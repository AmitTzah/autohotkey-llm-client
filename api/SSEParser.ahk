; ----------------------------------------------------
; SSEParser — Server-Sent Events streaming parser
; Parses SSE data: lines from the stream output file
; Returns an object {type, content, model?} where type is
; "content", "reasoning", "finish", or "done"
;
; NOTE: jsongo.Parse() returns Maps. Use .Has() not .HasOwnProp()
; for jsongo-parsed objects. Internal result object uses .HasOwnProp().
; ----------------------------------------------------

class SSEParser {
    ; Parses a single "data: " line from the SSE stream.
    ; Returns an object with {type, content, model?, usage?}
    static ParseLine(line) {
        if !InStr(line, "data: ")
            return { type: "ignore" }

        data := SubStr(line, InStr(line, "data: ") + 6)

        if data = "[DONE]"
            return { type: "done" }

        try {
            parsed := jsongo.Parse(data)
        } catch {
            return { type: "ignore" }
        }

        ; A syntactically valid JSON scalar is not an SSE event object. Never
        ; call Map methods on strings/numbers/null-like values extracted from
        ; arbitrary provider text containing the literal `data: ` marker.
        if Type(parsed) != "Map"
            return { type: "ignore" }

        ; OpenAI-style SSE error events (`data: {"error": ...}`)
        ; is valid JSON WITHOUT a "choices" key - bracket-indexing a Map for a
        ; missing key THROWS in AHK v2 and crashed the poll. Surface the
        ; provider message as an "error" chunk so the stream fails cleanly
        ; (error surfaced, partial content kept) instead of dying with an
        ; internal parser error.
        if parsed.Has("error") && IsObject(parsed["error"]) && parsed["error"].Has("message") && parsed["error"]["message"] != "" {
            return { type: "error", message: parsed["error"]["message"] }
        }

        if !parsed.Has("choices") {
            return SSEParser._handleUsageOnlyChunk(parsed)
        }

        choices := parsed["choices"]
        ; Compatible providers may emit choices:null on auxiliary events.
        if !IsObject(choices) || Type(choices) != "Array" || choices.Length = 0 {
            return SSEParser._handleUsageOnlyChunk(parsed)
        }

        ; An SSE event can carry more than one choice (for example, a re-joined
        ; split `data:` line, or a provider batching deltas) - accumulate the
        ; content from EVERY choice instead of reading only the first, or the
        ; later choices' payload is silently dropped.
        reasoningAcc := ""
        contentAcc := ""
        toolCallAcc := []
        for choice in choices {
            if !IsObject(choice)
                continue
            delta := choice.Has("delta") ? choice["delta"] : choice
            ; JSON null/scalar deltas are not parseable message objects.
            if !IsObject(delta)
                continue
            ; Tool calls (web_search): deltas arrive as partial fragments
            ; ({index, id, function:{name, arguments}}) that the stream handler
            ; merges by index into completed calls.
            if delta.Has("tool_calls") && IsObject(delta["tool_calls"]) && Type(delta["tool_calls"]) = "Array" {
                for tcf in delta["tool_calls"] {
                    if IsObject(tcf)
                        toolCallAcc.Push(tcf)
                }
            }
            part := SSEParser._parseDeltaContent(delta)
            if !part.HasOwnProp("type")
                continue
            if part.type = "reasoning"
                reasoningAcc .= part.content
            else if part.type = "content"
                contentAcc .= part.content
        }
        ; Nullable/scalar choices are ignored above, but a compatible provider
        ; may place the valid finish reason on a later choice. Read it only
        ; from an actual choice object so null entries cannot crash the poll.
        finish := ""
        for choice in choices {
            if IsObject(choice) && choice.Has("finish_reason") {
                finish := choice["finish_reason"]
                break
            }
        }
        ; A tool-call event (the model asked to search) - handled before the
        ; plain content branch so the stream handler can run the tool loop.
        if toolCallAcc.Length {
            result := { type: "tool_call", toolCalls: toolCallAcc }
            if finish != "" && finish != "null" {
                result.reason := finish
                if parsed.Has("model") && parsed["model"] != ""
                    result.model := parsed["model"]
                if parsed.Has("usage") && IsObject(parsed["usage"])
                    result.usage := SSEParser._buildUsageObject(parsed["usage"])
            }
            return result
        }
        result := {}
        if reasoningAcc != "" {
            result.type := "reasoning"
            result.content := reasoningAcc
        } else if contentAcc != "" {
            result.type := "content"
            result.content := contentAcc
        }

        ; Check for finish reason (stream end) — may coexist with content
        if finish != "" && finish != "null" {
            if !result.HasOwnProp("type")
                result.type := "finish"
            result.reason := finish
            if parsed.Has("model") && parsed["model"] != ""
                result.model := parsed["model"]
            if parsed.Has("usage") && IsObject(parsed["usage"])
                result.usage := SSEParser._buildUsageObject(parsed["usage"])
            return result
        }

        if result.HasOwnProp("type")
            return result
        return { type: "ignore" }
    }

