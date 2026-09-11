// scenarios/usage-tokens.js - Usage dashboards and token/cost accounting
//
// Part of the headless E2E suite (entry: ../e2e-suite.js). Scenarios launch
// the REAL app against an isolated profile and drive it via WebView2 CDP +
// AHK probes; `noApp: true` scenarios are static source checks. Add new
// scenarios here when a bug is verified/fixed - see ../README.md and
// BUG_HUNT_REPORT.md for the workflow. Scenario ids are stable (the report
// references them); never renumber.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const vm = require('node:vm');
const launcher = require('../launch');
const seed = require('../seed');
const { sleep, showChat, openSettings, openSection, sendChatMessage, waitStreamingIdle } = require('./helpers');

const scenarios = [];

scenarios.push({
  id: 9,
  name: 'Quick Access > Usage Dashboard is wired end-to-end (static check of menu -> IPC -> WebView path)',
  mode: null,
  noApp: true,
  settings: {},
  regression: true, // REFUTED bug kept as a regression check (dashboard must keep opening)
  async body() {
    // Zero-injection: assert the full wiring chain (the live check needed the
    // backtick menu, which injected keystrokes into the user's desktop).
    const rp = fs.readFileSync(path.join(launcher.REPO_ROOT, 'app', 'RequestProcessor.ahk'), 'utf8');
    const dash = fs.readFileSync(path.join(launcher.REPO_ROOT, 'app', 'viewers', 'UsageDashboard.ahk'), 'utf8');
    const cw = fs.readFileSync(path.join(launcher.REPO_ROOT, 'chat', 'ChatWindow.ahk'), 'utf8');
    const routerJs = fs.readFileSync(path.join(launcher.REPO_ROOT, 'webui', 'js', 'shared', 'web-message-router.js'), 'utf8');
    const actionHandled = /command = "usage:"[\s\S]*?ShowUsageDashboard\(\)/.test(rp);
    const ipcSent = /CustomMessages\.notifyShowDashboard\(hwnd\)/.test(dash);
    const ipcHandled = /WM_SHOW_DASHBOARD[\s\S]*?postWebMessage\("showDashboard"\)/.test(cw);
    const jsShows = /case 'showDashboard':[\s\S]*?AppShell\.showDashboard\(\)/.test(routerJs);
    if (!actionHandled || !ipcSent || !ipcHandled || !jsShows)
      throw new Error('Quick Access -> usage dashboard wiring broken: ' + JSON.stringify({ actionHandled, ipcSent, ipcHandled, jsShows }));
    return 'usage: action -> ShowUsageDashboard -> WM_SHOW_DASHBOARD -> showDashboard -> _showDashboard (wired; no key injection)';
  }
});

scenarios.push({
  id: 19,
  name: 'Dashboard "All Time" chart caps at 365 days while summary sums all rows',
  regression: true, // FIXED bug kept as a regression check (All Time must keep spanning the full history)
  mode: null,
  settings: {},
  fixtures: {
    chatUsage: [
      { date: seed.daysAgo(400), model: 'deepseek/deepseek-v4-flash', provider: 'deepseek', call_count: 1, prompt_tokens: 10, completion_tokens: 5, cached_tokens: 2, input_cost: 2, cached_input_cost: 0.2, output_cost: 3, total_cost: 5 },
      { date: seed.daysAgo(1), model: 'deepseek/deepseek-v4-flash', provider: 'deepseek', call_count: 1, prompt_tokens: 10, completion_tokens: 5, cached_tokens: 0, input_cost: 0.4, cached_input_cost: 0, output_cost: 0.6, total_cost: 1 }
    ]
  },
  async body({ cdp }) {
    await showChat();
    await cdp.click('#dashboard-icon');
    await cdp.waitFor('typeof allData !== "undefined" && allData.chat && allData.chat.length >= 1', 15000, 300, 'dashboard data');
    await cdp.eval('document.getElementById("timeRange").value = "all"; loadData(); true');
    await cdp.waitFor('typeof allData !== "undefined" && allData.chat.length === 2', 15000, 300, 'all-time data');
    const totalCost = await cdp.text('#totalCost');
    const labels = await cdp.eval('mainChart ? mainChart.data.labels.length : -1');
    if (totalCost !== '$6.00') throw new Error('summary total = ' + totalCost + ' (expected $6.00 = all-time)');
    if (labels !== 401) throw new Error('chart labels = ' + labels + ' (expected 401 = full history incl. the 400-day-old row)');
    const firstLabel = await cdp.eval('mainChart.data.labels[0]');
    return 'All Time: summary shows $6.00 (includes 400-day-old row) and chart spans the full history — ' + labels + ' labels, first = ' + firstLabel;
  }
});

scenarios.push({
  id: 29,
  name: 'Blank cached-input price costs 0 instead of the advertised 10% fallback',
  mode: null,
  noApp: true,
  regression: true, // FIXED: blank cachedInput now falls back to 10% (was throw)
  async body() {
    const outFile = path.join(os.tmpdir(), 'llm-cost-probe-' + process.pid + '.json');
    try { fs.unlinkSync(outFile); } catch {}
  const probe = path.join(__dirname, '..', 'probe-cost.ahk');
    const res = spawnSync(launcher.AHK, ['/ErrorStdOut', probe, outFile], { timeout: 25000, windowsHide: true, encoding: 'utf8' });
    if (res.error) throw new Error('cost probe spawn failed/timed out: ' + res.error.message);
    if (res.stderr) process.stderr.write('[probe-cost stderr] ' + res.stderr);
    const text = fs.readFileSync(outFile, 'utf-8');
    // FIXED: blank cachedInput ("" stored by the settings round-trip) now falls back to 10% (1.0) like the missing-property control, no throw.
    if (!text.includes('BUG29 throw=NO')) throw new Error('blank cachedInput should not throw after fix: ' + text);
    if (!text.includes('BUG29 missingFallback=OK')) throw new Error('missing cachedInput fallback broken: ' + text);
    if (!text.includes('blankCost=1')) throw new Error('blank cachedInput should fallback to 1 (10% of 10): ' + text);
    return text.split('\n').filter((l) => l.includes('Cost=') || l.includes('BUG29')).join(' | ');
  }
});

scenarios.push({
  id: 42,
  name: 'Usage dashboard chart date labels use the local date (no UTC day shift in UTC+x timezones)',
  regression: true, // FIXED by the step-1 IPC refactor (8df50b4): getDateRangeLabels keys labels by local date
  mode: null,
  noApp: true,
  async body() {
    const dashSrc = fs.readFileSync(path.join(launcher.REPO_ROOT, 'webui', 'js', 'usage-dashboard.js'), 'utf8');
    const m = dashSrc.match(/function getDateRangeLabels\(\) \{[\s\S]*?\n\}/);
    if (!m) throw new Error('getDateRangeLabels not found in usage-dashboard.js');
    const script = `
      const RealDate = Date;
      const fixed = new RealDate('2026-08-02T21:30:00Z'); // 2026-08-03 00:30 in UTC+3 (Asia/Jerusalem)
      const MockDate = class extends RealDate {
        constructor(...args) { if (args.length === 0) super(fixed.getTime()); else super(...args); }
      };
      global.Date = MockDate;
      global.allData = null;
      global.document = { getElementById: (id) => id === 'timeRange' ? { value: 'day' } : null };
      ${m[0]}
      console.log('LABELS ' + JSON.stringify(getDateRangeLabels()));
    `;
    const res = spawnSync(process.execPath, ['-e', script], {
      encoding: 'utf8', timeout: 15000, windowsHide: true,
      env: Object.assign({}, process.env, { TZ: 'Asia/Jerusalem' })
    });
    if (res.error || res.status !== 0)
      throw new Error('label probe failed: ' + (res.error && res.error.message) + ' ' + (res.stderr || res.stdout || ''));
    const line = String(res.stdout).split(/\r?\n/).find((l) => l.startsWith('LABELS '));
    if (!line) throw new Error('no LABELS line in probe output: ' + String(res.stdout));
    const labels = JSON.parse(line.slice(7));
    const localToday = '2026-08-03';
    const lastLabel = labels[labels.length - 1];
    // FIXED: labels are keyed by the LOCAL date (localDateKey), so a UTC+x
    // clock stuck at 2026-08-02T21:30Z must still label today "2026-08-03"
    // (the old toISOString() path produced "2026-08-02" and misplotted rows).
    if (lastLabel !== localToday)
      throw new Error('chart label for today shifted to UTC date: ' + JSON.stringify(labels) + ' (expected ' + localToday + ')');
    return 'range=day labels=' + JSON.stringify(labels) + ' — the "today" slot is labeled ' + lastLabel + ' (local date, not the UTC-shifted date)';
  }
});

scenarios.push({
  id: 52,
  name: 'Usage dashboard counts command thinking tokens once (completion_tokens already includes thinking)',
  regression: true, // FIXED bug kept as a regression check (command completion_tokens must not be double-counted)
  mode: null,
  settings: {},
  fixtures: {
    chatUsage: [
      { date: seed.daysAgo(0), model: 'gpt-5-mini', provider: 'openai', call_count: 1, prompt_tokens: 10, completion_tokens: 100, thinking_tokens: 40, cached_tokens: 0, input_cost: 0, cached_input_cost: 0, output_cost: 0, total_cost: 0 }
    ]
  },
  async body({ cdp, dbPath }) {
    // Insert a command_usage row with the SAME shape the app writes for inline
    // commands: completion_tokens is the FULL completion (thinking included,
    // per ResponseParser.ParseChatResponse) plus a separate thinking_tokens
    // column. The fixtures builder has no commandUsage support, so insert it
    // directly before the dashboard loads.
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(dbPath);
    db.exec("INSERT INTO command_usage (date, model, provider, command_name, call_count, prompt_tokens, completion_tokens, thinking_tokens, cached_tokens, input_cost, cached_input_cost, output_cost, total_cost, total_response_time_ms, total_ttft_ms) VALUES ('" + seed.daysAgo(0) + "', 'gpt-5-mini', 'openai', 'Test', 1, 10, 100, 40, 0, 0, 0, 0, 0, 0, 0)");
    db.close();

    await showChat();
    await cdp.click('#dashboard-icon');
    await cdp.waitFor('typeof allData !== "undefined" && allData.chat && allData.commands && allData.chat.length >= 1 && allData.commands.length >= 1', 15000, 300, 'dashboard data');
    await cdp.eval('document.getElementById("timeRange").value = "all"; loadData(); true');
    await cdp.waitFor('typeof allData !== "undefined" && allData.chat.length === 1 && allData.commands.length === 1', 15000, 300, 'all-time data');
    await sleep(500); // let the async host-object query + render settle
    const totalTokens = await cdp.text('#totalTokens');
    // FIXED (bug #52): renderSummary and renderModelSections count
    // command_usage.completion_tokens once (it already includes thinking,
    // matching chat's output_tokens).
    if (totalTokens !== '220')
      throw new Error('command thinking tokens still double-counted (bug #52 not fixed): ' + totalTokens);
    return 'chat row (prompt 10 + completion 100) + command row (prompt 10 + completion 100 + thinking 40): dashboard Total Tokens = ' + totalTokens +
      ' (220 = counted once; 260 = thinking double-counted for the command)';
  }
});

