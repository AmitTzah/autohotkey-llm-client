; ======================================================
; CodexCliTransport.ahk — one-shot Codex CLI text backend
;
; Contract: one deliberate AhkLLM model action launches exactly one
; `codex exec`. AhkLLM owns conversation history; each invocation receives a
; deterministic JSONL transcript and returns one assistant message. Native
; Codex web search, when requested, remains inside that same invocation.
; ======================================================

class CodexCliTransport {
    static _cachedStatus := ""

    ; Diagnostic-only correlated latency trace. The browser supplies a trace id
    ; on user Send; scope.params carries it through the one-shot Codex request.
    ; Never log prompt/response contents or credentials here.
    static _TraceParams(params, stage, detail := "") {
        if !IsObject(params) || !params.Has("_latencyTraceId") || !params.Has("_latencyTraceStartTick")
            return
        traceId := String(params["_latencyTraceId"])
        elapsed := A_TickCount - params["_latencyTraceStartTick"]
        suffix := detail != "" ? " " detail : ""
        debugLog("[LATENCY][" traceId "] +" elapsed "ms " stage suffix, "Latency")
    }

    static _Trace(owner, stage, detail := "") {
        if !IsObject(owner) || !owner.HasOwnProp("params")
            return
        CodexCliTransport._TraceParams(owner.params, stage, detail)
    }

    static _ProtocolInstructions := "You are the text-generation backend for AhkLLM.`n"
        . "Input on stdin is a chronological JSONL conversation. Each line is an object with exactly role and content fields.`n"
        . "Treat user lines as user messages and assistant lines as prior assistant messages. Produce only the next assistant message.`n"
        . "Do not emit JSON, role labels, or commentary about this protocol unless the conversation explicitly requests them.`n"
        . "Local files, shell commands, apps, plugins, MCP tools, subagents, and local execution are not available.`n"
        . "When AhkLLM enables first-party Codex web search for the turn, use it whenever the user asks to search, browse, look up current information, or otherwise requires fresh web data. Do not claim search is unavailable without attempting the provided web-search capability. When search is disabled, answer without web access."

