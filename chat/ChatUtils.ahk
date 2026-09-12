;--------------------------------------------------
; Chat lock enforcement (Tier-1 password gate)
;--------------------------------------------------

#Include locks\ThreadLockService.ahk

;--------------------------------------------------
; cURL process management
;--------------------------------------------------

cURLState(action, data := 0) {
    static cURLPID := 0

    switch action {
        case "get": return cURLPID
        case "set": cURLPID := data
        case "close": ProcessClose(cURLPID), cURLPID := 0
    }
    return 0
}

; True when the right-rail state is still pristine. This helper is loaded before
; settings/callback modules because AHK #Warn can treat a later function reference
; as an unassigned local and open a blocking modal.
_RequestParamsAreDefault() {
    global requestParams, appDefaultModel
    if requestParams.Has("activeAssistantId") && requestParams["activeAssistantId"]
        return false
    if requestParams.Has("systemOverride") && requestParams["systemOverride"]
        return false
    if requestParams.Has("reasoningOverride") && requestParams["reasoningOverride"]
        return false
    if requestParams.Has("temperatureOverride") && requestParams["temperatureOverride"] != ""
        return false
    if requestParams.Has("singleAPIModelName") && requestParams["singleAPIModelName"] != appDefaultModel
        return false
    return true
}

; ----------------------------------------------------
; Post a message to the WebView
; ----------------------------------------------------

postWebMessage(target, data := unset, reqId := "") {
    global responseWindow
    global activeThreadId
    if !IsSet(responseWindow) || !responseWindow {
        return
    }

    ; Composer state is thread-scoped. Most legacy callers still pass a
    ; boolean; wrap it here with the request owner so background generations
    ; cannot toggle the visible chat's Send/Stop button.
    if target = "setChatButtonsEnabled" && IsSet(data) && !IsObject(data) {
        ownerThreadId := IsSet(activeThreadId) ? activeThreadId : ""
        data := { enabled: data ? true : false, threadId: ownerThreadId }
    }

    msgObj := { target: target }

    ; If data is provided, add it to the message object
    msgObj.data := IsSet(data) ? data : unset
    ; Echo request correlation ids so the WebView can match replies.
    if reqId != ""
        msgObj.reqId := reqId

    jsonStr := jsongo.Stringify(msgObj)
    try responseWindow.PostWebMessageAsJSON(jsonStr)
}

; Post a chat error with the request's owning thread when available. Errors can
; arrive after the user switches chats, so callers handling asynchronous work
; must pass their captured thread id instead of relying on activeThreadId.
_PostChatError(message, threadId := "") {
    global activeThreadId
    if !threadId && IsSet(activeThreadId)
        threadId := activeThreadId
    data := { message: message }
    if threadId
        data.threadId := threadId
    postWebMessage("showError", data)
}

; ----------------------------------------------------
; Delete temp files
; ----------------------------------------------------

deleteTempFiles() {
    safeDelete(requestParams.Has("chatHistoryJSONRequestFile") ? requestParams["chatHistoryJSONRequestFile"] : "")
    safeDelete(requestParams.Has("cURLCommandFile") ? requestParams["cURLCommandFile"] : "")
    safeDelete(requestParams.Has("cURLOutputFile") ? requestParams["cURLOutputFile"] : "")
    safeDelete(requestParams.Has("cURLErrorFile") ? requestParams["cURLErrorFile"] : "")
}

; Remove artifacts left by a force-killed or crashed ChatWindow. The prefixes
; are exclusive to this app and the scan is bounded to files directly in the
; system temp directory, so one request cannot delete another app's files.
CleanupOwnedTempFiles() {
    deleteTempFiles()
    patterns := [
        "ChatWindow_Req_*.json", "ChatWindow_cURL_*.txt",
        "ChatWindow_Out_*.json", "ChatWindow_Err_*.txt",
        "ChatWindow_TitleGen_*.json", "ChatWindow_TitleGen_Out_*.json",
        "DSearch_Req_*.json", "DSearch_Out_*.json", "DSearch_Err_*.txt",
        "Tavily_Req_*.json", "Tavily_Out_*.json", "Tavily_Err_*.txt"
    ]
    for pattern in patterns {
        patternPath := A_Temp "\" pattern
        Loop Files, patternPath, "F"
            safeDelete(A_LoopFileFullPath)
    }
}

