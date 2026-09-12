// scenarios/chat-ui.js - Chat window UI behavior (streaming, buttons, rendering, editing)
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
const vm = require('node:vm');
const launcher = require('../launch');
const seed = require('../seed');
const { sleep, showChat, sendChatMessage, waitStreamingIdle, runProbe } = require('./helpers');

const scenarios = [];

scenarios.push({
  id: 316,
  name: 'Right-rail system prompt debounce races with an immediate first Send - the first chat request is built before the delayed updateModelSettings IPC arrives',
  regression: true, // FIXED bug #316 kept as a regression check (settings flush before send)
  mode: 'sse-success',
  settings: { threadTitles: { enabled: false } },
  async body({ cdp, mockLog }) {
    await showChat();
    await cdp.waitFor('window.activeThreadId === "" && document.getElementById("sysMsgMini") !== null', 15000, 300, 'fresh empty chat + system prompt field');

    const distinctive = 'IMMEDIATE SYSTEM PROMPT 316';
    // This is deliberately one CDP turn: typing schedules the 300 ms
    // _sendAllSettings timer, and Send is clicked before that timer can fire.
    await cdp.type('#sysMsgMini', distinctive);
    const visible = await cdp.eval('document.getElementById("sysMsgMini").value');
    if (visible !== distinctive)
      throw new Error('setup: typed system prompt is not visible: ' + JSON.stringify(visible));
    await sendChatMessage(cdp, 'send immediately after the right-rail change');
    await waitStreamingIdle(cdp, 30000);

    const lines = fs.readFileSync(mockLog, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
    const first = lines[0];
    if (!first || !first.body)
      throw new Error('setup: no first mock API request was logged; lines=' + lines.length);
    const systemMessages = (first.body.messages || [])
      .filter((message) => message.role === 'system')
      .map((message) => String(message.content || ''));
    const containsTyped = systemMessages.some((content) => content.indexOf(distinctive) >= 0);
    // Fixed behavior: the pending debounced settings update is flushed before
    // chatSend, so the first request must contain the newly typed prompt.
    if (!containsTyped)
      throw new Error('settings update did not reach the first request (bug #316 fix incomplete): ' + JSON.stringify(systemMessages));
    return 'typed ' + JSON.stringify(distinctive) + ' and clicked Send in the same turn; first mock request system messages=' +
      JSON.stringify(systemMessages) + ' (pending updateModelSettings was flushed before chatSend)';
  }
});

scenarios.push({
  id: 317,
  name: 'Two simultaneous message editors cross-contaminate deferred attachment removals - saving A deletes B attachment after B overwrites the global edit state',
  regression: true, // FIXED bug #317 kept as a regression check (removals are editor-scoped)
  mode: null,
  settings: {},
  fixtures: {
    threads: [{ id: 't-att-317', title: 'Two Editors', active_leaf_id: 'm-317-b' }],
    messages: [
      { id: 'm-317-a', thread_id: 't-att-317', role: 'user', content: 'message A', token_count: 2, active_path_tokens: 2 },
      { id: 'm-317-b', thread_id: 't-att-317', role: 'user', content: 'message B', parent_id: 'm-317-a', token_count: 2, active_path_tokens: 4 }
    ]
  },
  async body({ cdp, dataDir, dbPath }) {
    const { DatabaseSync } = require('node:sqlite');
    const attachmentDir = path.join(dataDir, 'attachments');
    fs.mkdirSync(attachmentDir, { recursive: true });
    const attachmentFile = path.join(attachmentDir, 'b-317.txt');
    fs.writeFileSync(attachmentFile, 'attachment owned by message B', 'utf8');
    const db = new DatabaseSync(dbPath);
    db.exec("INSERT INTO message_attachments (id, message_id, attachment_type, file_path, mime_type, original_filename, file_size, extracted_text) VALUES ('att-317-b', 'm-317-b', 'text_file', 'attachments/b-317.txt', 'text/plain', 'b-317.txt', 29, 'attachment owned by message B')");
    db.close();

    await showChat();
    await cdp.waitFor('document.querySelectorAll("#thread-list .chat-item").length > 0', 15000, 300, 'thread list');
    await cdp.click('#thread-list .chat-item');
    await cdp.waitFor('chatMessages.length === 2', 15000, 300, 'two messages loaded');
    await cdp.waitFor('document.querySelector("#chat-messages .msg:nth-child(2) .msg-attachment-delete") !== null', 15000, 300, 'B attachment loaded');
    const before = seed.query(dbPath, "SELECT id, message_id, file_path FROM message_attachments WHERE id='att-317-b'");
    if (before.length !== 1 || !fs.existsSync(attachmentFile))
      throw new Error('setup: B attachment row/file missing before sequence: row=' + JSON.stringify(before) + ' file=' + fs.existsSync(attachmentFile));

    // Open A, then B without closing A. Both editing classes prove the UI
    // coexistence through the normal Edit buttons.
    await cdp.click('#chat-messages .msg:nth-child(1) .msg-action-btn[title="Edit"]');
    await cdp.waitFor('document.querySelector("#chat-messages .msg:nth-child(1)").classList.contains("editing")', 5000, 200, 'A editor open');
    await cdp.click('#chat-messages .msg:nth-child(2) .msg-action-btn[title="Edit"]');
    await cdp.waitFor('document.querySelector("#chat-messages .msg:nth-child(1)").classList.contains("editing") && document.querySelector("#chat-messages .msg:nth-child(2)").classList.contains("editing")', 5000, 200, 'both editors remain open');

    await cdp.click('#chat-messages .msg:nth-child(2) .msg-attachment-delete');
    await cdp.waitFor('document.querySelector("#chat-messages .msg:nth-child(2) .msg-attachment-file").style.display === "none"', 5000, 200, 'B removal deferred');
    const deferred = await cdp.eval('({ editingId: window._editingMessageId, removed: (window._removedAttachmentIds || []).slice() })');
    if (deferred.editingId !== 'm-317-b' || deferred.removed.indexOf('att-317-b') < 0)
      throw new Error('setup: B removal was not selected under B editor: ' + JSON.stringify(deferred));

    // A's original closure still targets A, but commitEdit reads the current
    // global removal list now populated by B.
    await cdp.click('#chat-messages .msg:nth-child(1) .save-overwrite');
    await cdp.waitFor('document.querySelector("#chat-messages .msg:nth-child(1)").classList.contains("editing") === false', 10000, 200, 'A overwrite committed');
    await sleep(500);
    const after = seed.query(dbPath, "SELECT id, message_id, file_path FROM message_attachments WHERE id='att-317-b'");
    const fileExists = fs.existsSync(attachmentFile);
    // Fixed behavior: A's save uses A's own removal list, so B's persisted
    // attachment row and physical file must survive.
    if (after.length !== 1 || after[0].message_id !== 'm-317-b' || !fileExists)
      throw new Error('B attachment was changed by A save (bug #317 fix incomplete): row=' + JSON.stringify(after) + ' file=' + fileExists);
    return 'A and B editors coexisted; B active editor deferred ' + JSON.stringify(deferred.removed) +
      '; saving A preserved B attachment row=' + JSON.stringify(after) + ' and fileExists=' + fileExists;
  }
});

scenarios.push({
  id: 322,
  name: 'Selecting an assistant and sending immediately uses the assistant model',
  regression: true,
  mode: 'sse-success',
  settings: {
    assistants: [{
      id: 'asst-322', name: 'Immediate Assistant', baseModel: 'deepseek/deepseek-v4-flash',
      systemMessage: 'assistant system 322', systemMessageFile: '', description: '', reasoning: 'low', temperature: '0.2'
    }],
    threadTitles: { enabled: false }
  },
  fixtures: {
    threads: [{ id: 't-race-322', title: 'Assistant Send Race', active_leaf_id: 'm-race-322', model_override: 'openai/gpt-5-mini' }],
    messages: [{ id: 'm-race-322', thread_id: 't-race-322', role: 'user', content: 'existing message' }]
  },
  preLaunch(dataDir) {
    const settingsPath = path.join(dataDir, 'settings.json');
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8').replace(/^\uFEFF/, ''));
    settings.newChatStartsWith = 'openai/gpt-5-mini';
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf8');
  },
  async body({ cdp, dbPath, mockLog }) {
    await showChat();
    await cdp.waitFor('document.querySelectorAll("#thread-list .chat-item").length > 0', 15000, 300, 'thread list');
    await cdp.eval('window.loadThread("t-race-322"); true');
    await cdp.waitFor('window.activeThreadId === "t-race-322" && chatMessages.length === 1 && window._currentSettings && window._currentSettings.assistantName === ""', 15000, 300, 'direct-model thread loaded');
    await sleep(600);
    const directModel = await cdp.eval('window._currentSettings.model');
    if (String(directModel).indexOf('gpt-5-mini') < 0)
      throw new Error('setup: thread did not load the direct model: ' + JSON.stringify(directModel));
    // Establish deliberately different direct-model settings, then select the
    // assistant and send before its IPC round-trip can complete.
    await cdp.eval(`(() => {
      const reasoning = document.getElementById('reasoningDropdown');
      reasoning.value = 'high';
      reasoning.dispatchEvent(new Event('change', { bubbles: true }));
      const slider = document.getElementById('tempSlider');
      slider.value = '1.2';
      slider.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);
    await sleep(800);
    await cdp.type('#chat-input', 'send immediately after assistant selection');

    await cdp.click('#modelCardTrigger');
    await cdp.waitFor('document.getElementById("modelPopover").classList.contains("open")', 5000, 200, 'model popover');
    await cdp.waitFor('[...document.querySelectorAll("#tab-assistants .selector-item .si-name")].some(e => e.textContent === "Immediate Assistant")', 10000, 250, 'assistant listed');
    // Keep assistant selection and Send in the same renderer turn. The click
    // must update assistantName synchronously so the settings flush cannot
    // submit the stale direct model.
    await cdp.eval(`(() => {
      const item = [...document.querySelectorAll('#tab-assistants .selector-item')]
        .find((el) => el.querySelector('.si-name') && el.querySelector('.si-name').textContent === 'Immediate Assistant');
      if (!item) return false;
      item.click();
      document.getElementById('chat-send-btn').click();
      return true;
    })()`);
    await cdp.waitFor('typeof streamState !== "undefined" && streamState.active === true', 20000, 100, 'request started');
    await waitStreamingIdle(cdp, 30000);
    await sleep(700);

    const lines = fs.readFileSync(mockLog, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
    const request = lines.find((entry) => entry.body && entry.body.stream === true);
    if (!request) throw new Error('setup: no streaming request logged; lines=' + lines.length);
    const thread = seed.query(dbPath, "SELECT assistant_id FROM chat_threads WHERE id='t-race-322'");
    const systemMessages = (request.body.messages || []).filter((m) => m.role === 'system').map((m) => String(m.content || ''));
    const assistantConfig = request.body.reasoning_effort === 'low' && Number(request.body.temperature) === 0.2;
    if (request.body.model !== 'deepseek-v4-flash' || !thread[0] || thread[0].assistant_id !== 'asst-322' ||
        !systemMessages.some((text) => text.includes('assistant system 322')) || !assistantConfig)
      throw new Error('assistant selection did not win the immediate-send race: model=' +
        JSON.stringify({ model: request.body.model, thread, systemMessages, reasoning: request.body.reasoning_effort, temperature: request.body.temperature }));
    return 'selected Immediate Assistant and sent in one renderer turn; request used assistant model ' +
      JSON.stringify(request.body.model) + ', system prompt/reasoning/temperature=' + JSON.stringify({ system: systemMessages, reasoning: request.body.reasoning_effort, temperature: request.body.temperature }) +
      ' and DB assistant_id=' + JSON.stringify(thread[0].assistant_id);
  }
});

scenarios.push({
  id: 6,
  name: 'Stream failure with no output file shows an error and re-enables the UI',
  regression: true, // FIXED bug kept as a regression check (stream errors must always surface + re-enable)
  mode: null, // refused port -> curl exits before any output file
  settings: {},
  async body({ cdp }) {
    await showChat();
    await sendChatMessage(cdp, 'hello from bug 6');
    await cdp.waitFor('isLoading === true', 8000, 250, 'loading started');
    // FIXED behavior: the connection failure must surface an error banner and
    // re-enable the UI on its own — no Stop press, no stuck loading state.
    await cdp.waitFor('document.querySelectorAll(".error-banner").length > 0', 20000, 300, 'error banner');
    await cdp.waitFor('isLoading === false', 15000, 300, 'UI re-enabled');
    const inputDisabled = await cdp.eval('document.getElementById("chat-input").disabled');
    if (inputDisabled) throw new Error('input still disabled after the error');
    const bannerText = await cdp.text('.error-banner') || '';
    return 'connection failure shows error banner (' + bannerText.trim().slice(0, 60) + ') and re-enables the UI without Stop';
  }
});

scenarios.push({
  id: 12,
  name: 'Suspend banner is rebuilt from current settings on save (static check of the settings-update path)',
  regression: true, // FIXED bug kept as a regression check (banner must keep rebuilding on save)
  mode: null,
  noApp: true,
  async body() {
    // Zero-injection: Main's settings-updated handler must rebuild the banner
    // GUI (the live check sent the CapsLock+backtick suspend hotkey, which can
    // leak into the user's typing). Step 3 of the IPC refactor moved the
    // rebuild into the SettingsService hook registry.
    const mainAhk = fs.readFileSync(path.join(launcher.REPO_ROOT, 'Main.ahk'), 'utf8');
    const sbModule = fs.readFileSync(path.join(launcher.REPO_ROOT, 'app', 'SuspendBanner.ahk'), 'utf8');
    const updStart = mainAhk.indexOf('WM_SETTINGS_UPDATED');
    const reloadStart = mainAhk.indexOf('WM_RELOAD_MAIN');
    const handler = mainAhk.slice(updStart, reloadStart > updStart ? reloadStart : updStart + 1200);
    if (!/SettingsService\.ReloadFromDisk\(\)/.test(handler))
      throw new Error('Main.ahk settings-updated handler does not reload through SettingsService');
    if (!/SettingsService\.RegisterHook\("suspendBanner", _rebuildSuspendBanner\)/.test(mainAhk))
      throw new Error('Main.ahk does not register the suspend banner rebuild hook');
    if (!/suspendBanner\.Destroy\(\)[\s\S]*suspendBanner := Gui\(\)/.test(sbModule))
      throw new Error('SuspendBanner.ahk does not rebuild the GUI from scratch');
    return 'Main.ahk reloads via SettingsService with a registered suspendBanner hook; SuspendBanner.ahk rebuilds from current globals (no key injection)';
  }
});

scenarios.push({
  id: 13,
  name: 'Command Input Window is rebuilt from current settings on save (static check of the settings-update path)',
  regression: true, // FIXED bug kept as a regression check (input window must keep rebuilding on save)
  mode: null,
  noApp: true,
  async body() {
    // Zero-injection: Main's settings-updated handler must rebuild the input
    // window from the current globals (the live check opened it via the
    // backtick menu, which injected keystrokes into the user's desktop).
    const mainAhk = fs.readFileSync(path.join(launcher.REPO_ROOT, 'Main.ahk'), 'utf8');
    const iw = fs.readFileSync(path.join(launcher.REPO_ROOT, 'app', 'InputWindow.ahk'), 'utf8');
    const updStart = mainAhk.indexOf('WM_SETTINGS_UPDATED');
    const reloadStart = mainAhk.indexOf('WM_RELOAD_MAIN');
    const handler = mainAhk.slice(updStart, reloadStart > updStart ? reloadStart : updStart + 1200);
    if (!/SettingsService\.ReloadFromDisk\(\)/.test(handler))
      throw new Error('Main.ahk settings-updated handler does not reload through SettingsService');
    if (!/SettingsService\.RegisterHook\("inputWindow", _rebuildInputWindow\.Bind\(onCommandInputSend(?:,\s*onCommandInputCancel)?\)\)/.test(mainAhk))
      throw new Error('Main.ahk does not register the input window rebuild hook');
    if (!/w" inputWindowWidth " h" inputWindowHeight/.test(iw))
      throw new Error('InputWindow does not apply the configured width/height');
    return 'Main.ahk reloads via SettingsService with a registered inputWindow hook; InputWindow applies width/height from globals (no key injection)';
  }
});

scenarios.push({
  id: 14,
  name: 'Title generation keeps the thread\'s folder label (no hardcoded Unfiled)',
  regression: true, // FIXED bug kept as a regression check (sidebar folder groups must survive title-gen)
  mode: null,
  settings: {},
  async body() {
    // End-to-end title-gen can't run headlessly here: the title-gen request is a
    // NON-stream cURL call, and direct-spawned cURL cannot receive responses from
    // a local mock in this session (streaming works only because AHK Run with the
    // 2> redirection goes through cmd). The bug is statically provable instead.
    const tgen = fs.readFileSync(path.join(launcher.REPO_ROOT, 'chat', 'ThreadTitleGen.ahk'), 'utf8');
    // FIXED: the post must resolve the thread's real folder instead of
    // hardcoding "Unfiled", and no literal "Unfiled" may remain in the post.
    const hardcoded = /folder:\s*"Unfiled"/.test(tgen);
    const resolvesFolder = /folderName[\s\S]*folder:\s*folderName/.test(tgen);
    if (hardcoded) throw new Error('updateTopbarTitle still hardcodes folder "Unfiled"');
    if (!resolvesFolder) throw new Error('updateTopbarTitle does not resolve the thread\'s real folder');
    // FIXED: the threadList refresh must include the folders array so sidebar
    // folder groups don't disappear after title generation.
    const postsFoldersWithList = /postWebMessage\("threadList",\s*\{\s*threads:\s*threads,\s*folders:\s*folders\s*\}/.test(tgen);
    if (!postsFoldersWithList) throw new Error('threadList post after title-gen does not carry the folders array');
    const sidebar = fs.readFileSync(path.join(launcher.REPO_ROOT, 'webui', 'js', 'chat', 'chat-sidebar.js'), 'utf8');
    if (!/data\.folder !== undefined[\s\S]*?_threadMeta\[activeThreadId\]\.folder = data\.folder/.test(sidebar))
      throw new Error('JS does not honor the incoming folder value');
    return 'ThreadTitleGen.ahk posts the real folder and refreshes threadList with folders; chat-sidebar.js stores both correctly';
  }
});

scenarios.push({
  id: 15,
  name: 'Chat topbar Export button downloads the conversation',
  regression: true, // FIXED bug kept as a regression check (Export must keep downloading)
  mode: null,
  settings: {},
  async body({ cdp }) {
    await cdp.waitFor('document.querySelector(\'button[title="Export"]\') !== null', 10000, 250, 'export button');
    // FIXED: the button must have an id + wired handler (previously it had
    // neither), and clicking it must create a download blob.
    const wiring = await cdp.eval(`(() => {
      const btn = document.querySelector('button[title="Export"]');
      return { id: btn.id, exportFn: typeof window.exportChat === 'function' };
    })()`);
    if (wiring.id !== 'export-chat-btn') throw new Error('export button has no id: ' + JSON.stringify(wiring));
    if (!wiring.exportFn) throw new Error('exportChat not defined: ' + JSON.stringify(wiring));
    await cdp.eval(`(() => {
      window.__exportBlobCalls = 0;
      const orig = URL.createObjectURL;
      URL.createObjectURL = function() { window.__exportBlobCalls++; return orig.apply(this, arguments); };
      return true;
    })()`);
    await cdp.click('#export-chat-btn');
    await sleep(400);
    const blobCalls = await cdp.eval('window.__exportBlobCalls');
    if (blobCalls < 1) throw new Error('Export did not create a download blob');
    return 'export button is wired (id=export-chat-btn, handler attached) and clicking it created a download blob';
  }
});

scenarios.push({
  id: 17,
  name: 'System-prompt modal char counter updates while typing',
  regression: true, // FIXED bug kept as a regression check (counter must keep updating)
  mode: null,
  settings: {},
  async body({ cdp }) {
    // FIXED: the counter lives in the chat right-rail system prompt modal
    // (#sysMsgOverlay/#sysMsgFull), opened via #expandSysMsg. Typing must
    // update #charCount (previously nothing wrote to it).
    await showChat();
    await cdp.waitFor('document.getElementById("expandSysMsg") !== null', 10000, 250, 'expand button');
    await cdp.click('#expandSysMsg');
    await cdp.waitFor('document.getElementById("sysMsgOverlay").classList.contains("open")', 5000, 200, 'sysmsg overlay');
    await cdp.type('#sysMsgFull', 'hello world typed by harness');
    const count = await cdp.text('#charCount');
    if (count !== '28 chars') throw new Error('charCount = ' + JSON.stringify(count) + ' (expected 28 chars)');
    return 'after typing 28 chars, #charCount shows "28 chars"';
  }
});

scenarios.push({
  id: 20,
  name: 'Composer + right-rail Web Search toggles are the only tool controls (no Tools dropdown, no Advanced section, no codeExecution)',
  regression: true, // web-search milestone: stubs removed, only web_search remains
  mode: null,
  settings: {},
  async body({ cdp }) {
    await showChat();
    // The composer Tools dropdown and the right-rail Advanced collapsible are
    // gone; the only tool control is the composer Web Search toggle button.
    const dropdown = await cdp.eval('document.querySelector(".tools-dropdown") !== null');
    if (dropdown) throw new Error('composer Tools dropdown still present');
    const hasAdvanced = await cdp.eval('!!document.getElementById("advancedWrap")');
    if (hasAdvanced) throw new Error('right-rail Advanced section still present');
    const hasToggle = await cdp.eval('!!document.getElementById("webSearchToggle")');
    if (!hasToggle) throw new Error('composer Web Search toggle missing');
    const hasRailToggle = await cdp.eval('!!document.getElementById("railWebSearchToggle")');
    if (!hasRailToggle) throw new Error('right-rail Web Search toggle missing');

    await cdp.clearPosted();
    await cdp.click('#railWebSearchToggle');
    // The debounce and host round trip can exceed a fixed sleep when several
    // real-app workers are starting or tearing down WebView2 instances.
    const updateDeadline = Date.now() + 5000;
    let lastAfter = null;
    while (Date.now() < updateDeadline) {
      const after = await cdp.postedMessages();
      lastAfter = after.filter((m) => m.includes('"updateModelSettings"')).pop() || null;
      if (lastAfter) break;
      await sleep(100);
    }
    if (!lastAfter) throw new Error('no updateModelSettings posted after toggling web search');
    const payload = JSON.parse(lastAfter);
    if (payload.webSearch !== true) throw new Error('webSearch not true in updateModelSettings payload: ' + lastAfter);
    if ('codeExecution' in payload) throw new Error('codeExecution stub still in payload: ' + lastAfter);
    // The composer button reflects the same per-thread flag.
    const btnOn = await cdp.eval('document.getElementById("webSearchToggle").classList.contains("on")');
    if (!btnOn) throw new Error('composer toggle not synced with the right-rail switch');
    return 'stubs removed: composer + right-rail Web Search toggles are the only tool controls (no Tools dropdown, no Advanced section, no codeExecution)';
  }
});

scenarios.push({
  id: 21,
  name: 'Reasoning-only responses (thinking, no visible text) get no action buttons',
  regression: true, // FIXED bug kept as a regression check (thinking-only completions must keep getting actions)
  mode: 'sse-reasoning-only',
  settings: {},
  async body({ cdp }) {
    await showChat();
    await sendChatMessage(cdp, 'think only please');
    // The completed bubble stays in the DOM, but onStreamDone nulls the
    // streamState.bubble handle, so wait on the stream being idle instead of
    // requiring the (now-nulled) handle to survive completion.
    await cdp.waitFor('typeof streamState !== "undefined" && !streamState.active && !isLoading', 30000, 300, 'stream done');
    const thinking = await cdp.eval('document.querySelectorAll(".thinking-block").length');
    const lastMsgRole = await cdp.eval('chatMessages[chatMessages.length - 1].role');
    const lastBubbleActions = await cdp.eval(`(() => {
      const bubbles = [...document.querySelectorAll('.msg')];
      const last = bubbles[bubbles.length - 1];
      if (!last || !last.classList.contains('bot')) return -1;
      return last.querySelectorAll('.msg-action-btn').length;
    })()`);
    if (thinking === 0) throw new Error('no thinking block rendered');
    if (lastMsgRole !== 'assistant') throw new Error('assistant message not added to chatMessages: ' + lastMsgRole);
    if (lastBubbleActions === 0) throw new Error('assistant bubble has no action buttons');
    return 'thinking block shown, assistant message added to chatMessages, bubble has ' + lastBubbleActions + ' action buttons';
  }
});

scenarios.push({
  id: 31,
  name: 'Font-size +/- buttons use a stale 17px base after a thread with a custom size loads',
  mode: null,
  regression: true, // FIXED: font-size +/- now syncs cached base after thread load (was 18px)
  settings: {},
  fixtures: {
    threads: [{ id: 't-font-31', title: 'Font Thread', active_leaf_id: 'm-font-31', font_size: 20 }],
    messages: [{ id: 'm-font-31', thread_id: 't-font-31', role: 'user', content: 'hello' }]
  },
  async body({ cdp }) {
    await showChat();
    await cdp.waitFor('document.querySelectorAll("#thread-list .chat-item").length > 0', 15000, 300, 'thread list');
    await cdp.click('#thread-list .chat-item');
    // The thread's per-thread font size (20) arrives via currentSettings and is
    // applied to the CSS var + display, and UiControls.syncFontSize updates the cached base.

    await cdp.waitFor('document.getElementById("font-size-display") && document.getElementById("font-size-display").textContent === "20px"', 15000, 300, 'thread font size applied');
    const before = await cdp.eval('document.getElementById("font-size-display").textContent');
    await cdp.click('#btn-font-inc');
    await sleep(300);
    const after = await cdp.eval('document.getElementById("font-size-display").textContent');
    // FIXED: the + button now correctly bumps 20px -> 21px (was 17px -> 18px stale)
    if (after !== '21px')
      throw new Error('font-size increment did not use thread size: ' + before + ' -> ' + after + ' (expected 21px)');
    return 'after loading a 20px thread, clicking + correctly changed the display from ' + before + ' to ' + after;
  }
});

scenarios.push({
  id: 49,
  name: 'Canceling a message edit rolls back deferred attachment removals',
  regression: true, // FIXED bug kept as a regression check (cancel must not leave attachments half-removed)
  mode: null,
  settings: {},
  fixtures: {
    threads: [{ id: 't-att-49', title: 'Attachment Thread', active_leaf_id: 'm-att-49' }],
    messages: [{ id: 'm-att-49', thread_id: 't-att-49', role: 'user', content: 'with file' }]
  },
  async body({ cdp, dbPath }) {
    // Seed an attachment row (the fixtures builder has no attachments support).
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(dbPath);
    db.exec("INSERT INTO message_attachments (id, message_id, attachment_type, file_path, mime_type, original_filename, file_size, extracted_text) VALUES ('att-49', 'm-att-49', 'text_file', 'attachments/att-49.txt', 'text/plain', 'notes.txt', 12, 'SGVsbG8gd29ybGQ=')");
    db.close();

    await showChat();
    await cdp.waitFor('document.querySelectorAll("#thread-list .chat-item").length > 0', 15000, 300, 'thread list');
    await cdp.click('#thread-list .chat-item');
    await cdp.waitFor('document.querySelectorAll("#chat-messages .msg").length >= 1', 15000, 300, 'thread loaded');
    await sleep(700);
    await cdp.waitFor('document.querySelector(".msg-attachment-file .msg-attachment-delete") !== null', 10000, 300, 'attachment delete btn');
    // Open the editor and remove the attachment (deferred deletion).
    await cdp.click('#chat-messages .msg .msg-action-btn[title="Edit"]');
    await sleep(200);
    await cdp.click('#chat-messages .msg .msg-attachment-delete');
    await sleep(200);
    const hiddenDuringEdit = await cdp.eval(`(() => {
      const w = document.querySelector('.msg-attachment-file');
      return w ? w.style.display : 'no-wrapper';
    })()`);
    const rowDuring = seed.query(dbPath, "SELECT COUNT(*) AS c FROM message_attachments WHERE id='att-49'")[0].c;
    // Cancel the edit.
    await cdp.click('#chat-messages .msg .cancel-edit');
    await sleep(200);
    const hiddenAfterCancel = await cdp.eval(`(() => {
      const w = document.querySelector('.msg-attachment-file');
      return w ? w.style.display : 'no-wrapper';
    })()`);
    const editingId = await cdp.eval('typeof _editingMessageId !== "undefined" ? _editingMessageId : "undef"');
    const rowAfter = seed.query(dbPath, "SELECT COUNT(*) AS c FROM message_attachments WHERE id='att-49'")[0].c;
    // FIXED (bug #49): canceling rolls back the deferred removal (wrapper is
    // restored), clears the edit state, and leaves the DB row untouched.
    if (hiddenAfterCancel === 'none')
      throw new Error('cancel left the attachment hidden (bug #49 not fixed): hidden=' + hiddenAfterCancel);
    if (rowAfter === 0)
      throw new Error('cancel deleted the attachment instead of rolling back: rows=' + rowAfter);
    if (editingId !== null && editingId !== 'undef' && editingId !== '')
      throw new Error('cancel left a stale _editingMessageId=' + JSON.stringify(editingId));
    return 'Edit -> remove attachment -> Cancel: wrapper display=' + hiddenDuringEdit + ' -> ' + hiddenAfterCancel +
      ', DB rows during=' + rowDuring + ' after=' + rowAfter + ', _editingMessageId=' + JSON.stringify(editingId) +
      ' (cancel rolls back the deferred removal)';
  }
});

scenarios.push({
  id: 56,
  name: 'Stopping a stream before the first token is a clean cancel (static check)',
  regression: true, // FIXED bug kept as a regression check (cancel must be checked before the empty-content error branch)
  mode: null,
  noApp: true,
  async body() {
    const sh = fs.readFileSync(path.join(launcher.REPO_ROOT, 'chat', 'streaming', 'StreamHandler.ahk'), 'utf8');
    const se = fs.readFileSync(path.join(launcher.REPO_ROOT, 'chat', 'streaming', 'StreamError.ahk'), 'utf8');
    const finalizePos = sh.indexOf('_finalizeStreaming() {');
    // Slice to the end of _finalizeStreaming (the next function definition).
    // Later bug-#98 comments made the fixed 1200-char slice too short, which
    // hid _handleStreamError and falsely failed this regression check.
    const cleanupPos = sh.indexOf('_cleanupStreamState() {', finalizePos);
    const block = sh.slice(finalizePos, cleanupPos > finalizePos ? cleanupPos : finalizePos + 3000);
    const cancelPos = block.indexOf('_handleStreamCancelled()');
    const errorPos = block.indexOf('_handleStreamError()');
    // FIXED (bug #56): the cancelled branch runs BEFORE the empty-content
    // error branch, so a Stop before the first token is a clean cancel.
    if (cancelPos < 0 || errorPos < 0 || cancelPos > errorPos)
      throw new Error('cancel branch not before the empty-content error branch (bug #56 not fixed): cancelPos=' + cancelPos + ' errorPos=' + errorPos);
    // _handleStreamCancelled posts a clean cancellation for empty content.
    // Bug #171 scoped the payload to the sending thread ({ threadId }),
    // replacing the earlier bare `true` - assert the object-form post (a
    // clean streamCancelled, never a showError banner).
    const cleanCancel = /postWebMessage\("streamCancelled",\s*\{/.test(se);
    if (!cleanCancel)
      throw new Error('_handleStreamCancelled must post a clean streamCancelled for empty content');
    return '_finalizeStreaming checks _streamCancelled before the empty-content branch, so pressing Stop before the first token is a clean cancellation (no API-key banner)';
  }
});

scenarios.push({
  id: 57,
  name: 'Chat message HTML is rendered as inert text (XSS fixed)',
  regression: true, // FIXED bug kept as a regression check (raw HTML in messages must not execute)
  mode: null,
  settings: {},
  fixtures: {
    threads: [{ id: 't-xss-57', title: 'XSS Thread', active_leaf_id: 'm-xss-57' }],
    messages: [{ id: 'm-xss-57', thread_id: 't-xss-57', role: 'assistant', content: '<img src="x" onerror="window.__xssPwned = 1">', model: 'deepseek/deepseek-v4-flash' }]
  },
  async body({ cdp }) {
    await showChat();
    await cdp.waitFor('document.querySelectorAll("#thread-list .chat-item").length > 0', 15000, 300, 'thread list');
    await cdp.click('#thread-list .chat-item');
    await cdp.waitFor('document.querySelectorAll("#chat-messages .msg").length >= 1', 15000, 300, 'thread loaded');
    await sleep(700);
    const pwned = await cdp.eval('window.__xssPwned || 0');
    // FIXED (bug #57): markdown-it is configured with html:false, so raw HTML
    // in messages is escaped and rendered as inert text - the onerror handler
    // must not run.
    if (pwned !== 0)
      throw new Error('inline handler still executed (bug #57 not fixed): pwned=' + pwned);
    const renderedHtml = await cdp.eval('document.querySelector(".msg-content") ? document.querySelector(".msg-content").innerHTML : ""');
    if (String(renderedHtml).indexOf('<img') >= 0)
      throw new Error('raw <img> tag still present in rendered HTML (bug #57 not fixed): ' + JSON.stringify(renderedHtml));
    return 'assistant message <img src="x" onerror=...> rendered inert (window.__xssPwned=0); msg HTML=' + JSON.stringify(renderedHtml);
  }
});

scenarios.push({
  id: 212,
  name: 'The first message in a fresh session discards right-rail selections - handleChatSend auto-creates the thread, then calls _applyNewChatDefault() UNCONDITIONALLY, so a pre-send assistant pick / typed system prompt / temperature is overwritten by the "New Chats Start With" default (since bug #196, "App Default" resolves to the marked default assistant) and the request carries the default assistant\'s system message',
  mode: 'sse-success',
  regression: true, // FIXED bug #212 kept as a regression check (the default only applies to pristine requestParams)
  settings: {},
  async body({ cdp, mockLog }) {
    await showChat();
    await cdp.waitFor('document.getElementById("modelCardTrigger") !== null && typeof window._assistantList !== "undefined"', 15000, 300, 'model card + list');
    await cdp.click('#modelCardTrigger');
    await cdp.waitFor('document.getElementById("modelPopover").classList.contains("open")', 5000, 200, 'popover open');
    await cdp.waitFor('[...document.querySelectorAll("#tab-assistants .selector-item .si-name")].some(e => e.textContent === "Violet")', 10000, 250, 'violet listed');
    await cdp.eval(`(() => {
      const items = [...document.querySelectorAll('#tab-assistants .selector-item')];
      const it = items.find((el) => el.querySelector('.si-name') && el.querySelector('.si-name').textContent === 'Violet');
      if (!it) return false;
      it.click();
      return true;
    })()`);
    await sleep(1500); // switchAssistant round trip
    // Type DIRECTLY into the mini field (no Expand modal), then send.
    await cdp.eval('document.getElementById("sysMsgMini").value = ""');
    await cdp.type('#sysMsgMini', 'DIRECT TYPED MESSAGE');
    await sleep(800);
    const railAfter = await cdp.eval('document.getElementById("sysMsgMini").value');
    if (railAfter !== 'DIRECT TYPED MESSAGE')
      throw new Error('typed message not visible in the rail (setup): ' + JSON.stringify(railAfter));
    await sendChatMessage(cdp, 'hello from direct typing');
    await waitStreamingIdle(cdp, 30000);
    await sleep(500);
    const lines = fs.readFileSync(mockLog, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
    const chatReq = lines.find((e) => e.body && e.body.stream === true);
    if (!chatReq) throw new Error('no streaming chat request was logged; lines=' + lines.length);
    const b = chatReq.body;
    const sysMsg = (b.messages || []).filter((m) => m.role === 'system').map((m) => String(m.content || ''));
    const containsTyped = sysMsg.some((c) => c.indexOf('DIRECT TYPED MESSAGE') >= 0);
    // FIXED (bug #212): handleChatSend only applies the New Chats Start With
    // default when requestParams are pristine, so the typed system prompt (and
    // the Violet selection) survive thread creation and reach the request.
    if (!containsTyped)
      throw new Error('typed system prompt did not reach the request (fix incomplete): ' + JSON.stringify(sysMsg));
    return 'selected Violet + typed "DIRECT TYPED MESSAGE" before the first send; the request system message is the typed text (' +
      JSON.stringify(sysMsg[0] ? sysMsg[0].slice(0, 60) : '(none)') + ') - pre-send right-rail selections survive thread creation';
  }
});

scenarios.push({
  id: 178,
  name: 'SSE `data:` LINE split across poll boundaries silently loses the payload (the remainder arrives without the `data: ` prefix, so SSEParser ignores it)',
  mode: 'sse-split-line',
  regression: true, // FIXED: split data lines are re-formed by the pending-line buffer and all choices accumulate
  settings: {},
  async body({ cdp, dbPath, mockLog }) {
    await showChat();
    await sendChatMessage(cdp, 'split my stream line');
    // The bug leaves the stream active (the partial JSON crashes the poll
    // timer), so wait with a bounded cap instead of failing on the timeout.
    let idle = false;
    try { await waitStreamingIdle(cdp, 25000); idle = true; } catch {}
    await sleep(1200);
    let msgs = [];
    try { msgs = seed.query(dbPath, 'SELECT role, content FROM messages ORDER BY created_at'); } catch {}
    const asst = msgs.find((m) => m.role === 'assistant');
    const content = asst ? asst.content : '';
    const hasNormal = content.indexOf('Hello from the mock LLM.') >= 0;
    const hasSplit = content.indexOf('SPLIT-LEFT') >= 0;
    const diag = await cdp.eval('({ streamState: typeof streamState !== "undefined" ? streamState : null, isLoading: typeof isLoading !== "undefined" ? isLoading : null })').catch(() => ({}));
    const userSent = msgs.some((m) => m.role === 'user');
    if (!userSent)
      throw new Error('send failed (harness issue): ' + JSON.stringify(msgs));
    // FIXED (bug #178): the SPLIT-LEFT-RIGHT event (ONE `data:` line written
    // in two writes with a >poll gap) is re-formed by the stream's
    // pending-line buffer - the incomplete fragment is held across polls and
    // joined with the remainder, so the full payload (including the bare
    // continuation) is persisted and the stream finalizes normally.
    if (!asst)
      throw new Error('assistant message missing (fix incomplete): ' + JSON.stringify(msgs));
    if (!hasSplit || content.indexOf('SPLIT-LEFT-RIGHT') < 0)
      throw new Error('split payload did not survive in full (fix incomplete): ' + JSON.stringify(content));
    if (diag.streamState && diag.streamState.active)
      throw new Error('stream still active after finalize (fix incomplete): ' + JSON.stringify(diag.streamState));
    return 'split-line stream: idle=' + idle + ' streamState.active=' + (diag.streamState ? diag.streamState.active : '?') +
      ', assistant persisted=' + JSON.stringify(content) +
      ' - the split data line was re-formed by the pending-line buffer and its payload survives in full';
  }
});

scenarios.push({
  id: 193,
  name: 'Right-rail temperature 0 is silently dropped when ANY other right-rail setting is re-sent - _sendAllSettings posts temperature: s.temperature || "" (0 is falsy in JS), so typing a system prompt or changing reasoning with a 0 override resets it to default (bug #35/#78 family on the SEND path)',
  mode: null,
  regression: true, // FIXED: numeric temperature 0 survives the re-send (falsy-0 guard)
  noApp: true,
  settings: {},
  async body() {
    const src = fs.readFileSync(path.join(launcher.REPO_ROOT, 'webui', 'js', 'chat', 'model-picker', 'model-picker.js'), 'utf8');
    const posted = [];
    const sandbox = {
      console,
      window: {
        _currentSettings: { temperature: 0, systemMessage: '', reasoning: '', model: '', assistantName: '', codeExecution: false, webSearch: false }
      },
      document: {
        addEventListener() {},
        getElementById: () => null,
        querySelectorAll: () => [],
        querySelector: () => null,
        createElement: () => ({ style: {}, appendChild() {}, addEventListener() {}, querySelectorAll: () => [], querySelector: () => null, getContext() { return {}; } })
      },
      Ipc: { postToHost: (action, payload) => posted.push({ action, payload }) },
      setTimeout,
      clearTimeout,
      navigator: {},
      lucide: { createIcons() {} }
    };
    sandbox.global = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(src, sandbox);
    // Simulate the right-rail re-send after ANY change (e.g. typing into the
    // system prompt field) while the thread's temperature override is 0.
    sandbox._sendAllSettings();
    await new Promise((r) => setTimeout(r, 400));
    const p = posted.find((x) => x.action === 'updateModelSettings');
    if (!p) throw new Error('updateModelSettings was not posted (sandbox issue)');
    // FIXED (bug #193): temperature 0 (a valid override per bug #35/#78) must
    // survive the re-send - only truly empty/absent values become "".
    if (p.payload.temperature !== 0)
      throw new Error('temperature 0 still dropped on re-send (fix incomplete): ' + JSON.stringify(p.payload));
    return '_sendAllSettings with a stored temperature of 0 posted updateModelSettings with temperature=0 - the 0 override survives every other right-rail change (e.g. typing a system prompt), so the next reload keeps 0.0';
  }
});

scenarios.push({
  id: 198,
  name: 'PDF/office attachments with a generic MIME type are misclassified as text_file - getAttachmentTypeFromMime only falls back to the extension for odt/odp/ods/rtf/epub, so a .pdf/.docx/.pptx/.xlsx with application/octet-stream is treated as plain text (no PDF/office extraction, sent as garbled text context)',
  mode: null,
  regression: true, // FIXED bug #198 kept as a regression check
  settings: {},
  async body({ cdp }) {
    await showChat();
    const type = await cdp.eval(`(() => {
      const file = new File([new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2D, 0x31, 0x2E, 0x34])], 'report.pdf', { type: 'application/octet-stream' });
      addAttachment(file);
      const att = attachmentState.length ? attachmentState[0] : null;
      return att ? JSON.stringify({ type: att.type, filename: att.filename, mimeType: att.mimeType }) : 'none';
    })()`);
    const att = JSON.parse(type);
    // FIXED (bug #198): the extension fallback classifies the generic-MIME
    // PDF as pdf so the app extracts text and sends it as a PDF context.
    if (att.type !== 'pdf')
      throw new Error('generic-MIME PDF was not classified by extension (fix incomplete): ' + type);
    if (att.filename !== 'report.pdf')
      throw new Error('setup: filename lost: ' + type);
    return 'File "report.pdf" with MIME application/octet-stream was classified as "' + att.type +
      '" - getAttachmentTypeFromMime now falls back to the extension for pdf/docx/pptx/xlsx, so the PDF is attached as a PDF and extracted';
  }
});

scenarios.push({
  id: 204,
  name: 'A stalled stream never times out - CurlBuilder.BuildStream has --connect-timeout 30 but NO --max-time, so an API that accepts the connection and then sends nothing leaves streamState.active/isLoading true and the Stop/input UI stuck forever',
  mode: null,
  noApp: true,
  regression: true, // FIXED bug #204 kept as a regression check
  settings: {},
  async body() {
    const src = fs.readFileSync(path.join(launcher.REPO_ROOT, 'api', 'CurlBuilder.ahk'), 'utf8');
    const streamIdx = src.indexOf('static BuildStream(');
    const block = streamIdx >= 0 ? src.slice(streamIdx, streamIdx + 900) : '';
    const hasMaxTime = /--max-time 120/.test(block);
    // FIXED (bug #204): the streaming command now carries --max-time 120, so
    // a stalled upstream eventually exits and the stream error path re-enables
    // the UI (the sse-hang mock stays in mock-llm-server.js as a harness mode).
    if (!hasMaxTime)
      throw new Error('BuildStream still lacks --max-time (fix incomplete): ' + block);
    return 'CurlBuilder.BuildStream now includes --max-time 120 alongside --connect-timeout 30 - a stalled upstream cannot hang the chat UI forever';
  }
});

scenarios.push({
  id: 208,
  name: 'Streaming bubble author label injects assistant/model names as raw HTML (XSS) - createStreamingBubble concatenates displayName into innerHTML without escaping, so an assistant named <img onerror=...> executes in the WebView',
  mode: 'sse-success',
  regression: true, // FIXED bug #208 kept as a regression check (the author label is now escHtml'd)
  settings: {
    // The assistant name carries the payload. It flows settings.json -> the
    // AHK streamModelName post (displayName = asst.name) -> streamState.modelName
    // -> createStreamingBubble's innerHTML.
    assistants: [{
      id: 'asst-xss-208',
      name: '<img src="x" onerror="window.__xssPwned=1">',
      baseModel: 'deepseek/deepseek-v4-flash',
      systemMessage: '',
      systemMessageFile: '',
      description: '',
      reasoning: '',
      temperature: '',
      isDefault: false
    }]
  },
  fixtures: {
    threads: [{ id: 't-xss-208', title: 'XSS Thread', active_leaf_id: 'm-xss-208', assistant_id: 'asst-xss-208' }],
    messages: [{ id: 'm-xss-208', thread_id: 't-xss-208', role: 'user', content: 'hello' }]
  },
  async body({ cdp }) {
    await showChat();
    await cdp.waitFor('document.querySelectorAll("#thread-list .chat-item").length > 0', 15000, 300, 'thread list');
    await cdp.click('#thread-list .chat-item');
    await cdp.waitFor('document.querySelectorAll("#chat-messages .msg").length >= 1', 15000, 300, 'thread loaded');
    await sleep(500); // let the assistant/thread settings round-trip finish
    await sendChatMessage(cdp, 'stream for me');
    await waitStreamingIdle(cdp, 30000);
    await sleep(500);
    const pwned = await cdp.eval('window.__xssPwned || 0');
    const authorHtml = await cdp.eval(`(() => {
      const bubbles = [...document.querySelectorAll('.msg.bot')];
      const last = bubbles[bubbles.length - 1];
      if (!last) return '';
      const a = last.querySelector('.msg-author');
      return a ? a.innerHTML : '';
    })()`);
    const authorText = await cdp.eval(`(() => {
      const bubbles = [...document.querySelectorAll('.msg.bot')];
      const last = bubbles[bubbles.length - 1];
      if (!last) return '';
      const a = last.querySelector('.msg-author');
      return a ? a.textContent : '';
    })()`);
    // FIXED (bug #208): the assistant name is escaped before innerHTML, so
    // the <img> tag is inert text - the onerror handler must NOT run, no raw
    // <img> may appear in the author label, and the name is still visible as
    // text (textContent carries the literal markup).
    if (pwned !== 0)
      throw new Error('inline handler still executed (bug #208 not fixed): pwned=' + pwned);
    if (String(authorHtml).indexOf('<img') >= 0)
      throw new Error('raw <img> tag still present in the author label (bug #208 not fixed): ' + JSON.stringify(authorHtml));
    if (String(authorText).indexOf('<img') < 0)
      throw new Error('author label lost the name text (should render as inert text): ' + JSON.stringify(authorText));
    return 'assistant name <img src="x" onerror=...> rendered inert in the streaming bubble (window.__xssPwned=0); author innerHTML=' + JSON.stringify(authorHtml) +
      ' textContent=' + JSON.stringify(authorText) + ' - the author label is escaped like every other bubble';
  }
});

scenarios.push({
  id: 213,
  name: 'Font-size adjustments made before the first message are silently dropped - handleUpdateFontSize only persists when activeThreadId exists, so a font change on a fresh (no-thread) chat never reaches requestParams and the auto-created thread saves the default 17px',
  mode: null,
  regression: true, // FIXED bug #213 kept as a regression check (pre-send font size survives thread creation)
  settings: {},
  fixtures: {}, // no threads -> fresh empty app state
  async body({ cdp, dbPath }) {
    await showChat();
    await cdp.waitFor('document.getElementById("font-size-display") !== null && window.activeThreadId === ""', 15000, 300, 'fresh empty chat');
    // Bump the font size while NO thread exists (topbar controls are always
    // visible). The + click posts updateFontSize, which handleUpdateFontSize
    // drops because activeThreadId is empty.
    await cdp.click('#btn-font-inc');
    await sleep(500);
    const displayAfter = await cdp.eval('document.getElementById("font-size-display").textContent');
    if (displayAfter !== '18px')
      throw new Error('setup: the + button did not bump the display to 18px: ' + JSON.stringify(displayAfter));
    // Send the first message -> handleChatSend auto-creates the thread and
    // calls _saveCurrentSettingsToThread, which reads requestParams["fontSize"].
    await sendChatMessage(cdp, 'first message');
    await cdp.waitFor('window.activeThreadId !== ""', 15000, 300, 'thread auto-created');
    await sleep(900);
    const threadId = await cdp.eval('window.activeThreadId');
    const rows = seed.query(dbPath, 'SELECT font_size FROM chat_threads WHERE id=?', [threadId]);
    if (!rows.length) throw new Error('setup: thread row missing: ' + threadId);
    const savedFont = Number(rows[0].font_size);
    // FIXED (bug #213): handleUpdateFontSize stores the size in requestParams
    // even with no active thread, so the auto-created thread keeps the
    // user's pre-send 18px adjustment instead of falling back to 17px.
    if (savedFont !== 18)
      throw new Error('font size was dropped on the auto-created thread (bug #213 not fixed): font_size=' + savedFont + ' expected 18');
    return 'bumped the font to 18px with NO active thread, then sent the first message: the auto-created thread ' + threadId +
      ' saved font_size=' + savedFont + ' - the pre-send 18px adjustment survives thread creation';
  }
});

scenarios.push({
  id: 214,
  name: 'Switching branches mid-stream re-enables the composer (setChatButtonsEnabled(true) inside updateChatMessages) - the user can send a SECOND request while the first stream is still in flight, and the second send clobbers the shared requestParams stream state so the first (billed) response is never persisted or logged',
  mode: 'sse-slow',
  regression: true, // FIXED bug #214 kept as a regression check (composer stays disabled mid-stream)
  settings: {},
  fixtures: {
    threads: [{ id: 't-mid-214', title: 'Mid-Stream Branch', active_leaf_id: 'm-214-a1' }],
    messages: [
      { id: 'm-214-u1', thread_id: 't-mid-214', role: 'user', content: 'root question', token_count: 5, active_path_tokens: 5 },
      { id: 'm-214-a1', thread_id: 't-mid-214', role: 'assistant', content: 'branch A answer', model: 'deepseek/deepseek-v4-flash', parent_id: 'm-214-u1', sibling_group: 'sg-214', sibling_index: 0, token_count: 5, prompt_tokens: 10, active_path_tokens: 15 },
      { id: 'm-214-a2', thread_id: 't-mid-214', role: 'assistant', content: 'branch B answer', model: 'deepseek/deepseek-v4-flash', parent_id: 'm-214-u1', sibling_group: 'sg-214', sibling_index: 1, token_count: 5, prompt_tokens: 10, active_path_tokens: 15 }
    ]
  },
  async body({ cdp, dbPath, mockLog }) {
    await showChat();
    await cdp.waitFor('document.querySelectorAll("#thread-list .chat-item").length > 0', 15000, 300, 'thread list');
    await cdp.click('#thread-list .chat-item');
    await cdp.waitFor('chatMessages.length >= 2 && chatMessages[1] && chatMessages[1].id === "m-214-a1"', 15000, 300, 'branch A loaded');
    await sleep(600);
    await sendChatMessage(cdp, 'follow-up on A');
    await cdp.waitFor('typeof streamState !== "undefined" && streamState.active === true', 20000, 50, 'streaming active');
    await sleep(150);
    // Switch to the sibling branch while A's stream is in flight (same flow
    // as the branch-nav arrows on the assistant bubble).
    await cdp.click('#chat-messages .msg:nth-child(2) .msg-action-btn[title="Next branch"]');
    await cdp.waitFor('chatMessages.length >= 2 && chatMessages[1] && chatMessages[1].id === "m-214-a2"', 15000, 300, 'branch B loaded');
    await sleep(300);
    // The first stream must STILL be in flight at this point.
    const state = await cdp.eval(`(() => ({
      streamActive: (typeof streamState !== 'undefined' && streamState.active) || false,
      inputDisabled: document.getElementById('chat-input').disabled,
      isLoading: (typeof isLoading !== 'undefined' && isLoading) || false,
      btnOnclick: (function(){ var b = document.getElementById('chat-send-btn'); if (!b || !b.onclick) return 'none'; if (b.onclick === onStopStreaming) return 'stop'; if (b.onclick === onChatSend) return 'send'; return 'other'; })()
    }))()`);
    if (!state.streamActive)
      throw new Error('setup: first stream already finished before the state check (timing)');
    // FIXED (bug #214): updateChatMessages must NOT re-enable the composer
    // mid-stream - the input stays disabled, isLoading stays true, and the
    // button stays wired to Stop, so a second send is impossible.
    if (!state.inputDisabled || !state.isLoading || state.btnOnclick !== 'stop')
      throw new Error('composer was re-enabled after the branch switch mid-stream (bug #214 not fixed): ' + JSON.stringify(state));
    // The first stream must now complete untouched (no second request ever
    // fired), and its billed response must be persisted.
    await waitStreamingIdle(cdp, 40000);
    await sleep(800);
    const reEnabled = await cdp.eval('document.getElementById("chat-input").disabled === false && (typeof isLoading !== "undefined" && !isLoading)');
    if (!reEnabled)
      throw new Error('composer was not re-enabled after the stream completed: ' + reEnabled);
    // Regression: the first request's response IS persisted - an assistant
    // row is parented to the "follow-up on A" user message, and no "second
    // message on B" was ever created.
    const followUpId = seed.query(dbPath, "SELECT id FROM messages WHERE thread_id='t-mid-214' AND content='follow-up on A'")[0];
    const firstResp = seed.query(dbPath, "SELECT COUNT(*) AS c FROM messages WHERE thread_id='t-mid-214' AND role='assistant' AND parent_id=?", [followUpId ? followUpId.id : 'nope'])[0].c;
    const secondResp = seed.query(dbPath, "SELECT COUNT(*) AS c FROM messages WHERE thread_id='t-mid-214' AND role='assistant' AND parent_id IN (SELECT id FROM messages WHERE thread_id='t-mid-214' AND content='second message on B')")[0].c;
    if (firstResp !== 1)
      throw new Error('the first streamed response was not persisted (bug #214 not fixed): firstResp=' + firstResp);
    if (secondResp !== 0)
      throw new Error('a second message was sent while the first stream was in flight (bug #214 not fixed): secondResp=' + secondResp);
    return 'branch switch mid-stream kept the composer disabled (inputDisabled=' + state.inputDisabled +
      ' isLoading=' + state.isLoading + ' btn=' + state.btnOnclick + '); the first stream completed and its ' +
      'response was persisted (firstResp=' + firstResp + '), no second message was created (secondResp=' + secondResp + ')';
  }
});

scenarios.push({
  id: 215,
  name: 'Switching to an unanswered thread while another chat generates keeps the visible thread free of foreign loading/composer state',
  mode: 'sse-slow',
  regression: true, // Thread-scoped generation: background A must not show loading state in idle B.
  settings: {},
  fixtures: {
    threads: [
      { id: 't-ui-a-215', title: 'Thread A', active_leaf_id: 'm-215-u1a' },
      { id: 't-ui-b-215', title: 'Thread B (unanswered)', active_leaf_id: 'm-215-u1b' }
    ],
    messages: [
      { id: 'm-215-u1a', thread_id: 't-ui-a-215', role: 'user', content: 'question for A', token_count: 5, active_path_tokens: 5 },
      { id: 'm-215-u1b', thread_id: 't-ui-b-215', role: 'user', content: 'question for B (no answer yet)', token_count: 5, active_path_tokens: 5 }
    ]
  },
  async body({ cdp, dbPath }) {
    await showChat();
    await cdp.waitFor('document.querySelectorAll("#thread-list .chat-item").length >= 2', 15000, 300, 'thread list');
    await cdp.eval('window.loadThread("t-ui-a-215"); true');
    await cdp.waitFor('window.activeThreadId === "t-ui-a-215"', 15000, 300, 'thread A loaded');
    await sleep(600);
    await sendChatMessage(cdp, 'question for A');
    await cdp.waitFor('typeof streamState !== "undefined" && streamState.active === true', 20000, 50, 'streaming active');
    await sleep(150);

    await cdp.eval('window.loadThread("t-ui-b-215"); true');
    await cdp.waitFor('window.activeThreadId === "t-ui-b-215"', 15000, 300, 'thread B loaded');
    await sleep(400);

    const dotsDuring = await cdp.eval('document.getElementById("chat-loading") !== null');
    const bStateDuring = await cdp.eval(`(() => ({
      aBusy: typeof isThreadRequestInFlight === 'function' && isThreadRequestInFlight('t-ui-a-215'),
      bBusy: typeof isThreadRequestInFlight === 'function' && isThreadRequestInFlight('t-ui-b-215'),
      inputDisabled: document.getElementById('chat-input').disabled,
      isLoading: (typeof isLoading !== 'undefined' && isLoading) || false,
      btnOnclick: (function(){ var b = document.getElementById('chat-send-btn'); if (!b || !b.onclick) return 'none'; if (b.onclick === onStopStreaming) return 'stop'; if (b.onclick === onChatSend) return 'send'; return 'other'; })()
    }))()`);

    if (!bStateDuring.aBusy || bStateDuring.bBusy || bStateDuring.inputDisabled || bStateDuring.isLoading || bStateDuring.btnOnclick !== 'send')
      throw new Error('idle B inherited A generation state: ' + JSON.stringify(bStateDuring));
    if (dotsDuring)
      throw new Error('background thread A leaked loading dots into idle B: ' + dotsDuring);

    await waitStreamingIdle(cdp, 40000);
    await sleep(700);

    const dotsAfter = await cdp.eval('document.getElementById("chat-loading") !== null');
    const streamIdle = await cdp.eval('typeof streamState !== "undefined" && !streamState.active');
    if (!streamIdle) throw new Error('setup: stream never went idle');
    if (dotsAfter)
      throw new Error('loading indicator is still visible after the background stream completed');

    return 'switched to unanswered thread B while A generated: foreign loading dots=' + dotsDuring +
      ', B stayed Send-enabled while A was busy=' + (bStateDuring.btnOnclick === 'send') +
      ', and remained free of loading dots after A completed=' + !dotsAfter;
  }
});

scenarios.push({
  id: 216,
  name: 'A failed retry restores the removed messages into WHATEVER thread is currently visible - restoreRetryMessagesOnError pushes _retryRemovedMessages (thread A\'s messages) into the global chatMessages array, so switching to thread B before the retry fails repaints A\'s assistant message into B\'s UI (the DB rows stay correct in A, the same class as bug #195 on the error path)',
  mode: 'sse-lateerror',
  regression: true, // FIXED bug #216 kept as a regression check (restore is scoped to the retry thread/path)
  settings: {},
  fixtures: {
    threads: [
      { id: 't-retry-a-216', title: 'Thread A', active_leaf_id: 'm-216-a1' },
      { id: 't-retry-b-216', title: 'Thread B', active_leaf_id: 'm-216-u1b' }
    ],
    messages: [
      { id: 'm-216-u1', thread_id: 't-retry-a-216', role: 'user', content: 'root question', token_count: 5, active_path_tokens: 5 },
      { id: 'm-216-a1', thread_id: 't-retry-a-216', role: 'assistant', content: 'first answer', model: 'deepseek/deepseek-v4-flash', parent_id: 'm-216-u1', token_count: 9, prompt_tokens: 12, active_path_tokens: 21 },
      { id: 'm-216-u1b', thread_id: 't-retry-b-216', role: 'user', content: 'question for B', token_count: 5, active_path_tokens: 5 }
    ]
  },
  async body({ cdp, dbPath }) {
    await showChat();
    await cdp.waitFor('document.querySelectorAll("#thread-list .chat-item").length >= 2', 15000, 300, 'thread list');
    await cdp.eval('window.loadThread("t-retry-a-216"); true');
    await cdp.waitFor('window.activeThreadId === "t-retry-a-216" && chatMessages.length >= 2', 15000, 300, 'thread A loaded');
    await sleep(600);
    // Retry the assistant message: the UI removes a1 from A's array and
    // stashes it in _retryRemovedMessages; the retry request starts streaming
    // against the mock (sse-lateerror) and will fail ~1.5s later.
    await cdp.click('#chat-messages .msg:nth-child(2) .msg-action-btn[title="Retry"]');
    await cdp.waitFor('chatMessages.length === 1 && chatMessages[0].id === "m-216-u1"', 15000, 300, 'retry removed a1');
    // The retry request is dispatched (buttons disabled / isLoading). The mock
    // mode sse-lateerror never emits content, so streamState.active stays
    // false - the failure arrives ~1.5s later with no content/reasoning.
    await cdp.waitFor('typeof isLoading !== "undefined" && isLoading === true', 20000, 50, 'retry in flight');
    // Switch to thread B BEFORE the retry fails.
    await cdp.eval('window.loadThread("t-retry-b-216"); true');
    await cdp.waitFor('window.activeThreadId === "t-retry-b-216"', 15000, 300, 'thread B loaded');
    await sleep(300);
    // Wait for the retry to finish. The error belongs to thread A and is
    // queued there; it must not render in thread B after error scoping.
    await cdp.waitFor('typeof isLoading !== "undefined" && isLoading === false && typeof streamState !== "undefined" && streamState.active === false', 20000, 200, 'retry finished');
    await sleep(600);
    const uiMsgs = await cdp.eval('chatMessages.map(function(m){ return m.id + ":" + m.content; })');
    const stillOnB = await cdp.eval('window.activeThreadId === "t-retry-b-216"');
    const a1inB = String(uiMsgs.join('|')).indexOf('first answer') >= 0;
    // FIXED (bug #216): the restore is scoped to the retry's thread/path, so
    // thread A's messages must NOT appear in thread B's visible UI.
    if (!stillOnB)
      throw new Error('setup: not on thread B anymore: ' + stillOnB);
    if (a1inB)
      throw new Error('restored thread-A messages still pollute thread B (bug #216 not fixed): ui=' + JSON.stringify(uiMsgs));
    // Sanity: the DB row for a1 still belongs to thread A only.
    const a1Rows = seed.query(dbPath, "SELECT thread_id FROM messages WHERE content='first answer'");
    const dbThreads = a1Rows.map((r) => r.thread_id);
    const a1OnlyInA = dbThreads.length === 1 && dbThreads[0] === 't-retry-a-216';
    if (!a1OnlyInA)
      throw new Error('DB sanity failed: "first answer" must live in thread A only: ' + JSON.stringify(dbThreads));
    return 'retried a1 in A, switched to B, then the retry failed: B\'s UI array is ' + JSON.stringify(uiMsgs) +
      ' (thread A\'s "first answer" is NOT in the visible thread B) while the DB row stays in ' +
      JSON.stringify(dbThreads) + ' - restoreRetryMessagesOnError is scoped to the retry thread';
  }
});

scenarios.push({
  id: 217,
  name: 'Deleting ANOTHER message\'s attachment while editing a message defers the wrong attachment to the edit commit - setupMessageAttachmentDeleteDelegation pushes any clicked attachment id into the GLOBAL _removedAttachmentIds (never checking it belongs to _editingMessageId), so overwrite-committing message 1\'s edit hard-deletes message 2\'s attachment row from the DB',
  mode: null,
  regression: true, // FIXED bug #217 kept as a regression check (only the edited message's attachments defer)
  settings: {},
  fixtures: {
    threads: [{ id: 't-att-217', title: 'Attachment Edit', active_leaf_id: 'm-217-u2' }],
    messages: [
      { id: 'm-217-u1', thread_id: 't-att-217', role: 'user', content: 'message one' },
      { id: 'm-217-u2', thread_id: 't-att-217', role: 'user', content: 'message two', parent_id: 'm-217-u1' }
    ]
  },
  async body({ cdp, dbPath }) {
    // Seed one attachment on EACH user message.
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(dbPath);
    db.exec("INSERT INTO message_attachments (id, message_id, attachment_type, file_path, mime_type, original_filename, file_size, extracted_text) VALUES ('att-217-a', 'm-217-u1', 'text_file', 'attachments/a.txt', 'text/plain', 'a.txt', 12, ''), ('att-217-b', 'm-217-u2', 'text_file', 'attachments/b.txt', 'text/plain', 'b.txt', 12, '')");
    db.close();

    await showChat();
    await cdp.waitFor('document.querySelectorAll("#thread-list .chat-item").length > 0', 15000, 300, 'thread list');
    await cdp.click('#thread-list .chat-item');
    await cdp.waitFor('document.querySelectorAll("#chat-messages .msg").length >= 2', 15000, 300, 'thread loaded');
    await sleep(700);
    // Edit message 1.
    await cdp.click('#chat-messages .msg:nth-child(1) .msg-action-btn[title="Edit"]');
    await sleep(250);
    // While editing message 1, click the attachment X on message 2. The
    // delegated handler must scope the deferral to the edited message: an X
    // on a different bubble is neither deferred nor deleted (bug #217).
    await cdp.click('#chat-messages .msg:nth-child(2) .msg-attachment-delete');
    await sleep(250);
    const removedList = await cdp.eval('JSON.stringify(window._removedAttachmentIds || [])');
    if (String(removedList).indexOf('att-217-b') >= 0)
      throw new Error('setup: another message\'s attachment was still deferred: ' + removedList);
    // Commit message 1's edit (overwrite).
    await cdp.click('#chat-messages .msg:nth-child(1) .save-overwrite');
    await sleep(900);
    const rows = seed.query(dbPath, "SELECT id, message_id FROM message_attachments ORDER BY id");
    const ids = rows.map((r) => r.id);
    // FIXED (bug #217): the X on message 2's attachment is scoped out of the
    // edit - it is neither deferred into _removedAttachmentIds nor deleted,
    // so overwrite-committing message 1's edit leaves message 2's attachment
    // row untouched.
    if (String(removedList).indexOf('att-217-b') >= 0)
      throw new Error('another message\'s attachment was still deferred into the edit (bug #217 not fixed): ' + removedList);
    if (ids.indexOf('att-217-b') < 0)
      throw new Error('message 2 attachment was deleted by message 1\'s edit commit (bug #217 not fixed): ' + JSON.stringify(ids));
    if (ids.indexOf('att-217-a') < 0)
      throw new Error('message 1 attachment unexpectedly deleted: ' + JSON.stringify(ids));
    return 'edited message 1, clicked the X on message 2\'s attachment (deferred list stays ' + removedList +
      '), then overwrite-committed: the DB still holds ' + JSON.stringify(ids) +
      ' - only the edited message\'s attachments are affected by the edit';
  }
});

scenarios.push({
  id: 218,
  name: 'Switching threads mid-generation keeps the new thread independently sendable instead of inheriting the old thread Stop state',
  mode: 'sse-slow',
  regression: true, // Thread-scoped generation: A busy must not put idle B into Stop mode.
  settings: {},
  fixtures: {
    threads: [
      { id: 't-ui-a-218', title: 'Thread A', active_leaf_id: 'm-218-u1a' },
      { id: 't-ui-b-218', title: 'Thread B (answered)', active_leaf_id: 'm-218-a1b' }
    ],
    messages: [
      { id: 'm-218-u1a', thread_id: 't-ui-a-218', role: 'user', content: 'question for A', token_count: 5, active_path_tokens: 5 },
      { id: 'm-218-u1b', thread_id: 't-ui-b-218', role: 'user', content: 'question for B', token_count: 5, active_path_tokens: 5 },
      { id: 'm-218-a1b', thread_id: 't-ui-b-218', role: 'assistant', content: 'B answer', model: 'deepseek/deepseek-v4-flash', parent_id: 'm-218-u1b', token_count: 5, prompt_tokens: 10, active_path_tokens: 15 }
    ]
  },
  async body({ cdp }) {
    await showChat();
    await cdp.waitFor('document.querySelectorAll("#thread-list .chat-item").length >= 2', 15000, 300, 'thread list');
    await cdp.eval('window.loadThread("t-ui-a-218"); true');
    await cdp.waitFor('window.activeThreadId === "t-ui-a-218"', 15000, 300, 'thread A loaded');
    await sleep(600);
    await sendChatMessage(cdp, 'question for A');
    await cdp.waitFor('typeof streamState !== "undefined" && streamState.active === true', 20000, 50, 'streaming active');
    await sleep(150);

    await cdp.eval('window.loadThread("t-ui-b-218"); true');
    await cdp.waitFor('window.activeThreadId === "t-ui-b-218" && chatMessages.length >= 2', 15000, 300, 'thread B loaded');
    await sleep(400);

    const state = await cdp.eval(`(() => ({
      streamActive: (typeof streamState !== 'undefined' && streamState.active) || false,
      inputDisabled: document.getElementById('chat-input').disabled,
      isLoading: (typeof isLoading !== 'undefined' && isLoading) || false,
      btnOnclick: (function(){ var b = document.getElementById('chat-send-btn'); if (!b || !b.onclick) return 'none'; if (b.onclick === onStopStreaming) return 'stop'; if (b.onclick === onChatSend) return 'send'; return 'other'; })()
    }))()`);

    const aBusy = await cdp.eval('typeof isThreadRequestInFlight === "function" && isThreadRequestInFlight("t-ui-a-218")');
    if (!aBusy)
      throw new Error('setup: thread A request finished before the state check');
    if (state.streamActive || state.inputDisabled || state.isLoading || state.btnOnclick !== 'send')
      throw new Error('idle B inherited A generation state: ' + JSON.stringify(state));

    await cdp.eval('if (window.__posted) window.__posted.length = 0;');
    await cdp.eval(`(() => {
      const input = document.getElementById('chat-input');
      input.value = 'second message';
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      return true;
    })()`);
    await sleep(500);

    const posted = await cdp.eval('(window.__posted || []).slice()');
    const secondSendPosted = posted.some((m) => String(m).indexOf('"chatSend"') >= 0 || String(m).indexOf('chatSend') >= 0);
    if (!secondSendPosted || posted.some((m) => String(m).indexOf('cancelStream') >= 0))
      throw new Error('idle B did not send independently while A was in flight: ' + JSON.stringify(posted));

    await waitStreamingIdle(cdp, 40000);
    return 'switched to assistant-ended thread B while A generated: B stayed Send-enabled (inputDisabled=' + state.inputDisabled +
      ' isLoading=' + state.isLoading + ' btn=' + state.btnOnclick + '); Enter posted ' +
      JSON.stringify(posted) + ' (chatSend, never cancel) while A remained active in the background';
  }
});

scenarios.push({
  id: 224,
  name: 'User message bubbles also collapse SINGLE-newline paragraph breaks - _prepUserContent only converts 3+ newlines to <br>, so a multi-paragraph message (or a pasted selection) whose paragraphs are separated by single newlines renders as ONE block in the user\'s own bubble (the mirror of bug #222 on the user side)',
  mode: 'sse-success',
  regression: true, // FIXED bug #224 kept as a regression check (single-newline paragraph breaks stay visible in user bubbles)
  settings: {},
  async body({ cdp }) {
    await cdp.type('#chat-input', 'First paragraph of the selection.\nSecond paragraph of the selection.\nThird paragraph of the selection.');
    await cdp.click('#chat-send-btn');
    // The user bubble renders as soon as the message is appended.
    await cdp.waitFor('document.querySelector(".msg.you .msg-content") !== null', 10000, 250, 'user bubble');
    await sleep(400);
    const pCount = await cdp.eval('document.querySelectorAll(".msg.you .msg-content p").length');
    const innerText = await cdp.eval('document.querySelector(".msg.you .msg-content").innerText');
    const html = await cdp.eval('document.querySelector(".msg.you .msg-content").innerHTML');
    const hasBreak = /<br\s*\/?>/i.test(String(html));
    // FIXED (bug #224): markdown-it renders soft breaks (single newlines) as
    // <br> (breaks:true), so the multi-paragraph message keeps its breaks.
    if (!hasBreak && pCount < 2)
      throw new Error('user paragraphs are still collapsed into one block (bug #224 not fixed): pCount=' + pCount + ' html=' + JSON.stringify(html));
    return 'user sent 3 paragraphs separated by single newlines; user bubble pCount=' + pCount +
      (hasBreak ? ' (with <br>)' : ' (no <br>)') +
      ' innerText=' + JSON.stringify(String(innerText).replace(/\s+/g, ' ')) +
      ' - the paragraph breaks stay visible';
  }
});

scenarios.push({
  id: 222,
  name: 'Assistant responses whose paragraphs are separated by SINGLE newlines render as ONE block - chat-render.js md.render() never normalizes assistant content (unlike _prepUserContent for users), and markdown-it emits one <p> with soft breaks that CSS collapses to spaces, so a summarize-style response split into paragraphs by single newlines displays as a block of text',
  mode: 'sse-paragraphs',
  regression: true, // FIXED bug #222 kept as a regression check (single-newline paragraph breaks stay visible in assistant bubbles)
  settings: {},
  async body({ cdp }) {
    await sendChatMessage(cdp, 'Please summarize this article.');
    // The mock streams three chunks whose paragraph breaks are SINGLE
    // newlines (a common summarize-style LLM output shape).
    await cdp.waitFor('document.querySelector(".msg.bot .msg-content") !== null', 30000, 300, 'assistant bubble rendered');
    await waitStreamingIdle(cdp, 30000);
    await sleep(500);
    const pCount = await cdp.eval('document.querySelectorAll(".msg.bot .msg-content p").length');
    const innerText = await cdp.eval('document.querySelector(".msg.bot .msg-content").innerText');
    const html = await cdp.eval('document.querySelector(".msg.bot .msg-content").innerHTML');
    const hasBreak = /<br\s*\/?>/i.test(String(html));
    // FIXED (bug #222): markdown-it renders soft breaks (single newlines) as
    // <br> (breaks:true), so the summary keeps its paragraph breaks.
    if (!hasBreak && pCount < 2)
      throw new Error('single-newline paragraph breaks are still collapsed (bug #222 not fixed): pCount=' + pCount + ' html=' + JSON.stringify(html));
    return 'mock returned 3 paragraphs separated by single newlines; rendered pCount=' + pCount +
      (hasBreak ? ' (with <br>)' : ' (no <br>)') + ' innerText=' + JSON.stringify(String(innerText).replace(/\s+/g, ' ')) +
      ' - the paragraph breaks stay visible (soft breaks render as <br>)';
  }
});

scenarios.push({
  id: 219,
  name: 'Mid-stream SSE error event (`data: {"error": ...}`) crashes SSEParser.ParseLine - parsed["choices"] throws on a Map without a "choices" key, so the partial streamed response is never persisted, the user sees an internal Key "choices" error, and streamState.active stays true: every subsequent Send is swallowed as cancelStream (the composer is wedged until reload)',
  mode: 'sse-error-event',
  regression: true, // FIXED bug #219 kept as a regression check (provider error surfaced, partial kept, composer un-wedged)
  settings: {},
  async body({ cdp, dbPath }) {
    await sendChatMessage(cdp, 'trigger an upstream stream error');
    // The mock streams one content chunk, then a REAL OpenAI-style
    // `data: {"error": {...}}` SSE event, then ends the response.
    await cdp.waitFor('document.querySelector(".error-banner") !== null', 25000, 200, 'error banner');
    await sleep(800);
    const banner = await cdp.text('.error-banner');
    const stillActive = await cdp.eval('typeof streamState !== "undefined" && streamState.active');
    const isLoadingNow = await cdp.eval('typeof isLoading !== "undefined" && isLoading');
    const uiMsgCount = await cdp.eval('chatMessages.length');
    const asstRows = seed.query(dbPath, "SELECT COUNT(*) AS cnt FROM messages WHERE role='assistant'");
    const partialInDb = seed.query(dbPath, "SELECT COUNT(*) AS cnt FROM messages WHERE content LIKE '%Partial answer%'");
    // FIXED (bug #219): the provider's error message is surfaced (not an
    // internal "choices"/"Item has no value" parser crash), the partial
    // streamed content is persisted, and the composer is back in Send mode.
    if (stillActive)
      throw new Error('streamState.active is still true after the error event - composer wedged (bug #219 not fixed): banner=' + JSON.stringify(banner));
    if (isLoadingNow)
      throw new Error('isLoading is still true after the error event (bug #219 not fixed)');
    const showsInternal = String(banner).indexOf('choices') >= 0 || String(banner).indexOf('Item has no value') >= 0;
    if (showsInternal)
      throw new Error('internal parser error still surfaced instead of the provider message (bug #219 not fixed): banner=' + JSON.stringify(banner));
    if (String(banner).indexOf('upstream exploded (mock)') < 0)
      throw new Error('provider error message not surfaced (bug #219 not fixed): banner=' + JSON.stringify(banner));
    if (asstRows[0].cnt < 1 || partialInDb[0].cnt < 1)
      throw new Error('partial streamed content was not persisted (bug #219 not fixed): assistantRows=' + asstRows[0].cnt + ' partialRows=' + partialInDb[0].cnt);
    // The next Send must actually send (not be swallowed as cancelStream).
    // Wait for the composer to be truly re-enabled - under full-suite load
    // the setChatButtonsEnabled(true) post can lag a few hundred ms past the
    // banner, and a click on a still-disabled button posts nothing.
    await cdp.waitFor('document.getElementById("chat-send-btn") && !document.getElementById("chat-send-btn").disabled', 15000, 200, 'send button enabled after error');
    const uiCountBefore = await cdp.eval('chatMessages.length');
    await sendChatMessage(cdp, 'follow-up after the error');
    await sleep(800);
    const posted = await cdp.eval('(window.__posted || []).slice()');
    const chatSendPosted = posted.some((m) => String(m).indexOf('"chatSend"') >= 0 || String(m).indexOf('chatSend') >= 0);
    const cancelPosted = posted.some((m) => String(m).indexOf('cancelStream') >= 0);
    const uiCountAfter = await cdp.eval('chatMessages.length');
    if (!chatSendPosted || cancelPosted || uiCountAfter <= uiCountBefore)
      throw new Error('follow-up Send was swallowed as cancelStream (bug #219 not fixed): posted=' + JSON.stringify(posted));
    // Let the follow-up settle (the mock errors again; the UI must return to
    // Send mode once more).
    await waitStreamingIdle(cdp, 25000);
    return 'banner=' + JSON.stringify(banner) +
      ' streamState.active=' + stillActive + ' isLoading=' + isLoadingNow +
      ' chatMessages=' + uiMsgCount + ' assistantRowsInDb=' + asstRows[0].cnt +
      ' partialRowsInDb=' + partialInDb[0].cnt +
      ' - provider error surfaced, partial kept, composer un-wedged, follow-up Send posted chatSend';
  }
});

scenarios.push({
  id: 226,
  name: "Sidebar New Chat starts fresh with the configured defaults: pre-send right-rail selections are intentionally reset (refuted #226 - expected behavior, kept as a regression check)",
  regression: true,
  mode: 'sse-success',
  settings: {},
  async body({ cdp, mockLog }) {
    await showChat();
    await cdp.waitFor('document.getElementById("modelCardTrigger") !== null && window.activeThreadId === ""', 15000, 300, 'fresh empty chat');
    // Pick a NON-default model + typed system prompt in the right rail while
    // NO thread exists (the exact pre-send state bug #212 fixed on the send
    // path; here the chat is started with the sidebar New Chat button).
    await cdp.eval(`(() => {
      Ipc.postToHost('updateModelSettings', {
        model: 'openai/gpt-5-mini',
        systemMessage: 'PRE-SEND SYSTEM PROMPT 226',
        reasoning: '', temperature: '', codeExecution: false, webSearch: false
      });
      return true;
    })()`);
    await sleep(800);
    const picked = await cdp.eval('({ model: window._currentSettings.model, sys: window._currentSettings.systemMessage })');
    if (picked.model !== 'openai/gpt-5-mini')
      throw new Error('setup: right-rail model pick did not land: ' + JSON.stringify(picked));
    await cdp.click('#new-chat-btn');
    await cdp.waitFor('window.activeThreadId !== ""', 15000, 300, 'new thread created');
    await sleep(700);
    await sendChatMessage(cdp, 'first message after new chat');
    await waitStreamingIdle(cdp, 30000);
    const lines = fs.readFileSync(mockLog, 'utf8').trim().split(/\r?\n/).filter(Boolean);
    const last = JSON.parse(lines[lines.length - 1]);
    const sentModel = last.body.model;
    const sysMsgs = (last.body.messages || []).filter(function(m) { return m.role === 'system'; })
      .map(function(m) { return m.content; });
    // EXPECTED: a new chat starts with the configured defaults - the first
    // request uses the default (assistant) model and never carries the
    // pre-send selection.
    if (sentModel === 'gpt-5-mini' || sysMsgs.some(function(s) { return String(s).indexOf('PRE-SEND SYSTEM PROMPT 226') >= 0; }))
      throw new Error('regression: the pre-send selection survived New Chat (model=' + sentModel + ') - New Chat must reset to defaults');
    return 'picked openai/gpt-5-mini + system prompt pre-send, clicked New Chat, sent: request used model=' + sentModel +
      ' system=' + JSON.stringify(sysMsgs) + ' - New Chat correctly reset to the configured defaults';
  }
});

scenarios.push({
  id: 225,
  name: "Sidebar New Chat starts fresh at the configured default font size: the pre-send font adjustment is intentionally reset (refuted #225 - expected behavior, kept as a regression check)",
  regression: true,
  mode: null,
  settings: {},
  async body({ cdp, dbPath }) {
    await showChat();
    await cdp.waitFor('document.getElementById("font-size-display") !== null && window.activeThreadId === ""', 15000, 300, 'fresh empty chat');
    // Bump the font size while NO thread exists (same pre-send state as
    // scenario 213, but this time start the chat via the sidebar New Chat
    // button instead of sending the first message).
    await cdp.click('#btn-font-inc');
    await sleep(500);
    const before = await cdp.eval('document.getElementById("font-size-display").textContent');
    if (before !== '18px')
      throw new Error('setup: font + did not bump the display to 18px: ' + JSON.stringify(before));
    await cdp.click('#new-chat-btn');
    await cdp.waitFor('window.activeThreadId !== ""', 15000, 300, 'new thread created');
    await sleep(700);
    const after = await cdp.eval('document.getElementById("font-size-display").textContent');
    const threadId = await cdp.eval('window.activeThreadId');
    const rows = seed.query(dbPath, 'SELECT font_size FROM chat_threads WHERE id=?', [threadId]);
    const savedFont = rows.length ? Number(rows[0].font_size) : -1;
    // EXPECTED: a new chat starts at the configured default font - the new
    // thread is saved with the global default (17px) and the display snaps
    // back to 17px, discarding the pre-send 18px adjustment.
    if (after !== '17px' || savedFont !== 17)
      throw new Error('regression: the pre-send font size survived New Chat (display=' + JSON.stringify(after) + ' db=' + savedFont + ') - New Chat must reset to the default font');
    return 'bumped the font to 18px pre-send, clicked New Chat: thread ' + threadId + ' saved font_size=' + savedFont +
      ' and the display reset to ' + after + ' - New Chat correctly reset to the default font';
  }
});

scenarios.push({
  id: 229,
  name: 'A non-streaming (single-shot) chat response must render from dbMsg when the streaming buffers are empty - onStreamDone now persists the assistant message directly from streamDone.dbMsg and re-renders chatMessages, so a chat-mode command with "Stream Response" OFF (e.g. the default Summarize command) shows its response instead of waiting for a reload (bug #229 FIXED)',
  regression: true, // FIXED bug kept as a regression check (single-shot responses must render immediately)
  mode: null,
  noApp: true,
  settings: {},
  async body() {
    const src = fs.readFileSync(path.join(launcher.REPO_ROOT, 'webui', 'js', 'chat', 'stream.js'), 'utf8');
    const sandbox = {
      document: {
        getElementById: () => null,
        createElement: () => ({ style: {}, appendChild: () => {}, querySelector: () => null, querySelectorAll: () => [], insertBefore: () => {} }),
        querySelectorAll: () => [],
        querySelector: () => null
      },
      window: { addEventListener: () => {} },
      console,
      md: { render: (c) => c },
      setTimeout, clearTimeout,
      chatMessages: [],
      sessionStorage: { getItem: () => null, setItem: () => {} },
      streamState: undefined,
      hideLoadingIndicator: () => {},
      setChatButtonsEnabled: () => {},
      addMessageActions: () => {},
      escHtml: (s) => String(s || ''),
      renderChatMessages: () => {},
      renderNavList: () => {}
    };
    sandbox.global = sandbox;
    vm.runInContext(src, vm.createContext(sandbox));

    // Single-shot completion shape: AHK persisted the assistant row and posts
    // streamDone with dbMsg + threadId, but no content/reasoning chunk was
    // ever streamed, so the streaming buffers are empty.
    sandbox.activeThreadId = 't-229';
    sandbox.chatMessages = [{ id: 'm-229-u1', role: 'user', content: 'question' }];
    let rendered = 0;
    sandbox.renderChatMessages = () => { rendered++; };
    sandbox.streamState.active = false;
    sandbox.streamState.bubble = null;
    sandbox.streamState.contentDiv = null;
    sandbox.streamState.thinkingDetails = null;
    sandbox.streamState.contentBuffer = '';
    sandbox.streamState.thinkingBuffer = '';
    sandbox.streamState.modelName = 'deepseek-v4-pro';
    sandbox.streamState.userScrolledUp = false;
    sandbox.onStreamDone({
      model: 'deepseek-v4-pro',
      displayName: 'deepseek-v4-pro',
      threadId: 't-229',
      dbMsg: { id: 'm-229-a1', role: 'assistant', content: 'The summary the API returned.', parentId: 'm-229-u1', tokenCount: 9 }
    });

    // FIXED (bug #229): the persisted assistant message is added to
    // chatMessages from dbMsg even though no chunks were streamed, and the
    // view is re-rendered so the bubble appears immediately.
    const renderedIds = sandbox.chatMessages.map((m) => m.id);
    if (renderedIds.length !== 2 || renderedIds.indexOf('m-229-a1') < 0 || rendered !== 1)
      throw new Error('single-shot response still not rendered (fix incomplete): ids=' + JSON.stringify(renderedIds) + ' renders=' + rendered);
    const a1 = sandbox.chatMessages.find((m) => m.id === 'm-229-a1');
    if (!a1 || a1.role !== 'assistant' || a1.content !== 'The summary the API returned.')
      throw new Error('single-shot response content lost (fix incomplete): ' + JSON.stringify(a1));
    return 'single-shot streamDone (dbMsg present, buffers empty) rendered chatMessages=[' + renderedIds.join(',') +
      '] with renders=' + rendered + ' - the persisted assistant message appears immediately without a reload';
  }
});

scenarios.push({
  id: 230,
  name: 'A chat-mode command thread created after launch must appear in the sidebar immediately, and a single-shot streamDone must render in the real WebView DOM - _LoadThreadAndRefreshUI now refreshes the thread list after every load (bug #230 FIXED), onStreamDone renders dbMsg with empty buffers (#229), and the default Summarize/Translate/Explain commands stream (stream: true)',
  regression: true, // FIXED bugs #229/#230 kept as regression checks (command-created chats visible in the sidebar; single-shot responses render; default chat-mode Digest commands stream)
  mode: null,
  settings: {},
  async body({ cdp, dbPath }) {
    await showChat();
    await cdp.waitFor('document.querySelectorAll("#thread-list .chat-item").length === 0', 15000, 300, 'empty thread list');

    // Simulate Main's processInitialRequest chat branch exactly: while the app
    // is running, a thread titled with the command name is created in the DB
    // with a system + user message (the Summarize command flow).
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(dbPath);
    db.exec('PRAGMA busy_timeout=5000;');
    const tid = 't-cmd-230';
    db.prepare('INSERT INTO chat_threads (id, title) VALUES (?, ?)').run(tid, 'Summarize');
    db.prepare('INSERT INTO messages (id, thread_id, role, content) VALUES (?, ?, ?, ?)').run('m-230-sys', tid, 'system', 'Summarize the following text.');
    db.prepare('INSERT INTO messages (id, thread_id, role, content) VALUES (?, ?, ?, ?)').run('m-230-u1', tid, 'user', 'The text to summarize.');
    db.prepare('UPDATE chat_threads SET active_leaf_id=? WHERE id=?').run('m-230-u1', tid);
    db.close();

    // ChatWindow loads the command-created thread (the notifyLoadThread path
    // openChatWindow uses), exactly like a real command run.
    const p = runProbe('load-thread', [tid]);
    if (!p.posted) throw new Error('setup: load-thread probe did not post');
    await cdp.waitFor('window.activeThreadId === "t-cmd-230"', 15000, 300, 'command thread loaded');

    const dbHasThread = seed.query(dbPath, "SELECT id FROM chat_threads WHERE id=?", [tid]).length === 1;
    if (!dbHasThread)
      throw new Error('setup: command thread missing from DB');

    // FIXED (bug #230): _LoadThreadAndRefreshUI now posts a threadList refresh
    // after every load, so the command-created chat appears in the sidebar
    // without any unrelated action.
    let sidebarIds = [];
    const start = Date.now();
    while (Date.now() - start < 8000) {
      sidebarIds = await cdp.eval('[...document.querySelectorAll("#thread-list .chat-item")].map(e => e.getAttribute("data-chat"))');
      if (sidebarIds.indexOf(tid) >= 0) break;
      await sleep(300);
    }
    if (sidebarIds.indexOf(tid) < 0)
      throw new Error('command-created thread still missing from sidebar (fix incomplete): ' + JSON.stringify(sidebarIds));

    // FIXED (bug #229, verified in the REAL WebView DOM): a single-shot
    // (Stream Response OFF) completion posts streamDone with dbMsg and empty
    // buffers - the assistant bubble must render immediately.
    await cdp.eval(`handleStreamMessage('streamDone', { model: 'deepseek-v4-pro', displayName: 'deepseek-v4-pro', threadId: '${tid}', dbMsg: { id: 'm-230-a1', role: 'assistant', content: 'Here is the summary the API returned.', parentId: 'm-230-u1', tokenCount: 12 } }); true`);
    await sleep(600);
    const botTexts = await cdp.eval('[...document.querySelectorAll("#chat-messages .msg.bot .msg-content")].map(e => e.textContent)');
    if (!botTexts.some((t) => t.indexOf('Here is the summary the API returned.') >= 0))
      throw new Error('single-shot response not rendered in the real DOM (fix incomplete): ' + JSON.stringify(botTexts));

    // FIXED (default config): the chat-mode Digest commands (Summarize,
    // Translate to English, Explain) stream by default like every other
    // chat-mode default command.
    const defaults = fs.readFileSync(path.join(launcher.REPO_ROOT, 'default-settings', 'DefaultSettings.ahk'), 'utf8');
    for (const name of ['Summarize', 'Translate to English', 'Explain']) {
      const idx = defaults.indexOf('commandName: "' + name + '"');
      if (idx < 0) throw new Error('default command not found: ' + name);
      const block = defaults.slice(idx, idx + 900);
      if (!/stream:\s*true/.test(block))
        throw new Error('default command "' + name + '" still does not stream (fix incomplete)');
    }

    return 'command-created thread appears in the sidebar right after load (' + JSON.stringify(sidebarIds) + '); a single-shot streamDone rendered "' +
      botTexts.find((t) => t.indexOf('Here is the summary') >= 0) + '" in the real DOM; default Summarize/Translate/Explain now carry stream: true';
  }
});

scenarios.push({
  id: 231,
  name: 'Web selections must ALWAYS get \\n\\n paragraph breaks - _CaptureSelection now expands single newlines in the captured selection and fullText unconditionally (not only when the command toggle is on), so summarizing/translating text copied from the web keeps the source paragraph structure (bug #231 FIXED)',
  regression: true, // FIXED bug #231 kept as a regression check (selection capture always expands single newlines)
  mode: null,
  noApp: true,
  settings: {},
  async body() {
    const src = fs.readFileSync(path.join(launcher.REPO_ROOT, 'app', 'TextCapture.ahk'), 'utf8');
    // FIXED (bug #231): the captured selection AND fullText are normalized
    // with expand=true unconditionally, so a default command never sends
    // single-\n paragraph breaks from web selections.
    if (!/NormalizeLineEndings\(userMessage,\s*true\)/.test(src))
      throw new Error('userMessage capture does not always expand single newlines (fix incomplete)');
    if (!/NormalizeLineEndings\(fullText,\s*true\)/.test(src))
      throw new Error('fullText capture does not always expand single newlines (fix incomplete)');
    if (/NormalizeLineEndings\((?:userMessage|fullText),\s*expandNewlines\)/.test(src))
      throw new Error('selection capture still uses the command toggle instead of always expanding (fix incomplete)');
    return '_CaptureSelection always expands single newlines to \\n\\n for the captured selection and fullText - web selections keep their paragraph structure when summarized/translated';
  }
});

scenarios.push({
  id: 232,
  name: 'Sidebar provider icon / thread order must update as soon as a stream completes - _handleStreamComplete (and the cancel/partial path) now post a threadList refresh, so the sidebar item shows the responding model\'s icon and moves to the top without exiting and re-entering the chat (bug #232 FIXED)',
  regression: true, // FIXED bug #232 kept as a regression check (sidebar follows stream completion)
  mode: 'sse-success',
  settings: {},
  fixtures: {
    threads: [
      { id: 't-232', title: 'Existing Chat', active_leaf_id: 'm-232-u1', created_at: '2026-08-10 10:00:00' },
      { id: 't-232-b', title: 'Newer Chat', active_leaf_id: 'm-232-u1b', created_at: '2026-08-11 10:00:00' }
    ],
    messages: [
      { id: 'm-232-u1', thread_id: 't-232', role: 'user', content: 'question', token_count: 5, active_path_tokens: 5 },
      { id: 'm-232-u1b', thread_id: 't-232-b', role: 'user', content: 'other', token_count: 5, active_path_tokens: 5 }
    ]
  },
  async body({ cdp }) {
    await showChat();
    await cdp.waitFor('document.querySelectorAll("#thread-list .chat-item").length >= 2', 15000, 300, 'thread list');
    await sleep(500);
    await cdp.eval('window.loadThread("t-232"); true');
    await cdp.waitFor('window.activeThreadId === "t-232"', 15000, 300, 't-232 loaded');
    await sleep(500);
    await sendChatMessage(cdp, 'summarize this for me');
    await waitStreamingIdle(cdp, 30000);
    await sleep(800);
    // Read the sidebar WITHOUT any reload/re-enter - the completion must have
    // refreshed it.
    let iconAfter = '';
    let orderAfter = [];
    const start = Date.now();
    while (Date.now() - start < 8000) {
      iconAfter = await cdp.eval('(() => { const img = document.querySelector("#thread-list .chat-item[data-chat=\\"t-232\\"] .chat-icon img"); return img ? img.getAttribute("src") : "(no img)"; })()');
      orderAfter = await cdp.eval('[...document.querySelectorAll("#thread-list .chat-item")].map(e => e.getAttribute("data-chat"))');
      if (iconAfter.indexOf('deepseek') >= 0 && orderAfter[0] === 't-232') break;
      await sleep(300);
    }
    // FIXED (bug #232): the completion refreshed the sidebar - the icon is the
    // responding model's and the thread moved to the top (updated_at bumped).
    if (iconAfter.indexOf('deepseek') < 0)
      throw new Error('sidebar provider icon still stale after completion (fix incomplete): ' + iconAfter);
    if (orderAfter[0] !== 't-232')
      throw new Error('sidebar order still stale after completion (fix incomplete): ' + orderAfter.join(','));
    return 'after the stream completed, the sidebar shows icon=' + iconAfter + ' and order=[' + orderAfter.join(',') +
      '] - the provider icon / model badge follow the stream immediately without exiting the chat';
  }
});

scenarios.push({
  id: 233,
  name: 'COMMAND AUDIT (real app): every default chat-mode command must stream with its configured model + thinking config, persist the response, render it in the WebView, and update the sidebar - drives Quick ask, Summarize, Translate, Explain, Screenshot, DeepSeek V4 Pro/Flash, GPT-5.4/Mini, Gemini 3.5 Flash/3.1 Pro through the real load+trigger path against the mock SSE server',
  regression: true, // audit guard: all default chat-mode commands work end-to-end (model/stream/thinking + render + sidebar)
  mode: 'sse-success',
  mockOpts: { echoModel: true }, // the mock echoes each request's model so per-command provider attribution is verifiable
  settings: {},
  fixtures: {
    threads: [
      { id: 't-cmd-quickask', title: 'Quick ask (V4 Flash)', active_leaf_id: 'm-cmd-quickask-u', model_override: 'deepseek-v4-flash', reasoning_override: 'none' },
      { id: 't-cmd-summarize', title: 'Summarize', active_leaf_id: 'm-cmd-summarize-u', model_override: 'deepseek/deepseek-v4-pro', reasoning_override: 'high' },
      { id: 't-cmd-translate', title: 'Translate to English', active_leaf_id: 'm-cmd-translate-u', model_override: 'deepseek/deepseek-v4-pro', reasoning_override: 'none' },
      { id: 't-cmd-explain', title: 'Explain', active_leaf_id: 'm-cmd-explain-u', model_override: 'deepseek/deepseek-v4-pro', reasoning_override: 'none' },
      { id: 't-cmd-screenshot', title: 'Screenshot', active_leaf_id: 'm-cmd-screenshot-u', model_override: 'openai/gpt-5.4-mini', reasoning_override: 'medium' },
      { id: 't-cmd-dspro', title: 'DeepSeek V4 Pro', active_leaf_id: 'm-cmd-dspro-u', model_override: 'deepseek/deepseek-v4-pro', reasoning_override: 'high' },
      { id: 't-cmd-dsflash', title: 'DeepSeek V4 Flash', active_leaf_id: 'm-cmd-dsflash-u', model_override: 'deepseek/deepseek-v4-flash', reasoning_override: 'high' },
      { id: 't-cmd-gpt54', title: 'GPT-5.4', active_leaf_id: 'm-cmd-gpt54-u', model_override: 'openai/gpt-5.4', reasoning_override: 'medium' },
      { id: 't-cmd-gpt54mini', title: 'GPT-5.4 Mini', active_leaf_id: 'm-cmd-gpt54mini-u', model_override: 'openai/gpt-5.4-mini', reasoning_override: 'medium' },
      { id: 't-cmd-gem35', title: 'Gemini 3.5 Flash', active_leaf_id: 'm-cmd-gem35-u', model_override: 'google/gemini-3.5-flash', reasoning_override: 'medium' },
      { id: 't-cmd-gem31', title: 'Gemini 3.1 Pro', active_leaf_id: 'm-cmd-gem31-u', model_override: 'google/gemini-3.1-pro-preview', reasoning_override: 'high' }
    ],
    messages: [
      { id: 'm-cmd-quickask-u', thread_id: 't-cmd-quickask', role: 'user', content: 'quick ask content', token_count: 5, active_path_tokens: 5 },
      { id: 'm-cmd-summarize-u', thread_id: 't-cmd-summarize', role: 'user', content: 'summarize content', token_count: 5, active_path_tokens: 5 },
      { id: 'm-cmd-translate-u', thread_id: 't-cmd-translate', role: 'user', content: 'translate content', token_count: 5, active_path_tokens: 5 },
      { id: 'm-cmd-explain-u', thread_id: 't-cmd-explain', role: 'user', content: 'explain content', token_count: 5, active_path_tokens: 5 },
      { id: 'm-cmd-screenshot-u', thread_id: 't-cmd-screenshot', role: 'user', content: 'screenshot content', token_count: 5, active_path_tokens: 5 },
      { id: 'm-cmd-dspro-u', thread_id: 't-cmd-dspro', role: 'user', content: 'deepseek pro content', token_count: 5, active_path_tokens: 5 },
      { id: 'm-cmd-dsflash-u', thread_id: 't-cmd-dsflash', role: 'user', content: 'deepseek flash content', token_count: 5, active_path_tokens: 5 },
      { id: 'm-cmd-gpt54-u', thread_id: 't-cmd-gpt54', role: 'user', content: 'gpt 5.4 content', token_count: 5, active_path_tokens: 5 },
      { id: 'm-cmd-gpt54mini-u', thread_id: 't-cmd-gpt54mini', role: 'user', content: 'gpt 5.4 mini content', token_count: 5, active_path_tokens: 5 },
      { id: 'm-cmd-gem35-u', thread_id: 't-cmd-gem35', role: 'user', content: 'gemini 3.5 content', token_count: 5, active_path_tokens: 5 },
      { id: 'm-cmd-gem31-u', thread_id: 't-cmd-gem31', role: 'user', content: 'gemini 3.1 content', token_count: 5, active_path_tokens: 5 }
    ]
  },
  async body({ cdp, dbPath, mockLog }) {
    const cmds = [
      { id: 't-cmd-quickask', name: 'Quick ask (V4 Flash)', userText: 'quick ask content', model: 'deepseek-v4-flash', family: 'deepseek', icon: 'deepseek' },
      { id: 't-cmd-summarize', name: 'Summarize', userText: 'summarize content', model: 'deepseek-v4-pro', family: 'deepseek', icon: 'deepseek' },
      { id: 't-cmd-translate', name: 'Translate to English', userText: 'translate content', model: 'deepseek-v4-pro', family: 'deepseek', icon: 'deepseek' },
      { id: 't-cmd-explain', name: 'Explain', userText: 'explain content', model: 'deepseek-v4-pro', family: 'deepseek', icon: 'deepseek' },
      { id: 't-cmd-screenshot', name: 'Screenshot', userText: 'screenshot content', model: 'gpt-5.4-mini', family: 'openai', icon: 'openai' },
      { id: 't-cmd-dspro', name: 'DeepSeek V4 Pro', userText: 'deepseek pro content', model: 'deepseek-v4-pro', family: 'deepseek', icon: 'deepseek' },
      { id: 't-cmd-dsflash', name: 'DeepSeek V4 Flash', userText: 'deepseek flash content', model: 'deepseek-v4-flash', family: 'deepseek', icon: 'deepseek' },
      { id: 't-cmd-gpt54', name: 'GPT-5.4', userText: 'gpt 5.4 content', model: 'gpt-5.4', family: 'openai', icon: 'openai' },
      { id: 't-cmd-gpt54mini', name: 'GPT-5.4 Mini', userText: 'gpt 5.4 mini content', model: 'gpt-5.4-mini', family: 'openai', icon: 'openai' },
      { id: 't-cmd-gem35', name: 'Gemini 3.5 Flash', userText: 'gemini 3.5 content', model: 'gemini-3.5-flash', family: 'google', icon: 'google' },
      { id: 't-cmd-gem31', name: 'Gemini 3.1 Pro', userText: 'gemini 3.1 content', model: 'gemini-3.1-pro-preview', family: 'google', icon: 'google' }
    ];
    await showChat();
    await cdp.waitFor('document.querySelectorAll("#thread-list .chat-item").length >= 11', 15000, 300, 'thread list');
    await sleep(600);

    const results = [];
    for (const c of cmds) {
      // Load the command's thread through the real IPC and trigger the LLM
      // with stream=1 (chat-mode commands stream).
      await cdp.eval('window.loadThread("' + c.id + '"); true');
      await cdp.waitFor('window.activeThreadId === "' + c.id + '"', 15000, 300, c.name + ' loaded');
      await sleep(400);
      const p = runProbe('trigger-llm', ['1']);
      if (!p.posted) throw new Error(c.name + ': trigger probe did not post');
      await waitStreamingIdle(cdp, 30000);
      await cdp.waitFor('chatMessages.some((m) => m.role === "assistant" && m.content && m.content.indexOf("Hello from the mock LLM.") >= 0)', 15000, 250, c.name + ' response rendered');

      // The mock received a STREAMING request for this command's model with
      // the family-appropriate thinking config.
      const lines = fs.readFileSync(mockLog, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
      const req = lines.find((e) => e.body && e.body.messages && e.body.messages.some((m) => m.role === 'user' && String(m.content).indexOf(c.userText) >= 0));
      if (!req) throw new Error(c.name + ': no mock request recorded');
      const b = req.body;
      if (b.model !== c.model)
        throw new Error(c.name + ': request model ' + JSON.stringify(b.model) + ' != ' + c.model);
      if (b.stream !== true)
        throw new Error(c.name + ': request is not streaming (stream=' + JSON.stringify(b.stream) + ')');
      const hasThinking = c.family === 'deepseek' ? !!b.thinking
        : c.family === 'openai' ? !!b.reasoning_effort
        : !!(b.extra_body && b.extra_body.google && b.extra_body.google.thinking_config);
      if (!hasThinking)
        throw new Error(c.name + ': request missing ' + c.family + ' thinking config: ' + JSON.stringify(b).slice(0, 300));

      // Response persisted in the command's thread.
      const asst = seed.query(dbPath, "SELECT COUNT(*) AS c FROM messages WHERE thread_id=? AND role='assistant'", [c.id]);
      if (!asst[0] || asst[0].c < 1)
        throw new Error(c.name + ': assistant response not persisted');

      // Response rendered in the REAL WebView (streamed bubble).
      const rendered = await cdp.eval('chatMessages.some((m) => m.role === "assistant" && m.content && m.content.indexOf("Hello from the mock LLM.") >= 0)');

      // Sidebar shows the thread with the provider icon.
      await cdp.waitFor('(() => { const img = document.querySelector("#thread-list .chat-item[data-chat=\\"' + c.id + '\\"] .chat-icon img"); return !!img && img.getAttribute("src").indexOf("' + c.icon + '") >= 0; })()', 10000, 200, c.name + ' sidebar icon');
      const icon = await cdp.eval('(() => { const img = document.querySelector("#thread-list .chat-item[data-chat=\\"' + c.id + '\\"] .chat-icon img"); return img ? img.getAttribute("src") : "(no img)"; })()');
      if (icon.indexOf(c.icon) < 0)
        throw new Error(c.name + ': sidebar icon ' + icon + ' does not contain ' + c.icon);

      results.push(c.name + '[' + b.model + ', stream=' + b.stream + ']');
    }
    return 'all 11 default chat-mode commands streamed end-to-end with their configured model + thinking config, persisted + rendered the response, and updated the sidebar: ' + results.join(' | ');
  }
});

scenarios.push({
  id: 323,
  name: 'Provider error banners stay scoped when the user switches chats mid-request',
  regression: true,
  mode: 'sse-lateerror',
  mockOpts: { lateErrorDelay: 1500 },
  settings: { threadTitles: { enabled: false } },
  fixtures: {
    threads: [
      { id: 't-error-a-323', title: 'Gemini 3.1 Pro', active_leaf_id: 'm-error-a-323', model_override: 'google/gemini-3.1-pro-preview' },
      { id: 't-error-b-323', title: 'DeepSeek V4 Pro', active_leaf_id: 'm-error-b-323', model_override: 'deepseek/deepseek-v4-pro' }
    ],
    messages: [
      { id: 'm-error-a-323', thread_id: 't-error-a-323', role: 'user', content: 'Gemini request that will fail', token_count: 5, active_path_tokens: 5 },
      { id: 'm-error-b-323', thread_id: 't-error-b-323', role: 'user', content: 'DeepSeek conversation', token_count: 5, active_path_tokens: 5 }
    ]
  },
  async body({ cdp }) {
    await showChat();
    await cdp.waitFor('document.querySelectorAll("#thread-list .chat-item").length >= 2', 15000, 300, 'thread list');
    await cdp.eval('window.loadThread("t-error-a-323"); true');
    await cdp.waitFor('window.activeThreadId === "t-error-a-323" && chatMessages.length === 1', 15000, 300, 'Gemini chat loaded');

    // First let an error render in Gemini, then switch to DeepSeek. This is
    // the screenshot's timing: initChatMode must not preserve Gemini's banner.
    await sendChatMessage(cdp, 'trigger the Gemini billing error');
    await cdp.waitFor('typeof isLoading !== "undefined" && isLoading === true', 20000, 50, 'Gemini request in flight');
    await cdp.waitFor('document.querySelector("#chat-messages .error-banner") !== null', 20000, 200, 'Gemini error banner');
    const geminiBanner = await cdp.text('#chat-messages .error-banner');
    if (!geminiBanner)
      throw new Error('Gemini error banner was not rendered before switching');

    await cdp.eval('window.loadThread("t-error-b-323"); true');
    await cdp.waitFor('window.activeThreadId === "t-error-b-323" && chatMessages.length === 1', 15000, 300, 'DeepSeek chat loaded');
    const switchedBanner = await cdp.text('#chat-messages .error-banner');
    const activeThread = await cdp.eval('window.activeThreadId');
    if (activeThread !== 't-error-b-323')
      throw new Error('setup: active thread changed unexpectedly: ' + activeThread);
    if (switchedBanner && String(switchedBanner).trim())
      throw new Error('Gemini error banner leaked into the visible DeepSeek chat: ' + JSON.stringify(switchedBanner));

    await cdp.eval('window.loadThread("t-error-a-323"); true');
    await cdp.waitFor('window.activeThreadId === "t-error-a-323" && chatMessages.length === 2', 15000, 300, 'Gemini chat returned');
    const returnedBanner = await cdp.text('#chat-messages .error-banner');
    if (!returnedBanner)
      throw new Error('Gemini error banner was not retained while its chat was inactive');
    await cdp.click('#chat-messages .error-banner button');
    await cdp.waitFor('document.querySelector("#chat-messages .error-banner") === null', 5000, 100, 'dismissed Gemini error banner');

    // Then repeat with the switch happening BEFORE the delayed error arrives;
    // the payload thread guard must cover this race too.
    await sendChatMessage(cdp, 'trigger the Gemini late error');
    await cdp.waitFor('typeof isLoading !== "undefined" && isLoading === true', 20000, 50, 'second Gemini request in flight');
    await cdp.eval('window.loadThread("t-error-b-323"); true');
    await cdp.waitFor('window.activeThreadId === "t-error-b-323" && chatMessages.length === 1', 15000, 300, 'DeepSeek chat reloaded');
    await sleep(2500);
    const lateBanner = await cdp.text('#chat-messages .error-banner');
    if (lateBanner && String(lateBanner).trim())
      throw new Error('late Gemini error banner leaked into DeepSeek: ' + JSON.stringify(lateBanner));
    await cdp.eval('window.loadThread("t-error-a-323"); true');
    await cdp.waitFor('window.activeThreadId === "t-error-a-323" && chatMessages.length === 3', 15000, 300, 'Gemini chat returned after delayed error');
    const retainedLateBanner = await cdp.text('#chat-messages .error-banner');
    if (!retainedLateBanner)
      throw new Error('delayed Gemini error was not retained for its originating chat');
    return 'Gemini errors remain in Gemini across chat switches until dismissed; neither the immediate nor delayed error appeared in DeepSeek';
  }
});

scenarios.push({
  id: 337,
  name: 'Per-thread generation is fully independent across chats: concurrent sends persist separately, switching restores each thread Stop state, and stopping A never cancels B',
  mode: 'sse-slow',
  regression: true,
  settings: {},
  fixtures: {
    threads: [
      { id: 't-independent-a-337', title: 'Independent A', active_leaf_id: 'm-337-a0' },
      { id: 't-independent-b-337', title: 'Independent B', active_leaf_id: 'm-337-b0' }
    ],
    messages: [
      { id: 'm-337-au0', thread_id: 't-independent-a-337', role: 'user', content: 'seed A', token_count: 2, active_path_tokens: 2 },
      { id: 'm-337-a0', thread_id: 't-independent-a-337', role: 'assistant', content: 'seed answer A', model: 'deepseek/deepseek-v4-flash', parent_id: 'm-337-au0', token_count: 3, prompt_tokens: 4, active_path_tokens: 5 },
      { id: 'm-337-bu0', thread_id: 't-independent-b-337', role: 'user', content: 'seed B', token_count: 2, active_path_tokens: 2 },
      { id: 'm-337-b0', thread_id: 't-independent-b-337', role: 'assistant', content: 'seed answer B', model: 'deepseek/deepseek-v4-flash', parent_id: 'm-337-bu0', token_count: 3, prompt_tokens: 4, active_path_tokens: 5 }
    ]
  },
  async body({ cdp, dbPath }) {
    const buttonMode = `(() => {
      var b = document.getElementById('chat-send-btn');
      if (!b || !b.onclick) return 'none';
      if (b.onclick === onStopStreaming) return 'stop';
      if (b.onclick === onChatSend) return 'send';
      return 'other';
    })()`;

    await showChat();
    await cdp.waitFor('document.querySelectorAll("#thread-list .chat-item").length >= 2', 15000, 300, 'thread list');

    // Phase 1: start A, switch only after B's actual chat content has loaded,
    // then start B while A remains in flight.
    await cdp.eval('window.loadThread("t-independent-a-337"); true');
    await cdp.waitFor('window.activeThreadId === "t-independent-a-337" && chatMessages.some((m) => m.id === "m-337-a0")', 15000, 300, 'thread A loaded');
    await sleep(300);
    await sendChatMessage(cdp, 'phase 1 request A');
    await cdp.waitFor('isThreadRequestInFlight("t-independent-a-337")', 10000, 50, 'thread A busy');

    await cdp.eval('window.loadThread("t-independent-b-337"); true');
    await cdp.waitFor('window.activeThreadId === "t-independent-b-337" && chatMessages.some((m) => m.id === "m-337-b0")', 15000, 300, 'thread B loaded');
    await sleep(300);

    const bIdleMode = await cdp.eval(buttonMode);
    const bIdleInput = await cdp.eval('document.getElementById("chat-input").disabled');
    if (bIdleMode !== 'send' || bIdleInput)
      throw new Error('B is not independently sendable while A is busy: mode=' + bIdleMode + ' inputDisabled=' + bIdleInput);

    await sendChatMessage(cdp, 'phase 1 request B');
    await cdp.waitFor('isThreadRequestInFlight("t-independent-a-337") && isThreadRequestInFlight("t-independent-b-337")', 10000, 50, 'both threads busy');
    if (await cdp.eval(buttonMode) !== 'stop')
      throw new Error('busy B did not show Stop');

    await cdp.eval('window.loadThread("t-independent-a-337"); true');
    await cdp.waitFor('window.activeThreadId === "t-independent-a-337" && chatMessages.some((m) => m.content === "phase 1 request A")', 15000, 300, 'thread A returned');
    await sleep(300);
    if (await cdp.eval(buttonMode) !== 'stop')
      throw new Error('switching back to busy A did not restore Stop');

    await waitStreamingIdle(cdp, 40000);
    await sleep(500);

    const phase1A = seed.query(dbPath,
      "SELECT COUNT(*) AS c FROM messages WHERE thread_id=? AND role='assistant' AND parent_id IN (SELECT id FROM messages WHERE thread_id=? AND role='user' AND content=?)",
      ['t-independent-a-337', 't-independent-a-337', 'phase 1 request A'])[0].c;
    const phase1B = seed.query(dbPath,
      "SELECT COUNT(*) AS c FROM messages WHERE thread_id=? AND role='assistant' AND parent_id IN (SELECT id FROM messages WHERE thread_id=? AND role='user' AND content=?)",
      ['t-independent-b-337', 't-independent-b-337', 'phase 1 request B'])[0].c;
    if (phase1A !== 1 || phase1B !== 1)
      throw new Error('concurrent responses did not persist independently: A=' + phase1A + ' B=' + phase1B);

    // Phase 2: run both again, stop A only, and prove B remains in flight.
    await cdp.eval('window.loadThread("t-independent-a-337"); true');
    await cdp.waitFor('window.activeThreadId === "t-independent-a-337" && chatMessages.some((m) => m.content === "phase 1 request A")', 15000, 300, 'thread A phase 2 loaded');
    await sleep(250);
    await sendChatMessage(cdp, 'phase 2 request A to cancel');
    await cdp.waitFor('isThreadRequestInFlight("t-independent-a-337")', 10000, 50, 'thread A phase 2 busy');

    await cdp.eval('window.loadThread("t-independent-b-337"); true');
    await cdp.waitFor('window.activeThreadId === "t-independent-b-337" && chatMessages.some((m) => m.content === "phase 1 request B")', 15000, 300, 'thread B phase 2 loaded');
    await sleep(250);
    await sendChatMessage(cdp, 'phase 2 request B must continue');
    await cdp.waitFor('isThreadRequestInFlight("t-independent-a-337") && isThreadRequestInFlight("t-independent-b-337")', 10000, 50, 'both phase 2 threads busy');

    await cdp.eval('window.loadThread("t-independent-a-337"); true');
    await cdp.waitFor('window.activeThreadId === "t-independent-a-337" && chatMessages.some((m) => m.content === "phase 2 request A to cancel")', 15000, 300, 'thread A ready to stop');
    await sleep(200);
    if (await cdp.eval(buttonMode) !== 'stop')
      throw new Error('A was not in Stop mode before cancellation');

    await cdp.click('#chat-send-btn');
    await cdp.waitFor('!isThreadRequestInFlight("t-independent-a-337") && isThreadRequestInFlight("t-independent-b-337")', 15000, 50, 'A stopped while B still busy');

    await cdp.eval('window.loadThread("t-independent-b-337"); true');
    await cdp.waitFor('window.activeThreadId === "t-independent-b-337" && chatMessages.some((m) => m.content === "phase 2 request B must continue")', 15000, 300, 'thread B after A stop');
    await sleep(200);

    const bAfterAStopMode = await cdp.eval(buttonMode);
    const bAfterAStopDisabled = await cdp.eval('document.getElementById("chat-input").disabled');
    if (bAfterAStopMode !== 'stop' || !bAfterAStopDisabled)
      throw new Error('stopping A changed B generation state: mode=' + bAfterAStopMode + ' inputDisabled=' + bAfterAStopDisabled);

    await waitStreamingIdle(cdp, 40000);
    await sleep(500);

    const phase2B = seed.query(dbPath,
      "SELECT COUNT(*) AS c FROM messages WHERE thread_id=? AND role='assistant' AND parent_id IN (SELECT id FROM messages WHERE thread_id=? AND role='user' AND content=?)",
      ['t-independent-b-337', 't-independent-b-337', 'phase 2 request B must continue'])[0].c;
    if (phase2B !== 1)
      throw new Error('B response did not persist after stopping A: B=' + phase2B);

    return 'A/B concurrent sends both persisted; switching restored each busy thread Stop state; stopping A left B in Stop mode until B completed and persisted its response';
  }
});




scenarios.push({
  id: 338,
  name: 'Background generation in A does not block branch navigation, message editing, or regenerate in B',
  mode: 'sse-slow',
  mockOpts: { chunkDelay: 1500 },
  regression: true,
  settings: {},
  fixtures: {
    threads: [
      { id: 't-actions-a-338', title: 'Busy A', active_leaf_id: 'm-338-aa1' },
      { id: 't-actions-b-338', title: 'Actions B', active_leaf_id: 'm-338-ba2' }
    ],
    messages: [
      { id: 'm-338-au1', thread_id: 't-actions-a-338', role: 'user', content: 'A seed', token_count: 4, active_path_tokens: 4 },
      { id: 'm-338-aa1', thread_id: 't-actions-a-338', role: 'assistant', content: 'A seed answer', model: 'deepseek/deepseek-v4-flash', parent_id: 'm-338-au1', token_count: 5, prompt_tokens: 8, active_path_tokens: 9 },
      { id: 'm-338-bu1', thread_id: 't-actions-b-338', role: 'user', content: 'B root question', token_count: 4, active_path_tokens: 4 },
      { id: 'm-338-ba1', thread_id: 't-actions-b-338', role: 'assistant', content: 'B branch one', model: 'deepseek/deepseek-v4-flash', parent_id: 'm-338-bu1', sibling_group: 'sg-338-b', sibling_index: 0, token_count: 5, prompt_tokens: 8, active_path_tokens: 9 },
      { id: 'm-338-ba2', thread_id: 't-actions-b-338', role: 'assistant', content: 'B branch two', model: 'deepseek/deepseek-v4-flash', parent_id: 'm-338-bu1', sibling_group: 'sg-338-b', sibling_index: 1, token_count: 5, prompt_tokens: 8, active_path_tokens: 9 }
    ]
  },
  async body({ cdp, dbPath }) {
    await showChat();
    await cdp.waitFor('document.querySelectorAll("#thread-list .chat-item").length >= 2', 15000, 300, 'thread list');

    // Phase 1: while A is streaming, B must remain fully interactive for
    // branch navigation and local message editing.
    await cdp.eval('window.loadThread("t-actions-a-338"); true');
    await cdp.waitFor('window.activeThreadId === "t-actions-a-338" && chatMessages.some((m) => m.id === "m-338-aa1")', 15000, 300, 'A loaded');
    await sendChatMessage(cdp, 'phase 1 long request A 338');
    await cdp.waitFor('isThreadRequestInFlight("t-actions-a-338")', 10000, 50, 'A phase 1 busy');

    await cdp.eval('window.loadThread("t-actions-b-338"); true');
    await cdp.waitFor('window.activeThreadId === "t-actions-b-338" && chatMessages.some((m) => m.id === "m-338-ba2")', 15000, 300, 'B loaded');
    await sleep(250);

    if (!await cdp.eval('isThreadRequestInFlight("t-actions-a-338")'))
      throw new Error('setup: A finished before B actions were exercised');

    await cdp.click('#chat-messages .msg:nth-child(2) .msg-action-btn[title="Previous branch"]');
    await cdp.waitFor('chatMessages[1] && chatMessages[1].id === "m-338-ba1"', 10000, 200, 'B switched branch while A busy');
    if (!await cdp.eval('isThreadRequestInFlight("t-actions-a-338")'))
      throw new Error('A finished before branch navigation assertion');

    await cdp.click('#chat-messages .msg:nth-child(1) .msg-action-btn[title="Edit"]');
    await cdp.waitFor('document.querySelector("#chat-messages .msg:nth-child(1)").classList.contains("editing")', 5000, 100, 'B edit UI open while A busy');
    await cdp.type('#chat-messages .msg:nth-child(1) .msg-edit-textarea', 'B root edited while A busy 338');
    await cdp.click('#chat-messages .msg:nth-child(1) .save-overwrite');
    await cdp.waitFor('chatMessages[0] && chatMessages[0].content === "B root edited while A busy 338"', 10000, 200, 'B edit persisted in UI');
    if (!await cdp.eval('isThreadRequestInFlight("t-actions-a-338")'))
      throw new Error('A finished before edit isolation assertion');

    const edited = seed.query(dbPath, "SELECT content FROM messages WHERE id='m-338-bu1'")[0];
    if (!edited || edited.content !== 'B root edited while A busy 338')
      throw new Error('B overwrite edit did not persist while A was busy: ' + JSON.stringify(edited));

    await waitStreamingIdle(cdp, 40000);

    // Phase 2: start a fresh A request, then regenerate B. Both requests must
    // coexist and persist to their own threads.
    await cdp.eval('window.loadThread("t-actions-a-338"); true');
    await cdp.waitFor('window.activeThreadId === "t-actions-a-338" && chatMessages.some((m) => m.content === "phase 1 long request A 338")', 15000, 300, 'A phase 2 loaded');
    await sendChatMessage(cdp, 'phase 2 long request A 338');
    await cdp.waitFor('isThreadRequestInFlight("t-actions-a-338")', 10000, 50, 'A phase 2 busy');

    await cdp.eval('window.loadThread("t-actions-b-338"); true');
    await cdp.waitFor('window.activeThreadId === "t-actions-b-338" && chatMessages[0] && chatMessages[0].content === "B root edited while A busy 338"', 15000, 300, 'B phase 2 loaded');
    await sleep(200);

    const retryBtn = '#chat-messages .msg:nth-child(2) .msg-action-btn[title="Retry"]';
    await cdp.waitFor('document.querySelector(' + JSON.stringify(retryBtn) + ') !== null', 5000, 100, 'B retry button');
    await cdp.click(retryBtn);
    await cdp.waitFor('isThreadRequestInFlight("t-actions-a-338") && isThreadRequestInFlight("t-actions-b-338")', 10000, 50, 'A and B both busy after B regenerate');

    await waitStreamingIdle(cdp, 40000);
    await sleep(500);

    const bMockReplies = seed.query(dbPath,
      "SELECT COUNT(*) AS c FROM messages WHERE thread_id='t-actions-b-338' AND role='assistant' AND content='Hello from the mock LLM. This is the streamed answer.'")[0].c;
    const aPhase2Replies = seed.query(dbPath,
      "SELECT COUNT(*) AS c FROM messages WHERE thread_id='t-actions-a-338' AND role='assistant' AND parent_id IN (SELECT id FROM messages WHERE thread_id='t-actions-a-338' AND role='user' AND content='phase 2 long request A 338')")[0].c;
    if (bMockReplies < 1 || aPhase2Replies !== 1)
      throw new Error('cross-thread regenerate persistence failed: B mock replies=' + bMockReplies + ' A phase2=' + aPhase2Replies);

    return 'while A streamed, B switched assistant branches and overwrote its user message; during a fresh A stream, B regenerated independently and both responses persisted';
  }
});


scenarios.push({
  id: 341,
  name: 'Retry branch ownership survives cross-thread concurrency: B normal sends stay branch-free, arrows switch real context, and later normal A sends do not inherit retry state',
  mode: 'sse-slow',
  mockOpts: { chunkDelay: 1500 },
  regression: true,
  settings: {},
  fixtures: {
    threads: [
      { id: 't-branch-a-341', title: 'Branch A', active_leaf_id: 'm-341-a1' },
      { id: 't-branch-b-341', title: 'Branch B', active_leaf_id: 'm-341-b1' }
    ],
    messages: [
      { id: 'm-341-au1', thread_id: 't-branch-a-341', role: 'user', content: 'A root', token_count: 2, active_path_tokens: 2 },
      { id: 'm-341-a1', thread_id: 't-branch-a-341', role: 'assistant', content: 'A original answer', model: 'deepseek/deepseek-v4-flash', parent_id: 'm-341-au1', token_count: 3, prompt_tokens: 4, active_path_tokens: 5 },
      { id: 'm-341-bu1', thread_id: 't-branch-b-341', role: 'user', content: 'B root', token_count: 2, active_path_tokens: 2 },
      { id: 'm-341-b1', thread_id: 't-branch-b-341', role: 'assistant', content: 'B original answer', model: 'deepseek/deepseek-v4-flash', parent_id: 'm-341-bu1', token_count: 3, prompt_tokens: 4, active_path_tokens: 5 }
    ]
  },
  async body({ cdp, dbPath }) {
    await showChat();
    await cdp.waitFor('document.querySelectorAll("#thread-list .chat-item").length >= 2', 15000, 300, 'thread list');

    // Create A's sibling group through the real Retry action.
    await cdp.eval('window.loadThread("t-branch-a-341"); true');
    await cdp.waitFor('window.activeThreadId === "t-branch-a-341" && chatMessages.some((m) => m.id === "m-341-a1")', 15000, 250, 'A loaded');
    await cdp.click('#chat-messages .msg:nth-child(2) .msg-action-btn[title="Retry"]');
    await cdp.waitFor('isThreadRequestInFlight("t-branch-a-341")', 10000, 50, 'A retry busy');
    await sleep(350);

    // While A's retry metadata is actively being swapped through the shared
    // request window, send a completely normal request in B.
    await cdp.eval('window.loadThread("t-branch-b-341"); true');
    await cdp.waitFor('window.activeThreadId === "t-branch-b-341" && chatMessages.some((m) => m.id === "m-341-b1")', 15000, 250, 'B loaded');
    await sleep(200);
    await sendChatMessage(cdp, 'B normal while A retry 341');
    await cdp.waitFor('isThreadRequestInFlight("t-branch-a-341") && isThreadRequestInFlight("t-branch-b-341")', 10000, 50, 'A retry and B normal request both busy');
    await waitStreamingIdle(cdp, 40000);
    await sleep(500);

    const aRows = seed.query(dbPath,
      "SELECT id, parent_id, sibling_group, sibling_index, content FROM messages WHERE thread_id='t-branch-a-341' AND role='assistant' ORDER BY sibling_index, rowid");
    if (aRows.length !== 2)
      throw new Error('Retry A did not produce exactly two assistant siblings: ' + JSON.stringify(aRows));
    const retryGroup = String(aRows[0].sibling_group || '');
    if (!retryGroup || String(aRows[1].sibling_group || '') !== retryGroup)
      throw new Error('Retry A did not create one shared sibling group: ' + JSON.stringify(aRows));
    if (String(aRows[0].parent_id || '') !== 'm-341-au1' || String(aRows[1].parent_id || '') !== 'm-341-au1')
      throw new Error('Retry A sibling parents differ: ' + JSON.stringify(aRows));

    const newRetry = aRows.find((row) => String(row.id) !== 'm-341-a1');
    if (!newRetry)
      throw new Error('Could not identify retried A assistant: ' + JSON.stringify(aRows));

    const bRows = seed.query(dbPath,
      "SELECT a.id, a.parent_id, a.sibling_group, u.id AS user_id FROM messages a JOIN messages u ON a.parent_id=u.id WHERE a.thread_id='t-branch-b-341' AND a.role='assistant' AND u.content='B normal while A retry 341'");
    if (bRows.length !== 1)
      throw new Error('B normal response missing after concurrent A retry: ' + JSON.stringify(bRows));
    if (bRows[0].sibling_group)
      throw new Error('B normal response inherited A retry sibling group: ' + JSON.stringify(bRows[0]));

    // A must now display a real 2/2 branch. The arrows must change the actual
    // visible message ID/content and the DB active leaf, not merely scroll.
    await cdp.eval('window.loadThread("t-branch-a-341"); true');
    await cdp.waitFor(
      'window.activeThreadId === "t-branch-a-341" && chatMessages[1] && chatMessages[1].id === ' + JSON.stringify(String(newRetry.id)),
      15000, 250, 'A retry branch loaded'
    );
    await sleep(200);
    const label2 = await cdp.eval('document.querySelector("#chat-messages .msg:nth-child(2) .branch-label-inline")?.textContent || ""');
    if (label2 !== '2/2')
      throw new Error('retried A assistant did not render 2/2: ' + label2);

    await cdp.click('#chat-messages .msg:nth-child(2) .msg-action-btn[title="Previous branch"]');
    await cdp.waitFor('chatMessages[1] && chatMessages[1].id === "m-341-a1" && chatMessages[1].content === "A original answer"', 10000, 150, 'previous branch changed visible assistant');
    await sleep(150);
    const label1 = await cdp.eval('document.querySelector("#chat-messages .msg:nth-child(2) .branch-label-inline")?.textContent || ""');
    if (label1 !== '1/2')
      throw new Error('previous branch did not render 1/2: ' + label1);
    let leaf = seed.query(dbPath, "SELECT active_leaf_id FROM chat_threads WHERE id='t-branch-a-341'")[0];
    if (!leaf || String(leaf.active_leaf_id || '') !== 'm-341-a1')
      throw new Error('previous branch did not update DB active leaf: ' + JSON.stringify(leaf));

    await cdp.click('#chat-messages .msg:nth-child(2) .msg-action-btn[title="Next branch"]');
    await cdp.waitFor(
      'chatMessages[1] && chatMessages[1].id === ' + JSON.stringify(String(newRetry.id)),
      10000, 150, 'next branch restored retried assistant'
    );
    await sleep(150);
    leaf = seed.query(dbPath, "SELECT active_leaf_id FROM chat_threads WHERE id='t-branch-a-341'")[0];
    if (!leaf || String(leaf.active_leaf_id || '') !== String(newRetry.id))
      throw new Error('next branch did not update DB active leaf: ' + JSON.stringify(leaf));

    // A normal follow-up after all retry activity must start a new path node,
    // not become a third member of the retry sibling group.
    await sendChatMessage(cdp, 'A normal after retry 341');
    await cdp.waitFor('isThreadRequestInFlight("t-branch-a-341")', 10000, 50, 'A normal follow-up busy');
    await waitStreamingIdle(cdp, 40000);
    await sleep(500);

    const finalRows = seed.query(dbPath,
      "SELECT a.id, a.sibling_group, a.parent_id FROM messages a JOIN messages u ON a.parent_id=u.id WHERE a.thread_id='t-branch-a-341' AND a.role='assistant' AND u.content='A normal after retry 341'");
    if (finalRows.length !== 1)
      throw new Error('normal A follow-up response missing: ' + JSON.stringify(finalRows));
    if (finalRows[0].sibling_group)
      throw new Error('normal A follow-up inherited retry sibling group: ' + JSON.stringify(finalRows[0]));

    const groupCount = seed.query(dbPath,
      "SELECT COUNT(*) AS c FROM messages WHERE thread_id='t-branch-a-341' AND sibling_group=?",
      [retryGroup])[0].c;
    if (Number(groupCount) !== 2)
      throw new Error('retry sibling group grew after a normal send: count=' + groupCount);

    const finalHasBranchNav = await cdp.eval(
      'document.querySelector("#chat-messages .msg:last-child .branch-label-inline") !== null'
    );
    if (finalHasBranchNav)
      throw new Error('normal post-retry assistant incorrectly rendered branch arrows');

    return 'retry A created exactly 2 valid siblings; concurrent normal B remained branch-free; arrows changed visible content and DB leaf; later normal A response remained outside the retry group';
  }
});
module.exports = scenarios;
