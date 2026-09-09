; ======================================================
; CodexCliTransport tests — no real Codex calls.
; ======================================================

class CodexCliTransportTest {
    static __New() {
        RegisterTestClass("CodexCliTransportTest")
    }

    RuntimeArgs_LockDownLocalToolsAndForceChatGPT() {
        args := CodexCliRuntime.BuildExecArgs("gpt-5.6-luna", "C:\\work", "C:\\instructions.txt", "C:\\out.txt", "high", false)
        text := CodexCliRuntime.Join(args, " ")
        for required in [
            "exec", "--ephemeral", "--ignore-user-config", "--ignore-rules",
            "--skip-git-repo-check", "--sandbox", "read-only", "--strict-config",
            'forced_login_method="chatgpt"', 'approval_policy="never"',
            'web_search="disabled"', 'model_reasoning_summary="auto"',
            "mcp_servers={}", "hooks={}",
            'shell_environment_policy.inherit="none"', 'model_reasoning_effort="high"'
        ] {
            if !InStr(text, required)
                throw Error("Codex safe profile missing: " required)
        }
        for feature in [
            "shell_tool", "unified_exec", "shell_snapshot", "view_image",
            "code_mode", "code_mode_only", "sleep_tool",
            "apps", "multi_agent", "goals", "memories", "computer_use",
            "plugins", "remote_plugin", "plugin_sharing", "tool_suggest",
            "skill_mcp_dependency_install", "skill_search", "image_generation",
            "in_app_browser", "in_app_local_automation", "workspace_dependencies"
        ] {
            if !InStr(text, "--disable " feature)
                throw Error("Codex safe profile must disable " feature)
        }
        if InStr(text, "--disable code_mode_host")
            throw Error("Codex safe profile must leave the internal code-mode host available while disabling model-visible Code Mode")
    }

    RuntimeArgs_WebSearchIsNativeAndExplicit() {
        offArgs := CodexCliRuntime.Join(CodexCliRuntime.BuildExecArgs("gpt-5.6-luna", "C:\\w", "C:\\i", "C:\\o", "", false), " ")
        onArgs := CodexCliRuntime.Join(CodexCliRuntime.BuildExecArgs("gpt-5.6-luna", "C:\\w", "C:\\i", "C:\\o", "", true), " ")
        if !InStr(offArgs, 'web_search="disabled"') || InStr(offArgs, 'web_search="live"')
            throw Error("Web Search off must explicitly disable Codex search")
        if InStr(offArgs, "--search")
            throw Error("Web Search off must not request Codex live search")
        if !InStr(onArgs, 'web_search="live"') || !InStr(onArgs, "--search exec")
            throw Error("Web Search on must use Codex's documented live-search invocation inside the same turn")
        if InStr(onArgs, "standalone_web_search") || InStr(offArgs, "standalone_web_search")
            throw Error("AhkLLM must not override Codex's standalone search feature; --search and web_search mode own that contract")
    }

    RuntimeArgs_InvalidModelAndReasoningFailBeforeSpawn() {
        threwModel := false
        try CodexCliRuntime.BuildExecArgs("bad & model", "C:\\w", "C:\\i", "C:\\o")
        catch
            threwModel := true
        if !threwModel
            throw Error("Unsafe Codex model ids must be rejected before process construction")

        threwReasoning := false
        try CodexCliRuntime.BuildExecArgs("gpt-5.6-luna", "C:\\w", "C:\\i", "C:\\o", "turbo")
        catch
            threwReasoning := true
        if !threwReasoning
            throw Error("Unknown reasoning effort must fail before process construction")
    }

