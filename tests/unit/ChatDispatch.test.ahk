; ======================================================
; ChatDispatch.test.ahk — Unit tests for chat/callbacks/Dispatch.ahk
;
; Dispatch.ahk is only #Included by ChatWindow.ahk, so the test harness
; never loaded it before. These tests exercise OnWebMessageReceived's
; action switch (every case) plus the _Handle* settings handlers,
; _OnWebViewReady and _SurfaceError. PostMessage/FileSelect/RunWait
; built-ins are mocked at script level; the webview sink is captured via
; the global responseWindow override.
; ======================================================

#Include ..\..\chat\callbacks\Dispatch.ahk

; --- Script-level mocks for built-ins the module calls ---
RunWait(cmd := "", workDir := "", options := "", &outPID := 0) {
    global _mockRunWaitCalls, _mockRunWaitExitCode
    _mockRunWaitCalls.Push(cmd)
    return _mockRunWaitExitCode
}

FileSelect(options := "", root := "", prompt := "", filter := "") {
    global _mockFileSelectResult, _mockFileSelectOptions, _mockFileSelectRoot
    _mockFileSelectOptions := options
    _mockFileSelectRoot := root
    return _mockFileSelectResult
}

_mockHideWindow(args*) {
    global _mockHideWindowCalls
    _mockHideWindowCalls += 1
}
global chatWindow := { Hide: _mockHideWindow }

class ChatDispatchTest {

    static __New() {
        RegisterTestClass("ChatDispatchTest")
    }

    _args(jsonStr) {
        return { TryGetWebMessageAsString: (*) => jsonStr }
    }

    _captureWebView() {
        global responseWindow
        this._ensureRequestParams()
        captured := []
        oldResponseWindow := responseWindow
        ; AHK v2 passes the receiver object as the first argument when calling
        ; a function stored in an object property, hence the leading param.
        responseWindow := { PostWebMessageAsJSON: (obj, json) => captured.Push(json) }
        return { captured: captured, restore: (obj) => (responseWindow := oldResponseWindow) }
    }

    ; Earlier test classes replace the global requestParams with their own
    ; map; make sure the keys the dispatch handlers read exist.
    _ensureRequestParams() {
        global requestParams
        if !IsSet(requestParams) || !IsObject(requestParams)
            requestParams := Map()
        if !requestParams.Has("uniqueID")
            requestParams["uniqueID"] := "test-unique-id"
        if !requestParams.Has("mainScriptHiddenHwnd")
            requestParams["mainScriptHiddenHwnd"] := "0x0"
        if !requestParams.Has("singleAPIModelName")
            requestParams["singleAPIModelName"] := "deepseek-v4-flash"
    }

    _findCaptured(captured, target) {
        for _, json in captured {
            if InStr(json, '"target":"' target '"')
                return true
        }
        return false
    }

    _setupDb() {
        if ChatDB.isOpen {
            oldPath := ChatDB.dbPath
            ChatDB.Close()
            try FileDelete(oldPath)
        }
        ChatDB.Open(A_Temp "\test_dispatch_" A_TickCount "_" Random(1000, 999999) ".db")
    }

    _teardownDb() {
        if ChatDB.isOpen {
            dbPath := ChatDB.dbPath
            ChatDB.Close()
            try FileDelete(dbPath)
        }
    }

    _withTempSettingsPath() {
        oldPath := SettingsHandler.settingsPath
        tempPath := A_Temp "\test_dispatch_settings_" A_TickCount "_" Random(1000, 999999) ".json"
        SettingsHandler.settingsPath := tempPath
        try FileDelete(tempPath)
        return { tempPath: tempPath, restore: (obj) => (SettingsHandler.settingsPath := oldPath) }
    }

    SurfaceError_PostsShowErrorAndReEnables() {
        web := this._captureWebView()
        try {
            _SurfaceError("ctx", { Message: "boom", Stack: "stack-line" })
        } finally {
            web.restore()
        }
        if !this._findCaptured(web.captured, "showError")
            throw Error("Expected showError post")
        if !this._findCaptured(web.captured, "setChatButtonsEnabled")
            throw Error("Expected setChatButtonsEnabled post")
    }

    Dispatch_EmptyMessage_Returns() {
        web := this._captureWebView()
        try {
            OnWebMessageReceived("", this._args(""))
        } finally {
            web.restore()
        }
        if web.captured.Length != 0
            throw Error("Empty message must not post anything")
    }

    Dispatch_ReadOnlyActions_PostExpected() {
        web := this._captureWebView()
        try {
            OnWebMessageReceived("", this._args('{"action":"requestAssistantList"}'))
            OnWebMessageReceived("", this._args('{"action":"requestCurrentSettings"}'))
            OnWebMessageReceived("", this._args('{"action":"debugLog","message":"hi"}'))
            OnWebMessageReceived("", this._args('{"action":"webViewReady"}'))
        } finally {
            web.restore()
        }
        if !this._findCaptured(web.captured, "assistantList")
            throw Error("requestAssistantList should post assistantList")
        if !this._findCaptured(web.captured, "threadSettings")
            throw Error("requestCurrentSettings should post threadSettings")
    }

