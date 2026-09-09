#Requires AutoHotkey v2.0.18+
#Include ..\default-settings\DefaultSettings.ahk        ; App defaults (fallback for settings.json)
#Include ..\default-settings\DefaultModels.ahk          ; Auto-generated model metadata
#Include ..\default-settings\DefaultCodexModels.ahk     ; Curated ChatGPT/Codex CLI models
#Include ..\app\settings\SettingsPersistence.ahk
#Include ..\app\settings\SettingsDefaults.ahk
#Include ..\app\settings\SettingsMerge.ahk
#Include ..\app\settings\SettingsApply.ahk
#Include ..\app\settings\SettingsHandler.ahk
#Include ..\app\settings\SettingsService.ahk
#Include ..\shared\RuntimeResolver.ahk              ; API key check & provider resolution
#Include WebViewToo.ahk             ; WebView2 Framework for Web-based GUIs
#Include jsongo.v2.ahk              ; JSON parsing
#Include AutoXYWH.ahk               ; Auto-resizing of GUI controls
#Include ToolTipEx.ahk              ; Auto-timed tooltips (used by LoadingUI)
#Include SQLite\SQLite.ahk          ; SQLite database wrapper
global IUIAutomationActivateScreenReader := false  ; Prevent UIA from setting SPI_SETSCREENREADER (system-wide flag → Word black highlight)
#Include UIA.ahk                      ; UI Automation library (Descolada) — programmatic access to UI controls
DetectHiddenWindows true            ; Enables detection of hidden windows for inter-process communication

; The API transport modules emit redacted diagnostics. Load the logger before
; them so they can call it directly without an include-order warning.
#Include ..\shared\DebugLog.ahk

; Shared utilities
#Include ..\shared\SharedLib.ahk

; Application classes
#Include ..\api\CurlBuilder.ahk
#Include ..\api\CurlExecutor.ahk
#Include ..\api\CodexCliRuntime.ahk
#Include ..\api\CodexCliTransport.ahk
#Include ..\api\ProviderResolver.ahk
#Include ..\api\ResponseParser.ahk
#Include ..\api\LLMRequestBuilder.ahk
#Include ..\api\handlers\OpenAIChatCompletions.ahk
#Include ..\api\handlers\GoogleChatCompletions.ahk
#Include ..\api\SSEParser.ahk
#Include ..\api\SearchTools.ahk
#Include ..\api\ResponsesParser.ahk
#Include ..\api\ApiLogger.ahk
#Include ..\api\CostCalculator.ahk
#Include ..\app\InputWindow.ahk
#Include ..\ipc\CustomMessages.ahk
#Include ..\chat\db\ChatDB.ahk       ; Chat persistence (SQLite-backed)
#Include ..\app\backup\BackupManager.ahk ; Local user-data backup service
