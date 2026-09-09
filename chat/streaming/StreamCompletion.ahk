; ----------------------------------------------------
; StreamCompletion.ahk - Streaming completion handling
;
; Handles successful stream completion: response persistence,
; API logging, title generation trigger, provider lookup.
; ----------------------------------------------------

_handleStreamComplete() {
    try {
        ; The model asked to search: run the tool loop instead of finalizing.
        if requestParams.Has("_streamToolCalls") && requestParams["_streamToolCalls"].Count {
            _handleStreamToolCalls()
            return
        }
        _ClearCurrentStreamPID()
        ; Complete into the thread that sent the request, captured at send time.
        streamThreadId := requestParams.Has("_streamThreadId") ? requestParams["_streamThreadId"] : activeThreadId

        chatHistoryCopy := requestParams["_streamChatHistoryJSONRequest"]
        CodexCliTransport._TraceParams(requestParams, "ahk.response.persist.begin")
        saveStreamResponse(requestParams["_streamContent"], requestParams["_streamModelName"], &chatHistoryCopy, requestParams["_streamRequestStartTime"], requestParams["_streamFirstTokenTime"], requestParams["_streamUsage"], requestParams["_streamReasoning"], requestParams["_streamRawLastResponse"], requestParams["_streamProviderKey"], requestParams["_streamRawSseChunks"], streamThreadId)
        CodexCliTransport._TraceParams(requestParams, "ahk.response.persist.done")

        dbMsgData := ""
        userTokenCount := 0
        if streamThreadId {
            path := ChatDB.Msg_GetActivePath(streamThreadId)
            if path.Length {
                dbMsgData := buildStructuredMessagesFromPath([path[path.Length]])[1]
                ; Find last user message's backfilled token_count
                i := path.Length
                while i >= 1 {
                    if path[i].role = "user" {
                        userTokenCount := path[i].HasProp("token_count") ? path[i].token_count : 0
                        break
                    }
                    i--
                }
            }
        }

        CodexCliTransport._TraceParams(requestParams, "ahk.streamDone.post.begin")
        postWebMessage("streamDone", { model: requestParams["_streamModelName"] ? requestParams["_streamModelName"] : requestParams["singleAPIModelName"], displayName: requestParams.Has("_streamDisplayName") ? requestParams["_streamDisplayName"] : "", provider: requestParams.Has("_streamProviderKey") ? requestParams["_streamProviderKey"] : "", dbMsg: dbMsgData, userTokenCount: userTokenCount, threadId: streamThreadId })
        CodexCliTransport._TraceParams(requestParams, "ahk.streamDone.post.returned")

        postThreadStats(streamThreadId)
        ; Persisted assistant messages change sidebar order/model metadata.
        ; Refresh immediately after persistence.
        _postThreadListRefresh()
        ; The finishing stream is still registered here, so exclude it while
        ; checking all other streams, search loops, and non-stream requests.
        currentStream := _FindStreamByKey(_currentStreamKey)
        if !_HasOtherActiveOperations("", currentStream) {
            postWebMessage("setChatButtonsEnabled", true)
            startLoadingCursor(false)
        }
        ; Always delete request/cURL temp files because they can contain credentials.
        deleteTempFiles()
    } catch Error as normErr {
        debugLog("Stream completion error: " normErr.Message "`nStack: " normErr.Stack)
        _PostChatError("Request failed: " normErr.Message, requestParams.Has("_streamThreadId") ? requestParams["_streamThreadId"] : activeThreadId)
        ; Completion-handler failures must still restore the UI to a usable state.
        currentStream := _FindStreamByKey(_currentStreamKey)
        if !_HasOtherActiveOperations("", currentStream) {
            postWebMessage("setChatButtonsEnabled", true)
            startLoadingCursor(false)
        }
        deleteTempFiles()
    }
}

_maybeGenerateTitle(path, threadId := "") {
    if !threadId
        threadId := activeThreadId
    if autoTitleGenerationEnabled && IsSet(titleGenModel) && titleGenModel && path.Length <= 2 {
        ; Once a title request is dispatched for a thread, do not schedule another concurrently.
        ; Retries of the first exchange therefore cannot schedule a duplicate.
        global _titleGenRequestedThreads
        if _titleGenRequestedThreads.Has(threadId) {
            debugLog("[TITLEGEN] skip duplicate trigger thread=" threadId)
            return
        }
        threadInfo := ChatDB.db.Query("SELECT title FROM chat_threads WHERE id=?;", threadId)
        if threadInfo.count {
            currentTitle := threadInfo[1, "title"]
            debugLog("[TITLEGEN] trigger check thread=" threadId " title='" currentTitle "'")
            if currentTitle = "New Chat" || InStr(currentTitle, "(")
                SetTimer(generateThreadTitle.Bind(threadId), -200)
        }
    }
}

