; ======================================================
; ChatDB.test.ahk — Unit tests for ChatDB class
;
; Tests: Msg_Insert, Msg_GetActivePath, Msg_HardDelete,
;        Msg_GetThreadStats, Msg_GetSiblings,
;        Msg_SetActiveLeaf, Msg_SwitchBranch, Thread_CRUD
; ======================================================

class ChatDBTest {

    static __New() {
        RegisterTestClass("ChatDBTest")
    }

    ; Each test opens its own temp DB — no shared state
    _openDb() {
        if ChatDB.isOpen {
            oldPath := ChatDB.dbPath
            ChatDB.Close()
            try FileDelete(oldPath)
        }
        ChatDB.Open(A_Temp "\test_chat_" A_TickCount "_" Random(1000, 999999) ".db")
    }

    _closeDb() {
        if ChatDB.isOpen {
            dbPath := ChatDB.dbPath
            ChatDB.Close()
            try FileDelete(dbPath)
        }
    }

    _setup() {
        this._openDb()
        return ChatDB.Thread_Create("Test Thread")
    }

    _teardown() {
        this._closeDb()
    }

    ; ----------------------------------------------------
    ; Fresh canonical schema + foreign keys
    ; ----------------------------------------------------

    Schema_IsCanonical() {
        this._setup()
        version := ChatDB.db.Exec("PRAGMA user_version;")[1, "user_version"]
        if Integer(version) != 0
            throw Error("fresh schema must not use migration user_version, got " version)
        cols := [
            { t: "chat_threads", c: "font_size" },
            { t: "chat_threads", c: "advanced_toggles" },
            { t: "chat_threads", c: "folder_id" },
            { t: "chat_threads", c: "is_locked" },
            { t: "messages", c: "provider" },
            { t: "messages", c: "prompt_tokens" },
            { t: "messages", c: "is_local_copy" },
            { t: "messages", c: "input_cost" },
            { t: "messages", c: "cached_input_cost" },
            { t: "messages", c: "output_cost" },
            { t: "messages", c: "total_cost" },
            { t: "messages", c: "api_output_tokens" },
            { t: "chat_usage", c: "ttft_count" },
            { t: "command_usage", c: "ttft_count" }
        ]
        for item in cols {
            found := false
            for row in ChatDB.db.Exec("PRAGMA table_info(" item.t ");").rows {
                if row.name = item.c
                    found := true
            }
            if !found
                throw Error("column " item.t "." item.c " missing after schema creation")
        }
        if !ChatDB.db.Exec("SELECT name FROM sqlite_master WHERE type='table' AND name='chat_locks';").count
            throw Error("chat_locks table missing after schema creation")
        if ChatDB.db.Exec("SELECT name FROM sqlite_master WHERE type='table' AND name='assistants';").count
            throw Error("dead assistants table must not be created")
        if ChatDB.db.Exec("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_chat_locks_thread';").count
            throw Error("redundant chat-lock primary-key index must not be created")
        vacuum := ChatDB.db.Exec("PRAGMA auto_vacuum;")
        if !vacuum.count || Integer(vacuum[1, "auto_vacuum"]) != 2
            throw Error("fresh schema must use incremental auto_vacuum")
        this._teardown()
    }

    ForeignKeys_OnDeleteSetNull() {
        threadId := this._setup()
        ChatDB.db.Query("INSERT INTO chat_folders (id, name) VALUES(?, ?);", "f-fk", "Folder")
        ChatDB.db.Query("UPDATE chat_threads SET folder_id=? WHERE id=?;", "f-fk", threadId)
        ChatDB.db.Query("DELETE FROM chat_folders WHERE id=?;", "f-fk")
        row := ChatDB.db.Query("SELECT folder_id FROM chat_threads WHERE id=?;", threadId)
        if row.rows[1].folder_id != ""
            throw Error("PRAGMA foreign_keys=ON should SET NULL on folder delete, got '" row.rows[1].folder_id "'")
        this._teardown()
    }

    ; --------------------
    ; Msg_Insert
    ; --------------------

    Insert_SystemMessage() {
        threadId := this._setup()
        id := ChatDB.Msg_Insert({thread_id: threadId, role: "system", content: "You are a helpful assistant."})
        if !id
            throw Error("Expected non-empty id")
        path := ChatDB.Msg_GetActivePath(threadId)
        if path.Length != 1
            throw Error("Expected 1 message, got " path.Length)
        if path[1].role != "system"
            throw Error("Expected role 'system', got '" path[1].role "'")
        this._teardown()
    }

    Insert_UserMessage() {
        threadId := this._setup()
        sysId := ChatDB.Msg_Insert({thread_id: threadId, role: "system", content: "system"})
        id := ChatDB.Msg_Insert({thread_id: threadId, role: "user", content: "Hello", parent_id: sysId})
        if !id
            throw Error("Expected non-empty id")
        path := ChatDB.Msg_GetActivePath(threadId)
        if path.Length != 2
            throw Error("Expected 2 messages, got " path.Length)
        if path[2].role != "user"
            throw Error("Expected role 'user', got '" path[2].role "'")
        this._teardown()
    }

    Insert_WithTokenCounts() {
        threadId := this._setup()
        ChatDB.Msg_Insert({thread_id: threadId, role: "system", content: "system"})
        ChatDB.Msg_Insert({thread_id: threadId, role: "user", content: "Hello"})
        id := ChatDB.Msg_Insert({thread_id: threadId, role: "assistant", content: "Hi there!", model: "deepseek-v4-flash", token_count: 15, cached_tokens: 0})
        path := ChatDB.Msg_GetActivePath(threadId)
        if path[path.Length].token_count != 15
            throw Error("Expected token_count=15, got " path[path.Length].token_count)
        if path[path.Length].cached_tokens != 0
            throw Error("Expected cached_tokens=0, got " path[path.Length].cached_tokens)
        this._teardown()
    }

