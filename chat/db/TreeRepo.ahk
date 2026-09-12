; ======================================================
; TreeRepo.ahk - Message tree operations
;
; Branch navigation, tree visualization, fork, stats.
; Extracted from MessageRepo.ahk.
; ======================================================

#Include ..\..\shared\ModelResolver.ahk

class TreeRepo {

    static GetActivePath(threadId) {
        leafTable := ChatDB.db.Query("SELECT active_leaf_id FROM chat_threads WHERE id=?;", threadId)
        if !leafTable.count
            return []
        leafId := leafTable[1, "active_leaf_id"]
        return TreeRepo.GetPathToLeaf(threadId, leafId)
    }

    ; Return the path ending at an explicit leaf, without consulting the
    ; thread's mutable active_leaf_id. Request scopes use this to keep an
    ; in-flight continuation on the branch that sent the request.
    static GetPathToLeaf(threadId, leafId) {
        if !leafId
            return []

        ; threadId is a bound parameter, so its value cannot alter the SQL text.
        allTable := ChatDB.db.Query("SELECT id, thread_id, role, content, model, provider, parent_id, sibling_group, sibling_index, reasoning, token_count, prompt_tokens, thinking_tokens, cached_tokens, response_time_ms, ttft_ms, active_path_tokens, is_local_copy, api_output_tokens, input_cost, cached_input_cost, output_cost, total_cost, created_at FROM messages WHERE thread_id=?;", threadId)

        msgMap := Map()
        for row in allTable.rows {
            msgMap[row.id] := {
                id: row.id, thread_id: row.thread_id, role: row.role,
                content: row.content, model: row.model ? row.model : "",
                provider: row.Has("provider") && row.provider ? row.provider : "",
                parent_id: row.parent_id ? row.parent_id : "",
                sibling_group: row.sibling_group ? row.sibling_group : "",
                sibling_index: row.sibling_index,
                reasoning: row.Has("reasoning") && row["reasoning"] ? row["reasoning"] : "",
                token_count: row.Has("token_count") && row.token_count ? Integer(row.token_count) : 0,
                prompt_tokens: row.Has("prompt_tokens") && row["prompt_tokens"] ? Integer(row["prompt_tokens"]) : 0,
                thinking_tokens: row.Has("thinking_tokens") && row.thinking_tokens ? Integer(row.thinking_tokens) : 0,
                cached_tokens: row.Has("cached_tokens") && row.cached_tokens ? Integer(row.cached_tokens) : 0,
                response_time_ms: row.Has("response_time_ms") && row.response_time_ms ? Integer(row.response_time_ms) : 0,
                ttft_ms: row.Has("ttft_ms") && row.ttft_ms ? Integer(row.ttft_ms) : 0,
                active_path_tokens: row.Has("active_path_tokens") && row["active_path_tokens"] ? Integer(row["active_path_tokens"]) : 0,
                is_local_copy: row.Has("is_local_copy") ? Integer(row["is_local_copy"]) : 0,
                api_output_tokens: row.Has("api_output_tokens") ? Integer(row["api_output_tokens"]) : 0,
                ; Carry each message's call-time cost snapshot into the path.
                ; effect when its API call was made) into the path so forks can
                ; copy it - otherwise a Settings price change re-prices history.
                input_cost: row.Has("input_cost") && row.input_cost != "" ? Number(row.input_cost) : 0,
                cached_input_cost: row.Has("cached_input_cost") && row.cached_input_cost != "" ? Number(row.cached_input_cost) : 0,
                output_cost: row.Has("output_cost") && row.output_cost != "" ? Number(row.output_cost) : 0,
                total_cost: row.Has("total_cost") && row.total_cost != "" ? Number(row.total_cost) : 0,
                created_at: row.created_at
            }
        }

        path := []
        currentId := leafId
        while currentId && msgMap.Has(currentId) {
            path.InsertAt(1, msgMap[currentId])
            currentId := msgMap[currentId].parent_id
        }

