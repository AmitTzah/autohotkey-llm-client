; ======================================================
; ChatWindow.ahk — Single persistent chat window
;
; Runs as a sub-process spawned by Main.ahk. No tray icon.
; Close = hide. Re-opened via tray menu or command-line arg.
;
; Usage: AutoHotkey64.exe ChatWindow.ahk <mainScriptHwnd> [threadId]
; ======================================================

#Include ..\lib\Config.ahk
#SingleInstance Off

; Global error handler — surfaces errors to chat UI and debug log.
; Returns true so AHK does not ALSO show a modal error dialog: a modal dialog
; blocks the window (and the headless harness) on background/async errors like
; WebView2 teardown races, and the UI banner + log already carry the details.
; The lambda body is a comma expression (AHK v2 fat arrows cannot take a block);
; the trailing `true` is the return value, which tells AHK not to ALSO show a
; modal error dialog (the UI banner + log already carry the details).
OnError((err, mode) => (
    debugLog("RUNTIME ERROR: " err.Message "`nStack: " (err.HasProp("Stack") ? err.Stack : "none"), "ErrorHandler"),
    (IsSet(postWebMessage) ? postWebMessage("showError", { message: "Runtime Error: " err.Message, threadId: (IsSet(requestParams) && IsObject(requestParams) && requestParams.Has("_streamThreadId") ? requestParams["_streamThreadId"] : (IsSet(activeThreadId) ? activeThreadId : "")) }) : ""),
    (IsSet(startLoadingCursor) ? startLoadingCursor(false) : ""),
    (IsSet(postWebMessage) ? postWebMessage("setChatButtonsEnabled", true) : ""),
    true
), -1)
#NoTrayIcon

; The normal chat process stays alive because it owns a configured hotkey.
; E2E deliberately suppresses global hotkeys, so keep the hidden prewarmed
; window persistent explicitly instead of letting the script exit at EOF.
if EnvGet("AHKLLM_E2E_WORKER") != ""
    Persistent()

; ----------------------------------------------------
; Hotkeys
; ----------------------------------------------------

#Include ChatHotkeys.ahk
#Include ChatIconResolver.ahk
#Include ChatWindowIcon.ahk

; ----------------------------------------------------
; Initialize DB and request params
;
; ChatDB is opened here AND in Main.ahk — both processes need
; direct DB access. Main.ahk creates threads/messages; this process
; loads threads, saves responses, manages settings. SQLite WAL mode
; allows safe concurrent access. Each process is single-threaded (AHK).
;
; requestParams is a shared Map used across ALL included modules:
; ChatIPC, ChatSettings, ChatRequestBuilder, ChatUtils, StreamHandler,
; and all ChatCallbacks_*.ahk files. It holds the current thread's
; model, provider, overrides, stream state, and temp file paths.
; ----------------------------------------------------

ChatDB.Open()

; ----------------------------------------------------
; Load settings from settings.json (fall back to DefaultSettings.ahk)
; ----------------------------------------------------
; Single apply path: SettingsService.Apply runs the registered update hooks,
; so the chat hotkeys re-register on every settings change without another
; call site in the save chain.
SettingsService.RegisterHook("chatHotkeys", _registerChatHotkeys)
SettingsHandler.CacheInitialDefaults()
settings := SettingsHandler.Load()
SettingsService.Apply(SettingsHandler.Merge(settings, SettingsHandler.GetDefaults()))
RuntimeResolver_CheckApiKeys()
RuntimeResolver_ResolvePrimaryProvider()
debugLog("[CHAT] Settings loaded" (settings.Count ? " from settings.json" : " from DefaultSettings"))

