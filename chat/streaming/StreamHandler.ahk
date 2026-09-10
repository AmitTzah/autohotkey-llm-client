; ----------------------------------------------------
; StreamHandler.ahk — Streaming orchestration
;
; Core polling, SSE reading, finalization, state cleanup.
; Completion/error handling delegated to StreamCompletion.ahk
; and StreamError.ahk.
; ----------------------------------------------------

#Include StreamCompletion.ahk
#Include StreamError.ahk

; Every in-flight request owns its own stream record (output
; file, cURL PID, accumulated content, temp-file paths, ...). Two chat-mode
; commands can be streaming at once - the shared requestParams _stream* keys
; are only a WINDOW onto whichever stream is being processed right now (the
; poll timer swaps per request), so a second command can never clobber the
; first request's state or temp files.
_activeStreams := []
; Search tool loops remain registered while their synchronous backend is in
; flight. This list is separate from _activeStreams because a non-streaming
; chat request can also enter a search loop without having an LLM cURL stream.
_activeToolLoops := []
; Single-shot requests have no polling stream record, but still need an
; ownership record while their initial cURL is blocking.
_activeNonStreamRequests := []
_currentStreamKey := ""

sendStreamingRequest(&chatHistoryJSONRequest, initialRequest := false) {
    debugLog("[STREAM] Started — thread=" activeThreadId)
    try {

    requestStartTime := A_TickCount

    if FileExist(requestParams["cURLOutputFile"]) {
        FileDelete(requestParams["cURLOutputFile"])
    }
    if FileExist(requestParams["cURLErrorFile"]) {
        FileDelete(requestParams["cURLErrorFile"])
    }

    providerInfo := ProviderResolver.Resolve(requestParams["singleAPIModelName"])
    ; Never launch a URL-less cURL command; surface a friendly
    ; "No endpoint configured" error (same helper as the chat request path).
    if !providerInfo.endpoint {
        _ShowEndpointError(providerInfo)
        return
    }
    cURLCommand := CurlBuilder.BuildStream(providerInfo, requestParams["chatHistoryJSONRequestFile"], requestParams["cURLOutputFile"], requestParams["cURLErrorFile"])
    FileOpen(requestParams["cURLCommandFile"], "w", "UTF-8-RAW").Write(cURLCommand)

    Run(cURLCommand, , "Hide", &cURLPID)
    cURLState("set", cURLPID)
    debugLog("cURL started provider=" providerInfo.providerKey " model=" providerInfo.modelName " endpoint=" providerInfo.endpoint " pid=" cURLPID, "StreamHandler")

    sanitizedModel := ModelParser.Sanitize(requestParams["singleAPIModelName"])

    ; Use assistant name as display title when active
    if requestParams.Has("activeAssistantId") && requestParams["activeAssistantId"] {
        asst := AssistantRepo.GetFromSettings(requestParams["activeAssistantId"])
        displayName := asst && asst.name ? asst.name : sanitizedModel
    } else {
        displayName := sanitizedModel
    }

    ; Register this request's stream record (output
    ; file, cURL PID, accumulated content, temp-file paths, retry metadata -
    ; everything the completion/error/cancel handlers read) BEFORE any other
    ; request can overwrite the shared requestParams keys, then load it into
    ; the params window.
    stream := _BuildStreamRecord(chatHistoryJSONRequest, providerInfo, cURLPID, displayName, sanitizedModel, requestStartTime)
    _activeStreams.Push(stream)
    _LoadStreamIntoParams(stream)

    ; Post display title to UI immediately for bubble author during streaming
    ; Post only when this request belongs to the currently visible path;
    ; a mid-stream thread/branch switch must not paint one request into
    ; another view.
    if _shouldPostStreamToUI()
        postWebMessage("streamModelName", { name: displayName, provider: providerInfo.providerKey, threadId: activeThreadId })

    SetTimer(_pollStreamTimer, 100)
    } catch Error as e {
        debugLog("sendStreamingRequest error: " e.Message)
        postWebMessage("setChatButtonsEnabled", true)
        startLoadingCursor(false)
        _PostChatError("Request failed: " e.Message, activeThreadId)
    }
}

; Single-shot (non-streaming) response path for chat-mode
; commands with "Stream Response" OFF. Runs CurlBuilder.Build (plain JSON),
; parses with ResponseParser, then feeds the result through the SAME
; completion/error handlers as streaming (persistence, usage, API log,
; streamDone) by populating the _stream* context keys first.
sendNonStreamingRequest(&chatHistoryJSONRequest) {
    try {
        global _currentStreamKey, activeThreadId
        requestPath := requestParams.Has("_requestPath")
            ? requestParams["_requestPath"].Clone()
            : ChatDB.Msg_GetActivePath(activeThreadId).Clone()
        scope := {
            key: A_TickCount "_" Random(1000, 999999),
            threadId: activeThreadId,
            requestPath: requestPath,
            parentId: requestPath.Length ? requestPath[requestPath.Length].id : "",
            params: requestParams.Clone(),
            pid: 0,
            searchPid: 0,
            cancelled: false
        }
        scope.params["_requestPath"] := requestPath
        _activeNonStreamRequests.Push(scope)
        CodexCliTransport._Trace(scope, "ahk.nonstream.scope-created")
        ; The single-shot path is synchronous and is not tracked
        ; in _activeStreams - clear the current-stream marker so the
        ; _finalizeStreaming cleanup below does not remove another request's
        ; in-flight stream, then restore that stream afterwards.
        _currentStreamKey := ""
        requestStartTime := A_TickCount
        providerInfo := ProviderResolver.Resolve(scope.params["singleAPIModelName"])
        scope.transport := providerInfo.transport
        if providerInfo.transport = "http" && !providerInfo.endpoint {
            _RemoveNonStreamRequest(scope)
            _ShowEndpointError(providerInfo)
            return
        }
        if providerInfo.transport = "codex-cli" {
            _BeginCodexActivity(scope, providerInfo)
            CodexCliTransport._Trace(scope, "ahk.codex.activity-started")
            ; Return from WebMessageReceived(chatSend) before the blocking exec
            ; so a later cancelStream WebView message can interrupt the timer thread.
            SetTimer(_RunCodexNonStreamingRequest.Bind(scope, chatHistoryJSONRequest, providerInfo, requestStartTime), -1)
            CodexCliTransport._Trace(scope, "ahk.codex.timer-scheduled")
            return
        }

        cURLCommand := CurlBuilder.Build(providerInfo, requestParams["chatHistoryJSONRequestFile"], requestParams["cURLOutputFile"])
        FileOpen(requestParams["cURLCommandFile"], "w", "UTF-8-RAW").Write(cURLCommand)
        Run(cURLCommand, , "Hide", &cURLPID)
        scope.pid := cURLPID
        SearchTools.RegisterProcess(scope, cURLPID)
        cURLState("set", cURLPID)
        while ProcessExist(cURLPID) {
            if scope.cancelled
                break
            Sleep 100
        }
        cURLState("set", 0)
        SearchTools.ClearProcess(scope, cURLPID)
        _RemoveNonStreamRequest(scope)

        if scope.cancelled {
            _DeleteToolLoopFiles(scope)
            if !_HasOtherActiveOperations("", "", scope)
                postWebMessage("setChatButtonsEnabled", true), startLoadingCursor(false)
            return
        }

        ; The remaining legacy population/parsing block is retained below for
        ; unit compatibility; the scoped response handler owns the live path.
        return _ProcessNonStreamResponse(scope, chatHistoryJSONRequest, providerInfo, requestStartTime)

        ; Web-search tool loop (single-shot path): the model asked to search —
        ; run the searches, stage the tool exchange, and re-enter the request
        ; pipeline instead of finalizing an empty answer.
    } catch Error as e {
        debugLog("sendNonStreamingRequest error: " e.Message)
        if IsSet(scope)
            _RemoveNonStreamRequest(scope)
        _PostChatError("Request failed: " e.Message, IsSet(scope) && IsObject(scope) ? scope.threadId : activeThreadId)
        if !_HasOtherActiveOperations()
            postWebMessage("setChatButtonsEnabled", true), startLoadingCursor(false)
        _cleanupStreamState()
        deleteTempFiles()
    }
}

