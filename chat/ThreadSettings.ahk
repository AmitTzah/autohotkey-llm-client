; ThreadSettings.ahk — computes, restores, persists, and publishes per-thread settings.
; Per-thread overrides take precedence over assistant defaults.

#Include ..\shared\ModelResolver.ahk
#Include db\AssistantRepo.ahk

class ThreadSettings {

    ; Effective settings for a thread from a DB row (Thread_GetSettings
    ; shape) + optional assistant. Per-thread overrides win; the assistant's
    ; values are the fallback.
    static ComputeEffective(row, asst := "") {
        eff := {
            assistantId: row.HasOwnProp("assistantId") ? row.assistantId : "",
            model: "",
            systemMessage: "",
            reasoning: "",
            temperature: "",
            webSearch: row.HasOwnProp("webSearch") ? row.webSearch : false,
            fontSize: (row.HasOwnProp("fontSize") && row.fontSize) ? row.fontSize : 17,
            assistantName: "",
            assistantBaseModel: "",
            assistantDescription: ""
        }
        hasSystemOverride := row.HasOwnProp("systemOverrideSet") ? row.systemOverrideSet : (row.HasOwnProp("systemOverride") && row.systemOverride != "")
        hasReasoningOverride := row.HasOwnProp("reasoningOverrideSet") ? row.reasoningOverrideSet : (row.HasOwnProp("reasoningOverride") && row.reasoningOverride != "")
        hasTemperatureOverride := row.HasOwnProp("temperatureOverrideSet") ? row.temperatureOverrideSet : false
        if row.HasOwnProp("modelOverride") && row.modelOverride
            eff.model := row.modelOverride
        if hasSystemOverride
            eff.systemMessage := row.systemOverride
        if hasReasoningOverride
            eff.reasoning := row.reasoningOverride
        ; AHK treats numeric 0 as falsy, but 0 is a valid temperature override.
        ; Only NULL/empty string means "no override".
        if row.HasOwnProp("temperatureOverride") && (hasTemperatureOverride || row.temperatureOverride != "") {
            eff.temperature := row.temperatureOverride
            hasTemperatureOverride := true
        }
        eff.systemOverrideSet := hasSystemOverride
        eff.reasoningOverrideSet := hasReasoningOverride
        eff.temperatureOverrideSet := hasTemperatureOverride
        if eff.assistantId && asst {
            if !eff.model
                eff.model := asst.baseModel
            if !hasSystemOverride
                eff.systemMessage := AssistantRepo._resolveSystemMessage(asst)
            if !hasReasoningOverride
                eff.reasoning := asst.reasoning
            if !hasTemperatureOverride
                eff.temperature := asst.temperature
            eff.assistantName := asst.HasOwnProp("name") ? asst.name : ""
            eff.assistantBaseModel := asst.baseModel
            eff.assistantDescription := asst.HasOwnProp("description") ? asst.description : ""
        }
        return eff
    }

    ; Restore a thread's settings into requestParams for the thread-load path.
    static RestoreIntoRequestParams(threadId) {
        global requestParams, appDefaultModel
        ThreadSettings._ClearOverrides()
        settings := ChatDB.Thread_GetSettings(threadId)
        if !settings
            return
        asst := settings.assistantId ? AssistantRepo.GetFromSettings(settings.assistantId) : ""
        eff := ThreadSettings.ComputeEffective(settings, asst)
        requestParams["singleAPIModelName"] := eff.model != "" ? eff.model : appDefaultModel
        requestParams["systemOverride"] := eff.systemMessage
        requestParams["reasoningOverride"] := eff.reasoning
        requestParams["temperatureOverride"] := eff.temperature
        requestParams["systemOverrideSet"] := eff.systemOverrideSet
        requestParams["reasoningOverrideSet"] := eff.reasoningOverrideSet
        requestParams["temperatureOverrideSet"] := eff.temperatureOverrideSet
        requestParams["fontSize"] := eff.fontSize
        requestParams["webSearch"] := eff.webSearch
        if eff.assistantId
            requestParams["activeAssistantId"] := eff.assistantId
    }

