; ======================================================
; ChatSettings.ahk — Thread settings + assistant/model management
;
; Manages requestParams for the current thread: restore,
; save, reset, dropdown label, assistant switching,
; model settings persistence.
; ======================================================

#Include ..\chat\ThreadSettings.ahk

; Update provider tracking for API logs from a model id.
_updateProviderFromModel(model) {
    parts := ModelParser.Split(model)
    if parts.provider
        requestParams["providerName"] := parts.provider
}

; Clear all request-level overrides to default state.
_ClearRequestOverrides() {
    ThreadSettings._ClearOverrides()
}

; Apply saved per-thread settings from DB to requestParams.
_restoreThreadSettings(threadId) {
    ; Per-thread overrides take precedence over assistant defaults.
    ThreadSettings.RestoreIntoRequestParams(threadId)
}

; Normalize a JSON boolean / 1 / 0 / "true" / "false" value to a real boolean.
_BoolFrom(value) {
    if value = 1 || value = "1" || value = "true" || value = "on" || value = "yes"
        return true
    return false
}

; Build the settings object from current requestParams state.
_CurrentSettingsObject() {
    return ThreadSettings.ToDbObject()
}

; Persist current requestParams settings to a thread (called on thread creation).
_saveCurrentSettingsToThread(threadId) {
    ChatDB.Thread_UpdateSettings(threadId, _CurrentSettingsObject())
}

; Reset settings to defaults (no assistant, default model, no overrides).
_resetToDefaultSettings() {
    _ClearRequestOverrides()
}

; Apply an assistant's settings to requestParams and mark it active.
; Shared by handleSwitchAssistant and the new-chat default resolution.
_applyAssistantToRequestParams(asst) {
    requestParams["singleAPIModelName"] := asst.baseModel
    requestParams["systemOverride"] := AssistantRepo._resolveSystemMessage(asst)
    requestParams["reasoningOverride"] := asst.reasoning
    requestParams["temperatureOverride"] := asst.temperature
    requestParams["systemOverrideSet"] := false
    requestParams["reasoningOverrideSet"] := false
    requestParams["temperatureOverrideSet"] := false
    requestParams["activeAssistantId"] := asst.id
    if ModelParser.Split(asst.baseModel).provider != "codex"
        requestParams["imageGeneration"] := false
    _updateProviderFromModel(asst.baseModel)
}

; Apply the configured "new chats start with" default to requestParams.
; "" = app default model (appDefaultModel); "asst:<id>" = an assistant;
; anything else is treated as a model id. Returns true when a default applied.
_applyNewChatDefault() {
    global newChatStartsWith
    value := IsSet(newChatStartsWith) ? newChatStartsWith : ""
    ; App Default leaves the app default model in place. Assistants are chosen
    ; explicitly through General > New Chats Start With, so there is one source
    ; of truth for how a new chat starts.
    if value = ""
        return false
    if SubStr(value, 1, 5) = "asst:" {
        asst := AssistantRepo.GetFromSettings(SubStr(value, 6))
        if !asst
            return false
        _applyAssistantToRequestParams(asst)
        return true
    }
    ; Model default: drop any active assistant and use the model directly.
    if requestParams.Has("activeAssistantId")
        requestParams.Delete("activeAssistantId")
    requestParams["singleAPIModelName"] := value
    _updateProviderFromModel(value)
    return true
}

; Apply the configured new-chat model/assistant and default font size to a
; brand-new thread that has no messages or stored settings.
_applyNewChatDefaultToFreshThread(threadId) {
    if ChatDB.Msg_GetActivePath(threadId).Length > 0
        return false
    s := ChatDB.Thread_GetSettings(threadId)
    if s.modelOverride || s.assistantId || s.systemOverride || s.reasoningOverride || s.temperatureOverride != ""
        return false
    _resetToDefaultSettings()
    if _applyNewChatDefault()
        ChatDB.Thread_UpdateSettings(threadId, _CurrentSettingsObject())
    global responseWindowFontSize
    if IsSet(responseWindowFontSize) && responseWindowFontSize
        ChatDB.Thread_UpdateSettings(threadId, { fontSize: responseWindowFontSize })
    return true
}

; Send current dropdown label to WebView (assistant name / model name / "Default Model").
_sendDropdownLabel() {
    if requestParams.Has("activeAssistantId") && requestParams["activeAssistantId"] {
        asst := AssistantRepo.GetFromSettings(requestParams["activeAssistantId"])
        if asst {
            postWebMessage("dropdownLabel", { text: asst.name, isAssistant: true })
            return
        }
    }
    model := requestParams["singleAPIModelName"]
    if model {
        ; Always show actual model name, never "Default Model"
        displayModel := ModelParser.StripProvider(model)
        postWebMessage("dropdownLabel", { text: displayModel, isAssistant: false })
        return
    }
    postWebMessage("dropdownLabel", { text: ModelParser.StripProvider(appDefaultModel), isAssistant: false })
}

