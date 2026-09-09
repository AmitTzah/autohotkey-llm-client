<h1 align="center">AhkLLM</h1>

<p align="center"><b>LLM hotkeys and a full chat app for Windows.</b></p>

<p align="center">
  <a href="https://github.com/AmitTzah/ahkllm/releases/latest/download/AhkLLM.zip"><img src="https://img.shields.io/badge/Download-AhkLLM.zip-blue" alt="Download AhkLLM.zip"></a>
  <a href="https://github.com/AmitTzah/ahkllm/releases"><img src="https://img.shields.io/github/downloads/AmitTzah/ahkllm/total?label=downloads" alt="AhkLLM downloads"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-GPL--3.0-blue" alt="License: GPL-3.0"></a>
</p>

AhkLLM is a Windows LLM assistant built around two things: system-wide hotkeys and a full chat application.

You can select text in another application and rewrite it in place, summarize it, translate it, send it into a chat, grab screenshots, use FIM to continue or fill in text around your cursor, or create your own commands entirely.

The other half is a full WebView2 chat client with branching, conversation trees, assistants, file attachments, web search, usage tracking, backups, API logs, and a bunch of the other stuff I wanted from the LLM apps I was already using.

The main point is that the two sides are connected. You can use AhkLLM as a normal chat application, but you can also call it from whatever application you're already working in instead of constantly copying text back and forth to a browser.

**FIM Fill:** generate missing text using what comes before and after it.

<p align="center">
  <img src="docs/gifs/FIM-fill.gif" alt="AhkLLM FIM Fill generating text between existing text" width="760">
</p>

## The hotkey side

By default, pressing <kbd>&#96;</kbd> (the backtick key, usually below Esc) opens the command menu. The commands themselves are configurable, including the prompt, model, reasoning level, hotkey, whether to ask for extra input or attach a screenshot, and what AhkLLM should do with the result.

A few examples:

- Use **Rephrase in Context** to send both the selection and the surrounding document text, then replace only the selected part.
- Put your cursor in the middle of some prose or code and use **FIM Fill** to generate what belongs between the text before and after the cursor.
- Use **FIM Continue** to continue writing from where your cursor is sitting.
- Drag over a screen region, preview the screenshot, add a prompt if you want, and send that exact capture into chat as image context.
- Send selected text into the full chat window and continue the conversation there.
- Select a paragraph in an email, run **Refine**, and AhkLLM replaces the selection with the rewritten version.

<p align="center">
  <img src="docs/gifs/refine.gif" alt="AhkLLM refining selected text in place" width="760">
</p>

Custom commands can use the same capture-and-paste flow. This one turns selected text into a bullet list and pastes the result back into the original application:

<p align="center">
  <img src="docs/gifs/custom-paste-bullet-list.gif" alt="AhkLLM custom command turning selected text into a bullet list" width="760">
</p>

Screenshot capture is not hardwired to the built-in Screenshot command either. Any normal chat command can turn on **Attach Screenshot**. It can run immediately with a fixed prompt, or open the input box after the capture so you can type an instruction. When the input box is on, AhkLLM shows a small proportional preview of the exact PNG that will be attached. Attach Screenshot requires a vision-capable model and `pasteMode: "chat"`, and it cannot be combined with FIM.

Text capture uses Windows UI Automation where the target application exposes it, with clipboard fallbacks for normal selection-based commands where possible. FIM depends on UIA text access because AhkLLM needs the text on both sides of the cursor.

FIM Fill and Continue use DeepSeek's beta FIM completions endpoint by default. They work with normal writing as well as code.

<p align="center">
  <img src="docs/gifs/FIM-continue.gif" alt="AhkLLM FIM Continue extending text from the cursor" width="760">
</p>

FIM is also useful for building on structured text. Here, DeepSeek generates ASCII drawings in Notepad, then continues and regenerates them directly from the cursor:

<p align="center">
  <img src="docs/gifs/ASCII-DEMO.gif" alt="AhkLLM using DeepSeek FIM to generate, continue, and regenerate ASCII drawings in Notepad" width="760">
</p>

In this example, the Screenshot command lets you drag over part of Excel, then sends that capture into chat with an instruction to explain what's on screen:

<p align="center">
  <img src="docs/gifs/screenshot.gif" alt="AhkLLM capturing a screenshot and sending it as image context" width="760">
</p>

## The chat side

I originally only wanted the hotkey workflow. The chat GUI mostly happened because I was tired of bouncing between different LLM frontends and still not having a few things I consider pretty basic.

