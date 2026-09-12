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

scenarios.push({
  id: 336,
  name: 'Codex generated image persists across reload and reaches the next turn as visual context',
  regression: true,
  mode: null,
  settings: { threadTitles: { enabled: false } },
  fixtures: {
    threads: [{
      id: 't-codex-image-336', title: 'Codex Image Generation', active_leaf_id: 'm-codex-image-336-a1',
      model_override: 'codex/gpt-5.6-luna', reasoning_override: 'medium', reasoning_override_set: 1
    }],
    messages: [
      { id: 'm-codex-image-336-u1', thread_id: 't-codex-image-336', role: 'user', content: 'image generation seed' },
      { id: 'm-codex-image-336-a1', thread_id: 't-codex-image-336', role: 'assistant', content: 'seed answer', parent_id: 'm-codex-image-336-u1', model: 'codex/gpt-5.6-luna' }
    ]
  },
  preLaunch(dataDir) { installFakeCodex(dataDir); },
  launchEnv: fakeLaunchEnv,
  async body({ cdp, dataDir, dbPath }) {
    await showChat();
    await cdp.eval('window.loadThread("t-codex-image-336"); true');
    await cdp.waitFor(`window.activeThreadId === 't-codex-image-336'
      && window._currentSettings
      && window._currentSettings.model === 'codex/gpt-5.6-luna'`, 15000, 250, 'Codex image thread loaded');

    const initial = await cdp.eval(`(() => {
      const row = document.getElementById('imageGenerationRow');
      const sw = document.getElementById('railImageGenerationToggle');
      return {
        rowVisible: !!row && getComputedStyle(row).display !== 'none',
        on: !!sw && sw.classList.contains('on'),
        state: !!(window._currentSettings && window._currentSettings.imageGeneration)
      };
    })()`);
    if (!initial.rowVisible || initial.on || initial.state)
      throw new Error('Image Generation must be visible for Codex and default OFF: ' + JSON.stringify(initial));

    await cdp.click('#railImageGenerationToggle');
    await cdp.waitFor(`window._currentSettings && window._currentSettings.imageGeneration === true
      && document.getElementById('railImageGenerationToggle').classList.contains('on')`, 5000, 100, 'Image Generation enabled');
    await sleep(500);

    let toggleRows = seed.query(dbPath, "SELECT advanced_toggles FROM chat_threads WHERE id='t-codex-image-336'");
    if (!toggleRows.length) throw new Error('image-generation thread settings row missing');
    let toggles = {};
    try { toggles = JSON.parse(toggleRows[0].advanced_toggles || '{}'); }
    catch (e) { throw new Error('Image Generation persisted malformed advanced_toggles JSON: ' + e.message); }
    if (!toggles.imageGeneration)
      throw new Error('Image Generation ON state did not persist per thread: ' + JSON.stringify(toggleRows[0]));

    await sendChatMessage(cdp, 'generate image codex');
    await cdp.waitFor(`(() => {
      const el = document.querySelector('#chat-messages .thinking-block .thinking-content');
      return !!el && el.textContent.indexOf('Calling image generation tool') >= 0;
    })()`, 15000, 100, 'Codex image-generation public reasoning visible');
    await waitStreamingIdle(cdp, 30000);
    await cdp.waitFor('document.querySelectorAll("#chat-messages .msg.bot .msg-attachment-image img").length > 0', 10000, 200, 'generated image rendered');

    const execs = execLog(dataDir);
    if (execs.length !== 1)
      throw new Error('one Image Generation Send must produce exactly one Codex exec: ' + JSON.stringify(execs));
    const invocation = execs[0];
    if (invocation.args.includes('image_generation') && invocation.args.some((arg, i) => arg === '--disable' && invocation.args[i + 1] === 'image_generation'))
      throw new Error('Image Generation ON still disabled image_generation: ' + JSON.stringify(invocation.args));
    for (const feature of ['shell_tool', 'unified_exec', 'view_image', 'code_mode', 'apps', 'multi_agent', 'plugins', 'browser_use', 'computer_use']) {
      if (!invocation.args.some((arg, i) => arg === '--disable' && invocation.args[i + 1] === feature))
        throw new Error('Image Generation weakened unrelated Codex lockdown for ' + feature + ': ' + JSON.stringify(invocation.args));
    }

    const assistantRows = seed.query(dbPath,
      "SELECT id, content, reasoning, model, provider FROM messages WHERE thread_id='t-codex-image-336' AND role='assistant' ORDER BY rowid DESC LIMIT 1");
    if (!assistantRows.length) throw new Error('image-only Codex assistant message was not persisted');
    const assistant = assistantRows[0];
    if (String(assistant.content || '').trim() !== '')
      throw new Error('image-only fake Codex response unexpectedly persisted text: ' + JSON.stringify(assistant));
    if (String(assistant.reasoning || '').indexOf('Calling image generation tool') < 0)
      throw new Error('image-generation public reasoning was not persisted: ' + JSON.stringify(assistant));

    const attachments = seed.query(dbPath,
      'SELECT attachment_type, mime_type, original_filename, file_size, file_path FROM message_attachments WHERE message_id = ?', [assistant.id]);
    if (attachments.length !== 1)
      throw new Error('expected exactly one generated assistant attachment: ' + JSON.stringify(attachments));
    const att = attachments[0];
    const persistedImagePath = path.isAbsolute(att.file_path) ? att.file_path : path.join(dataDir, att.file_path);
    if (att.attachment_type !== 'image' || att.mime_type !== 'image/png' || Number(att.file_size) <= 8 || !fs.existsSync(persistedImagePath))
      throw new Error('generated image attachment metadata/file is invalid: ' + JSON.stringify(att));

    const rendered = await cdp.eval(`(() => {
      const img = document.querySelector('#chat-messages .msg.bot .msg-attachment-image img');
      return img ? { src: img.src.slice(0, 32), alt: img.alt } : null;
    })()`);
    if (!rendered || rendered.src.indexOf('data:image/png;base64,') !== 0)
      throw new Error('generated attachment did not render through the existing image component: ' + JSON.stringify(rendered));

    await cdp.eval('window.loadThread("t-codex-image-336"); true');
    await cdp.waitFor('document.querySelectorAll("#chat-messages .msg.bot .msg-attachment-image img").length > 0', 10000, 200, 'generated image restored after reload');
    if (execLog(dataDir).length !== 1)
      throw new Error('thread reload must not launch another Codex exec');

    await sendChatMessage(cdp, 'second codex turn: describe the generated image');
    await waitStreamingIdle(cdp, 30000);
    const followupExecs = execLog(dataDir);
    if (followupExecs.length !== 2)
      throw new Error('image follow-up must produce exactly one additional Codex exec: ' + JSON.stringify(followupExecs));
    const followup = followupExecs[1];
    const imageArgs = [];
    for (let i = 0; i < followup.args.length; i += 1) {
      if (followup.args[i] === '--image' && followup.args[i + 1]) imageArgs.push(followup.args[i + 1]);
    }
    if (imageArgs.length !== 1 || path.resolve(imageArgs[0]) !== path.resolve(persistedImagePath))
      throw new Error('follow-up Codex exec did not receive the persisted generated image: ' + JSON.stringify({ imageArgs, persistedImagePath }));
    if (!followup.args.some((arg, i) => arg === '--disable' && followup.args[i + 1] === 'view_image'))
      throw new Error('follow-up image input must not enable the Codex view_image tool: ' + JSON.stringify(followup.args));
    if (String(followup.stdin || '').indexOf('[Visual context: image #1 generated by the previous assistant is attached to this turn.]') < 0)
      throw new Error('follow-up transcript did not preserve generated-image provenance: ' + JSON.stringify(followup.stdin));
    if (String(followup.stdin || '').indexOf('second codex turn: describe the generated image') < 0)
      throw new Error('follow-up user text missing from Codex transcript: ' + JSON.stringify(followup.stdin));

    return 'generated PNG persisted and rendered across reload; the next Codex turn received that exact app-owned PNG via --image while view_image stayed disabled';
  }
});



