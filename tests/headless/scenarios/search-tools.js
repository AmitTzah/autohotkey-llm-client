// scenarios/search-tools.js - Web-search tool feature verification
//
// The web-search milestone (DeepSeek native search + Tavily fallback). These
// scenarios drive the REAL app against the local mock server: the mock answers
// the chat stream, the DeepSeek /responses backend, and the Tavily /search
// backend with shapes captured from the real APIs during mock setup. No real
// API calls happen in the headless suite.
'use strict';
const fs = require('node:fs');
const seed = require('../seed');
const { sleep, runProbe, showChat, sendChatMessage, waitStreamingIdle } = require('./helpers');

const scenarios = [];

// Canonical function-calling order (regression): the follow-up chat request
// must carry the exchange as contiguous assistant tool_calls -> role:"tool"
// with NO search-context user message before the tool call. The context is
// persisted for future turns but excluded from the in-flight round's request.
function assertCanonicalToolOrder(log) {
  const requests = log.split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const toolReq = requests.find((r) => JSON.stringify(r.body || {}).includes('"role":"tool"'));
  if (!toolReq) throw new Error('no chat request carries the tool exchange');
  const msgs = (toolReq.body && toolReq.body.messages) || [];
  const asstIdx = msgs.findIndex((m) => m && m.role === 'assistant' && m.tool_calls && m.tool_calls.length);
  const toolIdx = msgs.findIndex((m) => m && m.role === 'tool');
  if (asstIdx < 0 || toolIdx !== asstIdx + 1)
    throw new Error('tool exchange not contiguous (assistant tool_calls then tool): ' + JSON.stringify(msgs));
  const contextBefore = msgs.slice(0, asstIdx).some((m) => m && m.role === 'user' && String(m.content || '').indexOf('[Web search:') === 0);
  if (contextBefore) throw new Error('search context appears before the tool call: ' + JSON.stringify(msgs));
}

// Enable the right-rail Web Search toggle before the first message (default
// off), wait for the debounced updateModelSettings round-trip, and return the
// posted payload.
async function enableWebSearch(cdp) {
  await showChat();
  await cdp.waitFor('document.getElementById("webSearchToggle") !== null', 10000, 200, 'Web Search toggle');
  await cdp.clearPosted();
  await cdp.eval('document.getElementById("webSearchToggle").click()');
  // First prove the real click listener ran. This distinguishes a missing UI
  // binding from a delayed debounced IPC post under parallel WebView2 load.
  await cdp.waitFor('window._currentSettings && window._currentSettings.webSearch === true && document.getElementById("webSearchToggle").classList.contains("on")', 5000, 100, 'Web Search toggle state');
  // These scenarios exercise search execution, not debounce timing (#20 owns
  // that contract). Flush through the same production path used by Send so
  // parallel WebView2 scheduling cannot turn a delayed 300ms timer into a
  // false search failure.
  const flushed = await cdp.eval('typeof _sendAllSettings === "function" ? (_sendAllSettings(true), true) : false');
  if (!flushed) throw new Error('production _sendAllSettings flush is unavailable');
  try {
    await cdp.waitFor('window.__posted && window.__posted.some((m) => m.includes("updateModelSettings"))', 5000, 100, 'Web Search settings update');
  } catch (e) {
    const state = await cdp.eval('(() => ({ webSearch: !!(window._currentSettings && window._currentSettings.webSearch), toggleOn: document.getElementById("webSearchToggle").classList.contains("on"), posted: (window.__posted || []).slice(-8) }))()');
    throw new Error(e.message + ' state=' + JSON.stringify(state));
  }
  const posted = await cdp.postedMessages();
  const last = posted.filter((m) => m.includes('"updateModelSettings"')).pop();
  if (!last) throw new Error('no updateModelSettings posted after enabling web search');
  return JSON.parse(last);
}

scenarios.push({
  id: 250,
  name: 'Web Search toggle: DeepSeek native search end-to-end (tool loop through the mock /responses backend)',
  regression: true, // feature acceptance coverage retained as a regression check
  mode: 'sse-tool-call',
  settings: { threadTitles: { enabled: false } },
  mockOpts: {
    searchQuery: 'AutoHotkey WebView2',
    searchReasoning: 'Let me search for this.',
    searchText: 'DeepSeek native answer: AutoHotkey v2 hosts web content with WebView2.',
    chatText: 'the answer comes from DeepSeek\'s native search.'
  },
  async body({ cdp, dbPath, mockLog }) {
    const payload = await enableWebSearch(cdp);
    if (payload.webSearch !== true) throw new Error('webSearch not enabled in payload: ' + JSON.stringify(payload));
    if ('codeExecution' in payload) throw new Error('codeExecution stub still in payload');

    await sendChatMessage(cdp, 'What is the latest AutoHotkey version?');
    // Live progress: the streaming /responses backend re-renders the search
    // card as it runs (search rounds, then the answer) - assert it appears
    // BEFORE the stream completes.
    await cdp.waitFor('document.querySelector(".msg.search-context .search-card-results") && document.querySelector(".msg.search-context .search-card-results").textContent.indexOf("related terms") >= 0', 20000, 150, 'live search progress');
    await waitStreamingIdle(cdp, 45000);

    // The final answer bubble rendered after the tool round.
    const text = (await cdp.text('.msg.bot .msg-content')) || '';
    if (text.indexOf('Based on the search') < 0) throw new Error('final answer missing: ' + text.slice(0, 120));

    // DB path: user -> search context -> assistant answer.
    const rows = seed.query(dbPath, 'SELECT role, content FROM messages ORDER BY created_at');
    if (rows.length !== 3) throw new Error('expected user + search context + assistant, got ' + rows.length + ' rows');
    if (rows[0].role !== 'user') throw new Error('first message not user');
    if (rows[1].role !== 'user' || String(rows[1].content || '').indexOf('[Web search: AutoHotkey WebView2]') !== 0)
      throw new Error('search context message missing: ' + JSON.stringify(rows[1]));
    // The search context must carry the REAL backend answer, not a failure
    // blob. Regression (real-API report): DeepSeek's /responses success
    // envelope includes "error":null, which jsongo parses as "" - the old
    // "error key present" check turned every success into "Web search
    // failed: " with no reason. The mock now carries error:null, so this
    // assertion catches that exact regression.
    if (String(rows[1].content || '').indexOf('DeepSeek native answer') < 0)
      throw new Error('search context carries no DeepSeek search result: ' + JSON.stringify(rows[1]));
    if (String(rows[1].content || '').indexOf('Web search failed') >= 0)
      throw new Error('search context reports a failed search: ' + JSON.stringify(rows[1]));
    if (rows[2].role !== 'assistant') throw new Error('final answer not assistant');

    // DeepSeek native backend hit the mock /responses endpoint; the follow-up
    // chat request carried the role:"tool" result back to the model.
    const log = fs.readFileSync(mockLog, 'utf8');
    if (log.indexOf('/v1/responses') < 0 && log.indexOf('/responses') < 0) throw new Error('DeepSeek /responses backend not called');
    if (log.indexOf('"type":"web_search"') < 0) throw new Error('DeepSeek /responses request did not carry the web_search tool');
    if (log.indexOf('"role":"tool"') < 0) throw new Error('tool result not returned to the model');
    assertCanonicalToolOrder(log);
    const requests = log.split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const responsesReq = requests.find((r) => String(r.url).includes('/responses'));
    // Regression: the REAL DeepSeek API rejects stream:1 (jsongo serializes
    // AHK true as 1) with a 400 "invalid type: integer, expected a boolean"
    // (captured 2026-08-16 18:48) - the wire payload must carry a real
    // boolean, and the mock enforces it too.
    if (!responsesReq || responsesReq.body.stream !== true) throw new Error('/responses request must carry stream:true');

    // The toggle persisted with the thread.
    const settings = seed.query(dbPath, 'SELECT advanced_toggles FROM chat_threads LIMIT 1');
    if (!settings.length || String(settings[0].advanced_toggles || '').indexOf('webSearch') < 0)
      throw new Error('webSearch not persisted: ' + JSON.stringify(settings[0]));

    // UI feedback: the search context renders as a collapsible card showing
    // the query, with the results hidden until the user expands them.
    const cardState = await cdp.eval(`(() => {
      var toggle = document.querySelector('.msg.search-context .search-card-toggle');
      var results = document.querySelector('.msg.search-context .search-card-results');
      if (!toggle || !results) return JSON.stringify({ missing: true });
      var hiddenBefore = results.hidden;
      toggle.click();
      var hiddenAfter = results.hidden;
      toggle.click();
      return JSON.stringify({ title: toggle.textContent, hiddenBefore: hiddenBefore, hiddenAfter: hiddenAfter });
    })()`);
    const card = JSON.parse(cardState);
    if (card.missing) {
      const dom = await cdp.eval(`(() => {
        var sc = document.querySelector('.msg.search-context');
        if (sc) return sc.outerHTML.slice(0, 800);
        return 'no .msg.search-context; total .msg nodes=' + document.querySelectorAll('.msg').length;
      })()`);
      throw new Error('search context card not rendered: ' + cardState + ' | dom=' + dom);
    }
    if (card.title.indexOf('Searched the web for:') < 0 || card.title.indexOf('AutoHotkey WebView2') < 0)
      throw new Error('search card header missing the query: ' + cardState);
    if (card.hiddenBefore !== true || card.hiddenAfter !== false)
      throw new Error('search card results did not toggle: ' + cardState);

    // The search backend call is recorded in the API log (like chat/title).
    const apiLogFile = require('node:path').join(require('node:os').tmpdir(), 'LLM_API_Log.json');
    let apiLogEntries = [];
    try { apiLogEntries = JSON.parse(fs.readFileSync(apiLogFile, 'utf8')); } catch {}
    const searchEntry = apiLogEntries.find((e) => String(e.commandName || '').indexOf('Web Search (DeepSeek)') >= 0);
    if (!searchEntry) throw new Error('DeepSeek search request not found in the API log');
    if (String(searchEntry.searchQuery || '').indexOf('AutoHotkey WebView2') < 0)
      throw new Error('API log search entry missing the query: ' + JSON.stringify(searchEntry));

    return 'deepseek native search: tool call -> /responses mock -> answer persisted (3 messages, toggle persisted, no real API calls)';
  }
});