_RunCodexNonStreamingRequest(scope, chatHistoryJSONRequest, providerInfo, requestStartTime) {
    CodexCliTransport._Trace(scope, "ahk.codex.timer-fired")
    try {
        reasoning := scope.params.Has("reasoningOverride") ? scope.params["reasoningOverride"] : ""
        webSearch := scope.params.Has("webSearch") && scope.params["webSearch"]
        CodexCliTransport._Trace(scope, "ahk.codex.execute.begin")
        asyncState := CodexCliTransport.BeginRequest(
            providerInfo,
            scope.params["chatHistoryJSONRequestFile"],
            scope.params["cURLOutputFile"],
            scope.params["cURLErrorFile"],
            scope,
            webSearch,
            reasoning,
            _PostCodexActivity.Bind(scope, providerInfo)
        )
        asyncState.scope := scope
        asyncState.chatHistoryJSONRequest := chatHistoryJSONRequest
        asyncState.providerInfo := providerInfo
        asyncState.requestStartTime := requestStartTime
        asyncState.pollTimer := _PollCodexNonStreamingRequest.Bind(asyncState)
        SetTimer(asyncState.pollTimer, 50)
        CodexCliTransport._Trace(scope, "ahk.codex.poll-scheduled")
    } catch Error as e {
        _FailCodexNonStreamingRequest(scope, e)
    }
}

_PollCodexNonStreamingRequest(asyncState) {
    try {
        codexResult := CodexCliTransport.PollRequest(asyncState)
        if !IsObject(codexResult)
            return
        SetTimer(asyncState.pollTimer, 0)
        _CompleteCodexNonStreamingRequest(asyncState, codexResult)
    } catch Error as e {
        SetTimer(asyncState.pollTimer, 0)
        _FailCodexNonStreamingRequest(asyncState.scope, e)
    }
}

_CompleteCodexNonStreamingRequest(asyncState, codexResult) {
    scope := asyncState.scope
    providerInfo := asyncState.providerInfo
    scope.cancelled := codexResult.cancelled
    CodexCliTransport._Trace(scope, "ahk.codex.execute.returned", "cancelled=" (scope.cancelled ? "true" : "false"))
    if codexResult.HasOwnProp("thoughtSummary") && codexResult.thoughtSummary != "" {
        _PostCodexActivity(scope, providerInfo, {
            content: codexResult.thoughtSummary,
            summary: "Thought Process",
            replace: true,
            kind: "reasoning"
        })
        scope.params["_codexReasoningSummary"] := codexResult.thoughtSummary
    }
    _RemoveNonStreamRequest(scope)
    if scope.cancelled {
        _DeleteToolLoopFiles(scope)
        postWebMessage("streamCancelled", { threadId: scope.threadId })
        if !_HasOtherActiveOperations("", "", scope)
            postWebMessage("setChatButtonsEnabled", true), startLoadingCursor(false)
        return
    }
    CodexCliTransport._Trace(scope, "ahk.codex.response-processing.begin")
    _ProcessNonStreamResponse(scope, asyncState.chatHistoryJSONRequest, providerInfo, asyncState.requestStartTime)
}

_FailCodexNonStreamingRequest(scope, e) {
    debugLog("Codex deferred request error: " e.Message "`n" e.Stack, "StreamHandler")
    _RemoveNonStreamRequest(scope)
    _DeleteToolLoopFiles(scope)
    _PostChatError("Request failed: " e.Message, scope.threadId)
    if !_HasOtherActiveOperations("", "", scope)
        postWebMessage("setChatButtonsEnabled", true), startLoadingCursor(false)
}

_RunCodexNonStreamingRequestSyncLegacy(scope, chatHistoryJSONRequest, providerInfo, requestStartTime) {
    CodexCliTransport._Trace(scope, "ahk.codex.timer-fired")
    try {
        reasoning := scope.params.Has("reasoningOverride") ? scope.params["reasoningOverride"] : ""
        webSearch := scope.params.Has("webSearch") && scope.params["webSearch"]
        CodexCliTransport._Trace(scope, "ahk.codex.execute.begin")
        codexResult := CodexCliTransport.ExecuteRequest(
            providerInfo,
            scope.params["chatHistoryJSONRequestFile"],
            scope.params["cURLOutputFile"],
            scope.params["cURLErrorFile"],
            scope,
            webSearch,
            reasoning,
            _PostCodexActivity.Bind(scope, providerInfo)
        )
        scope.cancelled := codexResult.cancelled
        CodexCliTransport._Trace(scope, "ahk.codex.execute.returned", "cancelled=" (scope.cancelled ? "true" : "false"))
        if codexResult.HasOwnProp("thoughtSummary") && codexResult.thoughtSummary != "" {
            ; Normalize the live thought block to the exact public Codex
            ; summary/commentary/tool trace that will be persisted.
            _PostCodexActivity(scope, providerInfo, {
                content: codexResult.thoughtSummary,
                summary: "Thought Process",
                replace: true,
                kind: "reasoning"
            })
            scope.params["_codexReasoningSummary"] := codexResult.thoughtSummary
        }
        _RemoveNonStreamRequest(scope)
        if scope.cancelled {
            _DeleteToolLoopFiles(scope)
            postWebMessage("streamCancelled", { threadId: scope.threadId })
            if !_HasOtherActiveOperations("", "", scope)
                postWebMessage("setChatButtonsEnabled", true), startLoadingCursor(false)
            return
        }
        CodexCliTransport._Trace(scope, "ahk.codex.response-processing.begin")
        _ProcessNonStreamResponse(scope, chatHistoryJSONRequest, providerInfo, requestStartTime)
    } catch Error as e {
        debugLog("Codex deferred request error: " e.Message "`n" e.Stack, "StreamHandler")
        _RemoveNonStreamRequest(scope)
        _DeleteToolLoopFiles(scope)
        _PostChatError("Request failed: " e.Message, scope.threadId)
        if !_HasOtherActiveOperations("", "", scope)
            postWebMessage("setChatButtonsEnabled", true), startLoadingCursor(false)
    }
}

; Codex exec is one-shot at the response boundary, but --json stdout is a live
; lifecycle stream. Paint only provider-supplied public reasoning/commentary
; and safe tool activity into the normal Thought Process block so users get
; immediate feedback without exposing hidden reasoning or creating another turn.
_BeginCodexActivity(scope, providerInfo) {
    modelName := ModelParser.Sanitize(scope.params["singleAPIModelName"])
    displayName := modelName
    if scope.params.Has("activeAssistantId") && scope.params["activeAssistantId"] {
        asst := AssistantRepo.GetFromSettings(scope.params["activeAssistantId"])
        if asst && asst.name
            displayName := asst.name
    }
    ; Do not invent a Thinking... line. The loading indicator remains until
    ; Codex actually emits a public reasoning summary, commentary, or tool item.
    postWebMessage("streamModelName", { name: displayName, provider: providerInfo.providerKey, threadId: scope.threadId })
}

_PostCodexActivity(scope, providerInfo, progress) {
    if !IsObject(scope) || !IsObject(progress)
        return
    if scope.HasOwnProp("cancelled") && scope.cancelled
        return
    global providers
    collapsed := false
    if IsObject(providerInfo) && providers.Has(providerInfo.providerKey) {
        p := providers[providerInfo.providerKey]
        if p.HasOwnProp("collapseThinking")
            collapsed := p.collapseThinking
    }
    data := {
        content: progress.HasOwnProp("content") ? progress.content : "",
        collapsed: collapsed,
        kind: progress.HasOwnProp("kind") ? progress.kind : "reasoning",
        replace: progress.HasOwnProp("replace") ? progress.replace : false,
        threadId: scope.threadId
    }
    if progress.HasOwnProp("summary")
        data.summary := progress.summary
    if progress.HasOwnProp("searchCount")
        data.searchCount := progress.searchCount
    postWebMessage("streamReasoning", data)
}

