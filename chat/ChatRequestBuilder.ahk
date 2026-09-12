; ======================================================
; ChatRequestBuilder.ahk — LLM request pipeline
;
; buildRequest has 3 responsibilities:
;   1. VALIDATE — check API key is configured for the provider
;   2. BUILD — construct the JSON request from DB messages + overrides
;   3. WRITE — persist request + cURL command to temp files
;
; Also: sendRequestToLLM (thin wrapper).
; ======================================================

#Include ..\shared\ModelParser.ahk
#Include ..\shared\ModelResolver.ahk
#Include ..\shared\AttachmentUtils.ahk
#Include ..\shared\ImageUtils.ahk

; Preflight failures happen before a request gets its own ownership record.
; Keep this check local to the builder because the standalone #Warn/load probe
; includes this file without the streaming module that defines the full helper.
_HasActiveOperationForUi(threadId := "") {
    global _activeStreams, _activeToolLoops, _activeNonStreamRequests, activeThreadId
    if !threadId && IsSet(activeThreadId)
        threadId := activeThreadId
    if !threadId
        return false
    if IsSet(_activeStreams)
        for stream in _activeStreams
            if stream.threadId = threadId
                return true
    if IsSet(_activeToolLoops)
        for loopState in _activeToolLoops
            if loopState.threadId = threadId
                return true
    if IsSet(_activeNonStreamRequests)
        for scope in _activeNonStreamRequests
            if scope.threadId = threadId
                return true
    return false
}

buildRequest(requestPath := "") {
    if !activeThreadId {
        return ""
    }
    ; Only an explicitly supplied path may override the active thread's DB path.
    ; requestParams is a shared stream-processing window and may currently hold
    ; another thread's _requestPath while that background stream is polled.
    path := IsObject(requestPath) ? requestPath : ChatDB.Msg_GetActivePath(activeThreadId)
    if !path.Length {
        return ""
    }
    modelName := requestParams["singleAPIModelName"]
    debugLog("[API] Chat send — model=" modelName " thread=" activeThreadId " pathLen=" path.Length)

    ; Resolve provider once — used for validation, cURL building, and provider-specific request fields
    providerInfo := ProviderResolver.Resolve(requestParams["singleAPIModelName"])

    ; Validate: check API key is available for the selected provider
    if providerInfo.transport = "http" && !providerInfo.apiKey {
        return _ShowApiKeyError(providerInfo)
    }

    ; A provider with no endpoint would produce a URL-less cURL
    ; command - surface a friendly error instead of raw cURL stderr.
    if providerInfo.transport = "http" && !providerInfo.endpoint {
        return _ShowEndpointError(providerInfo)
    }

    ; Build messages array from DB path
    apiMessages := _BuildApiMessagesFromPath(path)

    ; Attach every user message's own attachments to its API content part
    ; so multi-turn requests preserve earlier
    ; image/file context.
    if !_ProcessAttachmentsForPath(&apiMessages, requestParams["singleAPIModelName"])
        return ""

    ; Clean up internal _msgId fields
    _CleanApiMessages(apiMessages)

    ; Build request object and apply overrides
    requestObj := _BuildRequestObj(apiMessages, providerInfo)

    return _WriteRequestFiles(requestObj, providerInfo)
}

; Show API key error and return "" so caller aborts.
_ShowApiKeyError(providerInfo) {
    ; ProviderResolver can return providerKey="" when no providers
    ; are configured - a bare providers[""] Map index THROWS in AHK v2 and
    ; crashes the error handler before the friendly message is posted.
    pInfo := ""
    if providers.Has(providerInfo.providerKey)
        pInfo := providers[providerInfo.providerKey]
    envVar := pInfo && pInfo.HasOwnProp("authEnvVar") ? pInfo.authEnvVar : providerInfo.providerKey
    errorMsg := "No API key configured for " providerInfo.providerKey ". Set " envVar " environment variable."
    _PostChatError(errorMsg)
    if !_HasActiveOperationForUi()
        postWebMessage("setChatButtonsEnabled", true), startLoadingCursor(false)
    debugLog("ERROR: " errorMsg)
    return ""
}