scenarios.push({
  id: 53,
  name: 'Dashboard "Last 24 Hours" summary matches the chart (local today only)',
  regression: true, // FIXED bug kept as a regression check (day-range summary must not over-count yesterday)
  mode: null,
  settings: {},
  fixtures: {
    chatUsage: [
      { date: seed.daysAgo(1), model: 'deepseek/deepseek-v4-flash', provider: 'deepseek', call_count: 1, prompt_tokens: 100, completion_tokens: 50, cached_tokens: 0, input_cost: 1, cached_input_cost: 0, output_cost: 1, total_cost: 2 },
      { date: seed.daysAgo(0), model: 'deepseek/deepseek-v4-flash', provider: 'deepseek', call_count: 1, prompt_tokens: 50, completion_tokens: 25, cached_tokens: 0, input_cost: 1, cached_input_cost: 0, output_cost: 1, total_cost: 2 }
    ]
  },
  async body({ cdp }) {
    await showChat();
    await cdp.click('#dashboard-icon');
    await cdp.waitFor('typeof allData !== "undefined" && allData.chat && allData.chat.length >= 2', 15000, 300, 'dashboard data');
    await cdp.eval('document.getElementById("timeRange").value = "day"; loadData(); true');
    // Wait for the DAY render specifically: the day chart has exactly one
    // "today" label (the month render, which also passes the data-count check,
    // has 30 labels and would race with this assertion).
    await cdp.waitFor('mainChart && mainChart.data.labels.length === 1', 15000, 300, 'day-range chart rendered');
    const totalCost = await cdp.text('#totalCost');
    const labels = await cdp.eval('mainChart.data.labels.length');
    // FIXED (bug #53): the "day" SQL filter now uses the LOCAL today date
    // (usage rows are stored with local dates and the chart plots one local
    // "today" label), so the summary matches the chart.
    if (totalCost !== '$2.00')
      throw new Error('day summary still over-counts yesterday (bug #53 not fixed): cost=' + totalCost + ' labels=' + labels);
    return 'seeded yesterday + today rows (total $4.00): "Last 24 Hours" summary shows ' + totalCost +
      ' (today only) while the chart has ' + labels + ' label(s) - summary matches the chart';
  }
});

scenarios.push({
  id: 118,
  name: 'Editing an assistant message with "Save as Branch" records a fake API request in the usage dashboard (no API call happens)',
  regression: true, // FIXED bug kept as a regression check (branch-edit copies must not record chat_usage)
  mode: null,
  settings: {},
  fixtures: {
    threads: [{ id: 't-fake-118', title: 'Branch Edit Assistant', active_leaf_id: 'm-118-a1' }],
    messages: [
      { id: 'm-118-u1', thread_id: 't-fake-118', role: 'user', content: 'original question', token_count: 12, active_path_tokens: 12 },
      { id: 'm-118-a1', thread_id: 't-fake-118', role: 'assistant', content: 'original answer', model: 'deepseek/deepseek-v4-flash', parent_id: 'm-118-u1', token_count: 9, active_path_tokens: 21 }
    ]
  },
  async body({ cdp, dbPath }) {
    await showChat();
    await cdp.waitFor('document.querySelectorAll("#thread-list .chat-item").length > 0', 15000, 300, 'thread list');
    await cdp.click('#thread-list .chat-item');
    await cdp.waitFor('document.querySelectorAll("#chat-messages .msg").length >= 2', 15000, 300, 'thread loaded');
    await sleep(700);
    // Edit the assistant message and save it as a NEW BRANCH - this is a pure
    // local DB operation: no LLM request is fired for role=assistant.
    await cdp.click('#chat-messages .msg:nth-child(2) .msg-action-btn[title="Edit"]');
    await cdp.waitFor('document.querySelector("#chat-messages .msg:nth-child(2)").classList.contains("editing")', 5000, 200, 'edit ui open');
    await cdp.type('#chat-messages .msg:nth-child(2) .msg-edit-textarea', 'edited answer branch');
    await cdp.click('#chat-messages .msg:nth-child(2) .save-branch');
    // The new message is a sibling of the edited assistant (same parent u1),
    // so the active path becomes [u1, new message].
    await cdp.waitFor('chatMessages.length === 2 && chatMessages[1] && chatMessages[1].content === "edited answer branch"', 15000, 300, 'branch message created');
    await sleep(700);

    const rows = seed.query(dbPath, "SELECT call_count, prompt_tokens, completion_tokens, cached_tokens FROM chat_usage WHERE model='deepseek/deepseek-v4-flash'");
    // FIXED (bug #118): branch-edit inserts are local_copy - MessageRepo.Insert
    // never upserts chat_usage for them, so the dashboard stays at zero API
    // requests (no request happened).
    if (rows.length !== 0)
      throw new Error('branch-edit still recorded a fake request: ' + JSON.stringify(rows));
    const thread = seed.query(dbPath, 'SELECT cumulative_input_tokens, cumulative_output_tokens FROM chat_threads WHERE id = ?', ['t-fake-118'])[0];
    return 'assistant branch-edit produced NO chat_usage row - dashboard API Requests stays 0 (no API call); thread cumulative counters stay ' +
      JSON.stringify(thread);
  }
});

scenarios.push({
  id: 119,
  name: 'Live exchange: token counters, header tooltips and dashboard all agree (regression check for the usage pipeline)',
  regression: true, // guards the end-to-end usage accounting: insert -> chat_usage -> header -> dashboard
  mode: 'sse-success',
  settings: {},
  async body({ cdp, dbPath }) {
    await showChat();
    // Fresh profile: send the first message (mock usage: prompt 12, completion 9, cached 4).
    await sendChatMessage(cdp, 'count my tokens');
    await waitStreamingIdle(cdp, 40000);
    await sleep(1200);

    const rows = seed.query(dbPath, "SELECT model, prompt_tokens, completion_tokens, cached_tokens, call_count FROM chat_usage");
    if (rows.length !== 1 || rows[0].prompt_tokens !== 12 || rows[0].completion_tokens !== 9 || rows[0].cached_tokens !== 4 || rows[0].call_count !== 1)
      throw new Error('chat_usage row wrong: ' + JSON.stringify(rows));
    const msgs = seed.query(dbPath, "SELECT role, token_count, thinking_tokens, cached_tokens, prompt_tokens, active_path_tokens FROM messages ORDER BY created_at");
    if (msgs.length !== 2) throw new Error('expected 2 messages, got ' + msgs.length);
    const asst = msgs[1];
    if (asst.role !== 'assistant' || asst.prompt_tokens !== 12 || asst.token_count !== 9 || asst.active_path_tokens !== 21)
      throw new Error('assistant token fields wrong: ' + JSON.stringify(asst));
    const thread = seed.query(dbPath, 'SELECT cumulative_input_tokens, cumulative_output_tokens, cumulative_cached_tokens FROM chat_threads')[0];
    if (thread.cumulative_input_tokens !== 12 || thread.cumulative_output_tokens !== 9 || thread.cumulative_cached_tokens !== 4)
      throw new Error('thread cumulative counters wrong: ' + JSON.stringify(thread));

    // Header token bar: context 21, input 12, output 9, cache 4.
    const bar = await cdp.eval('document.getElementById("tokenBar").textContent');
    if (String(bar).indexOf('21') < 0 || String(bar).indexOf('\u2191 12') < 0 || String(bar).indexOf('\u2193 9') < 0 || String(bar).indexOf('4') < 0)
      throw new Error('header token bar wrong: ' + JSON.stringify(bar));
    // Cost tooltip and totals must agree with the DB (input+cached split).
    const costTip = await cdp.attr('#tokenBar .tu-item:last-child', 'title');
    if (!costTip || costTip.indexOf('Input: $') < 0 || costTip.indexOf('Cached: $') < 0 || costTip.indexOf('Output: $') < 0)
      throw new Error('cost tooltip malformed: ' + JSON.stringify(costTip));

    // Per-message token popover on the assistant bubble.
    await cdp.click('#chat-messages .msg:nth-child(2) .stat-btn');
    await cdp.waitFor('document.querySelector(".stat-toggle.pop-open") !== null', 5000, 200, 'popover open');
    const pop = await cdp.text('.stat-toggle.pop-open .stat-popover');
    if (String(pop).indexOf('Output: 9 tokens') < 0 || String(pop).indexOf('Cache: 4 tokens') < 0)
      throw new Error('assistant token popover wrong: ' + JSON.stringify(pop));

    // Dashboard: 1 call, 21 total tokens.
    await cdp.click('#dashboard-icon');
    await cdp.waitFor('typeof allData !== "undefined" && allData.chat && allData.chat.length >= 1', 15000, 300, 'dashboard data');
    await sleep(600);
    const totalTokens = await cdp.text('#totalTokens');
    const totalCalls = await cdp.text('#totalCalls');
    // Bug #167: the title-generation command call is ALSO tracked now, so the
    // dashboard shows 2 calls (1 chat + 1 title-gen, which yields no tokens
    // when the harness cannot read the title response). The chat exchange's 21
    // tokens are unchanged.
    if (totalTokens !== '21' || totalCalls !== '2')
      throw new Error('dashboard totals wrong: tokens=' + totalTokens + ' calls=' + totalCalls);
    return 'live exchange: chat_usage row=' + JSON.stringify(rows[0]) + ', thread counters=' + JSON.stringify(thread) +
      ', header=' + JSON.stringify(bar) + ', popover=' + JSON.stringify(pop) + ', dashboard tokens=' + totalTokens + ' calls=' + totalCalls +
      ' (2 calls = 1 chat + 1 title-gen command, bug #167)';
  }
});