_ProcessNonStreamResponse(scope, chatHistoryJSONRequest, providerInfo, requestStartTime) {
    global requestParams
    visibleParams := requestParams
    try {
        requestParams := scope.params
        raw := FileExist(requestParams["cURLOutputFile"])
            ? FileOpen(requestParams["cURLOutputFile"], "r", "UTF-8-RAW").Read()
            : ""
        requestParams["_streamOutputFile"] := requestParams["cURLOutputFile"]
        requestParams["_streamLastPos"] := 0
        requestParams["_streamContent"] := ""
        requestParams["_streamReasoning"] := requestParams.Has("_codexReasoningSummary") ? requestParams["_codexReasoningSummary"] : ""
        sanitizedModel := ModelParser.Sanitize(requestParams["singleAPIModelName"])
        requestParams["_streamModelName"] := sanitizedModel
        requestParams["_streamDisplayName"] := sanitizedModel
        if requestParams.Has("activeAssistantId") && requestParams["activeAssistantId"] {
            asst := AssistantRepo.GetFromSettings(requestParams["activeAssistantId"])
            requestParams["_streamDisplayName"] := asst && asst.name ? asst.name : sanitizedModel
        }
        requestParams["_streamFirstTokenTime"] := 0
        requestParams["_streamUsage"] := {}
        requestParams["_streamProviderKey"] := providerInfo.providerKey
        requestParams["_streamRawSseChunks"] := ""
        requestParams["_streamRawLastResponse"] := raw
        requestParams["_streamPendingLine"] := ""
        requestParams["_streamPollCount"] := 0
        requestParams["_streamRequestStartTime"] := requestStartTime
        requestParams["_streamChatHistoryJSONRequest"] := chatHistoryJSONRequest
        requestParams["_streamPID"] := 0
        requestParams["_streamCancelled"] := false
        requestParams["_streamThreadId"] := scope.threadId
        requestParams["_streamParentId"] := scope.parentId
        requestParams["_streamLogWindowTitle"] := requestParams["windowTitle"]
        requestParams["_streamLogProviderName"] := requestParams["providerName"]
        requestParams["_streamLogModel"] := requestParams["singleAPIModelName"]
        requestParams["_streamLogPasteMode"] := requestParams["pasteMode"]

        if raw = "" {
            _handleStreamError()
            _cleanupStreamState()
            return
        }
        response := ResponseParser.ParseChatResponse(jsongo.Parse(raw))
        CodexCliTransport._Trace(scope, "ahk.codex.synthetic-response.parsed", "chars=" StrLen(response.response))
        if response.toolCalls.Length {
            _handleNonStreamToolCalls(response.toolCalls, scope)
            return
        }
        if !response.response {
            _handleStreamError()
            _cleanupStreamState()
            return
        }
        requestParams["_streamContent"] := response.response
        requestParams["_streamUsage"] := response.usage
        if response.model != ""
            requestParams["_streamModelName"] := ModelParser.Sanitize(response.model)
        requestParams["_streamFirstTokenTime"] := A_TickCount
        CodexCliTransport._Trace(scope, "ahk.codex.finalize.begin")
        _finalizeStreaming()
    } finally {
        requestParams := visibleParams
    }
}

; Web-search tool loop for the non-streaming (single-shot) chat path. Runs
; synchronously: execute the searches, persist the search context, stage the
; ephemeral tool messages, then re-enter _BuildAndFireRequest (which rebuilds
; the request with the tool exchange and recurses back here until the model
; answers with plain content).
_handleNonStreamToolCalls(toolCalls, ownerScope := "") {
    try {
        global activeThreadId
        if IsObject(ownerScope) {
            scopeParams := ownerScope.params.Clone()
            threadId := ownerScope.threadId
            sendPath := ownerScope.requestPath
            parentId := ownerScope.parentId
        } else {
            scopeParams := requestParams.Clone()
            threadId := activeThreadId
            sendPath := ChatDB.Msg_GetActivePath(threadId)
            parentId := sendPath.Length ? sendPath[sendPath.Length].id : ""
        }
        scopeParams["_requestPath"] := sendPath.Clone()
        loopState := SearchToolExecutor.NewLoopState(threadId, parentId, scopeParams, 0)
        loopState.placeholderQuery := SearchToolExecutor.FirstQuery(toolCalls)
        _activeToolLoops.Push(loopState)
        loopCount := loopState.loopCount
        loopCount++
        if SearchToolExecutor.MaxIterationsReached(loopCount) {
            _failToolLoop("Web search stopped: too many search rounds (max " SearchTools.MAX_TOOL_ITERATIONS ").", "", loopState)
            return
        }

        ; Immediate UI feedback: show the query card ("Searching…") while the
        ; backend runs, then update it in place with the real result.
        ctxId := SearchToolExecutor.PrepareFollowUp(toolCalls, threadId, parentId, loopState)
        if ctxId && activeThreadId = threadId
            postWebMessage("appendChatMessage", { id: ctxId, role: "user", content: SearchToolExecutor.PlaceholderContent(toolCalls) })

        providerInfo := ProviderResolver.Resolve(scopeParams["singleAPIModelName"])
        ; Live progress: re-render the search card as the backend streams.
        execResult := SearchToolExecutor.Execute(toolCalls, providerInfo, "", _postSearchProgress.Bind(loopState), loopState)
        if SearchTools.IsCancelled(loopState) {
            ; User pressed Stop while the search ran: cancel the card and do
            ; NOT fire the follow-up request.
            _handleSearchCancelledCard(loopState)
            _FinishToolLoop(loopState)
            if !_HasOtherActiveOperations(loopState)
                postWebMessage("setChatButtonsEnabled", true), startLoadingCursor(false)
            return
        }
        ; Every search in this round failed (empty backend answers, API
        ; errors, missing keys): surface the failure card and STOP the loop -
        ; no follow-up request, so the model cannot keep firing more failed
        ; queries (real-API report 2026-08-16: four failed search cards in a
        ; row before the model gave up).
        if execResult.successCount = 0 {
            _failToolLoop(execResult.failureText != "" ? execResult.failureText : "Web search failed.", execResult.contextText, loopState)
            return
        }
        SearchToolExecutor.QueueFollowUp(execResult, threadId, parentId, loopCount, loopState)
        if ctxId && activeThreadId = threadId
            postWebMessage("updateChatMessage", { id: ctxId, role: "user", content: execResult.contextText })

        _FinishToolLoop(loopState, "", true)
        _BuildAndFireRequestForScope(loopState)
    } catch Error as e {
        debugLog("_handleNonStreamToolCalls error: " e.Message "`n" e.Stack)
        _failToolLoop("Web search failed: " e.Message, "", IsSet(loopState) ? loopState : "")
    }
}

_pollStreamTimer() {
    ; Poll every in-flight request; concurrent chat-mode commands
    ; fire while the first is still streaming, and each request owns its own
    ; output file / cURL PID / accumulated content. The shared requestParams
    ; keys are swapped per stream via _LoadStreamIntoParams.
    if !_activeStreams.Length {
        SetTimer(, 0)
        return
    }
    snapshot := _activeStreams.Clone()
    for stream in snapshot {
        if !_StreamIsActive(stream.key)
            continue
        _LoadStreamIntoParams(stream)
        try {
            pid := requestParams["_streamPID"]
            if !ProcessExist(pid) {
                SetTimer(, 0)
                _finalizeStreaming()
            } else {
                _readStreamChunkFromParams()
                requestParams["_streamPollCount"]++
                _SaveStreamFromParams(stream)
            }
        } catch Error as e {
            debugLog("_pollStreamTimer error: " e.Message "`n" e.Stack)
            SetTimer(, 0)
            _finalizeStreaming()
        }
    }
    if _activeStreams.Length = 0 {
        SetTimer(, 0)
    } else {
        SetTimer(_pollStreamTimer, 100)
    }
}

_readStreamChunkFromParams() {
    state := _StreamStateFromParams()
    _readAndProcessStream(state, _shouldPostStreamToUI())
    _ParamsFromStreamState(state)
}

; Stream content/reasoning/model posts are painted only into
; the WebView when the CURRENT active path is the one that sent the request.
; The DB completion still runs for the captured thread regardless.
_shouldPostStreamToUI() {
    if !requestParams.Has("_streamThreadId")
        return false
    if activeThreadId != requestParams["_streamThreadId"]
        return false
    ; Locked chats: an in-flight stream's partial content must not be painted
    ; into the UI while the thread is locked (the DB completion still runs -
    ; unlocking later re-paints it via _RepostActiveStreamForThread).
    if ThreadLockService.IsLocked(requestParams["_streamThreadId"]) &&
        !ThreadLockService.IsUnlockedInSession(requestParams["_streamThreadId"])
        return false
    ; Root retries have no request parent and remain current while
    ; the thread is still the active one.
    if requestParams.Has("pendingRetryIsRoot") && requestParams["pendingRetryIsRoot"]
        return true
    if !requestParams.Has("_streamParentId")
        return true ; legacy flows without a captured parent
    path := ChatDB.Msg_GetActivePath(activeThreadId)
    if !path.Length
        return false
    return path[path.Length].id = requestParams["_streamParentId"]
}

