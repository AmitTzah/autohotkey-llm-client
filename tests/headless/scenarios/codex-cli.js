// scenarios/codex-cli.js - Real-app coverage for the local Codex CLI transport.
//
// These scenarios never invoke real Codex. Each launches AhkLLM with
// CODEX_CLI_PATH pointing at an isolated .cmd shim that runs
// tests/headless/fake-codex-cli.js.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const seed = require('../seed');
const { sleep, showChat, sendChatMessage, waitStreamingIdle } = require('./helpers');

const FAKE_SCRIPT = path.join(__dirname, '..', 'fake-codex-cli.js');

function fakePaths(dataDir) {
  return {
    cli: path.join(dataDir, 'fake-codex.cmd'),
    log: path.join(dataDir, 'fake-codex-log.jsonl')
  };
}

function installFakeCodex(dataDir) {
  const p = fakePaths(dataDir);
  fs.writeFileSync(p.cli, [
    '@echo off',
    '"%FAKE_NODE_EXE%" "%FAKE_CODEX_SCRIPT%" %*',
    'exit /b %ERRORLEVEL%',
    ''
  ].join('\r\n'), 'utf8');
  fs.writeFileSync(p.log, '', 'utf8');
}

function fakeLaunchEnv({ dataDir }) {
  const p = fakePaths(dataDir);
  return {
    CODEX_CLI_PATH: p.cli,
    FAKE_NODE_EXE: process.execPath,
    FAKE_CODEX_SCRIPT: FAKE_SCRIPT,
    FAKE_CODEX_LOG: p.log
  };
}