    ; Step 2 of the IPC refactor: every WebView request carries a reqId and
    ; the dispatch must acknowledge it with an ok ack echoing the same id.
    Dispatch_AcksWebRequests_WithCorrelationId() {
        web := this._captureWebView()
        try {
            OnWebMessageReceived("", this._args('{"action":"requestAssistantList","reqId":"r42"}'))
        } finally {
            web.restore()
        }
        found := false
        for _, json in web.captured {
            if InStr(json, '"target":"ack"') && InStr(json, '"reqId":"r42"')
                && InStr(json, '"action":"requestAssistantList"') && InStr(json, '"ok":1')
                found := true
        }
        if !found
            throw Error("action with reqId should receive an ok ack echoing the reqId")
    }

    ; The ack error path: _AckWebMessage reports dispatch failures with the
    ; same reqId so the WebView can reject its pending request.
    AckReportsErrors_WithCorrelationId() {
        web := this._captureWebView()
        try {
            _AckWebMessage("r7", "saveSettings", false, "boom")
        } finally {
            web.restore()
        }
        found := false
        for _, json in web.captured {
            if InStr(json, '"target":"ack"') && InStr(json, '"reqId":"r7"')
                && InStr(json, '"ok":0') && InStr(json, '"error":"boom"')
                found := true
        }
        if !found
            throw Error("_AckWebMessage should post an error ack with the reqId")
    }

    ; Regression: the ready handshake is the ONLY reliable point to wire the
    ; Send button (WebView2 drops messages posted before the page installed its
    ; listener, so the startup setChatButtonsEnabled post is racy). The handler
    ; must re-post it on EVERY page load.
    OnWebViewReady_AlwaysPostsSetChatButtonsEnabled() {
        global activeThreadId
        web := this._captureWebView()
        oldActive := IsSet(activeThreadId) ? activeThreadId : ""
        try {
            activeThreadId := ""
            _OnWebViewReady()
        } finally {
            activeThreadId := oldActive
            web.restore()
        }
        if !this._findCaptured(web.captured, "setChatButtonsEnabled")
            throw Error("_OnWebViewReady must post setChatButtonsEnabled on every page load")
    }

    OnWebViewReady_AlwaysPostsAssistantList() {
        global activeThreadId, assistants
        web := this._captureWebView()
        oldActive := IsSet(activeThreadId) ? activeThreadId : ""
        oldAssistants := assistants
        try {
            activeThreadId := ""
            assistants := [
                { id: 'asst-d', name: 'Default Assistant', baseModel: 'deepseek/deepseek-v4-flash', systemMessage: 'default sys' }
            ]
            _OnWebViewReady()
        } finally {
            activeThreadId := oldActive
            assistants := oldAssistants
            web.restore()
        }
        if !this._findCaptured(web.captured, "assistantList")
            throw Error("_OnWebViewReady must re-push the assistant list on every page load (startup 500ms timer races slow loads)")
    }