; When the user navigates BACK to the sending thread/branch while its stream is
; still in flight, re-paint the accumulated partial so the UI is not blank.
_RepostActiveStreamForThread(threadId) {
    ; Find the newest in-flight stream that sent a request for this
    ; thread (multiple commands can be streaming at once).
    stream := _FindLatestStreamForThread(threadId)
    if !stream
        return
    _LoadStreamIntoParams(stream)
    if !_shouldPostStreamToUI()
        return
    if stream.displayName != ""
        postWebMessage("streamModelName", { name: stream.displayName, provider: stream.providerKey, threadId: stream.threadId })
    reasoning := stream.reasoning
    content := stream.content
    if reasoning != ""
        postWebMessage("streamReasoning", { content: reasoning, collapsed: false })
    if content != ""
        postWebMessage("streamContent", content)
}

; Build the per-request stream record and capture every field
; the completion/error/cancel handlers read from requestParams["_stream*"],
; plus the request's OWN temp-file paths, cURL PID, and retry metadata, so a
; second concurrent request can never clobber the first one's state.
_BuildStreamRecord(chatHistoryJSONRequest, providerInfo, cURLPID, displayName, sanitizedModel, requestStartTime) {
    retryIsRoot := requestParams.Has("pendingRetryIsRoot") && requestParams["pendingRetryIsRoot"]
    retrySiblingGroup := requestParams.Has("pendingRetrySiblingGroup") ? requestParams["pendingRetrySiblingGroup"] : ""
    requestPath := requestParams.Has("_requestPath")
        ? requestParams["_requestPath"]
        : ChatDB.Msg_GetActivePath(activeThreadId)
    requestPath := requestPath.Clone()
    requestParamsSnapshot := requestParams.Clone()
    requestParamsSnapshot["_requestPath"] := requestPath
    stream := {
        key: A_TickCount "_" Random(1000, 999999),
        requestParamsSnapshot: requestParamsSnapshot,
        requestPath: requestPath,
        requestLeafId: requestPath.Length ? requestPath[requestPath.Length].id : "",
        phase: "stream",
        toolLoopState: "",
        outputFile: requestParams["cURLOutputFile"],
        lastPos: 0,
        content: "",
        reasoning: "",
        modelName: sanitizedModel,
        displayName: displayName,
        firstTokenTime: 0,
        usage: {},
        providerKey: providerInfo.providerKey,
        rawSseChunks: "",
        rawLastResponse: "",
        ; Buffer a `data:` JSON line when it is split across poll boundaries.
        ; here (as the incomplete trailing fragment) until the next poll
        ; completes it.
        pendingLine: "",
        errorMessage: "",
        pollCount: 0,
        requestStartTime: requestStartTime,
        chatHistoryJSONRequest: chatHistoryJSONRequest,
        pid: cURLPID,
        cancelled: false,
        ; Web-search tool loop state (per round).
        toolCalls: Map(),
        toolLoopCount: requestParams.Has("_toolLoopCount") ? requestParams["_toolLoopCount"] : 0,
        ; Capture the thread that sent this request.
        threadId: activeThreadId,
        parentId: "",
        ; Capture request log metadata at send time.
        logWindowTitle: requestParams["windowTitle"],
        logProviderName: requestParams["providerName"],
        logModel: requestParams["singleAPIModelName"],
        logPasteMode: requestParams["pasteMode"],
        retryIsRoot: retryIsRoot,
        retrySiblingGroup: retrySiblingGroup,
        ; Keep each request's own temp-file paths so cleanup cannot target another request.
        ; THESE, not whatever request started later).
        requestFile: requestParams["chatHistoryJSONRequestFile"],
        cURLCommandFile: requestParams["cURLCommandFile"],
        errorFile: requestParams["cURLErrorFile"]
    }
    ; Capture the last message of the request path at send time.
    ; A root retry has no parent.
    if !retryIsRoot {
        if requestPath.Length
            stream.parentId := requestPath[requestPath.Length].id
    }
    return stream
}

; Load a per-request stream record into the shared requestParams window so the
; existing read/completion/error/cancel handlers keep working unchanged. Also
; swaps in THIS request's temp-file paths (deleteTempFiles and
; appendToChatHistory must act on this request's files) and its
; retry metadata, all scoped to the request.
_LoadStreamIntoParams(stream) {
    global _currentStreamKey
    requestParams["_streamOutputFile"]       := stream.outputFile
    requestParams["_streamLastPos"]          := stream.lastPos
    requestParams["_streamContent"]          := stream.content
    requestParams["_streamReasoning"]        := stream.reasoning
    requestParams["_streamModelName"]        := stream.modelName
    requestParams["_streamDisplayName"]      := stream.displayName
    requestParams["_streamFirstTokenTime"]   := stream.firstTokenTime
    requestParams["_streamUsage"]            := stream.usage
    requestParams["_streamProviderKey"]      := stream.providerKey
    requestParams["_streamRawSseChunks"]     := stream.rawSseChunks
    requestParams["_streamRawLastResponse"]  := stream.rawLastResponse
    requestParams["_streamPendingLine"]      := stream.pendingLine
    requestParams["_streamErrorMessage"]     := stream.errorMessage
    requestParams["_streamPollCount"]        := stream.pollCount
    requestParams["_streamRequestStartTime"] := stream.requestStartTime
    requestParams["_streamChatHistoryJSONRequest"] := stream.chatHistoryJSONRequest
    requestParams["_streamPID"]              := stream.pid
    requestParams["_streamCancelled"]        := stream.cancelled
    requestParams["_streamToolCalls"]        := stream.HasOwnProp("toolCalls") ? stream.toolCalls : Map()
    requestParams["_streamToolLoopCount"]    := stream.HasOwnProp("toolLoopCount") ? stream.toolLoopCount : 0
    requestParams["_streamThreadId"]         := stream.threadId
    requestParams["_streamParentId"]         := stream.parentId
    requestParams["_requestPath"]            := stream.HasOwnProp("requestPath") ? stream.requestPath : []
    requestParams["_streamLogWindowTitle"]   := stream.logWindowTitle
    requestParams["_streamLogProviderName"]  := stream.logProviderName
    requestParams["_streamLogModel"]         := stream.logModel
    requestParams["_streamLogPasteMode"]     := stream.logPasteMode
    requestParams["chatHistoryJSONRequestFile"] := stream.requestFile
    requestParams["cURLCommandFile"]         := stream.cURLCommandFile
    requestParams["cURLOutputFile"]          := stream.outputFile
    requestParams["cURLErrorFile"]           := stream.errorFile
    if stream.retryIsRoot
        requestParams["pendingRetryIsRoot"] := true
    else if requestParams.Has("pendingRetryIsRoot")
        requestParams.Delete("pendingRetryIsRoot")
    if stream.retrySiblingGroup != ""
        requestParams["pendingRetrySiblingGroup"] := stream.retrySiblingGroup
    else if requestParams.Has("pendingRetrySiblingGroup")
        requestParams.Delete("pendingRetrySiblingGroup")
    _currentStreamKey := stream.key
}

; Copy the mutable poll/read fields back from the requestParams window into
; the per-request record.
_SaveStreamFromParams(stream) {
    stream.lastPos          := requestParams["_streamLastPos"]
    stream.content          := requestParams["_streamContent"]
    stream.reasoning        := requestParams["_streamReasoning"]
    stream.modelName        := requestParams["_streamModelName"]
    stream.firstTokenTime   := requestParams["_streamFirstTokenTime"]
    stream.usage            := requestParams["_streamUsage"]
    stream.rawSseChunks     := requestParams["_streamRawSseChunks"]
    stream.rawLastResponse  := requestParams["_streamRawLastResponse"]
    stream.pendingLine      := requestParams["_streamPendingLine"]
    stream.errorMessage     := requestParams.Has("_streamErrorMessage") ? requestParams["_streamErrorMessage"] : ""
    stream.pollCount        := requestParams["_streamPollCount"]
    stream.cancelled        := requestParams.Has("_streamCancelled") && requestParams["_streamCancelled"]
    stream.toolCalls        := requestParams.Has("_streamToolCalls") ? requestParams["_streamToolCalls"] : Map()
    stream.toolLoopCount    := requestParams.Has("_streamToolLoopCount") ? requestParams["_streamToolLoopCount"] : 0
}

