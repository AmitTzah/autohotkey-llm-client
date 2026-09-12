; ======================================================
; SearchToolExecutor.test.ahk — web_search tool execution + follow-up staging
; ======================================================

class SearchToolExecutorTest {

    static __New() {
        RegisterTestClass("SearchToolExecutorTest")
    }

    _setupDb() {
        if ChatDB.isOpen {
            oldPath := ChatDB.dbPath
            ChatDB.Close()
            try FileDelete(oldPath)
        }
        ChatDB.Open(A_Temp "\test_ste_" A_TickCount "_" Random(1000, 999999) ".db")
    }

    _teardownDb() {
        if ChatDB.isOpen {
            dbPath := ChatDB.dbPath
            ChatDB.Close()
            try FileDelete(dbPath)
        }
    }

    Execute_BuildsAssistantAndToolMessages() {
        providerInfo := { providerKey: "openai", modelName: "gpt-5-mini", apiKey: "k", endpoint: "http://x/chat/completions" }
        toolCalls := [{
            id: "call_1",
            name: "web_search",
            arguments: "{`"query`":`"latest news`"}"
        }]
        ; Inject a test runner so no network call happens in the unit test.
        exec := SearchToolExecutor.Execute(toolCalls, providerInfo, (q) => "answer for " . q)

