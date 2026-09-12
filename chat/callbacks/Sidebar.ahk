; Thread list and sidebar navigation callbacks

; ----------------------------------------------------
; Sidebar actions from WebView (D6)
; ----------------------------------------------------

handleSidebarAction(params, *) {
    global activeThreadId
    subAction := params.Has("subAction") ? params["subAction"] : params["action"]
    switch subAction {
        case "loadThreadList":
            _postThreadListRefresh()
        case "loadTrashList":
            postWebMessage("trashList", ChatDB.Thread_List(true))
        case "loadTree":
            if activeThreadId
                postWebMessage("renderChatTree", ChatDB.Msg_GetTree(activeThreadId))
        case "loadThread":
            if params.Has("threadId")
                _LoadThreadAndRefreshUI(params["threadId"])
        case "navigateToMessage":
            if params.Has("messageId") && activeThreadId {
                leafId := TreeRepo._WalkToLeaf(params["messageId"], activeThreadId)
                ChatDB.Msg_SetActiveLeaf(activeThreadId, leafId)
                _LoadThreadAndRefreshUI(activeThreadId, false)
                ; SetActiveLeaf bumps the thread's updated_at, so the
                ; sidebar order and active-path model badge must be refreshed.
                ; tree-modal and search navigation both route here, and without
                ; this post the list kept the pre-navigation order until some
                ; unrelated action reposted it.
                _postThreadListRefresh()
            }
        case "newChat", "deleteThread", "restoreThread", "deleteThreadForever", "emptyTrash", "renameThread":
            _HandleThreadAction(subAction, params)
        case "createFolder", "renameFolder", "deleteFolder", "moveToFolder":
            _HandleFolderAction(subAction, params)
    }
}

; ---------- Thread actions ----------

_HandleThreadAction(action, params) {
    global activeThreadId
    switch action {
        case "newChat":
            activeThreadId := ChatDB.Thread_Create()
            _resetToDefaultSettings()
            ; Start new chats with the configured default assistant/model.
            if _prepareFreshChatSettings()
                ChatDB.Thread_UpdateSettings(activeThreadId, _CurrentSettingsObject())
            ; Apply default font size from settings to the new thread
            global responseWindowFontSize
            if IsSet(responseWindowFontSize) && responseWindowFontSize
                ChatDB.Thread_UpdateSettings(activeThreadId, { fontSize: responseWindowFontSize })
            postWebMessage("loadThread", activeThreadId)
            ; Publish the resolved new-chat model/assistant immediately. The
            ; subsequent full load publishes the same persisted thread state.
            postCurrentSettingsToWebView()
            _sendDropdownLabel()
            _postThreadListRefresh()

        case "deleteThread":
            if params.Has("threadId") {
                threadId := params["threadId"]
                ; Locked chats must be unlocked before they can be deleted
                ; (a lock is worthless if the delete button can destroy it).
                ThreadLockService.RequireUnlocked(threadId)
                ChatDB.Thread_SoftDelete(threadId)
                if activeThreadId = threadId {
                    activeThreadId := ""
                    ; The deleted thread's settings must not leak into the next
                    ; chat: handleChatSend persists requestParams when it creates
                    ; a new thread, so reset to defaults and refresh the UI.
                    _resetToDefaultSettings()
                    postWebMessage("loadThread", "")
                    postWebMessage("initChatMode", [])
                    postCurrentSettingsToWebView()
                    _sendDropdownLabel()
                    ; The title bar must follow the emptied state.
                    ; Clear the deleted thread's name immediately.
                    chatWindow.Title := AppInfo.Name
                }
                _postThreadListRefresh()
            }

        case "restoreThread":
            if params.Has("threadId") {
                ChatDB.Thread_Restore(params["threadId"])
                _postThreadListRefresh()
            }

        case "deleteThreadForever":
            if params.Has("threadId") {
                threadId := params["threadId"]
                ThreadLockService.RequireUnlocked(threadId)
                ChatDB.Thread_Delete(threadId)
                if activeThreadId = threadId {
                    activeThreadId := ""
                    _resetToDefaultSettings()
                    postWebMessage("loadThread", "")
                    postWebMessage("initChatMode", [])
                    postCurrentSettingsToWebView()
                    _sendDropdownLabel()
                    ; Reset the title when the active thread is
                    ; permanently deleted.
                    chatWindow.Title := AppInfo.Name
                }
                _postThreadListRefresh()
            }

        case "emptyTrash":
            trashed := ChatDB.Thread_List(true)
            for t in trashed
                ChatDB.Thread_Delete(t.id)
            if activeThreadId {
                stillExists := false
                for t in ChatDB.Thread_List()
                    if t.id = activeThreadId
                        stillExists := true
                if !stillExists {
                    activeThreadId := ""
                    _resetToDefaultSettings()
                    postWebMessage("initChatMode", [])
                    postCurrentSettingsToWebView()
                    _sendDropdownLabel()
                    ; Reset the title when emptyTrash removes the
                    ; active thread.
                    chatWindow.Title := AppInfo.Name
                }
            }
            _postThreadListRefresh()

        case "renameThread":
            if params.Has("threadId") && params.Has("title") {
                ChatDB.Thread_Update(params["threadId"], params["title"])
                _postThreadListRefresh()
                if activeThreadId = params["threadId"] {
                    threadInfo := ChatDB.db.Query("SELECT title FROM chat_threads WHERE id=?;", params["threadId"])
                    if threadInfo.count
                        chatWindow.Title := AppInfo.Name " - " threadInfo[1, "title"]
                }
            }
    }
}

; ---------- Folder actions ----------

_HandleFolderAction(action, params) {
    switch action {
        case "createFolder":
            if params.Has("name") {
                id := ChatDB._UUID()
                ChatDB.db.Query("INSERT INTO chat_folders (id, name) VALUES(?, ?);", id, params["name"])
                ChatDB._MarkPersistentDataChanged()
                _postThreadListRefresh()
            }

        case "renameFolder":
            if params.Has("folderId") && params.Has("name") {
                ChatDB.db.Query("UPDATE chat_folders SET name=? WHERE id=?;", params["name"], params["folderId"])
                ChatDB._MarkPersistentDataChanged()
                _postThreadListRefresh()
            }

        case "deleteFolder":
            if params.Has("folderId") {
                ChatDB.db.Query("UPDATE chat_threads SET folder_id=NULL WHERE folder_id=?;", params["folderId"])
                ChatDB.db.Query("DELETE FROM chat_folders WHERE id=?;", params["folderId"])
                ChatDB._MarkPersistentDataChanged()
                _postThreadListRefresh()
            }

        case "moveToFolder":
            if params.Has("threadId") && params.Has("folderId") {
                fid := params["folderId"] = "__none__" ? SQLite.Null : params["folderId"]
                ChatDB.db.Query("UPDATE chat_threads SET folder_id=? WHERE id=?;", fid, params["threadId"])
                ChatDB._MarkPersistentDataChanged()
                debugLog("[FOLDER] moveToFolder thread=" params["threadId"] " folderId=" params["folderId"])
                _postThreadListRefresh()
            }
    }
}