_StreamIsActive(key) {
    for stream in _activeStreams
        if stream.key = key
            return true
    return false
}

_RemoveStreamFromActive(key) {
    if !key
        return
    for i, stream in _activeStreams {
        if stream.key = key {
            _activeStreams.RemoveAt(i)
            return
        }
    }
}

; After a request finalizes, reload the last remaining stream's state into
; requestParams so its next poll (and any non-timer code) sees the right data.
_RestoreLastActiveStream() {
    global _currentStreamKey
    if _activeStreams.Length {
        _LoadStreamIntoParams(_activeStreams[_activeStreams.Length])
    } else {
        _currentStreamKey := ""
        ; No stream owns the shared requestParams window anymore. A private
        ; tool-loop scope may retain its own path, but the shared window must
        ; not leak the completed stream's request path into the next request.
        if requestParams.Has("_requestPath")
            requestParams.Delete("_requestPath")
    }
}

; Check whether another request is still streaming besides the one currently
; loaded in requestParams? The composer must stay in Stop mode while ANY
; request is in flight, so setChatButtonsEnabled(true) is only posted when the
; finishing request is the LAST one.
_HasOtherActiveStreams() {
    current := _currentStreamKey
    count := 0
    for stream in _activeStreams
        if stream.key != current
            count++
    return count > 0
}

; The newest in-flight stream that SENT a request for this thread.
_FindLatestStreamForThread(threadId) {
    found := ""
    for stream in _activeStreams
        if stream.threadId = threadId
            found := stream
    return found
}

_FindStreamByKey(key) {
    if !key
        return ""
    for stream in _activeStreams
        if stream.key = key
            return stream
    return ""
}

_FindToolLoopForThread(threadId) {
    found := ""
    for loopState in _activeToolLoops
        if loopState.threadId = threadId
            found := loopState
    return found
}

_FindNonStreamRequestForThread(threadId) {
    found := ""
    for scope in _activeNonStreamRequests
        if scope.threadId = threadId
            found := scope
    return found
}

_RemoveNonStreamRequest(scope) {
    if !IsObject(scope)
        return
    for i, item in _activeNonStreamRequests {
        if item.key = scope.key {
            _activeNonStreamRequests.RemoveAt(i)
            return
        }
    }
}

; Aggregate in-flight check used by tool-loop cleanup. The current operation
; can be excluded while it is being removed; other streams/searches keep the
; composer in Stop mode.
_HasOtherActiveOperations(currentLoop := "", currentStream := "", currentRequest := "") {
    for stream in _activeStreams
        if !IsObject(currentStream) || stream.key != currentStream.key
            return true
    for loopState in _activeToolLoops
        if !IsObject(currentLoop) || loopState.key != currentLoop.key
            return true
    for scope in _activeNonStreamRequests
        if !IsObject(currentRequest) || scope.key != currentRequest.key
            return true
    return false
}

_RemoveToolLoop(loopState) {
    if !IsObject(loopState)
        return
    for i, item in _activeToolLoops {
        if item.key = loopState.key {
            _activeToolLoops.RemoveAt(i)
            return
        }
    }
}

; Continue a tool loop with its captured thread/settings map. The global
; requestParams/activeThreadId variables are swapped only for the synchronous
; build/send call; the new stream record captures the scoped map before the
; visible thread is restored.
_BuildAndFireRequestForScope(loopState) {
    global requestParams, activeThreadId
    visibleParams := requestParams
    visibleThreadId := activeThreadId
    loopState.params["_requestPath"] := loopState.requestPath.Clone()
    requestParams := loopState.params
    activeThreadId := loopState.threadId
    try {
        return _BuildAndFireRequest()
    } finally {
        loopState.params := requestParams
        requestParams := visibleParams
        activeThreadId := visibleThreadId
    }
}

_DeleteToolLoopFiles(loopState) {
    if !IsObject(loopState) || !IsObject(loopState.params)
        return
    for key in ["chatHistoryJSONRequestFile", "cURLCommandFile", "cURLOutputFile", "cURLErrorFile"] {
        if loopState.params.Has(key) {
            p := loopState.params[key]
            if p && FileExist(p)
                try FileDelete(p)
        }
    }
}

_FinishToolLoop(loopState, stream := "", preserveStaged := false) {
    if !IsObject(loopState)
        return
    _RemoveToolLoop(loopState)
    _DeleteToolLoopFiles(loopState)
    if !preserveStaged {
        for key in ["_pendingToolMessages", "_pendingSearchContextIds", "_toolLoopCount"] {
            if loopState.params.Has(key)
                loopState.params.Delete(key)
        }
    }
    if IsObject(stream) {
        stream.phase := "finished"
        stream.toolLoopState := ""
        _RemoveStreamFromActive(stream.key)
        if _currentStreamKey = stream.key
            _RestoreLastActiveStream()
        if _activeStreams.Length
            SetTimer(_pollStreamTimer, 100)
    }
}

; Kill the cURL process of the CURRENTLY loaded stream without touching
; another concurrent request's PID. Each stream record owns its process.
_CloseCurrentStreamPID() {
    if !requestParams.Has("_streamPID")
        return
    pid := requestParams["_streamPID"]
    if pid && ProcessExist(pid) {
        ; Kill the whole tree (cmd wrapper + cURL child) so no orphan keeps
        ; writing to the output file after the stream finalizes.
        RunWait('taskkill /PID ' pid ' /T /F', , "Hide")
    }
    if cURLState("get") = pid
        cURLState("set", 0)
}

; Clear the global cURLState only when it still tracks the CURRENT stream's
; PID; never clobber another concurrent request's PID.
_ClearCurrentStreamPID() {
    if !requestParams.Has("_streamPID")
        return
    pid := requestParams["_streamPID"]
    if cURLState("get") = pid
        cURLState("set", 0)
}

; Build a stream state Map from requestParams.
_StreamStateFromParams() {
    return {
        outputFile: requestParams["_streamOutputFile"],
        lastPos: requestParams["_streamLastPos"],
        content: requestParams["_streamContent"],
        reasoning: requestParams["_streamReasoning"],
        modelName: requestParams["_streamModelName"],
        firstTokenTime: requestParams["_streamFirstTokenTime"],
        usage: requestParams["_streamUsage"],
        providerKey: requestParams["_streamProviderKey"],
        rawSseChunks: requestParams["_streamRawSseChunks"],
        rawLastResponse: requestParams["_streamRawLastResponse"],
        pendingLine: requestParams["_streamPendingLine"],
        errorMessage: requestParams.Has("_streamErrorMessage") ? requestParams["_streamErrorMessage"] : "",
        toolCalls: requestParams.Has("_streamToolCalls") ? requestParams["_streamToolCalls"] : Map()
    }
}

; Write stream state back into requestParams.
_ParamsFromStreamState(state) {
    requestParams["_streamLastPos"] := state.lastPos
    requestParams["_streamContent"] := state.content
    requestParams["_streamReasoning"] := state.reasoning
    requestParams["_streamModelName"] := state.modelName
    requestParams["_streamFirstTokenTime"] := state.firstTokenTime
    requestParams["_streamUsage"] := state.usage
    requestParams["_streamRawSseChunks"] := state.rawSseChunks
    requestParams["_streamRawLastResponse"] := state.rawLastResponse
    requestParams["_streamPendingLine"] := state.pendingLine
    if state.HasOwnProp("errorMessage") && state.errorMessage != "" {
        requestParams["_streamErrorMessage"] := state.errorMessage
    } else if requestParams.Has("_streamErrorMessage") {
        requestParams.Delete("_streamErrorMessage")
    }
    requestParams["_streamToolCalls"] := state.toolCalls
}

