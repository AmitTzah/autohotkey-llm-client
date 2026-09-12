; ======================================================
; SearchTools.ahk — Web-search tool definition + shared helpers
;
; AhkLLM's only tool is web search. The per-thread right-rail toggle
; (requestParams.webSearch, default off) decides whether the model sees the
; tool at all. When it calls web_search:
;   - DeepSeek models search natively via DeepSeek's Responses API
;     (POST /responses with the server-side web_search tool).
;   - Every other provider falls back to Tavily (plain REST, no model
;     function-calling requirements beyond the standard tools array).
; ======================================================

class SearchTools {

    static TOOL_NAME := "web_search"
    ; Keep a finite runaway guard, but allow legitimately deep agent searches.
    static MAX_TOOL_ITERATIONS := 60

    ; OpenAI-compatible function-tool definition sent to every provider when
    ; the per-thread Web Search toggle is on.
    static Definition() {
        return {
            type: "function",
            function: {
                name: SearchTools.TOOL_NAME,
                description: "Search the web for current, factual, or URL-specific information. Returns an answer with source links.",
                parameters: {
                    type: "object",
                    properties: { query: { type: "string", description: "The search query." } },
                    required: ["query"]
                    ; NOTE: do NOT add additionalProperties here. AHK has no
                    ; boolean type — `false` IS 0, and jsongo serializes it as
                    ; "additionalProperties":0, which DeepSeek's JSON-Schema
                    ; validator rejects ("0 is not of types boolean, object").
                    ; The field is optional in JSON Schema, so omitting it is
                    ; both valid and provider-safe.
                }
            }
        }
    }

    ; Is the per-thread Web Search toggle on?
    static Enabled() {
        global requestParams
        return requestParams.Has("webSearch") && requestParams["webSearch"]
    }

    ; DeepSeek models search natively (their /responses API); everything else
    ; uses Tavily as the fallback backend.
    static IsNativeDeepSeek(providerKey) {
        return providerKey = "deepseek"
    }

    ; Tavily key: explicit setting wins, environment variable is the fallback
    ; (mirrors ProviderResolver._getApiKey for model providers).
    static TavilyKey() {
        global tavilyApiKey
        if IsSet(tavilyApiKey) && tavilyApiKey != ""
            return tavilyApiKey
        return EnvGet("TAVILY_API_KEY")
    }

    static TavilyEndpoint() {
        global tavilyEndpoint
        return IsSet(tavilyEndpoint) && tavilyEndpoint != "" ? tavilyEndpoint : "https://api.tavily.com/search"
    }

    ; Derive a Responses-API endpoint from a chat-completions endpoint:
    ;   https://api.deepseek.com/chat/completions  -> https://api.deepseek.com/responses
    ;   http://127.0.0.1:PORT/v1/chat/completions  -> http://127.0.0.1:PORT/v1/responses
    static ResponsesEndpoint(chatEndpoint) {
        marker := "/chat/completions"
        pos := InStr(chatEndpoint, marker)
        if pos {
            return SubStr(chatEndpoint, 1, pos - 1) . "/responses"
        }
        v1Pos := InStr(chatEndpoint, "/v1")
        if v1Pos {
            return SubStr(chatEndpoint, 1, v1Pos + 2) . "/responses"
        }
        return RTrim(chatEndpoint, "/") . "/responses"
    }

    ; Human-readable search context persisted as a user-role message so
    ; follow-up turns keep the results in API history (no schema change:
    ; it is a plain text message).
    static BuildContextText(query, resultText) {
        return "[Web search: " query "]`n`n" resultText
    }

    ; Search backends run synchronously inside the tool loop, so the process
    ; handle and cancellation flag belong to that loop's state object rather
    ; than to the shared requestParams window.
    static RegisterProcess(loopState, pid) {
        if !IsObject(loopState)
            return
        loopState.searchPid := pid
    }

    static IsCancelled(loopState) {
        return IsObject(loopState) && loopState.HasOwnProp("cancelled") && loopState.cancelled
    }

    ; Set the flag before taskkill: killing cmd/cURL can yield to the search
    ; loop, and the loop must never turn a cancelled search into a follow-up.
    static CancelProcess(loopState) {
        if !IsObject(loopState)
            return false
        loopState.cancelled := true
        pid := loopState.HasOwnProp("searchPid") ? loopState.searchPid : 0
        if pid && ProcessExist(pid)
            RunWait('taskkill /PID ' pid ' /T /F', , "Hide")
        loopState.searchPid := 0
        return true
    }

    static ClearProcess(loopState, pid := 0) {
        if !IsObject(loopState)
            return
        if pid = 0 || !loopState.HasOwnProp("searchPid") || loopState.searchPid = pid
            loopState.searchPid := 0
    }
}
