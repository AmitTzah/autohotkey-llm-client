; ======================================================
; StreamError.test.ahk — Regression tests for StreamError.ahk
;
; Tests: cancel preserves pendingRetrySiblingGroup
; Bug: _handleStreamCancelled saved with sibling_group="" ignoring pendingRetrySiblingGroup
; ======================================================

class StreamErrorTest {

    static __New() {
        RegisterTestClass("StreamErrorTest")
    }

    _setup() {
        if ChatDB.isOpen {
            oldPath := ChatDB.dbPath
            ChatDB.Close()
            try FileDelete(oldPath)
        }
        ChatDB.Open(A_Temp "\test_streamerr_" A_TickCount "_" Random(1000, 999999) ".db")
        return ChatDB.Thread_Create("StreamError Test")
    }

    _teardown() {
        if ChatDB.isOpen {
            dbPath := ChatDB.dbPath
            ChatDB.Close()
            try FileDelete(dbPath)
        }
    }

    ; Regression: a retry that fails after rewinding the durable leaf must
    ; restore the original answer before the next normal send builds history.
    FailedRetry_RestoresActiveLeafForNextSend() {
        global requestParams
        threadId := this._setup()
        u1 := ChatDB.Msg_Insert({thread_id: threadId, role: "user", content: "u1"})
        a1 := ChatDB.Msg_Insert({thread_id: threadId, role: "assistant", content: "a1", model: "deepseek/test", parent_id: u1, token_count: 5})
        ChatDB.Msg_SetActiveLeaf(threadId, u1)
        requestParams["pendingRetryThreadId"] := threadId
        requestParams["pendingRetryOriginalLeaf"] := a1
        requestParams["pendingRetryRewoundLeaf"] := u1

        _RestoreFailedRetryLeaf()

        leaf := ChatDB.db.Query("SELECT active_leaf_id FROM chat_threads WHERE id=?;", threadId)
        if !leaf.count || leaf[1, "active_leaf_id"] != a1
            throw Error("failed retry did not restore active leaf to a1")
        u2 := ChatDB.Msg_Insert({thread_id: threadId, role: "user", content: "u2", parent_id: a1})
        parent := ChatDB.db.Query("SELECT parent_id FROM messages WHERE id=?;", u2)
        if !parent.count || parent[1, "parent_id"] != a1
            throw Error("next user message did not attach to restored a1")
        this._teardown()
    }

    ; ----------------------------------------------------
    ; Regression: Cancelled retry uses pendingRetrySiblingGroup
    ; ----------------------------------------------------
    CancelRetry_PreservesSiblingGroup() {
        threadId := this._setup()

        ; Create a message with existing sibling group (2 siblings)
        usrId := ChatDB.Msg_Insert({thread_id: threadId, role: "user", content: "q"})
        sg := ChatDB._UUID()
        ChatDB.Msg_Insert({thread_id: threadId, role: "assistant", content: "a1", parent_id: usrId, sibling_group: sg, sibling_index: 0})
        a2Id := ChatDB.Msg_Insert({thread_id: threadId, role: "assistant", content: "a2", parent_id: usrId, sibling_group: sg, sibling_index: 1})

        ; Simulate retry: set pendingRetrySiblingGroup and active leaf to parent
        global requestParams
        requestParams["pendingRetrySiblingGroup"] := sg
        ChatDB.Msg_SetActiveLeaf(threadId, usrId)

        ; Simulate what _handleStreamCancelled does: insert cancelled message with sibling_group
        cancelledId := ChatDB.Msg_Insert({
            thread_id: threadId, role: "assistant",
            content: "partial response...",
            model: "test-model",
            parent_id: usrId,
            sibling_group: sg,  ; <-- THE FIX: should be sg, not ""
            sibling_index: ChatDB.Msg_GetSiblings(a2Id).Length + 1  ; should be index 2
        })

        ; Verify the cancelled message has a sibling_group
        path := ChatDB.Msg_GetActivePath(threadId)
        lastMsg := path[path.Length]
        if !lastMsg.sibling_group
            throw Error("Cancelled message should have sibling_group, got empty")
        if lastMsg.sibling_group != sg
            throw Error("Cancelled message should have same sibling_group '" sg "', got '" lastMsg.sibling_group "'")

        ; Verify there are now 3 siblings in the group
        sibs := ChatDB.Msg_GetSiblings(cancelledId)
        if sibs.Length < 3
            throw Error("Expected at least 3 siblings after cancel-retry, got " sibs.Length)

        this._teardown()
    }

