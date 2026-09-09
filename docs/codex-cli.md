# Codex CLI backend

AhkLLM can use the official, separately installed OpenAI Codex CLI as an optional local LLM transport. This backend is intended for users who already have Codex access through their ChatGPT plan and want AhkLLM to send deliberate model requests through their own local Codex installation instead of through an OpenAI API key.

This is **not** an OpenAI API key substitute or a claim that a ChatGPT subscription includes OpenAI API credits. Codex requests consume the user's normal ChatGPT/Codex plan allowance and remain subject to the plan's usage limits.

## Setup

1. Install the official Codex CLI separately, following OpenAI's current Codex CLI instructions.
2. In a terminal, run `codex login` and authenticate with ChatGPT.
3. Start or reload AhkLLM.
4. Open **Settings -> Providers -> Codex CLI (ChatGPT subscription)**.
5. Click **Check Codex**. AhkLLM runs only `codex --version` and `codex login status`; this check does not invoke a model or consume a Codex turn.
6. Choose a `codex/...` model in the normal model picker or in a supported command.

AhkLLM requires Codex CLI **0.153.0 or newer** and was tested against the **0.153.x** release family. Compatible newer releases are allowed so routine Codex updates do not disable the backend. AhkLLM still passes its restricted execution controls on every request with strict configuration enabled; if a future Codex release removes or changes a required control, that request fails with an incompatibility error instead of silently relaxing the profile. If `codex` is not on `PATH`, set `CODEX_CLI_PATH` to the installed Codex executable or Windows command shim before launching AhkLLM.

The Codex model list in AhkLLM is curated rather than fetched from the OpenAI API. Actual model availability is controlled by the user's ChatGPT/Codex plan and the installed Codex client, so a listed model can still be unavailable to a particular account.

### Adding a new Codex model

Codex models live in `default-settings/DefaultCodexModels.ahk`, separately from the models.dev-generated API catalog. Normal AhkLLM releases update this small curated list when OpenAI adds or changes Codex models, including the model-specific reasoning efforts AhkLLM should expose.

Advanced users can also add a model immediately from **Settings -> Models** by choosing the `codex` provider and entering the upstream Codex model ID. AhkLLM does not send a disposable probe request to validate a new model, because that would consume Codex usage. The first real request is the availability check. Unknown manually added Codex models use the conservative `low`, `medium`, and `high` reasoning choices until AhkLLM has curated model-specific metadata; leave reasoning on **Model Default** if the model rejects an explicit effort.

## Authentication and credentials

AhkLLM does not ask for, read, copy, proxy, or persist OpenAI credentials for the Codex provider. Authentication is owned by the official Codex installation. Each user installs Codex separately and signs in directly with their own ChatGPT account.

For Codex child processes, AhkLLM clears common API-key environment variables, including `OPENAI_API_KEY`, before invoking the CLI. The generated Codex configuration also forces the ChatGPT login method. This avoids silently falling back to API-key billing when the user selected the ChatGPT-subscription backend.

The **Check Codex** action recognizes ChatGPT authentication specifically. A CLI that is installed but authenticated only by another method is reported as not ready for this backend.

## Request model

AhkLLM treats Codex as a process transport, not as an HTTP endpoint:

- One deliberate AhkLLM model action launches one non-interactive `codex exec` process.
- AhkLLM remains the source of truth for chat history, branches, retries, and thread storage.
- Each turn is ephemeral. AhkLLM sends the active chronological conversation to Codex over standard input and reads the final assistant message from Codex's output file.
- Prompt text is not placed on the Codex command line.
- JSONL progress output is used for token accounting and provider-supplied public reasoning/activity.
- When Codex emits an `item.completed` reasoning item, AhkLLM shows its public summary in the same **Thought Process** block used by other providers and persists that summary with the assistant message. Hidden/raw chain-of-thought is never requested or displayed.
- Cancellation terminates the owned Windows process tree.

Automatic thread titles are a special case. If the configured title model is Codex, AhkLLM derives a short deterministic title locally from the first user message. It does not spend a second hidden Codex turn on title generation.

## Restricted LLM-only profile

