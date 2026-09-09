; ----------------------------------------------------
; RuntimeResolver.ahk — API key check and provider resolution
;
; Checks that at least one configured provider has an API key, then resolves
; APIKey, APIEndpoint, and FIMEndpoint for runtime use.
; ----------------------------------------------------

; ----------------------------------------------------
; Global variables (set by ResolvePrimaryProvider / ResolveDefaultAssistant)
; ----------------------------------------------------
global APIKey := ""
global APIEndpoint := ""
global FIMEndpoint := ""

; ----------------------------------------------------
; API KEY CHECK — Ensures at least one provider key is set
; Called AFTER SettingsHandler.Load() so direct-entry keys are available.
; ----------------------------------------------------
; Resolve a provider's API key: direct-entry key wins, else the env var.
_RuntimeResolver_ApiKeyFor(p) {
    if p.HasOwnProp("authMode") && p.authMode = "direct" && p.HasOwnProp("apiKey") && p.apiKey != ""
        return p.apiKey
    if p.HasOwnProp("authEnvVar")
        return EnvGet(p.authEnvVar)
    return ""
}

RuntimeResolver_CheckApiKeys() {
    global providers
    anyKeyFound := false
    keyProviders := ""
    for providerKey, p in providers {
        transport := p.HasOwnProp("transport") && p.transport != "" ? p.transport : "http"
        if transport != "http" {
            anyKeyFound := true
            break
        }
        key := _RuntimeResolver_ApiKeyFor(p)
        if key != "" {
            anyKeyFound := true
            break
        }
        keyProviders .= "`n  " (p.HasOwnProp("authEnvVar") ? p.authEnvVar : "direct") "  (for " p.displayName ")"
    }
    if !anyKeyFound {
        msg := "No API keys found.`n`n"
            . "Set at least one environment variable or enter a direct key in Settings and restart:"
            . keyProviders
            . "`n`nExample:"
            . "`n  setx DEEPSEEK_API_KEY sk-your-key-here"
        MsgBox(msg, "Missing API Keys", "IconX")
        ExitApp()
    }
}

; ----------------------------------------------------
; RESOLVE PRIMARY PROVIDER — first configured provider with a key
; ----------------------------------------------------
RuntimeResolver_ResolvePrimaryProvider() {
    global providers, APIKey, APIEndpoint, FIMEndpoint
    for providerKey, p in providers {
        apiKey := _RuntimeResolver_ApiKeyFor(p)
        if apiKey != "" {
            APIKey := apiKey
            APIEndpoint := p.endpoint
            FIMEndpoint := p.HasOwnProp("fimEndpoint") ? p.fimEndpoint : ""
            return
        }
    }
    ; Safety net: fall back to deepseek
    if providers.Has("deepseek") {
        APIKey := ""
        APIEndpoint := providers["deepseek"].endpoint
        FIMEndpoint := providers["deepseek"].HasOwnProp("fimEndpoint") ? providers["deepseek"].fimEndpoint : ""
    }
}

