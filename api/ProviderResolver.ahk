; ----------------------------------------------------
; ProviderResolver.ahk — LLM provider resolution
;
; Given a model string, resolves which provider and
; endpoint to use. Extracted from LLMRequestBuilder.ahk.
; ----------------------------------------------------

class ProviderResolver {
    static _getApiKey(p) {
        if p.HasOwnProp("authMode") && p.authMode = "direct" && p.HasOwnProp("apiKey") && p.apiKey != ""
            return p.apiKey
        if p.HasOwnProp("authMode") && p.authMode = "chatgpt"
            return ""
        if p.HasOwnProp("authEnvVar") && p.authEnvVar != ""
            return EnvGet(p.authEnvVar)
        return ""
    }

    static _buildResult(providerKey, modelName, p) {
        ; OpenRouter uses an outer AhkLLM transport prefix plus an upstream slug.
        ; Nested models send modelName directly; the built-in free router remains
        ; addressed as "openrouter/free" for compatibility.
        apiModelName := providerKey = "openrouter" && modelName = "free" ? "openrouter/free" : modelName
        resolvedKey := ProviderResolver._getApiKey(p)
        debugLog(ProviderResolver._AuthDiagnostic(providerKey, apiModelName, p, resolvedKey), "ProviderResolver")
        return {
            providerKey: providerKey,
            modelName: apiModelName,
            apiKey: resolvedKey,
            endpoint: p.endpoint,
            fimEndpoint: p.HasOwnProp("fimEndpoint") ? p.fimEndpoint : "",
            transport: p.HasOwnProp("transport") && p.transport != "" ? p.transport : "http",
            authMode: p.HasOwnProp("authMode") ? p.authMode : "env",
            billingMode: p.HasOwnProp("billingMode") ? p.billingMode : "api"
        }
    }

    ; Redacted provider-auth diagnostics. Never include the credential itself
    ; or the cURL command line: both may contain sensitive bearer tokens.
    static _AuthDiagnostic(providerKey, apiModelName, p, resolvedKey) {
        authMode := p.HasOwnProp("authMode") ? p.authMode : "env"
        envVar := p.HasOwnProp("authEnvVar") ? p.authEnvVar : ""
        directConfigured := authMode = "direct" && p.HasOwnProp("apiKey") && p.apiKey != ""
        source := !resolvedKey ? "none" : (directConfigured ? "direct" : "env")
        return "provider=" providerKey " model=" apiModelName
            . " endpoint=" (p.HasOwnProp("endpoint") ? p.endpoint : "")
            . " authSource=" source " authEnvVar=" envVar
            . " keyPresent=" (resolvedKey != "" ? "true" : "false")
            . " keyLength=" StrLen(resolvedKey)
    }

    ; Given a model string like "deepseek/deepseek-v4-pro" or "deepseek-v4-pro",
    ; returns { providerKey, modelName, apiKey, endpoint, fimEndpoint }.
    ; Unprefixed model ids are resolved through providerMap.
    static Resolve(modelId) {
        parts := ModelParser.Split(modelId)
        if parts.provider {
            if providers.Has(parts.provider) {
                p := providers[parts.provider]
                return ProviderResolver._buildResult(parts.provider, parts.name, p)
            }
        }

        ; No provider prefix: infer the provider from providerMap.
        providerKey := "deepseek"
        for prefix, prov in providerMap {
            ; Match by prefix only; substring matching can select the wrong provider.
            ; "mygpt-custom" resolve to the gpt provider.
            if SubStr(modelId, 1, StrLen(prefix)) = prefix {
                providerKey := prov
                break
            }
        }

        if providers.Has(providerKey)
            return ProviderResolver._buildResult(providerKey, modelId, providers[providerKey])

        ; Do not hardcode a fallback provider: users may remove any provider.
        ; the Settings UI lets the user DELETE the deepseek provider (>=1
        ; provider must remain), and a missing-key Map index THROWS in AHK v2,
        ; crashing EVERY request for a model whose prefix is not covered.
        ; Fall back to the FIRST configured provider instead (a clean
        ; fallback; callers still surface api-key/endpoint errors) and never
        ; index a missing key.
        for firstKey in providers
            return ProviderResolver._buildResult(firstKey, modelId, providers[firstKey])
        return { providerKey: "", modelName: modelId, apiKey: "", endpoint: "", fimEndpoint: "", transport: "http", authMode: "env", billingMode: "api" }
    }
}
