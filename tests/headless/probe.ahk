; probe.ahk — Win32-level helper for the headless harness.
; Usage: AutoHotkey64.exe probe.ahk <command> <outFile> [arg1 ...]
; Writes a small JSON object to <outFile> and exits 0.
#Requires AutoHotkey v2.0.18+
#SingleInstance Off
#NoTrayIcon
DetectHiddenWindows true

command := A_Args.Length > 0 ? A_Args[1] : ""
outFile := A_Args.Length > 1 ? A_Args[2] : ""

; Never block the harness: log any error and force-exit.
OnError((err, mode) => (Write(Map("error", err.Message)), ExitApp(1)), -1)
SetTimer(ExitWatchdog, -15000)
ExitWatchdog(*) {
    Write(Map("error", "WATCHDOG fired"))
    ExitApp(1)
}

Write(obj) {
    global outFile
    if !outFile
        return
    lines := []
    for k, v in obj
        lines.Push(k "|" v)
    try FileAppend(Join("`n", lines), outFile, "UTF-8")
}

Join(sep, arr) {
    out := ""
    for i, v in arr
        out .= (i > 1 ? sep : "") v
    return out
}

ChatHwnd() {
    ; AHK v2 GUI windows have class "AutoHotkeyGUI" (the "AutoHotkey" class is
    ; the hidden script window). Find the ChatWindow process via its script
    ; window, then return its GUI window ("AhkLLM" while prewarmed,
    ; "AhkLLM - <title>" after being shown/renamed).
    ; A stale ChatWindow from an earlier scenario can briefly outlive its
    ; teardown; if several are alive, prefer the most recently started one
    ; (highest PID) so probes never inspect a zombie window from a previous run.
    chatPid := 0
    ; Prefer process enumeration: the harness may run on a different desktop,
    ; where the ChatWindow's hidden script window is not visible to WinGetList.
    ; The command line marker still keeps this worker separate from siblings.
    for proc in ProcessList() {
        if !InStr(proc["exe"], "AutoHotkey64.exe")
            continue
        cmd := ProcessCmdLine(proc["pid"])
        if !InStr(cmd, "\ChatWindow.ahk`"") || !IsCurrentWorkerProcess(proc["pid"])
            continue
        if proc["pid"] > chatPid
            chatPid := proc["pid"]
    }
    ; Fallback for the normal interactive desktop, where the script window is
    ; visible even when process command-line access is unavailable.
    if !chatPid {
        for h in WinGetList("ahk_class AutoHotkey") {
            t := WinGetTitle("ahk_id " h)
            if InStr(t, "ChatWindow.ahk") {
                pid := WinGetPID("ahk_id " h)
                if IsCurrentWorkerProcess(pid) && pid > chatPid
                    chatPid := pid
            }
        }
    }
    if !chatPid
        return 0
    for h in WinGetList("ahk_pid " chatPid) {
        if WinGetClass("ahk_id " h) != "AutoHotkeyGUI"
            continue
        t := WinGetTitle("ahk_id " h)
        if (t = "AhkLLM") || (SubStr(t, 1, 6) = "AhkLLM")
            return h
    }
    return 0
}

IsCurrentWorkerProcess(pid) {
    worker := EnvGet("AHKLLM_E2E_WORKER")
    return worker = "" || InStr(ProcessCmdLine(pid), "--e2e-worker=" worker)
}

MoveOffscreenNoActivate(hwnd, w := 0, h := 0) {
    ; HWND_BOTTOM + SWP_NOACTIVATE + SWP_SHOWWINDOW. When dimensions are
    ; supplied, also retain the render size and avoid sending a redraw storm.
    flags := (w && h) ? 0x0450 : 0x0051
    DllCall("user32.dll\SetWindowPos", "ptr", hwnd, "ptr", 1, "int", -20000, "int", -20000, "int", w, "int", h, "uint", flags)
    DllCall("user32.dll\ShowWindow", "ptr", hwnd, "int", 4) ; SW_SHOWNOACTIVATE
}

; Render an HICON into a 32x32 BGRA DIB and return its bytes as hex. Two
; LoadPicture calls for the same file return different handles, so handle
; equality cannot prove two icons are the same image — rendered bytes can.
IconFingerprint(hIcon, &crc := 0) {
    if !hIcon
        return ""
    w := 32, h := 32
    bi := Buffer(40)  ; BITMAPINFOHEADER
    NumPut("uint", 40, bi, 0)
    NumPut("int", w, bi, 4)
    NumPut("int", -h, bi, 8)    ; negative height = top-down
    NumPut("ushort", 1, bi, 12)
    NumPut("ushort", 32, bi, 14)
    hdcScreen := DllCall("user32.dll\GetDC", "ptr", 0, "ptr")
    hdcMem := DllCall("gdi32.dll\CreateCompatibleDC", "ptr", hdcScreen, "ptr")
    bits := 0
    hbm := DllCall("gdi32.dll\CreateDIBSection", "ptr", hdcMem, "ptr", bi, "uint", 0, "ptr*", &bits, "ptr", 0, "uint", 0, "ptr")
    if !hbm {
        DllCall("gdi32.dll\DeleteDC", "ptr", hdcMem)
        DllCall("user32.dll\ReleaseDC", "ptr", 0, "ptr", hdcScreen)
        return ""
    }
    old := DllCall("gdi32.dll\SelectObject", "ptr", hdcMem, "ptr", hbm, "ptr")
    ; DI_NORMAL = 3
    DllCall("user32.dll\DrawIconEx", "ptr", hdcMem, "int", 0, "int", 0, "ptr", hIcon, "int", w, "int", h, "uint", 0, "ptr", 0, "uint", 3)
    byteCount := w * h * 4
    buf := Buffer(byteCount)
    DllCall("ntdll.dll\RtlMoveMemory", "ptr", buf, "ptr", bits, "uptr", byteCount)
    hex := ""
    loop byteCount
        hex .= Format("{:02X}", NumGet(buf, A_Index - 1, "uchar"))
    ; Compact CRC of the rendered pixels so failures can say WHAT the window
    ; icon actually was (blank/zeros = the cross-process draw failed; a real
    ; but different icon = the app applied something else).
    crc := 2166136261
    loop byteCount
        crc := (crc ^ NumGet(buf, A_Index - 1, "uchar")) * 16777619 & 0xFFFFFFFF
    crc := Format("{:08X}", crc)
    DllCall("gdi32.dll\SelectObject", "ptr", hdcMem, "ptr", old)
    DllCall("gdi32.dll\DeleteObject", "ptr", hbm)
    DllCall("gdi32.dll\DeleteDC", "ptr", hdcMem)
    DllCall("user32.dll\ReleaseDC", "ptr", 0, "ptr", hdcScreen)
    return hex
}

; CreateDIBSection/DrawIconEx can fail transiently in a fresh process (GDI),
; which used to make icon-check report a bogus "custom icon NOT applied".
; Retry a few times; "" means the icon could not be rendered at all.
RenderFingerprint(hIcon, &crc := "") {
    loop 6 {
        fp := IconFingerprint(hIcon, &crc)
        if fp != ""
            return fp
        Sleep 300
    }
    return ""
}

; PIDs of THIS repo's app scripts only: Main.ahk and chat/ChatWindow.ahk.
; Matched two ways, so a user's unrelated AHK scripts are never included:
;  1) process command line (works even when the app was started on the user's
;     interactive desktop, which this sandbox desktop cannot see), and
;  2) script-window title (full path + " - AutoHotkey vX.Y").
; A windowless hung AutoHotkey64.exe (load-time hang / modal error dialog) has
; no recognizable cmdline/window and is never matched -- it is NOT one of the
; app scripts and must not be killed by guesswork.
AppScriptPids(includeWebView2 := true) {
    pids := []
    ; Command-line match: "<exe>" "<path>\Main.ahk" / ...\chat\ChatWindow.ahk"
    for proc in ProcessList() {
        if !InStr(proc["exe"], "AutoHotkey64.exe")
            continue
        cmd := ProcessCmdLine(proc["pid"])
        if !(InStr(cmd, "\Main.ahk`"") || InStr(cmd, "\ChatWindow.ahk`""))
            continue
        if !IsCurrentWorkerProcess(proc["pid"])
            continue
        if !HasVal(pids, proc["pid"])
            pids.Push(proc["pid"])
    }
    if includeWebView2 {
        ; Also close THIS harness's WebView2 browser processes
        ; (msedgewebview2.exe). They carry our unique --user-data-dir marker
        ; (llm-webview2-*); matching it never touches other applications'
        ; WebView2 processes.
        for proc in ProcessList() {
            if !InStr(proc["exe"], "msedgewebview2.exe")
                continue
            cmd := ProcessCmdLine(proc["pid"])
            if !InStr(cmd, "llm-webview2-")
                continue
            if !HasVal(pids, proc["pid"])
                pids.Push(proc["pid"])
        }
    }
    ; Window-title match (catches instances on this desktop with unusual cmdlines).
    for h in WinGetList("ahk_class AutoHotkey") {
        t := WinGetTitle("ahk_id " h)
        if !(InStr(t, "\Main.ahk - AutoHotkey") || InStr(t, "\ChatWindow.ahk - AutoHotkey"))
            continue
        pid := WinGetPID("ahk_id " h)
        if !IsCurrentWorkerProcess(pid)
            continue
        if !HasVal(pids, pid)
            pids.Push(pid)
    }
    return pids
}

; Read another process's command line via its PEB (works for same-user processes
; even on a different desktop, where window enumeration cannot see them).
; Returns "" when it cannot be read (access denied / not an AHK process).
ProcessCmdLine(pid) {
    hProc := DllCall("kernel32.dll\OpenProcess", "uint", 0x0410, "int", 0, "uint", pid, "ptr") ; QUERY_INFORMATION | VM_READ
    if !hProc
        return ""
    try {
        ; PROCESS_BASIC_INFORMATION: PebBaseAddress at offset 8 (x64).
        pbi := Buffer(48)
        DllCall("ntdll.dll\NtQueryInformationProcess", "ptr", hProc, "int", 0, "ptr", pbi, "uint", 48, "uint*", &retLen := 0)
        peb := NumGet(pbi, 8, "ptr")
        ; PEB.ProcessParameters at offset 0x20 (x64).
        ppBuf := Buffer(8)
        if !DllCall("kernel32.dll\ReadProcessMemory", "ptr", hProc, "ptr", peb + 0x20, "ptr", ppBuf, "uptr", 8, "uptr*", &bytesRead := 0)
            return ""
        params := NumGet(ppBuf, 0, "ptr")
        ; RTL_USER_PROCESS_PARAMETERS.CommandLine at offset 0x70 (x64):
        ; UNICODE_STRING { Length(2), MaxLength(2), pad(4), Buffer(8) }.
        uni := Buffer(16)
        if !DllCall("kernel32.dll\ReadProcessMemory", "ptr", hProc, "ptr", params + 0x70, "ptr", uni, "uptr", 16, "uptr*", &bytesRead := 0)
            return ""
        cmdLen := NumGet(uni, 0, "ushort")
        cmdBuf := NumGet(uni, 8, "ptr")
        if !cmdLen || !cmdBuf
            return ""
        out := Buffer(cmdLen)
        if !DllCall("kernel32.dll\ReadProcessMemory", "ptr", hProc, "ptr", cmdBuf, "ptr", out, "uptr", cmdLen, "uptr*", &bytesRead := 0)
            return ""
        return StrGet(out, cmdLen // 2, "UTF-16")
    } finally {
        DllCall("kernel32.dll\CloseHandle", "ptr", hProc)
    }
}

; Enumerate processes via Toolhelp32; returns an array of Map(pid, exe).
ProcessList() {
    procs := []
    hSnap := DllCall("kernel32.dll\CreateToolhelp32Snapshot", "uint", 0x2, "uint", 0, "ptr") ; TH32CS_SNAPPROCESS
    if !hSnap || hSnap = -1
        return procs
    try {
        pe32 := Buffer(568)
        NumPut("uint", 568, pe32, 0)
        if !DllCall("kernel32.dll\Process32FirstW", "ptr", hSnap, "ptr", pe32)
            return procs
        loop {
            procs.Push(Map("pid", NumGet(pe32, 8, "uint"), "exe", StrGet(pe32.Ptr + 44, 260, "UTF-16")))
        } until !DllCall("kernel32.dll\Process32NextW", "ptr", hSnap, "ptr", pe32)
    } finally {
        DllCall("kernel32.dll\CloseHandle", "ptr", hSnap)
    }
    return procs
}

HasVal(arr, v) {
    for x in arr
        if x = v
            return true
    return false
}

switch command {
    case "preflight":
        ; Command-line match works across desktops (PEB), so a leftover instance
        ; from an aborted hidden-desktop run is caught even though no window of
        ; it exists on the caller's desktop. Window match covers legacy cases.
        ; A stale WebView2 browser process ALONE (our marker, no Main.ahk
        ; parent) does not block the run - the next run uses its own
        ; user-data folder, so only a real app-script instance conflicts
        ; (#SingleInstance).
        pids := AppScriptPids(false)
        running := pids.Length > 0 || WinExist("Main.ahk ahk_class AutoHotkey") || WinExist("ChatWindow.ahk ahk_class AutoHotkey")
        Write(Map("running", running ? 1 : 0, "pids", Join(",", pids)))

    case "app-pids":
        pids := AppScriptPids()
        Write(Map("count", pids.Length, "pids", Join(",", pids)))

    case "kill-app":
        pids := AppScriptPids()
        closed := 0
        for pid in pids
            closed += ProcessClose(pid) ? 1 : 0
        Write(Map("closed", closed, "pids", Join(",", pids)))

    case "kill-chat":
        hwnd := ChatHwnd()
        if hwnd
            WinClose("ahk_id " hwnd)
        Write(Map("closed", hwnd ? 1 : 0))

    case "chat-info":
        hwnd := ChatHwnd()
        title := hwnd ? WinGetTitle("ahk_id " hwnd) : ""
        chatWin := hwnd ? 1 : 0
        x := "", y := "", w := "", h := ""
        childClass := ""
        if hwnd {
            WinGetPos(&x, &y, &w, &h, "ahk_id " hwnd)
            child := DllCall("user32.dll\GetWindow", "ptr", hwnd, "uint", 5)  ; GW_CHILD
            if child {
                buf := Buffer(256)
                DllCall("user32.dll\GetClassName", "ptr", child, "ptr", buf, "int", 256)
                childClass := StrGet(buf)
            }
        }
        Write(Map("hwnd", hwnd ? hwnd : 0, "title", title, "chatWinExist", chatWin, "x", x, "y", y, "w", w, "h", h, "childClass", childClass))

    case "active-window":
        a := WinActive("A")
        t := a ? WinGetTitle("ahk_id " a) : ""
        Write(Map("active", a ? a : 0, "title", t))

    case "list-windows":
        parts := []
        for h in WinGetList("ahk_class AutoHotkey") {
            t := WinGetTitle("ahk_id " h)
            pid := WinGetPID("ahk_id " h)
            if !IsCurrentWorkerProcess(pid)
                continue
            parts.Push("script: " SubStr(t, 1, 50) " pid=" pid)
            ; All top-level windows of that process (any class)
            for w in WinGetList("ahk_pid " pid) {
                wt := WinGetTitle("ahk_id " w)
                wc := WinGetClass("ahk_id " w)
                parts.Push("   win: class=" wc " title=" SubStr(wt, 1, 50) " vis=" DllCall("user32.dll\IsWindowVisible", "ptr", w))
            }
        }
        Write(Map("count", parts.Length, "windows", Join("; ", parts)))

    case "show-chat":
        ; Show the ChatWindow OFF-SCREEN: the harness drives the app via CDP and
        ; probes, and the backtick command menu needs a visible window in this
        ; session - but the window must never appear on the user's screen or
        ; steal focus. Positioning it far off-screen keeps it invisible while
        ; staying "shown" (IsWindowVisible = true, rendered on its desktop).
        hwnd := ChatHwnd()
        if hwnd {
            ; WinMove/WinShow are normally harmless, but their shell-level
            ; implementation can activate a newly-created GUI on some Windows
            ; builds. Use the no-activate Win32 forms explicitly: the user's
            ; foreground window must remain untouched while the app is moved
            ; to its off-screen render position.
            MoveOffscreenNoActivate(hwnd)
        }
        Write(Map("shown", hwnd ? 1 : 0))

    case "resize-chat":
        ; Keep the ChatWindow off-screen but resize it, so CDP captures have a
        ; roomier viewport (wider tree canvas, bigger dashboard charts).
        w := A_Args[3] ? Integer(A_Args[3]) : 1600
        h := A_Args[4] ? Integer(A_Args[4]) : 900
        hwnd := ChatHwnd()
        if hwnd {
            MoveOffscreenNoActivate(hwnd, w, h)
        }
        Write(Map("resized", hwnd ? 1 : 0))

    case "icon-check":
        iconPath := A_Args[3]
        hwnd := ChatHwnd()
        hBig := 0
        hSmall := 0
        hCustom := 0
        if iconPath && FileExist(iconPath) {
            try hCustom := LoadPicture(iconPath, "Icon1 w32 h32", &imgT)
        }
        customFp := hCustom ? RenderFingerprint(hCustom, &crcCustom) : ""
        if hwnd {
            ; The window icon is applied asynchronously at startup, so sample
            ; until the icons are stable (two consecutive identical reads) or
            ; the timeout hits — a single early sample caused a flaky "custom
            ; icon NOT applied" result. NOTE: read the SendMessage return value
            ; directly — referencing the built-in ErrorLevel hangs
            ; AutoHotkey64.exe at load in this environment. The Control
        ; parameter must be OMITTED ("" means "target control" and fails
        ; with 'Target control not found' on window-level messages).
            lastBig := 0, lastSmall := 0
            deadline := A_TickCount + 5000
            loop {
                hBig := SendMessage(0x7F, 0, 0, , "ahk_id " hwnd)    ; WM_GETICON ICON_BIG
                hSmall := SendMessage(0x7F, 1, 0, , "ahk_id " hwnd)  ; WM_GETICON ICON_SMALL
                fpBig := hBig ? RenderFingerprint(hBig, &crcBig) : ""
                fpSmall := hSmall ? RenderFingerprint(hSmall, &crcSmall) : ""
                ; Drawing a window icon handle cross-process is not always
                ; reliable, and the icon can be applied asynchronously, so
                ; re-verify the pixel match on every sample rather than
                ; trusting a single draw of one handle.
                if (fpBig && customFp && fpBig = customFp) || (fpSmall && customFp && fpSmall = customFp)
                    break
                if (hBig != 0 || hSmall != 0) && hBig = lastBig && hSmall = lastSmall
                    break
                lastBig := hBig, lastSmall := hSmall
                if A_TickCount > deadline
                    break
                Sleep 200
            }
        }
        ; The OLD buggy path (ChatWindow.ahk prefixed every icon path with
        ; A_ScriptDir "\..\"); it must still fail to load — the fixed code
        ; resolves absolute paths without that prefix.
        scriptDir := A_ScriptDir "\..\..\chat"
        hMangled := 0
        try hMangled := LoadPicture(scriptDir "\..\" iconPath, "Icon1 w32 h32", &imgT2)
        Write(Map(
            "hwnd", hwnd ? hwnd : 0,
            "hBig", hBig, "hSmall", hSmall,
            "hCustom", hCustom,
            "hMangled", hMangled,
            "crcBig", IsSet(crcBig) ? crcBig : "",
            "crcSmall", IsSet(crcSmall) ? crcSmall : "",
            "crcCustom", IsSet(crcCustom) ? crcCustom : "",
            ; The comparison is meaningless when the expected icon could not be
            ; rendered (transient GDI failure in this process) — report it so
            ; the runner can retry with a fresh process instead of treating it
            ; as "icon not applied".
            "renderFailed", (customFp = "" || ((hBig || hSmall) && fpBig = "" && fpSmall = "")) ? 1 : 0,
            ; Handle equality is unreliable (same file loaded twice gives two
            ; handles), so compare rendered pixels instead.
            "customApplied", (fpBig && fpBig = customFp) || (fpSmall && fpSmall = customFp) ? 1 : 0,
            "mangledLoaded", hMangled ? 1 : 0
        ))

    case "menu-open":
        ; MANUAL DEBUGGING ONLY — injects a real backtick into the interactive
        ; desktop. No scenario uses this anymore (it can leak a keystroke into
        ; the user's typing when the injection misses the app's hotkey).
        Send("``")
        Sleep 400
        open := WinExist("ahk_class #32768") ? 1 : 0
        if open
            Send("{Esc}")
        Write(Map("open", open))

    case "load-thread":
        ; Mirror CustomMessages.notifyLoadThread (Main -> ChatWindow): write the
        ; thread id to the target ChatWindow's private temp file, then post WM_LOAD_THREAD (0x502) to
        ; the chat window. Used by the chat-command race scenarios to reproduce
        ; the command path (processInitialRequest -> openChatWindow) without
        ; touching the real menu.
        hwnd := ChatHwnd()
        threadId := A_Args.Length > 2 ? A_Args[3] : ""
        ok := 0
        if hwnd && threadId {
            ; OnLoadThread reveals the ChatWindow with the no-activate AHK
            ; option. Put it off-screen BEFORE that asynchronous message is
            ; handled as well, so there is no on-screen/foreground flash.
            MoveOffscreenNoActivate(hwnd)
            FileOpen(A_Temp "\chat_load_thread_" hwnd ".txt", "w", "UTF-8-RAW").Write(threadId)
            ; wParam=2 is the private headless form of WM_LOAD_THREAD: the
            ; real handler keeps the render window off-screen and inactive.
            PostMessage(0x502, 2, 0, , "ahk_id " hwnd)
            ok := 1
        }
        Write(Map("hwnd", hwnd ? hwnd : 0, "threadId", threadId, "posted", ok))

    case "trigger-llm":
        ; Mirror CustomMessages.notifyTriggerLLM (Main -> ChatWindow): post
        ; WM_TRIGGER_LLM (0x504) with wParam = the command's stream flag
        ; (1 = stream, 0 = single-shot JSON). Used by the chat-command race
        ; scenarios to reproduce the command trigger exactly.
        hwnd := ChatHwnd()
        streamFlag := A_Args.Length > 2 && A_Args[3] = "1" ? 1 : 0
        ok := 0
        if hwnd {
            PostMessage(0x504, streamFlag, 0, , "ahk_id " hwnd)
            ok := 1
        }
        Write(Map("hwnd", hwnd ? hwnd : 0, "stream", streamFlag, "posted", ok))

    case "close-test":
        ; MANUAL DEBUGGING ONLY — activates the chat window and sends keys.
        hwnd := ChatHwnd()
        keys := A_Args.Length > 3 ? A_Args[3] : "^w"
        if hwnd {
            WinShow("ahk_id " hwnd)
            WinActivate("ahk_id " hwnd)
            Sleep 200
            Send(keys)
            Sleep 400
        }
        visible := hwnd ? DllCall("user32.dll\IsWindowVisible", "ptr", hwnd) : -1
        Write(Map("hwnd", hwnd ? hwnd : 0, "keys", keys, "visibleAfterKeys", visible))

    case "suspend-banner":
        ; MANUAL DEBUGGING ONLY — sends the CapsLock+backtick combo.
        ; Send the suspend hotkey combo (CapsLock & `)
        Send("{CapsLock Down}``{CapsLock Up}")
        Sleep 600
        text := ""
        found := 0
        ; The banner GUI has class AutoHotkeyGUI (like all AHK v2 GUIs).
        for h in WinGetList("ahk_class AutoHotkeyGUI") {
            t := WinGetText("ahk_id " h)
            if t && t != "" {
                text := t
                found := h
                break
            }
        }
        ; Toggle back off
        Send("{CapsLock Down}``{CapsLock Up}")
        Write(Map("found", found ? 1 : 0, "bannerText", text))

    case "input-window-pos":
        title := A_Args[3]
        hwnd := WinExist(title " ahk_class AutoHotkeyGUI")
        x := "", y := "", w := "", h := ""
        if hwnd {
            WinGetPos(&x, &y, &w, &h, "ahk_id " hwnd)
        }
        Write(Map("hwnd", hwnd ? hwnd : 0, "x", x, "y", y, "w", w, "h", h))

    case "input-window-edit-color":
        ; Sample a pixel inside the input window's Edit field (rendered, not
        ; style-derived) so a regression like "dark window + light font renders
        ; invisible text on the Edit's default white background" is caught.
        title := A_Args[3]
        hwnd := WinExist(title " ahk_class AutoHotkeyGUI")
        if !hwnd {
            Write(Map("hwnd", 0, "color", ""))
            return
        }
        ; The Edit is the first control; sample its center via PrintWindow.
        RECT := Buffer(16)
        DllCall("user32.dll\GetClientRect", "ptr", hwnd, "ptr", RECT)
        cw := NumGet(RECT, 8, "int"), ch := NumGet(RECT, 12, "int")
        hdcScreen := DllCall("user32.dll\GetDC", "ptr", 0, "ptr")
        hdcMem := DllCall("gdi32.dll\CreateCompatibleDC", "ptr", hdcScreen, "ptr")
        hbm := DllCall("gdi32.dll\CreateCompatibleBitmap", "ptr", hdcScreen, "int", cw, "int", ch, "ptr")
        DllCall("gdi32.dll\SelectObject", "ptr", hdcMem, "ptr", hbm)
        DllCall("user32.dll\PrintWindow", "ptr", hwnd, "ptr", hdcMem, "uint", 2)
        ; Edit starts at x20 y+5 and spans most of the window width.
        sx := 20 + (cw - 40) // 2
        sy := 5 + (ch - 40) // 2
        color := DllCall("gdi32.dll\GetPixel", "ptr", hdcMem, "int", sx, "int", sy, "uint")
        DllCall("gdi32.dll\DeleteObject", "ptr", hbm)
        DllCall("gdi32.dll\DeleteDC", "ptr", hdcMem)
        DllCall("user32.dll\ReleaseDC", "ptr", 0, "ptr", hdcScreen)
        Write(Map("hwnd", hwnd, "color", Format("0x{:06X}", color & 0xFFFFFF), "sample", sx "," sy))

    case "send-menu-usage":
        ; MANUAL DEBUGGING ONLY — sends the backtick + menu keys.
        ; Open backtick menu, navigate Quick Access (q) -> 7 (Usage Dashboard)
        Send("``")
        Sleep 350
        menuOpened := WinExist("ahk_class #32768") ? 1 : 0
        if menuOpened {
            Send("q")
            Sleep 300
            Send("7")
            Sleep 600
            Send("{Esc}")
        }
        Write(Map("menuOpened", menuOpened))

    case "open-input":
        ; MANUAL DEBUGGING ONLY — sends the backtick + accelerator key.
        ; Open the backtick menu and press the given accelerator key. The key is
        ; ONLY sent if the menu actually opened - otherwise it would leak into
        ; whatever the user is typing on the interactive desktop (the harness
        ; must never inject stray keystrokes into the user's session).
        Send("``")
        Sleep 350
        menuOpened := WinExist("ahk_class #32768") ? 1 : 0
        if menuOpened {
            Send(A_Args[3])
            Sleep 500
        }
        Write(Map("done", 1, "menuOpened", menuOpened))

    case "close-input":
        Send("{Esc}")
        Sleep 200
        Write(Map("done", 1))

    default:
        Write(Map("error", "unknown command: " command))
}

ExitApp(0)
