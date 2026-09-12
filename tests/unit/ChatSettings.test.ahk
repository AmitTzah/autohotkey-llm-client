; ======================================================
; ChatSettings.test.ahk — Unit tests for ChatSettings module
;
; Tests: handleModelSettingsUpdate preserves assistant
;        when only side settings change (thinking level, etc.)
; ======================================================

class ChatSettingsTest {

    static __New() {
        RegisterTestClass("ChatSettingsTest")
    }

    _openDb() {
        if ChatDB.isOpen {
            oldPath := ChatDB.dbPath
            ChatDB.Close()
            try FileDelete(oldPath)
        }
        ChatDB.Open(A_Temp "\test_chat_settings_" A_TickCount "_" Random(1000, 999999) ".db")
    }

    _closeDb() {
        if ChatDB.isOpen {
            dbPath := ChatDB.dbPath
            ChatDB.Close()
            try FileDelete(dbPath)
        }
    }

    test_preservesAssistant_whenOnlyReasoningChanges() {
        global requestParams, activeThreadId, assistants

        this._openDb()

        ; Stub assistants global (no DB seeding needed)
        assistants := [{id: "asst-1", name: "Test Asst", baseModel: "deepseek/test", systemMessage: "Hello", reasoning: "", temperature: "", isDefault: true}]
        asst := assistants[1]

        ; Set up requestParams with an active assistant
        requestParams["activeAssistantId"] := asst.id
        requestParams["singleAPIModelName"] := asst.baseModel
        requestParams["systemOverride"] := asst.systemMessage
        requestParams["reasoningOverride"] := ""
        requestParams["temperatureOverride"] := ""

        ; Simulate user changing thinking level from right sidebar
        ; (model="" because assistant mode doesn't populate model field)
        parsed := jsongo.Parse('{"model":"","systemMessage":"","reasoning":"high","temperature":""}')
        handleModelSettingsUpdate(parsed)

        ; Assert: assistant should still be active
        if !requestParams.Has("activeAssistantId") || !requestParams["activeAssistantId"]
            throw Error("activeAssistantId was cleared when only reasoning changed")
        if requestParams["activeAssistantId"] != asst.id
            throw Error("activeAssistantId changed to different assistant")

        ; Assert: reasoning was updated
        if requestParams["reasoningOverride"] != "high"
            throw Error("reasoningOverride was not updated. Got: " requestParams["reasoningOverride"])

        ; Assert: model was not changed
        if requestParams["singleAPIModelName"] != asst.baseModel
            throw Error("singleAPIModelName was changed. Got: " requestParams["singleAPIModelName"] " expected: " asst.baseModel)

        this._closeDb()
    }

    test_clearsAssistant_whenModelExplicitlyChanged() {
        global requestParams, activeThreadId, assistants

        this._openDb()

        assistants := [{id: "asst-1", name: "Test Asst", baseModel: "deepseek/test", systemMessage: "Hello", reasoning: "", temperature: "", isDefault: true}]
        asst := assistants[1]

        ; Set up requestParams with an active assistant
        requestParams["activeAssistantId"] := asst.id
        requestParams["singleAPIModelName"] := asst.baseModel
        requestParams["systemOverride"] := asst.systemMessage
        requestParams["reasoningOverride"] := ""
        requestParams["temperatureOverride"] := ""

        ; Simulate user explicitly picking a model (non-empty model field)
        parsed := jsongo.Parse('{"model":"deepseek/deepseek-v4-flash","systemMessage":"","reasoning":"","temperature":""}')
        handleModelSettingsUpdate(parsed)

        ; Assert: assistant should be cleared
        if requestParams.Has("activeAssistantId")
            throw Error("activeAssistantId was NOT cleared when model explicitly changed")

        ; Assert: model was updated
        if requestParams["singleAPIModelName"] != "deepseek/deepseek-v4-flash"
            throw Error("singleAPIModelName was not updated. Got: " requestParams["singleAPIModelName"])

        this._closeDb()
    }

    test_revertsToDefaultModel_whenNoAssistantAndNoModel() {
        global requestParams, activeThreadId, appDefaultModel

        this._openDb()

        ; Clean state — no assistant, no model override
        requestParams.Delete("activeAssistantId")
        requestParams["singleAPIModelName"] := "some-other-model"
        requestParams["systemOverride"] := ""
        requestParams["reasoningOverride"] := ""
        requestParams["temperatureOverride"] := ""

        ; Simulate settings change with empty model and no assistant
        parsed := jsongo.Parse('{"model":"","systemMessage":"","reasoning":"low","temperature":""}')
        handleModelSettingsUpdate(parsed)

        ; Assert: reverts to default model
        if requestParams["singleAPIModelName"] != appDefaultModel
            throw Error("Did not revert to default model. Got: " requestParams["singleAPIModelName"] " expected: " appDefaultModel)

        ; Assert: reasoning was updated
        if requestParams["reasoningOverride"] != "low"
            throw Error("reasoningOverride was not updated. Got: " requestParams["reasoningOverride"])

        this._closeDb()
    }

    ; Regression: right-rail Advanced toggles (Code Execution / Web Search)
    ; used to do nothing — only a CSS class changed. They must be stored,
    ; round-tripped, and persisted with the thread as stubs.
    test_advancedToggles_storedAndPersisted() {
        global requestParams, activeThreadId, assistants

        this._openDb()

        assistants := [{id: "asst-1", name: "Test Asst", baseModel: "deepseek/test", systemMessage: "Hello", reasoning: "", temperature: "", isDefault: true}]
        if requestParams.Has("activeAssistantId")
            requestParams.Delete("activeAssistantId")
        requestParams["singleAPIModelName"] := "deepseek/deepseek-v4-flash"

        ChatDB.Thread_Create("Toggle Thread")
        threads := ChatDB.Thread_List()
        activeThreadId := threads[threads.Length].id

        parsed := jsongo.Parse('{"model":"deepseek/deepseek-v4-flash","systemMessage":"","reasoning":"","temperature":"","webSearch":true}')
        handleModelSettingsUpdate(parsed)

        ; In-memory flags
        if requestParams["webSearch"] != true
            throw Error("webSearch was not stored in requestParams")

        ; Round-trip through the settings object
        obj := _CurrentSettingsObject()
        if obj.webSearch != true
            throw Error("_CurrentSettingsObject does not carry the advanced toggles")

        ; Persisted to the thread and restored by Thread_GetSettings
        saved := ChatDB.Thread_GetSettings(activeThreadId)
        if saved.webSearch != true
            throw Error("advanced toggles did not persist to the thread: " jsongo.Stringify(saved))

        activeThreadId := ""
        this._closeDb()
    }

    test_applyNewChatDefault_appDefault_keepsChatDefaultModel() {
        global newChatStartsWith, requestParams, assistants, appDefaultModel

        oldDefault := newChatStartsWith
        oldAsst := assistants
        oldModel := requestParams["singleAPIModelName"]
        assistants := []
        newChatStartsWith := ""
        try {
            applied := _applyNewChatDefault()
            if applied
                throw Error("App default should not apply an assistant/model")
            if requestParams["singleAPIModelName"] != oldModel
                throw Error("App default must leave the current default model intact")
        } finally {
            newChatStartsWith := oldDefault
            assistants := oldAsst
            requestParams["singleAPIModelName"] := oldModel
        }
    }

    ; Legacy isDefault metadata must not override General > New Chats Start With.
    ; App Default means the app default model even when an old settings file still
    ; contains an assistant with isDefault:true.

    test_applyNewChatDefault_ignoresLegacyIsDefaultAssistant() {
        global newChatStartsWith, requestParams, assistants

        oldDefault := newChatStartsWith
        oldAsst := assistants
        oldModel := requestParams["singleAPIModelName"]
        oldAsstId := requestParams.Has("activeAssistantId") ? requestParams["activeAssistantId"] : ""
        assistants := [
            { id: "asst-a", name: "A", baseModel: "openai/gpt-5-mini", systemMessage: "sysA", reasoning: "", temperature: "", isDefault: false },
            { id: "asst-b", name: "B", baseModel: "deepseek/deepseek-v4-flash", systemMessage: "sysB", reasoning: "high", temperature: "0.5", isDefault: true }
        ]
        newChatStartsWith := ""
        try {
            applied := _applyNewChatDefault()
            if !applied
                applied := false
            if applied
                throw Error("legacy isDefault must not override App Default")
            if requestParams.Has("activeAssistantId") && requestParams["activeAssistantId"] = "asst-b"
                throw Error("legacy isDefault assistant must not become active")
            if requestParams["singleAPIModelName"] != oldModel
                throw Error("App Default must leave the current default model intact")
            if requestParams["systemOverride"] = "sysB"
                throw Error("legacy isDefault assistant system message must not apply")
            ; Keep the legacy cleanup path safe when there was no active assistant key.
            if oldAsstId = "" && !requestParams.Has("activeAssistantId")
                requestParams["activeAssistantId"] := ""
        } finally {
            newChatStartsWith := oldDefault
            assistants := oldAsst
            requestParams["singleAPIModelName"] := oldModel
            if oldAsstId = ""
                requestParams.Delete("activeAssistantId")
            else
                requestParams["activeAssistantId"] := oldAsstId
            requestParams["systemOverride"] := ""
            requestParams["temperatureOverride"] := ""
        }
    }

    test_prepareFreshChatSettings_appliesConfiguredModel_andClearsStaleThreadState() {
        global newChatStartsWith, requestParams

        oldDefault := newChatStartsWith
        oldParams := requestParams
        try {
            newChatStartsWith := "openai/gpt-5-mini"
            requestParams := Map(
                "singleAPIModelName", "deepseek/deepseek-v4-pro",
                "activeAssistantId", "stale-asst",
                "systemOverride", "stale system",
                "reasoningOverride", "high",
                "temperatureOverride", "0.4",
                "webSearch", true
            )

            applied := _prepareFreshChatSettings()
            if !applied
                throw Error("configured fresh-chat model should apply")
            if requestParams["singleAPIModelName"] != "openai/gpt-5-mini"
                throw Error("fresh-chat model was not applied")
            if requestParams.Has("activeAssistantId")
                throw Error("fresh-chat model should clear a stale assistant")
            if requestParams["systemOverride"] != "" || requestParams["reasoningOverride"] != "" || requestParams["temperatureOverride"] != ""
                throw Error("fresh-chat preparation must clear stale per-thread overrides")
            if requestParams["webSearch"] != false
                throw Error("fresh-chat preparation must clear stale per-thread tools")
        } finally {
            newChatStartsWith := oldDefault
            requestParams := oldParams
        }
    }

    test_applyNewChatDefault_assistant_applies() {
        global newChatStartsWith, requestParams, assistants

        oldDefault := newChatStartsWith
        oldAsst := assistants
        oldModel := requestParams["singleAPIModelName"]
        oldAsstId := requestParams.Has("activeAssistantId") ? requestParams["activeAssistantId"] : ""
        assistants := [{ id: "asst-9", name: "Nine", baseModel: "openai/gpt-5-mini", systemMessage: "sys", reasoning: "low", temperature: "0.7" }]
        newChatStartsWith := "asst:asst-9"
        try {
            applied := _applyNewChatDefault()
            if !applied
                throw Error("Assistant default should apply")
            if requestParams["activeAssistantId"] != "asst-9"
                throw Error("Assistant default should mark the assistant active")
            if requestParams["singleAPIModelName"] != "openai/gpt-5-mini"
                throw Error("Assistant default should apply its base model")
            if requestParams["systemOverride"] != "sys"
                throw Error("Assistant default should apply its system message")
            if requestParams["temperatureOverride"] != "0.7"
                throw Error("Assistant default should apply its temperature")
        } finally {
            newChatStartsWith := oldDefault
            assistants := oldAsst
            requestParams["singleAPIModelName"] := oldModel
            if oldAsstId = ""
                requestParams.Delete("activeAssistantId")
            else
                requestParams["activeAssistantId"] := oldAsstId
            requestParams["systemOverride"] := ""
            requestParams["temperatureOverride"] := ""
        }
    }

    test_applyNewChatDefault_model_applies_andClearsAssistant() {
        global newChatStartsWith, requestParams, assistants

        oldDefault := newChatStartsWith
        oldAsst := assistants
        oldModel := requestParams["singleAPIModelName"]
        requestParams["activeAssistantId"] := "asst-stale"
        assistants := [{ id: "asst-1", name: "One", baseModel: "deepseek/deepseek-v4-flash", systemMessage: "", reasoning: "", temperature: "" }]
        newChatStartsWith := "openai/gpt-5-mini"
        try {
            applied := _applyNewChatDefault()
            if !applied
                throw Error("Model default should apply")
            if requestParams["singleAPIModelName"] != "openai/gpt-5-mini"
                throw Error("Model default should set the model, got '" requestParams["singleAPIModelName"] "'")
            if requestParams.Has("activeAssistantId")
                throw Error("Model default should clear any active assistant")
        } finally {
            newChatStartsWith := oldDefault
            assistants := oldAsst
            requestParams["singleAPIModelName"] := oldModel
            if requestParams.Has("activeAssistantId")
                requestParams.Delete("activeAssistantId")
        }
    }

    ; Regression (bug #47): per-thread overrides must survive a reload even
    ; when an assistant is active. _restoreThreadSettings used to apply the
    ; stored overrides and THEN overwrite all three with the assistant's
    ; values, so any per-thread edit (system prompt, thinking, temperature)
    ; made while an assistant was active silently vanished on the next load.
    test_restoreThreadSettings_keepsPerThreadOverrides_whenAssistantActive() {
        global requestParams, activeThreadId, assistants

        this._openDb()

        assistants := [{
            id: "asst-47", name: "Test Asst", baseModel: "deepseek/test",
            systemMessage: "assistant system", systemMessageFile: "",
            reasoning: "high", temperature: "0.3"
        }]

        threadId := ChatDB.Thread_Create("Override Thread")
        ChatDB.Thread_UpdateSettings(threadId, {
            assistantId: "asst-47",
            systemOverride: "user override",
            reasoningOverride: "low",
            temperatureOverride: "0.9"
        })

        _restoreThreadSettings(threadId)

        if !requestParams.Has("activeAssistantId") || requestParams["activeAssistantId"] != "asst-47"
            throw Error("assistant should stay active")
        if requestParams["systemOverride"] != "user override"
            throw Error("systemOverride was overwritten by the assistant: " requestParams["systemOverride"])
        if requestParams["reasoningOverride"] != "low"
            throw Error("reasoningOverride was overwritten by the assistant: " requestParams["reasoningOverride"])
        if requestParams["temperatureOverride"] != "0.9"
            throw Error("temperatureOverride was overwritten by the assistant: " requestParams["temperatureOverride"])

        this._closeDb()
    }

    ; The fallback must stay intact: with NO per-thread overrides, the
    ; assistant's values (system message, reasoning, temperature) still apply
    ; when the thread reloads.
    test_restoreThreadSettings_fallsBackToAssistantDefaults() {
        global requestParams, activeThreadId, assistants

        this._openDb()

        assistants := [{
            id: "asst-47b", name: "Test Asst", baseModel: "deepseek/test",
            systemMessage: "assistant system", systemMessageFile: "",
            reasoning: "high", temperature: "0.3"
        }]

        threadId := ChatDB.Thread_Create("Assistant Thread")
        ChatDB.Thread_UpdateSettings(threadId, { assistantId: "asst-47b" })

        _restoreThreadSettings(threadId)

        if !requestParams.Has("activeAssistantId") || requestParams["activeAssistantId"] != "asst-47b"
            throw Error("assistant should be active")
        if requestParams["systemOverride"] != "assistant system"
            throw Error("assistant system message should apply when no override: " requestParams["systemOverride"])
        if requestParams["reasoningOverride"] != "high"
            throw Error("assistant reasoning should apply when no override: " requestParams["reasoningOverride"])
        if requestParams["temperatureOverride"] != "0.3"
            throw Error("assistant temperature should apply when no override: " requestParams["temperatureOverride"])

        this._closeDb()
    }

    ; Step 4 of the architecture refactor: ThreadSettings.ComputeEffective is
    ; the single precedence implementation (override wins, assistant falls
    ; back). These tests pin the precedence so the restore path and the
    ; message builder cannot drift again.
    test_ThreadSettings_ComputeEffective_overridesWin() {
        global assistants
        oldAsst := assistants
        assistants := [{
            id: "asst-eff-1", name: "Eff Asst", baseModel: "deepseek/test",
            systemMessage: "assistant system", systemMessageFile: "",
            reasoning: "high", temperature: "0.3"
        }]
        try {
            row := {
                assistantId: "asst-eff-1",
                modelOverride: "openai/gpt-5-mini",
                systemOverride: "user override",
                reasoningOverride: "low",
                temperatureOverride: "0.9",
                webSearch: false,
                fontSize: 20
            }
            eff := ThreadSettings.ComputeEffective(row, assistants[1])
            if eff.model != "openai/gpt-5-mini"
                throw Error("model override should win: " eff.model)
            if eff.systemMessage != "user override"
                throw Error("system override should win: " eff.systemMessage)
            if eff.reasoning != "low"
                throw Error("reasoning override should win: " eff.reasoning)
            if eff.temperature != "0.9"
                throw Error("temperature override should win: " eff.temperature)
            if eff.webSearch != false
                throw Error("advanced toggles should round-trip")
            if eff.fontSize != 20
                throw Error("font size should round-trip: " eff.fontSize)
            if eff.assistantName != "Eff Asst"
                throw Error("assistant metadata should be attached: " eff.assistantName)
        } finally {
            assistants := oldAsst
        }
    }

    test_ThreadSettings_ComputeEffective_assistantFallback() {
        global assistants
        oldAsst := assistants
        assistants := [{
            id: "asst-eff-2", name: "Eff Asst", baseModel: "deepseek/test",
            systemMessage: "assistant system", systemMessageFile: "",
            reasoning: "high", temperature: "0.3"
        }]
        try {
            row := { assistantId: "asst-eff-2" }
            eff := ThreadSettings.ComputeEffective(row, assistants[1])
            if eff.model != "deepseek/test"
                throw Error("assistant base model should be the fallback: " eff.model)
            if eff.systemMessage != "assistant system"
                throw Error("assistant system message should be the fallback")
            if eff.reasoning != "high"
                throw Error("assistant reasoning should be the fallback")
            if eff.temperature != "0.3"
                throw Error("assistant temperature should be the fallback")
        } finally {
            assistants := oldAsst
        }
    }

    ; Regression (bug #319): an explicit empty reasoning/temperature override
    ; is different from an absent override and suppresses assistant fallback.
    test_ThreadSettings_explicitEmptyOverridesWin() {
        global assistants
        oldAsst := assistants
        assistants := [{
            id: "asst-explicit-default", name: "Defaults", baseModel: "deepseek/test",
            systemMessage: "assistant system", systemMessageFile: "",
            reasoning: "high", temperature: "0.3"
        }]
        try {
            row := {
                assistantId: "asst-explicit-default",
                reasoningOverride: "", reasoningOverrideSet: true,
                temperatureOverride: "", temperatureOverrideSet: true
            }
            eff := ThreadSettings.ComputeEffective(row, assistants[1])
            if eff.reasoning != "" || eff.temperature != ""
                throw Error("explicit empty overrides were replaced by assistant defaults")
            if !eff.reasoningOverrideSet || !eff.temperatureOverrideSet
                throw Error("explicit override flags were not retained")
        } finally {
            assistants := oldAsst
        }
    }

    ; Regression (bug #320): clearing an assistant prompt is an explicit
    ; per-thread blank, not a request to restore the assistant prompt.
    test_ThreadSettings_explicitEmptySystemOverrideWins() {
        global assistants
        oldAsst := assistants
        assistants := [{
            id: "asst-explicit-system", name: "Prompt", baseModel: "deepseek/test",
            systemMessage: "assistant system", systemMessageFile: "",
            reasoning: "", temperature: ""
        }]
        try {
            row := { assistantId: "asst-explicit-system", systemOverride: "", systemOverrideSet: true }
            eff := ThreadSettings.ComputeEffective(row, assistants[1])
            if eff.systemMessage != "" || !eff.systemOverrideSet
                throw Error("explicit blank system override was replaced by assistant prompt")
        } finally {
            assistants := oldAsst
        }
    }

    ; Regression (bug #35): a per-thread temperature override of 0 is valid.
    ; ComputeEffective used a truthiness check and AHK treats numeric 0 as
    ; falsy, so the 0 override was dropped and the assistant's temperature
    ; (or nothing) was applied instead.
    test_ThreadSettings_temperatureZeroOverrideWins() {
        global assistants
        oldAsst := assistants
        assistants := [{
            id: "asst-35a", name: "Eff Asst", baseModel: "deepseek/test",
            systemMessage: "assistant system", systemMessageFile: "",
            reasoning: "high", temperature: "0.3"
        }]
        try {
            row := {
                assistantId: "asst-35a",
                temperatureOverride: 0
            }
            eff := ThreadSettings.ComputeEffective(row, assistants[1])
            if eff.temperature = "" || eff.temperature != 0
                throw Error("temperature 0 override was dropped: '" eff.temperature "'")
        } finally {
            assistants := oldAsst
        }
    }

    ; Regression (bug #35) end-to-end: restoring a thread whose
    ; temperature_override column is 0 must put 0 back into requestParams
    ; (the previous truthiness check dropped it, so the next request used the
    ; model default).
    test_restoreThreadSettings_temperatureZeroRestored() {
        global requestParams, activeThreadId, assistants

        this._openDb()

        oldAsst := assistants
        oldHasAsst := requestParams.Has("activeAssistantId")
        oldAsstId := oldHasAsst ? requestParams["activeAssistantId"] : ""
        assistants := [{ id: "asst-35b", name: "Asst", baseModel: "deepseek/test", systemMessage: "", systemMessageFile: "", reasoning: "", temperature: "" }]
        threadId := ChatDB.Thread_Create("Temp Zero Thread")
        ChatDB.Thread_UpdateSettings(threadId, { temperatureOverride: 0 })

        try {
            _restoreThreadSettings(threadId)

            if !requestParams.Has("temperatureOverride") || requestParams["temperatureOverride"] = ""
                throw Error("temperature 0 override was not restored: '" requestParams["temperatureOverride"] "'")
            if requestParams["temperatureOverride"] != 0
                throw Error("restored temperature is not 0: " requestParams["temperatureOverride"])
        } finally {
            ; Restore the state this test disturbed (restoring a thread with no
            ; assistant deletes the activeAssistantId key, which other tests
            ; assume exists).
            assistants := oldAsst
            if oldHasAsst
                requestParams["activeAssistantId"] := oldAsstId
            else if requestParams.Has("activeAssistantId")
                requestParams.Delete("activeAssistantId")
            this._closeDb()
        }
    }

    ; Regression (bug #41): a thread created outside the sidebar newChat path
    ; (tray "New Chat", command-line spawn) must still start with the
    ; configured "New Chats Start With" default. The sidebar applies it at
    ; creation; LoadThreadIntoUI now applies it to fresh (message-less,
    ; settings-less) threads via _applyNewChatDefaultToFreshThread.
    test_freshThread_GetsNewChatDefault() {
        global requestParams, activeThreadId, assistants, newChatStartsWith, responseWindowFontSize

        this._openDb()
        oldParams := requestParams
        oldAsst := assistants
        oldDefault := newChatStartsWith
        oldFont := responseWindowFontSize
        oldActive := activeThreadId
        assistants := [{ id: "asst-41", name: "Default Asst", baseModel: "deepseek/deepseek-v4-pro", systemMessage: "default sys", reasoning: "high", temperature: "0.3" }]
        newChatStartsWith := "asst:asst-41"
        responseWindowFontSize := "19"
        activeThreadId := ""

        try {
            threadId := ChatDB.Thread_Create("Tray New Chat")
            applied := _applyNewChatDefaultToFreshThread(threadId)
            if !applied
                throw Error("fresh thread should apply the new-chat default")
            s := ChatDB.Thread_GetSettings(threadId)
            if s.assistantId != "asst-41"
                throw Error("fresh thread should start with the default assistant, got '" s.assistantId "'")
            if s.fontSize != 19
                throw Error("fresh thread should get the default font size, got '" s.fontSize "'")
        } finally {
            requestParams := oldParams
            assistants := oldAsst
            newChatStartsWith := oldDefault
            responseWindowFontSize := oldFont
            activeThreadId := oldActive
            this._closeDb()
        }
    }

    ; Regression (bug #41): a thread that already has stored settings must NOT
    ; be re-defaulted when it is loaded.
    test_configuredThread_IsNotReDefaulted() {
        global requestParams, assistants, newChatStartsWith

        this._openDb()
        oldParams := requestParams
        oldAsst := assistants
        oldDefault := newChatStartsWith
        assistants := [{ id: "asst-41", name: "Default Asst", baseModel: "deepseek/deepseek-v4-pro", systemMessage: "default sys", reasoning: "high", temperature: "0.3" }]
        newChatStartsWith := "asst:asst-41"

        try {
            threadId := ChatDB.Thread_Create("Configured Thread")
            ChatDB.Thread_UpdateSettings(threadId, { modelOverride: "openai/gpt-5-mini", fontSize: 21 })
            applied := _applyNewChatDefaultToFreshThread(threadId)
            if applied
                throw Error("configured thread should not be re-defaulted")
            s := ChatDB.Thread_GetSettings(threadId)
            if s.modelOverride != "openai/gpt-5-mini" || s.fontSize != 21
                throw Error("configured thread settings were overwritten")
        } finally {
            requestParams := oldParams
            assistants := oldAsst
            newChatStartsWith := oldDefault
            this._closeDb()
        }
    }

    ; Regression (bug #212): handleChatSend must only apply the "New Chats
    ; Start With" default when the right-rail requestParams are pristine - an
    ; unconditional apply wiped the user's pre-send selections (assistant pick,
    ; typed system prompt, temperature, model) when the first message
    ; auto-created the thread.
    test_requestParamsAreDefault_guardsNewChatDefault() {
        global requestParams, appDefaultModel

        oldParams := requestParams
        try {
            requestParams := Map("singleAPIModelName", appDefaultModel)
            if !_RequestParamsAreDefault()
                throw Error("pristine requestParams should be default")

            requestParams := Map("singleAPIModelName", appDefaultModel, "activeAssistantId", "asst-1")
            if _RequestParamsAreDefault()
                throw Error("an active assistant must make requestParams non-default")

            requestParams := Map("singleAPIModelName", appDefaultModel, "systemOverride", "custom sys")
            if _RequestParamsAreDefault()
                throw Error("a typed system prompt must make requestParams non-default")

            requestParams := Map("singleAPIModelName", appDefaultModel, "reasoningOverride", "high")
            if _RequestParamsAreDefault()
                throw Error("a reasoning override must make requestParams non-default")

            ; Temperature 0 is a REAL override (bugs #35/#78 family) - it must
            ; keep the thread from being re-defaulted.
            requestParams := Map("singleAPIModelName", appDefaultModel, "temperatureOverride", 0)
            if _RequestParamsAreDefault()
                throw Error("temperature 0 must make requestParams non-default")

            requestParams := Map("singleAPIModelName", "openai/gpt-5-mini")
            if _RequestParamsAreDefault()
                throw Error("a non-default model must make requestParams non-default")
        } finally {
            requestParams := oldParams
        }
    }

    ; Regression (bug #213): a font-size adjustment made BEFORE the first
    ; message (no active thread yet) used to be dropped - handleUpdateFontSize
    ; wrapped the whole persistence in `if activeThreadId`, so requestParams
    ; never carried the size and the auto-created thread saved the default
    ; 17px. The size must be stored in requestParams unconditionally so
    ; _saveCurrentSettingsToThread persists it when the thread is created.
    test_updateFontSize_beforeFirstMessage_survivesThreadCreate() {
        global requestParams, activeThreadId

        this._openDb()
        oldParams := requestParams
        oldActive := activeThreadId
        activeThreadId := ""

        try {
            handleUpdateFontSize(jsongo.Parse('{"fontSize":18}'))

            ; The adjustment must reach requestParams even with no thread.
            if !requestParams.Has("fontSize") || requestParams["fontSize"] != 18
                throw Error("font size was dropped without an active thread: '" (requestParams.Has("fontSize") ? requestParams["fontSize"] : "<missing>") "'")

            ; Mirror handleChatSend's auto-create path: the thread is created
            ; and _saveCurrentSettingsToThread persists current requestParams.
            threadId := ChatDB.Thread_Create("Fresh Font Thread")
            activeThreadId := threadId
            _saveCurrentSettingsToThread(threadId)

            saved := ChatDB.Thread_GetSettings(threadId)
            if saved.fontSize != 18
                throw Error("auto-created thread saved the default font size, got '" saved.fontSize "' expected 18")
        } finally {
            requestParams := oldParams
            activeThreadId := oldActive
            this._closeDb()
        }
    }

    ; The active-thread path must keep persisting immediately (and the new
    ; unconditional requestParams write must not break it).
    test_imageGeneration_isCodexOnlyAndPersistsPerThread() {
        global requestParams, activeThreadId
        this._openDb()
        oldParams := requestParams
        oldActive := activeThreadId
        try {
            threadId := ChatDB.Thread_Create("Image Generation Thread")
            ChatDB.db.Query("UPDATE chat_threads SET advanced_toggles=? WHERE id=?;", '{"futureToggle":true,"webSearch":true}', threadId)
            activeThreadId := threadId
            handleModelSettingsUpdate(jsongo.Parse('{"model":"codex/gpt-5.6-luna","systemMessage":"","reasoning":"","temperature":"","webSearch":false,"imageGeneration":true}'))
            if !requestParams.Has("imageGeneration") || requestParams["imageGeneration"] != true
                throw Error("Codex imageGeneration flag was not stored in requestParams")
            saved := ChatDB.Thread_GetSettings(threadId)
            if !saved.HasOwnProp("imageGeneration") || saved.imageGeneration != true
                throw Error("Codex imageGeneration flag did not persist per thread")
            raw := ChatDB.db.Query("SELECT advanced_toggles FROM chat_threads WHERE id=?;", threadId)
            parsedToggles := jsongo.Parse(raw[1, "advanced_toggles"])
            if !parsedToggles.Has("futureToggle") || !parsedToggles["futureToggle"]
                throw Error("Updating Image Generation must preserve unrelated advanced_toggles keys")

            handleModelSettingsUpdate(jsongo.Parse('{"model":"deepseek/deepseek-v4-flash","systemMessage":"","reasoning":"","temperature":"","webSearch":false,"imageGeneration":true}'))
            if requestParams["imageGeneration"] != false
                throw Error("Non-Codex model must fail closed for image generation")
            saved := ChatDB.Thread_GetSettings(threadId)
            if saved.imageGeneration != false
                throw Error("Non-Codex imageGeneration state must persist as false")
        } finally {
            requestParams := oldParams
            activeThreadId := oldActive
            this._closeDb()
        }
    }

    test_imageGeneration_restoresWhenCodexIsTheAppDefault() {
        global requestParams, appDefaultModel
        this._openDb()
        oldParams := requestParams
        oldDefault := appDefaultModel
        try {
            appDefaultModel := "codex/gpt-5.6-luna"
            threadId := ChatDB.Thread_Create("Codex Default Image Generation")
            ChatDB.Thread_UpdateSettings(threadId, { webSearch: false, imageGeneration: true })
            ThreadSettings.RestoreIntoRequestParams(threadId)
            if requestParams["singleAPIModelName"] != "codex/gpt-5.6-luna"
                throw Error("Codex app default was not restored as the effective model")
            if !requestParams.Has("imageGeneration") || requestParams["imageGeneration"] != true
                throw Error("Image Generation should restore for a Codex app-default model")
        } finally {
            requestParams := oldParams
            appDefaultModel := oldDefault
            this._closeDb()
        }
    }

    test_updateFontSize_withActiveThread_persistsImmediately() {
        global requestParams, activeThreadId

        this._openDb()
        oldParams := requestParams
        oldActive := activeThreadId

        try {
            threadId := ChatDB.Thread_Create("Active Font Thread")
            activeThreadId := threadId
            handleUpdateFontSize(jsongo.Parse('{"fontSize":20}'))
            saved := ChatDB.Thread_GetSettings(threadId)
            if saved.fontSize != 20
                throw Error("active-thread font size was not persisted, got '" saved.fontSize "' expected 20")
            if !requestParams.Has("fontSize") || requestParams["fontSize"] != 20
                throw Error("active-thread font size was not stored in requestParams")
        } finally {
            requestParams := oldParams
            activeThreadId := oldActive
            this._closeDb()
        }
    }
}