; Clean up DB and cURL on exit (ProcessClose from Main.ahk is force-kill;
; this runs when ChatWindow exits gracefully via WinClose or user action)
_ChatWindowOnExit(*) {
    try ChatDB.Close()
    try {
        ; Close every in-flight cURL process; multiple chat-mode
        ; commands can be streaming at once, so the single global cURLState
        ; PID is not enough.
        if IsSet(_activeStreams) {
            for stream in _activeStreams {
                if stream.HasOwnProp("pid") && stream.pid && ProcessExist(stream.pid)
                    ProcessClose(stream.pid)
            }
        }
        if IsSet(_activeToolLoops) {
            for loopState in _activeToolLoops
                SearchTools.CancelProcess(loopState)
        }
        if IsSet(_activeNonStreamRequests) {
            for scope in _activeNonStreamRequests
                SearchTools.CancelProcess(scope)
        }
        if IsSet(cURLState) {
            pid := cURLState("get")
            if pid && ProcessExist(pid)
                cURLState("close")
        }
        CleanupOwnedTempFiles()
    }
}
OnExit(_ChatWindowOnExit)

requestParams := Map()
requestParams["pasteMode"] := "chat"
requestParams["uniqueID"] := A_TickCount A_NowUTC
requestParams["mainScriptHiddenHwnd"] := A_Args.Length > 0 ? Integer(A_Args[1]) : 0
requestParams["providerName"] := "deepseek"
requestParams["singleAPIModelName"] := appDefaultModel
requestParams["windowTitle"] := "Chat"
requestParams["stream"] := true
requestParams["isFIM"] := false
requestParams["numberOfAPIModels"] := 1
requestParams["APIModelsIndex"] := 1
activeThreadId := ""
CleanupOwnedTempFiles()

; ----------------------------------------------------
; IPC handlers (ChatIPC), settings (ChatSettings),
; and request builder (ChatRequestBuilder)
; ----------------------------------------------------

#Include ChatSettings.ahk
#Include ChatUtils.ahk
#Include ChatRequestBuilder.ahk
#Include ChatIPC.ahk
#Include tools\SearchToolExecutor.ahk
SearchToolExecutor.RecoverAbandonedPlaceholders()

; ----------------------------------------------------
; Create WebView and LLM client
; ----------------------------------------------------

global responseWindow := WebViewToo(, , ,)
responseWindow.OnEvent("Close", (*) => responseWindow.Hide())
responseWindow.Title := AppInfo.Name
global chatWindow := responseWindow

; Set window icon (title bar / taskbar) to match the main script's tray icon.
; Resolve the configured path first — absolute paths (e.g. an icon picked
; outside the repo) are used as-is; repo-relative paths resolve against the
; repo root. An empty value means no icon.
; Set the window icon (title bar / taskbar) and re-apply it on every settings
; update, so "Active Icon" (iconOn) edits take effect live instead
; of only at startup. The hook is registered AFTER the window exists: the
; initial SettingsService.Apply above ran before chatWindow was created.
_applyChatWindowIcon()
SettingsService.RegisterHook("chatWindowIcon", _applyChatWindowIcon)

; Set up WebMessageReceived handler for JS→AHK communication via postMessage
responseWindow.WebMessageReceived(OnWebMessageReceived)

; Register Dashboard host object for inline usage dashboard
responseWindow.AddHostObjectToScript("Dashboard", {
    QueryUsage: (filtersJson) => jsongo.Stringify(ChatDB.Usage_Query(jsongo.Parse(filtersJson)))
})

llmClient := LLMRequestBuilder(APIKey)

; ----------------------------------------------------
; Utility modules, dispatch, and callbacks
; ----------------------------------------------------

; Handle inline dashboard IPC from Main.ahk
OnMessage(CustomMessages.WM_SHOW_DASHBOARD, (*) => (
    postWebMessage("showDashboard"),
    chatWindow.Show(),
    WinActivate("ahk_id " chatWindow.hWnd)
))
; Handle Settings-panel IPC from Main.ahk
OnMessage(CustomMessages.WM_SHOW_SETTINGS, (*) => (
    postWebMessage("showSettings"),
    chatWindow.Show(),
    WinActivate("ahk_id " chatWindow.hWnd)
))
OnMessage(CustomMessages.WM_BACKUP_STATUS, _OnBackupStatus)