scenarios.push({
  id: 339,
  name: 'Codex non-streaming requests are thread-scoped: B stays sendable while A runs, concurrent Codex requests coexist, and stopping A never cancels B',
  regression: true,
  mode: null,
  settings: { threadTitles: { enabled: false } },
  fixtures: {
    threads: [
      {
        id: 't-codex-a-339', title: 'Codex A', active_leaf_id: 'm-codex-a-339-a1',
        model_override: 'codex/gpt-5.6-luna', reasoning_override: 'medium', reasoning_override_set: 1
      },
      {
        id: 't-codex-b-339', title: 'Codex B', active_leaf_id: 'm-codex-b-339-a1',
        model_override: 'codex/gpt-5.6-luna', reasoning_override: 'medium', reasoning_override_set: 1
      }
    ],
    messages: [
      { id: 'm-codex-a-339-u1', thread_id: 't-codex-a-339', role: 'user', content: 'A seed' },
      { id: 'm-codex-a-339-a1', thread_id: 't-codex-a-339', role: 'assistant', content: 'A seed answer', parent_id: 'm-codex-a-339-u1', model: 'codex/gpt-5.6-luna' },
      { id: 'm-codex-b-339-u1', thread_id: 't-codex-b-339', role: 'user', content: 'B seed' },
      { id: 'm-codex-b-339-a1', thread_id: 't-codex-b-339', role: 'assistant', content: 'B seed answer', parent_id: 'm-codex-b-339-u1', model: 'codex/gpt-5.6-luna' }
    ]
  },
  preLaunch(dataDir) { installFakeCodex(dataDir); },
  launchEnv: fakeLaunchEnv,
  async body({ cdp, dataDir, dbPath }) {
    const buttonMode = "(() => { var b=document.getElementById('chat-send-btn'); if(!b||!b.onclick)return 'none'; if(b.onclick===onStopStreaming)return 'stop'; if(b.onclick===onChatSend)return 'send'; return 'other'; })()";

    await showChat();
    await cdp.eval('window.loadThread("t-codex-a-339"); true');
    await cdp.waitFor('window.activeThreadId === "t-codex-a-339" && chatMessages.some((m) => m.id === "m-codex-a-339-a1") && window._currentSettings && window._currentSettings.model === "codex/gpt-5.6-luna"', 15000, 250, 'Codex A loaded');

    // A deliberately never completes until Stop kills its process.
    await sendChatMessage(cdp, 'cancel this codex request');
    await cdp.waitFor('isThreadRequestInFlight("t-codex-a-339")', 10000, 50, 'Codex A busy');
    await cdp.waitFor('document.querySelector("#chat-messages .thinking-content") && document.querySelector("#chat-messages .thinking-content").textContent.indexOf("Beginning a cancellable Codex response") >= 0', 15000, 100, 'Codex A reasoning');

    await cdp.eval('window.loadThread("t-codex-b-339"); true');
    await cdp.waitFor('window.activeThreadId === "t-codex-b-339" && chatMessages.some((m) => m.id === "m-codex-b-339-a1") && window._currentSettings && window._currentSettings.model === "codex/gpt-5.6-luna"', 15000, 250, 'Codex B loaded');
    await sleep(200);

    const bIdleMode = await cdp.eval(buttonMode);
    const bIdleDisabled = await cdp.eval('document.getElementById("chat-input").disabled');
    if (bIdleMode !== 'send' || bIdleDisabled)
      throw new Error('idle Codex B inherited A busy state: mode=' + bIdleMode + ' inputDisabled=' + bIdleDisabled);

    await sendChatMessage(cdp, 'slow thread b');
    await cdp.waitFor('isThreadRequestInFlight("t-codex-a-339") && isThreadRequestInFlight("t-codex-b-339")', 10000, 50, 'both Codex requests busy');
    await cdp.waitFor('document.querySelector("#chat-messages .thinking-content") && document.querySelector("#chat-messages .thinking-content").textContent.indexOf("Working on concurrent thread B") >= 0', 15000, 100, 'Codex B reasoning');

    let execs = execLog(dataDir);
    if (execs.length !== 2)
      throw new Error('expected two concurrent Codex execs, got ' + JSON.stringify(execs));

    await cdp.eval('window.loadThread("t-codex-a-339"); true');
    await cdp.waitFor('window.activeThreadId === "t-codex-a-339" && chatMessages.some((m) => m.content === "cancel this codex request")', 15000, 250, 'Codex A returned');
    await sleep(150);
    if (await cdp.eval(buttonMode) !== 'stop')
      throw new Error('busy Codex A did not restore Stop mode');

    await cdp.click('#chat-send-btn');
    await cdp.waitFor('!isThreadRequestInFlight("t-codex-a-339") && isThreadRequestInFlight("t-codex-b-339")', 15000, 50, 'A stopped while B remained busy');

    await cdp.eval('window.loadThread("t-codex-b-339"); true');
    await cdp.waitFor('window.activeThreadId === "t-codex-b-339" && chatMessages.some((m) => m.content === "slow thread b")', 15000, 250, 'Codex B returned after A stop');
    await sleep(150);

    const bBusyMode = await cdp.eval(buttonMode);
    const bBusyDisabled = await cdp.eval('document.getElementById("chat-input").disabled');
    if (bBusyMode !== 'stop' || !bBusyDisabled)
      throw new Error('stopping Codex A changed B busy state: mode=' + bBusyMode + ' inputDisabled=' + bBusyDisabled);

    await waitStreamingIdle(cdp, 30000);
    await sleep(500);

    const aAssistantRows = seed.query(dbPath,
      "SELECT content FROM messages WHERE thread_id='t-codex-a-339' AND role='assistant'");
    const aCancelledFinal = aAssistantRows.filter((row) => String(row.content || '').trim() === 'BASIC CODEX ANSWER').length;
    const bAssistantRows = seed.query(dbPath,
      "SELECT content, reasoning FROM messages WHERE thread_id='t-codex-b-339' AND role='assistant'");
    const bRows = bAssistantRows.filter((row) => String(row.content || '').trim() === 'THREAD B CODEX ANSWER');
    if (aCancelledFinal !== 0)
      throw new Error('cancelled Codex A persisted a final response: ' + JSON.stringify(aAssistantRows));
    if (bRows.length !== 1 || String(bRows[0].reasoning || '').indexOf('Working on concurrent thread B') < 0)
      throw new Error('Codex B did not complete independently after A was stopped: ' + JSON.stringify(bAssistantRows));

    return 'Codex A stayed isolated from idle B; A+B ran concurrently; stopping A left B in Stop mode until B completed and persisted its own final+reasoning';
  }
});


