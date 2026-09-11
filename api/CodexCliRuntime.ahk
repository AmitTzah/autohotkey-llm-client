; ======================================================
; CodexCliRuntime.ahk — deterministic local Codex CLI invocation
;
; AhkLLM treats Codex as a local transport, not an HTTP endpoint. The runtime
; deliberately ignores user config/rules, forces ChatGPT authentication, and
; removes local execution/agent tools so normal chat behaves like a text LLM.
; Prompt text is passed through stdin redirection and never appears in argv.
; ======================================================

class CodexCliRuntime {
    ; 0.153.x is the family AhkLLM was validated against, not a maximum.
    ; Compatible newer Codex releases are allowed so routine CLI updates do not
    ; disable the backend. The exec path still uses strict config plus explicit
    ; lockdown switches, so an actual removed/renamed safety control fails the
    ; request as an incompatibility instead of being silently ignored.
    static MIN_SUPPORTED_VERSION := "0.153.0"
    static TESTED_VERSION_LABEL := "0.153.x"

    static Executable() {
        explicit := EnvGet("CODEX_CLI_PATH")
        return explicit != "" ? explicit : "codex"
    }

    static ValidateModelId(modelId) {
        modelId := String(modelId)
        if !RegExMatch(modelId, "^[A-Za-z0-9][A-Za-z0-9._:/-]*$")
            throw Error("Invalid Codex model id: " modelId)
        return modelId
    }

    static ValidateReasoning(reasoning) {
        reasoning := String(reasoning)
        allowed := Map("", true, "none", true, "minimal", true, "low", true, "medium", true, "high", true, "xhigh", true, "max", true)
        if !allowed.Has(reasoning)
            throw Error("Unsupported Codex reasoning effort: " reasoning)
        return reasoning
    }

    static DisabledFeatures() {
        ; Keep this centralized. --strict-config makes an incompatible CLI fail
        ; closed instead of silently dropping a safety control.
        return [
            ; Local execution / filesystem inspection.
            "shell_tool", "unified_exec", "shell_snapshot", "view_image",
            ; Keep code_mode_host at Codex's default. The host is not itself a
            ; model-visible tool; disabling it breaks Responses Lite tool
            ; plumbing even while code_mode remains disabled.
            "code_mode", "code_mode_only", "sleep_tool",
            ; Agent/app/plugin/MCP discovery surfaces.
            "apps", "multi_agent", "goals", "memories", "hooks",
            "plugins", "remote_plugin", "plugin_sharing", "tool_suggest",
            "skill_mcp_dependency_install", "skill_search",
            ; Browser/computer/image-generation surfaces.
            "browser_use", "browser_use_external", "browser_use_full_cdp_access",
            "in_app_browser", "in_app_local_automation", "computer_use",
            "image_generation", "workspace_dependencies", "auth_elicitation"
        ]
    }

    static BuildExecArgs(modelId, workingDir, instructionFile, outputFile, reasoning := "", webSearch := false, imageGeneration := false, inputImages := "") {
        modelId := CodexCliRuntime.ValidateModelId(modelId)
        reasoning := CodexCliRuntime.ValidateReasoning(reasoning)
        ; Use Codex's documented top-level --search switch for search turns.
        ; Responses Lite depends on internal tool plumbing that includes the
        ; code-mode host even when model-visible Code Mode is disabled. AhkLLM
        ; therefore disables Code Mode itself, not its host. First-party search
        ; is selected only through --search plus the explicit web_search mode.
        args := webSearch ? ["--search", "exec"] : ["exec"]
        args.Push(
            "--ephemeral",
            "--ignore-user-config",
            "--ignore-rules",
            "--skip-git-repo-check",
            "--sandbox", "read-only",
            "--strict-config",
            "--json",
            "--output-last-message", outputFile,
            "--cd", workingDir,
            "--model", modelId,
            "--config", "forced_login_method=" CodexCliRuntime.TomlString("chatgpt"),
            "--config", "approval_policy=" CodexCliRuntime.TomlString("never"),
            "--config", "web_search=" CodexCliRuntime.TomlString(webSearch ? "live" : "disabled"),
            ; Ask Codex to emit its model-provided reasoning summary in the
            ; exec JSONL stream. This is the public/safe summary surface, not
            ; raw hidden reasoning, and feeds AhkLLM's normal thought block.
            "--config", "model_reasoning_summary=" CodexCliRuntime.TomlString("auto"),
            "--config", "model_instructions_file=" CodexCliRuntime.TomlString(instructionFile),
            "--config", "include_permissions_instructions=false",
            "--config", "include_apps_instructions=false",
            "--config", "include_collaboration_mode_instructions=false",
            "--config", "include_environment_context=false",
            "--config", "skills.include_instructions=false",
            "--config", "mcp_servers={}",
            "--config", "hooks={}",
            "--config", "shell_environment_policy.inherit=" CodexCliRuntime.TomlString("none")
        )
        if IsObject(inputImages) {
            for imagePath in inputImages {
                imagePath := String(imagePath)
                if imagePath = "" || !FileExist(imagePath)
                    throw Error("Codex input image is missing: " imagePath)
                args.Push("--image", imagePath)
            }
        }
        for feature in CodexCliRuntime.DisabledFeatures() {
            ; This turn-level permission may expose only Codex image generation.
            ; Every other safety disable remains unchanged.
            if imageGeneration && feature = "image_generation"
                continue
            args.Push("--disable", feature)
        }
        if reasoning != ""
            args.Push("--config", "model_reasoning_effort=" CodexCliRuntime.TomlString(reasoning))
        return args
    }