    ; Handle the usage-only chunk (stream_options: include_usage sends usage
    ; in a separate chunk with empty choices after finish_reason).
    static _handleUsageOnlyChunk(parsed) {
        if parsed.Has("usage") && IsObject(parsed["usage"]) {
            result := { type: "finish" }
            if parsed.Has("model") && parsed["model"] != ""
                result.model := parsed["model"]
            result.usage := SSEParser._buildUsageObject(parsed["usage"])
            return result
        }
        return { type: "ignore" }
    }

    ; Parse delta content — detect reasoning vs visible content.
    ; Returns {type?, content?} — may be empty if no recognized content.
    ; Tries all known reasoning field names (pi pattern: first non-empty wins).
    static _parseDeltaContent(delta) {
        result := {}

        ; reasoning fields — tried in order, first non-empty wins
        ; Candidate thinking fields across providers: reasoning_content (DeepSeek),
        ; reasoning (OpenAI-compatible), reasoning_text (Google).
        reasoningFields := ["reasoning_content", "reasoning", "reasoning_text"]
        for field in reasoningFields {
            if delta.Has(field) && delta[field] != "" {
                result.type := "reasoning"
                result.content := delta[field]
                return result
            }
        }

        ; content — may include Gemini <thought> tags
        if delta.Has("content") && delta["content"] != "" {
            content := delta["content"]

            ; Gemini embeds thinking as <thought>...</thought> with extra_content flag
            isGeminiThought := delta.Has("extra_content")
                && delta["extra_content"].Has("google")
                && delta["extra_content"]["google"].Has("thought")
                && delta["extra_content"]["google"]["thought"]

            if isGeminiThought {
                content := StrReplace(content, "<thought>", "")
                content := StrReplace(content, "</thought>", "")
                result.type := "reasoning"
                result.content := content
                return result
            }

            ; Strip lingering </thought> closing tag
            content := StrReplace(content, "</thought>", "")

            if content != "" {
                result.type := "content"
                result.content := content
            }
        }

        return result
    }

    ; Build a standardized usage object from a jsongo-parsed usage Map.
    static _buildUsageObject(usageObj) {
        cachedTokens := 0
        if usageObj.Has("prompt_cache_hit_tokens") {
            cachedTokens := usageObj["prompt_cache_hit_tokens"]
        } else if usageObj.Has("prompt_tokens_details") {
            details := usageObj["prompt_tokens_details"]
            if IsObject(details) && details.Has("cached_tokens")
                cachedTokens := details["cached_tokens"]
        }
        return {
            promptTokens:     usageObj.Has("prompt_tokens") ? usageObj["prompt_tokens"] : 0,
            completionTokens: _computeCompletion(usageObj),
            totalTokens:      usageObj.Has("total_tokens") ? usageObj["total_tokens"] : 0,
            cachedTokens:     cachedTokens,
            thinkingTokens:   _extractThinkingTokens(usageObj)
        }
    }
}

; Google: completion_tokens excludes thinking tokens.
; Use total - prompt for the real output count (visible + thinking).
_computeCompletion(usageObj) {
    prompt := usageObj.Has("prompt_tokens") ? usageObj["prompt_tokens"] : 0
    completion := usageObj.Has("completion_tokens") ? usageObj["completion_tokens"] : 0
    total := usageObj.Has("total_tokens") ? usageObj["total_tokens"] : 0
    if total > prompt + completion
        return total - prompt
    return completion
}

; Extract reasoning/thinking tokens from the usage object.
; Checks completion_tokens_details.reasoning_tokens (OpenAI/DeepSeek format).
; Falls back to total - prompt - completion for Gemini (doesn't report thinking separately).
_extractThinkingTokens(usageObj) {
    if usageObj.Has("completion_tokens_details") {
        details := usageObj["completion_tokens_details"]
        if IsObject(details) && details.Has("reasoning_tokens")
            return details["reasoning_tokens"]
    }
    ; Gemini fallback: thinking = total_tokens - prompt_tokens - completion_tokens
    prompt := usageObj.Has("prompt_tokens") ? usageObj["prompt_tokens"] : 0
    completion := usageObj.Has("completion_tokens") ? usageObj["completion_tokens"] : 0
    total := usageObj.Has("total_tokens") ? usageObj["total_tokens"] : 0
    if total > prompt + completion
        return total - prompt - completion
    return 0
}
