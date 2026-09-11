; Dispatch.ahk — routes WebView messages and includes chat callback modules.

; Surface an error to both the debug log AND the chat UI.
; Callable from any callback — re-enables buttons and shows red banner.
_SurfaceError(context, err) {
    errorMsg := "[" context "] " err.Message
    debugLog("ERROR: " errorMsg "`nStack: " (err.HasProp("Stack") ? err.Stack : "none"), "ErrorHandler")
    _PostChatError(errorMsg)
    postWebMessage("setChatButtonsEnabled", true)
    startLoadingCursor(false)
}

OnWebMessageReceived(sender, args) {
    global activeThreadId
    reqId := ""
    try {
        msg := args.TryGetWebMessageAsString()
        if !msg
            return
        parsed := jsongo.Parse(msg)
        action := parsed.Get("action", "")
        ; Echo each request's reqId in its acknowledgement so the WebView can
        ; resolve the matching promise and surface failures.
        reqId := parsed.Get("reqId", "")
        ; Locked-chat gate: actions that read or mutate the ACTIVE thread are
        ; rejected while it is locked (and not unlocked in this session).
        ; Content can never be reached through a side channel like the tree
        ; modal or the right-rail settings, and global search is filtered at
        ; the SQL level instead.
        ; ChatDB.isOpen guards the test harness (stale activeThreadId with a
        ; closed DB); production always has the DB open, so behavior is unchanged.
        if _IsLockedThreadContentAction(action, parsed) && IsSet(activeThreadId) && ChatDB.isOpen
            ThreadLockService.RequireUnlocked(activeThreadId)
        switch action {
            case "chatSend":
                handleChatSend(parsed)
            case "searchMessages":
                handleSearch(parsed)
            case "deleteAttachment":
                handleDeleteAttachment(parsed)
            case "retry":
                handleRetry(parsed)
            case "editMessage":
                handleEdit(parsed)
            case "deleteMessage":
                handleDelete(parsed.Get("id", ""))
            case "switchBranch":
                handleBranchSwitch(parsed)
            case "forkChat":
                handleFork(parsed.Get("id", ""))
            case "sidebarAction":
                handleSidebarAction(parsed)
            case "requestAssistantList":
                postAssistantsToWebView()
            case "updateModelSettings":
                handleModelSettingsUpdate(parsed)
            case "switchAssistant":
                handleSwitchAssistant(parsed)
            case "cancelStream":
                handleCancelStream()
            case "hideWindow":
                global chatWindow
                chatWindow.Hide()
            case "openExternalUrl":
                _HandleOpenExternalUrl(parsed)
            case "requestCurrentSettings":
                postCurrentSettingsToWebView()
            case "showApiLogs":
                debugLog("[DISPATCH] showApiLogs received, sending IPC to Main")
                CustomMessages.notifyShowApiLogs(requestParams["mainScriptHiddenHwnd"])
            case "webViewReady":
                _OnWebViewReady()
            case "requestAllSettings":
                _HandleRequestAllSettings()
            case "requestDefaultSettings":
                _HandleRequestDefaultSettings()
            case "saveSettings":
                _HandleSaveSettings(parsed)
            case "requestSystemMessageFiles":
                _HandleRequestSystemMessageFiles()
            case "openSystemMessagesFolder":
                _HandleOpenSystemMessagesFolder()
            case "refreshModelPricing":
                _HandleRefreshModelPricing(parsed)
            case "lookupOpenRouterModel":
                _HandleOpenRouterModelLookup(parsed)
            case "checkCodex":
                _HandleCheckCodex()
            case "reloadScript":
                CustomMessages.notifyReloadMain(requestParams["mainScriptHiddenHwnd"])
            case "browseIcon":
                _HandleBrowseIcon(parsed)
            case "browseCompletionSound":
                _HandleBrowseCompletionSound(parsed)
            case "testCompletionSound":
                _HandleTestCompletionSound(parsed)
            case "browseBackupFolder":
                _HandleBrowseBackupFolder(parsed)
            case "backupNow":
                _HandleBackupNow(parsed)
            case "debugLog":
                debugLog(parsed.Get("message", ""), "WebUI")
            case "updateFontSize":
                handleUpdateFontSize(parsed)
            case "unlockThread":
                handleUnlockThread(parsed)
            case "setThreadLock":
                handleSetThreadLock(parsed)
            case "lockChatNow":
                handleLockChatNow(parsed)
            case "dismissLockedThread":
                handleDismissLockedThread(parsed)
            case "getThreadLockInfo":
                handleGetThreadLockInfo(parsed)
        }
        _AckWebMessage(reqId, action, true, "")
    } catch Error as e {
        _SurfaceError("Dispatch." (IsSet(action) ? action : "unknown"), e)
        _AckWebMessage(reqId, IsSet(action) ? action : "unknown", false, e.Message)
    }
}