    static ExecuteRequest(providerInfo, requestFile, outputFile, errorFile, cancelState := "", webSearch := false, reasoning := "", progressCallback := "") {
        CodexCliTransport._Trace(cancelState, "codex.transport.enter")
        unique := A_TickCount "_" Random(1000, 999999)
        prefix := A_Temp "\AhkLLM_Codex_" unique
        promptFile := prefix "_prompt.jsonl"
        instructionFile := prefix "_instructions.txt"
        eventsFile := prefix "_events.jsonl"
        finalFile := prefix "_last.txt"
        statusFile := prefix "_exit.txt"
        batchFile := prefix ".cmd"
        workDir := A_Temp "\AhkLLM-Codex-Work"
        if !DirExist(workDir)
            DirCreate(workDir)

        try {
            ; Fail before inference when Codex is too old or not signed in with
            ; ChatGPT. Newer-than-tested releases are allowed; the actual exec
            ; remains fail-closed if a required strict-config/lockdown control
            ; has become incompatible.
            hadCachedStatus := IsObject(CodexCliTransport._cachedStatus)
            CodexCliTransport._Trace(cancelState, "codex.ensure-ready.begin", "cached=" (hadCachedStatus ? "true" : "false"))
            CodexCliTransport.EnsureReady()
            CodexCliTransport._Trace(cancelState, "codex.ensure-ready.done", "cached=" (hadCachedStatus ? "true" : "false"))
            requestObj := jsongo.Parse(FileRead(requestFile, "UTF-8"))
            prepared := CodexCliTransport.PrepareRequest(requestObj)
            FileOpen(promptFile, "w", "UTF-8-RAW").Write(prepared.transcript)
            FileOpen(instructionFile, "w", "UTF-8-RAW").Write(prepared.instructions)
            CodexCliTransport._Trace(cancelState, "codex.request-files.ready")

            args := CodexCliRuntime.BuildExecArgs(providerInfo.modelName, workDir, instructionFile, finalFile, reasoning, webSearch)
            batch := CodexCliRuntime.BuildBatch(CodexCliRuntime.Executable(), args, promptFile, eventsFile, errorFile, statusFile)
            FileOpen(batchFile, "w", "UTF-8-RAW").Write(batch)
            debugLog("provider=codex model=" providerInfo.modelName " webSearch=" (webSearch ? "live" : "disabled") " reasoning=" reasoning, "CodexCliTransport")

            CodexCliTransport._Trace(cancelState, "codex.exec.begin")
            processResult := CodexCliTransport._RunBatch(batchFile, cancelState, eventsFile, progressCallback)
            CodexCliTransport._Trace(cancelState, "codex.exec.returned", "exit=" processResult.exitCode " cancelled=" (processResult.cancelled ? "true" : "false"))
            if processResult.cancelled
                return { success: false, cancelled: true }

            exitCode := processResult.exitCode
            if exitCode != 0 {
                CodexCliTransport._NormalizeErrorFile(errorFile, exitCode)
                return { success: false, cancelled: false, exitCode: exitCode }
            }
            if !FileExist(finalFile) {
                FileOpen(errorFile, "w", "UTF-8-RAW").Write("Codex CLI completed without producing a final response.")
                return { success: false, cancelled: false, exitCode: exitCode }
            }
            answer := FileRead(finalFile, "UTF-8")
            CodexCliTransport._Trace(cancelState, "codex.final-file.read", "chars=" StrLen(answer))
            if Trim(answer) = "" {
                FileOpen(errorFile, "w", "UTF-8-RAW").Write("Codex CLI returned an empty final response.")
                return { success: false, cancelled: false, exitCode: exitCode }
            }
            eventsText := FileExist(eventsFile) ? FileRead(eventsFile, "UTF-8") : ""
            usage := CodexCliTransport.ExtractUsage(eventsText)
            webSearchCalls := CodexCliTransport.CountWebSearches(eventsText)
            thoughtSummary := CodexCliTransport.ExtractThoughtSummary(eventsText)
            debugLog("webSearchRequested=" (webSearch ? "true" : "false") " webSearchCalls=" webSearchCalls, "CodexCliTransport")
            responseJson := CodexCliTransport.BuildSyntheticResponse(providerInfo.modelName, answer, usage)
            FileOpen(outputFile, "w", "UTF-8-RAW").Write(responseJson)
            CodexCliTransport._Trace(cancelState, "codex.synthetic-response.written", "chars=" StrLen(answer))
            return { success: true, cancelled: false, usage: usage, response: answer, events: eventsText, webSearchCalls: webSearchCalls, thoughtSummary: thoughtSummary }
        } catch Error as e {
            try FileOpen(errorFile, "w", "UTF-8-RAW").Write("Codex CLI request failed: " e.Message)
            debugLog("Codex transport error: " e.Message "`n" e.Stack, "CodexCliTransport")
            return { success: false, cancelled: false, error: e.Message }
        } finally {
            for tempPath in [promptFile, instructionFile, eventsFile, finalFile, statusFile, batchFile] {
                if FileExist(tempPath)
                    try FileDelete(tempPath)
            }
        }
    }

