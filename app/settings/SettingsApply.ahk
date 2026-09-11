; SettingsApply.ahk — applies a settings Map to runtime globals.

class SettingsApply {
    ; Apply settings Map to global variables.
    ; Called on startup and when settings are updated via IPC.
    static ApplyToGlobals(settings) {
        SettingsApply._ApplyProviders(settings)
        SettingsApply._ApplyModels(settings)
        SettingsApply._ApplyAssistants(settings)
        SettingsApply._ApplyCommands(settings)
        SettingsApply._ApplySubmenuOrder(settings)
        SettingsApply._ApplyCommandGroupOrders(settings)
        SettingsApply._ApplyThreadTitles(settings)
        SettingsApply._ApplyGenerationNotifications(settings)
        SettingsApply._ApplyUI(settings)
        SettingsApply._ApplyIcons(settings)
        SettingsApply._ApplyHotkeys(settings)
        SettingsApply._ApplyApiLogs(settings)
        SettingsApply._ApplyTrash(settings)
        SettingsApply._ApplyBackup(settings)
        SettingsApply._ApplyMenuItems(settings)
        global chatShortcut
        if settings.Has("chatShortcut")
            chatShortcut := settings["chatShortcut"]
        global newChatStartsWith
        if settings.Has("newChatStartsWith")
            newChatStartsWith := settings["newChatStartsWith"]
        global tavilyApiKey, tavilyEndpoint
        if settings.Has("tavilyApiKey")
            tavilyApiKey := settings["tavilyApiKey"]
        if settings.Has("tavilyEndpoint")
            tavilyEndpoint := settings["tavilyEndpoint"]
    }

    static _ApplyProviders(settings) {
        global providers, providerMap

        if !settings.Has("providers")
            return
        newProviders := Map()
        newProviderMap := Map()
        for k, p in settings["providers"] {
            provObj := {
                displayName: p.Has("displayName") ? p["displayName"] : k,
                endpoint: p.Has("endpoint") ? p["endpoint"] : "",
                modelsDevProvider: p.Has("modelsDevProvider") ? p["modelsDevProvider"] : "",
                fimEndpoint: p.Has("fimEndpoint") ? p["fimEndpoint"] : "",
                transport: p.Has("transport") && p["transport"] != "" ? p["transport"] : "http",
                billingMode: p.Has("billingMode") ? p["billingMode"] : "api",
                authEnvVar: p.Has("authEnvVar") ? p["authEnvVar"] : "",
                authMode: p.Has("authMode") ? p["authMode"] : "env",
                apiKey: p.Has("apiKey") ? p["apiKey"] : "",
                icon: p.Has("icon") ? p["icon"] : "",
                collapseThinking: p.Has("collapseThinking") ? p["collapseThinking"] : false
            }
            newProviders[k] := provObj
            if p.Has("prefixes") && IsObject(p["prefixes"]) {
                for _, prefix in p["prefixes"]
                    newProviderMap[prefix] := k
            }
        }
        providers := newProviders
        ; An explicit prefixes key is authoritative, including an empty list.
        ; Providers without it keep the existing UserConfig mapping.
        hasExplicitPrefixes := false
        for k, p in settings["providers"] {
            if p.Has("prefixes") {
                hasExplicitPrefixes := true
                break
            }
        }
        if hasExplicitPrefixes
            providerMap := newProviderMap
    }

    static _ApplyModels(settings) {
        global models

        if !settings.Has("models")
            return
        newModels := Map()
        for k, m in settings["models"] {
            entry := {
                provider: m.Has("provider") ? m["provider"] : "",
                input: m.Has("input") && m["input"] != "" ? m["input"] : 0,
                cachedInput: m.Has("cachedInput") ? m["cachedInput"] : "",
                output: m.Has("output") && m["output"] != "" ? m["output"] : 0,
                context: m.Has("context") ? m["context"] : 0,
                reasoning: m.Has("reasoning") ? m["reasoning"] : false,
                vision: m.Has("vision") ? m["vision"] : false
            }
            ; Preserve new metadata fields (api, compat, thinkingLevelMap, thinkingOff)
            if m.Has("api")
                entry.api := m["api"]
            if m.Has("compat") && IsObject(m["compat"])
                entry.compat := SettingsPersistence._ToMap(m["compat"])
            if m.Has("thinkingLevelMap") && IsObject(m["thinkingLevelMap"])
                entry.thinkingLevelMap := SettingsPersistence._ToMap(m["thinkingLevelMap"])
            if m.Has("thinkingOff")
                entry.thinkingOff := m["thinkingOff"]
            newModels[k] := entry
        }
        models := newModels
    }

