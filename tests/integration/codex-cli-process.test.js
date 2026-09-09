'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const AHK = process.env.AHK_EXE || 'C:\\Program Files\\AutoHotkey\\v2\\AutoHotkey64.exe';
const FIXTURE = path.join(__dirname, 'CodexCliProcessSmoke.ahk');

describe('Codex CLI process transport', () => {
  it('streams safe fake Codex lifecycle events and still performs exactly one exec', { timeout: 20000 }, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ahkllm-codex-smoke-'));
    const fakeCli = path.join(dir, 'fake codex.cmd');
    const fakeJs = path.join(dir, 'fake-codex.js');
    const argsFile = path.join(dir, 'args.txt');
    const stdinFile = path.join(dir, 'stdin.txt');
    const invocationsFile = path.join(dir, 'invocations.jsonl');
    const progressMarker = path.join(dir, 'progress-seen.txt');
    const resultFile = path.join(dir, 'result.json');
    const requestFile = path.join(dir, 'request.json');

    // npm-installed CLIs on Windows use a .cmd shim that forwards %* to a
    // real executable. Mirror that boundary so Node performs the same Windows
    // command-line parsing the official Codex launcher ultimately sees.
    fs.writeFileSync(fakeCli, [
      '@echo off',
      '"%FAKE_NODE_EXE%" "%FAKE_CODEX_JS%" %*',
      'exit /b %ERRORLEVEL%',
      ''
    ].join('\r\n'), 'utf8');

    fs.writeFileSync(fakeJs, [
      "'use strict';",
      "const fs = require('node:fs');",
      "const args = process.argv.slice(2);",
      "fs.writeFileSync(process.env.FAKE_CODEX_ARGS, args.join('\\n'), 'utf8');",
      "fs.appendFileSync(process.env.FAKE_CODEX_INVOCATIONS, JSON.stringify(args) + '\\n', 'utf8');",
      "if (args.length === 1 && args[0] === '--version') { process.stdout.write('codex-cli 0.153.4\\n'); process.exit(0); }",
      "if (args[0] === 'login' && args[1] === 'status') { process.stdout.write('Logged in using ChatGPT\\n'); process.exit(0); }",
      "const emit = (obj, newline = true) => process.stdout.write(JSON.stringify(obj) + (newline ? '\\n' : ''));",
      "const waitForProgress = (deadline, cb) => {",
      "  if (fs.existsSync(process.env.FAKE_CODEX_PROGRESS_MARKER)) return cb();",
      "  if (Date.now() >= deadline) { process.stderr.write('progress callback was not observed while fake Codex was alive\\n'); process.exitCode = 8; return; }",
      "  setTimeout(() => waitForProgress(deadline, cb), 25);",
      "};",
      "let input = '';",
      "process.stdin.setEncoding('utf8');",
      "process.stdin.on('data', chunk => { input += chunk; });",
      "process.stdin.on('end', () => {",
      "  fs.writeFileSync(process.env.FAKE_CODEX_STDIN, input, 'utf8');",
      "  const at = args.indexOf('--output-last-message');",
      "  if (at < 0 || !args[at + 1]) { process.exitCode = 9; return; }",
      "  emit({type:'item.completed',item:{id:'item-commentary',type:'agent_message',text:'I will compare the sources first.'}});",
      "  setTimeout(() => {",
      "    const reasoning = JSON.stringify({type:'item.completed',item:{id:'item-reasoning',type:'reasoning',text:'Checking the release source'}});",
      "    const cut = Math.floor(reasoning.length / 2);",
      "    process.stdout.write(reasoning.slice(0, cut));",
      "    setTimeout(() => {",
      "      process.stdout.write(reasoning.slice(cut) + '\\n');",
      "      waitForProgress(Date.now() + 2000, () => {",
      "        // Leave the file unchanged across several transport polls. If the",
      "        // poller replays already-consumed lines, the assertions will see",
      "        // duplicate commentary/reasoning callbacks.",
      "        setTimeout(() => {",
      "          process.stdout.write('harmless non-json diagnostic line\\n');",
      "          emit({type:'item.started',item:{id:'item-search',type:'web_search'}});",
      "          setTimeout(() => {",
      "            emit({type:'item.completed',item:{id:'item-search',type:'web_search',query:'latest release'}});",
      "            emit({type:'item.completed',item:{id:'item-final',type:'agent_message',text:'fake codex answer'}});",
      "            fs.writeFileSync(args[at + 1], 'fake codex answer\\n', 'utf8');",
      "            // Deliberately omit the trailing newline on the final JSONL",
      "            // record. Completed extraction must still parse usage, and the",
      "            // post-exit progress drain must treat the stable segment as complete.",
      "            emit({type:'turn.completed',usage:{input_tokens:21,output_tokens:4,cached_input_tokens:13,total_tokens:25}}, false);",
      "          }, 180);",
      "        }, 250);",
      "      });",
      "    }, 180);",
      "  }, 80);",
      "});",
      ''
    ].join('\n'), 'utf8');

    fs.writeFileSync(requestFile, JSON.stringify({ messages: [
      { role: 'system', content: 'Stable system prompt' },
      { role: 'user', content: 'SECRET-PROMPT-TEXT' }
    ] }), 'utf8');

    try {
      const env = {
        ...process.env,
        CODEX_CLI_PATH: fakeCli,
        FAKE_NODE_EXE: process.execPath,
        FAKE_CODEX_JS: fakeJs,
        FAKE_CODEX_ARGS: argsFile,
        FAKE_CODEX_STDIN: stdinFile,
        FAKE_CODEX_INVOCATIONS: invocationsFile,
        FAKE_CODEX_PROGRESS_MARKER: progressMarker
      };
      const res = spawnSync(AHK, [FIXTURE, resultFile, requestFile], {
        cwd: REPO_ROOT,
        env,
        windowsHide: true,
        encoding: 'utf8',
        timeout: 15000
      });
      assert.ifError(res.error);
      assert.strictEqual(res.status, 0, 'AHK smoke fixture failed: ' + (res.stderr || res.stdout || ''));
      assert.ok(fs.existsSync(resultFile), 'smoke fixture did not write a result artifact');

      const result = JSON.parse(fs.readFileSync(resultFile, 'utf8'));
      const receivedArgs = fs.existsSync(argsFile) ? fs.readFileSync(argsFile, 'utf8') : '<no args file>';
      assert.strictEqual(result.success, 1, result.error || ('Codex transport returned failure: ' + JSON.stringify(result) + ' argv=' + receivedArgs));
      assert.strictEqual(result.answer.trim(), 'fake codex answer');
      assert.strictEqual(result.promptTokens, 21);
      assert.strictEqual(result.cachedTokens, 13);
      assert.strictEqual(result.webSearchCalls, 1);
      assert.strictEqual(result.preflightInstalled, 1, 'Codex preflight should detect the CLI');
      assert.strictEqual(result.preflightSupported, 1, 'Codex preflight should accept a recent CLI');
      assert.strictEqual(result.preflightAuthenticated, 1, 'Codex preflight should detect ChatGPT login');
      assert.strictEqual(result.preflightVersion, '0.153.4');
      assert.ok(fs.existsSync(progressMarker), 'fake Codex should observe a live progress callback before it is allowed to finish');

      const contents = result.progress.map((p) => p.content);
      assert.deepStrictEqual(contents, [
        'I will compare the sources first.\n\n',
        'Checking the release source\n\n',
        'Searching the web…\n\n',
        'Web search: latest release\n\n'
      ], 'progress callbacks should be ordered, deduplicated, and ignore malformed/partial lines');
      assert.ok(result.progress.every((p) => p.kind === 'reasoning'), 'Codex public progress must use the normal provider reasoning/Thought Process UI kind');
      assert.strictEqual(result.progress[3].searchCount, 1);
      assert.ok(result.thoughtSummary.includes('I will compare the sources first.'));
      assert.ok(result.thoughtSummary.includes('Checking the release source'));
      assert.ok(result.thoughtSummary.includes('Web search: latest release'));
      assert.ok(!result.thoughtSummary.includes('fake codex answer'), 'final answer must not be duplicated into persisted reasoning');

      const argv = fs.readFileSync(argsFile, 'utf8');
      const stdin = fs.readFileSync(stdinFile, 'utf8');
      assert.ok(!argv.includes('SECRET-PROMPT-TEXT'), 'prompt leaked into argv');
      assert.ok(stdin.includes('SECRET-PROMPT-TEXT'), 'prompt was not delivered through stdin');
      assert.strictEqual((argv.match(/^exec\r?$/gm) || []).length, 1, 'expected exactly one codex exec');
      assert.ok(argv.includes('forced_login_method="chatgpt"'), 'ChatGPT auth was not forced');
      assert.ok(argv.includes('web_search="disabled"'), 'normal chat must explicitly disable web search');
      assert.ok(argv.includes('model_reasoning_summary="auto"'), 'public reasoning-summary request did not reach Codex argv');
      assert.ok(argv.includes('model_reasoning_effort="high"'), 'reasoning effort did not reach Codex argv');
      assert.ok(argv.includes('view_image'), 'local image viewing must be disabled');
      assert.ok(argv.includes('shell_snapshot'), 'shell snapshot/file inspection must be disabled');
      assert.ok(argv.includes('code_mode_only'), 'code-mode-only execution must be disabled');
      assert.ok(!argv.includes('code_mode_host'), 'internal code_mode_host must not be disabled');

      const invocations = fs.readFileSync(invocationsFile, 'utf8').trim().split(/\r?\n/).filter(Boolean).map(JSON.parse);
      assert.strictEqual(invocations.filter((a) => a.length === 1 && a[0] === '--version').length, 1, 'ready preflight should run codex --version exactly once');
      assert.strictEqual(invocations.filter((a) => a[0] === 'login' && a[1] === 'status').length, 1, 'ready preflight should run codex login status exactly once');
      assert.strictEqual(invocations.filter((a) => a[0] === 'exec').length, 1, 'cached version/login checks must not create extra codex exec turns');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