    PrepareRequest_IsDeterministicAppendOnlyAndSeparatesSystem() {
        first := Map("messages", [
            Map("role", "system", "content", "SYSTEM-STABLE"),
            Map("role", "user", "content", "hello"),
            Map("role", "assistant", "content", "hi")
        ])
        extended := Map("messages", [
            Map("role", "system", "content", "SYSTEM-STABLE"),
            Map("role", "user", "content", "hello"),
            Map("role", "assistant", "content", "hi"),
            Map("role", "user", "content", "next")
        ])
        p1 := CodexCliTransport.PrepareRequest(first)
        p1Again := CodexCliTransport.PrepareRequest(first)
        p2 := CodexCliTransport.PrepareRequest(extended)
        if p1.transcript != p1Again.transcript || p1.instructions != p1Again.instructions
            throw Error("Identical Codex requests must serialize byte-identically for cache hits")
        if SubStr(p2.transcript, 1, StrLen(p1.transcript)) != p1.transcript
            throw Error("Extended chat transcript must retain the complete prior transcript as a byte-identical prefix")
        if InStr(p1.transcript, "SYSTEM-STABLE")
            throw Error("System instructions belong in model instructions, not the conversation transcript")
        if !InStr(p1.instructions, "SYSTEM-STABLE")
            throw Error("System instructions must reach Codex model instructions")
        if !InStr(p1.transcript, '"role":"user"') || !InStr(p1.transcript, '"role":"assistant"')
            throw Error("Transcript must preserve chronological user/assistant roles")
    }

    ContentText_RejectsImagesUntilSupported() {
        threw := false
        try CodexCliTransport.ContentText([Map("type", "image_url", "image_url", Map("url", "data:image/png;base64,AA=="))])
        catch
            threw := true
        if !threw
            throw Error("Codex v1 must reject image content rather than silently dropping it")
    }

    UsageAndSyntheticResponse_PreserveCachedTokens() {
        events := '{"type":"turn.completed","usage":{"input_tokens":120,"output_tokens":30,"reasoning_output_tokens":11,"cached_input_tokens":90,"total_tokens":150}}`n'
        usage := CodexCliTransport.ExtractUsage(events)
        if usage.promptTokens != 120 || usage.completionTokens != 30 || usage.thinkingTokens != 11 || usage.cachedTokens != 90 || usage.totalTokens != 150
            throw Error("Codex JSONL usage extraction lost input/output/reasoning/cache totals")
        parsed := ResponseParser.ParseChatResponse(jsongo.Parse(CodexCliTransport.BuildSyntheticResponse("gpt-5.6-luna", "answer", usage)))
        if parsed.response != "answer" || parsed.usage.promptTokens != 120 || parsed.usage.cachedTokens != 90
            throw Error("Synthetic Codex response must remain compatible with the existing response/usage pipeline")
        searchEvents := '{"type":"item.started","item":{"type":"web_search"}}`n'
            . '{"type":"item.completed","item":{"type":"web_search","query":"one"}}`n'
            . '{"type":"item.completed","item":{"type":"agent_message","text":"done"}}`n'
            . '{"type":"item.completed","item":{"type":"web_search","query":"two"}}`n'
        if CodexCliTransport.CountWebSearches(searchEvents) != 2
            throw Error("Codex search observability must count completed web_search calls exactly once")

        progress := []
        callback := (payload) => progress.Push(payload)
        state := { lineCount: 0, searchCount: 0, pendingAgentMessage: "" }
        commentary := jsongo.Parse('{"type":"item.completed","item":{"type":"agent_message","text":"I will verify that now."}}')
        reasoningEvent := jsongo.Parse('{"type":"item.completed","item":{"type":"reasoning","text":"Checking the release source"}}')
        started := jsongo.Parse('{"type":"item.started","item":{"type":"web_search"}}')
        completed := jsongo.Parse('{"type":"item.completed","item":{"type":"web_search","query":"latest release"}}')
        CodexCliTransport._EmitProgressEvent(commentary, state, callback)
        if progress.Length != 0
            throw Error("An agent_message must stay pending until another event proves it is intermediate commentary")
        CodexCliTransport._EmitProgressEvent(reasoningEvent, state, callback)
        CodexCliTransport._EmitProgressEvent(started, state, callback)
        CodexCliTransport._EmitProgressEvent(completed, state, callback)
        if progress.Length != 4 || progress[1].content != "I will verify that now.`n`n" || progress[2].content != "Checking the release source`n`n"
            throw Error("Codex public commentary and reasoning summaries must stream through the thought block")
        for payload in progress {
            if !payload.HasOwnProp("kind") || payload.kind != "reasoning"
                throw Error("Codex public progress must use the normal provider reasoning/Thought Process UI kind")
        }
        if progress[3].content != "Searching the web…`n`n" || progress[4].searchCount != 1 || progress[4].content != "Web search: latest release`n`n"
            throw Error("Codex web-search lifecycle must append truthful activity to the thought block")

        thoughtEvents := '{"type":"item.completed","item":{"type":"agent_message","text":"I will verify that now."}}`n'
            . '{"type":"item.completed","item":{"type":"reasoning","text":"Checking the release source"}}`n'
            . '{"type":"item.completed","item":{"type":"web_search","query":"latest release"}}`n'
            . '{"type":"item.completed","item":{"type":"agent_message","text":"0.153.4"}}`n'
            . '{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}`n'
        thought := CodexCliTransport.ExtractThoughtSummary(thoughtEvents)
        if !InStr(thought, "I will verify that now.") || !InStr(thought, "Checking the release source") || !InStr(thought, "Web search: latest release")
            throw Error("Persisted Codex thought summary must retain public commentary, reasoning summary, and tool activity")
        if InStr(thought, "0.153.4")
            throw Error("The final Codex answer must never be duplicated inside the thought block")
    }

