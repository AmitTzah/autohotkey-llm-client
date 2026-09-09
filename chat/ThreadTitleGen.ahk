; ----------------------------------------------------
; ThreadTitleGen - Fire-and-forget title generation
;
; Generates a short thread title from the first
; user+assistant exchange using a cheap LLM call.
; Delegates request building to LLMRequestBuilder
; and cURL execution to CurlBuilder.
; ----------------------------------------------------

; Allow at most one in-flight/successful title-generation request per thread.
; retry (or cancel) of the first exchange must not re-fire title generation
; while the title is still "New Chat" - the request may be in flight, may
; have failed, or may already have succeeded with a title the DB gate
; (currentTitle != "New Chat") would otherwise re-check.
global _titleGenRequestedThreads := Map()

generateThreadTitle(threadId) {
    global _titleGenRequestedThreads
    if !autoTitleGenerationEnabled || !IsSet(titleGenModel) || !titleGenModel
        return
    ; A delayed title callback can run after the user relocks its thread.
    ; Do not even read the active path in that case: title generation is an
    ; outbound plaintext sink just like the normal chat request/log path.
    if IsSet(ThreadLockService) && ThreadLockService.ShouldRedactContent(threadId) {
        debugLog("[TITLEGEN] skip locked thread=" threadId)
        return
    }

    prompt := _TitleGen_BuildPrompt(threadId)
    if !prompt
        return

    ; Only one request per thread: the first caller dispatches, any later
    ; caller (a duplicate timer scheduled before this one fired, a direct
    ; call, or a retry of the first exchange) returns without an API call.
    if _titleGenRequestedThreads.Has(threadId) {
        debugLog("[TITLEGEN] skip duplicate title request thread=" threadId)
        return
    }
    _titleGenRequestedThreads[threadId] := true

    debugLog("[TITLEGEN] generateThreadTitle thread=" threadId " model=" titleGenModel)

    titleGenStart := A_TickCount
    providerInfo := ProviderResolver.Resolve(titleGenModel)
    if providerInfo.transport = "codex-cli" {
        ; The Codex backend guarantees one deliberate user action = one Codex
        ; invocation. Auto-title generation is hidden background work, so never
        ; spend a second subscription turn on it. Derive a deterministic local
        ; title from the first user message instead.
        title := _TitleGen_LocalFallbackTitle(threadId)
        if title {
            _TitleGen_PublishTitle(threadId, title)
            debugLog("[TITLEGEN] local Codex fallback title='" title "' thread=" threadId)
        } else {
            _titleGenRequestedThreads.Delete(threadId)
        }
        return
    }

    payload := LLMRequestBuilder.createJSONRequest(
        titleGenModel,
        titleGenSystemPrompt,
        prompt,
        "",                    ; temperature
        titleGenMaxTokens,     ; maxTokens
        "",                    ; stop
        false,                 ; stream
        "disabled"             ; reasoningEffort - title generation never thinks
    )

    raw := _TitleGen_ExecuteRequest(payload, providerInfo)
    result := _TitleGen_ParseResponse(raw)
    title := result.title
    promptTokens := result.promptTokens
    completionTokens := result.completionTokens
    thinkingTokens := result.thinkingTokens

    debugLog("[API] Title gen - prompt=" promptTokens " completion=" completionTokens " model=" titleGenModel)

    _TitleGen_TrackUsage(titleGenModel, providerInfo.providerKey, promptTokens, completionTokens, thinkingTokens, titleGenStart)

    ; A lock may be applied by the other process while cURL is running. Do
    ; not publish or persist a title based on a now-protected exchange.
    redacted := IsSet(ThreadLockService) && ThreadLockService.ShouldRedactContent(threadId)
    if title {
        if !redacted {
        ChatDB.Thread_Update(threadId, title)
        threads := ChatDB.Thread_List()
        folders := _GetFolders()
        postWebMessage("threadList", { threads: threads, folders: folders })
        ; Post the thread's REAL folder so the topbar label isn't reset to
        ; "Unfiled" (the JS stores whatever folder arrives into _threadMeta).
        folderName := ""
        for t in threads {
            if t.id = threadId {
                folderName := t.folder_name
                break
            }
        }
        ; Diagnostic: dump what the DB actually holds for this thread at
        ; title-gen time so a stale/missing folder is visible in the log.
        folderRow := ChatDB.db.Query("SELECT folder_id FROM chat_threads WHERE id=?;", threadId)
        dbFolderId := folderRow.count ? folderRow[1, "folder_id"] : ""
        debugLog("[TITLEGEN] title='" title "' thread=" threadId
            . " dbFolderId='" dbFolderId "' resolvedFolderName='" folderName "'")
        postWebMessage("updateTopbarTitle", { text: title, folder: folderName })
        }
    } else {
        ; A failed title request must clear the dispatch guard so a later trigger can retry.
        ; error, provider hiccup, timeout, empty response) must NOT permanently
        ; disable auto-titles. Clear the dispatch guard so the next trigger
        ; The guard only suppresses duplicate in-flight/successful requests.
        ; protects against duplicate IN-FLIGHT/success requests.
        _titleGenRequestedThreads.Delete(threadId)
        debugLog("[TITLEGEN] no title parsed - dispatch guard cleared thread=" threadId)
    }

    _TitleGen_LogRequest(titleGenModel, providerInfo.providerKey, providerInfo.endpoint, payload, raw, title, titleGenStart, redacted)
}