scenarios.push({
  id: 340,
  name: 'Codex final answer containing an SSE-looking data marker is persisted as ordinary text and never re-parsed as SSE',
  regression: true,
  mode: null,
  settings: { threadTitles: { enabled: false } },
  fixtures: {
    threads: [{
      id: 't-codex-data-340', title: 'Codex Data Marker', active_leaf_id: 'm-codex-data-340-a1',
      model_override: 'codex/gpt-5.6-luna', reasoning_override: 'medium', reasoning_override_set: 1
    }],
    messages: [
      { id: 'm-codex-data-340-u1', thread_id: 't-codex-data-340', role: 'user', content: 'seed' },
      { id: 'm-codex-data-340-a1', thread_id: 't-codex-data-340', role: 'assistant', content: 'seed answer', parent_id: 'm-codex-data-340-u1', model: 'codex/gpt-5.6-luna' }
    ]
  },
  preLaunch(dataDir) { installFakeCodex(dataDir); },
  launchEnv: fakeLaunchEnv,
  async body({ cdp, dbPath }) {
    await showChat();
    await cdp.eval('window.loadThread("t-codex-data-340"); true');
    await cdp.waitFor(
      'window.activeThreadId === "t-codex-data-340" && chatMessages.some((m) => m.id === "m-codex-data-340-a1") && window._currentSettings && window._currentSettings.model === "codex/gpt-5.6-luna"',
      15000, 250, 'Codex data-marker thread loaded'
    );

    await sendChatMessage(cdp, 'codex data marker');
    await cdp.waitFor('isThreadRequestInFlight("t-codex-data-340")', 10000, 50, 'Codex data-marker request busy');
    await waitStreamingIdle(cdp, 30000);
    await sleep(400);

    const rows = seed.query(dbPath,
      "SELECT content FROM messages WHERE thread_id='t-codex-data-340' AND role='assistant'");
    const matched = rows.filter((row) => {
      const text = String(row.content || '');
      return text.includes('CODEX DATA MARKER ANSWER') &&
        text.includes('data: "embedded scalar text"');
    });
    if (matched.length !== 1)
      throw new Error('Codex data-marker answer did not persist intact: ' + JSON.stringify(rows));

    const errorVisible = await cdp.eval(
      'document.body && document.body.textContent.indexOf("Request failed: This value of type") >= 0'
    );
    if (errorVisible)
      throw new Error('Codex answer was re-parsed as SSE and surfaced the scalar .Has failure');

    return 'Codex answer containing data: "embedded scalar text" persisted intact without entering SSE parsing';
  }
});