    ; Check installation/version/authentication without invoking `codex exec`.
    ; This is safe to expose as a Settings health check because it consumes no
    ; inference allowance and never reads or copies Codex credentials.
    static CheckStatus(force := true) {
        if !force && IsObject(CodexCliTransport._cachedStatus)
            return CodexCliTransport._cachedStatus

        unique := A_TickCount "_" Random(1000, 999999)
        prefix := A_Temp "\AhkLLM_Codex_Check_" unique
        versionOut := prefix "_version.txt"
        versionErr := prefix "_version_err.txt"
        versionStatus := prefix "_version_exit.txt"
        versionBatch := prefix "_version.cmd"
        loginOut := prefix "_login.txt"
        loginErr := prefix "_login_err.txt"
        loginStatus := prefix "_login_exit.txt"
        loginBatch := prefix "_login.cmd"
        result := {
            installed: false,
            version: "",
            supported: false,
            authenticated: false,
            message: "",
            error: ""
        }

        try {
            versionScript := CodexCliRuntime.BuildProbeBatch(CodexCliRuntime.Executable(), ["--version"], versionOut, versionErr, versionStatus)
            FileOpen(versionBatch, "w", "UTF-8-RAW").Write(versionScript)
            versionProcess := CodexCliTransport._RunBatch(versionBatch)
            versionText := CodexCliTransport._ProbeText(versionOut, versionErr)
            if versionProcess.exitCode != 0 {
                result.message := "Codex CLI was not found or could not start. Install the official Codex CLI, then run 'codex login'."
                result.error := SubStr(Trim(versionText), 1, 600)
                return CodexCliTransport._RememberStatus(result)
            }

            result.installed := true
            result.version := CodexCliRuntime.ExtractVersion(versionText)
            result.supported := result.version != "" && CodexCliRuntime.VersionSupported(result.version)
            if !result.supported {
                if result.version = "" {
                    result.message := "Codex CLI is installed, but AhkLLM could not determine its version. Install Codex " CodexCliRuntime.MIN_SUPPORTED_VERSION " or newer and try again."
                } else {
                    result.message := "Codex CLI v" result.version " is too old. AhkLLM requires Codex " CodexCliRuntime.MIN_SUPPORTED_VERSION " or newer."
                }
                return CodexCliTransport._RememberStatus(result)
            }

            loginScript := CodexCliRuntime.BuildProbeBatch(CodexCliRuntime.Executable(), ["login", "status"], loginOut, loginErr, loginStatus)
            FileOpen(loginBatch, "w", "UTF-8-RAW").Write(loginScript)
            loginProcess := CodexCliTransport._RunBatch(loginBatch)
            loginText := CodexCliTransport._ProbeText(loginOut, loginErr)
            negativeAuth := RegExMatch(loginText, "i)(not logged in|not authenticated|login required|unauthenticated|no (?:stored )?auth)")
            chatGptAuth := RegExMatch(loginText, "i)chatgpt")
            result.authenticated := loginProcess.exitCode = 0 && !negativeAuth && chatGptAuth

            if result.authenticated {
                if CodexCliRuntime.VersionTested(result.version)
                    result.message := "Ready: Codex CLI v" result.version " is signed in with ChatGPT (tested " CodexCliRuntime.TESTED_VERSION_LABEL " family)."
                else
                    result.message := "Ready: Codex CLI v" result.version " is signed in with ChatGPT. This is newer than AhkLLM's tested " CodexCliRuntime.TESTED_VERSION_LABEL " family; compatible newer releases are allowed, and AhkLLM will report an error if a required safe-profile control changed."
            } else if loginProcess.exitCode = 0 && !negativeAuth {
                result.message := "Codex CLI v" result.version " is authenticated, but AhkLLM requires ChatGPT sign-in. Run 'codex login' and choose ChatGPT."
                result.error := SubStr(Trim(loginText), 1, 600)
            } else {
                result.message := "Codex CLI v" result.version " is installed but not signed in with ChatGPT. Run 'codex login' in a terminal."
                result.error := SubStr(Trim(loginText), 1, 600)
            }
            return CodexCliTransport._RememberStatus(result)
        } catch Error as e {
            result.message := "Codex CLI could not be checked."
            result.error := e.Message
            return CodexCliTransport._RememberStatus(result)
        } finally {
            for tempPath in [versionOut, versionErr, versionStatus, versionBatch, loginOut, loginErr, loginStatus, loginBatch] {
                if FileExist(tempPath)
                    try FileDelete(tempPath)
            }
        }
    }