_getProviderEndpoint() {
    providerKey := requestParams.Has("_streamProviderKey") ? requestParams["_streamProviderKey"] : "deepseek"
    if providers.Has(providerKey) && providers[providerKey].HasOwnProp("transport") && providers[providerKey].transport = "codex-cli"
        return "local:codex-cli"
    providerKey := requestParams.Has("_streamProviderKey") ? requestParams["_streamProviderKey"] : "deepseek"
    if providers.Has(providerKey)
        return providers[providerKey].endpoint
    return APIEndpoint
}

saveStreamResponse(content, modelName, &chatHistoryJSONRequest, requestStartTime, firstTokenTime, usage := {}, reasoning := "", rawLastResponse := "", providerKey := "", rawSseChunks := "", streamThreadId := "") {
    if !content && !reasoning
        return

    if !streamThreadId
        streamThreadId := activeThreadId

    requestBeforeAppend := chatHistoryJSONRequest
    llmClient.appendToChatHistory("assistant", content, &chatHistoryJSONRequest, requestParams["chatHistoryJSONRequestFile"])

    if streamThreadId {
        responseTimeMs := A_TickCount - requestStartTime
        ttftMs := firstTokenTime > 0 ? firstTokenTime - requestStartTime : 0
        _persistStreamResponse(content, modelName, reasoning, usage, responseTimeMs, ttftMs, streamThreadId, providerKey)
    }

    _logStreamResponse(content, modelName, reasoning, usage, rawLastResponse, requestBeforeAppend, requestStartTime, firstTokenTime, streamThreadId)
}

_persistStreamResponse(content, modelName, reasoning, usage, responseTimeMs := 0, ttftMs := 0, streamThreadId := "", providerKey := "") {
    if !streamThreadId
        streamThreadId := activeThreadId
    ; A root-assistant retry has no parent and inserts the new response as a sibling.
    ; The sibling is inserted with parent_id NULL.
    isRootRetry := requestParams.Has("pendingRetryIsRoot") && requestParams["pendingRetryIsRoot"]
    if isRootRetry
        requestParams.Delete("pendingRetryIsRoot")
    ; Use the request parent captured at send time, not the current active path.
    ; This prevents a same-thread branch switch from re-parenting the response.
    parentId := requestParams.Has("_streamParentId") ? requestParams["_streamParentId"] : ""
    if !isRootRetry && !parentId {
        ; Legacy/unit-test fallback: use the sending thread's path when no parent was captured.
        sendPath := ChatDB.Msg_GetActivePath(streamThreadId)
        if sendPath.Length
            parentId := sendPath[sendPath.Length].id
    }
    attributionPath := isRootRetry ? []
        : (requestParams.Has("_requestPath") ? requestParams["_requestPath"].Clone()
            : (parentId ? ChatDB.Msg_GetPathToLeaf(streamThreadId, parentId) : ChatDB.Msg_GetActivePath(streamThreadId)))
    path := attributionPath
    retrySiblingGroup := requestParams.Has("pendingRetrySiblingGroup") ? requestParams["pendingRetrySiblingGroup"] : ""
    retrySiblingIdx := retrySiblingGroup ? MessageRepo.GetMaxSiblingIndex(retrySiblingGroup) + 1 : 0
    if retrySiblingGroup
        requestParams.Delete("pendingRetrySiblingGroup")

    ; A same-thread branch switch can leave the visible active leaf on a
    ; different branch while this response is being persisted. Keep that
    ; user-selected leaf unchanged; the assistant still uses parentId above.
    preserveActiveLeaf := false
    if activeThreadId = streamThreadId && !isRootRetry && parentId {
        visiblePath := ChatDB.Msg_GetActivePath(streamThreadId)
        preserveActiveLeaf := visiblePath.Length && visiblePath[visiblePath.Length].id != parentId
    }

    completionTokens := usage.HasProp("completionTokens") ? usage.completionTokens : 0
    thinkingTokens := usage.HasProp("thinkingTokens") ? usage.thinkingTokens : 0
    promptTokens := usage.HasProp("promptTokens") ? usage.promptTokens : 0

    ; The user may permanently delete a chat while its request is in flight.
    ; The conversation row must not become an orphan, but the completed API
    ; call is still historical usage and must remain visible in the dashboard.
    if !ChatDB.db.Query("SELECT id FROM chat_threads WHERE id=?;", streamThreadId).count {
        orphanCosts := CostCalculator.ComputeTokenCosts(modelName, { promptTokens: promptTokens, completionTokens: completionTokens, cachedTokens: usage.HasProp("cachedTokens") ? usage.cachedTokens : 0 })
        ChatDB.ChatUsage_Upsert({
            date: FormatTime(, "yyyy-MM-dd"), model: modelName,
            provider: providerKey != "" ? providerKey : ModelParser.Split(modelName).provider,
            prompt_tokens: promptTokens, completion_tokens: completionTokens,
            thinking_tokens: thinkingTokens, cached_tokens: usage.HasProp("cachedTokens") ? usage.cachedTokens : 0,
            input_cost: orphanCosts.inputCost != "" ? orphanCosts.inputCost : 0,
            cached_input_cost: orphanCosts.cachedInputCost != "" ? orphanCosts.cachedInputCost : 0,
            output_cost: orphanCosts.outputCost != "" ? orphanCosts.outputCost : 0,
            total_cost: orphanCosts.totalCost != "" ? orphanCosts.totalCost : 0,
            response_time_ms: responseTimeMs, ttft_ms: ttftMs, ttft_measured: ttftMs > 0
        })
        return
    }

    ChatDB.Msg_Insert({
        thread_id: streamThreadId, role: "assistant", content: content, model: modelName, provider: providerKey,
        parent_id: parentId, sibling_group: retrySiblingGroup, sibling_index: retrySiblingIdx,
        reasoning: reasoning,
        prompt_tokens: promptTokens,
        token_count: Max(0, completionTokens - thinkingTokens),
        thinking_tokens: thinkingTokens,
        cached_tokens: usage.HasProp("cachedTokens") ? usage.cachedTokens : 0,
        response_time_ms: responseTimeMs,
        ttft_ms: ttftMs,
        ttft_measured: ttftMs > 0,
        token_attribution_path: attributionPath,
        update_active_leaf: !preserveActiveLeaf
    })
    _maybeGenerateTitle(path, streamThreadId)
}

