#Requires AutoHotkey v2.0.18+
#ErrorStdOut
#SingleInstance Off
#NoTrayIcon

#Include ..\..\lib\jsongo.v2.ahk
#Include ..\..\api\CodexCliRuntime.ahk
#Include ..\..\api\CodexCliTransport.ahk

debugLog(*) {
}

if A_Args.Length < 2
    ExitApp(2)

resultFile := A_Args[1]
requestFile := A_Args[2]
SplitPath(resultFile, , &testDir)
responseFile := testDir "\response.json"
errorFile := testDir "\error.txt"

try {
    ; The explicit Settings-style check should populate the ready cache. The
    ; real transport call below must reuse it and therefore add no extra probe
    ; processes before its one codex exec model invocation.
    preflight := CodexCliTransport.CheckStatus()
    providerInfo := {
        providerKey: "codex",
        modelName: "gpt-5.6-luna",
        transport: "codex-cli",
        authMode: "chatgpt",
        billingMode: "chatgpt-subscription",
        apiKey: "",
        endpoint: "",
        fimEndpoint: ""
    }
    progress := []
    progressMarker := EnvGet("FAKE_CODEX_PROGRESS_MARKER")
    onProgress := (payload) => _CaptureProgress(payload, progress, progressMarker)
    transportResult := CodexCliTransport.ExecuteRequest(
        providerInfo,
        requestFile,
        responseFile,
        errorFile,
        "",
        false,
        "high",
        onProgress
    )
    usage := transportResult.HasOwnProp("usage") ? transportResult.usage
        : { promptTokens: 0, cachedTokens: 0 }
    payload := Map(
        "success", transportResult.success ? 1 : 0,
        "exitCode", transportResult.HasOwnProp("exitCode") ? transportResult.exitCode : 0,
        "answer", transportResult.HasOwnProp("response") ? transportResult.response : "",
        "promptTokens", usage.promptTokens,
        "cachedTokens", usage.cachedTokens,
        "thoughtSummary", transportResult.HasOwnProp("thoughtSummary") ? transportResult.thoughtSummary : "",
        "webSearchCalls", transportResult.HasOwnProp("webSearchCalls") ? transportResult.webSearchCalls : 0,
        "progress", progress,
        "error", FileExist(errorFile) ? FileRead(errorFile, "UTF-8") : "",
        "preflightInstalled", preflight.installed ? 1 : 0,
        "preflightSupported", preflight.supported ? 1 : 0,
        "preflightAuthenticated", preflight.authenticated ? 1 : 0,
        "preflightVersion", preflight.version
    )
    FileOpen(resultFile, "w", "UTF-8-RAW").Write(jsongo.Stringify(payload))
} catch Error as e {
    FileOpen(resultFile, "w", "UTF-8-RAW").Write(jsongo.Stringify(Map("success", 0, "exitCode", -999, "error", e.Message)))
}
ExitApp(0)

_CaptureProgress(payload, progress, marker) {
    item := Map(
        "content", payload.HasOwnProp("content") ? payload.content : "",
        "summary", payload.HasOwnProp("summary") ? payload.summary : "",
        "replace", payload.HasOwnProp("replace") && payload.replace ? 1 : 0,
        "kind", payload.HasOwnProp("kind") ? payload.kind : "",
        "searchCount", payload.HasOwnProp("searchCount") ? payload.searchCount : 0
    )
    progress.Push(item)
    if marker != "" && !FileExist(marker)
        FileOpen(marker, "w", "UTF-8-RAW").Write("progress")
}