The biggest one is branching. Editing or retrying an earlier message creates another branch instead of destroying what came after it, and the conversation map lets you see the whole tree and jump between branches. You can also fork part of a conversation into a separate chat.

<p align="center">
  <img src="docs/screenshots/chat-window.png" alt="AhkLLM chat window" width="380">
  <img src="docs/screenshots/chat-tree.png" alt="AhkLLM conversation tree" width="380">
</p>

Other chat features currently include:

- Streaming responses with Markdown, syntax highlighting, math rendering, quote, copy, edit, retry, and export.
- DeepSeek, OpenAI, Gemini, OpenRouter, the optional local Codex CLI backend, and user-added OpenAI-compatible providers.
- Per-chat model and reasoning settings, plus temperature where the selected backend supports it.
- Configurable assistants with their own system prompts.
- Images, PDFs, scanned PDFs, DOCX, PPTX, XLSX, EPUB, text files, and a fairly long list of code formats as attachments.
- Web search. DeepSeek can use its Responses API search path, while other providers can use Tavily.
- Folders, trash, and real-time chat search.
- Password-locked chats. This is an application-level lock, not encryption at rest. The exact security model is documented in [docs/locked-chats.md](docs/locked-chats.md).
- Optional local backups.
- A usage dashboard for token counts, estimated API cost, response speed, and latency, with filtering and CSV export. Codex CLI turns show token usage but $0 API cost because they use the user's ChatGPT/Codex plan allowance instead of API billing.
- An API log viewer for inspecting requests and responses when something behaves strangely.

<p align="center">
  <img src="docs/screenshots/usage-dashboard.png" alt="AhkLLM usage dashboard" width="380">
  <img src="docs/screenshots/settings-providers.png" alt="AhkLLM provider settings" width="380">
</p>

There is currently no dark mode. I know. I'll add one if people actually want it.

## Installation

