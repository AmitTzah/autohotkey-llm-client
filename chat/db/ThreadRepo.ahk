; ======================================================
; ThreadRepo.ahk - Thread CRUD operations
;
; Part of ChatDB split. All thread-related database
; operations extracted from ChatDB.ahk.
; ======================================================

class ThreadRepo {

    ; Normalize a JSON boolean / 1 / 0 / "true" / "false" value to a real boolean.
    static _ToBool(value) {
        if value = 1 || value = "1" || value = "true" || value = "on" || value = "yes"
            return true
        return false
    }

    ; An empty value normally clears an override. The explicit flag lets the
    ; UI persist an intentional empty override (Model Default / blank prompt).
    static _OverrideFlag(settings, flagName, value) {
        if settings.HasOwnProp(flagName)
            return ThreadRepo._ToBool(settings.%flagName%)
        return value != ""
    }

    ; Create a new thread. Returns thread id string.
    static Create(title := "New Chat") {
        id := ChatDB._UUID()
        ChatDB.db.Query("INSERT INTO chat_threads (id, title) VALUES(?, ?);", id, title)
        ChatDB._MarkPersistentDataChanged()
        return id
    }

    ; Save per-thread settings (model, assistant, system, reasoning, temperature,
    ; fontSize, and the right-rail Advanced toggles).
    static UpdateSettings(threadId, settings) {
        parts := []
        params := []
        if settings.HasOwnProp("assistantId")
            parts.Push("assistant_id = ?") params.Push(settings.assistantId ? settings.assistantId : SQLite.Null)
        if settings.HasOwnProp("modelOverride")
            parts.Push("model_override = ?") params.Push(settings.modelOverride ? settings.modelOverride : SQLite.Null)
        if settings.HasOwnProp("systemOverride") {
            parts.Push("system_override = ?") params.Push(settings.systemOverride != "" ? settings.systemOverride : SQLite.Null)
            parts.Push("system_override_set = ?") params.Push(ThreadRepo._OverrideFlag(settings, "systemOverrideSet", settings.systemOverride))
        }
        if settings.HasOwnProp("reasoningOverride") {
            parts.Push("reasoning_override = ?") params.Push(settings.reasoningOverride != "" ? settings.reasoningOverride : SQLite.Null)
            parts.Push("reasoning_override_set = ?") params.Push(ThreadRepo._OverrideFlag(settings, "reasoningOverrideSet", settings.reasoningOverride))
        }
        if settings.HasOwnProp("temperatureOverride") {
            parts.Push("temperature_override = ?") params.Push(settings.temperatureOverride != "" ? settings.temperatureOverride : SQLite.Null)
            parts.Push("temperature_override_set = ?") params.Push(ThreadRepo._OverrideFlag(settings, "temperatureOverrideSet", settings.temperatureOverride))
        }
        if settings.HasOwnProp("fontSize")
            parts.Push("font_size = ?") params.Push(settings.fontSize ? settings.fontSize : 17)
        if settings.HasOwnProp("webSearch") || settings.HasOwnProp("imageGeneration") {
            currentSettings := ThreadRepo.GetSettings(threadId)
            currentWebSearch := currentSettings ? currentSettings.webSearch : false
            currentImageGeneration := currentSettings ? currentSettings.imageGeneration : false
            togglesJson := jsongo.Stringify({
                webSearch: settings.HasOwnProp("webSearch") ? ThreadRepo._ToBool(settings.webSearch) : currentWebSearch, imageGeneration: settings.HasOwnProp("imageGeneration") ? ThreadRepo._ToBool(settings.imageGeneration) : currentImageGeneration
            })
            togglesJson := ThreadRepo._MergeAdvancedToggles(threadId, togglesJson)
            parts.Push("advanced_toggles = ?") params.Push(togglesJson)
        }
        if parts.Length {
            setClause := ""
            for i, p in parts
                setClause .= (i > 1 ? ", " : "") p
            params.Push(threadId)
            ChatDB.db.Query("UPDATE chat_threads SET " setClause " WHERE id=?;", params*)
            ChatDB._MarkPersistentDataChanged()
        }
    }

    static _MergeAdvancedToggles(threadId, updatesJson) {
        updates := jsongo.Parse(updatesJson)
        current := ChatDB.db.Query("SELECT advanced_toggles FROM chat_threads WHERE id=?;", threadId)
        if !current.count || !current[1, "advanced_toggles"]
            return updatesJson
        try existing := jsongo.Parse(current[1, "advanced_toggles"])
        catch
            return updatesJson
        for key, value in updates
            existing[key] := value
        return jsongo.Stringify(existing)
    }