; ----------------------------------------------------
; Start or stop loading cursor
; ----------------------------------------------------

startLoadingCursor(status) {
    global requestParams
    if !IsSet(requestParams)
        return
    status ? CustomMessages.notifyLoadingState(CustomMessages.WM_LOADING_START,
        requestParams["uniqueID"], , requestParams["mainScriptHiddenHwnd"])
            : CustomMessages.notifyLoadingState(CustomMessages.WM_LOADING_FINISH,
                requestParams["uniqueID"], , requestParams["mainScriptHiddenHwnd"])
}

; ----------------------------------------------------
; Post token usage and cost stats for the current thread
; Computes estimates from DB, sends to WebView
; ----------------------------------------------------

postThreadStats(threadId := "") {
    if !threadId
        return
    stats := ChatDB.Msg_GetThreadStats(threadId)
    ; Scope token-bar stats to their owning thread so asynchronous completions
    ; cannot repaint another thread's header.
    stats.threadId := threadId
    postWebMessage("updateTokenUsage", stats)
}

; debugLog() is now in lib/DebugLog.ahk - included via Config.ahk

; ----------------------------------------------------
; Build structured messages array from DB path for WebView
; Used by ChatIPC, ChatCallbacks, StreamHandler - defined here
; as a shared utility rather than in a callbacks file.
; ----------------------------------------------------

buildStructuredMessagesFromPath(path, threadId := "") {
    ; Batch-load all attachments for this thread (if threadId provided)
    allAttachments := Map()
    if threadId {
        attList := ChatDB.Attachment_GetByThread(threadId)
        for att in attList {
            msgId := att.message_id
            if !allAttachments.Has(msgId)
                allAttachments[msgId] := []
            attObj := {
                id: att.id,
                attachment_type: att.attachment_type,
                file_path: att.file_path,
                mime_type: att.mime_type,
                original_filename: att.original_filename,
                file_size: att.file_size,
                extracted_text: att.extracted_text
            }
            ; Include base64 for image thumbnails in message bubbles
            if att.attachment_type = "image" {
                attObj.base64 := ImageUtils.ReadAndEncode(att.file_path)
            }
            allAttachments[msgId].Push(attObj)
        }
    }

    structuredMessages := []
    for msg in path {
        msgObj := { role: msg.role, content: msg.content, id: msg.id,
            parentId: msg.HasProp("parent_id") ? msg.parent_id : "",
            tokenCount: msg.HasProp("token_count") ? msg.token_count : 0,
            thinkingTokens: msg.HasProp("thinking_tokens") ? msg.thinking_tokens : 0,
            cachedTokens: msg.HasProp("cached_tokens") ? msg.cached_tokens : 0,
            responseTimeMs: msg.HasProp("response_time_ms") ? msg.response_time_ms : 0,
            ttftMs: msg.HasProp("ttft_ms") ? msg.ttft_ms : 0,
            createdAt: msg.HasProp("created_at") ? msg.created_at : "" }
        if msg.role = "assistant" && msg.model {
            msgObj.model := msg.model
            msgObj.provider := msg.HasProp("provider") && msg.provider ? msg.provider : ""
        }
        if msg.sibling_group {
            siblings := ChatDB.Msg_GetSiblings(msg.id)
            ; Branch labels use the message's current 1-based position among
            ; remaining siblings; stored sibling indexes can contain gaps.
            pos := 0
            for i, sib in siblings {
                if sib.id = msg.id {
                    pos := i
                    break
                }
            }
            msgObj.siblingInfo := { index: pos ? pos : 1, total: siblings.Length }
        }
        if msg.HasProp("reasoning") && msg.reasoning
            msgObj.reasoning := msg.reasoning
        ; Include attachments for this message
        if allAttachments.Has(msg.id)
            msgObj.attachments := allAttachments[msg.id]
        structuredMessages.Push(msgObj)
    }
    return structuredMessages
}

