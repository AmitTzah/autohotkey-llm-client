// scenarios/chat-tree.js - Threads, fork, branch, rename, delete, trash
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
const { sleep, runProbe, showChat, sendChatMessage, waitStreamingIdle } = require('./helpers');

const scenarios = [];

scenarios.push({
  id: 1,
  name: 'New chat after deleting active chat starts clean (no leaked per-thread settings)',
  regression: true, // FIXED bug kept as a regression check (new chats must stay clean after deletions)
  mode: null, // refused endpoint: request fails fast, thread + settings still created
  settings: {
    assistants: [{
      id: 'asst-1', name: 'My Assistant', baseModel: 'deepseek/deepseek-v4-flash',
      systemMessage: 'You are a pirate.', systemMessageFile: '', description: '',
      reasoning: 'high', temperature: '0.3', isDefault: false
    }]
  },
  fixtures: {
    threads: [{
      id: 't-leak-1', title: 'Leak Source', active_leaf_id: 'm-leak-1',
      assistant_id: 'asst-1', model_override: 'deepseek/deepseek-v4-pro',
      system_override: 'You are a pirate.', reasoning_override: 'high',
      temperature_override: 0.3, font_size: 21
    }],
    messages: [{ id: 'm-leak-1', thread_id: 't-leak-1', role: 'user', content: 'hello', token_count: 5 }]
  },
  async body({ cdp, dbPath }) {
    await showChat();
    await cdp.waitFor('document.querySelectorAll("#thread-list .chat-item").length > 0', 15000, 300, 'thread list');
    await cdp.click('#thread-list .chat-item');
    await cdp.waitFor('window.activeThreadId === "t-leak-1" && document.querySelectorAll(".msg").length === 1', 15000, 300, 'thread loaded');
    await cdp.eval(`(() => {
      const item = [...document.querySelectorAll('#thread-list .chat-item')].find(i => i.getAttribute('data-chat') === 't-leak-1');
      if (!item) return 'no-item';
      const btn = item.querySelector('.chat-action-btn.danger');
      if (!btn) return 'no-btn';
      btn.click();
      return 'clicked';
    })()`);
    // NOTE: post deleteThread directly (instead of driving the delete-confirm
    // dialog) so this scenario stays focused on the per-thread settings leak and is
    // independent of the delete-confirm flow covered by scenario 23.
    await cdp.eval(`window.chrome.webview.postMessage(JSON.stringify({ action: 'sidebarAction', subAction: 'deleteThread', threadId: 't-leak-1' })); true`);
    await cdp.waitFor('window.activeThreadId === "" && chatMessages.length === 0', 10000, 250, 'chat emptied');
    await sendChatMessage(cdp, 'fresh message');
    await cdp.waitFor('window.activeThreadId !== ""', 10000, 250, 'new thread created');
    const newId = await cdp.eval('window.activeThreadId');
    const rows = seed.query(dbPath,
      'SELECT assistant_id, model_override, system_override, reasoning_override, temperature_override, font_size FROM chat_threads WHERE id = ?',
      [newId]);
    const s = rows[0] || {};
    const leaked = s.assistant_id === 'asst-1' && s.system_override === 'You are a pirate.' &&
      s.reasoning_override === 'high' && Number(s.temperature_override) === 0.3 && Number(s.font_size) === 21;
    if (leaked) throw new Error('new thread leaked deleted chat settings: ' + JSON.stringify(s));
    return 'new thread ' + newId + ' starts clean (no assistant/system/reasoning/temp/font from deleted chat)';
  }
});

scenarios.push({
  id: 2,
  name: 'New chat honors the "New Chats Start With" default (assistant)',
  regression: true, // FIXED bug kept as a regression check (new-chat default must keep applying)
  mode: 'json',
  settings: {
    assistants: [
      { id: 'asst-d', name: 'Default Assistant', baseModel: 'deepseek/deepseek-v4-flash', systemMessage: 'default sys', systemMessageFile: '', description: '', reasoning: 'high', temperature: '0.5' },
      { id: 'asst-x', name: 'Other Assistant', baseModel: 'openai/gpt-5-mini', systemMessage: '', systemMessageFile: '', description: '', reasoning: '', temperature: '' }
    ],
    newChatStartsWith: 'asst:asst-d'
  },
  async body({ cdp, mockLog }) {
    await showChat();
    await cdp.waitFor('typeof window._currentSettings !== "undefined" && typeof window._assistantList !== "undefined"', 15000, 300, 'settings state');
    await cdp.click('#new-chat-btn');
    await cdp.waitFor('window.activeThreadId !== ""', 10000, 250, 'new chat created');
    await sleep(600);
    const assistantName = await cdp.eval('window._currentSettings.assistantName || ""');
    const model = await cdp.eval('window._currentSettings.model || ""');
    if (assistantName !== 'Default Assistant') throw new Error('new chat did not start with the default assistant: ' + assistantName);
    if (model !== 'deepseek/deepseek-v4-flash') throw new Error('unexpected model: ' + model);
    return 'new chat starts with assistant "' + assistantName + '" (' + model + ')';
  }
});

scenarios.push({
  id: 7,
  name: 'Trash retention auto-purges expired trashed threads (wired at startup + timer)',
  regression: true, // FIXED bug kept as a regression check (expired trash must keep purging)
  mode: null,
  settings: { trash: { retentionDays: 1 } },
  fixtures: {
    threads: [{ id: 't-trash-1', title: 'Old Trashed', is_deleted: 1, deleted_at: '2026-07-01 00:00:00' }]
  },
  async body({ cdp, dbPath }) {
    // Static: the purge must now be reachable from production code. The ONLY
    // direct call to the repo implementation stays the ChatDB facade, and
    // Main.ahk must call the facade at startup + on the timer (settings-update
    // re-purge is a bonus, so >= 2 is enough).
    let repoCalls = 0;
    let facadeCalls = 0;
    const scanDirs = ['app', 'api', 'chat', 'shared', 'ipc'];
    const files = [path.join(launcher.REPO_ROOT, 'Main.ahk')];
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith('.ahk')) files.push(p);
      }
    };
    for (const d of scanDirs) walk(path.join(launcher.REPO_ROOT, d));
    for (const f of files) {
      const txt = fs.readFileSync(f, 'utf8');
      repoCalls += (txt.match(/ThreadRepo\.PurgeExpired\(/g) || []).length;
      facadeCalls += (txt.match(/ChatDB\.Thread_PurgeExpired\(/g) || []).length;
    }
    if (repoCalls !== 1) throw new Error('expected exactly 1 direct ThreadRepo.PurgeExpired() call (the ChatDB facade), found ' + repoCalls);
    if (facadeCalls < 2) throw new Error('expected Main.ahk to call ChatDB.Thread_PurgeExpired() at startup + timer, found ' + facadeCalls);
    // Live: an expired trashed thread must be purged during the app run
    // (the startup purge runs before the chat page is ready).
    await sleep(2500);
    const rows = seed.query(dbPath, "SELECT id FROM chat_threads WHERE id='t-trash-1' AND is_deleted=1");
    if (rows.length !== 0) throw new Error('expired trashed thread was not purged');
    return 'PurgeExpired wired via ChatDB facade in Main.ahk; expired trashed thread purged during app run';
  }
});

scenarios.push({
  id: 23,
  name: 'Chat delete confirmation works (chat overlay opens; Delete posts and deletes)',
  regression: true, // FIXED bug kept as a regression check (delete confirm must keep working)
  mode: null,
  settings: {},
  fixtures: {
    threads: [{ id: 't-del-1', title: 'To Delete', active_leaf_id: 'm-del-1' }],
    messages: [{ id: 'm-del-1', thread_id: 't-del-1', role: 'user', content: 'hello' }]
  },
  async body({ cdp, dbPath }) {
    await showChat();
    await cdp.waitFor('document.querySelectorAll("#thread-list .chat-item").length > 0', 15000, 300, 'thread list');
    await cdp.click('#thread-list .chat-item');
    await cdp.waitFor('window.activeThreadId === "t-del-1"', 15000, 300, 'thread loaded');
    await cdp.clearPosted();
    await cdp.eval(`(() => {
      const item = [...document.querySelectorAll('#thread-list .chat-item')].find(i => i.getAttribute('data-chat') === 't-del-1');
      if (!item) return 'no-item';
      const btn = item.querySelector('.chat-action-btn.danger');
      if (!btn) return 'no-btn';
      btn.click();
      return 'clicked';
    })()`);
    await sleep(400);
    const settingsModalOpen = await cdp.eval('(document.getElementById("confirmModal") || {}).classList ? document.getElementById("confirmModal").classList.contains("open") : false');
    const chatOverlay = await cdp.eval('!!document.getElementById("customConfirmOverlay")');
    const overlayMsg = await cdp.text('#customConfirmOverlay') || '';
    if (settingsModalOpen) throw new Error('settings confirmModal opened instead of the chat overlay');
    if (!chatOverlay) throw new Error('customConfirmOverlay did not open');
    if (!overlayMsg.includes('Delete this chat?')) throw new Error('unexpected overlay message: ' + JSON.stringify(overlayMsg));
    await cdp.click('#customConfirmOverlay .yes-confirm-btn');
    await cdp.waitFor('window.__posted && window.__posted.some((m) => m.includes("deleteThread"))', 5000, 100, 'deleteThread posted');
    await sleep(300);
    const posted = await cdp.postedMessages();
    const alive = seed.query(dbPath, "SELECT id FROM chat_threads WHERE id='t-del-1' AND is_deleted=0").length === 1;
    if (alive) throw new Error('thread survived the delete confirm');
    return 'delete confirm opens the chat overlay with the right message; clicking Delete posts deleteThread and deletes the chat';
  }
});

