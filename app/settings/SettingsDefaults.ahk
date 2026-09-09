; ======================================================
; SettingsDefaults.ahk — pristine defaults snapshot
;
; Builds the complete defaults Map from the DefaultSettings.ahk globals and
; caches the pristine snapshot captured at startup (before ApplyToGlobals
; overwrites those globals with applied values).
; ======================================================

class SettingsDefaults {
    static _initialDefaults := unset
    static _initialDefaultsCaptured := false

    ; Call once at startup before ApplyToGlobals to cache the true defaults.
    static CacheInitialDefaults() {
        SettingsDefaults._initialDefaults := SettingsDefaults.GetDefaults()
        SettingsDefaults._initialDefaultsCaptured := true
    }

    ; Build complete defaults Map from current DefaultSettings.ahk globals.
    ; Delegates to section-specific helpers for readability.
    ;
    ; IMPORTANT: after ApplyToGlobals() has run, the section globals (chatShortcut,
    ; appDefaultModel, hotkeys, ...) hold APPLIED values, not defaults. Reading them
    ; here would return the applied values, which broke "Reset to Defaults" (e.g.
    ; chatShortcut stayed "b" instead of reverting to "1"). So once CacheInitialDefaults()
    ; has captured the pristine snapshot at startup, return that instead.
    static GetDefaults() {
        if SettingsDefaults._initialDefaultsCaptured {
            snapshot := Map()
            for k, v in SettingsDefaults._initialDefaults
                ; Deep-clone so a caller mutating the returned snapshot cannot
                snapshot[k] := SettingsDefaults._DeepClone(v)
            return snapshot
        }
        d := Map()
        d["version"] := 1
        d["providers"] := SettingsDefaults._DefaultsProviders()
        d["models"] := SettingsDefaults._DefaultsModels()
        d["assistants"] := SettingsDefaults._DefaultsAssistants()
        d["commands"] := SettingsDefaults._DefaultsCommands()
        d["submenuOrder"] := SettingsDefaults._DefaultsSubmenuOrder()
        d["commandGroupOrders"] := Map()
        d["threadTitles"] := SettingsDefaults._DefaultsThreadTitles()
        d["ui"] := SettingsDefaults._DefaultsUI()
        d["icons"] := SettingsDefaults._DefaultsIcons()
        d["hotkeys"] := SettingsDefaults._DefaultsHotkeys()
        d["apiLogs"] := SettingsDefaults._DefaultsApiLogs()
        d["trash"] := SettingsDefaults._DefaultsTrash()
        d["backup"] := Map(
            "enabled", false,
            "folder", ""
        )
        d["menuItems"] := SettingsDefaults._DefaultsMenuItems()
        d["chatShortcut"] := IsSet(chatShortcut) ? chatShortcut : ""
        d["newChatStartsWith"] := IsSet(newChatStartsWith) ? newChatStartsWith : ""
        d["tavilyApiKey"] := IsSet(tavilyApiKey) ? tavilyApiKey : ""
        d["tavilyEndpoint"] := IsSet(tavilyEndpoint) ? tavilyEndpoint : "https://api.tavily.com/search"
        return d
    }

    ; --- Defaults helpers (read from DefaultSettings globals) ---

    static _DefaultsProviders() {
        global providers, providerMap

        provMap := Map()
        for providerKey, p in providers {
            provMap[providerKey] := Map(
                "displayName", p.displayName,
                "endpoint", p.endpoint,
                "modelsDevProvider", p.HasOwnProp("modelsDevProvider") ? p.modelsDevProvider : "",
                "fimEndpoint", p.HasOwnProp("fimEndpoint") ? p.fimEndpoint : "",
                "transport", p.HasOwnProp("transport") ? p.transport : "http",
                "billingMode", p.HasOwnProp("billingMode") ? p.billingMode : "api",
                "authMode", p.HasOwnProp("authMode") ? p.authMode : "env",
                "authEnvVar", p.HasOwnProp("authEnvVar") ? p.authEnvVar : "",
                "apiKey", "",
                "icon", p.HasOwnProp("icon") ? p.icon : "",
                "collapseThinking", p.HasOwnProp("collapseThinking") ? p.collapseThinking : false,
                "prefixes", []
            )
        }
        ; Fill prefixes from global providerMap
        if IsSet(providerMap)
            SettingsDefaults._FillPrefixesFromProviderMap(provMap)
        return provMap
    }

    static _FillPrefixesFromProviderMap(provMap) {
        global providerMap
        for prefix, prov in providerMap {
            if !provMap.Has(prov)
                continue
            prefixes := provMap[prov]["prefixes"]
            if !IsObject(prefixes)
                prefixes := []
            found := false
            for _, p in prefixes {
                if p = prefix {
                    found := true
                    break
                }
            }
            if !found
                prefixes.Push(prefix)
            provMap[prov]["prefixes"] := prefixes
        }
    }