_readFileChunk(state) {
    if !FileExist(state.outputFile)
        return ""
    ; Read cURL output as raw bytes and advance only past complete UTF-8 characters.
    ; cursor past COMPLETE UTF-8 characters. A poll boundary that splits a
    ; multibyte character leaves its leading bytes unconsumed (lastPos stays
    ; before them), so the next poll re-reads them together with the rest and
    ; decodes the character correctly without producing U+FFFD from a split
    ; multibyte sequence.
    file := FileOpen(state.outputFile, "r")
    if !file
        return ""
    file.Pos := state.lastPos
    avail := file.Length - state.lastPos
    if avail <= 0 {
        file.Close()
        return ""
    }
    newBuf := Buffer(avail)
    file.RawRead(newBuf, avail)
    file.Close()

    complete := _UTF8CompletePrefixLen(newBuf, avail)
    state.lastPos += complete
    return complete > 0 ? StrGet(newBuf, complete, "UTF-8") : ""
}

; Number of leading bytes that form COMPLETE UTF-8 characters (the trailing
; bytes of an incomplete multibyte sequence are excluded so they stay pending).
_UTF8CompletePrefixLen(buf, len) {
    if len = 0
        return 0
    ; Scan back from the end to the last LEADING byte (continuation bytes have
    ; the 10xxxxxx pattern).
    i := len
    while i > 1 && (NumGet(buf, i - 1, "UChar") & 0xC0) = 0x80
        i--
    b := NumGet(buf, i - 1, "UChar")
    if (b & 0x80) = 0
        charLen := 1
    else if (b & 0xE0) = 0xC0
        charLen := 2
    else if (b & 0xF0) = 0xE0
        charLen := 3
    else if (b & 0xF8) = 0xF0
        charLen := 4
    else
        return len  ; corrupt leading byte - let the decoder replace it once
    return i + charLen - 1 <= len ? len : i - 1
}

_readAndProcessStream(state, doPostMessage := false) {
    newContent := _readFileChunk(state)
    if !newContent
        return

    ; Prepend an incomplete JSON fragment retained from the previous poll.
    ; head of this chunk's first line - prepend it so a `data:` line split
    ; across poll boundaries re-forms and its payload survives in full.
    pending := state.HasOwnProp("pendingLine") ? state.pendingLine : ""
    lines := StrSplit(pending . newContent, "`n", "`r")
    ; The chunk's LAST piece may itself be an incomplete line (no trailing
    ; newline yet) - hold it for the next poll unless it is a complete JSON
    ; event that can be processed right away.
    lastIdx := lines.Length
    tail := lines[lastIdx]
    holdTail := tail != "" && !_IsCompleteJsonEvent(tail)
    if holdTail {
        state.pendingLine := tail
        lines.RemoveAt(lastIdx)
    } else {
        state.pendingLine := ""
    }

    for line in lines {
        if (line = "")
            continue

        if InStr(line, "data: ")
            state.rawSseChunks .= line "`n"

        if InStr(line, "data: {") {
            jsonStart := InStr(line, "{")
            state.rawLastResponse := SubStr(line, jsonStart)
        }

        chunk := SSEParser.ParseLine(line)
        _processChunk(state, chunk, doPostMessage)
    }
}

; A trailing chunk piece is only safe to process immediately when it is a
; complete JSON event. Incomplete JSON fragments remain in state.pendingLine
; until the next poll completes them.
_IsCompleteJsonEvent(line) {
    dataPos := InStr(line, "data: ")
    payload := dataPos ? SubStr(line, dataPos + 6) : line
    if payload = "[DONE]"
        return true
    if !InStr("{[", SubStr(payload, 1, 1))
        return true  ; plain text / empty - not a JSON fragment
    try {
        parsed := jsongo.Parse(payload)
    } catch {
        return false
    }
    ; jsongo.Parse returns an empty STRING for truncated JSON (it does not
    ; throw) - only a Map/Array result means the event is complete.
    return IsObject(parsed) && (Type(parsed) = "Map" || Type(parsed) = "Array")
}

; Apply a parsed SSE chunk to the stream state, posting to WebView if needed.
_processChunk(state, chunk, doPostMessage) {
    switch chunk.type {
        case "content":
            if (state.firstTokenTime = 0)
                state.firstTokenTime := A_TickCount
            state.content .= chunk.content
            if doPostMessage
                postWebMessage("streamContent", chunk.content)
            if chunk.HasOwnProp("model") && chunk.model
                state.modelName := ModelParser.Sanitize(chunk.model)
            if chunk.HasOwnProp("usage") && IsObject(chunk.usage) && chunk.usage.HasOwnProp("totalTokens") && chunk.usage.totalTokens > 0
                state.usage := chunk.usage

        case "tool_call":
            ; The model asked to search the web. Merge the partial fragments
            ; into completed calls ({id, name, arguments}) keyed by index.
            if chunk.HasOwnProp("toolCalls") && IsObject(chunk.toolCalls)
                _mergeToolCallDeltas(state, chunk.toolCalls)
            if chunk.HasOwnProp("model") && chunk.model
                state.modelName := ModelParser.Sanitize(chunk.model)
            if chunk.HasOwnProp("usage") && IsObject(chunk.usage) && chunk.usage.HasOwnProp("totalTokens") && chunk.usage.totalTokens > 0
                state.usage := chunk.usage

        case "reasoning":
            ; Reasoning-only streams may never produce a content chunk, so the
            ; first-token timer must also stamp on reasoning.
            ; Otherwise ttft_ms stays 0 (popover hides TTFT, dashboard
            ; averages 0ms, API-log latency falls back to the full duration).
            if (state.firstTokenTime = 0)
                state.firstTokenTime := A_TickCount
            state.reasoning .= chunk.content
            collapseFlag := false
            if state.reasoning = chunk.content {
                if providers.Has(state.providerKey) {
                    p := providers[state.providerKey]
                    if p.HasOwnProp("collapseThinking")
                        collapseFlag := p.collapseThinking
                }
            }
            if doPostMessage
                postWebMessage("streamReasoning", { content: chunk.content, collapsed: collapseFlag })

        case "finish":
            if chunk.HasOwnProp("model") && chunk.model
                state.modelName := ModelParser.Sanitize(chunk.model)
            if chunk.HasOwnProp("usage") && IsObject(chunk.usage) && chunk.usage.HasOwnProp("totalTokens") && chunk.usage.totalTokens > 0
                state.usage := chunk.usage

        case "done":

        case "error":
            ; Mid-stream provider error events carry a real provider failure.
            ; {"message":"..."}}`) - remember the message so finalization can
            ; surface it and keep the partial content instead of crashing on
            ; the missing "choices" key.
            if chunk.HasOwnProp("message") && chunk.message != ""
                state.errorMessage := chunk.message
    }
}

; Merge streaming tool_calls delta fragments (OpenAI-compatible shape) into
; completed {id, name, arguments} entries keyed by the call index.
_mergeToolCallDeltas(state, fragments) {
    if !IsObject(state.toolCalls)
        state.toolCalls := Map()
    for f in fragments {
        if !IsObject(f)
            continue
        idx := f.Has("index") ? f["index"] : 0
        if !state.toolCalls.Has(idx)
            state.toolCalls[idx] := { id: "", name: "", arguments: "" }
        entry := state.toolCalls[idx]
        if f.Has("id") && f["id"] != ""
            entry.id := f["id"]
        if f.Has("function") && IsObject(f["function"]) {
            if f["function"].Has("name") && f["function"]["name"] != ""
                entry.name := f["function"]["name"]
            if f["function"].Has("arguments") && f["function"]["arguments"] != ""
                entry.arguments .= f["function"]["arguments"]
        }
    }
}

_finalizeStreaming() {
    try {
        _readStreamChunkFromParams()
        contentLen := StrLen(requestParams["_streamContent"])
        reasoningLen := StrLen(requestParams["_streamReasoning"])
        debugLog("[STREAM] Done — content=" contentLen "chars reasoning=" reasoningLen "chars polls=" requestParams["_streamPollCount"])

        wasCancelled := requestParams.Has("_streamCancelled") && requestParams["_streamCancelled"]

        ; A user Stop before the first token finalizes as a clean cancellation.
        ; as a clean cancellation - check the flag BEFORE the empty-content
        ; branch, which would otherwise look like a connection failure and show
        ; the misleading API-key banner.
        if wasCancelled {
            _clearToolLoopState()
            _handleStreamCancelled()
            ; Every exit path cleans up _stream* keys to prevent stale request state.
            ; cancelled request can never leak stale stream state into the
            ; next send. The call is idempotent (_handleStreamCancelled also
            ; cleans up internally), but _finalizeStreaming must not rely on
            ; that transitive cleanup.
            _cleanupStreamState()
            _FinishStreamFinalize()
            return
        }

        ; A mid-stream SSE error event is a real provider failure after partial output.
        ; real provider failure AFTER partial tokens - surface the provider
        ; message, persist the partial response (like a cancellation), and
        ; post streamCancelled so the bubble finalizes and the composer is not
        ; wedged in Stop mode. This must run BEFORE the empty-content error
        ; branch so the partial is never misread as a connection failure.
        if requestParams.Has("_streamErrorMessage") && requestParams["_streamErrorMessage"] {
            _clearToolLoopState()
            _handleMidStreamError()
            _cleanupStreamState()
            _FinishStreamFinalize()
            return
        }

        if _NoContentAndNoToolCalls() {
            _clearToolLoopState()
            _handleStreamError()
            _cleanupStreamState()
            _FinishStreamFinalize()
            return
        }

        ; A tool-call round owns its stream teardown and continuation. Do not
        ; run ordinary completion cleanup against the visible thread's
        ; requestParams window after the synchronous search returns.
        if requestParams.Has("_streamToolCalls") && requestParams["_streamToolCalls"].Count {
            _handleStreamComplete()
            return
        }
        _handleStreamComplete()
        ; The web-search tool loop finished (no more tool calls) — drop the
        ; staged tool exchange + loop counter so the next send starts clean.
        _clearToolLoopState()
        _cleanupStreamState()
        _FinishStreamFinalize()
    } catch Error as e {
        debugLog("_finalizeStreaming error: " e.Message "`n" e.Stack)
        _clearToolLoopState()
        ; The finishing stream is still registered here, so exclude it while
        ; checking all other streams, search loops, and non-stream requests.
        currentStream := _FindStreamByKey(_currentStreamKey)
        if !_HasOtherActiveOperations("", currentStream) {
            postWebMessage("setChatButtonsEnabled", true)
            startLoadingCursor(false)
        }
        _PostChatError("Request failed: " e.Message, requestParams.Has("_streamThreadId") ? requestParams["_streamThreadId"] : activeThreadId)
        _cleanupStreamState()
        _FinishStreamFinalize()
    }
}