scenarios.push({
  id: 28,
  name: 'Sidebar inline rename saves on Escape instead of canceling',
  regression: true, // REFUTED: Escape cancels correctly (blur does not fire on DOM removal); kept as a regression check
  mode: null,
  settings: {},
  fixtures: {
    threads: [{ id: 't-ren-1', title: 'Original Title', active_leaf_id: 'm-ren-1' }],
    messages: [{ id: 'm-ren-1', thread_id: 't-ren-1', role: 'user', content: 'hello' }]
  },
  async body({ cdp }) {
    await showChat();
    await cdp.waitFor('document.querySelectorAll("#thread-list .chat-item").length > 0', 15000, 300, 'thread list');
    await cdp.click('#thread-list .chat-item .chat-action-btn[title="Rename"]');
    await cdp.waitFor('document.querySelector("#thread-list .chat-item .chat-name input") !== null', 5000, 200, 'inline rename input');
    // Type a new name without committing.
    await cdp.eval(`(() => {
      const inp = document.querySelector("#thread-list .chat-item .chat-name input");
      if (!inp) return false;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(inp, 'Renamed By Escape');
      inp.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);
    await cdp.clearPosted();
    // Press Escape: this must CANCEL the rename, not save it.
    await cdp.eval(`(() => {
      const inp = document.querySelector("#thread-list .chat-item .chat-name input");
      if (!inp) return false;
      inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      return true;
    })()`);
    await sleep(300);
    const posted = await cdp.postedMessages();
    const renamePosted = posted.some((m) => m.includes('renameThread'));
    const shown = await cdp.eval('document.querySelector("#thread-list .chat-item .chat-name").textContent');
    // FIXED/expected: Escape cancels the rename - no renameThread is posted and
    // the original title is restored (the earlier suspicion that blur fires on
    // DOM removal was refuted in WebView2).
    if (renamePosted) throw new Error('Escape still posts renameThread: ' + JSON.stringify(posted.filter((m) => m.includes('renameThread'))));
    if (shown !== 'Original Title') throw new Error('Escape did not restore the original title: ' + JSON.stringify(shown));
    return 'Escape canceled the rename (no renameThread posted); title stays ' + JSON.stringify(shown);
  }
});

scenarios.push({
  id: 30,
  name: 'Deleting a message confirms "data is preserved" but hard-deletes it',
  mode: null,
  regression: true, // FIXED: confirmation now honestly says permanent delete (was "data is preserved" lie),
  settings: {},
  fixtures: {
    threads: [{ id: 't-del-30', title: 'Delete Copy Thread', active_leaf_id: 'm-del-30b' }],
    messages: [
      { id: 'm-del-30a', thread_id: 't-del-30', role: 'user', content: 'first message' },
      { id: 'm-del-30b', thread_id: 't-del-30', role: 'assistant', content: 'reply', model: 'deepseek/deepseek-v4-flash', parent_id: 'm-del-30a' }
    ]
  },
  async body({ cdp, dbPath }) {
    await showChat();
    // Load the seeded thread first - bubbles only render after loadThread.
    await cdp.waitFor('document.querySelectorAll("#thread-list .chat-item").length > 0', 15000, 300, 'thread list');
    await cdp.click('#thread-list .chat-item');
    await cdp.waitFor('document.querySelectorAll("#chat-messages .msg").length >= 2', 15000, 300, 'messages rendered');
    // Delete the user message: the confirm dialog must now honestly warn permanent deletion.
    await cdp.click('#chat-messages .msg:nth-child(1) .msg-action-btn[title="Delete"]');
    await cdp.waitFor('document.getElementById("customConfirmOverlay") !== null', 5000, 200, 'confirm overlay');
    const confirmText = await cdp.eval('document.getElementById("customConfirmOverlay").textContent');
    const saysPreserved = confirmText.indexOf('data is preserved') >= 0;
    await cdp.click('#customConfirmOverlay .yes-confirm-btn');
    await sleep(900); // IPC round trip + DB delete + re-render
    const rows = seed.query(dbPath, "SELECT COUNT(*) AS c FROM messages WHERE id='m-del-30a'");
    const deletedForever = rows[0].c === 0;
    // FIXED: dialog now honestly warns permanent deletion, not data preserved.
    const saysPermanent = confirmText.indexOf('permanently') >= 0 || confirmText.indexOf('cannot be undone') >= 0;
    if (saysPreserved)
      throw new Error('confirmation still claims data is preserved (lie not fixed): ' + JSON.stringify(confirmText.trim()));
    if (!saysPermanent)
      throw new Error('confirmation should warn permanent deletion: ' + JSON.stringify(confirmText.trim()));
    if (!deletedForever)
      throw new Error('message should still be hard-deleted (row gone) but survived: deletedForever=' + deletedForever + ' text=' + JSON.stringify(confirmText.trim()));
    return 'confirm dialog honestly says "' + confirmText.trim() + '" and the message row is permanently gone';
  }
});

scenarios.push({
  id: 38,
  name: 'Chat window title follows the active thread after a rename + switch',
  regression: true, // FIXED bug kept as a regression check (switching threads must update the window title)
  mode: null,
  settings: {},
  fixtures: {
    threads: [
      { id: 't-title-38a', title: 'Alpha Thread', active_leaf_id: 'm-title-38a' },
      { id: 't-title-38b', title: 'Beta Thread', active_leaf_id: 'm-title-38b' }
    ],
    messages: [
      { id: 'm-title-38a', thread_id: 't-title-38a', role: 'user', content: 'hello alpha' },
      { id: 'm-title-38b', thread_id: 't-title-38b', role: 'user', content: 'hello beta' }
    ]
  },
  async body({ cdp, dbPath }) {
    await showChat();
    const clickItem = (idx) => cdp.eval(`(() => {
      const items = document.querySelectorAll('#thread-list .chat-item');
      if (!items[${idx}]) return false;
      items[${idx}].click();
      return true;
    })()`);
    const clickRename = (idx) => cdp.eval(`(() => {
      const items = document.querySelectorAll('#thread-list .chat-item');
      const btn = items[${idx}] && items[${idx}].querySelector('.chat-action-btn[title="Rename"]');
      if (!btn) return false;
      btn.click();
      return true;
    })()`);
    await cdp.waitFor('document.querySelectorAll("#thread-list .chat-item").length >= 2', 15000, 300, 'thread list');
    // Load thread A, then rename it via the sidebar (this sets the window title).
    await clickItem(0);
    await cdp.waitFor('document.querySelectorAll("#chat-messages .msg").length >= 1', 15000, 300, 'thread A loaded');
    await clickRename(0);
    await cdp.waitFor('document.querySelector("#thread-list .chat-item .chat-name input") !== null', 5000, 200, 'rename input');
    await cdp.type('#thread-list .chat-item .chat-name input', 'Alpha Renamed');
    const inputVal = await cdp.eval('document.querySelector("#thread-list .chat-item .chat-name input") ? document.querySelector("#thread-list .chat-item .chat-name input").value : "(missing)"');
    await cdp.clearPosted();
    await cdp.eval(`(() => {
      const inp = document.querySelector('#thread-list .chat-item .chat-name input');
      if (!inp) return false;
      inp.dispatchEvent(new Event('blur', { bubbles: true }));
      return true;
    })()`);
    await sleep(900); // rename IPC + title update + list refresh
    const postedAfterRename = await cdp.postedMessages();
    if (!postedAfterRename.some((m) => m.includes('renameThread')))
      throw new Error('renameThread was not posted after blur; inputVal=' + JSON.stringify(inputVal) + ' posted=' + JSON.stringify(postedAfterRename));
    let renamedRows = [];
    const renameDeadline = Date.now() + 10000;
    for (;;) {
      renamedRows = seed.query(dbPath, "SELECT title FROM chat_threads WHERE id='t-title-38a'");
      if (renamedRows.length && renamedRows[0].title === 'Alpha Renamed') break;
      if (Date.now() > renameDeadline) break;
      await sleep(100);
    }
    if (!renamedRows.length || renamedRows[0].title !== 'Alpha Renamed')
      throw new Error('rename did not commit before switching (setup): ' + JSON.stringify(renamedRows));
    // Switch to thread B.
    await clickItem(1);
    await cdp.waitFor('document.querySelectorAll("#chat-messages .msg").length >= 1', 15000, 300, 'thread B loaded');
    await sleep(800);
    const topbarTitle = await cdp.eval('document.querySelector(".title-text") ? document.querySelector(".title-text").textContent : ""');
    const info = runProbe('chat-info');
    // FIXED (bug #38): _LoadThreadAndRefreshUI now updates chatWindow.Title
    // from the active thread, so after renaming A and switching to B the title
    // bar follows the newly active thread.
    if (topbarTitle.indexOf('Beta') < 0)
      throw new Error('thread B did not load (setup): topbar=' + JSON.stringify(topbarTitle));
    if ((info.title || '').indexOf('Beta') < 0)
      throw new Error('window title did not follow the thread switch: ' + JSON.stringify(info.title) + ' topbar=' + JSON.stringify(topbarTitle));
    return 'window title follows the active thread: "' + info.title + '"';
  }
});

scenarios.push({
  id: 44,
  name: 'Forking a chat drops the per-thread font size and Advanced toggles',
  mode: null,
  regression: true, // FIXED: fork now inherits font_size and advanced_toggles (was dropped),
  settings: {},
  fixtures: {
    threads: [{ id: 't-fork-44', title: 'Fork Source', active_leaf_id: 'm-fork-44', font_size: 20 }],
    messages: [{ id: 'm-fork-44', thread_id: 't-fork-44', role: 'user', content: 'fork me' }]
  },
  async body({ cdp, dbPath }) {
    // Seed advanced_toggles on the source thread (the fixtures builder has no
    // column for it) BEFORE loading the thread so the fork must copy both
    // per-thread settings to preserve them.
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(dbPath);
    db.exec("UPDATE chat_threads SET advanced_toggles = '{\"codeExecution\":true,\"webSearch\":true}' WHERE id='t-fork-44'");
    db.close();

    await showChat();
    await cdp.waitFor('document.querySelectorAll("#thread-list .chat-item").length > 0', 15000, 300, 'thread list');
    await cdp.click('#thread-list .chat-item');
    await cdp.waitFor('document.querySelectorAll("#chat-messages .msg").length >= 1', 15000, 300, 'thread loaded');
    await sleep(700);
    const fontBefore = await cdp.eval('document.getElementById("font-size-display").textContent');
    if (fontBefore !== '20px')
      throw new Error('source thread font size not applied (setup): ' + JSON.stringify(fontBefore));
    // Fork the chat from the user message.
    await cdp.click('#chat-messages .msg .msg-action-btn[title="Fork"]');
    await cdp.waitFor('window.activeThreadId !== "t-fork-44"', 15000, 300, 'fork created');
    const newId = await cdp.eval('window.activeThreadId');
    await sleep(700);
    const rows = seed.query(dbPath, 'SELECT font_size, advanced_toggles FROM chat_threads WHERE id = ?', [newId]);
    const s = rows[0] || {};
    const fontAfter = await cdp.eval('document.getElementById("font-size-display").textContent');
    // FIXED: TreeRepo._CopyThreadSettings now copies font_size and advanced_toggles
    if (Number(s.font_size) !== 20 || String(s.advanced_toggles || '').indexOf('codeExecution') < 0 || fontAfter !== '20px')
      throw new Error('fork did not keep source settings (fix broken): ' + JSON.stringify(s) + ' font=' + fontAfter);
    return 'source thread font_size=20 + advanced_toggles set; fork id=' + newId +
      ' correctly has font_size=' + s.font_size + ' advanced_toggles=' + JSON.stringify(s.advanced_toggles) +
      ' and the UI shows ' + fontAfter;
  }
});

scenarios.push({
  id: 48,
  name: 'Forking a chat keeps token stats (context copied per message; cumulative counters recomputed from the fork\'s own messages)',
  regression: true, // FIXED bug kept as a regression check (bug #48 context part + bug #126 recompute semantics)
  mode: null,
  settings: {},
  fixtures: {
    threads: [{ id: 't-stats-48', title: 'Stats Source', active_leaf_id: 'm-stats-48b' }],
    messages: [
      { id: 'm-stats-48a', thread_id: 't-stats-48', role: 'user', content: 'hello', token_count: 10, active_path_tokens: 10 },
      { id: 'm-stats-48b', thread_id: 't-stats-48', role: 'assistant', content: 'hi', model: 'deepseek/deepseek-v4-flash', parent_id: 'm-stats-48a', token_count: 20, active_path_tokens: 40 }
    ]
  },
  async body({ cdp, dbPath }) {
    // Give the source thread real cumulative usage stats (the fixtures builder
    // defaults them to 0), matching what MessageRepo.Insert accumulates.
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(dbPath);
    db.exec("UPDATE chat_threads SET cumulative_input_tokens=10, cumulative_output_tokens=20, cumulative_cached_tokens=2, cumulative_cost=0.5, cumulative_input_cost=0.3, cumulative_cached_input_cost=0.01, cumulative_output_cost=0.2 WHERE id='t-stats-48'");
    db.close();

    await showChat();
    await cdp.waitFor('document.querySelectorAll("#thread-list .chat-item").length > 0', 15000, 300, 'thread list');
    await cdp.click('#thread-list .chat-item');
    await cdp.waitFor('document.querySelectorAll("#chat-messages .msg").length >= 2', 15000, 300, 'thread loaded');
    await sleep(700);
    const sourceBar = await cdp.eval('document.getElementById("tokenBar").textContent');
    if (String(sourceBar).indexOf('$0.50') < 0)
      throw new Error('source token bar missing $0.50 (setup): ' + JSON.stringify(sourceBar));
    // Fork the chat from the ASSISTANT message (a1): the fork contains u1 + a1.
    await cdp.click('#chat-messages .msg:nth-child(2) .msg-action-btn[title="Fork"]');
    await cdp.waitFor('window.activeThreadId !== "t-stats-48"', 15000, 300, 'fork created');
    const newId = await cdp.eval('window.activeThreadId');
    await sleep(800);
    const forkBar = await cdp.eval('document.getElementById("tokenBar").textContent');
    const forkMsgs = seed.query(dbPath, 'SELECT COUNT(*) AS c FROM messages WHERE thread_id = ?', [newId])[0].c;
    const forkRow = seed.query(dbPath, 'SELECT cumulative_input_tokens, cumulative_output_tokens, cumulative_cost, active_leaf_id FROM chat_threads WHERE id = ?', [newId])[0] || {};
    const leafStats = forkRow.active_leaf_id
      ? seed.query(dbPath, 'SELECT active_path_tokens FROM messages WHERE id = ?', [forkRow.active_leaf_id])[0] || {}
      : {};
    // FIXED (bug #48 + #126): TreeRepo.ForkThread copies each message's
    // active_path_tokens (context used) but RECOMPUTES the cumulative counters
    // from the fork's own messages - only a1's API call (10 input / 20 output),
    // not the source thread's full ledger (which over-reported mid-conversation
    // forks).
    if (forkMsgs !== 2)
      throw new Error('fork should contain 2 messages (u1 + a1), got ' + forkMsgs);
    if (forkRow.cumulative_input_tokens !== 10 || forkRow.cumulative_output_tokens !== 20)
      throw new Error('fork counters were not recomputed from its own messages: ' + JSON.stringify(forkRow));
    if (leafStats.active_path_tokens !== 40)
      throw new Error('fork leaf active_path_tokens was not copied: ' + leafStats.active_path_tokens);
    return 'source token bar: ' + JSON.stringify(sourceBar) + '; fork token bar: ' + JSON.stringify(forkBar) +
      ' (recomputed counters=' + forkRow.cumulative_input_tokens + '/' + forkRow.cumulative_output_tokens + ', leaf active_path_tokens=' + leafStats.active_path_tokens + ')';
  }
});

scenarios.push({
  id: 54,
  name: 'Chat-header token bar contract on branch switch: context follows the active path, cumulative cost/tokens stay',
  regression: true, // REFUTED: the contract HOLDS (context 65->80, cost/totals unchanged); kept as a regression check
  mode: null,
  settings: {},
  fixtures: {
    threads: [{ id: 't-br-54', title: 'Branch Tokens', active_leaf_id: 'm-br-a2' }],
    messages: [
      { id: 'm-br-u1', thread_id: 't-br-54', role: 'user', content: 'first', token_count: 10, active_path_tokens: 10 },
      { id: 'm-br-a1', thread_id: 't-br-54', role: 'assistant', content: 'reply A', model: 'deepseek/deepseek-v4-flash', parent_id: 'm-br-u1', sibling_group: 'sg-br', sibling_index: 0, token_count: 20, active_path_tokens: 30 },
      { id: 'm-br-u2', thread_id: 't-br-54', role: 'user', content: 'follow A', parent_id: 'm-br-a1', token_count: 5, active_path_tokens: 35 },
      { id: 'm-br-a2', thread_id: 't-br-54', role: 'assistant', content: 'answer A', model: 'deepseek/deepseek-v4-flash', parent_id: 'm-br-u2', token_count: 30, active_path_tokens: 65 },
      { id: 'm-br-a1b', thread_id: 't-br-54', role: 'assistant', content: 'reply B', model: 'deepseek/deepseek-v4-flash', parent_id: 'm-br-u1', sibling_group: 'sg-br', sibling_index: 1, token_count: 20, active_path_tokens: 30 },
      { id: 'm-br-u2b', thread_id: 't-br-54', role: 'user', content: 'follow B', parent_id: 'm-br-a1b', token_count: 10, active_path_tokens: 40 },
      { id: 'm-br-a2b', thread_id: 't-br-54', role: 'assistant', content: 'answer B', model: 'deepseek/deepseek-v4-flash', parent_id: 'm-br-u2b', token_count: 40, active_path_tokens: 80 }
    ]
  },
  async body({ cdp, dbPath }) {
    // Shared per-thread cumulative ledger (tooltip: "across all conversation
    // branches") - must NOT change on branch switch.
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(dbPath);
    db.exec("UPDATE chat_threads SET cumulative_input_tokens=25, cumulative_output_tokens=110, cumulative_cached_tokens=4, cumulative_cost=1.5, cumulative_input_cost=0.5, cumulative_cached_input_cost=0.1, cumulative_output_cost=1.0 WHERE id='t-br-54'");
    db.close();

    await showChat();
    await cdp.waitFor('document.querySelectorAll("#thread-list .chat-item").length > 0', 15000, 300, 'thread list');
    await cdp.click('#thread-list .chat-item');
    await cdp.waitFor('document.querySelectorAll("#chat-messages .msg").length >= 4', 15000, 300, 'branch A loaded');
    await sleep(700);
    const barA = await cdp.eval('document.getElementById("tokenBar").textContent');
    if (String(barA).indexOf('65') < 0 || String(barA).indexOf('$1.50') < 0)
      throw new Error('branch A header values missing (setup): ' + JSON.stringify(barA));
    // Switch to branch B via the nav arrow on the shared assistant message.
    await cdp.click('#chat-messages .msg .msg-action-btn[title="Next branch"]');
    await cdp.waitFor('chatMessages.length >= 4 && chatMessages[3] && chatMessages[3].id === "m-br-a2b"', 15000, 300, 'branch B loaded');
    await sleep(700);
    const barB = await cdp.eval('document.getElementById("tokenBar").textContent');
    const costB = await cdp.eval('document.querySelector("#tokenBar .tu-item:last-child .tu-val").textContent');
    const contextB = await cdp.eval('document.querySelector("#tokenBar .tu-item:first-child .tu-val").textContent');
    // CONTRACT: context follows the active path (65 -> 80) while the cumulative
    // cost and totals stay per-thread. Throw with observed values if violated.
    if (String(contextB).indexOf('80') < 0 || costB !== '$1.50')
      throw new Error('token bar contract violated on branch switch: branch A bar=' + JSON.stringify(barA) +
        ' branch B bar=' + JSON.stringify(barB) + ' contextB=' + JSON.stringify(contextB) + ' costB=' + JSON.stringify(costB));
    return 'branch A bar=' + JSON.stringify(barA) + ' -> branch B bar=' + JSON.stringify(barB) +
      ' (context ' + JSON.stringify(contextB) + ', cost ' + costB + ' - contract holds)';
  }
});

scenarios.push({
  id: 55,
  name: 'Branch switch / search navigation land on the newest continuation (matching the tree modal)',
  regression: true, // FIXED bug kept as a regression check (branch-nav/search must land on the same leaf the tree modal picks)
  mode: null,
  settings: {},
  fixtures: {
    threads: [{ id: 't-br-55', title: 'Multi-Child Branch', active_leaf_id: 'm-br-55-a2x' }],
    messages: [
      { id: 'm-br-55-u1', thread_id: 't-br-55', role: 'user', content: 'first', token_count: 10, active_path_tokens: 10, created_at: '2026-08-01 09:00:00' },
      { id: 'm-br-55-a1', thread_id: 't-br-55', role: 'assistant', content: 'reply A', model: 'deepseek/deepseek-v4-flash', parent_id: 'm-br-55-u1', sibling_group: 'sg-55', sibling_index: 0, token_count: 20, active_path_tokens: 30, created_at: '2026-08-01 09:01:00' },
      { id: 'm-br-55-u2', thread_id: 't-br-55', role: 'user', content: 'follow A1', parent_id: 'm-br-55-a1', token_count: 5, active_path_tokens: 35, created_at: '2026-08-01 09:02:00' },
      { id: 'm-br-55-a2', thread_id: 't-br-55', role: 'assistant', content: 'ans A1', model: 'deepseek/deepseek-v4-flash', parent_id: 'm-br-55-u2', token_count: 30, active_path_tokens: 65, created_at: '2026-08-01 09:03:00' },
      { id: 'm-br-55-u2x', thread_id: 't-br-55', role: 'user', content: 'follow A2', parent_id: 'm-br-55-a1', token_count: 10, active_path_tokens: 40, created_at: '2026-08-01 10:00:00' },
      { id: 'm-br-55-a2x', thread_id: 't-br-55', role: 'assistant', content: 'ans A2', model: 'deepseek/deepseek-v4-flash', parent_id: 'm-br-55-u2x', token_count: 40, active_path_tokens: 90, created_at: '2026-08-01 10:01:00' },
      { id: 'm-br-55-a1b', thread_id: 't-br-55', role: 'assistant', content: 'reply B', model: 'deepseek/deepseek-v4-flash', parent_id: 'm-br-55-u1', sibling_group: 'sg-55', sibling_index: 1, token_count: 20, active_path_tokens: 30, created_at: '2026-08-01 09:05:00' },
      { id: 'm-br-55-u2b', thread_id: 't-br-55', role: 'user', content: 'follow B1', parent_id: 'm-br-55-a1b', token_count: 10, active_path_tokens: 40, created_at: '2026-08-01 09:06:00' },
      { id: 'm-br-55-a2b', thread_id: 't-br-55', role: 'assistant', content: 'ans B1', model: 'deepseek/deepseek-v4-flash', parent_id: 'm-br-55-u2b', token_count: 30, active_path_tokens: 70, created_at: '2026-08-01 09:07:00' },
      { id: 'm-br-55-u2bx', thread_id: 't-br-55', role: 'user', content: 'follow B2', parent_id: 'm-br-55-a1b', token_count: 15, active_path_tokens: 45, created_at: '2026-08-01 11:00:00' },
      { id: 'm-br-55-a2bx', thread_id: 't-br-55', role: 'assistant', content: 'ans B2', model: 'deepseek/deepseek-v4-flash', parent_id: 'm-br-55-u2bx', token_count: 50, active_path_tokens: 95, created_at: '2026-08-01 11:01:00' }
    ]
  },
  async body({ cdp }) {
    await showChat();
    await cdp.waitFor('document.querySelectorAll("#thread-list .chat-item").length > 0', 15000, 300, 'thread list');
    await cdp.click('#thread-list .chat-item');
    await cdp.waitFor('chatMessages.length >= 4 && chatMessages[chatMessages.length - 1].id === "m-br-55-a2x"', 15000, 300, 'newest continuation loaded');
    await sleep(700);
    const contextStart = await cdp.eval('document.querySelector("#tokenBar .tu-item:first-child .tu-val").textContent');
    if (String(contextStart).indexOf('90') < 0)
      throw new Error('active continuation context missing (setup): ' + JSON.stringify(contextStart));
    // Branch-nav switch to the sibling (a1 -> a1b). a1b has TWO continuations:
    // u2b (oldest, leaf context 70) and u2bx (newest, leaf context 95).
    await cdp.click('#chat-messages .msg .msg-action-btn[title="Next branch"]');
    await cdp.waitFor('chatMessages.length >= 4 && chatMessages[chatMessages.length - 1].id !== "m-br-55-a2x"', 15000, 300, 'branch switched');
    await sleep(700);
    const contextSwitch = await cdp.eval('document.querySelector("#tokenBar .tu-item:first-child .tu-val").textContent');
    const leafAfterSwitch = await cdp.eval('chatMessages[chatMessages.length - 1] ? chatMessages[chatMessages.length - 1].id : ""');
    // FIXED (bug #55): _WalkToLeaf now picks the same leaf the tree modal's
    // _findDefaultLeaf picks (the newest continuation), so branch-nav/search
    // navigation lands on the newest continuation.
    if (leafAfterSwitch !== 'm-br-55-a2bx' || String(contextSwitch).indexOf('95') < 0)
      throw new Error('branch switch did not land on the newest continuation (bug #55 not fixed): leaf=' + leafAfterSwitch + ' context=' + contextSwitch);
    // Tree modal navigation to the SAME node must land on the newest leaf (95) -
    // proving the two navigation paths disagree.
    await cdp.click('#treeBtn');
    await cdp.waitFor('typeof window._treeData !== "undefined" && window._treeData.length > 0', 15000, 300, 'tree data');
    await cdp.waitFor('document.querySelector(\'.tree-node[data-target="m-br-55-a1b"]\') !== null', 15000, 300, 'tree node');
    await cdp.click('.tree-node[data-target="m-br-55-a1b"]');
    await cdp.waitFor('chatMessages[chatMessages.length - 1] && chatMessages[chatMessages.length - 1].id === "m-br-55-a2bx"', 15000, 300, 'tree navigated to newest');
    await sleep(700);
    const contextTree = await cdp.eval('document.querySelector("#tokenBar .tu-item:first-child .tu-val").textContent');
    if (String(contextTree).indexOf('95') < 0)
      throw new Error('tree modal did not land on the newest continuation: ' + JSON.stringify(contextTree));
    return 'branch-nav switch from a1 landed on leaf ' + leafAfterSwitch + ' (context ' + JSON.stringify(contextSwitch) +
      ') and the tree modal lands on m-br-55-a2bx (context ' + JSON.stringify(contextTree) + ') - both newest';
  }
});

scenarios.push({
  id: 58,
  name: 'Forking a chat keeps the thread\'s folder',
  regression: true, // FIXED bug kept as a regression check (forks must stay in the source folder)
  mode: null,
  settings: {},
  fixtures: {
    folders: [{ id: 'f-fork-58', name: 'My Folder' }],
    threads: [{ id: 't-fork-58', title: 'Forked Source', active_leaf_id: 'm-fork-58', folder_id: 'f-fork-58' }],
    messages: [{ id: 'm-fork-58', thread_id: 't-fork-58', role: 'user', content: 'fork me' }]
  },
  async body({ cdp, dbPath }) {
    await showChat();
    await cdp.waitFor('document.querySelectorAll("#thread-list .chat-item").length > 0', 15000, 300, 'thread list');
    await cdp.click('#thread-list .chat-item');
    await cdp.waitFor('document.querySelectorAll("#chat-messages .msg").length >= 1', 15000, 300, 'thread loaded');
    await sleep(500);
    await cdp.click('#chat-messages .msg .msg-action-btn[title="Fork"]');
    await cdp.waitFor('window.activeThreadId !== "t-fork-58"', 15000, 300, 'fork created');
    const newId = await cdp.eval('window.activeThreadId');
    await sleep(500);
    const rows = seed.query(dbPath, 'SELECT folder_id FROM chat_threads WHERE id = ?', [newId]);
    const folder = rows[0] && rows[0].folder_id;
    // FIXED (bug #58): _CopyThreadSettings now copies folder_id, so the fork
    // appears in the source thread's folder.
    if (folder !== 'f-fork-58')
      throw new Error('fork did not keep the source folder (bug #58 not fixed): folder=' + JSON.stringify(folder));
    return 'source thread is in folder f-fork-58; fork id=' + newId + ' has folder_id=' + JSON.stringify(folder) + ' (same folder)';
  }
});

scenarios.push({
  id: 113,
  name: 'Forking at a message drops the deeper branches below off-path siblings (tree copy is one level deep)',
  regression: true, // FIXED bug kept as a regression check (forks must copy full off-path subtrees)
  mode: null,
  settings: {},
  fixtures: {
    threads: [{ id: 't-fork-113', title: 'Fork Deep Tree', active_leaf_id: 'm-113-a1' }],
    messages: [
      // Active path: u1 -> a1 (fork point). a1b is an off-path sibling with a
      // whole subtree under it (u2b->a2b and a retry pair u2b2->a2b2).
      { id: 'm-113-u1', thread_id: 't-fork-113', role: 'user', content: 'root', token_count: 10, active_path_tokens: 10 },
      { id: 'm-113-a1', thread_id: 't-fork-113', role: 'assistant', content: 'reply A', model: 'deepseek/deepseek-v4-flash', parent_id: 'm-113-u1', sibling_group: 'sg-113', sibling_index: 0, token_count: 20, active_path_tokens: 30 },
      { id: 'm-113-a1b', thread_id: 't-fork-113', role: 'assistant', content: 'reply B', model: 'deepseek/deepseek-v4-flash', parent_id: 'm-113-u1', sibling_group: 'sg-113', sibling_index: 1, token_count: 20, active_path_tokens: 30 },
      // Continuations below the OFF-PATH sibling a1b (normal branch navigation walks into these).
      { id: 'm-113-u2b', thread_id: 't-fork-113', role: 'user', content: 'follow B', parent_id: 'm-113-a1b', sibling_group: 'sg-113b', sibling_index: 0, token_count: 5, active_path_tokens: 35 },
      { id: 'm-113-a2b', thread_id: 't-fork-113', role: 'assistant', content: 'ans B', model: 'deepseek/deepseek-v4-flash', parent_id: 'm-113-u2b', token_count: 30, active_path_tokens: 65 },
      // Retry of "follow B" - another sibling group that only exists below the off-path sibling.
      { id: 'm-113-u2b2', thread_id: 't-fork-113', role: 'user', content: 'follow B retry', parent_id: 'm-113-a1b', sibling_group: 'sg-113b', sibling_index: 1, token_count: 8, active_path_tokens: 38 },
      { id: 'm-113-a2b2', thread_id: 't-fork-113', role: 'assistant', content: 'ans B2', model: 'deepseek/deepseek-v4-flash', parent_id: 'm-113-u2b2', token_count: 25, active_path_tokens: 63 }
    ]
  },
  async body({ cdp, dbPath }) {
    await showChat();
    await cdp.waitFor('document.querySelectorAll("#thread-list .chat-item").length > 0', 15000, 300, 'thread list');
    await cdp.click('#thread-list .chat-item');
    await cdp.waitFor('document.querySelectorAll("#chat-messages .msg").length >= 2', 15000, 300, 'thread loaded');
    await sleep(600);
    // Fork at the assistant message (a1) - the last message on the active path.
    await cdp.click('#chat-messages .msg:nth-child(2) .msg-action-btn[title="Fork"]');
    await cdp.waitFor('window.activeThreadId !== "t-fork-113"', 15000, 300, 'fork created');
    const newId = await cdp.eval('window.activeThreadId');
    await sleep(700);
    const forkMsgs = seed.query(dbPath, "SELECT id, parent_id, sibling_group, content FROM messages WHERE thread_id = ? ORDER BY created_at", [newId]);
    const ids = forkMsgs.map((m) => m.id).sort();
    // FIXED (bug #113): _CopyOffPathSiblings now walks descendants of the
    // copied off-path siblings, so the fork is a faithful copy of the whole
    // conversation tree (u1, a1, a1b + the u2b/a2b and u2b2/a2b2 subtrees).
    if (ids.length !== 7)
      throw new Error('fork message count changed: ' + ids.length + ' -> ' + ids.join(','));
    const deepMissing = ['follow B', 'ans B', 'follow B retry', 'ans B2'].filter((c) => !forkMsgs.some((m) => m.content === c));
    if (deepMissing.length !== 0)
      throw new Error('fork still drops deep branches: missing=' + JSON.stringify(deepMissing) + ' ids=' + JSON.stringify(ids));
    // The visible symptom: switching branch in the fork walks INTO the a1b
    // subtree (path u1 -> a1b -> u2b2 -> a2b2, 4 messages) instead of landing
    // on a dead a1b leaf with no continuation.
    await cdp.click('#chat-messages .msg .msg-action-btn[title="Next branch"]');
    await cdp.waitFor('chatMessages.length === 4 && chatMessages[1] && chatMessages[1].siblingInfo && chatMessages[1].siblingInfo.total === 2', 15000, 300, 'fork switched into the a1b subtree');
    const forkThread = seed.query(dbPath, 'SELECT active_leaf_id FROM chat_threads WHERE id = ?', [newId])[0];
    const a1bFork = seed.query(dbPath, "SELECT id FROM messages WHERE thread_id = ? AND content = 'reply B'", [newId])[0];
    const a1bChildren = seed.query(dbPath, 'SELECT COUNT(*) AS c FROM messages WHERE parent_id = ?', [a1bFork.id])[0].c;
    if (a1bChildren !== 2)
      throw new Error('a1b copy lost its continuations: children=' + a1bChildren);
    if (forkThread.active_leaf_id === a1bFork.id)
      throw new Error('branch switch still lands on the dead a1b leaf');
    const forkCount = forkMsgs.length;
    return 'fork id=' + newId + ' has ' + forkCount + ' messages (' + ids.join(',') +
      ') - deep branches below the off-path sibling a1b are copied; branch switch walks into the subtree (a1b children=' + a1bChildren + ')';
  }
});

scenarios.push({
  id: 114,
  name: 'Hard-deleting a message in a branched tree miscalculates cumulative token counters (rowid order, not tree paths)',
  regression: true, // FIXED bug kept as a regression check (branched-delete recompute must be tree-accurate)
  mode: null,
  settings: {},
  fixtures: {
    threads: [{ id: 't-del-114', title: 'Branch Delete', active_leaf_id: 'm-114-a2',
      cumulative_input_tokens: 550, cumulative_output_tokens: 150, cumulative_cached_tokens: 0, cumulative_cost: 0 }],
    messages: [
      // Branch A (active): u1 -> a1 -> u2 -> a2 (leaf).
      { id: 'm-114-u1', thread_id: 't-del-114', role: 'user', content: 'first', token_count: 100, active_path_tokens: 100 },
      { id: 'm-114-a1', thread_id: 't-del-114', role: 'assistant', content: 'reply A', model: 'deepseek/deepseek-v4-flash', parent_id: 'm-114-u1', token_count: 50, active_path_tokens: 150 },
      { id: 'm-114-u2', thread_id: 't-del-114', role: 'user', content: 'follow A', parent_id: 'm-114-a1', token_count: 100, active_path_tokens: 250 },
      { id: 'm-114-a2', thread_id: 't-del-114', role: 'assistant', content: 'ans A', model: 'deepseek/deepseek-v4-flash', parent_id: 'm-114-u2', token_count: 50, active_path_tokens: 300 },
      // Branch B (off-path): u2b -> a2b (a retry sibling of u2).
      { id: 'm-114-u2b', thread_id: 't-del-114', role: 'user', content: 'follow B', parent_id: 'm-114-a1', token_count: 100, active_path_tokens: 250 },
      { id: 'm-114-a2b', thread_id: 't-del-114', role: 'assistant', content: 'ans B', model: 'deepseek/deepseek-v4-flash', parent_id: 'm-114-u2b', token_count: 50, active_path_tokens: 300 }
    ]
  },
  async body({ cdp, dbPath }) {
    await showChat();
    await cdp.waitFor('document.querySelectorAll("#thread-list .chat-item").length > 0', 15000, 300, 'thread list');
    await cdp.click('#thread-list .chat-item');
    await cdp.waitFor('document.querySelectorAll("#chat-messages .msg").length >= 4', 15000, 300, 'thread loaded');
    await sleep(700);
    // Delete the ACTIVE leaf assistant (a2). It is not on branch B's path.
    await cdp.click('#chat-messages .msg:nth-child(4) .msg-action-btn[title="Delete"]');
    await sleep(300);
    await cdp.waitFor('document.getElementById("customConfirmOverlay") !== null', 5000, 200, 'confirm');
    await cdp.click('#customConfirmOverlay .yes-confirm-btn');
    await sleep(900);

    const thread = seed.query(dbPath, 'SELECT cumulative_input_tokens, cumulative_output_tokens, active_leaf_id FROM chat_threads WHERE id = ?', ['t-del-114'])[0];
    // FIXED (bug #114): _RecomputeCumulativeCounters is tree-accurate - it uses
    // each assistant's prompt ground truth (or its parent's active_path_tokens)
    // instead of a rowid-order running sum. After deleting a2 the remaining API
    // calls are a1 (prompt = u1's 100) and a2b (prompt = u1 100 + a1 50 + u2b
    // 100 = 250) -> 350 input tokens, NOT the buggy 450 (u2's tokens charged to
    // branch B).
    if (Number(thread.cumulative_input_tokens) !== 350)
      throw new Error('cumulative input after branched delete = ' + thread.cumulative_input_tokens + ' (expected the tree-accurate 350)');
    const bar = await cdp.eval('document.getElementById("tokenBar").textContent');
    if (String(bar).indexOf('\u2191 350') < 0)
      throw new Error('header input tokens do not show the corrected 350: ' + JSON.stringify(bar));
    return 'deleted leaf a2 from a branched tree: cumulative_input_tokens=' + thread.cumulative_input_tokens +
      ' (tree-accurate 350; the buggy rowid-order recompute charged 450) and the header shows the corrected total';
  }
});

scenarios.push({
  id: 124,
  name: 'Conversation tree modal says "Viewing active path" but counts every node in the tree (off-path branches included)',
  regression: true, // FIXED bug kept as a regression check (subtitle must count the active path, not the whole tree)
  mode: null,
  settings: {},
  fixtures: {
    threads: [{ id: 't-tree-124', title: 'Tree Count', active_leaf_id: 'm-124-a1' }],
    messages: [
      // Active path: u1 -> a1 (2 messages).
      { id: 'm-124-u1', thread_id: 't-tree-124', role: 'user', content: 'root', token_count: 10, active_path_tokens: 10 },
      { id: 'm-124-a1', thread_id: 't-tree-124', role: 'assistant', content: 'reply A', model: 'deepseek/deepseek-v4-flash', parent_id: 'm-124-u1', sibling_group: 'sg-124', sibling_index: 0, token_count: 20, active_path_tokens: 30 },
      // Off-path branch: a1b -> u2b -> a2b (3 more nodes, NOT on the active path).
      { id: 'm-124-a1b', thread_id: 't-tree-124', role: 'assistant', content: 'reply B', model: 'deepseek/deepseek-v4-flash', parent_id: 'm-124-u1', sibling_group: 'sg-124', sibling_index: 1, token_count: 20, active_path_tokens: 30 },
      { id: 'm-124-u2b', thread_id: 't-tree-124', role: 'user', content: 'follow B', parent_id: 'm-124-a1b', token_count: 5, active_path_tokens: 35 },
      { id: 'm-124-a2b', thread_id: 't-tree-124', role: 'assistant', content: 'ans B', model: 'deepseek/deepseek-v4-flash', parent_id: 'm-124-u2b', token_count: 30, active_path_tokens: 65 }
    ]
  },
  async body({ cdp }) {
    await showChat();
    await cdp.waitFor('document.querySelectorAll("#thread-list .chat-item").length > 0', 15000, 300, 'thread list');
    await cdp.click('#thread-list .chat-item');
    await cdp.waitFor('document.querySelectorAll("#chat-messages .msg").length >= 2', 15000, 300, 'thread loaded');
    await sleep(600);
    await cdp.click('#treeBtn');
    await cdp.waitFor('document.getElementById("treeOverlay").classList.contains("open") && document.querySelector(".tree-modal-sub") && document.querySelector(".tree-modal-sub").textContent.indexOf("Viewing active path") === 0 && document.querySelector(".tree-modal-sub").textContent.indexOf("2 node") >= 0', 15000, 300, 'tree modal active-path count');
    const label = await cdp.text('.tree-modal-sub');
    // FIXED (bug #124): renderChatTree counts only the ACTIVE PATH nodes - the
    // active path here has 2 messages, so the label says 2 even though the
    // whole tree has 5 nodes (off-path branches no longer inflate it).
    if (!String(label).includes('2 node'))
      throw new Error('tree label does not show the active-path count: ' + JSON.stringify(label));
    if (String(label).includes('5 node'))
      throw new Error('tree label still counts the whole tree (bug #124 not fixed): ' + JSON.stringify(label));
    return 'tree modal label: ' + JSON.stringify(label) + ' - counts the 2 active-path nodes, not all 5 tree nodes';
  }
});

scenarios.push({
  id: 125,
  name: 'Branch position labels (x/y) go stale after deleting a sibling - they use the raw sibling_index, not the position among remaining branches',
  regression: true, // FIXED bug kept as a regression check (labels are positions among remaining siblings)
  mode: null,
  settings: {},
  fixtures: {
    threads: [{ id: 't-label-125', title: 'Branch Labels', active_leaf_id: 'm-125-a1c' }],
    messages: [
      { id: 'm-125-u1', thread_id: 't-label-125', role: 'user', content: 'root', token_count: 10, active_path_tokens: 10 },
      // Three retry branches of the same question (sibling group with indexes 0,1,2).
      { id: 'm-125-a1', thread_id: 't-label-125', role: 'assistant', content: 'answer A', model: 'deepseek/deepseek-v4-flash', parent_id: 'm-125-u1', sibling_group: 'sg-125', sibling_index: 0, token_count: 20, active_path_tokens: 30 },
      { id: 'm-125-a1b', thread_id: 't-label-125', role: 'assistant', content: 'answer B', model: 'deepseek/deepseek-v4-flash', parent_id: 'm-125-u1', sibling_group: 'sg-125', sibling_index: 1, token_count: 20, active_path_tokens: 30 },
      { id: 'm-125-a1c', thread_id: 't-label-125', role: 'assistant', content: 'answer C', model: 'deepseek/deepseek-v4-flash', parent_id: 'm-125-u1', sibling_group: 'sg-125', sibling_index: 2, token_count: 20, active_path_tokens: 30 }
    ]
  },
  async body({ cdp, dbPath }) {
    await showChat();
    await cdp.waitFor('document.querySelectorAll("#thread-list .chat-item").length > 0', 15000, 300, 'thread list');
    await cdp.click('#thread-list .chat-item');
    await cdp.waitFor('document.querySelectorAll("#chat-messages .msg").length >= 2', 15000, 300, 'thread loaded');
    await sleep(700);
    // Sanity: the third branch (leaf) correctly shows 3/3 before any delete.
    const labelBefore = await cdp.text('#chat-messages .msg:nth-child(2) .branch-label-inline');
    if (labelBefore !== '3/3')
      throw new Error('expected 3/3 before delete, got ' + JSON.stringify(labelBefore));
    // Switch back to the FIRST branch (a1, index 0).
    await cdp.click('#chat-messages .msg:nth-child(2) .msg-action-btn[title="Previous branch"]');
    await cdp.waitFor('chatMessages.length === 2 && chatMessages[1] && chatMessages[1].content === "answer B"', 15000, 300, 'switched to branch B');
    await cdp.click('#chat-messages .msg:nth-child(2) .msg-action-btn[title="Previous branch"]');
    await cdp.waitFor('chatMessages.length === 2 && chatMessages[1] && chatMessages[1].content === "answer A"', 15000, 300, 'switched to branch A');
    await sleep(400);
    const labelA = await cdp.text('#chat-messages .msg:nth-child(2) .branch-label-inline');
    if (labelA !== '1/3')
      throw new Error('expected 1/3 on branch A, got ' + JSON.stringify(labelA));
    // Delete the FIRST branch (index 0). The remaining siblings still carry
    // their original sibling_index 1 and 2.
    await cdp.click('#chat-messages .msg:nth-child(2) .msg-action-btn[title="Delete"]');
    await sleep(300);
    await cdp.waitFor('document.getElementById("customConfirmOverlay") !== null', 5000, 200, 'confirm');
    await cdp.click('#customConfirmOverlay .yes-confirm-btn');
    await cdp.waitFor('chatMessages.length === 1', 15000, 300, 'thread emptied to user message');
    await sleep(400);
    // Navigate to branch B through the tree modal.
    await cdp.click('#treeBtn');
    await cdp.waitFor('document.getElementById("treeOverlay").classList.contains("open")', 15000, 300, 'tree open');
    await cdp.waitFor('document.querySelectorAll(".tree-node").length >= 3', 20000, 300, 'tree nodes rendered');
    const targets = await cdp.eval('[].map.call(document.querySelectorAll(".tree-node"), function(n){ return n.getAttribute("data-target"); }).join(",")');
    if (String(targets).indexOf('m-125-a1b') < 0)
      throw new Error('branch B node missing from tree; targets=' + targets);
    await cdp.click('.tree-node[data-target="m-125-a1b"]');
    await cdp.waitFor('chatMessages.length === 2 && chatMessages[1] && chatMessages[1].content === "answer B"', 15000, 300, 'navigated to branch B');
    await sleep(500);
    const labelB = await cdp.text('#chat-messages .msg:nth-child(2) .branch-label-inline');
    // FIXED (bug #125): buildStructuredMessagesFromPath labels the message by
    // its POSITION among the remaining siblings - B is now the first of 2.
    if (labelB !== '1/2')
      throw new Error('branch B label after deleting branch A = ' + JSON.stringify(labelB) + ' (expected 1/2)');
    // Branch C is now the second of 2.
    await cdp.click('#treeBtn');
    await cdp.waitFor('document.getElementById("treeOverlay").classList.contains("open")', 15000, 300, 'tree open again');
    await cdp.click('.tree-node[data-target="m-125-a1c"]');
    await cdp.waitFor('chatMessages.length === 2 && chatMessages[1] && chatMessages[1].content === "answer C"', 15000, 300, 'navigated to branch C');
    await sleep(500);
    const labelC = await cdp.text('#chat-messages .msg:nth-child(2) .branch-label-inline');
    if (labelC !== '2/2')
      throw new Error('branch C label after deleting branch A = ' + JSON.stringify(labelC) + ' (expected 2/2)');
    return 'labels before delete: A=' + labelA + ', C=' + labelBefore + '; after deleting A: B=' + labelB + ' (1/2), C=' + labelC + ' (2/2)';
  }
});

scenarios.push({
  id: 126,
  name: 'Forking mid-conversation copies the source thread\'s FULL cumulative token/cost counters even though the fork only contains the prefix',
  regression: true, // FIXED bug kept as a regression check (fork counters reflect only the prefix's API calls)
  mode: null,
  settings: {},
  fixtures: {
    threads: [{
      id: 't-fork-126', title: 'Fork Counters', active_leaf_id: 'm-126-a2',
      cumulative_input_tokens: 25, cumulative_output_tokens: 50,
      cumulative_cached_tokens: 0, cumulative_cost: 0
    }],
    messages: [
      // Call 1: u1 -> a1 (input 10, output 20). Call 2: u2 -> a2 (input 15, output 30).
      { id: 'm-126-u1', thread_id: 't-fork-126', role: 'user', content: 'root', token_count: 10, active_path_tokens: 10 },
      { id: 'm-126-a1', thread_id: 't-fork-126', role: 'assistant', content: 'answer one', model: 'deepseek/deepseek-v4-flash', parent_id: 'm-126-u1', token_count: 20, active_path_tokens: 30 },
      { id: 'm-126-u2', thread_id: 't-fork-126', role: 'user', content: 'follow up', parent_id: 'm-126-a1', token_count: 5, active_path_tokens: 35 },
      { id: 'm-126-a2', thread_id: 't-fork-126', role: 'assistant', content: 'answer two', model: 'deepseek/deepseek-v4-flash', parent_id: 'm-126-u2', token_count: 30, active_path_tokens: 65 }
    ]
  },
  async body({ cdp, dbPath }) {
    await showChat();
    await cdp.waitFor('document.querySelectorAll("#thread-list .chat-item").length > 0', 15000, 300, 'thread list');
    await cdp.click('#thread-list .chat-item');
    await cdp.waitFor('document.querySelectorAll("#chat-messages .msg").length >= 4', 15000, 300, 'thread loaded');
    await sleep(700);
    // Fork at a1 (the second message): the fork contains ONLY u1 + a1, whose
    // single API call consumed 10 input / 20 output tokens.
    await cdp.click('#chat-messages .msg:nth-child(2) .msg-action-btn[title="Fork"]');
    await cdp.waitFor('window.activeThreadId !== "t-fork-126"', 15000, 300, 'fork created');
    const newId = await cdp.eval('window.activeThreadId');
    await sleep(900);
    const forkMsgs = seed.query(dbPath, 'SELECT COUNT(*) AS c FROM messages WHERE thread_id = ?', [newId])[0].c;
    if (forkMsgs !== 2)
      throw new Error('fork should contain exactly 2 messages, has ' + forkMsgs);
    const forkThread = seed.query(dbPath, 'SELECT cumulative_input_tokens, cumulative_output_tokens FROM chat_threads WHERE id = ?', [newId])[0];
    // FIXED (bug #126): ForkThread recomputes the fork's counters from its own
    // messages - the fork contains only u1 + a1, whose single API call consumed
    // 10 input / 20 output tokens (NOT the source's full 25/50).
    if (Number(forkThread.cumulative_input_tokens) !== 10 || Number(forkThread.cumulative_output_tokens) !== 20)
      throw new Error('fork counters = ' + JSON.stringify(forkThread) + ' (expected the fork\'s own 10/20, not the copied 25/50)');
    const bar = await cdp.text('#tokenBar .tu-item:nth-child(2) .tu-val');
    if (String(bar).indexOf('\u2191 10') < 0 || String(bar).indexOf('\u2193 20') < 0)
      throw new Error('fork header does not show the fork\'s own totals: ' + JSON.stringify(bar));
    return 'fork id=' + newId + ' has ' + forkMsgs + ' messages with recomputed counters ' +
      JSON.stringify(forkThread) + ' (its own calls: 10 input / 20 output); header shows ' + JSON.stringify(bar);
  }
});

scenarios.push({
  id: 128,
  name: 'Hard-deleting a message inflates the thread\'s cumulative OUTPUT tokens (user messages\' backfilled input token_count is counted as output)',
  regression: true, // FIXED bug kept as a regression check (user input token_counts never count as output)
  mode: null,
  settings: {},
  fixtures: {
    threads: [{ id: 't-out-128', title: 'Output Inflation', active_leaf_id: 'm-128-a2',
      cumulative_input_tokens: 800, cumulative_output_tokens: 150, cumulative_cached_tokens: 0, cumulative_cost: 0 }],
    messages: [
      // Branch A (active): u1 -> a1 -> u2 -> a2 (leaf). Off-path branch B: u2b -> a2b.
      // token_count on users = backfilled input contribution; on assistants = visible output.
      { id: 'm-128-u1', thread_id: 't-out-128', role: 'user', content: 'first', token_count: 100, active_path_tokens: 100 },
      { id: 'm-128-a1', thread_id: 't-out-128', role: 'assistant', content: 'reply A', model: 'deepseek/deepseek-v4-flash', parent_id: 'm-128-u1', token_count: 50, active_path_tokens: 150 },
      { id: 'm-128-u2', thread_id: 't-out-128', role: 'user', content: 'follow A', parent_id: 'm-128-a1', token_count: 100, active_path_tokens: 250 },
      { id: 'm-128-a2', thread_id: 't-out-128', role: 'assistant', content: 'ans A', model: 'deepseek/deepseek-v4-flash', parent_id: 'm-128-u2', token_count: 50, active_path_tokens: 300 },
      { id: 'm-128-u2b', thread_id: 't-out-128', role: 'user', content: 'follow B', parent_id: 'm-128-a1', token_count: 100, active_path_tokens: 250 },
      { id: 'm-128-a2b', thread_id: 't-out-128', role: 'assistant', content: 'ans B', model: 'deepseek/deepseek-v4-flash', parent_id: 'm-128-u2b', token_count: 50, active_path_tokens: 300 }
    ]
  },
  async body({ cdp, dbPath }) {
    await showChat();
    await cdp.waitFor('document.querySelectorAll("#thread-list .chat-item").length > 0', 15000, 300, 'thread list');
    await cdp.click('#thread-list .chat-item');
    await cdp.waitFor('document.querySelectorAll("#chat-messages .msg").length >= 4', 15000, 300, 'thread loaded');
    await sleep(700);
    // Delete the ACTIVE leaf assistant (a2).
    await cdp.click('#chat-messages .msg:nth-child(4) .msg-action-btn[title="Delete"]');
    await sleep(300);
    await cdp.waitFor('document.getElementById("customConfirmOverlay") !== null', 5000, 200, 'confirm');
    await cdp.click('#customConfirmOverlay .yes-confirm-btn');
    await sleep(900);

    const thread = seed.query(dbPath, 'SELECT cumulative_input_tokens, cumulative_output_tokens FROM chat_threads WHERE id = ?', ['t-out-128'])[0];
    // FIXED (bug #128): the recompute counts output ONLY on assistant rows -
    // user token_counts are backfilled INPUT contributions. After deleting a2
    // the remaining API calls produced a1 (50) + a2b (50) = 100 output tokens
    // (the old recompute inflated it to 400 with u1/u2/u2b's input tokens).
    if (Number(thread.cumulative_output_tokens) !== 100)
      throw new Error('cumulative output after delete = ' + thread.cumulative_output_tokens + ' (expected 100)');
    const bar = await cdp.eval('document.getElementById("tokenBar").textContent');
    if (String(bar).indexOf('\u2193 100') < 0)
      throw new Error('header output tokens do not show the corrected 100: ' + JSON.stringify(bar));
    return 'deleted leaf a2: cumulative_output_tokens=' + thread.cumulative_output_tokens +
      ' (tree-accurate 100; user input token_counts no longer count as output) and the header shows the corrected total';
  }
});

scenarios.push({
  id: 129,
  name: 'Empty Trash / deleteThreadForever leaves stale messages_fts rows (thread-level delete skips FTS cleanup, unlike HardDelete)',
  regression: true, // FIXED bug kept as a regression check (thread-level delete must clean the FTS index)
  mode: null,
  settings: {},
  fixtures: {
    threads: [{ id: 't-fts-129', title: 'FTS Delete', active_leaf_id: 'm-129-a1' }],
    messages: [
      { id: 'm-129-u1', thread_id: 't-fts-129', role: 'user', content: 'first', token_count: 10, active_path_tokens: 10 },
      { id: 'm-129-a1', thread_id: 't-fts-129', role: 'assistant', content: 'reply', model: 'deepseek/deepseek-v4-flash', parent_id: 'm-129-u1', token_count: 5, active_path_tokens: 15 }
    ]
  },
  async body({ cdp, dbPath }) {
    await showChat();
    await cdp.waitFor('document.querySelectorAll("#thread-list .chat-item").length > 0', 15000, 300, 'thread list');
    await cdp.click('#thread-list .chat-item');
    await cdp.waitFor('document.querySelectorAll("#chat-messages .msg").length >= 2', 15000, 300, 'thread loaded');
    await sleep(600);
    // Soft-delete the thread from the sidebar, then permanently delete it
    // from the trash ("Delete forever" = ThreadRepo.Delete path).
    await cdp.click('#thread-list .chat-item .chat-action-btn.danger');
    await sleep(300);
    await cdp.waitFor('document.getElementById("customConfirmOverlay") !== null', 5000, 200, 'trash confirm');
    await cdp.click('#customConfirmOverlay .yes-confirm-btn');
    await sleep(900);
    await cdp.waitFor('document.querySelectorAll(".trash-item").length >= 1', 10000, 250, 'trash item appears');
    await cdp.click('.trash-item button.danger');
    await sleep(300);
    await cdp.waitFor('document.getElementById("customConfirmOverlay") !== null', 5000, 200, 'delete forever confirm');
    await cdp.click('#customConfirmOverlay .yes-confirm-btn');
    await sleep(900);

    const msgs = seed.query(dbPath, 'SELECT COUNT(*) AS c FROM messages WHERE thread_id = ?', ['t-fts-129'])[0].c;
    const threads = seed.query(dbPath, 'SELECT COUNT(*) AS c FROM chat_threads WHERE id = ?', ['t-fts-129'])[0].c;
    const ftsRows = seed.query(dbPath, "SELECT COUNT(*) AS c FROM messages_fts WHERE msg_id IN ('m-129-u1','m-129-a1')")[0].c;
    // FIXED (bug #129): ThreadRepo.Delete/PurgeExpired now call FTS_Remove for
    // every deleted message (the same guarantee MessageRepo.HardDelete gives -
    // bug #65), so the FTS index stays in sync with messages in-session.
    if (msgs !== 0 || threads !== 0)
      throw new Error('thread not fully deleted: msgs=' + msgs + ' threads=' + threads);
    if (ftsRows !== 0)
      throw new Error('FTS rows were NOT cleaned (bug #129 not fixed): ftsRows=' + ftsRows);
    return 'thread deleted (messages=' + msgs + ' threads=' + threads + ') and messages_fts holds ' +
      ftsRows + ' row(s) for the deleted messages - FTS index stays in sync';
  }
});

scenarios.push({
  id: 139,
  name: 'Search navigation lands on the newest continuation of an off-path branch and keeps the DB active leaf consistent (audit)',
  regression: true, // audit: FTS search -> navigateToMessage -> _WalkToLeaf must land on the branch leaf
  mode: null,
  settings: {},
  fixtures: {
    threads: [{ id: 't-srch-139', title: 'Search Tree', active_leaf_id: 'm-139-a1' }],
    messages: [
      { id: 'm-139-u1', thread_id: 't-srch-139', role: 'user', content: 'root', token_count: 10, active_path_tokens: 10 },
      { id: 'm-139-a1', thread_id: 't-srch-139', role: 'assistant', content: 'answer A', model: 'deepseek/deepseek-v4-flash', parent_id: 'm-139-u1', sibling_group: 'sg-139', sibling_index: 0, token_count: 20, prompt_tokens: 10, active_path_tokens: 30 },
      { id: 'm-139-a1b', thread_id: 't-srch-139', role: 'assistant', content: 'answer B', model: 'deepseek/deepseek-v4-flash', parent_id: 'm-139-u1', sibling_group: 'sg-139', sibling_index: 1, token_count: 20, prompt_tokens: 10, active_path_tokens: 30 },
      { id: 'm-139-u2b', thread_id: 't-srch-139', role: 'user', content: 'needle in the haystack', parent_id: 'm-139-a1b', token_count: 5, active_path_tokens: 35 },
      { id: 'm-139-a2b', thread_id: 't-srch-139', role: 'assistant', content: 'answer B2', model: 'deepseek/deepseek-v4-flash', parent_id: 'm-139-u2b', token_count: 30, prompt_tokens: 15, active_path_tokens: 45 }
    ]
  },
  async body({ cdp, dbPath }) {
    await showChat();
    await cdp.waitFor('document.querySelectorAll("#thread-list .chat-item").length > 0', 15000, 300, 'thread list');
    await cdp.click('#thread-list .chat-item');
    await cdp.waitFor('chatMessages.length === 2 && chatMessages[1] && chatMessages[1].id === "m-139-a1"', 15000, 300, 'branch A loaded');
    await sleep(700);

    // Type in the GLOBAL search box; the off-path message "needle in the haystack"
    // lives in branch B (u2b) and is indexed by FTS5.
    await cdp.type('.search-wrap:not(.in-panel) .search-input', 'needle');
    await cdp.waitFor('document.querySelectorAll(".search-result-item").length >= 1', 15000, 300, 'search results');
    const preview = await cdp.text('.search-result-item:first-child .search-result-preview');
    if (String(preview).indexOf('needle') < 0)
      throw new Error('search result does not match needle: ' + JSON.stringify(preview));
    await cdp.click('.search-result-item:first-child');

    // Navigation must land on the NEWEST continuation of branch B (a2b) and the
    // DB active leaf must match.
    await cdp.waitFor('chatMessages.length === 4 && chatMessages[3] && chatMessages[3].id === "m-139-a2b"', 15000, 300, 'navigated to branch B leaf');
    await sleep(700);
    const leaf = seed.query(dbPath, 'SELECT active_leaf_id FROM chat_threads WHERE id=?', ['t-srch-139'])[0];
    if (leaf.active_leaf_id !== 'm-139-a2b')
      throw new Error('DB active leaf after search nav wrong: ' + JSON.stringify(leaf));
    const ctx = await cdp.text('#tokenBar .tu-item:first-child .tu-val');
    if (String(ctx).indexOf('65') !== 0)
      throw new Error('header context after search nav wrong: ' + JSON.stringify(ctx));
    return 'searched "needle": result preview=' + JSON.stringify(preview) + ' -> navigated to leaf m-139-a2b ' +
      '(context ' + JSON.stringify(ctx) + '), DB active_leaf=' + leaf.active_leaf_id + ' (consistent)';
  }
});

scenarios.push({
  id: 143,
  name: 'Forking at a message drops OFF-PATH children of the fork point itself (alternative continuations that already exist are not copied)',
  mode: null,
  regression: true,
  settings: {},
  fixtures: {
    threads: [{ id: 't-fork-143', title: 'Fork Offpath Children', active_leaf_id: 'm-143-a2' }],
    messages: [
      { id: 'm-143-u1', thread_id: 't-fork-143', role: 'user', content: 'u1', token_count: 10, active_path_tokens: 10 },
      { id: 'm-143-a1', thread_id: 't-fork-143', role: 'assistant', content: 'a1', model: 'deepseek/deepseek-v4-flash', parent_id: 'm-143-u1', token_count: 20, prompt_tokens: 10, active_path_tokens: 30 },
      // Active continuation of a1:
      { id: 'm-143-u2', thread_id: 't-fork-143', role: 'user', content: 'u2', parent_id: 'm-143-a1', token_count: 5, active_path_tokens: 35 },
      { id: 'm-143-a2', thread_id: 't-fork-143', role: 'assistant', content: 'a2', model: 'deepseek/deepseek-v4-flash', parent_id: 'm-143-u2', token_count: 30, prompt_tokens: 15, active_path_tokens: 45 },
      // OFF-PATH alternative continuation of a1 (already exists in the tree):
      { id: 'm-143-u2b', thread_id: 't-fork-143', role: 'user', content: 'u2b', parent_id: 'm-143-a1', sibling_group: 'sg-143', sibling_index: 1, token_count: 5, active_path_tokens: 35 },
      { id: 'm-143-a2b', thread_id: 't-fork-143', role: 'assistant', content: 'a2b', model: 'deepseek/deepseek-v4-flash', parent_id: 'm-143-u2b', token_count: 30, prompt_tokens: 15, active_path_tokens: 45 }
    ]
  },
  async body({ cdp, dbPath }) {
    await showChat();
    await cdp.waitFor('document.querySelectorAll("#thread-list .chat-item").length > 0', 15000, 300, 'thread list');
    await cdp.click('#thread-list .chat-item');
    await cdp.waitFor('chatMessages.length === 4 && chatMessages[3] && chatMessages[3].id === "m-143-a2"', 15000, 300, 'thread loaded');
    await sleep(700);
    // Fork at a1 (message 2). The fork point a1 has an OFF-PATH child u2b/a2b.
    await cdp.click('#chat-messages .msg:nth-child(2) .msg-action-btn[title="Fork"]');
    await cdp.waitFor('window.activeThreadId !== "t-fork-143"', 15000, 300, 'fork created');
    const forkId = await cdp.eval('window.activeThreadId');
    await sleep(900);
    const forkMsgs = seed.query(dbPath, 'SELECT role, content FROM messages WHERE thread_id = ? ORDER BY created_at', [forkId]);
    const contents = forkMsgs.map((m) => m.role + '/' + m.content).join(',');
    // Fixed: the fork copies the active path up to a1 PLUS the already-existing
    // off-path alternative continuation u2b/a2b (4 messages), exactly like
    // off-path siblings at every other level (bug #113). Only the ACTIVE
    // continuation beyond the fork point is excluded.
    // BUG present: the fork only holds u1+a1; u2b/a2b is silently dropped.
    if (forkMsgs.length !== 4)
      throw new Error('unexpected fork size ' + forkMsgs.length + ': ' + contents);
    if (contents.indexOf('u2b') < 0 || contents.indexOf('a2b') < 0)
      throw new Error('off-path children of the fork point missing from fork: ' + contents);
    if (contents.indexOf('u2/') >= 0 || contents.indexOf('a2/') >= 0)
      throw new Error('active continuation beyond the fork point must NOT be copied: ' + contents);
    const activeLeaf = seed.query(dbPath, 'SELECT active_leaf_id FROM chat_threads WHERE id = ?', [forkId])[0].active_leaf_id;
    return 'fork id=' + forkId + ' contains ' + forkMsgs.length + ' messages (' + contents +
      '); off-path child subtree u2b/a2b IS copied (active leaf ' + activeLeaf + ')';
  }
});

scenarios.push({
  id: 146,
  name: '"Save as Branch" after removing an attachment deletes the attachment from the ORIGINAL message (the source branch loses its attachment too)',
  mode: null,
  regression: true,
  settings: {},
  fixtures: {
    threads: [{ id: 't-att-146', title: 'Branch Attach', active_leaf_id: 'm-146-a1' }],
    messages: [
      { id: 'm-146-u1', thread_id: 't-att-146', role: 'user', content: 'root with attachment', token_count: 10, active_path_tokens: 10 },
      { id: 'm-146-a1', thread_id: 't-att-146', role: 'assistant', content: 'reply', model: 'deepseek/deepseek-v4-flash', parent_id: 'm-146-u1', token_count: 5, prompt_tokens: 10, active_path_tokens: 15 }
    ]
  },
  async body({ cdp, dbPath, dataDir }) {
    const fs = require('node:fs');
    const path = require('node:path');
    const { DatabaseSync } = require('node:sqlite');
    const attDir = path.join(dataDir, 'attachments');
    fs.mkdirSync(attDir, { recursive: true });
    const filePath = 'attachments/branch-146.txt';
    fs.writeFileSync(path.join(dataDir, filePath), 'branch attach content');
    const db = new DatabaseSync(dbPath, { enableForeignKeyConstraints: false });
    db.prepare("INSERT INTO message_attachments (id, message_id, attachment_type, file_path, mime_type, original_filename, file_size, extracted_text) VALUES ('a-146-1','m-146-u1','text_file',?,'text/plain','branch.txt',21,'')").run(filePath);
    db.close();

    await showChat();
    await cdp.waitFor('document.querySelectorAll("#thread-list .chat-item").length > 0', 15000, 300, 'thread list');
    await cdp.click('#thread-list .chat-item');
    await cdp.waitFor('document.querySelectorAll("#chat-messages .msg").length >= 2', 15000, 300, 'thread loaded');
    await sleep(700);
    // Open edit on the user message and remove its attachment (deferred).
    await cdp.click('#chat-messages .msg:nth-child(1) .msg-action-btn[title="Edit"]');
    await cdp.waitFor('document.querySelector("#chat-messages .msg:nth-child(1)").classList.contains("editing")', 5000, 200, 'edit ui open');
    await cdp.click('#chat-messages .msg:nth-child(1) .msg-attachment-delete');
    await sleep(300);
    const hidden = await cdp.eval('(function(){ var w = document.querySelector("#chat-messages .msg:nth-child(1) .msg-attachment-image, #chat-messages .msg:nth-child(1) .msg-attachment-file"); return w ? w.style.display : "none-el"; })()');
    if (String(hidden) !== 'none') throw new Error('attachment did not hide on remove: ' + JSON.stringify(hidden));
    // Save as a NEW BRANCH with the edited text.
    await cdp.type('#chat-messages .msg:nth-child(1) .msg-edit-textarea', 'root without attachment (branch)');
    await cdp.click('#chat-messages .msg:nth-child(1) .save-branch');
    await sleep(1200);

    const srcRows = seed.query(dbPath, "SELECT COUNT(*) AS c FROM message_attachments WHERE message_id='m-146-u1'")[0].c;
    const branch = seed.query(dbPath, "SELECT id FROM messages WHERE content='root without attachment (branch)'");
    const branchRows = branch.length ? seed.query(dbPath, 'SELECT COUNT(*) AS c FROM message_attachments WHERE message_id = ?', [branch[0].id])[0].c : -1;
    // Fixed: the removal applies only to the NEW branch - the ORIGINAL message
    // (which stays in the tree with its original content) keeps its attachment.
    // BUG present: handleEdit ran Attachment_DeleteOne on removedAttachmentIds
    // BEFORE copying, so the original lost its attachment too.
    if (Number(srcRows) !== 1)
      throw new Error('source lost its attachment (BUG present / regression): ' + srcRows);
    if (branchRows !== 0)
      throw new Error('branch should not carry the removed attachment: ' + branchRows);
    return 'after Save-as-Branch with a removed attachment: original message attachment rows=' + srcRows +
      ' (kept - the removal applies only to the branch), branch rows=' + branchRows;
  }
});

scenarios.push({
  id: 147,
  name: 'Retrying an assistant that has no parent (root message, e.g. after deleting the root user message) creates the retry as a CHILD of the original instead of a sibling',
  mode: 'sse-success',
  regression: true,
  settings: {},
  fixtures: {
    threads: [{ id: 't-retry-147', title: 'Root Retry', active_leaf_id: 'm-147-a1' }],
    messages: [
      { id: 'm-147-u1', thread_id: 't-retry-147', role: 'user', content: 'root question', token_count: 10, active_path_tokens: 10 },
      { id: 'm-147-a1', thread_id: 't-retry-147', role: 'assistant', content: 'root answer', model: 'deepseek/deepseek-v4-flash', parent_id: 'm-147-u1', token_count: 9, prompt_tokens: 12, active_path_tokens: 21 }
    ]
  },
  async body({ cdp, dbPath }) {
    await showChat();
    await cdp.waitFor('document.querySelectorAll("#thread-list .chat-item").length > 0', 15000, 300, 'thread list');
    await cdp.click('#thread-list .chat-item');
    await cdp.waitFor('document.querySelectorAll("#chat-messages .msg").length >= 2', 15000, 300, 'thread loaded');
    await sleep(700);
    // Delete the root user message: a1 becomes the thread root (parent NULL).
    await cdp.click('#chat-messages .msg:nth-child(1) .msg-action-btn[title="Delete"]');
    await sleep(300);
    await cdp.waitFor('document.getElementById("customConfirmOverlay") !== null', 5000, 200, 'confirm');
    await cdp.click('#customConfirmOverlay .yes-confirm-btn');
    await cdp.waitFor('chatMessages.length === 1 && chatMessages[0] && chatMessages[0].role === "assistant"', 15000, 300, 'root assistant remains');
    await sleep(700);
    // Retry the now-root assistant.
    await cdp.click('#chat-messages .msg:nth-child(1) .msg-action-btn[title="Retry"]');
    await waitStreamingIdle(cdp, 40000);
    await sleep(1200);

    const newRow = seed.query(dbPath, "SELECT parent_id, sibling_group FROM messages WHERE content='Hello from the mock LLM. This is the streamed answer.'");
    if (!newRow.length) throw new Error('retried response not found');
    const isChild = newRow[0].parent_id === 'm-147-a1';
    const sibCount = newRow[0].sibling_group ? seed.query(dbPath, 'SELECT COUNT(*) AS c FROM messages WHERE sibling_group = ?', [newRow[0].sibling_group])[0].c : 0;
    // Fixed: retrying a root assistant clears the leaf so the new response is
    // inserted with parent_id NULL - a proper SIBLING of the original root.
    // BUG present: with no parent the response was inserted with parent_id =
    // the original assistant while sharing its sibling_group (simultaneously a
    // "sibling" and a CHILD of the original).
    if (isChild)
      throw new Error('retry still became a child of the original (BUG present): ' + JSON.stringify(newRow[0]));
    if (newRow[0].parent_id !== null && newRow[0].parent_id !== '')
      throw new Error('root retry should have no parent, got ' + JSON.stringify(newRow[0]));
    if (sibCount !== 2)
      throw new Error('expected 2 messages in the retry sibling group: ' + sibCount);
    return 'retried root assistant: new response parent_id=' + newRow[0].parent_id +
      ' (NULL - proper root sibling, not a child of a1) sibling group count=' + sibCount;
  }
});

scenarios.push({
  id: 148,
  name: 'Navigating to a message with multiple retry continuations lands on the ORIGINAL (oldest) continuation, not the most recent retry',
  mode: null,
  regression: true,
  settings: {},
  fixtures: {
    threads: [{ id: 't-nav-148', title: 'Nav Leaf', active_leaf_id: 'm-148-a2b' }],
    messages: [
      { id: 'm-148-u1', thread_id: 't-nav-148', role: 'user', content: 'root', token_count: 10, active_path_tokens: 10 },
      { id: 'm-148-a1', thread_id: 't-nav-148', role: 'assistant', content: 'answer root', model: 'deepseek/deepseek-v4-flash', parent_id: 'm-148-u1', token_count: 20, prompt_tokens: 10, active_path_tokens: 30 },
      { id: 'm-148-u2', thread_id: 't-nav-148', role: 'user', content: 'needle with retries', parent_id: 'm-148-a1', token_count: 5, active_path_tokens: 35 },
      // Original answer (sibling_index 0) and a RETRY (sibling_index 1) - the
      // retry is the active/newest continuation (scenario 125 semantics).
      { id: 'm-148-a2', thread_id: 't-nav-148', role: 'assistant', content: 'original answer', model: 'deepseek/deepseek-v4-flash', parent_id: 'm-148-u2', sibling_group: 'sg-148', sibling_index: 0, token_count: 30, prompt_tokens: 15, active_path_tokens: 45 },
      { id: 'm-148-a2b', thread_id: 't-nav-148', role: 'assistant', content: 'retried answer (newest)', model: 'deepseek/deepseek-v4-flash', parent_id: 'm-148-u2', sibling_group: 'sg-148', sibling_index: 1, token_count: 30, prompt_tokens: 15, active_path_tokens: 45 }
    ]
  },
  async body({ cdp, dbPath }) {
    await showChat();
    await cdp.waitFor('document.querySelectorAll("#thread-list .chat-item").length > 0', 15000, 300, 'thread list');
    await cdp.click('#thread-list .chat-item');
    await cdp.waitFor('chatMessages.length === 4 && chatMessages[3] && chatMessages[3].id === "m-148-a2b"', 15000, 300, 'thread loaded on the retry leaf');
    await sleep(700);
    // Open the tree modal and click the USER message node (u2) - navigation
    // should land on the NEWEST continuation (a2b, the active retry).
    await cdp.click('#treeBtn');
    await cdp.waitFor('document.getElementById("treeOverlay").classList.contains("open") && document.querySelectorAll(".tree-node").length >= 4', 15000, 300, 'tree open');
    await cdp.eval('(() => { const n = [...document.querySelectorAll(".tree-node")].find((el) => el.textContent.indexOf("needle with retries") >= 0); if (!n) return false; n.click(); return true; })()');
    await cdp.waitFor('document.getElementById("treeOverlay").classList.contains("open") === false', 15000, 300, 'tree closed');
    await sleep(900);
    const lastId = await cdp.eval('chatMessages.length ? chatMessages[chatMessages.length - 1].id : ""');
    const leaf = seed.query(dbPath, 'SELECT active_leaf_id FROM chat_threads WHERE id = ?', ['t-nav-148'])[0].active_leaf_id;
    // Fixed: both _WalkToLeaf and _findDefaultLeaf pick the NEWEST
    // continuation (highest sibling_index = the active retry a2b).
    // BUG present: _findDefaultLeaf picked the LAST child of the DESC-sorted
    // children array (= min sibling_index = the ORIGINAL) and _WalkToLeaf
    // ORDER BY sibling_index ASC agreed, landing on a2 (index 0).
    if (lastId !== 'm-148-a2b' || leaf !== 'm-148-a2b')
      throw new Error('navigation did not land on the newest retry (BUG present?): lastId=' + lastId + ' leaf=' + leaf);
    return 'tree-click on u2 navigated to ' + lastId + ' (DB leaf ' + leaf +
      ') - the newest retry m-148-a2b';
  }
});

scenarios.push({
  id: 150,
  name: '"Save as Branch" on a USER message keeps the ORIGINAL message\'s token attribution forever (the branch copy is never re-backfilled, so its token popover is stale/wrong)',
  mode: 'sse-success',
  regression: true,
  settings: {},
  fixtures: {
    threads: [{
      id: 't-bruser-150', title: 'Branch User Tokens', active_leaf_id: 'm-150-a2',
      cumulative_input_tokens: 40, cumulative_output_tokens: 15
    }],
    messages: [
      { id: 'm-150-u1', thread_id: 't-bruser-150', role: 'user', content: 'root', token_count: 12, active_path_tokens: 12 },
      { id: 'm-150-a1', thread_id: 't-bruser-150', role: 'assistant', content: 'answer one', model: 'deepseek/deepseek-v4-flash', parent_id: 'm-150-u1', token_count: 9, prompt_tokens: 12, active_path_tokens: 21 },
      // u2's token_count 7 was BACKFILLED from a real prompt of 28 (12+9+7).
      { id: 'm-150-u2', thread_id: 't-bruser-150', role: 'user', content: 'original follow-up', parent_id: 'm-150-a1', token_count: 7, active_path_tokens: 28 },
      { id: 'm-150-a2', thread_id: 't-bruser-150', role: 'assistant', content: 'answer two', model: 'deepseek/deepseek-v4-flash', parent_id: 'm-150-u2', token_count: 6, prompt_tokens: 28, active_path_tokens: 34 }
    ]
  },
  async body({ cdp, dbPath }) {
    await showChat();
    await cdp.waitFor('document.querySelectorAll("#thread-list .chat-item").length > 0', 15000, 300, 'thread list');
    await cdp.click('#thread-list .chat-item');
    await cdp.waitFor('chatMessages.length === 4 && chatMessages[3] && chatMessages[3].id === "m-150-a2"', 15000, 300, 'thread loaded');
    await sleep(700);
    // Edit the USER message (index 3) and save it as a NEW BRANCH with
    // different text. handleEdit copies u2's token_count (7) into the branch
    // copy and fires a REAL request; the response's backfill skips the copy
    // because its token_count is already non-zero.
    await cdp.click('#chat-messages .msg:nth-child(3) .msg-action-btn[title="Edit"]');
    await cdp.waitFor('document.querySelector("#chat-messages .msg:nth-child(3)").classList.contains("editing")', 5000, 200, 'edit ui open');
    await cdp.type('#chat-messages .msg:nth-child(3) .msg-edit-textarea', 'edited follow-up (branch)');
    await cdp.click('#chat-messages .msg:nth-child(3) .save-branch');
    await waitStreamingIdle(cdp, 40000);
    await sleep(1200);

    const branch = seed.query(dbPath, "SELECT id, token_count, active_path_tokens FROM messages WHERE content='edited follow-up (branch)'");
    if (!branch.length) throw new Error('branch user message not found');
    const bc = Number(branch[0].token_count);
    // Fixed: the branch copy is a local_copy, so the branch's own API call
    // (mock prompt 12) RE-backfills it: Max(0, 12 - (12+9+7)) = 0 - the stale
    // copied 7 is replaced with the branch's real contribution.
    // BUG present: the copied 7 was never overwritten (bc === 7 forever).
    if (bc !== 0) throw new Error('branch user attribution still stale (BUG present): token_count=' + bc);
    const pop = await (async () => {
      const idx = await cdp.eval('chatMessages.findIndex((m) => m.content === "edited follow-up (branch)")');
      if (idx < 0) return '';
      await cdp.click('#chat-messages .msg:nth-child(' + (idx + 1) + ') .stat-btn');
      await cdp.waitFor('document.querySelector(".stat-toggle.pop-open") !== null', 5000, 200, 'popover open');
      return await cdp.text('.stat-toggle.pop-open .stat-popover');
    })();
    if (String(pop).indexOf('Input: 0 tokens') < 0)
      throw new Error('branch user popover should show the re-backfilled 0: ' + JSON.stringify(pop));
    return 'branch-copied user message keeps token_count=' + bc +
      ' (re-backfilled by the branch\'s own API call) and its popover shows ' + JSON.stringify(pop) +
      ' - the stale source attribution is replaced';
  }
});

scenarios.push({
  id: 154,
  name: '"Save as Branch" on an assistant message drops the reasoning/thinking CONTENT (the branch copy keeps thinking_tokens but the DB reasoning column is empty - no Thought Process block)',
  mode: null,
  regression: true,
  settings: {},
  fixtures: {
    threads: [{
      id: 't-reason-154', title: 'Branch Reasoning Loss', active_leaf_id: 'm-154-a1',
      cumulative_input_tokens: 12, cumulative_output_tokens: 14
    }],
    messages: [
      { id: 'm-154-u1', thread_id: 't-reason-154', role: 'user', content: 'root', token_count: 12, active_path_tokens: 12 },
      { id: 'm-154-a1', thread_id: 't-reason-154', role: 'assistant', content: 'answer one', model: 'deepseek/deepseek-v4-flash', parent_id: 'm-154-u1', token_count: 9, prompt_tokens: 12, thinking_tokens: 5, reasoning: 'SECRET THINKING STEP ONE\nSECRET THINKING STEP TWO', active_path_tokens: 26 }
    ]
  },
  async body({ cdp, dbPath }) {
    await showChat();
    await cdp.waitFor('document.querySelectorAll("#thread-list .chat-item").length > 0', 15000, 300, 'thread list');
    await cdp.click('#thread-list .chat-item');
    await cdp.waitFor('chatMessages.length === 2 && chatMessages[1] && chatMessages[1].id === "m-154-a1"', 15000, 300, 'thread loaded');
    await sleep(700);
    // The source assistant bubble shows the thinking block.
    const srcHasThinking = await cdp.eval('document.querySelectorAll("#chat-messages .msg .thinking-block").length');
    if (srcHasThinking !== 1)
      throw new Error('setup: source assistant should show a thinking block, got ' + srcHasThinking);
    // Edit the assistant and save as a NEW BRANCH (local copy).
    await cdp.click('#chat-messages .msg:nth-child(2) .msg-action-btn[title="Edit"]');
    await cdp.waitFor('document.querySelector("#chat-messages .msg:nth-child(2)").classList.contains("editing")', 5000, 200, 'edit ui open');
    await cdp.type('#chat-messages .msg:nth-child(2) .msg-edit-textarea', 'answer one (branch)');
    await cdp.click('#chat-messages .msg:nth-child(2) .save-branch');
    await cdp.waitFor('chatMessages.length === 2 && chatMessages[1] && chatMessages[1].content === "answer one (branch)"', 15000, 300, 'branch message created');
    await sleep(700);

    const branch = seed.query(dbPath, "SELECT reasoning, thinking_tokens, token_count FROM messages WHERE content='answer one (branch)'");
    if (!branch.length) throw new Error('branch message not found');
    const reasoning = String(branch[0].reasoning || '');
    const thinking = Number(branch[0].thinking_tokens);
    // Fixed: the branch insert carries the source's reasoning, so the Thought
    // Process block and the thinking tokens stay together.
    // BUG present: handleEdit's branch insert copied token metadata (bug #123)
    // but omitted the reasoning field, losing the thinking CONTENT while
    // keeping the thinking token count.
    if (reasoning !== 'SECRET THINKING STEP ONE\nSECRET THINKING STEP TWO')
      throw new Error('branch copy lost the source reasoning (BUG present): ' + JSON.stringify(reasoning));
    if (thinking !== 5)
      throw new Error('branch copy should keep thinking_tokens=5, got ' + thinking);
    const branchHasThinking = await cdp.eval('document.querySelectorAll("#chat-messages .msg .thinking-block").length');
    if (branchHasThinking !== 1)
      throw new Error('branch bubble should show the copied Thought Process block: ' + branchHasThinking);
    return 'assistant branch-edit copy: DB reasoning="' + reasoning + '" (kept) with thinking_tokens=' + thinking +
      ' - the branch bubble shows the Thought Process block (src=1, branch=1)';
  }
});

scenarios.push({
  id: 155,
  name: 'Sidebar thread model badge is stale after a branch switch (ThreadRepo.List shows the LAST-INSERTED assistant model, not the ACTIVE path\'s model)',
  mode: null,
  regression: true,
  noApp: true,
  settings: {},
  async body() {
    const os = require('node:os');
    const outFile = path.join(os.tmpdir(), 'llm-bughunt-db-' + process.pid + '.txt');
    try { fs.unlinkSync(outFile); } catch {}
    const probe = path.join(__dirname, '..', 'probe-bughunt-db.ahk');
    const res = spawnSync(launcher.AHK, ['/ErrorStdOut', probe, outFile, 'thread-list-model-stale'], { timeout: 25000, windowsHide: true, encoding: 'utf8' });
    if (res.error) throw new Error('model probe spawn failed/timed out: ' + res.error.message);
    if (res.stderr) process.stderr.write('[probe stderr] ' + res.stderr);
    const text = fs.readFileSync(outFile, 'utf-8');
    const m = text.match(/listedModel=([^\s]+)/);
    if (!m) throw new Error('probe output missing listedModel: ' + text);
    const listed = m[1];
    // Fixed: ThreadRepo.List walks the ACTIVE path, so the badge follows the
    // branch currently open.
    // BUG present: active path used openai/gpt-5-mini but ThreadRepo.List
    // returned the last-inserted assistant (deepseek/deepseek-v4-flash).
    if (listed !== 'openai/gpt-5-mini')
      throw new Error('ThreadRepo.List badge still stale (BUG present): listed=' + listed);
    return 'active path model=openai/gpt-5-mini and ThreadRepo.List badge=' + listed +
      ' (active-path model, not the last-inserted assistant) - sidebar icon/title stays correct after switching branches';
  }
});

scenarios.push({
  id: 159,
  name: 'Switching threads while a request is streaming persists the response into the WRONG thread (_persistStreamResponse reads activeThreadId at completion time, not the thread that sent the request)',
  mode: 'sse-success',
  regression: true,
  settings: {},
  fixtures: {
    threads: [
      { id: 't-stream-a-159', title: 'Thread A', active_leaf_id: 'm-159-u1a' },
      { id: 't-stream-b-159', title: 'Thread B', active_leaf_id: 'm-159-u1b' }
    ],
    messages: [
      { id: 'm-159-u1a', thread_id: 't-stream-a-159', role: 'user', content: 'question for A', token_count: 5, active_path_tokens: 5 },
      { id: 'm-159-u1b', thread_id: 't-stream-b-159', role: 'user', content: 'question for B', token_count: 5, active_path_tokens: 5 }
    ]
  },
  async body({ cdp, dbPath }) {
    await showChat();
    await cdp.waitFor('document.querySelectorAll("#thread-list .chat-item").length >= 2', 15000, 300, 'thread list');
    // Load thread A and send a message; while the mock streams (~320ms), click thread B.
    await cdp.eval('window.loadThread("t-stream-a-159"); true');
    await cdp.waitFor('window.activeThreadId === "t-stream-a-159"', 15000, 300, 'thread A loaded');
    await sleep(600);
    await sendChatMessage(cdp, 'question for A');
    await cdp.waitFor('typeof streamState !== "undefined" && streamState.active === true', 20000, 50, 'streaming active');
    await sleep(40);
    await cdp.eval('window.loadThread("t-stream-b-159"); true');
    await cdp.waitFor('window.activeThreadId === "t-stream-b-159"', 10000, 250, 'thread B loaded');
    await waitStreamingIdle(cdp, 30000);
    await sleep(1200);

    const inA = seed.query(dbPath, "SELECT COUNT(*) AS c FROM messages WHERE thread_id='t-stream-a-159' AND role='assistant'")[0].c;
    const inB = seed.query(dbPath, "SELECT COUNT(*) AS c FROM messages WHERE thread_id='t-stream-b-159' AND role='assistant'")[0].c;
    const msgsA = seed.query(dbPath, "SELECT role, content FROM messages WHERE thread_id='t-stream-a-159' ORDER BY rowid");
    const msgsB = seed.query(dbPath, "SELECT role, content FROM messages WHERE thread_id='t-stream-b-159' ORDER BY rowid");
    // Fixed: the completion uses the thread captured at send time, so the
    // response lands in thread A (the sender); thread B stays untouched.
    // BUG present: the streamed assistant landed in thread B (the thread
    // switched to mid-stream) instead of thread A.
    if (inA !== 1 || inB !== 0)
      throw new Error('streamed response did not land in the sending thread (BUG present): inA=' + inA + ' inB=' + inB +
        ' A=' + JSON.stringify(msgsA) + ' B=' + JSON.stringify(msgsB));
    return 'sent in thread A, switched to thread B mid-stream: assistant rows inA=' + inA + ' inB=' + inB +
      ' - the "Hello from the mock LLM" response landed in thread ' + (inB ? 'B (WRONG)' : 'A (the sender - captured at send time)') +
      '; A=' + JSON.stringify(msgsA.map((m) => m.role + ':' + String(m.content).slice(0, 30))) +
      ' B=' + JSON.stringify(msgsB.map((m) => m.role + ':' + String(m.content).slice(0, 30)));
  }
});

scenarios.push({
  id: 169,
  name: 'Retry failure hides the original response - retryLastAssistantMessage splices the retried message out of chatMessages immediately, and a failed retry never restores it (bubble gone + error banner until reload; DB row intact)',
  mode: 'sse-success',
  mockOpts: { failFirstRequests: 1 },
  regression: true,
  settings: {},
  fixtures: {
    threads: [{ id: 't-retry-169', title: 'Retry Fail', active_leaf_id: 'm-169-a1' }],
    messages: [
      { id: 'm-169-u1', thread_id: 't-retry-169', role: 'user', content: 'original question', token_count: 7, active_path_tokens: 7 },
      { id: 'm-169-a1', thread_id: 't-retry-169', role: 'assistant', content: 'original answer that must stay', model: 'deepseek/deepseek-v4-flash', parent_id: 'm-169-u1', token_count: 5, prompt_tokens: 12, active_path_tokens: 19 }
    ]
  },
  async body({ cdp, dbPath }) {
    await showChat();
    await cdp.waitFor('document.querySelectorAll("#thread-list .chat-item").length > 0', 15000, 300, 'thread list');
    await cdp.click('#thread-list .chat-item');
    await cdp.waitFor('chatMessages.length === 2 && chatMessages[1] && chatMessages[1].id === "m-169-a1"', 15000, 300, 'thread loaded');
    await sleep(700);
    // Click Retry on the assistant. The UI immediately removes it from chatMessages.
    await cdp.click('#chat-messages .msg:nth-child(2) .msg-action-btn[title="Retry"]');
    await cdp.waitFor('chatMessages.length === 1 && chatMessages[0].role === "user"', 15000, 300, 'retried message removed from UI');
    // The mock returns a provider error for the retry, then resumes normal
    // streaming for the next exchange.
    await waitStreamingIdle(cdp, 30000);
    await sleep(800);
    const dbRow = seed.query(dbPath, "SELECT COUNT(*) AS c FROM messages WHERE id='m-169-a1'")[0].c;
    const leaf = seed.query(dbPath, "SELECT active_leaf_id FROM chat_threads WHERE id='t-retry-169'")[0].active_leaf_id;
    const domBubbles = await cdp.eval('document.querySelectorAll("#chat-messages .msg").length');
    const errBanner = await cdp.eval('!!document.querySelector(".error-banner") || document.body.innerText.indexOf("Request failed") >= 0');
    // Fixed: the retry-removed messages are restored on the error path, so the
    // original response stays visible (domBubbles=2: user + a1) even though
    // the retry failed and the error banner is shown.
    // BUG present: DB row intact but the UI bubble was gone (domBubbles=1)
    // until reload.
    if (dbRow !== 1 || domBubbles !== 2 || leaf !== 'm-169-a1')
      throw new Error('retry-failure state changed: dbRow=' + dbRow + ' domBubbles=' + domBubbles + ' leaf=' + leaf + ' banner=' + errBanner);
    await sendChatMessage(cdp, 'follow-up after failed retry');
    await waitStreamingIdle(cdp, 40000);
    await sleep(800);
    const u2 = seed.query(dbPath, "SELECT id, parent_id FROM messages WHERE content='follow-up after failed retry'")[0];
    const a2 = seed.query(dbPath, "SELECT id, parent_id FROM messages WHERE thread_id='t-retry-169' AND role='assistant' AND id <> 'm-169-a1' ORDER BY rowid DESC LIMIT 1")[0];
    const finalLeaf = seed.query(dbPath, "SELECT active_leaf_id FROM chat_threads WHERE id='t-retry-169'")[0].active_leaf_id;
    if (!u2 || u2.parent_id !== 'm-169-a1' || !a2 || a2.parent_id !== u2.id || finalLeaf !== a2.id)
      throw new Error('next exchange did not follow restored path: u2=' + JSON.stringify(u2) + ' a2=' + JSON.stringify(a2) + ' leaf=' + finalLeaf);
    await cdp.eval('window.loadThread("t-retry-169"); true');
    await cdp.waitFor('chatMessages.length === 4', 15000, 300, 'reloaded active path');
    return 'failed provider retry restored a1 (DB leaf=' + leaf + ', DOM bubbles=' + domBubbles + '); next exchange attached u2 to a1 and reload showed u1 -> a1 -> u2 -> a2';
  }
});

scenarios.push({
  id: 170,
  name: 'Reasoning-only streams report ttft_ms=0 (the first-token timer only stamps "content" chunks, never "reasoning") - the popover hides TTFT, the dashboard averages 0ms, and the API log latency falls back to the full duration',
  mode: 'sse-reasoning-only',
  regression: true,
  settings: {},
  fixtures: {
    threads: [{ id: 't-ttft-170', title: 'TTFT Reasoning', active_leaf_id: 'm-170-u1' }],
    messages: [{ id: 'm-170-u1', thread_id: 't-ttft-170', role: 'user', content: 'reasoning only please', token_count: 5, active_path_tokens: 5 }]
  },
  async body({ cdp, dbPath, mockLog }) {
    await showChat();
    await cdp.waitFor('document.querySelectorAll("#thread-list .chat-item").length > 0', 15000, 300, 'thread list');
    await cdp.click('#thread-list .chat-item');
    await cdp.waitFor('chatMessages.length === 1', 15000, 300, 'thread loaded');
    await sleep(600);
    await sendChatMessage(cdp, 'reasoning only please');
    await waitStreamingIdle(cdp, 30000);
    await sleep(1200);
    const row = seed.query(dbPath, "SELECT ttft_ms, response_time_ms, thinking_tokens, token_count FROM messages WHERE thread_id='t-ttft-170' AND role='assistant' ORDER BY rowid DESC LIMIT 1")[0];
    const ttft = Number(row.ttft_ms);
    // Fixed: _processChunk stamps firstTokenTime on reasoning chunks too, so
    // the reasoning-only stream records a real TTFT.
    // Bug: _processChunk only set firstTokenTime for "content" chunks, so
    // ttft_ms stayed 0.
    if (ttft <= 0)
      throw new Error('reasoning-only TTFT still 0 (BUG present): ttft_ms=' + ttft + ' response=' + row.response_time_ms);
    if (!fs.existsSync(mockLog)) throw new Error('mock log missing');
    return 'sse-reasoning-only exchange persisted ttft_ms=' + ttft + ' (response_time_ms=' + row.response_time_ms + ', thinking=' + row.thinking_tokens +
      ') - the popover shows TTFT, the dashboard averages a real value, and the API log latency is the first-token latency';
  }
});

scenarios.push({
  id: 171,
  name: 'Cancelling a stream AFTER switching threads writes the partial response into the WRONG thread (_handleStreamCancelled reads the current activeThreadId, same root cause as #159)',
  mode: 'sse-success',
  regression: true,
  settings: {},
  fixtures: {
    threads: [
      { id: 't-cancel-a-171', title: 'Thread A', active_leaf_id: 'm-171-u1a' },
      { id: 't-cancel-b-171', title: 'Thread B', active_leaf_id: 'm-171-u1b' }
    ],
    messages: [
      { id: 'm-171-u1a', thread_id: 't-cancel-a-171', role: 'user', content: 'question for A', token_count: 5, active_path_tokens: 5 },
      { id: 'm-171-u1b', thread_id: 't-cancel-b-171', role: 'user', content: 'question for B', token_count: 5, active_path_tokens: 5 }
    ]
  },
  async body({ cdp, dbPath }) {
    await showChat();
    await cdp.waitFor('document.querySelectorAll("#thread-list .chat-item").length >= 2', 15000, 300, 'thread list');
    await cdp.eval('window.loadThread("t-cancel-a-171"); true');
    await cdp.waitFor('window.activeThreadId === "t-cancel-a-171"', 15000, 300, 'thread A loaded');
    await sleep(600);
    await sendChatMessage(cdp, 'question for A');
    await cdp.waitFor('typeof streamState !== "undefined" && streamState.active === true', 20000, 50, 'streaming active');
    await sleep(40);
    // Switch to thread B while A's stream is in flight.
    await cdp.eval('window.loadThread("t-cancel-b-171"); true');
    await cdp.waitFor('window.activeThreadId === "t-cancel-b-171"', 10000, 250, 'thread B loaded');
    // Cancel while content has streamed (mock: reasoning at 0ms + 60ms, content at 120ms).
    await sleep(90);
    await cdp.eval('window.onStopStreaming(); true');
    await waitStreamingIdle(cdp, 30000);
    await sleep(1200);
    const inA = seed.query(dbPath, "SELECT COUNT(*) AS c FROM messages WHERE thread_id='t-cancel-a-171' AND role='assistant'")[0].c;
    const inB = seed.query(dbPath, "SELECT COUNT(*) AS c FROM messages WHERE thread_id='t-cancel-b-171' AND role='assistant'")[0].c;
    const partial = seed.query(dbPath, "SELECT content FROM messages WHERE thread_id='t-cancel-b-171' AND role='assistant'");
    // Fixed: the cancel handler uses the thread captured at send time, so the
    // partial lands in thread A (the sender); thread B stays untouched.
    // BUG present: the cancelled partial landed in thread B (the current
    // active thread at cancel time).
    if (inA !== 1 || inB !== 0)
      throw new Error('cancel-after-switch partial not in the sending thread (BUG present): inA=' + inA + ' inB=' + inB);
    return 'sent in A, switched to B, cancelled mid-stream: partial assistant rows inA=' + inA + ' inB=' + inB +
      ' (content="' + (partial.length ? String(partial[0].content).slice(0, 40) : '') + '") - _handleStreamCancelled used the captured sending thread (A)';
  }
});

scenarios.push({
  id: 172,
  name: 'Hard-deleting a streaming thread mid-stream never leaves an orphan message and retains historical usage',
  mode: 'sse-slow',
  regression: true,
  settings: {},
  fixtures: {
    threads: [
      { id: 't-hard-a-172', title: 'Thread A', active_leaf_id: 'm-172-u1a' },
      { id: 't-hard-b-172', title: 'Thread B', active_leaf_id: 'm-172-u1b' }
    ],
    messages: [
      { id: 'm-172-u1a', thread_id: 't-hard-a-172', role: 'user', content: 'question for A', token_count: 5, active_path_tokens: 5 },
      { id: 'm-172-u1b', thread_id: 't-hard-b-172', role: 'user', content: 'question for B', token_count: 5, active_path_tokens: 5 }
    ]
  },
  async body({ cdp, dbPath }) {
    await showChat();
    await cdp.waitFor('document.querySelectorAll("#thread-list .chat-item").length >= 2', 15000, 300, 'thread list');
    await cdp.eval('window.loadThread("t-hard-a-172"); true');
    await cdp.waitFor('window.activeThreadId === "t-hard-a-172"', 15000, 300, 'thread A loaded');
    await sleep(600);
    await sendChatMessage(cdp, 'question for A');
    await cdp.waitFor('typeof streamState !== "undefined" && streamState.active === true', 20000, 50, 'streaming active');
    await sleep(40);
    // The slow mock streams for ~2s, so the delete below is guaranteed mid-stream.
    const activeAtStart = await cdp.eval('streamState.active === true');
    // Soft-delete A (goes to trash) - this clears activeThreadId (A was active).
    await cdp.eval(`(() => {
      const items = [...document.querySelectorAll('#thread-list .chat-item')];
      const it = items.find((el) => el.getAttribute('data-chat') === 't-hard-a-172');
      if (!it) return false;
      it.querySelector('.chat-action-btn.danger').click();
      return true;
    })()`);
    await sleep(300);
    await cdp.waitFor('document.getElementById("customConfirmOverlay") !== null', 5000, 200, 'trash confirm');
    await cdp.click('#customConfirmOverlay .yes-confirm-btn');
    await sleep(500);
    // Delete forever from the trash while the stream is still in flight.
    await cdp.waitFor('document.querySelectorAll(".trash-item").length >= 1', 10000, 250, 'trash item');
    await cdp.click('.trash-item button.danger');
    await sleep(300);
    await cdp.waitFor('document.getElementById("customConfirmOverlay") !== null', 5000, 200, 'delete forever confirm');
    const activeAtHardDelete = await cdp.eval('typeof isThreadRequestInFlight === "function" && isThreadRequestInFlight("t-hard-a-172")');
    await cdp.click('#customConfirmOverlay .yes-confirm-btn');
    await waitStreamingIdle(cdp, 30000);
    await sleep(1200);
    // No dangling rows: activeThreadId was cleared, so _persistStreamResponse
    // was skipped entirely (the response is neither persisted nor orphaned).
    const dangling = seed.query(dbPath, 'SELECT COUNT(*) AS c FROM messages WHERE thread_id NOT IN (SELECT id FROM chat_threads)')[0].c;
    const anyAssistant = seed.query(dbPath, "SELECT COUNT(*) AS c FROM messages WHERE role='assistant'")[0].c;
    const usage = seed.query(dbPath, 'SELECT COUNT(*) AS c FROM chat_usage')[0].c;
    // The thread row is gone, so the response cannot be retained as a message;
    // the historical API usage row must still be recorded independently.
    if (!activeAtStart || !activeAtHardDelete) throw new Error('setup: stream finished before the delete - timing not mid-stream (' + activeAtStart + '/' + activeAtHardDelete + ')');
    if (dangling !== 0 || anyAssistant !== 0 || usage !== 1)
      throw new Error('hard-delete completion left an orphan or lost historical usage: dangling=' + dangling + ' assistantRows=' + anyAssistant + ' usage=' + usage);
    return 'hard-delete mid-stream: thread A removed while streaming; completion left no orphan message (dangling=' + dangling +
      ', assistant rows=' + anyAssistant + ') and retained the billed call in chat_usage=' + usage + ' (activeAtStart=' + activeAtStart + ' activeAtHardDelete=' + activeAtHardDelete + ')';
  }
});

scenarios.push({
  id: 173,
  name: 'A mid-stream failure with no usage chunk crashes the completion handler (CostCalculator reads usage.promptTokens unguarded) - the partial response IS persisted but the UI is left STUCK with a misleading "Request failed" banner',
  mode: 'sse-midfail',
  regression: true,
  settings: {},
  fixtures: {
    threads: [{ id: 't-midfail-173', title: 'Mid Fail', active_leaf_id: 'm-173-u1' }],
    messages: [{ id: 'm-173-u1', thread_id: 't-midfail-173', role: 'user', content: 'stream that dies', token_count: 5, active_path_tokens: 5 }]
  },
  async body({ cdp, dbPath }) {
    await showChat();
    await cdp.waitFor('document.querySelectorAll("#thread-list .chat-item").length > 0', 15000, 300, 'thread list');
    await cdp.click('#thread-list .chat-item');
    await cdp.waitFor('chatMessages.length === 1', 15000, 300, 'thread loaded');
    await sleep(600);
    await sendChatMessage(cdp, 'stream that dies');
    // The stream ends after the partial chunk (no usage). With the guard the
    // completion handler persists the partial and returns the UI to a usable,
    // terminal state (streamDone posted -> streamState.active false).
    await waitStreamingIdle(cdp, 20000);
    await sleep(800);
    const rows = seed.query(dbPath, "SELECT content, token_count, prompt_tokens FROM messages WHERE thread_id='t-midfail-173' AND role='assistant'");
    const errBanner = await cdp.eval('document.body.innerText.indexOf("Request failed") >= 0 || !!document.querySelector(".error-banner")');
    const usable = await cdp.eval('isLoading === false && streamState.active === false');
    // Fixed: CostCalculator guards the missing usage fields, so the partial
    // completes cleanly (rows=1) and the UI reaches a terminal, usable state.
    // BUG present: the completion handler crashed after persisting the partial
    // (isLoading=true, streamState.active=true until reload) and showed a
    // misleading "Request failed" banner.
    if (rows.length !== 1 || !usable)
      throw new Error('mid-stream failure handling still broken: rows=' + rows.length + ' usable=' + usable + ' errBanner=' + errBanner);
    return 'mock sent one content chunk then ended with an error body: persisted assistant row content="' + String(rows[0].content).slice(0, 40) +
      '" prompt_tokens=' + rows[0].prompt_tokens + ' (no usage) - the completion handler survives the usage-less stream: ' +
      'UI usable (isLoading=false, streamState.active=false), error banner shown=' + errBanner + ' - the partial is saved and the thread stays usable';
  }
});

scenarios.push({
  id: 174,
  name: 'Branch navigation never refreshes the sidebar thread list - handleBranchSwitch bumps updated_at but posts no threadList, so the sidebar order/model badge stays stale after a branch switch',
  mode: null,
  regression: true,
  settings: {},
  fixtures: {
    threads: [
      { id: 't-order-a-174', title: 'Thread A (newer)', active_leaf_id: 'm-174-a1a', updated_at: '2026-08-10 12:00:00' },
      { id: 't-order-b-174', title: 'Thread B (older)', active_leaf_id: 'm-174-a1b2', updated_at: '2026-08-09 12:00:00' }
    ],
    messages: [
      { id: 'm-174-u1a', thread_id: 't-order-a-174', role: 'user', content: 'u1a', token_count: 5, active_path_tokens: 5 },
      { id: 'm-174-a1a', thread_id: 't-order-a-174', role: 'assistant', content: 'a1a', model: 'deepseek/deepseek-v4-flash', parent_id: 'm-174-u1a', token_count: 5, prompt_tokens: 10, active_path_tokens: 15 },
      { id: 'm-174-a1a2', thread_id: 't-order-a-174', role: 'assistant', content: 'a1a retry', model: 'deepseek/deepseek-v4-flash', parent_id: 'm-174-u1a', sibling_group: 'sg-174-a', sibling_index: 1, token_count: 5, prompt_tokens: 10, active_path_tokens: 15 },
      { id: 'm-174-u1b', thread_id: 't-order-b-174', role: 'user', content: 'u1b', token_count: 5, active_path_tokens: 5 },
      { id: 'm-174-a1b', thread_id: 't-order-b-174', role: 'assistant', content: 'a1b', model: 'deepseek/deepseek-v4-flash', parent_id: 'm-174-u1b', sibling_group: 'sg-174-b', sibling_index: 0, token_count: 5, prompt_tokens: 10, active_path_tokens: 15 },
      { id: 'm-174-a1b2', thread_id: 't-order-b-174', role: 'assistant', content: 'a1b retry', model: 'deepseek/deepseek-v4-flash', parent_id: 'm-174-u1b', sibling_group: 'sg-174-b', sibling_index: 1, token_count: 5, prompt_tokens: 10, active_path_tokens: 15 }
    ]
  },
  async body({ cdp, dbPath }) {
    await showChat();
    await cdp.waitFor('document.querySelectorAll("#thread-list .chat-item").length >= 2', 15000, 300, 'thread list');
    const orderBefore = await cdp.eval('[...document.querySelectorAll("#thread-list .chat-item")].map((el) => el.getAttribute("data-chat"))');
    if (orderBefore[0] !== 't-order-a-174')
      throw new Error('setup: thread A should be first, got ' + orderBefore.join(','));
    // Open thread B, then branch-switch inside it (bumps B's updated_at).
    await cdp.eval('window.loadThread("t-order-b-174"); true');
    await cdp.waitFor('window.activeThreadId === "t-order-b-174"', 15000, 300, 'thread B loaded');
    await sleep(600);
    await cdp.waitFor('chatMessages.length === 2 && chatMessages[1] && chatMessages[1].id === "m-174-a1b2"', 15000, 300, 'thread B active leaf loaded');
    const hasNext = await cdp.eval('!!document.querySelector("#chat-messages .msg:nth-child(2) .msg-action-btn[title=\'Next branch\']")');
    if (!hasNext) throw new Error('setup: no Next branch button for the retried sibling');
    const dbBefore = seed.query(dbPath, "SELECT updated_at FROM chat_threads WHERE id='t-order-b-174'")[0].updated_at;
    // Hook the AHK->WebView message channel so we can observe the threadList
    // refresh (the __posted hook only records JS->AHK posts).
    await cdp.eval(`(() => {
      if (!window.__ahkMsgs) {
        window.__ahkMsgs = [];
        window.chrome.webview.addEventListener('message', (e) => {
          try {
            const raw = e.data;
            const d = (typeof raw === 'string') ? JSON.parse(raw) : raw;
            if (d && d.target === 'threadList') window.__ahkMsgs.push(d);
          } catch (err) {}
        });
      }
      return true;
    })()`);
    await cdp.click('#chat-messages .msg:nth-child(2) .msg-action-btn[title="Next branch"]');
    await sleep(1000);
    const dbAfter = seed.query(dbPath, "SELECT updated_at FROM chat_threads WHERE id='t-order-b-174'")[0].updated_at;
    const orderAfter = await cdp.eval('[...document.querySelectorAll("#thread-list .chat-item")].map((el) => el.getAttribute("data-chat"))');
    // Fixed: handleBranchSwitch posts _postThreadListRefresh(), so the sidebar
    // re-renders from the DB after every branch switch.
    // BUG present: the DB updated_at bumped (dbAfter > dbBefore) but the
    // sidebar was never refreshed.
    if (dbAfter <= dbBefore) throw new Error('setup: updated_at did not bump: ' + dbBefore + ' -> ' + dbAfter);
    const posted = await cdp.eval('(window.__ahkMsgs || []).length');
    if (posted < 1)
      throw new Error('branch switch did not post a threadList refresh (BUG present): posted=' + posted);
    const dbRows = seed.query(dbPath, 'SELECT id, updated_at FROM chat_threads ORDER BY updated_at DESC');
    const expectedOrder = dbRows.map((r) => r.id);
    if (orderAfter.join(',') !== expectedOrder.join(','))
      throw new Error('sidebar order does not match the refreshed DB order: got ' + orderAfter.join(',') + ' expected ' + expectedOrder.join(','));
    return 'branch-switch bumped updated_at (' + dbBefore + ' -> ' + dbAfter + ') AND posted ' + posted +
      ' threadList refresh(es) - the sidebar re-renders the DB order ' + orderAfter.join(',') +
      ' (and the #155 model badge follows the active branch)';
  }
});

scenarios.push({
  id: 180,
  name: 'Sidebar thread list runs a per-thread active-path walk (N+1): one leaf lookup + one SELECT per ancestor for EVERY listed thread, so refresh latency scales with thread count x path depth',
  mode: null,
  regression: true, // FIXED: Thread_List batches the badge-walk data (301 threads -> 2 queries)
  settings: {},
  noApp: true,
  async body() {
    const os = require('node:os');
    const outFile = path.join(os.tmpdir(), 'llm-bughunt-db-' + process.pid + '.txt');
    try { fs.unlinkSync(outFile); } catch {}
    const probe = path.join(__dirname, '..', 'probe-bughunt-db.ahk');
    const res = spawnSync(launcher.AHK, ['/ErrorStdOut', probe, outFile, 'thread-list-nplus1'], { timeout: 30000, windowsHide: true, encoding: 'utf8' });
    if (res.error) throw new Error('thread-list probe spawn failed/timed out: ' + res.error.message);
    if (res.stderr) process.stderr.write('[probe stderr] ' + res.stderr);
    const text = fs.readFileSync(outFile, 'utf-8');
    const qm = text.match(/queries=(\d+)/);
    const tm = text.match(/threads=(\d+)/);
    const dm = text.match(/listedDangling=(\d+)/);
    const trm = text.match(/listedTrashed=(\d+)/);
    if (!qm || !tm || !dm || !trm) throw new Error('probe output missing fields: ' + text);
    const queries = Number(qm[1]), threads = Number(tm[1]), listedDangling = Number(dm[1]), listedTrashed = Number(trm[1]);
    // FIXED (bug #180): the badge walk loads all message rows for the listed
    // threads in ONE query and walks the ancestor chains in memory, so the
    // query count is bounded (a small constant) instead of ~2 per thread.
    if (queries > threads + 5 || queries > 20)
      throw new Error('thread list still issues unbounded queries (fix incomplete): threads=' + threads + ' queries=' + queries);
    if (listedDangling !== 1 || listedTrashed !== 0)
      throw new Error('dangling/trashed handling regressed: listedDangling=' + listedDangling + ' listedTrashed=' + listedTrashed);
    return '301 listed threads -> ' + queries + ' SQL queries per Thread_List() refresh (bounded; the badge walk now runs against one batched message query in memory). The dangling active_leaf_id thread is still listed (' + listedDangling + ', badge walk breaks cleanly - no throw/hang) and the trashed thread stays excluded (' + listedTrashed + ' listed)';
  }
});

scenarios.push({
  id: 192,
  regression: true, // REFUTED lead (2026-08-10): formatRelativeDate is LOCAL-correct - it extracts local date components after the UTC parse, so a UTC-21:30 (local 00:30) message is labeled "Today"
  name: 'Sidebar dates are local-day-correct: a message stored UTC 21:30 (local 00:30 in UTC+3) is labeled "Today, 00:30" (regression check for the UTC-vs-local family on the sidebar)',
  mode: null,
  noApp: true,
  settings: {},
  async body() {
    const src = fs.readFileSync(path.join(launcher.REPO_ROOT, 'webui', 'js', 'chat', 'chat-sidebar.js'), 'utf8');
    const script = `
      const RealDate = Date;
      // "Now" = 2026-08-10T21:00:00Z = 2026-08-11 00:00 in Asia/Jerusalem (UTC+3).
      const fixed = new RealDate('2026-08-10T21:00:00Z');
      const MockDate = class extends RealDate {
        constructor(...args) { if (args.length === 0) super(fixed.getTime()); else super(...args); }
      };
      global.Date = MockDate;
      ${src}
      // The message was stored by SQLite as UTC 2026-08-10 21:30:00
      // (= LOCAL 2026-08-11 00:30 in UTC+3) - it should be labeled "Today".
      console.log('LABEL ' + formatRelativeDate('2026-08-10 21:30:00'));
    `;
    const res = spawnSync(process.execPath, ['-e', script], {
      encoding: 'utf8', timeout: 15000, windowsHide: true,
      env: Object.assign({}, process.env, { TZ: 'Asia/Jerusalem' })
    });
    if (res.error || res.status !== 0)
      throw new Error('sidebar date probe failed: ' + (res.error && res.error.message) + ' ' + (res.stderr || res.stdout || ''));
    const line = String(res.stdout).split(/\r?\n/).find((l) => l.startsWith('LABEL '));
    if (!line) throw new Error('no LABEL line in probe output: ' + String(res.stdout));
    const label = line.slice(6);
    // FIXED/REFUTED: formatRelativeDate builds msgDay from d.getFullYear()/
    // getMonth()/getDate() - the LOCAL components of the UTC-instant - so the
    // day compare is local-vs-local and the label is correct.
    if (label.indexOf('Today') !== 0 || label.indexOf('00:30') < 0)
      throw new Error('local-midnight message mislabeled (regression): ' + label);
    return 'message created at LOCAL 2026-08-11 00:30 (stored UTC 2026-08-10 21:30) is labeled "' + label +
      '" - formatRelativeDate uses the local date components after the UTC parse, so the sidebar day label matches the local calendar day';
  }
});

scenarios.push({
  id: 209,
  name: 'Tree-modal / search navigation leaves the sidebar stale - navigateToMessage bumps chat_threads.updated_at (SetActiveLeaf) but posts no threadList refresh, so the sidebar order/model badge stays stale after navigating to an off-path branch (the fixed #174 path only covers handleBranchSwitch)',
  mode: null,
  regression: true, // FIXED bug #209 kept as a regression check (navigateToMessage now refreshes the sidebar)
  settings: {},
  fixtures: {
    // B is NEWER (created_at/updated_at 08-11), A is older (08-10). The seed
    // mirrors created_at into updated_at, so the sidebar starts B-first.
    threads: [
      { id: 't-209-a', title: 'Thread A (older)', active_leaf_id: 'm-209-a2', created_at: '2026-08-10 10:00:00' },
      { id: 't-209-b', title: 'Thread B (newer)', active_leaf_id: 'm-209-b1', created_at: '2026-08-11 10:00:00' }
    ],
    messages: [
      { id: 'm-209-u1', thread_id: 't-209-a', role: 'user', content: 'root question', token_count: 5, active_path_tokens: 5 },
      { id: 'm-209-a1', thread_id: 't-209-a', role: 'assistant', content: 'branch one answer', model: 'deepseek/deepseek-v4-flash', parent_id: 'm-209-u1', sibling_group: 'sg-209', sibling_index: 0, token_count: 5, prompt_tokens: 10, active_path_tokens: 15 },
      { id: 'm-209-a2', thread_id: 't-209-a', role: 'assistant', content: 'branch two answer (active)', model: 'deepseek/deepseek-v4-flash', parent_id: 'm-209-u1', sibling_group: 'sg-209', sibling_index: 1, token_count: 5, prompt_tokens: 10, active_path_tokens: 15 },
      { id: 'm-209-b1', thread_id: 't-209-b', role: 'user', content: 'thread B hello', token_count: 5, active_path_tokens: 5 }
    ]
  },
  async body({ cdp, dbPath }) {
    await showChat();
    await cdp.waitFor('document.querySelectorAll("#thread-list .chat-item").length >= 2', 15000, 300, 'thread list');
    const orderBefore = await cdp.eval('[...document.querySelectorAll("#thread-list .chat-item")].map((el) => el.getAttribute("data-chat"))');
    if (orderBefore[0] !== 't-209-b' || orderBefore[1] !== 't-209-a')
      throw new Error('setup: sidebar should start B-first (B newer), got ' + orderBefore.join(','));
    // Hook the AHK->WebView channel to count threadList refreshes (the
    // __posted hook only records JS->AHK posts).
    await cdp.eval(`(() => {
      if (!window.__ahkMsgs) {
        window.__ahkMsgs = [];
        window.chrome.webview.addEventListener('message', (e) => {
          try {
            const raw = e.data;
            const d = (typeof raw === 'string') ? JSON.parse(raw) : raw;
            if (d && d.target === 'threadList') window.__ahkMsgs.push(d);
          } catch (err) {}
        });
      }
      return true;
    })()`);
    // Open thread A (older) - same flow as clicking its sidebar item.
    await cdp.eval('window.loadThread("t-209-a"); true');
    await cdp.waitFor('window.activeThreadId === "t-209-a"', 15000, 300, 'thread A loaded');
    await sleep(600);
    await cdp.waitFor('chatMessages.length === 2 && chatMessages[1] && chatMessages[1].id === "m-209-a2"', 15000, 300, 'branch two loaded');
    const dbBefore = seed.query(dbPath, "SELECT updated_at FROM chat_threads WHERE id='t-209-a'")[0].updated_at;
    await cdp.eval(`(() => { window.__ahkMsgs.length = 0; return true; })()`);
    // Navigate to the OFF-PATH sibling (branch one) - the exact IPC the tree
    // modal and the search dropdown send (chat-tree-modal.js / chat-search.js).
    await cdp.eval(`Ipc.postToHost('sidebarAction', { subAction: 'navigateToMessage', messageId: 'm-209-a1' }); true`);
    await sleep(1200);
    const dbAfter = seed.query(dbPath, "SELECT updated_at FROM chat_threads WHERE id='t-209-a'")[0].updated_at;
    if (dbAfter <= dbBefore)
      throw new Error('setup: updated_at did not bump: ' + dbBefore + ' -> ' + dbAfter);
    const orderAfter = await cdp.eval('[...document.querySelectorAll("#thread-list .chat-item")].map((el) => el.getAttribute("data-chat"))');
    const posted = await cdp.eval('(window.__ahkMsgs || []).length');
    const dbRows = seed.query(dbPath, 'SELECT id, updated_at FROM chat_threads ORDER BY updated_at DESC');
    const dbOrder = dbRows.map((r) => r.id);
    // FIXED (bug #209): navigateToMessage now posts _postThreadListRefresh(),
    // so the sidebar re-renders from the DB - A moves to the top (its
    // updated_at bumped) and the list matches the DB order.
    if (dbOrder[0] !== 't-209-a')
      throw new Error('setup: DB order did not flip to A-first: ' + dbOrder.join(','));
    if (posted < 1)
      throw new Error('navigateToMessage did not post a threadList refresh (fix incomplete): posted=' + posted);
    if (orderAfter.join(',') !== dbOrder.join(','))
      throw new Error('sidebar order does not match the refreshed DB order (fix incomplete): got ' + orderAfter.join(',') + ' expected ' + dbOrder.join(','));
    return 'navigated to off-path branch in A: updated_at ' + dbBefore + ' -> ' + dbAfter +
      ', posted ' + posted + ' threadList refresh(es) and the sidebar now shows the DB order ' +
      orderAfter.join(',') + ' (A moved to the top like branch-switch navigation)';
  }
});

scenarios.push({
  id: 195,
  name: 'Switching threads while a request is streaming pushes the OLD thread\'s completed response into the CURRENT thread\'s in-memory message array - _persistStreamedMessage always targets the global chatMessages, so after thread A\'s stream finishes while thread B is visible, B\'s UI array (copy/export/thread map) contains A\'s assistant message even though the DB row is correct in A',
  mode: 'sse-slow',
  regression: true, // FIXED bug #195 kept as a regression check
  settings: {},
  fixtures: {
    threads: [
      { id: 't-ui-a-195', title: 'Thread A', active_leaf_id: 'm-195-u1a' },
      { id: 't-ui-b-195', title: 'Thread B', active_leaf_id: 'm-195-u1b' }
    ],
    messages: [
      { id: 'm-195-u1a', thread_id: 't-ui-a-195', role: 'user', content: 'question for A', token_count: 5, active_path_tokens: 5 },
      { id: 'm-195-u1b', thread_id: 't-ui-b-195', role: 'user', content: 'question for B', token_count: 5, active_path_tokens: 5 }
    ]
  },
  async body({ cdp, dbPath }) {
    await showChat();
    await cdp.waitFor('document.querySelectorAll("#thread-list .chat-item").length >= 2', 15000, 300, 'thread list');
    await cdp.eval('window.loadThread("t-ui-a-195"); true');
    await cdp.waitFor('window.activeThreadId === "t-ui-a-195"', 15000, 300, 'thread A loaded');
    await sleep(600);
    await sendChatMessage(cdp, 'question for A');
    await cdp.waitFor('typeof streamState !== "undefined" && streamState.active === true', 20000, 50, 'streaming active');
    // Make sure A's appendChatMessage post has actually landed in the UI
    // array BEFORE switching - under load the post can lag past B's
    // initChatMode and leave B's array with A's message (a setup flake, not
    // the bug under test).
    await cdp.waitFor('chatMessages.length === 2 && chatMessages[1].role === "user"', 10000, 100, 'A append settled');
    // Switch to thread B while A's stream is in flight (same flow as bug #159).
    await cdp.eval('window.loadThread("t-ui-b-195"); true');
    // loadThread sets activeThreadId synchronously in JS, but B's initChatMode
    // (AHK round trip) replaces chatMessages afterwards - wait for B's OWN
    // messages to arrive before asserting the pollution-free baseline (a
    // setup flake under load, not the bug under test).
    await cdp.waitFor('window.activeThreadId === "t-ui-b-195" && chatMessages.length === 1 && chatMessages[0] && chatMessages[0].id === "m-195-u1b"', 15000, 100, 'thread B loaded with its own messages');
    const midLen = await cdp.eval('chatMessages.length');
    if (midLen !== 1)
      throw new Error('setup: B chatMessages should have 1 message after switch, got ' + midLen);
    await waitStreamingIdle(cdp, 30000);
    await sleep(1000);

    const uiMsgs = await cdp.eval('chatMessages.map(function(m){ return m.role + ":" + String(m.content).slice(0, 60); })');
    const inA = seed.query(dbPath, "SELECT COUNT(*) AS c FROM messages WHERE thread_id='t-ui-a-195' AND role='assistant'")[0].c;
    const inB = seed.query(dbPath, "SELECT COUNT(*) AS c FROM messages WHERE thread_id='t-ui-b-195' AND role='assistant'")[0].c;
    // The DB fix from #159 is in place: the response lands in thread A, not B.
    if (inA !== 1 || inB !== 0)
      throw new Error('setup: DB rows wrong (inA=' + inA + ' inB=' + inB + ') - stream/switch timing failed');
    const hasStreamBubble = await cdp.eval('document.getElementById("streaming-bubble") !== null');
    // FIXED (bug #195): A's stream is suppressed/persisted only for its own
    // thread; B's UI array keeps exactly B's user message and no stray
    // streaming bubble appears in B.
    if (uiMsgs.length !== 1 || String(uiMsgs[0]).indexOf('assistant') === 0)
      throw new Error('old-thread response leaked into the current UI array (fix incomplete): ' + JSON.stringify(uiMsgs));
    if (hasStreamBubble)
      throw new Error('old-thread streaming bubble leaked into thread B UI (fix incomplete)');
    return 'sent in A, switched to B mid-stream; DB rows inA=' + inA + ' inB=' + inB +
      ' (correct), and the visible thread B chatMessages=' + JSON.stringify(uiMsgs) +
      ' has no A response and no streaming bubble - stream messages are scoped to the sending thread/path';
  }
});

scenarios.push({
  id: 197,
  name: 'Switching BRANCHES within the SAME thread mid-stream mis-parents the completed response - _persistStreamResponse reads ChatDB.Msg_GetActivePath(streamThreadId) at completion time instead of capturing the request\'s last user message, so after branch A sends and the user navigates to branch B, the response becomes a child of branch B\'s leaf instead of branch A\'s follow-up user message',
  mode: 'sse-slow',
  regression: true, // FIXED bug #197 kept as a regression check
  settings: {},
  fixtures: {
    threads: [{ id: 't-br-197', title: 'Branch Mid-Stream', active_leaf_id: 'm-197-a2a' }],
    messages: [
      { id: 'm-197-u1', thread_id: 't-br-197', role: 'user', content: 'root', token_count: 5, active_path_tokens: 5 },
      { id: 'm-197-a1', thread_id: 't-br-197', role: 'assistant', content: 'branch A answer', model: 'deepseek/deepseek-v4-flash', parent_id: 'm-197-u1', sibling_group: 'sg-197-a', sibling_index: 0, token_count: 5, prompt_tokens: 10, active_path_tokens: 10 },
      { id: 'm-197-a1b', thread_id: 't-br-197', role: 'assistant', content: 'branch B answer', model: 'deepseek/deepseek-v4-flash', parent_id: 'm-197-u1', sibling_group: 'sg-197-a', sibling_index: 1, token_count: 5, prompt_tokens: 10, active_path_tokens: 10 },
      { id: 'm-197-u2a', thread_id: 't-br-197', role: 'user', content: 'follow A', parent_id: 'm-197-a1', token_count: 4, active_path_tokens: 14 },
      { id: 'm-197-a2a', thread_id: 't-br-197', role: 'assistant', content: 'A leaf', model: 'deepseek/deepseek-v4-flash', parent_id: 'm-197-u2a', token_count: 6, prompt_tokens: 20, active_path_tokens: 20 },
      { id: 'm-197-u2b', thread_id: 't-br-197', role: 'user', content: 'follow B', parent_id: 'm-197-a1b', token_count: 4, active_path_tokens: 14 },
      { id: 'm-197-a2b', thread_id: 't-br-197', role: 'assistant', content: 'B leaf', model: 'deepseek/deepseek-v4-flash', parent_id: 'm-197-u2b', token_count: 6, prompt_tokens: 20, active_path_tokens: 20 }
    ]
  },
  async body({ cdp, dbPath }) {
    await showChat();
    await cdp.waitFor('document.querySelectorAll("#thread-list .chat-item").length > 0', 15000, 300, 'thread list');
    await cdp.click('#thread-list .chat-item');
    await cdp.waitFor('chatMessages.length >= 4 && chatMessages[3] && chatMessages[3].id === "m-197-a2a"', 15000, 300, 'branch A loaded');
    await sleep(700);
    await sendChatMessage(cdp, 'follow-up on A');
    await cdp.waitFor('typeof streamState !== "undefined" && streamState.active === true', 20000, 50, 'streaming active');
    await sleep(120);
    // While A's follow-up request is streaming, switch to the sibling branch
    // (a1 -> a1b). The branch nav arrows are on the shared assistant bubble.
    await cdp.click('#chat-messages .msg:nth-child(2) .msg-action-btn[title="Next branch"]');
    await cdp.waitFor('chatMessages.length >= 4 && chatMessages[3] && chatMessages[3].id === "m-197-a2b"', 15000, 300, 'branch B loaded');
    await waitStreamingIdle(cdp, 40000);
    await sleep(1200);

    const newRows = seed.query(dbPath, "SELECT id, parent_id, thread_id FROM messages WHERE thread_id='t-br-197' AND content LIKE 'Hello from the mock LLM%'");
    if (newRows.length !== 1)
      throw new Error('setup: expected exactly one streamed response, got ' + JSON.stringify(newRows));
    const parentId = newRows[0].parent_id;
    const u3a = seed.query(dbPath, "SELECT id FROM messages WHERE thread_id='t-br-197' AND content='follow-up on A'")[0].id;
    // FIXED (bug #197): the response is inserted under the user message that
    // SENT the request (u3a), captured at send time, not the newly-active
    // branch B leaf.
    if (parentId !== u3a)
      throw new Error('streamed response was not parented to the sending user message (fix incomplete): parent=' + parentId + ' expected=' + u3a);
    return 'branch A sent "follow-up on A" (user id ' + u3a + '), switched to branch B mid-stream; the completed response was inserted with parent_id=' + parentId +
      ' - _persistStreamResponse uses the parent captured at send time, so the response stays on the branch that sent it';
  }
});

scenarios.push({
  id: 210,
  name: 'Chat-window title stays stale after deleting the active thread - the deleteThread/deleteThreadForever/emptyTrash paths clear activeThreadId and post loadThread+initChatMode but never reset chatWindow.Title (only renameThread and _LoadThreadAndRefreshUI touch it)',
  mode: null,
  regression: true, // FIXED bug #210 kept as a regression check (deleting the active thread resets the title)
  settings: {},
  fixtures: {
    threads: [{ id: 't-del-210', title: 'Stale Title Thread', active_leaf_id: 'm-del-210' }],
    messages: [{ id: 'm-del-210', thread_id: 't-del-210', role: 'user', content: 'hello' }]
  },
  async body({ cdp }) {
    await showChat();
    await cdp.waitFor('document.querySelectorAll("#thread-list .chat-item").length > 0', 15000, 300, 'thread list');
    await cdp.click('#thread-list .chat-item');
    await cdp.waitFor('window.activeThreadId === "t-del-210" && document.querySelectorAll("#chat-messages .msg").length >= 1', 15000, 300, 'thread loaded');
    await sleep(700);
    const titleBefore = (runProbe('chat-info').title || '');
    if (titleBefore.indexOf('Stale Title Thread') < 0)
      throw new Error('setup: window title does not show the loaded thread: ' + JSON.stringify(titleBefore));
    // Delete the ACTIVE chat via the sidebar (delete confirm flow).
    await cdp.eval(`(() => {
      const item = [...document.querySelectorAll('#thread-list .chat-item')].find(i => i.getAttribute('data-chat') === 't-del-210');
      if (!item) return 'no-item';
      const btn = item.querySelector('.chat-action-btn.danger');
      if (!btn) return 'no-btn';
      btn.click();
      return 'clicked';
    })()`);
    await cdp.waitFor('document.getElementById("customConfirmOverlay") !== null', 5000, 200, 'confirm overlay');
    await cdp.click('#customConfirmOverlay .yes-confirm-btn');
    await cdp.waitFor('window.activeThreadId === "" && chatMessages.length === 0', 10000, 250, 'chat emptied');
    await sleep(700);
    const titleAfter = (runProbe('chat-info').title || '');
    // FIXED (bug #210): the deletion paths now reset chatWindow.Title to the
    // app name, so the title bar follows the emptied chat area.
    if (titleAfter.indexOf('Stale Title Thread') >= 0)
      throw new Error('window title still shows the deleted thread (fix incomplete): ' + JSON.stringify(titleAfter));
    if (titleAfter !== 'AhkLLM')
      throw new Error('window title should reset to the app name after deleting the active thread, got: ' + JSON.stringify(titleAfter));
    return 'deleted the active thread: activeThreadId="" and the window title reset from "' + titleBefore +
      '" to "' + titleAfter + '" - deleteThread/deleteThreadForever/emptyTrash now reset chatWindow.Title';
  }
});

scenarios.push({
  id: 211,
  name: 'A failed retry leaks pendingRetrySiblingGroup into the next response - retryAction sets the pending keys and only the SUCCESS (_persistStreamResponse) and CANCEL (_handleStreamCancelled) paths delete them; a retry rejected before any stream (vision gate / buildRequest failure / _handleStreamError) leaves the stale group set, so the next normal send inserts its response with the retried message\'s sibling_group even though its parent is the new user message',
  mode: 'sse-success',
  regression: true, // FIXED bug #211 kept as a regression check (failed retries clear the pending keys)
  settings: {},
  fixtures: {
    threads: [{ id: 't-stale-211', title: 'Stale Retry State', active_leaf_id: 'm-211-a1' }],
    messages: [
      { id: 'm-211-u1', thread_id: 't-stale-211', role: 'user', content: 'root question' },
      { id: 'm-211-a1', thread_id: 't-stale-211', role: 'assistant', content: 'first answer', model: 'deepseek/deepseek-v4-flash', parent_id: 'm-211-u1', token_count: 9, prompt_tokens: 12, active_path_tokens: 21 }
    ]
  },
  async body({ cdp, dbPath }) {
    // Attach an image to the user message: deepseek/deepseek-v4-flash has
    // vision:false, so the retry request is rejected by the vision gate BEFORE
    // any stream starts (buildRequest returns ""). This is the "failed retry".
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(dbPath);
    db.exec("INSERT INTO message_attachments (id, message_id, attachment_type, file_path, mime_type, original_filename, file_size, extracted_text) VALUES ('att-211', 'm-211-u1', 'image', 'attachments/img.png', 'image/png', 'img.png', 12, '')");
    db.close();

    await showChat();
    await cdp.waitFor('document.querySelectorAll("#thread-list .chat-item").length > 0', 15000, 300, 'thread list');
    await cdp.click('#thread-list .chat-item');
    await cdp.waitFor('chatMessages.length === 2 && chatMessages[1] && chatMessages[1].id === "m-211-a1"', 15000, 300, 'thread loaded');
    await sleep(700);
    // Retry the assistant reply - the vision gate rejects it (no stream).
    await cdp.click('#chat-messages .msg:nth-child(2) .msg-action-btn[title="Retry"]');
    await cdp.waitFor('document.querySelectorAll(".error-banner").length > 0', 15000, 300, 'vision-gate error');
    await cdp.waitFor('isLoading === false', 10000, 250, 'UI re-enabled after failed retry');
    await sleep(500);
    // Remove the image so the follow-up request passes the vision gate.
    const db2 = new DatabaseSync(dbPath);
    db2.exec("DELETE FROM message_attachments WHERE message_id='m-211-u1'");
    db2.close();
    // Normal follow-up send - its streamed response must NOT inherit the
    // failed retry's sibling group.
    await sendChatMessage(cdp, 'follow-up after failed retry');
    await waitStreamingIdle(cdp, 40000);
    await sleep(1200);

    const rows = seed.query(dbPath, "SELECT id, content FROM messages WHERE thread_id='t-stale-211' AND content LIKE 'Hello from the mock LLM%'");
    if (rows.length !== 1)
      throw new Error('setup: expected one streamed follow-up response, got ' + JSON.stringify(rows));
    const a2 = seed.query(dbPath, "SELECT parent_id, sibling_group, sibling_index FROM messages WHERE id=?", [rows[0].id])[0];
    const u2 = seed.query(dbPath, "SELECT id FROM messages WHERE content='follow-up after failed retry'")[0];
    const a1sg = seed.query(dbPath, "SELECT sibling_group FROM messages WHERE id='m-211-a1'")[0].sibling_group;
    if (!u2) throw new Error('setup: follow-up user message missing');
    if (a2.parent_id !== u2.id)
      throw new Error('setup: follow-up response was not parented to the follow-up user message: ' + JSON.stringify(a2));
    // FIXED (bug #211): the failed retry cleared its pending sibling group, so
    // the follow-up response must be inserted with NO sibling group - it must
    // NOT be grouped with the retried assistant (a1sg) across different parents.
    if (a2.sibling_group && a2.sibling_group !== '')
      throw new Error('follow-up response inherited the failed retry\'s sibling group (fix incomplete): ' + JSON.stringify(a2) + ' a1sg=' + JSON.stringify(a1sg));
    return 'failed retry (vision gate) cleared pendingRetrySiblingGroup: follow-up response (parent=' + a2.parent_id +
      ') was inserted with sibling_group=' + JSON.stringify(a2.sibling_group) +
      ' (clean; the retried assistant keeps its own group ' + JSON.stringify(a1sg) + ') - the next normal send is no longer mis-grouped';
  }
});

scenarios.push({
  id: 205,
  name: 'Cancelling a retry of a ROOT assistant (no parent) inserts the partial as a CHILD of the original - _handleStreamCancelled honors pendingRetrySiblingGroup but never checks pendingRetryIsRoot (unlike _persistStreamResponse, bug #147), so the cancelled retry is attached under the original root instead of as a sibling with parent NULL',
  mode: 'sse-slow',
  regression: true, // FIXED bug #205 kept as a regression check
  settings: {},
  fixtures: {
    threads: [{ id: 't-root-205', title: 'Root Retry Cancel', active_leaf_id: 'm-205-a1' }],
    messages: [
      { id: 'm-205-a1', thread_id: 't-root-205', role: 'assistant', content: 'original root answer', model: 'deepseek/deepseek-v4-flash', token_count: 5, prompt_tokens: 1, active_path_tokens: 6 }
    ]
  },
  async body({ cdp, dbPath }) {
    await showChat();
    await cdp.waitFor('document.querySelectorAll("#thread-list .chat-item").length > 0', 15000, 300, 'thread list');
    await cdp.click('#thread-list .chat-item');
    await cdp.waitFor('chatMessages.length >= 1 && chatMessages[0] && chatMessages[0].id === "m-205-a1"', 15000, 300, 'root assistant loaded');
    await sleep(600);
    await cdp.click('#chat-messages .msg .msg-action-btn[title="Retry"]');
    await cdp.waitFor('typeof streamState !== "undefined" && streamState.active === true', 20000, 50, 'retry streaming');
    await sleep(120);
    // Cancel mid-stream (the slow mock has already emitted reasoning).
    await cdp.eval('window.onStopStreaming(); true');
    await waitStreamingIdle(cdp, 40000);
    await sleep(1200);

    const partials = seed.query(dbPath, "SELECT id, parent_id, content, reasoning FROM messages WHERE thread_id='t-root-205' AND id != 'm-205-a1'");
    if (partials.length !== 1)
      throw new Error('setup: expected one cancelled partial, got ' + JSON.stringify(partials));
    const parentId = partials[0].parent_id;
    // FIXED (bug #205): the cancelled partial is a SIBLING of the original
    // root (parent_id NULL), mirroring the completed retry path (bug #147).
    if (parentId !== null && parentId !== '')
      throw new Error('cancelled root retry still has a parent (fix incomplete): parent=' + parentId + ' rows=' + JSON.stringify(partials));
    return 'retried the root assistant and cancelled after reasoning started: the partial row has parent_id=' +
      JSON.stringify(parentId) + ' (NULL - sibling of the original root) - _handleStreamCancelled now honors pendingRetryIsRoot';
  }
});

scenarios.push({
  id: 206,
  name: 'Switching threads mid-stream writes the OLD request\'s API-log entry with the NEW thread\'s model/provider - _logStreamResponse reads the CURRENT requestParams (singleAPIModelName/providerName) at completion instead of the values captured at send time, so the log row disagrees with the request body it logged',
  mode: 'sse-success',
  regression: true, // FIXED bug #206 kept as a regression check
  settings: {},
  fixtures: {
    threads: [
      { id: 't-log-a-206', title: 'Thread A', active_leaf_id: 'm-206-u1a' },
      { id: 't-log-b-206', title: 'Thread B', active_leaf_id: 'm-206-u1b', model_override: 'openai/gpt-5-mini' }
    ],
    messages: [
      { id: 'm-206-u1a', thread_id: 't-log-a-206', role: 'user', content: 'question for A', token_count: 5, active_path_tokens: 5 },
      { id: 'm-206-u1b', thread_id: 't-log-b-206', role: 'user', content: 'question for B', token_count: 5, active_path_tokens: 5 }
    ]
  },
  async body({ cdp, dbPath }) {
    const logFile = path.join(os.tmpdir(), 'LLM_API_Log.json');
    try { fs.unlinkSync(logFile); } catch {}
    await showChat();
    await cdp.waitFor('document.querySelectorAll("#thread-list .chat-item").length >= 2', 15000, 300, 'thread list');
    await cdp.eval('window.loadThread("t-log-a-206"); true');
    await cdp.waitFor('window.activeThreadId === "t-log-a-206"', 15000, 300, 'thread A loaded');
    await sleep(600);
    await sendChatMessage(cdp, 'question for A');
    await cdp.waitFor('typeof streamState !== "undefined" && streamState.active === true', 20000, 50, 'streaming active');
    await sleep(40);
    await cdp.eval('window.loadThread("t-log-b-206"); true');
    await cdp.waitFor('window.activeThreadId === "t-log-b-206"', 10000, 250, 'thread B loaded');
    await waitStreamingIdle(cdp, 30000);
    await sleep(1000);

    const raw = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '';
    const logs = JSON.parse(raw || '[]');
    const entry = logs.find((e) => e.request && String(e.request).indexOf('question for A') >= 0);
    if (!entry) throw new Error('setup: no API-log entry for thread A request: ' + raw.slice(0, 500));
    const reqObj = JSON.parse(String(entry.request));
    const reqModel = reqObj.model;
    // FIXED (bug #206): the log entry must describe the SENDING thread's
    // model (full id, as the logger has always stored), not the thread that
    // became active mid-stream.
    if (entry.model !== 'deepseek/deepseek-v4-flash' || entry.provider !== 'deepseek')
      throw new Error('API-log entry still uses the wrong thread metadata (fix incomplete): entry.model=' + entry.model + ' provider=' + entry.provider + ' reqModel=' + reqModel);
    return 'sent in A (request body model=' + reqModel + '), switched to B mid-stream; the API-log entry for A\'s request says model=' + entry.model +
      ', provider=' + entry.provider + ' - loggers use the request metadata captured at send time';
  }
});

scenarios.push({
  id: 207,
  name: 'Thread A\'s stream completion repaints thread B\'s header token bar with A\'s stats - _handleStreamComplete calls postThreadStats(streamThreadId) and the WebView\'s updateTokenUsage renders whatever arrives, so after switching to B mid-stream B shows A\'s Context/Cumulative numbers even though B\'s DB has only a 5-token user message',
  mode: 'sse-success',
  regression: true, // FIXED bug #207 kept as a regression check
  settings: {},
  fixtures: {
    threads: [
      { id: 't-hdr-a-207', title: 'Thread A', active_leaf_id: 'm-207-u1a' },
      { id: 't-hdr-b-207', title: 'Thread B', active_leaf_id: 'm-207-u1b' }
    ],
    messages: [
      { id: 'm-207-u1a', thread_id: 't-hdr-a-207', role: 'user', content: 'question for A', token_count: 5, active_path_tokens: 5 },
      { id: 'm-207-u1b', thread_id: 't-hdr-b-207', role: 'user', content: 'question for B', token_count: 5, active_path_tokens: 5 }
    ]
  },
  async body({ cdp, dbPath }) {
    await showChat();
    await cdp.waitFor('document.querySelectorAll("#thread-list .chat-item").length >= 2', 15000, 300, 'thread list');
    await cdp.eval('window.loadThread("t-hdr-a-207"); true');
    await cdp.waitFor('window.activeThreadId === "t-hdr-a-207"', 15000, 300, 'thread A loaded');
    await sleep(600);
    await sendChatMessage(cdp, 'question for A');
    await cdp.waitFor('typeof streamState !== "undefined" && streamState.active === true', 20000, 50, 'streaming active');
    await sleep(40);
    await cdp.eval('window.loadThread("t-hdr-b-207"); true');
    await cdp.waitFor('window.activeThreadId === "t-hdr-b-207"', 10000, 250, 'thread B loaded');
    // B's own stats: context 5, cumulative 0/0.
    const bStats = seed.query(dbPath, "SELECT cumulative_input_tokens, cumulative_output_tokens FROM chat_threads WHERE id='t-hdr-b-207'")[0];
    await waitStreamingIdle(cdp, 30000);
    await sleep(1000);
    const bar = await cdp.text('#tokenBar');
    // FIXED (bug #207): A's completion stats carry threadId=A and are ignored
    // while B is active, so the header keeps B's own stats (context 5, 0/0).
    if (String(bar).indexOf('21') >= 0 || String(bar).indexOf('\u2191 12') >= 0)
      throw new Error('token bar still shows thread A stats over thread B (fix incomplete): bar=' + JSON.stringify(bar) + ' bStats=' + JSON.stringify(bStats));
    if (String(bar).indexOf('5') < 0)
      throw new Error('token bar lost thread B\'s own context (fix incomplete): bar=' + JSON.stringify(bar) + ' bStats=' + JSON.stringify(bStats));
    return 'after A completes while B is visible: B DB stats=' + JSON.stringify(bStats) +
      ' (context 5, no API calls); the header shows B\'s stats "' + String(bar).replace(/\s+/g, ' ').trim() +
      '" - updateTokenUsage ignores stats whose threadId does not match the active thread';
  }
});

scenarios.push({
  id: 318,
  name: 'Editing an assistant message bumps thread recency but does not refresh the sidebar - Save as Branch changes DB order while the live thread list stays stale',
  regression: true, // FIXED bug #318 kept as a regression check (edit refreshes sidebar)
  mode: null,
  settings: { threadTitles: { enabled: false } },
  fixtures: {
    threads: [
      { id: 't-order-a-318', title: 'Thread A (older)', active_leaf_id: 'm-318-a1', created_at: '2026-08-20 10:00:00' },
      { id: 't-order-b-318', title: 'Thread B (newer)', active_leaf_id: 'm-318-b1', created_at: '2026-08-21 10:00:00' }
    ],
    messages: [
      { id: 'm-318-u1', thread_id: 't-order-a-318', role: 'user', content: 'question A', token_count: 3, active_path_tokens: 3, created_at: '2026-08-20 10:00:01' },
      { id: 'm-318-a1', thread_id: 't-order-a-318', role: 'assistant', content: 'answer A', model: 'deepseek/deepseek-v4-flash', parent_id: 'm-318-u1', token_count: 3, prompt_tokens: 3, active_path_tokens: 6, created_at: '2026-08-20 10:00:02' },
      { id: 'm-318-b1', thread_id: 't-order-b-318', role: 'user', content: 'question B', token_count: 3, active_path_tokens: 3, created_at: '2026-08-21 10:00:01' }
    ]
  },
  async body({ cdp, dbPath }) {
    await showChat();
    await cdp.waitFor('document.querySelectorAll("#thread-list .chat-item").length >= 2', 15000, 300, 'two seeded threads');
    const orderBefore = await cdp.eval('[...document.querySelectorAll("#thread-list .chat-item")].map((el) => el.getAttribute("data-chat"))');
    if (orderBefore.join(',') !== 't-order-b-318,t-order-a-318')
      throw new Error('setup: sidebar should start B-first, got ' + orderBefore.join(','));

    await cdp.eval('window.loadThread("t-order-a-318"); true');
    await cdp.waitFor('window.activeThreadId === "t-order-a-318" && chatMessages.length === 2', 15000, 300, 'older thread A loaded');
    await cdp.waitFor('document.querySelector("#chat-messages .msg:nth-child(2) .msg-action-btn[title=\'Edit\']") !== null', 5000, 200, 'A assistant Edit action');
    const dateBefore = await cdp.eval('document.querySelector("#thread-list .chat-item[data-chat=\\"t-order-a-318\\"] .chat-date").textContent');
    const dbBefore = seed.query(dbPath, "SELECT updated_at FROM chat_threads WHERE id='t-order-a-318'")[0].updated_at;

    // Save as Branch on an assistant is local-only: it edits the DB and
    // updates the visible chat but does not cause an LLM response refresh.
    await cdp.click('#chat-messages .msg:nth-child(2) .msg-action-btn[title="Edit"]');
    await cdp.waitFor('document.querySelector("#chat-messages .msg:nth-child(2)").classList.contains("editing")', 5000, 200, 'assistant edit open');
    await cdp.type('#chat-messages .msg:nth-child(2) .msg-edit-textarea', 'answer A branch 318');
    await cdp.click('#chat-messages .msg:nth-child(2) .save-branch');
    await cdp.waitFor('chatMessages.some((m) => m.content === "answer A branch 318")', 15000, 300, 'local branch created');

    const dbAfter = seed.query(dbPath, "SELECT updated_at FROM chat_threads WHERE id='t-order-a-318'")[0].updated_at;
    const dbOrder = seed.query(dbPath, 'SELECT id FROM chat_threads ORDER BY updated_at DESC').map((row) => row.id);
    const orderAfter = await cdp.eval('[...document.querySelectorAll("#thread-list .chat-item")].map((el) => el.getAttribute("data-chat"))');
    const dateAfter = await cdp.eval('document.querySelector("#thread-list .chat-item[data-chat=\\"t-order-a-318\\"] .chat-date").textContent');
    if (dbAfter <= dbBefore || dbOrder[0] !== 't-order-a-318')
      throw new Error('setup: branch edit did not make A newest in DB: ' + dbBefore + ' -> ' + dbAfter + ' order=' + dbOrder.join(','));
    // Fixed behavior: the edit posts a threadList refresh, so the live
    // sidebar follows the DB's new order and date immediately.
    if (orderAfter.join(',') !== 't-order-a-318,t-order-b-318' || dateAfter === dateBefore)
      throw new Error('sidebar did not refresh after edit (bug #318 fix incomplete): before=' + orderBefore.join(',') +
        ' after=' + orderAfter.join(',') + ' dates=' + JSON.stringify(dateBefore) + ' -> ' + JSON.stringify(dateAfter));
    return 'Save as Branch on assistant A changed DB order to ' + dbOrder.join(',') + ' (' + dbBefore + ' -> ' + dbAfter +
      ') and live sidebar refreshed to ' + orderAfter.join(',') + ' with date ' + JSON.stringify(dateAfter) +
      ' (changed from ' + JSON.stringify(dateBefore) + ')';
  }
});

scenarios.push({
  id: 321,
  name: 'Deleting the active assistant response refreshes the sidebar model badge',
  regression: true,
  mode: null,
  settings: { threadTitles: { enabled: false } },
  fixtures: {
    threads: [{ id: 't-badge-321', title: 'Model Badge Delete', active_leaf_id: 'm-321-a2' }],
    messages: [
      { id: 'm-321-u1', thread_id: 't-badge-321', role: 'user', content: 'first question', token_count: 3, active_path_tokens: 3 },
      { id: 'm-321-a1', thread_id: 't-badge-321', role: 'assistant', content: 'answer from model A', model: 'openai/gpt-5-mini', parent_id: 'm-321-u1', token_count: 3, prompt_tokens: 3, active_path_tokens: 6 },
      { id: 'm-321-u2', thread_id: 't-badge-321', role: 'user', content: 'second question', parent_id: 'm-321-a1', token_count: 3, active_path_tokens: 9 },
      { id: 'm-321-a2', thread_id: 't-badge-321', role: 'assistant', content: 'answer from model B', model: 'deepseek/deepseek-v4-flash', parent_id: 'm-321-u2', token_count: 3, prompt_tokens: 9, active_path_tokens: 12 }
    ]
  },
  async body({ cdp, dbPath }) {
    await showChat();
    await cdp.waitFor('document.querySelectorAll("#thread-list .chat-item").length > 0', 15000, 300, 'thread list');
    await cdp.waitFor('document.querySelector("#thread-list .chat-item[data-chat=\\"t-badge-321\\"] .chat-icon img") !== null', 5000, 200, 'initial model badge');
    const before = await cdp.eval('document.querySelector("#thread-list .chat-item[data-chat=\\"t-badge-321\\"] .chat-icon img").getAttribute("src")');
    if (String(before).indexOf('deepseek.ico') < 0)
      throw new Error('setup: active model B did not produce the DeepSeek badge: ' + JSON.stringify(before));

    await cdp.eval('window.loadThread("t-badge-321"); true');
    await cdp.waitFor('window.activeThreadId === "t-badge-321" && chatMessages.length === 4', 15000, 300, 'four-message path loaded');
    await cdp.click('#chat-messages .msg:nth-child(4) .msg-action-btn[title="Delete"]');
    await cdp.waitFor('document.getElementById("customConfirmOverlay") !== null', 5000, 200, 'delete confirmation');
    await cdp.click('#customConfirmOverlay .yes-confirm-btn');
    await cdp.waitFor('chatMessages.length === 3', 15000, 300, 'active response deleted');
    await sleep(800); // updateChatView + token stats + thread-list refresh

    const dbState = seed.query(dbPath, "SELECT active_leaf_id FROM chat_threads WHERE id='t-badge-321'");
    if (!dbState.length || dbState[0].active_leaf_id !== 'm-321-u2')
      throw new Error('setup: delete did not move active leaf to u2: ' + JSON.stringify(dbState));
    const after = await cdp.eval('document.querySelector("#thread-list .chat-item[data-chat=\\"t-badge-321\\"] .chat-icon img").getAttribute("src")');
    if (String(after).indexOf('openai.ico') < 0)
      throw new Error('sidebar badge did not refresh to model A after delete: before=' + before + ' after=' + after);
    return 'deleted active model-B response; sidebar badge refreshed from ' + JSON.stringify(before) + ' to model A ' + JSON.stringify(after);
  }
});

scenarios.push({
  id: 220,
  name: 'Folder-delete confirmation double-escapes the folder name - _buildFolderSection passes escHtml(folder.name) into _showChatConfirm, which escapes the whole message again, so a folder named "A&B<C>" confirms as "A&amp;amp;B&amp;lt;C&amp;gt;" instead of showing the raw characters',
  regression: true, // FIXED bug #220 kept as a regression check (raw name, escaped exactly once)
  fixtures: {
    folders: [{ id: 'f-220', name: 'A&B<C>' }],
    threads: [{ id: 't-220', title: 'Thread in folder', folder_id: 'f-220' }]
  },
  async body({ cdp }) {
    await cdp.waitFor('document.querySelector("#thread-list .folder") !== null', 15000, 300, 'folder section rendered');
    await cdp.click('#thread-list .folder .folder-delete-btn');
    await cdp.waitFor('document.getElementById("customConfirmOverlay") !== null', 10000, 200, 'confirm overlay');
    const text = await cdp.text('#customConfirmOverlay');
    // FIXED (bug #220): _buildFolderSection passes the RAW name and
    // _showChatConfirm escapes the whole message exactly once, so the visible
    // text reads the raw characters "A&B<C>", not the HTML entities.
    const doubleEscaped = String(text).indexOf('&amp;') >= 0;
    if (doubleEscaped)
      throw new Error('folder name is still double-escaped in the confirm dialog (bug #220 not fixed): ' + JSON.stringify(text));
    const normalized = String(text).replace(/\s+/g, ' ').trim();
    if (normalized.indexOf('Delete folder "A&B<C>"? Chats will become unfiled.') < 0)
      throw new Error('confirm text does not show the raw folder name (bug #220 not fixed): ' + JSON.stringify(normalized));
    // Dismiss the dialog so the run ends in a clean state.
    await cdp.click('#customConfirmOverlay .cancel-confirm-btn');
    return 'confirm text: ' + JSON.stringify(normalized) +
      ' - the folder name renders raw ("A&B<C>"), escaped exactly once';
  }
});

scenarios.push({
  id: 344,
  name: 'Selecting a low sidebar chat must not auto-expand a non-empty collapsed Trash section',
  regression: true,
  mode: null,
  settings: { trash: { retentionDays: 30 } },
  fixtures: {
    threads: [
      { id: 't-trash-disclosure-344', title: 'Deleted chat', is_deleted: 1, deleted_at: '2026-09-11 12:00:00' },
      { id: 't-low-344-01', title: 'Chat 01', updated_at: '2026-09-12 12:01:00' },
      { id: 't-low-344-02', title: 'Chat 02', updated_at: '2026-09-12 12:02:00' },
      { id: 't-low-344-03', title: 'Chat 03', updated_at: '2026-09-12 12:03:00' },
      { id: 't-low-344-04', title: 'Chat 04', updated_at: '2026-09-12 12:04:00' },
      { id: 't-low-344-05', title: 'Chat 05', updated_at: '2026-09-12 12:05:00' },
      { id: 't-low-344-06', title: 'Chat 06', updated_at: '2026-09-12 12:06:00' },
      { id: 't-low-344-07', title: 'Chat 07', updated_at: '2026-09-12 12:07:00' },
      { id: 't-low-344-08', title: 'Chat 08', updated_at: '2026-09-12 12:08:00' },
      { id: 't-low-344-09', title: 'Chat 09', updated_at: '2026-09-12 12:09:00' },
      { id: 't-low-344-10', title: 'Chat 10', updated_at: '2026-09-12 12:10:00' },
      { id: 't-low-344-11', title: 'Chat 11', updated_at: '2026-09-12 12:11:00' },
      { id: 't-low-344-12', title: 'Chat 12', updated_at: '2026-09-12 12:12:00' }
    ]
  },
  async body({ cdp }) {
    await showChat();
    await cdp.waitFor(
      'document.querySelectorAll("#thread-list .chat-item").length >= 12 && document.querySelectorAll(".trash-items .trash-item").length === 1',
      15000, 200, 'sidebar chats and trash rendered'
    );

    await cdp.eval(`(() => {
      const list = document.getElementById('thread-list');
      if (list) list.scrollTop = list.scrollHeight;
      const wrap = document.getElementById('trashWrap');
      if (wrap) wrap.classList.add('collapsed');
      return true;
    })()`);

    const before = await cdp.eval(
      'document.getElementById("trashWrap").classList.contains("collapsed")'
    );
    if (!before)
      throw new Error('setup: Trash was not collapsed before selecting the low chat');

    await cdp.eval(`(() => {
      const items = document.querySelectorAll('#thread-list .chat-item');
      if (!items.length) return false;
      items[items.length - 1].click();
      return true;
    })()`);
    await cdp.waitFor(
      'window.activeThreadId && window.activeThreadId.indexOf("t-low-344-") === 0',
      15000, 200, 'low sidebar chat loaded'
    );
    await sleep(500);

    const state = await cdp.eval(`(() => ({
      collapsed: document.getElementById('trashWrap').classList.contains('collapsed'),
      trashCount: document.querySelectorAll('.trash-items .trash-item').length,
      activeThreadId: window.activeThreadId
    }))()`);
    if (!state.collapsed || state.trashCount !== 1)
      throw new Error('thread refresh changed Trash disclosure state: ' + JSON.stringify(state));

    return 'clicking a low chat refreshed sidebar data without overriding the collapsed Trash disclosure';
  }
});

module.exports = scenarios;