_logStreamResponse(content, modelName, reasoning, usage, rawLastResponse, requestBeforeAppend, requestStartTime, firstTokenTime, streamThreadId := "") {
    global activeThreadId
    if !streamThreadId
        streamThreadId := activeThreadId
    responseTimeMs := firstTokenTime > 0 ? firstTokenTime - requestStartTime : A_TickCount - requestStartTime

    pt := usage.HasProp("promptTokens") ? usage.promptTokens : 0
    ct := usage.HasProp("completionTokens") ? usage.completionTokens : 0
    tht := usage.HasProp("thinkingTokens") ? usage.thinkingTokens : 0
    ckt := usage.HasProp("cachedTokens") ? usage.cachedTokens : 0
    debugLog("[API] Chat done - prompt=" pt " completion=" ct " cached=" ckt " latency=" responseTimeMs "ms model=" modelName)
    debugLog("[USAGE] Chat - prompt=" pt " completion=" ct " cached=" ckt)
    costs := CostCalculator.ComputeTokenCosts(modelName, usage)
    if costs.totalCost != ""
        debugLog("[COST] Chat - input=$" costs.inputCost " cached=$" costs.cachedInputCost " output=$" costs.outputCost " total=$" costs.totalCost)

    ; Build response: real API data from last chunk, but with accumulated content
    responseStr := rawLastResponse
    if content && rawLastResponse {
        try {
            parsed := jsongo.Parse(rawLastResponse)
            if parsed.Has("choices") && parsed["choices"].Length > 0 {
                parsed["choices"][1]["delta"]["content"] := content
                if reasoning
                    parsed["choices"][1]["delta"]["reasoning_content"] := reasoning
                responseStr := jsongo.Stringify(parsed)
            }
        }
    }

    ; Locked chats: never persist full request/response bodies for a thread
    ; that is locked and not unlocked in this session - the API log file
    ; (%TEMP%\LLM_API_Log.json) is a plaintext sink outside the chat DB.
    logEntry := {
        timestamp: FormatTime(, "yyyy-MM-dd HH:mm:ss"),
        commandName: _streamLogWindowTitle(), provider: _streamLogProviderName(),
        model: _streamLogModel(), isFIM: false, endpoint: _getProviderEndpoint(),
        pasteMode: _streamLogPasteMode(),
        request: requestBeforeAppend,
        response: responseStr,
        status: "success", responseTimeMs: responseTimeMs
    }
    if ThreadLockService.ShouldRedactContent(streamThreadId) {
        logEntry.request := "<hidden: locked chat>"
        logEntry.response := "<hidden: locked chat>"
    }
    ApiLogger.LogRequest(logEntry)
}

