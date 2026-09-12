; ======================================================
; SSEParser.test.ahk — SSE line parsing (incl. web-search tool calls)
; ======================================================

class SSEParserTest {

    static __New() {
        RegisterTestClass("SSEParserTest")
    }

    ParseLine_ToolCallDelta_ReturnsToolCallChunk() {
        chunk := SSEParser.ParseLine('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"web_search","arguments":""}}]}}]}')
        if chunk.type != "tool_call"
            throw Error("expected tool_call chunk, got " chunk.type)
        if chunk.toolCalls.Length != 1
            throw Error("expected 1 tool call fragment")
        tc := chunk.toolCalls[1]
        if tc["id"] != "call_1"
            throw Error("id mismatch")
        if tc["function"]["name"] != "web_search"
            throw Error("name mismatch")
    }

    ParseLine_ContentChunk_StillWorks() {
        chunk := SSEParser.ParseLine('data: {"choices":[{"delta":{"content":"hi"}}]}')
        if chunk.type != "content" || chunk.content != "hi"
            throw Error("content parse regression")
    }

    ParseLine_NullToolCalls_DoesNotCrashAndKeepsContent() {
        chunk := SSEParser.ParseLine('data: {"choices":[{"delta":{"content":"hello","tool_calls":null}}]}')
        if chunk.type != "content" || chunk.content != "hello"
            throw Error("null tool_calls must preserve content")
    }

    ParseLine_NullChoices_IsIgnored() {
        chunk := SSEParser.ParseLine('data: {"choices":null}')
        if chunk.type != "ignore"
            throw Error("null choices must be ignored safely")
    }

    ParseLine_NullDelta_IsIgnored() {
        chunk := SSEParser.ParseLine('data: {"choices":[{"delta":null}]}')
        if chunk.type != "ignore"
            throw Error("null delta must be ignored safely")
    }

    ParseLine_NullDelta_WithValidContent_PreservesContent() {
        chunk := SSEParser.ParseLine('data: {"choices":[{"delta":null},{"delta":{"content":"kept"}}]}')
        if chunk.type != "content" || chunk.content != "kept"
            throw Error("null delta must not hide valid simultaneous content")
    }

    ParseLine_NullChoice_WithValidContent_PreservesContent() {
        chunk := SSEParser.ParseLine('data: {"choices":[null,{"delta":{"content":"kept"}}]}')
        if chunk.type != "content" || chunk.content != "kept"
            throw Error("null choice must not hide valid simultaneous content")
    }

    ParseLine_JsonScalar_IsIgnoredSafely() {
        chunk := SSEParser.ParseLine('data: "embedded scalar text"')
        if chunk.type != "ignore"
            throw Error("JSON scalar SSE payload must be ignored safely, got " chunk.type)
    }

    ParseLine_ToolCallFinish_CarriesReason() {
        chunk := SSEParser.ParseLine('data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}],"model":"deepseek-v4-flash","usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}')
        if chunk.type != "finish" || chunk.reason != "tool_calls"
            throw Error("expected finish/tool_calls chunk, got " chunk.type " reason=" chunk.reason)
    }
}