    static _RememberStatus(result) {
        ; Cache only a fully ready status. If installation/login changes after a
        ; failure, the next request should probe again rather than remain stuck.
        CodexCliTransport._cachedStatus := result.installed && result.supported && result.authenticated ? result : ""
        return result
    }

    static EnsureReady() {
        status := CodexCliTransport.CheckStatus(false)
        if status.installed && status.supported && status.authenticated
            return status
        message := status.message != "" ? status.message : "Codex CLI is not ready for AhkLLM."
        throw Error(message)
    }

    static _ProbeText(outputFile, errorFile) {
        out := FileExist(outputFile) ? Trim(FileRead(outputFile, "UTF-8")) : ""
        err := FileExist(errorFile) ? Trim(FileRead(errorFile, "UTF-8")) : ""
        return out (out != "" && err != "" ? "`n" : "") err
    }

    static PrepareRequest(requestObj) {
        if !IsObject(requestObj) || !requestObj.Has("messages") || !(requestObj["messages"] is Array)
            throw Error("Codex CLI requires a chat messages array.")
        systemParts := []
        transcriptLines := []
        for msg in requestObj["messages"] {
            if !IsObject(msg) || !msg.Has("role")
                continue
            role := String(msg["role"])
            content := msg.Has("content") ? CodexCliTransport.ContentText(msg["content"]) : ""
            if role = "system" || role = "developer" {
                if content != ""
                    systemParts.Push(content)
                continue
            }
            if role != "user" && role != "assistant"
                throw Error("Codex CLI backend does not accept role '" role "'.")
            line := Map("role", role, "content", content)
            transcriptLines.Push(jsongo.Stringify(line))
        }
        if !transcriptLines.Length
            throw Error("Codex CLI request has no user/assistant conversation content.")

        instructions := CodexCliTransport._ProtocolInstructions
        if systemParts.Length
            instructions .= "`n`nAhkLLM system instructions:`n" CodexCliRuntime.Join(systemParts, "`n`n")
        return { instructions: instructions, transcript: CodexCliRuntime.Join(transcriptLines, "`n") "`n" }
    }

    static ContentText(content) {
        if !IsObject(content)
            return String(content)
        if content is Array {
            pieces := []
            for part in content {
                if !IsObject(part)
                    continue
                partType := part.Has("type") ? part["type"] : ""
                if partType = "text" {
                    if part.Has("text") && part["text"] != ""
                        pieces.Push(String(part["text"]))
                } else if partType = "image_url" || partType = "input_image" {
                    throw Error("Image input is not yet supported by the Codex CLI backend.")
                }
            }
            return CodexCliRuntime.Join(pieces, "`n`n")
        }
        throw Error("Unsupported Codex message content shape.")
    }

    static CountWebSearches(eventsText) {
        count := 0
        for line in StrSplit(String(eventsText), "`n", "`r") {
            if Trim(line) = ""
                continue
            try event := jsongo.Parse(line)
            catch
                continue
            if !IsObject(event)
                continue
            if event.Has("type") && event["type"] = "item.completed" && event.Has("item") && IsObject(event["item"])
                && event["item"].Has("type") && event["item"]["type"] = "web_search"
                count++
        }
        return count
    }

