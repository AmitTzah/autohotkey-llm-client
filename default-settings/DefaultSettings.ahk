; ============================================================================
; DefaultSettings.ahk -- App defaults (fallback when settings.json is missing)
; ============================================================================
; Edit this file to customize AhkLLM.
; Changes take effect after saving (Ctrl+S auto-reloads).
;
; Quick reference -- search for the section you need:
;   S1  Providers       -- API endpoints, auth, display settings
;   S2  Models          -- auto-generated in DefaultModels.ahk
;   S3  Provider Map    -- infers provider from model name prefixes
;   S4  Assistants      -- named chat profiles
;   S5  Commands        -- menu commands (the ` menu)
;   S6  Thread Titles   -- auto-generation model and prompt
;   S7  UI              -- chat window, input, suspend banner
;   S8  Icons           -- tray icons
;   S9  Hotkeys         -- main hotkey, suspend, close, save/reload
;   S10 API Logs        -- max log entries
;   S11 Trash Retention -- days before auto-purge
;   S12 Menu Items      -- Quick Access submenu and Tray menu


; ============================================================================
; S1 PROVIDERS -- API endpoint configuration
; ============================================================================
; Each provider: displayName, endpoint, optional modelsDevProvider catalog override, fimEndpoint, authEnvVar, icon, collapseThinking.
; API keys are read from environment variables (set via `setx`).

providers := Map(
    "deepseek", {
        displayName: "DeepSeek",
        endpoint: "https://api.deepseek.com/chat/completions",
        modelsDevProvider: "deepseek",
        fimEndpoint: "https://api.deepseek.com/beta/completions",
        authEnvVar: "DEEPSEEK_API_KEY",
        icon: "icons/deepseek.ico",
        collapseThinking: false
    },
    "openai", {
        displayName: "OpenAI",
        endpoint: "https://api.openai.com/v1/chat/completions",
        modelsDevProvider: "openai",
        fimEndpoint: "",
        authEnvVar: "OPENAI_API_KEY",
        icon: "icons/openai.ico",
        collapseThinking: true
    },
    "codex", {
        displayName: "Codex CLI (ChatGPT subscription)",
        transport: "codex-cli",
        billingMode: "chatgpt-subscription",
        endpoint: "",
        modelsDevProvider: "",
        fimEndpoint: "",
        authMode: "chatgpt",
        authEnvVar: "",
        icon: "icons/openai.ico",
        collapseThinking: true
    },
    "openrouter", {
        displayName: "OpenRouter",
        endpoint: "https://openrouter.ai/api/v1/chat/completions",
        modelsDevProvider: "openrouter",
        fimEndpoint: "",
        authEnvVar: "OPENROUTER_API_KEY",
        icon: "icons/openrouter.ico",
        collapseThinking: false
    },
    "google", {
        displayName: "Google Gemini",
        endpoint: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
        modelsDevProvider: "google",
        fimEndpoint: "",
        authEnvVar: "GOOGLE_API_KEY",
        icon: "icons/google.ico",
        collapseThinking: true
    }
)


; ============================================================================
; S2 MODELS -- Pricing and metadata
; ============================================================================
; Generated model metadata lives in DefaultModels.ahk. To refresh: Models
; settings -> Fetch Latest Models, or run scripts\Refresh-Models.ps1.
; ============================================================================


; ============================================================================
; S3 PROVIDER INFERENCE MAP
; ============================================================================
; When a model name is given WITHOUT a "provider/" prefix (e.g. "gpt-5-mini"
; instead of "openai/gpt-5-mini"), the script uses these prefix->provider
; mappings to figure out which provider to use. First prefix match wins.
; If no prefix matches, defaults to "deepseek".
;
; You only need to edit this when:
;   - Adding a new provider (e.g. "anthropic") -- add a mapping for their model
;     name prefixes (e.g. "claude"->"anthropic").
;   - A provider releases a new model family with a different name prefix
;     (e.g. if OpenAI releases "nova-*" models -- add "nova"->"openai").

providerMap := Map(
    "deepseek", "deepseek",
    "gpt",      "openai",
    "o1",       "openai",
    "o3",       "openai",
    "codex",    "codex",
    "openrouter", "openrouter",
    "claude",   "anthropic",
    "gemini",   "google",
    "gemma",    "google"
)


; ============================================================================
; S4 ASSISTANTS -- Named chat profiles
; ============================================================================
; Each assistant: name, baseModel ("provider/model"), systemMessage (or systemMessageFile), description, reasoning, temperature.
;   Legacy isDefault values are retained for settings-file compatibility but no longer choose the new-chat default. Use newChatStartsWith instead.
;   description: short description shown in the model card (optional). Keep it one sentence or less.
;   Use systemMessageFile: "default-settings/system-messages/my-assistant.txt" for longer prompts.
;   reasoning: "none" | "minimal" | "low" | "medium" | "high" | "xhigh" or "" for model default.
;     DeepSeek: "none" uses thinking:{type:"disabled"}; low/medium->high, xhigh->max
;     OpenAI:   "none" only on gpt-5.1+; "xhigh" only on gpt-5.1-codex-max+
;     Google:   "none" only on Gemini 2.5; "xhigh" not supported
;   temperature: 0-2 or "" for model default.

assistants := [


     {
        name: "Natural Conversationalist",
        baseModel: "deepseek/deepseek-v4-pro",
        systemMessageFile: "default-settings/system-messages/natural-conversationalist.txt",
        reasoning: "none",
        temperature: "",
        description : "A friendly, natural conversationalist that responds in a human-like manner.",
        isDefault: true
    },
     {
        name: "Violet",
        baseModel: "google/gemma-4-31b-it",
        systemMessageFile: "default-settings/system-messages/violet.txt",
        reasoning: "none",
        temperature: "",
        description : "A direct, unfiltered conversationalist with her own opinions.",
        isDefault: false
    }
]


; ============================================================================
; S5 COMMANDS (Menu Commands)
; ============================================================================
; Each object in this array defines one command in the prompt menu.
;
; --- REQUIRED FIELDS ---
;
;   commandName:      Internal identifier string (used by the script to
;                     reference this command -- not shown to the end user).
;
;   menuText:         Label displayed in the tray/hotkey menu. The & character
;                     defines an accelerator key (e.g. "&1" lets the user
;                     press 1 to select that item).
;
;   APIModels:        A single model identifier. Supports "provider/model"
;                     format (e.g. "openai/gpt-4o") or direct model names
;                     (e.g. "deepseek-v4-pro").
;
; --- OPTIONAL FIELDS ---
;   All fields below are optional.  Fields related to prompt composition
;   (systemMessage, systemMessageFile, userMessage, showInputBox,
;   inputBoxDefault, and template variables) are ignored when isFIM: true.
;
;   --- Prompt composition ---
;   systemMessage:     Instructions for the LLM (system prompt).  Supports
;                      template variables (see below).
;                      Example: "Define: {{selection}}"
;
;   systemMessageFile: Path to a .txt file containing the system message.
;                      Supports the same template variables as systemMessage.
;                      Takes precedence over systemMessage.
;                      Example: systemMessageFile: "default-settings/system-messages/define.txt"
;
;   userMessage:       The user message sent to the LLM.  Supports the same
;                      template variables as systemMessage.
;                      No default -- if omitted, no user message is sent.
;                      Typical: "{{selection}}" to operate on selected text,
;                               "{{input}}" when showInputBox is true.
;                      NOTE: AHK uses backtick-n (``n) for newlines, not \n.
;
;   showInputBox:     If true, opens a text box before sending.  Whatever the
;                     user types becomes available as {{input}} in the prompt
;                     fields above.  Ignored when isFIM: true.  Default: false.
;
;   inputBoxDefault:  Text pre-filled in the input box.  Only meaningful when
;                     showInputBox is true.
;
;   includeImageContext:
;                     (Optional) When true, lets the user select a screen
;                     region when the command runs and attaches that image to
;                     the chat message. Requires pasteMode: "chat", cannot be
;                     used with isFIM: true, and the selected model must support
;                     vision/image input. Works with or without showInputBox.
;                     With showInputBox enabled, the screenshot is captured
;                     first and shown as a preview above the prompt field.
;                     Default: false.
;
;   --- Template Variables ---
;   These placeholders work in systemMessage, systemMessageFile, and userMessage.
;   They are replaced at runtime with the actual captured text.
;   Ignored when isFIM: true.
;
;     {{selection}}  -- the text the user highlighted before triggering the command
;     {{fullText}}    -- the entire document text (read via Windows accessibility API)
;     {{input}}       -- whatever the user typed in the input box (only if showInputBox: true)
;
;   --- Default Behaviour (no userMessage, no templates) ---
;   If you omit userMessage and don't use any {{...}} variables, the command
;   behaves exactly like it always did in past versions: the selected text is sent as-is to the
;   LLM. If showInputBox is true, the typed text is prepended before the
;   selection, separated by a blank line.
;
;   Template variables are optional -- use them when you need the full
;   document context ({{fullText}}) or want to control exactly how the
;   selection and input are formatted in the prompt.
;
;   pasteMode:        (Optional) Where the LLM response goes:
;                       "chat"     -- shows the full chat interface in the chat window
;                       "replace"  -- replaces the selected text in the active app
;                       "append"   -- placed after the cursor/selection
;                     Default: "chat".
;
;   stream:           (Optional, chat mode only) When true, the LLM response
;                     streams token-by-token in real time instead of appearing
;                     all at once. Requires pasteMode: "chat". Default: false.
;
;   thinking:         (Optional) { type: "enabled", level: "none"|"minimal"|"low"|"medium"|"high"|"xhigh"|"max" }
;                     level must be one the command's model supports (see its thinkingLevelMap).
;                     "none" = thinking disabled. Omit the field entirely for Model Default (no config).
;                     "enabled" works across all providers (translated per API).
;                     Optional "level" controls the thinking depth (defaults to "medium").
;                     Default: omitted (model default).
;
;   isFIM:      (Optional) Use DeepSeek FIM (Fill In the Middle) beta
;                     endpoint instead of chat completions.
;                     When true, the [CHAT] prompt fields above (systemMessage,
;                     userMessage, showInputBox, template variables) are all
;                     ignored -- FIM uses a separate API format.
;                     FIM Fill (pasteMode: "replace"):
;                       Fills the gap between prefix and suffix.  Works with or
;                       without a selection (cursor = zero-width gap).
;                     FIM Continue (pasteMode: "append"):
;                       Continues from the cursor/selection.
;                     Default: false.
;
;   expandNewlines:   (Optional) If true, single \n between text paragraphs
;                     is expanded to \n\n (the universal paragraph break in
;                     LLM training data).  Normalisation (\r\n -> \n) always
;                     happens regardless.  Useful for FIM and prose commands.
;                     Default: false.
;
;   maxContextWords:   (Optional) Maximum words of surrounding context to send
;                      to the API.  The selection/gap itself is always fully
;                      captured; only surrounding text is truncated.
;                      FIM Fill:  splits limit equally above and below cursor.
;                      FIM Continue: controls words captured before cursor.
;                      {{fullText}}: limits document context around selection.
;                      Uses UIA DocumentRange for instant full-text access;
;                      truncation is pure string ops (no scroll, no delay).
;                      Default: 0 (no limit -- entire document).
;                      Example: maxContextWords: 3000
;
;   temperature:      (Optional) Sampling temperature 0-2.  Higher = more
;                     creative/random, lower = more deterministic.
;                     Not set by default (API uses its own default).
;
;   maxTokens:        (Optional) Maximum tokens in the response.
;                     Not set by default (API decides). FIM commands
;                     should set this explicitly (default: 4000).
;
;   stop:             (Optional) Array of stop sequences (e.g. ["\n\n"]).
;                     Generation stops when any sequence appears.
;                     Not set by default (no stop sequences).
;
;   tags:             (Optional) Array of submenu names used to group commands
;                     in the menu.  Each tag creates a submenu containing all
;                     commands that share that tag.  Default: [] (no grouping).
;
;   directAccelerator:
;                     (Optional) Creates a top-level keyboard shortcut for
;                     commands that are inside tagged submenus. Press ` then
;                     the key (e.g. "&r") to fire the command without
;                     navigating into its submenu. Only useful with tags --
;                     without tags the command already appears in the main
;                     menu, making this redundant. Default: none.
;
; ============================================================================
; Example command template -- remove /* and */ to activate, then paste into commands:
/*
    {
        commandName: "Your Command Name",
        menuText: "&9 - Your Menu Label",        
        systemMessage: "Your system message here. This sets the model's role.",
; systemMessageFile: "default-settings/system-messages/my-command.txt",
        APIModels: "deepseek-v4-flash",
        ; APIModels: "openai/gpt-4o",

        ; --- Prompt fields (ignored when isFIM: true) ---
        ; userMessage: "{{selection}}",
        showInputBox: true,
        inputBoxDefault: "",
        includeImageContext: false,

        pasteMode: "replace",
        stream: false,
        thinking: { type: "enabled", level: "none" },  ; "none" = disabled; or pick a model-supported level

        ; --- Set to true to ignore all prompt fields above ---
        isFIM: false,
        
        temperature: 0.7,                        
        maxTokens: 500,                          
        stop: ["\n"],                          
        tags: ["&Your tag"],
        directAccelerator: "&y"                  
    },
*/
; ============================================================================

; ============================================================================
; SUBMENU ORDER -- Controls the order of tagged submenus in the ` menu.
; Tags listed here appear first, in order. Tags not listed appear after,
; in the order their commands are defined. Omit to use command order for all.
submenuOrder := ["&Text manipulation", "&Digest", "&DeepSeek", "&OpenAI", "&Google"]

commands := [

        {
        commandName: "Quick ask (V4 Flash)",
        menuText: "&2 - Quick Ask DeepSeek V4 Flash",
        APIModels: "deepseek-v4-flash",
        showInputBox: true,
        userMessage: "{{input}}`n`n{{selection}}",
        pasteMode: "chat",
        stream: true,
        thinking: { type: "enabled", level: "none" },  ; disabled — fast quick ask
        isFIM: false,                            
    },

    {
        commandName: "FIM Continue",
        menuText: "&1 - FIM Continue",
        APIModels: "deepseek/deepseek-v4-flash",
        pasteMode: "append",
        isFIM: true,
        expandNewlines: true,
        temperature: 1,
        directAccelerator: "&3",
        tags: ["&Text manipulation"],

    },

         {
        commandName: "FIM Fill",
        menuText: "&2 - FIM Fill",
        systemMessage: "",
        APIModels: "deepseek/deepseek-v4-flash",
        pasteMode: "replace",
        isFIM: true,
        expandNewlines: true,
        directAccelerator: "&4",

        tags: ["&Text manipulation"],

    },

        {
        commandName: "Rephrase in Context",
        menuText: "&3 - Rephrase in Context",
        systemMessageFile: "default-settings/system-messages/rephrase-in-context.txt",
        userMessage: "### Full document context:`n`n{{fullText}}`n`n### Text to rephrase:`n`n{{selection}}",
        APIModels: "deepseek/deepseek-v4-flash",
        thinking: { type: "enabled", level: "none" },  ; disabled — fast rephrase
        pasteMode: "replace",
        tags: ["&Text manipulation"],

    },
     {
        commandName: "Custom Prompt → Paste",
        menuText: "&5 - Custom Prompt → Paste",
        APIModels: "deepseek/deepseek-v4-flash",
        showInputBox: true,
        userMessage: "{{input}}`n`n{{selection}}",
        pasteMode: "replace",
        directAccelerator: "&5",
        tags: ["&Text manipulation"],
    },


    {
        commandName: "Refine",
        menuText: "&4 - Refine",
        systemMessageFile: "default-settings/system-messages/refine.txt",
        APIModels: "deepseek/deepseek-v4-flash",
        userMessage: "{{selection}}",
        pasteMode: "replace",
        thinking: { type: "enabled", level: "none" },  ; disabled — fast refine
        tags: ["&Text manipulation"],
        directAccelerator: "&8"

    },

     {
        commandName: "Summarize",
        menuText: "&1 - Summarize",
        systemMessageFile: "default-settings/system-messages/summarize.txt",
        APIModels: "deepseek/deepseek-v4-pro",
        userMessage: "{{selection}}",
        thinking: { type: "enabled", level: "high" },
        pasteMode: "chat",
        stream: true,
        tags: ["&Digest"],
        directAccelerator: "&6"

    }
    , {
        commandName: "Translate to English",
        menuText: "&2 - Translate to English",
        systemMessageFile: "default-settings/system-messages/translate-to-english.txt",
        APIModels: "deepseek/deepseek-v4-pro",
        userMessage: "{{selection}}",
        thinking: { type: "enabled", level: "none" },  ; disabled — fast translate
        pasteMode: "chat",
        stream: true,
        tags: ["&Digest"]

    }
    , {
        commandName: "Explain",
        menuText: "&3 - Explain",
        APIModels: "deepseek/deepseek-v4-pro",
        userMessage: "What does the following text mean?`n`n{{selection}}",
        thinking: { type: "enabled", level: "none" },  ; disabled — fast explanation
        pasteMode: "chat",
        stream: true,
        tags: ["&Digest"]

    }

  , {
        commandName: "Screenshot",
        menuText: "&4 - Send Screenshot",
        APIModels: "openai/gpt-5.6-luna",
        showInputBox: true,
        userMessage: "{{input}}",
        pasteMode: "chat",
        stream: true,
        includeImageContext:true,
        thinking: { type: "disabled", level: "none" },
        tags: ["&Digest"],
        directAccelerator: "&7"
    }


    , {
        commandName: "DeepSeek V4 Pro",
        menuText: "&1 - DeepSeek V4 Pro",
        APIModels: "deepseek/deepseek-v4-pro",
        showInputBox: true,
        userMessage: "{{input}}`n`n{{selection}}",
        pasteMode: "chat",
        stream: true,
        thinking: { type: "enabled", level: "high" },
        tags: ["&DeepSeek"]
    }
    , {
        commandName: "DeepSeek V4 Flash",
        menuText: "&2 - DeepSeek V4 Flash",
        APIModels: "deepseek/deepseek-v4-flash",
        showInputBox: true,
        userMessage: "{{input}}`n`n{{selection}}",
        pasteMode: "chat",
        stream: true,
        thinking: { type: "enabled", level: "high" },
        tags: ["&DeepSeek"],
    }
    , {
        commandName: "GPT-5.4",
        menuText: "&1 - GPT-5.4",
        APIModels: "openai/gpt-5.4",
        showInputBox: true,
        userMessage: "{{input}}`n`n{{selection}}",
        pasteMode: "chat",
        stream: true,
        thinking: { type: "enabled", level: "medium" },
        tags: ["&OpenAI"]
    }
    , {
        commandName: "GPT-5.4 Mini",
        menuText: "&2 - GPT-5.4 Mini",
        APIModels: "openai/gpt-5.4-mini",
        showInputBox: true,
        userMessage: "{{input}}`n`n{{selection}}",
        pasteMode: "chat",
        stream: true,
        thinking: { type: "enabled", level: "medium" },
        tags: ["&OpenAI"]
    }
    , {
        commandName: "Gemini 3.5 Flash",
        menuText: "&1 - Gemini 3.5 Flash",
        APIModels: "google/gemini-3.5-flash",
        showInputBox: true,
        userMessage: "{{input}}`n`n{{selection}}",
        pasteMode: "chat",
        stream: true,
        thinking: { type: "enabled", level: "medium" },
        tags: ["&Google"]
    }
    , {
        commandName: "Gemini 3.1 Pro",
        menuText: "&2 - Gemini 3.1 Pro",
        APIModels: "google/gemini-3.1-pro-preview",
        showInputBox: true,
        userMessage: "{{input}}`n`n{{selection}}",
        pasteMode: "chat",
        stream: true,
        thinking: { type: "enabled", level: "high" },
        tags: ["&Google"]
    }
]


; ============================================================================
; S6 THREAD TITLE AUTO-GENERATION
; ============================================================================
; After the first exchange in a chat thread, generates a short title via a
; separate, cheap LLM call. Toggle with autoTitleGenerationEnabled.

autoTitleGenerationEnabled := true
titleGenModel := "deepseek/deepseek-v4-flash"
titleGenSystemPrompt := "Generate a short, descriptive title (max 6 words) for a conversation based on the first exchange. Respond with ONLY the title, no quotes, no punctuation, no commentary."
titleGenMaxTokens := 50


; ============================================================================
; S7 UI SETTINGS
; ============================================================================

; -- Chat Window (also used for command responses) --
chatShortcut := "1"
appDefaultModel := "deepseek/deepseek-v4-flash"
newChatStartsWith := "" ; "" = app default model; "asst:<id>" = assistant; otherwise a model id

; -- Web Search (per-thread toggle; see ThreadSettings) --
; DeepSeek models search natively via DeepSeek's Responses API. All other
; providers use Tavily; the key can be set here directly or via the
; TAVILY_API_KEY environment variable (Settings -> General).
tavilyApiKey := ""
tavilyEndpoint := "https://api.tavily.com/search"
responseWindowFontFace := "Inter"
responseWindowFontSize := "17"

; -- Command Input Window --
inputWindowBackground    := "0xFFFFFF"
inputWindowFontSize      := "s14"
inputWindowFontColor     := "cBlack"
inputWindowFontFace      := "Arial"
inputWindowWidth         := 500
inputWindowHeight        := 250

; -- Suspend Banner --
suspendBannerText        := "AhkLLM Suspended"
suspendBannerFontSize    := "s10"
suspendBannerFontFace    := "Arial"
suspendBannerTextColor   := "cBlack"
suspendBannerBackground  := "0xFFDF00"


; ============================================================================
; S8 ICONS
; ============================================================================

iconOn  := "icons\IconOn.ico" ; Tray icon when the script is active
iconOff := "icons\IconOff.ico" ; Tray icon when the script is suspended


; ============================================================================
; S9 HOTKEYS
; ============================================================================

mainHotkey         := "``"               ; Backtick -- opens the command menu
reloadHotkey       := "~^!r"             ; Ctrl+Alt+R -- reload script
closeWindowsHotkey := "~^w"              ; Ctrl+W -- close input pop-up
suspendHotkey      := "CapsLock & ``"    ; CapsLock+Backtick -- toggle suspend


; ============================================================================
; S10 API LOGS
; ============================================================================

apiLogMaxEntries := 20    ; max request/response entries; 0 = disable logging


; ============================================================================
; S11 TRASH RETENTION
; ============================================================================

trashRetentionDays := 30    ; days before auto-purge; 0 = never auto-purge


; ============================================================================
; S12 MENU ITEMS
; ============================================================================
; -- Quick Access (appear under ` -> Quick Access in the command menu) --
quickAccessMenuItems := [
    { menuText: "&1 - DeepSeek Usage",         command: "https://platform.deepseek.com/usage" },
    { menuText: "&2 - OpenAI Usage",         command: "https://platform.openai.com/settings/organization/usage" },
    { menuText: "&3 - Gemini Usage",         command: "https://aistudio.google.com/spend" },
    { menuText: "&4 - API Logs",               command: "apilogs:" },
    { menuText: "&5 - Settings",               command: "settings:" },
    { menuText: "&6 - Debug Log",              command: A_Temp "\LLM_Debug_Log.txt" },
    { menuText: "&7 - Usage Dashboard",        command: "usage:" },

]


; -- System tray menu (right-click the tray icon) --
; "Open Chat Window" and "New Chat" are hardcoded above these items.
; Supported actions: "reload" and "exit".
trayMenuItems := [
    { menuText: "&Reload Script", action: "reload" },
    { menuText: "E&xit",          action: "exit" }
]
