; ======================================================
; StreamHandler.test.ahk — Unit tests for StreamHandler logic
;
; Tests: saveStreamResponse content guard,
;        _readAndProcessStream edge cases
; ======================================================

class StreamHandlerTest {

    static __New() {
        RegisterTestClass("StreamHandlerTest")
    }

    _setupDb() {
        if ChatDB.isOpen {
            oldPath := ChatDB.dbPath
            ChatDB.Close()
            try FileDelete(oldPath)
        }
        ChatDB.Open(A_Temp "\test_strm_" A_TickCount "_" Random(1000, 999999) ".db")
    }

    _teardownDb() {
        if ChatDB.isOpen {
            dbPath := ChatDB.dbPath
            ChatDB.Close()
            try FileDelete(dbPath)
        }
    }

    ; --------------------
    ; saveStreamResponse — empty content guard
    ; --------------------
    ; NOTE: saveStreamResponse uses globals from ChatWindow.ahk
    ; (activeThreadId, requestParams, router). We test the
    ; empty content guard by verifying no crash when content is empty.

    ; --------------------
    ; _readAndProcessStream — no file
    ; --------------------

    ReadStreamChunk_NoFile_Returns() {
        ; Should not throw when file doesn't exist
        state := {outputFile: A_Temp "\nonexistent_" A_TickCount "_" Random(1000, 999999) ".tmp", lastPos: 0, content: "", reasoning: "", modelName: "", firstTokenTime: 0, usage: {}, providerKey: "", rawSseChunks: ""}
        try {
            _readAndProcessStream(state, false)
        } catch Error as err {
            throw Error("_readAndProcessStream should not throw for missing file: " err.Message)
        }
    }

    ReadStreamChunk_EmptyFile_Returns() {
        ; Should not throw for empty file
        tmpFile := A_Temp "\test_empty_" A_TickCount "_" Random(1000, 999999) ".tmp"
        FileAppend("", tmpFile)
        state := {outputFile: tmpFile, lastPos: 0, content: "", reasoning: "", modelName: "", firstTokenTime: 0, usage: {}, providerKey: "", rawSseChunks: ""}
        try {
            _readAndProcessStream(state, false)
        } catch Error as err {
            FileDelete(tmpFile)
            throw Error("_readAndProcessStream should not throw for empty file: " err.Message)
        }
        FileDelete(tmpFile)
    }