    static BuildExecLine(executable, args) {
        exe := executable = "codex" ? "codex" : CodexCliRuntime.BatchQuote(executable)
        line := "call " exe
        for arg in args
            line .= " " CodexCliRuntime.BatchQuote(arg)
        return line
    }

    static BuildBatch(executable, args, promptFile, eventsFile, errorFile, statusFile) {
        lines := [
            "@echo off",
            "setlocal DisableDelayedExpansion",
            'set "OPENAI_API_KEY="',
            'set "AZURE_OPENAI_API_KEY="',
            'set "CODEX_API_KEY="',
            'set "DEEPSEEK_API_KEY="',
            'set "GOOGLE_API_KEY="',
            'set "OPENROUTER_API_KEY="',
            'set "TAVILY_API_KEY="'
        ]
        line := CodexCliRuntime.BuildExecLine(executable, args)
            . " < " CodexCliRuntime.BatchQuote(promptFile)
            . " > " CodexCliRuntime.BatchQuote(eventsFile)
            . " 2> " CodexCliRuntime.BatchQuote(errorFile)
        lines.Push(line)
        lines.Push('set "AHKLLM_CODEX_EXIT=%ERRORLEVEL%"')
        lines.Push("> " CodexCliRuntime.BatchQuote(statusFile) " echo %AHKLLM_CODEX_EXIT%")
        lines.Push("exit /b %AHKLLM_CODEX_EXIT%")
        return CodexCliRuntime.Join(lines, "`r`n") "`r`n"
    }

    ; Build a credential-scrubbed diagnostic wrapper. These commands are
    ; metadata/auth checks only (`--version`, `login status`) and never invoke
    ; a model or consume a Codex turn.
    static BuildProbeBatch(executable, args, outputFile, errorFile, statusFile) {
        lines := [
            "@echo off",
            "setlocal DisableDelayedExpansion",
            'set "OPENAI_API_KEY="',
            'set "AZURE_OPENAI_API_KEY="',
            'set "CODEX_API_KEY="',
            'set "DEEPSEEK_API_KEY="',
            'set "GOOGLE_API_KEY="',
            'set "OPENROUTER_API_KEY="',
            'set "TAVILY_API_KEY="'
        ]
        line := CodexCliRuntime.BuildExecLine(executable, args)
            . " > " CodexCliRuntime.BatchQuote(outputFile)
            . " 2> " CodexCliRuntime.BatchQuote(errorFile)
        lines.Push(line)
        lines.Push('set "AHKLLM_CODEX_EXIT=%ERRORLEVEL%"')
        lines.Push("> " CodexCliRuntime.BatchQuote(statusFile) " echo %AHKLLM_CODEX_EXIT%")
        lines.Push("exit /b %AHKLLM_CODEX_EXIT%")
        return CodexCliRuntime.Join(lines, "`r`n") "`r`n"
    }

    static ExtractVersion(text) {
        if RegExMatch(String(text), "i)(?:codex(?:-cli)?[ `t]+)?v?(\d+)\.(\d+)\.(\d+)", &m)
            return m[1] "." m[2] "." m[3]
        return ""
    }

    static VersionAtLeast(actual, required := "") {
        if required = ""
            required := CodexCliRuntime.MIN_SUPPORTED_VERSION
        a := CodexCliRuntime._VersionParts(actual)
        r := CodexCliRuntime._VersionParts(required)
        if a.Length != 3 || r.Length != 3
            return false
        loop 3 {
            if a[A_Index] > r[A_Index]
                return true
            if a[A_Index] < r[A_Index]
                return false
        }
        return true
    }

    static VersionSupported(actual) {
        return CodexCliRuntime.VersionAtLeast(actual)
    }

    static VersionTested(actual) {
        parts := CodexCliRuntime._VersionParts(actual)
        return parts.Length = 3 && parts[1] = 0 && parts[2] = 153
    }

    static _VersionParts(version) {
        if !RegExMatch(String(version), "^(\d+)\.(\d+)\.(\d+)$", &m)
            return []
        return [Integer(m[1]), Integer(m[2]), Integer(m[3])]
    }

    static TomlString(value) {
        value := StrReplace(String(value), "\", "\\")
        value := StrReplace(value, '"', '\"')
        return '"' value '"'
    }

    static BatchQuote(value) {
        value := StrReplace(String(value), "%", "%%")
        value := StrReplace(value, '"', '\"')
        return '"' value '"'
    }

    static Join(items, separator := " ") {
        out := ""
        for item in items
            out .= (out = "" ? "" : separator) item
        return out
    }
}