scenarios.push({
  id: 251,
  name: 'Web Search toggle: Tavily fallback end-to-end for non-DeepSeek providers (mock /search backend)',
  regression: true, // feature acceptance coverage retained as a regression check
  mode: 'sse-tool-call',
  settings: {
    threadTitles: { enabled: false },
    newChatStartsWith: 'openai/gpt-5-mini',
    tavilyApiKey: 'test-tavily-key'
  },
  mockOpts: {
    searchQuery: 'AutoHotkey WebView2',
    tavilyAnswer: 'Tavily mock answer: AutoHotkey v2 supports WebView2 for hosting web content.',
    chatText: 'the answer comes from Tavily.'
  },
  // Point the Tavily backend at the local mock (the port is only known after
  // the mock server starts, so patch settings.json after the seed writes it).
  preLaunch(dataDir, endpoint) {
    const settingsFile = require('node:path').join(dataDir, 'settings.json');
    const raw = fs.readFileSync(settingsFile, 'utf8');
    const settings = JSON.parse(raw.replace(/^\uFEFF/, ''));
    settings.tavilyEndpoint = String(endpoint).replace(/chat\/completions$/, '') + 'search';
    fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2), 'utf8');
  },
  async body({ cdp, dbPath, mockLog }) {
    const payload = await enableWebSearch(cdp);
    if (payload.webSearch !== true) throw new Error('webSearch not enabled: ' + JSON.stringify(payload));

    await sendChatMessage(cdp, 'How does AutoHotkey host web content?');
    await waitStreamingIdle(cdp, 45000);

    const text = (await cdp.text('.msg.bot .msg-content')) || '';
    if (text.indexOf('Based on the search') < 0) throw new Error('final answer missing: ' + text.slice(0, 120));

    const rows = seed.query(dbPath, 'SELECT role, content FROM messages ORDER BY created_at');
    if (rows.length !== 3) throw new Error('expected 3 messages, got ' + rows.length);
    if (rows[1].role !== 'user' || String(rows[1].content || '').indexOf('[Web search: AutoHotkey WebView2]') !== 0)
      throw new Error('search context message missing: ' + JSON.stringify(rows[1]));
    if (String(rows[1].content || '').indexOf('Tavily mock answer') < 0)
      throw new Error('search context carries no Tavily result: ' + JSON.stringify(rows[1]));
    if (String(rows[1].content || '').indexOf('Web search failed') >= 0)
      throw new Error('search context reports a failed search: ' + JSON.stringify(rows[1]));

    const log = fs.readFileSync(mockLog, 'utf8');
    if (log.indexOf('/v1/search') < 0 && log.indexOf('/search') < 0) throw new Error('Tavily /search backend not called');
    const tavilyReq = log.split('\n').filter(Boolean).map((l) => JSON.parse(l)).find((r) => String(r.url).endsWith('/search'));
    if (!tavilyReq || tavilyReq.body.api_key !== 'test-tavily-key')
      throw new Error('Tavily request did not carry the configured test key: ' + JSON.stringify(tavilyReq && tavilyReq.body));
    if (log.indexOf('"role":"tool"') < 0) throw new Error('tool result not returned to the model');
    assertCanonicalToolOrder(log);

    // The Tavily backend call is recorded in the API log.
    const apiLogFile = require('node:path').join(require('node:os').tmpdir(), 'LLM_API_Log.json');
    let apiLogEntries = [];
    try { apiLogEntries = JSON.parse(fs.readFileSync(apiLogFile, 'utf8')); } catch {}
    const searchEntry = apiLogEntries.find((e) => String(e.commandName || '').indexOf('Web Search (Tavily)') >= 0);
    if (!searchEntry) throw new Error('Tavily search request not found in the API log');
    if (String(searchEntry.searchQuery || '').indexOf('AutoHotkey WebView2') < 0)
      throw new Error('API log search entry missing the query: ' + JSON.stringify(searchEntry));
    const serializedEntry = JSON.stringify(searchEntry);
    const serializedApiLog = fs.readFileSync(apiLogFile, 'utf8');
    if (serializedEntry.indexOf('test-tavily-key') >= 0 || serializedApiLog.indexOf('test-tavily-key') >= 0)
      throw new Error('Tavily API key leaked into the API log: ' + serializedEntry);
    if (String(searchEntry.request || '').indexOf('AutoHotkey WebView2') < 0)
      throw new Error('Tavily API log request lost useful query metadata: ' + JSON.stringify(searchEntry.request));

    return 'tavily fallback: tool call -> mock /search with test key -> answer persisted; API log keeps query metadata but no credential';
  }
});

scenarios.push({
  id: 252,
  name: 'Web Search toggle off: web_search tool removed from subsequent API requests (on -> send -> off -> send)',
  regression: true, // feature acceptance coverage retained as a regression check
  mode: 'sse-success',
  settings: { threadTitles: { enabled: false } },
  async body({ cdp, dbPath, mockLog }) {
    const onPayload = await enableWebSearch(cdp);
    if (onPayload.webSearch !== true) throw new Error('webSearch not enabled: ' + JSON.stringify(onPayload));

    await sendChatMessage(cdp, 'first message');
    await waitStreamingIdle(cdp, 45000);

    // Toggle the same right-rail switch OFF and capture the posted payload.
    await cdp.clearPosted();
    await cdp.eval('document.getElementById("webSearchToggle").click()');
    await sleep(1000); // debounce 300ms + IPC round trip
    const posted = await cdp.postedMessages();
    const last = posted.filter((m) => m.includes('"updateModelSettings"')).pop();
    if (!last) throw new Error('no updateModelSettings posted after disabling web search');
    const offPayload = JSON.parse(last);
    if (offPayload.webSearch !== false) throw new Error('webSearch not false in payload: ' + JSON.stringify(offPayload));

    await sendChatMessage(cdp, 'second message');
    await waitStreamingIdle(cdp, 45000);

    // Inspect the REAL request bodies the mock server recorded: the first
    // chat request must carry the web_search tool, the second must not.
    const requests = fs.readFileSync(mockLog, 'utf8')
      .split('\n').filter(Boolean)
      .map((l) => JSON.parse(l))
      .filter((r) => String(r.url).includes('/chat/completions'));
    if (requests.length < 2) throw new Error('expected 2 chat requests, got ' + requests.length);
    const first = requests[0].body;
    const second = requests[1].body;
    if (!first.tools || !Array.isArray(first.tools) || first.tools[0].function.name !== 'web_search')
      throw new Error('first request missing web_search tool: ' + JSON.stringify(first.tools));
    if (second.tools !== undefined)
      throw new Error('second request still carries tools after toggling off: ' + JSON.stringify(second.tools));

    // The off state persisted with the thread (jsongo serializes AHK false
    // as 0, so accept any falsy value).
    const rows = seed.query(dbPath, 'SELECT advanced_toggles FROM chat_threads LIMIT 1');
    if (!rows.length) throw new Error('no thread row to check');
    let toggles = {};
    try { toggles = JSON.parse(rows[0].advanced_toggles || '{}'); } catch {}
    if (toggles.webSearch) throw new Error('webSearch not persisted as off: ' + JSON.stringify(rows[0]));

    return 'toggle off: first request carries web_search tool, second request has no tools, thread persists webSearch off';
  }
});

