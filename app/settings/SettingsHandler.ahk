; ======================================================
; SettingsHandler.ahk — facade over the settings subsystems
;
; Keeps the stable public API (SettingsHandler.Load, Save, Merge,
; GetDefaults, ApplyToGlobals, ...) while delegating to the focused
; implementations in this directory:
;   SettingsPersistence — settings.json read/write + Map conversion
;   SettingsDefaults    — pristine defaults snapshot
;   SettingsMerge       — deep-merge loaded settings with defaults
;   SettingsApply       — apply a settings Map to the globals
; ======================================================

class SettingsHandler {
    static settingsPath {
        get => SettingsPersistence.settingsPath
        set => SettingsPersistence.settingsPath := value
    }

    ; Registry of every top-level settings key. A key must be
    ; added here AND produced by SettingsDefaults, so the round-trip tests can
    ; guarantee no settings section silently drops values on save.
    static KNOWN_TOP_LEVEL_KEYS := ["version", "providers", "models", "assistants", "commands", "submenuOrder", "commandGroupOrders", "threadTitles", "generationNotifications", "ui", "icons", "hotkeys", "apiLogs", "trash", "backup", "menuItems", "chatShortcut", "newChatStartsWith", "tavilyApiKey", "tavilyEndpoint"]

    static Load() => SettingsPersistence.Load()
    static Save(settingsMap) => SettingsPersistence.Save(settingsMap)
    static _ToMap(obj) => SettingsPersistence._ToMap(obj)

    static CacheInitialDefaults() => SettingsDefaults.CacheInitialDefaults()
    static GetDefaults() => SettingsDefaults.GetDefaults()

    static Merge(existing, defaults) => SettingsMerge.Merge(existing, defaults)
    static Override(incoming, base) => SettingsMerge.Override(incoming, base)

    static ApplyToGlobals(settings) => SettingsApply.ApplyToGlobals(settings)
}