    ; Build the persisted thought block from only public Codex exec JSONL.
    ; `reasoning` items contain Codex's safe/model-provided summary, not raw
    ; hidden reasoning. Intermediate agent_message items are public commentary;
    ; the final agent_message is the answer and is intentionally excluded.
    static ExtractThoughtSummary(eventsText) {
        lines := StrSplit(String(eventsText), "`n", "`r")
        lastAgentLine := 0
        for idx, line in lines {
            if Trim(line) = ""
                continue
            try event := jsongo.Parse(line)
            catch
                continue
            if !IsObject(event)
                continue
            if !event.Has("type") || event["type"] != "item.completed" || !event.Has("item") || !IsObject(event["item"])
                continue
            item := event["item"]
            if item.Has("type") && item["type"] = "agent_message" && item.Has("text") && Trim(String(item["text"])) != ""
                lastAgentLine := idx
        }

        parts := []
        lastPart := ""
        for idx, line in lines {
            if Trim(line) = ""
                continue
            try event := jsongo.Parse(line)
            catch
                continue
            if !IsObject(event)
                continue
            if !event.Has("type") || event["type"] != "item.completed" || !event.Has("item") || !IsObject(event["item"])
                continue
            item := event["item"]
            if !item.Has("type")
                continue
            itemType := item["type"]
            part := ""
            if itemType = "reasoning" && item.Has("text") {
                part := Trim(String(item["text"]))
            } else if itemType = "agent_message" && idx != lastAgentLine && item.Has("text") {
                part := Trim(String(item["text"]))
            } else if itemType = "web_search" && item.Has("query") {
                query := CodexCliTransport._ActivityText(item["query"])
                if query != ""
                    part := "Web search: " query
            }
            if part != "" && part != lastPart {
                parts.Push(part)
                lastPart := part
            }
        }
        return CodexCliRuntime.Join(parts, "`n`n")
    }

    ; Convert Codex's structured JSONL lifecycle into short, user-visible
    ; activity updates. These are tool/status summaries only — never hidden
    ; chain-of-thought. The callback is optional so probes/tests remain inert.
    static _DrainProgressEvents(eventsFile, state, progressCallback, finalDrain := false) {
        if eventsFile = "" || !FileExist(eventsFile) || !IsObject(progressCallback)
            return
        try text := FileRead(eventsFile, "UTF-8")
        catch
            return

        ; While Codex is still running, leave the final split segment alone:
        ; it may be a JSONL record that is only partially written. Once the
        ; process has exited, the file is stable and a complete final record
        ; is valid even when Codex did not append a trailing newline.
        lines := StrSplit(text, "`n")
        completeCount := finalDrain ? lines.Length : Max(0, lines.Length - 1)
        while state.lineCount < completeCount {
            state.lineCount++
            line := Trim(lines[state.lineCount], " `t`r")
            if line = ""
                continue
            try event := jsongo.Parse(line)
            catch
                continue
            CodexCliTransport._EmitProgressEvent(event, state, progressCallback)
        }
    }