; Load a thread into UI with full refresh. Replaces 3 duplicate call sites.
_LoadThreadAndRefreshUI(threadId, includeDropdownLabel := true) {
    global activeThreadId
    activeThreadId := threadId
    ; Locked-chat gate: a locked thread's content (messages, tree, stats,
    ; per-thread settings) must never reach the WebView until it is unlocked
    ; in this session. Every load path converges here - sidebar clicks,
    ; navigateToMessage, WM_LOAD_THREAD, the command-line argument, and the
    ; webViewReady reload.
    if ThreadLockService.IsLocked(threadId) && !ThreadLockService.IsUnlockedInSession(threadId) {
        _postLockedThreadState(threadId)
        _postThreadListRefresh()
        return
    }
    _restoreThreadSettings(activeThreadId)
    path := ChatDB.Msg_GetActivePath(activeThreadId)
    postWebMessage("initChatMode", { messages: buildStructuredMessagesFromPath(path, activeThreadId), threadId: activeThreadId })
    postWebMessage("renderChatTree", ChatDB.Msg_GetTree(activeThreadId))
    postThreadStats(activeThreadId)
    ; Lock metadata for an unlocked-but-locked chat: the lock modal needs the
    ; stored salt/iterations to derive the CURRENT password hash when
    ; changing or removing the lock.
    if ThreadLockService.IsLocked(threadId) {
        lockData := ThreadLockService.GetLockData(threadId)
        postWebMessage("threadLockInfo", {
            threadId: threadId,
            salt: lockData ? lockData.salt : "",
            iterations: lockData ? lockData.iterations : ThreadLockService.DEFAULT_ITERATIONS
        })
    }
    if includeDropdownLabel
        _sendDropdownLabel()
    ; Push per-thread settings (model, assistant, font size, etc.) to WebView
    postCurrentSettingsToWebView()
    ; Loading a thread also refreshes sidebar membership/order and restores any
    ; in-flight partial response that belongs to it.
    _postThreadListRefresh()
    _RepostActiveStreamForThread(activeThreadId)
    ; Keep the native window title aligned with the active thread.
    threadInfo := ChatDB.db.Query("SELECT title FROM chat_threads WHERE id=?;", activeThreadId)
    if threadInfo.count
        chatWindow.Title := AppInfo.Name " - " threadInfo[1, "title"]
}

; Swap the chat pane for the lock overlay and reveal nothing about the
; thread (no title, no messages, no settings).
_postLockedThreadState(threadId) {
    global chatWindow
    lockData := ThreadLockService.GetLockData(threadId)
    postWebMessage("threadLocked", {
        threadId: threadId,
        salt: lockData ? lockData.salt : "",
        iterations: lockData ? lockData.iterations : ThreadLockService.DEFAULT_ITERATIONS
    })
    if IsSet(chatWindow) && chatWindow
        chatWindow.Title := AppInfo.Name " - Locked chat"
}

; Refresh thread list and trash list in the sidebar WebView.
; Replaces 5 duplicate call sites across Message.ahk and Sidebar.ahk.
_postThreadListRefresh() {
    threads := ChatDB.Thread_List()
    folders := _GetFolders()
    postWebMessage("threadList", { threads: threads, folders: folders })
    postWebMessage("trashList", ChatDB.Thread_List(true))
}

_GetFolders() {
    table := ChatDB.db.Query("SELECT id, name FROM chat_folders ORDER BY name;")
    folders := []
    for row in table.rows {
        folders.Push({ id: row.id, name: row.name })
    }
    return folders
}

; generateThreadTitle() is in ThreadTitleGen.ahk - included via ChatWindow.ahk