scenarios.push({
  id: 253,
  name: 'Stop mid-search: backend call cancelled, no follow-up request, card cancelled, chat usable',
  regression: true, // feature acceptance coverage retained as a regression check
  mode: 'sse-tool-call',
  settings: { threadTitles: { enabled: false } },
  mockOpts: {
    searchQuery: 'AutoHotkey WebView2',
    searchDelay: 60000, // keep the /responses stream open so Stop lands mid-search
    chatText: 'the answer comes from DeepSeek native search.'
  },
  async body({ cdp, mockLog }) {
    const payload = await enableWebSearch(cdp);
    if (payload.webSearch !== true) throw new Error('webSearch not enabled');

    await sendChatMessage(cdp, 'What is the latest AutoHotkey version?');
    // The placeholder card appears immediately; the slow mock keeps the
    // search streaming.
    await cdp.waitFor('document.querySelector(".msg.search-context .search-card-results") && document.querySelector(".msg.search-context .search-card-results").textContent.indexOf("Searching") >= 0', 15000, 150, 'searching card');
    await sleep(500);

    // Press Stop while the search backend is still running.
    await cdp.eval('window.chrome.webview.postMessage(JSON.stringify({ action: "cancelStream" }))');
    await sleep(2000);

    // The card becomes "Search cancelled." instead of a stale "Searching...".
    const cardText = await cdp.eval('document.querySelector(".msg.search-context .search-card-results") ? document.querySelector(".msg.search-context .search-card-results").textContent : ""');
    if (cardText.indexOf('Search cancelled') < 0) throw new Error('card not marked cancelled: ' + JSON.stringify(cardText));

    // No follow-up chat request - the staged tool exchange must NOT fire.
    const log = fs.readFileSync(mockLog, 'utf8');
    const chatReqs = log.split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((r) => String(r.url).includes('/chat/completions'));
    if (chatReqs.length !== 1) throw new Error('expected exactly 1 chat request (no follow-up after cancel), got ' + chatReqs.length);
    if (JSON.stringify(chatReqs[0].body).indexOf('"role":"tool"') >= 0) throw new Error('follow-up tool exchange fired after cancel');

    // The backend call was still logged (status cancelled).
    const apiLogFile = require('node:path').join(require('node:os').tmpdir(), 'LLM_API_Log.json');
    let apiLogEntries = [];
    try { apiLogEntries = JSON.parse(fs.readFileSync(apiLogFile, 'utf8')); } catch {}
    const searchEntry = apiLogEntries.find((e) => String(e.commandName || '').indexOf('Web Search (DeepSeek)') >= 0 && String(e.searchQuery || '').indexOf('AutoHotkey WebView2') >= 0);
    if (!searchEntry) throw new Error('cancelled search request not found in the API log');
    if (String(searchEntry.status) !== 'cancelled') throw new Error('expected cancelled status, got ' + JSON.stringify(searchEntry.status));

    // The chat is not broken: composer is back in Send mode.
    const sendEnabled = await cdp.eval('document.getElementById("chat-send-btn") ? !document.getElementById("chat-send-btn").disabled : false');
    if (!sendEnabled) throw new Error('composer not re-enabled after cancel');

    return 'stop mid-search: /responses killed, no follow-up request, card cancelled, search logged (status cancelled), composer usable';
  }
});

scenarios.push({
  id: 256,
  regression: true,
  name: 'Tavily continuation stays with the originating thread after switching threads during search',
  mode: 'sse-tool-call',
  settings: {
    threadTitles: { enabled: false },
    newChatStartsWith: 'openai/gpt-5-mini',
    tavilyApiKey: 'test-tavily-key'
  },
  mockOpts: {
    searchQuery: 'AutoHotkey WebView2',
    tavilyAnswer: 'Tavily scoped answer for thread A.',
    tavilyDelay: 1800,
    chatText: 'thread A continuation answer.'
  },
  preLaunch(dataDir, endpoint) {
    const settingsFile = require('node:path').join(dataDir, 'settings.json');
    const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    settings.tavilyEndpoint = String(endpoint).replace(/chat\/completions$/, '') + 'search';
    fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2), 'utf8');
  },
  fixtures: {
    threads: [
      { id: 't-search-a-256', title: 'Thread A', active_leaf_id: 'm-search-a-u1' },
      { id: 't-search-b-256', title: 'Thread B', active_leaf_id: 'm-search-b-u1' }
    ],
    messages: [
      { id: 'm-search-a-u1', thread_id: 't-search-a-256', role: 'user', content: 'existing A context', token_count: 5, active_path_tokens: 5 },
      { id: 'm-search-b-u1', thread_id: 't-search-b-256', role: 'user', content: 'existing B context', token_count: 5, active_path_tokens: 5 }
    ]
  },
  async body({ cdp, dbPath, mockLog }) {
    await showChat();
    await cdp.eval('window.loadThread("t-search-a-256"); true');
    await cdp.waitFor('window.activeThreadId === "t-search-a-256"', 15000, 250, 'thread A loaded');
    await enableWebSearch(cdp);
    await sendChatMessage(cdp, 'search from A');
    await cdp.waitFor('document.querySelector(".msg.search-context .search-card-results") && document.querySelector(".msg.search-context .search-card-results").textContent.indexOf("Searching") >= 0', 15000, 150, 'Tavily searching card');

    await cdp.eval('window.loadThread("t-search-b-256"); true');
    await cdp.waitFor('window.activeThreadId === "t-search-b-256"', 10000, 200, 'thread B loaded');
    // The Tavily delay starts after the first chat request reaches the mock;
    // under parallel WebView2 startup that point can be several seconds later
    // than the fixed delay. Wait for A's durable continuation instead of
    // assuming a wall-clock offset, while B remains the visible thread.
    const continuationDeadline = Date.now() + 15000;
    for (;;) {
      const aProgress = seed.query(dbPath, "SELECT role FROM messages WHERE thread_id='t-search-a-256' ORDER BY rowid");
      if (aProgress.length >= 4) break;
      if (Date.now() > continuationDeadline) throw new Error('A continuation was not persisted while B was active: ' + JSON.stringify(aProgress));
      await sleep(200);
    }
    await cdp.eval('window.loadThread("t-search-a-256"); true');
    await cdp.waitFor('window.activeThreadId === "t-search-a-256"', 10000, 200, 'thread A restored');
    await cdp.waitFor('document.querySelector(".msg.bot .msg-content") && document.querySelector(".msg.bot .msg-content").textContent.indexOf("thread A continuation") >= 0', 20000, 200, 'A continuation rendered');

    const aRows = seed.query(dbPath, "SELECT role, content FROM messages WHERE thread_id='t-search-a-256' ORDER BY rowid");
    const bRows = seed.query(dbPath, "SELECT role, content FROM messages WHERE thread_id='t-search-b-256' ORDER BY rowid");
    if (aRows.length !== 4 || !String(aRows[2].content).includes('[Web search: AutoHotkey WebView2]') || aRows[3].role !== 'assistant')
      throw new Error('A continuation/path is wrong: ' + JSON.stringify(aRows));
    if (bRows.length !== 1 || JSON.stringify(bRows).includes('Web search') || JSON.stringify(bRows).includes('thread A'))
      throw new Error('B was polluted by A search state: ' + JSON.stringify(bRows));

    const requests = fs.readFileSync(mockLog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const followUp = requests.find((r) => JSON.stringify(r.body || {}).includes('"role":"tool"'));
    if (!followUp || JSON.stringify(followUp.body).includes('existing B context'))
      throw new Error('A follow-up used the wrong thread/path: ' + JSON.stringify(followUp && followUp.body));
    return 'switched A -> B while Tavily ran: A kept its model/path/tool continuation and B stayed isolated';
  }
});

scenarios.push({
  id: 257,
  regression: true,
  name: 'Stopping a Tavily search kills only the backend, redacts the key, and leaves the composer usable',
  mode: 'sse-tool-call',
  settings: {
    threadTitles: { enabled: false },
    newChatStartsWith: 'openai/gpt-5-mini',
    tavilyApiKey: 'test-tavily-key'
  },
  mockOpts: { searchQuery: 'AutoHotkey WebView2', tavilyDelay: 60000 },
  preLaunch(dataDir, endpoint) {
    const settingsFile = require('node:path').join(dataDir, 'settings.json');
    const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    settings.tavilyEndpoint = String(endpoint).replace(/chat\/completions$/, '') + 'search';
    fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2), 'utf8');
  },
  async body({ cdp, mockLog }) {
    await enableWebSearch(cdp);
    await sendChatMessage(cdp, 'cancel Tavily');
    await cdp.waitFor('document.querySelector(".msg.search-context .search-card-results") && document.querySelector(".msg.search-context .search-card-results").textContent.indexOf("Searching") >= 0', 15000, 150, 'Tavily searching card');
    await sleep(500);
    await cdp.eval('window.onStopStreaming(); true');
    await cdp.waitFor('document.querySelector(".msg.search-context .search-card-results") && document.querySelector(".msg.search-context .search-card-results").textContent.indexOf("Search cancelled") >= 0', 10000, 150, 'cancelled card');
    await cdp.waitFor('document.getElementById("chat-send-btn") && !document.getElementById("chat-send-btn").disabled', 10000, 150, 'composer usable');

    const requests = fs.readFileSync(mockLog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const tavilyReq = requests.find((r) => String(r.url).endsWith('/search'));
    const chatReqs = requests.filter((r) => String(r.url).includes('/chat/completions'));
    if (!tavilyReq || tavilyReq.body.api_key !== 'test-tavily-key') throw new Error('Tavily request was not started with the test key');
    if (chatReqs.length !== 1 || requests.some((r) => JSON.stringify(r.body || {}).includes('"role":"tool"')))
      throw new Error('cancelled Tavily fired a follow-up request: ' + JSON.stringify(requests));

    const apiLogFile = require('node:path').join(require('node:os').tmpdir(), 'LLM_API_Log.json');
    const apiText = fs.readFileSync(apiLogFile, 'utf8');
    const entries = JSON.parse(apiText);
    const entry = entries.find((e) => String(e.commandName || '').includes('Web Search (Tavily)') && String(e.searchQuery || '').includes('AutoHotkey WebView2'));
    if (!entry || entry.status !== 'cancelled') throw new Error('cancelled Tavily API entry missing/status wrong: ' + JSON.stringify(entry));
    if (apiText.includes('test-tavily-key')) throw new Error('Tavily key leaked into the cancellation API log');
    const stale = fs.readdirSync(require('node:os').tmpdir()).filter((n) => /^Tavily_(Req|Out|Err)_/.test(n));
    if (stale.length) throw new Error('Tavily temp files remain after cancellation: ' + JSON.stringify(stale));
    return 'Tavily request started, Stop killed its process tree, no tool follow-up fired, cancelled card/log persisted, key redacted, temp files cleaned';
  }
});