    ; Get per-thread settings.
    static GetSettings(threadId) {
        table := ChatDB.db.Query("SELECT assistant_id, model_override, system_override, reasoning_override, temperature_override, system_override_set, reasoning_override_set, temperature_override_set, font_size, advanced_toggles FROM chat_threads WHERE id=?;", threadId)
        if table.count {
            row := table[1]
            webSearch := false, imageGeneration := false
            if row.advanced_toggles {
                try {
                    toggles := jsongo.Parse(row.advanced_toggles)
                    webSearch := toggles.Has("webSearch") ? ThreadRepo._ToBool(toggles["webSearch"]) : false
                    imageGeneration := toggles.Has("imageGeneration") ? ThreadRepo._ToBool(toggles["imageGeneration"]) : false
                } catch {
                    debugLog("[THREAD] Failed to parse advanced_toggles for " threadId)
                }
            }
            return {
                assistantId: row.assistant_id,
                modelOverride: row.model_override,
                systemOverride: row.system_override,
                reasoningOverride: row.reasoning_override,
                temperatureOverride: row.temperature_override,
                systemOverrideSet: ThreadRepo._ToBool(row.system_override_set),
                reasoningOverrideSet: ThreadRepo._ToBool(row.reasoning_override_set),
                temperatureOverrideSet: ThreadRepo._ToBool(row.temperature_override_set),
                webSearch: webSearch,
                imageGeneration: imageGeneration,
                fontSize: row.font_size ? row.font_size : 17
            }
        }
        return ""
    }

    ; Get threads sorted by most recent first.
    static List(showTrash := false) {
        global appDefaultModel, assistants
        query := "SELECT t.id, t.title, t.created_at, t.updated_at, t.active_leaf_id, t.assistant_id, t.model_override, t.folder_id, t.is_locked, COALESCE(f.name, '') AS folder_name FROM chat_threads t LEFT JOIN chat_folders f ON t.folder_id = f.id WHERE t.is_deleted=" (showTrash ? 1 : 0)
        query .= " ORDER BY t.updated_at DESC"
        table := ChatDB.db.Exec(query)
        threads := []
        ; Build sidebar badge data without per-thread ancestor N+1 queries.
        ; Load the message rows for all listed threads in one query and walk
        ; ancestor chains in memory.
        msgMap := Map()
        if table.count {
            msgTable := ChatDB.db.Query("SELECT id, parent_id, role, model, provider FROM messages WHERE thread_id IN (SELECT id FROM chat_threads WHERE is_deleted=" (showTrash ? 1 : 0) ");")
            for msgRow in msgTable.rows {
                msgMap[msgRow.id] := {
                    parent_id: msgRow.parent_id ? msgRow.parent_id : "",
                    role: msgRow.role,
                    model: msgRow.model ? msgRow.model : "",
                    provider: msgRow.Has("provider") && msgRow.provider ? msgRow.provider : ""
                }
            }
        }
        for row in table.rows {
            ; The sidebar badge reflects the active path's model.
            ; (the last assistant on the path currently open), not the
            ; LAST-INSERTED assistant row in the thread (which can live on an
            ; off-path branch after a retry/branch switch). Walk from the active
            ; leaf up to the nearest assistant.
            model := ""
            provider := ""
            currentId := row.active_leaf_id ? row.active_leaf_id : ""
            while currentId && msgMap.Has(currentId) {
                msg := msgMap[currentId]
                if msg.role = "assistant" && msg.model {
                    model := msg.model
                    provider := msg.provider
                    break
                }
                currentId := msg.parent_id
            }
            ; A brand-new/user-only thread has no assistant row yet. Its badge
            ; should reflect the model configured for the thread instead of falling
            ; through the UI's unknown-model fallback (OpenRouter). Preserve the
            ; active-path assistant model above whenever one exists.
            if !model && !currentId {
                if row.model_override {
                    model := row.model_override
                } else if row.assistant_id && IsSet(assistants) {
                    for asst in assistants {
                        if asst.HasOwnProp("id") && asst.id = row.assistant_id {
                            if asst.HasOwnProp("baseModel")
                                model := asst.baseModel
                            break
                        }
                    }
                }
                if !model && IsSet(appDefaultModel)
                    model := appDefaultModel
            }
            ; Bug (locked chats): a locked thread's real title can leak intent
            ; (e.g. "Salary negotiation", "therapy notes"), so it is redacted
            ; everywhere the list renders - sidebar AND trash - UNLESS the user
            ; already unlocked it in this ChatWindow session (then the real
            ; title is shown and renaming works normally). ThreadLockService
            ; only exists in the ChatWindow process; other processes (Main)
            ; simply keep the redacted title.
            isLocked := Integer(row.is_locked ? row.is_locked : 0)
            title := row.title
            ; Fail closed when this process has no session-aware lock service:
            ; a locked title is confidential unless unlock has been proven.
            if isLocked && (!IsSet(ThreadLockService) || !ThreadLockService.IsUnlockedInSession(row.id))
                title := "Locked chat"
            threads.Push({
                id: row.id,
                title: title,
                is_locked: isLocked,
                created_at: row.created_at,
                updated_at: row.updated_at,
                model: model,
                provider: provider,
                folder_id: row.folder_id ? row.folder_id : "",
                folder_name: row.folder_name ? row.folder_name : ""
            })
        }
        return threads
    }