; True for actions whose handler reads or mutates the active thread's
; content/settings and must therefore be blocked while it is locked.
_IsLockedThreadContentAction(action, parsed) {
    switch action {
        case "chatSend", "retry", "editMessage", "deleteMessage", "deleteAttachment",
             "forkChat", "switchBranch", "updateModelSettings", "switchAssistant",
             "updateFontSize", "requestCurrentSettings":
            return true
        case "searchMessages":
            ; Global search is filtered at the SQL level (locked chats never
            ; match); scoped search of a locked thread is blocked.
            return parsed.Has("threadId")
        case "sidebarAction":
            sub := parsed.Has("subAction") ? parsed["subAction"] : ""
            ; loadTree renders the ACTIVE thread's tree; navigateToMessage and
            ; loadThread are already gated by _LoadThreadAndRefreshUI.
            return sub = "loadTree"
    }
    return false
}

; Acknowledge a WebView request. Only sent when the request carried a reqId
; (older ad-hoc posts are not acknowledged, keeping the contract opt-in).
_AckWebMessage(reqId, action, ok, errorMsg) {
    if reqId = ""
        return
    ack := { reqId: reqId, action: action, ok: ok }
    if errorMsg != ""
        ack.error := errorMsg
    postWebMessage("ack", ack)
}

; WebView just loaded/reloaded — send current thread data if one exists.
; Replaces sessionStorage-based recovery with DB as single source of truth.
_OnWebViewReady() {
    global activeThreadId
    ; Always re-enable the chat buttons on the ready handshake. The startup
    ; setChatButtonsEnabled posts in ChatWindow.ahk race the page load:
    ; WebView2 drops messages posted before the page installed its 'message'
    ; listener, which left the Send button unwired on those launches. The page
    ; posts webViewReady AFTER installing the listener, so this is the only
    ; reliable point to wire the UI.
    postWebMessage("setChatButtonsEnabled", true)
    ; The assistant/model list has the same race: ChatSettings.ahk pushes it
    ; on a one-shot 500ms timer at startup, and a slow page load drops that
    ; post, leaving the assistant picker (and _assistantList) empty until the
    ; user opens Settings. Re-push on the ready handshake — the one point we
    ; know the page is listening.
    postAssistantsToWebView()
    ; Re-push merged settings after the ready handshake so startup UI CSS
    ; variables are applied even if earlier WebView posts were dropped.
    _HandleRequestAllSettings()
    if activeThreadId
        _LoadThreadAndRefreshUI(activeThreadId)
}

; Send full settings (merged with defaults) to WebView
_HandleRequestAllSettings() {
    defaults := SettingsHandler.GetDefaults()
    loaded := SettingsHandler.Load()
    merged := SettingsHandler.Merge(loaded, defaults)
    ; Full app settings and per-thread settings use distinct message types so
    ; consumers cannot confuse their payload shapes.
    postWebMessage("appSettings", merged)
    if requestParams.Has("mainScriptHiddenHwnd")
        CustomMessages.notifyBackupStatusRequest(requestParams["mainScriptHiddenHwnd"])
}

; Send raw defaults (not merged with loaded) to WebView for Reset button.
; Also saves the defaults immediately so the chat process reloads fresh model data.
_HandleCheckCodex() {
    status := CodexCliTransport.CheckStatus()
    postWebMessage("codexStatus", status)
}

_HandleRequestDefaultSettings() {
    defaults := SettingsHandler.GetDefaults()
    ; Save and apply defaults immediately — bypass merge with stale loaded data
    if SettingsHandler.Save(defaults) {
        ; Apply + run registered update hooks (chat hotkeys re-register here).
        SettingsService.Apply(defaults)
        postAssistantsToWebView()
        postCurrentSettingsToWebView()  ; refresh thinking levels for current model
        try {
            CustomMessages.notifySettingsUpdated(requestParams["mainScriptHiddenHwnd"])
        } catch Error as e2 {
            debugLog("[SETTINGS] Failed to notify Main process: " e2.Message)
        }
    }
    postWebMessage("defaultSettings", defaults)
}

