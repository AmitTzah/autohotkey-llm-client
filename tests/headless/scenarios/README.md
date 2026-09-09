# Scenario definitions

This folder holds the scenario definitions of the headless E2E suite. The runner
is `../e2e-suite.js`; it assembles every `module.exports` array here into one
run list, ordered by scenario id. The bug-hunt workflow that produces these
scenarios lives in `../BUG_HUNT_REPORT.md` (start there).

## Layout

| File | Area |
|---|---|
| `chat-tree.js` | Threads, fork, branch, rename, delete, trash |
| `commands.js` | Command configuration and execution |
| `settings.js` | Settings persistence and application (hotkeys, icons, tray, modals) |
| `usage-tokens.js` | Usage dashboards and token/cost accounting |
| `chat-ui.js` | Chat window UI behavior (streaming, buttons, rendering, editing) |
| `codex-cli.js` | Real-app Codex CLI transport, reasoning, search, cancellation, history/scoping |
| `misc.js` | Icons, model-id parsing, vision gating, API logs |
| `helpers.js` | Shared helpers used by scenario bodies |

Put a new scenario in the file that matches its subject. If none fits, `misc.js`
is the fallback; splitting a new area file out later is fine.

## Scenario object shape

Each file exports an array of scenario objects:

```js
{
  id: 59,                 // stable, never renumber (the report references it)
  name: 'One-line bug summary',
  regression: true,       // true = guards a FIXED bug (this is the growing
                          // regression suite); false/omitted = reproduces an
                          // open bug
  mode: 'json',           // optional: mock LLM response mode (see mock-llm-server.js);
                          // omit/null for no mock (cURL connection refused)
  settings: { ... },      // optional: merged into the isolated profile's settings.json
  fixtures: { ... },      // optional: DB seed (see ../seed.js)
  preLaunch(dataDir) { }, // optional: extra setup before the app launches
  noApp: true,            // optional: static source check, does not launch the app
  async body({ cdp, dataDir, dbPath, port, endpoint, mockLog }) {
    // The actual test. Throw to FAIL; return a string describing the result.
    // PASS means the scenario reproduced the expected behavior.
  }
}
```

`body` is passed a CDP client (`cdp.eval/click/type/waitFor` — see `../cdp.js`)
and the isolated profile's paths. `noApp: true` scenarios only get a static
source check and should not use `cdp`.

## Adding a scenario (bug-hunt flow)

1. Write the bug entry in `../BUG_HUNT_REPORT.md` (status `reported`).
2. Add a scenario object here with a new, unused scenario id.
3. Run it: `node ../e2e-suite.js --scenarios=<id>`. PASS = bug reproduced.
4. When the bug is fixed, mark the scenario `regression: true` and flip its
   assertion to expect the FIXED behavior, then re-run.
5. Run `node ../e2e-suite.js --check-sync` — it must say OK (report and
   scenarios must agree).

## Helpers and gotchas

- Import only what the file uses: node built-ins (`fs`/`path`/`os`) directly,
  `../launch` / `../seed` / `../cdp` for project modules, and the shared
  functions from `./helpers` (`runProbe`, `showChat`, `openSettings`, `sleep`,
  `readJsonFile`, ...).
- AHK probe scripts (`probe.ahk`, `probe-cost.ahk`, `probe-thinking.ahk`) live
  ONE LEVEL UP from this folder. `__dirname` here is `tests/headless/scenarios`,
  so resolve them with `path.join(__dirname, '..', 'probe-cost.ahk')`.
- Scenario ids are referenced by `../BUG_HUNT_REPORT.md` and by the results
  file. Never renumber or reuse an id, even if the bug is closed.