scenarios.push({
  id: 342,
  name: 'Web-search ceiling terminates only its request and a fresh Codex chat sends normally afterward',
  regression: true,
  mode: 'sse-tool-call',
  settings: {
    threadTitles: { enabled: false },
    newChatStartsWith: 'codex/gpt-5.6-luna',
    tavilyApiKey: 'test-tavily-key'
  },
  mockOpts: {
    toolRounds: 61,
    searchQuery: 'ceiling ownership query',
    tavilyAnswer: 'fast ceiling search result',
    tavilyDelay: 1,
    toolCallDelay: 1
  },
  fixtures: {
    threads: [{
      id: 't-search-ceiling-342', title: 'Search Ceiling', active_leaf_id: 'm-search-ceiling-342-a1',
      model_override: 'openai/gpt-5-mini'
    }],
    messages: [
      { id: 'm-search-ceiling-342-u1', thread_id: 't-search-ceiling-342', role: 'user', content: 'seed search question' },
      { id: 'm-search-ceiling-342-a1', thread_id: 't-search-ceiling-342', role: 'assistant', content: 'seed search answer', parent_id: 'm-search-ceiling-342-u1', model: 'openai/gpt-5-mini' }
    ]
  },
  preLaunch(dataDir, endpoint) {
    installFakeCodex(dataDir);
    const settingsFile = path.join(dataDir, 'settings.json');
    const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    settings.tavilyEndpoint = String(endpoint).replace(/chat\/completions$/, '') + 'search';
    fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2), 'utf8');
  },
  launchEnv: fakeLaunchEnv,
  async body({ cdp, dbPath, dataDir }) {
    await showChat();
    await cdp.eval('window.loadThread("t-search-ceiling-342"); true');
    await cdp.waitFor(
      'window.activeThreadId === "t-search-ceiling-342" && window._currentSettings && window._currentSettings.model === "openai/gpt-5-mini"',
      15000, 250, 'search ceiling thread loaded'
    );

    await cdp.waitFor('document.getElementById("webSearchToggle") !== null', 10000, 100, 'Web Search toggle');
    await cdp.eval('document.getElementById("webSearchToggle").classList.contains("on") ? true : (document.getElementById("webSearchToggle").click(), true)');
    await cdp.waitFor('window._currentSettings && window._currentSettings.webSearch === true', 5000, 100, 'Web Search enabled');
    await cdp.eval('typeof _sendAllSettings === "function" ? (_sendAllSettings(true), true) : false');
    await sleep(250);

    await sendChatMessage(cdp, 'force repeated web searches to the ceiling');
    await cdp.waitFor(
      'document.body && document.body.textContent.indexOf("too many search rounds (max 60)") >= 0',
      90000, 100, 'terminal search ceiling error'
    );
    await cdp.waitFor(
      'typeof isThreadRequestInFlight === "function" && !isThreadRequestInFlight("t-search-ceiling-342")',
      15000, 100, 'failed search request fully released'
    );

    const terminalRows = seed.query(dbPath,
      "SELECT content FROM messages WHERE thread_id='t-search-ceiling-342' AND content LIKE '%too many search rounds (max 60)%'");
    if (terminalRows.length !== 1)
      throw new Error('terminal ceiling search context missing or duplicated: ' + JSON.stringify(terminalRows));

    const oldThread = await cdp.eval('window.activeThreadId');
    await cdp.click('#new-chat-btn');
    await cdp.waitFor('window.activeThreadId && window.activeThreadId !== ' + JSON.stringify(oldThread), 15000, 250, 'fresh chat created');
    const freshThread = await cdp.eval('window.activeThreadId');
    await cdp.waitFor(
      'window._currentSettings && window._currentSettings.model === "codex/gpt-5.6-luna"',
      15000, 200, 'fresh chat Codex default applied'
    );

    await sendChatMessage(cdp, 'normal codex after search ceiling');
    await cdp.waitFor('isThreadRequestInFlight(' + JSON.stringify(freshThread) + ')', 10000, 50, 'fresh Codex request started');
    await waitStreamingIdle(cdp, 30000);
    await sleep(350);

    const freshRows = seed.query(dbPath,
      'SELECT role, content FROM messages WHERE thread_id=? ORDER BY rowid', [freshThread]);
    if (freshRows.length !== 2 || freshRows[0].role !== 'user' ||
        freshRows[1].role !== 'assistant' || String(freshRows[1].content).trim() !== 'BASIC CODEX ANSWER')
      throw new Error('fresh chat did not complete cleanly after ceiling failure: ' + JSON.stringify(freshRows));

    const missingOriginError = await cdp.eval(
      'document.body && document.body.textContent.indexOf("originating stream record is missing") >= 0'
    );
    if (missingOriginError)
      throw new Error('stale stream tool state leaked into the fresh Codex request');
    if (execLog(dataDir).length !== 1)
      throw new Error('fresh chat should execute Codex exactly once after the failed search loop');

    return '61 requested search rounds hit the bounded max 60 terminal path; ownership released, then a brand-new Codex thread completed and persisted without stale originating-stream state';
  }
});