    static _ApplyAssistants(settings) {
        global assistants

        if !settings.Has("assistants")
            return
        newAssistants := []
        for _, a in settings["assistants"] {
            newAssistants.Push({
                id: a.Has("id") ? a["id"] : "",
                name: a.Has("name") ? a["name"] : "",
                baseModel: a.Has("baseModel") ? a["baseModel"] : "",
                systemMessage: a.Has("systemMessage") ? a["systemMessage"] : "",
                systemMessageFile: a.Has("systemMessageFile") ? a["systemMessageFile"] : "",
                description: a.Has("description") ? a["description"] : "",
                reasoning: a.Has("reasoning") ? a["reasoning"] : "",
                temperature: a.Has("temperature") ? a["temperature"] : "",
                isDefault: a.Has("isDefault") ? a["isDefault"] : false
            })
        }
        assistants := newAssistants
    }

    static _ApplyCommands(settings) {
        global commands

        if !settings.Has("commands")
            return
        newCommands := []
        for _, c in settings["commands"] {
            cmd := {}
            ; Saved key presence is authoritative; empty strings, false, and zero
            ; are valid command values and must survive the settings round-trip.
            SettingsApply._SetIfExists(cmd, c, "commandName")
            SettingsApply._SetIfExists(cmd, c, "menuText")
            SettingsApply._SetIfExists(cmd, c, "APIModels")
            SettingsApply._SetIfExists(cmd, c, "pasteMode")
            SettingsApply._SetIfExists(cmd, c, "stream")
            SettingsApply._SetIfExists(cmd, c, "isFIM")
            SettingsApply._SetIfExists(cmd, c, "showInputBox")
            if c.Has("userMessage") && c["userMessage"] != ""
                cmd.userMessage := StrReplace(c["userMessage"], "``n", "`n")
            SettingsApply._SetIfExists(cmd, c, "systemMessage")
            SettingsApply._SetIfExists(cmd, c, "systemMessageFile")
            SettingsApply._SetIfExists(cmd, c, "inputBoxDefault")
            SettingsApply._SetIfExists(cmd, c, "temperature")
            SettingsApply._SetIfExists(cmd, c, "maxTokens")
            SettingsApply._SetIfExists(cmd, c, "stop")
            SettingsApply._SetIfNonEmptyTags(cmd, c)
            SettingsApply._SetIfExists(cmd, c, "directAccelerator")
            SettingsApply._SetIfExists(cmd, c, "expandNewlines")
            SettingsApply._SetIfExists(cmd, c, "maxContextWords")
            SettingsApply._SetIfExists(cmd, c, "includeImageContext")
            if c.Has("thinking")
                cmd.thinking := c["thinking"]
            newCommands.Push(cmd)
        }
        commands := newCommands
    }

    ; Key presence is authoritative; empty strings, false, and zero are valid.
    static _SetIfExists(cmd, c, key) {
        if c.Has(key)
            cmd.%key% := c[key]
    }

    static _SetIfNonEmptyTags(cmd, c) {
        ; An explicit empty array clears all tags.
        if c.Has("tags") && IsObject(c["tags"])
            cmd.tags := c["tags"]
    }

    static _ApplySubmenuOrder(settings) {
        global submenuOrder

        if !settings.Has("submenuOrder")
            return
        newSO := []
        for _, tag in settings["submenuOrder"]
            newSO.Push(tag)
        submenuOrder := newSO
    }

    ; Convert the Settings UI's zero-based command indexes to the one-based
    ; indexes used by AHK arrays. The native menu uses these per-group orders
    ; so a tagged-group drag remains visible after the settings reload.
    static _ApplyCommandGroupOrders(settings) {
        global commandGroupOrders
        commandGroupOrders := Map()
        if !settings.Has("commandGroupOrders") || !IsObject(settings["commandGroupOrders"])
            return
        for tag, rawOrder in settings["commandGroupOrders"] {
            if !IsObject(rawOrder)
                continue
            order := []
            seen := Map()
            for _, rawIndex in rawOrder {
                if !IsInteger(rawIndex)
                    continue
                index := rawIndex + 1
                if index > 0 && !seen.Has(index) {
                    order.Push(index)
                    seen[index] := true
                }
            }
            commandGroupOrders[tag] := order
        }
    }

    static _ApplyThreadTitles(settings) {
        global autoTitleGenerationEnabled, titleGenModel, titleGenSystemPrompt, titleGenMaxTokens

        if !settings.Has("threadTitles")
            return
        tt := settings["threadTitles"]
        autoTitleGenerationEnabled := tt.Has("enabled") ? tt["enabled"] : true
        ; Empty strings explicitly clear the corresponding runtime value.
        if tt.Has("model")
            titleGenModel := tt["model"]
        if tt.Has("prompt")
            titleGenSystemPrompt := tt["prompt"]
        if tt.Has("maxTokens")
            titleGenMaxTokens := tt["maxTokens"]
    }

    static _ApplyGenerationNotifications(settings) {
        global completionSoundMode, completionSoundType, completionSoundPath

        if !settings.Has("generationNotifications")
            return
        n := settings["generationNotifications"]
        mode := n.Has("mode") ? n["mode"] : "attention"
        sound := n.Has("sound") ? n["sound"] : "system"
        completionSoundMode := (mode = "never" || mode = "always") ? mode : "attention"
        completionSoundType := sound = "custom" ? "custom" : "system"
        completionSoundPath := n.Has("customPath") ? n["customPath"] : ""
    }