    ; Trash a thread (soft-delete).
    static SoftDelete(threadId) {
        debugLog("[THREAD] Deleted - id=" threadId)
        ChatDB.db.Query("UPDATE chat_threads SET is_deleted=1, deleted_at=datetime('now'), updated_at=datetime('now') WHERE id=?;", threadId)
        ChatDB._MarkPersistentDataChanged()
    }

    ; Restore a trashed thread.
    static Restore(threadId) {
        ChatDB.db.Query("UPDATE chat_threads SET is_deleted=0, deleted_at=NULL, updated_at=datetime('now') WHERE id=?;", threadId)
        ChatDB._MarkPersistentDataChanged()
    }

    ; Permanently delete expired trashed threads.
    static PurgeExpired() {
        if (IsSet(trashRetentionDays) && trashRetentionDays <= 0) || (!IsSet(trashRetentionDays))
            return
        ; Coerce to a number and bind it as the datetime modifier - a crafted
        ; setting value can never alter the SQL text.
        retention := Integer(trashRetentionDays)
        retentionModifier := "-" retention " days"
        ; Clean up attachment files on disk BEFORE the raw SQL DELETEs.
        ; The CASCADE FK would auto-delete message_attachments rows but leave orphan files.
        expiredTable := ChatDB.db.Query("SELECT id FROM chat_threads WHERE is_deleted=1 AND deleted_at < datetime('now', ?);", retentionModifier)
        if !expiredTable.count
            return
        ChatDB.BeginTransaction()
        try {
        ; Keep messages_fts in sync with messages during purge.
        ; rows for every purged message (same guarantee as MessageRepo.HardDelete
        ; -> FTS_Remove). The raw DELETEs below never touch the FTS index.
        changed := false
        for row in expiredTable.rows {
            msgIds := ChatDB.db.Query("SELECT id FROM messages WHERE thread_id=?;", row.id)
            for m in msgIds.rows
                ChatDB.FTS_Remove(m.id)
            if AttachmentRepo.DeleteByThread(row.id, false) > 0
                changed := true
        }
        ChatDB.db.Query("DELETE FROM messages WHERE thread_id IN (SELECT id FROM chat_threads WHERE is_deleted=1 AND deleted_at < datetime('now', ?));", retentionModifier)
        if ThreadRepo._Changes() > 0
            changed := true
        ChatDB.db.Query("DELETE FROM chat_threads WHERE is_deleted=1 AND deleted_at < datetime('now', ?);", retentionModifier)
        if ThreadRepo._Changes() > 0
            changed := true
        if changed
            ChatDB.RequestSpaceReclaim()
        if changed
            ChatDB._MarkPersistentDataChanged()
        ChatDB.CommitTransaction()
        } catch Error as e {
            ChatDB.RollbackTransaction()
            throw e
        }
    }

    static _Changes() {
        result := ChatDB.db.Exec("SELECT changes() AS count;")
        return result.count ? Integer(result[1, "count"]) : 0
    }

    ; Permanently delete a thread and all its messages.
    static Delete(threadId) {
        debugLog("[THREAD] Deleted - id=" threadId)
        ChatDB.BeginTransaction()
        try {
        ; Pass the raw id; DeleteByThread performs its own escaping.
        ; Passing safeId (already escaped) double-escaped it, so crafted-id
        ; threads deleted their messages but orphaned their attachment rows.
        AttachmentRepo.DeleteByThread(threadId)
        ; Remove FTS rows before deleting the thread.
        ; This keeps thread-level deletion consistent with HardDelete.
        msgIds := ChatDB.db.Query("SELECT id FROM messages WHERE thread_id=?;", threadId)
        for m in msgIds.rows
            ChatDB.FTS_Remove(m.id)
        ChatDB.MaybeFault("thread-delete-after-attachments")
        ChatDB.db.Query("DELETE FROM messages WHERE thread_id=?;", threadId)
        ChatDB.db.Query("DELETE FROM chat_threads WHERE id=?;", threadId)
        ChatDB.RequestSpaceReclaim()
        ChatDB.CommitTransaction()
        ChatDB._MarkPersistentDataChanged()
        } catch Error as e {
            ChatDB.RollbackTransaction()
            throw e
        }
    }

    ; Update thread title and timestamp.
    static Update(threadId, title, updateTimestamp := true) {
        if !threadId
            return
        if updateTimestamp
            ChatDB.db.Query("UPDATE chat_threads SET title=?, updated_at=datetime('now') WHERE id=?;", title, threadId)
        else
            ChatDB.db.Query("UPDATE chat_threads SET title=? WHERE id=?;", title, threadId)
        ChatDB._MarkPersistentDataChanged()
    }
}
