; ======================================================
; run_tests.ahk — Test runner entry point
;
; Usage: AutoHotkey64.exe ai-automation/tests/run_tests.ahk
; ======================================================

#Requires AutoHotkey v2.0.18+
#ErrorStdOut
#SingleInstance Off
#NoTrayIcon

; -----------------------------------------------------------
; Output file for test results
; -----------------------------------------------------------
global TEST_LOG := A_Temp "\test_results.txt"
try FileDelete(TEST_LOG)

; Write to log file. Batch file reads this after AHK completes.
Log(msg) {
    global TEST_LOG
    FileAppend(msg, TEST_LOG)
}

; -----------------------------------------------------------
; Global error handler
; -----------------------------------------------------------
OnError(TestErrorHandler, -1)
TestErrorHandler(err, mode) {
    global TEST_LOG
    try Log("[RUNTIME ERROR] " err.Message "`n")
    if err.HasProp("Stack") && err.Stack
        try Log(err.Stack "`n")
    ; ExitApp is overridden below (and swallowed) so production code cannot
    ; kill the runner mid-run, but that also turns any runtime error into an
    ; invisible orphaned AutoHotkey64.exe that never exits. Terminate for
    ; real instead so a failed run can never hang an automated command.
    DllCall("ExitProcess", "UInt", 1)
}

; -----------------------------------------------------------
; Override MsgBox/ExitApp BEFORE Config loads UserConfig
; -----------------------------------------------------------
MsgBox(text, title := "", options := "") {
    global TEST_LOG
    Log("[MSGBOX] " title ": " text "`n")
    return "OK"
}
ExitApp(ExitCode := 0) {
    global TEST_LOG
    Log("[EXITAPP suppressed in test mode]`n")
}

global testMode := true

; -----------------------------------------------------------
; Mock globals needed by production modules loaded via Config
; (Must be set BEFORE Config.ahk so they override vendor libs)
; -----------------------------------------------------------
global responseWindow := {PostWebMessageAsJSON: (*) => ""}

; -----------------------------------------------------------
; Load production config
; -----------------------------------------------------------
#Include ..\lib\Config.ahk

; -----------------------------------------------------------
; Override UserConfig globals with test values (after Config)
; -----------------------------------------------------------
#Include test_config.ahk

; -----------------------------------------------------------
; Include ChatWindow-specific modules not in Config.ahk
; (ChatUtils, StreamHandler, and callbacks are loaded by ChatWindow.ahk
; but we need them directly in test mode)
; -----------------------------------------------------------
#Include ..\app\TextCapture.ahk
#Include ..\app\menu\CommandMenu.ahk
#Include ..\chat\ChatUtils.ahk
#Include ..\chat\ChatSettings.ahk
#Include ..\chat\streaming\StreamHandler.ahk
#Include ..\chat\tools\SearchToolExecutor.ahk
#Include ..\chat\callbacks\Message.ahk
#Include ..\chat\ChatRequestBuilder.ahk
; Settings-related modules that live in Main.ahk / ChatWindow.ahk and are
; otherwise never loaded by the test harness.
#Include ..\chat\ThreadTitleGen.ahk
#Include ..\app\HotkeyRegistrar.ahk
#Include ..\app\SuspendBanner.ahk
#Include ..\app\TrayIcon.ahk
#Include ..\app\TrayMenu.ahk
#Include ..\chat\ChatHotkeys.ahk
#Include ..\chat\ChatIconResolver.ahk
#Include ..\chat\ChatWindowIcon.ahk
#Include ..\chat\callbacks\Dispatch.ahk

; -----------------------------------------------------------
; Test registration
; -----------------------------------------------------------
global __TestClasses := []

RegisterTestClass(className) {
    global __TestClasses
    __TestClasses.Push(className)
}