    static _DefaultsModels() {
        global models

        modelMap := Map()
        for modelId, m in models {
            entry := Map(
                "provider", m.HasOwnProp("provider") ? m.provider : "",
                "input", m.HasOwnProp("input") ? m.input : 0,
                "cachedInput", m.HasOwnProp("cachedInput") ? m.cachedInput : "",
                "output", m.HasOwnProp("output") ? m.output : 0,
                "context", m.HasOwnProp("context") ? m.context : 0,
                "reasoning", m.HasOwnProp("reasoning") ? m.reasoning : false,
                "vision", m.HasOwnProp("vision") ? m.vision : false
            )
            ; Preserve new metadata fields (api, compat, thinkingLevelMap, thinkingOff)
            if m.HasOwnProp("api")
                entry["api"] := m.api
            if m.HasOwnProp("compat") && IsObject(m.compat)
                entry["compat"] := SettingsDefaults._CloneMap(m.compat)
            if m.HasOwnProp("thinkingLevelMap") && IsObject(m.thinkingLevelMap)
                entry["thinkingLevelMap"] := SettingsDefaults._CloneMap(m.thinkingLevelMap)
            if m.HasOwnProp("thinkingOff")
                entry["thinkingOff"] := m.thinkingOff
            modelMap[modelId] := entry
        }
        return modelMap
    }

    ; Deep-clone a Map (for compat, thinkingLevelMap)
    static _CloneMap(src) {
        result := Map()
        for k, v in src
            result[k] := v
        return result
    }

    ; Recursively copy Maps/Arrays so GetDefaults() snapshots are independent.
    static _DeepClone(value) {
        if value is Map {
            result := Map()
            for k, v in value
                result[k] := SettingsDefaults._DeepClone(v)
            return result
        }
        if value is Array {
            result := []
            for item in value
                result.Push(SettingsDefaults._DeepClone(item))
            return result
        }
        return value
    }

    static _DefaultsAssistants() {
        global assistants

        asstList := []
        for a in assistants {
            asstList.Push(Map(
                "id", SettingsPersistence._UUID(),
                "name", a.name,
                "baseModel", a.baseModel,
                "systemMessage", a.HasOwnProp("systemMessage") ? a.systemMessage : "",
                "systemMessageFile", a.HasOwnProp("systemMessageFile") ? a.systemMessageFile : "",
                "description", a.HasOwnProp("description") ? a.description : "",
                "reasoning", a.HasOwnProp("reasoning") ? a.reasoning : "",
                "temperature", a.HasOwnProp("temperature") ? a.temperature : "",
                ; Carry isDefault through the defaults snapshot so
                ; DefaultSettings marks an assistant isDefault:true, and the
                ; fresh-profile apply path must see it (otherwise "App Default"
                ; starts with the model instead of the marked assistant).
                "isDefault", a.HasOwnProp("isDefault") ? a.isDefault : false
            ))
        }
        return asstList
    }

    static _DefaultsCommands() {
        global commands

        cmdList := []
        for c in commands
            cmdList.Push(SettingsDefaults._CommandToMap(c))
        return cmdList
    }

    static _DefaultsSubmenuOrder() {
        global submenuOrder

        soList := []
        if IsSet(submenuOrder) {
            for _, tag in submenuOrder
                soList.Push(tag)
        }
        return soList
    }

    static _DefaultsThreadTitles() {
        global autoTitleGenerationEnabled, titleGenModel, titleGenSystemPrompt, titleGenMaxTokens

        return Map(
            "enabled", IsSet(autoTitleGenerationEnabled) ? autoTitleGenerationEnabled : true,
            "model", IsSet(titleGenModel) ? titleGenModel : "deepseek/deepseek-v4-flash",
            "prompt", IsSet(titleGenSystemPrompt) ? titleGenSystemPrompt : "",
            "maxTokens", IsSet(titleGenMaxTokens) ? titleGenMaxTokens : 50
        )
    }