; Show "endpoint missing" and return "" so the caller aborts.
_ShowEndpointError(providerInfo) {
    errorMsg := "No endpoint configured for provider '" providerInfo.providerKey "'. Set it in Settings → Providers."
    _PostChatError(errorMsg)
    if !_HasActiveOperationForUi()
        postWebMessage("setChatButtonsEnabled", true), startLoadingCursor(false)
    debugLog("ERROR: " errorMsg)
    return ""
}

; Build a plain {role, content, _msgId} array from the DB path.
_BuildApiMessagesFromPath(path) {
    apiMessages := []
    ; Canonical function-calling order: while a tool round is in flight, the
    ; durable search-context user messages inserted for THIS round are
    ; excluded from the follow-up request body - the staged assistant
    ; tool_calls + role:"tool" pair carries the results. Once the tool loop
    ; clears the staged state, the context re-enters the history for every
    ; later request.
    skip := Map()
    if requestParams.Has("_pendingSearchContextIds") {
        for id in requestParams["_pendingSearchContextIds"]
            skip[id] := true
    }
    for msg in path {
        if msg.HasOwnProp("id") && skip.Has(msg.id)
            continue
        apiMessages.Push({ role: msg.role, content: msg.content, _msgId: msg.id })
    }
    ; Tool-loop round: append the ephemeral assistant tool_calls + role:"tool"
    ; results the API requires before the model can answer (they are NOT
    ; persisted — only the search-context user message is).
    if requestParams.Has("_pendingToolMessages") {
        for toolMsg in requestParams["_pendingToolMessages"]
            apiMessages.Push(toolMsg)
    }
    return apiMessages
}

; Remove internal _msgId fields before serializing to JSON.
_CleanApiMessages(apiMessages) {
    for msg in apiMessages
        if msg.HasProp("_msgId")
            msg.DeleteProp("_msgId")
}

; Attach durable image/file context to API messages.
; User attachments stay on their own turn. Images produced by an assistant are
; carried into the next user turn so follow-up questions can still see them.
; Codex receives app-owned image files through repeated --image flags instead
; of unsupported image_url content parts.
_ProcessAttachmentsForPath(&apiMessages, modelName) {
    requestParams["_codexInputImages"] := []
    providerInfo := ProviderResolver.Resolve(modelName)
    isCodex := IsObject(providerInfo) && providerInfo.transport = "codex-cli"

    ; Vision gate across the whole conversation, including generated assistant
    ; images that will be carried into a later user turn.
    for msg in apiMessages {
        if (msg.role != "user" && msg.role != "assistant") || !msg.HasProp("_msgId") || !msg._msgId
            continue
        attachments := ChatDB.Attachment_GetByMessage(msg._msgId)
        if attachments.Length && _HasImageAttachments(attachments) && !AttachmentUtils.HasVision(modelName) {
            errorMsg := "Model '" modelName "' does not support vision. Remove images or switch models."
            _PostChatError(errorMsg)
            if !_HasActiveOperationForUi()
                postWebMessage("setChatButtonsEnabled", true), startLoadingCursor(false)
            return false
        }
    }

    pendingAssistantImages := []
    codexSeenImages := Map()

    for i, msg in apiMessages {
        if !msg.HasProp("_msgId") || !msg._msgId
            continue
        attachments := ChatDB.Attachment_GetByMessage(msg._msgId)

        if msg.role = "assistant" {
            for att in attachments {
                if att.attachment_type = "image"
                    pendingAssistantImages.Push(att)
            }
            continue
        }
        if msg.role != "user"
            continue

        ownImages := _ImageAttachmentsOnly(attachments)
        assistantImages := pendingAssistantImages
        pendingAssistantImages := []
        userMsg := apiMessages[i].content
        fileContexts := _BuildFileContexts(attachments)

        if isCodex {
            assistantRefs := _QueueCodexInputImages(assistantImages, &codexSeenImages)
            ownRefs := _QueueCodexInputImages(ownImages, &codexSeenImages)
            textParts := []
            if fileContexts
                textParts.Push(RTrim(fileContexts, "`n`n"))
            if assistantRefs.Length
                textParts.Push("[Visual context: " _CodexImageReferenceText(assistantRefs) " generated by the previous assistant is attached to this turn.]")
            if ownRefs.Length
                textParts.Push("[Visual context: " _CodexImageReferenceText(ownRefs) " attached by the user belongs to this turn.]")
            if userMsg
                textParts.Push(userMsg)

            if textParts.Length {
                combinedText := ""
                for part in textParts
                    combinedText .= (combinedText = "" ? "" : "`n`n") part
                apiMessages[i] := { role: "user", content: combinedText, _msgId: msg._msgId }
            }
            continue
        }

        visualImages := []
        for att in assistantImages
            visualImages.Push(att)
        for att in ownImages
            visualImages.Push(att)

        contentArray := _BuildImageContentParts(visualImages)
        if fileContexts
            contentArray.InsertAt(1, { type: "text", text: RTrim(fileContexts, "`n`n") })
        if assistantImages.Length
            contentArray.Push({ type: "text", text: "[Visual context: image generated by the previous assistant is attached to this turn.]" })
        if userMsg && contentArray.Length
            contentArray.Push({ type: "text", text: userMsg })

        if contentArray.Length > 0
            apiMessages[i] := { role: "user", content: contentArray, _msgId: msg._msgId }
    }

    return true
}