scenarios.push({
  id: 258,
  regression: true,
  name: 'Cancelling one Tavily search does not affect another active thread stream',
  mode: 'sse-tool-call',
  settings: {
    threadTitles: { enabled: false },
    newChatStartsWith: 'openai/gpt-5-mini',
    tavilyApiKey: 'test-tavily-key'
  },
  mockOpts: { searchQuery: 'AutoHotkey WebView2', tavilyDelay: 8000, chatDelay: 3000, chatText: 'independent B response.' },
  preLaunch(dataDir, endpoint) {
    const settingsFile = require('node:path').join(dataDir, 'settings.json');
    const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    settings.tavilyEndpoint = String(endpoint).replace(/chat\/completions$/, '') + 'search';
    fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2), 'utf8');
  },
  fixtures: {
    threads: [
      { id: 't-search-a-258', title: 'Thread A', active_leaf_id: 'm-search-a-u1-258' },
      { id: 't-search-b-258', title: 'Thread B', active_leaf_id: 'm-search-b-u1-258' }
    ],
    messages: [
      { id: 'm-search-a-u1-258', thread_id: 't-search-a-258', role: 'user', content: 'A seed', token_count: 5, active_path_tokens: 5 },
      { id: 'm-search-b-u1-258', thread_id: 't-search-b-258', role: 'user', content: 'B seed', token_count: 5, active_path_tokens: 5 }
    ]
  },
  async body({ cdp, dbPath, mockLog }) {
    await showChat();
    await cdp.eval('window.loadThread("t-search-a-258"); true');
    await cdp.waitFor('window.activeThreadId === "t-search-a-258"', 15000, 250, 'A loaded');
    await enableWebSearch(cdp);
    await sendChatMessage(cdp, 'A slow Tavily search');
    await cdp.waitFor('document.querySelector(".msg.search-context .search-card-results") && document.querySelector(".msg.search-context .search-card-results").textContent.indexOf("Searching") >= 0', 15000, 150, 'A searching');

    await cdp.eval('window.loadThread("t-search-b-258"); true');
    await cdp.waitFor('window.activeThreadId === "t-search-b-258"', 10000, 200, 'B loaded');
    // The composer correctly stays in Stop mode while A searches. Trigger B
    // through the same command/IPC path used by command-mode requests so B is
    // an independently in-flight stream rather than a second UI send.
    const bTrigger = require('./helpers').runProbe('trigger-llm', ['1']);
    if (!bTrigger.posted) throw new Error('B trigger probe did not post');
    await sleep(500);

    await cdp.eval('window.loadThread("t-search-a-258"); true');
    await cdp.waitFor('window.activeThreadId === "t-search-a-258"', 10000, 200, 'A restored');
    await cdp.eval('window.onStopStreaming(); true');
    await cdp.waitFor('document.querySelector(".msg.search-context .search-card-results") && document.querySelector(".msg.search-context .search-card-results").textContent.indexOf("Search cancelled") >= 0', 10000, 150, 'A cancelled');
    await sleep(4500);

    const aRows = seed.query(dbPath, "SELECT role, content FROM messages WHERE thread_id='t-search-a-258' ORDER BY rowid");
    const bRows = seed.query(dbPath, "SELECT role, content FROM messages WHERE thread_id='t-search-b-258' ORDER BY rowid");
    if (aRows.some((r) => r.role === 'assistant') || bRows.filter((r) => r.role === 'assistant').length !== 1 || !JSON.stringify(bRows).includes('independent B response'))
      throw new Error('cancelled A disturbed B or persisted A unexpectedly: A=' + JSON.stringify(aRows) + ' B=' + JSON.stringify(bRows));
    const requests = fs.readFileSync(mockLog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    if (requests.filter((r) => String(r.url).includes('/chat/completions')).length !== 2)
      throw new Error('A cancellation caused a follow-up or B stream was lost: ' + JSON.stringify(requests));
    return 'A Tavily search cancelled while B remained active: B response persisted, A produced no follow-up/assistant, and request ownership stayed isolated';
  }
});

scenarios.push({
  id: 254,
  name: 'DeepSeek native search empty backend: one failure card, tool loop stops (no retry loop)',
  regression: true, // feature acceptance coverage retained as a regression check
  mode: 'sse-tool-call',
  settings: { threadTitles: { enabled: false } },
  mockOpts: {
    searchEmpty: true, // /responses completes with ZERO message items (real
                       // backend shape when it returns "no answer")
    chatText: 'the answer comes from DeepSeek native search.'
  },
  async body({ cdp, dbPath, mockLog }) {
    const payload = await enableWebSearch(cdp);
    if (payload.webSearch !== true) throw new Error('webSearch not enabled');

    await sendChatMessage(cdp, 'What is the latest AutoHotkey version?');
    // The placeholder card appears immediately, then becomes the failure card
    // once the empty backend stream completes.
    await cdp.waitFor('document.querySelector(".msg.search-context .search-card-results") && document.querySelector(".msg.search-context .search-card-results").textContent.indexOf("Searching") >= 0', 15000, 150, 'searching card');
    await cdp.waitFor('document.querySelector(".msg.search-context .search-card-results") && document.querySelector(".msg.search-context .search-card-results").textContent.indexOf("Web search failed") >= 0', 30000, 150, 'failure card');

    // Regression: a failed search round must NOT fire a follow-up request, so
    // the model cannot keep retrying (real-API report 2026-08-16: four failed
    // search cards in a row before the model gave up).
    const log = fs.readFileSync(mockLog, 'utf8');
    const chatReqs = log.split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((r) => String(r.url).includes('/chat/completions'));
    if (chatReqs.length !== 1) throw new Error('expected exactly 1 chat request (no follow-up after failed search), got ' + chatReqs.length);
    if (JSON.stringify(chatReqs[0].body).indexOf('"role":"tool"') >= 0) throw new Error('follow-up tool exchange fired after failed search');

    // The card carries the failure message, and the thread persists user +
    // failure card with NO assistant answer (the loop stopped).
    const cardText = await cdp.eval('document.querySelector(".msg.search-context .search-card-results") ? document.querySelector(".msg.search-context .search-card-results").textContent : ""');
    if (cardText.indexOf('DeepSeek returned no answer') < 0) throw new Error('failure card missing the reason: ' + JSON.stringify(cardText));
    const rows = seed.query(dbPath, 'SELECT role, content FROM messages ORDER BY created_at');
    if (rows.length !== 2) throw new Error('expected user + failure card, got ' + rows.length + ' rows');
    if (String(rows[1].content || '').indexOf('Web search failed') < 0)
      throw new Error('failure not persisted: ' + JSON.stringify(rows[1]));

    // The failed backend call is logged with status error.
    const apiLogFile = require('node:path').join(require('node:os').tmpdir(), 'LLM_API_Log.json');
    let apiLogEntries = [];
    try { apiLogEntries = JSON.parse(fs.readFileSync(apiLogFile, 'utf8')); } catch {}
    const searchEntry = apiLogEntries.find((e) => String(e.commandName || '').indexOf('Web Search (DeepSeek)') >= 0);
    if (!searchEntry) throw new Error('empty search request not found in the API log');
    if (String(searchEntry.status) !== 'error') throw new Error('expected error status, got ' + JSON.stringify(searchEntry.status));

    // The chat is not broken: composer is back in Send mode.
    const sendEnabled = await cdp.eval('document.getElementById("chat-send-btn") ? !document.getElementById("chat-send-btn").disabled : false');
    if (!sendEnabled) throw new Error('composer not re-enabled after failed search');

    return 'empty backend: one failure card, no follow-up request, failure persisted + logged, composer usable';
  }
});

