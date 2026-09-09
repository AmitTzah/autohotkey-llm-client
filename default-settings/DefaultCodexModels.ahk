; ============================================================================
; DefaultCodexModels.ahk -- curated ChatGPT-authenticated Codex CLI models
;
; Kept separate from DefaultModels.ahk because Refresh-Models.ps1 regenerates
; that file from models.dev. These entries describe AhkLLM's local Codex
; transport, not API pricing. Availability is ultimately controlled by the
; user's ChatGPT/Codex plan and installed Codex CLI.
; ============================================================================

models["codex/gpt-5.6-luna"] := {
    provider: "codex", api: "codex-cli",
    compat: Map("thinkingFormat", "codex-cli", "supportsReasoningEffort", true, "supportsUsageInStreaming", false, "maxTokensField", ""),
    thinkingLevelMap: Map("none", "none", "low", "low", "medium", "medium", "high", "high", "xhigh", "xhigh", "max", "max"),
    thinkingOff: "none",
    input: 0, cachedInput: 0, output: 0, context: 0, reasoning: true, vision: false
}

models["codex/gpt-5.6-terra"] := {
    provider: "codex", api: "codex-cli",
    compat: Map("thinkingFormat", "codex-cli", "supportsReasoningEffort", true, "supportsUsageInStreaming", false, "maxTokensField", ""),
    thinkingLevelMap: Map("none", "none", "low", "low", "medium", "medium", "high", "high", "xhigh", "xhigh", "max", "max"),
    thinkingOff: "none",
    input: 0, cachedInput: 0, output: 0, context: 0, reasoning: true, vision: false
}

models["codex/gpt-5.6-sol"] := {
    provider: "codex", api: "codex-cli",
    compat: Map("thinkingFormat", "codex-cli", "supportsReasoningEffort", true, "supportsUsageInStreaming", false, "maxTokensField", ""),
    thinkingLevelMap: Map("none", "none", "low", "low", "medium", "medium", "high", "high", "xhigh", "xhigh", "max", "max"),
    thinkingOff: "none",
    input: 0, cachedInput: 0, output: 0, context: 0, reasoning: true, vision: false
}

models["codex/gpt-6-astra"] := {
    provider: "codex", api: "codex-cli",
    compat: Map("thinkingFormat", "codex-cli", "supportsReasoningEffort", true, "supportsUsageInStreaming", false, "maxTokensField", ""),
    thinkingLevelMap: Map("low", "low", "medium", "medium", "high", "high", "xhigh", "xhigh", "max", "max"),
    thinkingOff: "low",
    input: 0, cachedInput: 0, output: 0, context: 0, reasoning: true, vision: false
}
