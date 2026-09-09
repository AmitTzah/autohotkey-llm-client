# Headless Bug-Verification Harness

This harness verifies GUI bugs by executing the real reproduction steps against
the real AhkLLM application and asserting on live state. It launches AutoHotkey
`Main.ahk`, drives the embedded WebView2 chat UI over Chrome DevTools Protocol
(CDP), and uses small AHK probes for Win32 state. It uses synthetic CDP input,
not physical mouse or keyboard input.

The workflow and scenario-to-bug mapping live in `BUG_HUNT_REPORT.md`. Scenario
IDs are stable and are checked with `--check-sync`.

## Running the suite

```powershell
node tests/headless/e2e-suite.js --all
node tests/headless/e2e-suite.js --all --workers=4
node tests/headless/e2e-suite.js --scenarios=1,6,15 --workers=1
node tests/headless/e2e-suite.js --pilot
node tests/headless/e2e-suite.js --check-sync
node tests/headless/e2e-suite.js --status
node tests/headless/e2e-suite.js --cleanup
```

`--workers=N` accepts 1 through 32. Without it, the automatic selection is:

```text
min(8, availableParallelism - 2, memoryGiB - 2, scenarioCount), at least 1
```

The runner uses durations from the previous `headless-verification.txt` report
to balance slow scenarios across workers. Each worker runs its shard
sequentially, while workers run concurrently.

Close the normal AhkLLM app before a real-app run. Preflight refuses to start if
the normal app is already running, preventing single-instance, window, and
hotkey overlap with the test workers.

## Safety and parallel isolation

`e2e-suite.js` never moves, renames, junctions, modifies, or restores the real
`%APPDATA%\AhkLLM` profile. Each real-app worker receives both
`AHKLLM_E2E_WORKER` and `AHKLLM_E2E_DATA_DIR`. `shared/AppInfo.ahk` redirects
`AppInfo.DataDir` only when both variables are present; normal production
launches continue to use `A_AppData\AhkLLM`.

Every worker has its own:

- data directory, SQLite database, and settings;
- `TEMP`/`TMP` root, request files, debug log, probe output, and mock log;
- WebView2 user-data directory and CDP port; and
- generated `.ahkllm-e2e-main-<worker>.ahk` Main identity and worker marker.

Generated Main scripts stay in the repository root so `A_ScriptDir` remains the
production root. They replace production `#SingleInstance` identity with a
unique script path and add `#NoTrayIcon`; they are removed after a worker exits
and by `--cleanup` if a run is interrupted. Main passes the worker marker to
every ChatWindow launch route, and probes use it to select the correct process.

E2E Main and ChatWindow instances do not register global hotkeys. Windows stay
off-screen and are not activated. Cleanup uses owned PIDs and E2E worker,
generated-Main, WebView2, and internal-worker command-line markers. It never
uses a blanket `AutoHotkey64.exe` kill and never targets unrelated Node or
WebView2 processes.

`--status` reports the parent and worker PIDs, selected IDs, run root, progress,
current scenario/stage, recent results, CDP target URLs/page state, and the
worker `LLM_Debug_Log.txt` tail. A successful run removes its private run root;
failed runs retain worker data snapshots. `--cleanup` is recoverable after a
hard interruption and reports when a parent, worker, lock, generated script, or
temporary directory could not be removed.

## Files

| File | Purpose |
|---|---|
| `cdp.js` | Minimal CDP client with command timeouts and socket-close rejection |
| `mock-llm-server.js` | Local deterministic fake HTTP LLM and search backends |
| `fake-codex-cli.js` | Deterministic Codex CLI stand-in used by real-app Codex transport scenarios |
| `seed.js` | Writes settings and creates/seeds SQLite fixtures |
| `launch.js` | Explicit worker sandbox launch, CDP discovery, and marker-scoped process cleanup |
| `probe.ahk` | Worker-aware Win32/window/process probes and Main-to-ChatWindow IPC probes |
| `e2e-suite.js` | CLI, weighted sharding, worker reports/status, CDP setup, and marked-process cleanup |
| `scenarios/*.js` | Numbered bug-verification scenarios grouped by area |
| `scenarios/helpers.js` | Shared probes, UI navigation, and CDP helpers |
| `capture-screenshots.js` | Off-screen screenshot utility |
| `verify-cleanup.js` | Off-screen pipeline cleanup/leak verification |
| `BUG_HUNT_REPORT.md` | Bug list, evidence, and scenario workflow |

The screenshot and cleanup utilities use the same explicit worker data-dir and
process-marker contract as `e2e-suite.js`; no headless utility swaps the real
profile.

## Scenarios

A scenario seeds an isolated state, optionally starts a local mock server,
launches the real app, connects to WebView2, performs the reproduction, and
returns evidence or throws an assertion error. `PASS` means the scenario's
expected behavior was observed. `--all` writes the canonical merged report to
`results/headless-verification.txt`; workers write only private `report.json`
files.

Scenario helpers include `openSettings`, `openSection`, `saveSettings`,
`hideSettingsToChat`, `sendChatMessage`, `waitStreamingIdle`, `runProbe`,
`readJsonFile`, and `seed.query`. A CDP postMessage hook is available through
the `cdp` object.

## Probe and environment notes

- AHK probe output and app settings can have UTF-8 BOMs; helpers strip them.
- Standalone probes must define every referenced AHK symbol and use a watchdog.
- Do not use physical keyboard injection in an automated scenario: it can leak
  input into the user's interactive desktop.
- The real app should be closed before the suite even though each worker has a
  separate data and WebView2 environment.

## Interrupted runs and artifacts

The parent lock is `%TEMP%\ahkllm-e2e-parent.lock`. Worker reports are updated
after each stage and scenario, so `--status` remains useful during long runs.
On Ctrl+C/SIGTERM the parent stops its internal workers and marked E2E app
processes, removes generated worker scripts, and releases the lock. If the
parent itself is hard-killed, run `--cleanup`; it first verifies the lock PID is
an E2E parent before terminating it and then sweeps only marked E2E artifacts.

The canonical results file is intentionally ignored by Git. Failed worker data
snapshots are left outside the successful-run cleanup path so the failing
scenario can be investigated.