_ImageAttachmentsOnly(attachments) {
    images := []
    for att in attachments {
        if att.attachment_type = "image"
            images.Push(att)
    }
    return images
}

_QueueCodexInputImages(attachments, &seen) {
    refs := []
    for att in attachments {
        fullPath := _ResolveCodexInputImagePath(att)
        if !fullPath
            continue
        key := StrLower(fullPath)
        if seen.Has(key) {
            refs.Push(seen[key])
            continue
        }
        requestParams["_codexInputImages"].Push(fullPath)
        index := requestParams["_codexInputImages"].Length
        seen[key] := index
        refs.Push(index)
    }
    return refs
}

_CodexImageReferenceText(refs) {
    labels := ""
    for ref in refs
        labels .= (labels = "" ? "" : ", ") "#" ref
    return (refs.Length = 1 ? "image " : "images ") labels
}

_ResolveCodexInputImagePath(att) {
    if !IsObject(att) || att.attachment_type != "image" || !att.file_path
        return ""
    relativePath := StrReplace(String(att.file_path), "/", "\")
    prefix := "attachments\"
    if StrLower(SubStr(relativePath, 1, StrLen(prefix))) != prefix
        return ""
    if InStr(relativePath, "..") || InStr(relativePath, ":")
        return ""
    tail := SubStr(relativePath, StrLen(prefix) + 1)
    if !tail || SubStr(tail, 1, 1) = "\"
        return ""
    fullPath := AppInfo.DataDir "\" relativePath
    return FileExist(fullPath) ? fullPath : ""
}

; Check if any attachment is an image.
_HasImageAttachments(attachments) {
    for att in attachments {
        if att.attachment_type = "image"
            return true
    }
    return false
}

; Build image_url content parts from attachments.
_BuildImageContentParts(attachments) {
    contentArray := []
    for att in attachments {
        if att.attachment_type = "image" {
            base64Data := ImageUtils.ReadAndEncode(att.file_path)
            if base64Data {
                contentArray.Push({
                    type: "image_url",
                    image_url: { url: "data:" att.mime_type ";base64," base64Data }
                })
            }
        }
    }
    return contentArray
}

; Build file context text from non-image attachments.
_BuildFileContexts(attachments) {
    fileContexts := ""
    for att in attachments {
        if att.attachment_type != "image" {
            typeLabel := att.attachment_type = "pdf" ? "PDF"
                      : att.attachment_type = "docx" ? "DOCX"
                      : "File"
            if att.extracted_text {
                fileContexts .= "[Attached " typeLabel ": " att.original_filename "]`n`n" att.extracted_text "`n`n"
            }
        }
    }
    return fileContexts
}

; Build the request object and apply all overrides (system, reasoning, temperature, stream, provider defaults).
_BuildRequestObj(apiMessages, providerInfo) {
    ; Apply system message override
    _ApplySystemOverride(apiMessages)

    ; ProviderResolver returns the API model name. Most providers use the
    ; provider-stripped id, while OpenRouter's router id must remain
    ; "openrouter/free" for the API call.
    apiModelName := providerInfo.modelName
    requestObj := { model: apiModelName, messages: apiMessages }

    ; Look up model metadata for thinking/compat
    global models
    ; Resolve both full and short model ids through the shared resolver.
    modelMeta := ModelResolver.Lookup(models, requestParams["singleAPIModelName"])

    ; Apply reasoning override via metadata-driven handler.
    ; Only send thinking config for a thinking level this model actually offers.
    ; "Model Default" (empty) — or any value the sidebar dropdown can't display
    ; (e.g. an assistant's "none" default on a model whose level list has no
    ; "none") — sends NO thinking config at all.
    reasoning := requestParams.Has("reasoningOverride") ? requestParams["reasoningOverride"] : ""
    hasLevelMap := IsObject(modelMeta) && modelMeta.HasOwnProp("thinkingLevelMap") && IsObject(modelMeta.thinkingLevelMap)
    if (reasoning != "" && hasLevelMap && modelMeta.thinkingLevelMap.Has(reasoning))
        OpenAIChatCompletions.ApplyThinking(&requestObj, modelMeta, reasoning, requestParams["singleAPIModelName"])

    ; Apply temperature override (use != "" not truthiness — "0" is falsy in AHK)
    if providerInfo.transport != "codex-cli" && requestParams.Has("temperatureOverride") && requestParams["temperatureOverride"] != "" {
        try {
            requestObj.temperature := Float(requestParams["temperatureOverride"])
        } catch {
            debugLog("WARNING: invalid temperature value: " requestParams["temperatureOverride"])
        }
    }

    if requestParams["stream"] {
        requestObj.stream := true
        requestObj.stream_options := { include_usage: true }
    }

    ; Web Search tool: the per-thread right-rail toggle is OFF by default, so
    ; the model only ever sees the tool when the user explicitly enables it.
    ; The search backend is resolved at execution time (DeepSeek native vs
    ; Tavily) — the request format is the same OpenAI-compatible function tool
    ; for every provider.
    if SearchTools.Enabled() && providerInfo.transport != "codex-cli" {
        requestObj.tools := [SearchTools.Definition()]
    }

    return requestObj
}

; Apply system message override from requestParams or prepend one if missing.
_ApplySystemOverride(apiMessages) {
    if !requestParams.Has("systemOverride") || !requestParams["systemOverride"]
        return

    found := false
    for i, m in apiMessages {
        if m.role = "system" {
            apiMessages[i].content := requestParams["systemOverride"]
            found := true
            break
        }
    }
    if !found {
        apiMessages.InsertAt(1, { role: "system", content: requestParams["systemOverride"] })
    }
}

; Serialize request to JSON, write to temp files, store paths in requestParams.
_WriteRequestFiles(requestObj, providerInfo) {
    payload := LLMRequestBuilder._FixStreamBoolean(jsongo.Stringify(requestObj))

    ; A_TickCount alone collides when requests start in the same millisecond.
    ; Use the existing UUID generator so every request owns its files.
    uniqueID := ChatDB._UUID()
    requestFile := A_Temp "\ChatWindow_Req_" uniqueID ".json"
    cURLFile := A_Temp "\ChatWindow_cURL_" uniqueID ".txt"
    outputFile := A_Temp "\ChatWindow_Out_" uniqueID ".json"
    errorFile := A_Temp "\ChatWindow_Err_" uniqueID ".txt"

    FileOpen(requestFile, "w", "UTF-8-RAW").Write(payload)
    if providerInfo.transport = "codex-cli" {
        ; Codex is a local process transport. Preserve the normal request file
        ; as the transport-neutral handoff, but do not manufacture a URL/cURL.
        cURLCommand := "codex-cli"
    } else {
    if requestParams["stream"] {
        cURLCommand := CurlBuilder.BuildStream(providerInfo, requestFile, outputFile, errorFile)
    } else {
        cURLCommand := CurlBuilder.Build(providerInfo, requestFile, outputFile)
    }
    }
    FileOpen(cURLFile, "w", "UTF-8-RAW").Write(cURLCommand)

    requestParams["chatHistoryJSONRequestFile"] := requestFile
    requestParams["cURLCommandFile"] := cURLFile
    requestParams["cURLOutputFile"] := outputFile
    requestParams["cURLErrorFile"] := errorFile

    return payload
}

sendRequestToLLM(&chatHistoryJSONRequest, initialRequest := false) {
    providerInfo := ProviderResolver.Resolve(requestParams["singleAPIModelName"])
    if providerInfo.transport = "codex-cli" {
        ; One AhkLLM Send -> one codex exec. Native web search, if enabled,
        ; stays inside that same local Codex turn.
        sendNonStreamingRequest(&chatHistoryJSONRequest)
        return
    }
    ; A chat-mode command with "Stream Response" off uses the
    ; single-shot JSON path (CurlBuilder.Build + ResponseParser), not the SSE
    ; stream handler - otherwise a JSON-only API response is dropped as an SSE
    ; parse failure.
    if requestParams["stream"]
        sendStreamingRequest(&chatHistoryJSONRequest, initialRequest)
    else
        sendNonStreamingRequest(&chatHistoryJSONRequest)
}

_ClearRetryRollbackState() {
    global requestParams
    for key in ["pendingRetryThreadId", "pendingRetryOriginalLeaf", "pendingRetryRewoundLeaf"] {
        if requestParams.Has(key)
            requestParams.Delete(key)
    }
}

; A retry temporarily moves the durable active leaf to the target's parent so
; the request history excludes the retried answer. If request construction or the
; provider fails before a replacement is committed, put that leaf back. Only
; restore when the DB still points at this retry's rewound branch (or its
; partial-error child), so a user branch switch made meanwhile wins.
_RestoreFailedRetryLeaf() {
    global requestParams
    if !requestParams.Has("pendingRetryThreadId") || !requestParams.Has("pendingRetryOriginalLeaf") {
        _ClearRetryRollbackState()
        return
    }
    threadId := requestParams["pendingRetryThreadId"]
    originalLeaf := requestParams["pendingRetryOriginalLeaf"]
    rewoundLeaf := requestParams.Has("pendingRetryRewoundLeaf") ? requestParams["pendingRetryRewoundLeaf"] : ""
    current := ChatDB.db.Query("SELECT active_leaf_id FROM chat_threads WHERE id=?;", threadId)
    if current.count {
        activeLeaf := current[1, "active_leaf_id"] ? current[1, "active_leaf_id"] : ""
        shouldRestore := activeLeaf = rewoundLeaf
        if !shouldRestore && activeLeaf {
            child := ChatDB.db.Query("SELECT id FROM messages WHERE id=? AND thread_id=? AND parent_id=? AND sibling_group IS NOT NULL;", activeLeaf, threadId, rewoundLeaf)
            shouldRestore := child.count
        }
        if shouldRestore
            ChatDB.Msg_SetActiveLeaf(threadId, originalLeaf)
    }
    _ClearRetryRollbackState()
}