scenarios.push({
  id: 123,
  name: '"Save as Branch" uses an estimate for edited assistant text while preserving historical API metadata',
  regression: true,
  mode: null,
  settings: {},
  fixtures: {
    threads: [{
      id: 't-branch-123', title: 'Branch Token Loss', active_leaf_id: 'm-123-a1',
      cumulative_input_tokens: 12, cumulative_output_tokens: 9
    }],
    messages: [
      { id: 'm-123-u1', thread_id: 't-branch-123', role: 'user', content: 'original question', token_count: 12, active_path_tokens: 12 },
      { id: 'm-123-a1', thread_id: 't-branch-123', role: 'assistant', content: 'original answer', model: 'deepseek/deepseek-v4-flash', parent_id: 'm-123-u1', token_count: 9, prompt_tokens: 12, active_path_tokens: 21 }
    ]
  },
  async body({ cdp, dbPath }) {
    await showChat();
    await cdp.waitFor('document.querySelectorAll("#thread-list .chat-item").length > 0', 15000, 300, 'thread list');
    await cdp.click('#thread-list .chat-item');
    await cdp.waitFor('document.querySelectorAll("#chat-messages .msg").length >= 2', 15000, 300, 'thread loaded');
    await sleep(700);
    // Header context before the branch: the a1 leaf carries 21 (prompt 12 + output 9).
    const barBefore = await cdp.text('#tokenBar .tu-item:first-child .tu-val');
    if (String(barBefore).indexOf('21') !== 0)
      throw new Error('expected header context 21 before branch edit, got ' + JSON.stringify(barBefore));
    // Edit the assistant and save it as a NEW BRANCH (a pure local copy).
    await cdp.click('#chat-messages .msg:nth-child(2) .msg-action-btn[title="Edit"]');
    await cdp.waitFor('document.querySelector("#chat-messages .msg:nth-child(2)").classList.contains("editing")', 5000, 200, 'edit ui open');
    await cdp.type('#chat-messages .msg:nth-child(2) .msg-edit-textarea', 'edited answer branch');
    await cdp.click('#chat-messages .msg:nth-child(2) .save-branch');
    await cdp.waitFor('chatMessages.length === 2 && chatMessages[1] && chatMessages[1].content === "edited answer branch"', 15000, 300, 'branch message created');
    await sleep(900);

    const rows = seed.query(dbPath, "SELECT token_count, prompt_tokens, thinking_tokens, cached_tokens, active_path_tokens FROM messages WHERE content='edited answer branch'");
    if (rows.length !== 1) throw new Error('branch copy row missing: ' + JSON.stringify(rows));
    const r = rows[0];
    // The edited local copy has no historical prompt/cost attribution. Its
    // current context uses the text estimate: ceil(19/3)=7, so 12+7=19.
    if (Number(r.active_path_tokens) !== 19)
      throw new Error('branch copy active_path_tokens = ' + r.active_path_tokens + ' (expected current estimate 19)');
    if (Number(r.token_count) !== 7 || Number(r.prompt_tokens) !== 0)
      throw new Error('branch copy should use current text estimate without historical prompt tokens: ' + JSON.stringify(r));
    // Header reflects the edited content estimate, not the source API prompt.
    const barAfter = await cdp.text('#tokenBar .tu-item:first-child .tu-val');
    if (String(barAfter).indexOf('19') !== 0)
      throw new Error('header context after branch edit = ' + JSON.stringify(barAfter) + ' (expected 19)');
    // Per-message popover shows the current text estimate, not stale API data.
    await cdp.click('#chat-messages .msg:nth-child(2) .stat-btn');
    await cdp.waitFor('document.querySelector(".stat-toggle.pop-open") !== null', 5000, 200, 'popover open');
    const pop = await cdp.text('.stat-toggle.pop-open .stat-popover');
    if (String(pop).indexOf('Output: 7 tokens') < 0)
      throw new Error('branch popover lost the output attribution: ' + JSON.stringify(pop));
    return 'branch copy DB=' + JSON.stringify(r) + ', header context before=' + JSON.stringify(barBefore) +
      ' after=' + JSON.stringify(barAfter) + ' popover=' + JSON.stringify(pop) + ' (copy uses 19/7 current estimate; historical a1 remains unchanged)';
  }
});

scenarios.push({
  id: 127,
  name: 'Complex branched tree stays DB-consistent: FTS == messages, valid parents/leaf, and token counters match the API calls (regression audit)',
  regression: true, // guards DB integrity + token accounting through send/retry/branch-edit flows
  mode: 'sse-success',
  settings: {},
  async body({ cdp, dbPath }) {
    await showChat();
    // Exchange 1.
    await sendChatMessage(cdp, 'first question');
    await waitStreamingIdle(cdp, 40000);
    // Exchange 2.
    await sendChatMessage(cdp, 'second question');
    await waitStreamingIdle(cdp, 40000);
    await sleep(900);
    // Retry the last assistant (creates a sibling branch).
    await cdp.click('#chat-messages .msg:last-child .msg-action-btn[title="Retry"]');
    await waitStreamingIdle(cdp, 40000);
    await sleep(900);
    // Edit the LAST USER message and save as a NEW BRANCH (fires a real call).
    const userIdx = await cdp.eval('chatMessages.length - 2');
    await cdp.click('#chat-messages .msg:nth-child(' + (userIdx + 1) + ') .msg-action-btn[title="Edit"]');
    await cdp.waitFor('document.querySelector("#chat-messages .msg:nth-child(' + (userIdx + 1) + ')").classList.contains("editing")', 5000, 200, 'edit ui open');
    await cdp.type('#chat-messages .msg:nth-child(' + (userIdx + 1) + ') .msg-edit-textarea', 'second question (branch)');
    await cdp.click('#chat-messages .msg:nth-child(' + (userIdx + 1) + ') .save-branch');
    await waitStreamingIdle(cdp, 40000);
    await sleep(1200);

    const dbPath_ = dbPath;
    const counts = seed.query(dbPath_, "SELECT (SELECT COUNT(*) FROM messages) AS msgs, (SELECT COUNT(*) FROM messages_fts) AS fts");
    if (counts[0].msgs !== counts[0].fts)
      throw new Error('FTS out of sync: messages=' + counts[0].msgs + ' fts=' + counts[0].fts);
    // Every message's parent must live in the same thread.
    const badParent = seed.query(dbPath_, "SELECT m.id FROM messages m LEFT JOIN messages p ON p.id = m.parent_id WHERE m.parent_id IS NOT NULL AND (p.id IS NULL OR p.thread_id <> m.thread_id)");
    if (badParent.length)
      throw new Error('dangling/cross-thread parents: ' + JSON.stringify(badParent));
    // The active leaf must exist.
    const badLeaf = seed.query(dbPath_, "SELECT t.id FROM chat_threads t LEFT JOIN messages m ON m.id = t.active_leaf_id WHERE t.active_leaf_id IS NOT NULL AND m.id IS NULL");
    if (badLeaf.length)
      throw new Error('threads with dangling active_leaf: ' + JSON.stringify(badLeaf));
    // Thread cumulative counters must equal the per-message API ground truth.
    const sums = seed.query(dbPath_, "SELECT COALESCE(SUM(prompt_tokens),0) AS inp, COALESCE(SUM(token_count + thinking_tokens),0) AS outp FROM messages WHERE role='assistant'");
    const thread = seed.query(dbPath_, 'SELECT cumulative_input_tokens, cumulative_output_tokens FROM chat_threads')[0];
    if (Number(thread.cumulative_input_tokens) !== Number(sums[0].inp) || Number(thread.cumulative_output_tokens) !== Number(sums[0].outp))
      throw new Error('thread counters mismatch: thread=' + JSON.stringify(thread) + ' assistant-sums=' + JSON.stringify(sums[0]));
    // Usage dashboard row: 4 API calls (2 sends + retry + user-branch-edit),
    // each mock call = prompt 12 / completion 9 / cached 4.
    const usage = seed.query(dbPath_, 'SELECT call_count, prompt_tokens, completion_tokens, cached_tokens FROM chat_usage');
    if (usage.length !== 1 || usage[0].call_count !== 4 || usage[0].prompt_tokens !== 48 || usage[0].completion_tokens !== 36 || usage[0].cached_tokens !== 16)
      throw new Error('chat_usage wrong: ' + JSON.stringify(usage));
    return 'messages=' + counts[0].msgs + ' fts=' + counts[0].fts + ' parents/leaf valid, counters=' +
      JSON.stringify(thread) + ' match assistant sums=' + JSON.stringify(sums[0]) + ', chat_usage=' + JSON.stringify(usage[0]);
  }
});

scenarios.push({
  id: 132,
  regression: true, // mid-path retry audit: sibling branch created in the middle of the tree stays DB-consistent
  name: 'Mid-conversation Retry creates a sibling branch in the middle of the tree and keeps counters/usage consistent (audit)',
  mode: 'sse-success',
  settings: {},
  async body({ cdp, dbPath }) {
    await showChat();
    // Exchange 1.
    await sendChatMessage(cdp, 'first question');
    await waitStreamingIdle(cdp, 40000);
    // Exchange 2.
    await sendChatMessage(cdp, 'second question');
    await waitStreamingIdle(cdp, 40000);
    await sleep(900);
    // Retry the FIRST assistant (mid-path retry): the new answer becomes a
    // sibling of a1 with parent u1, and u2/a2 move off the active path.
    await cdp.click('#chat-messages .msg:nth-child(2) .msg-action-btn[title="Retry"]');
    await waitStreamingIdle(cdp, 40000);
    await sleep(1200);

    const counts = seed.query(dbPath, "SELECT (SELECT COUNT(*) FROM messages) AS msgs, (SELECT COUNT(*) FROM messages_fts) AS fts");
    if (counts[0].msgs !== 5) throw new Error('expected 5 messages (u1,a1,u2,a2,a1b), got ' + counts[0].msgs);
    if (counts[0].msgs !== counts[0].fts) throw new Error('FTS out of sync: ' + JSON.stringify(counts[0]));
    const badParent = seed.query(dbPath, "SELECT m.id FROM messages m LEFT JOIN messages p ON p.id = m.parent_id WHERE m.parent_id IS NOT NULL AND (p.id IS NULL OR p.thread_id <> m.thread_id)");
    if (badParent.length) throw new Error('dangling/cross-thread parents: ' + JSON.stringify(badParent));
    const badLeaf = seed.query(dbPath, "SELECT t.id FROM chat_threads t LEFT JOIN messages m ON m.id = t.active_leaf_id WHERE t.active_leaf_id IS NOT NULL AND m.id IS NULL");
    if (badLeaf.length) throw new Error('dangling active_leaf: ' + JSON.stringify(badLeaf));
    // The retried answer must be a sibling of a1 (same parent u1, sibling group).
    const sibs = seed.query(dbPath, "SELECT sibling_group, sibling_index FROM messages WHERE parent_id = (SELECT id FROM messages WHERE role='user' AND content='first question') ORDER BY sibling_index");
    if (sibs.length !== 2 || sibs[0].sibling_group !== sibs[1].sibling_group)
      throw new Error('retried answer is not a sibling of a1: ' + JSON.stringify(sibs));
    // Counters == assistant ground truth sums (3 API calls, mock: 12/9/4 each).
    const sums = seed.query(dbPath, "SELECT COALESCE(SUM(prompt_tokens),0) AS inp, COALESCE(SUM(token_count + thinking_tokens),0) AS outp, COALESCE(SUM(cached_tokens),0) AS ckt FROM messages WHERE role='assistant'");
    const thread = seed.query(dbPath, 'SELECT cumulative_input_tokens, cumulative_output_tokens, cumulative_cached_tokens FROM chat_threads')[0];
    if (Number(thread.cumulative_input_tokens) !== Number(sums[0].inp) || Number(thread.cumulative_output_tokens) !== Number(sums[0].outp) || Number(thread.cumulative_cached_tokens) !== Number(sums[0].ckt))
      throw new Error('thread counters mismatch: thread=' + JSON.stringify(thread) + ' assistant-sums=' + JSON.stringify(sums[0]));
    const usage = seed.query(dbPath, 'SELECT call_count, prompt_tokens, completion_tokens, cached_tokens FROM chat_usage')[0];
    if (!usage || usage.call_count !== 3 || usage.prompt_tokens !== 36 || usage.completion_tokens !== 27 || usage.cached_tokens !== 12)
      throw new Error('chat_usage wrong after mid-path retry: ' + JSON.stringify(usage));
    return 'mid-path retry: messages=' + counts[0].msgs + ' fts=' + counts[0].fts + ' siblings=' +
      JSON.stringify(sibs) + ' counters=' + JSON.stringify(thread) + ' match sums=' + JSON.stringify(sums[0]) +
      ' chat_usage=' + JSON.stringify(usage);
  }
});