function fakeLog(dataDir) {
  const p = fakePaths(dataDir);
  if (!fs.existsSync(p.log)) return [];
  return fs.readFileSync(p.log, 'utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse);
}

function execLog(dataDir) {
  return fakeLog(dataDir).filter((entry) => entry.kind === 'exec');
}

const scenarios = [];

scenarios.push({
  id: 329,
  name: 'Codex CLI public reasoning uses the normal Thought Process UI and persists across reload',
  regression: true,
  mode: null,
  settings: { threadTitles: { enabled: false } },
  fixtures: {
    threads: [{
      id: 't-codex-329', title: 'Codex Reasoning', active_leaf_id: 'm-codex-329-a1',
      model_override: 'codex/gpt-5.6-luna',
      system_override: 'SYSTEM-CODEX-329', system_override_set: 1,
      reasoning_override: 'medium', reasoning_override_set: 1
    }],
    messages: [
      { id: 'm-codex-329-u1', thread_id: 't-codex-329', role: 'user', content: 'prior codex user message' },
      { id: 'm-codex-329-a1', thread_id: 't-codex-329', role: 'assistant', content: 'prior codex assistant answer', parent_id: 'm-codex-329-u1', model: 'codex/gpt-5.6-luna' }
    ]
  },
  preLaunch(dataDir) { installFakeCodex(dataDir); },
  launchEnv: fakeLaunchEnv,
  async body({ cdp, dataDir, dbPath }) {
    await showChat();
    await cdp.waitFor('document.querySelectorAll("#thread-list .chat-item").length > 0', 15000, 250, 'Codex thread list');
    await cdp.eval('window.loadThread("t-codex-329"); true');
    await cdp.waitFor('window.activeThreadId === "t-codex-329" && window._currentSettings && window._currentSettings.model === "codex/gpt-5.6-luna"', 15000, 250, 'Codex thread loaded');
    await sleep(500);

    await sendChatMessage(cdp, 'basic codex reasoning ui');

    // The fake emits the same public shape observed from real Codex 0.153.4:
    // item.completed / item.type=reasoning / item.text=<public summary>.
    await cdp.waitFor(`(() => {
      const el = document.querySelector('#chat-messages .thinking-block .thinking-content');
      return !!el && el.textContent.indexOf('Comparing the requested information') >= 0;
    })()`, 15000, 100, 'Codex public reasoning visible before final answer');
    const live = await cdp.eval(`(() => {
      const block = document.querySelector('#chat-messages .thinking-block');
      const summary = block && block.querySelector('summary');
      const contents = [...document.querySelectorAll('#chat-messages .msg.bot .msg-content')].map((e) => e.textContent);
      return {
        normalThinkingClass: !!block && !block.classList.contains('activity-block'),
        summary: summary ? summary.textContent : '',
        content: block ? block.querySelector('.thinking-content').textContent : '',
        finalAlreadyVisible: contents.some((text) => text.indexOf('BASIC CODEX ANSWER') >= 0)
      };
    })()`);
    if (!live.normalThinkingClass || live.summary.indexOf('Thought Process') < 0)
      throw new Error('Codex reasoning is not using the normal Thought Process appearance: ' + JSON.stringify(live));
    if (live.finalAlreadyVisible)
      throw new Error('final answer appeared before the delayed reasoning-only checkpoint: ' + JSON.stringify(live));

    await waitStreamingIdle(cdp, 30000);
    await cdp.waitFor('[...document.querySelectorAll("#chat-messages .msg.bot .msg-content")].some((e) => e.textContent.indexOf("BASIC CODEX ANSWER") >= 0)', 10000, 200, 'Codex final answer rendered');

    const rows = seed.query(dbPath,
      "SELECT id, content, reasoning, model, provider FROM messages WHERE thread_id='t-codex-329' AND role='assistant' ORDER BY rowid DESC LIMIT 1");
    if (!rows.length) throw new Error('Codex assistant response was not persisted');
    const row = rows[0];
    if (String(row.content).trim() !== 'BASIC CODEX ANSWER')
      throw new Error('unexpected persisted Codex final answer: ' + JSON.stringify(row));
    if (String(row.reasoning).indexOf('Comparing the requested information') < 0)
      throw new Error('public Codex reasoning summary was not persisted: ' + JSON.stringify(row));
    if (String(row.reasoning).indexOf('BASIC CODEX ANSWER') >= 0)
      throw new Error('final Codex answer was duplicated into reasoning: ' + JSON.stringify(row));
    if (row.provider !== 'codex' || String(row.model).indexOf('gpt-5.6-luna') < 0)
      throw new Error('Codex provider/model attribution is wrong: ' + JSON.stringify(row));

    const execs = execLog(dataDir);
    if (execs.length !== 1)
      throw new Error('one Send must equal exactly one Codex exec; observed ' + execs.length + ': ' + JSON.stringify(execs));
    const invocation = execs[0];
    if (invocation.reasoningSummary !== 'auto' || invocation.reasoningEffort !== 'medium')
      throw new Error('Codex reasoning config did not reach the CLI: ' + JSON.stringify({ summary: invocation.reasoningSummary, effort: invocation.reasoningEffort }));
    if (invocation.stdin.indexOf('SYSTEM-CODEX-329') >= 0 || invocation.instructions.indexOf('SYSTEM-CODEX-329') < 0)
      throw new Error('system prompt must be in model instructions, not the transcript');
    if (invocation.stdin.indexOf('prior codex user message') < 0 || invocation.stdin.indexOf('prior codex assistant answer') < 0 || invocation.stdin.indexOf('basic codex reasoning ui') < 0)
      throw new Error('Codex stdin did not contain the active AhkLLM history path: ' + JSON.stringify(invocation.stdin));
    if (invocation.args.some((arg) => String(arg).toLowerCase().indexOf('temperature') >= 0))
      throw new Error('Codex invocation must not contain a temperature setting: ' + JSON.stringify(invocation.args));

    // Reload from SQLite and require the same standard thought block to render.
    await cdp.eval('window.loadThread("t-codex-329"); true');
    await cdp.waitFor(`(() => {
      const blocks = [...document.querySelectorAll('#chat-messages .thinking-block .thinking-content')];
      return blocks.some((el) => el.textContent.indexOf('Comparing the requested information') >= 0);
    })()`, 15000, 200, 'persisted Codex thought block after reload');
    const reloadText = await cdp.eval(`(() => {
      const blocks = [...document.querySelectorAll('#chat-messages .thinking-block .thinking-content')];
      const el = blocks.find((x) => x.textContent.indexOf('Comparing the requested information') >= 0);
      return el ? el.textContent : '';
    })()`);
    if (reloadText.indexOf('BASIC CODEX ANSWER') >= 0)
      throw new Error('reloaded thought block contains the final answer: ' + JSON.stringify(reloadText));

    return 'real WebView showed provider-supplied Codex reasoning in the normal Thought Process block before the final answer; DB reasoning persisted/reloaded; one Send produced one exec with medium+auto and system instructions separated from transcript';
  }
});

scenarios.push({
  id: 330,
  name: 'Codex CLI Web Search toggle routes native search on/off inside the same single exec',
  regression: true,
  mode: null,
  settings: { threadTitles: { enabled: false } },
  fixtures: {
    threads: [{
      id: 't-codex-330', title: 'Codex Search', active_leaf_id: 'm-codex-330-a1',
      model_override: 'codex/gpt-5.6-luna', reasoning_override: 'medium', reasoning_override_set: 1
    }],
    messages: [
      { id: 'm-codex-330-u1', thread_id: 't-codex-330', role: 'user', content: 'seed search conversation' },
      { id: 'm-codex-330-a1', thread_id: 't-codex-330', role: 'assistant', content: 'seed answer', parent_id: 'm-codex-330-u1', model: 'codex/gpt-5.6-luna' }
    ]
  },
  preLaunch(dataDir) { installFakeCodex(dataDir); },
  launchEnv: fakeLaunchEnv,
  async body({ cdp, dataDir, dbPath }) {
    await showChat();
    await cdp.eval('window.loadThread("t-codex-330"); true');
    await cdp.waitFor('window.activeThreadId === "t-codex-330" && window._currentSettings && window._currentSettings.model === "codex/gpt-5.6-luna"', 15000, 250, 'Codex search thread loaded');
    await sleep(500);

    const initiallyOn = await cdp.eval('document.getElementById("webSearchToggle").classList.contains("on")');
    if (initiallyOn) throw new Error('setup: Web Search should start off');
    await cdp.click('#webSearchToggle');
    await cdp.waitFor('document.getElementById("webSearchToggle").classList.contains("on") && window._currentSettings.webSearch === true', 5000, 100, 'Web Search enabled');
    await sleep(500);
    await sendChatMessage(cdp, 'search on codex');

    await cdp.waitFor(`(() => {
      const blocks = [...document.querySelectorAll('#chat-messages .thinking-block .thinking-content')];
      return blocks.some((el) => el.textContent.indexOf('Web search: fake current release') >= 0);
    })()`, 15000, 100, 'Codex web search activity visible');
    await waitStreamingIdle(cdp, 30000);
    await cdp.waitFor('[...document.querySelectorAll("#chat-messages .msg.bot .msg-content")].some((e) => e.textContent.indexOf("SEARCH ON CODEX ANSWER") >= 0)', 10000, 200, 'search-on final answer');

    await cdp.click('#webSearchToggle');
    await cdp.waitFor('!document.getElementById("webSearchToggle").classList.contains("on") && window._currentSettings.webSearch === false', 5000, 100, 'Web Search disabled');
    await sleep(500);
    await sendChatMessage(cdp, 'search off codex');
    await waitStreamingIdle(cdp, 30000);
    await cdp.waitFor('[...document.querySelectorAll("#chat-messages .msg.bot .msg-content")].some((e) => e.textContent.indexOf("SEARCH OFF CODEX ANSWER") >= 0)', 10000, 200, 'search-off final answer');

    const execs = execLog(dataDir);
    if (execs.length !== 2)
      throw new Error('two deliberate Sends must produce exactly two Codex execs: ' + JSON.stringify(execs));
    const on = execs[0], off = execs[1];
    if (!on.args.includes('--search') || on.webSearchMode !== 'live')
      throw new Error('Web Search ON did not use --search + web_search="live": ' + JSON.stringify(on));
    if (off.args.includes('--search') || off.webSearchMode !== 'disabled')
      throw new Error('Web Search OFF did not remove --search + force disabled: ' + JSON.stringify(off));

    const rows = seed.query(dbPath,
      "SELECT content, reasoning FROM messages WHERE thread_id='t-codex-330' AND role='assistant' ORDER BY rowid DESC LIMIT 2").reverse();
    if (rows.length !== 2)
      throw new Error('expected two new Codex assistant responses: ' + JSON.stringify(rows));
    if (String(rows[0].content).trim() !== 'SEARCH ON CODEX ANSWER' || String(rows[0].reasoning).indexOf('Web search: fake current release') < 0)
      throw new Error('search-on response did not persist the native search trace: ' + JSON.stringify(rows[0]));
    if (String(rows[1].content).trim() !== 'SEARCH OFF CODEX ANSWER' || String(rows[1].reasoning).indexOf('Web search:') >= 0)
      throw new Error('search-off response unexpectedly contains native search activity: ' + JSON.stringify(rows[1]));

    return 'Web Search ON used --search + web_search=live and persisted one web-search trace; OFF used no --search + web_search=disabled; exactly one exec per Send';
  }
});

scenarios.push({
  id: 331,
  name: 'Codex CLI Stop kills the fake process tree, clears UI state, and the next Send succeeds',
  regression: true,
  mode: null,
  settings: { threadTitles: { enabled: false } },
  fixtures: {
    threads: [{
      id: 't-codex-331', title: 'Codex Cancel', active_leaf_id: 'm-codex-331-a1',
      model_override: 'codex/gpt-5.6-luna', reasoning_override: 'medium', reasoning_override_set: 1
    }],
    messages: [
      { id: 'm-codex-331-u1', thread_id: 't-codex-331', role: 'user', content: 'seed cancel conversation' },
      { id: 'm-codex-331-a1', thread_id: 't-codex-331', role: 'assistant', content: 'seed answer', parent_id: 'm-codex-331-u1', model: 'codex/gpt-5.6-luna' }
    ]
  },
  preLaunch(dataDir) { installFakeCodex(dataDir); },
  launchEnv: fakeLaunchEnv,
  async body({ cdp, dataDir, dbPath }) {
    await showChat();
    await cdp.eval('window.loadThread("t-codex-331"); true');
    await cdp.waitFor('window.activeThreadId === "t-codex-331" && window._currentSettings && window._currentSettings.model === "codex/gpt-5.6-luna"', 15000, 250, 'Codex cancel thread loaded');
    await sleep(500);

    await sendChatMessage(cdp, 'cancel this codex request');
    await cdp.waitFor(`(() => {
      const el = document.querySelector('#chat-messages .thinking-block .thinking-content');
      return !!el && el.textContent.indexOf('Beginning a cancellable Codex response') >= 0;
    })()`, 15000, 100, 'partial Codex reasoning before Stop');
    await cdp.waitFor('document.getElementById("chat-send-btn") && !document.getElementById("chat-send-btn").disabled', 5000, 100, 'Stop button enabled');

    let execs = execLog(dataDir);
    if (execs.length !== 1 || !execs[0].pid)
      throw new Error('fake Codex cancel exec was not captured: ' + JSON.stringify(execs));
    const cancelledPid = Number(execs[0].pid);
    await cdp.clearPosted();
    await cdp.click('#chat-send-btn');
    try {
      await cdp.waitFor('typeof isLoading !== "undefined" && !isLoading && typeof streamState !== "undefined" && !streamState.active', 15000, 100, 'Codex cancellation returned UI to idle');
    } catch (e) {
      let pidAliveAtTimeout = false;
      try { process.kill(cancelledPid, 0); pidAliveAtTimeout = true; } catch {}
      const state = await cdp.eval(`(() => {
        const input = document.getElementById('chat-input');
        const send = document.getElementById('chat-send-btn');
        return {
          isLoading: typeof isLoading !== 'undefined' ? isLoading : null,
          streamActive: typeof streamState !== 'undefined' ? streamState.active : null,
          streamFinalized: typeof streamState !== 'undefined' ? streamState.finalized : null,
          inputDisabled: input ? input.disabled : null,
          sendDisabled: send ? send.disabled : null,
          sendHtml: send ? send.innerHTML : null,
          posted: (window.__posted || []).slice(-8)
        };
      })()`);
      const debugLogPath = path.join(process.env.TEMP || process.env.TMP || dataDir, 'LLM_Debug_Log.txt');
      let debugTail = [];
      try {
        if (fs.existsSync(debugLogPath))
          debugTail = fs.readFileSync(debugLogPath, 'utf8').split(/\r?\n/).filter(Boolean).slice(-80);
      } catch {}
      throw new Error(e.message + ' state=' + JSON.stringify({ ...state, pidAliveAtTimeout, execs: execLog(dataDir), debugTail }));
    }
    await cdp.waitFor('document.getElementById("chat-input") && !document.getElementById("chat-input").disabled', 5000, 100, 'composer re-enabled after Codex Stop');
    await sleep(600);

    let pidAlive = false;
    try { process.kill(cancelledPid, 0); pidAlive = true; } catch {}
    if (pidAlive)
      throw new Error('cancelled fake Codex node process is still alive: pid=' + cancelledPid);
    const cancelledFinal = seed.query(dbPath,
      "SELECT content FROM messages WHERE thread_id='t-codex-331' AND role='assistant'")
      .filter((row) => String(row.content).trim() === 'BASIC CODEX ANSWER').length;
    if (cancelledFinal !== 0)
      throw new Error('cancelled Codex request persisted an unexpected final answer');

    await sendChatMessage(cdp, 'basic codex after cancellation');
    await waitStreamingIdle(cdp, 30000);
    await cdp.waitFor('[...document.querySelectorAll("#chat-messages .msg.bot .msg-content")].some((e) => e.textContent.indexOf("BASIC CODEX ANSWER") >= 0)', 10000, 200, 'post-cancel Codex request succeeded');
    execs = execLog(dataDir);
    if (execs.length !== 2)
      throw new Error('cancel + next Send must produce exactly two Codex execs: ' + JSON.stringify(execs));
    const persisted = seed.query(dbPath,
      "SELECT content FROM messages WHERE thread_id='t-codex-331' AND role='assistant'")
      .filter((row) => String(row.content).trim() === 'BASIC CODEX ANSWER').length;
    if (persisted !== 1)
      throw new Error('post-cancel Codex response was not persisted exactly once: ' + persisted);

    return 'Stop killed the fake Codex process tree (pid ' + cancelledPid + ' exited), UI returned to idle, and the next deliberate Send succeeded with one additional exec';
  }
});

scenarios.push({
  id: 332,
  name: 'Codex CLI reasoning/final response stay scoped to the originating thread after a mid-request switch',
  regression: true,
  mode: null,
  settings: { threadTitles: { enabled: false } },
  fixtures: {
    threads: [
      { id: 't-codex-a-332', title: 'Codex A', active_leaf_id: 'm-codex-a-332-a1', model_override: 'codex/gpt-5.6-luna', reasoning_override: 'medium', reasoning_override_set: 1 },
      { id: 't-codex-b-332', title: 'Codex B', active_leaf_id: 'm-codex-b-332-a1', model_override: 'codex/gpt-5.6-luna', reasoning_override: 'medium', reasoning_override_set: 1 }
    ],
    messages: [
      { id: 'm-codex-a-332-u1', thread_id: 't-codex-a-332', role: 'user', content: 'thread A seed' },
      { id: 'm-codex-a-332-a1', thread_id: 't-codex-a-332', role: 'assistant', content: 'A seed answer', parent_id: 'm-codex-a-332-u1', model: 'codex/gpt-5.6-luna' },
      { id: 'm-codex-b-332-u1', thread_id: 't-codex-b-332', role: 'user', content: 'thread B seed' },
      { id: 'm-codex-b-332-a1', thread_id: 't-codex-b-332', role: 'assistant', content: 'B seed answer', parent_id: 'm-codex-b-332-u1', model: 'codex/gpt-5.6-luna' }
    ]
  },
  preLaunch(dataDir) { installFakeCodex(dataDir); },
  launchEnv: fakeLaunchEnv,
  async body({ cdp, dataDir, dbPath }) {
    await showChat();
    await cdp.eval('window.loadThread("t-codex-a-332"); true');
    await cdp.waitFor('window.activeThreadId === "t-codex-a-332"', 15000, 250, 'Codex thread A loaded');
    await sleep(500);
    await sendChatMessage(cdp, 'slow thread A');
    await cdp.waitFor(`(() => {
      const el = document.querySelector('#chat-messages .thinking-block .thinking-content');
      return !!el && el.textContent.indexOf('Working on the originating thread') >= 0;
    })()`, 15000, 100, 'thread A Codex reasoning visible');

    await cdp.eval('window.loadThread("t-codex-b-332"); true');
    await cdp.waitFor('window.activeThreadId === "t-codex-b-332" && chatMessages.some((m) => m.id === "m-codex-b-332-a1")', 15000, 250, 'switched to Codex thread B');
    await sleep(300);
    const duringB = await cdp.eval(`({
      text: document.getElementById('chat-messages').textContent,
      ids: chatMessages.map((m) => m.id)
    })`);
    if (String(duringB.text).indexOf('Working on the originating thread') >= 0)
      throw new Error('thread A Codex reasoning painted into thread B: ' + JSON.stringify(duringB));

    await waitStreamingIdle(cdp, 30000);
    await sleep(500);
    const afterB = await cdp.eval(`({
      active: window.activeThreadId,
      text: document.getElementById('chat-messages').textContent,
      contents: chatMessages.map((m) => m.content)
    })`);
    if (afterB.active !== 't-codex-b-332' || String(afterB.text).indexOf('THREAD A CODEX ANSWER') >= 0 || String(afterB.text).indexOf('Working on the originating thread') >= 0)
      throw new Error('Codex completion leaked into the visible non-origin thread: ' + JSON.stringify(afterB));

    const aRows = seed.query(dbPath,
      "SELECT content, reasoning FROM messages WHERE thread_id='t-codex-a-332' AND role='assistant' ORDER BY rowid DESC LIMIT 1");
    const bLeak = seed.query(dbPath,
      "SELECT COUNT(*) AS c FROM messages WHERE thread_id='t-codex-b-332' AND (content='THREAD A CODEX ANSWER' OR reasoning LIKE '%Working on the originating thread%')")[0].c;
    if (!aRows.length || String(aRows[0].content).trim() !== 'THREAD A CODEX ANSWER' || String(aRows[0].reasoning).indexOf('Working on the originating thread') < 0)
      throw new Error('originating thread did not persist Codex final+reasoning correctly: ' + JSON.stringify(aRows));
    if (bLeak !== 0)
      throw new Error('Codex response was persisted into thread B: leak rows=' + bLeak);
    if (execLog(dataDir).length !== 1)
      throw new Error('thread switch must not create another Codex exec');

    await cdp.eval('window.loadThread("t-codex-a-332"); true');
    await cdp.waitFor(`(() => {
      const text = document.getElementById('chat-messages').textContent;
      return text.indexOf('THREAD A CODEX ANSWER') >= 0 && text.indexOf('Working on the originating thread') >= 0;
    })()`, 15000, 200, 'originating Codex thread reload');

    return 'started Codex in A, switched to B after public reasoning, observed no A progress/final in B; DB stored both only in A and reload restored them; one exec total';
  }
});

scenarios.push({
  id: 333,
  name: 'Codex CLI two-turn history keeps a byte-identical transcript prefix and reports cached input tokens',
  regression: true,
  mode: null,
  settings: { threadTitles: { enabled: false } },
  fixtures: {
    threads: [{
      id: 't-codex-333', title: 'Codex History', active_leaf_id: 'm-codex-333-a1',
      model_override: 'codex/gpt-5.6-luna', reasoning_override: 'low', reasoning_override_set: 1
    }],
    messages: [
      { id: 'm-codex-333-u1', thread_id: 't-codex-333', role: 'user', content: 'history nonce ALPHA-333' },
      { id: 'm-codex-333-a1', thread_id: 't-codex-333', role: 'assistant', content: 'I saw ALPHA-333', parent_id: 'm-codex-333-u1', model: 'codex/gpt-5.6-luna' }
    ]
  },
  preLaunch(dataDir) { installFakeCodex(dataDir); },
  launchEnv: fakeLaunchEnv,
  async body({ cdp, dataDir, dbPath }) {
    await showChat();
    await cdp.eval('window.loadThread("t-codex-333"); true');
    await cdp.waitFor('window.activeThreadId === "t-codex-333" && window._currentSettings && window._currentSettings.model === "codex/gpt-5.6-luna"', 15000, 250, 'Codex history thread loaded');
    await sleep(500);

    await sendChatMessage(cdp, 'first codex turn');
    await waitStreamingIdle(cdp, 30000);
    await cdp.waitFor('[...document.querySelectorAll("#chat-messages .msg.bot .msg-content")].some((e) => e.textContent.indexOf("BASIC CODEX ANSWER") >= 0)', 10000, 200, 'first Codex answer');

    await sendChatMessage(cdp, 'second codex turn');
    await waitStreamingIdle(cdp, 30000);
    await cdp.waitFor('[...document.querySelectorAll("#chat-messages .msg.bot .msg-content")].some((e) => e.textContent.indexOf("SECOND CODEX ANSWER") >= 0)', 10000, 200, 'second Codex answer');

    const execs = execLog(dataDir);
    if (execs.length !== 2)
      throw new Error('two Sends must equal exactly two Codex execs: ' + JSON.stringify(execs));
    if (!execs[1].stdin.startsWith(execs[0].stdin))
      throw new Error('second Codex transcript lost the byte-identical first-turn prefix: first=' + JSON.stringify(execs[0].stdin) + ' second=' + JSON.stringify(execs[1].stdin));
    if (execs[1].stdin.indexOf('history nonce ALPHA-333') < 0 || execs[1].stdin.indexOf('BASIC CODEX ANSWER') < 0 || execs[1].stdin.indexOf('second codex turn') < 0)
      throw new Error('second Codex transcript is missing active-path history: ' + JSON.stringify(execs[1].stdin));
    if (execs[0].reasoningEffort !== 'low' || execs[1].reasoningEffort !== 'low')
      throw new Error('per-thread low reasoning effort was not stable across turns: ' + JSON.stringify(execs.map((e) => e.reasoningEffort)));

    const rows = seed.query(dbPath,
      "SELECT content, cached_tokens FROM messages WHERE thread_id='t-codex-333' AND role='assistant' ORDER BY rowid DESC LIMIT 2").reverse();
    if (rows.length !== 2 || String(rows[0].content).trim() !== 'BASIC CODEX ANSWER' || String(rows[1].content).trim() !== 'SECOND CODEX ANSWER')
      throw new Error('two Codex responses were not persisted in order: ' + JSON.stringify(rows));
    if (Number(rows[1].cached_tokens) !== 21)
      throw new Error('second Codex turn did not persist cached_input_tokens=21: ' + JSON.stringify(rows[1]));

    return 'two sequential Sends produced exactly two execs; turn 2 stdin starts with turn 1 stdin byte-for-byte, includes the prior assistant response, keeps low reasoning, and persists cached_input_tokens=21';
  }
});

scenarios.push({
  id: 334,
  name: 'Selecting a Codex model hides the unsupported Temperature control immediately and switching back restores it',
  regression: true,
  mode: null,
  settings: { threadTitles: { enabled: false } },
  fixtures: {
    threads: [{
      id: 't-codex-temp-334', title: 'Codex Temperature UI', active_leaf_id: 'm-codex-temp-334-a1',
      model_override: 'deepseek/deepseek-v4-flash'
    }],
    messages: [
      { id: 'm-codex-temp-334-u1', thread_id: 't-codex-temp-334', role: 'user', content: 'temperature ui seed' },
      { id: 'm-codex-temp-334-a1', thread_id: 't-codex-temp-334', role: 'assistant', content: 'seed answer', parent_id: 'm-codex-temp-334-u1', model: 'deepseek/deepseek-v4-flash' }
    ]
  },
  async body({ cdp }) {
    await showChat();
    await cdp.eval('window.loadThread("t-codex-temp-334"); true');
    await cdp.waitFor('window.activeThreadId === "t-codex-temp-334" && window._currentSettings && window._currentSettings.model === "deepseek/deepseek-v4-flash"', 15000, 250, 'temperature UI seed thread loaded');
    await cdp.waitFor('window.modelList && window.modelList.codex && window.modelList.codex.length > 0 && window.modelList.deepseek && window.modelList.deepseek.length > 0', 15000, 250, 'model picker list including Codex');

    const initial = await cdp.eval(`(() => {
      const slider = document.getElementById('tempSlider');
      return !!slider && !!slider.parentElement && getComputedStyle(slider.parentElement).display !== 'none' && !slider.disabled;
    })()`);
    if (!initial) throw new Error('setup: Temperature should be visible for the DeepSeek seed model');

    await cdp.click('#modelCardTrigger');
    await cdp.waitFor('document.getElementById("modelPopover").classList.contains("open") && document.querySelectorAll("#tab-models .selector-item").length > 0', 5000, 100, 'model picker opened');
    const codexState = await cdp.eval(`(() => {
      const items = [...document.querySelectorAll('#tab-models .selector-item')];
      const item = items.find((el) => {
        const provider = el.querySelector('.si-desc');
        const name = el.querySelector('.si-name');
        return provider && provider.textContent.trim().toLowerCase() === 'codex' && name && name.textContent.indexOf('gpt-5.6-luna') >= 0;
      });
      if (!item) return { found: false };
      const meta = (window.modelList.codex || []).find((m) => m.fullId === 'codex/gpt-5.6-luna');
      const rawSupportsTemperature = meta ? meta.supportsTemperature : undefined;
      item.click();
      const slider = document.getElementById('tempSlider');
      return {
        found: true,
        rawSupportsTemperature: rawSupportsTemperature,
        model: window._currentSettings && window._currentSettings.model,
        supportsTemperature: window._currentSettings && window._currentSettings.supportsTemperature,
        display: slider && slider.parentElement ? slider.parentElement.style.display : null,
        disabled: slider ? slider.disabled : null
      };
    })()`);
    if (!codexState.found)
      throw new Error('Codex Luna item was not present in the real model picker');
    if (codexState.model !== 'codex/gpt-5.6-luna' || codexState.supportsTemperature !== false || codexState.display !== 'none' || codexState.disabled !== true)
      throw new Error('Temperature was not hidden synchronously when Codex was selected: ' + JSON.stringify(codexState));

    // The AHK updateModelSettings round trip must preserve the same capability
    // state instead of re-showing the control after the local click update.
    await cdp.waitFor(`(() => {
      const slider = document.getElementById('tempSlider');
      return window._currentSettings && window._currentSettings.model === 'codex/gpt-5.6-luna'
        && window._currentSettings.supportsTemperature === false
        && slider && slider.parentElement && slider.parentElement.style.display === 'none' && slider.disabled;
    })()`, 5000, 100, 'Codex temperature capability preserved after AHK round trip');

    await cdp.click('#modelCardTrigger');
    await cdp.waitFor('document.getElementById("modelPopover").classList.contains("open")', 5000, 100, 'model picker reopened');
    const normalState = await cdp.eval(`(() => {
      const items = [...document.querySelectorAll('#tab-models .selector-item')];
      const item = items.find((el) => {
        const provider = el.querySelector('.si-desc');
        const name = el.querySelector('.si-name');
        return provider && provider.textContent.trim().toLowerCase() === 'deepseek' && name && name.textContent.indexOf('deepseek-v4-flash') >= 0;
      });
      if (!item) return { found: false };
      item.click();
      const slider = document.getElementById('tempSlider');
      return {
        found: true,
        model: window._currentSettings && window._currentSettings.model,
        supportsTemperature: window._currentSettings && window._currentSettings.supportsTemperature,
        display: slider && slider.parentElement ? slider.parentElement.style.display : null,
        disabled: slider ? slider.disabled : null
      };
    })()`);
    if (!normalState.found)
      throw new Error('DeepSeek model item was not present when switching back');
    if (normalState.model !== 'deepseek/deepseek-v4-flash' || normalState.supportsTemperature !== true || normalState.display !== '' || normalState.disabled !== false)
      throw new Error('Temperature was not restored synchronously for a supported model: ' + JSON.stringify(normalState));

    await cdp.waitFor(`(() => {
      const slider = document.getElementById('tempSlider');
      return window._currentSettings && window._currentSettings.model === 'deepseek/deepseek-v4-flash'
        && window._currentSettings.supportsTemperature === true
        && slider && slider.parentElement && slider.parentElement.style.display !== 'none' && !slider.disabled;
    })()`, 5000, 100, 'temperature restored after AHK round trip');

    return 'real model-picker click hid Temperature synchronously for codex/gpt-5.6-luna, the AHK settings round trip kept it hidden, and switching back to DeepSeek restored it';
  }
});

scenarios.push({
  id: 335,
  name: 'Switching direct models preserves the thread System Message in the right rail and after the AHK round trip',
  regression: true,
  mode: null,
  settings: { threadTitles: { enabled: false } },
  fixtures: {
    threads: [{
      id: 't-model-system-335', title: 'Model Switch System Message', active_leaf_id: 'm-model-system-335-a1',
      model_override: 'deepseek/deepseek-v4-flash',
      system_override: 'KEEP-SYSTEM-335', system_override_set: 1
    }],
    messages: [
      { id: 'm-model-system-335-u1', thread_id: 't-model-system-335', role: 'user', content: 'system message switch seed' },
      { id: 'm-model-system-335-a1', thread_id: 't-model-system-335', role: 'assistant', content: 'seed answer', parent_id: 'm-model-system-335-u1', model: 'deepseek/deepseek-v4-flash' }
    ]
  },
  async body({ cdp, dbPath }) {
    await showChat();
    await cdp.eval('window.loadThread("t-model-system-335"); true');
    await cdp.waitFor(`window.activeThreadId === 't-model-system-335'
      && window._currentSettings
      && window._currentSettings.model === 'deepseek/deepseek-v4-flash'
      && window._currentSettings.systemMessage === 'KEEP-SYSTEM-335'
      && window._currentSettings.systemOverrideSet === true
      && document.getElementById('sysMsgMini').value === 'KEEP-SYSTEM-335'`, 15000, 250, 'seed model + system message loaded');
    await cdp.waitFor('window.modelList && window.modelList.codex && window.modelList.codex.length > 0', 15000, 250, 'Codex model list available');
    await cdp.clearPosted();

    await cdp.click('#modelCardTrigger');
    await cdp.waitFor('document.getElementById("modelPopover").classList.contains("open") && document.querySelectorAll("#tab-models .selector-item").length > 0', 5000, 100, 'model picker opened');

    const immediate = await cdp.eval(`(() => {
      const item = [...document.querySelectorAll('#tab-models .selector-item')].find((el) => {
        const provider = el.querySelector('.si-desc');
        const name = el.querySelector('.si-name');
        return provider && provider.textContent.trim().toLowerCase() === 'codex'
          && name && name.textContent.indexOf('gpt-5.6-luna') >= 0;
      });
      if (!item) return { found: false };
      item.click();
      return {
        found: true,
        model: window._currentSettings && window._currentSettings.model,
        systemMessage: window._currentSettings && window._currentSettings.systemMessage,
        systemOverrideSet: window._currentSettings && window._currentSettings.systemOverrideSet,
        fieldValue: document.getElementById('sysMsgMini').value
      };
    })()`);
    if (!immediate.found)
      throw new Error('Codex Luna item was not present in the real model picker');
    if (immediate.model !== 'codex/gpt-5.6-luna' || immediate.systemMessage !== 'KEEP-SYSTEM-335'
        || immediate.systemOverrideSet !== true || immediate.fieldValue !== 'KEEP-SYSTEM-335')
      throw new Error('model switch cleared the System Message synchronously: ' + JSON.stringify(immediate));

    await cdp.waitFor(`window.__posted && window.__posted.some((raw) => {
      try {
        const msg = JSON.parse(raw);
        return msg.action === 'updateModelSettings'
          && msg.model === 'codex/gpt-5.6-luna'
          && msg.systemMessage === 'KEEP-SYSTEM-335'
          && msg.systemOverrideSet === true;
      } catch (_) { return false; }
    })`, 5000, 100, 'model switch settings posted with preserved System Message');

    let rows = [];
    const persistDeadline = Date.now() + 5000;
    while (Date.now() < persistDeadline) {
      rows = seed.query(dbPath,
        "SELECT model_override, system_override, system_override_set FROM chat_threads WHERE id='t-model-system-335'");
      if (rows.length && rows[0].model_override === 'codex/gpt-5.6-luna'
          && rows[0].system_override === 'KEEP-SYSTEM-335' && Number(rows[0].system_override_set) === 1)
        break;
      await sleep(100);
    }
    if (!rows.length || rows[0].model_override !== 'codex/gpt-5.6-luna'
        || rows[0].system_override !== 'KEEP-SYSTEM-335' || Number(rows[0].system_override_set) !== 1)
      throw new Error('persisted thread settings lost the System Message on model switch: ' + JSON.stringify(rows));

    await cdp.waitFor(`window._currentSettings
      && window._currentSettings.model === 'codex/gpt-5.6-luna'
      && window._currentSettings.systemMessage === 'KEEP-SYSTEM-335'
      && window._currentSettings.systemOverrideSet === true
      && document.getElementById('sysMsgMini').value === 'KEEP-SYSTEM-335'`, 5000, 100, 'System Message preserved after AHK persistence round trip');

    await cdp.eval('window.loadThread("t-model-system-335"); true');
    await cdp.waitFor(`window._currentSettings
      && window._currentSettings.model === 'codex/gpt-5.6-luna'
      && window._currentSettings.systemMessage === 'KEEP-SYSTEM-335'
      && document.getElementById('sysMsgMini').value === 'KEEP-SYSTEM-335'`, 10000, 200, 'System Message restored after thread reload');

    return 'direct model switch preserved the custom System Message immediately, through the AHK round trip, in SQLite, and after reload';
  }
});

module.exports = scenarios;