scenarios.push({
  id: 255,
  name: 'DeepSeek native search multi-item stream: interim commentary excluded from the search result',
  regression: true, // feature acceptance coverage retained as a regression check
  mode: 'sse-tool-call',
  settings: { threadTitles: { enabled: false } },
  mockOpts: {
    searchQuery: 'AutoHotkey WebView2',
    // Real capture 2026-08-16: DeepSeek tags every message "final_answer" at
    // output_item.added and corrects interim commentary to "commentary" at
    // output_item.done. The tool result must contain ONLY the final answer.
    searchInterim: ['Let me search for the latest news.', 'Let me open the live coverage.'],
    searchText: 'DeepSeek native answer: AutoHotkey v2 hosts web content with WebView2.',
    chatText: 'the answer comes from DeepSeek\'s native search.'
  },
  async body({ cdp, dbPath, mockLog }) {
    const payload = await enableWebSearch(cdp);
    if (payload.webSearch !== true) throw new Error('webSearch not enabled');

    await sendChatMessage(cdp, 'What is the latest AutoHotkey version?');
    await waitStreamingIdle(cdp, 45000);

    const text = (await cdp.text('.msg.bot .msg-content')) || '';
    if (text.indexOf('Based on the search') < 0) throw new Error('final answer missing: ' + text.slice(0, 120));

    // Persisted search context: the real answer only - no interim narration.
    const rows = seed.query(dbPath, 'SELECT role, content FROM messages ORDER BY created_at');
    if (rows.length !== 3) throw new Error('expected 3 messages, got ' + rows.length);
    const context = String(rows[1].content || '');
    if (context.indexOf('DeepSeek native answer') < 0)
      throw new Error('search context missing the final answer: ' + JSON.stringify(rows[1]));
    if (context.indexOf('Let me search') >= 0 || context.indexOf('Let me open') >= 0)
      throw new Error('interim commentary leaked into the persisted search result: ' + JSON.stringify(rows[1]));

    // The follow-up chat request's role:"tool" message carries the clean
    // result too (the model must not see "Let me search..." as a search hit).
    const log = fs.readFileSync(mockLog, 'utf8');
    const toolReq = log.split('\n').filter(Boolean).map((l) => JSON.parse(l)).find((r) => JSON.stringify(r.body || {}).includes('"role":"tool"'));
    if (!toolReq) throw new Error('no follow-up request with the tool result');
    const toolMsg = (toolReq.body.messages || []).find((m) => m && m.role === 'tool');
    if (!toolMsg || String(toolMsg.content || '').indexOf('DeepSeek native answer') < 0)
      throw new Error('tool result missing the answer: ' + JSON.stringify(toolMsg));
    if (String(toolMsg.content || '').indexOf('Let me search') >= 0 || String(toolMsg.content || '').indexOf('Let me open') >= 0)
      throw new Error('interim commentary leaked into the tool result: ' + JSON.stringify(toolMsg));

    return 'multi-item stream: search result contains only the final answer (no interim commentary)';
  }
});

scenarios.push({
  id: 259,
  regression: true,
  name: 'Tavily search continuation keeps the originating same-thread branch after switching to a sibling branch',
  mode: 'sse-tool-call',
  settings: {
    threadTitles: { enabled: false },
    newChatStartsWith: 'openai/gpt-5-mini',
    tavilyApiKey: 'test-tavily-key'
  },
  mockOpts: {
    searchQuery: 'branch-scoped Tavily query',
    tavilyAnswer: 'Tavily result from branch A1.',
    tavilyDelay: 1800,
    chatText: 'final answer for branch A1.'
  },
  preLaunch(dataDir, endpoint) {
    const settingsFile = require('node:path').join(dataDir, 'settings.json');
    const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    settings.tavilyEndpoint = String(endpoint).replace(/chat\/completions$/, '') + 'search';
    fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2), 'utf8');
  },
  fixtures: {
    threads: [{ id: 't-branch-search-259', title: 'Branch Search', active_leaf_id: 'm-259-a2a', model_override: 'openai/gpt-5-mini' }],
    messages: [
      { id: 'm-259-u1', thread_id: 't-branch-search-259', role: 'user', content: 'root', token_count: 5, active_path_tokens: 5 },
      { id: 'm-259-a1', thread_id: 't-branch-search-259', role: 'assistant', content: 'branch A1 answer', model: 'openai/gpt-5-mini', parent_id: 'm-259-u1', sibling_group: 'sg-259', sibling_index: 0, token_count: 5, prompt_tokens: 10, active_path_tokens: 15 },
      { id: 'm-259-a1b', thread_id: 't-branch-search-259', role: 'assistant', content: 'branch A2 answer', model: 'openai/gpt-5-mini', parent_id: 'm-259-u1', sibling_group: 'sg-259', sibling_index: 1, token_count: 5, prompt_tokens: 10, active_path_tokens: 15 },
      { id: 'm-259-u2a', thread_id: 't-branch-search-259', role: 'user', content: 'follow A1', parent_id: 'm-259-a1', token_count: 0, active_path_tokens: 15 },
      { id: 'm-259-a2a', thread_id: 't-branch-search-259', role: 'assistant', content: 'A1 leaf', model: 'openai/gpt-5-mini', parent_id: 'm-259-u2a', token_count: 2, prompt_tokens: 20, active_path_tokens: 22 },
      { id: 'm-259-u2b', thread_id: 't-branch-search-259', role: 'user', content: 'follow A2', parent_id: 'm-259-a1b', token_count: 0, active_path_tokens: 15 },
      { id: 'm-259-a2b', thread_id: 't-branch-search-259', role: 'assistant', content: 'A2 leaf', model: 'openai/gpt-5-mini', parent_id: 'm-259-u2b', token_count: 6, prompt_tokens: 20, active_path_tokens: 26 }
    ]
  },
  async body({ cdp, dbPath, mockLog }) {
    await showChat();
    await cdp.waitFor('document.querySelectorAll("#thread-list .chat-item").length > 0', 15000, 300, 'thread list');
    await cdp.click('#thread-list .chat-item');
    await cdp.waitFor('chatMessages.length >= 4 && chatMessages[3] && chatMessages[3].id === "m-259-a2a"', 15000, 300, 'branch A1 loaded');
    await sleep(600);
    await enableWebSearch(cdp);
    await sendChatMessage(cdp, 'search while A1 is active');
    await cdp.waitFor('document.querySelector(".msg.search-context .search-card-results") && document.querySelector(".msg.search-context .search-card-results").textContent.indexOf("Searching") >= 0', 15000, 150, 'branch search card');

    await sleep(150);
    await cdp.click('#chat-messages .msg:nth-child(2) .msg-action-btn[title="Next branch"]');
    await cdp.waitFor('chatMessages.length >= 4 && chatMessages[3] && chatMessages[3].id === "m-259-a2b"', 15000, 250, 'branch A2 loaded');
    await waitStreamingIdle(cdp, 30000);
    await sleep(900);

    const requests = fs.readFileSync(mockLog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const followUp = requests.find((r) => JSON.stringify(r.body || {}).includes('"role":"tool"'));
    if (!followUp) throw new Error('no Tavily follow-up request with tool result');
    const messages = followUp.body.messages || [];
    const toolIndex = messages.findIndex((m) => m && m.role === 'tool');
    const assistantIndex = messages.findIndex((m) => m && m.role === 'assistant' && m.tool_calls);
    if (assistantIndex < 0 || toolIndex !== assistantIndex + 1)
      throw new Error('canonical tool ordering was lost: ' + JSON.stringify(messages));
    const bodyText = JSON.stringify(followUp.body);
    if (!bodyText.includes('branch A1 answer') || bodyText.includes('branch A2 answer') || bodyText.includes('follow A2'))
      throw new Error('follow-up used the wrong branch history: ' + bodyText);

    const contextRows = seed.query(dbPath, "SELECT id, parent_id, content FROM messages WHERE thread_id='t-branch-search-259' AND content LIKE '[Web search:%'");
    if (contextRows.length !== 1 || !String(contextRows[0].content).includes('Tavily result from branch A1'))
      throw new Error('search context missing or duplicated: ' + JSON.stringify(contextRows));
    const sentUser = seed.query(dbPath, "SELECT id FROM messages WHERE thread_id='t-branch-search-259' AND content='search while A1 is active'")[0];
    const context = contextRows[0];
    const answer = seed.query(dbPath, "SELECT parent_id, content, prompt_tokens, active_path_tokens FROM messages WHERE thread_id='t-branch-search-259' AND role='assistant' AND content LIKE '%final answer for branch A1.%'")[0];
    const activeLeaf = seed.query(dbPath, "SELECT active_leaf_id FROM chat_threads WHERE id='t-branch-search-259'")[0].active_leaf_id;
    if (!sentUser || !context || context.parent_id !== sentUser.id || !answer || answer.parent_id !== context.id)
      throw new Error('A1 context/answer parent chain is wrong: ' + JSON.stringify({ sentUser, context, answer }));
    if (activeLeaf !== 'm-259-a2b')
      throw new Error('visible A2 branch was not preserved: active_leaf_id=' + activeLeaf);
    const a2Rows = seed.query(dbPath, "SELECT content FROM messages WHERE thread_id='t-branch-search-259' AND parent_id='m-259-u2b'");
    if (a2Rows.some((r) => String(r.content).includes('final answer for branch A1') || String(r.content).includes('[Web search:')))
      throw new Error('A2 received A1 search pollution: ' + JSON.stringify(a2Rows));
    const a1User = seed.query(dbPath, "SELECT token_count, active_path_tokens FROM messages WHERE id='m-259-u2a'")[0];
    const a2User = seed.query(dbPath, "SELECT token_count, active_path_tokens FROM messages WHERE id='m-259-u2b'")[0];
    const a1Response = seed.query(dbPath, "SELECT active_path_tokens FROM messages WHERE thread_id='t-branch-search-259' AND role='assistant' AND content LIKE '%final answer for branch A1.%'")[0];
    const branchUsers = seed.query(dbPath, "SELECT id, content, token_count, active_path_tokens FROM messages WHERE thread_id='t-branch-search-259' AND role='user' ORDER BY rowid");
    if (!a1User || Number(a1User.token_count) !== 0 || Number(a1User.active_path_tokens) !== 15)
      throw new Error('A1 branch user attribution changed unexpectedly: ' + JSON.stringify({ a1User, branchUsers }));
    if (!a2User || Number(a2User.token_count) !== 0 || Number(a2User.active_path_tokens) !== 10)
      throw new Error('A2 current-path estimate changed after the off-path response: ' + JSON.stringify(a2User));
    if (!a1Response || Number(a1Response.active_path_tokens) !== 26)
      throw new Error('A1 assistant active_path_tokens is wrong: ' + JSON.stringify(a1Response));
    if (!contextRows[0] || !answer || Number(answer.prompt_tokens) !== 16)
      throw new Error('A1 token metadata was not persisted: ' + JSON.stringify({ contextRows, answer }));
    return 'switched A1 -> A2 during Tavily search: history/persistence and assistant token metadata stayed on A1, A2 and the visible leaf remained unchanged; direct positive backfill is covered by the ChatDB regression';
  }
});