_OnBackupStatus(*) {
    try {
        if !FileExist(BackupManager.StatusPath)
            return
        ; Build a plain AHK object from scalar fields. Passing the raw jsongo
        ; wrapper through nested jsongo.Stringify can fail with "Invalid index"
        ; and leave the WebView showing its optimistic pending text.
        parsedStatus := jsongo.Parse(FileRead(BackupManager.StatusPath, "UTF-8"))
        status := {
            enabled: parsedStatus.Get("enabled", false),
            folder: parsedStatus.Get("folder", ""),
            text: parsedStatus.Get("text", "No backup has been created yet"),
            lastBackupTime: parsedStatus.Get("lastBackupTime", ""),
            lastError: parsedStatus.Get("lastError", ""),
            pending: parsedStatus.Get("pending", false),
            running: parsedStatus.Get("running", false)
        }
        postWebMessage("backupStatus", status)
    } catch Error as e {
        debugLog("[BACKUP] Failed to read status: " e.Message)
    }
}

#Include ThreadTitleGen.ahk
#Include streaming\StreamHandler.ahk
#Include callbacks\Dispatch.ahk

; ----------------------------------------------------
; Load WebView
; ----------------------------------------------------

responseWindow.Load("..\webui\index.html")

; ----------------------------------------------------
; Show window
; ----------------------------------------------------

showChatWindow(initialRequest := true, activate := true) {
    if initialRequest {
        _SetChatWindowSize()
        options := _WindowPosStr() (activate ? "" : " NA")
        chatWindow.Show(options, "Chat")
    } else {
        chatWindow.Show(activate ? "" : "NA")
    }
    if activate && !WinActive("ahk_id " chatWindow.hWnd)
        chatWindow.Flash()
    if activate
        WinActivate("ahk_id " chatWindow.hWnd)
    Sleep 500
    if initialRequest && requestParams["mainScriptHiddenHwnd"] {
        CustomMessages.notifyLoadingState(CustomMessages.WM_CHAT_WINDOW_OPENED,
            requestParams["uniqueID"], chatWindow.hWnd, requestParams["mainScriptHiddenHwnd"])
    }
}

; Check if pre-warming (spawned hidden at Main.ahk startup)
prewarming := (A_Args.Length >= 2 && A_Args[2] = "prewarm")

if prewarming {
    ; Pre-warm mode: initialize WebView2 in background, stay hidden.
    ; Set window size/position now so it appears centered when shown.
    _SetChatWindowSize()
    ; Post config messages so they're ready when user opens.
    postWebMessage("setChatButtonsEnabled", true)
    ; Notify main script so it knows we exist (for WinShow later).
    CustomMessages.notifyLoadingState(CustomMessages.WM_CHAT_WINDOW_OPENED,
        requestParams["uniqueID"], chatWindow.hWnd, requestParams["mainScriptHiddenHwnd"])
    debugLog("[APP] ChatWindow prewarmed — hWnd=" chatWindow.hWnd)
} else {
    noActivate := A_Args.Length >= 3 && A_Args[3] = "noactivate"
    showChatWindow(true, !noActivate)
    postWebMessage("setChatButtonsEnabled", true)
}

; ----------------------------------------------------
; Load initial thread if passed via command-line arg
; (skip in prewarm mode — "prewarm" is not a thread ID)
; ----------------------------------------------------

if (A_Args.Length >= 2 && A_Args[2] != "" && A_Args[2] != "prewarm") {
    LoadThreadIntoUI(A_Args[2], true)  ; autoFire=true for command-line-arg path
    Sleep 500
    postWebMessage("setChatButtonsEnabled", { enabled: !_HasActiveOperationForUi(activeThreadId), threadId: activeThreadId })
    if requestParams["mainScriptHiddenHwnd"]
        CustomMessages.notifyThreadLoaded(requestParams["mainScriptHiddenHwnd"])
}

; Default chat window dimensions used by showChatWindow and prewarm.
_ChatWindowDims() {
    return { w: 900, h: 680,
             x: (A_ScreenWidth - 900) // 2,
             y: (A_ScreenHeight - 680) // 4 }
}

; Compute default chat window size and position, then move the window.
_SetChatWindowSize() {
    d := _ChatWindowDims()
    WinMove(d.x, d.y, d.w, d.h, "ahk_id " chatWindow.hWnd)
}

; Return a position string "xX yY wW hH" for the default chat window layout.
_WindowPosStr() {
    d := _ChatWindowDims()
    return Format("x{} y{} w{} h{}", d.x, d.y, d.w, d.h)
}