scenarios.push({
  id: 133,
  regression: true, // FIXED bug kept as a regression check (cancelled stream must not bill usage)
  name: 'Cancelling a stream mid-response records a fake 0-token API request in chat_usage and inflates the thread cumulative input by the un-billed parent context (header vs dashboard disagree)',
  mode: 'sse-success',
  settings: {},
  mockOpts: { chunkDelay: 800 },
  async body({ cdp, dbPath }) {
    await showChat();
    // Exchange 1 completes: u1 + a1 (mock usage prompt 12 / completion 9 / cached 4).
    await sendChatMessage(cdp, 'first question');
    await waitStreamingIdle(cdp, 40000);
    await sleep(1000);
    const botCountBeforeCancel = await cdp.eval('document.querySelectorAll("#chat-messages .msg.bot").length');

    // Exchange 2 starts; cancel it AFTER at least one SSE chunk has been
    // read into the stream state (partial content), but BEFORE the usage
    // chunk / [DONE] arrives. The mock streams reasoning at ~60ms intervals
    // and finishes at ~320ms, so wait for streaming to become active and then
    // give it ~250ms before pressing Stop (the send button becomes Stop).
    await sendChatMessage(cdp, 'second question');
    await cdp.waitFor('typeof streamState !== "undefined" && streamState.active === true', 20000, 50, 'streaming active');
    await sleep(40);
    await cdp.clearPosted();
    const stopHit = await cdp.pointerClick('#chat-send-btn', {
      holdMs: 80,
      // Streaming Thought updates call global lucide.createIcons(), which can
      // replace the Stop SVG between mouse-down and mouse-up. Simulate that
      // deterministically while the pointer is held.
      duringPressExpression: `(() => {
        const btn = document.querySelector('#chat-send-btn');
        if (!btn) return false;
        btn.innerHTML = btn.innerHTML;
        if (typeof lucide !== 'undefined') lucide.createIcons();
        return true;
      })()`
    });
    if (stopHit.hitTag !== 'BUTTON')
      throw new Error('Stop icon must not own pointer hit-testing: ' + JSON.stringify(stopHit));
    await sleep(150);
    const stopPosts = await cdp.postedMessages();
    if (!stopPosts.some((m) => String(m).indexOf('cancelStream') >= 0))
      throw new Error('physical Stop click did not post cancelStream: hit=' + JSON.stringify(stopHit) + ' posted=' + JSON.stringify(stopPosts));
    await waitStreamingIdle(cdp, 30000);
    await sleep(1200);

    // UI regression: Stop during DeepSeek reasoning must finalize the ONE
    // in-flight assistant bubble. Previously the host re-enabled the composer
    // before streamCancelled, clearing streamState; a trailing reasoning delta
    // then opened a second tiny assistant bubble while the original kept its
    // hourglass spinner.
    const cancelUi = await cdp.eval(`(() => {
      const bots = Array.from(document.querySelectorAll('#chat-messages .msg.bot'));
      const last = bots[bots.length - 1] || null;
      const summary = last && last.querySelector('.thinking-block summary');
      return {
        botCount: bots.length,
        pulseCount: document.querySelectorAll('#chat-messages .msg.bot .thinking-pulse').length,
        lastThoughtSummary: summary ? summary.textContent : ''
      };
    })()`);
    if (cancelUi.botCount !== botCountBeforeCancel + 1)
      throw new Error('Stop created duplicate assistant bubbles: before=' + botCountBeforeCancel + ' after=' + JSON.stringify(cancelUi));
    if (cancelUi.pulseCount !== 0)
      throw new Error('cancelled reasoning left a live Thought Process spinner: ' + JSON.stringify(cancelUi));
    if (String(cancelUi.lastThoughtSummary).toLowerCase().indexOf('cancelled') < 0)
      throw new Error('cancelled reasoning bubble was not finalized as cancelled: ' + JSON.stringify(cancelUi));

    const msgs = seed.query(dbPath, "SELECT role, content, token_count, prompt_tokens, active_path_tokens, model FROM messages ORDER BY created_at");
    const thread = seed.query(dbPath, 'SELECT cumulative_input_tokens, cumulative_output_tokens, cumulative_cached_tokens FROM chat_threads')[0];
    const usage = seed.query(dbPath, 'SELECT call_count, prompt_tokens, completion_tokens FROM chat_usage')[0];
    const partial = msgs[msgs.length - 1];

    // The cancelled partial assistant is persisted (by design). Confirm we
    // actually hit the cancel path: the last row must be an assistant with NO
    // API usage (token_count/prompt_tokens 0) - if it carries full usage the
    // mock finished before Stop landed and this run did not exercise the bug.
    if (!partial || partial.role !== 'assistant')
      throw new Error('setup: last row is not an assistant after cancel: ' + JSON.stringify(msgs));
    if (Number(partial.prompt_tokens) > 0 || Number(partial.token_count) > 0)
      throw new Error('setup: stream finished before Stop landed (last assistant has usage) - re-run: ' + JSON.stringify(partial));
    // FIXED (bug #133): the cancelled partial is inserted as a local_copy, so
    // MessageRepo.Insert never upserts chat_usage (no fake request) and never
    // recomputes the cumulative counters. The dashboard keeps 1 call / 12
    // prompt tokens, the thread counters stay 12/9/4, and the header token bar
    // agrees with the dashboard (the old code charged the parent's
    // active_path_tokens, inflating cumulative input to 33).
    if (usage.call_count !== 1 || usage.prompt_tokens !== 12)
      throw new Error('cancelled stream still billed a fake request: ' + JSON.stringify(usage) + ' msgs=' + JSON.stringify(msgs));
    if (Number(thread.cumulative_input_tokens) !== 12 || Number(thread.cumulative_output_tokens) !== 9 || Number(thread.cumulative_cached_tokens) !== 4)
      throw new Error('cancelled stream inflated the cumulative counters: ' + JSON.stringify(thread) + ' msgs=' + JSON.stringify(msgs) + ' usage=' + JSON.stringify(usage));
    if (Number(partial.active_path_tokens) !== 21)
      throw new Error('cancelled partial should keep the parent context (21), got ' + partial.active_path_tokens);
    const bar = await cdp.eval('document.getElementById("tokenBar").textContent');
    if (String(bar).indexOf('\u2191 12') < 0 || String(bar).indexOf('\u2191 33') >= 0)
      throw new Error('header token bar must agree with the dashboard (\u2191 12, not \u2191 33): ' + JSON.stringify(bar));
    return 'cancelled mid-stream: one assistant bubble finalized (' + JSON.stringify(cancelUi) + '), partial row=' + JSON.stringify(partial) +
      ', chat_usage=' + JSON.stringify(usage) + ' (1 completed call only), thread counters=' +
      JSON.stringify(thread) + ' (12/9/4 - un-billed context never charged), header=' + JSON.stringify(bar);
  }
});