        if exec.toolMessages.Length != 2
            throw Error("expected assistant + tool messages, got " exec.toolMessages.Length)
        asst := exec.toolMessages[1]
        toolMsg := exec.toolMessages[2]
        if asst.role != "assistant" || asst.tool_calls.Length != 1
            throw Error("assistant tool_calls message wrong")
        if asst.tool_calls[1].function.name != "web_search" || asst.tool_calls[1].id != "call_1"
            throw Error("tool call payload wrong")
        if toolMsg.role != "tool" || toolMsg.tool_call_id != "call_1"
            throw Error("tool result message wrong")
        if !InStr(toolMsg.content, "answer for latest news")
            throw Error("tool result missing injected answer: " toolMsg.content)
        if !InStr(exec.contextText, "[Web search: latest news]")
            throw Error("context text missing marker: " exec.contextText)
    }

    Execute_UnknownTool_ReturnsErrorResult() {
        providerInfo := { providerKey: "openai", modelName: "gpt-5-mini", apiKey: "k", endpoint: "http://x/chat/completions" }
        toolCalls := [{ id: "call_x", name: "delete_all_files", arguments: "{}" }]
        exec := SearchToolExecutor.Execute(toolCalls, providerInfo)
        if !InStr(exec.toolMessages[2].content, "not available")
            throw Error("expected unavailable-tool error: " exec.toolMessages[2].content)
        if exec.successCount != 0
            throw Error("unknown tool must not count as a successful search")
        if InStr(exec.failureText, "not available") = 0
            throw Error("unknown tool failureText wrong: '" exec.failureText "'")
    }

    ; A round where EVERY search fails must stop the tool loop - Execute
    ; reports successCount 0 + the first failure text so the caller skips the
    ; follow-up request (real-API report 2026-08-16: four failed search cards
    ; in a row before the model gave up).
    Execute_AllSearchesFailed_ReportsZeroSuccess() {
        providerInfo := { providerKey: "openai", modelName: "gpt-5-mini", apiKey: "k", endpoint: "http://x/chat/completions" }
        toolCalls := [{
            id: "call_1",
            name: "web_search",
            arguments: "{`"query`":`"q1`"}"
        }]
        exec := SearchToolExecutor.Execute(toolCalls, providerInfo, (q) => "Web search failed: no answer.")
        if exec.successCount != 0
            throw Error("expected 0 successes, got " exec.successCount)
        if exec.failureText != "Web search failed: no answer."
            throw Error("failureText wrong: '" exec.failureText "'")
    }

    ; A round with one success and one failure still continues the loop (the
    ; model sees both tool messages and may legitimately answer or rephrase).
    Execute_PartialSuccess_ReportsSuccessCount() {
        providerInfo := { providerKey: "openai", modelName: "gpt-5-mini", apiKey: "k", endpoint: "http://x/chat/completions" }
        toolCalls := [{
            id: "call_1",
            name: "web_search",
            arguments: "{`"query`":`"q1`"}"
        }, {
            id: "call_2",
            name: "web_search",
            arguments: "{`"query`":`"q2`"}"
        }]
        exec := SearchToolExecutor.Execute(toolCalls, providerInfo, (q) => q = "q1" ? "answer for q1" : "Web search failed: nope")
        if exec.successCount != 1
            throw Error("expected 1 success, got " exec.successCount)
        if exec.failureText != "Web search failed: nope"
            throw Error("failureText wrong: '" exec.failureText "'")
        if !InStr(exec.toolMessages[2].content, "answer for q1") || !InStr(exec.toolMessages[3].content, "Web search failed: nope")
            throw Error("tool messages must carry both the success and the failure")
    }

    Execute_IndependentLoopStates_DoNotShareToolMessages() {
        providerInfo := { providerKey: "openai", modelName: "gpt-5-mini", apiKey: "k", endpoint: "http://x/chat/completions" }
        stateA := SearchToolExecutor.NewLoopState("thread-a", "parent-a", Map(), 0)
        stateB := SearchToolExecutor.NewLoopState("thread-b", "parent-b", Map(), 0)
        calls := [{ id: "a", name: "web_search", arguments: "{`"query`":`"A`"}" }]
        execA := SearchToolExecutor.Execute(calls, providerInfo, (q) => "answer A", "", stateA)
        SearchToolExecutor.QueueFollowUp(execA, "", "", 1, stateA)
        if stateB.toolMessages.Length || stateB.contextIds.Length || stateB.params.Has("_pendingToolMessages")
            throw Error("thread B received thread A tool-loop state")
        if !stateA.params.Has("_pendingToolMessages") || stateA.params["_pendingToolMessages"].Length != 2
            throw Error("thread A did not retain its own staged tool exchange")
    }

    NewLoopState_CarriesIterationAndAllPriorContextIds() {
        params := Map()
        params["_toolLoopCount"] := 2
        params["_pendingSearchContextIds"] := ["ctx-a", "ctx-b", "ctx-a"]
        params["_requestPath"] := [{ id: "leaf-a" }]
        state := SearchToolExecutor.NewLoopState("thread-a", "parent-a", params, 0)
        if state.loopCount != 2
            throw Error("non-stream loop count was reset instead of carried forward")
        if state.contextIds.Length != 2 || state.contextIds[1] != "ctx-a" || state.contextIds[2] != "ctx-b"
            throw Error("prior search context IDs were not restored uniquely: " jsongo.Stringify(state.contextIds))
        if state.requestPath.Length != 1 || state.requestPath[1].id != "leaf-a"
            throw Error("request path was not carried with the loop state")
    }

    MaxIterationsReached_UsesBoundedSixtyRoundCeiling() {
        if SearchTools.MAX_TOOL_ITERATIONS != 60
            throw Error("expected bounded web-search ceiling of 60, got " SearchTools.MAX_TOOL_ITERATIONS)
        if SearchToolExecutor.MaxIterationsReached(60)
            throw Error("round 60 must still be allowed")
        if !SearchToolExecutor.MaxIterationsReached(61)
            throw Error("round 61 must terminate the tool loop")
    }

    QueueFollowUp_InsertsContextAndStagesMessages() {
        global requestParams, activeThreadId
        this._setupDb()
        ChatDB.Thread_Create("Queue")
        threads := ChatDB.Thread_List()
        activeThreadId := threads[threads.Length].id
        u1Id := ChatDB.Msg_Insert({ thread_id: activeThreadId, role: "user", content: "q" })

        requestParams := Map()
        loopState := SearchToolExecutor.NewLoopState(activeThreadId, u1Id, requestParams, 0)
        exec := {
            toolMessages: [{ role: "assistant", content: "", tool_calls: [] }],
            contextText: "[Web search: x]`n`nresults"
        }
        ctxId := SearchToolExecutor.QueueFollowUp(exec, activeThreadId, u1Id, 1, loopState)
        if !ctxId
            throw Error("expected a context message id")
        path := ChatDB.Msg_GetActivePath(activeThreadId)
        if path.Length != 2 || path[2].role != "user" || path[2].id != ctxId
            throw Error("search context not chained after the user message")
        if loopState.loopCount != 1
            throw Error("tool loop count not staged")
        if loopState.toolMessages.Length != 1
            throw Error("pending tool messages not staged")
        if loopState.contextIds.Length != 1 || loopState.contextIds[1] != ctxId
            throw Error("search context id not tracked for canonical ordering: " jsongo.Stringify(loopState.contextIds))

        activeThreadId := ""
        this._teardownDb()
    }

    ; The search round stages a "Searching…" placeholder FIRST (so the UI
    ; shows the query immediately), then QueueFollowUp EDITS that same row to
    ; the real result - one card per round, updated in place.
    PrepareFollowUp_ThenQueueFollowUp_UpdatesPlaceholderInPlace() {
        global requestParams, activeThreadId
        this._setupDb()
        ChatDB.Thread_Create("Placeholder")
        threads := ChatDB.Thread_List()
        activeThreadId := threads[threads.Length].id
        u1Id := ChatDB.Msg_Insert({ thread_id: activeThreadId, role: "user", content: "q" })

        toolCalls := [{
            id: "call_1",
            name: "web_search",
            arguments: "{`"query`":`"latest news`"}"
        }]
        requestParams := Map()
        loopState := SearchToolExecutor.NewLoopState(activeThreadId, u1Id, requestParams, 0)
        ctxId := SearchToolExecutor.PrepareFollowUp(toolCalls, activeThreadId, u1Id, loopState)
        if !ctxId
            throw Error("expected a placeholder message id")

        path := ChatDB.Msg_GetActivePath(activeThreadId)
        if path.Length != 2 || path[2].id != ctxId
            throw Error("placeholder not chained after the user message")
        if InStr(path[2].content, "Searching…") = 0
            throw Error("placeholder content missing Searching marker: " path[2].content)
        if loopState.contextIds.Length != 1 || loopState.contextIds[1] != ctxId
            throw Error("placeholder id not tracked for canonical ordering")

        exec := {
            toolMessages: [{ role: "assistant", content: "", tool_calls: [] }],
            contextText: "[Web search: latest news]`n`nreal results"
        }
        SearchToolExecutor.QueueFollowUp(exec, activeThreadId, u1Id, 1, loopState)

        path2 := ChatDB.Msg_GetActivePath(activeThreadId)
        if path2.Length != 2
            throw Error("placeholder must NOT create a second message row, got " path2.Length " messages")
        if path2[2].id != ctxId || path2[2].content != "[Web search: latest news]`n`nreal results"
            throw Error("placeholder row not edited to the real result: " jsongo.Stringify(path2[2]))
        if loopState.placeholderId != ""
            throw Error("placeholder state should be cleared after QueueFollowUp")

        activeThreadId := ""
        this._teardownDb()
    }

    ; Regression (bug #315): a placeholder from a force-killed process must be
    ; converted on the next ChatWindow startup and remain searchable in FTS.
    RecoverAbandonedPlaceholders_MarksFailureAndKeepsCompletedResults() {
        this._setupDb()
        threadId := ChatDB.Thread_Create("Recovery")
        staleId := ChatDB.Msg_Insert({
            thread_id: threadId, role: "user",
            content: "[Web search: stale query]`n`nSearching…"
        })
        completedId := ChatDB.Msg_Insert({
            thread_id: threadId, role: "user",
            content: "[Web search: done query]`n`nCompleted result"
        })
        recovered := SearchToolExecutor.RecoverAbandonedPlaceholders()
        stale := ChatDB.db.Query("SELECT content FROM messages WHERE id=?;", staleId)
        completed := ChatDB.db.Query("SELECT content FROM messages WHERE id=?;", completedId)
        if recovered != 1
            throw Error("expected one abandoned placeholder recovery, got " recovered)
        if InStr(stale[1, "content"], "Searching") || !InStr(stale[1, "content"], "interrupted by application restart")
            throw Error("stale placeholder was not marked failed: " stale[1, "content"])
        if completed[1, "content"] != "[Web search: done query]`n`nCompleted result"
            throw Error("completed search context was changed")
        results := ChatDB.SearchMessages("interrupted application restart")
        if results.Length != 1 || results[1].messageId != staleId
            throw Error("recovered failure was not reindexed in FTS")
        this._teardownDb()
    }
}