; Save settings from WebView, write to JSON, notify Main process
_HandleSaveSettings(parsed) {
    settingsData := parsed.Get("data", "")
    if !settingsData {
        postWebMessage("settingsSaved", { success: false, error: "No data received" })
        return
    }
    try {
        ; Single apply path: merge (each section payload authoritative for its
        ; own top-level key), persist, apply globals, run update hooks.
        merged := SettingsService.SaveFromWebView(settingsData)
        if merged {
            ; Push updated assistant list (and model list) to the chat sidebar
            postAssistantsToWebView()
            ; Re-push merged settings so UI CSS variables apply immediately.
            _HandleRequestAllSettings()
            ; Refresh thinking levels for current model
            postCurrentSettingsToWebView()
            ; Notify Main process to reload
            try {
                CustomMessages.notifySettingsUpdated(requestParams["mainScriptHiddenHwnd"])
            } catch Error as e2 {
                debugLog("[SETTINGS] Failed to notify Main process: " e2.Message)
            }
            postWebMessage("settingsSaved", { success: true })
        } else {
            postWebMessage("settingsSaved", { success: false, error: "Failed to write settings.json" })
        }
    } catch Error as e {
        debugLog("[SETTINGS] Save error: " e.Message " at line " e.Line)
        postWebMessage("settingsSaved", { success: false, error: e.Message })
    }
}

; Run PowerShell pricing refresh and return results
_BuildModelsDevCatalogConfig(providerData) {
    providersMap := SettingsHandler._ToMap(providerData)
    spec := ""
    config := Map()
    for providerKey, p in providersMap {
        if p.Get("transport", "http") != "http"
            continue
        providerKey := Trim(providerKey)
        if !RegExMatch(providerKey, "^[a-z0-9][a-z0-9._-]*$")
            throw Error("Invalid provider ID for models.dev refresh: " providerKey)
        catalog := Trim(p.Get("modelsDevProvider", ""))
        if catalog = ""
            catalog := providerKey
        if !RegExMatch(catalog, "^[a-z0-9][a-z0-9._-]*$")
            throw Error("Invalid models.dev provider key: " catalog)
        spec .= (spec = "" ? "" : ";") providerKey "=" catalog
        config[providerKey] := {
            catalog: catalog,
            displayName: p.Get("displayName", providerKey)
        }
    }
    return { spec: spec, providers: config }
}