scenarios.push({
  id: 135,
  name: 'Usage dashboard filters and totals stay consistent with the DB rows (audit)',
  mode: null,
  regression: true, // audit: summary + type/provider/model filters must match the DB rows
  settings: {},
  fixtures: {
    chatUsage: [
      { date: seed.daysAgo(0), model: 'deepseek/deepseek-v4-flash', provider: 'deepseek', call_count: 2, prompt_tokens: 20, completion_tokens: 14, thinking_tokens: 2, cached_tokens: 6, input_cost: 0.002, cached_input_cost: 0.0002, output_cost: 0.004, total_cost: 0.006 },
      { date: seed.daysAgo(0), model: 'openai/gpt-5-mini', provider: 'openai', call_count: 1, prompt_tokens: 10, completion_tokens: 8, thinking_tokens: 0, cached_tokens: 3, input_cost: 0.001, cached_input_cost: 0.0001, output_cost: 0.002, total_cost: 0.003 },
      { date: seed.daysAgo(2), model: 'deepseek/deepseek-v4-flash', provider: 'deepseek', call_count: 1, prompt_tokens: 5, completion_tokens: 4, thinking_tokens: 0, cached_tokens: 1, input_cost: 0.0005, cached_input_cost: 0.00005, output_cost: 0.001, total_cost: 0.0015 }
    ]
  },
  async body({ cdp, dbPath }) {
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(dbPath);
    db.exec("INSERT INTO command_usage (date, model, provider, command_name, call_count, prompt_tokens, completion_tokens, thinking_tokens, cached_tokens, input_cost, cached_input_cost, output_cost, total_cost, total_response_time_ms, total_ttft_ms) VALUES ('" + seed.daysAgo(0) + "', 'deepseek/deepseek-v4-flash', 'deepseek', 'Audit', 1, 6, 5, 1, 2, 0.0006, 0.00006, 0.0012, 0.0018, 0, 0)");
    db.close();

    await showChat();
    await cdp.click('#dashboard-icon');
    await cdp.waitFor('typeof allData !== "undefined" && allData.chat && allData.commands && allData.chat.length === 3 && allData.commands.length === 1', 15000, 300, 'dashboard data');
    await cdp.eval('document.getElementById("timeRange").value = "all"; loadData(); true');
    await cdp.waitFor('typeof allData !== "undefined" && allData.chat.length === 3 && allData.commands.length === 1', 15000, 300, 'all-time data');
    await sleep(600);

    // Summary: cost = 0.006 + 0.003 + 0.0015 + 0.0018 = 0.0123; calls = 2+1+1+1 = 5;
    // tokens = chat(20+14)+(10+8)+(5+4) + command(6+5) = 72.
    const totalCost = await cdp.text('#totalCost');
    const totalCalls = await cdp.text('#totalCalls');
    const totalTokens = await cdp.text('#totalTokens');
    if (totalCost !== '$0.0123') throw new Error('total cost wrong: ' + totalCost);
    if (totalCalls !== '5') throw new Error('total calls wrong: ' + totalCalls);
    if (totalTokens !== '72') throw new Error('total tokens wrong: ' + totalTokens);

    // Type filter: chat only -> calls 4, tokens 61 (20+14+10+8+5+4).
    await cdp.eval('document.getElementById("typeFilter").value = "chat"; loadData(); true');
    await cdp.waitFor('typeof allData !== "undefined" && allData.commands.length === 0', 15000, 300, 'chat-only data');
    await sleep(500);
    if (await cdp.text('#totalCalls') !== '4') throw new Error('chat-only calls wrong: ' + await cdp.text('#totalCalls'));
    if (await cdp.text('#totalTokens') !== '61') throw new Error('chat-only tokens wrong: ' + await cdp.text('#totalTokens'));

    // Type filter: commands only -> calls 1, tokens 11.
    await cdp.eval('document.getElementById("typeFilter").value = "command"; loadData(); true');
    await cdp.waitFor('typeof allData !== "undefined" && allData.chat.length === 0 && allData.commands.length === 1', 15000, 300, 'command-only data');
    await sleep(500);
    if (await cdp.text('#totalCalls') !== '1') throw new Error('command-only calls wrong: ' + await cdp.text('#totalCalls'));
    if (await cdp.text('#totalTokens') !== '11') throw new Error('command-only tokens wrong: ' + await cdp.text('#totalTokens'));

    // Provider filter: deepseek (all types) -> 3 chat + 1 command rows.
    await cdp.eval('document.getElementById("typeFilter").value = "all"; document.getElementById("providerFilter").value = "deepseek"; loadData(); true');
    await cdp.waitFor('typeof allData !== "undefined" && allData.chat.length === 2 && allData.commands.length === 1', 15000, 300, 'deepseek data');
    await sleep(500);
    if (await cdp.text('#totalCalls') !== '4') throw new Error('deepseek calls wrong: ' + await cdp.text('#totalCalls'));

    // Model filter: deepseek/deepseek-v4-flash only -> 2 chat + 1 command.
    await cdp.eval('document.getElementById("modelFilter").value = "deepseek/deepseek-v4-flash"; loadData(); true');
    await cdp.waitFor('typeof allData !== "undefined" && allData.chat.length === 2 && allData.commands.length === 1', 15000, 300, 'model-filtered data');
    await sleep(500);
    if (await cdp.text('#totalCalls') !== '4') throw new Error('model-filter calls wrong: ' + await cdp.text('#totalCalls'));
    if (await cdp.text('#totalTokens') !== '54') throw new Error('model-filter tokens wrong: ' + await cdp.text('#totalTokens'));

    return 'dashboard audit: all-time cost=$0.0123 calls=5 tokens=72; chat-only 4/61; command-only 1/11; deepseek 4; model-filter 4/54 - all match the DB rows';
  }
});