    ProgressDrain_HoldsPartialLineUntilFinalDrain() {
        tempFile := A_Temp "\\AhkLLM_Codex_Drain_" A_TickCount "_" Random(1000, 999999) ".jsonl"
        progress := []
        callback := (payload) => progress.Push(payload)
        state := { lineCount: 0, searchCount: 0, pendingAgentMessage: "" }
        try {
            ; A stable JSON object without a trailing newline is indistinguishable
            ; from an in-progress write while Codex is alive, so normal polling
            ; must defer it. Once the process exits, finalDrain=true must consume it.
            FileOpen(tempFile, "w", "UTF-8-RAW").Write('{"type":"item.completed","item":{"type":"reasoning","text":"late public summary"}}')
            CodexCliTransport._DrainProgressEvents(tempFile, state, callback)
            if progress.Length != 0 || state.lineCount != 0
                throw Error("Normal Codex polling must leave the final unterminated JSONL segment pending")
            CodexCliTransport._DrainProgressEvents(tempFile, state, callback, true)
            if progress.Length != 1 || progress[1].content != "late public summary`n`n"
                throw Error("Post-exit Codex drain must consume a complete final JSONL record without a trailing newline")
            CodexCliTransport._DrainProgressEvents(tempFile, state, callback, true)
            if progress.Length != 1
                throw Error("Repeated final Codex drains must not duplicate already-consumed reasoning")
        } finally {
            if FileExist(tempFile)
                FileDelete(tempFile)
        }
    }

    CancellationRequested_RecognizesKilledProcessRace() {
        if !CodexCliTransport._CancellationRequested({ cancelled: true })
            throw Error("Codex transport must preserve a Stop flag even when the wrapper has already exited")
        if !CodexCliTransport._CancellationRequested({ cancelled: false, cancelRequested: true })
            throw Error("Codex transport must recognize an explicit cancellation request")
        if CodexCliTransport._CancellationRequested({ cancelled: false, cancelRequested: false })
            throw Error("Codex transport must not classify an ordinary request as cancelled")

        srcPath := A_ScriptDir "\\..\\api\\CodexCliTransport.ahk"
        src := FileRead(srcPath)
        waitPos := InStr(src, "if waitResult = 0 {")
        if !waitPos
            throw Error("Codex process-exit branch not found")
        exitBranch := SubStr(src, waitPos, 700)
        if !InStr(exitBranch, "_CancellationRequested(cancelState)") || !InStr(exitBranch, "cancelled := true")
            throw Error("A killed Codex wrapper must be classified from the UI cancellation flag before the exit branch returns")
    }