; Publish a local title and refresh both thread list and topbar.
_TitleGen_PublishTitle(threadId, title) {
    ChatDB.Thread_Update(threadId, title)
    threads := ChatDB.Thread_List()
    folders := _GetFolders()
    postWebMessage("threadList", { threads: threads, folders: folders })
    folderName := ""
    for t in threads {
        if t.id = threadId {
            folderName := t.folder_name
            break
        }
    }
    folderRow := ChatDB.db.Query("SELECT folder_id FROM chat_threads WHERE id=?;", threadId)
    dbFolderId := folderRow.count ? folderRow[1, "folder_id"] : ""
    debugLog("[TITLEGEN] title='" title "' thread=" threadId
        . " dbFolderId='" dbFolderId "' resolvedFolderName='" folderName "'")
    postWebMessage("updateTopbarTitle", { text: title, folder: folderName })
}

; Codex title generation must not consume a hidden subscription turn. Use the
; first user message as a deterministic local title instead, normalized and
; shortened at a word boundary where possible.
_TitleGen_LocalFallbackTitle(threadId) {
    path := ChatDB.Msg_GetActivePath(threadId)
    text := ""
    for msg in path {
        if msg.role = "user" && Trim(msg.content) != "" {
            text := msg.content
            break
        }
    }
    text := Trim(RegExReplace(text, "\s+", " "), " `t`r`n-*#>")
    if text = ""
        return ""
    if StrLen(text) > 60 {
        candidate := SubStr(text, 1, 60)
        lastSpace := InStr(candidate, " ", false, -1)
        if lastSpace >= 24
            candidate := SubStr(candidate, 1, lastSpace - 1)
        text := RTrim(candidate, " ,;:-") "…"
    }
    return _TitleGen_CleanTitle(text)
}

; Build the prompt from the first user+assistant exchange.
_TitleGen_BuildPrompt(threadId) {
    path := ChatDB.Msg_GetActivePath(threadId)
    if path.Length < 2
        return ""
    firstUser := "", firstAsst := ""
    for msg in path {
        if msg.role = "user" && !firstUser
            firstUser := msg.content
        if msg.role = "assistant" && firstUser && !firstAsst
            firstAsst := msg.content
    }
    if !firstUser || !firstAsst
        return ""
    return "User: " SubStr(firstUser, 1, 200) "`nAssistant: " SubStr(firstAsst, 1, 200)
}

; Execute the title generation cURL request using CurlBuilder.
_TitleGen_ExecuteRequest(payload, providerInfo) {
    uniqueID := ChatDB._UUID()
    tmpFile := A_Temp "\ChatWindow_TitleGen_" uniqueID ".json"
    outFile := A_Temp "\ChatWindow_TitleGen_Out_" uniqueID ".json"
    FileOpen(tmpFile, "w", "UTF-8-RAW").Write(payload)

    cURLCommand := CurlBuilder.Build(providerInfo, tmpFile, outFile)
    raw := CurlExecutor.Run(cURLCommand, outFile, 200)

    safeDelete(tmpFile)
    safeDelete(outFile)
    return raw
}