scenarios.push({
  id: 140,
  regression: true, // FIXED bug kept as a regression check (retry must not re-fire title generation)
  name: 'Retrying the first exchange fires a SECOND title-generation request (no in-flight/title guard - duplicate API calls while the title is still "New Chat")',
  mode: null,
  noApp: true,
  settings: {},
  async body() {
    // The live harness cannot read title responses (direct-spawned cURL gets
    // 0 bytes back - README), so a live "retry must not re-fire" check would
    // always see the #151 failure-retry path. Verify the combined contract
    // statically (behavior is covered by the ThreadTitleGen unit tests):
    //   1. the per-thread dispatched-request guard is set BEFORE the request
    //      (blocks in-flight/success duplicates - bug #140), and
    //   2. _maybeGenerateTitle skips when the guard exists, and
    //   3. the guard is cleared ONLY on the no-title/failure path (bug #151).
    const src = fs.readFileSync(path.join(launcher.REPO_ROOT, 'chat', 'ThreadTitleGen.ahk'), 'utf8');
    const guardSetBeforeRequest = /_titleGenRequestedThreads\[threadId\]\s*:=\s*true[\s\S]{0,1200}?ProviderResolver\.Resolve/.test(src);
    const guardCheckedInTrigger = /if _titleGenRequestedThreads\.Has\(threadId\)[\s\S]{0,200}?skip duplicate title request/.test(src);
    const failureOnlyClear = /if\s+title\s*\{[\s\S]*?else\s*\{[\s\S]*?_titleGenRequestedThreads\.Delete\(threadId\)/.test(src);
    if (!guardSetBeforeRequest || !guardCheckedInTrigger || !failureOnlyClear)
      throw new Error('title-gen duplicate guard contract broken: set=' + guardSetBeforeRequest + ' checked=' + guardCheckedInTrigger + ' failureOnlyClear=' + failureOnlyClear);
    return 'title-gen guard contract: dispatched-request guard set before the request and checked by _maybeGenerateTitle (one request per thread for in-flight/success - bug #140); ' +
      'the guard is cleared only on the no-title/failure path so a transient failure stays retryable (bug #151)';
  }
});

scenarios.push({
  id: 144,
  name: '"Save as Branch" on an assistant message double-counts the copied token metadata in the thread cumulative counters after the next real exchange (header vs dashboard disagree)',
  mode: 'sse-success',
  regression: true,
  settings: {},
  fixtures: {
    threads: [{
      id: 't-dbl-144', title: 'Double Count', active_leaf_id: 'm-144-a1',
      cumulative_input_tokens: 12, cumulative_output_tokens: 9, cumulative_cached_tokens: 4
    }],
    messages: [
      { id: 'm-144-u1', thread_id: 't-dbl-144', role: 'user', content: 'root', token_count: 12, active_path_tokens: 12 },
      { id: 'm-144-a1', thread_id: 't-dbl-144', role: 'assistant', content: 'answer one', model: 'deepseek/deepseek-v4-flash', parent_id: 'm-144-u1', token_count: 9, prompt_tokens: 12, cached_tokens: 4, active_path_tokens: 21 }
    ]
  },
  async body({ cdp, dbPath }) {
    await showChat();
    await cdp.waitFor('document.querySelectorAll("#thread-list .chat-item").length > 0', 15000, 300, 'thread list');
    await cdp.click('#thread-list .chat-item');
    await cdp.waitFor('document.querySelectorAll("#chat-messages .msg").length >= 2', 15000, 300, 'thread loaded');
    await sleep(700);
    // Save the assistant message as a NEW BRANCH - a LOCAL DB copy carrying the
    // source token metadata (bug #123) but NO API call (bug #118).
    await cdp.click('#chat-messages .msg:nth-child(2) .msg-action-btn[title="Edit"]');
    await cdp.waitFor('document.querySelector("#chat-messages .msg:nth-child(2)").classList.contains("editing")', 5000, 200, 'edit ui open');
    await cdp.type('#chat-messages .msg:nth-child(2) .msg-edit-textarea', 'answer one (branch)');
    await cdp.click('#chat-messages .msg:nth-child(2) .save-branch');
    await cdp.waitFor('chatMessages.length === 2 && chatMessages[1] && chatMessages[1].content === "answer one (branch)"', 15000, 300, 'branch message created');
    await sleep(700);
    // The branch is now the leaf; send a REAL follow-up exchange. The new
    // assistant insert calls _RecomputeCumulativeCounters, which sums ALL
    // assistant rows - including the local copy's COPIED prompt_tokens.
    await sendChatMessage(cdp, 'follow up');
    await waitStreamingIdle(cdp, 40000);
    await sleep(1200);

    const thread = seed.query(dbPath, 'SELECT cumulative_input_tokens, cumulative_output_tokens, cumulative_cached_tokens FROM chat_threads WHERE id = ?', ['t-dbl-144'])[0];
    const usage = seed.query(dbPath, 'SELECT call_count, prompt_tokens, completion_tokens, cached_tokens FROM chat_usage')[0];
    // In THIS run only the follow-up is a real API call (a1 is a seeded row,
    // not a live exchange): chat_usage = 1 call, 12/9/4. The thread counters
    // must reflect ONLY real API calls: the seeded a1 (12/9/4) + the follow-up
    // (12/9/4) = 24/18/8. The local branch copy (a copied 12/9/4) must NOT be
    // charged a second time.
    // BUG present: the recompute also charges the local branch copy (12/9/4)
    // on top -> thread counters 36/27/12 (header) while the dashboard holds 1
    // call, 12/9/4 - header and dashboard disagree.
    if (Number(thread.cumulative_input_tokens) !== 24 || Number(thread.cumulative_output_tokens) !== 18 || Number(thread.cumulative_cached_tokens) !== 8)
      throw new Error('counters should be the real calls only (24/18/8), got: ' + JSON.stringify(thread));
    if (!usage || usage.call_count !== 1 || usage.prompt_tokens !== 12 || usage.completion_tokens !== 9 || usage.cached_tokens !== 4)
      throw new Error('chat_usage should hold the 1 real call only: ' + JSON.stringify(usage));
    const bar = await cdp.eval('document.getElementById("tokenBar").textContent');
    if (String(bar).indexOf('\u2191 24') < 0 || String(bar).indexOf('\u2193 18') < 0)
      throw new Error('header should show the real-call totals 24/18: ' + JSON.stringify(bar));
    return 'assistant branch-copy + real follow-up: thread counters=' + JSON.stringify(thread) +
      ' (24/18/8 = seeded a1 + follow-up; the local copy is NOT charged) while chat_usage=' + JSON.stringify(usage) +
      ' (1 real call, 12/9/4) - header and dashboard agree; header=' + JSON.stringify(bar);
  }
});

scenarios.push({
  id: 145,
  name: 'User message token backfill leaks the previous assistant\'s THINKING tokens into the next user\'s "contribution" (token popover over-counts)',
  mode: null,
  regression: true,
  noApp: true,
  settings: {},
  async body() {
    const os = require('node:os');
    const outFile = path.join(os.tmpdir(), 'llm-bughunt-db-' + process.pid + '.txt');
    try { fs.unlinkSync(outFile); } catch {}
    const probe = path.join(__dirname, '..', 'probe-bughunt-db.ahk');
    const res = spawnSync(launcher.AHK, ['/ErrorStdOut', probe, outFile, 'backfill-thinking'], { timeout: 25000, windowsHide: true, encoding: 'utf8' });
    if (res.error) throw new Error('backfill probe spawn failed/timed out: ' + res.error.message);
    if (res.stderr) process.stderr.write('[probe stderr] ' + res.stderr);
    const text = fs.readFileSync(outFile, 'utf-8');
    const u2m = text.match(/u2tc=(\d+)/);
    if (!u2m) throw new Error('probe output missing u2tc: ' + text);
    const u2tc = Number(u2m[1]);
    // Fixed: the backfill subtracts the prior assistant's thinking tokens too,
    // so the user's contribution is its true value.
    // BUG present: a1 reported prompt 12 / visible 9 / thinking 5; the true
    // next prompt is 12+9+5+4=30 and the user's real contribution is 4, but
    // the backfill subtracted only visible outputs (12+9) -> u2tc=9.
    if (u2tc !== 4) throw new Error('backfill still leaks thinking (BUG present): u2tc=' + u2tc);
    return 'user backfill is now thinking-accurate: u2tc=' + u2tc +
      ' (true contribution 4 = 30 prompt - 12 u1 - 9 visible - 5 thinking)';
  }
});

scenarios.push({
  id: 149,
  name: 'Command requests with SHORT model ids (no provider prefix) silently drop the thinking config (LLMRequestBuilder still gates on models.Has(full-id))',
  mode: null,
  regression: true,
  noApp: true,
  settings: {},
  async body() {
    const os = require('node:os');
    const outFile = path.join(os.tmpdir(), 'llm-bughunt-db-' + process.pid + '.txt');
    try { fs.unlinkSync(outFile); } catch {}
    const probe = path.join(__dirname, '..', 'probe-bughunt-db.ahk');
    const res = spawnSync(launcher.AHK, ['/ErrorStdOut', probe, outFile, 'command-thinking-short'], { timeout: 25000, windowsHide: true, encoding: 'utf8' });
    if (res.error) throw new Error('thinking probe spawn failed/timed out: ' + res.error.message);
    if (res.stderr) process.stderr.write('[probe stderr] ' + res.stderr);
    const text = fs.readFileSync(outFile, 'utf-8');
    if (text.indexOf('shortHasThinking=1') < 0)
      throw new Error('short-id command still drops thinking (BUG present): ' + text);
    if (text.indexOf('fullHasThinking=1') < 0)
      throw new Error('control (full id) no longer applies thinking: ' + text);
    return 'createJSONRequest("deepseek-v4-flash", thinking enabled/high) -> thinking fields NOW applied ' +
      '(ModelResolver.Lookup resolves the short id); the full id control gets thinking:{type:enabled} + reasoning_effort:high';
  }
});

scenarios.push({
  id: 156,
  name: 'Overwrite-editing a USER message keeps its OLD backfilled token_count, so the NEXT user message\'s backfill subtracts the stale value and its token popover over-counts (stale attribution on the overwrite path)',
  mode: null,
  regression: true,
  noApp: true,
  settings: {},
  async body() {
    const os = require('node:os');
    const outFile = path.join(os.tmpdir(), 'llm-bughunt-db-' + process.pid + '.txt');
    try { fs.unlinkSync(outFile); } catch {}
    const probe = path.join(__dirname, '..', 'probe-bughunt-db.ahk');
    const res = spawnSync(launcher.AHK, ['/ErrorStdOut', probe, outFile, 'edit-user-stale-backfill'], { timeout: 25000, windowsHide: true, encoding: 'utf8' });
    if (res.error) throw new Error('edit-user probe spawn failed/timed out: ' + res.error.message);
    if (res.stderr) process.stderr.write('[probe stderr] ' + res.stderr);
    const text = fs.readFileSync(outFile, 'utf-8');
    const m = text.match(/u3tc=(\d+)/);
    if (!m) throw new Error('probe output missing u3tc: ' + text);
    const u3tc = Number(m[1]);
    // Fixed: Msg_Edit re-estimates the edited user's contribution (~1 token /
    // 3 chars), so the next backfill subtracts the NEW value and u3 gets its
    // true contribution.
    // BUG present: u2 edited to a 30-token text kept token_count=7; the next
    // prompt (62 = 12+9+30+6+5) subtracted the stale 7, so u3 got
    // 62-(12+9+7+6)=28 instead of its true 5.
    if (u3tc !== 5)
      throw new Error('next user backfill still stale (BUG present): u3tc=' + u3tc);
    return 'u2 overwrite-edit re-estimates its contribution; next user backfill gives u3tc=' + u3tc +
      ' (true contribution 5 = 62 prompt - 12 u1 - 9 a1 - 30 new u2 - 6 a2) - the edited message\'s attribution is refreshed, not stale';
  }
});

scenarios.push({
  id: 157,
  name: 'Forking AT a user message under-reports the fork\'s "Context Used" (the user row\'s active_path_tokens never includes its own backfilled token_count, so the fork leaf shows the parent context only)',
  mode: null,
  regression: true,
  noApp: true,
  settings: {},
  async body() {
    const os = require('node:os');
    const outFile = path.join(os.tmpdir(), 'llm-bughunt-db-' + process.pid + '.txt');
    try { fs.unlinkSync(outFile); } catch {}
    const probe = path.join(__dirname, '..', 'probe-bughunt-db.ahk');
    const res = spawnSync(launcher.AHK, ['/ErrorStdOut', probe, outFile, 'fork-at-user-stale-context'], { timeout: 25000, windowsHide: true, encoding: 'utf8' });
    if (res.error) throw new Error('fork-at-user probe spawn failed/timed out: ' + res.error.message);
    if (res.stderr) process.stderr.write('[probe stderr] ' + res.stderr);
    const text = fs.readFileSync(outFile, 'utf-8');
    const m = text.match(/forkContext=(\d+)/);
    if (!m) throw new Error('probe output missing forkContext: ' + text);
    const forkContext = Number(m[1]);
    // Fixed: the backfill now updates the user's active_path_tokens too
    // (parent context + own contribution), so the fork at u2 reports 30.
    // BUG present: u2.tc=9 (backfilled), u2.apt=21 (stale - parent context
    // only, the backfill never updated it), so the fork reported 21.
    if (forkContext !== 30)
      throw new Error('fork context still under-reports (BUG present): forkContext=' + forkContext);
    return 'fork at u2 (contribution 9, true context 30): fork leaf active_path_tokens=' + forkContext +
      ' - the backfill keeps the user message\'s active_path_tokens in sync, so the fork header reports the full context';
  }
});

// Load the REAL usage-dashboard.js in a vm sandbox (same approach as
// tests/unit/usage-dashboard.test.js) and return { window, exports: { clickHandler, els } }.
function loadUsageDashboardSandbox() {
  const src = fs.readFileSync(path.join(launcher.REPO_ROOT, 'webui', 'js', 'usage-dashboard.js'), 'utf8');
  const els = {};
  const listeners = {};
  function makeEl(id) {
    if (els[id]) return els[id];
    const el = {
      id,
      value: id === 'timeRange' ? 'all' : '',
      innerHTML: '',
      listeners: {},
      style: {},
      classList: { add() {}, remove() {}, toggle() {} },
      dataset: {},
      addEventListener(type, fn) { el.listeners[type] = fn; },
      querySelector() { return null; },
      querySelectorAll() { return []; },
      appendChild() {},
      click() { if (el.listeners.click) el.listeners.click(); },
      getContext() { return {}; }
    };
    els[id] = el;
    return el;
  }
  const stackToggle = {
    querySelectorAll() { return []; },
    addEventListener() {}
  };
  let csvCaptured = '';
  const sandbox = {
    console,
    document: {
      getElementById: (id) => makeEl(id),
      querySelector: (sel) => (sel === '#stackToggle' ? stackToggle : null),
      addEventListener() {}
    },
    window: {
      chrome: { webview: { postMessage: () => {} } },
      addEventListener() {}
    },
    Chart: function() { return { destroy() {}, update() {} }; },
    Blob: function(parts) { return { parts }; },
    URL: { createObjectURL: (b) => { csvCaptured = b.parts.join(''); return 'blob:csv'; }, revokeObjectURL() {} },
    setTimeout() {},
    clearTimeout() {},
    navigator: {},
    lucide: { createIcons() {} }
  };
  sandbox.global = sandbox;
  sandbox.document.createElement = () => ({
    style: {}, innerHTML: '', classList: { add() {}, remove() {}, toggle() {} },
    addEventListener() {}, appendChild() {}, querySelector: () => null, querySelectorAll: () => [],
    click() {}
  });
  const ctx = vm.createContext(sandbox);
  vm.runInContext(src, ctx);
  return { sandbox, els, getCsv: () => csvCaptured };
}

scenarios.push({
  id: 163,
  name: 'Usage CSV export is unquoted - a model/provider name containing a comma (both user-editable in Settings) produces a malformed CSV with shifted columns',
  mode: null,
  regression: true,
  noApp: true,
  settings: {},
  async body() {
    const { sandbox, els, getCsv } = loadUsageDashboardSandbox();
    sandbox.allData = {
      chat: [{
        date: '2026-08-10', model: 'openai/gpt-5,beta', provider: 'openai',
        input_tokens: 12, output_tokens: 9, thinking_tokens: 2, cached_tokens: 4,
        cached_input_cost: 0.01, output_cost: 0.02, total_cost: 0.03, message_count: 1
      }],
      commands: [],
      providers: ['openai'],
      models: ['openai/gpt-5,beta']
    };
    els.exportBtn.click();
    const csv = getCsv();
    if (!csv) throw new Error('export did not run (csv empty)');
    const rows = csv.trim().split('\n');
    // Quote-aware CSV row parser (RFC-4180).
    function splitCsvRow(row) {
      var out = [], cur = '', inQ = false;
      for (var i = 0; i < row.length; i++) {
        var c = row[i];
        if (inQ) {
          if (c === '"') { if (row[i + 1] === '"') { cur += '"'; i++; } else inQ = false; }
          else cur += c;
        } else if (c === '"') inQ = true;
        else if (c === ',') { out.push(cur); cur = ''; }
        else cur += c;
      }
      out.push(cur);
      return out;
    }
    const dataRow = splitCsvRow(rows[1]);
    // Fixed: comma-containing fields are RFC-4180 quoted, so the row keeps 12
    // fields and the model name round-trips as one field.
    // BUG present: "openai/gpt-5,beta" was joined without quoting, shifting
    // every following column one field left (13 fields instead of 12).
    if (rows[1].indexOf('"openai/gpt-5,beta"') < 0 || dataRow.length !== 12)
      throw new Error('CSV fields not properly quoted (BUG present): row=' + rows[1] + ' fields=' + dataRow.length);
    if (dataRow[3] !== 'openai/gpt-5,beta')
      throw new Error('model field corrupted: ' + JSON.stringify(dataRow[3]));
    return 'export row: model field="' + dataRow[3] + '" -> ' + dataRow.length + ' parsed fields (header has 12) - comma-containing names are quoted and columns stay aligned: ' + rows[1];
  }
});

scenarios.push({
  id: 168,
  name: 'Usage dashboard rows with an empty provider (model removed from settings, MessageRepo provider fallback fails) appear in the chart under "" but are absent from the provider filter dropdown',
  mode: null,
  regression: true,
  noApp: true,
  settings: {},
  async body() {
    const { sandbox, els } = loadUsageDashboardSandbox();
    sandbox.allData = {
      chat: [{
        date: '2026-08-10', model: 'gpt-5', provider: '',
        input_tokens: 12, output_tokens: 9, thinking_tokens: 0, cached_tokens: 0,
        cached_input_cost: 0, output_cost: 0, total_cost: 0, message_count: 1
      }],
      commands: [],
      providers: ['deepseek'],
      models: ['gpt-5']
    };
    els.providerFilter.innerHTML = '';
    sandbox.populateFilters();
    const options = els.providerFilter.innerHTML;
    // Fixed: populateFilters adds a selectable "Unknown (blank)" option
    // (reserved value __BLANK_PROVIDER__, bug #182: __unknown__ can be a real
    // provider name) when any row's provider key resolves to "".
    // BUG present: the chart's provider-mode key became '' while
    // populateFilters only listed the backend's distinct providers
    // (['deepseek']) - no option could scope to the blank-provider rows.
    const optionValues = [...options.matchAll(/<option value="([^"]*)"/g)].map((m) => m[1]).slice(1);
    const hasAnyProvider = options.indexOf('deepseek') >= 0;
    if (!hasAnyProvider) throw new Error('provider dropdown did not render (harness issue)');
    if (optionValues.indexOf('__BLANK_PROVIDER__') < 0)
      throw new Error('blank-provider option missing (BUG present): ' + options);
    return 'chat_usage row provider="" (model gpt-5 no longer in settings): the filter dropdown now includes a selectable "Unknown (blank)" option (reserved value __BLANK_PROVIDER__) alongside ' +
      JSON.stringify(optionValues) + ' - the removed-model row can be isolated/filtered';
  }
});

scenarios.push({
  id: 177,
  name: 'Fork copies drop the per-message COST snapshots - after a Settings price change the fork header is re-priced at CURRENT prices while the source thread keeps its snapshots (the two threads disagree)',
  mode: null,
  noApp: true,
  regression: true, // FIXED in 8ca2fdb: fork rows copy the call-time cost snapshots (was re-priced at CURRENT prices)
  settings: {},
  async body() {
    const os = require('node:os');
    const outFile = path.join(os.tmpdir(), 'llm-bughunt-db-' + process.pid + '.txt');
    try { fs.unlinkSync(outFile); } catch {}
    const probe = path.join(__dirname, '..', 'probe-bughunt-db.ahk');
    const res = spawnSync(launcher.AHK, ['/ErrorStdOut', probe, outFile, 'fork-cost-snapshot'], { timeout: 25000, windowsHide: true, encoding: 'utf8' });
    if (res.error) throw new Error('fork-cost probe spawn failed/timed out: ' + res.error.message);
    if (res.stderr) process.stderr.write('[probe stderr] ' + res.stderr);
    const text = fs.readFileSync(outFile, 'utf-8');
    const srcM = text.match(/srcCost=([\d.]+)/);
    const forkM = text.match(/forkCost=([\d.]+)/);
    const copyM = text.match(/copiedCostSum=([\d.]+)/);
    if (!srcM || !forkM || !copyM) throw new Error('probe output missing fields: ' + text);
    const srcCost = Number(srcM[1]), forkCost = Number(forkM[1]), copiedCostSum = Number(copyM[1]);
    // FIXED (bug #177): the fork rows carry the per-message cost snapshots
    // (GetActivePath selects them, the fork INSERTs copy them), so the fork's
    // recomputed cumulative cost equals the source's even after the price
    // change - forkCost == srcCost with copiedCostSum > 0.
    if (srcCost <= 0)
      throw new Error('control failed - source snapshot cost should be > 0: ' + text);
    if (copiedCostSum === 0 || Math.abs(forkCost - srcCost) > 1e-9)
      throw new Error('fork cost still drifts (fix incomplete): srcCost=' + srcCost + ' forkCost=' + forkCost + ' copiedCostSum=' + copiedCostSum);
    return 'source thread cumulative_cost=' + srcCost + ' (snapshot at call time), fork cumulative_cost=' + forkCost +
      ' with copied cost sum ' + copiedCostSum + ' - the fork carries the call-time snapshots and agrees with the source after a Settings price change';
  }
});

scenarios.push({
  id: 181,
  name: 'Overwrite-editing an ASSISTANT message leaves its OLD token_count in place - the next user backfill subtracts the stale output tokens and its token popover over-counts (stale attribution on the assistant path, bug #156 family)',
  mode: null,
  regression: true, // FIXED: assistant edits refresh their token attribution (bug #156 family)
  noApp: true,
  settings: {},
  async body() {
    const os = require('node:os');
    const outFile = path.join(os.tmpdir(), 'llm-bughunt-db-' + process.pid + '.txt');
    try { fs.unlinkSync(outFile); } catch {}
    const probe = path.join(__dirname, '..', 'probe-bughunt-db.ahk');
    const res = spawnSync(launcher.AHK, ['/ErrorStdOut', probe, outFile, 'edit-assistant-stale-backfill'], { timeout: 25000, windowsHide: true, encoding: 'utf8' });
    if (res.error) throw new Error('edit-assistant probe spawn failed/timed out: ' + res.error.message);
    if (res.stderr) process.stderr.write('[probe stderr] ' + res.stderr);
    const text = fs.readFileSync(outFile, 'utf-8');
    const a1M = text.match(/a1tcAfterEdit=(\d+)/);
    const u3M = text.match(/u3tc=(\d+)/);
    if (!a1M || !u3M) throw new Error('probe output missing fields: ' + text);
    const a1tcAfterEdit = Number(a1M[1]), u3tc = Number(u3M[1]);
    // FIXED (bug #181): MessageRepo.Edit re-estimates token_count for
    // ASSISTANT messages too (like the user path, bug #156), so the edited
    // assistant's ~100-token content is reflected and the next user backfill
    // gives u3 its true contribution 5 instead of 96.
    if (u3tc !== 5)
      throw new Error('assistant edit was not re-attributed (fix incomplete): a1tcAfterEdit=' + a1tcAfterEdit + ' u3tc=' + u3tc);
    if (a1tcAfterEdit <= 9)
      throw new Error('edited assistant token_count was not refreshed (fix incomplete): a1tcAfterEdit=' + a1tcAfterEdit);
    return 'assistant overwrite-edit refreshed token_count=' + a1tcAfterEdit + ' (~100-token new content); the next user backfill got u3tc=' + u3tc +
      ' (true contribution 5) - the edited assistant\'s output-token count no longer leaks stale attribution into the next user';
  }
});

scenarios.push({
  id: 182,
  name: 'A provider literally named "__unknown__" collides with the blank-provider filter sentinel - the dropdown carries two "__unknown__" options and selecting either returns ONLY the blank-provider rows, so the real provider is unfilterable',
  mode: null,
  regression: true, // FIXED: blank-provider sentinel is now the reserved __BLANK_PROVIDER__ (no collision)
  noApp: true,
  settings: {},
  async body() {
    // 1. Real UsageRepo: a provider literally named "__unknown__" must filter
    //    by its OWN name; the reserved "__BLANK_PROVIDER__" sentinel scopes
    //    to (provider='' OR NULL) only.
    const os = require('node:os');
    const outFile = path.join(os.tmpdir(), 'llm-bughunt-db-' + process.pid + '.txt');
    try { fs.unlinkSync(outFile); } catch {}
    const probe = path.join(__dirname, '..', 'probe-bughunt-db.ahk');
    const res = spawnSync(launcher.AHK, ['/ErrorStdOut', probe, outFile, 'unknown-provider-sentinel'], { timeout: 25000, windowsHide: true, encoding: 'utf8' });
    if (res.error) throw new Error('unknown-provider probe spawn failed/timed out: ' + res.error.message);
    if (res.stderr) process.stderr.write('[probe stderr] ' + res.stderr);
    const text = fs.readFileSync(outFile, 'utf-8');
    const realM = text.match(/realRows=(\d+)/);
    const blankM = text.match(/blankRows=(\d+)/);
    const bRealM = text.match(/blankSentinelRealRows=(\d+)/);
    const bBlankM = text.match(/blankSentinelBlankRows=(\d+)/);
    const listM = text.match(/providersListHas__unknown__=(\d)/);
    if (!realM || !blankM || !bRealM || !bBlankM || !listM) throw new Error('probe output missing fields: ' + text);
    const realRows = Number(realM[1]), blankRows = Number(blankM[1]);
    const bRealRows = Number(bRealM[1]), bBlankRows = Number(bBlankM[1]), listed = Number(listM[1]);
    if (realRows !== 1 || blankRows !== 0 || bRealRows !== 0 || bBlankRows !== 1 || listed !== 1)
      throw new Error('provider sentinel semantics wrong (fix incomplete): ' + text);

    // 2. Real usage-dashboard.js populateFilters: the real provider renders
    //    under its own value and the "Unknown (blank)" option uses the
    //    reserved sentinel - two DISTINCT values, so both are selectable.
    const { sandbox, els } = loadUsageDashboardSandbox();
    sandbox.allData = {
      chat: [
        { date: '2026-08-10', model: 'real/__unknown__', provider: '__unknown__', input_tokens: 10, output_tokens: 5, thinking_tokens: 0, cached_tokens: 0, cached_input_cost: 0, output_cost: 0.2, total_cost: 0.3, message_count: 1 },
        { date: '2026-08-10', model: 'blank-model', provider: '', input_tokens: 20, output_tokens: 10, thinking_tokens: 0, cached_tokens: 0, cached_input_cost: 0, output_cost: 0.4, total_cost: 0.6, message_count: 1 }
      ],
      commands: [],
      providers: ['__unknown__', 'deepseek'],
      models: ['real/__unknown__', 'blank-model']
    };
    els.providerFilter.innerHTML = '';
    sandbox.populateFilters();
    const options = els.providerFilter.innerHTML;
    const realProviderOptions = [...options.matchAll(/<option value="__unknown__"/g)].length;
    const blankSentinelOptions = [...options.matchAll(/<option value="__BLANK_PROVIDER__"/g)].length;
    if (realProviderOptions !== 1 || blankSentinelOptions !== 1)
      throw new Error('dropdown must carry the real __unknown__ provider AND the Unknown (blank) sentinel as DISTINCT values: ' + options);
    return 'UsageRepo.Query(provider="__unknown__") returned realRows=' + realRows + ' blankRows=' + blankRows +
      ' (the real provider filters by its own name); Query(provider="__BLANK_PROVIDER__") returned ' + bRealRows + ' real / ' + bBlankRows +
      ' blank rows; populateFilters emitted ' + realProviderOptions + ' real option(s) + ' + blankSentinelOptions +
      ' sentinel option(s) - no collision, both filterable';
  }
});

scenarios.push({
  id: 191,
  regression: true, // REFUTED lead (2026-08-10): _TitleGen_ParseResponse is already graceful - an AHK bare try block SWALLOWS exceptions (probe-verified), so malformed/partial title responses return an empty title instead of crashing the SetTimer callback
  name: 'Title-generation parser stays graceful on malformed/partial responses (truncated JSON and empty-completion shapes return an empty title; a normal response still parses)',
  mode: null,
  noApp: true,
  settings: {},
  async body() {
    const os = require('node:os');
    const outFile = path.join(os.tmpdir(), 'llm-bughunt-db-' + process.pid + '.txt');
    try { fs.unlinkSync(outFile); } catch {}
    const probe = path.join(__dirname, '..', 'probe-bughunt-db.ahk');
    const res = spawnSync(launcher.AHK, ['/ErrorStdOut', probe, outFile, 'titlegen-parse-throw'], { timeout: 25000, windowsHide: true, encoding: 'utf8' });
    if (res.error) throw new Error('titlegen probe spawn failed/timed out: ' + res.error.message);
    if (res.stderr) process.stderr.write('[probe stderr] ' + res.stderr);
    const text = fs.readFileSync(outFile, 'utf-8');
    const threwM = text.match(/threw=(\d)/);
    const ctrlM = text.match(/controlTitle='([^']*)'/);
    const emptyM = text.match(/emptyCompletionThrew=(\d)/);
    if (!threwM || !ctrlM || !emptyM) throw new Error('probe output missing fields: ' + text);
    if (threwM[1] !== '0' || emptyM[1] !== '0' || ctrlM[1] !== 'Hello Title')
      throw new Error('title-gen parser regressed (would crash the timer + Runtime Error banner): ' + text);
    return 'real _TitleGen_ParseResponse: truncated JSON ("{"choices":[{"mes") threw=0, empty-completion shape threw=0, and a normal response yields "' + ctrlM[1] +
      '" - the bare try swallows the parse error, so a failed title call degrades to an empty title (status failed) without a Runtime Error banner or a stuck dispatch guard';
  }
});

scenarios.push({
  id: 194,
  name: 'Overwrite-editing an assistant updates current context without changing historical cumulative output',
  mode: null,
  noApp: true,
  regression: true, // FIXED bug #194 kept as a regression check
  settings: {},
  async body() {
    const os = require('node:os');
    const outFile = path.join(os.tmpdir(), 'llm-bughunt-db-' + process.pid + '.txt');
    try { fs.unlinkSync(outFile); } catch {}
    const probe = path.join(__dirname, '..', 'probe-bughunt-db.ahk');
    const res = spawnSync(launcher.AHK, ['/ErrorStdOut', probe, outFile, 'edit-assistant-stale-cumulative'], { timeout: 25000, windowsHide: true, encoding: 'utf8' });
    if (res.error) throw new Error('edit-assistant-cumulative probe spawn failed/timed out: ' + res.error.message);
    if (res.stderr) process.stderr.write('[probe stderr] ' + res.stderr);
    const text = fs.readFileSync(outFile, 'utf-8');
    const a1M = text.match(/a1tcAfterEdit=(\d+)/);
    const beforeM = text.match(/beforeCumOut=(\d+)/);
    const afterM = text.match(/afterCumOut=(\d+)/);
    if (!a1M || !beforeM || !afterM) throw new Error('probe output missing fields: ' + text);
    const a1tc = Number(a1M[1]), beforeCumOut = Number(beforeM[1]), afterCumOut = Number(afterM[1]);
    // The edited text gets a new current-path estimate, but the billed API
    // output snapshot remains the original 9-token historical call.
    if (!(a1tc > 9 && beforeCumOut === 9 && afterCumOut === 9))
      throw new Error('assistant edit changed historical cumulative output: a1tc=' + a1tc + ' before=' + beforeCumOut + ' after=' + afterCumOut);
    return 'assistant overwrite-edit refreshed token_count=' + a1tc +
      ' and chat_threads.cumulative_output_tokens stayed at historical ' + afterCumOut +
      ' (was ' + beforeCumOut + ' before the edit) - current context estimate and billed history are separate';
  }
});

scenarios.push({
  id: 200,
  name: 'Usage dashboard command rows with an EMPTY provider but a provider-prefixed model are unfilterable - renderMainChart keys command rows by c.provider||"" (unlike chat rows, which fall back to extractProvider(c.model)), while populateFilters only adds the "Unknown (blank)" sentinel when BOTH provider and extractProvider(model) are empty; the "" command series renders with no selectable filter',
  mode: null,
  noApp: true,
  regression: true, // FIXED bug #200 kept as a regression check
  settings: {},
  async body() {
    const { sandbox, els } = loadUsageDashboardSandbox();
    sandbox.allData = {
      chat: [],
      commands: [{
        date: '2026-08-12', model: 'deepseek/gpt-5', provider: '',
        prompt_tokens: 10, completion_tokens: 5, thinking_tokens: 0, cached_tokens: 0,
        cached_input_cost: 0, output_cost: 0, total_cost: 0, call_count: 1
      }],
      providers: ['deepseek'],
      models: ['deepseek/gpt-5']
    };
    els.providerFilter.innerHTML = '';
    sandbox.document.querySelector = function(sel) {
      return sel === '#stackToggle .active' ? { dataset: { mode: 'provider' } } : null;
    };
    let captured = null;
    sandbox.Chart = function(ctx, cfg) { captured = cfg; return { destroy() {}, update() {} }; };
    sandbox.mainChart = null;
    sandbox.populateFilters();
    sandbox.renderMainChart();
    const options = els.providerFilter.innerHTML;
    const hasBlankOption = options.indexOf('__BLANK_PROVIDER__') >= 0;
    const chartLabels = captured ? captured.data.datasets.map((d) => d.label) : [];
    const hasEmptySeries = chartLabels.indexOf('') >= 0;
    // FIXED (bug #200): the command row charts under its model's provider
    // prefix (deepseek), exactly like chat rows, so the existing provider
    // filter option can select it - no unfilterable "" series exists.
    if (hasEmptySeries || chartLabels.indexOf('deepseek') < 0)
      throw new Error('command empty-provider series still unfilterable (fix incomplete): chartLabels=' + JSON.stringify(chartLabels));
    return 'command row provider="" model="deepseek/gpt-5": provider-mode chart labels=' + JSON.stringify(chartLabels) +
      ' (charts under "deepseek", matching the filter options) - no unfilterable "" series remains';
  }
});

scenarios.push({
  id: 202,
  name: 'Forking a thread that contains a "Save as Branch" local copy re-counts the copy as a REAL API call - TreeRepo fork INSERTs do not copy is_local_copy, so _RecomputeCumulativeCounters charges the copied tokens/cost a second time and the fork header disagrees with the source thread and the dashboard',
  mode: null,
  noApp: true,
  regression: true, // FIXED bug #202 kept as a regression check
  settings: {},
  async body() {
    const os = require('node:os');
    const outFile = path.join(os.tmpdir(), 'llm-bughunt-db-' + process.pid + '.txt');
    try { fs.unlinkSync(outFile); } catch {}
    const probe = path.join(__dirname, '..', 'probe-bughunt-db.ahk');
    const res = spawnSync(launcher.AHK, ['/ErrorStdOut', probe, outFile, 'fork-local-copy'], { timeout: 25000, windowsHide: true, encoding: 'utf8' });
    if (res.error) throw new Error('fork-local-copy probe spawn failed/timed out: ' + res.error.message);
    if (res.stderr) process.stderr.write('[probe stderr] ' + res.stderr);
    const text = fs.readFileSync(outFile, 'utf-8');
    const srcM = text.match(/src=(\d+)\/(\d+)\/(\d+)/);
    const forkM = text.match(/fork=(\d+)\/(\d+)\/(\d+)/);
    const flagsM = text.match(/forkLocalCopyRows=(\d+)/);
    if (!srcM || !forkM || !flagsM) throw new Error('probe output missing fields: ' + text);
    const srcIn = Number(srcM[1]), srcOut = Number(srcM[2]), srcCk = Number(srcM[3]);
    const forkIn = Number(forkM[1]), forkOut = Number(forkM[2]), forkCk = Number(forkM[3]);
    const copyFlags = Number(flagsM[1]);
    // FIXED (bug #202): the fork preserves is_local_copy, so its cumulative
    // counters match the source (the branch copy is never re-charged).
    if (!(copyFlags === 1 && forkIn === srcIn && forkOut === srcOut && forkCk === srcCk))
      throw new Error('fork still re-counts the local copy (fix incomplete): copyFlags=' + copyFlags + ' src=' + srcIn + '/' + srcOut + '/' + srcCk + ' fork=' + forkIn + '/' + forkOut + '/' + forkCk);
    return 'source thread (1 real API call 12/9/4 + 1 local copy): cumulative=' + srcIn + '/' + srcOut + '/' + srcCk +
      '; fork has ' + copyFlags + ' is_local_copy row(s) and cumulative=' + forkIn + '/' + forkOut + '/' + forkCk +
      ' - the fork preserves the local-copy flag, so its header agrees with the source and the dashboard';
  }
});

scenarios.push({
  id: 267,
  name: 'Quick Access > Usage Dashboard replaces open Commands Settings without side-by-side layout',
  mode: null,
  regression: true,
  settings: {},
  async body({ cdp }) {
    await showChat();
    await openSettings(cdp);
    await openSection(cdp, 'commands');

    // This is the same JS entry point reached by the showDashboard IPC sent
    // from Quick Access. Previously it only showed the dashboard panel; the
    // settings nav/center remained visible and squeezed Commands to the side.
    await cdp.eval('window._showDashboard(); true');
    await cdp.waitFor(
      'document.getElementById("dashboard-panel").style.display === "flex" && ' +
      'document.getElementById("settingsNav").style.display === "none" && ' +
      'document.getElementById("settingsCenter").style.display === "none"',
      10000, 100, 'dashboard replaces settings'
    );

    const state = await cdp.eval(`(() => ({
      dashboard: document.getElementById('dashboard-panel').style.display,
      chat: document.getElementById('chat-layout').style.display,
      settingsNav: document.getElementById('settingsNav').style.display,
      settingsCenter: document.getElementById('settingsCenter').style.display,
      railLeft: document.getElementById('railLeft').style.display,
      dashboardActive: document.getElementById('dashboard-icon').classList.contains('active'),
      settingsActive: document.getElementById('settings-icon').classList.contains('active')
    }))()`);

    if (!(state.dashboard === 'flex' && state.chat === 'none' &&
          state.settingsNav === 'none' && state.settingsCenter === 'none' &&
          state.railLeft !== 'none' && state.dashboardActive && !state.settingsActive)) {
      throw new Error('dashboard/settings navigation state is mixed: ' + JSON.stringify(state));
    }
    return 'Quick Access dashboard replaced Commands Settings cleanly: settings hidden, left rail restored, dashboard active';
  }
});

module.exports = scenarios;