    RuntimeVersion_ParsesMinimumAndAllowsCompatibleNewerReleases() {
        if CodexCliRuntime.ExtractVersion("codex-cli 0.153.4") != "0.153.4"
            throw Error("Codex version parser should accept official CLI output")
        if !CodexCliRuntime.VersionSupported("0.153.0") || !CodexCliRuntime.VersionSupported("0.153.4")
            throw Error("Tested Codex 0.153.x releases should be accepted")
        if !CodexCliRuntime.VersionTested("0.153.4") || CodexCliRuntime.VersionTested("0.154.0")
            throw Error("The tested-family marker must be informational rather than an upper support bound")
        if CodexCliRuntime.VersionSupported("0.152.9")
            throw Error("Codex releases older than the minimum must be rejected")
        if !CodexCliRuntime.VersionSupported("0.154.0") || !CodexCliRuntime.VersionSupported("1.0.0")
            throw Error("Compatible newer Codex releases must not be blocked solely by their version number")
        if CodexCliRuntime.VersionSupported("unknown")
            throw Error("Unparseable Codex versions should fail closed")
    }

    ProbeBatch_ChecksMetadataWithoutExecAndStripsApiKeys() {
        batch := CodexCliRuntime.BuildProbeBatch("codex", ["login", "status"], "C:\\out.txt", "C:\\err.txt", "C:\\status.txt")
        if !InStr(batch, 'call codex "login" "status"')
            throw Error("Codex preflight must use the documented login status command")
        if InStr(batch, '"exec"')
            throw Error("Codex preflight must never invoke codex exec")
        for key in ["OPENAI_API_KEY", "AZURE_OPENAI_API_KEY", "CODEX_API_KEY", "DEEPSEEK_API_KEY", "GOOGLE_API_KEY", "OPENROUTER_API_KEY", "TAVILY_API_KEY"] {
            if !InStr(batch, 'set "' key '="')
                throw Error("Codex preflight must clear credential environment variable " key)
        }
    }

    BatchContract_UsesStdinOnceAndStripsApiKeys() {
        args := CodexCliRuntime.BuildExecArgs("gpt-5.6-luna", "C:\\work", "C:\\instructions.txt", "C:\\last.txt", "low", false)
        execLine := CodexCliRuntime.BuildExecLine("codex", args)
        batch := CodexCliRuntime.BuildBatch("codex", args, "C:\\prompt.jsonl", "C:\\events.jsonl", "C:\\error.txt", "C:\\status.txt")
        if !InStr(execLine, 'call codex "exec"')
            throw Error("Codex wrapper must launch exactly one non-interactive exec command")
        if InStr(execLine, "SECRET-PROMPT-TEXT")
            throw Error("Prompt content must never be exposed on the Codex command line")
        if !InStr(batch, '< "C:\\prompt.jsonl"')
            throw Error("Conversation must be redirected to Codex over stdin")
        for key in ["OPENAI_API_KEY", "AZURE_OPENAI_API_KEY", "CODEX_API_KEY", "DEEPSEEK_API_KEY", "GOOGLE_API_KEY", "OPENROUTER_API_KEY", "TAVILY_API_KEY"] {
            if !InStr(batch, 'set "' key '="')
                throw Error("Codex child wrapper must clear credential environment variable " key)
        }
        firstExec := InStr(batch, '"exec"')
        if !firstExec || InStr(batch, '"exec"', false, firstExec + 1)
            throw Error("One transport request must contain exactly one codex exec invocation")
    }
}