; True when the stream produced neither content nor reasoning AND has no
; pending web-search tool calls (tool-call rounds must route to the tool loop,
; not the empty-response error branch).
_NoContentAndNoToolCalls() {
    if requestParams["_streamContent"] != "" || requestParams["_streamReasoning"] != ""
        return false
    if requestParams.Has("_streamToolCalls") && requestParams["_streamToolCalls"].Count
        return false
    return true
}

; Web-search tool loop: execute the model's web_search calls, persist the
; search context as a user message, stage the ephemeral tool exchange, then
; fire the follow-up request. The follow-up's stream record re-captures the
; parent (now the search-context message), so the final answer chains
; user -> search context -> answer in the DB.
_handleStreamToolCalls() {
    try {
        global activeThreadId
        stream := _FindStreamByKey(_currentStreamKey)
        if !stream
            throw Error("originating stream record is missing")
        toolCalls := requestParams["_streamToolCalls"]
        loopState := SearchToolExecutor.NewLoopState(stream.threadId, stream.parentId, stream.requestParamsSnapshot.Clone(), stream.toolLoopCount)
        loopState.placeholderQuery := SearchToolExecutor.FirstQuery(toolCalls)
        stream.phase := "search"
        stream.toolLoopState := loopState
        _activeToolLoops.Push(loopState)
        loopCount := loopState.loopCount
        loopCount++

        if SearchToolExecutor.MaxIterationsReached(loopCount) {
            _failToolLoop("Web search stopped: too many search rounds (max " SearchTools.MAX_TOOL_ITERATIONS ").", "", loopState, stream)
            return
        }

        parentId := stream.parentId
        threadId := stream.threadId
        ; Immediate UI feedback: show the query card ("Searching…") while the
        ; backend runs, then update it in place with the real result.
        ctxId := SearchToolExecutor.PrepareFollowUp(toolCalls, threadId, parentId, loopState)
        if ctxId && activeThreadId = threadId
            postWebMessage("appendChatMessage", { id: ctxId, role: "user", content: SearchToolExecutor.PlaceholderContent(toolCalls) })

        providerInfo := ProviderResolver.Resolve(loopState.params["singleAPIModelName"])
        ; Live progress: re-render the search card as the backend streams.
        execResult := SearchToolExecutor.Execute(toolCalls, providerInfo, "", _postSearchProgress.Bind(loopState), loopState)
        if SearchTools.IsCancelled(loopState) {
            ; User pressed Stop while the search ran: cancel the card and do
            ; NOT fire the follow-up request.
            _handleSearchCancelledCard(loopState)
            _FinishToolLoop(loopState, stream)
            if !_HasOtherActiveOperations(loopState, stream)
                postWebMessage("setChatButtonsEnabled", true), startLoadingCursor(false)
            return
        }
        ; Same all-failed guard as the non-streaming path: stop the loop
        ; instead of letting the model retry failed searches.
        if execResult.successCount = 0 {
            _failToolLoop(execResult.failureText != "" ? execResult.failureText : "Web search failed.", execResult.contextText, loopState, stream)
            return
        }
        SearchToolExecutor.QueueFollowUp(execResult, threadId, parentId, loopCount, loopState)
        if ctxId && activeThreadId = threadId
            postWebMessage("updateChatMessage", { id: ctxId, role: "user", content: execResult.contextText })

        _FinishToolLoop(loopState, stream, true)
        ; Re-enter the request pipeline with the staged tool messages; a new
        ; stream record is created for this round.
        _BuildAndFireRequestForScope(loopState)
    } catch Error as e {
        debugLog("_handleStreamToolCalls error: " e.Message "`n" e.Stack)
        _failToolLoop("Web search failed: " e.Message, "", IsSet(loopState) ? loopState : "", IsSet(stream) ? stream : "")
    }
}

; Surface a tool-loop failure, tear down this round's stream, and clear the
; staged loop state so the next normal send starts clean.
_failToolLoop(message, contextText := "", loopState := "", stream := "") {
    debugLog("[SEARCH] " message)
    if IsObject(loopState) && loopState.placeholderId = "" && loopState.placeholderQuery != "" && loopState.threadId && loopState.parentId {
        loopState.placeholderId := ChatDB.Msg_Insert({
            thread_id: loopState.threadId,
            role: "user",
            content: SearchTools.BuildContextText(loopState.placeholderQuery, message),
            parent_id: loopState.parentId,
            sibling_group: "",
            sibling_index: 0
        })
    }
    ; Turn the "Searching…" placeholder into a failure card instead of
    ; leaving a stale "Searching…" message in the thread. When the round had
    ; multiple failed queries, contextText carries every query's failure card.
    if IsObject(loopState) && loopState.placeholderId != "" {
        ctxId := loopState.placeholderId
        q := loopState.placeholderQuery
        content := contextText != "" ? contextText : "[Web search: " q "]\n\n" message
        try ChatDB.Msg_Edit(ctxId, content, loopState.threadId)
        if activeThreadId = loopState.threadId
            postWebMessage("updateChatMessage", { id: ctxId, role: "user", content: content })
        loopState.placeholderId := ""
        loopState.placeholderQuery := ""
    }
    errorThreadId := activeThreadId
    if IsObject(loopState)
        errorThreadId := loopState.threadId
    else if IsObject(stream)
        errorThreadId := stream.threadId
    _PostChatError(message, errorThreadId)
    if IsObject(loopState)
        _FinishToolLoop(loopState, stream)
    else
        _clearToolLoopState()
    if !IsObject(loopState) {
        _deleteCurrentStreamFiles()
        _RemoveStreamFromActive(_currentStreamKey)
        _cleanupStreamState()
        _RestoreLastActiveStream()
    }
    if !_activeStreams.Length && !_activeToolLoops.Length && !_activeNonStreamRequests.Length
        postWebMessage("setChatButtonsEnabled", true), startLoadingCursor(false)
}