; Parse the title and token usage from the raw JSON response.
_TitleGen_ParseResponse(raw) {
    title := "", promptTokens := 0, completionTokens := 0, thinkingTokens := 0
    if !raw
        return { title: title, promptTokens: promptTokens, completionTokens: completionTokens, thinkingTokens: thinkingTokens }

    try {
        parsed := jsongo.Parse(raw)
        if parsed.Has("usage") {
            u := parsed["usage"]
            promptTokens := u.Has("prompt_tokens") ? u["prompt_tokens"] : 0
            completionTokens := u.Has("completion_tokens") ? u["completion_tokens"] : 0
            if u.Has("completion_tokens_details") {
                d := u["completion_tokens_details"]
                if d.Has("reasoning_tokens")
                    thinkingTokens := d["reasoning_tokens"]
            }
        }
        if parsed.Has("choices") && parsed["choices"].Length > 0 {
            title := _TitleGen_CleanTitle(Trim(parsed["choices"][1]["message"]["content"]))
        }
    }
    return { title: title, promptTokens: promptTokens, completionTokens: completionTokens, thinkingTokens: thinkingTokens }
}

; Clean up the raw title: strip quotes, trailing period, truncate to 60 chars.
_TitleGen_CleanTitle(rawTitle) {
    if SubStr(rawTitle, 1, 1) = '"' || SubStr(rawTitle, 1, 1) = "'"
        rawTitle := SubStr(rawTitle, 2)
    lastChar := SubStr(rawTitle, StrLen(rawTitle))
    if lastChar = '"' || lastChar = "'"
        rawTitle := SubStr(rawTitle, 1, StrLen(rawTitle) - 1)
    if SubStr(rawTitle, -1) = "."
        rawTitle := SubStr(rawTitle, 1, StrLen(rawTitle) - 1)
    if StrLen(rawTitle) > 60
        rawTitle := SubStr(rawTitle, 1, 60)
    return rawTitle
}

; Track title generation usage in the dashboard.
_TitleGen_TrackUsage(titleModel, providerKey, promptTokens, completionTokens, thinkingTokens, titleGenStart) {
    ; Failed or usage-less title calls are still API requests and belong in usage tracking.
    ; request - record it (0 tokens/cost but call_count + response time) so the
    ; dashboard shows it instead of silently omitting the call.
    usage := { promptTokens: promptTokens, completionTokens: completionTokens, cachedTokens: 0 }
    costs := CostCalculator.ComputeTokenCosts(titleModel, usage)
    ChatDB.CommandUsage_Upsert({
        date: FormatTime(, "yyyy-MM-dd"),
        model: titleModel,
        provider: providerKey,
        command_name: "Title Generation",
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        thinking_tokens: thinkingTokens,
        cached_tokens: 0,
        input_cost: costs.inputCost != "" ? costs.inputCost : 0,
        cached_input_cost: costs.cachedInputCost != "" ? costs.cachedInputCost : 0,
        output_cost: costs.outputCost != "" ? costs.outputCost : 0,
        total_cost: costs.totalCost != "" ? costs.totalCost : 0,
        response_time_ms: A_TickCount - titleGenStart
    })
}

; Log the title generation API request.
_TitleGen_LogRequest(titleModel, providerKey, endpoint, payload, raw, title, titleGenStart, redacted := false) {
    if redacted {
        payload := "<hidden: locked chat>"
        raw := "<hidden: locked chat>"
    }
    ApiLogger.LogRequest({
        timestamp: FormatTime(, "yyyy-MM-dd HH:mm:ss"),
        commandName: "Thread Title Generation",
        provider: providerKey, model: titleModel, isFIM: false,
        endpoint: endpoint, pasteMode: "none",
        request: payload, response: raw,
        status: title ? "success" : "failed",
        responseTimeMs: A_TickCount - titleGenStart
    })
}