scenarios.push({
  id: 260,
  regression: true,
  name: 'Two sequential web-search rounds retain every staged context exclusion until the final answer',
  mode: 'sse-tool-call',
  settings: {
    threadTitles: { enabled: false },
    newChatStartsWith: 'openai/gpt-5-mini',
    tavilyApiKey: 'test-tavily-key'
  },
  mockOpts: {
    toolRounds: 2,
    searchQueries: ['first staged query', 'second staged query'],
    tavilyAnswer: 'multi-round Tavily result.',
    tavilyDelay: 120,
    chatText: 'multi-round final answer.'
  },
  preLaunch(dataDir, endpoint) {
    const settingsFile = require('node:path').join(dataDir, 'settings.json');
    const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    settings.tavilyEndpoint = String(endpoint).replace(/chat\/completions$/, '') + 'search';
    fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2), 'utf8');
  },
  async body({ cdp, dbPath, mockLog }) {
    await enableWebSearch(cdp);
    await sendChatMessage(cdp, 'run two searches');
    await waitStreamingIdle(cdp, 45000);

    const requests = fs.readFileSync(mockLog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const chatRequests = requests.filter((r) => String(r.url).includes('/chat/completions'));
    const toolRequests = chatRequests.filter((r) => JSON.stringify(r.body || {}).includes('"role":"tool"'));
    if (toolRequests.length !== 2)
      throw new Error('expected two tool follow-ups, got ' + toolRequests.length + ': ' + JSON.stringify(chatRequests));
    for (const req of toolRequests) {
      const messages = req.body.messages || [];
      const assistantIndex = messages.findIndex((m) => m && m.role === 'assistant' && m.tool_calls);
      const toolIndex = messages.findIndex((m) => m && m.role === 'tool');
      if (assistantIndex < 0 || toolIndex !== assistantIndex + 1)
        throw new Error('non-canonical multi-round tool order: ' + JSON.stringify(messages));
      if (messages.some((m) => m && m.role === 'user' && String(m.content || '').startsWith('[Web search:')))
        throw new Error('durable search context leaked into in-flight follow-up: ' + JSON.stringify(messages));
    }

    const contexts = seed.query(dbPath, "SELECT id, content FROM messages WHERE content LIKE '[Web search:%' ORDER BY rowid");
    if (contexts.length !== 2 || !String(contexts[0].content).includes('first staged query') || !String(contexts[1].content).includes('second staged query'))
      throw new Error('expected two durable search contexts: ' + JSON.stringify(contexts));

    // Turn the tool off, then prove both durable contexts re-enter ordinary
    // history after the loop has completed.
    await cdp.clearPosted();
    await cdp.eval('document.getElementById("webSearchToggle").click()');
    await sleep(1000);
    await sendChatMessage(cdp, 'ordinary message after search loop');
    await waitStreamingIdle(cdp, 30000);
    const allChat = fs.readFileSync(mockLog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((r) => String(r.url).includes('/chat/completions'));
    const ordinary = allChat[allChat.length - 1];
    const ordinaryText = JSON.stringify(ordinary && ordinary.body);
    if (!ordinary || !ordinaryText.includes('first staged query') || !ordinaryText.includes('second staged query'))
      throw new Error('durable contexts did not return to ordinary history: ' + ordinaryText);
    return 'two staged search rounds kept both contexts excluded from follow-ups and restored them to later ordinary history';
  }
});

scenarios.push({
  id: 261,
  regression: true,
  name: 'Initial non-stream request keeps its thread/path ownership when switching threads before tool calls arrive',
  mode: 'json',
  settings: {
    threadTitles: { enabled: false },
    newChatStartsWith: 'openai/gpt-5-mini',
    tavilyApiKey: 'test-tavily-key'
  },
  mockOpts: {
    toolRounds: 1,
    searchQuery: 'non-stream scoped query',
    tavilyAnswer: 'non-stream Tavily result.',
    tavilyDelay: 120,
    jsonDelay: 1800,
    chatText: 'non-stream final answer.'
  },
  preLaunch(dataDir, endpoint) {
    const settingsFile = require('node:path').join(dataDir, 'settings.json');
    const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    settings.tavilyEndpoint = String(endpoint).replace(/chat\/completions$/, '') + 'search';
    fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2), 'utf8');
  },
  fixtures: {
    threads: [
      { id: 't-nonstream-a-261', title: 'Non-stream A', active_leaf_id: 'm-nonstream-a-u1', model_override: 'openai/gpt-5-mini' },
      { id: 't-nonstream-b-261', title: 'Non-stream B', active_leaf_id: 'm-nonstream-b-u1', model_override: 'openai/gpt-5-mini' }
    ],
    messages: [
      { id: 'm-nonstream-a-u1', thread_id: 't-nonstream-a-261', role: 'user', content: 'A initial path', token_count: 5, active_path_tokens: 5 },
      { id: 'm-nonstream-b-u1', thread_id: 't-nonstream-b-261', role: 'user', content: 'B untouched path', token_count: 5, active_path_tokens: 5 }
    ]
  },
  async body({ cdp, dbPath, mockLog }) {
    await showChat();
    await cdp.eval('window.loadThread("t-nonstream-a-261"); true');
    await cdp.waitFor('window.activeThreadId === "t-nonstream-a-261"', 15000, 250, 'A loaded');
    await enableWebSearch(cdp);
    const trigger = runProbe('trigger-llm', ['0']);
    if (!trigger.posted) throw new Error('non-stream trigger did not post');
    await cdp.waitFor('typeof isLoading !== "undefined" && isLoading === true', 15000, 100, 'initial non-stream request active');
    await sleep(250);
    await cdp.eval('window.loadThread("t-nonstream-b-261"); true');
    await cdp.waitFor('window.activeThreadId === "t-nonstream-b-261"', 10000, 200, 'B loaded during initial request');
    await sleep(6000);

    const aRows = seed.query(dbPath, "SELECT role, content FROM messages WHERE thread_id='t-nonstream-a-261' ORDER BY rowid");
    const bRows = seed.query(dbPath, "SELECT role, content FROM messages WHERE thread_id='t-nonstream-b-261' ORDER BY rowid");
    if (aRows.length !== 3 || !JSON.stringify(aRows).includes('non-stream final answer') || bRows.length !== 1)
      throw new Error('non-stream ownership was wrong: A=' + JSON.stringify(aRows) + ' B=' + JSON.stringify(bRows));
    const requests = fs.readFileSync(mockLog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const followUp = requests.find((r) => JSON.stringify(r.body || {}).includes('"role":"tool"'));
    if (!followUp || JSON.stringify(followUp.body).includes('B untouched path') || !JSON.stringify(followUp.body).includes('A initial path'))
      throw new Error('non-stream follow-up used wrong request path: ' + JSON.stringify(followUp && followUp.body));
    return 'switched A -> B during the initial single-shot request; Tavily/search/final answer stayed owned by A and B remained untouched';
  }
});

