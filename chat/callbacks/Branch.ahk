; Branch callbacks - navigation, fork, retry

; ----------------------------------------------------
; Switch branch from WebView (D3)
; ----------------------------------------------------

handleBranchSwitch(params, *) {
    global activeThreadId
    if !params.Has("id") || !activeThreadId
        return
    id := params["id"]
    direction := params.Has("direction") ? params["direction"] : 1
    result := ChatDB.Msg_SwitchBranch(activeThreadId, id, direction)
    debugLog("[BRANCH] Switch - thread=" activeThreadId " leaf=" id)
    postWebMessage("updateChatView", buildStructuredMessagesFromPath(result.path, activeThreadId))
    postWebMessage("updateBranchInfo", { msgId: id, siblingInfo: result.siblingInfo })
    postThreadStats(activeThreadId)
    ; A branch switch bumps the thread's updated_at; refresh the sidebar
    ; list so its order and model badge follow the newly active
    ; branch instead of staying stale until some other action reposts it.
    _postThreadListRefresh()
    ; Branch navigation does not use the full thread-loader path, so explicitly
    ; restore any in-flight request that belongs to the newly selected path.
    _RepostActiveStreamForThread(activeThreadId)
}

; ----------------------------------------------------
; Fork/duplicate chat from WebView (D7)
; ----------------------------------------------------

handleFork(msgId, *) {
    global activeThreadId
    if !msgId || !activeThreadId
        return
    newThreadId := ChatDB.Msg_ForkThread(activeThreadId, msgId)
    debugLog("[THREAD] Forked - id=" newThreadId " from=" activeThreadId)
    if newThreadId {
        ; The fork inherits the source's lock. Keep it unlocked in THIS session
        ; so the user who just created it can read it without re-entering the
        ; password - it stays locked in the DB for every other session.
        if ThreadLockService.IsLocked(newThreadId)
            ThreadLockService.Unlock(newThreadId)
        postWebMessage("threadForked", { newThreadId: newThreadId })
    }
}

; ----------------------------------------------------
; Button click actions
; ----------------------------------------------------

; Find which message to retry: specific assistant by id, or last assistant in path.
; Returns { targetMsg, parentMsg } - both empty if no retry target found.
_findRetryTarget(path, messageId) {
    if messageId && path.Length {
        for i, msg in path {
            if msg.id = messageId && msg.role = "assistant" {
                parentMsg := i > 1 ? path[i - 1] : ""
                return { targetMsg: msg, parentMsg: parentMsg }
            }
        }
    }
    if path.Length && path[path.Length].role = "assistant" {
        parentMsg := path.Length > 1 ? path[path.Length - 1] : ""
        return { targetMsg: path[path.Length], parentMsg: parentMsg }
    }
    return { targetMsg: "", parentMsg: "" }
}

; Ensure the message has a sibling_group, creating one if needed.
; Sets sibling_index=0 on the message. Returns the sibling group UUID.
_setupSiblingGroup(msg) {
    sg := msg.sibling_group
    if !sg {
        sg := ChatDB._UUID()
        ; msg.id and sg are bound parameters, so crafted ids
        ; can never alter the SQL text.
        ChatDB.db.Query("UPDATE messages SET sibling_group=?, sibling_index=0 WHERE id=?;", sg, msg.id)
        ChatDB._MarkPersistentDataChanged()
    }
    return sg
}

retryAction(messageId := "") {
    global activeThreadId, requestParams
    if !activeThreadId
        return
    path := ChatDB.Msg_GetActivePath(activeThreadId)
    target := _findRetryTarget(path, messageId)

    if target.targetMsg {
        requestParams["pendingRetryThreadId"] := activeThreadId
        requestParams["pendingRetryOriginalLeaf"] := path[path.Length].id
        requestParams["pendingRetrySiblingGroup"] := _setupSiblingGroup(target.targetMsg)
        if target.parentMsg {
            requestParams["pendingRetryRewoundLeaf"] := target.parentMsg.id
            ChatDB.Msg_SetActiveLeaf(activeThreadId, target.parentMsg.id)
        } else {
            requestParams["pendingRetryRewoundLeaf"] := path[path.Length].id
            ; A root-assistant retry has no parent. The
            ; leaf must stay on the original so the request can still be built,
            ; but the pending response must be inserted with parent_id NULL as
            ; a SIBLING of the original - not as its CHILD. Flag it for
            ; _persistStreamResponse.
            requestParams["pendingRetryIsRoot"] := true
        }
    } else if path.Length && path[path.Length].role = "user" {
        ; Chat ends with user (e.g. assistant was deleted). Clear stale retry state.
        if requestParams.Has("pendingRetrySiblingGroup")
            requestParams.Delete("pendingRetrySiblingGroup")
    }

    if requestParams.Has("pendingRetrySiblingGroup") || (path.Length && path[path.Length].role = "user")
        ; Chat UI retries always stream.
        requestParams["stream"] := true
        _BuildAndFireRequest()
}