    ; Clear all request-level overrides to default state.
    static _ClearOverrides() {
        global requestParams, appDefaultModel
        requestParams["systemOverride"] := ""
        requestParams["reasoningOverride"] := ""
        requestParams["temperatureOverride"] := ""
        requestParams["systemOverrideSet"] := false
        requestParams["reasoningOverrideSet"] := false
        requestParams["temperatureOverrideSet"] := false
        requestParams["webSearch"] := false
        if requestParams.Has("activeAssistantId")
            requestParams.Delete("activeAssistantId")
        if requestParams.Has("fontSize")
            requestParams.Delete("fontSize")
        requestParams["singleAPIModelName"] := appDefaultModel
    }

    ; Serialize the current requestParams to the DB settings shape.
    static ToDbObject() {
        global requestParams, responseWindowFontSize, appDefaultModel
        defaultFontSize := IsSet(responseWindowFontSize) ? responseWindowFontSize : "17"
        return {
            assistantId: requestParams.Has("activeAssistantId") ? requestParams["activeAssistantId"] : "",
            modelOverride: requestParams["singleAPIModelName"] != appDefaultModel ? requestParams["singleAPIModelName"] : "",
            systemOverride: requestParams.Has("systemOverride") ? requestParams["systemOverride"] : "",
            reasoningOverride: requestParams.Has("reasoningOverride") ? requestParams["reasoningOverride"] : "",
            temperatureOverride: requestParams.Has("temperatureOverride") ? requestParams["temperatureOverride"] : "",
            systemOverrideSet: requestParams.Has("systemOverrideSet") ? requestParams["systemOverrideSet"] : false,
            reasoningOverrideSet: requestParams.Has("reasoningOverrideSet") ? requestParams["reasoningOverrideSet"] : false,
            temperatureOverrideSet: requestParams.Has("temperatureOverrideSet") ? requestParams["temperatureOverrideSet"] : false,
            webSearch: requestParams.Has("webSearch") ? requestParams["webSearch"] : false,
            fontSize: requestParams.Has("fontSize") ? requestParams["fontSize"] : defaultFontSize
        }
    }

    ; Build the right-rail message payload from the current requestParams.
    static ToThreadSettingsMessage() {
        global requestParams, responseWindowFontSize, models
        model := requestParams["singleAPIModelName"]
        systemMessage := requestParams.Has("systemOverride") ? requestParams["systemOverride"] : ""
        reasoning := requestParams.Has("reasoningOverride") ? requestParams["reasoningOverride"] : ""
        temperature := requestParams.Has("temperatureOverride") ? requestParams["temperatureOverride"] : ""
        defaultFontSize := IsSet(responseWindowFontSize) ? responseWindowFontSize : "17"
        fontSize := requestParams.Has("fontSize") ? requestParams["fontSize"] : defaultFontSize
        webSearch := requestParams.Has("webSearch") ? requestParams["webSearch"] : false

        assistantName := ""
        assistantBaseModel := ""
        assistantDescription := ""
        if requestParams.Has("activeAssistantId") && requestParams["activeAssistantId"] {
            asst := AssistantRepo.GetFromSettings(requestParams["activeAssistantId"])
            if asst {
                assistantName := asst.name
                assistantBaseModel := asst.baseModel ? asst.baseModel : ""
                assistantDescription := asst.HasOwnProp("description") ? asst.description : ""
            }
        }

        thinkingLevels := []
        ; Resolve both full and short model ids for right-rail thinking levels.
        modelMeta := ModelResolver.Lookup(models, model)
        supportsTemperature := !(IsObject(modelMeta) && modelMeta.HasOwnProp("api") && modelMeta.api = "codex-cli")
        if IsObject(modelMeta) && modelMeta.HasOwnProp("thinkingLevelMap") && IsObject(modelMeta.thinkingLevelMap) {
            for level in modelMeta.thinkingLevelMap
                thinkingLevels.Push(level)
        }

        return {
            model: model,
            systemMessage: systemMessage,
            reasoning: reasoning,
            temperature: temperature,
            systemOverrideSet: requestParams.Has("systemOverrideSet") ? requestParams["systemOverrideSet"] : false,
            reasoningOverrideSet: requestParams.Has("reasoningOverrideSet") ? requestParams["reasoningOverrideSet"] : false,
            temperatureOverrideSet: requestParams.Has("temperatureOverrideSet") ? requestParams["temperatureOverrideSet"] : false,
            webSearch: webSearch,
            fontSize: fontSize,
            assistantName: assistantName,
            assistantBaseModel: assistantBaseModel,
            assistantDescription: assistantDescription,
            thinkingLevels: thinkingLevels,
            supportsTemperature: supportsTemperature
        }
    }
}