scenarios.push({
  id: 262,
  regression: true,
  name: 'A failed search does not re-enable the composer while independent request B remains active',
  mode: 'sse-tool-call',
  settings: {
    threadTitles: { enabled: false },
    newChatStartsWith: 'openai/gpt-5-mini',
    tavilyApiKey: 'test-tavily-key'
  },
  mockOpts: {
    tavilyError: true,
    tavilyDelay: 3000,
    searchQuery: 'failing Tavily query',
    toolCallDelay: 60,
    chatDelay: 15000,
    chatText: 'independent B is still running.'
  },
  preLaunch(dataDir, endpoint) {
    const settingsFile = require('node:path').join(dataDir, 'settings.json');
    const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    settings.tavilyEndpoint = String(endpoint).replace(/chat\/completions$/, '') + 'search';
    fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2), 'utf8');
  },
  fixtures: {
    threads: [
      { id: 't-fail-a-262', title: 'Fail A', active_leaf_id: 'm-fail-a-u1', model_override: 'openai/gpt-5-mini' },
      { id: 't-fail-b-262', title: 'Active B', active_leaf_id: 'm-fail-b-u1', model_override: 'openai/gpt-5-mini' }
    ],
    messages: [
      { id: 'm-fail-a-u1', thread_id: 't-fail-a-262', role: 'user', content: 'A search request', token_count: 5, active_path_tokens: 5 },
      { id: 'm-fail-b-u1', thread_id: 't-fail-b-262', role: 'user', content: 'B active request', token_count: 5, active_path_tokens: 5 }
    ]
  },
  async body({ cdp, dbPath, mockLog }) {
    await showChat();
    // Start A's search, then trigger B through the command IPC path while A's
    // Tavily backend is delayed. This keeps both operations overlapping while
    // the disabled composer prevents a second UI send.
    await cdp.eval('window.loadThread("t-fail-a-262"); true');
    await cdp.waitFor('window.activeThreadId === "t-fail-a-262"', 15000, 250, 'A loaded');
    await enableWebSearch(cdp);
    await sendChatMessage(cdp, 'fail A search');
    try {
      await cdp.waitFor('document.querySelector(".msg.search-context .search-card-results")', 15000, 150, 'A search card');
    } catch (e) {
      const requests = fs.existsSync(mockLog) ? fs.readFileSync(mockLog, 'utf8').split('\n').filter(Boolean) : [];
      throw new Error(e.message + ' mockRequests=' + requests.join(' | '));
    }
    await cdp.eval('window.loadThread("t-fail-b-262"); true');
    await cdp.waitFor('window.activeThreadId === "t-fail-b-262"', 10000, 200, 'B loaded');
    const bTrigger = runProbe('trigger-llm', ['1']);
    if (!bTrigger.posted) throw new Error('B trigger did not post');
    await sleep(700);

    const start = Date.now();
    let failedCard = false;
    while (Date.now() - start < 10000) {
      const rows = seed.query(dbPath, "SELECT content FROM messages WHERE thread_id='t-fail-a-262' AND content LIKE '[Web search:%'");
      failedCard = rows.some((r) => String(r.content).includes('Web search failed'));
      if (failedCard) break;
      await sleep(200);
    }
    if (!failedCard) throw new Error('A failure card was not persisted');
    const busyState = await cdp.eval('(() => { const b = document.getElementById("chat-send-btn"); const i = document.getElementById("chat-input"); return { inputDisabled: !!i && i.disabled, stop: !!b && String(b.onclick || "").indexOf("onStopStreaming") >= 0, loading: !!isLoading, stream: !!(typeof streamState !== "undefined" && streamState.active) }; })()');
    const posted = await cdp.postedMessages();
    if (!busyState.inputDisabled || !busyState.stop) {
      const requests = fs.existsSync(mockLog) ? fs.readFileSync(mockLog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
      throw new Error('A failure re-enabled the composer while B was active: state=' + JSON.stringify(busyState) + ' posted=' + JSON.stringify(posted.slice(-12)) + ' requests=' + JSON.stringify(requests));
    }

    const bDoneStart = Date.now();
    while (Date.now() - bDoneStart < 25000) {
      const bRows = seed.query(dbPath, "SELECT content FROM messages WHERE thread_id='t-fail-b-262' AND role='assistant'");
      if (bRows.some((r) => String(r.content).includes('independent B is still running'))) break;
      await sleep(200);
    }
    const bDoneRows = seed.query(dbPath, "SELECT content FROM messages WHERE thread_id='t-fail-b-262' AND role='assistant'");
    if (!bDoneRows.some((r) => String(r.content).includes('independent B is still running'))) {
      const debugRowsA = seed.query(dbPath, "SELECT thread_id, role, content FROM messages ORDER BY rowid");
      throw new Error('B did not finish; rows=' + JSON.stringify(debugRowsA) + '; requests=' + (fs.existsSync(mockLog) ? fs.readFileSync(mockLog, 'utf8') : ''));
    }
    await waitStreamingIdle(cdp, 25000);
    const usableAfterB = await cdp.eval('(() => { const b = document.getElementById("chat-send-btn"); const i = document.getElementById("chat-input"); return !!i && !i.disabled && !!b && String(b.onclick || "").indexOf("onChatSend") >= 0; })()');
    if (!usableAfterB) {
      const endState = await cdp.eval('(() => { const b = document.getElementById("chat-send-btn"); const i = document.getElementById("chat-input"); return { inputDisabled: !!i && i.disabled, onclick: String(b && b.onclick || ""), loading: !!isLoading, stream: !!(typeof streamState !== "undefined" && streamState.active) }; })()');
      throw new Error('composer remained disabled after B finished: ' + JSON.stringify(endState));
    }
    return 'A failure card completed while B stayed active; composer remained busy until B finished, then returned to Send mode';
  }
});

scenarios.push({
  id: 263,
  regression: true,
  name: 'A normal stream finishing first does not re-enable the composer while a Tavily search remains active',
  mode: 'sse-tool-call',
  settings: {
    threadTitles: { enabled: false },
    newChatStartsWith: 'openai/gpt-5-mini',
    tavilyApiKey: 'test-tavily-key'
  },
  mockOpts: {
    tavilyDelay: 20000,
    searchQuery: 'slow Tavily ownership query',
    toolCallDelay: 60,
    chatDelay: 120,
    chatText: 'independent B finished first.'
  },
  preLaunch(dataDir, endpoint) {
    const settingsFile = require('node:path').join(dataDir, 'settings.json');
    const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    settings.tavilyEndpoint = String(endpoint).replace(/chat\/completions$/, '') + 'search';
    fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2), 'utf8');
  },
  fixtures: {
    threads: [
      { id: 't-order-a-263', title: 'Slow search A', active_leaf_id: 'm-order-a-u1', model_override: 'openai/gpt-5-mini' },
      { id: 't-order-b-263', title: 'Fast stream B', active_leaf_id: 'm-order-b-u1', model_override: 'openai/gpt-5-mini' }
    ],
    messages: [
      { id: 'm-order-a-u1', thread_id: 't-order-a-263', role: 'user', content: 'A search path', token_count: 5, active_path_tokens: 5 },
      { id: 'm-order-b-u1', thread_id: 't-order-b-263', role: 'user', content: 'B stream path', token_count: 5, active_path_tokens: 5 }
    ]
  },
  async body({ cdp, dbPath, mockLog }) {
    await showChat();
    await cdp.eval('window.loadThread("t-order-a-263"); true');
    await cdp.waitFor('window.activeThreadId === "t-order-a-263"', 15000, 250, 'A loaded');
    await enableWebSearch(cdp);
    await sendChatMessage(cdp, 'start slow search A');
    await cdp.waitFor('document.querySelector(".msg.search-context .search-card-results") && document.querySelector(".msg.search-context .search-card-results").textContent.indexOf("Searching") >= 0', 15000, 150, 'A searching');

    await cdp.eval('window.loadThread("t-order-b-263"); true');
    await cdp.waitFor('window.activeThreadId === "t-order-b-263"', 10000, 200, 'B loaded');
    await cdp.clearPosted();
    const bTrigger = runProbe('trigger-llm', ['1']);
    if (!bTrigger.posted) throw new Error('B trigger did not post');

    // B's mock response is short while A's Tavily backend remains delayed.
    // The AHK search callback owns the message-loop turn, so verify the
    // busy-state invariant during that overlap, then verify both persisted
    // responses after A releases the turn.
    await sleep(1500);
    const aSearchRows = seed.query(dbPath, "SELECT content FROM messages WHERE thread_id='t-order-a-263' AND content LIKE '[Web search:%'");
    const busyState = await cdp.eval('(() => { const b = document.getElementById("chat-send-btn"); const i = document.getElementById("chat-input"); return { inputDisabled: !!i && i.disabled, stop: !!b && String(b.onclick || "").indexOf("onStopStreaming") >= 0, loading: !!isLoading }; })()');
    const prematureEnables = (await cdp.postedMessages()).filter((m) => m.includes('"target":"setChatButtonsEnabled"') && m.includes('"data":1'));
    if (!aSearchRows.some((r) => String(r.content).includes('Searching')) || !busyState.inputDisabled || !busyState.stop || !busyState.loading || prematureEnables.length)
      throw new Error('B completion released the composer while A was active: ' + JSON.stringify({ aSearchRows, busyState, prematureEnables }));

    const finishStart = Date.now();
    while (Date.now() - finishStart < 30000) {
      const aRows = seed.query(dbPath, "SELECT content FROM messages WHERE thread_id='t-order-a-263' AND role='assistant'");
      const bRows = seed.query(dbPath, "SELECT content FROM messages WHERE thread_id='t-order-b-263' AND role='assistant'");
      if (aRows.length && bRows.length) break;
      await sleep(200);
    }
    const aRows = seed.query(dbPath, "SELECT content FROM messages WHERE thread_id='t-order-a-263' AND role='assistant'");
    const bRows = seed.query(dbPath, "SELECT content FROM messages WHERE thread_id='t-order-b-263' AND role='assistant'");
    if (!aRows.length || !bRows.length)
      throw new Error('A/B responses were not both persisted: ' + JSON.stringify({ aRows, bRows, requests: fs.existsSync(mockLog) ? fs.readFileSync(mockLog, 'utf8') : '' }));
    await cdp.waitFor('document.getElementById("chat-input") && !document.getElementById("chat-input").disabled', 15000, 200, 'composer usable after A');
    const finalPosts = await cdp.postedMessages();
    const finalEnables = finalPosts.filter((m) => m.includes('"target":"setChatButtonsEnabled"') && (m.includes('"data":1') || m.includes('"data":true')));
    if (finalEnables.length > 1)
      throw new Error('composer returned to Send more than once after A: ' + JSON.stringify(finalEnables));
    return 'B stream finished first while A searched: composer stayed disabled/loading until A finished, then returned to Send once';
  }
});