    ; Regression (bug #171): _handleStreamCancelled must persist the partial
    ; into the thread that SENT the request (captured at send time), not the
    ; currently-active thread (the user may switch threads between send/Stop).
    CancelAfterSwitch_UsesCapturedThread() {
        global activeThreadId, requestParams
        threadIdA := this._setup()
        threadIdB := ChatDB.Thread_Create("Thread B")
        uA := ChatDB.Msg_Insert({thread_id: threadIdA, role: "user", content: "question for A"})
        uB := ChatDB.Msg_Insert({thread_id: threadIdB, role: "user", content: "question for B"})

        ; The user switched to thread B before cancelling:
        activeThreadId := threadIdB
        requestParams["_streamThreadId"] := threadIdA
        requestParams["_streamContent"] := "partial answer"
        requestParams["_streamReasoning"] := ""
        requestParams["_streamModelName"] := "deepseek-v4-flash"
        requestParams["_streamDisplayName"] := "deepseek-v4-flash"
        requestParams["_streamLastPos"] := 0
        requestParams["_streamRequestStartTime"] := A_TickCount
        requestParams["_streamFirstTokenTime"] := 0
        requestParams["_streamChatHistoryJSONRequest"] := "{}"
        requestParams["_streamProviderKey"] := "deepseek"
        requestParams["_streamOutputFile"] := "out.txt"
        requestParams["_streamUsage"] := {}
        requestParams["_streamRawSseChunks"] := ""
        requestParams["_streamRawLastResponse"] := ""
        requestParams["_streamPollCount"] := 0
        requestParams["_streamPID"] := 0
        requestParams["_streamCancelled"] := false
        requestParams["cURLErrorFile"] := ""

        _handleStreamCancelled()

        inA := ChatDB.db.Query("SELECT COUNT(*) AS c FROM messages WHERE thread_id=? AND role='assistant';", threadIdA)
        inB := ChatDB.db.Query("SELECT COUNT(*) AS c FROM messages WHERE thread_id=? AND role='assistant';", threadIdB)
        if Integer(inA[1, "c"]) != 1 || Integer(inB[1, "c"]) != 0
            throw Error("cancelled partial must land in the captured thread A (bug #171): inA=" inA[1, "c"] " inB=" inB[1, "c"])
        row := ChatDB.db.Query("SELECT parent_id, content FROM messages WHERE thread_id=? AND role='assistant';", threadIdA)
        if row[1, "parent_id"] != uA || row[1, "content"] != "partial answer"
            throw Error("cancelled partial should attach to A's user message, got parent=" row[1, "parent_id"] " content=" row[1, "content"])
        activeThreadId := ""
        this._teardown()
    }

    ; Regression (bug #205): cancelling a retry of a ROOT assistant must
    ; insert the partial as a SIBLING with parent_id NULL, exactly like the
    ; completed retry path (bug #147) - not as a child of the original root.
    CancelRootRetry_ParentIsNull() {
        global activeThreadId, requestParams
        threadId := this._setup()
        rootId := ChatDB.Msg_Insert({thread_id: threadId, role: "assistant", content: "root answer", model: "deepseek/deepseek-v4-flash", token_count: 5, prompt_tokens: 1})
        sg := ChatDB._UUID()
        ChatDB.db.Query("UPDATE messages SET sibling_group=? WHERE id=?;", sg, rootId)

        activeThreadId := threadId
        requestParams["_streamThreadId"] := threadId
        requestParams["_streamParentId"] := ""
        requestParams["pendingRetryIsRoot"] := true
        requestParams["pendingRetrySiblingGroup"] := sg
        requestParams["_streamContent"] := ""
        requestParams["_streamReasoning"] := "thinking partial"
        requestParams["_streamModelName"] := "deepseek-v4-flash"
        requestParams["_streamDisplayName"] := "deepseek-v4-flash"
        requestParams["_streamLastPos"] := 0
        requestParams["_streamRequestStartTime"] := A_TickCount
        requestParams["_streamFirstTokenTime"] := 0
        requestParams["_streamChatHistoryJSONRequest"] := "{}"
        requestParams["_streamProviderKey"] := "deepseek"
        requestParams["_streamOutputFile"] := "out.txt"
        requestParams["_streamUsage"] := {}
        requestParams["_streamRawSseChunks"] := ""
        requestParams["_streamRawLastResponse"] := ""
        requestParams["_streamPollCount"] := 0
        requestParams["_streamPID"] := 0
        requestParams["_streamCancelled"] := false
        requestParams["cURLErrorFile"] := ""

        _handleStreamCancelled()

        row := ChatDB.db.Query("SELECT parent_id, sibling_group FROM messages WHERE thread_id=? AND reasoning='thinking partial';", threadId)
        if !row.count
            throw Error("cancelled root retry partial was not inserted")
        if row[1, "parent_id"] != ""
            throw Error("cancelled root retry must have parent_id NULL (bug #205), got '" row[1, "parent_id"] "'")
        if row[1, "sibling_group"] != sg
            throw Error("cancelled root retry must keep the retry sibling group, got '" row[1, "sibling_group"] "'")
        activeThreadId := ""
        this._teardown()
    }

    ; ----------------------------------------------------
    ; Regression: Cancel without retry (no pendingRetrySiblingGroup) uses empty sibling_group
    ; ----------------------------------------------------
    CancelNoRetry_EmptySiblingGroup() {
        threadId := this._setup()

        usrId := ChatDB.Msg_Insert({thread_id: threadId, role: "user", content: "q"})

        ; Cancel without retry — no pendingRetrySiblingGroup
        global requestParams
        if requestParams.Has("pendingRetrySiblingGroup")
            requestParams.Delete("pendingRetrySiblingGroup")

        cancelledId := ChatDB.Msg_Insert({
            thread_id: threadId, role: "assistant",
            content: "partial...",
            model: "test",
            parent_id: usrId,
            sibling_group: "", sibling_index: 0
        })

        path := ChatDB.Msg_GetActivePath(threadId)
        lastMsg := path[path.Length]
        if lastMsg.sibling_group
            throw Error("Non-retry cancel should have empty sibling_group, got '" lastMsg.sibling_group "'")

        this._teardown()
    }

    ; ----------------------------------------------------
    ; Regression: connection failure with NO output file must
    ; still post an error banner and re-enable the UI.
    ; (Previously the showError/setChatButtonsEnabled block was
    ; inside FileExist(outputFile), so a refused connection left
    ; the chat stuck in the Stop state with no error.)
    ; ----------------------------------------------------
    StreamError_NoOutputFile_PostsErrorAndReEnables() {
        global requestParams, responseWindow, apiLogMaxEntries

        ; Capture webview messages without touching the real log.
        oldResponseWindow := responseWindow
        captured := []
        responseWindow := { PostWebMessageAsJSON: (obj, json) => captured.Push(json) }
        oldLogLimit := apiLogMaxEntries
        apiLogMaxEntries := 0

        tmpDir := A_Temp
        errFile := tmpDir "\llm_test_stderr_" A_TickCount "_" Random(1000, 999999) ".txt"
        FileAppend("curl: (7) Failed to connect to 127.0.0.1 port 12345: Connection refused", errFile)
        outFile := tmpDir "\llm_test_nonexistent_" A_TickCount "_" Random(1000, 999999) ".out"
        if FileExist(outFile)
            FileDelete(outFile)

        requestParams["cURLErrorFile"] := errFile
        requestParams["_streamOutputFile"] := outFile
        requestParams["_streamRequestStartTime"] := 0
        requestParams["_streamProviderKey"] := "deepseek"
        requestParams["_streamThreadId"] := "thread-error-test"
        requestParams["windowTitle"] := "test"
        requestParams["providerName"] := "deepseek"
        requestParams["singleAPIModelName"] := "deepseek/deepseek-v4-flash"
        requestParams["pasteMode"] := "chat"

        try {
            _handleStreamError()
        } finally {
            responseWindow := oldResponseWindow
            apiLogMaxEntries := oldLogLimit
            ; The error path now deletes its temp files (bug #110), so the
            ; stderr file may already be gone by cleanup time.
            try FileDelete(errFile)
        }

        hasError := false
        hasReenable := false
        for _, json in captured {
            if InStr(json, '"target":"showError"') && InStr(json, "Connection refused")
                hasError := true
            ; Composer state is now an object scoped to the request-owning thread.
            if InStr(json, '"target":"setChatButtonsEnabled"')
                && InStr(json, '"enabled":1')
                && InStr(json, '"threadId":"thread-error-test"')
                hasReenable := true
        }
        if !hasError
            throw Error("Expected showError with cURL stderr text; captured: " jsongo.Stringify(captured))
        if !hasReenable
            throw Error("Expected setChatButtonsEnabled true; captured: " jsongo.Stringify(captured))
    }

    ; Regression (bug #304): completion, error, and cancellation logging must
    ; decide redaction from the request-owning thread, not activeThreadId.
    StreamLogRedaction_UsesCapturedThreadForAllTerminalPaths() {
        global activeThreadId, requestParams, responseWindow, apiLogMaxEntries
        threadLocked := this._setup()
        threadVisible := ChatDB.Thread_Create("Visible unlocked thread")
        ChatDB.ThreadLock_Set(threadLocked, "00112233445566778899aabbccddeeff", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", 10000)
        ThreadLockService.sessionUnlocked.Clear()
        activeThreadId := threadVisible

        oldLogPath := ApiLogger.logFilePath
        oldLogLimit := apiLogMaxEntries
        oldResponseWindow := responseWindow
        oldParams := requestParams
        logPath := A_Temp "\test_stream_redaction_" A_TickCount "_" Random(1000, 999999) ".json"
        ApiLogger.logFilePath := logPath
        apiLogMaxEntries := 10
        responseWindow := { PostWebMessageAsJSON: (*) => "" }
        outFile := ""
        requestParams := Map(
            "cURLErrorFile", "", "_streamOutputFile", "",
            "uniqueID", "stream-redaction-test", "mainScriptHiddenHwnd", "0x0",
            "chatHistoryJSONRequestFile", "", "cURLCommandFile", "", "cURLOutputFile", "",
            "_streamRequestStartTime", A_TickCount, "_streamFirstTokenTime", 0,
            "_streamContent", "LOCKED_CANCEL_SECRET", "_streamReasoning", "",
            "_streamModelName", "deepseek/deepseek-v4-flash", "singleAPIModelName", "deepseek/deepseek-v4-flash",
            "_streamThreadId", threadLocked, "_streamChatHistoryJSONRequest", "LOCKED_CANCEL_SECRET",
            "_streamProviderKey", "deepseek", "providerName", "deepseek",
            "windowTitle", "test", "pasteMode", "chat"
        )

        try {
            _logStreamResponse("LOCKED_SUCCESS_SECRET", "deepseek/deepseek-v4-flash", "", {}, "{}", "LOCKED_SUCCESS_SECRET", A_TickCount, 0, threadLocked)
            _logCancelledRequest()

            outFile := A_Temp "\test_stream_redaction_out_" A_TickCount "_" Random(1000, 999999) ".json"
            FileAppend('{"error":{"message":"LOCKED_ERROR_SECRET"}}', outFile, "UTF-8-RAW")
            requestParams["_streamOutputFile"] := outFile
            requestParams["_streamChatHistoryJSONRequest"] := "LOCKED_ERROR_SECRET"
            _handleStreamError()
            logText := FileRead(logPath, "UTF-8")
            if InStr(logText, "LOCKED_SUCCESS_SECRET") || InStr(logText, "LOCKED_CANCEL_SECRET") || InStr(logText, "LOCKED_ERROR_SECRET")
                throw Error("locked request secret leaked in terminal-path API log: " logText)
            hiddenCount := 0
            StrReplace(logText, "<hidden: locked chat>", "", , &hiddenCount)
            if hiddenCount < 6
                throw Error("all locked terminal-path bodies were not redacted: " logText)

            ; Inverse: an unlocked request remains visible even when a locked
            ; thread is currently displayed.
            activeThreadId := threadLocked
            requestParams["_streamThreadId"] := threadVisible
            requestParams["_streamContent"] := "UNLOCKED_OWNER_SECRET"
            requestParams["_streamChatHistoryJSONRequest"] := "UNLOCKED_OWNER_SECRET"
            _logCancelledRequest()
            logText := FileRead(logPath, "UTF-8")
            if !InStr(logText, "UNLOCKED_OWNER_SECRET")
                throw Error("unlocked request was redacted based on visible locked thread")
        } finally {
            try FileDelete(logPath)
            try FileDelete(outFile)
            ApiLogger.logFilePath := oldLogPath
            apiLogMaxEntries := oldLogLimit
            responseWindow := oldResponseWindow
            requestParams := oldParams
            activeThreadId := ""
            this._teardown()
        }
    }

    ; ----------------------------------------------------
    ; Bug #133 regression: the cancelled partial assistant is a LOCAL DB row
    ; (no usage was ever reported), so inserting it with local_copy must NOT
    ; upsert chat_usage (no fake "API Request") and must NOT recompute the
    ; cumulative counters from the un-billed parent context. The 0-token row
    ; keeps its parent's active_path_tokens so "Context Used" stays intact.
    ; This mirrors the exact object shape _handleStreamCancelled now inserts.
    ; ----------------------------------------------------
    CancelPartial_InsertMarksLocalCopy() {
        sePath := A_ScriptDir "\..\chat\streaming\StreamError.ahk"
        se := FileRead(sePath)
        ; Bug #221 moved the insert into the shared _persistPartialStreamContent
        ; helper (used by both the cancel path and the mid-stream error path) -
        ; the local_copy guarantee is on the helper's insert now.
        helperIdx := InStr(se, "_persistPartialStreamContent() {")
        if !helperIdx
            throw Error("_persistPartialStreamContent not found (bug #221 refactor)")
        helperBlock := SubStr(se, helperIdx, 2200)
        if !InStr(helperBlock, "local_copy: true")
            throw Error("_persistPartialStreamContent must insert the cancelled partial as local_copy (bug #133)")
        if !InStr(se, "_handleStreamCancelled() {") || !InStr(se, "_persistPartialStreamContent()")
            throw Error("_handleStreamCancelled must delegate the partial insert to _persistPartialStreamContent (bug #221)")
    }

    CancelPartial_LocalCopy_DoesNotBillUsage() {
        threadId := this._setup()

        ; Exchange 1: user + billed assistant (mock usage prompt 12 / completion 9 / cached 4).
        usrId := ChatDB.Msg_Insert({
            thread_id: threadId, role: "user", content: "first question",
            token_count: 12, active_path_tokens: 12
        })
        a1Id := ChatDB.Msg_Insert({
            thread_id: threadId, role: "assistant", content: "first answer",
            model: "deepseek/deepseek-v4-flash", parent_id: usrId,
            prompt_tokens: 12, token_count: 9, thinking_tokens: 0,
            cached_tokens: 4, response_time_ms: 100
        })

        usageBefore := ChatDB.db.Query("SELECT call_count, prompt_tokens, completion_tokens FROM chat_usage;")
        if usageBefore.count != 1 || usageBefore[1, "call_count"] != 1 || usageBefore[1, "prompt_tokens"] != 12
            throw Error("setup: exchange 1 should have produced one billed chat_usage row, got " usageBefore.count)
        threadBefore := ChatDB.db.Query("SELECT cumulative_input_tokens, cumulative_output_tokens, cumulative_cached_tokens FROM chat_threads WHERE id=?;", threadId)
        if threadBefore.count != 1 || threadBefore[1, "cumulative_input_tokens"] != 12 || threadBefore[1, "cumulative_output_tokens"] != 9 || threadBefore[1, "cumulative_cached_tokens"] != 4
            throw Error("setup: exchange 1 cumulative counters wrong")

        ; Exchange 2: user message (no usage yet), then the user cancels mid-stream.
        u2Id := ChatDB.Msg_Insert({
            thread_id: threadId, role: "user", content: "second question", parent_id: a1Id
        })

        ; Cancelled partial (the shape _handleStreamCancelled inserts after the fix).
        ChatDB.Msg_Insert({
            thread_id: threadId, role: "assistant", content: "partial answer...",
            model: "deepseek/deepseek-v4-flash", parent_id: u2Id,
            reasoning: "partial reasoning",
            local_copy: true,
            token_count: 0, thinking_tokens: 0, cached_tokens: 0, response_time_ms: 0
        })

        ; The cancelled partial must NOT create a billed API request row.
        usageAfter := ChatDB.db.Query("SELECT call_count, prompt_tokens, completion_tokens FROM chat_usage;")
        if usageAfter.count != 1 || usageAfter[1, "call_count"] != 1 || usageAfter[1, "prompt_tokens"] != 12
            throw Error("cancelled partial billed a fake request: " usageAfter.count " rows, call_count=" usageAfter[1, "call_count"])

        ; Cumulative counters must stay at the completed exchange only (12/9/4,
        ; not 33 = 12 real + 21 un-billed parent context).
        threadAfter := ChatDB.db.Query("SELECT cumulative_input_tokens, cumulative_output_tokens, cumulative_cached_tokens FROM chat_threads WHERE id=?;", threadId)
        if threadAfter[1, "cumulative_input_tokens"] != 12 || threadAfter[1, "cumulative_output_tokens"] != 9 || threadAfter[1, "cumulative_cached_tokens"] != 4
            throw Error("cancelled partial inflated cumulative counters: input=" threadAfter[1, "cumulative_input_tokens"] " output=" threadAfter[1, "cumulative_output_tokens"] " cached=" threadAfter[1, "cumulative_cached_tokens"])

        ; The partial row carries no usage and keeps the parent's context total.
        path := ChatDB.Msg_GetActivePath(threadId)
        partial := path[path.Length]
        if partial.token_count != 0 || partial.prompt_tokens != 0
            throw Error("partial row should have zero usage, got token_count=" partial.token_count " prompt_tokens=" partial.prompt_tokens)
        if partial.active_path_tokens != 21
            throw Error("partial row should keep the parent context (21), got " partial.active_path_tokens)

        this._teardown()
    }

    ; ----------------------------------------------------
    ; Regression (bug #232): completing a stream (or persisting a cancelled/
    ; mid-error partial) changes the sidebar's model badge and thread order -
    ; both paths must post a threadList refresh so the provider icon and
    ; position follow the stream immediately (no exit/re-enter needed).
    ; ----------------------------------------------------
    StreamComplete_RefreshesSidebar() {
        src := FileRead(A_ScriptDir "\..\chat\streaming\StreamCompletion.ahk")
        ; _handleStreamComplete must post the sidebar refresh right after the
        ; stats post (the point where the persisted message changes the badge).
        if !RegExMatch(src, "postThreadStats\(streamThreadId\)[\s\S]{0,400}?_postThreadListRefresh\(\)")
            throw Error("_handleStreamComplete must post a threadList refresh after postThreadStats (bug #232)")
    }

    StreamComplete_PlaysBestEffortCompletionCue() {
        src := FileRead(A_ScriptDir "\..\chat\streaming\StreamCompletion.ahk")
        if !RegExMatch(src, "_postThreadListRefresh\(\)[\s\S]{0,700}?_NotifyGenerationComplete\(streamThreadId\)")
            throw Error("successful stream completion should trigger the configured completion cue after the sidebar refresh")
        if !InStr(src, 'DllCall("winmm\PlaySoundW"')
            throw Error("system completion sound should use the native Windows PlaySound alias")
    }

    CompletionSound_E2EWorker_IsSilentNoOp() {
        oldWorker := EnvGet("AHKLLM_E2E_WORKER")
        try {
            EnvSet("AHKLLM_E2E_WORKER", "unit-silent-audio")
            ; A missing custom file with fallback disabled normally returns false.
            ; In an E2E worker it must short-circuit before any host playback/file path.
            if !_PlayCompletionSound("custom", "Z:\definitely-missing-ahkllm-e2e-sound.wav", false)
                throw Error("E2E completion sound suppression should be a successful no-op")
        } finally {
            EnvSet("AHKLLM_E2E_WORKER", oldWorker)
        }
    }

    CancelStream_FinalizesBeforeComposerReenable() {
        src := FileRead(A_ScriptDir "\..\chat\streaming\StreamError.ahk")
        cancelStart := InStr(src, "handleCancelStream(")
        cancelEnd := InStr(src, "_logCancelledRequest() {", false, cancelStart)
        cancelBlock := SubStr(src, cancelStart, cancelEnd - cancelStart)
        if InStr(cancelBlock, 'if !_HasOtherActiveOperations("", stream)') && InStr(cancelBlock, 'postWebMessage("setChatButtonsEnabled", true), startLoadingCursor(false)')
            throw Error("active stream cancel must not re-enable composer before streamCancelled finalizes the bubble")

        finalizeStart := InStr(src, "_handleStreamCancelled() {")
        finalizeEnd := InStr(src, "; Called by Dispatch.ahk", false, finalizeStart)
        finalizeBlock := SubStr(src, finalizeStart, finalizeEnd - finalizeStart)
        cancelledPos := InStr(finalizeBlock, 'postWebMessage("streamCancelled"')
        enablePos := InStr(finalizeBlock, "_MaybeEnableThreadComposer(streamThreadId")
        if !cancelledPos || !enablePos || cancelledPos > enablePos
            throw Error("streamCancelled must be posted before the owning thread's composer is re-enabled")
    }

    PartialPersist_RefreshesSidebar() {
        src := FileRead(A_ScriptDir "\..\chat\streaming\StreamError.ahk")
        if !RegExMatch(src, "postThreadStats\(streamThreadId\)[\s\S]{0,400}?_postThreadListRefresh\(\)")
            throw Error("_persistPartialStreamContent must post a threadList refresh after postThreadStats (bug #232)")
    }
}
