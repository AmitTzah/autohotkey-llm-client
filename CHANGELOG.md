# Changelog

## [1.4.0] - 2026-09-13

### Added

- Optional Codex CLI backend using ChatGPT subscription authentication, with Codex reasoning summaries, native web search, image generation, usage tracking, and automatic thread titles.
- Per-thread Codex request isolation for concurrent chats, thread switches, and branch navigation.
- Mermaid diagram rendering and bracket-delimited LaTeX math support.
- Completion sounds and attention indicators for finished responses.

### Improved

- New-chat defaults consistently control the selected assistant, model, and provider icon.
- Markdown rendering and WebView startup were refactored into focused modules.
- Chat links now open in the system's default browser.
- Streaming, cancellation, retry, branch, and thread-switch state handling was substantially hardened.

### Fixed

- Duplicate messages and stale UI state during cancellation races.
- Cross-thread response, usage, error, and retry-state leakage.
- Model and settings preservation across edits, forks, retries, and reloads.
- Codex image, reasoning, title-generation, and search state persistence.
- Sidebar ordering, provider badges, trash disclosure state, and new-chat initialization edge cases.

## [1.3.1] - 2026-09-03

### Fixed

- Backup settings now require a destination before activation, normalize the selected folder consistently, and use the persisted configuration reliably when starting a manual backup.
- Backup status clears stale errors when its configuration changes and reports actionable pending/running/folder-required states.

## [1.3.0] - 2026-09-02

### Added

- First-class user-added OpenAI-compatible Chat Completions providers with stable IDs and optional models.dev catalog mappings.
- Rich models.dev metadata refresh, including input/cache/output pricing, context, vision, reasoning, and compatibility details.

### Improved

- Redesigned the Edit Models workspace with stacked full-width tables, a draggable panel splitter, resizable columns, readable provider labels, and complete pricing visibility.
- Provider settings now clearly describe the OpenAI-compatible Chat Completions and Bearer-authentication requirements.

### Fixed

- Custom providers can add models during the same unsaved Settings session, and provider/model references survive Save and reload without mangling nested IDs.
- Legacy generated provider IDs can be renamed to stable IDs, while removing a provider cannot leave dangling model references.
- Custom-provider SSE parsing tolerates nullable OpenAI-compatible fields such as `tool_calls`, `choices`, and `delta`.
- OpenRouter remains lookup-only instead of bulk-importing its large catalog; the synthetic `openrouter/free` model remains available.
- Settings refreshes no longer rewrite committed defaults with user-specific provider mappings.
- Settings IPC acknowledgements are not lost when the host handles a save synchronously.

## [1.2.1] - 2026-09-01

### Fixed

- Removed the default `\n` stop sequence from FIM Continue so continuation output is not cut off at the first newline.

## [1.2.0] - 2026-09-01

### Added

- Support for adding and resolving user-supplied OpenRouter models, including model metadata, reasoning levels, pricing, and provider icons.
- Expanded regression coverage for settings, streaming, branching, attachments, locking, usage tracking, and concurrent requests.
- Isolated parallel WebView2 E2E workers for faster and safer full-application verification.

### Improved

- Refined settings labels, shortcut capture and feedback, usage-dashboard navigation, and input-window presentation.
- Clarified context-limit behavior and password-protection limitations in the documentation.

### Fixed

- Made Escape cancellation reliable and corrected several settings, FIM, and UI lifecycle edge cases.
- Refreshed the documentation screenshots and custom-paste demonstration assets.