Normal AhkLLM chat deliberately constrains Codex to act like a text LLM rather than a local coding agent. The invocation is ephemeral and non-interactive. AhkLLM disables the local execution and inspection surfaces it knows about, including shell/unified execution, shell snapshots, code modes, local image viewing, apps, plugins, MCP discovery, skills, subagents, memories, browser/computer control, and image generation. It also launches Codex in a dedicated empty working directory, ignores user Codex config/rules, uses `approval_policy="never"`, and keeps the Codex sandbox read-only as a final write-protection backstop.

AhkLLM does not rely on the system prompt as a security control. The prompt tells the model that local tools are unavailable, while CLI feature switches, strict configuration validation, and the read-only sandbox enforce the restricted profile. The 0.153.x family is the tested baseline, not an upper version pin: compatible newer Codex releases are allowed. If Codex changes or removes one of the controls AhkLLM passes to enforce this profile, the CLI invocation fails and AhkLLM reports the incompatibility rather than silently continuing with a weaker configuration.

## Web search

The per-chat **Web Search** toggle uses Codex's hosted web-search mode inside the same `codex exec` turn:

- Web Search off: Codex search is explicitly disabled.
- Web Search on: Codex hosted search is enabled for that same request.

This path does not use Tavily and does not create a second Codex model invocation.

## Current capability differences

The first Codex backend version intentionally exposes a narrower capability set than HTTP providers:

- Text chat and text commands: supported.
- Multi-turn conversation: supported by sending AhkLLM's active conversation history each turn.
- Reasoning effort: supported where the selected Codex model offers it.
- Temperature: not exposed; Codex CLI does not provide an API-equivalent temperature control for this transport.
- FIM Fill / FIM Continue: not supported by the Codex backend.
- Image/attachment input: not supported by the initial Codex transport; unsupported message content fails instead of being silently dropped.
- AhkLLM local/agent tools: disabled for normal Codex-backed chat.
- Codex local shell/file/agent tools: disabled by the LLM-only execution profile.

## Usage dashboard

AhkLLM records token usage reported by Codex, including cached input tokens and the reported reasoning-output token count when provided. Codex rows record **$0 API cost** because AhkLLM is not making a metered OpenAI API request for those turns.

`$0 API cost` does not mean free or unlimited inference. The request still consumes the user's ChatGPT/Codex plan allowance and is subject to that plan's limits. The dashboard cost tooltip calls this out when Codex usage is present.

## Data flow and logs

For a Codex-backed request, AhkLLM writes short-lived request artifacts under the Windows temporary directory, launches the user's local Codex CLI, sends the conversation through standard input, and receives the result from the CLI. Codex then communicates with OpenAI under the user's own Codex/ChatGPT authentication.

Temporary transport files are removed after the request. AhkLLM's normal diagnostic/API logging settings still apply and can contain prompt or response text unless logging is disabled. Locked-chat redaction rules continue to apply.

## Terms and plan limits

The integration uses OpenAI's official Codex CLI interface and the user's own local authentication; AhkLLM does not pool accounts, distribute credentials, proxy a subscription to other users, run an inference server, or attempt to bypass Codex limits.

OpenAI's product terms and Codex plan rules can change. Users and distributors should review the current OpenAI terms and Codex documentation rather than treating this document as a legal guarantee. AhkLLM should be described as using the user's **Codex entitlement through the official local Codex client**, not as turning a ChatGPT subscription into an OpenAI API.

## Troubleshooting

If **Check Codex** reports that the CLI is missing, verify that `codex --version` works in a new terminal launched with the same Windows account as AhkLLM. If needed, set `CODEX_CLI_PATH` before starting AhkLLM.

If the CLI is installed but not authenticated, run `codex login` and choose ChatGPT authentication, then click **Check Codex** again.

If AhkLLM reports that Codex is too old, update the official Codex CLI. If a newer Codex release is installed and a request reports that the restricted profile is incompatible, update AhkLLM when a compatible release is available (or temporarily use the previously working Codex release). AhkLLM intentionally fails when the CLI no longer understands one of the controls used to disable local agent capabilities.

If a request reports a Codex usage/quota limit, wait for the user's Codex allowance to reset or select another configured backend. AhkLLM does not fall back from the ChatGPT Codex backend to an OpenAI API key automatically.