handleSwitchAssistant(parsed) {
    global activeThreadId
    assistantId := parsed.Get("assistantId", "")
    if !assistantId {
        ; User selected "Default Model" — clear assistant
        _resetToDefaultSettings()
        if activeThreadId {
            ChatDB.Thread_UpdateSettings(activeThreadId, _CurrentSettingsObject())
        }
        _sendDropdownLabel()
        postCurrentSettingsToWebView()
        return
    }

    asst := AssistantRepo.GetFromSettings(assistantId)
    if !asst
        return

    _applyAssistantToRequestParams(asst)

    ; Persist to DB
    if activeThreadId {
        ChatDB.Thread_UpdateSettings(activeThreadId, {
            assistantId: assistantId,
            modelOverride: "",
            systemOverride: "",
            reasoningOverride: "",
            temperatureOverride: "",
            webSearch: requestParams.Has("webSearch") ? requestParams["webSearch"] : false,
            imageGeneration: requestParams.Has("imageGeneration") ? requestParams["imageGeneration"] : false
        })
    }

    _sendDropdownLabel()
    postCurrentSettingsToWebView()
    if activeThreadId
        postThreadStats(activeThreadId)
    debugLog("[MODEL] Switched to assistant: " asst.name " (" asst.baseModel ")")
}

handleModelSettingsUpdate(parsed) {
    global activeThreadId
    model := parsed.Get("model", "")
    systemMessage := parsed.Get("systemMessage", "")
    reasoning := parsed.Get("reasoning", "")
    temperature := parsed.Get("temperature", "")
    systemOverrideSet := _BoolFrom(parsed.Get("systemOverrideSet", systemMessage != ""))
    reasoningOverrideSet := _BoolFrom(parsed.Get("reasoningOverrideSet", reasoning != ""))
    temperatureOverrideSet := _BoolFrom(parsed.Get("temperatureOverrideSet", temperature != ""))
    ; An immediate settings flush can arrive from an older renderer snapshot
    ; after the explicit blank was saved. Preserve that durable choice rather
    ; than turning it back into assistant inheritance.
    if !systemMessage && activeThreadId && !systemOverrideSet {
        savedSettings := ChatDB.Thread_GetSettings(activeThreadId)
        if savedSettings && savedSettings.systemOverrideSet
            systemOverrideSet := true
    }
    webSearch := _BoolFrom(parsed.Get("webSearch", false))
    imageGeneration := _BoolFrom(parsed.Get("imageGeneration", false))

    ; Only clear assistant when user explicitly changes the model (non-empty).
    ; When model is empty, the user is adjusting side settings (reasoning, temperature, etc.)
    ; while an assistant is active — preserve the assistant.
    if model {
        if requestParams.Has("activeAssistantId")
            requestParams.Delete("activeAssistantId")
        requestParams["singleAPIModelName"] := model
        _updateProviderFromModel(model)
    } else if !requestParams.Has("activeAssistantId") {
        ; No explicit model and no active assistant — fall back to the default.
        requestParams["singleAPIModelName"] := appDefaultModel
    }
    requestParams["systemOverride"] := systemMessage
    requestParams["reasoningOverride"] := reasoning
    requestParams["temperatureOverride"] := temperature
    requestParams["systemOverrideSet"] := systemOverrideSet
    requestParams["reasoningOverrideSet"] := reasoningOverrideSet
    requestParams["temperatureOverrideSet"] := temperatureOverrideSet
    requestParams["webSearch"] := webSearch
    ; UI state is not a security boundary: only the effective Codex provider
    ; may retain this per-thread permission.
    requestParams["imageGeneration"] := ModelParser.Split(requestParams["singleAPIModelName"]).provider = "codex" && imageGeneration

    ; Persist to DB
    if activeThreadId {
        ChatDB.Thread_UpdateSettings(activeThreadId, _CurrentSettingsObject())
        postThreadStats(activeThreadId)

    }

    _sendDropdownLabel()
    postCurrentSettingsToWebView()
    debugLog("[SETTINGS] Saved — thread=" activeThreadId " model=" (model ? model : appDefaultModel) " systemMsg=" StrLen(systemMessage) "chars")
}

postCurrentSettingsToWebView() {
    ; ThreadSettings owns the right-rail payload shape and precedence rules.
    postWebMessage("threadSettings", ThreadSettings.ToThreadSettingsMessage())
}

postAssistantsToWebView() {
    global assistants, models
    if !IsSet(assistants) || !IsSet(models)
        return
    postWebMessage("assistantList", assistants)

    ; Also send model list grouped by provider for the two-dropdown selector
    modelByProvider := Map()
    for modelId, modelData in models {
        parts := ModelParser.Split(modelId)
        if parts.provider {
            providerKey := parts.provider
            shortName := parts.name
            if !modelByProvider.Has(providerKey)
                modelByProvider[providerKey] := []
            modelByProvider[providerKey].Push({
                id: shortName,
                fullId: modelId,
                name: modelData.HasOwnProp("displayName") ? modelData.displayName : shortName,
                reasoning: modelData.HasOwnProp("reasoning") ? modelData.reasoning : false,
                vision: modelData.HasOwnProp("vision") ? modelData.vision : false,
                supportsTemperature: !(modelData.HasOwnProp("api") && modelData.api = "codex-cli")
            })
        }
    }
    postWebMessage("modelList", modelByProvider)
}

; Delayed push: send assistant list after WebView page loads.
; Called from the main init flow with a timer to avoid race conditions.
SetTimer SendAssistantsDelayed, -500
SendAssistantsDelayed() {
    postAssistantsToWebView()
}

; Handle per-chat font size update from the header +/- buttons.
; Keep the size in requestParams before a thread exists; only the DB write
; requires an active thread.
handleUpdateFontSize(parsed) {
    global activeThreadId
    fontSize := parsed.Get("fontSize", 17)
    requestParams["fontSize"] := fontSize
    if activeThreadId
        ChatDB.Thread_UpdateSettings(activeThreadId, { fontSize: fontSize })
}