    static _DefaultsUI() {
        global responseWindowFontFace, responseWindowFontSize
        global inputWindowBackground, inputWindowFontSize, inputWindowFontColor, inputWindowFontFace, inputWindowWidth, inputWindowHeight
        global suspendBannerText, suspendBannerFontSize, suspendBannerFontFace, suspendBannerTextColor, suspendBannerBackground

        return Map(
            "responseFont", IsSet(responseWindowFontFace) ? responseWindowFontFace : "Inter",
            "responseFontSize", IsSet(responseWindowFontSize) ? responseWindowFontSize : "17",
            "inputWindow", Map(
                "background", IsSet(inputWindowBackground) ? inputWindowBackground : "0x212529",
                "fontSize", IsSet(inputWindowFontSize) ? inputWindowFontSize : "s14",
                "fontColor", IsSet(inputWindowFontColor) ? inputWindowFontColor : "cWhite",
                "fontFace", IsSet(inputWindowFontFace) ? inputWindowFontFace : "Arial",
                "width", IsSet(inputWindowWidth) ? inputWindowWidth : 500,
                "height", IsSet(inputWindowHeight) ? inputWindowHeight : 250
            ),
            "suspendBanner", Map(
                "text", IsSet(suspendBannerText) ? suspendBannerText : "AhkLLM Suspended",
                "fontSize", IsSet(suspendBannerFontSize) ? suspendBannerFontSize : "s10",
                "fontFace", IsSet(suspendBannerFontFace) ? suspendBannerFontFace : "Arial",
                "textColor", IsSet(suspendBannerTextColor) ? suspendBannerTextColor : "cBlack",
                "background", IsSet(suspendBannerBackground) ? suspendBannerBackground : "0xFFDF00"
            )
        )
    }

    static _DefaultsIcons() {
        global iconOn, iconOff

        return Map(
            "iconOn", IsSet(iconOn) ? iconOn : "icons\IconOn.ico",
            "iconOff", IsSet(iconOff) ? iconOff : "icons\IconOff.ico"
        )
    }

    static _DefaultsHotkeys() {
        global mainHotkey, reloadHotkey, closeWindowsHotkey, suspendHotkey

        return Map(
            "main", IsSet(mainHotkey) ? mainHotkey : "``",
            "reload", IsSet(reloadHotkey) ? reloadHotkey : "~^!r",
            "closeWindows", IsSet(closeWindowsHotkey) ? closeWindowsHotkey : "~^w",
            "suspend", IsSet(suspendHotkey) ? suspendHotkey : "CapsLock & ``"
        )
    }

    static _DefaultsApiLogs() {
        global apiLogMaxEntries

        return Map(
            "maxEntries", IsSet(apiLogMaxEntries) ? apiLogMaxEntries : 20
        )
    }

    static _DefaultsTrash() {
        global trashRetentionDays

        return Map(
            "retentionDays", IsSet(trashRetentionDays) ? trashRetentionDays : 30
        )
    }

    static _DefaultsMenuItems() {
        global quickAccessMenuItems, trayMenuItems

        qaList := []
        if IsSet(quickAccessMenuItems) {
            for _, item in quickAccessMenuItems {
                qaList.Push(Map(
                    "menuText", item.menuText,
                    "command", item.command
                ))
            }
        }
        trayList := []
        if IsSet(trayMenuItems) {
            for _, item in trayMenuItems {
                trayList.Push(Map(
                    "menuText", item.menuText,
                    "action", item.action
                ))
            }
        }
        return Map(
            "quickAccess", qaList,
            "tray", trayList
        )
    }

    ; Convert a command object to a Map for serialization
    static _CommandToMap(c) {
        m := Map()
        m["commandName"] := c.HasOwnProp("commandName") ? c.commandName : ""
        m["menuText"] := c.HasOwnProp("menuText") ? c.menuText : ""
        m["APIModels"] := c.HasOwnProp("APIModels") ? c.APIModels : ""
        m["pasteMode"] := c.HasOwnProp("pasteMode") ? c.pasteMode : "chat"
        m["stream"] := c.HasOwnProp("stream") ? c.stream : false
        m["isFIM"] := c.HasOwnProp("isFIM") ? c.isFIM : false
        m["showInputBox"] := c.HasOwnProp("showInputBox") ? c.showInputBox : false
        m["userMessage"] := c.HasOwnProp("userMessage") ? c.userMessage : ""
        m["systemMessage"] := c.HasOwnProp("systemMessage") ? c.systemMessage : ""
        m["systemMessageFile"] := c.HasOwnProp("systemMessageFile") ? c.systemMessageFile : ""
        m["inputBoxDefault"] := c.HasOwnProp("inputBoxDefault") ? c.inputBoxDefault : ""
        m["temperature"] := c.HasOwnProp("temperature") ? (c.temperature = "" ? "" : c.temperature) : ""
        m["maxTokens"] := c.HasOwnProp("maxTokens") ? c.maxTokens : ""
        m["stop"] := c.HasOwnProp("stop") ? c.stop : ""
        m["tags"] := c.HasOwnProp("tags") ? c.tags : []
        m["directAccelerator"] := c.HasOwnProp("directAccelerator") ? c.directAccelerator : ""
        m["expandNewlines"] := c.HasOwnProp("expandNewlines") ? c.expandNewlines : false
        m["maxContextWords"] := c.HasOwnProp("maxContextWords") ? c.maxContextWords : 0
        m["includeImageContext"] := c.HasOwnProp("includeImageContext") ? c.includeImageContext : false
        if c.HasOwnProp("thinking") {
            m["thinking"] := c.thinking
        }
        return m
    }
}