_HandleRefreshModelPricing(parsed) {
    scriptPath := A_ScriptDir "\..\scripts\Refresh-Models.ps1"
    if !FileExist(scriptPath) {
        postWebMessage("modelPricingRefresh", { success: false, error: "scripts\Refresh-Models.ps1 not found" })
        return
    }
    try {
        ; -NoPause: without it the script blocks on "Press any key" and hangs the hidden window
        providerData := parsed.Get("providers", "")
        useLiveCatalogs := IsObject(providerData)
        catalogConfig := ""
        if useLiveCatalogs {
            catalogConfig := _BuildModelsDevCatalogConfig(providerData)
            if catalogConfig.spec = ""
                throw Error("No providers configured for model refresh")
            cmd := "powershell -NoProfile -ExecutionPolicy Bypass -File `"" scriptPath "`" -NoPause -ProviderCatalogs `"" catalogConfig.spec "`" -NoUpdateDefaults"
            pricingFile := A_ScriptDir "\..\scripts\models_metadata.txt"
        } else {
            cmd := "powershell -NoProfile -ExecutionPolicy Bypass -File `"" scriptPath "`" -NoPause"
            pricingFile := A_ScriptDir "\..\default-settings\DefaultModels.ahk"
        }
        exitCode := RunWait(cmd, A_ScriptDir, "Hide")
        if exitCode != 0 {
            postWebMessage("modelPricingRefresh", { success: false, error: "Refresh-Models.ps1 exited with code " exitCode })
            return
        }
        ; Read the generated model metadata file the pipeline writes
        if !FileExist(pricingFile) {
            postWebMessage("modelPricingRefresh", { success: false, error: "Model metadata output was not generated" })
            return
        }
        content := FileRead(pricingFile, "UTF-8")
        ; Parse models from the file — extract the models := Map(...) block
        models := ModelPricingParser.Parse(content)
        if !useLiveCatalogs && models.Length = 0 {
            postWebMessage("modelPricingRefresh", { success: false, error: "No models parsed from DefaultModels.ahk" })
            return
        }
        warnings := []
        if useLiveCatalogs {
            seenProviders := Map()
            for model in models {
                parts := ModelParser.Split(model.id)
                if parts.provider != ""
                    seenProviders[parts.provider] := true
            }
            for providerKey, cfg in catalogConfig.providers {
                if cfg.catalog = "openrouter" {
                    if providerKey != "openrouter"
                        warnings.Push(cfg.displayName ": the OpenRouter catalog is lookup-only; add models manually for this transport.")
                    continue
                }
                if !seenProviders.Has(providerKey)
                    warnings.Push(cfg.displayName ": no compatible models were found in models.dev catalog '" cfg.catalog "'.")
            }
        }

        postWebMessage("modelPricingRefresh", { success: true, models: models, warnings: warnings })
    } catch Error as e {
        postWebMessage("modelPricingRefresh", { success: false, error: e.Message })
    }
}

_HandleOpenRouterModelLookup(parsed) {
    global providers
    modelId := Trim(parsed.Get("modelId", ""))
    reqId := parsed.Get("reqId", "")
    result := { success: false, reqId: reqId, modelId: modelId, resolvedModelId: "", raw: "", error: "" }
    try {
        if modelId = ""
            throw Error("Enter an OpenRouter model ID, for example openai/gpt-5.6-sol")
        if !providers.Has("openrouter")
            throw Error("OpenRouter provider is not configured")
        apiKey := ProviderResolver._getApiKey(providers["openrouter"])
        if apiKey = ""
            throw Error("Configure OPENROUTER_API_KEY before looking up models")

        isFullId := InStr(modelId, "/") > 0
        if isFullId {
            ; Single-model endpoint: user-controlled path is restricted before
            ; it is appended to the fixed HTTPS OpenRouter URL.
            if !RegExMatch(modelId, "^[~A-Za-z0-9._-]+/[A-Za-z0-9._:-]+$")
                throw Error("OpenRouter model IDs must use provider/model format")
            url := "https://openrouter.ai/api/v1/model/" modelId
        } else {
            ; A bare exact slug (for example gpt-5.6-sol) is convenient in the
            ; settings table. Resolve it with OpenRouter's server-side q filter
            ; instead of downloading the full catalog. Only URL-safe model slug
            ; characters are accepted, so concatenation cannot alter the query.
            if !RegExMatch(modelId, "^[~A-Za-z0-9._:-]+$")
                throw Error("Invalid OpenRouter model slug")
            url := "https://openrouter.ai/api/v1/models?q=" modelId
        }

        http := ComObject("WinHttp.WinHttpRequest.5.1")
        http.SetTimeouts(5000, 5000, 10000, 10000)
        http.Open("GET", url, false)
        http.SetRequestHeader("Authorization", "Bearer " apiKey)
        http.SetRequestHeader("Accept", "application/json")
        http.Send()
        status := http.Status
        if status != 200 {
            if status = 404
                throw Error("OpenRouter model not found: " modelId)
            throw Error("OpenRouter model lookup failed with HTTP " status)
        }

        response := jsongo.Parse(http.ResponseText)
        if isFullId {
            if !response.Has("data") || !IsObject(response["data"]) || !response["data"].Has("id")
                throw Error("OpenRouter returned invalid model metadata")
            ; Preserve a full alias exactly as entered. The lookup response may
            ; contain its canonical target, but aliases should remain dynamic.
            result.resolvedModelId := modelId
            result.raw := http.ResponseText
        } else {
            if !response.Has("data") || !IsObject(response["data"])
                throw Error("OpenRouter returned invalid model search results")
            exactMatches := []
            suggestion := ""
            for candidate in response["data"] {
                if !IsObject(candidate) || !candidate.Has("id")
                    continue
                candidateId := candidate["id"]
                if suggestion = ""
                    suggestion := candidateId
                slashPos := InStr(candidateId, "/", , -1)
                leaf := slashPos ? SubStr(candidateId, slashPos + 1) : candidateId
                if StrLower(leaf) = StrLower(modelId)
                    exactMatches.Push(candidate)
            }
            if exactMatches.Length = 0 {
                hint := suggestion != "" ? " Try '" suggestion "'." : " Use the full provider/model ID."
                throw Error("No exact OpenRouter model matches '" modelId "'." hint)
            }
            if exactMatches.Length > 1
                throw Error("Multiple OpenRouter models use the slug '" modelId "'. Enter the full provider/model ID.")
            resolved := exactMatches[1]
            result.resolvedModelId := resolved["id"]
            result.raw := jsongo.Stringify({ data: resolved })
        }
        result.success := true
    } catch Error as e {
        result.error := e.Message
    }
    postWebMessage("openRouterModelLookup", result)
}

_SystemMessageFilesIn(dirPath) {
    files := []
    if !DirExist(dirPath)
        return files
    Loop Files dirPath "\\*.txt", "F"
        files.Push(A_LoopFileName)
    return files
}

_HandleRequestSystemMessageFiles() {
    userDir := AppInfo.DataDir "\\system-messages"
    if !DirExist(userDir)
        DirCreate(userDir)
    defaultDir := A_ScriptDir "\\..\\default-settings\\system-messages"
    postWebMessage("systemMessageFiles", {
        defaultFiles: _SystemMessageFilesIn(defaultDir),
        userFiles: _SystemMessageFilesIn(userDir),
        userFolder: userDir
    })
}

_HandleOpenSystemMessagesFolder() {
    userDir := AppInfo.DataDir "\\system-messages"
    if !DirExist(userDir)
        DirCreate(userDir)
    Run(userDir)
}

_HandleOpenExternalUrl(parsed) {
    url := Trim(parsed.Get("url", ""))
    ; Conversation content can control this value. Restrict host execution to
    ; ordinary web URLs and reject whitespace/control characters or OS/custom
    ; URI schemes before handing the target to Windows' registered handler.
    if !url || !RegExMatch(url, "i)^https?://[^\s]+$")
        throw Error("Blocked unsupported external URL")
    Run(url)
}

_HandleBrowseIcon(parsed) {
    field := parsed.Get("field", "")
    if field != "iconOn" && field != "iconOff"
        return
    selected := FileSelect(3, A_ScriptDir "\..\icons", "Select icon file", "Icon Files (*.ico)")
    if !selected
        return
    ; Store path relative to repo root when possible (settings.json uses e.g. "icons\IconOn.ico")
    repoRoot := A_ScriptDir "\.."
    if InStr(selected, repoRoot) = 1
        selected := SubStr(selected, StrLen(repoRoot) + 2)
    postWebMessage("iconFileSelected", { field: field, path: selected })
}

_HandleBrowseCompletionSound(parsed) {
    current := parsed.Get("path", "")
    startPath := current && FileExist(current) ? current : ""
    selected := FileSelect(3, startPath, "Select completion sound", "WAV Audio (*.wav)")
    if selected
        postWebMessage("completionSoundSelected", { path: selected })
}

_HandleTestCompletionSound(parsed) {
    soundType := parsed.Get("soundType", "system")
    customPath := parsed.Get("customPath", "")
    if !_PlayCompletionSound(soundType, customPath, false) {
        if soundType = "custom"
            throw Error("Choose a valid WAV file before testing the custom completion sound.")
        throw Error("Windows could not play the notification sound.")
    }
}

_HandleBrowseBackupFolder(parsed) {
    current := parsed.Get("folder", "")
    ; AutoHotkey's numeric mode 2 is a save-file dialog. Use the explicit
    ; directory mode so Browse cannot select a backup file; also discard a
    ; stale/typed file path as the dialog's starting directory.
    currentDir := DirExist(current) ? current : ""
    selected := FileSelect("D", currentDir, "Select AHKLLM backup folder")
    if selected
        postWebMessage("backupFolderSelected", { folder: selected })
}

_HandleBackupNow(parsed) {
    config := parsed.Get("backup", "")
    if !IsObject(config)
        throw Error("backupNow requires the currently displayed backup configuration")
    merged := SettingsService.SaveFromWebView({ backup: config })
    if !merged
        throw Error("could not persist the backup configuration")
    ; The config is persisted/applied in this process and is also sent
    ; explicitly to Main. Do not send a second settings-updated notification:
    ; that notification can race after the manual backup and leave the just-
    ; completed backup falsely pending for the settings change itself.
    if !CustomMessages.notifyBackupNow(requestParams["mainScriptHiddenHwnd"], config)
        throw Error("could not send the manual backup request to Main")
}

#Include Message.ahk
#Include Edit.ahk
#Include Branch.ahk
#Include Sidebar.ahk
#Include Search.ahk
#Include Lock.ahk