    static _EmitProgressEvent(event, state, progressCallback) {
        if !IsObject(event) || !event.Has("type")
            return
        eventType := event["type"]
        if state.HasOwnProp("traceOwner") && !state.firstEventLogged {
            state.firstEventLogged := true
            CodexCliTransport._Trace(state.traceOwner, "codex.jsonl.first-event", "type=" eventType)
        }
        if state.HasOwnProp("traceOwner") && eventType = "thread.started"
            CodexCliTransport._Trace(state.traceOwner, "codex.thread.started")
        if state.HasOwnProp("traceOwner") && eventType = "turn.started"
            CodexCliTransport._Trace(state.traceOwner, "codex.turn.started")
        ; The agent_message immediately before turn.completed is the final
        ; answer, so never flush the pending message on turn completion.
        if eventType = "turn.completed" {
            if state.HasOwnProp("traceOwner") && state.pendingAgentMessage != ""
                CodexCliTransport._Trace(state.traceOwner, "codex.final-agent-known", "chars=" StrLen(state.pendingAgentMessage))
            if state.HasOwnProp("traceOwner")
                CodexCliTransport._Trace(state.traceOwner, "codex.turn.completed")
            return
        }
        if !event.Has("item") || !IsObject(event["item"])
            return
        item := event["item"]
        if !item.Has("type")
            return
        itemType := item["type"]
        if state.HasOwnProp("traceOwner") && !state.firstItemLogged {
            state.firstItemLogged := true
            CodexCliTransport._Trace(state.traceOwner, "codex.first-item", "event=" eventType " type=" itemType)
        }
        if state.HasOwnProp("traceOwner") && eventType = "item.completed" && itemType = "reasoning"
            CodexCliTransport._Trace(state.traceOwner, "codex.reasoning.completed", "chars=" (item.Has("text") ? StrLen(String(item["text"])) : 0))

        if eventType = "item.completed" && itemType = "agent_message" {
            if state.HasOwnProp("traceOwner") && !state.firstAgentLogged {
                state.firstAgentLogged := true
                CodexCliTransport._Trace(state.traceOwner, "codex.agent-message.completed")
            }
            text := item.Has("text") ? Trim(String(item["text"])) : ""
            ; Two public messages in succession make the previous one
            ; unambiguously intermediate commentary.
            if state.pendingAgentMessage != "" && state.pendingAgentMessage != text
                CodexCliTransport._EmitThoughtPart(state.pendingAgentMessage, progressCallback)
            state.pendingAgentMessage := text
            return
        }

        ; Any subsequent tool/reasoning item proves the preceding public agent
        ; message was commentary rather than the final answer.
        if state.pendingAgentMessage != "" {
            CodexCliTransport._EmitThoughtPart(state.pendingAgentMessage, progressCallback)
            state.pendingAgentMessage := ""
        }

        if eventType = "item.completed" && itemType = "reasoning" {
            text := item.Has("text") ? Trim(String(item["text"])) : ""
            if text != ""
                CodexCliTransport._EmitThoughtPart(text, progressCallback)
            return
        }

        if itemType != "web_search"
            return
        if eventType = "item.started" {
            CodexCliTransport._EmitThoughtPart("Searching the web…", progressCallback, state.searchCount)
            return
        }
        if eventType != "item.completed"
            return

        state.searchCount++
        query := item.Has("query") ? CodexCliTransport._ActivityText(item["query"]) : ""
        content := query != "" ? "Web search: " query : "Web search completed."
        CodexCliTransport._EmitThoughtPart(content, progressCallback, state.searchCount)
    }

    static _EmitThoughtPart(text, progressCallback, searchCount := 0) {
        if Trim(String(text)) = ""
            return
        payload := {
            content: String(text) "`n`n",
            summary: "Thought Process",
            replace: false,
            kind: "reasoning"
        }
        if searchCount
            payload.searchCount := searchCount
        CodexCliTransport._CallProgress(progressCallback, payload)
    }

    static _CallProgress(progressCallback, payload) {
        try progressCallback.Call(payload)
        catch Error as e
            debugLog("Codex progress callback ignored error: " e.Message, "CodexCliTransport")
    }

    static _ActivityText(value) {
        text := Trim(String(value))
        text := StrReplace(text, "`r", " ")
        text := StrReplace(text, "`n", " ")
        return StrLen(text) > 220 ? SubStr(text, 1, 217) "..." : text
    }

    static ExtractUsage(eventsText) {
        usage := { promptTokens: 0, completionTokens: 0, thinkingTokens: 0, cachedTokens: 0, totalTokens: 0 }
        for line in StrSplit(String(eventsText), "`n", "`r") {
            if Trim(line) = ""
                continue
            try event := jsongo.Parse(line)
            catch
                continue
            candidate := CodexCliTransport._UsageCandidate(event)
            if !IsObject(candidate)
                continue
            usage.promptTokens := CodexCliTransport._Number(candidate, ["input_tokens", "prompt_tokens", "inputTokens"], usage.promptTokens)
            usage.completionTokens := CodexCliTransport._Number(candidate, ["output_tokens", "completion_tokens", "outputTokens"], usage.completionTokens)
            usage.thinkingTokens := CodexCliTransport._Number(candidate, ["reasoning_output_tokens", "reasoning_tokens", "thinking_tokens", "thinkingTokens"], usage.thinkingTokens)
            usage.cachedTokens := CodexCliTransport._Number(candidate, ["cached_input_tokens", "cached_tokens", "cachedTokens"], usage.cachedTokens)
            usage.totalTokens := CodexCliTransport._Number(candidate, ["total_tokens", "totalTokens"], usage.totalTokens)
        }
        if !usage.totalTokens
            usage.totalTokens := usage.promptTokens + usage.completionTokens
        return usage
    }