    ; Regression (bug #160): a poll boundary that splits a UTF-8 multibyte
    ; character must round-trip without U+FFFD replacement characters - the
    ; raw-byte incremental decode keeps the incomplete trailing bytes pending.
    ReadStreamChunk_Utf8Split_NoReplacementChars() {
        path := A_Temp "\test_utf8_split_" A_TickCount "_" Random(1000, 999999) ".tmp"
        ; "ab" + U+00E9 (C3 A9) + "cd", split INSIDE the é:
        bytes := [0x61, 0x62, 0xC3, 0xA9, 0x63, 0x64]
        f := FileOpen(path, "w", "UTF-8-RAW")
        buf := Buffer(3)
        loop 3
            NumPut("UChar", bytes[A_Index], buf, A_Index - 1)
        f.RawWrite(buf)
        f.Close()

        state := {outputFile: path, lastPos: 0}
        part1 := _readFileChunk(state)
        ; Append the remaining bytes (A9 63 64) and resume from the pending tail:
        f := FileOpen(path, "a", "UTF-8-RAW")
        buf2 := Buffer(3)
        loop 3
            NumPut("UChar", bytes[A_Index + 3], buf2, A_Index - 1)
        f.RawWrite(buf2)
        f.Close()
        part2 := _readFileChunk(state)
        FileDelete(path)

        joined := part1 . part2
        if joined != "ab" Chr(0xE9) "cd"
            throw Error("split UTF-8 char must round-trip (bug #160): part1='" part1 "' part2='" part2 "' joined='" joined "'")
        if InStr(joined, Chr(0xFFFD))
            throw Error("U+FFFD replacement char persisted (bug #160)")
    }

    ; Regression (bug #178): a `data:` JSON line split across two polls (the
    ; first chunk ends mid-JSON, the second carries the bare remainder) must
    ; be re-formed by the pending-line buffer so the event's payload survives
    ; in full - the old code crashed the poll on the partial (jsongo.Parse
    ; returns a String) and silently lost the remainder (no `data: ` prefix).
    ReadStreamChunk_SplitDataLine_RejoinsPayload() {
        path := A_Temp "\test_sse_split_" A_TickCount "_" Random(1000, 999999) ".tmp"
        part1 := 'data: {"choices":[{"delta":{"content":"SPLIT-LEFT"}},'
        part2 := '{"delta":{"content":"-RIGHT"}}]}' "`n"
        FileAppend(part1, path)
        state := {outputFile: path, lastPos: 0, content: "", reasoning: "", modelName: "", firstTokenTime: 0, usage: {}, providerKey: "", rawSseChunks: "", pendingLine: ""}
        _readAndProcessStream(state, false)
        ; The partial must be held, not consumed or dropped:
        if state.pendingLine != part1
            throw Error("partial line must be held in pendingLine (bug #178), got '" state.pendingLine "'")
        if state.content != ""
            throw Error("no content may be persisted before the line completes, got '" state.content "'")

        FileAppend(part2, path)
        _readAndProcessStream(state, false)
        if state.content != "SPLIT-LEFT-RIGHT"
            throw Error("split-line payload must survive in full (bug #178), got '" state.content "'")
        if state.pendingLine != ""
            throw Error("pendingLine must clear after the line completes, got '" state.pendingLine "'")
        FileDelete(path)
    }

    ReadStreamChunk_ParsesContent() {
        tmpFile := A_Temp "\test_sse_" A_TickCount "_" Random(1000, 999999) ".tmp"
        FileAppend('data: {"choices":[{"delta":{"content":"Hello"}}]}', tmpFile)
        state := {outputFile: tmpFile, lastPos: 0, content: "", reasoning: "", modelName: "", firstTokenTime: 0, usage: {}, providerKey: "", rawSseChunks: ""}
        _readAndProcessStream(state, false)
        if state.content != "Hello"
            throw Error("Expected content='Hello', got '" state.content "'")
        FileDelete(tmpFile)
    }

    ; Regression (bug #178): a re-joined split `data:` line can carry MORE
    ; than one choice in a single SSE event - the parser must accumulate the
    ; content from every choice instead of reading only the first one.
    SSEParser_MultiChoiceEvent_AccumulatesAllContent() {
        line := 'data: {"choices":[{"delta":{"content":"SPLIT-LEFT"}},{"delta":{"content":"-RIGHT"}}]}'
        result := SSEParser.ParseLine(line)
        if result.type != "content"
            throw Error("Expected type='content', got '" result.type "'")
        if result.content != "SPLIT-LEFT-RIGHT"
            throw Error("Expected content='SPLIT-LEFT-RIGHT', got '" result.content "'")
    }

    ; --------------------
    ; _persistStreamResponse â€” captured thread (bug #159)
    ; --------------------

    PersistStreamResponse_UsesCapturedThread() {
        global activeThreadId, requestParams
        this._setupDb()
        threadIdA := ChatDB.Thread_Create("Thread A")
        threadIdB := ChatDB.Thread_Create("Thread B")
        uA := ChatDB.Msg_Insert({thread_id: threadIdA, role: "user", content: "question for A"})
        uB := ChatDB.Msg_Insert({thread_id: threadIdB, role: "user", content: "question for B"})

        ; The user switched to thread B while A's stream was in flight:
        activeThreadId := threadIdB
        requestParams["_streamThreadId"] := threadIdA
        requestParams["_streamParentId"] := ""

        _persistStreamResponse("Hello from the mock LLM", "deepseek-v4-flash", "", { promptTokens: 12, completionTokens: 9, cachedTokens: 4 }, 500, 100, threadIdA)

        inA := ChatDB.db.Query("SELECT COUNT(*) AS c FROM messages WHERE thread_id=? AND role='assistant';", threadIdA)
        inB := ChatDB.db.Query("SELECT COUNT(*) AS c FROM messages WHERE thread_id=? AND role='assistant';", threadIdB)
        if Integer(inA[1, "c"]) != 1 || Integer(inB[1, "c"]) != 0
            throw Error("response must land in the captured thread A (bug #159): inA=" inA[1, "c"] " inB=" inB[1, "c"])
        row := ChatDB.db.Query("SELECT parent_id FROM messages WHERE thread_id=? AND role='assistant';", threadIdA)
        if row[1, "parent_id"] != uA
            throw Error("parent should be A's user message, got " row[1, "parent_id"])
        activeThreadId := ""
        requestParams.Delete("_streamParentId")
        this._teardownDb()
    }

    ; Regression (bug #197): the response must be parented to the message that
    ; SENT the request (_streamParentId captured at send time), NOT to the
    ; currently-active leaf after a same-thread branch switch mid-stream.
    PersistStreamResponse_UsesCapturedParent_NotCurrentLeaf() {
        global activeThreadId, requestParams
        this._setupDb()
        threadId := ChatDB.Thread_Create("Branch Mid-Stream")
        u1 := ChatDB.Msg_Insert({thread_id: threadId, role: "user", content: "root"})
        a1 := ChatDB.Msg_Insert({thread_id: threadId, role: "assistant", content: "branch A answer", parent_id: u1, model: "deepseek/deepseek-v4-flash", sibling_group: "sg-test197", sibling_index: 0, token_count: 5, prompt_tokens: 10})
        a1b := ChatDB.Msg_Insert({thread_id: threadId, role: "assistant", content: "branch B answer", parent_id: u1, model: "deepseek/deepseek-v4-flash", sibling_group: "sg-test197", sibling_index: 1, token_count: 5, prompt_tokens: 10})
        u2a := ChatDB.Msg_Insert({thread_id: threadId, role: "user", content: "follow A", parent_id: a1})
        a2a := ChatDB.Msg_Insert({thread_id: threadId, role: "assistant", content: "A leaf", parent_id: u2a, model: "deepseek/deepseek-v4-flash", token_count: 6, prompt_tokens: 20})
        u2b := ChatDB.Msg_Insert({thread_id: threadId, role: "user", content: "follow B", parent_id: a1b})
        a2b := ChatDB.Msg_Insert({thread_id: threadId, role: "assistant", content: "B leaf", parent_id: u2b, model: "deepseek/deepseek-v4-flash", token_count: 6, prompt_tokens: 20})

        ; Request was sent from branch A (last message u2a), then the user
        ; switched to branch B (active leaf now a2b) while it streamed.
        activeThreadId := threadId
        requestParams["_streamThreadId"] := threadId
        requestParams["_streamParentId"] := u2a
        ChatDB.db.Query("UPDATE chat_threads SET active_leaf_id=? WHERE id=?;", a2b, threadId)

        _persistStreamResponse("Hello from the mock LLM", "deepseek/deepseek-v4-flash", "", { promptTokens: 12, completionTokens: 9, cachedTokens: 4 }, 500, 100, threadId)

        row := ChatDB.db.Query("SELECT parent_id FROM messages WHERE thread_id=? AND content='Hello from the mock LLM';", threadId)
        if row[1, "parent_id"] != u2a
            throw Error("response must use the captured send-time parent (bug #197): got " row[1, "parent_id"] " expected " u2a)
        if row[1, "parent_id"] = a2b
            throw Error("response must NOT attach to the newly-active branch leaf a2b (bug #197)")
        activeThreadId := ""
        requestParams.Delete("_streamParentId")
        requestParams.Delete("_streamThreadId")
        this._teardownDb()
    }

    ; Regression (bug #206): the API-log metadata helpers must return the
    ; values captured at send time, even after requestParams changed because
    ; the user switched threads while the request was in flight.
    StreamLogHelpers_UseCapturedRequestMetadata() {
        global requestParams
        requestParams["_streamLogModel"] := "deepseek/deepseek-v4-flash"
        requestParams["_streamLogProviderName"] := "deepseek"
        requestParams["_streamLogWindowTitle"] := "Chat"
        requestParams["_streamLogPasteMode"] := "chat"
        requestParams["singleAPIModelName"] := "openai/gpt-5-mini"
        requestParams["providerName"] := "openai"
        requestParams["windowTitle"] := "Other Thread"
        requestParams["pasteMode"] := "replace"
        if _streamLogModel() != "deepseek/deepseek-v4-flash"
            throw Error("_streamLogModel must use the captured value (bug #206)")
        if _streamLogProviderName() != "deepseek"
            throw Error("_streamLogProviderName must use the captured value (bug #206)")
        if _streamLogWindowTitle() != "Chat"
            throw Error("_streamLogWindowTitle must use the captured value (bug #206)")
        if _streamLogPasteMode() != "chat"
            throw Error("_streamLogPasteMode must use the captured value (bug #206)")
        requestParams.Delete("_streamLogModel")
        requestParams.Delete("_streamLogProviderName")
        requestParams.Delete("_streamLogWindowTitle")
        requestParams.Delete("_streamLogPasteMode")
    }

    ; Regression: hard-deleting the streaming thread mid-stream must not create
    ; an orphan message. The completed API call remains historical usage.
    PersistStreamResponse_AfterThreadHardDelete_KeepsTrace() {
        global activeThreadId, requestParams
        this._setupDb()
        threadIdA := ChatDB.Thread_Create("Thread A")
        ChatDB.Msg_Insert({thread_id: threadIdA, role: "user", content: "question for A"})
        ; Hard-delete the thread while its stream is in flight (wipes the
        ; thread row + messages and clears the active thread):
        ChatDB.Thread_Delete(threadIdA)
        activeThreadId := ""
        requestParams["_streamThreadId"] := threadIdA

        _persistStreamResponse("Hello from the mock LLM", "deepseek/deepseek-v4-flash", "", { promptTokens: 12, completionTokens: 9, cachedTokens: 4 }, 500, 100, threadIdA)

        dangling := ChatDB.db.Query("SELECT COUNT(*) AS c FROM messages WHERE thread_id NOT IN (SELECT id FROM chat_threads);")
        if Integer(dangling[1, "c"]) != 0
            throw Error("deleted-thread completion must not create an orphan message, got " dangling[1, "c"])
        usage := ChatDB.db.Query("SELECT COUNT(*) AS c FROM chat_usage;")
        if Integer(usage[1, "c"]) != 1
            throw Error("billed response must be usage-tracked (bug #172), got " usage[1, "c"])
        activeThreadId := ""
        this._teardownDb()
    }

    ; Regression (bug #170): a reasoning-only stream never emits a "content"
    ; chunk, so _processChunk must stamp firstTokenTime on "reasoning" chunks
    ; too - otherwise ttft_ms stays 0 forever.
    ProcessChunk_ReasoningStampsFirstTokenTime() {
        state := {outputFile: "", lastPos: 0, content: "", reasoning: "", modelName: "", firstTokenTime: 0, usage: {}, providerKey: "deepseek", rawSseChunks: "", rawLastResponse: ""}
        _processChunk(state, { type: "reasoning", content: "thinking..." }, false)
        if state.firstTokenTime = 0
            throw Error("reasoning chunk must stamp firstTokenTime (bug #170)")
        if state.reasoning != "thinking..."
            throw Error("reasoning content must still accumulate")
        ; A second chunk keeps the FIRST stamp:
        firstStamp := state.firstTokenTime
        _processChunk(state, { type: "reasoning", content: "more thinking" }, false)
        if state.firstTokenTime != firstStamp
            throw Error("firstTokenTime must not be re-stamped")
    }

    ; --------------------------------------------------------
    ; SSEParser: null-usage investigation
    ; jsongo.Parse converts JSON null to "" (empty string).
    ; If OpenAI returns {"usage":null} in a finish chunk,
    ; SSEParser would do parsed["usage"]["prompt_tokens"]
    ; which is bracket-access on "" → __Item error.
    ; --------------------------------------------------------

    ; Verify jsongo.Parse(null) → "" (AHK empty string)
    JsongoNull_BecomesEmptyString() {
        obj := jsongo.Parse('{"key": null}')
        val := obj["key"]
        if Type(val) != "String"
            throw Error("Expected null→String, got Type=" Type(val))
        if val != ""
            throw Error("Expected null→empty string, got '" val "'")
    }

    ; Verify bracket access on "" (from null) triggers __Item
    JsongoNull_BracketAccessOnString_ThrowsTypeError() {
        obj := jsongo.Parse('{"usage": null}')
        usage := obj["usage"]
        if Type(usage) != "String"
            throw Error("Expected String, got " Type(usage))
        ; This should throw — bracket access on a String
        threw := false
        try {
            _ := usage["prompt_tokens"]
        } catch Error as e {
            threw := true
            if !InStr(e.Message, "__Item")
                throw Error("Expected __Item error, got: " e.Message)
        }
        if !threw
            throw Error("Expected bracket access on String to throw, but it didn't")
    }

    ; SSEParser with finish chunk containing "usage": null
    SSEParser_NullUsage_HandlesGracefully() {
        line := 'data: {"id":"test","choices":[{"delta":{},"finish_reason":"stop"}],"model":"gpt-5.1","usage":null}'
        try {
            result := SSEParser.ParseLine(line)
            ; Should not throw, should return finish without usage
            if result.type != "finish"
                throw Error("Expected type='finish', got '" result.type "'")
            if result.HasOwnProp("usage")
                throw Error("Expected no usage prop when usage is null")
        } catch Error as e {
            throw Error("SSEParser should handle null usage gracefully, but threw: " e.Message)
        }
    }

    ; SSEParser with finish chunk containing valid usage
    SSEParser_ValidUsage_ExtractsCorrectly() {
        line := 'data: {"id":"test","choices":[{"delta":{},"finish_reason":"stop"}],"model":"gpt-5.1","usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}'
        result := SSEParser.ParseLine(line)
        if result.type != "finish"
            throw Error("Expected type='finish', got '" result.type "'")
        if !result.HasOwnProp("usage")
            throw Error("Expected usage prop")
        if result.usage.promptTokens != 10
            throw Error("Expected promptTokens=10, got " result.usage.promptTokens)
        if result.usage.completionTokens != 5
            throw Error("Expected completionTokens=5, got " result.usage.completionTokens)
        if result.usage.totalTokens != 15
            throw Error("Expected totalTokens=15, got " result.usage.totalTokens)
    }

    ; SSEParser with finish chunk containing empty usage object
    SSEParser_EmptyUsageObject_HandlesGracefully() {
        line := 'data: {"id":"test","choices":[{"delta":{},"finish_reason":"stop"}],"model":"gpt-5.1","usage":{}}'
        try {
            result := SSEParser.ParseLine(line)
            if result.type != "finish"
                throw Error("Expected type='finish', got '" result.type "'")
        } catch Error as e {
            throw Error("SSEParser should handle empty usage object gracefully, but threw: " e.Message)
        }
    }

    ; SSEParser: usage-only chunk with empty choices (OpenAI stream_options: include_usage format)
    SSEParser_EmptyChoicesWithUsage_ExtractsUsage() {
        line := 'data: {"id":"test","choices":[],"model":"gpt-5.1","usage":{"prompt_tokens":20,"completion_tokens":8,"total_tokens":28,"prompt_cache_hit_tokens":5}}'
        result := SSEParser.ParseLine(line)
        if result.type != "finish"
            throw Error("Expected type='finish' for usage-only chunk, got '" result.type "'")
        if !result.HasOwnProp("usage")
            throw Error("Expected usage prop in usage-only chunk")
        if result.usage.promptTokens != 20
            throw Error("Expected promptTokens=20, got " result.usage.promptTokens)
        if result.usage.completionTokens != 8
            throw Error("Expected completionTokens=8, got " result.usage.completionTokens)
        if result.usage.totalTokens != 28
            throw Error("Expected totalTokens=28, got " result.usage.totalTokens)
        if result.usage.cachedTokens != 5
            throw Error("Expected cachedTokens=5, got " result.usage.cachedTokens)
        if result.model != "gpt-5.1"
            throw Error("Expected model='gpt-5.1', got '" result.model "'")
    }

    ; SSEParser: empty choices without usage should still be ignored
    SSEParser_EmptyChoicesNoUsage_ReturnsIgnore() {
        line := 'data: {"id":"test","choices":[],"model":"gpt-5.1"}'
        result := SSEParser.ParseLine(line)
        if result.type != "ignore"
            throw Error("Expected type='ignore' for empty choices without usage, got '" result.type "'")
    }

    ; --------------------------------------------------------
    ; SSEParser: Gemini thinking tokens via total - prompt - completion
    ; --------------------------------------------------------

    SSEParser_GeminiUsage_ExtractsThinkingTokens() {
        line := 'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"model":"gemini-2.5-flash","usage":{"prompt_tokens":2,"completion_tokens":7,"total_tokens":473}}'
        result := SSEParser.ParseLine(line)
        if result.type != "finish"
            throw Error("Expected type='finish', got '" result.type "'")
        if result.usage.thinkingTokens != 464
            throw Error("Expected thinkingTokens=464 (473-2-7), got " result.usage.thinkingTokens)
        if result.usage.completionTokens != 471
            throw Error("Expected completionTokens=471 (total-prompt), got " result.usage.completionTokens)
    }

    SSEParser_DeepSeekUsage_ExtractsThinkingTokens() {
        line := 'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"model":"deepseek","usage":{"prompt_tokens":100,"completion_tokens":200,"total_tokens":300,"completion_tokens_details":{"reasoning_tokens":50}}}'
        result := SSEParser.ParseLine(line)
        if result.usage.thinkingTokens != 50
            throw Error("Expected thinkingTokens=50 from details, got " result.usage.thinkingTokens)
        if result.usage.completionTokens != 200
            throw Error("Expected completionTokens=200, got " result.usage.completionTokens)
    }

    ; Gemini cached tokens via prompt_tokens_details.cached_tokens
    SSEParser_GeminiUsage_ExtractsCachedTokens() {
        line := 'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"model":"gemini-2.5-flash","usage":{"prompt_tokens":4663,"completion_tokens":664,"total_tokens":6651,"prompt_tokens_details":{"cached_tokens":3009}}}'
        result := SSEParser.ParseLine(line)
        if result.usage.cachedTokens != 3009
            throw Error("Expected cachedTokens=3009 from prompt_tokens_details, got " result.usage.cachedTokens)
    }

    SSEParser_NormalUsage_NoThinking() {
        line := 'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"model":"gpt-4","usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}'
        result := SSEParser.ParseLine(line)
        if result.usage.thinkingTokens != 0
            throw Error("Expected thinkingTokens=0, got " result.usage.thinkingTokens)
        if result.usage.completionTokens != 5
            throw Error("Expected completionTokens=5, got " result.usage.completionTokens)
    }

    ; --------------------------------------------------------
    ; Error response parsing: Google Gemini returns errors as
    ; [{error: {message: "..."}}] (array), while OpenAI/DeepSeek
    ; return {error: {message: "..."}} (object).
    ; _handleStreamError() must extract the message from both.
    ; --------------------------------------------------------

    ; Google Gemini format: array with error object
    ParseError_GoogleArrayFormat() {
        raw := '[{"error": {"code": 400, "message": "Invalid reasoning_effort value", "status": "INVALID_ARGUMENT"}}]'
        parsed := jsongo.Parse(raw)

        errMsg := ""
        if Type(parsed) = "Array" && parsed.Length > 0 && parsed[1].Has("error") && parsed[1]["error"].Has("message") {
            errMsg := parsed[1]["error"]["message"]
        }

        if errMsg != "Invalid reasoning_effort value"
            throw Error("Expected error message 'Invalid reasoning_effort value', got '" errMsg "'")
    }

    ; OpenAI/DeepSeek format: object with error
    ParseError_ObjectFormat() {
        raw := '{"error": {"message": "Invalid API key", "type": "invalid_request_error"}}'
        parsed := jsongo.Parse(raw)

        errMsg := ""
        if parsed.Has("error") && parsed["error"].Has("message") {
            errMsg := parsed["error"]["message"]
        }

        if errMsg != "Invalid API key"
            throw Error("Expected error message 'Invalid API key', got '" errMsg "'")
    }

    ; Both branches combined (mirrors the actual _handleStreamError logic)
    ParseError_CombinedLogic_HandlesArrayFirst() {
        ; Test: Array format should be caught by the first branch
        raw := '[{"error": {"message": "Array error format"}}]'
        parsed := jsongo.Parse(raw)

        errMsg := ""
        if Type(parsed) = "Array" && parsed.Length > 0 && parsed[1].Has("error") && parsed[1]["error"].Has("message") {
            errMsg := parsed[1]["error"]["message"]
        } else if parsed.Has("error") && parsed["error"].Has("message") {
            errMsg := parsed["error"]["message"]
        }

        if errMsg != "Array error format"
            throw Error("Expected 'Array error format', got '" errMsg "'")
    }

    ParseError_CombinedLogic_HandlesObjectFallback() {
        ; Test: Object format falls through to second branch
        raw := '{"error": {"message": "Object error format"}}'
        parsed := jsongo.Parse(raw)

        errMsg := ""
        if Type(parsed) = "Array" && parsed.Length > 0 && parsed[1].Has("error") && parsed[1]["error"].Has("message") {
            errMsg := parsed[1]["error"]["message"]
        } else if parsed.Has("error") && parsed["error"].Has("message") {
            errMsg := parsed["error"]["message"]
        }

        if errMsg != "Object error format"
            throw Error("Expected 'Object error format', got '" errMsg "'")
    }

    ; --------------------------------------------------------
    ; Non-JSON content: jsongo.Parse throws, catch block must
    ; ensure errMsg stays empty so the fallback at line ~200 fires.
    ; --------------------------------------------------------
    ParseError_NonJsonContent_ReturnsEmptyError() {
        ; Simulate a garbage response body (e.g., HTML error page)
        raw := "<html>502 Bad Gateway</html>"
        threw := false
        errMsg := ""
        try {
            parsed := jsongo.Parse(raw)
            ; Should have thrown — fail if we reach here
            if Type(parsed) = "Array" && parsed.Length > 0 && parsed[1].Has("error") && parsed[1]["error"].Has("message") {
                errMsg := parsed[1]["error"]["message"]
            } else if parsed.Has("error") && parsed["error"].Has("message") {
                errMsg := parsed["error"]["message"]
            }
        } catch Error as e {
            threw := true
            ; errMsg stays empty — fallback path should fire
        }

        if !threw
            throw Error("Expected jsongo.Parse to throw on non-JSON input")
        if errMsg != ""
            throw Error("Expected empty errMsg after parse failure, got '" errMsg "'")
    }

    ; Regression (bug #56): a user-initiated Stop before the first token must
    ; finalize as a clean cancellation. _finalizeStreaming must check
    ; _streamCancelled BEFORE the empty-content branch (which routes to
    ; _handleStreamError and shows the misleading API-key banner).
    FinalizeStreaming_ChecksCancelBeforeEmptyContent() {
        srcPath := A_ScriptDir "\..\chat\streaming\StreamHandler.ahk"
        src := FileRead(srcPath)
        finalizePos := InStr(src, "_finalizeStreaming() {")
        if !finalizePos
            throw Error("_finalizeStreaming not found in StreamHandler.ahk")
        ; The window is generous because the bug #219 mid-stream-error branch
        ; sits between the cancel branch and the empty-content branch.
        block := SubStr(src, finalizePos, 2200)
        cancelPos := InStr(block, "_handleStreamCancelled()")
        errorPos := InStr(block, "_handleStreamError()")
        if !cancelPos || !errorPos || cancelPos > errorPos
            throw Error("_finalizeStreaming must check _streamCancelled before the empty-content error branch (bug #56): cancelPos=" cancelPos " errorPos=" errorPos)
    }

    ; Regression (bug #98): the wasCancelled branch of _finalizeStreaming must
    ; clean up the _stream* keys before returning, so a cancelled request can
    ; never leak stale stream state into the next send.
    FinalizeStreaming_CancelBranchCleansUpStreamState() {
        srcPath := A_ScriptDir "\..\chat\streaming\StreamHandler.ahk"
        src := FileRead(srcPath)
        finalizePos := InStr(src, "_finalizeStreaming() {")
        if !finalizePos
            throw Error("_finalizeStreaming not found in StreamHandler.ahk")
        block := SubStr(src, finalizePos, 2000)
        cancelPos := InStr(block, "if wasCancelled {")
        if !cancelPos
            throw Error("wasCancelled branch not found")
        ; The window is generous because the bug #221 _FinishStreamFinalize
        ; call sits between _cleanupStreamState and the return.
        branch := SubStr(block, cancelPos, 900)
        cleanupPos := InStr(branch, "_cleanupStreamState()")
        retPos := InStr(branch, "return")
        if !InStr(branch, "_handleStreamCancelled()") || !cleanupPos || !retPos || cleanupPos > retPos
            throw Error("_finalizeStreaming wasCancelled branch must call _cleanupStreamState before return (bug #98): cleanupPos=" cleanupPos " retPos=" retPos)
    }

    ; Regression (bug #110, security): every terminal stream path must delete
    ; the temp request/cURL files (they contain the Authorization Bearer
    ; token) - success, error, and cancel.
    StreamPaths_DeleteTempFiles() {
        scPath := A_ScriptDir "\..\chat\streaming\StreamCompletion.ahk"
        sc := FileRead(scPath)
        completeIdx := InStr(sc, "_handleStreamComplete() {")
        ; The window is generous because the bug #232 sidebar-refresh comment
        ; sits between the stats post and the temp-file cleanup.
        completeBlock := SubStr(sc, completeIdx, 3600)
        if !InStr(completeBlock, "deleteTempFiles()")
            throw Error("_handleStreamComplete must delete temp files (bug #110)")
        sePath := A_ScriptDir "\..\chat\streaming\StreamError.ahk"
        se := FileRead(sePath)
        errorIdx := InStr(se, "_handleStreamError() {")
        ; The window is generous because the bug #219 last-SSE-event error
        ; extraction sits between the file reads and the cleanup.
        errorBlock := SubStr(se, errorIdx, 3400)
        if !InStr(errorBlock, "deleteTempFiles()")
            throw Error("_handleStreamError must delete temp files (bug #110)")
        cancelIdx := InStr(se, "_handleStreamCancelled() {")
        cancelBlock := SubStr(se, cancelIdx, 3600)
        if !InStr(cancelBlock, "deleteTempFiles()")
            throw Error("_handleStreamCancelled must keep deleting temp files")
    }

    ; Regression (bug #211): a retry that FAILS before/without streaming (vision
    ; gate rejection, buildRequest failure, _handleStreamError) must clear the
    ; pending retry keys - otherwise the NEXT normal response reads the stale
    ; sibling group and is inserted as a sibling of the retried message across
    ; different parents (tree corruption). The stream cleanup is the single
    ; terminal-path choke point, so it must clear both keys.
    CleanupStreamState_ClearsPendingRetryKeys() {
        global requestParams
        oldParams := requestParams
        requestParams := Map(
            "pendingRetrySiblingGroup", "sg-211",
            "pendingRetryIsRoot", true)
        try {
            _cleanupStreamState()
            if requestParams.Has("pendingRetrySiblingGroup")
                throw Error("_cleanupStreamState must clear pendingRetrySiblingGroup (bug #211)")
            if requestParams.Has("pendingRetryIsRoot")
                throw Error("_cleanupStreamState must clear pendingRetryIsRoot (bug #211)")
        } finally {
            requestParams := oldParams
        }
    }

    ; Regression (bug #211): a retry rejected BEFORE any stream starts (vision
    ; gate / API-key / endpoint error) goes through _BuildAndFireRequest's
    ; build-failure branch - it must clear the pending retry keys there too,
    ; because no stream ever runs to reach _cleanupStreamState.
    BuildAndFireRequest_BuildFailureClearsPendingRetry() {
        srcPath := A_ScriptDir "\..\chat\ChatRequestBuilder.ahk"
        src := FileRead(srcPath)
        fnPos := InStr(src, "_BuildAndFireRequest() {")
        if !fnPos
            throw Error("_BuildAndFireRequest not found in ChatRequestBuilder.ahk")
        block := SubStr(src, fnPos, 2400)
        ; The deletes are inlined (a helper call would be an unresolved
        ; identifier when ChatRequestBuilder.ahk is #Included by the headless
        ; DB-audit probe without the chat-process modules).
        if !InStr(block, "pendingRetrySiblingGroup") || !InStr(block, "pendingRetryIsRoot") || !InStr(block, "Delete(")
            throw Error("_BuildAndFireRequest must clear pending retry state when the request fails to build (bug #211)")
    }

    ; Regression (bug #219): a real OpenAI-style SSE error event
    ; (`data: {"error": {"message": ...}}`) is valid JSON WITHOUT a "choices"
    ; key - the old parsed["choices"] Map index THREW in AHK v2 and crashed
    ; the poll. ParseLine must surface the provider message as an "error"
    ; chunk instead.
    SSEParser_ErrorEvent_ReturnsErrorChunk() {
        result := SSEParser.ParseLine('data: {"error":{"message":"upstream exploded (mock)"}}')
        if result.type != "error"
            throw Error("expected type='error', got '" result.type "'")
        if result.message != "upstream exploded (mock)"
            throw Error("expected provider message, got '" result.message "'")
    }

    ; Regression (bug #219): valid JSON with NEITHER "choices" NOR "error"
    ; (e.g. a provider keepalive/ping object) must be ignored, not crash.
    SSEParser_MissingChoicesNoError_ReturnsIgnore() {
        result := SSEParser.ParseLine('data: {"foo":"bar"}')
        if result.type != "ignore"
            throw Error("expected type='ignore', got '" result.type "'")
    }

    ; Regression (bug #219): the poll's chunk processor must remember the
    ; error message so finalization can surface it and keep the partial.
    ProcessChunk_ErrorEvent_StoresErrorMessage() {
        state := {outputFile: "", lastPos: 0, content: "", reasoning: "", modelName: "", firstTokenTime: 0, usage: {}, providerKey: "deepseek", rawSseChunks: "", rawLastResponse: "", pendingLine: "", errorMessage: ""}
        _processChunk(state, { type: "error", message: "upstream exploded (mock)" }, false)
        if state.errorMessage != "upstream exploded (mock)"
            throw Error("error event must be stored in state.errorMessage (bug #219), got '" state.errorMessage "'")
    }

    ; Regression (bug #219): _finalizeStreaming must handle a mid-stream error
    ; event BEFORE the empty-content branch (which would misreport it as a
    ; connection failure and drop the partial response).
    FinalizeStreaming_ChecksMidStreamErrorBeforeEmptyContent() {
        srcPath := A_ScriptDir "\..\chat\streaming\StreamHandler.ahk"
        src := FileRead(srcPath)
        finalizePos := InStr(src, "_finalizeStreaming() {")
        if !finalizePos
            throw Error("_finalizeStreaming not found in StreamHandler.ahk")
        block := SubStr(src, finalizePos, 2200)
        errorPos := InStr(block, "_handleMidStreamError()")
        emptyPos := InStr(block, "_handleStreamError()")
        cancelPos := InStr(block, "_handleStreamCancelled()")
        if !errorPos || !emptyPos || errorPos > emptyPos
            throw Error("_finalizeStreaming must check _streamErrorMessage before the empty-content error branch (bug #219): midStreamErrorPos=" errorPos " emptyErrorPos=" emptyPos)
        if !cancelPos || cancelPos > errorPos
            throw Error("_finalizeStreaming must keep the cancelled check before the error branch (bug #56/#219): cancelPos=" cancelPos " midStreamErrorPos=" errorPos)
    }

    ; Regression (bug #221): a per-request stream record must round-trip
    ; through the shared requestParams window - every field the
    ; completion/error/cancel handlers read, including the request's OWN
    ; temp-file paths and retry metadata.
    LoadStreamIntoParams_RoundTripsStreamState() {
        global requestParams, _activeStreams, _currentStreamKey
        oldParams := requestParams
        oldStreams := _activeStreams
        oldKey := _currentStreamKey
        requestParams := Map()
        _activeStreams := []
        stream := {key: "k-221", outputFile: "out.json", lastPos: 3, content: "partial", reasoning: "think", modelName: "m", displayName: "M", firstTokenTime: 5, usage: {completionTokens: 1}, providerKey: "deepseek", rawSseChunks: "data", rawLastResponse: "{}", pendingLine: "", errorMessage: "", pollCount: 2, requestStartTime: 1, chatHistoryJSONRequest: "{}", pid: 42, cancelled: false, threadId: "t-221", parentId: "p-221", logWindowTitle: "Chat", logProviderName: "deepseek", logModel: "m", logPasteMode: "chat", retryIsRoot: true, retrySiblingGroup: "sg-221", requestFile: "req.json", cURLCommandFile: "curl.txt", errorFile: "err.txt"}
        try {
            _LoadStreamIntoParams(stream)
            if requestParams["_streamThreadId"] != "t-221" || requestParams["_streamPID"] != 42
                throw Error("stream identity fields not loaded (bug #221)")
            if requestParams["chatHistoryJSONRequestFile"] != "req.json" || requestParams["cURLCommandFile"] != "curl.txt" || requestParams["cURLOutputFile"] != "out.json" || requestParams["cURLErrorFile"] != "err.txt"
                throw Error("the request's OWN temp-file paths must load into requestParams (bug #221/#223)")
            if requestParams["pendingRetryIsRoot"] != true || requestParams["pendingRetrySiblingGroup"] != "sg-221"
                throw Error("the request's own retry metadata must load into requestParams (bug #221)")
            if _currentStreamKey != "k-221"
                throw Error("current stream key not set (bug #221)")
            _SaveStreamFromParams(stream)
            if stream.lastPos != 3 || stream.content != "partial" || stream.pollCount != 2
                throw Error("_SaveStreamFromParams must round-trip mutable fields (bug #221)")
        } finally {
            requestParams := oldParams
            _activeStreams := oldStreams
            _currentStreamKey := oldKey
        }
    }

    ; Regression (bug #221): the composer re-enable gate must detect another
    ; in-flight request besides the one being finalized.
    HasOtherActiveStreams_CountsConcurrentRequests() {
        global _activeStreams, _currentStreamKey
        oldStreams := _activeStreams
        oldKey := _currentStreamKey
        try {
            _activeStreams := [
                {key: "a", threadId: "t-a"},
                {key: "b", threadId: "t-b"}
            ]
            _currentStreamKey := "a"
            if !_HasOtherActiveStreams()
                throw Error("must detect the concurrent stream b (bug #221)")
            _currentStreamKey := "b"
            if !_HasOtherActiveStreams()
                throw Error("must detect the concurrent stream a (bug #221)")
            _activeStreams := [{key: "only", threadId: "t-a"}]
            _currentStreamKey := "only"
            if _HasOtherActiveStreams()
                throw Error("the last finishing stream must re-enable the composer (bug #221)")
        } finally {
            _activeStreams := oldStreams
            _currentStreamKey := oldKey
        }
    }

    ; Regression: a finishing stream must still see a concurrent synchronous
    ; request/tool loop as an active operation, even though it is not another
    ; stream.
    HasOtherActiveOperations_IncludesNonStreamAndToolOwners() {
        global _activeStreams, _activeToolLoops, _activeNonStreamRequests
        oldStreams := _activeStreams
        oldLoops := _activeToolLoops
        oldRequests := _activeNonStreamRequests
        try {
            current := {key: "stream-b", threadId: "t-b"}
            _activeStreams := [current]
            _activeToolLoops := []
            _activeNonStreamRequests := [{key: "request-a", threadId: "t-a"}]
            if !_HasOtherActiveOperations("", current)
                throw Error("a finishing stream must detect an active non-stream request")
            _activeNonStreamRequests := []
            _activeToolLoops := [{key: "loop-a", threadId: "t-a"}]
            if !_HasOtherActiveOperations("", current)
                throw Error("a finishing stream must detect an active search/tool loop")
            _activeToolLoops := []
            if _HasOtherActiveOperations("", current)
                throw Error("the finishing stream must be idle when it is the only operation")
        } finally {
            _activeStreams := oldStreams
            _activeToolLoops := oldLoops
            _activeNonStreamRequests := oldRequests
        }
    }

    CodexNonStreamingRequest_DefersBlockingExecOffWebMessageCallback() {
        srcPath := A_ScriptDir "\\..\\chat\\streaming\\StreamHandler.ahk"
        src := FileRead(srcPath)
        schedulePos := InStr(src, "SetTimer(_RunCodexNonStreamingRequest.Bind(")
        helperPos := InStr(src, "_RunCodexNonStreamingRequest(scope, chatHistoryJSONRequest, providerInfo, requestStartTime)")
        beginPos := InStr(src, "CodexCliTransport.BeginRequest(", false, helperPos)
        pollHelperPos := InStr(src, "_PollCodexNonStreamingRequest(asyncState)", false, helperPos)
        pollCallPos := InStr(src, "CodexCliTransport.PollRequest(asyncState)", false, pollHelperPos)
        if !schedulePos || !helperPos || !beginPos || !pollHelperPos || !pollCallPos
            throw Error("Codex chat path must start and poll the CLI through the captured non-stream request scope")
        if schedulePos > helperPos
            throw Error("Codex timer scheduling must occur before the deferred execution helper")
        branchText := SubStr(src, schedulePos, helperPos - schedulePos)
        if InStr(branchText, "CodexCliTransport.ExecuteRequest(") || InStr(branchText, "CodexCliTransport.BeginRequest(")
            throw Error("Codex process start must not run inline inside the WebView chatSend callback")
        helperText := SubStr(src, helperPos, pollHelperPos - helperPos)
        pollText := SubStr(src, pollHelperPos, 1200)
        if !InStr(helperText, "scope.params[") || !InStr(helperText, "SetTimer(asyncState.pollTimer, 50)")
            throw Error("Deferred Codex start must use captured request paths and schedule non-blocking polling")
        if InStr(helperText, "CodexCliTransport.ExecuteRequest(") || !InStr(pollText, "CodexCliTransport.PollRequest(asyncState)")
            throw Error("Live Codex chat must not hold the AHK thread in synchronous ExecuteRequest")
    }

    CodexNonStreamingRequest_RecordsTransportForCooperativeStop() {
        srcPath := A_ScriptDir "\\..\\chat\\streaming\\StreamHandler.ahk"
        src := FileRead(srcPath)
        transportPos := InStr(src, "scope.transport := providerInfo.transport")
        schedulePos := InStr(src, "SetTimer(_RunCodexNonStreamingRequest.Bind(")
        if !transportPos || !schedulePos || transportPos > schedulePos
            throw Error("Non-stream request scope must record its transport before Codex is deferred so Stop can use cooperative cancellation")
    }

    RequestPath_CleansAndRestoresByStreamOwnership() {
        global requestParams, _activeStreams, _currentStreamKey
        oldParams := requestParams
        oldStreams := _activeStreams
        oldKey := _currentStreamKey
        try {
            requestParams := Map()
            streamA := {
                key: "path-a", requestPath: [{id: "leaf-a"}], outputFile: "out-a", lastPos: 0,
                content: "", reasoning: "", modelName: "m", displayName: "M", firstTokenTime: 0,
                usage: {}, providerKey: "deepseek", rawSseChunks: "", rawLastResponse: "", pendingLine: "",
                errorMessage: "", pollCount: 0, requestStartTime: 0, chatHistoryJSONRequest: "{}", pid: 0,
                cancelled: false, toolCalls: Map(), toolLoopCount: 0, threadId: "t-a", parentId: "",
                logWindowTitle: "", logProviderName: "", logModel: "m", logPasteMode: "chat",
                retryIsRoot: false, retrySiblingGroup: "", requestFile: "", cURLCommandFile: "", errorFile: ""
            }
            streamB := streamA.Clone()
            streamB.key := "path-b"
            streamB.requestPath := [{id: "leaf-b"}]
            _activeStreams := [streamA, streamB]

            _LoadStreamIntoParams(streamA)
            if requestParams["_requestPath"][1].id != "leaf-a"
                throw Error("stream A path was not loaded")
            _cleanupStreamState()
            if !requestParams.Has("_requestPath")
                throw Error("cleanup removed the path before the remaining stream could be restored")
            _FinishStreamFinalize()
            if !requestParams.Has("_requestPath") || requestParams["_requestPath"][1].id != "leaf-b"
                throw Error("remaining stream B path was not restored")

            _cleanupStreamState()
            _FinishStreamFinalize()
            if requestParams.Has("_requestPath")
                throw Error("completed stream path leaked after the final stream finished")
        } finally {
            requestParams := oldParams
            _activeStreams := oldStreams
            _currentStreamKey := oldKey
        }
    }

    ; Regression (bug #221): removing a finalized stream must only remove the
    ; matching key and never touch another concurrent request's record.
    RemoveStreamFromActive_OnlyRemovesMatchingKey() {
        global _activeStreams
        oldStreams := _activeStreams
        try {
            _activeStreams := [{key: "a", threadId: "t-a"}, {key: "b", threadId: "t-b"}]
            _RemoveStreamFromActive("a")
            if _activeStreams.Length != 1 || _activeStreams[1].key != "b"
                throw Error("_RemoveStreamFromActive must remove only the matching stream (bug #221)")
            _RemoveStreamFromActive("nope")
            if _activeStreams.Length != 1
                throw Error("removing an unknown key must be a no-op (bug #221)")
            _RemoveStreamFromActive("")
            if _activeStreams.Length != 1
                throw Error("removing an empty key must be a no-op (bug #221)")
        } finally {
            _activeStreams := oldStreams
        }
    }

    ; Regression (bug #221): the poll timer must iterate EVERY in-flight
    ; request and sendStreamingRequest must register a per-request record.
    PollTimer_IteratesAllActiveStreams() {
        srcPath := A_ScriptDir "\..\chat\streaming\StreamHandler.ahk"
        src := FileRead(srcPath)
        if !InStr(src, "for stream in snapshot")
            throw Error("_pollStreamTimer must iterate a snapshot of all active streams (bug #221)")
        if !InStr(src, "_activeStreams.Push(stream)")
            throw Error("sendStreamingRequest must register a per-request stream record (bug #221)")
        if !InStr(src, "_LoadStreamIntoParams(stream)")
            throw Error("each polled stream must be loaded into the requestParams window (bug #221)")
    }
}