scenarios.push({
  id: 343,
  name: 'Switching sibling branches during a non-stream Codex request keeps live activity and persistence on the originating branch',
  regression: true,
  mode: null,
  settings: { threadTitles: { enabled: false } },
  fixtures: {
    threads: [{
      id: 't-codex-branch-343', title: 'Codex Branch Scope', active_leaf_id: 'm-codex-branch-343-a2a',
      model_override: 'codex/gpt-5.6-luna', reasoning_override: 'medium', reasoning_override_set: 1
    }],
    messages: [
      { id: 'm-codex-branch-343-u1', thread_id: 't-codex-branch-343', role: 'user', content: 'shared root' },
      { id: 'm-codex-branch-343-a1', thread_id: 't-codex-branch-343', role: 'assistant', content: 'branch A answer', parent_id: 'm-codex-branch-343-u1', sibling_group: 'sg-codex-343', sibling_index: 0, model: 'codex/gpt-5.6-luna' },
      { id: 'm-codex-branch-343-a1b', thread_id: 't-codex-branch-343', role: 'assistant', content: 'branch B answer', parent_id: 'm-codex-branch-343-u1', sibling_group: 'sg-codex-343', sibling_index: 1, model: 'codex/gpt-5.6-luna' },
      { id: 'm-codex-branch-343-u2a', thread_id: 't-codex-branch-343', role: 'user', content: 'follow A', parent_id: 'm-codex-branch-343-a1' },
      { id: 'm-codex-branch-343-a2a', thread_id: 't-codex-branch-343', role: 'assistant', content: 'A leaf', parent_id: 'm-codex-branch-343-u2a', model: 'codex/gpt-5.6-luna' },
      { id: 'm-codex-branch-343-u2b', thread_id: 't-codex-branch-343', role: 'user', content: 'follow B', parent_id: 'm-codex-branch-343-a1b' },
      { id: 'm-codex-branch-343-a2b', thread_id: 't-codex-branch-343', role: 'assistant', content: 'B leaf', parent_id: 'm-codex-branch-343-u2b', model: 'codex/gpt-5.6-luna' }
    ]
  },
  preLaunch(dataDir) { installFakeCodex(dataDir); },
  launchEnv: fakeLaunchEnv,
  async body({ cdp, dbPath, dataDir }) {
    const buttonMode = '(() => { const b = document.getElementById("chat-send-btn"); if (!b || !b.onclick) return "none"; if (b.onclick === onStopStreaming) return "stop"; if (b.onclick === onChatSend) return "send"; return "other"; })()';

    await showChat();
    await cdp.eval('window.loadThread("t-codex-branch-343"); true');
    await cdp.waitFor(
      'window.activeThreadId === "t-codex-branch-343" && chatMessages[chatMessages.length - 1] && chatMessages[chatMessages.length - 1].id === "m-codex-branch-343-a2a"',
      15000, 250, 'Codex branch A loaded'
    );

    await sendChatMessage(cdp, 'slow branch codex');
    await cdp.waitFor(
      '(() => { const el = document.querySelector("#chat-messages .thinking-block .thinking-content"); return !!el && el.textContent.indexOf("Working on the originating Codex branch") >= 0; })()',
      15000, 100, 'originating branch Codex reasoning visible'
    );
    const sentUser = seed.query(dbPath,
      "SELECT id FROM messages WHERE thread_id='t-codex-branch-343' AND role='user' AND content='slow branch codex' ORDER BY rowid DESC LIMIT 1")[0];
    if (!sentUser)
      throw new Error('originating Codex user message was not persisted');

    await cdp.click('#chat-messages .msg:nth-child(2) .msg-action-btn[title="Next branch"]');
    await cdp.waitFor(
      'chatMessages[chatMessages.length - 1] && chatMessages[chatMessages.length - 1].id === "m-codex-branch-343-a2b"',
      15000, 200, 'Codex branch B loaded while A runs'
    );
    await sleep(250);

    const offPath = await cdp.eval('(() => { const b = document.getElementById("chat-send-btn"); return { busy: typeof isThreadRequestInFlight === "function" && isThreadRequestInFlight("t-codex-branch-343"), inputDisabled: document.getElementById("chat-input").disabled, buttonMode: !b || !b.onclick ? "none" : (b.onclick === onStopStreaming ? "stop" : (b.onclick === onChatSend ? "send" : "other")), loadingDots: !!document.getElementById("chat-loading"), text: document.getElementById("chat-messages").textContent }; })()');
    if (!offPath.busy || !offPath.inputDisabled || offPath.buttonMode !== 'stop')
      throw new Error('same-thread Codex request lost its busy/Stop ownership after branch switch: ' + JSON.stringify(offPath));
    if (offPath.loadingDots || String(offPath.text).indexOf('Working on the originating Codex branch') >= 0)
      throw new Error('originating Codex loading/activity painted into sibling branch B: ' + JSON.stringify(offPath));

    await cdp.click('#chat-messages .msg:nth-child(2) .msg-action-btn[title="Previous branch"]');
    await cdp.waitFor(
      'chatMessages.some((m) => m.content === "slow branch codex")',
      15000, 200, 'returned to originating Codex branch'
    );
    await cdp.waitFor(
      '(() => { const el = document.querySelector("#chat-messages .thinking-block .thinking-content"); return !!el && el.textContent.indexOf("Working on the originating Codex branch") >= 0; })()',
      10000, 100, 'originating Codex activity restored'
    );
    const originBusy = await cdp.eval(buttonMode);
    if (originBusy !== 'stop')
      throw new Error('returning to the originating branch did not restore Stop state: ' + originBusy);

    await cdp.click('#chat-messages .msg:nth-child(2) .msg-action-btn[title="Next branch"]');
    await cdp.waitFor(
      'chatMessages[chatMessages.length - 1] && chatMessages[chatMessages.length - 1].id === "m-codex-branch-343-a2b"',
      15000, 200, 'returned to sibling B before Codex completion'
    );
    await waitStreamingIdle(cdp, 30000);
    await sleep(350);

    const assistantRows = seed.query(dbPath,
      "SELECT id, parent_id, content, reasoning FROM messages WHERE thread_id='t-codex-branch-343' AND role='assistant'");
    const responseRows = assistantRows.filter((row) =>
      String(row.content || '').trim() === 'ORIGINATING BRANCH CODEX ANSWER'
    );
    if (responseRows.length !== 1 || responseRows[0].parent_id !== sentUser.id)
      throw new Error('Codex completion did not persist under the originating send path: ' +
        JSON.stringify({ sentUser, responseRows, assistantRows, execs: execLog(dataDir) }));
    const activeLeaf = seed.query(dbPath,
      "SELECT active_leaf_id FROM chat_threads WHERE id='t-codex-branch-343'")[0].active_leaf_id;
    if (activeLeaf !== 'm-codex-branch-343-a2b')
      throw new Error('background Codex completion yanked the visible branch: active_leaf_id=' + activeLeaf);

    const after = await cdp.eval('(() => { const b = document.getElementById("chat-send-btn"); return { lastId: chatMessages.length ? chatMessages[chatMessages.length - 1].id : "", text: document.getElementById("chat-messages").textContent, loadingDots: !!document.getElementById("chat-loading"), inputDisabled: document.getElementById("chat-input").disabled, buttonMode: !b || !b.onclick ? "none" : (b.onclick === onStopStreaming ? "stop" : (b.onclick === onChatSend ? "send" : "other")) }; })()');
    if (after.lastId !== 'm-codex-branch-343-a2b' ||
        String(after.text).indexOf('ORIGINATING BRANCH CODEX ANSWER') >= 0 ||
        String(after.text).indexOf('Working on the originating Codex branch') >= 0 ||
        after.loadingDots || after.inputDisabled || after.buttonMode !== 'send')
      throw new Error('background Codex completion altered sibling branch B UI/composer: ' + JSON.stringify(after));

    await cdp.click('#chat-messages .msg:nth-child(2) .msg-action-btn[title="Previous branch"]');
    await cdp.waitFor(
      'document.getElementById("chat-messages").textContent.indexOf("ORIGINATING BRANCH CODEX ANSWER") >= 0',
      15000, 200, 'originating Codex final visible after switching back'
    );
    if (execLog(dataDir).length !== 1)
      throw new Error('branch navigation must not start another Codex process');

    return 'Codex ran on branch A; branch B showed no A loading/activity, switching back restored A busy activity, background completion stayed parented to A and did not yank B';
  }
});
scenarios.push({
  id: 347,
  name: 'Codex title model stays isolated from HTTP and Codex chat request state',
  regression: true,
  mode: 'sse-success',
  settings: {
    threadTitles: {
      enabled: true,
      model: 'codex/gpt-5.6-luna',
      prompt: 'TITLE_PROMPT_347: Return only a short title.',
      maxTokens: 50
    }
  },
  fixtures: {
    threads: [
      { id: 't-title-http-347', title: 'New Chat', active_leaf_id: null, model_override: 'openai/gpt-5-mini' },
      { id: 't-title-codex-347', title: 'New Chat', active_leaf_id: null, model_override: 'codex/gpt-5.6-luna' }
    ]
  },
  preLaunch(dataDir) { installFakeCodex(dataDir); },
  launchEnv: fakeLaunchEnv,
  async body({ cdp, dataDir, dbPath, mockLog }) {
    async function waitForExec(predicate, label, timeoutMs = 15000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const found = execLog(dataDir).find(predicate);
        if (found) return found;
        await sleep(100);
      }
      throw new Error('timeout waiting for ' + label + ': ' + JSON.stringify(execLog(dataDir)));
    }
    async function waitForTitle(threadId, label) {
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline) {
        const rows = seed.query(dbPath, 'SELECT title FROM chat_threads WHERE id = ?', [threadId]);
        if (rows.length && rows[0].title !== 'New Chat') return rows[0].title;
        await sleep(100);
      }
      throw new Error('timeout waiting for ' + label);
    }

    await showChat();

    // Non-Codex main chat + Codex title request.
    await cdp.eval('window.loadThread("t-title-http-347"); true');
    await cdp.waitFor(
      'window.activeThreadId === "t-title-http-347" && window._currentSettings && window._currentSettings.model === "openai/gpt-5-mini"',
      15000, 200, 'HTTP title thread'
    );
    await sendChatMessage(cdp, 'HTTP first exchange 347');
    await waitStreamingIdle(cdp, 30000);
    await waitForExec(
      (e) => String(e.instructions || '').includes('TITLE_PROMPT_347') &&
             String(e.stdin || '').includes('HTTP first exchange 347'),
      'Codex title exec for HTTP chat'
    );

    // The title process is still live here in the fake CLI. A follow-up chat
    // must remain an OpenAI request while the Codex title completes.
    await sendChatMessage(cdp, 'HTTP second exchange 347');
    await waitStreamingIdle(cdp, 30000);
    await waitForTitle('t-title-http-347', 'HTTP-thread Codex title');
    const httpModel = await cdp.eval('window._currentSettings && window._currentSettings.model');
    if (httpModel !== 'openai/gpt-5-mini')
      throw new Error('Codex title contaminated HTTP chat model state: ' + httpModel);
    const httpRequests = fs.existsSync(mockLog)
      ? fs.readFileSync(mockLog, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line))
          .filter((r) => String(r.url || '').includes('/chat/completions') && r.body && Array.isArray(r.body.messages))
      : [];
    const firstHttp = httpRequests.find((r) => JSON.stringify(r.body.messages).includes('HTTP first exchange 347'));
    const secondHttp = httpRequests.find((r) => JSON.stringify(r.body.messages).includes('HTTP second exchange 347'));
    if (!firstHttp || !secondHttp || firstHttp.body.model !== 'gpt-5-mini' || secondHttp.body.model !== 'gpt-5-mini')
      throw new Error('Codex title contaminated outbound HTTP request model: ' + JSON.stringify(httpRequests));

    // Codex main chat + Codex title request. Start a second Codex turn while the
    // title Codex process is still live to prove the two request states are independent.
    await cdp.eval('window.loadThread("t-title-codex-347"); true');
    await cdp.waitFor(
      'window.activeThreadId === "t-title-codex-347" && window._currentSettings && window._currentSettings.model === "codex/gpt-5.6-luna"',
      15000, 200, 'Codex title thread'
    );
    await sendChatMessage(cdp, 'first codex title exchange 347');
    await waitStreamingIdle(cdp, 30000);
    await waitForExec(
      (e) => String(e.instructions || '').includes('TITLE_PROMPT_347') &&
             String(e.stdin || '').includes('first codex title exchange 347'),
      'Codex title exec for Codex chat'
    );

    await sendChatMessage(cdp, 'second codex turn');
    await waitStreamingIdle(cdp, 30000);
    await waitForTitle('t-title-codex-347', 'Codex-thread Codex title');

    const codexModel = await cdp.eval('window._currentSettings && window._currentSettings.model');
    if (codexModel !== 'codex/gpt-5.6-luna')
      throw new Error('Codex title contaminated Codex chat model state: ' + codexModel);
    const latest = seed.query(dbPath,
      "SELECT content, model, provider FROM messages WHERE thread_id='t-title-codex-347' AND role='assistant' ORDER BY rowid DESC LIMIT 1")[0];
    if (!latest || String(latest.content || '').trim() !== 'SECOND CODEX ANSWER' ||
        String(latest.model || '').indexOf('gpt-5.6-luna') < 0 || latest.provider !== 'codex')
      throw new Error('post-title Codex chat request was corrupted: ' + JSON.stringify(latest));

    const titleExecs = execLog(dataDir).filter((e) => String(e.instructions || '').includes('TITLE_PROMPT_347'));
    if (titleExecs.length !== 2)
      throw new Error('expected one Codex title invocation per first exchange: ' + JSON.stringify(titleExecs));

    return 'Codex generated titles for HTTP and Codex chats while overlapping follow-up sends retained their own model/provider state';
  }
});

module.exports = scenarios;