_deleteCurrentStreamFiles() {
    for key in ["chatHistoryJSONRequestFile", "cURLCommandFile", "cURLOutputFile", "cURLErrorFile"] {
        if requestParams.Has(key) {
            p := requestParams[key]
            if p && FileExist(p)
                try FileDelete(p)
        }
    }
}

; Clear the staged tool-exchange messages + loop counter once the loop ends
; (final completion, error, or cancel).
_clearToolLoopState(stream := "") {
    if !IsObject(stream)
        stream := _FindStreamByKey(_currentStreamKey)
    if !IsObject(stream)
        return
    params := stream.requestParamsSnapshot
    for key in ["_pendingToolMessages", "_pendingSearchContextIds", "_toolLoopCount"] {
        if params.Has(key)
            params.Delete(key)
    }
}

; Turn the "Searching..." placeholder into a cancelled card (Stop was pressed
; while the search backend was still running).
_handleSearchCancelledCard(loopState := "") {
    if IsObject(loopState) && loopState.placeholderId != "" {
        ctxId := loopState.placeholderId
        q := loopState.placeholderQuery
        content := "[Web search: " q "]\n\n**Search cancelled.**"
        try ChatDB.Msg_Edit(ctxId, content, loopState.threadId)
        if activeThreadId = loopState.threadId
            postWebMessage("updateChatMessage", { id: ctxId, role: "user", content: content })
    }
}

; Called by the search backend as it streams: re-render the placeholder card
; with the latest live progress.
_postSearchProgress(loopState, cardContent) {
    if IsObject(loopState) && loopState.placeholderId != "" && activeThreadId = loopState.threadId
        postWebMessage("updateChatMessage", { id: loopState.placeholderId, role: "user", content: cardContent })
}

; Drop the finalized request from the in-flight list and restore the
; next stream's state into requestParams.
_FinishStreamFinalize() {
    _RemoveStreamFromActive(_currentStreamKey)
    _RestoreLastActiveStream()
}

_cleanupStreamState() {
    ; Map.Delete throws "Item has no value" for a missing key, so guard every
    ; Cleanup must be idempotent even when the
    ; request failed before all stream keys were written.
    if requestParams.Has("_streamOutputFile")
        requestParams.Delete("_streamOutputFile")
    if requestParams.Has("_streamLastPos")
        requestParams.Delete("_streamLastPos")
    if requestParams.Has("_streamContent")
        requestParams.Delete("_streamContent")
    if requestParams.Has("_streamReasoning")
        requestParams.Delete("_streamReasoning")
    if requestParams.Has("_streamModelName")
        requestParams.Delete("_streamModelName")
    if requestParams.Has("_streamDisplayName")
        requestParams.Delete("_streamDisplayName")
    if requestParams.Has("_streamFirstTokenTime")
        requestParams.Delete("_streamFirstTokenTime")
    if requestParams.Has("_streamUsage")
        requestParams.Delete("_streamUsage")
    if requestParams.Has("_streamProviderKey")
        requestParams.Delete("_streamProviderKey")
    if requestParams.Has("_streamRawSseChunks")
        requestParams.Delete("_streamRawSseChunks")
    if requestParams.Has("_streamRawLastResponse")
        requestParams.Delete("_streamRawLastResponse")
    if requestParams.Has("_streamPendingLine")
        requestParams.Delete("_streamPendingLine")
    if requestParams.Has("_streamErrorMessage")
        requestParams.Delete("_streamErrorMessage")
    if requestParams.Has("_streamPollCount")
        requestParams.Delete("_streamPollCount")
    if requestParams.Has("_streamRequestStartTime")
        requestParams.Delete("_streamRequestStartTime")
    if requestParams.Has("_streamChatHistoryJSONRequest")
        requestParams.Delete("_streamChatHistoryJSONRequest")
    if requestParams.Has("_streamPID")
        requestParams.Delete("_streamPID")
    if requestParams.Has("_streamCancelled")
        requestParams.Delete("_streamCancelled")
    if requestParams.Has("_streamThreadId")
        requestParams.Delete("_streamThreadId")
    if requestParams.Has("_streamParentId")
        requestParams.Delete("_streamParentId")
    ; Keep a path available until _FinishStreamFinalize() can restore a
    ; remaining stream. If no stream is active, this is either the shared
    ; window after a failed preflight or a terminal private scope; neither may
    ; retain a completed request's path.
    if !_activeStreams.Length && requestParams.Has("_requestPath")
        requestParams.Delete("_requestPath")
    if requestParams.Has("_streamLogWindowTitle")
        requestParams.Delete("_streamLogWindowTitle")
    if requestParams.Has("_streamLogProviderName")
        requestParams.Delete("_streamLogProviderName")
    if requestParams.Has("_streamLogModel")
        requestParams.Delete("_streamLogModel")
    if requestParams.Has("_streamLogPasteMode")
        requestParams.Delete("_streamLogPasteMode")
    ; A retry that fails before streaming must not leave
    ; pendingRetrySiblingGroup / pendingRetryIsRoot set - they are consumed by
    ; _persistStreamResponse / _handleStreamCancelled on the success/cancel
    ; paths, and a stale group would be picked up by the NEXT response's
    ; Msg_Insert, mis-grouping it with the retried message across parents.
    ; The deletes are INLINED (no helper call) so this file loads standalone
    ; in every include context - AHK v2 treats a call whose callee is only
    ; defined in a later #Include as an unassigned local variable and pops a
    ; #Warn modal that hangs the run.
    if requestParams.Has("pendingRetrySiblingGroup")
        requestParams.Delete("pendingRetrySiblingGroup")
    if requestParams.Has("pendingRetryIsRoot")
        requestParams.Delete("pendingRetryIsRoot")
    if requestParams.Has("pendingRetryThreadId")
        requestParams.Delete("pendingRetryThreadId")
    if requestParams.Has("pendingRetryOriginalLeaf")
        requestParams.Delete("pendingRetryOriginalLeaf")
    if requestParams.Has("pendingRetryRewoundLeaf")
        requestParams.Delete("pendingRetryRewoundLeaf")
}

; A mid-stream SSE error event is a real provider failure after
; partial tokens - keep the partial response (mirroring the cancel path) and
; post streamCancelled so the WebView finalizes the bubble, then surface the
; provider error via the standard error handler (which reads the cURL
; output/stderr files, logs the failure, deletes the request's temp files,
; and re-enables the UI). Order matters: streamCancelled first so the UI
; finalizes the partial before setChatButtonsEnabled(true) resets the
; composer.
_handleMidStreamError() {
    ; A failed retry is a transactional UI/DB operation: do not turn a
    ; provider error's partial text into a new active branch. The normal
    ; non-retry path keeps its existing partial-response behavior.
    if requestParams.Has("pendingRetryOriginalLeaf") {
        streamThreadId := requestParams.Has("_streamThreadId") ? requestParams["_streamThreadId"] : activeThreadId
        _RestoreFailedRetryLeaf()
        postWebMessage("streamCancelled", { dbMsg: "", threadId: streamThreadId })
        _handleStreamError()
        return
    }
    dbMsgData := _persistPartialStreamContent()
    streamThreadId := requestParams.Has("_streamThreadId") ? requestParams["_streamThreadId"] : activeThreadId
    postWebMessage("streamCancelled", { dbMsg: dbMsgData, threadId: streamThreadId })
    _handleStreamError()
}

; API-log/error/cancel entries describe the request that
; was sent, not the thread that happens to be active when it finished. The
; values are captured in sendStreamingRequest and fall back to current
; requestParams only for legacy/unit-test flows.
_streamLogWindowTitle() {
    return requestParams.Has("_streamLogWindowTitle") ? requestParams["_streamLogWindowTitle"] : requestParams["windowTitle"]
}
_streamLogProviderName() {
    return requestParams.Has("_streamLogProviderName") ? requestParams["_streamLogProviderName"] : requestParams["providerName"]
}
_streamLogModel() {
    return requestParams.Has("_streamLogModel") ? requestParams["_streamLogModel"] : requestParams["singleAPIModelName"]
}
_streamLogPasteMode() {
    return requestParams.Has("_streamLogPasteMode") ? requestParams["_streamLogPasteMode"] : requestParams["pasteMode"]
}