; Retry metadata lives in the shared requestParams window while legacy
; stream handlers run. A background retry may therefore be the last request
; loaded into that window when the user sends normally from another thread.
; Only metadata explicitly owned by the active thread may participate in a
; new dispatch; everything else is stale foreign state.
_SanitizeRetryStateForDispatch() {
    global requestParams, activeThreadId
    retryKeys := [
        "pendingRetryThreadId",
        "pendingRetryOriginalLeaf",
        "pendingRetryRewoundLeaf",
        "pendingRetrySiblingGroup",
        "pendingRetryIsRoot"
    ]
    hasRetryState := false
    for key in retryKeys {
        if requestParams.Has(key) {
            hasRetryState := true
            break
        }
    }
    if !hasRetryState
        return

    ownerThreadId := requestParams.Has("pendingRetryThreadId") ? requestParams["pendingRetryThreadId"] : ""
    if ownerThreadId != "" && ownerThreadId = activeThreadId
        return

    for key in retryKeys {
        if requestParams.Has(key)
            requestParams.Delete(key)
    }
}

; Build request, fire to LLM, handle errors. Replaces 5 duplicate call sites.
_BuildAndFireRequest(requestPath := "") {
    _SanitizeRetryStateForDispatch()
    try {
    ; Streaming requests are built through the shared requestParams window.
    ; Another active stream's poll timer also swaps that window to its own
    ; temp paths/state. Keep build -> stream registration non-interruptible so
    ; the existing stream cannot clobber the new command before it owns a
    ; per-request stream record. Non-streaming/Codex dispatch stays interruptible.
    criticalDispatch := requestParams.Has("stream") && requestParams["stream"]
    if criticalDispatch
        Critical "On"
    ; Capture request ownership once, before any stream record is created.
    ; Ordinary sends always use the active thread's current DB path; scoped
    ; tool-loop continuations pass their owned path explicitly.
    ownedRequestPath := IsObject(requestPath) ? requestPath.Clone() : ChatDB.Msg_GetActivePath(activeThreadId).Clone()
    if requestParams.Has("_latencyTraceId")
        debugLog("[LATENCY][" requestParams["_latencyTraceId"] "] +" (A_TickCount - requestParams["_latencyTraceStartTick"]) "ms ahk.buildRequest.begin", "Latency")
    chatHistoryJSONRequest := buildRequest(ownedRequestPath)
    if requestParams.Has("_latencyTraceId")
        debugLog("[LATENCY][" requestParams["_latencyTraceId"] "] +" (A_TickCount - requestParams["_latencyTraceStartTick"]) "ms ahk.buildRequest.returned", "Latency")
    if !chatHistoryJSONRequest {
        if criticalDispatch
            Critical "Off"
        if !_HasActiveOperationForUi()
            postWebMessage("setChatButtonsEnabled", true), startLoadingCursor(false)
        ; A retry rejected before any stream (vision gate, API-key
        ; error, endpoint error) leaves pendingRetrySiblingGroup / 
        ; pendingRetryIsRoot set - clear them so the next normal response is
        ; not mis-grouped with the retried message. The deletes are INLINED
        ; (no helper call) because ChatRequestBuilder.ahk is #Included by the
        ; headless DB-audit probe WITHOUT the chat-process modules - AHK v2
        ; treats a call whose callee is only defined in a later #Include as an
        ; unassigned local variable and pops a #Warn modal that hangs the run.
        _RestoreFailedRetryLeaf()
        if requestParams.Has("pendingRetrySiblingGroup")
            requestParams.Delete("pendingRetrySiblingGroup")
        if requestParams.Has("pendingRetryIsRoot")
            requestParams.Delete("pendingRetryIsRoot")
        return false
    }
    postWebMessage("setChatButtonsEnabled", false)
    startLoadingCursor(true)
    if requestParams.Has("_latencyTraceId")
        debugLog("[LATENCY][" requestParams["_latencyTraceId"] "] +" (A_TickCount - requestParams["_latencyTraceStartTick"]) "ms ahk.sendRequestToLLM.begin", "Latency")
    ; The stream record is built synchronously inside sendRequestToLLM and
    ; reads _requestPath from the shared window. Replace any background stream
    ; path with this request's captured owner immediately before dispatch.
    requestParams["_requestPath"] := ownedRequestPath.Clone()
    sendRequestToLLM(&chatHistoryJSONRequest)
    if requestParams.Has("_latencyTraceId")
        debugLog("[LATENCY][" requestParams["_latencyTraceId"] "] +" (A_TickCount - requestParams["_latencyTraceStartTick"]) "ms ahk.sendRequestToLLM.returned", "Latency")
    if criticalDispatch
        Critical "Off"
    return true
    } catch Error as e {
        if criticalDispatch
            Critical "Off"
        debugLog("_BuildAndFireRequest error: " e.Message "`n" e.Stack, "ErrorHandler")
        _RestoreFailedRetryLeaf()
        _PostChatError("Request failed: " e.Message)
        postWebMessage("setChatButtonsEnabled", true)
        startLoadingCursor(false)
        return false
    }
}