    ; Regression (bug #118): a local branch-edit copy (local_copy) must NOT
    ; upsert chat_usage (no API call happened) and must not re-charge the
    ; thread's cumulative counters.
    Insert_LocalCopy_DoesNotRecordUsage() {
        threadId := this._setup()
        u1Id := ChatDB.Msg_Insert({thread_id: threadId, role: "user", content: "original question", token_count: 12})
        ChatDB.Msg_Insert({thread_id: threadId, role: "assistant", content: "original answer", parent_id: u1Id, model: "deepseek/deepseek-v4-flash", token_count: 9})
        before := ChatDB.db.Exec("SELECT cumulative_input_tokens, cumulative_output_tokens FROM chat_threads WHERE id='" threadId "';")
        ChatDB.Msg_Insert({thread_id: threadId, role: "assistant", content: "edited answer branch", parent_id: u1Id, model: "deepseek/deepseek-v4-flash", sibling_group: "sg-118", sibling_index: 1, local_copy: true})
        usage := ChatDB.db.Exec("SELECT COUNT(*) AS c, COALESCE(SUM(call_count),0) AS calls FROM chat_usage;")
        if Integer(usage[1, "c"]) != 1 || Integer(usage[1, "calls"]) != 1
            throw Error("local copy must not add a chat_usage row (bug #118): rows=" usage[1, "c"] " calls=" usage[1, "calls"] " (expected exactly the real assistant's 1)")
        after := ChatDB.db.Exec("SELECT cumulative_input_tokens, cumulative_output_tokens FROM chat_threads WHERE id='" threadId "';")
        if Integer(after[1, "cumulative_input_tokens"]) != Integer(before[1, "cumulative_input_tokens"]) || Integer(after[1, "cumulative_output_tokens"]) != Integer(before[1, "cumulative_output_tokens"])
            throw Error("local copy must not re-charge cumulative counters: before in=" before[1, "cumulative_input_tokens"] " out=" before[1, "cumulative_output_tokens"] " after in=" after[1, "cumulative_input_tokens"] " out=" after[1, "cumulative_output_tokens"])
        this._teardown()
    }

    ; Regression (bug #123): a local branch-edit copy must carry the source
    ; message's token metadata (token_count/prompt_tokens/thinking/cached/
    ; active_path_tokens) so the header Context Used and the token popover stay
    ; faithful - while still not re-charging the counters (bug #118).
    Insert_LocalCopy_KeepsTokenMetadata() {
        threadId := this._setup()
        u1Id := ChatDB.Msg_Insert({thread_id: threadId, role: "user", content: "original question", token_count: 12})
        ChatDB.Msg_Insert({thread_id: threadId, role: "assistant", content: "original answer", parent_id: u1Id, model: "deepseek/deepseek-v4-flash", token_count: 9, prompt_tokens: 12, thinking_tokens: 0, cached_tokens: 4, active_path_tokens: 21})
        before := ChatDB.db.Exec("SELECT cumulative_input_tokens, cumulative_output_tokens, cumulative_cached_tokens FROM chat_threads WHERE id='" threadId "';")
        copyId := ChatDB.Msg_Insert({thread_id: threadId, role: "assistant", content: "edited answer branch", parent_id: u1Id, model: "deepseek/deepseek-v4-flash", sibling_group: "sg-123", sibling_index: 1, token_count: 9, prompt_tokens: 12, thinking_tokens: 0, cached_tokens: 4, active_path_tokens: 21, local_copy: true})
        row := ChatDB.db.Exec("SELECT token_count, prompt_tokens, thinking_tokens, cached_tokens, active_path_tokens FROM messages WHERE id='" copyId "';")
        if Integer(row[1, "token_count"]) != 9 || Integer(row[1, "prompt_tokens"]) != 12 || Integer(row[1, "thinking_tokens"]) != 0 || Integer(row[1, "cached_tokens"]) != 4 || Integer(row[1, "active_path_tokens"]) != 21
            throw Error("local copy must keep the source token metadata (bug #123): tc=" row[1, "token_count"] " pt=" row[1, "prompt_tokens"] " tht=" row[1, "thinking_tokens"] " ckt=" row[1, "cached_tokens"] " apt=" row[1, "active_path_tokens"])
        after := ChatDB.db.Exec("SELECT cumulative_input_tokens, cumulative_output_tokens, cumulative_cached_tokens FROM chat_threads WHERE id='" threadId "';")
        if Integer(after[1, "cumulative_input_tokens"]) != Integer(before[1, "cumulative_input_tokens"]) || Integer(after[1, "cumulative_output_tokens"]) != Integer(before[1, "cumulative_output_tokens"]) || Integer(after[1, "cumulative_cached_tokens"]) != Integer(before[1, "cumulative_cached_tokens"])
            throw Error("metadata copy must not re-charge counters: before in=" before[1, "cumulative_input_tokens"] " out=" before[1, "cumulative_output_tokens"] " ckt=" before[1, "cumulative_cached_tokens"] " after in=" after[1, "cumulative_input_tokens"] " out=" after[1, "cumulative_output_tokens"] " ckt=" after[1, "cumulative_cached_tokens"])
        this._teardown()
    }

    ; Regression (bug #144): a local branch-edit copy carries the source's
    ; COPIED token metadata, so a later REAL exchange's cumulative recompute
    ; must exclude local copies - otherwise the copied prompt/output/cached
    ; tokens are charged a second time and the header disagrees with the
    ; dashboard. Real calls: a1 (12/9/4) + a2 (24/5+2/1) => 36/16/5; the
    ; local copy (12/9/4) must NOT be added on top.
    Insert_LocalCopy_ExcludedFromCumulativeRecompute() {
        threadId := this._setup()
        u1Id := ChatDB.Msg_Insert({thread_id: threadId, role: "user", content: "u1"})
        ChatDB.Msg_Insert({thread_id: threadId, role: "assistant", content: "a1", parent_id: u1Id, model: "deepseek/deepseek-v4-flash", token_count: 9, prompt_tokens: 12, cached_tokens: 4})
        ChatDB.Msg_Insert({thread_id: threadId, role: "assistant", content: "a1 edited branch", parent_id: u1Id, model: "deepseek/deepseek-v4-flash", sibling_group: "sg-144", sibling_index: 1, token_count: 9, prompt_tokens: 12, cached_tokens: 4, active_path_tokens: 21, local_copy: true})
        copyRow := ChatDB.db.Query("SELECT is_local_copy FROM messages WHERE content='a1 edited branch';")
        if Integer(copyRow[1, "is_local_copy"]) != 1
            throw Error("local_copy flag must be persisted on the message row")
        u2Id := ChatDB.Msg_Insert({thread_id: threadId, role: "user", content: "u2", parent_id: ChatDB.db.Query("SELECT id FROM messages WHERE content='a1 edited branch';").rows[1].id})
        ChatDB.Msg_Insert({thread_id: threadId, role: "assistant", content: "a2", parent_id: u2Id, model: "deepseek/deepseek-v4-flash", token_count: 5, prompt_tokens: 24, thinking_tokens: 2, cached_tokens: 1})
        row := ChatDB.db.Query("SELECT cumulative_input_tokens, cumulative_output_tokens, cumulative_cached_tokens FROM chat_threads WHERE id=?;", threadId)
        ; Ground truth (real API calls only): input = 12 + 24 = 36;
        ; output = 9 + (5 + 2) = 16; cached = 4 + 1 = 5.
        if Integer(row[1, "cumulative_input_tokens"]) != 36
            throw Error("cumulative input must exclude the local copy: expected 36, got " row[1, "cumulative_input_tokens"])
        if Integer(row[1, "cumulative_output_tokens"]) != 16
            throw Error("cumulative output must exclude the local copy: expected 16, got " row[1, "cumulative_output_tokens"])
        if Integer(row[1, "cumulative_cached_tokens"]) != 5
            throw Error("cumulative cached must exclude the local copy: expected 5, got " row[1, "cumulative_cached_tokens"])
        this._teardown()
    }

    ; Hardening item 3: the thread's cumulative counters are DERIVED from the
    ; messages in one place (_RecomputeCumulativeCounters) - after every insert
    ; the ledger equals the per-message API ground truth (sum of assistant
    ; prompt_tokens / token_count+thinking / cached), never an incremental
    ; accumulation that can drift.
    Insert_DerivesCumulativeCountersFromMessages() {
        threadId := this._setup()
        u1Id := ChatDB.Msg_Insert({thread_id: threadId, role: "user", content: "q1", token_count: 12})
        ChatDB.Msg_Insert({thread_id: threadId, role: "assistant", content: "a1", parent_id: u1Id, model: "deepseek/deepseek-v4-flash", token_count: 9, prompt_tokens: 12, cached_tokens: 4, thinking_tokens: 0})
        u2Id := ChatDB.Msg_Insert({thread_id: threadId, role: "user", content: "q2", parent_id: ChatDB.db.Query("SELECT id FROM messages WHERE content='a1';").rows[1].id})
        ChatDB.Msg_Insert({thread_id: threadId, role: "assistant", content: "a2", parent_id: u2Id, model: "deepseek/deepseek-v4-flash", token_count: 5, prompt_tokens: 24, thinking_tokens: 2, cached_tokens: 1})
        row := ChatDB.db.Query("SELECT cumulative_input_tokens, cumulative_output_tokens, cumulative_cached_tokens FROM chat_threads WHERE id=?;", threadId)
        ; Ground truth: input = 12 + 24 = 36; output = 9 + (5 + 2) = 16; cached = 4 + 1 = 5.
        if Integer(row[1, "cumulative_input_tokens"]) != 36
            throw Error("cumulative input should equal SUM(assistant prompt_tokens)=36, got " row[1, "cumulative_input_tokens"])
        if Integer(row[1, "cumulative_output_tokens"]) != 16
            throw Error("cumulative output should equal SUM(assistant token_count+thinking)=16, got " row[1, "cumulative_output_tokens"])
        if Integer(row[1, "cumulative_cached_tokens"]) != 5
            throw Error("cumulative cached should equal SUM(assistant cached)=5, got " row[1, "cumulative_cached_tokens"])
        this._teardown()
    }

    ; Regression (bug #145): user token backfill must subtract the prior
    ; assistant's THINKING tokens too - token_count holds only VISIBLE output
    ; (thinking is stored separately), so summing token_count alone leaks the
    ; thinking tokens into the next user's backfilled contribution.
    Insert_BackfillSubtractsAssistantThinking() {
        threadId := this._setup()
        u1Id := ChatDB.Msg_Insert({thread_id: threadId, role: "user", content: "u1"})
        ChatDB.Msg_Insert({thread_id: threadId, role: "assistant", content: "a1", parent_id: u1Id, model: "deepseek/deepseek-v4-flash", prompt_tokens: 12, token_count: 9, thinking_tokens: 5})
        u2Id := ChatDB.Msg_Insert({thread_id: threadId, role: "user", content: "u2", parent_id: ChatDB.db.Query("SELECT id FROM messages WHERE content='a1';").rows[1].id})
        ChatDB.Msg_Insert({thread_id: threadId, role: "assistant", content: "a2", parent_id: u2Id, model: "deepseek/deepseek-v4-flash", prompt_tokens: 30, token_count: 6})
        u2tc := Integer(ChatDB.db.Query("SELECT token_count FROM messages WHERE id=?;", u2Id)[1, "token_count"])
        ; True contribution = 30 prompt - 12 u1 - 9 a1 visible - 5 a1 thinking = 4.
        if u2tc != 4
            throw Error("u2 contribution should be 4 (thinking subtracted), got " u2tc)
        this._teardown()
    }

    ; Regression (bug #150): a local branch-edit copy of a USER message carries
    ; the SOURCE message's backfilled token_count (bug #123). When the branch's
    ; own real API response arrives, the copy must be RE-backfilled with its
    ; real contribution - the copied (stale) attribution is replaced.
    Insert_Backfill_ReplacesLocalCopyAttribution() {
        threadId := this._setup()
        u1Id := ChatDB.Msg_Insert({thread_id: threadId, role: "user", content: "u1"})
        a1Id := ChatDB.Msg_Insert({thread_id: threadId, role: "assistant", content: "a1", parent_id: u1Id, model: "deepseek/deepseek-v4-flash", prompt_tokens: 12, token_count: 9})
        u2Id := ChatDB.Msg_Insert({thread_id: threadId, role: "user", content: "original follow-up", parent_id: a1Id})
        ChatDB.Msg_Insert({thread_id: threadId, role: "assistant", content: "a2", parent_id: u2Id, model: "deepseek/deepseek-v4-flash", prompt_tokens: 28, token_count: 6})
        u2tc := Integer(ChatDB.db.Query("SELECT token_count FROM messages WHERE id=?;", u2Id)[1, "token_count"])
        if u2tc != 7
            throw Error("setup: u2 should be backfilled to 7 (28-21), got " u2tc)

        ; Branch-edit copy of u2 with DIFFERENT content (local_copy carries tc 7):
        u2bId := ChatDB.Msg_Insert({
            thread_id: threadId, role: "user", content: "edited follow-up (branch)",
            parent_id: a1Id, sibling_group: "sg-150", sibling_index: 1,
            token_count: u2tc, active_path_tokens: 21 + u2tc, local_copy: true
        })
        ; The branch fires a REAL request whose prompt is 12 (mock):
        ChatDB.Msg_Insert({thread_id: threadId, role: "assistant", content: "a2b", parent_id: u2bId, model: "deepseek/deepseek-v4-flash", prompt_tokens: 12, token_count: 5})
        u2btc := Integer(ChatDB.db.Query("SELECT token_count FROM messages WHERE id=?;", u2bId)[1, "token_count"])
        ; True contribution = Max(0, 12 - (12 u1 + 9 a1 + 7 copied)) = 0.
        if u2btc != 0
            throw Error("branch copy must be re-backfilled to 0 (12 - 28), got " u2btc)
        this._teardown()
    }

    ; Regression (bug #153): each assistant message snapshots its costs at the
    ; prices in effect when the API call was made; _RecomputeCumulativeCounters
    ; sums those snapshots, so a later price change in Settings never re-prices
    ; historical calls (header stays equal to the dashboard).
    Insert_SnapshotsCosts_PriceChangesDoNotRePriceHistory() {
        global models
        threadId := this._setup()
        oldModels := models
        try {
            models := Map("deepseek/deepseek-v4-flash", { provider: "deepseek", input: 1400, cachedInput: 28, output: 2800, context: 1000000 })
            u1Id := ChatDB.Msg_Insert({thread_id: threadId, role: "user", content: "u1"})
            a1Id := ChatDB.Msg_Insert({thread_id: threadId, role: "assistant", content: "a1", parent_id: u1Id, model: "deepseek/deepseek-v4-flash", prompt_tokens: 12, token_count: 9, cached_tokens: 4})
            ; a1's snapshot at the original prices: (12-4)*1400 + 4*28 + 9*2800 = 0.036512
            a1Row := ChatDB.db.Query("SELECT input_cost, cached_input_cost, output_cost, total_cost FROM messages WHERE id=?;", a1Id)
            if Abs(Number(a1Row[1, "total_cost"]) - 0.036512) > 0.000001
                throw Error("a1 should snapshot total_cost=0.036512, got " a1Row[1, "total_cost"])

            ; Double the prices (simulates a Settings change):
            models := Map("deepseek/deepseek-v4-flash", { provider: "deepseek", input: 2800, cachedInput: 56, output: 5600, context: 1000000 })
            u2Id := ChatDB.Msg_Insert({thread_id: threadId, role: "user", content: "u2", parent_id: a1Id})
            ChatDB.Msg_Insert({thread_id: threadId, role: "assistant", content: "a2", parent_id: u2Id, model: "deepseek/deepseek-v4-flash", prompt_tokens: 12, token_count: 9, cached_tokens: 4})
            ; a2 snapshots the doubled price (0.073024); the recompute must sum
            ; the snapshots (0.036512 + 0.073024 = 0.109536), NOT re-price a1.
            threadRow := ChatDB.db.Query("SELECT cumulative_cost FROM chat_threads WHERE id=?;", threadId)
            if Abs(Number(threadRow[1, "cumulative_cost"]) - 0.109536) > 0.000001
                throw Error("cumulative cost must keep a1's original snapshot: expected 0.109536, got " threadRow[1, "cumulative_cost"])
        } finally {
            models := oldModels
            this._teardown()
        }
    }

    ; --------------------
    ; Msg_GetActivePath
    ; --------------------

    GetActivePath_EmptyThread() {
        threadId := this._setup()
        path := ChatDB.Msg_GetActivePath(threadId)
        if path.Length != 0
            throw Error("Expected empty path for new thread, got " path.Length)
        this._teardown()
    }

    GetActivePath_MultiMessage() {
        threadId := this._setup()
        sysId := ChatDB.Msg_Insert({thread_id: threadId, role: "system", content: "s"})
        usrId := ChatDB.Msg_Insert({thread_id: threadId, role: "user", content: "u", parent_id: sysId})
        ChatDB.Msg_Insert({thread_id: threadId, role: "assistant", content: "a", parent_id: usrId})
        path := ChatDB.Msg_GetActivePath(threadId)
        if path.Length != 3
            throw Error("Expected 3 messages, got " path.Length)
        roles := ["system", "user", "assistant"]
        for i, msg in path {
            if msg.role != roles[i]
                throw Error("Message " i " expected role '" roles[i] "', got '" msg.role "'")
        }
        this._teardown()
    }

    ; Regression: assistant usage must attribute the prompt contribution to
    ; the request's captured branch, even after the visible leaf switches to a
    ; sibling before persistence.
    Insert_AssistantBackfillUsesExplicitBranchPath() {
        threadId := this._setup()
        rootUserId := ChatDB.Msg_Insert({thread_id: threadId, role: "user", content: "root", token_count: 5, active_path_tokens: 5})
        a1Id := ChatDB.Msg_Insert({thread_id: threadId, role: "assistant", content: "A1", model: "deepseek-v4-flash", parent_id: rootUserId, sibling_group: "sg-path", sibling_index: 0, token_count: 5, prompt_tokens: 10})
        a2Id := ChatDB.Msg_Insert({thread_id: threadId, role: "assistant", content: "A2", model: "deepseek-v4-flash", parent_id: rootUserId, sibling_group: "sg-path", sibling_index: 1, token_count: 5, prompt_tokens: 10})
        a1UserId := ChatDB.Msg_Insert({thread_id: threadId, role: "user", content: "A1 follow-up", parent_id: a1Id, token_count: 0})
        a1LeafId := ChatDB.Msg_Insert({thread_id: threadId, role: "assistant", content: "A1 leaf", model: "deepseek-v4-flash", parent_id: a1UserId, token_count: 2, active_path_tokens: 22})
        a2UserId := ChatDB.Msg_Insert({thread_id: threadId, role: "user", content: "A2 follow-up", parent_id: a2Id, token_count: 0})
        a2LeafId := ChatDB.Msg_Insert({thread_id: threadId, role: "assistant", content: "A2 leaf", model: "deepseek-v4-flash", parent_id: a2UserId, token_count: 6, active_path_tokens: 26})

        requestPath := ChatDB.Msg_GetPathToLeaf(threadId, a1LeafId)
        ChatDB.Msg_Insert({
            thread_id: threadId, role: "assistant", content: "A1 response after branch switch",
            model: "deepseek-v4-flash", parent_id: a1LeafId,
            token_count: 10, prompt_tokens: 16,
            token_attribution_path: requestPath,
            update_active_leaf: false
        })

        a1User := ChatDB.db.Query("SELECT token_count, active_path_tokens FROM messages WHERE id=?;", a1UserId)
        a2User := ChatDB.db.Query("SELECT token_count, active_path_tokens FROM messages WHERE id=?;", a2UserId)
        activeLeaf := ChatDB.db.Query("SELECT active_leaf_id FROM chat_threads WHERE id=?;", threadId)
        a1Response := ChatDB.db.Query("SELECT parent_id, active_path_tokens FROM messages WHERE thread_id=? AND content=?;", threadId, "A1 response after branch switch")
        if Integer(a1User[1, "token_count"]) != 4 || Integer(a1User[1, "active_path_tokens"]) != 19
            throw Error("explicit request path must backfill A1: tc=" a1User[1, "token_count"] " apt=" a1User[1, "active_path_tokens"])
        if Integer(a2User[1, "token_count"]) != 0 || Integer(a2User[1, "active_path_tokens"]) != 15
            throw Error("sibling A2 attribution changed: tc=" a2User[1, "token_count"] " apt=" a2User[1, "active_path_tokens"])
        if activeLeaf[1, "active_leaf_id"] != a2LeafId
            throw Error("visible active leaf changed during off-path persistence")
        if a1Response[1, "parent_id"] != a1LeafId || Integer(a1Response[1, "active_path_tokens"]) != 26
            throw Error("assistant was not persisted on A1 with correct path tokens")
        this._teardown()
    }

    GetPathToExplicitLeaf_StaysOnRequestedBranch() {
        threadId := this._setup()
        rootId := ChatDB.Msg_Insert({thread_id: threadId, role: "user", content: "root"})
        a1Id := ChatDB.Msg_Insert({thread_id: threadId, role: "assistant", content: "A1", parent_id: rootId, sibling_group: "sg", sibling_index: 0})
        a2Id := ChatDB.Msg_Insert({thread_id: threadId, role: "assistant", content: "A2", parent_id: rootId, sibling_group: "sg", sibling_index: 1})
        path := ChatDB.Msg_GetPathToLeaf(threadId, a1Id)
        if path.Length != 2 || path[2].id != a1Id
            throw Error("explicit leaf path did not stay on A1: " jsongo.Stringify(path))
        active := ChatDB.Msg_GetActivePath(threadId)
        if active.Length != 2 || active[2].id != a2Id
            throw Error("explicit path lookup changed the active A2 branch")
        this._teardown()
    }

    Insert_CanPreserveVisibleLeafForOffPathContinuation() {
        threadId := this._setup()
        rootId := ChatDB.Msg_Insert({thread_id: threadId, role: "user", content: "root"})
        a1Id := ChatDB.Msg_Insert({thread_id: threadId, role: "assistant", content: "A1", parent_id: rootId, sibling_group: "sg", sibling_index: 0})
        a2Id := ChatDB.Msg_Insert({thread_id: threadId, role: "assistant", content: "A2", parent_id: rootId, sibling_group: "sg", sibling_index: 1})
        ChatDB.Msg_Insert({thread_id: threadId, role: "assistant", content: "off-path answer", parent_id: a1Id, update_active_leaf: false})
        row := ChatDB.db.Query("SELECT active_leaf_id FROM chat_threads WHERE id=?;", threadId)
        if !row.count || row[1, "active_leaf_id"] != a2Id
            throw Error("off-path insert changed the visible active leaf")
        this._teardown()
    }

    HardDelete_MiddleMessage_ReparentsChildren() {
        threadId := this._setup()
        u1Id := ChatDB.Msg_Insert({thread_id: threadId, role: "user", content: "u1"})
        a1Id := ChatDB.Msg_Insert({thread_id: threadId, role: "assistant", content: "a1", parent_id: u1Id})
        u2Id := ChatDB.Msg_Insert({thread_id: threadId, role: "user", content: "u2", parent_id: a1Id})
        a2Id := ChatDB.Msg_Insert({thread_id: threadId, role: "assistant", content: "a2", parent_id: u2Id})
        path := ChatDB.Msg_GetActivePath(threadId)
        if path.Length != 4
            throw Error("Expected 4 before delete, got " path.Length)

        ; Delete middle message (a1Id) — children should be re-parented to u1Id
        ChatDB.Msg_HardDelete(a1Id)
        path := ChatDB.Msg_GetActivePath(threadId)
        if path.Length != 3
            throw Error("Expected 3 after re-parent, got " path.Length)
        ; Verify u2 now has parent u1 (not a1 which is deleted)
        checkParent := ChatDB.db.Exec("SELECT parent_id FROM messages WHERE id='" u2Id "';")
        if checkParent.count && checkParent[1, "parent_id"] != u1Id
            throw Error("u2 should be re-parented to u1Id, got " checkParent[1, "parent_id"])
        this._teardown()
    }

    HardDelete_RootMessage_ReparentsToNull() {
        threadId := this._setup()
        rootId := ChatDB.Msg_Insert({thread_id: threadId, role: "system", content: "sys"})
        u1Id := ChatDB.Msg_Insert({thread_id: threadId, role: "user", content: "u1", parent_id: rootId})
        ; Delete root — children should get parent_id=NULL
        ChatDB.Msg_HardDelete(rootId)
        path := ChatDB.Msg_GetActivePath(threadId)
        if path.Length < 1
            throw Error("Expected path with user message after root delete, got " path.Length)
        ; Verify u1 has NULL parent_id
        check := ChatDB.db.Exec("SELECT parent_id FROM messages WHERE id='" u1Id "';")
        if check.count && check[1, "parent_id"] != ""
            throw Error("Child should have NULL parent after root delete")
        this._teardown()
    }

    ; --------------------
    ; Msg_GetThreadStats
    ; --------------------

    GetThreadStats_Empty() {
        threadId := this._setup()
        stats := ChatDB.Msg_GetThreadStats(threadId)
        if stats.activePathTokens != 0
            throw Error("Expected 0 activePathTokens, got " stats.activePathTokens)
        if stats.cumulativeInputTokens != 0
            throw Error("Expected 0 cumulativeInputTokens, got " stats.cumulativeInputTokens)
        if stats.cumulativeOutputTokens != 0
            throw Error("Expected 0 cumulativeOutputTokens, got " stats.cumulativeOutputTokens)
        this._teardown()
    }

    GetThreadStats_WithApiTokens() {
        threadId := this._setup()
        ChatDB.Msg_Insert({thread_id: threadId, role: "system", content: "system"})
        ChatDB.Msg_Insert({thread_id: threadId, role: "user", content: "user message"})
        ChatDB.Msg_Insert({thread_id: threadId, role: "assistant", content: "response", model: "deepseek-v4-flash", token_count: 20})
        stats := ChatDB.Msg_GetThreadStats(threadId)
        if stats.activePathTokens <= 0
            throw Error("Expected activePathTokens > 0, got " stats.activePathTokens)
        if stats.cumulativeOutputTokens <= 0
            throw Error("Expected cumulativeOutputTokens > 0, got " stats.cumulativeOutputTokens)
        this._teardown()
    }

    ; --------------------
    ; Msg_GetSiblings
    ; --------------------

    GetSiblings_NoSiblings() {
        threadId := this._setup()
        id := ChatDB.Msg_Insert({thread_id: threadId, role: "user", content: "u1"})
        sibs := ChatDB.Msg_GetSiblings(id)
        if sibs.Length != 0
            throw Error("Expected 0 siblings for single message, got " sibs.Length)
        this._teardown()
    }

    GetSiblings_WithBranch() {
        threadId := this._setup()
        id1 := ChatDB.Msg_Insert({thread_id: threadId, role: "user", content: "u1"})
        ChatDB.Msg_Insert({thread_id: threadId, role: "assistant", content: "a1", parent_id: id1})
        sg := "test-group"
        id3 := ChatDB.Msg_Insert({thread_id: threadId, role: "assistant", content: "a2", parent_id: id1, sibling_group: sg, sibling_index: 1})
        sibs := ChatDB.Msg_GetSiblings(id3)
        if sibs.Length < 1
            throw Error("Expected at least 1 sibling, got " sibs.Length)
        this._teardown()
    }

    ; --------------------
    ; Thread CRUD
    ; --------------------

    Thread_CreateAndList() {
        this._setup()
        id1 := ChatDB.Thread_Create("Chat 1")
        id2 := ChatDB.Thread_Create("Chat 2")
        threads := ChatDB.Thread_List()
        found := 0
        for t in threads {
            if t.id = id1 || t.id = id2
                found++
        }
        if found != 2
            throw Error("Expected 2 threads in list, found " found)
        ChatDB.Thread_Delete(id1)
        ChatDB.Thread_Delete(id2)
        this._teardown()
    }

    Thread_Delete_Cascades() {
        threadId := this._setup()
        ChatDB.Msg_Insert({thread_id: threadId, role: "user", content: "u1"})
        ChatDB.Msg_Insert({thread_id: threadId, role: "assistant", content: "a1"})
        ChatDB.Thread_Delete(threadId)
        path := ChatDB.Msg_GetActivePath(threadId)
        if path.Length != 0
            throw Error("Expected empty path after thread delete, got " path.Length)
        this._teardown()
    }

    ; Regression (bug #116): ThreadRepo.Delete must pass the RAW thread id to
    ; AttachmentRepo.DeleteByThread (which escapes it internally) - passing the
    ; already-escaped safeId double-escaped it ('x'' became 'x''''), so crafted-id
    ; threads deleted their messages but orphaned their attachment rows.
    Thread_Delete_CraftedId_CleansAttachments() {
        this._setup()
        crafted := "x'"
        ChatDB.db.Exec("INSERT INTO chat_threads (id, title) VALUES('x''', 'Crafted');")
        ChatDB.db.Exec("INSERT INTO messages (id, thread_id, role, content) VALUES('m1', 'x''', 'user', 'hi');")
        ChatDB.Attachment_Insert("m1", {
            attachment_type: "text_file",
            file_path: "attachments/x.txt",
            mime_type: "text/plain",
            original_filename: "x.txt",
            file_size: 1,
            extracted_text: ""
        })
        ChatDB.Thread_Delete(crafted)
        msgCount := ChatDB.db.Exec("SELECT COUNT(*) AS c FROM messages WHERE thread_id='x''';")
        attCount := ChatDB.db.Exec("SELECT COUNT(*) AS c FROM message_attachments WHERE message_id='m1';")
        thrCount := ChatDB.db.Exec("SELECT COUNT(*) AS c FROM chat_threads WHERE id='x''';")
        if Integer(msgCount[1, "c"]) != 0
            throw Error("crafted thread's messages should be deleted, got " msgCount[1, "c"])
        if Integer(attCount[1, "c"]) != 0
            throw Error("crafted thread's attachment rows should be deleted, got " attCount[1, "c"])
        if Integer(thrCount[1, "c"]) != 0
            throw Error("crafted thread should be deleted, got " thrCount[1, "c"])
        this._teardown()
    }

    ; Regression (bug #129): thread-level delete must remove messages_fts rows
    ; like MessageRepo.HardDelete does - the old raw DELETEs left stale index
    ; rows until the next startup rebuild.
    Thread_Delete_RemovesFtsRows() {
        threadId := this._setup()
        ChatDB.Msg_Insert({thread_id: threadId, role: "user", content: "first"})
        ChatDB.Msg_Insert({thread_id: threadId, role: "assistant", content: "reply"})
        ChatDB.Thread_Delete(threadId)
        fts := ChatDB.db.Exec("SELECT COUNT(*) AS c FROM messages_fts;")
        if Integer(fts[1, "c"]) != 0
            throw Error("thread delete must remove FTS rows (bug #129), got " fts[1, "c"])
        this._teardown()
    }

    ; --------------------
    ; Msg_SetActiveLeaf
    ; --------------------

    SetActiveLeaf_ChangesPath() {
        threadId := this._setup()
        u1Id := ChatDB.Msg_Insert({thread_id: threadId, role: "user", content: "u1"})
        a1Id := ChatDB.Msg_Insert({thread_id: threadId, role: "assistant", content: "a1", parent_id: u1Id})
        ChatDB.Msg_Insert({thread_id: threadId, role: "user", content: "u2", parent_id: a1Id})
        ChatDB.Msg_SetActiveLeaf(threadId, a1Id)
        path := ChatDB.Msg_GetActivePath(threadId)
        if path.Length != 2
            throw Error("Expected path length 2 after SetActiveLeaf, got " path.Length)
        if path[path.Length].id != a1Id
            throw Error("Expected last message id to be " a1Id ", got " path[path.Length].id)
        this._teardown()
    }

    ; --------------------
    GetSiblings_FiltersMalformedCrossParentGroup() {
        threadId := this._setup()
        u1 := ChatDB.Msg_Insert({thread_id: threadId, role: "user", content: "root"})
        a1 := ChatDB.Msg_Insert({
            thread_id: threadId, role: "assistant", content: "first answer",
            parent_id: u1, sibling_group: "malformed-group", sibling_index: 0
        })
        u2 := ChatDB.Msg_Insert({thread_id: threadId, role: "user", content: "follow-up", parent_id: a1})
        a2 := ChatDB.Msg_Insert({
            thread_id: threadId, role: "assistant", content: "second unrelated answer",
            parent_id: u2, sibling_group: "malformed-group", sibling_index: 1
        })

        firstSiblings := ChatDB.Msg_GetSiblings(a1)
        secondSiblings := ChatDB.Msg_GetSiblings(a2)
        if firstSiblings.Length != 1 || firstSiblings[1].id != a1
            throw Error("cross-parent row was exposed as a sibling of the first answer")
        if secondSiblings.Length != 1 || secondSiblings[1].id != a2
            throw Error("cross-parent row was exposed as a sibling of the second answer")

        ChatDB.Msg_SetActiveLeaf(threadId, a2)
        result := ChatDB.Msg_SwitchBranch(threadId, a2, -1)
        if result.siblingInfo.total != 1
            throw Error("malformed cross-parent group rendered branch navigation total=" result.siblingInfo.total)
        leaf := ChatDB.db.Query("SELECT active_leaf_id FROM chat_threads WHERE id=?;", threadId)
        if leaf[1, "active_leaf_id"] != a2
            throw Error("malformed group branch switch changed the active leaf")

        this._teardown()
    }

    ; Msg_SwitchBranch
    ; --------------------

    SwitchBranch_NoSiblings() {
        threadId := this._setup()
        u1Id := ChatDB.Msg_Insert({thread_id: threadId, role: "user", content: "u1"})
        id := ChatDB.Msg_Insert({thread_id: threadId, role: "assistant", content: "a1", parent_id: u1Id})
        result := ChatDB.Msg_SwitchBranch(threadId, id, 1)
        if result.siblingInfo.total != 1
            throw Error("Expected sibling total 1, got " result.siblingInfo.total)
        if result.path.Length != 2
            throw Error("Expected path length 2, got " result.path.Length)
        this._teardown()
    }

    SwitchBranch_UpdatesActivePathTokens() {
        threadId := this._setup()
        u1Id := ChatDB.Msg_Insert({thread_id: threadId, role: "user", content: "hello"})
        ; Two sibling assistants — token_count = visible output
        a1Id := ChatDB.Msg_Insert({thread_id: threadId, role: "assistant", content: "short reply", parent_id: u1Id, sibling_group: "test-sg", sibling_index: 0, model: "deepseek-v4-flash", token_count: 5, cached_tokens: 0})
        a2Id := ChatDB.Msg_Insert({thread_id: threadId, role: "assistant", content: "longer detailed response", parent_id: u1Id, sibling_group: "test-sg", sibling_index: 1, model: "deepseek-v4-flash", token_count: 10, cached_tokens: 0})
        ; After insert, active_path_tokens = token_count of last assistant (10)
        stats := ChatDB.Msg_GetThreadStats(threadId)
        if stats.activePathTokens != 10
            throw Error("Expected active_path_tokens=10 for a2, got " stats.activePathTokens)

        ; Switch to a1 branch — _SyncActivePathTokens sums token_count: a1(5) = 5
        result := ChatDB.Msg_SwitchBranch(threadId, a2Id, -1)
        if result.siblingInfo.index != 1
            throw Error("Expected sibling index 1 after switching, got " result.siblingInfo.index)

        stats := ChatDB.Msg_GetThreadStats(threadId)
        if stats.activePathTokens != 5
            throw Error("Expected active_path_tokens=5 for a1 branch after switch, got " stats.activePathTokens)

        ; Switch back to a2 — token_count sum: a2(10) = 10
        ChatDB.Msg_SwitchBranch(threadId, a1Id, 1)
        stats := ChatDB.Msg_GetThreadStats(threadId)
        if stats.activePathTokens != 10
            throw Error("Expected active_path_tokens=10 for a2 branch after switch back, got " stats.activePathTokens)
        this._teardown()
    }

    ; Regression (bug #306): locked titles are redacted until the session
    ; explicitly proves an unlock; the service path still permits the title
    ; after that proof.
    ThreadList_RedactsLockedTitleUntilSessionUnlock() {
        threadId := this._setup()
        ChatDB.Thread_Update(threadId, "Sensitive title")
        ChatDB.ThreadLock_Set(threadId, "00112233445566778899aabbccddeeff", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", 10000)
        ThreadLockService.sessionUnlocked.Clear()
        lockedTitle := ChatDB.Thread_List()[1].title
        if lockedTitle != "Locked chat"
            throw Error("locked title must be redacted before session unlock")
        ThreadLockService.Unlock(threadId)
        unlockedTitle := ChatDB.Thread_List()[1].title
        if unlockedTitle != "Sensitive title"
            throw Error("session-unlocked title should be visible")
        ThreadLockService.sessionUnlocked.Clear()
        this._teardown()
    }

    ; Regression (bug #1): a stale branch event from another thread must not
    ; write that thread's leaf into the caller's active_leaf_id.
    SwitchBranch_RejectsForeignMessage() {
        threadA := this._setup()
        threadB := ChatDB.Thread_Create("Other Thread")
        aUser := ChatDB.Msg_Insert({thread_id: threadA, role: "user", content: "A"})
        aLeaf := ChatDB.Msg_Insert({thread_id: threadA, role: "assistant", content: "A answer", parent_id: aUser, model: "deepseek-v4-flash", token_count: 3})
        bUser := ChatDB.Msg_Insert({thread_id: threadB, role: "user", content: "B"})
        b1 := ChatDB.Msg_Insert({thread_id: threadB, role: "assistant", content: "B one", parent_id: bUser, sibling_group: "foreign-sg", sibling_index: 0, model: "deepseek-v4-flash", token_count: 3})
        ChatDB.Msg_Insert({thread_id: threadB, role: "assistant", content: "B two", parent_id: bUser, sibling_group: "foreign-sg", sibling_index: 1, model: "deepseek-v4-flash", token_count: 5})
        ChatDB.Msg_SetActiveLeaf(threadA, aLeaf)
        result := ChatDB.Msg_SwitchBranch(threadA, b1, 1)
        stored := ChatDB.db.Query("SELECT active_leaf_id FROM chat_threads WHERE id=?;", threadA)
        if stored[1, "active_leaf_id"] != aLeaf
            throw Error("foreign branch switch changed A's leaf to " stored[1, "active_leaf_id"])
        if result.path.Length != 2 || result.path[result.path.Length].id != aLeaf
            throw Error("foreign branch switch returned the wrong A path")
        stats := ChatDB.Msg_GetThreadStats(threadA)
        if stats.activePathTokens != 3
            throw Error("foreign branch switch leaked B stats into A: " stats.activePathTokens)
        this._teardown()
    }

    ; --------------------
    ; Msg_ForkThread
    ; --------------------

    ; Regression (bug #180): ThreadRepo.List must NOT issue a per-thread
    ; active-path walk (one leaf lookup + one SELECT per ancestor for every
    ; listed thread). The badge model is resolved from a single batched
    ; message query, so a 300-thread list stays at a bounded query count.
    ThreadList_QueryCountIsBounded() {
        this._setup()
        loop 30 {
            tid := ChatDB.Thread_Create("N1T" A_Index)
            u1 := ChatDB.Msg_Insert({thread_id: tid, role: "user", content: "u1"})
            a1 := ChatDB.Msg_Insert({thread_id: tid, role: "assistant", content: "a1", parent_id: u1, model: "deepseek/deepseek-v4-flash"})
            u2 := ChatDB.Msg_Insert({thread_id: tid, role: "user", content: "u2", parent_id: a1})
            ChatDB.Msg_SetActiveLeaf(tid, u2)
        }
        ; A dangling active_leaf_id must not throw, and a trashed thread must
        ; be excluded.
        dangleId := ChatDB.Thread_Create("DanglingLeaf")
        ChatDB.db.Query("UPDATE chat_threads SET active_leaf_id='ghost-missing-id' WHERE id=?;", dangleId)
        trashId := ChatDB.Thread_Create("Trashed")
        ChatDB.Thread_SoftDelete(trashId)

        realDb := ChatDB.db
        counter := ThreadListQueryCounter()
        counter.count := 0
        counter.real := realDb
        ChatDB.db := counter
        try {
            list := ChatDB.Thread_List()
        } finally {
            ChatDB.db := realDb
        }
        queryCount := counter.count

        if queryCount > 10
            throw Error("Thread_List must use a bounded query count (bug #180), got " queryCount " for " list.Length " threads")
        if list.Length != 32
            throw Error("expected 31 live + 1 dangling = 32 listed threads, got " list.Length)
        badgeFound := false
        for t in list {
            if t.id = dangleId && t.model != ""
                throw Error("dangling-leaf thread must list with an empty badge model, got '" t.model "'")
            if t.model = "deepseek/deepseek-v4-flash"
                badgeFound := true
            if t.id = trashId
                throw Error("trashed thread must not be listed")
        }
        if !badgeFound
            throw Error("badge model must resolve from the batched message map (bug #180)")
        this._teardown()
    }

    ForkThread_CreatesNewThread() {
        threadId := this._setup()
        u1Id := ChatDB.Msg_Insert({thread_id: threadId, role: "user", content: "u1"})
        a1Id := ChatDB.Msg_Insert({thread_id: threadId, role: "assistant", content: "a1", parent_id: u1Id})
        newId := ChatDB.Msg_ForkThread(threadId, a1Id)
        if !newId
            throw Error("Expected new thread id from fork")
        path := ChatDB.Msg_GetActivePath(newId)
        if path.Length != 2
            throw Error("Expected 2 messages in forked thread, got " path.Length)
        ChatDB.Thread_Delete(newId)
        this._teardown()
    }

    ; Regression: Fork copies attachments
    ForkThread_CopiesAttachments() {
        threadId := this._setup()
        u1Id := ChatDB.Msg_Insert({thread_id: threadId, role: "user", content: "u1 with file"})
        ChatDB.Attachment_Insert(u1Id, {
            attachment_type: "pdf",
            file_path: "attachments\test_fork.pdf",
            mime_type: "application/pdf",
            original_filename: "test.pdf",
            file_size: 500,
            extracted_text: "fork test"
        })
        a1Id := ChatDB.Msg_Insert({thread_id: threadId, role: "assistant", content: "a1", parent_id: u1Id})

        newId := ChatDB.Msg_ForkThread(threadId, a1Id)
        if !newId
            throw Error("Expected new thread id from fork")

        ; Get forked message and check its attachments
        path := ChatDB.Msg_GetActivePath(newId)
        if path.Length != 2
            throw Error("Expected 2 messages in forked thread")

        atts := ChatDB.Attachment_GetByMessage(path[1].id)
        if atts.Length != 1
            throw Error("Expected 1 copied attachment after fork, got " atts.Length)
        if atts[1].attachment_type != "pdf"
            throw Error("Expected pdf attachment type after fork copy")

        ChatDB.Thread_Delete(newId)
        this._teardown()
    }

    ; Regression: Fork copies per-thread font_size and Advanced toggles (bug #44)
    ForkThread_CopiesPerThreadSettings() {
        threadId := this._setup()
        togglesJson := jsongo.Stringify(Map("codeExecution", true, "webSearch", true))
        ChatDB.db.Exec("UPDATE chat_threads SET font_size=20, advanced_toggles='" SQLite.Escape(togglesJson) "' WHERE id='" threadId "';")
        u1Id := ChatDB.Msg_Insert({thread_id: threadId, role: "user", content: "u1"})
        a1Id := ChatDB.Msg_Insert({thread_id: threadId, role: "assistant", content: "a1", parent_id: u1Id})
        newId := ChatDB.Msg_ForkThread(threadId, a1Id)
        if !newId
            throw Error("Expected new thread id from fork (per-thread settings)")
        row := ChatDB.db.Exec("SELECT font_size, advanced_toggles FROM chat_threads WHERE id='" newId "';")
        if !row.count || Integer(row[1, "font_size"]) != 20
            throw Error("Expected forked thread font_size=20, got " (row.count ? row[1, "font_size"] : "none"))
        if !InStr(row[1, "advanced_toggles"], "codeExecution")
            throw Error("Expected forked thread advanced_toggles to contain codeExecution, got " row[1, "advanced_toggles"])
        if !InStr(row[1, "advanced_toggles"], "webSearch")
            throw Error("Expected forked thread advanced_toggles to contain webSearch")
        ChatDB.Thread_Delete(newId)
        this._teardown()
    }

    ; Regression (bug #126): a mid-conversation fork must NOT inherit the source
    ; thread's FULL cumulative counters - it recomputes them from the fork's own
    ; messages (only the prefix's API calls). The per-message active_path_tokens
    ; (context used) are still copied, keeping bug #48's context part.
    ForkThread_RecomputesCountersFromForkMessages() {
        threadId := this._setup()
        ChatDB.db.Exec("UPDATE chat_threads SET cumulative_input_tokens=25, cumulative_output_tokens=50, cumulative_cached_tokens=5 WHERE id='" threadId "';")
        u1Id := ChatDB.Msg_Insert({thread_id: threadId, role: "user", content: "u1", token_count: 10, active_path_tokens: 10})
        a1Id := ChatDB.Msg_Insert({thread_id: threadId, role: "assistant", content: "a1", parent_id: u1Id, model: "deepseek/deepseek-v4-flash", token_count: 20, active_path_tokens: 30})
        u2Id := ChatDB.Msg_Insert({thread_id: threadId, role: "user", content: "u2", parent_id: a1Id, token_count: 5, active_path_tokens: 35})
        a2Id := ChatDB.Msg_Insert({thread_id: threadId, role: "assistant", content: "a2", parent_id: u2Id, token_count: 30, active_path_tokens: 65})

        ; Fork mid-conversation at a1: the fork contains only u1 + a1.
        newId := ChatDB.Msg_ForkThread(threadId, a1Id)
        if !newId
            throw Error("Expected new thread id from fork (recomputed counters)")
        forkMsgs := ChatDB.db.Exec("SELECT COUNT(*) AS c FROM messages WHERE thread_id='" newId "';")
        if Integer(forkMsgs[1, "c"]) != 2
            throw Error("fork should contain 2 messages (u1 + a1), got " forkMsgs[1, "c"])
        row := ChatDB.db.Exec("SELECT cumulative_input_tokens, cumulative_output_tokens, cumulative_cached_tokens, active_leaf_id FROM chat_threads WHERE id='" newId "';")
        if !row.count
            throw Error("fork thread row missing")
        ; The fork's own calls: a1's single API call consumed 10 input / 20 output.
        if Integer(row[1, "cumulative_input_tokens"]) != 10
            throw Error("fork should recompute input=10 (not inherit 25), got " row[1, "cumulative_input_tokens"])
        if Integer(row[1, "cumulative_output_tokens"]) != 20
            throw Error("fork should recompute output=20 (not inherit 50), got " row[1, "cumulative_output_tokens"])
        leaf := ChatDB.db.Exec("SELECT active_path_tokens FROM messages WHERE id='" row[1, "active_leaf_id"] "';")
        if !leaf.count || Integer(leaf[1, "active_path_tokens"]) != 30
            throw Error("fork leaf should keep active_path_tokens=30 (context still copied), got " (leaf.count ? leaf[1, "active_path_tokens"] : "none"))
        ChatDB.Thread_Delete(newId)
        this._teardown()
    }

    ; Regression (bug #202): forking a thread that contains a LOCAL branch-edit
    ; copy must preserve is_local_copy on the fork rows, so the fork's
    ; recomputed cumulative counters do NOT charge the copy as a real API call.
    ForkThread_PreservesLocalCopyFlag() {
        threadId := this._setup()
        u1Id := ChatDB.Msg_Insert({thread_id: threadId, role: "user", content: "u1"})
        a1Id := ChatDB.Msg_Insert({thread_id: threadId, role: "assistant", content: "real a1", parent_id: u1Id, model: "deepseek/deepseek-v4-flash", prompt_tokens: 12, token_count: 9, cached_tokens: 4})
        a1bId := ChatDB.Msg_Insert({thread_id: threadId, role: "assistant", content: "branch copy", parent_id: u1Id, sibling_group: "sg-fork-202", sibling_index: 1, model: "deepseek/deepseek-v4-flash", token_count: 9, prompt_tokens: 12, cached_tokens: 4, active_path_tokens: 21, local_copy: true})
        src := ChatDB.db.Query("SELECT cumulative_input_tokens, cumulative_output_tokens, cumulative_cached_tokens FROM chat_threads WHERE id=?;", threadId)
        srcIn := Integer(src[1, "cumulative_input_tokens"]), srcOut := Integer(src[1, "cumulative_output_tokens"]), srcCk := Integer(src[1, "cumulative_cached_tokens"])
        newId := ChatDB.Msg_ForkThread(threadId, a1bId)
        if !newId
            throw Error("Expected fork id")
        fork := ChatDB.db.Query("SELECT cumulative_input_tokens, cumulative_output_tokens, cumulative_cached_tokens FROM chat_threads WHERE id=?;", newId)
        forkIn := Integer(fork[1, "cumulative_input_tokens"]), forkOut := Integer(fork[1, "cumulative_output_tokens"]), forkCk := Integer(fork[1, "cumulative_cached_tokens"])
        localRows := ChatDB.db.Query("SELECT COUNT(*) AS c FROM messages WHERE thread_id=? AND is_local_copy=1;", newId)
        if Integer(localRows[1, "c"]) != 1
            throw Error("fork must preserve the local-copy flag (bug #202), got " localRows[1, "c"])
        if forkIn != srcIn || forkOut != srcOut || forkCk != srcCk
            throw Error("fork counters must equal the source (local copy not re-charged), got " forkIn "/" forkOut "/" forkCk " expected " srcIn "/" srcOut "/" srcCk)
        ChatDB.Thread_Delete(newId)
        this._teardown()
    }

    ; Regression (bug #177): a fork must copy each message's per-message COST
    ; SNAPSHOT (input_cost/cached_input_cost/output_cost/total_cost, bug #153
    ; columns) so the fork's recomputed cumulative cost matches the source
    ; thread even after a Settings price change. The old code copied only the
    ; token fields, so the fork's recompute fell back to the CURRENT prices
    ; and the fork header disagreed with the source thread.
    ForkThread_CopiesCostSnapshots() {
        threadId := this._setup()
        u1Id := ChatDB.Msg_Insert({thread_id: threadId, role: "user", content: "u1"})
        a1Id := ChatDB.Msg_Insert({thread_id: threadId, role: "assistant", content: "a1", parent_id: u1Id, model: "deepseek/deepseek-v4-flash", prompt_tokens: 100, token_count: 50, cached_tokens: 20})
        srcRow := ChatDB.db.Query("SELECT cumulative_cost FROM chat_threads WHERE id=?;", threadId)
        srcCost := Number(srcRow[1, "cumulative_cost"])
        if srcCost <= 0
            throw Error("control failed - source should carry a snapshot cost > 0, got " srcCost)
        snapRow := ChatDB.db.Query("SELECT input_cost, cached_input_cost, output_cost, total_cost FROM messages WHERE id=?;", a1Id)
        snapTotal := Number(snapRow[1, "total_cost"])
        if snapTotal <= 0
            throw Error("control failed - a1 should carry a cost snapshot > 0, got " snapTotal)

        ; Simulate a Settings price change AFTER the API call was made.
        m := models["deepseek/deepseek-v4-flash"]
        origInput := m.input
        origCachedInput := m.cachedInput
        origOutput := m.output
        m.input := m.input * 2
        m.cachedInput := m.cachedInput * 2
        m.output := m.output * 2

        newId := ChatDB.Msg_ForkThread(threadId, a1Id)
        if !newId
            throw Error("Expected new thread id from fork (cost snapshots)")
        forkRow := ChatDB.db.Query("SELECT cumulative_cost FROM chat_threads WHERE id=?;", newId)
        forkCost := Number(forkRow[1, "cumulative_cost"])
        if Abs(forkCost - srcCost) > 0.000001
            throw Error("fork cumulative_cost must equal the source's snapshot cost (bug #177): srcCost=" srcCost " forkCost=" forkCost)
        forkSnaps := ChatDB.db.Query("SELECT input_cost, cached_input_cost, output_cost, total_cost FROM messages WHERE thread_id=?;", newId)
        copiedSum := 0
        for r in forkSnaps.rows
            copiedSum += Number(r.input_cost) + Number(r.cached_input_cost) + Number(r.output_cost) + Number(r.total_cost)
        if copiedSum = 0
            throw Error("fork rows must carry the copied cost snapshots (bug #177), got sum 0")
        ; Restore the model prices so later tests keep the real defaults.
        m.input := origInput
        m.cachedInput := origCachedInput
        m.output := origOutput
        ChatDB.Thread_Delete(newId)
        this._teardown()
    }

    ; Regression (bug #58): a fork must land in the source thread's folder.
    ForkThread_CopiesFolder() {
        threadId := this._setup()
        ; Create the folder first - with PRAGMA foreign_keys=ON (hardening item
        ; 2) a folder_id must reference an existing chat_folders row.
        ChatDB.db.Query("INSERT INTO chat_folders (id, name) VALUES(?, ?);", "f-58", "Folder 58")
        ChatDB.db.Query("UPDATE chat_threads SET folder_id=? WHERE id=?;", "f-58", threadId)
        u1Id := ChatDB.Msg_Insert({thread_id: threadId, role: "user", content: "u1"})
        a1Id := ChatDB.Msg_Insert({thread_id: threadId, role: "assistant", content: "a1", parent_id: u1Id})
        newId := ChatDB.Msg_ForkThread(threadId, a1Id)
        if !newId
            throw Error("Expected new thread id from fork (folder)")
        row := ChatDB.db.Query("SELECT folder_id FROM chat_threads WHERE id=?;", newId)
        if !row.count || row[1, "folder_id"] != "f-58"
            throw Error("Expected forked thread folder_id=f-58, got " (row.count ? row[1, "folder_id"] : "none"))
        ChatDB.Thread_Delete(newId)
        this._teardown()
    }

    ; Regression (bug #62): a fork must inherit a temperature override of 0
    ; (AHK treats 0 as falsy, so the old truthiness check dropped it).
    ForkThread_CopiesTemperatureZero() {
        threadId := this._setup()
        u1Id := ChatDB.Msg_Insert({thread_id: threadId, role: "user", content: "u1"})
        a1Id := ChatDB.Msg_Insert({thread_id: threadId, role: "assistant", content: "a1", parent_id: u1Id})
        ChatDB.Thread_UpdateSettings(threadId, { temperatureOverride: 0 })
        newId := ChatDB.Msg_ForkThread(threadId, a1Id)
        if !newId
            throw Error("Expected new thread id from fork (temp 0)")
        s := ChatDB.Thread_GetSettings(newId)
        if s.temperatureOverride = "" || s.temperatureOverride != 0
            throw Error("fork should inherit temperature override 0, got '" s.temperatureOverride "'")
        ChatDB.Thread_Delete(newId)
        this._teardown()
    }

    ; Regression (bug #113): a fork must copy the FULL descendant subtrees of
    ; off-path siblings - previously only the direct siblings were copied, so
    ; branch navigation in the fork landed on a dead leaf. Children of the fork
    ; point itself (the source thread's continuation) must NOT be copied.
    ForkThread_CopiesDeepOffPathSubtrees() {
        threadId := this._setup()
        u1Id := ChatDB.Msg_Insert({thread_id: threadId, role: "user", content: "root"})
        a1Id := ChatDB.Msg_Insert({thread_id: threadId, role: "assistant", content: "reply A", parent_id: u1Id, sibling_group: "sg-113", sibling_index: 0})
        a1bId := ChatDB.Msg_Insert({thread_id: threadId, role: "assistant", content: "reply B", parent_id: u1Id, sibling_group: "sg-113", sibling_index: 1})
        u2bId := ChatDB.Msg_Insert({thread_id: threadId, role: "user", content: "follow B", parent_id: a1bId})
        a2bId := ChatDB.Msg_Insert({thread_id: threadId, role: "assistant", content: "ans B", parent_id: u2bId})
        u2b2Id := ChatDB.Msg_Insert({thread_id: threadId, role: "user", content: "follow B retry", parent_id: a1bId, sibling_group: "sg-113b", sibling_index: 1})
        a2b2Id := ChatDB.Msg_Insert({thread_id: threadId, role: "assistant", content: "ans B2", parent_id: u2b2Id})
        ; Continuation beyond the fork point - must NOT be copied.
        u2Id := ChatDB.Msg_Insert({thread_id: threadId, role: "user", content: "follow A", parent_id: a1Id})
        a2Id := ChatDB.Msg_Insert({thread_id: threadId, role: "assistant", content: "ans A", parent_id: u2Id})

        newId := ChatDB.Msg_ForkThread(threadId, a1Id)
        if !newId
            throw Error("Expected new thread id from fork (deep branches)")

        forkMsgs := ChatDB.db.Exec("SELECT id, parent_id, sibling_group FROM messages WHERE thread_id='" newId "';")
        if forkMsgs.count != 7
            throw Error("fork should copy the off-path sibling subtree (7 messages), got " forkMsgs.count)
        ; The active path's continuation below the fork point must not be in the fork.
        cont := ChatDB.db.Exec("SELECT COUNT(*) AS c FROM messages WHERE thread_id='" newId "' AND content IN ('follow A','ans A');")
        if Integer(cont[1, "c"]) != 0
            throw Error("fork must not include the continuation beyond the fork point")
        ; Every fork message's parent must resolve inside the fork.
        bad := ChatDB.db.Exec("SELECT COUNT(*) AS c FROM messages m LEFT JOIN messages p ON p.id = m.parent_id WHERE m.thread_id='" newId "' AND m.parent_id IS NOT NULL AND p.id IS NULL;")
        if Integer(bad[1, "c"]) != 0
            throw Error("fork has dangling parents")
        ; The off-path sibling's copy must keep its continuations (a1b -> u2b/u2b2).
        a1bFork := ChatDB.db.Exec("SELECT id FROM messages WHERE thread_id='" newId "' AND content='reply B';")
        if !a1bFork.count
            throw Error("off-path sibling a1b not copied to the fork")
        childrenB := ChatDB.db.Exec("SELECT COUNT(*) AS c FROM messages WHERE parent_id='" a1bFork[1, "id"] "';")
        if Integer(childrenB[1, "c"]) != 2
            throw Error("a1b copy should keep its 2 continuations (u2b + u2b2), got " childrenB[1, "c"])
        ChatDB.Thread_Delete(newId)
        this._teardown()
    }

    ; Regression (bug #143): a fork at a message whose own children include an
    ; OFF-PATH alternative continuation must copy that alternative (with its
    ; subtree) - only the ACTIVE continuation beyond the fork point is
    ; excluded (scenario 126), not every child of the fork point.
    ForkThread_CopiesOffPathChildrenOfForkPoint() {
        threadId := this._setup()
        u1Id := ChatDB.Msg_Insert({thread_id: threadId, role: "user", content: "u1"})
        a1Id := ChatDB.Msg_Insert({thread_id: threadId, role: "assistant", content: "a1", parent_id: u1Id})
        ; Active continuation of a1:
        u2Id := ChatDB.Msg_Insert({thread_id: threadId, role: "user", content: "u2", parent_id: a1Id})
        a2Id := ChatDB.Msg_Insert({thread_id: threadId, role: "assistant", content: "a2", parent_id: u2Id})
        ; OFF-PATH alternative continuation of a1 (already exists in the tree):
        u2bId := ChatDB.Msg_Insert({thread_id: threadId, role: "user", content: "u2b", parent_id: a1Id, sibling_group: "sg-143", sibling_index: 1})
        a2bId := ChatDB.Msg_Insert({thread_id: threadId, role: "assistant", content: "a2b", parent_id: u2bId})
        ; The ACTIVE continuation is u2 -> a2 (u2b/a2b are the OFF-PATH branch):
        ChatDB.Msg_SetActiveLeaf(threadId, a2Id)

        newId := ChatDB.Msg_ForkThread(threadId, a1Id)
        if !newId
            throw Error("Expected new thread id from fork (off-path children)")

        forkMsgs := ChatDB.db.Exec("SELECT content FROM messages WHERE thread_id='" newId "';")
        if forkMsgs.count != 4
            throw Error("fork should contain u1+a1+u2b+a2b (4 messages), got " forkMsgs.count)
        hasU2b := false, hasA2b := false
        for row in forkMsgs.rows {
            if row.content = "u2b"
                hasU2b := true
            if row.content = "a2b"
                hasA2b := true
        }
        if !hasU2b || !hasA2b
            throw Error("fork must copy the off-path children of the fork point (u2b/a2b)")
        cont := ChatDB.db.Exec("SELECT COUNT(*) AS c FROM messages WHERE thread_id='" newId "' AND content IN ('u2','a2');")
        if Integer(cont[1, "c"]) != 0
            throw Error("fork must NOT include the active continuation beyond the fork point (u2/a2)")
        bad := ChatDB.db.Exec("SELECT COUNT(*) AS c FROM messages m LEFT JOIN messages p ON p.id = m.parent_id WHERE m.thread_id='" newId "' AND m.parent_id IS NOT NULL AND p.id IS NULL;")
        if Integer(bad[1, "c"]) != 0
            throw Error("fork has dangling parents")
        ChatDB.Thread_Delete(newId)
        this._teardown()
    }

    ; Regression (bug #69): the LIKE fallback must escape %/_/\\ so searching for
    ; a literal % does not match every message.
    SearchMessages_LikeEscapesWildcards() {
        threadId := this._setup()
        ChatDB.Msg_Insert({thread_id: threadId, role: "user", content: "50% done"})
        ChatDB.Msg_Insert({thread_id: threadId, role: "user", content: "plain text here"})
        results := ChatDB.SearchMessages("%", threadId)
        if results.Length != 1
            throw Error("searching for % should match only the message containing it, got " results.Length)
        if !InStr(results[1].contentPreview, "50% done")
            throw Error("expected the %-containing message, got '" results[1].contentPreview "'")
        this._teardown()
    }

    ; Regression (bug #165): attachment extracted_text must be searchable - the
    ; FTS index includes the decoded attachment text, and removing the
    ; attachment re-indexes the message so the term stops matching.
    SearchMessages_FindsAttachmentExtractedText() {
        threadId := this._setup()
        uId := ChatDB.Msg_Insert({thread_id: threadId, role: "user", content: "see attached report"})
        ChatDB.Attachment_Insert(uId, {
            attachment_type: "pdf",
            file_path: "attachments/report.pdf",
            mime_type: "application/pdf",
            original_filename: "report.pdf",
            file_size: 1024,
            extracted_text: "Quarterly results mention the needle keyword only here."
        })
        results := ChatDB.SearchMessages("needle", threadId)
        if results.Length != 1
            throw Error("search must find attachment extracted_text (bug #165), got " results.Length)
        if results[1].messageId != uId
            throw Error("hit should be the attachment's message, got " results[1].messageId)
        ; Removing the attachment removes the term from the index:
        atts := ChatDB.Attachment_GetByMessage(uId)
        ChatDB.Attachment_DeleteOne(atts[1].id)
        results2 := ChatDB.SearchMessages("needle", threadId)
        if results2.Length != 0
            throw Error("attachment text must stop matching after deletion, got " results2.Length)
        this._teardown()
    }

    ; Regression (bug #183): a search hit that exists ONLY in an attachment's
    ; extracted_text must preview the MATCHED attachment text (the snippet is
    ; built from the FTS-indexed content = message + attachment text), not the
    ; unrelated message content.
    SearchMessages_AttachmentHit_SnippetShowsMatch() {
        threadId := this._setup()
        u1Id := ChatDB.Msg_Insert({thread_id: threadId, role: "user", content: "see attached report"})
        ChatDB.Attachment_Insert(u1Id, {
            attachment_type: "pdf",
            file_path: "attachments/report.pdf",
            mime_type: "application/pdf",
            original_filename: "report.pdf",
            file_size: 1024,
            extracted_text: "Quarterly results mention the needle keyword only here."
        })
        hits := ChatDB.SearchMessages("needle", threadId)
        if hits.Length < 1
            throw Error("control failed - attachment text must be searchable (bug #165), got " hits.Length " hits")
        if !InStr(hits[1].contentPreview, "needle")
            throw Error("snippet must contain the attachment match (bug #183), got '" hits[1].contentPreview "'")
        this._teardown()
    }

    ; Regression (bug #161): a query ending in an apostrophe must keep FTS5
    ; prefix matching ("comp'" behaves like "comp") - the * guard only checks
    ; for a trailing "*" (terms are ALWAYS double-quoted, so the old "'" check
    ; wrongly disabled prefix matching for trailing-apostrophe queries).
    SearchMessages_FTS5_TrailingApostropheKeepsPrefix() {
        threadId := this._setup()
        u1 := ChatDB.Msg_Insert({thread_id: threadId, role: "user", content: "complete the compass calculation"})
        ChatDB.Msg_Insert({thread_id: threadId, role: "user", content: "don't forget the donuts", parent_id: u1})
        plain := SearchRepo._FTS5("comp", threadId)
        quote := SearchRepo._FTS5("comp'", threadId)
        if plain.Length = 0
            throw Error("setup: comp should prefix-match complete/compass")
        if quote.Length != plain.Length
            throw Error("comp' must behave like comp (bug #161): plain=" plain.Length " quote=" quote.Length)
        this._teardown()
    }

    ; Large-history sanity (follow-up audit): the startup FTS rebuild must
    ; re-index a big messages table (rows inserted WITHOUT FTS_Sync, e.g. a
    ; legacy/copied DB) and include attachment extracted_text, without
    ; duplicates or gaps.
    FTSRebuild_LargeHistory_StaysConsistent() {
        if ChatDB.isOpen {
            oldPath := ChatDB.dbPath
            ChatDB.Close()
            try FileDelete(oldPath)
        }
        dbPath := A_Temp "\test_large_fts_" A_TickCount "_" Random(1000, 999999) ".db"
        ChatDB.Open(dbPath)
        threadId := ChatDB.Thread_Create("Large")
        parentId := ""
        loop 200 {
            uId := ChatDB.Msg_Insert({thread_id: threadId, role: "user", content: "question " A_Index, parent_id: parentId})
            aId := ChatDB.Msg_Insert({thread_id: threadId, role: "assistant", content: "answer " A_Index, parent_id: uId, model: "deepseek/deepseek-v4-flash", prompt_tokens: 10, token_count: 5})
            parentId := aId
        }
        ; Insert one message + attachment entirely via raw SQL (no FTS_Sync) to
        ; force the startup rebuild path, then close and reopen:
        rawMsg := ChatDB._UUID()
        ChatDB.db.Query("INSERT INTO messages (id, thread_id, role, content) VALUES(?, ?, 'user', 'legacy content');", rawMsg, threadId)
        ChatDB.db.Query("INSERT INTO message_attachments (id, message_id, attachment_type, file_path, mime_type, original_filename, file_size, extracted_text) VALUES(?, ?, 'pdf', 'attachments/legacy.pdf', 'application/pdf', 'legacy.pdf', 10, ?);", ChatDB._UUID(), rawMsg, AttachmentRepo._StrToBase64("the needle lives in the legacy attachment"))
        ChatDB.Close()

        ChatDB.Open(dbPath)
        msgCount := ChatDB.db.Query("SELECT COUNT(*) AS c FROM messages;")[1, "c"]
        ftsCount := ChatDB.db.Query("SELECT COUNT(*) AS c FROM messages_fts;")[1, "c"]
        if Integer(ftsCount) != Integer(msgCount)
            throw Error("FTS rebuild must index every message: messages=" msgCount " fts=" ftsCount)
        ; The rebuilt index must include the legacy attachment's text:
        hits := SearchRepo.Search("needle", threadId)
        if hits.Length != 1
            throw Error("rebuilt FTS must include attachment extracted_text (needle), got " hits.Length)
        ChatDB.Close()
        try FileDelete(dbPath)
    }

    ; Regression (bug #80, security): thread mutators must escape threadId - a
    ; crafted id with a single quote must not break or inject SQL.
    ThreadMutators_EscapeThreadId() {
        threadId := this._setup()
        crafted := "bad'id"
        ChatDB.db.Exec("INSERT INTO chat_threads (id, title) VALUES('bad''id', 'Crafted');")
        try {
            ChatDB.Thread_SoftDelete(crafted)
            row := ChatDB.db.Exec("SELECT is_deleted FROM chat_threads WHERE id='bad''id';")
            if !row.count || Integer(row[1, "is_deleted"]) != 1
                throw Error("SoftDelete should target the crafted id literally")
            ChatDB.Thread_Restore(crafted)
            row := ChatDB.db.Exec("SELECT is_deleted FROM chat_threads WHERE id='bad''id';")
            if !row.count || Integer(row[1, "is_deleted"]) != 0
                throw Error("Restore should target the crafted id literally")
            ChatDB.Thread_Update(crafted, "Renamed")
            row := ChatDB.db.Exec("SELECT title FROM chat_threads WHERE id='bad''id';")
            if row[1, "title"] != "Renamed"
                throw Error("Update should target the crafted id literally")
            ChatDB.Thread_Delete(crafted)
            row := ChatDB.db.Exec("SELECT COUNT(*) AS c FROM chat_threads WHERE id='bad''id';")
            if Integer(row[1, "c"]) != 0
                throw Error("Delete should target the crafted id literally")
        } finally {
            this._teardown()
        }
    }

    ; Regression (bug #96, security): AttachmentRepo must escape msgId/threadId
    ; and ChatDB FTS_Sync/FTS_Remove the same way - a crafted id with a single
    ; quote must not break or inject SQL.
    AttachmentRepo_EscapesMsgId() {
        threadId := this._setup()
        craftedMsgId := "bad'id"
        ChatDB.db.Exec("INSERT INTO messages (id, thread_id, role, content) VALUES('bad''id', '" threadId "', 'user', 'attached content');")
        try {
            attId := ChatDB.Attachment_Insert(craftedMsgId, {
                attachment_type: "text_file",
                file_path: "tmp/nonexistent.bin",
                mime_type: "text/plain",
                original_filename: "note.txt",
                file_size: 12,
                extracted_text: "hello"
            })
            if !attId
                throw Error("Attachment_Insert should return an id for a crafted msgId")
            rows := ChatDB.Attachment_GetByMessage(craftedMsgId)
            if rows.Length != 1 || rows[1].original_filename != "note.txt"
                throw Error("GetByMessage should find the crafted-id attachment, got " rows.Length " rows")
            ChatDB.Attachment_DeleteByMessage(craftedMsgId)
            rows := ChatDB.Attachment_GetByMessage(craftedMsgId)
            if rows.Length != 0
                throw Error("DeleteByMessage should remove the crafted-id attachment, got " rows.Length " rows")

            ; FTS sync/remove must also escape msgId (bug #96).
            ChatDB.FTS_Sync(craftedMsgId, "content with a quote ' here")
            ftsRow := ChatDB.db.Exec("SELECT COUNT(*) AS c FROM messages_fts WHERE msg_id='bad''id';")
            if !ftsRow.count || Integer(ftsRow[1, "c"]) != 1
                throw Error("FTS_Sync should index the crafted-id message, got " (ftsRow.count ? ftsRow[1, "c"] : "none"))
            ChatDB.FTS_Remove(craftedMsgId)
            ftsRow := ChatDB.db.Exec("SELECT COUNT(*) AS c FROM messages_fts WHERE msg_id='bad''id';")
            if !ftsRow.count || Integer(ftsRow[1, "c"]) != 0
                throw Error("FTS_Remove should remove the crafted-id message, got " (ftsRow.count ? ftsRow[1, "c"] : "none"))
        } finally {
            this._teardown()
        }
    }

    ; Regression (bug #99, security): MessageRepo.Insert must escape parent_id
    ; and sibling_group - a crafted id with a single quote must not break or
    ; inject SQL (same class as #80/#81/#96).
    Insert_EscapesParentIdAndSiblingGroup() {
        threadId := this._setup()
        craftedParent := "bad'parent"
        craftedGroup := "sib'group"
        try {
            parentId := ChatDB.Msg_Insert({thread_id: threadId, role: "user", content: "parent", parent_id: craftedParent, sibling_group: craftedGroup})
            if !parentId
                throw Error("Msg_Insert should accept a crafted parent_id/sibling_group")
            row := ChatDB.db.Exec("SELECT parent_id, sibling_group FROM messages WHERE id='" parentId "';")
            if !row.count || row[1, "parent_id"] != craftedParent || row[1, "sibling_group"] != craftedGroup
                throw Error("crafted parent_id/sibling_group should round-trip literally, got " (row.count ? row[1, "parent_id"] " / " row[1, "sibling_group"] : "none"))
            ; A child with a crafted parent hits the active-path lookup too.
            childId := ChatDB.Msg_Insert({thread_id: threadId, role: "user", content: "child", parent_id: craftedParent})
            if !childId
                throw Error("Msg_Insert child with crafted parent_id should succeed")
            childRow := ChatDB.db.Exec("SELECT parent_id FROM messages WHERE id='" childId "';")
            if !childRow.count || childRow[1, "parent_id"] != craftedParent
                throw Error("child parent_id should round-trip literally")
        } finally {
            this._teardown()
        }
    }

    ; Regression (bug #81, security): _setupSiblingGroup must escape msg.id.
    Branch_SetupSiblingGroup_EscapesMsgId() {
        srcPath := A_ScriptDir "\..\chat\callbacks\Branch.ahk"
        src := FileRead(srcPath)
        block := SubStr(src, InStr(src, "_setupSiblingGroup(msg) {"), 500)
        ; Hardening (bug #81): the update binds msg.id as a parameter, so a
        ; crafted id can never alter the SQL text.
        if !InStr(block, "UPDATE messages SET sibling_group=?, sibling_index=0 WHERE id=?;")
            throw Error("_setupSiblingGroup must bind msg.id (hardening, bug #81)")
    }

    ; Regression (bug #70): FTS5 MATCH must quote terms so special characters
    ; (e.g. C++) do not produce a syntax error / empty results.
    SearchMessages_FTS5EscapesSpecialChars() {
        threadId := this._setup()
        ChatDB.Msg_Insert({thread_id: threadId, role: "user", content: "I code C++ daily"})
        ChatDB.Msg_Insert({thread_id: threadId, role: "user", content: "plain text"})
        results := ChatDB.SearchMessages("C++", threadId)
        if results.Length = 0
            throw Error("searching for C++ should return the C++ message, got 0 results")
        found := false
        for r in results {
            if InStr(r.contentPreview, "C++")
                found := true
        }
        if !found
            throw Error("the C++ message was not found among the results")
        this._teardown()
    }

    ; Regression (bug #63): a model with cachedInput="" must fall back to 10%
    ; of the input price instead of showing 0 in the token-bar pricing unit.
    GetThreadStats_CachedInputEmpty_FallsBackToTenPercent() {
        global models, requestParams
        threadId := this._setup()
        testModel := "deepseek/test-empty-cached"
        models[testModel] := {
            provider: "deepseek", api: "openai-completions",
            compat: Map("thinkingFormat", "deepseek", "supportsReasoningEffort", true, "supportsUsageInStreaming", true, "maxTokensField", "max_tokens"),
            thinkingLevelMap: Map("none", "none", "low", "low", "high", "high", "max", "max"),
            thinkingOff: "disabled",
            input: 1, cachedInput: "", output: 2, context: 1000000, reasoning: true, vision: false
        }
        ; Bug #103: pricing resolves from the ACTIVE model (request model
        ; first) - make the test model active so its pricing drives the unit.
        oldModel := requestParams["singleAPIModelName"]
        try {
            requestParams["singleAPIModelName"] := testModel
            ChatDB.Msg_Insert({thread_id: threadId, role: "assistant", content: "hi", model: testModel})
            stats := ChatDB.Msg_GetThreadStats(threadId)
            if Number(stats.pricingUnit.cachedInput) != 0.1
                throw Error("cachedInput fallback should be 10% of input (0.1), got " stats.pricingUnit.cachedInput)
        } finally {
            requestParams["singleAPIModelName"] := oldModel
            models.Delete(testModel)
            this._teardown()
        }
    }

    ; Regression (bug #64): active_path_tokens must include thinking tokens so
    ; the header "Context Used" reflects the full context-window usage.
    ActivePathTokens_IncludesThinkingTokens() {
        threadId := this._setup()
        uId := ChatDB.Msg_Insert({thread_id: threadId, role: "user", content: "hello", token_count: 10})
        aId := ChatDB.Msg_Insert({thread_id: threadId, role: "assistant", content: "answer", parent_id: uId, prompt_tokens: 20, token_count: 5, thinking_tokens: 7})
        leaf := ChatDB.db.Exec("SELECT active_path_tokens FROM messages WHERE id='" aId "';")
        if !leaf.count || Integer(leaf[1, "active_path_tokens"]) != 32
            throw Error("expected active_path_tokens = prompt(20) + visible(5) + thinking(7) = 32, got " (leaf.count ? leaf[1, "active_path_tokens"] : "none"))
        this._teardown()
    }

    ; Historical API prompt_tokens stays persisted, while the current-path
    ; estimate is recomputed from the editable message contributions.
    RecomputeActivePathUsesCurrentPathEstimate() {
        threadId := this._setup()
        uId := ChatDB.Msg_Insert({thread_id: threadId, role: "user", content: "hello", token_count: 10})
        aId := ChatDB.Msg_Insert({thread_id: threadId, role: "assistant", content: "answer", parent_id: uId, prompt_tokens: 100, token_count: 20})
        leaf := ChatDB.db.Exec("SELECT active_path_tokens, prompt_tokens FROM messages WHERE id='" aId "';")
        if !leaf.count || Integer(leaf[1, "active_path_tokens"]) != 120
            throw Error("setup: assistant active_path should be prompt(100)+visible(20)=120, got " (leaf.count ? leaf[1, "active_path_tokens"] : "none"))
        if !leaf.count || Integer(leaf[1, "prompt_tokens"]) != 100
            throw Error("setup: assistant prompt_tokens should be persisted (bug #107), got " (leaf.count ? leaf[1, "prompt_tokens"] : "none"))
        ; Simulate the structural-change recompute (delete/edit path).
        TreeRepo._RecomputeActivePath(threadId)
        leaf := ChatDB.db.Exec("SELECT active_path_tokens FROM messages WHERE id='" aId "';")
        if !leaf.count || Integer(leaf[1, "active_path_tokens"]) != 30
            throw Error("recompute must use current path estimate (30), got " (leaf.count ? leaf[1, "active_path_tokens"] : "none"))
        this._teardown()
    }

    ; Regression (bug #109, security): the remaining repo paths must escape
    ; crafted ids - SetActiveLeaf and HardDelete round-trip a crafted id with
    ; a single quote instead of breaking the SQL.
    RepoPaths_EscapeCraftedIds() {
        this._setup()
        craftedThread := "bad'thread"
        craftedMsg := "bad'msg"
        ChatDB.db.Exec("INSERT INTO chat_threads (id, title) VALUES('bad''thread', 'Crafted');")
        ChatDB.db.Exec("INSERT INTO messages (id, thread_id, role, content) VALUES('bad''msg', 'bad''thread', 'user', 'hi');")
        try {
            ChatDB.Msg_SetActiveLeaf(craftedThread, craftedMsg)
            row := ChatDB.db.Exec("SELECT active_leaf_id FROM chat_threads WHERE id='bad''thread';")
            if !row.count || row[1, "active_leaf_id"] != craftedMsg
                throw Error("SetActiveLeaf should target the crafted ids literally")
            ; Hard delete the crafted message.
            ChatDB.Msg_HardDelete(craftedMsg)
            row := ChatDB.db.Exec("SELECT COUNT(*) AS c FROM messages WHERE id='bad''msg';")
            if !row.count || Integer(row[1, "c"]) != 0
                throw Error("HardDelete should delete the crafted message literally")
        } finally {
            this._teardown()
        }
    }

    ; Regression (bug #147): retrying an assistant that has NO parent (thread
    ; root, e.g. after deleting the root user message) must insert the retried
    ; response as a SIBLING with parent NULL, not as a CHILD of the original.
    ; Mirrors retryAction + _persistStreamResponse: sibling group set on the
    ; root target, the leaf stays (so the request can be built), and the
    ; pendingRetryIsRoot flag makes the insert use parent NULL.
    RetryRootAssistant_InsertsSiblingNotChild() {
        global requestParams
        threadId := this._setup()
        u1Id := ChatDB.Msg_Insert({thread_id: threadId, role: "user", content: "u1"})
        a1Id := ChatDB.Msg_Insert({thread_id: threadId, role: "assistant", content: "a1", parent_id: u1Id})
        ; Delete the root user message: a1 becomes the thread root.
        ChatDB.Msg_HardDelete(u1Id)
        path := ChatDB.Msg_GetActivePath(threadId)
        if path.Length != 1 || path[1].id != a1Id
            throw Error("setup: a1 should be the root after deleting u1, path=" path.Length)

        ; retryAction: setup the sibling group on the root target and flag the
        ; root retry (bug #147 fix) - the leaf stays on a1 so the request can
        ; still be built from the original path.
        sg := ChatDB._UUID()
        ChatDB.db.Query("UPDATE messages SET sibling_group=?, sibling_index=0 WHERE id=?;", sg, a1Id)
        requestParams["pendingRetryIsRoot"] := true

        ; _persistStreamResponse: root retries use parent NULL regardless of
        ; the current active path.
        isRootRetry := requestParams.Has("pendingRetryIsRoot") && requestParams["pendingRetryIsRoot"]
        if isRootRetry
            requestParams.Delete("pendingRetryIsRoot")
        path := ChatDB.Msg_GetActivePath(threadId)
        parentId := isRootRetry ? "" : (path.Length ? path[path.Length].id : "")
        ChatDB.Msg_Insert({
            thread_id: threadId, role: "assistant", content: "a1 retried",
            parent_id: parentId, sibling_group: sg,
            sibling_index: MessageRepo.GetMaxSiblingIndex(sg) + 1,
            model: "deepseek/deepseek-v4-flash", prompt_tokens: 12, token_count: 9
        })
        newRow := ChatDB.db.Query("SELECT parent_id, sibling_group FROM messages WHERE content='a1 retried';")
        if newRow[1, "parent_id"]
            throw Error("root retry must have parent NULL (not the original a1), got '" newRow[1, "parent_id"] "'")
        sibCount := ChatDB.db.Query("SELECT COUNT(*) AS c FROM messages WHERE sibling_group=?;", newRow[1, "sibling_group"])
        if Integer(sibCount[1, "c"]) != 2
            throw Error("expected 2 messages in the retry sibling group, got " sibCount[1, "c"])
        this._teardown()
    }

    ; Regression (bug #115): GetActivePath/GetTree must escape crafted thread ids
    ; (bug #109's sweep escaped the sibling call sites but missed these two).
    TreeQueries_EscapeCraftedThreadId() {
        this._setup()
        crafted := "bad'thread"
        ChatDB.db.Exec("INSERT INTO chat_threads (id, title) VALUES('bad''thread', 'Crafted');")
        ChatDB.db.Exec("INSERT INTO messages (id, thread_id, role, content) VALUES('bad''m1', 'bad''thread', 'user', 'hi');")
        ChatDB.db.Exec("UPDATE chat_threads SET active_leaf_id='bad''m1' WHERE id='bad''thread';")
        ; A decoy in another thread proves the WHERE clause stays literal.
        otherId := ChatDB.Thread_Create("Other")
        ChatDB.Msg_Insert({thread_id: otherId, role: "user", content: "decoy"})

        path := ChatDB.Msg_GetActivePath(crafted)
        if path.Length != 1 || path[1].id != "bad'm1"
            throw Error("GetActivePath should return only the crafted thread's message, got length=" path.Length " first=" (path.Length ? path[1].id : "none"))
        tree := ChatDB.Msg_GetTree(crafted)
        if tree.Length != 1
            throw Error("GetTree should return only the crafted thread's message, got " tree.Length)
        this._teardown()
    }

    ; --------------------
    ; Msg_Edit
    ; --------------------

    Edit_OverwritesContent() {
        threadId := this._setup()
        id := ChatDB.Msg_Insert({thread_id: threadId, role: "user", content: "original"})
        ChatDB.Msg_Edit(id, "edited")
        path := ChatDB.Msg_GetActivePath(threadId)
        if path[path.Length].content != "edited"
            throw Error("Expected content 'edited', got '" path[path.Length].content "'")
        this._teardown()
    }

    ; Regression (bug #301): ID-based mutations must accept the caller's
    ; expected thread and no-op for stale, foreign, or nonexistent IDs.
    Mutations_RequireExpectedThreadOwnership() {
        threadA := this._setup()
        threadB := ChatDB.Thread_Create("Other Thread")
        aMsg := ChatDB.Msg_Insert({thread_id: threadA, role: "user", content: "A original"})
        bEdit := ChatDB.Msg_Insert({thread_id: threadB, role: "user", content: "B original"})
        bDelete := ChatDB.Msg_Insert({thread_id: threadB, role: "user", content: "B survives"})

        ChatDB.Msg_Edit(bEdit, "B must not change", threadA)
        ChatDB.Msg_HardDelete(bDelete, threadA)
        ChatDB.Msg_Edit("missing-message", "must not insert", threadA)
        ChatDB.Msg_HardDelete("missing-message", threadA)

        bRow := ChatDB.db.Query("SELECT content FROM messages WHERE id=?;", bEdit)
        bDeleteRow := ChatDB.db.Query("SELECT COUNT(*) AS c FROM messages WHERE id=?;", bDelete)
        if bRow[1, "content"] != "B original" || bDeleteRow[1, "c"] != 1
            throw Error("foreign message mutation bypassed expected thread ownership")

        ChatDB.Msg_Edit(aMsg, "A changed legitimately", threadA)
        aRow := ChatDB.db.Query("SELECT content FROM messages WHERE id=?;", aMsg)
        if aRow[1, "content"] != "A changed legitimately"
            throw Error("legitimate owned edit was rejected")
        this._teardown()
    }

    ; Regression (bug #305): a failure during a structural mutation must roll
    ; back its DB writes rather than leaving a partial fork behind.
    Transaction_RollbackRestoresFork() {
        global persistenceFaultStage
        threadId := this._setup()
        userId := ChatDB.Msg_Insert({thread_id: threadId, role: "user", content: "source"})
        ChatDB.Msg_Insert({thread_id: threadId, role: "assistant", content: "answer", parent_id: userId, model: "deepseek/deepseek-v4-flash"})
        persistenceFaultStage := "fork-after-thread"
        threw := false
        try ChatDB.Msg_ForkThread(threadId, userId)
        catch Error
            threw := true
        persistenceFaultStage := ""
        threads := ChatDB.db.Query("SELECT COUNT(*) AS c FROM chat_threads;")
        if !threw || threads[1, "c"] != 1
            throw Error("failed fork must roll back its thread row")
        this._teardown()
    }

    ; Trash lifecycle
    ; --------------------

    Thread_SoftDelete_HidesFromList() {
        threadId := this._setup()
        ChatDB.Thread_SoftDelete(threadId)
        threads := ChatDB.Thread_List()
        for t in threads {
            if t.id = threadId
                throw Error("Soft-deleted thread should not appear in normal list")
        }
        ; Should appear in trash
        trashed := ChatDB.Thread_List(true)
        found := false
        for t in trashed {
            if t.id = threadId
                found := true
        }
        if !found
            throw Error("Soft-deleted thread should appear in trash list")
        this._teardown()
    }

    Thread_Restore_Reappears() {
        threadId := this._setup()
        ChatDB.Thread_SoftDelete(threadId)
        ChatDB.Thread_Restore(threadId)
        threads := ChatDB.Thread_List()
        found := false
        for t in threads {
            if t.id = threadId
                found := true
        }
        if !found
            throw Error("Restored thread should appear in list")
        this._teardown()
    }

    ; ----------------------------------------------------
    ; Regression: Thread_PurgeExpired must permanently delete trashed threads
    ; past the retention period (previously nothing called it, so trash never
    ; auto-purged). Expired threads go; recent ones survive.
    ; ----------------------------------------------------
    Thread_PurgeExpired_DeletesExpiredKeepsRecent() {
        global trashRetentionDays
        oldRetention := trashRetentionDays
        trashRetentionDays := 1
        try {
            this._setup()
            expiredId := ChatDB.Thread_Create("Expired Trash")
            recentId  := ChatDB.Thread_Create("Recent Trash")

            ChatDB.Thread_SoftDelete(expiredId)
            ChatDB.Thread_SoftDelete(recentId)

            ; Age the expired thread past the 1-day retention window.
            ChatDB.db.Exec("UPDATE chat_threads SET deleted_at=datetime('now', '-2 days') WHERE id='" expiredId "';")

            ChatDB.Thread_PurgeExpired()

            recentSurvived := false
            for t in ChatDB.Thread_List(true) {
                if t.id = expiredId
                    throw Error("Expired trashed thread survived PurgeExpired")
                if t.id = recentId
                    recentSurvived := true
            }
            if !recentSurvived
                throw Error("Recent trashed thread was purged before its retention period")
        } finally {
            trashRetentionDays := oldRetention
            this._teardown()
        }
    }

    ; Regression (bug #129): PurgeExpired must also remove the purged messages'
    ; FTS index rows (the raw DELETEs never touch messages_fts).
    Thread_PurgeExpired_RemovesFtsRows() {
        global trashRetentionDays
        oldRetention := trashRetentionDays
        trashRetentionDays := 1
        try {
            this._setup()
            expiredId := ChatDB.Thread_Create("Expired")
            ChatDB.Msg_Insert({thread_id: expiredId, role: "user", content: "expired msg"})
            ChatDB.Thread_SoftDelete(expiredId)
            ChatDB.db.Exec("UPDATE chat_threads SET deleted_at=datetime('now', '-2 days') WHERE id='" expiredId "';")
            ChatDB.Thread_PurgeExpired()
            fts := ChatDB.db.Exec("SELECT COUNT(*) AS c FROM messages_fts;")
            if Integer(fts[1, "c"]) != 0
                throw Error("purge must remove FTS rows (bug #129), got " fts[1, "c"])
        } finally {
            trashRetentionDays := oldRetention
            this._teardown()
        }
    }

    Thread_PurgeExpired_NoExpiredThreadsDoesNotMarkBackupDirty() {
        global trashRetentionDays, gBackupManager
        oldRetention := trashRetentionDays
        hadManager := IsSet(gBackupManager)
        oldManager := hadManager ? gBackupManager : unset
        trashRetentionDays := 30
        try {
            this._setup()
            gBackupManager := BackupManager()
            before := gBackupManager._changeGeneration
            ChatDB.Thread_PurgeExpired()
            if gBackupManager._changeGeneration != before
                throw Error("a no-op purge must not notify the backup manager")
        } finally {
            trashRetentionDays := oldRetention
            if hadManager
                gBackupManager := oldManager
            else
                gBackupManager := unset
            this._teardown()
        }
    }

    Thread_PurgeExpired_ExpiredThreadsMarkBackupDirty() {
        global trashRetentionDays, gBackupManager
        oldRetention := trashRetentionDays
        hadManager := IsSet(gBackupManager)
        oldManager := hadManager ? gBackupManager : unset
        trashRetentionDays := 1
        try {
            this._setup()
            expiredId := ChatDB.Thread_Create("Expired for dirty test")
            ChatDB.Thread_SoftDelete(expiredId)
            ChatDB.db.Query("UPDATE chat_threads SET deleted_at=datetime('now', '-2 days') WHERE id=?;", expiredId)
            gBackupManager := BackupManager()
            before := gBackupManager._changeGeneration
            ChatDB.Thread_PurgeExpired()
            if gBackupManager._changeGeneration <= before
                throw Error("purging an expired thread must notify the backup manager")
        } finally {
            trashRetentionDays := oldRetention
            if hadManager
                gBackupManager := oldManager
            else
                gBackupManager := unset
            this._teardown()
        }
    }

    ; --------------------
    ; Cumulative counter persistence
    ; --------------------

    ; Regression (bug #65): hard-deleting a message must decrement the thread's
    ; cumulative counters (they used to stay stale and forever inflated).
    HardDelete_DecrementsCumulativeCounters() {
        threadId := this._setup()
        ChatDB.Msg_Insert({thread_id: threadId, role: "system", content: "sys"})
        ChatDB.Msg_Insert({thread_id: threadId, role: "user", content: "Hello"})
        a1Id := ChatDB.Msg_Insert({thread_id: threadId, role: "assistant", content: "Hi!", model: "deepseek-v4-flash", token_count: 15, cached_tokens: 0})
        threadRow := ChatDB.db.Exec("SELECT cumulative_output_tokens FROM chat_threads WHERE id='" threadId "';")
        beforeOut := Integer(threadRow[1, "cumulative_output_tokens"])
        if beforeOut != 15
            throw Error("Expected cumulative output 15 before delete, got " beforeOut)

        ChatDB.Msg_HardDelete(a1Id)

        threadRow := ChatDB.db.Exec("SELECT cumulative_input_tokens, cumulative_output_tokens, cumulative_cached_tokens FROM chat_threads WHERE id='" threadId "';")
        afterIn := Integer(threadRow[1, "cumulative_input_tokens"])
        afterOut := Integer(threadRow[1, "cumulative_output_tokens"])
        afterCached := Integer(threadRow[1, "cumulative_cached_tokens"])
        if afterOut != 0
            throw Error("Cumulative output_tokens should drop to 0 after delete, got " afterOut)
        if afterIn != 0 || afterCached != 0
            throw Error("Cumulative input/cached should be 0 after delete, got in=" afterIn " cached=" afterCached)
        this._teardown()
    }

    ; Regression (bug #114): hard-deleting a leaf in a BRANCHED tree must
    ; recompute cumulative counters by tree path (each assistant's stored API
    ; prompt_tokens), not by insertion order - the old running-sum charged
    ; off-path branch messages with the other branch's tokens.
    HardDelete_BranchedTree_RecomputesTreeAccurateCounters() {
        threadId := this._setup()
        u1Id := ChatDB.Msg_Insert({thread_id: threadId, role: "user", content: "first", token_count: 100})
        a1Id := ChatDB.Msg_Insert({thread_id: threadId, role: "assistant", content: "reply A", parent_id: u1Id, model: "deepseek/deepseek-v4-flash", token_count: 50, prompt_tokens: 100})
        u2Id := ChatDB.Msg_Insert({thread_id: threadId, role: "user", content: "follow A", parent_id: a1Id, token_count: 100})
        a2Id := ChatDB.Msg_Insert({thread_id: threadId, role: "assistant", content: "ans A", parent_id: u2Id, model: "deepseek/deepseek-v4-flash", token_count: 50, prompt_tokens: 300})
        u2bId := ChatDB.Msg_Insert({thread_id: threadId, role: "user", content: "follow B", parent_id: a1Id, token_count: 100})
        a2bId := ChatDB.Msg_Insert({thread_id: threadId, role: "assistant", content: "ans B", parent_id: u2bId, model: "deepseek/deepseek-v4-flash", token_count: 50, prompt_tokens: 250})
        ChatDB.Msg_SetActiveLeaf(threadId, a2Id)
        ChatDB.Msg_HardDelete(a2Id)
        row := ChatDB.db.Exec("SELECT cumulative_input_tokens, cumulative_output_tokens FROM chat_threads WHERE id='" threadId "';")
        if Integer(row[1, "cumulative_input_tokens"]) != 350
            throw Error("branched-delete recompute input = " row[1, "cumulative_input_tokens"] " (expected tree-accurate 350 = a1 100 + a2b 250)")
        if Integer(row[1, "cumulative_output_tokens"]) != 100
            throw Error("branched-delete recompute output = " row[1, "cumulative_output_tokens"] " (expected 100 = a1 50 + a2b 50)")
        this._teardown()
    }

    ; Regression (bug #114, fallback): legacy rows without stored prompt_tokens
    ; fall back to the parent message's active_path_tokens - the context the
    ; API call actually saw - instead of the rowid running sum.
    HardDelete_BranchedTree_FallsBackToParentContext() {
        threadId := this._setup()
        u1Id := ChatDB.Msg_Insert({thread_id: threadId, role: "user", content: "first", token_count: 100})
        a1Id := ChatDB.Msg_Insert({thread_id: threadId, role: "assistant", content: "reply A", parent_id: u1Id, model: "deepseek/deepseek-v4-flash", token_count: 50})
        u2Id := ChatDB.Msg_Insert({thread_id: threadId, role: "user", content: "follow A", parent_id: a1Id, token_count: 100})
        a2Id := ChatDB.Msg_Insert({thread_id: threadId, role: "assistant", content: "ans A", parent_id: u2Id, model: "deepseek/deepseek-v4-flash", token_count: 50})
        u2bId := ChatDB.Msg_Insert({thread_id: threadId, role: "user", content: "follow B", parent_id: a1Id, token_count: 100})
        a2bId := ChatDB.Msg_Insert({thread_id: threadId, role: "assistant", content: "ans B", parent_id: u2bId, model: "deepseek/deepseek-v4-flash", token_count: 50})
        ChatDB.Msg_SetActiveLeaf(threadId, a2Id)
        ChatDB.Msg_HardDelete(a2Id)
        row := ChatDB.db.Exec("SELECT cumulative_input_tokens, cumulative_output_tokens FROM chat_threads WHERE id='" threadId "';")
        if Integer(row[1, "cumulative_input_tokens"]) != 350
            throw Error("fallback recompute input = " row[1, "cumulative_input_tokens"] " (expected 350 via parent active_path_tokens)")
        if Integer(row[1, "cumulative_output_tokens"]) != 100
            throw Error("fallback recompute output = " row[1, "cumulative_output_tokens"] " (expected 100)")
        this._teardown()
    }

    ; Regression (bug #128): the recompute must NOT count user messages'
    ; backfilled input token_counts as output - only assistant rows carry API
    ; output. Deleting the active leaf leaves a1 (50) + a2b (50) = 100 output.
    HardDelete_DoesNotCountUserInputAsOutput() {
        threadId := this._setup()
        u1Id := ChatDB.Msg_Insert({thread_id: threadId, role: "user", content: "first", token_count: 100, active_path_tokens: 100})
        a1Id := ChatDB.Msg_Insert({thread_id: threadId, role: "assistant", content: "reply A", parent_id: u1Id, model: "deepseek/deepseek-v4-flash", token_count: 50, active_path_tokens: 150})
        u2Id := ChatDB.Msg_Insert({thread_id: threadId, role: "user", content: "follow A", parent_id: a1Id, token_count: 100, active_path_tokens: 250})
        a2Id := ChatDB.Msg_Insert({thread_id: threadId, role: "assistant", content: "ans A", parent_id: u2Id, model: "deepseek/deepseek-v4-flash", token_count: 50, active_path_tokens: 300})
        u2bId := ChatDB.Msg_Insert({thread_id: threadId, role: "user", content: "follow B", parent_id: a1Id, token_count: 100, active_path_tokens: 250})
        a2bId := ChatDB.Msg_Insert({thread_id: threadId, role: "assistant", content: "ans B", parent_id: u2bId, model: "deepseek/deepseek-v4-flash", token_count: 50, active_path_tokens: 300})
        ChatDB.Msg_SetActiveLeaf(threadId, a2Id)
        ChatDB.Msg_HardDelete(a2Id)
        row := ChatDB.db.Exec("SELECT cumulative_output_tokens FROM chat_threads WHERE id='" threadId "';")
        if Integer(row[1, "cumulative_output_tokens"]) != 100
            throw Error("output after branched delete = " row[1, "cumulative_output_tokens"] " (expected 100 = a1 50 + a2b 50; user input token_counts must not count - bug #128)")
        this._teardown()
    }

    Thread_List_EmptyThreadUsesConfiguredModelForBadge() {
        global appDefaultModel, assistants
        threadId := this._setup()
        oldDefault := appDefaultModel
        hadAssistants := IsSet(assistants)
        oldAssistants := hadAssistants ? assistants : ""
        try {
            ChatDB.Thread_UpdateSettings(threadId, { modelOverride: "openai/gpt-5-mini" })
            listed := ChatDB.Thread_List()[1].model
            if listed != "openai/gpt-5-mini"
                throw Error("empty thread badge should use model_override, got '" listed "'")

            assistants := [{ id: "asst-icon", name: "Icon Assistant", baseModel: "anthropic/claude-sonnet-4", systemMessage: "", reasoning: "", temperature: "" }]
            ChatDB.Thread_UpdateSettings(threadId, { assistantId: "asst-icon", modelOverride: "" })
            listedAssistant := ChatDB.Thread_List()[1].model
            if listedAssistant != "anthropic/claude-sonnet-4"
                throw Error("empty assistant thread badge should use assistant base model, got '" listedAssistant "'")

            ChatDB.Thread_UpdateSettings(threadId, { assistantId: "", modelOverride: "" })
            appDefaultModel := "google/gemini-2.5-flash"
            listedDefault := ChatDB.Thread_List()[1].model
            if listedDefault != "google/gemini-2.5-flash"
                throw Error("empty app-default thread badge should use appDefaultModel, got '" listedDefault "'")
        } finally {
            appDefaultModel := oldDefault
            assistants := hadAssistants ? oldAssistants : []
            this._teardown()
        }
    }

    ; Regression (bug #155): Thread_List's per-thread model must follow the
    ; ACTIVE path (the branch currently open), not the LAST-INSERTED assistant
    ; row (which may sit on an off-path branch after a retry/branch switch).
    Thread_List_ModelFollowsActivePath() {
        threadId := this._setup()
        u1Id := ChatDB.Msg_Insert({thread_id: threadId, role: "user", content: "u1"})
        a1Id := ChatDB.Msg_Insert({thread_id: threadId, role: "assistant", content: "a1", parent_id: u1Id, model: "deepseek/deepseek-v4-flash", prompt_tokens: 10, token_count: 5})
        ; Active continuation (branch A) - model X:
        u2Id := ChatDB.Msg_Insert({thread_id: threadId, role: "user", content: "u2A", parent_id: a1Id})
        a2AId := ChatDB.Msg_Insert({thread_id: threadId, role: "assistant", content: "a2A", parent_id: u2Id, model: "openai/gpt-5-mini", prompt_tokens: 20, token_count: 8})
        ; Off-path continuation (branch B) - model Y, inserted LATER:
        u2bId := ChatDB.Msg_Insert({thread_id: threadId, role: "user", content: "u2B", parent_id: a1Id, sibling_group: "sg-155", sibling_index: 1})
        ChatDB.Msg_Insert({thread_id: threadId, role: "assistant", content: "a2B", parent_id: u2bId, model: "google/gemini-2.5-flash", prompt_tokens: 25, token_count: 10})

        ChatDB.Msg_SetActiveLeaf(threadId, a2AId)
        listed := ChatDB.Thread_List()[1].model
        if listed != "openai/gpt-5-mini"
            throw Error("Thread_List badge must follow the ACTIVE path (bug #155): expected openai/gpt-5-mini, got '" listed "'")

        ; Switch to branch B: the badge must follow.
        ChatDB.Msg_SetActiveLeaf(threadId, ChatDB.db.Query("SELECT id FROM messages WHERE content='a2B';").rows[1].id)
        listed2 := ChatDB.Thread_List()[1].model
        if listed2 != "google/gemini-2.5-flash"
            throw Error("Thread_List badge must follow the active path after switching: expected google/gemini-2.5-flash, got '" listed2 "'")
        this._teardown()
    }

    ; Regression (bug #156): overwrite-editing a USER message must refresh its
    ; backfilled token_count (estimated from the new content), so the NEXT
    ; user's backfill subtracts the NEW value instead of the stale one.
    Edit_UserMessage_RefreshesAttribution() {
        threadId := this._setup()
        u1Id := ChatDB.Msg_Insert({thread_id: threadId, role: "user", content: "u1"})
        a1Id := ChatDB.Msg_Insert({thread_id: threadId, role: "assistant", content: "a1", parent_id: u1Id, model: "deepseek/deepseek-v4-flash", prompt_tokens: 12, token_count: 9})
        u2Id := ChatDB.Msg_Insert({thread_id: threadId, role: "user", content: "original follow-up", parent_id: a1Id})
        ChatDB.Msg_Insert({thread_id: threadId, role: "assistant", content: "a2", parent_id: u2Id, model: "deepseek/deepseek-v4-flash", prompt_tokens: 28, token_count: 6})
        u2tc := Integer(ChatDB.db.Query("SELECT token_count FROM messages WHERE id=?;", u2Id)[1, "token_count"])
        if u2tc != 7
            throw Error("setup: u2 should be backfilled to 7 (28-21), got " u2tc)

        ; Overwrite edit to a much longer text (~90 chars -> ~30 tokens):
        newText := "this edited follow-up is now a dramatically longer message with much more text than before"
        ChatDB.Msg_Edit(u2Id, newText)
        u2tcAfter := Integer(ChatDB.db.Query("SELECT token_count FROM messages WHERE id=?;", u2Id)[1, "token_count"])
        if u2tcAfter != 30
            throw Error("edited user message should re-estimate its contribution (bug #156), expected 30, got " u2tcAfter)

        ; Next exchange: prompt for a3 = 12 + 9 + 30 + 6 + 5 = 62.
        u3Id := ChatDB.Msg_Insert({thread_id: threadId, role: "user", content: "u3", parent_id: ChatDB.db.Query("SELECT id FROM messages WHERE content='a2';").rows[1].id})
        ChatDB.Msg_Insert({thread_id: threadId, role: "assistant", content: "a3", parent_id: u3Id, model: "deepseek/deepseek-v4-flash", prompt_tokens: 62, token_count: 5})
        u3tc := Integer(ChatDB.db.Query("SELECT token_count FROM messages WHERE id=?;", u3Id)[1, "token_count"])
        if u3tc != 5
            throw Error("next user backfill should be 5 (62 - 12 - 9 - 30 - 6), got " u3tc)
        this._teardown()
    }

    ; Regression (bug #157): the user-token backfill must ALSO update the user
    ; message's active_path_tokens (parent context + own contribution) - it was
    ; computed at INSERT time with token_count still 0, so forking AT that
    ; message under-reported the fork's Context Used.
    Insert_Backfill_UpdatesActivePathTokens() {
        threadId := this._setup()
        u1Id := ChatDB.Msg_Insert({thread_id: threadId, role: "user", content: "u1"})
        a1Id := ChatDB.Msg_Insert({thread_id: threadId, role: "assistant", content: "a1", parent_id: u1Id, model: "deepseek/deepseek-v4-flash", prompt_tokens: 12, token_count: 9})
        u2Id := ChatDB.Msg_Insert({thread_id: threadId, role: "user", content: "u2", parent_id: a1Id})
        ChatDB.Msg_Insert({thread_id: threadId, role: "assistant", content: "a2", parent_id: u2Id, model: "deepseek/deepseek-v4-flash", prompt_tokens: 30, token_count: 6})
        u2Row := ChatDB.db.Query("SELECT token_count, active_path_tokens FROM messages WHERE id=?;", u2Id)
        if Integer(u2Row[1, "token_count"]) != 9
            throw Error("u2 should be backfilled to 9 (30-21), got " u2Row[1, "token_count"])
        if Integer(u2Row[1, "active_path_tokens"]) != 30
            throw Error("u2 active_path_tokens must include its own contribution (bug #157): expected 30, got " u2Row[1, "active_path_tokens"])
        ; Fork AT u2: the fork's leaf is the u2 copy, so its Context Used must
        ; report the full 30 (previously the stale 21).
        forkId := ChatDB.Msg_ForkThread(threadId, u2Id)
        stats := ChatDB.Msg_GetThreadStats(forkId)
        if Integer(stats.activePathTokens) != 30
            throw Error("fork at u2 must report context 30, got " stats.activePathTokens)
        this._teardown()
    }

    ; --------------------
    ; Msg_Edit active_path_tokens recalculation
    ; --------------------

    Edit_AdjustsActivePathTokens() {
        threadId := this._setup()
        ChatDB.Msg_Insert({thread_id: threadId, role: "system", content: "sys"})
        ChatDB.Msg_Insert({thread_id: threadId, role: "user", content: "Very long original message to edit"})
        aId := ChatDB.Msg_Insert({thread_id: threadId, role: "assistant", content: "response", model: "deepseek-v4-flash", token_count: 10, cached_tokens: 0})
        ; After insert, active_path_tokens = prefix sum (0+0+10=10)
        stats := ChatDB.Msg_GetThreadStats(threadId)
        if stats.activePathTokens != 10
            throw Error("Expected activePathTokens=10 baseline, got " stats.activePathTokens)

        ; Edit the assistant message — _RecomputeActivePath recalculates from token_count (still 10)
        ChatDB.Msg_Edit(aId, "ok")

        stats2 := ChatDB.Msg_GetThreadStats(threadId)
        if stats2.activePathTokens != 1
            throw Error("Expected activePathTokens=1 after edit (re-estimated 1-token assistant), got " stats2.activePathTokens)
        aTc := Integer(ChatDB.db.Query("SELECT token_count FROM messages WHERE id=?;", aId)[1, "token_count"])
        if aTc != 1
            throw Error("edited assistant should re-estimate token_count (bug #181), expected 1, got " aTc)
        this._teardown()
    }

    ; Regression (bug #181): overwrite-editing an ASSISTANT message must
    ; refresh its token_count (estimated from the new content) like the user
    ; path (bug #156) - the assistant's token_count feeds
    ; _BackfillUserTokens' existing_sum, so a stale value makes the NEXT
    ; user's backfill over-count its own contribution.
    Edit_AssistantMessage_RefreshesAttribution() {
        threadId := this._setup()
        u1Id := ChatDB.Msg_Insert({thread_id: threadId, role: "user", content: "u1"})
        a1Id := ChatDB.Msg_Insert({thread_id: threadId, role: "assistant", content: "SHORT", parent_id: u1Id, model: "deepseek/deepseek-v4-flash", prompt_tokens: 12, token_count: 9})
        u2Id := ChatDB.Msg_Insert({thread_id: threadId, role: "user", content: "u2", parent_id: a1Id})
        ChatDB.Msg_Insert({thread_id: threadId, role: "assistant", content: "a2", parent_id: u2Id, model: "deepseek/deepseek-v4-flash", prompt_tokens: 25, token_count: 6})
        ; Overwrite edit to a ~300-char text -> ~100 tokens.
        longText := ""
        loop 300
            longText .= "x"
        ChatDB.Msg_Edit(a1Id, longText)
        a1tc := Integer(ChatDB.db.Query("SELECT token_count FROM messages WHERE id=?;", a1Id)[1, "token_count"])
        if a1tc <= 9
            throw Error("edited assistant should re-estimate token_count (bug #181), got " a1tc)

        ; Next real prompt = 12 + a1tc + 4 + 6 + 5 = 127; the backfill must
        ; give u3 its true contribution 5 (not 127 - 12 - stale 9 - 4 - 6 = 96).
        a2Row := ChatDB.db.Query("SELECT id FROM messages WHERE content='a2';")
        u3Id := ChatDB.Msg_Insert({thread_id: threadId, role: "user", content: "u3", parent_id: a2Row.rows[1].id})
        ChatDB.Msg_Insert({thread_id: threadId, role: "assistant", content: "a3", parent_id: u3Id, model: "deepseek/deepseek-v4-flash", prompt_tokens: 127, token_count: 5})
        u3tc := Integer(ChatDB.db.Query("SELECT token_count FROM messages WHERE id=?;", u3Id)[1, "token_count"])
        if u3tc != 5
            throw Error("next user backfill should be 5 with the refreshed assistant attribution (bug #181), got " u3tc)
        this._teardown()
    }

    ; Regression (bug #194): overwrite-editing an assistant message must
    ; recompute the thread's CUMULATIVE counters too - token_count is
    ; refreshed, so cumulative_output_tokens must follow immediately instead
    ; of staying at the pre-edit value until the next API call.
    Edit_AssistantMessage_RecomputesCumulativeCounters() {
        threadId := this._setup()
        u1Id := ChatDB.Msg_Insert({thread_id: threadId, role: "user", content: "u1"})
        a1Id := ChatDB.Msg_Insert({thread_id: threadId, role: "assistant", content: "SHORT", parent_id: u1Id, model: "deepseek/deepseek-v4-flash", prompt_tokens: 12, token_count: 9})
        before := Integer(ChatDB.db.Query("SELECT cumulative_output_tokens FROM chat_threads WHERE id=?;", threadId)[1, "cumulative_output_tokens"])
        if before != 9
            throw Error("setup: expected cumulative_output=9 before edit, got " before)
        longText := ""
        loop 300
            longText .= "x"
        ChatDB.Msg_Edit(a1Id, longText)
        a1tc := Integer(ChatDB.db.Query("SELECT token_count FROM messages WHERE id=?;", a1Id)[1, "token_count"])
        after := Integer(ChatDB.db.Query("SELECT cumulative_output_tokens FROM chat_threads WHERE id=?;", threadId)[1, "cumulative_output_tokens"])
        if a1tc <= 9
            throw Error("setup: edited assistant token_count should be refreshed (bug #181), got " a1tc)
        if after != 9
            throw Error("assistant edit must preserve historical cumulative output 9, got " after)
        this._teardown()
    }

    ; ----------------------------------------------------
    ; Assistant CRUD tests
    ; ----------------------------------------------------

    ; AssistantRepo.GetFromSettings tests — assistants now come from global array, not DB
    GetFromSettings_ReturnsCorrectAssistant() {
        global assistants
        assistants := [{id: "a1", name: "Test Asst", baseModel: "deepseek/test", isDefault: true}]

        asst := AssistantRepo.GetFromSettings("a1")
        if !asst
            throw Error("GetFromSettings returned empty for valid ID")
        if asst.name != "Test Asst"
            throw Error("GetFromSettings returned wrong name: " asst.name)
        if asst.id != "a1"
            throw Error("GetFromSettings returned wrong ID")
    }

    GetFromSettings_UnknownId_ReturnsEmpty() {
        global assistants
        assistants := [{id: "a1", name: "Test", baseModel: "m", isDefault: true}]

        result := AssistantRepo.GetFromSettings("nonexistent-id")
        if result != ""
            throw Error("Expected empty string for unknown ID, got: " (IsObject(result) ? result.name : String(result)))
    }

    GetFromSettings_UnsetGlobal_ReturnsEmpty() {
        global assistants
        assistants := unset

        result := AssistantRepo.GetFromSettings("any-id")
        if result != ""
            throw Error("Expected empty string when assistants global is unset")
    }

    ; ----------------------------------------------------
    ; Thread settings persistence tests
    ; ----------------------------------------------------

    Thread_UpdateSettings_SavesModelOverride() {
        this._openDb()
        threadId := ChatDB.Thread_Create("Test")

        ChatDB.Thread_UpdateSettings(threadId, { modelOverride: "openai/gpt-4.1" })
        settings := ChatDB.Thread_GetSettings(threadId)

        if !settings || settings.modelOverride != "openai/gpt-4.1"
            throw Error("Expected modelOverride 'openai/gpt-4.1', got: " (settings ? settings.modelOverride : "NULL"))
        this._closeDb()
    }

    Thread_UpdateSettings_ClearsModelOverride() {
        this._openDb()
        threadId := ChatDB.Thread_Create("Test")

        ChatDB.Thread_UpdateSettings(threadId, { modelOverride: "openai/gpt-4.1" })
        ChatDB.Thread_UpdateSettings(threadId, { modelOverride: "" })
        settings := ChatDB.Thread_GetSettings(threadId)

        if settings.modelOverride != ""
            throw Error("Expected empty modelOverride after clear, got: " settings.modelOverride)
        this._closeDb()
    }

    Thread_UpdateSettings_SavesAssistantId() {
        global assistants
        assistants := [{id: "asst-test-1", name: "Test", baseModel: "deepseek/test", isDefault: true}]
        this._openDb()
        threadId := ChatDB.Thread_Create("Test")

        ChatDB.Thread_UpdateSettings(threadId, { assistantId: "asst-test-1" })
        settings := ChatDB.Thread_GetSettings(threadId)

        if !settings || settings.assistantId != "asst-test-1"
            throw Error("Expected assistantId to match, got: " (settings ? settings.assistantId : "NULL"))
        this._closeDb()
    }

    Thread_UpdateSettings_SavesAllFields() {
        this._openDb()
        threadId := ChatDB.Thread_Create("Test")

        ChatDB.Thread_UpdateSettings(threadId, {
            modelOverride: "openai/gpt-4.1",
            systemOverride: "You are helpful",
            reasoningOverride: "none",
            temperatureOverride: 0.7
        })
        settings := ChatDB.Thread_GetSettings(threadId)

        if settings.systemOverride != "You are helpful"
            throw Error("Expected systemOverride, got: " settings.systemOverride)
        if settings.reasoningOverride != "none"
            throw Error("Expected reasoningOverride 'none', got: " settings.reasoningOverride)
        if settings.temperatureOverride != "0.7"
            throw Error("Expected temperatureOverride '0.7', got: " settings.temperatureOverride)
        this._closeDb()
    }

    Thread_GetSettings_EmptyThread_ReturnsEmpty() {
        this._openDb()
        threadId := ChatDB.Thread_Create("Test")

        settings := ChatDB.Thread_GetSettings(threadId)

        if settings.modelOverride || settings.systemOverride || settings.reasoningOverride || settings.temperatureOverride
            throw Error("Expected all overrides to be empty for new thread")
        this._closeDb()
    }

    ; ----------------------------------------------------
    ; Usage_Query — now queries chat_usage table
    ; ----------------------------------------------------

    UsageQuery_AcceptsMapInput() {
        this._openDb()

        ; Populate chat_usage directly (same as real inserts would)
        ChatDB.ChatUsage_Upsert({date: FormatTime(, "yyyy-MM-dd"), model: "deepseek-v4-flash", provider: "deepseek",
            prompt_tokens: 30, completion_tokens: 60, thinking_tokens: 10, thinking_tokens: 0, cached_tokens: 5, input_cost: 0.0000042, cached_input_cost: 0.000000014, output_cost: 0.0000168, total_cost: 0.0000210})

        ChatDB.ChatUsage_Upsert({date: FormatTime(, "yyyy-MM-dd"), model: "deepseek-v4-flash", provider: "deepseek",
            prompt_tokens: 20, completion_tokens: 30, thinking_tokens: 0, thinking_tokens: 0, cached_tokens: 0, input_cost: 0.0000028, output_cost: 0.0000084, total_cost: 0.0000112})

        ; Simulate jsongo.Parse() returning a Map (bracket-only access)
        filters := Map("timeRange", "all", "model", "", "type", "all")
        result := ChatDB.Usage_Query(filters)

        if result.chat.Length = 0
            throw Error("Expected chat rows > 0 with Map input, got " result.chat.Length)
        if result.models.Length = 0
            throw Error("Expected at least 1 model, got " result.models.Length)

        ; Verify chat row has aggregated values: call_count=2, prompt=50, comp=90
        first := result.chat[1]
        if first.input_tokens != 50
            throw Error("Expected input_tokens=50, got " first.input_tokens)
        if first.output_tokens != 90
            throw Error("Expected output_tokens=90, got " first.output_tokens)
        if first.message_count != 2
            throw Error("Expected 2 calls grouped, got " first.message_count)

        this._closeDb()
    }

    UsageQuery_RespectsTimeRangeFilter() {
        this._openDb()

        ; Insert today's chat usage
        ChatDB.ChatUsage_Upsert({date: FormatTime(, "yyyy-MM-dd"), model: "deepseek-v4-flash", provider: "deepseek",
            prompt_tokens: 10, completion_tokens: 20, thinking_tokens: 0, cached_tokens: 0, input_cost: 0.0000014, output_cost: 0.0000056, total_cost: 0.0000070})

        ; "day" filter should return today's data
        filters := Map("timeRange", "day", "model", "", "type", "all")
        result := ChatDB.Usage_Query(filters)
        if result.chat.Length = 0
            throw Error("Expected chat rows with 'day' filter, got 0")

        ; "month" filter should also return today's data
        filtersMonth := Map("timeRange", "month", "model", "", "type", "all")
        resultMonth := ChatDB.Usage_Query(filtersMonth)
        if resultMonth.chat.Length = 0
            throw Error("Expected chat rows with 'month' filter, got 0")

        this._closeDb()
    }

    ; ----------------------------------------------------
    ; chat_usage — ChatUsage_Upsert
    ; ----------------------------------------------------

    ChatUsage_Upsert_InsertsNewRow() {
        this._openDb()
        ChatDB.ChatUsage_Upsert({date: FormatTime(, "yyyy-MM-dd"), model: "deepseek-v4-flash", provider: "deepseek",
            prompt_tokens: 10, completion_tokens: 20, thinking_tokens: 0, thinking_tokens: 0, cached_tokens: 0, input_cost: 0.0000014, output_cost: 0.0000056, total_cost: 0.0000070, response_time_ms: 1200})

        row := ChatDB.db.Exec("SELECT * FROM chat_usage WHERE date='" FormatTime(, "yyyy-MM-dd") "' AND model='deepseek-v4-flash'")
        if row.count != 1
            throw Error("Expected 1 row, got " row.count)
        if Integer(row[1,"call_count"]) != 1
            throw Error("Expected call_count=1, got " row[1,"call_count"])
        if Integer(row[1,"prompt_tokens"]) != 10
            throw Error("Expected prompt_tokens=10, got " row[1,"prompt_tokens"])
        this._closeDb()
    }

    ChatUsage_Upsert_UpdatesExistingRow() {
        this._openDb()
        date := FormatTime(, "yyyy-MM-dd")
        ChatDB.ChatUsage_Upsert({date: date, model: "deepseek-v4-flash", provider: "deepseek",
            prompt_tokens: 10, completion_tokens: 20, thinking_tokens: 0, cached_tokens: 0, input_cost: 0.0000014, output_cost: 0.0000056, total_cost: 0.0000070})
        ChatDB.ChatUsage_Upsert({date: date, model: "deepseek-v4-flash", provider: "deepseek",
            prompt_tokens: 15, completion_tokens: 25, thinking_tokens: 0, cached_tokens: 5, input_cost: 0.0000021, cached_input_cost: 0.000000014, output_cost: 0.0000070, total_cost: 0.0000091})

        row := ChatDB.db.Exec("SELECT * FROM chat_usage WHERE date='" date "' AND model='deepseek-v4-flash'")
        if row.count != 1
            throw Error("Expected 1 row (UPSERT), got " row.count)
        if Integer(row[1,"call_count"]) != 2
            throw Error("Expected call_count=2, got " row[1,"call_count"])
        if Integer(row[1,"prompt_tokens"]) != 25
            throw Error("Expected prompt_tokens=25, got " row[1,"prompt_tokens"])
        if Integer(row[1,"completion_tokens"]) != 45
            throw Error("Expected completion_tokens=45, got " row[1,"completion_tokens"])
        this._closeDb()
    }

    ChatUsage_Upsert_TracksCachedInputCost() {
        this._openDb()
        ChatDB.ChatUsage_Upsert({date: FormatTime(, "yyyy-MM-dd"), model: "deepseek-v4-flash", provider: "deepseek",
            prompt_tokens: 100, completion_tokens: 50, thinking_tokens: 0, cached_tokens: 40, input_cost: 0.000014, cached_input_cost: 0.000000112, output_cost: 0.000014, total_cost: 0.000028})

        row := ChatDB.db.Exec("SELECT * FROM chat_usage WHERE date='" FormatTime(, "yyyy-MM-dd") "' AND model='deepseek-v4-flash'")
        if Number(row[1,"cached_input_cost"]) != 0.000000112
            throw Error("Expected cached_input_cost=0.000000112, got " row[1,"cached_input_cost"])
        if Number(row[1,"input_cost"]) != 0.000014
            throw Error("Expected input_cost=0.000014, got " row[1,"input_cost"])
        this._closeDb()
    }

    ; ----------------------------------------------------
    ; Usage_Query — type filter
    ; ----------------------------------------------------

    UsageQuery_TypeFilter_ChatOnly() {
        this._openDb()
        ChatDB.ChatUsage_Upsert({date: FormatTime(, "yyyy-MM-dd"), model: "deepseek-v4-flash", provider: "deepseek",
            prompt_tokens: 10, completion_tokens: 20, thinking_tokens: 0, cached_tokens: 0, input_cost: 0.0000014, output_cost: 0.0000056, total_cost: 0.0000070})
        ChatDB.CommandUsage_Upsert({date: FormatTime(, "yyyy-MM-dd"), model: "deepseek-v4-flash", provider: "deepseek", command_name: "Refine",
            prompt_tokens: 50, completion_tokens: 30, thinking_tokens: 0, cached_tokens: 0, input_cost: 0.000007, output_cost: 0.0000084, total_cost: 0.0000154})

        filters := Map("timeRange", "all", "model", "", "type", "chat")
        result := ChatDB.Usage_Query(filters)
        if result.chat.Length != 1
            throw Error("Expected 1 chat row with type=chat, got " result.chat.Length)
        if result.commands.Length != 0
            throw Error("Expected 0 command rows with type=chat, got " result.commands.Length)
        this._closeDb()
    }

    UsageQuery_TypeFilter_CommandOnly() {
        this._openDb()
        ChatDB.ChatUsage_Upsert({date: FormatTime(, "yyyy-MM-dd"), model: "deepseek-v4-flash", provider: "deepseek",
            prompt_tokens: 10, completion_tokens: 20, thinking_tokens: 0, cached_tokens: 0, input_cost: 0.0000014, output_cost: 0.0000056, total_cost: 0.0000070})
        ChatDB.CommandUsage_Upsert({date: FormatTime(, "yyyy-MM-dd"), model: "deepseek-v4-flash", provider: "deepseek", command_name: "Refine",
            prompt_tokens: 50, completion_tokens: 30, thinking_tokens: 0, cached_tokens: 0, input_cost: 0.000007, output_cost: 0.0000084, total_cost: 0.0000154})

        filters := Map("timeRange", "all", "model", "", "type", "command")
        result := ChatDB.Usage_Query(filters)
        if result.chat.Length != 0
            throw Error("Expected 0 chat rows with type=command, got " result.chat.Length)
        if result.commands.Length != 1
            throw Error("Expected 1 command row with type=command, got " result.commands.Length)
        this._closeDb()
    }

    UsageQuery_ProviderFilter_ChatOnly() {
        this._openDb()
        ChatDB.ChatUsage_Upsert({date: FormatTime(, "yyyy-MM-dd"), model: "deepseek/deepseek-v4-flash", provider: "deepseek",
            prompt_tokens: 10, completion_tokens: 20, thinking_tokens: 0, cached_tokens: 0, input_cost: 0.0000014, output_cost: 0.0000056, total_cost: 0.0000070})
        ChatDB.ChatUsage_Upsert({date: FormatTime(, "yyyy-MM-dd"), model: "google/gemini-2.5-flash", provider: "google",
            prompt_tokens: 30, completion_tokens: 40, thinking_tokens: 0, cached_tokens: 0, input_cost: 0.000009, output_cost: 0.000100, total_cost: 0.000109})

        filters := Map("timeRange", "all", "model", "", "provider", "deepseek", "type", "all")
        result := ChatDB.Usage_Query(filters)
        if result.chat.Length != 1
            throw Error("Expected 1 chat row with provider=deepseek, got " result.chat.Length)
        if result.chat[1].input_tokens != 10
            throw Error("Expected deepseek input_tokens=10, got " result.chat[1].input_tokens)
        this._closeDb()
    }

    ; ----------------------------------------------------
    ; chat_usage — TTFT tracking
    ; ----------------------------------------------------

    ChatUsage_Upsert_TracksTTFT() {
        this._openDb()
        date := FormatTime(, "yyyy-MM-dd")
        ; Insert with ttft_ms — should persist to total_ttft_ms
        ChatDB.ChatUsage_Upsert({date: date, model: "deepseek-v4-flash", provider: "deepseek",
            prompt_tokens: 10, completion_tokens: 20, thinking_tokens: 0, cached_tokens: 0,
            input_cost: 0.0000014, output_cost: 0.0000056, total_cost: 0.0000070,
            response_time_ms: 1200, ttft_ms: 350})
        row := ChatDB.db.Exec("SELECT total_ttft_ms, call_count FROM chat_usage WHERE date='" date "' AND model='deepseek-v4-flash'")
        if Integer(row[1,"total_ttft_ms"]) != 350
            throw Error("Expected total_ttft_ms=350 on INSERT, got " row[1,"total_ttft_ms"])

        ; Second upsert — should accumulate ttft_ms
        ChatDB.ChatUsage_Upsert({date: date, model: "deepseek-v4-flash", provider: "deepseek",
            prompt_tokens: 5, completion_tokens: 10, thinking_tokens: 0, cached_tokens: 0,
            input_cost: 0.0000007, output_cost: 0.0000028, total_cost: 0.0000035,
            response_time_ms: 800, ttft_ms: 200})
        row2 := ChatDB.db.Exec("SELECT total_ttft_ms, call_count FROM chat_usage WHERE date='" date "' AND model='deepseek-v4-flash'")
        if Integer(row2[1,"total_ttft_ms"]) != 550
            throw Error("Expected total_ttft_ms=550 on UPDATE (350+200), got " row2[1,"total_ttft_ms"])
        if Integer(row2[1,"call_count"]) != 2
            throw Error("Expected call_count=2, got " row2[1,"call_count"])
        this._closeDb()
    }

    ; ----------------------------------------------------
    ; command_usage — TTFT tracking
    ; ----------------------------------------------------

    CommandUsage_Upsert_TracksTTFT() {
        this._openDb()
        date := FormatTime(, "yyyy-MM-dd")
        ; Insert with ttft_ms
        ChatDB.CommandUsage_Upsert({date: date, model: "deepseek-v4-flash", provider: "deepseek", command_name: "Summarize",
            prompt_tokens: 50, completion_tokens: 100, thinking_tokens: 0, cached_tokens: 0,
            input_cost: 0.000007, output_cost: 0.000028, total_cost: 0.000035,
            response_time_ms: 2500, ttft_ms: 800})
        row := ChatDB.db.Exec("SELECT total_ttft_ms FROM command_usage WHERE date='" date "' AND model='deepseek-v4-flash' AND command_name='Summarize'")
        if Integer(row[1,"total_ttft_ms"]) != 800
            throw Error("Expected total_ttft_ms=800, got " row[1,"total_ttft_ms"])

        ; Accumulate
        ChatDB.CommandUsage_Upsert({date: date, model: "deepseek-v4-flash", provider: "deepseek", command_name: "Summarize",
            prompt_tokens: 30, completion_tokens: 50, thinking_tokens: 0, cached_tokens: 0,
            input_cost: 0.0000042, output_cost: 0.000014, total_cost: 0.0000182,
            response_time_ms: 1200, ttft_ms: 400})
        row2 := ChatDB.db.Exec("SELECT total_ttft_ms, call_count FROM command_usage WHERE date='" date "' AND model='deepseek-v4-flash' AND command_name='Summarize'")
        if Integer(row2[1,"total_ttft_ms"]) != 1200
            throw Error("Expected total_ttft_ms=1200 on UPSERT (800+400), got " row2[1,"total_ttft_ms"])
        if Integer(row2[1,"call_count"]) != 2
            throw Error("Expected call_count=2, got " row2[1,"call_count"])
        this._closeDb()
    }

    ; ----------------------------------------------------
    ; Usage_Query — total_ttft_ms in chat results
    ; ----------------------------------------------------

    UsageQuery_IncludesTTFT_Chat() {
        this._openDb()
        ChatDB.ChatUsage_Upsert({date: FormatTime(, "yyyy-MM-dd"), model: "deepseek-v4-flash", provider: "deepseek",
            prompt_tokens: 10, completion_tokens: 20, thinking_tokens: 5, cached_tokens: 0,
            input_cost: 0.0000014, output_cost: 0.0000056, total_cost: 0.0000070,
            response_time_ms: 900, ttft_ms: 300})
        filters := Map("timeRange", "all", "model", "", "type", "all")
        result := ChatDB.Usage_Query(filters)
        if result.chat.Length != 1
            throw Error("Expected 1 chat row, got " result.chat.Length)
        if result.chat[1].total_ttft_ms != 300
            throw Error("Expected total_ttft_ms=300 in query result, got " result.chat[1].total_ttft_ms)
        if result.chat[1].total_response_time_ms != 900
            throw Error("Expected total_response_time_ms=900 in query result, got " result.chat[1].total_response_time_ms)
        this._closeDb()
    }

    ; ----------------------------------------------------
    ; Usage_Query — total_ttft_ms in command results
    ; ----------------------------------------------------

    UsageQuery_IncludesTTFT_Command() {
        this._openDb()
        ChatDB.CommandUsage_Upsert({date: FormatTime(, "yyyy-MM-dd"), model: "deepseek-v4-flash", provider: "deepseek", command_name: "Refine",
            prompt_tokens: 50, completion_tokens: 30, thinking_tokens: 0, cached_tokens: 0,
            input_cost: 0.000007, output_cost: 0.0000084, total_cost: 0.0000154,
            response_time_ms: 1500, ttft_ms: 500})
        filters := Map("timeRange", "all", "model", "", "type", "all")
        result := ChatDB.Usage_Query(filters)
        if result.commands.Length != 1
            throw Error("Expected 1 command row, got " result.commands.Length)
        if result.commands[1].total_ttft_ms != 500
            throw Error("Expected total_ttft_ms=500 in query result, got " result.commands[1].total_ttft_ms)
        this._closeDb()
        ; ----------------------------------------------------
        ; Usage_Query — output_tokens is the total (includes thinking),
        ; so JS must NOT add thinking_tokens again for speed calc.
        ; Bug: dashboard double-counted thinking, inflating tok/s.
        ; ----------------------------------------------------
    
        UsageQuery_OutputTokensIncludesThinking() {
            this._openDb()
            ; completion_tokens=50 is the TOTAL (visible 40 + thinking 10)
            ChatDB.ChatUsage_Upsert({date: FormatTime(, "yyyy-MM-dd"), model: "deepseek-v4-flash", provider: "deepseek",
                prompt_tokens: 100, completion_tokens: 50, thinking_tokens: 10, cached_tokens: 0,
                input_cost: 0.000014, output_cost: 0.000014, total_cost: 0.000028,
                response_time_ms: 500, ttft_ms: 150})
            filters := Map("timeRange", "all", "model", "", "type", "all")
            result := ChatDB.Usage_Query(filters)
            ; output_tokens = completion_tokens = 50 (already includes the 10 thinking tokens)
            if result.chat[1].output_tokens != 50
                throw Error("Expected output_tokens=50 (total completion), got " result.chat[1].output_tokens)
            ; thinking_tokens is separate metadata — adding it again would double-count
            if result.chat[1].thinking_tokens != 10
                throw Error("Expected thinking_tokens=10, got " result.chat[1].thinking_tokens)
            ; The correct output for speed = output_tokens (50), NOT output_tokens + thinking_tokens (60)
            this._closeDb()
        }
    
    }

    ; ----------------------------------------------------
    ; chat_usage — TTFT defaults to 0 when not provided
    ; ----------------------------------------------------

    ChatUsage_Upsert_TTFT_DefaultsToZero() {
        this._openDb()
        date := FormatTime(, "yyyy-MM-dd")
        ; Insert without ttft_ms — should default to 0
        ChatDB.ChatUsage_Upsert({date: date, model: "deepseek-v4-flash", provider: "deepseek",
            prompt_tokens: 10, completion_tokens: 20, thinking_tokens: 0, cached_tokens: 0,
            input_cost: 0.0000014, output_cost: 0.0000056, total_cost: 0.0000070,
            response_time_ms: 500})
        row := ChatDB.db.Exec("SELECT total_ttft_ms FROM chat_usage WHERE date='" date "' AND model='deepseek-v4-flash'")
        if Integer(row[1,"total_ttft_ms"]) != 0
            throw Error("Expected total_ttft_ms=0 when not provided, got " row[1,"total_ttft_ms"])
        this._closeDb()
    }

    ; ----------------------------------------------------
    ; SearchMessages — full-text message search
    ; ----------------------------------------------------

    SearchMessages_MatchesContent() {
        threadId := this._setup()
        ChatDB.Msg_Insert({thread_id: threadId, role: "user", content: "hello world testing"})
        ChatDB.Msg_Insert({thread_id: threadId, role: "assistant", content: "response here"})
        results := ChatDB.SearchMessages("hello", threadId)
        if results.Length != 1
            throw Error("Expected 1 match for 'hello', got " results.Length)
        if results[1].messageId = ""
            throw Error("Expected non-empty messageId")
        if results[1].role != "user"
            throw Error("Expected role 'user', got '" results[1].role "'")
        if results[1].contentPreview != "hello world testing"
            throw Error("Expected contentPreview 'hello world testing', got '" results[1].contentPreview "'")
        if results[1].threadTitle != "Test Thread"
            throw Error("Expected threadTitle 'Test Thread', got '" results[1].threadTitle "'")
        this._teardown()
    }

    SearchMessages_NoMatches() {
        threadId := this._setup()
        ChatDB.Msg_Insert({thread_id: threadId, role: "user", content: "hello"})
        results := ChatDB.SearchMessages("xyznonexistent", threadId)
        if results.Length != 0
            throw Error("Expected 0 matches for nonexistent term, got " results.Length)
        this._teardown()
    }

    SearchMessages_ScopedToThread() {
        this._openDb()
        thread1 := ChatDB.Thread_Create("Thread 1")
        thread2 := ChatDB.Thread_Create("Thread 2")
        ChatDB.Msg_Insert({thread_id: thread1, role: "user", content: "unique phrase alpha"})
        ChatDB.Msg_Insert({thread_id: thread2, role: "user", content: "completely different beta"})

        ; Scoped to thread1 — should only find thread1's message
        results := ChatDB.SearchMessages("unique", thread1)
        if results.Length != 1
            throw Error("Expected 1 match scoped to thread1, got " results.Length)
        if results[1].threadId != thread1
            throw Error("Expected threadId to be thread1, got " results[1].threadId)

        ; Scoped to thread2 — should NOT find thread1's message
        results2 := ChatDB.SearchMessages("unique", thread2)
        if results2.Length != 0
            throw Error("Expected 0 matches for 'unique' scoped to thread2, got " results2.Length)

        ; Unscoped (global) — should find the message from thread1
        results3 := ChatDB.SearchMessages("unique")
        if results3.Length != 1
            throw Error("Expected 1 global match for 'unique', got " results3.Length)

        ChatDB.Thread_Delete(thread1)
        ChatDB.Thread_Delete(thread2)
        this._closeDb()
    }

    SearchMessages_ExcludesDeletedThreads() {
        this._openDb()
        thread1 := ChatDB.Thread_Create("Active Thread")
        thread2 := ChatDB.Thread_Create("Deleted Thread")
        ChatDB.Msg_Insert({thread_id: thread1, role: "user", content: "visible message"})
        ChatDB.Msg_Insert({thread_id: thread2, role: "user", content: "hidden message"})

        ; Before soft-delete — both visible
        results := ChatDB.SearchMessages("message")
        if results.Length != 2
            throw Error("Expected 2 matches before delete, got " results.Length)

        ; Soft-delete thread2
        ChatDB.Thread_SoftDelete(thread2)

        ; After soft-delete — only thread1 visible
        results2 := ChatDB.SearchMessages("message")
        if results2.Length != 1
            throw Error("Expected 1 match after delete (deleted thread excluded), got " results2.Length)
        if results2[1].threadId != thread1
            throw Error("Expected remaining result from active thread, got threadId=" results2[1].threadId)

        ChatDB.Thread_Delete(thread1)
        ChatDB.Thread_Delete(thread2)
        this._closeDb()
    }

    SearchMessages_SafeWithSpecialCharacters() {
        threadId := this._setup()
        ; Insert message with SQL-significant chars in content (but search term is safe due to SQLite.Escape)
        ChatDB.Msg_Insert({thread_id: threadId, role: "user", content: "test with apostrophe's and quotes"})
        ; Search for a term containing apostrophe — should be safe due to SQLite.Escape
        results := ChatDB.SearchMessages("apostrophe's", threadId)
        if results.Length != 1
            throw Error("Expected 1 match for term with apostrophe, got " results.Length)
        ; Search for % sign — SQL LIKE wildcard, should be escaped
        ChatDB.Msg_Insert({thread_id: threadId, role: "user", content: "50% discount"})
        results2 := ChatDB.SearchMessages("50%", threadId)
        if results2.Length != 1
            throw Error("Expected 1 match for term with percent sign, got " results2.Length)
        this._teardown()
    }

    SearchMessages_LimitEnforced() {
        this._openDb()
        threadId := ChatDB.Thread_Create("Bulk Thread")
        ; Insert 25 messages with the same keyword
        loop 25 {
            ChatDB.Msg_Insert({thread_id: threadId, role: "user", content: "keyword match " A_Index})
        }
        results := ChatDB.SearchMessages("keyword", threadId)
        if results.Length > 20
            throw Error("Expected at most 20 results (LIMIT), got " results.Length)
        if results.Length < 2
            throw Error("Expected at least some results, got " results.Length)
        ChatDB.Thread_Delete(threadId)
        this._closeDb()
    }

    ; Case-insensitive: SQLite LIKE is case-insensitive for ASCII by default
    SearchMessages_CaseInsensitive() {
        threadId := this._setup()
        ChatDB.Msg_Insert({thread_id: threadId, role: "user", content: "This is an Error message"})
        ; Search in uppercase — FTS5 matches case-insensitively
        results := ChatDB.SearchMessages("ERROR", threadId)
        if results.Length != 1
            throw Error("Expected 1 case-insensitive match for 'ERROR', got " results.Length)
        ; Search in mixed case
        results2 := ChatDB.SearchMessages("ErRoR", threadId)
        if results2.Length != 1
            throw Error("Expected 1 match for mixed-case 'ErRoR', got " results2.Length)
        this._teardown()
    }

    ; Substring match: LIKE finds mid-word substrings
    SearchMessages_Substring() {
        threadId := this._setup()
        ; "err" is a substring of "error" — LIKE finds it
        ChatDB.Msg_Insert({thread_id: threadId, role: "user", content: "error occurred"})
        results := ChatDB.SearchMessages("err", threadId)
        if results.Length != 1
            throw Error("Expected 1 LIKE fallback match for substring 'err', got " results.Length)
        this._teardown()
    }

    ; Title search: global (un-scoped) search also matches thread titles
    SearchMessages_TitleMatch() {
        this._openDb()
        threadId := ChatDB.Thread_Create("Python Debugging Guide")
        ChatDB.Msg_Insert({thread_id: threadId, role: "user", content: "how do I fix this bug"})

        ; Search for "Python" — title matches, but no message content has "Python"
        results := ChatDB.SearchMessages("Python")
        ; Should find at least the title match
        found := false
        for r in results {
            if r.threadId = threadId && r.messageId = ""
                found := true
        if !found
            throw Error("Expected title match for 'Python' in 'Python Debugging Guide'")
        ; Title result should have empty messageId and role='system'
        for r in results {
            if r.threadId = threadId && r.messageId = "" {
                if r.role != "system"
                    throw Error("Expected title result role='system', got '" r.role "'")
                if r.threadTitle != "Python Debugging Guide"
                    throw Error("Expected threadTitle 'Python Debugging Guide', got '" r.threadTitle "'")
            }
        }

        ChatDB.Thread_Delete(threadId)
        this._closeDb()
    }

    ; Regression: _WalkToLeaf finds the branch leaf, not the given message itself.
    ; When navigateToMessage is called with a user message that has assistant
    ; children, the active leaf must be the last child, not the user message.
    NavigateToMessage_WalksToLeaf() {
        threadId := this._setup()
        uId := ChatDB.Msg_Insert({thread_id: threadId, role: "user", content: "hello"})
        aId := ChatDB.Msg_Insert({thread_id: threadId, role: "assistant", content: "response", parent_id: uId})

        ; Walk from user message — should find assistant as the leaf
        leafId := TreeRepo._WalkToLeaf(uId)
        if leafId != aId
            throw Error("Expected _WalkToLeaf to find assistant (" aId ") as leaf, got " leafId)

        ; Walk from assistant — should return itself (no children)
        leafId2 := TreeRepo._WalkToLeaf(aId)
        if leafId2 != aId
            throw Error("Expected _WalkToLeaf to return assistant itself, got " leafId2)

        ; Set active leaf and verify path includes both messages
        ChatDB.Msg_SetActiveLeaf(threadId, leafId)
        path := ChatDB.Msg_GetActivePath(threadId)
        if path.Length != 2
            throw Error("Expected path length 2 after navigating to user message, got " path.Length)
        if path[1].role != "user" || path[2].role != "assistant"
            throw Error("Expected path: [user, assistant], got: [" path[1].role ", " path[2].role "]")

        this._teardown()

    ; Regression (bug #55): _WalkToLeaf must descend to the NEWEST continuation
    ; (the leaf the tree modal's _findDefaultLeaf picks), not the oldest child.
    WalkToLeaf_PicksNewestContinuation() {
        threadId := this._setup()
        uId := ChatDB.Msg_Insert({thread_id: threadId, role: "user", content: "hello"})
        aId := ChatDB.Msg_Insert({thread_id: threadId, role: "assistant", content: "response", parent_id: uId})
        oldId := ChatDB.Msg_Insert({thread_id: threadId, role: "user", content: "old follow-up", parent_id: aId})
        oldLeaf := ChatDB.Msg_Insert({thread_id: threadId, role: "assistant", content: "old answer", parent_id: oldId})
        newId := ChatDB.Msg_Insert({thread_id: threadId, role: "user", content: "new follow-up", parent_id: aId})
        newLeaf := ChatDB.Msg_Insert({thread_id: threadId, role: "assistant", content: "new answer", parent_id: newId})

        leafId := TreeRepo._WalkToLeaf(aId)
        if leafId != newLeaf
            throw Error("Expected _WalkToLeaf to pick the NEWEST continuation (" newLeaf "), got " leafId)

        ChatDB.Thread_Delete(threadId)
        this._teardown()
    }

    ; Regression (bug #148): _WalkToLeaf must descend to the NEWEST retry - the
    ; continuation with the HIGHEST sibling_index (original 0, retries 1, 2,
    ; ...), not the ORIGINAL answer.
    WalkToLeaf_PicksNewestRetrySibling() {
        threadId := this._setup()
        u1Id := ChatDB.Msg_Insert({thread_id: threadId, role: "user", content: "root"})
        a1Id := ChatDB.Msg_Insert({thread_id: threadId, role: "assistant", content: "a1", parent_id: u1Id})
        u2Id := ChatDB.Msg_Insert({thread_id: threadId, role: "user", content: "needle", parent_id: a1Id})
        original := ChatDB.Msg_Insert({thread_id: threadId, role: "assistant", content: "original answer", parent_id: u2Id, sibling_group: "sg-148", sibling_index: 0})
        retry := ChatDB.Msg_Insert({thread_id: threadId, role: "assistant", content: "retried answer (newest)", parent_id: u2Id, sibling_group: "sg-148", sibling_index: 1})
        leafId := TreeRepo._WalkToLeaf(u2Id)
        if leafId != retry
            throw Error("Expected _WalkToLeaf to pick the NEWEST retry (" retry "), got " leafId)
        this._teardown()
    }

        ; Verify FTS5 works independently (not just LIKE fallback).
        ; FTS5 finds whole-word matches; LIKE finds substrings.
        ; Test: search for a whole word → FTS5 should find it.
        ; Then search for a substring → LIKE fallback should find it.
    SearchMessages_FTS5_DirectMatch() {
            threadId := this._setup()
            ChatDB.Msg_Insert({thread_id: threadId, role: "user", content: "the zebra crossed the road"})
    
            ; Whole-word search — FTS5 should find "zebra"
            results := ChatDB.SearchMessages("zebra", threadId)
            if results.Length != 1
                throw Error("Expected 1 FTS5 match for whole word 'zebra', got " results.Length)
    
            ; Substring search — LIKE fallback should find "oss" in "crossed"
            results2 := ChatDB.SearchMessages("oss", threadId)
            if results2.Length != 1
                throw Error("Expected 1 LIKE fallback match for substring 'oss', got " results2.Length)
    
        this._teardown()
    }

        ; Regression: FTS5 MATCH must use proper quoting ('term' not bare term).
        ; SQLite.Escape escapes internal quotes but does NOT wrap in quotes.
        ; If we used SQLite.Escape directly, MATCH would see bare words as column names.
        SearchMessages_FTS5_WithApostrophe() {
            threadId := this._setup()
            ; Content with apostrophe: "user's" — FTS5 should match the word
            ChatDB.Msg_Insert({thread_id: threadId, role: "user", content: "the user's input was helpful"})
    
            ; Search for "user's" — FTS5 tokenizes on apostrophe, matches "user"
            results := ChatDB.SearchMessages("user", threadId)
            if results.Length != 1
                throw Error("Expected 1 FTS5 match for 'user' in 'user''s', got " results.Length)
    
            ; Search for exact word "input" — should definitely match
            results2 := ChatDB.SearchMessages("input", threadId)
            if results2.Length != 1
                throw Error("Expected 1 FTS5 match for 'input', got " results2.Length)
    
            this._teardown()
        }

        ; Regression: FTS5 sync must handle content with single quotes.
        ; SQLite.Escape doubles internal quotes (' → '') but does NOT wrap in quotes.
        ; The caller must add wrapping quotes: '" SQLite.Escape(val) "'
        SearchMessages_FTS5_SyncWithQuotes() {
            threadId := this._setup()
            ; Content with apostrophe/single quote — must survive FTS sync round-trip
            ChatDB.Msg_Insert({thread_id: threadId, role: "user", content: "it's working"})
            ChatDB.Msg_Insert({thread_id: threadId, role: "assistant", content: "don't panic"})
    
            ; FTS5 should find "it's" content (tokenized as "it" and "s")
            results := ChatDB.SearchMessages("working", threadId)
            if results.Length != 1
                throw Error("Expected 1 FTS5 match for 'working' after quote content sync, got " results.Length)
    
            ; FTS5 should find "don't" content
            results2 := ChatDB.SearchMessages("panic", threadId)
            if results2.Length != 1
                throw Error("Expected 1 FTS5 match for 'panic' after quote content sync, got " results2.Length)
    
            this._teardown()
        }
    
    }
    
    }

}

; Query-counting proxy used by ThreadList_QueryCountIsBounded (bug #180) to
; prove Thread_List does not issue per-thread queries.
class ThreadListQueryCounter {
    count := 0
    real := ""
    Exec(statement, args*) {
        this.count++
        return this.real.Exec(statement, args*)
    }
    Query(statement, args*) {
        this.count++
        return this.real.Query(statement, args*)
    }
}