    static _UsageCandidate(event) {
        if !IsObject(event)
            return ""
        for key in ["usage", "token_usage", "tokenUsage"]
            if event.Has(key) && IsObject(event[key])
                return event[key]
        if event.Has("response") && IsObject(event["response"]) {
            response := event["response"]
            if response.Has("usage") && IsObject(response["usage"])
                return response["usage"]
        }
        return ""
    }

    static _Number(node, keys, fallback := 0) {
        for key in keys {
            if node.Has(key) {
                try return Integer(node[key])
            }
        }
        return fallback
    }

    static BuildSyntheticResponse(modelName, answer, usage) {
        payload := Map(
            "model", modelName,
            "choices", [Map("message", Map("role", "assistant", "content", answer))],
            "usage", Map(
                "prompt_tokens", usage.promptTokens,
                "completion_tokens", usage.completionTokens,
                "total_tokens", usage.totalTokens,
                "prompt_tokens_details", Map("cached_tokens", usage.cachedTokens),
                "completion_tokens_details", Map("reasoning_tokens", usage.thinkingTokens)
            )
        )
        return jsongo.Stringify(payload)
    }

    static _RunBatch(batchFile, cancelState := "", eventsFile := "", progressCallback := "") {
        ; Use CreateProcessW rather than AutoHotkey Run/ShellExecute. We need the
        ; exact cmd.exe process handle: ShellExecute can return an intermediary
        ; PID that exits before the wrapper/Codex child, racing response files
        ; and making cancellation unreliable.
        commandLine := '"' A_ComSpec '" /D /S /C ""' batchFile '""'
        commandBuf := Buffer(StrPut(commandLine, "UTF-16") * 2, 0)
        StrPut(commandLine, commandBuf, "UTF-16")
        siSize := A_PtrSize = 8 ? 104 : 68
        piSize := A_PtrSize = 8 ? 24 : 16
        startupInfo := Buffer(siSize, 0)
        processInfo := Buffer(piSize, 0)
        NumPut("UInt", siSize, startupInfo, 0)
        created := DllCall("CreateProcessW",
            "Str", A_ComSpec,
            "Ptr", commandBuf.Ptr,
            "Ptr", 0,
            "Ptr", 0,
            "Int", false,
            "UInt", 0x08000000, ; CREATE_NO_WINDOW
            "Ptr", 0,
            "Ptr", 0,
            "Ptr", startupInfo.Ptr,
            "Ptr", processInfo.Ptr,
            "Int")
        if !created
            throw OSError(A_LastError, "CreateProcessW failed for Codex wrapper")

        processHandle := NumGet(processInfo, 0, "Ptr")
        threadHandle := NumGet(processInfo, A_PtrSize, "Ptr")
        pid := NumGet(processInfo, A_PtrSize * 2, "UInt")
        CodexCliTransport._Trace(cancelState, "codex.process.created", "pid=" pid)
        if threadHandle
            DllCall("CloseHandle", "Ptr", threadHandle)
        if IsObject(cancelState) {
            cancelState.pid := pid
            cancelState.searchPid := pid
            if !cancelState.HasOwnProp("cancelled")
                cancelState.cancelled := false
        }
        cancelled := false
        exitCode := -1
        progressState := { lineCount: 0, searchCount: 0, lastPoll: 0, pendingAgentMessage: "", traceOwner: cancelState, firstEventLogged: false, firstItemLogged: false, firstAgentLogged: false }
        try {
            loop {
                waitResult := DllCall("WaitForSingleObject", "Ptr", processHandle, "UInt", 25, "UInt")
                if waitResult = 0 { ; WAIT_OBJECT_0
                    ; Stop can kill the wrapper from the UI callback before this
                    ; polling loop gets another timeout tick. Preserve that
                    ; user intent instead of misclassifying the killed process
                    ; as an ordinary nonzero Codex exit.
                    if CodexCliTransport._CancellationRequested(cancelState) {
                        cancelled := true
                        if IsObject(cancelState)
                            cancelState.cancelled := true
                    }
                    break
                }
                if waitResult != 0x102 ; WAIT_TIMEOUT
                    throw OSError(A_LastError, "WaitForSingleObject failed for Codex wrapper")

                if IsObject(progressCallback) && eventsFile != "" && A_TickCount - progressState.lastPoll >= 100 {
                    progressState.lastPoll := A_TickCount
                    CodexCliTransport._DrainProgressEvents(eventsFile, progressState, progressCallback)
                }

                if CodexCliTransport._CancellationRequested(cancelState) {
                    cancelled := true
                    if IsObject(cancelState)
                        cancelState.cancelled := true
                    try RunWait('taskkill /PID ' pid ' /T /F', , "Hide")
                    catch
                        DllCall("TerminateProcess", "Ptr", processHandle, "UInt", 1)
                    DllCall("WaitForSingleObject", "Ptr", processHandle, "UInt", 2000, "UInt")
                    break
                }
            }
            CodexCliTransport._Trace(cancelState, "codex.process.exited")
            ; Drain any lifecycle records written immediately before exit.
            ; The process is gone now, so a final JSONL record without a
            ; trailing newline is complete and safe to parse.
            if IsObject(progressCallback) && eventsFile != ""
                CodexCliTransport._DrainProgressEvents(eventsFile, progressState, progressCallback, true)

            code := 0
            if DllCall("GetExitCodeProcess", "Ptr", processHandle, "UInt*", &code, "Int")
                exitCode := code
        } finally {
            if processHandle
                DllCall("CloseHandle", "Ptr", processHandle)
            if IsObject(cancelState) {
                cancelState.pid := 0
                cancelState.searchPid := 0
            }
        }
        return { cancelled: cancelled, exitCode: exitCode }
    }