The normal download is the latest [`AhkLLM.zip`](https://github.com/AmitTzah/ahkllm/releases/latest/download/AhkLLM.zip). It is a portable ZIP rather than an installer.

1. Download and extract `AhkLLM.zip` somewhere.
2. Install [AutoHotkey v2.0.18 or later](https://www.autohotkey.com/download/ahk-v2.exe).
3. Make sure the [WebView2 Runtime](https://developer.microsoft.com/en-us/microsoft-edge/webview2/) is installed. Windows 11 normally already has it.
4. Set the API key for whichever HTTP provider you want to use, or enter it later in Settings. Alternatively, users with ChatGPT/Codex access can install and sign in to the official Codex CLI separately; see [Codex CLI backend](docs/codex-cli.md). If you just want to try AhkLLM without paying for API usage, see [Try AhkLLM for free](#try-ahkllm-for-free).
5. Run `Main.ahk`.

If you want to run directly from source instead, clone the repository and follow the same steps.

If you prefer storing API keys in Windows environment variables, AhkLLM recognizes:

```text
DEEPSEEK_API_KEY
OPENAI_API_KEY
GOOGLE_API_KEY
OPENROUTER_API_KEY
TAVILY_API_KEY
```

For example:

```cmd
setx DEEPSEEK_API_KEY "your-key-here"
```

Open a new terminal or sign out and back in after using `setx` so Windows picks up the new value.

## Basic controls

By default:

- <kbd>&#96;</kbd> opens the command menu.
- <kbd>&#96;</kbd> followed by <kbd>1</kbd> opens the chat window.
- <kbd>Ctrl</kbd> + <kbd>Alt</kbd> + <kbd>R</kbd> reloads AhkLLM.
- <kbd>Ctrl</kbd> + <kbd>W</kbd> closes pop-ups.
- <kbd>CapsLock</kbd> + <kbd>&#96;</kbd> suspends or resumes the hotkeys.

They are all remappable from Settings.

Most configuration is available from the gear icon in the chat window, including providers, models, commands, assistants, hotkeys, icons, menu items, and UI appearance settings.

If you prefer editing the shipped defaults directly, they live in [`default-settings/DefaultSettings.ahk`](default-settings/DefaultSettings.ahk). Reload or restart AhkLLM after changing that file.

### User-added providers and model metadata

User-added providers must expose an OpenAI-compatible Chat Completions endpoint and use Bearer authentication. Give each provider a stable lowercase ID; model references use that transport ID, such as `xiaomi/mimo-v2.5-pro`.

**Fetch Latest Models** gets pricing, cached-input pricing, context limits, vision/reasoning support, and compatibility metadata from [models.dev](https://models.dev/). A provider uses the models.dev catalog with the same ID by default. Set the optional **models.dev Provider** override when a transport provider should use another catalog, for example `work-mimo` mapped to `xiaomi`; generated model IDs still use `work-mimo`.

OpenRouter is intentionally handled per model: use the model settings **Lookup** action for an exact slug or provider/model ID. Its large catalog is not bulk-imported, and `openrouter/free` remains the built-in synthetic router model.

### Codex CLI (ChatGPT subscription)

AhkLLM includes a built-in `codex` provider that invokes the user's separately installed official Codex CLI locally. The user authenticates Codex directly with their own ChatGPT account; AhkLLM does not request or store an OpenAI API key for this provider.

Open **Settings -> Providers -> Codex CLI (ChatGPT subscription)** and click **Check Codex** to verify the installed CLI version and ChatGPT login without invoking a model. Codex-backed turns consume your normal ChatGPT/Codex plan allowance and plan limits.

See [docs/codex-cli.md](docs/codex-cli.md) for installation, the restricted LLM-only execution profile, supported capabilities, usage accounting, and troubleshooting.

## Try AhkLLM for free

If you just want to try AhkLLM without paying for API usage, you can use OpenRouter's free model router. Create a free OpenRouter API key and set it as `OPENROUTER_API_KEY`, either through a Windows environment variable or from AhkLLM's provider settings.

For normal chat, open the model picker and choose `openrouter/free`.

For commands such as **Refine**, **Summarize**, **Translate**, or **Explain**:

1. Open **Settings -> Commands**.
2. Choose the command you want to change.
3. Set its model to `openrouter/free`.
4. Save the settings.

OpenRouter chooses from its currently available free models automatically, so the exact model can vary between requests. The free tier also has rate limits.

**FIM Fill** and **FIM Continue** are the exception. They use a separate FIM completions endpoint, so `openrouter/free` cannot be used for those commands. AhkLLM uses DeepSeek's FIM endpoint for them by default.

## Where the data goes

Chats, settings, and attachments are stored locally under `%APPDATA%\AhkLLM\`. Chat history lives in SQLite and uploaded files are stored alongside the application data.

AhkLLM has no telemetry.

That does not mean your prompts stay on your machine. Selected text, prompts, screenshots, and attachments are sent to whichever model provider you configure when you make a request. Web search queries are also sent to the relevant search provider.

For the Codex CLI backend, AhkLLM hands the active text conversation to the user's local Codex process, which communicates with OpenAI using that user's own Codex/ChatGPT authentication. AhkLLM does not read or proxy the Codex credential.

API request/response logs and the diagnostic log are written under `%TEMP%` and can contain prompt or response data. Logging can be disabled in Settings.

If you enter provider keys directly in Settings, they are stored in `settings.json`. Environment variables are preferable if that matters to you.

Password-protecting a chat will **not** hide it from anyone with direct filesystem access to `%APPDATA%\AhkLLM\`: the password stops the chat from being opened through AhkLLM, but the underlying database and attachments are not encrypted at rest. See [docs/locked-chats.md](docs/locked-chats.md) for the details.

## Testing and contributing

This project has a normal unit/integration test suite and a fairly large headless E2E harness that launches and drives the real application.

For the regular test suite:

```cmd
npm run test:fast
```

For the full E2E suite:

```cmd
npm run test:e2e
```

The E2E suite never moves or junctions your real AhkLLM profile. Each worker uses a guarded, explicit temporary data directory, plus its own TEMP/TMP and WebView2 state. Close the normal app before running it. Use `--workers=N` for explicit parallelism; automatic runs cap at 8 workers. More details are in [`tests/headless/README.md`](tests/headless/README.md).

The running history of bugs found through that harness is in [`tests/headless/BUG_HUNT_REPORT.md`](tests/headless/BUG_HUNT_REPORT.md). If you want to contribute but have no idea what to work on, that is a pretty good place to point yourself, or your LLM, first.

See [`CONTRIBUTING.md`](CONTRIBUTING.md) before opening a PR.

## Architecture

If you want to understand how the AHK side, WebView2 UI, SQLite layer, IPC, streaming, attachments, and branching system fit together, see [`ARCHITECTURE.md`](ARCHITECTURE.md).

## License and original project

AhkLLM is GPL-3.0. See [`LICENSE`](LICENSE).

AhkLLM started as a fork of [LLM-AutoHotkey-Assistant](https://github.com/kdalanon/LLM-AutoHotkey-Assistant) by [kdalanon](https://github.com/kdalanon), which had the original hotkey workflow that gave me the idea for this project.

It has since grown into a much larger application, but that project is where the whole thing started.

Third-party libraries and redistributed assets are listed in [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).