    ; Regression (bug #45): the WebView must receive the full merged settings
    ; on the ready handshake so ui-theme.js applies the response font (and
    ; other UI CSS vars) at startup, not only when Settings is opened.
    OnWebViewReady_PostsAppSettings() {
        global activeThreadId
        web := this._captureWebView()
        oldActive := IsSet(activeThreadId) ? activeThreadId : ""
        try {
            activeThreadId := ""
            _OnWebViewReady()
        } finally {
            activeThreadId := oldActive
            web.restore()
        }
        if !this._findCaptured(web.captured, "appSettings")
            throw Error("_OnWebViewReady must post appSettings so the response font applies at startup (bug #45)")
    }

    Dispatch_RequestAllSettings_PostsMerged() {
        sp := this._withTempSettingsPath()
        web := this._captureWebView()
        try {
            OnWebMessageReceived("", this._args('{"action":"requestAllSettings"}'))
        } finally {
            web.restore()
            sp.restore()
        }
        if !this._findCaptured(web.captured, "appSettings")
            throw Error("requestAllSettings should post appSettings")
    }

    ; Regression: reopening Settings (requestAllSettings) re-merges the saved
    ; file with defaults. A default model/provider removed from the file must
    ; not come back, while retained models still get metadata from defaults.
    Dispatch_RequestAllSettings_RemovedDefaultsStayRemoved() {
        sp := this._withTempSettingsPath()
        web := this._captureWebView()
        initial := '{"version":1,'
            . '"models":{"openai/gpt-5-mini":{"provider":"openai","input":0}},'
            . '"providers":{"openai":{"displayName":"OpenAI","endpoint":""}}}'
        try {
            FileAppend(initial, sp.tempPath, "UTF-8")
            try {
                OnWebMessageReceived("", this._args('{"action":"requestAllSettings"}'))
            } finally {
                web.restore()
            }
            payload := ""
            for _, json in web.captured {
                if InStr(json, '"target":"appSettings"')
                    payload := json
            }
            if payload = ""
                throw Error("requestAllSettings should post appSettings")
            parsed := SettingsHandler._ToMap(jsongo.Parse(payload))
            models := parsed["data"]["models"]
            providers := parsed["data"]["providers"]
            if models.Has("deepseek/deepseek-chat")
                throw Error("requestAllSettings resurrected removed default model deepseek/deepseek-chat")
            if providers.Has("deepseek")
                throw Error("requestAllSettings resurrected removed default provider deepseek")
            if !models.Has("openai/gpt-5-mini")
                throw Error("requestAllSettings should keep models present in the saved file")
            retained := models["openai/gpt-5-mini"]
            if !retained.Has("thinkingLevelMap")
                throw Error("requestAllSettings should fill metadata from defaults for retained models")
        } finally {
            sp.restore()
            try FileDelete(sp.tempPath)
        }
    }

    Dispatch_RequestDefaultSettings_PostsAndSaves() {
        sp := this._withTempSettingsPath()
        web := this._captureWebView()
        try {
            OnWebMessageReceived("", this._args('{"action":"requestDefaultSettings"}'))
        } finally {
            web.restore()
        }
        if !this._findCaptured(web.captured, "defaultSettings")
            throw Error("requestDefaultSettings should post defaultSettings")
        if !FileExist(sp.tempPath)
            throw Error("requestDefaultSettings should write defaults to settings.json")
        sp.restore()
        try FileDelete(sp.tempPath)
    }

    Dispatch_SaveSettings_Success() {
        sp := this._withTempSettingsPath()
        web := this._captureWebView()
        try {
            OnWebMessageReceived("", this._args('{"action":"saveSettings","data":{"hotkeys":{"main":"`"}}}'))
        } finally {
            web.restore()
        }
        found := false
        for _, json in web.captured {
            ; jsongo serializes booleans as 1/0, not true/false.
            if InStr(json, '"target":"settingsSaved"') && InStr(json, '"success":1')
                found := true
        }
        if !found
            throw Error("saveSettings success should post settingsSaved success:true")
        if !FileExist(sp.tempPath)
            throw Error("saveSettings should write the settings file")
        sp.restore()
        try FileDelete(sp.tempPath)
    }

    ; Regression (bug #45): after a successful save the merged settings are
    ; re-pushed so the response font (and other UI CSS vars) apply immediately,
    ; without reopening Settings.
    Dispatch_SaveSettings_PostsAppSettingsAfterSuccess() {
        sp := this._withTempSettingsPath()
        web := this._captureWebView()
        try {
            OnWebMessageReceived("", this._args('{"action":"saveSettings","data":{"ui":{"responseFont":"Georgia"}}}'))
        } finally {
            web.restore()
        }
        if !this._findCaptured(web.captured, "appSettings")
            throw Error("saveSettings success should re-push appSettings so the response font applies immediately (bug #45)")
        sp.restore()
        try FileDelete(sp.tempPath)
    }

    Dispatch_SaveSettings_NoData() {
        sp := this._withTempSettingsPath()
        web := this._captureWebView()
        try {
            OnWebMessageReceived("", this._args('{"action":"saveSettings"}'))
        } finally {
            web.restore()
            sp.restore()
        }
        found := false
        for _, json in web.captured {
            if InStr(json, '"target":"settingsSaved"') && InStr(json, "No data received")
                found := true
        }
        if !found
            throw Error("saveSettings without data should post the no-data error")
    }

    ; Regression: removed models/providers must stay removed after a save
    ; round-trip. The panel sends complete section maps, so the merge on save
    ; must not resurrect entries absent from the payload. Unsent top-level keys
    ; (e.g. trash) must keep their saved values.
    Dispatch_SaveSettings_RemovedEntriesStayRemoved() {
        sp := this._withTempSettingsPath()
        web := this._captureWebView()
        initial := '{"version":1,'
            . '"models":{"deepseek/deepseek-chat":{"provider":"deepseek","input":0},'
            . '"openai/gpt-5-mini":{"provider":"openai","input":0}},'
            . '"providers":{"deepseek":{"displayName":"DeepSeek","endpoint":""}},'
            . '"trash":{"retentionDays":30}}'
        try {
            FileAppend(initial, sp.tempPath, "UTF-8")
            try {
                ; UI payload: models/providers without the removed entries, plus a
                ; changed hotkey — trash/version are not sent and must survive.
                OnWebMessageReceived("", this._args('{"action":"saveSettings","data":{'
                    . '"models":{"openai/gpt-5-mini":{"provider":"openai","input":0}},'
                    . '"providers":{"openai":{"displayName":"OpenAI","endpoint":""}},'
                    . '"hotkeys":{"main":"t"}}}'))
            } finally {
                web.restore()
            }
            if !FileExist(sp.tempPath)
                throw Error("saveSettings should write the settings file")
            saved := FileRead(sp.tempPath, "UTF-8")
            if InStr(saved, '"deepseek/deepseek-chat"')
                throw Error("removed model deepseek/deepseek-chat was resurrected: " saved)
            if InStr(saved, '"deepseek"')
                throw Error("removed provider deepseek was resurrected: " saved)
            if !InStr(saved, '"retentionDays"') || !InStr(saved, '"main"')
                throw Error("unsent or changed top-level keys were lost: " saved)
        } finally {
            sp.restore()
            try FileDelete(sp.tempPath)
        }
    }

    Dispatch_ModelsDevCatalog_DefaultsToProviderId() {
        cfg := _BuildModelsDevCatalogConfig(Map(
            "xiaomi", Map("displayName", "Xiaomi", "modelsDevProvider", "")
        ))
        if cfg.spec != "xiaomi=xiaomi"
            throw Error("Expected provider ID to auto-map to the same models.dev catalog, got " cfg.spec)
        if cfg.providers["xiaomi"].catalog != "xiaomi"
            throw Error("Expected xiaomi catalog mapping")
    }

    Dispatch_ModelsDevCatalog_OverrideKeepsTransportProvider() {
        cfg := _BuildModelsDevCatalogConfig(Map(
            "work-mimo", Map("displayName", "Work MiMo", "modelsDevProvider", "xiaomi")
        ))
        if cfg.spec != "work-mimo=xiaomi"
            throw Error("Expected transport/catalog mapping work-mimo=xiaomi, got " cfg.spec)
        if cfg.providers["work-mimo"].displayName != "Work MiMo"
            throw Error("Expected display name to survive catalog mapping")
    }

    Dispatch_ModelsDevCatalog_RejectsInvalidKey() {
        threw := false
        try _BuildModelsDevCatalogConfig(Map(
            "work-mimo", Map("modelsDevProvider", "bad catalog key")
        ))
        catch
            threw := true
        if !threw
            throw Error("Invalid models.dev provider keys must be rejected")
    }

    Dispatch_RefreshModelPricing_Success() {
        global _mockRunWaitExitCode
        _mockRunWaitExitCode := 0
        web := this._captureWebView()
        try {
            OnWebMessageReceived("", this._args('{"action":"refreshModelPricing"}'))
        } finally {
            web.restore()
        }
        found := false
        for _, json in web.captured {
            if InStr(json, '"target":"modelPricingRefresh"') && InStr(json, '"success":1')
                found := true
        }
        if !found
            throw Error("refreshModelPricing should post a success result")
    }

    Dispatch_RefreshModelPricing_RunFailed() {
        global _mockRunWaitExitCode
        _mockRunWaitExitCode := 7
        web := this._captureWebView()
        try {
            OnWebMessageReceived("", this._args('{"action":"refreshModelPricing"}'))
        } finally {
            web.restore()
        }
        found := false
        for _, json in web.captured {
            if InStr(json, '"target":"modelPricingRefresh"') && InStr(json, "exited with code 7")
                found := true
        }
        if !found
            throw Error("refreshModelPricing should report the failing exit code")
    }

    Dispatch_BrowseIcon_StoresRelativePath() {
        global _mockFileSelectResult
        _mockFileSelectResult := A_ScriptDir "\..\icons\test.ico"
        web := this._captureWebView()
        try {
            OnWebMessageReceived("", this._args('{"action":"browseIcon","field":"iconOn"}'))
        } finally {
            web.restore()
        }
        found := false
        for _, json in web.captured {
            if InStr(json, '"target":"iconFileSelected"') {
                parsed := jsongo.Parse(json)
                if parsed["data"]["path"] = "icons\test.ico"
                    found := true
            }
        }
        if !found
            throw Error("Repo-relative icon path should be stripped of the repo root")
    }

    Dispatch_BrowseIcon_KeepsAbsolutePath() {
        global _mockFileSelectResult
        _mockFileSelectResult := "C:\elsewhere\icon.ico"
        web := this._captureWebView()
        try {
            OnWebMessageReceived("", this._args('{"action":"browseIcon","field":"iconOff"}'))
        } finally {
            web.restore()
        }
        found := false
        for _, json in web.captured {
            if InStr(json, '"target":"iconFileSelected"') {
                parsed := jsongo.Parse(json)
                if parsed["data"]["path"] = "C:\elsewhere\icon.ico"
                    found := true
            }
        }
        if !found
            throw Error("Absolute icon path should be passed through unchanged")
    }

    Dispatch_BrowseIcon_CancelPostsNothing() {
        global _mockFileSelectResult
        _mockFileSelectResult := ""
        web := this._captureWebView()
        try {
            OnWebMessageReceived("", this._args('{"action":"browseIcon","field":"iconOn"}'))
            OnWebMessageReceived("", this._args('{"action":"browseIcon","field":"other"}'))
        } finally {
            web.restore()
        }
        if this._findCaptured(web.captured, "iconFileSelected")
            throw Error("Cancelled/invalid icon browse must not post")
    }

    Dispatch_BrowseCompletionSound_PostsSelectedWav() {
        global _mockFileSelectResult, _mockFileSelectOptions
        _mockFileSelectResult := "C:\sounds\done.wav"
        _mockFileSelectOptions := ""
        web := this._captureWebView()
        try {
            _HandleBrowseCompletionSound(Map("path", ""))
        } finally {
            web.restore()
        }
        if _mockFileSelectOptions != 3
            throw Error("completion sound Browse must select an existing file")
        found := false
        for _, json in web.captured {
            if InStr(json, '"target":"completionSoundSelected"') {
                parsed := jsongo.Parse(json)
                if parsed["data"]["path"] = "C:\sounds\done.wav"
                    found := true
            }
        }
        if !found
            throw Error("completion sound Browse should post the selected WAV path")
    }

    Dispatch_BrowseBackupFolder_UsesDirectoryPicker() {
        global _mockFileSelectResult, _mockFileSelectOptions, _mockFileSelectRoot
        filePath := A_Temp "\\backup-browse-file-" A_TickCount ".txt"
        FileAppend("not a folder", filePath)
        _mockFileSelectResult := A_Temp "\\selected-backup-folder"
        _mockFileSelectOptions := ""
        _mockFileSelectRoot := "sentinel"
        try {
            _HandleBrowseBackupFolder(Map("folder", filePath))
            if _mockFileSelectOptions != "D"
                throw Error("backup Browse must use FileSelect directory mode D")
            if _mockFileSelectRoot != ""
                throw Error("backup Browse must not use a file as the starting directory")
        } finally {
            try FileDelete(filePath)
        }
    }

    Dispatch_IpcActions_NoThrow() {
        web := this._captureWebView()
        try {
            OnWebMessageReceived("", this._args('{"action":"reloadScript"}'))
            OnWebMessageReceived("", this._args('{"action":"showApiLogs"}'))
        } finally {
            web.restore()
        }
    }

    Dispatch_OpenExternalUrl_UsesDefaultUrlHandler() {
        global _mockRunCalls, _mockTitleGenOutput
        _mockRunCalls := []
        _mockTitleGenOutput := ""
        web := this._captureWebView()
        try {
            OnWebMessageReceived("", this._args('{"action":"openExternalUrl","url":"https://example.com/news?id=42"}'))
        } finally {
            web.restore()
        }
        if _mockRunCalls.Length != 1
            throw Error("Expected one Run call for an HTTPS link, got " _mockRunCalls.Length)
        if _mockRunCalls[1] != "https://example.com/news?id=42"
            throw Error("Unexpected URL handed to Run: " _mockRunCalls[1])
    }

    Dispatch_OpenExternalUrl_RejectsUnsafeSchemes() {
        global _mockRunCalls, _mockTitleGenOutput
        _mockRunCalls := []
        _mockTitleGenOutput := ""
        blockedUrls := [
            "javascript:alert(1)",
            "file:///C:/Windows/System32/calc.exe",
            "mailto:test@example.com",
            "https://example.com/a b"
        ]
        for _, url in blockedUrls {
            rejected := false
            try _HandleOpenExternalUrl(Map("url", url))
            catch Error
                rejected := true
            if !rejected
                throw Error("Expected unsafe external URL to be rejected: " url)
        }
        if _mockRunCalls.Length != 0
            throw Error("Unsafe external URLs must not call Run")
    }

    Dispatch_WebViewReady_NoThread() {
        global activeThreadId
        old := activeThreadId
        activeThreadId := ""
        web := this._captureWebView()
        try {
            OnWebMessageReceived("", this._args('{"action":"webViewReady"}'))
        } finally {
            web.restore()
            activeThreadId := old
        }
    }

    Dispatch_WebViewReady_WithThread_LoadsUI() {
        global activeThreadId
        this._setupDb()
        threadId := ChatDB.Thread_Create("Dispatch Ready")
        old := activeThreadId
        activeThreadId := threadId
        web := this._captureWebView()
        try {
            OnWebMessageReceived("", this._args('{"action":"webViewReady"}'))
        } finally {
            web.restore()
            activeThreadId := old
            this._teardownDb()
        }
        if !this._findCaptured(web.captured, "initChatMode")
            throw Error("webViewReady with a thread should load the chat UI")
    }

    Dispatch_SidebarAction_NewChat_AppliesDefaultFontSize() {
        global activeThreadId, responseWindowFontSize
        this._setupDb()
        old := activeThreadId
        oldFont := responseWindowFontSize
        activeThreadId := ""
        responseWindowFontSize := "19"
        web := this._captureWebView()
        createdThreads := 0
        newThreadSettings := ""
        loaded := false
        try {
            OnWebMessageReceived("", this._args('{"action":"sidebarAction","subAction":"newChat"}'))
            createdThreads := ChatDB.Thread_List().Length
            if createdThreads > 0 {
                newThreadSettings := ChatDB.Thread_GetSettings(ChatDB.Thread_List()[1].id)
            }
            loaded := this._findCaptured(web.captured, "loadThread")
        } finally {
            web.restore()
            activeThreadId := old
            responseWindowFontSize := oldFont
            this._teardownDb()
        }
        if createdThreads = 0
            throw Error("newChat should create a thread")
        if newThreadSettings.fontSize != 19
            throw Error("New thread should inherit the default font size, got '" newThreadSettings.fontSize "'")
        if !loaded
            throw Error("newChat should load the new thread")
    }

    Dispatch_NewChat_AppliesDefaultAssistant() {
        global activeThreadId, requestParams, assistants, newChatStartsWith
        this._setupDb()
        old := activeThreadId
        oldParams := requestParams
        oldAsst := assistants
        oldDefault := newChatStartsWith
        assistants := [{ id: "asst-1", name: "Default Asst", baseModel: "deepseek/deepseek-v4-pro", systemMessage: "default sys", reasoning: "high", temperature: "0.3" }]
        newChatStartsWith := "asst:asst-1"
        activeThreadId := ""
        web := this._captureWebView()
        try {
            OnWebMessageReceived("", this._args('{"action":"sidebarAction","subAction":"newChat"}'))
            threads := ChatDB.Thread_List()
            if threads.Length = 0
                throw Error("newChat should create a thread")
            s := ChatDB.Thread_GetSettings(threads[1].id)
            if s.assistantId != "asst-1"
                throw Error("New chat should start with the default assistant, got '" s.assistantId "'")
            if s.systemOverride != "default sys"
                throw Error("New chat should carry the default assistant's system message")
            if s.modelOverride != "deepseek/deepseek-v4-pro"
                throw Error("New chat should carry the default assistant's model, got '" s.modelOverride "'")
        } finally {
            web.restore()
            activeThreadId := old
            requestParams := oldParams
            assistants := oldAsst
            newChatStartsWith := oldDefault
            this._teardownDb()
        }
    }

    Dispatch_NewChat_AppliesDefaultModel() {
        global activeThreadId, requestParams, assistants, newChatStartsWith
        this._setupDb()
        old := activeThreadId
        oldParams := requestParams
        oldAsst := assistants
        oldDefault := newChatStartsWith
        assistants := [{ id: "asst-1", name: "Some Asst", baseModel: "deepseek/deepseek-v4-flash", systemMessage: "", reasoning: "", temperature: "" }]
        newChatStartsWith := "openai/gpt-5-mini"
        activeThreadId := ""
        web := this._captureWebView()
        try {
            OnWebMessageReceived("", this._args('{"action":"sidebarAction","subAction":"newChat"}'))
            threads := ChatDB.Thread_List()
            if threads.Length = 0
                throw Error("newChat should create a thread")
            s := ChatDB.Thread_GetSettings(threads[1].id)
            if s.modelOverride != "openai/gpt-5-mini"
                throw Error("New chat should start with the default model, got '" s.modelOverride "'")
            if s.assistantId != ""
                throw Error("A model default must not attach an assistant, got '" s.assistantId "'")
        } finally {
            web.restore()
            activeThreadId := old
            requestParams := oldParams
            assistants := oldAsst
            newChatStartsWith := oldDefault
            this._teardownDb()
        }
    }

    Dispatch_NewChat_AppDefault_UsesChatDefaultModel() {
        global activeThreadId, requestParams, assistants, newChatStartsWith, appDefaultModel
        this._setupDb()
        old := activeThreadId
        oldParams := requestParams
        oldAsst := assistants
        oldDefault := newChatStartsWith
        assistants := [{ id: "asst-1", name: "Some Asst", baseModel: "deepseek/deepseek-v4-flash", systemMessage: "", reasoning: "", temperature: "" }]
        newChatStartsWith := ""
        activeThreadId := ""
        web := this._captureWebView()
        try {
            OnWebMessageReceived("", this._args('{"action":"sidebarAction","subAction":"newChat"}'))
            if requestParams["singleAPIModelName"] != appDefaultModel
                throw Error("App default should keep the chat default model, got '" requestParams["singleAPIModelName"] "'")
            if requestParams.Has("activeAssistantId")
                throw Error("App default must not attach an assistant")
        } finally {
            web.restore()
            activeThreadId := old
            requestParams := oldParams
            assistants := oldAsst
            newChatStartsWith := oldDefault
            this._teardownDb()
        }
    }

    Dispatch_DeleteActiveThread_ResetsRequestParams() {
        global activeThreadId, requestParams, appDefaultModel
        this._setupDb()
        old := activeThreadId
        oldParams := requestParams
        threadId := ChatDB.Thread_Create("To Delete")
        activeThreadId := threadId
        requestParams := Map(
            "singleAPIModelName", "deepseek/deepseek-chat",
            "systemOverride", "You are a pirate.",
            "reasoningOverride", "high",
            "temperatureOverride", "0.3",
            "fontSize", 21,
            "activeAssistantId", "asst-1")
        web := this._captureWebView()
        try {
            OnWebMessageReceived("", this._args('{"action":"sidebarAction","subAction":"deleteThread","threadId":"' threadId '"}'))
            ; Deleting the ACTIVE thread must clear it and reset requestParams,
            ; otherwise the next handleChatSend persists stale settings into the
            ; new thread (bug #1: per-thread settings leak).
            if activeThreadId != ""
                throw Error("Deleting the active thread should clear activeThreadId")
            if requestParams.Has("activeAssistantId")
                throw Error("Deleting the active thread should clear the assistant")
            if requestParams.Has("fontSize")
                throw Error("Deleting the active thread should clear font size")
            if requestParams["systemOverride"] != "" || requestParams["reasoningOverride"] != "" || requestParams["temperatureOverride"] != ""
                throw Error("Deleting the active thread should clear system/reasoning/temperature overrides")
            if requestParams["singleAPIModelName"] != appDefaultModel
                throw Error("Deleting the active thread should reset the model to the default")
        } finally {
            web.restore()
            activeThreadId := old
            requestParams := oldParams
            this._teardownDb()
        }
    }

    ; Regression (bug #321): deleting the active response changes the model
    ; shown in the sidebar, so the handler must republish the thread list.
    Dispatch_DeleteMessage_RefreshesThreadList() {
        global activeThreadId
        this._setupDb()
        old := activeThreadId
        threadId := ChatDB.Thread_Create("Delete response")
        activeThreadId := threadId
        userId := ChatDB.Msg_Insert({ thread_id: threadId, role: "user", content: "question" })
        assistantId := ChatDB.Msg_Insert({ thread_id: threadId, role: "assistant", content: "answer", model: "openai/gpt-5-mini", parent_id: userId })
        web := this._captureWebView()
        try {
            handleDelete(assistantId)
            if !this._findCaptured(web.captured, "threadList")
                throw Error("deleting an active response should refresh the thread list")
        } finally {
            web.restore()
            activeThreadId := old
            this._teardownDb()
        }
    }

    ; Regression (bug #210): deleting the ACTIVE thread must reset the
    ; chat-window title - the deleteThread/deleteThreadForever/emptyTrash paths
    ; cleared activeThreadId and posted loadThread+initChatMode but left the
    ; title bar showing the deleted thread's name until another thread loaded.
    Dispatch_DeleteActiveThread_ResetsWindowTitle() {
        global activeThreadId, requestParams, chatWindow
        this._setupDb()
        old := activeThreadId
        oldParams := requestParams
        oldTitle := chatWindow.Title
        threadId := ChatDB.Thread_Create("To Delete")
        activeThreadId := threadId
        requestParams := Map("singleAPIModelName", "deepseek/deepseek-v4-flash")
        chatWindow.Title := AppInfo.Name " - To Delete"
        web := this._captureWebView()
        try {
            OnWebMessageReceived("", this._args('{"action":"sidebarAction","subAction":"deleteThread","threadId":"' threadId '"}'))
            if chatWindow.Title != AppInfo.Name
                throw Error("Deleting the active thread should reset the window title to '" AppInfo.Name "', got '" chatWindow.Title "'")
        } finally {
            web.restore()
            activeThreadId := old
            requestParams := oldParams
            chatWindow.Title := oldTitle
            this._teardownDb()
        }
    }

    Dispatch_DeleteInactiveThread_KeepsRequestParams() {
        global activeThreadId, requestParams
        this._setupDb()
        old := activeThreadId
        oldParams := requestParams
        activeId := ChatDB.Thread_Create("Active")
        otherId := ChatDB.Thread_Create("Other")
        activeThreadId := activeId
        requestParams := Map(
            "singleAPIModelName", "deepseek/deepseek-chat",
            "systemOverride", "You are a pirate.",
            "reasoningOverride", "high",
            "temperatureOverride", "0.3",
            "fontSize", 21,
            "activeAssistantId", "asst-1")
        web := this._captureWebView()
        try {
            OnWebMessageReceived("", this._args('{"action":"sidebarAction","subAction":"deleteThread","threadId":"' otherId '"}'))
            ; Deleting a NON-active thread must not touch the active thread's settings.
            if activeThreadId != activeId
                throw Error("Deleting another thread should keep activeThreadId")
            if !requestParams.Has("activeAssistantId") || requestParams["activeAssistantId"] != "asst-1"
                throw Error("Deleting another thread should keep the active assistant")
            if requestParams["systemOverride"] != "You are a pirate."
                throw Error("Deleting another thread should keep the active system override")
        } finally {
            web.restore()
            activeThreadId := old
            requestParams := oldParams
            this._teardownDb()
        }
    }

    Dispatch_HideWindow() {
        global _mockHideWindowCalls
        _mockHideWindowCalls := 0
        web := this._captureWebView()
        try {
            OnWebMessageReceived("", this._args('{"action":"hideWindow"}'))
        } finally {
            web.restore()
        }
        if _mockHideWindowCalls != 1
            throw Error("hideWindow should hide the chat window")
    }

    Dispatch_GuardedActions_NoThrow() {
        global activeThreadId
        old := activeThreadId
        activeThreadId := ""
        web := this._captureWebView()
        try {
            OnWebMessageReceived("", this._args('{"action":"chatSend"}'))
            OnWebMessageReceived("", this._args('{"action":"retry"}'))
            OnWebMessageReceived("", this._args('{"action":"editMessage"}'))
            OnWebMessageReceived("", this._args('{"action":"deleteMessage"}'))
            OnWebMessageReceived("", this._args('{"action":"deleteAttachment"}'))
            OnWebMessageReceived("", this._args('{"action":"switchBranch"}'))
            OnWebMessageReceived("", this._args('{"action":"forkChat"}'))
            OnWebMessageReceived("", this._args('{"action":"sidebarAction","subAction":"loadTree"}'))
            OnWebMessageReceived("", this._args('{"action":"searchMessages","query":"x"}'))
            OnWebMessageReceived("", this._args('{"action":"cancelStream"}'))
            OnWebMessageReceived("", this._args('{"action":"updateFontSize","size":"18"}'))
            OnWebMessageReceived("", this._args('{"action":"updateModelSettings","model":"deepseek/deepseek-v4-flash"}'))
            OnWebMessageReceived("", this._args('{"action":"switchAssistant","assistantName":"Test Assistant"}'))
        } finally {
            web.restore()
            activeThreadId := old
        }
        if !this._findCaptured(web.captured, "searchResults")
            throw Error("Short search query should post empty searchResults")
    }

    ; Regression (bug #174): handleBranchSwitch bumps the thread's updated_at,
    ; so it must also refresh the sidebar thread list - otherwise the order
    ; (and the #155 model badge) stay stale after branch navigation.
    BranchSwitch_PostsThreadListRefresh() {
        srcPath := A_ScriptDir "\..\chat\callbacks\Branch.ahk"
        if !FileExist(srcPath)
            throw Error("Branch.ahk not found")
        src := FileRead(srcPath)
        swStart := InStr(src, "handleBranchSwitch(params, *) {")
        if !swStart
            throw Error("handleBranchSwitch not found in Branch.ahk")
        block := SubStr(src, swStart, 1200)
        if !InStr(block, "_postThreadListRefresh()")
            throw Error("handleBranchSwitch must refresh the sidebar thread list (bug #174)")
    }

    ; Regression (bug #318): both edit modes touch chat_threads.updated_at,
    ; so each must refresh the sidebar order/date immediately.
    Edit_PostsThreadListRefresh() {
        srcPath := A_ScriptDir "\..\chat\callbacks\Edit.ahk"
        if !FileExist(srcPath)
            throw Error("Edit.ahk not found")
        src := FileRead(srcPath)
        first := InStr(src, "_postThreadListRefresh()")
        if !first
            throw Error("handleEdit must refresh the sidebar after branch edits (bug #318)")
        second := InStr(src, "_postThreadListRefresh()", false, first + StrLen("_postThreadListRefresh()"))
        if !second
            throw Error("handleEdit must refresh the sidebar after overwrite edits (bug #318)")
    }

    ; Regression (bug #212): handleChatSend's auto-create branch must apply the
    ; "New Chats Start With" default ONLY when the right-rail requestParams are
    ; pristine - an unconditional apply overwrote a pre-send assistant pick /
    ; typed system prompt / temperature / model with the default.
    ChatSend_AutoCreateThread_GuardsNewChatDefault() {
        srcPath := A_ScriptDir "\..\chat\callbacks\Message.ahk"
        if !FileExist(srcPath)
            throw Error("Message.ahk not found")
        src := FileRead(srcPath)
        autoCreatePos := InStr(src, "if !activeThreadId {")
        if !autoCreatePos
            throw Error("handleChatSend auto-create branch not found in Message.ahk")
        block := SubStr(src, autoCreatePos, 900)
        guardPos := InStr(block, "_RequestParamsAreDefault()")
        applyPos := InStr(block, "_applyNewChatDefault()")
        if !guardPos || !applyPos || guardPos > applyPos
            throw Error("handleChatSend must call _RequestParamsAreDefault() before _applyNewChatDefault() (bug #212)")
    }

    ; Regression (bug #209): navigateToMessage (tree modal / search navigation)
    ; bumps chat_threads.updated_at via SetActiveLeaf, so it must also refresh
    ; the sidebar thread list - otherwise the order (and the #155 model badge)
    ; stay stale after navigating to an off-path branch (same class as the
    ; fixed #174, which only covered handleBranchSwitch).
    NavigateToMessage_PostsThreadListRefresh() {
        srcPath := A_ScriptDir "\..\chat\callbacks\Sidebar.ahk"
        if !FileExist(srcPath)
            throw Error("Sidebar.ahk not found")
        src := FileRead(srcPath)
        navPos := InStr(src, 'case "navigateToMessage":')
        if !navPos
            throw Error("navigateToMessage case not found in Sidebar.ahk")
        ; The navigation call now passes activeThreadId into _WalkToLeaf so
        ; stale message IDs cannot even be resolved outside the visible tree.
        block := SubStr(src, navPos, 1200)
        if !InStr(block, "_postThreadListRefresh()")
            throw Error("navigateToMessage must refresh the sidebar thread list (bug #209)")
    }

    Dispatch_InvalidJson_PostsShowError() {
        web := this._captureWebView()
        try {
            OnWebMessageReceived("", this._args('{"action":'))
        } finally {
            web.restore()
        }
        if !this._findCaptured(web.captured, "showError")
            throw Error("Invalid JSON should surface an error to the UI")
    }

}