    static _CancellationRequested(cancelState) {
        if !IsObject(cancelState)
            return false
        if cancelState.HasOwnProp("cancelled") && cancelState.cancelled
            return true
        if cancelState.HasOwnProp("cancelRequested") && cancelState.cancelRequested
            return true
        return cancelState.HasOwnProp("cancelOnEscape") && cancelState.cancelOnEscape && GetKeyState("Esc", "P")
    }

    static _ReadExitCode(statusFile) {
        if !FileExist(statusFile)
            return -1
        text := Trim(FileRead(statusFile, "UTF-8"))
        try return Integer(text)
        catch
            return -1
    }

    static _NormalizeErrorFile(errorFile, exitCode) {
        text := FileExist(errorFile) ? Trim(FileRead(errorFile, "UTF-8")) : ""
        if RegExMatch(text, "i)(auth|login|logged in|unauthori[sz]ed|credential|401)")
            text := "Codex CLI is not authenticated with ChatGPT. Run 'codex login' and choose ChatGPT authentication."
        else if RegExMatch(text, "i)(quota|rate limit|too many requests|429|usage limit|subscription limit)")
            text := "Codex ChatGPT usage limit reached. Try again after your Codex allowance resets or choose another backend."
        else if RegExMatch(text, "i)(unknown option|unrecognized option|unknown config|strict.?config|invalid .*config)")
            text := "This Codex CLI version is incompatible with AhkLLM's safe LLM-only profile. Update AhkLLM/Codex and try again."
        else if text = ""
            text := "Codex CLI exited with code " exitCode "."
        FileOpen(errorFile, "w", "UTF-8-RAW").Write(SubStr(text, 1, 1200))
    }
}