scenarios.push({
  id: 264,
  regression: true,
  name: 'A completed stream does not leak its request path into a later request on another thread',
  mode: 'sse-success',
  settings: { threadTitles: { enabled: false }, newChatStartsWith: 'openai/gpt-5-mini' },
  fixtures: {
    threads: [
      { id: 't-path-a-264', title: 'Path A', active_leaf_id: 'm-path-a-u1', model_override: 'openai/gpt-5-mini' },
      { id: 't-path-b-264', title: 'Path B', active_leaf_id: 'm-path-b-u1', model_override: 'openai/gpt-5-mini' }
    ],
    messages: [
      { id: 'm-path-a-u1', thread_id: 't-path-a-264', role: 'user', content: 'A-only history', token_count: 5, active_path_tokens: 5 },
      { id: 'm-path-b-u1', thread_id: 't-path-b-264', role: 'user', content: 'B-only history', token_count: 5, active_path_tokens: 5 }
    ]
  },
  async body({ cdp, dbPath, mockLog }) {
    await showChat();
    await cdp.eval('window.loadThread("t-path-a-264"); true');
    await cdp.waitFor('window.activeThreadId === "t-path-a-264"', 15000, 200, 'A loaded');
    await sendChatMessage(cdp, 'A-only request');
    await waitStreamingIdle(cdp, 30000);

    await cdp.eval('window.loadThread("t-path-b-264"); true');
    await cdp.waitFor('window.activeThreadId === "t-path-b-264"', 10000, 200, 'B loaded');
    await sendChatMessage(cdp, 'B-only request');
    await waitStreamingIdle(cdp, 30000);

    const requests = fs.readFileSync(mockLog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const chatRequests = requests.filter((r) => String(r.url).includes('/chat/completions'));
    if (chatRequests.length < 2)
      throw new Error('expected A and B requests: ' + JSON.stringify(requests));
    const bBody = JSON.stringify(chatRequests[chatRequests.length - 1].body || {});
    if (!bBody.includes('B-only history') || !bBody.includes('B-only request') || bBody.includes('A-only history') || bBody.includes('A-only request'))
      throw new Error('B reused A requestPath: ' + bBody);

    const aRows = seed.query(dbPath, "SELECT role, content FROM messages WHERE thread_id='t-path-a-264' ORDER BY rowid");
    const bRows = seed.query(dbPath, "SELECT role, content FROM messages WHERE thread_id='t-path-b-264' ORDER BY rowid");
    if (aRows.length !== 3 || bRows.length !== 3 || !JSON.stringify(bRows).includes('Hello from the mock LLM'))
      throw new Error('sequential responses persisted to the wrong thread: ' + JSON.stringify({ aRows, bRows }));
    return 'after A completed, B used only B history and persisted its response in B';
  }
});

scenarios.push({
  id: 265,
  regression: true,
  name: 'A completed branch stream does not leak its request path into a later sibling-branch request',
  mode: 'sse-success',
  settings: { threadTitles: { enabled: false }, newChatStartsWith: 'openai/gpt-5-mini' },
  fixtures: {
    threads: [{ id: 't-path-branches-265', title: 'Sibling Paths', active_leaf_id: 'm-path-a1-265', model_override: 'openai/gpt-5-mini' }],
    messages: [
      { id: 'm-path-root-265', thread_id: 't-path-branches-265', role: 'user', content: 'shared root', token_count: 5, active_path_tokens: 5 },
      { id: 'm-path-a1-265', thread_id: 't-path-branches-265', role: 'assistant', content: 'A1-only branch', model: 'openai/gpt-5-mini', parent_id: 'm-path-root-265', sibling_group: 'sg-path-265', sibling_index: 0, token_count: 5, prompt_tokens: 5, active_path_tokens: 10 },
      { id: 'm-path-a2-265', thread_id: 't-path-branches-265', role: 'assistant', content: 'A2-only branch', model: 'openai/gpt-5-mini', parent_id: 'm-path-root-265', sibling_group: 'sg-path-265', sibling_index: 1, token_count: 5, prompt_tokens: 5, active_path_tokens: 10 }
    ]
  },
  async body({ cdp, dbPath, mockLog }) {
    await showChat();
    await cdp.waitFor('document.querySelectorAll("#thread-list .chat-item").length > 0', 15000, 250, 'thread list');
    await cdp.click('#thread-list .chat-item');
    await cdp.waitFor('chatMessages.length === 2 && chatMessages[1] && chatMessages[1].id === "m-path-a1-265"', 15000, 250, 'A1 loaded');
    await sendChatMessage(cdp, 'A1-only request');
    await waitStreamingIdle(cdp, 30000);

    await cdp.click('#chat-messages .msg:nth-child(2) .msg-action-btn[title="Next branch"]');
    await cdp.waitFor('chatMessages.length === 2 && chatMessages[1] && chatMessages[1].id === "m-path-a2-265"', 15000, 250, 'A2 loaded');
    await sendChatMessage(cdp, 'A2-only request');
    await waitStreamingIdle(cdp, 30000);

    const requests = fs.readFileSync(mockLog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const chatRequests = requests.filter((r) => String(r.url).includes('/chat/completions'));
    const secondBody = JSON.stringify(chatRequests[chatRequests.length - 1] && chatRequests[chatRequests.length - 1].body || {});
    if (!secondBody.includes('A2-only branch') || !secondBody.includes('A2-only request') || secondBody.includes('A1-only branch') || secondBody.includes('A1-only request'))
      throw new Error('sibling request reused A1 requestPath: ' + secondBody);

    try {
      const a2User = seed.query(dbPath, "SELECT id FROM messages WHERE thread_id='t-path-branches-265' AND content='A2-only request'")[0];
      const a2ResponseRows = a2User ? seed.query(dbPath, "SELECT id, parent_id FROM messages WHERE thread_id='t-path-branches-265' AND role='assistant' AND parent_id=? ORDER BY rowid DESC LIMIT 1", [a2User.id]) : [];
      const a2Response = a2ResponseRows[0];
      const activeLeaf = seed.query(dbPath, "SELECT active_leaf_id FROM chat_threads WHERE id='t-path-branches-265'")[0];
      const latestAssistant = seed.query(dbPath, "SELECT id FROM messages WHERE thread_id='t-path-branches-265' AND role='assistant' ORDER BY rowid DESC LIMIT 1")[0];
      if (!a2User || !a2Response || a2Response.parent_id !== a2User.id || !activeLeaf || activeLeaf.active_leaf_id !== (latestAssistant || {}).id)
        throw new Error(JSON.stringify({ a2User, a2Response, activeLeaf, latestAssistant }));
    } catch (e) {
      throw new Error('A2 response parent/active branch audit failed: ' + e.message);
    }
    return 'after A1 completed and navigation moved to A2, the ordinary request used A2 history and persisted under the A2 send leaf';
  }
});

module.exports = scenarios;