#Include unit\AttachmentUtils.test.ahk
#Include unit\ChatDB.test.ahk
#Include unit\ThreadLockRepo.test.ahk
#Include unit\AttachmentRepo.test.ahk
#Include unit\ImageUtils.test.ahk
#Include unit\ScreenRegionSelector.test.ahk
#Include unit\SQLiteEscape.test.ahk
#Include unit\TextCapture.test.ahk
#Include unit\LLMRequestBuilder.test.ahk
#Include unit\ChatUtils.test.ahk
#Include unit\StreamHandler.test.ahk
#Include unit\StreamError.test.ahk
#Include unit\ChatRequestBuilder.test.ahk
#Include unit\SearchTools.test.ahk
#Include unit\ResponsesParser.test.ahk
#Include unit\ResponsesStreamParser.test.ahk
#Include unit\TavilySearch.test.ahk
#Include unit\DeepSeekSearch.test.ahk
#Include unit\SSEParser.test.ahk
#Include unit\SearchToolExecutor.test.ahk
#Include unit\CustomMessages.test.ahk
#Include unit\InlineRequestRunner.test.ahk
#Include unit\CodexCliTransport.test.ahk
#Include unit\ModelParser.test.ahk
#Include unit\ModelPricingParser.test.ahk
#Include unit\ChatSettings.test.ahk
#Include unit\RequestProcessor.test.ahk
#Include unit\UserConfig.test.ahk
#Include unit\CostCalculator.test.ahk
#Include unit\SettingsHandler.test.ahk
#Include unit\BackupManager.test.ahk
#Include unit\DefaultSettingsIntegrity.test.ahk
#Include unit\UsageTracking.test.ahk
#Include unit\UsageDashboard.test.ahk
#Include integration\ChatFlow.test.ahk
#Include integration\BranchFlow.test.ahk
#Include integration\UsageFlow.test.ahk
; Settings-branch modules that are only included by Main.ahk / ChatWindow.ahk.
; Registered last so their global mocks and settings application cannot
; affect the rest of the suite.
#Include unit\HotkeyRegistrar.test.ahk
#Include unit\SuspendBanner.test.ahk
#Include unit\TrayIcon.test.ahk
#Include unit\TrayMenu.test.ahk
#Include unit\ChatHotkeys.test.ahk
#Include unit\ChatIconResolver.test.ahk
#Include unit\ChatWindowIcon.test.ahk
#Include unit\InputWindow.test.ahk
#Include unit\ThreadTitleGen.test.ahk
#Include unit\ChatDispatch.test.ahk
#Include unit\MainWindowHandle.test.ahk
#Include unit\CommandThinkingMap.test.ahk

; -----------------------------------------------------------
; Test runner
; -----------------------------------------------------------

totalPassed := 0
totalFailed := 0
failedDetails := []

RunAllTests(*) {
    global __TestClasses, totalPassed, totalFailed, failedDetails
    for i, className in __TestClasses {
        if SubStr(className, 1, 1) = "_"
            continue
        RunTestClass(className)
    }
    total := totalPassed + totalFailed
    Log("`n---`n")
    Log(total " tests run | " totalPassed " passed | " totalFailed " failed`n")
    if failedDetails.Length > 0 {
        Log("`nFAILURES:`n")
        for detail in failedDetails
            Log("  " detail "`n")
    }
    ; Write result marker for the batch file, then terminate for real.
    ; The ExitApp override above swallows ExitApp calls so production code
    ; can't kill the runner mid-run, but that also leaves an orphan
    ; AutoHotkey64.exe per test run. ExitProcess avoids that (and makes the
    ; exit code propagate for direct invocations; the batch uses the marker).
    Log("`nRESULT: " (totalFailed > 0 ? "FAIL" : "PASS") "`n")
    DllCall("ExitProcess", "UInt", totalFailed > 0 ? 1 : 0)
}

RunTestClass(className) {
    global __TestClasses, totalPassed, totalFailed, failedDetails, TEST_LOG
    try {
        Log("[RUN] " className " (class init)`n")
        obj := %className%()
        proto := %className%.Prototype
        for methodName in proto.OwnProps() {
            if SubStr(methodName, 1, 1) = "_"
                continue
            try {
                Log("[RUN] " className "." methodName "`n")
                obj.%methodName%()
                Log("[PASS] " className "." methodName "`n")
                totalPassed++
            } catch Error as err {
                Log("[FAIL] " className "." methodName " — " err.Message "`n")
                if err.HasProp("Stack") && err.Stack
                    Log("    stack: " err.Stack "`n")
                totalFailed++
                failedDetails.Push(className "." methodName ": " err.Message)
            }
        }
    } catch Error as err {
        Log("[FAIL] " className " (class init) — " err.Message "`n")
        totalFailed++
    }
}

if MsgBox("test") != "OK" {
    Log("[CRITICAL] MsgBox override not active! Tests aborted.`n")
    DllCall("ExitProcess", "UInt", 1)
}

RunAllTests()