    static _ApplyUI(settings) {
        global responseWindowFontFace, responseWindowFontSize

        if !settings.Has("ui")
            return
        u := settings["ui"]
        ; Empty strings explicitly clear the corresponding runtime value.
        if u.Has("responseFont")
            responseWindowFontFace := u["responseFont"]
        if u.Has("responseFontSize")
            responseWindowFontSize := u["responseFontSize"]
        SettingsApply._ApplyInputWindow(u)
        SettingsApply._ApplySuspendBanner(u)
    }

    static _ApplyInputWindow(u) {
        global inputWindowBackground, inputWindowFontSize, inputWindowFontColor, inputWindowFontFace, inputWindowWidth, inputWindowHeight

        if !u.Has("inputWindow")
            return
        iw := u["inputWindow"]
        if iw.Has("background")
            inputWindowBackground := iw["background"]
        if iw.Has("fontSize")
            inputWindowFontSize := iw["fontSize"]
        if iw.Has("fontColor")
            inputWindowFontColor := iw["fontColor"]
        if iw.Has("fontFace")
            inputWindowFontFace := iw["fontFace"]
        if iw.Has("width")
            inputWindowWidth := iw["width"]
        if iw.Has("height")
            inputWindowHeight := iw["height"]
    }

    static _ApplySuspendBanner(u) {
        global suspendBannerText, suspendBannerFontSize, suspendBannerFontFace, suspendBannerTextColor, suspendBannerBackground

        if !u.Has("suspendBanner")
            return
        sb := u["suspendBanner"]
        if sb.Has("text")
            suspendBannerText := sb["text"]
        if sb.Has("fontSize")
            suspendBannerFontSize := sb["fontSize"]
        if sb.Has("fontFace")
            suspendBannerFontFace := sb["fontFace"]
        if sb.Has("textColor")
            suspendBannerTextColor := sb["textColor"]
        if sb.Has("background")
            suspendBannerBackground := sb["background"]
    }

    static _ApplyIcons(settings) {
        global iconOn, iconOff

        if !settings.Has("icons")
            return
        ic := settings["icons"]
        if ic.Has("iconOn")
            iconOn := ic["iconOn"]
        if ic.Has("iconOff")
            iconOff := ic["iconOff"]
    }

    static _ApplyHotkeys(settings) {
        global mainHotkey, reloadHotkey, closeWindowsHotkey, suspendHotkey

        if !settings.Has("hotkeys")
            return
        hk := settings["hotkeys"]
        ; Apply the saved value even when empty — an empty field means the
        ; hotkey is disabled (nothing is registered for it). Skipping empty
        ; values kept the previous binding alive forever.
        if hk.Has("main")
            mainHotkey := hk["main"]
        if hk.Has("reload")
            reloadHotkey := hk["reload"]
        if hk.Has("closeWindows")
            closeWindowsHotkey := hk["closeWindows"]
        if hk.Has("suspend")
            suspendHotkey := hk["suspend"]
    }

    static _ApplyApiLogs(settings) {
        global apiLogMaxEntries

        if !settings.Has("apiLogs")
            return
        al := settings["apiLogs"]
        if al.Has("maxEntries") {
            apiLogMaxEntries := al["maxEntries"]
            ApiLogger.TrimToLimit()
        }
    }

    static _ApplyTrash(settings) {
        global trashRetentionDays

        if !settings.Has("trash")
            return
        tr := settings["trash"]
        if tr.Has("retentionDays")
            trashRetentionDays := tr["retentionDays"]
    }

    static _ApplyBackup(settings) {
        ; BackupManager owns the live backup configuration. Keep a small
        ; global mirror for settings consumers and tests, but do not start a
        ; second settings/timer system here.
        global backupEnabled, backupFolder
        if !settings.Has("backup")
            return
        b := settings["backup"]
        if !IsObject(b) {
            backupEnabled := false
            backupFolder := ""
            return
        }
        backupEnabled := b.Has("enabled") ? b["enabled"] : false
        backupFolder := b.Has("folder") ? b["folder"] : ""
    }

    static _ApplyMenuItems(settings) {
        global quickAccessMenuItems, trayMenuItems

        if !settings.Has("menuItems")
            return
        mi := settings["menuItems"]
        if mi.Has("quickAccess") {
            newQA := []
            for _, item in mi["quickAccess"] {
                newQA.Push({ menuText: item.Has("menuText") ? item["menuText"] : "", command: item.Has("command") ? item["command"] : "" })
            }
            quickAccessMenuItems := newQA
        }
        if mi.Has("tray") {
            newTray := []
            for _, item in mi["tray"] {
                newTray.Push({ menuText: item.Has("menuText") ? item["menuText"] : "", action: item.Has("action") ? item["action"] : "" })
            }
            trayMenuItems := newTray
        }
    }
}