        return path
    }

    static GetSiblings(msgId) {
        table := ChatDB.db.Query("SELECT sibling_group, thread_id, parent_id, role FROM messages WHERE id=?;", msgId)
        if !table.count
            return []
        sg := table[1, "sibling_group"]
        if !sg
            return []
        tid := table[1, "thread_id"]
        parentId := table[1, "parent_id"] ? table[1, "parent_id"] : ""
        role := table[1, "role"]

        table2 := ChatDB.db.Query("SELECT id, role, content, model, sibling_index, parent_id FROM messages WHERE sibling_group=? AND thread_id=? AND role=? ORDER BY sibling_index;", sg, tid, role)
        siblings := []
        for row in table2.rows {
            rowParent := row.parent_id ? row.parent_id : ""
            if rowParent != parentId
                continue
            siblings.Push({
                id: row.id, role: row.role,
                content_preview: SubStr(row.content, 1, 80),
                model: row.model ? row.model : "",
                sibling_index: row.sibling_index
            })
        }
        return siblings
    }

    static GetTree(threadId) {
        allTable := ChatDB.db.Query("SELECT * FROM messages WHERE thread_id=?;", threadId)
        nodeMap := Map(), childrenMap := Map()
        for row in allTable.rows {
            node := {
                id: row.id, role: row.role,
                content_preview: SubStr(row.content, 1, 80),
                model: row.model ? row.model : "",
                parent_id: row.parent_id ? row.parent_id : "",
                sibling_group: row.sibling_group ? row.sibling_group : "",
                sibling_index: row.sibling_index,
                children: []
            }
            nodeMap[row.id] := node
            parentKey := row.parent_id ? row.parent_id : "__root__"
            if !childrenMap.Has(parentKey)
                childrenMap[parentKey] := []
            childrenMap[parentKey].Push(row.id)
        }

        for parentKey, childIds in childrenMap {
            if parentKey = "__root__"
                continue
            if nodeMap.Has(parentKey) {
                ; Sort by sibling_index descending: newest (2/2) on top
                sorted := TreeRepo._SortTreeChildren(childIds, nodeMap)
                for cid in sorted {
                    if nodeMap.Has(cid)
                        nodeMap[parentKey].children.Push(nodeMap[cid])
                }
            }
        }

        roots := []
        if childrenMap.Has("__root__") {
            sortedRoots := TreeRepo._SortTreeChildren(childrenMap["__root__"], nodeMap)
            for cid in sortedRoots {
                if nodeMap.Has(cid)
                    roots.Push(nodeMap[cid])
            }
        }
        return roots
    }

    ; Sort child IDs by sibling_index descending (newest first).
    ; Messages without sibling_group/sibling_index sort after those with.
    static _SortTreeChildren(childIds, nodeMap) {
        result := []
        for cid in childIds
            result.Push(cid)
        ; Bubble sort by sibling_index descending
        loop result.Length - 1 {
            for i, cid in result {
                if i >= result.Length
                    break
                current := nodeMap.Has(cid) ? nodeMap[cid].sibling_index : -1
                next := result.Has(i + 1) && nodeMap.Has(result[i + 1]) ? nodeMap[result[i + 1]].sibling_index : -1
                if current < next {
                    temp := result[i]
                    result[i] := result[i + 1]
                    result[i + 1] := temp
                }
            }
        }
        return result
    }

    static ForkThread(threadId, upToMsgId) {
        path := TreeRepo.GetActivePath(threadId)
        if !path.Length
            return ""

        cutoff := 0
        for i, msg in path {
            if msg.id = upToMsgId {
                cutoff := i
                break
            }
        }
        if !cutoff
            return ""

        ChatDB.BeginTransaction()
        try {
        newThreadId := TreeRepo._CreateForkThread(threadId)
        ChatDB.MaybeFault("fork-after-thread")

          ; Copy thread-level settings from original to fork
          TreeRepo._CopyThreadSettings(threadId, newThreadId)
          ; A fork is a full copy of the conversation prefix - if the source is
          ; password-protected, the copy must be equally protected, or forking
          ; would silently strip the lock from sensitive content.
          TreeRepo._CopyThreadLock(threadId, newThreadId)

        idMap := Map()
        sgMap := Map()  ; source sibling_group -> new sibling_group (fresh UUIDs per fork)

        ; First pass: copy active path messages up to cutoff
        for i, msg in path {
            if i > cutoff
                break
            newId := ChatDB._UUID()
            idMap[msg.id] := newId
            newParentId := msg.parent_id && idMap.Has(msg.parent_id) ? idMap[msg.parent_id] : ""
            safeSiblingGroup := TreeRepo._MapSiblingGroup(msg, &sgMap)
            TreeRepo._InsertForkMessage(newId, newThreadId, msg, newParentId, safeSiblingGroup)
            AttachmentRepo.CopyForMessage(msg.id, newId)
            if A_Index = 1
                ChatDB.MaybeFault("fork-after-first-message")
        }

        ; Second pass: copy any siblings NOT on the active path so branch nav works,
        ; plus their full descendant subtrees.
        ; Exclude only the active continuation beyond the fork point.
        ; excluded - off-path children of the fork point itself (alternative
        ; continuations that already exist) are part of the conversation tree
        ; and must be copied like off-path siblings at every other level.
        activePathNextId := cutoff < path.Length ? path[cutoff + 1].id : ""
        TreeRepo._CopyOffPathSiblings(threadId, newThreadId, &idMap, &sgMap, path[cutoff].id, activePathNextId)

        newLeafId := idMap[path[cutoff].id]
        ChatDB.db.Query("UPDATE chat_threads SET active_leaf_id=?, updated_at=datetime('now') WHERE id=?;", newLeafId, newThreadId)

        ; Do not copy source-thread cumulative counters into a fork.
        ; fork contains only the prefix (+ off-path branches), so its counters
        ; are recomputed from the fork's own messages (the per-message token
        ; fields are copied by _InsertForkMessage/_CopyOffPathSiblings). This
        ; Recompute them from copied per-message accounting data.
        ; fork's totals until the next structural change.
        MessageRepo._RecomputeCumulativeCounters(newThreadId)

        ; Bulk FTS sync for all copied messages in the forked thread. The
        ; Attachment copies above already FTS-resynced their messages, so DELETE
        ; first to stay idempotent, then re-index messages
        ; WITH attachments (the bulk insert cannot decode base64 text).
        ChatDB.db.Query("DELETE FROM messages_fts WHERE msg_id IN (SELECT id FROM messages WHERE thread_id=?);", newThreadId)
        ChatDB.db.Query("INSERT INTO messages_fts(msg_id, content) SELECT id, content FROM messages WHERE thread_id=?;", newThreadId)
        forkAttMsgs := ChatDB.db.Query("SELECT DISTINCT message_id FROM message_attachments WHERE message_id IN (SELECT id FROM messages WHERE thread_id=?) AND extracted_text != '';", newThreadId)
        for fam in forkAttMsgs.rows
            ChatDB.FTS_ResyncForAttachments(fam.message_id)

        ChatDB.CommitTransaction()
        ChatDB._MarkPersistentDataChanged()
        return newThreadId
        } catch Error as e {
            ChatDB.RollbackTransaction()
            throw e
        }
    }

    ; Create a new thread for the fork with "Copy - " prefix.
    static _CreateForkThread(originalThreadId) {
        oldTitle := "New Chat"
        titleRow := ChatDB.db.Query("SELECT title FROM chat_threads WHERE id=?;", originalThreadId)
        if titleRow.count && titleRow[1, "title"]
            oldTitle := titleRow[1, "title"]
        return ThreadRepo.Create("Copy - " oldTitle)
    }

    ; Copy thread-level settings (model, system, reasoning, temperature, assistant) from original to fork.
      static _CopyThreadSettings(sourceThreadId, targetThreadId) {
        settings := ThreadRepo.GetSettings(sourceThreadId)
        if settings.modelOverride
            ChatDB.db.Query("UPDATE chat_threads SET model_override=? WHERE id=?;", settings.modelOverride, targetThreadId)
        if settings.systemOverrideSet || settings.systemOverride != ""
            ChatDB.db.Query("UPDATE chat_threads SET system_override=?, system_override_set=? WHERE id=?;", settings.systemOverride != "" ? settings.systemOverride : SQLite.Null, settings.systemOverrideSet ? 1 : 0, targetThreadId)
        if settings.reasoningOverrideSet || settings.reasoningOverride != ""
            ChatDB.db.Query("UPDATE chat_threads SET reasoning_override=?, reasoning_override_set=? WHERE id=?;", settings.reasoningOverride != "" ? settings.reasoningOverride : SQLite.Null, settings.reasoningOverrideSet ? 1 : 0, targetThreadId)
        ; Temperature 0 is a valid override; AHK treats numeric 0 as falsy.
        ; Use an explicit empty check.
        if settings.temperatureOverride != "" || settings.temperatureOverrideSet
            ChatDB.db.Query("UPDATE chat_threads SET temperature_override=?, temperature_override_set=? WHERE id=?;", settings.temperatureOverride != "" ? settings.temperatureOverride : SQLite.Null, settings.temperatureOverrideSet ? 1 : 0, targetThreadId)
        if settings.assistantId
            ChatDB.db.Query("UPDATE chat_threads SET assistant_id=? WHERE id=?;", settings.assistantId, targetThreadId)
        ; Also copy per-thread font size and Advanced toggles (Code Execution / Web Search)
        try {
            srcRow := ChatDB.db.Query("SELECT font_size, advanced_toggles, folder_id FROM chat_threads WHERE id=?;", sourceThreadId)
            if srcRow.count {
                if srcRow[1, "font_size"] != ""
                    ChatDB.db.Query("UPDATE chat_threads SET font_size=? WHERE id=?;", Integer(srcRow[1, "font_size"]), targetThreadId)
                if srcRow[1, "advanced_toggles"] != ""
                    ChatDB.db.Query("UPDATE chat_threads SET advanced_toggles=? WHERE id=?;", srcRow[1, "advanced_toggles"], targetThreadId)
                ; Keep the fork in the source thread's folder.
                if srcRow[1, "folder_id"] != ""
                    ChatDB.db.Query("UPDATE chat_threads SET folder_id=? WHERE id=?;", srcRow[1, "folder_id"], targetThreadId)
            }
        }
    }

    ; Copy the source thread's lock (is_locked + chat_locks row) to the fork.
    static _CopyThreadLock(sourceThreadId, targetThreadId) {
        if !ThreadLockRepo.IsLocked(sourceThreadId)
            return
        lockData := ThreadLockRepo.Get(sourceThreadId)
        if !lockData
            return
        ChatDB.db.Query("UPDATE chat_threads SET is_locked=1 WHERE id=?;", targetThreadId)
        ChatDB.db.Query("INSERT OR REPLACE INTO chat_locks (thread_id, kdf, salt, hash, iterations) VALUES(?, ?, ?, ?, ?);", targetThreadId, lockData.kdf, lockData.salt, lockData.hash, lockData.iterations)
    }

    ; Map a source sibling_group to a fresh UUID, creating one if needed.
    ; Returns the fresh UUID, or "" when the message has no sibling group.
    static _MapSiblingGroup(msg, &sgMap) {
        if msg.sibling_group {
            if !sgMap.Has(msg.sibling_group)
                sgMap[msg.sibling_group] := ChatDB._UUID()
            return sgMap[msg.sibling_group]
        }
        return ""
    }

    ; Insert a single message row into the fork thread.
    static _InsertForkMessage(newId, threadId, msg, parentId, siblingGroup) {
        model := msg.model ? msg.model : ""
        provider := msg.HasProp("provider") && msg.provider ? msg.provider : ""
        reasoning := msg.HasProp("reasoning") && msg.reasoning ? msg.reasoning : ""

        tc := msg.HasProp("token_count") ? msg.token_count : 0
        tht := msg.HasProp("thinking_tokens") ? msg.thinking_tokens : 0
        ckt := msg.HasProp("cached_tokens") ? msg.cached_tokens : 0
        lat := msg.HasProp("response_time_ms") ? msg.response_time_ms : 0
        ttft := msg.HasProp("ttft_ms") ? msg.ttft_ms : 0
        ; Keep per-message active-path token totals so fork context remains accurate.
        ; token bar ("Context Used") matches the copied conversation.
        apt := msg.HasProp("active_path_tokens") && msg.active_path_tokens != "" ? Integer(msg.active_path_tokens) : 0
        ; Carry assistant API prompt-token data into the fork for later recompute.
        ; later recompute can restore prompt+completion.
        spt := msg.HasProp("prompt_tokens") && msg.prompt_tokens != "" ? Integer(msg.prompt_tokens) : 0
        ; Copy each original API call's cost snapshot into the fork.
        ; the fork's recomputed cumulative cost matches the source thread even
        ; after a Settings price change.
        costs := TreeRepo._MessageCostSnapshot(msg)

        isLocal := msg.HasProp("is_local_copy") ? Integer(msg.is_local_copy) : 0
        apiOutput := msg.HasOwnProp("api_output_tokens") ? msg.api_output_tokens : (!isLocal && msg.role = "assistant" ? tc : 0)
        ChatDB.db.Query("INSERT INTO messages (id, thread_id, role, content, model, provider, parent_id, sibling_group, sibling_index, reasoning, token_count, prompt_tokens, thinking_tokens, cached_tokens, response_time_ms, ttft_ms, active_path_tokens, is_local_copy, api_output_tokens, input_cost, cached_input_cost, output_cost, total_cost) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);", newId, threadId, msg.role, msg.content, model, provider, parentId ? parentId : SQLite.Null, siblingGroup ? siblingGroup : SQLite.Null, msg.sibling_index, reasoning, tc, spt, tht, ckt, lat, ttft, apt, isLocal, apiOutput, costs.inputCost, costs.cachedInputCost, costs.outputCost, costs.totalCost)
    }

    ; Extract the per-message cost snapshot from a source
    ; row or path object, defaulting missing/empty values to 0 (legacy rows
    ; predating the snapshot columns re-price via _RecomputeCumulativeCounters'
    ; zero-cost fallback).
    static _MessageCostSnapshot(src) {
        inputCost := src.HasProp("input_cost") && src.input_cost != "" ? Number(src.input_cost) : 0
        cachedInputCost := src.HasProp("cached_input_cost") && src.cached_input_cost != "" ? Number(src.cached_input_cost) : 0
        outputCost := src.HasProp("output_cost") && src.output_cost != "" ? Number(src.output_cost) : 0
        totalCost := src.HasProp("total_cost") && src.total_cost != "" ? Number(src.total_cost) : 0
        return { inputCost: inputCost, cachedInputCost: cachedInputCost, outputCost: outputCost, totalCost: totalCost }
    }

    ; Copy siblings that are not on the active path, along with their full
    ; descendant subtrees, so the fork preserves the conversation tree. The
    ; active continuation beyond the fork point remains in the source thread;
    ; off-path children of the fork point itself are copied.
    static _CopyOffPathSiblings(threadId, newThreadId, &idMap, &sgMap, cutoffMsgId := "", activePathNextId := "") {
        ; First pass: direct siblings of messages already copied from the active path.
        for oldSg, newSg in sgMap {
            siblings := ChatDB.db.Query("SELECT * FROM messages WHERE sibling_group=? AND thread_id=? ORDER BY sibling_index;", oldSg, threadId)
            for sibRow in siblings.rows {
                if idMap.Has(sibRow.id)
                    continue  ; already copied from active path
                ; Only copy if parent was also copied (within fork range)
                if sibRow.parent_id && !idMap.Has(sibRow.parent_id)
                    continue
                TreeRepo._InsertCopiedOffPathMessage(sibRow, newThreadId, &idMap, &sgMap)
            }
        }

        ; Second pass: walk descendants of every copied message until
        ; no more can be added, preserving complete off-path subtrees.
        loop {
            copiedAny := false
            all := ChatDB.db.Query("SELECT * FROM messages WHERE thread_id=? ORDER BY sibling_index, rowid;", threadId)
            for row in all.rows {
                if idMap.Has(row.id)
                    continue  ; already copied
                if !row.parent_id || !idMap.Has(row.parent_id)
                    continue  ; parent not in the fork yet (or not forkable)
                if cutoffMsgId && row.parent_id = cutoffMsgId && row.id = activePathNextId
                    continue  ; the ACTIVE path's continuation beyond the fork point
                TreeRepo._InsertCopiedOffPathMessage(row, newThreadId, &idMap, &sgMap)
                copiedAny := true
            }
            if !copiedAny
                break
        }
    }

    ; Insert one off-path message (direct sibling or descendant) into the fork
    ; thread, remapping its parent and sibling group through the fork's idMap/sgMap.
    static _InsertCopiedOffPathMessage(row, newThreadId, &idMap, &sgMap) {
        newId := ChatDB._UUID()
        idMap[row.id] := newId
        mappedParent := row.parent_id && idMap.Has(row.parent_id) ? idMap[row.parent_id] : ""
        newSg := row.sibling_group ? TreeRepo._MapSiblingGroup(row, &sgMap) : ""

        model := row.model ? row.model : ""
        reasoning := row.Has("reasoning") && row.reasoning ? row.reasoning : ""
        sTc := row.token_count ? row.token_count : 0
        sPt := row.Has("prompt_tokens") ? row.prompt_tokens : 0
        sTht := row.thinking_tokens ? row.thinking_tokens : 0
        sCkt := row.cached_tokens ? row.cached_tokens : 0
        sLat := row.response_time_ms ? row.response_time_ms : 0
        sTtft := row.ttft_ms ? row.ttft_ms : 0
        sApt := row.Has("active_path_tokens") && row.active_path_tokens ? Integer(row.active_path_tokens) : 0
        sLocal := row.Has("is_local_copy") ? Integer(row.is_local_copy) : 0
        sApiOutput := row.Has("api_output_tokens") ? Integer(row.api_output_tokens) : (!sLocal && row.role = "assistant" ? sTc : 0)
        ; Copy cost snapshots for off-path fork rows too.
        ; priced at the original call-time prices.
        costs := TreeRepo._MessageCostSnapshot(row)

        ChatDB.db.Query("INSERT INTO messages (id, thread_id, role, content, model, provider, parent_id, sibling_group, sibling_index, reasoning, token_count, prompt_tokens, thinking_tokens, cached_tokens, response_time_ms, ttft_ms, active_path_tokens, is_local_copy, api_output_tokens, input_cost, cached_input_cost, output_cost, total_cost) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);", newId, newThreadId, row.role, row.content, model, row.Has("provider") && row.provider ? row.provider : "", mappedParent ? mappedParent : SQLite.Null, newSg ? newSg : SQLite.Null, row.sibling_index, reasoning, sTc, sPt, sTht, sCkt, sLat, sTtft, sApt, sLocal, sApiOutput, costs.inputCost, costs.cachedInputCost, costs.outputCost, costs.totalCost)
        AttachmentRepo.CopyForMessage(row.id, newId)
    }

    static SetActiveLeaf(threadId, msgId) {
        check := ChatDB.db.Query("SELECT id FROM messages WHERE id=? AND thread_id=?;", msgId, threadId)
        if !check.count
            return
        ChatDB.db.Query("UPDATE chat_threads SET active_leaf_id=?, updated_at=datetime('now') WHERE id=?;", msgId, threadId)
        TreeRepo._RecomputeActivePath(threadId)
        ChatDB._MarkPersistentDataChanged()
    }


    static SwitchBranch(threadId, msgId, direction := 1) {
        ; A branch event can arrive after the user switched threads. The
        ; sibling lookup is keyed by the message's real thread, so verify the
        ; caller's thread before deriving a leaf from that sibling set.
        ownership := ChatDB.db.Query("SELECT id FROM messages WHERE id=? AND thread_id=?;", msgId, threadId)
        if !ownership.count
            return { path: TreeRepo.GetActivePath(threadId), siblingInfo: { index: 1, total: 1 } }
        siblings := TreeRepo.GetSiblings(msgId)
        if siblings.Length < 2
            return { path: TreeRepo.GetActivePath(threadId), siblingInfo: { index: 1, total: 1 } }

        currentPos := 0
        for sib in siblings {
            if sib.id = msgId {
                currentPos := A_Index - 1
                break
            }
        }

        newPos := Mod(currentPos + direction + siblings.Length, siblings.Length)
        newMsgId := siblings[newPos + 1].id

        if newMsgId = msgId
            return { path: TreeRepo.GetActivePath(threadId), siblingInfo: { index: currentPos + 1, total: siblings.Length } }

        newLeafId := TreeRepo._WalkToLeaf(newMsgId, threadId)
        ChatDB.db.Query("UPDATE chat_threads SET active_leaf_id=?, updated_at=datetime('now') WHERE id=?;", newLeafId, threadId)

        path := TreeRepo.GetActivePath(threadId)
        ChatDB._MarkPersistentDataChanged()
        return { path: path, siblingInfo: { index: newPos + 1, total: siblings.Length } }
    }

    ; Returns token/cost stats for the token bar. activePathTokens is read from
    ; the leaf message's active_path_tokens column (O(1) primary key lookup).
    ; The column stores the current-path token estimate. Historical API
    ; prompt/output snapshots are kept separately for accounting.
    static GetThreadStats(threadId) {
        ; Read active_path_tokens from the leaf message (O(1))
        threadRow := ChatDB.db.Query("SELECT active_leaf_id FROM chat_threads WHERE id=?;", threadId)
        activePathTokens := 0
        if threadRow.count && threadRow[1, "active_leaf_id"] {
            leafRow := ChatDB.db.Query("SELECT active_path_tokens FROM messages WHERE id=? AND thread_id=?;", threadRow[1, "active_leaf_id"], threadId)
            if leafRow.count
                activePathTokens := Integer(leafRow[1, "active_path_tokens"])
        }

        threadTable := ChatDB.db.Query("SELECT cumulative_input_tokens, cumulative_output_tokens, cumulative_cached_tokens, cumulative_cost, cumulative_input_cost, cumulative_cached_input_cost, cumulative_output_cost FROM chat_threads WHERE id=?;", threadId)
        ; Determine context window and pricing unit from the SAME model
        ; resolution order: current request model, then thread
        ; model override, then the last assistant message on the active path.
        ; Resolve pricing from the current request/thread context rather than
        ; an unrelated message elsewhere in the thread.
        pricing := TreeRepo._ResolvePricing(threadId)
        contextWin := pricing && pricing.HasOwnProp("context") ? pricing.context : 1048576

        result := {
            activePathTokens: activePathTokens, contextWindow: contextWin,
            cumulativeInputTokens: threadTable.count ? Integer(threadTable[1, "cumulative_input_tokens"]) : 0,
            cumulativeOutputTokens: threadTable.count ? Integer(threadTable[1, "cumulative_output_tokens"]) : 0,
            cumulativeCachedTokens: threadTable.count ? Integer(threadTable[1, "cumulative_cached_tokens"]) : 0,
            cumulativeCost: threadTable.count ? Number(threadTable[1, "cumulative_cost"]) : 0,
            cumulativeInputCost: threadTable.count ? Number(threadTable[1, "cumulative_input_cost"]) : 0,
            cumulativeCachedInputCost: threadTable.count ? Number(threadTable[1, "cumulative_cached_input_cost"]) : 0,
            cumulativeOutputCost: threadTable.count ? Number(threadTable[1, "cumulative_output_cost"]) : 0,
            pricingUnit: { input: 0, cachedInput: 0, output: 0 }
        }

        if pricing {
            result.pricingUnit := {
                input: pricing.HasOwnProp("input") ? pricing.input : 0,
                ; A stored "" means "not set"; fall back to 10% of
                ; the input price.
                cachedInput: pricing.HasOwnProp("cachedInput") && pricing.cachedInput != "" ? pricing.cachedInput : (pricing.HasOwnProp("input") ? pricing.input * 0.1 : 0),
                output: pricing.HasOwnProp("output") ? pricing.output : 0
            }
        }

        return result
    }

    static _LookupPricing(modelName) {
        ; Single lookup accepting full or short model ids.
        return ModelResolver.Lookup(models, modelName)
    }

    ; Resolve the model pricing used for the token bar, in priority order
    ; 1) current request model, 2) thread model_override,
    ; 3) the last assistant message on the active path.
    static _ResolvePricing(threadId) {
        if IsSet(requestParams) && requestParams.Has("singleAPIModelName") && requestParams["singleAPIModelName"] {
            pricing := TreeRepo._LookupPricing(requestParams["singleAPIModelName"])
            if pricing
                return pricing
        }
        threadRow := ChatDB.db.Query("SELECT model_override FROM chat_threads WHERE id=?;", threadId)
        if threadRow.count && threadRow[1, "model_override"] {
            pricing := TreeRepo._LookupPricing(threadRow[1, "model_override"])
            if pricing
                return pricing
        }
        path := TreeRepo.GetActivePath(threadId)
        i := path.Length
        while i >= 1 {
            if path[i].role = "assistant" && path[i].model {
                pricing := TreeRepo._LookupPricing(path[i].model)
                if pricing
                    return pricing
            }
            i--
        }
        return ""
    }

    static _WalkToLeaf(msgId, threadId := "") {
        currentId := msgId
        loop {
            ; Pick the newest continuation; retries and branch
            ; copies get HIGHER sibling_index (original 0, retry 1, ...), so
            ; order by sibling_index DESC (rowid DESC for ties = last-inserted).
            ; This keeps the newest retry or branch continuation at the leaf.
            if threadId
                childTable := ChatDB.db.Query("SELECT id FROM messages WHERE parent_id=? AND thread_id=? ORDER BY sibling_index DESC, rowid DESC LIMIT 1;", currentId, threadId)
            else
                childTable := ChatDB.db.Query("SELECT id FROM messages WHERE parent_id=? ORDER BY sibling_index DESC, rowid DESC LIMIT 1;", currentId)
            if !childTable.count
                break
            currentId := childTable[1, "id"]
        }
        return currentId
    }

    ; Walk the active path and recompute active_path_tokens as the current
    ; context estimate. Historical API prompt_tokens remain untouched, but
    ; cannot override an ancestor edited locally before the next request.
    ; Called after: insert with backfill, hard delete, edit.
    ; Historical API prompt/output/cost fields stay untouched; this field is
    ; deliberately the current editable-path estimate used by the header.
    static _RecomputeActivePath(threadId) {
        path := TreeRepo.GetActivePath(threadId)
        prev := 0
        for msg in path {
            prev += msg.token_count
            ; Thinking tokens occupy the context window too. Do not use a
            ; downstream assistant's stored prompt_tokens here: after an
            ; ancestor edit that value may describe a different request, not
            ; today's active conversation.
            prev += msg.thinking_tokens
            ChatDB.db.Query("UPDATE messages SET active_path_tokens=? WHERE id=?;", prev, msg.id)
        }
    }
}
