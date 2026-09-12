// scenarios/settings.js - Settings persistence and application (hotkeys, icons, tray, modals)
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
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const launcher = require('../launch');
const seed = require('../seed');
const { sleep, runIconCheck, readJsonFile, showChat, openSettings, openSection, saveSettings, hideSettingsToChat, sendChatMessage, waitStreamingIdle } = require('./helpers');

const scenarios = [];
// Keep the retention regression relative to the run date; a fixed historical
// timestamp eventually becomes older than the default 30-day retention and
// is correctly removed during startup.
const retentionFixtureDate = new Date(Date.now() - 19 * 24 * 60 * 60 * 1000)
  .toISOString().slice(0, 19).replace('T', ' ');

scenarios.push({
  id: 319,
  name: 'Explicit Model Default reasoning and temperature selections survive reload',
  regression: true,
  mode: 'sse-success',
  settings: {
    assistants: [{
      id: 'asst-319', name: 'Defaults Assistant', baseModel: 'deepseek/deepseek-v4-flash',
      systemMessage: 'assistant system 319', systemMessageFile: '', description: '',
      reasoning: 'high', temperature: '0.3'
    }]
  },
  fixtures: {
    threads: [{ id: 't-defaults-319', title: 'Explicit Defaults', active_leaf_id: 'm-defaults-319', assistant_id: 'asst-319' }],
    messages: [{ id: 'm-defaults-319', thread_id: 't-defaults-319', role: 'user', content: 'hello defaults' }]
  },
  async body({ cdp, dbPath, mockLog }) {
    await showChat();
    await cdp.waitFor('document.querySelectorAll("#thread-list .chat-item").length > 0', 15000, 300, 'thread list');
    await cdp.click('#thread-list .chat-item');
    await cdp.waitFor('document.querySelectorAll("#chat-messages .msg").length >= 1 && window._currentSettings && window._currentSettings.assistantName === "Defaults Assistant"', 15000, 300, 'assistant thread loaded');
    await sleep(700);

    const initial = await cdp.eval(`(() => ({
      reasoning: document.getElementById('reasoningDropdown').value,
      temperature: window._currentSettings.temperature,
      assistant: window._currentSettings.assistantName
    }))()`);
    if (initial.reasoning !== 'high' || String(initial.temperature) !== '0.3')
      throw new Error('setup: assistant defaults did not load: ' + JSON.stringify(initial));

    // Concrete reasoning is also an explicit per-thread choice. Exercise the
    // non-empty path before the existing Model Default round-trip below.
    await cdp.eval(`(() => {
      const reasoning = document.getElementById('reasoningDropdown');
      reasoning.value = 'high';
      reasoning.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`);
    await sleep(900);
    const concrete = seed.query(dbPath, "SELECT reasoning_override, reasoning_override_set FROM chat_threads WHERE id='t-defaults-319'")[0];
    if (!concrete || concrete.reasoning_override !== 'high' || Number(concrete.reasoning_override_set) !== 1)
      throw new Error('concrete reasoning override was not persisted explicitly: ' + JSON.stringify(concrete));
    await cdp.eval('window.loadThread("t-defaults-319"); true');
    await cdp.waitFor('window.activeThreadId === "t-defaults-319" && document.getElementById("reasoningDropdown").value === "high"', 15000, 300, 'concrete reasoning reloaded');
    await sendChatMessage(cdp, 'verify concrete reasoning after reload');
    await waitStreamingIdle(cdp, 40000);
    await sleep(700);
    const requests = fs.readFileSync(mockLog, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
    const concreteRequest = requests.find((entry) => entry.body && entry.body.stream === true && entry.body.messages && entry.body.messages.some((m) => String(m.content || '').includes('verify concrete reasoning')));
    if (!concreteRequest || concreteRequest.body.reasoning_effort !== 'high')
      throw new Error('reloaded concrete reasoning did not reach the request: ' + JSON.stringify(concreteRequest && concreteRequest.body));

    await cdp.eval(`(() => {
      const reasoning = document.getElementById('reasoningDropdown');
      reasoning.value = '';
      reasoning.dispatchEvent(new Event('change', { bubbles: true }));
      const reset = document.getElementById('tempReset');
      if (!reset || reset.style.display === 'none') return false;
      reset.click();
      return true;
    })()`);
    await sleep(900); // debounce + updateModelSettings persistence
    const selected = await cdp.eval(`(() => ({
      reasoning: document.getElementById('reasoningDropdown').value,
      temperature: window._currentSettings.temperature,
      tempDefault: document.getElementById('tempSlider').classList.contains('temp-default')
    }))()`);
    if (selected.reasoning !== '' || selected.temperature !== '' || !selected.tempDefault)
      throw new Error('setup: explicit default controls were not selected: ' + JSON.stringify(selected));

    const saved = seed.query(dbPath, "SELECT reasoning_override, temperature_override, reasoning_override_set, temperature_override_set FROM chat_threads WHERE id='t-defaults-319'");
    if (!saved.length || saved[0].reasoning_override !== null || saved[0].temperature_override !== null || saved[0].reasoning_override_set !== 1 || saved[0].temperature_override_set !== 1)
      throw new Error('setup: expected explicit empty overrides to be persisted with set flags: ' + JSON.stringify(saved));

    await cdp.eval('window.loadThread("t-defaults-319"); true');
    await cdp.waitFor('window.activeThreadId === "t-defaults-319" && document.querySelectorAll("#chat-messages .msg").length >= 1', 15000, 300, 'thread reloaded');
    await sleep(700);
    const reloaded = await cdp.eval(`(() => ({
      reasoning: document.getElementById('reasoningDropdown').value,
      temperature: window._currentSettings.temperature,
      tempDefault: document.getElementById('tempSlider').classList.contains('temp-default'),
      assistant: window._currentSettings.assistantName
    }))()`);
    if (reloaded.reasoning !== '' || reloaded.temperature !== '' || !reloaded.tempDefault || reloaded.assistant !== 'Defaults Assistant')
      throw new Error('explicit defaults did not survive reload: ' + JSON.stringify(reloaded));
    return 'selected Model Default and temperature Default; DB stored explicit empty overrides; reload kept both defaults';
  }
});

scenarios.push({
  id: 320,
  name: 'Clearing an assistant system prompt remains blank after reload',
  regression: true,
  mode: 'sse-success',
  settings: {
    assistants: [{
      id: 'asst-320', name: 'Prompt Assistant', baseModel: 'deepseek/deepseek-v4-flash',
      systemMessage: 'distinct assistant system 320', systemMessageFile: '', description: '',
      reasoning: '', temperature: ''
    }],
    threadTitles: { enabled: false }
  },
  fixtures: {
    threads: [{ id: 't-prompt-320', title: 'Cleared Prompt', active_leaf_id: 'm-prompt-320', assistant_id: 'asst-320' }],
    messages: [{ id: 'm-prompt-320', thread_id: 't-prompt-320', role: 'user', content: 'hello prompt' }]
  },
  async body({ cdp, dbPath, mockLog }) {
    await showChat();
    await cdp.waitFor('document.querySelectorAll("#thread-list .chat-item").length > 0', 15000, 300, 'thread list');
    await cdp.click('#thread-list .chat-item');
    await cdp.waitFor('document.querySelectorAll("#chat-messages .msg").length >= 1 && document.getElementById("sysMsgMini").value === "distinct assistant system 320"', 15000, 300, 'assistant prompt loaded');
    await cdp.eval(`(() => {
      const mini = document.getElementById('sysMsgMini');
      mini.value = '';
      mini.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);
    await sleep(900); // debounce + updateModelSettings persistence
    const current = await cdp.eval('({ prompt: document.getElementById("sysMsgMini").value, setting: window._currentSettings.systemMessage })');
    if (current.prompt !== '' || current.setting !== '')
      throw new Error('setup: prompt did not clear in the current session: ' + JSON.stringify(current));
    const settingsPosts = (await cdp.postedMessages()).filter((message) => message.includes('"updateModelSettings"'));
    const settingsPayload = settingsPosts.length ? JSON.parse(settingsPosts[settingsPosts.length - 1]) : null;
    if (!settingsPayload || settingsPayload.systemOverrideSet !== true)
      throw new Error('setup: cleared prompt did not send systemOverrideSet=true: ' + JSON.stringify(settingsPayload));
    const beforeSend = seed.query(dbPath, "SELECT system_override_set FROM chat_threads WHERE id='t-prompt-320'");
    if (!beforeSend.length || beforeSend[0].system_override_set !== 1)
      throw new Error('setup: systemOverrideSet was not persisted before send: ' + JSON.stringify(beforeSend));

    await sendChatMessage(cdp, 'send with cleared prompt');
    await waitStreamingIdle(cdp, 30000);
    await sleep(500);
    const postSendSettings = (await cdp.postedMessages())
      .filter((message) => message.includes('"updateModelSettings"'))
      .map((message) => JSON.parse(message));
    const lastPostSendSettings = postSendSettings[postSendSettings.length - 1];
    const lines = fs.readFileSync(mockLog, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
    const request = lines.find((entry) => entry.body && entry.body.stream === true);
    if (!request) throw new Error('setup: no streaming request logged; lines=' + lines.length);
    const systemMessages = (request.body.messages || [])
      .filter((message) => message.role === 'system')
      .map((message) => String(message.content || ''));
    if (systemMessages.some((content) => content.indexOf('distinct assistant system 320') >= 0))
      throw new Error('setup: cleared prompt still reached the current request: ' + JSON.stringify(systemMessages));

    const saved = seed.query(dbPath, "SELECT system_override, system_override_set FROM chat_threads WHERE id='t-prompt-320'");
    if (!saved.length || saved[0].system_override !== null || saved[0].system_override_set !== 1)
      throw new Error('setup: cleared prompt was not stored as an explicit blank override: ' + JSON.stringify({ saved, lastPostSendSettings }));
    await cdp.eval('window.loadThread("t-prompt-320"); true');
    await cdp.waitFor('window.activeThreadId === "t-prompt-320" && document.querySelectorAll("#chat-messages .msg").length >= 2', 15000, 300, 'thread reloaded');
    await sleep(700);
    const reloaded = await cdp.eval('document.getElementById("sysMsgMini").value');
    if (reloaded !== '')
      throw new Error('blank prompt was not preserved after reload: ' + JSON.stringify(reloaded));
    return 'cleared the assistant prompt; current request had system messages=' + JSON.stringify(systemMessages) +
      '; explicit blank override survived reload';
  }
});

scenarios.push({
  id: 3,
  name: 'Removing models/providers in Settings persists (removed entries stay removed)',
  regression: true, // FIXED bug kept as a regression check (removals must not be resurrected by merge)
  mode: null,
  settings: {},
  async body({ cdp, dataDir }) {
    const settingsFile = path.join(dataDir, 'settings.json');
    await openSettings(cdp);
    await openSection(cdp, 'models');
    await cdp.waitFor('document.querySelectorAll("#modelsTableBody tr").length > 0', 10000, 250, 'models table');
    // A provider cannot be removed while any model still references it. The
    // validator intentionally blocks that invalid state, so remove every
    // DeepSeek model before removing the provider and verify the clean list
    // survives Save -> Load.
    const removedDeepSeekModels = await cdp.eval(`(() => {
      let count = 0;
      for (const row of [...document.querySelectorAll('#modelsTableBody tr')]) {
        const provider = row.querySelector('[data-field="provider"]');
        if (provider && provider.value === 'deepseek') {
          const button = row.querySelector('.btn-sm.danger');
          if (button) { button.click(); count++; }
        }
      }
      return count;
    })()`);
    if (!removedDeepSeekModels) throw new Error('setup: no DeepSeek models were available to remove');
    await openSection(cdp, 'providers');
    await cdp.waitFor('document.querySelectorAll("#providerGrid .provider-card").length > 1', 10000, 250, 'provider cards');
    await cdp.click('#providerGrid .provider-card .btn-sm.danger');
    await saveSettings(cdp, dataDir);
    const saved = readJsonFile(settingsFile);
    const providerBack = saved.providers && saved.providers.deepseek;
    if (providerBack) throw new Error('removed provider deepseek is still present in settings.json after save');
    const dangling = Object.keys(saved.models || {}).filter((id) => id.indexOf('deepseek/') === 0);
    if (dangling.length) throw new Error('removed provider left dangling models in settings.json: ' + JSON.stringify(dangling));
    // Reload half: hide and reopen Settings so AHK re-merges the saved file
    // with defaults (the same Merge used at startup and after WM_SETTINGS_UPDATED).
    // Removed entries must not come back from the defaults.
    await cdp.waitFor('window.SettingsPanel && !window.SettingsPanel.isDirty()', 10000, 250, 'save acknowledged');
    await cdp.click('#sidebar-toggle');
    await sleep(500);
    await openSettings(cdp);
    await openSection(cdp, 'models');
    await cdp.waitFor('document.querySelectorAll("#modelsTableBody tr").length > 0', 10000, 250, 'models table re-rendered');
    await sleep(400);
    const modelRows = await cdp.eval(`[...document.querySelectorAll('#modelsTableBody tr')].map(tr => ({
      id: (tr.querySelector('[data-field="id"]') || {}).value || '',
      provider: (tr.querySelector('[data-field="provider"]') || {}).value || ''
    }))`);
    if (modelRows.some((r) => r.provider === 'deepseek'))
      throw new Error('removed DeepSeek models came back from defaults after reopening settings: ' + JSON.stringify(modelRows));
    await openSection(cdp, 'providers');
    const providerKeys = await cdp.eval(`[...document.querySelectorAll('#providerGrid .provider-card')].map(c => c.dataset.providerKey || '')`);
    if (providerKeys.includes('deepseek'))
      throw new Error('removed provider deepseek came back from defaults after reopening settings: ' + JSON.stringify(providerKeys));
    return 'after removing all DeepSeek models and the deepseek provider, neither the provider nor dangling models returned after reopening settings';
  }
});

scenarios.push({
  id: 4,
  name: 'Clearing a hotkey field disables the hotkey (empty = off)',
  regression: true, // FIXED bug kept as a regression check (cleared hotkeys must stay disabled)
  mode: null,
  settings: { hotkeys: { main: '`', reload: '~^!r', closeWindows: '~^w', suspend: 'CapsLock & `' } },
  async body({ cdp, dataDir }) {
    const settingsFile = path.join(dataDir, 'settings.json');
    await openSettings(cdp);
    await openSection(cdp, 'hotkeys');
    await cdp.waitFor('document.getElementById("hkMain") !== null', 10000, 250, 'hotkeys form');
    await cdp.type('#hkMain', '');
    await saveSettings(cdp, dataDir);
    const saved = readJsonFile(settingsFile);
    if (saved.hotkeys.main !== '') throw new Error('expected empty main hotkey saved, got ' + JSON.stringify(saved.hotkeys.main));
    // Zero-injection: verify the registrar skips empty bindings statically
    // (sending the real backtick to prove the menu does not open would leak a
    // keystroke into the user's typing when the injection misses the hotkey).
    const hr = fs.readFileSync(path.join(launcher.REPO_ROOT, 'app', 'HotkeyRegistrar.ahk'), 'utf8');
    const skipsEmpty = /if !key\s*\n\s*return ""/.test(hr);
    const mainRoutedThroughHotkeyOn = /_activeHotkeys\.main := _HotkeyOn\((?:_NormalizeHotkeyKey\()?mainHotkey/.test(hr);
    if (!skipsEmpty || !mainRoutedThroughHotkeyOn)
      throw new Error('HotkeyRegistrar no longer skips empty keys: skipsEmpty=' + skipsEmpty + ' mainRouted=' + mainRoutedThroughHotkeyOn);
    return 'cleared main hotkey saves as "" and _HotkeyOn returns "" for empty keys (no live key injection)';
  }
});

scenarios.push({
  id: 5,
  name: 'New model keeps thinking metadata across a Settings save (reasoning dropdown shows its levels)',
  regression: true, // FIXED bug kept as a regression check (metadata must survive settings saves)
  mode: 'json',
  settings: {},
  preLaunch(dataDir) {
    // Seed a NEW model id (not present in default-settings/DefaultModels.ahk) that carries full
    // metadata, exactly as the fetch pipeline produces it. It has no defaults
    // entry to refill from, so everything it has must survive the save
    // round-trip on its own.
    const settingsFile = path.join(dataDir, 'settings.json');
    const cfg = readJsonFile(settingsFile);
    cfg.models = {
      'openai/gpt-brand-new': {
        provider: 'openai',
        api: 'openai-completions',
        compat: {
          thinkingFormat: 'openai',
          supportsReasoningEffort: true,
          supportsUsageInStreaming: true,
          maxTokensField: 'max_completion_tokens'
        },
        thinkingLevelMap: { low: 'low', high: 'high' },
        thinkingOff: 'none',
        input: 0.4, cachedInput: 0.1, output: 1.6, context: 128000, reasoning: true, vision: false
      }
    };
    fs.writeFileSync(settingsFile, JSON.stringify(cfg, null, 2));
  },
  async body({ cdp, dataDir }) {
    await showChat();
    await openSettings(cdp);
    await openSection(cdp, 'models');
    await cdp.waitFor('document.querySelectorAll("#modelsTableBody tr").length > 0', 10000, 250, 'models table');
    // Make the panel dirty (Save is disabled otherwise) with a no-op edit on
    // the seeded row, then run the save round-trip.
    const rowSel = '#modelsTableBody tr:first-child [data-field="context"]';
    await cdp.waitFor('document.querySelector(' + JSON.stringify(rowSel) + ') !== null', 5000, 200, 'seeded model row');
    await cdp.type(rowSel, '128K');
    await cdp.click('.nav-footer .btn-primary');
    try {
      await cdp.waitFor('window.SettingsPanel && !window.SettingsPanel.isDirty()', 15000, 300, 'save acknowledged');
    } catch (err) {
      const state = await cdp.eval('({ dirty: window.SettingsPanel && window.SettingsPanel.isDirty ? window.SettingsPanel.isDirty() : null, saveDisabled: document.querySelector(".nav-footer .btn-primary") ? document.querySelector(".nav-footer .btn-primary").disabled : null, confirmText: document.getElementById("confirmModal") && document.getElementById("confirmModal").classList.contains("open") ? document.getElementById("confirmModal").textContent : "" })');
      throw new Error(err.message + ' | settings state=' + JSON.stringify(state));
    }
    // The saved file must still carry the metadata for the new id.
    const saved = readJsonFile(path.join(dataDir, 'settings.json'));
    const back = saved.models && saved.models['openai/gpt-brand-new'];
    if (!back || !back.thinkingLevelMap || !back.thinkingLevelMap.high)
      throw new Error('saved model lost thinking metadata: ' + JSON.stringify(back));
    await hideSettingsToChat(cdp);
    await cdp.waitFor('window.modelList && Object.keys(window.modelList).length > 0', 15000, 300, 'model list');
    await cdp.click('#modelCardTrigger');
    await cdp.waitFor('document.getElementById("modelPopover").classList.contains("open")', 5000, 200, 'popover open');
    await cdp.click('.popover-tab[data-target="tab-models"]');
    await cdp.waitFor('[...document.querySelectorAll("#tab-models .selector-item .si-name")].some(e => e.textContent === "gpt-brand-new")', 10000, 250, 'new model listed');
    await cdp.eval(`(() => {
      const items = [...document.querySelectorAll('#tab-models .selector-item')];
      const it = items.find(e => e.querySelector('.si-name').textContent === 'gpt-brand-new');
      it.click();
      return true;
    })()`);
    await cdp.waitFor('window._currentSettings.model.indexOf("gpt-brand-new") >= 0', 10000, 250, 'model selected');
    // FIXED behavior: the model's levels must be offered after the save
    // round-trip (before the fix, only "Model Default" remained).
    await cdp.waitFor('document.getElementById("reasoningDropdown").options.length > 1', 15000, 300, 'reasoning dropdown shows levels');
    const opts = await cdp.eval('[...document.getElementById("reasoningDropdown").options].map(o => o.textContent)');
    if (opts.length <= 1) throw new Error('expected the model\'s levels, got only ' + JSON.stringify(opts));
    if (opts.filter((o) => o === 'Low' || o === 'High').length < 2)
      throw new Error('seeded levels low/high missing from dropdown: ' + JSON.stringify(opts));
    return 'after Settings save, openai/gpt-brand-new keeps thinkingLevelMap and offers ' + JSON.stringify(opts);
  }
});

scenarios.push({
  id: 8,
  name: 'Close-Windows hotkey setting is honored by the chat window (dynamic registration)',
  regression: true, // FIXED bug kept as a regression check (chat window must keep honoring the setting)
  mode: null,
  settings: { hotkeys: { main: '`', reload: '~^!r', closeWindows: '~^q', suspend: 'CapsLock & `' } },
  async body({ cdp }) {
    // Live key injection is unreliable in this session (injected keys sometimes
    // don't reach AHK hotkeys). Verify the fix statically: the chat window must
    // register the CONFIGURED closeWindowsHotkey dynamically (no hardcoded
    // ~^w::), empty = disabled, and re-register after settings saves.
    const chatWin = fs.readFileSync(path.join(launcher.REPO_ROOT, 'chat', 'ChatWindow.ahk'), 'utf8');
    const chatHk = fs.readFileSync(path.join(launcher.REPO_ROOT, 'chat', 'ChatHotkeys.ahk'), 'utf8');
    const dispatch = fs.readFileSync(path.join(launcher.REPO_ROOT, 'chat', 'callbacks', 'Dispatch.ahk'), 'utf8');
    const hr = fs.readFileSync(path.join(launcher.REPO_ROOT, 'app', 'HotkeyRegistrar.ahk'), 'utf8');
    const noHardcode = !/::\s*ChatHotkeys\("closeWindows"\)/.test(chatWin) && !/~\^w::/.test(chatWin);
    const includesModule = chatWin.includes('#Include ChatHotkeys.ahk');
    // Step 3 of the IPC refactor: the chat window registers the hotkey hook
    // with SettingsService, which runs it at startup and on every settings
    // apply (replacing the old explicit _registerChatHotkeys() call sites).
    const registersAtStartup = chatWin.includes('SettingsService.RegisterHook("chatHotkeys", _registerChatHotkeys)');
    const dynamicRegister = /Hotkey\(\s*closeWindowsHotkey/.test(chatHk) && /_activeChatHotkey/.test(chatHk);
    const emptyMeansDisabled = /if\s+_activeChatHotkey[\s\S]*Hotkey\(_activeChatHotkey,\s*"Off"\)/.test(chatHk)
      && /if\s+closeWindowsHotkey[\s\S]*Hotkey\(closeWindowsHotkey/.test(chatHk);
    const reRegistersOnSave = (dispatch.match(/SettingsService\.(Apply|SaveFromWebView|ReloadFromDisk)\(/g) || []).length >= 2;
    const mainOnlyClosesInput = /case "closeWindows":[\s\S]*?commandInputWindow\.guiObj\.hWnd/.test(hr);
    if (!noHardcode || !includesModule || !registersAtStartup) throw new Error('ChatWindow still hardcodes the close hotkey or does not register it');
    if (!dynamicRegister || !emptyMeansDisabled) throw new Error('ChatHotkeys.ahk does not register closeWindowsHotkey dynamically with empty=disabled');
    if (!reRegistersOnSave) throw new Error('Dispatch does not re-register chat hotkeys after settings saves');
    if (!mainOnlyClosesInput) throw new Error('Main closeWindows handler unexpectedly closes the chat window');
    // The Hotkeys tab must no longer claim a restart is required — hotkey
    // changes are live on both the main script and the chat window.
    await openSettings(cdp);
    await openSection(cdp, 'hotkeys');
    await cdp.waitFor('document.getElementById("hkMain") !== null', 10000, 250, 'hotkeys form');
    const restartWarning = await cdp.eval(`(() => {
      const btn = document.getElementById('restartNowBtn');
      const banner = [...document.querySelectorAll('.warning-banner')].find(b => b.textContent.indexOf('restart') >= 0);
      return { btn: !!btn, banner: !!banner };
    })()`);
    if (restartWarning.btn || restartWarning.banner)
      throw new Error('stale restart warning still shown in Hotkeys: ' + JSON.stringify(restartWarning));
    return 'ChatWindow registers closeWindowsHotkey via a SettingsService hook (empty=disabled, re-registered on every settings apply); Main still handles only the input window; no restart warning shown';
  }
});

scenarios.push({
  id: 24,
  name: 'Input window Edit field applies the configured background (static check of the Edit Background option)',
  regression: true, // FIXED bug kept as a regression check (Edit must keep honoring the configured background)
  mode: null,
  noApp: true,
  async body() {
    // REGRESSION: the input window fix applied a dark background + light font,
    // but the Edit control does not inherit Gui.BackColor — it stayed white, so
    // white text was invisible. The Edit must be created with its own
    // Background option so the field matches the configured background. The
    // rendered-pixel live check was removed (it required key injection to open
    // the input window); InputWindow.test.ahk covers the applied colors.
    const iw = fs.readFileSync(path.join(launcher.REPO_ROOT, 'app', 'InputWindow.ahk'), 'utf8');
    const editOwnsBackground = /Background" inputWindowBackground/.test(iw);
    if (!editOwnsBackground)
      throw new Error('InputWindow Edit no longer carries its own Background option');
    return 'InputWindow Edit control carries its own Background option (never inherits the default white field)';
  }
});

scenarios.push({
  id: 25,
  name: 'Input window default design is light (static check of the default background)',
  regression: true, // FIXED bug kept as a regression check (default must stay light)
  mode: null,
  noApp: true,
  async body() {
    // REGRESSION guard: the app is light-themed, so the DEFAULT input window
    // must be light (white field + dark text). The previous default was dark
    // (0x212529 + cWhite), which looked broken against the light UI. Checked
    // statically to avoid key injection.
    const ds = fs.readFileSync(path.join(launcher.REPO_ROOT, 'default-settings', 'DefaultSettings.ahk'), 'utf8');
    const lightDefault = /inputWindowBackground\s*:=\s*"0xFFFFFF"/.test(ds);
    if (!lightDefault)
      throw new Error('default inputWindowBackground is no longer light (0xFFFFFF)');
    return 'default inputWindowBackground = 0xFFFFFF (light design preserved)';
  }
});

scenarios.push({
  id: 26,
  name: 'Opening Settings wipes the right-rail per-thread settings',
  regression: true, // FIXED bug kept as a regression check (right rail must survive opening Settings)
  mode: null,
  settings: {},
  async body({ cdp }) {
    // Set a per-thread system message through the right rail first, so there
    // is something to lose when Settings is opened.
    await showChat();
    await cdp.waitFor('document.getElementById("sysMsgMini") !== null && document.getElementById("expandSysMsg") !== null', 10000, 250, 'right rail');
    await cdp.click('#expandSysMsg');
    await cdp.waitFor('document.getElementById("sysMsgOverlay").classList.contains("open")', 5000, 200, 'sysmsg overlay');
    await cdp.type('#sysMsgFull', 'must survive settings open');
    await cdp.click('#sysMsgSave');
    await sleep(900); // 300ms debounce + IPC round trip
    const before = await cdp.eval('document.getElementById("sysMsgMini").value');
    if (before !== 'must survive settings open')
      throw new Error('system message not applied before opening settings: ' + JSON.stringify(before));
    // Open Settings: AHK answers requestAllSettings with the FULL merged
    // settings object, which main.js routes through populateCurrentSettings.
    await openSettings(cdp);
    const after = await cdp.eval('document.getElementById("sysMsgMini").value');
    // FIXED (bug #26): the full merged settings payload (requestAllSettings)
    // is no longer routed through populateCurrentSettings, so the right rail
    // keeps its per-thread system message when Settings opens.
    if (after !== before)
      throw new Error('opening Settings wiped the right-rail system message: "' + before + '" -> "' + after + '"');
    return 'right-rail system message survived opening Settings ("' + after + '")';
  }
});

scenarios.push({
  id: 33,
  name: 'Clearing the chat-window icon setting still loads the default custom icon',
  mode: null,
  regression: true, // FIXED: clearing icon now correctly clears global (was skipped and kept default)
  settings: { icons: { iconOn: '', iconOff: '' } },
  async body() {
    const defaultIco = path.join(launcher.REPO_ROOT, 'icons', 'IconOn.ico');
    const info = runIconCheck(defaultIco);
    if (info.hwnd === 0) throw new Error('chat window not found; probe=' + JSON.stringify(info));
    if (info.renderFailed === 1) throw new Error('icon render failed 3x; probe=' + JSON.stringify(info));
    // FIXED: with icons.iconOn="" the window now correctly shows no custom icon
    // because SettingsApply._ApplyIcons now applies empty values (was skipped).
    if (info.customApplied !== 0)
      throw new Error('cleared icon was NOT honored (fix broken): ' + JSON.stringify(info));
    return 'window correctly shows no custom IconOn.ico fingerprint when icons.iconOn is cleared (' + JSON.stringify(info) + ')';
  }
});

scenarios.push({
  id: 34,
  name: 'Tray icon changes apply live on settings updates (static check of the settings-update path)',
  regression: true, // FIXED bug kept as a regression check (tray icon must re-apply on settings updates)
  mode: null,
  noApp: true,
  async body() {
    const mainSrc = fs.readFileSync(path.join(launcher.REPO_ROOT, 'Main.ahk'), 'utf8');
    const traySrc = fs.readFileSync(path.join(launcher.REPO_ROOT, 'app', 'TrayIcon.ahk'), 'utf8');
    // FIXED: startup applies the icon through the shared rebuild, the rebuild
    // is registered as the trayIcon settings hook, and it honors suspend state.
    const hasStartupRebuild = /_rebuildTrayIcon\(\)/.test(mainSrc);
    const hasHook = mainSrc.includes('SettingsService.RegisterHook("trayIcon", _rebuildTrayIcon)');
    const hasApply = /TraySetIcon\(_trayIconForCurrentState\(\)/.test(traySrc);
    const hasOnBranch = /iconOn/.test(traySrc);
    const hasOffBranch = /iconOff/.test(traySrc);
    const hasSuspendBranch = /A_IsSuspended/.test(traySrc);
    const updStart = mainSrc.indexOf('WM_SETTINGS_UPDATED');
    const reloadStart = mainSrc.indexOf('WM_RELOAD_MAIN');
    const handler = mainSrc.slice(updStart, reloadStart > updStart ? reloadStart : updStart + 1200);
    // The handler reloads through SettingsService, which runs the registered
    // trayIcon hook, so icon edits apply without a restart.
    const handlerReloads = handler.includes('SettingsService.ReloadFromDisk()');
    if (!hasStartupRebuild || !hasHook || !hasApply || !hasOnBranch || !hasOffBranch || !hasSuspendBranch || !handlerReloads)
      throw new Error('tray icon fix not wired: startupRebuild=' + hasStartupRebuild + ' hook=' + hasHook +
        ' apply=' + hasApply + ' onBranch=' + hasOnBranch + ' offBranch=' + hasOffBranch + ' suspendBranch=' + hasSuspendBranch +
        ' handlerReloads=' + handlerReloads);
    return 'Tray icon rebuild runs at startup, is registered as the trayIcon settings hook, honors suspend state, and the settings-update handler reloads via SettingsService';
  }
});

scenarios.push({
  id: 35,
  name: 'Temperature override of 0 is restored when the thread reloads (request uses 0)',
  regression: true, // FIXED bug kept as a regression check (temperature 0 override must survive thread reload)
  mode: 'sse-success',
  settings: {},
  fixtures: {
    threads: [{ id: 't-temp0-35', title: 'Temp Zero Thread', active_leaf_id: 'm-temp0-35', temperature_override: 0 }],
    messages: [{ id: 'm-temp0-35', thread_id: 't-temp0-35', role: 'user', content: 'hello' }]
  },
  async body({ cdp, mockLog }) {
    await showChat();
    await cdp.waitFor('document.querySelectorAll("#thread-list .chat-item").length > 0', 15000, 300, 'thread list');
    await cdp.click('#thread-list .chat-item');
    // Wait until the thread actually loads (messages render), then let the
    // currentSettings round trip finish.
    await cdp.waitFor('document.querySelectorAll("#chat-messages .msg").length >= 1', 15000, 300, 'thread loaded');
    await sleep(500); // currentSettings round trip for the right rail
    // FIXED (bug #35): the 0 override is restored into requestParams, so the
    // next request must carry temperature 0. (The right-rail DISPLAY of 0 is
    // a separate bug, #78, tracked in its own cycle.)
    await sendChatMessage(cdp, 'second message');
    await waitStreamingIdle(cdp, 30000);
    await sleep(500);
    const lines = fs.readFileSync(mockLog, 'utf8').split(/\r?\n/).filter(Boolean);
    const chatReq = lines.map((l) => JSON.parse(l)).find((e) => e.body && e.body.stream === true);
    if (!chatReq) throw new Error('no streaming chat request was logged; lines=' + lines.length);
    const temp = chatReq.body.temperature;
    if (temp !== 0)
      throw new Error('temperature 0 override was dropped from the request: ' + JSON.stringify(temp));
    return 'thread with temperature_override=0 sent a request with temperature=0 (' + temp + ')';
  }
});

scenarios.push({
  id: 37,
  name: 'Tray menu item changes apply live via the settings hook (static check of the settings-update path)',
  regression: true, // FIXED bug kept as a regression check (tray menu must rebuild from trayMenuItems on settings update)
  mode: null,
  noApp: true,
  async body() {
    const mainSrc = fs.readFileSync(path.join(launcher.REPO_ROOT, 'Main.ahk'), 'utf8');
    const trayMenuSrc = fs.readFileSync(path.join(launcher.REPO_ROOT, 'app', 'TrayMenu.ahk'), 'utf8');
    // FIXED (bug #37): the tray menu rebuild lives in app/TrayMenu.ahk and is
    // registered as a SettingsService hook, so Menu Items edits apply live
    // (the WM_SETTINGS_UPDATED handler reloads via SettingsService, which runs
    // the hooks).
    const hasInclude = /#Include app\\TrayMenu\.ahk/.test(mainSrc);
    const hasHook = /SettingsService\.RegisterHook\("trayMenu", _rebuildTrayMenu\)/.test(mainSrc);
    const hasStartupCall = /_rebuildTrayMenu\(\)/.test(mainSrc);
    const menuDeletes = /A_TrayMenu\.Delete\(\)/.test(trayMenuSrc);
    const menuAdds = /A_TrayMenu\.Add/.test(trayMenuSrc);
    const iteratesItems = /for _, item in trayMenuItems/.test(trayMenuSrc);
    if (!hasInclude || !hasHook || !hasStartupCall || !menuDeletes || !menuAdds || !iteratesItems)
      throw new Error('tray menu rebuild not wired through the settings hook: include=' + hasInclude +
        ' hook=' + hasHook + ' startupCall=' + hasStartupCall + ' deletes=' + menuDeletes +
        ' adds=' + menuAdds + ' iterates=' + iteratesItems);
    return 'A_TrayMenu is rebuilt from trayMenuItems by _rebuildTrayMenu (app/TrayMenu.ahk), registered as the trayMenu settings hook in Main.ahk - menu edits apply without restart';
  }
});

scenarios.push({
  id: 39,
  name: 'System-message modal preserves a custom (unlisted) system-message file on Save',
  regression: true, // FIXED bug kept as a regression check (opening + saving the modal must not clear a custom system-message file)
  mode: null,
  settings: {
    commands: [{
      commandName: 'Custom File Command', menuText: 'Custom File Command',
      APIModels: 'deepseek/deepseek-v4-flash', pasteMode: 'chat', stream: false,
      systemMessageFile: 'default-settings/system-messages/my-custom-prompt.txt'
    }]
  },
  async body({ cdp }) {
    await openSettings(cdp);
    await openSection(cdp, 'commands');
    await cdp.waitFor('document.querySelectorAll("#commandsListBody .cmd-item").length > 0', 15000, 250, 'command list');
    await cdp.click('#commandsListBody .cmd-item');
    await sleep(400);
    // Open the system-message edit modal for the selected command.
    await cdp.click('#cmdEditSysMsg');
    await cdp.waitFor('document.getElementById("sysMsgEditModal").classList.contains("open")', 5000, 200, 'sysmsg modal');
    const selState = await cdp.eval(`(() => {
      const sel = document.getElementById('smFileSelect');
      return sel ? { selectedIndex: sel.selectedIndex, value: sel.value } : null;
    })()`);
    // The seeded file (system-messages/my-custom-prompt.txt) is NOT one of the
    // hardcoded options, so the select falls back to value "" (no selection).
    // Click Save without changing anything.
    await cdp.click('#sysMsgEditSave');
    await sleep(300);
    const after = await cdp.eval(`(() => {
      const c = window.Cmds && window.Cmds.commands();
      return c && c[0] ? { systemMessageFile: c[0].systemMessageFile, systemMessage: c[0].systemMessage } : null;
    })()`);
    const label = await cdp.eval('document.getElementById("cmdSysMsgLabel") ? document.getElementById("cmdSysMsgLabel").textContent : ""');
    // FIXED (bug #39): the modal remembers the stored file and falls back to it
    // when the select has no matching option, so the custom file survives.
    if (!after || after.systemMessageFile !== 'default-settings/system-messages/my-custom-prompt.txt')
      throw new Error('custom system-message file was not preserved through the modal save: ' +
        JSON.stringify(after) + ' label="' + label + '"');
    return 'custom file survived the modal save: systemMessageFile=' +
      JSON.stringify(after.systemMessageFile) + ' label="' + label + '"';
  }
});

scenarios.push({
  id: 40,
  name: 'Refresh-models modal keeps edits to a model id on Save',
  regression: true, // FIXED bug kept as a regression check (edited model ids must survive the refresh-modal save)
  mode: null,
  settings: {},
  async body({ cdp }) {
    await openSettings(cdp);
    await openSection(cdp, 'models');
    await cdp.waitFor('document.querySelectorAll("#modelsTableBody tr").length > 0', 15000, 250, 'models table');
    await cdp.click('#refreshPricingBtn');
    await cdp.waitFor('document.getElementById("refreshModal").classList.contains("open")', 5000, 200, 'refresh modal');
    await cdp.waitFor('document.querySelectorAll("#refreshRightTbody tr [data-field=id]").length > 0', 15000, 250, 'right panel models');
    const before = await cdp.eval(`(() => {
      const inp = document.querySelector('#refreshRightTbody tr [data-field=id]');
      return inp ? { value: inp.value, fullId: inp.getAttribute('data-full-id') } : null;
    })()`);
    // Rename the model id in the "Your Models" panel.
    await cdp.type('#refreshRightTbody tr [data-field=id]', 'renamed-model-id');
    await sleep(200);
    await cdp.click('#refreshSaveBtn');
    await sleep(400);
    const after = await cdp.eval(`(() => {
      const inp = document.querySelector('#modelsTableBody tr [data-field=id]');
      return inp ? inp.value : null;
    })()`);
    // FIXED (bug #40): saveRefresh and _rightPanelIds now prefer the live
    // input value over the stale data-full-id attribute.
    if (after !== 'renamed-model-id')
      throw new Error('model id edit was discarded on Save: before=' + JSON.stringify(before) + ' after=' + JSON.stringify(after));
    return 'edited the first model id to "renamed-model-id" in the refresh modal; after Save the table shows "' + after + '"';
  }
});

scenarios.push({
  id: 41,
  name: 'Tray "New Chat" applies the "New Chats Start With" default (static check of the tray path)',
  regression: true, // FIXED bug kept as a regression check (tray-started chats must start with the configured default)
  mode: null,
  noApp: true,
  async body() {
    const mainSrc = fs.readFileSync(path.join(launcher.REPO_ROOT, 'Main.ahk'), 'utf8');
    const trayMenuSrc = fs.readFileSync(path.join(launcher.REPO_ROOT, 'app', 'TrayMenu.ahk'), 'utf8');
    const sidebarSrc = fs.readFileSync(path.join(launcher.REPO_ROOT, 'chat', 'callbacks', 'Sidebar.ahk'), 'utf8');
    const utilsSrc = fs.readFileSync(path.join(launcher.REPO_ROOT, 'chat', 'ChatUtils.ahk'), 'utf8');
    const ipcSrc = fs.readFileSync(path.join(launcher.REPO_ROOT, 'chat', 'ChatIPC.ahk'), 'utf8');
    const settingsSrc = fs.readFileSync(path.join(launcher.REPO_ROOT, 'chat', 'ChatSettings.ahk'), 'utf8');
    // Tray "New Chat" creates the thread directly and opens it (the tray menu
    // build lives in app/TrayMenu.ahk since bug #37).
    const trayNewChat = /openChatWindow\(ChatDB\.Thread_Create\(\)\)/.test(trayMenuSrc);
    // FIXED (bug #41): the unified loader path now applies the new-chat
    // default to fresh (message-less, settings-less) threads.
    const loaderApplies = ipcSrc.includes('_applyNewChatDefaultToFreshThread(threadId)');
    const helperExists = settingsSrc.includes('_applyNewChatDefaultToFreshThread(threadId)');
    // The sidebar newChat action resolves the same fresh-chat preference at creation.
    const freshResolverExists = settingsSrc.includes('_prepareFreshChatSettings()');
    const sidebarApplies = sidebarSrc.includes('_prepareFreshChatSettings()');
    if (!trayNewChat || !loaderApplies || !helperExists || !freshResolverExists || !sidebarApplies)
      throw new Error('tray new-chat default wiring missing: trayNewChat=' + trayNewChat +
        ' loaderApplies=' + loaderApplies + ' helperExists=' + helperExists +
        ' freshResolverExists=' + freshResolverExists + ' sidebarApplies=' + sidebarApplies);
    return 'LoadThreadIntoUI applies _applyNewChatDefaultToFreshThread to fresh threads, so tray "New Chat" starts with the configured default';
  }
});

scenarios.push({
  id: 45,
  name: '"Response Font" is applied to chat messages at startup and after saves',
  regression: true, // FIXED bug kept as a regression check (response font must apply without opening Settings)
  mode: null,
  settings: { ui: { responseFont: 'Georgia' } },
  fixtures: {
    threads: [{ id: 't-font-45', title: 'Font Face Thread', active_leaf_id: 'm-font-45' }],
    messages: [{ id: 'm-font-45', thread_id: 't-font-45', role: 'assistant', content: 'hello world', model: 'deepseek/deepseek-v4-flash' }]
  },
  async body({ cdp }) {
    await showChat();
    await cdp.waitFor('document.querySelectorAll("#thread-list .chat-item").length > 0', 15000, 300, 'thread list');
    await cdp.click('#thread-list .chat-item');
    await cdp.waitFor('document.querySelectorAll("#chat-messages .msg").length >= 1', 15000, 300, 'thread loaded');
    await sleep(500);
    const familyBefore = await cdp.eval(`getComputedStyle(document.querySelector('.msg-content')).fontFamily`);
    const varBefore = await cdp.eval(`getComputedStyle(document.documentElement).getPropertyValue('--chat-font-family').trim()`);
    // FIXED (bug #45): appSettings is re-pushed on webViewReady and after
    // saves, so ui-theme.js applies --chat-font-family at startup.
    if (String(familyBefore).indexOf('Georgia') < 0)
      throw new Error('response font was not applied at startup: ' + JSON.stringify(familyBefore) + ' var=' + JSON.stringify(varBefore));
    if (String(varBefore).indexOf('Georgia') < 0)
      throw new Error('--chat-font-family not set at startup: ' + JSON.stringify(varBefore));
    return 'configured ui.responseFont=Georgia applied at startup: msg font=' + JSON.stringify(familyBefore) + ' (var=' + JSON.stringify(varBefore) + ')';
  }
});

scenarios.push({
  id: 47,
  name: 'Per-thread system prompt / temperature edits are discarded on reload when an assistant is active',
  regression: true, // FIXED bug kept as a regression check (overrides must survive reloads)
  mode: null,
  settings: {
    assistants: [{
      id: 'asst-47', name: 'Test Assistant', baseModel: 'deepseek/deepseek-v4-flash',
      systemMessage: 'assistant system', systemMessageFile: '', description: '',
      reasoning: 'high', temperature: '0.3'
    }]
  },
  fixtures: {
    threads: [{ id: 't-asst-47', title: 'Assistant Thread', active_leaf_id: 'm-asst-47', assistant_id: 'asst-47' }],
    messages: [{ id: 'm-asst-47', thread_id: 't-asst-47', role: 'user', content: 'hello' }]
  },
  async body({ cdp, dbPath }) {
    await showChat();
    await cdp.waitFor('document.querySelectorAll("#thread-list .chat-item").length > 0', 15000, 300, 'thread list');
    await cdp.click('#thread-list .chat-item');
    await cdp.waitFor('document.querySelectorAll("#chat-messages .msg").length >= 1', 15000, 300, 'thread loaded');
    await sleep(700);
    // Edit the system prompt while the assistant is active (right-rail modal).
    await cdp.click('#expandSysMsg');
    await cdp.waitFor('document.getElementById("sysMsgOverlay").classList.contains("open")', 5000, 200, 'sysmsg overlay');
    await cdp.type('#sysMsgFull', 'user override');
    await cdp.click('#sysMsgSave');
    await sleep(900); // 300ms debounce + IPC round trip
    const miniAfter = await cdp.eval('document.getElementById("sysMsgMini").value');
    if (miniAfter !== 'user override')
      throw new Error('system prompt edit did not apply (setup): ' + JSON.stringify(miniAfter));
    // Reload the thread (click the same sidebar item -> _restoreThreadSettings).
    await cdp.eval(`(() => {
      const items = document.querySelectorAll('#thread-list .chat-item');
      if (!items[0]) return false;
      items[0].click();
      return true;
    })()`);
    await cdp.waitFor('document.querySelectorAll("#chat-messages .msg").length >= 1', 15000, 300, 'thread reloaded');
    await sleep(700);
    const miniReloaded = await cdp.eval('document.getElementById("sysMsgMini").value');
    const rows = seed.query(dbPath, "SELECT system_override, temperature_override FROM chat_threads WHERE id='t-asst-47'");
    // FIXED (bug #47): the per-thread override is persisted AND wins over the
    // assistant's defaults when the thread reloads.
    if (miniReloaded !== 'user override')
      throw new Error('per-thread override did not survive the reload: "' + miniReloaded + '" (DB system_override=' +
        JSON.stringify(rows[0] && rows[0].system_override) + ')');
    return 'edited system prompt to "user override" with assistant active; after reload the rail still shows "' +
      miniReloaded + '" (DB system_override=' + JSON.stringify(rows[0] && rows[0].system_override) + ')';
  }
});

scenarios.push({
  id: 60,
  name: 'Typing a system prompt directly into the right-rail field never reaches the API request',
  regression: true, // FIXED bug kept as a regression check (direct typing must reach the API request)
  mode: 'sse-success',
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
    // FIXED (bug #60): typing into #sysMsgMini now updates requestParams, so
    // the sent request must carry the typed system message.
    if (!containsTyped)
      throw new Error('typed message did not reach the request: ' + JSON.stringify(sysMsg));
    return 'typed directly into the rail field; the sent request carries "DIRECT TYPED MESSAGE" (head=' +
      JSON.stringify(sysMsg[0] ? sysMsg[0].slice(0, 50) : '(none)') + ')';
  }
});

scenarios.push({
  id: 120,
  name: 'Lowering Trash Retention in Settings does NOT purge expired trash - the settings-update purge hook fails at runtime',
  regression: true, // FIXED bug kept as a regression check (retention changes must purge expired trash immediately)
  mode: null,
  settings: { trash: { retentionDays: 30 } },
  fixtures: {
    threads: [
      // Deleted 19 days ago: survives the startup purge (retention 30) but
      // must be purged the moment retention is lowered to 1 and saved.
      { id: 't-trash-120', title: 'To Purge', is_deleted: 1, deleted_at: retentionFixtureDate },
      { id: 't-live-120', title: 'Live Thread', active_leaf_id: 'm-120-u1' }
    ],
    messages: [{ id: 'm-120-u1', thread_id: 't-live-120', role: 'user', content: 'hello' }]
  },
  async body({ cdp, dbPath, dataDir }) {
    await showChat();
    await cdp.waitFor('document.querySelectorAll("#thread-list .chat-item").length > 0', 15000, 300, 'thread list');
    // Sanity: with retention 30 the 19-day-old trashed thread must still exist
    // (startup purge must NOT have removed it).
    await sleep(1500);
    if (seed.query(dbPath, "SELECT id FROM chat_threads WHERE id='t-trash-120'").length !== 1)
      throw new Error('setup: trashed thread was purged before the retention change');

    // 1) General tab: lower trash retention to 1 and save.
    await openSettings(cdp);
    await openSection(cdp, 'general');
    const settingsFile = path.join(dataDir, 'settings.json');
    const beforeRetentionSave = fs.readFileSync(settingsFile, 'utf8');
    await cdp.eval('(() => { const el = document.getElementById("trashRetentionDays"); el.value = "1"; el.dispatchEvent(new Event("input", { bubbles: true })); el.dispatchEvent(new Event("change", { bubbles: true })); const button = document.querySelector(".nav-footer .btn-primary"); button.disabled = false; button.click(); return el.value; })()');
    await cdp.waitFor('window.SettingsPanel && window.SettingsPanel.isDirty && window.SettingsPanel.isDirty() === false', 20000, 100, 'retention save completed');
    const saveDeadline = Date.now() + 20000;
    let afterSave = null;
    while (Date.now() < saveDeadline) {
      try {
        const current = readJsonFile(settingsFile);
        if (current !== null && Number(current.trash && current.trash.retentionDays) === 1 && fs.readFileSync(settingsFile, 'utf8') !== beforeRetentionSave) { afterSave = current; break; }
      } catch {}
      await sleep(100);
    }
    if (!afterSave) afterSave = readJsonFile(settingsFile);
    if (!afterSave.trash || afterSave.trash.retentionDays !== 1)
      throw new Error('trash retention not persisted: ' + JSON.stringify(afterSave.trash));
    // The Main process reloads on WM_SETTINGS_UPDATED and re-runs the purge
    // hook. FIXED (bug #120): the hook is now a plain zero-arg wrapper
    // (TrashRetentionPurge) instead of the bare static-method reference
    // ChatDB.Thread_PurgeExpired, which AHK cannot invoke via fn.Call()
    // ("hook 'purgeExpired' failed: Missing a required parameter."), so the
    // expired trashed thread must be purged right after the save.
    const start = Date.now();
    let purged = false;
    while (Date.now() - start < 6000) {
      if (seed.query(dbPath, "SELECT id FROM chat_threads WHERE id='t-trash-120'").length === 0) { purged = true; break; }
      await sleep(300);
    }
    if (!purged)
      throw new Error('trashed thread was NOT purged after saving retention 1 (bug #120 still reproduces)');

    // 2) UI & Theme tab: change the default response font size to 20 and save.
    await openSection(cdp, 'ui');
    await cdp.eval('(() => { const el = document.getElementById("responseFontSize"); el.value = "20"; el.dispatchEvent(new Event("change", { bubbles: true })); return el.value; })()');
    await cdp.click('.nav-footer .btn-primary');
    // The saveSettings helper's "has models" poll returns instantly on a second
    // save (the key is already on disk), so poll for the actual value here.
    const start2 = Date.now();
    let afterSave2 = null;
    while (Date.now() - start2 < 15000) {
      try {
        const j = readJsonFile(path.join(dataDir, 'settings.json'));
        if (j.ui && j.ui.responseFontSize === '20') { afterSave2 = j; break; }
      } catch {}
      await sleep(300);
    }
    if (!afterSave2)
      throw new Error('responseFontSize not persisted: ' + JSON.stringify(afterSave2));
    // The settings DID persist and the app accepted them - only the purge hook
    // is broken. Continue verifying that OTHER settings still round-trip, so
    // the failure is isolated to the purge path.

    // 3) New Chat must start with the new default font size (20px) applied.
    await cdp.click('#sidebar-toggle'); // back to chat view
    await sleep(500);
    const oldThread = await cdp.eval('window.activeThreadId');
    await cdp.click('#new-chat-btn');
    await cdp.waitFor('window.activeThreadId !== ' + JSON.stringify(oldThread), 15000, 300, 'new chat created');
    await cdp.waitFor('document.getElementById("font-size-display") && document.getElementById("font-size-display").textContent === "20px"', 15000, 300, 'font size applied');
    const cssFont = await cdp.eval('document.documentElement.style.getPropertyValue("--chat-font-size").trim()');
    const newThread = await cdp.eval('window.activeThreadId');
    const row = seed.query(dbPath, 'SELECT font_size FROM chat_threads WHERE id = ?', [newThread])[0];
    if (cssFont !== '20px' || !row || Number(row.font_size) !== 20)
      throw new Error('new chat font size not reflected: css=' + JSON.stringify(cssFont) + ' db=' + JSON.stringify(row));
    return 'retention 30->1 persisted and t-trash-120 (deleted 19 days ago) WAS purged after saving ' +
      '(hook "purgeExpired" now runs via the TrashRetentionPurge wrapper); responseFontSize 17->20 persisted and new chat ' +
      newThread + ' has font_size=' + row.font_size + ' and --chat-font-size=' + cssFont;
  }
});

scenarios.push({
  id: 122,
  name: 'Saving Settings silently drops assistant temperature and isDefault (the Assistants tab save() only emits the card fields)',
  regression: true, // FIXED bug kept as a regression check (assistant temperature/isDefault survive a save)
  mode: null,
  settings: {
    assistants: [{
      id: 'asst-temp-122', name: 'Temp Assistant', baseModel: 'deepseek/deepseek-v4-flash',
      systemMessage: '', systemMessageFile: '', description: '', reasoning: 'high',
      temperature: '0.7', isDefault: true
    }]
  },
  async body({ cdp, dataDir, dbPath }) {
    await showChat();
    await cdp.waitFor('typeof window.assistantList !== "undefined" && window.assistantList.length === 1', 15000, 300, 'assistant list');
    // Sanity: the assistant arrives WITH its configured temperature.
    const before = await cdp.eval('window.assistantList[0].temperature');
    if (before !== '0.7')
      throw new Error('assistant did not arrive with temperature 0.7: ' + JSON.stringify(before));
    // Open Settings and make one harmless change so Save is enabled.
    await openSettings(cdp);
    // Wait until the settings panel has actually received the merged payload
    // (loadSettings -> clearDirty disables the Save button; until then
    // _currentSettings is unset and clicking Save silently does nothing).
    await cdp.waitFor('document.querySelector(".nav-footer .btn-primary") && document.querySelector(".nav-footer .btn-primary").disabled === true', 15000, 250, 'settings payload loaded');
    // Make one harmless General change so Save is enabled. This scenario is
    // about preserving assistant metadata, not command-menu key validation.

    await cdp.eval('(() => { const el = document.getElementById("apiLogMaxEntries"); el.value = "21"; el.dispatchEvent(new Event("input", { bubbles: true })); el.dispatchEvent(new Event("change", { bubbles: true })); return el.value; })()');
    await saveSettings(cdp, dataDir);
    await sleep(800);
    // FIXED (bug #122): assistants.js save() reads temperature/isDefault back
    // from the card dataset, and SettingsApply._ApplyAssistants carries them
    // into the runtime globals, so the save round-trip preserves both.
    const saved = readJsonFile(path.join(dataDir, 'settings.json'));
    const asst = (saved.assistants || []).find((a) => a.id === 'asst-temp-122');
    if (!asst) throw new Error('assistant missing from settings.json after save');
    if (asst.temperature !== '0.7')
      throw new Error('assistant temperature was dropped by the save (bug #122 not fixed): ' + JSON.stringify(asst));
    // AHK has no boolean type - jsongo persists true as 1, so accept any
    // truthy value (the bug was the key being dropped entirely).
    if (!asst.isDefault)
      throw new Error('assistant isDefault was dropped by the save (bug #122 not fixed): ' + JSON.stringify(asst));
    // AHK re-pushes assistantList after the save; the re-pushed copy must keep
    // the configured temperature.
    const start2 = Date.now();
    let afterList = null;
    while (Date.now() - start2 < 8000) {
      afterList = await cdp.eval('window.assistantList && window.assistantList[0] ? window.assistantList[0] : null');
      if (afterList && afterList.temperature === '0.7') break;
      await sleep(300);
    }
    if (!afterList || afterList.temperature !== '0.7')
      throw new Error('runtime assistantList lost temperature after save (bug #122 not fixed): ' + JSON.stringify(afterList));
    return 'assistant temperature 0.7 / isDefault true survived the Settings save round-trip in settings.json and the re-pushed assistantList';
  }
});

scenarios.push({
  id: 130,
  name: 'Saving Settings wipes a custom (unlisted) "Response Font" - the select has no matching option so save() emits an empty value',
  regression: true, // FIXED bug kept as a regression check (custom fonts survive a save round-trip)
  mode: null,
  settings: { ui: { responseFont: 'Courier New', responseFontSize: '17' } },
  fixtures: {
    threads: [{ id: 't-font-130', title: 'Custom Font', active_leaf_id: 'm-130-a1' }],
    messages: [{ id: 'm-130-a1', thread_id: 't-font-130', role: 'assistant', content: 'hello', model: 'deepseek/deepseek-v4-flash' }]
  },
  async body({ cdp, dataDir }) {
    const settingsFile = require('node:path').join(dataDir, 'settings.json');
    const before = readJsonFile(settingsFile);
    if (before.ui.responseFont !== 'Courier New')
      throw new Error('seed did not carry the custom font (setup): ' + JSON.stringify(before.ui));
    await openSettings(cdp);
    await openSection(cdp, 'ui');
    await cdp.waitFor('document.getElementById("responseFont") !== null', 10000, 250, 'ui section');
    // The select has NO "Courier New" option - load() assigns the raw value,
    // leaving the select with an empty selection.
    const selValue = await cdp.eval('document.getElementById("responseFont").value');
    if (selValue !== '')
      throw new Error('select unexpectedly matched the custom font: ' + JSON.stringify(selValue));
    // Make the panel dirty with a no-op edit on another UI field, then save.
    await cdp.type('#iwWidth', '500');
    await saveSettings(cdp, dataDir);
    const after = readJsonFile(settingsFile);
    // FIXED (bug #130): save() falls back to the recorded stored value when
    // the select has no matching option (same class as #39's custom
    // system-message file), so the custom font survives the round-trip.
    if (after.ui.responseFont !== 'Courier New')
      throw new Error('custom font was wiped by the save (bug #130 not fixed): ' + JSON.stringify(after.ui.responseFont));
    return 'seeded ui.responseFont="Courier New" (not one of the 5 select options); after opening Settings and saving, settings.json has responseFont="' +
      after.ui.responseFont + '" - the custom font survives';
  }
});

scenarios.push({
  id: 134,
  name: 'General and Shortcuts settings round-trip and live application (new-chat assistant, title-gen off, API log cap, trash days, Open Chat key)',
  mode: 'sse-success',
  regression: true, // audit: General + Shortcuts settings persist, reload and apply live
  settings: {},
  async body({ cdp, dataDir, mockLog, endpoint }) {
    const os = require('node:os');
    await showChat();
    await cdp.waitFor('typeof window.assistantList !== "undefined" && window.assistantList.length > 0', 15000, 300, 'assistant list');
    const asst = await cdp.eval('window.assistantList[0]');
    if (!asst || !asst.id || !asst.name) throw new Error('no assistant to select: ' + JSON.stringify(asst));

    await openSettings(cdp);
    await openSection(cdp, 'general');
    await cdp.waitFor('document.getElementById("newChatStartsWith") !== null', 10000, 250, 'general fields');
    await cdp.waitFor('Array.from(document.getElementById("newChatStartsWith").options).some((option) => option.value === "asst:' + asst.id + '")', 10000, 100, 'assistant option loaded');
    // Set and save General in one renderer turn so a delayed settings payload
    // cannot reset the controls between the edit and the Save click.
    await cdp.clearPosted();
    await cdp.eval('(() => { const id = "asst:' + asst.id + '"; const n = document.getElementById("newChatStartsWith"); if (![...n.options].some((o) => o.value === id)) { const o = document.createElement("option"); o.value = id; o.textContent = "selected assistant"; n.appendChild(o); } n.value = id; n.dispatchEvent(new Event("change", { bubbles: true })); const t = document.getElementById("titleGenToggle"); if (t.classList.contains("on")) t.click(); const logs = document.getElementById("apiLogMaxEntries"); logs.value = "3"; logs.dispatchEvent(new Event("change", { bubbles: true })); const trash = document.getElementById("trashRetentionDays"); trash.value = "7"; trash.dispatchEvent(new Event("change", { bubbles: true })); const b = document.querySelector(".nav-footer .btn-primary"); b.disabled = false; b.click(); return { id: n.value, logs: logs.value, trash: trash.value }; })()');
    await cdp.waitFor('window.SettingsPanel && window.SettingsPanel.isDirty && window.SettingsPanel.isDirty() === false', 20000, 100, 'general save completed');
    const generalDeadline = Date.now() + 20000;
    let generalSaved = null;
    while (Date.now() < generalDeadline) {
      try {
        const current = readJsonFile(path.join(dataDir, 'settings.json'));
        if (current.newChatStartsWith === 'asst:' + asst.id && Number(current.apiLogs.maxEntries) === 3 && Number(current.trash.retentionDays) === 7 && !current.threadTitles.enabled) { generalSaved = current; break; }
      } catch {}
      await sleep(100);
    }
    if (!generalSaved)
      throw new Error('General settings did not persist before shortcuts save');
    await openSection(cdp, 'hotkeys');
    await cdp.waitFor('document.getElementById("chatShortcut") !== null', 10000, 250, 'shortcuts fields');
    // SettingsPanel.saveSettings() collects every registered section, not just
    // the visible one. Under parallel load, the post-save settings refresh can
    // briefly repopulate the hidden General controls with an older snapshot.
    // Reassert both sections and click Save in one renderer turn so no queued
    // refresh can land between the values being set and the payload capture.
    const shortcutFileBefore = fs.readFileSync(path.join(dataDir, 'settings.json'), 'utf8');
    const expectedAssistant = JSON.stringify('asst:' + asst.id);
    await cdp.eval(`(() => {
      const n = document.getElementById('newChatStartsWith');
      const id = ${expectedAssistant};
      if (![...n.options].some((o) => o.value === id)) {
        const o = document.createElement('option');
        o.value = id;
        o.textContent = 'selected assistant';
        n.appendChild(o);
      }
      n.value = id;
      n.dispatchEvent(new Event('change', { bubbles: true }));
      document.getElementById('titleGenToggle').classList.remove('on');
      const logs = document.getElementById('apiLogMaxEntries');
      logs.value = '3';
      logs.dispatchEvent(new Event('change', { bubbles: true }));
      const trash = document.getElementById('trashRetentionDays');
      trash.value = '7';
      trash.dispatchEvent(new Event('change', { bubbles: true }));
      const shortcut = document.getElementById('chatShortcut');
      shortcut.value = '9';
      shortcut.dispatchEvent(new Event('input', { bubbles: true }));
      shortcut.dispatchEvent(new Event('change', { bubbles: true }));
      const button = document.querySelector('.nav-footer .btn-primary');
      button.disabled = false;
      button.click();
      return { newChatStartsWith: n.value, chatShortcut: shortcut.value };
    })()`);
    await cdp.waitFor('document.querySelector(".nav-footer .btn-primary") && document.querySelector(".nav-footer .btn-primary").disabled === true', 20000, 100, 'shortcuts save acknowledgement');
    await cdp.waitFor('window.SettingsPanel && window.SettingsPanel.isDirty && window.SettingsPanel.isDirty() === false', 20000, 100, 'shortcuts save completed');
    const shortcutDeadline = Date.now() + 20000;
    while (Date.now() < shortcutDeadline) {
      try {
        if (fs.readFileSync(path.join(dataDir, 'settings.json'), 'utf8') !== shortcutFileBefore) break;
      } catch {}
      await sleep(100);
    }
    if (Date.now() >= shortcutDeadline)
      throw new Error('shortcuts save did not update settings.json');
    await sleep(800);

    // Persisted on disk.
    const saved = readJsonFile(path.join(dataDir, 'settings.json'));
    if (!saved.newChatStartsWith || saved.newChatStartsWith !== 'asst:' + asst.id)
      throw new Error('newChatStartsWith not persisted: ' + JSON.stringify(saved.newChatStartsWith));
    if (saved.threadTitles.enabled) throw new Error('threadTitles.enabled not persisted as false: ' + JSON.stringify(saved.threadTitles));
    if (Number(saved.apiLogs.maxEntries) !== 3) throw new Error('apiLogs.maxEntries not persisted: ' + JSON.stringify(saved.apiLogs));
    if (Number(saved.trash.retentionDays) !== 7) throw new Error('trash.retentionDays not persisted: ' + JSON.stringify(saved.trash));
    if (saved.chatShortcut !== '9') throw new Error('chatShortcut not persisted: ' + JSON.stringify(saved.chatShortcut));

    // Reload round-trip: reopen Settings and verify the fields repopulate.
    await hideSettingsToChat(cdp);
    await openSettings(cdp);
    await openSection(cdp, 'general');
    await sleep(400);
    const reloadedGeneral = await cdp.eval('({ ncs: document.getElementById("newChatStartsWith").value, titleOn: document.getElementById("titleGenToggle").classList.contains("on"), logs: document.getElementById("apiLogMaxEntries").value, trash: document.getElementById("trashRetentionDays").value })');
    await openSection(cdp, 'hotkeys');
    const reloadedShortcut = await cdp.eval('document.getElementById("chatShortcut").value');
    if (reloadedGeneral.ncs !== 'asst:' + asst.id || reloadedGeneral.titleOn !== false || reloadedGeneral.logs !== '3' || reloadedGeneral.trash !== '7' || reloadedShortcut !== '9')
      throw new Error('settings fields did not round-trip: general=' + JSON.stringify(reloadedGeneral) + ' openChatKey=' + JSON.stringify(reloadedShortcut));
    await hideSettingsToChat(cdp);

    // Application 1: New Chat from the sidebar starts with the chosen assistant.
    await cdp.click('#new-chat-btn');
    await sleep(900);
    const cardName = await cdp.eval('document.querySelector("#modelCardTrigger .name") ? document.querySelector("#modelCardTrigger .name").textContent : ""');
    if (String(cardName).indexOf(asst.name) < 0)
      throw new Error('new chat did not start with the assistant: card=' + JSON.stringify(cardName) + ' expected ' + asst.name);

    // Application 2: send a chat message - the request must use the
    // assistant's base model, and with title-gen disabled NO title request may
    // hit the mock (modeUsed 'title' / max_tokens 50).
    await sendChatMessage(cdp, 'check the default');
    await waitStreamingIdle(cdp, 40000);
    await sleep(1500);
    const logLines = fs.existsSync(mockLog) ? fs.readFileSync(mockLog, 'utf8').trim().split(/\r?\n/).filter(Boolean) : [];
    const requests = logLines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    const chatReqs = requests.filter((r) => r.body && r.body.messages && !r.body.prompt);
    const titleReqs = requests.filter((r) => r.body && r.body.max_tokens === 50);
    if (!chatReqs.length) throw new Error('no chat request reached the mock: ' + JSON.stringify(requests));
    const lastChatModel = String(chatReqs[chatReqs.length - 1].body.model || '');
    const asstModelShort = String(asst.baseModel || '').split('/').pop();
    if (lastChatModel.indexOf(asstModelShort) < 0 && lastChatModel !== asst.baseModel)
      throw new Error('chat request did not use the assistant model: sent=' + JSON.stringify(lastChatModel) + ' expected base=' + asst.baseModel);
    if (titleReqs.length !== 0)
      throw new Error('title generation still fired with threadTitles.enabled=false: ' + JSON.stringify(titleReqs));

    // Application 3: API log file capped at maxEntries after the save.
    const apiLog = path.join(os.tmpdir(), 'LLM_API_Log.json');
    let apiCount = 0;
    if (fs.existsSync(apiLog)) {
      try { apiCount = JSON.parse(fs.readFileSync(apiLog, 'utf8')).length; } catch {}
    }
    if (apiCount > 3)
      throw new Error('API log not trimmed to maxEntries=3: ' + apiCount + ' entries');

    return 'round-trip OK (newChatStartsWith=asst:' + asst.id + ', titleGen off, apiLogs=3, trash=7, openChatKey=9); new chat card=' +
      JSON.stringify(cardName) + '; chat request model=' + lastChatModel + '; title requests=' + titleReqs.length +
      '; API log entries=' + apiCount;
  }
});

scenarios.push({
  id: 137,
  name: 'UI/Theme and Menu Items settings round-trip with live CSS application (response font applies after save)',
  mode: null,
  regression: true, // audit: UI/Theme + Menu Items settings persist, reload and apply live
  settings: {},
  async body({ cdp, dataDir }) {
    await showChat();
    await openSettings(cdp);
    await openSection(cdp, 'ui');
    await cdp.waitFor('document.getElementById("responseFont") !== null', 10000, 250, 'ui section');
    // Change the response font to a listed option and the font size to 18.
    await cdp.eval('(() => { const s = document.getElementById("responseFont"); for (let i = 0; i < s.options.length; i++) { if (s.options[i].value === "Georgia") { s.selectedIndex = i; break; } } s.dispatchEvent(new Event("change", { bubbles: true })); return s.value; })()');
    await cdp.eval('(() => { const el = document.getElementById("responseFontSize"); el.value = "18"; el.dispatchEvent(new Event("change", { bubbles: true })); return true; })()');
    // Change the input-window background color.
    await cdp.eval('(() => { const el = document.getElementById("iwBackground"); el.value = "#123456"; el.dispatchEvent(new Event("input", { bubbles: true })); document.getElementById("iwBackgroundHex").value = "0x123456"; return true; })()');
    await saveSettings(cdp, dataDir);
    await sleep(800);

    const saved = readJsonFile(path.join(dataDir, 'settings.json'));
    if (saved.ui.responseFont !== 'Georgia') throw new Error('ui.responseFont not persisted: ' + JSON.stringify(saved.ui.responseFont));
    if (saved.ui.responseFontSize !== '18') throw new Error('ui.responseFontSize not persisted: ' + JSON.stringify(saved.ui.responseFontSize));
    if (saved.ui.inputWindow.background !== '0x123456') throw new Error('inputWindow.background not persisted: ' + JSON.stringify(saved.ui.inputWindow.background));

    // Live application: the response font CSS var must update without reopening Settings.
    const fontVar = await cdp.eval('getComputedStyle(document.documentElement).getPropertyValue("--chat-font-family").trim()');
    if (String(fontVar).indexOf('Georgia') < 0)
      throw new Error('--chat-font-family not applied after save: ' + JSON.stringify(fontVar));

    // Reload round-trip.
    await hideSettingsToChat(cdp);
    await openSettings(cdp);
    await openSection(cdp, 'ui');
    await sleep(400);
    const reloaded = await cdp.eval('({ rf: document.getElementById("responseFont").value, rfs: document.getElementById("responseFontSize").value, iwb: document.getElementById("iwBackground").value })');
    if (reloaded.rf !== 'Georgia' || reloaded.rfs !== '18' || String(reloaded.iwb).toUpperCase() !== '#123456')
      throw new Error('ui fields did not round-trip: ' + JSON.stringify(reloaded));

    // Menu Items: add a Quick Access row and save.
    await openSection(cdp, 'menu');
    await cdp.waitFor('document.getElementById("qaTableBody") !== null', 10000, 250, 'menu section');
    await cdp.click('#addQaRow');
    await sleep(300);
    const rowsBefore = await cdp.eval('document.querySelectorAll("#qaTableBody tr").length');
    // This save also collects the hidden UI section. Reassert the UI values
    // and the new menu row in the same renderer turn so a delayed settings
    // refresh cannot replace the UI controls with an older snapshot first.
    const menuFileBefore = fs.readFileSync(path.join(dataDir, 'settings.json'), 'utf8');
    await cdp.eval(`(() => {
      const font = document.getElementById('responseFont');
      font.value = 'Georgia';
      font.dispatchEvent(new Event('change', { bubbles: true }));
      const size = document.getElementById('responseFontSize');
      size.value = '18';
      size.dispatchEvent(new Event('change', { bubbles: true }));
      const bg = document.getElementById('iwBackground');
      bg.value = '#123456';
      bg.dispatchEvent(new Event('input', { bubbles: true }));
      document.getElementById('iwBackgroundHex').value = '0x123456';
      const tr = document.querySelector('#qaTableBody tr:last-child');
      const inputs = tr.querySelectorAll('input');
      inputs[0].value = '&9 - Test';
      inputs[1].value = 'https://example.com';
      inputs.forEach((i) => i.dispatchEvent(new Event('input', { bubbles: true })));
      const button = document.querySelector('.nav-footer .btn-primary');
      button.disabled = false;
      button.click();
      return { font: font.value, size: size.value, background: bg.value, menu: inputs[0].value };
    })()`);
    await cdp.waitFor('document.querySelector(".nav-footer .btn-primary") && document.querySelector(".nav-footer .btn-primary").disabled === true', 20000, 100, 'menu save acknowledgement');
    await cdp.waitFor('window.SettingsPanel && window.SettingsPanel.isDirty && window.SettingsPanel.isDirty() === false', 20000, 100, 'menu save completed');
    const menuDeadline = Date.now() + 20000;
    while (Date.now() < menuDeadline) {
      try {
        if (fs.readFileSync(path.join(dataDir, 'settings.json'), 'utf8') !== menuFileBefore) break;
      } catch {}
      await sleep(100);
    }
    if (Date.now() >= menuDeadline)
      throw new Error('menu save did not update settings.json');
    await sleep(800);
    const saved2 = readJsonFile(path.join(dataDir, 'settings.json'));
    const qa = saved2.menuItems.quickAccess;
    const added = qa.find((i) => i.menuText === '&9 - Test' && i.command === 'https://example.com');
    if (!added) throw new Error('quick-access row not persisted: ' + JSON.stringify(qa));
    return 'ui round-trip: responseFont=Georgia size=18 iwBg=0x123456 persisted + applied (--chat-font-family=' +
      JSON.stringify(fontVar) + '); reload shows ' + JSON.stringify(reloaded) + '; quick access rows before=' + rowsBefore +
      ' after=' + qa.length + ' (added &9 - Test)';
  }
});

scenarios.push({
  id: 152,
  regression: true, // audit: provider endpoint edits must be used by the NEXT request
  name: 'Changing a provider endpoint in Settings is used by the next request (live audit)',
  mode: 'sse-success',
  settings: {},
  async body({ cdp, dataDir, mockLog, endpoint }) {
    await showChat();
    // Exchange 1 hits the mock endpoint (the default deepseek endpoint).
    await sendChatMessage(cdp, 'first message');
    await waitStreamingIdle(cdp, 40000);
    await sleep(1000);
    const msgsBefore = await cdp.eval('chatMessages.length');
    if (msgsBefore < 2) throw new Error('setup: first exchange did not complete: ' + msgsBefore);
    const mockCount1 = fs.existsSync(mockLog) ? fs.readFileSync(mockLog, 'utf8').trim().split(/\r?\n/).filter(Boolean).length : 0;

    // Point the deepseek provider at a CLOSED port (a just-freed port) and save.
    const closedPort = await launcher.findFreePort();
    const closedEndpoint = 'http://127.0.0.1:' + closedPort + '/v1/chat/completions';
    await openSettings(cdp);
    await openSection(cdp, 'providers');
    await cdp.waitFor('document.querySelector("#providerGrid .provider-card input[data-field=endpoint]") !== null', 10000, 250, 'providers grid');
    await cdp.eval(`(() => {
      const cards = [...document.querySelectorAll('#providerGrid .provider-card')];
      const deepseek = cards.find((c) => c.dataset.providerKey === 'deepseek');
      if (!deepseek) return false;
      const inp = deepseek.querySelector('input[data-field=endpoint]');
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(inp, ${JSON.stringify(closedEndpoint)});
      inp.dispatchEvent(new Event('input', { bubbles: true }));
      return inp.value;
    })()`);
    await saveSettings(cdp, dataDir);
    await sleep(800);
    const savedAfter = readJsonFile(path.join(dataDir, 'settings.json'));
    if (savedAfter.providers.deepseek.endpoint !== closedEndpoint)
      throw new Error('endpoint edit did not persist to settings.json: ' + JSON.stringify(savedAfter.providers.deepseek));
    await hideSettingsToChat(cdp);

    // Exchange 2 must use the NEW (closed) endpoint -> connection refused.
    await sendChatMessage(cdp, 'second message');
    await waitStreamingIdle(cdp, 40000);
    await sleep(1000);
    const msgsAfter = await cdp.eval('chatMessages.length');
    const banners = await cdp.eval('[...document.querySelectorAll(".error-banner")].map((b) => b.textContent)');
    const mockCount2 = fs.existsSync(mockLog) ? fs.readFileSync(mockLog, 'utf8').trim().split(/\r?\n/).filter(Boolean).length : 0;
    // Diagnostic: what endpoint did the API logger record for the second request?
    const apiLog = path.join(require('node:os').tmpdir(), 'LLM_API_Log.json');
    let apiEntries = [];
    try { apiEntries = JSON.parse(fs.readFileSync(apiLog, 'utf8')); } catch {}
    // FIXED/expected behavior: the second request must use the NEW (closed)
    // endpoint -> connection refused: the user message is appended (so the
    // count grows by exactly 1), NO assistant message follows, and an error
    // banner appears. The API logger must record the CLOSED endpoint for it.
    if (msgsAfter !== msgsBefore + 1)
      throw new Error('second exchange produced an assistant message (endpoint change not applied?): msgsBefore=' + msgsBefore + ' msgsAfter=' + msgsAfter);
    if (!banners.length)
      throw new Error('no error banner after the endpoint change: ' + JSON.stringify(banners));
    const lastChat = apiEntries.find((e) => e.commandName === 'Chat');
    if (!lastChat || lastChat.endpoint !== closedEndpoint)
      throw new Error('second chat request did not use the closed endpoint: ' + JSON.stringify(lastChat));
    return 'after saving deepseek endpoint -> ' + closedEndpoint + ', the next request was refused (' +
      JSON.stringify(banners[0] || '') + ') - the edited endpoint is used live (mock requests ' + mockCount1 + '->' + mockCount2 + ')';
  }
});

scenarios.push({
  id: 153,
  name: 'Changing a model price in Settings re-prices the thread\'s HISTORICAL cumulative cost in the header (both calls at the new rate) while the dashboard keeps the original per-call costs - header and dashboard disagree',
  mode: 'sse-success',
  regression: true,
  settings: {
    models: {
      'deepseek/deepseek-v4-flash': {
        provider: 'deepseek', api: 'openai-completions',
        compat: { thinkingFormat: 'deepseek', supportsReasoningEffort: true, supportsUsageInStreaming: true, maxTokensField: 'max_tokens' },
        thinkingLevelMap: { none: 'none', low: 'low', high: 'high', max: 'max' },
        thinkingOff: 'disabled',
        input: 1400, cachedInput: 28, output: 2800, context: 1000000, reasoning: true, vision: false
      }
    }
  },
  async body({ cdp, dataDir, dbPath }) {
    await showChat();
    // Exchange 1 at input 1400 / cached 28 / output 2800 ($/M):
    // (12-4)*1400 + 4*28 + 9*2800 = 11200 + 112 + 25200 = 36512 / 1e6 = $0.036512
    await sendChatMessage(cdp, 'first message');
    await waitStreamingIdle(cdp, 40000);
    await sleep(1000);
    const usage1 = seed.query(dbPath, 'SELECT total_cost, input_cost, cached_input_cost, output_cost FROM chat_usage')[0];
    if (Math.abs(Number(usage1.total_cost) - 0.036512) > 0.00001)
      throw new Error('setup: first call cost wrong: ' + JSON.stringify(usage1));

    // Double the prices in Settings (input 2800 / cached 56 / output 5600) and save.
    await openSettings(cdp);
    await openSection(cdp, 'models');
    await cdp.waitFor('document.querySelector("#modelsTableBody input[data-field=input]") !== null', 10000, 250, 'models table');
    await cdp.eval(`(() => {
      const rows = [...document.querySelectorAll('#modelsTableBody tr')];
      const row = rows.find((r) => (r.querySelector('input[data-field=id]') || {}).value === 'deepseek-v4-flash');
      const target = row || rows[0];
      const set = (sel, v) => { const el = target.querySelector(sel); if (!el) return; const s = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; s.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('blur', { bubbles: true })); };
      set('input[data-field=input]', '2800');
      set('input[data-field=cachedInput]', '56');
      set('input[data-field=output]', '5600');
      return true;
    })()`);
    await saveSettings(cdp, dataDir);
    await sleep(800);
    const savedAfter = readJsonFile(path.join(dataDir, 'settings.json'));
    const savedModel = savedAfter.models && savedAfter.models['deepseek/deepseek-v4-flash'];
    if (!savedModel || Number(savedModel.input) !== 2800 || Number(savedModel.output) !== 5600)
      throw new Error('price edit did not persist to settings.json: ' + JSON.stringify(savedModel));
    await hideSettingsToChat(cdp);

    // Exchange 2 at the doubled prices: (12-4)*2800 + 4*56 + 9*5600 =
    // 22400 + 224 + 50400 = 73024 / 1e6 = $0.073024.
    // The DASHBOARD (chat_usage) correctly keeps each call's ORIGINAL price:
    // 0.036512 (old) + 0.073024 (new) = 0.109536.
    await sendChatMessage(cdp, 'second message');
    await waitStreamingIdle(cdp, 40000);
    await sleep(1200);
    const usage2 = seed.query(dbPath, 'SELECT total_cost, call_count FROM chat_usage')[0];
    if (Math.abs(Number(usage2.total_cost) - 0.109536) > 0.00001)
      throw new Error('price change not reflected in the second call: total=' + usage2.total_cost + ' (expected 0.109536)');
    const bar = await cdp.eval('document.getElementById("tokenBar").textContent');
    const thread = seed.query(dbPath, 'SELECT cumulative_cost FROM chat_threads')[0];
    // Fixed: each call snapshots its cost at insert time, so the recompute
    // sums the ORIGINAL per-call costs: 0.036512 + 0.073024 = 0.109536 -
    // the header now agrees with the dashboard.
    // BUG present: _RecomputeCumulativeCounters re-priced EVERY assistant row
    // with the CURRENT model prices (both at the doubled rate: $0.146048).
    if (Math.abs(Number(thread.cumulative_cost) - 0.109536) > 0.00001)
      throw new Error('header cumulative cost should keep the original per-call costs (BUG present?): ' + JSON.stringify(thread));
    if (String(bar).indexOf('$0.11') < 0)
      throw new Error('header should show the snapshot-summed $0.11: ' + JSON.stringify(bar));
    return 'exchange 1 cost=$' + usage1.total_cost + '; after doubling the model prices in Settings, exchange 2 total=$' +
      usage2.total_cost + ' (dashboard: 0.036512 + 0.073024 = 0.109536) and the thread cumulative_cost=' +
      thread.cumulative_cost + ' ($0.11 header) - historical costs keep their original snapshots, header and dashboard agree: ' + JSON.stringify(bar);
  }
});

scenarios.push({
  id: 158,
  name: 'Models tab: focusing and blurring the Context field corrupts "128K" -> 128 (the blur handler parseInt\'s the DISPLAY string, so the k/M suffix is lost and the saved model context shrinks 1000x)',
  mode: null,
  regression: true,
  noApp: true,
  settings: {},
  async body() {
    // Run the REAL webui/js/settings/sections/models.js in a vm sandbox (the
    // same approach as tests/unit/models-pricing-refresh.test.js) and drive
    // the actual focus/blur listeners + save().
    const sharedSrc = fs.readFileSync(path.join(launcher.REPO_ROOT, 'webui', 'js', 'shared', 'settings-shared.js'), 'utf-8');
    const src = fs.readFileSync(path.join(launcher.REPO_ROOT, 'webui', 'js', 'settings', 'sections', 'models.js'), 'utf-8');

    function makeEl(initial) {
      const el = {
        value: initial.value !== undefined ? String(initial.value) : '',
        raw: initial.raw !== undefined ? String(initial.raw) : null,
        checked: !!initial.checked,
        listeners: {},
        classList: { add() {}, remove() {}, toggle() {} },
        dataset: {}
      };
      el.getAttribute = (name) => (name === 'data-context-raw' || name === 'data-price-raw') ? el.raw : null;
      el.setAttribute = (name, v) => { if (name === 'data-context-raw' || name === 'data-price-raw') el.raw = String(v); };
      el.addEventListener = (type, fn) => { el.listeners[type] = fn; };
      el.focus = () => { if (el.listeners.focus) el.listeners.focus(); };
      el.blur = () => { if (el.listeners.blur) el.listeners.blur(); };
      return el;
    }

    let trRef = null;
    const idEl = makeEl({ value: 'deepseek-v4-flash' });
    const providerEl = makeEl({ value: 'deepseek' });
    const inputEl = makeEl({ value: '0.14', raw: '0.14' });
    const cachedEl = makeEl({ value: '', raw: '' });
    const outputEl = makeEl({ value: '0.28', raw: '0.28' });
    const contextEl = makeEl({ value: '128K' });
    const visionEl = makeEl({ value: 'on', checked: false });
    const reasoningEl = makeEl({ value: 'on', checked: true });
    const fields = {
      '[data-field="id"]': idEl,
      '[data-field="provider"]': providerEl,
      '[data-field="input"]': inputEl,
      '[data-field="cachedInput"]': cachedEl,
      '[data-field="output"]': outputEl,
      '[data-field="context"]': contextEl,
      '[data-field="vision"]': visionEl,
      '[data-field="reasoning"]': reasoningEl
    };
    const tr = {
      dataset: {},
      innerHTML: '',
      querySelector: (sel) => fields[sel] || null,
      // _wirePriceContext calls querySelectorAll('[data-price-raw]') and
      // _wireFields may query other selectors - return every field so the
      // wiring actually attaches to the pre-created elements (the inert
      // innerHTML assignment never populates them).
      querySelectorAll: () => Object.values(fields),
      addEventListener() {},
      remove() {}
    };
    fields['.btn-sm.danger'] = makeEl({ value: '' });
    const tbody = {
      innerHTML: '',
      appendChild(child) { trRef = child; }
    };
    const registeredSections = {};
    const sandbox = {
      document: {
        getElementById: (id) => (id === 'modelsTableBody' ? tbody : null),
        querySelectorAll: (sel) => (sel === '#modelsTableBody tr' ? (trRef ? [trRef] : []) : []),
        createElement: () => tr,
        addEventListener: () => {}
      },
      window: {
        chrome: { webview: { postMessage: () => {} } },
        SettingsPanel: { registerSection: (name, mod) => { registeredSections[name] = mod; } },
        addEventListener: () => {}
      },
      setTimeout: () => {},
      clearTimeout: () => {},
      console
    };
    sandbox.global = sandbox;
    const ctx = vm.createContext(sandbox);
    vm.runInContext(sharedSrc, ctx);
    vm.runInContext(src, ctx);

    const mod = registeredSections.models;
    mod.load({
      providers: { deepseek: {} },
      models: { 'deepseek/deepseek-v4-flash': { provider: 'deepseek', input: 0.14, cachedInput: '', output: 0.28, context: 128000, vision: false, reasoning: true } }
    });
    if (contextEl.value !== '128K')
      throw new Error('setup: context display should be 128K, got ' + contextEl.value);
    // Fixed: blur parses the k/M suffix, so the raw stays 128000.
    // BUG: merely focusing (value stays the display string) and blurring the
    // field parseInt'd "128K" -> 128 and stored it as data-context-raw; the
    // save() then read the raw 128 instead of 128000.
    contextEl.focus();
    contextEl.blur();
    const saved = mod.save();
    const savedContext = saved.models['deepseek/deepseek-v4-flash'].context;
    if (savedContext !== 128000)
      throw new Error('context shrank on focus/blur (BUG present): saved=' + savedContext + ' displayAfterBlur=' + contextEl.value);
    return 'model context 128000 displayed as "128K"; focus+blur keeps data-context-raw=128000, display "128K", saved context=' +
      savedContext + ' (the k/M multiplier survives every focus/blur or save)';
  }
});

scenarios.push({
  id: 164,
  name: 'Models tab: pasting a "$"-prefixed price (e.g. "$0.5") and blurring silently zeroes it - the blur handler parseFloat\'s the raw string (NaN -> 0) and stores 0 as data-price-raw',
  mode: null,
  regression: true,
  noApp: true,
  settings: {},
  async body() {
    // Run the REAL models.js in a vm sandbox (same pattern as #158) and drive
    // the actual price focus/blur listeners + save().
    const sharedSrc = fs.readFileSync(path.join(launcher.REPO_ROOT, 'webui', 'js', 'shared', 'settings-shared.js'), 'utf-8');
    const src = fs.readFileSync(path.join(launcher.REPO_ROOT, 'webui', 'js', 'settings', 'sections', 'models.js'), 'utf-8');

    function makeEl(initial) {
      const el = {
        value: initial.value !== undefined ? String(initial.value) : '',
        raw: initial.raw !== undefined ? String(initial.raw) : null,
        checked: !!initial.checked,
        listeners: {},
        classList: { add() {}, remove() {}, toggle() {} },
        dataset: {}
      };
      el.getAttribute = (name) => (name === 'data-context-raw' || name === 'data-price-raw') ? el.raw : null;
      el.setAttribute = (name, v) => { if (name === 'data-context-raw' || name === 'data-price-raw') el.raw = String(v); };
      el.addEventListener = (type, fn) => { el.listeners[type] = fn; };
      el.focus = () => { if (el.listeners.focus) el.listeners.focus(); };
      el.blur = () => { if (el.listeners.blur) el.listeners.blur(); };
      return el;
    }

    let trRef = null;
    const idEl = makeEl({ value: 'deepseek-v4-flash' });
    const providerEl = makeEl({ value: 'deepseek' });
    const inputEl = makeEl({ value: '$0.50', raw: '0.5' });
    const cachedEl = makeEl({ value: '', raw: '' });
    const outputEl = makeEl({ value: '0.28', raw: '0.28' });
    const contextEl = makeEl({ value: '' });
    const visionEl = makeEl({ value: 'on', checked: false });
    const reasoningEl = makeEl({ value: 'on', checked: true });
    const fields = {
      '[data-field="id"]': idEl,
      '[data-field="provider"]': providerEl,
      '[data-field="input"]': inputEl,
      '[data-field="cachedInput"]': cachedEl,
      '[data-field="output"]': outputEl,
      '[data-field="context"]': contextEl,
      '[data-field="vision"]': visionEl,
      '[data-field="reasoning"]': reasoningEl
    };
    const tr = {
      dataset: {},
      innerHTML: '',
      querySelector: (sel) => fields[sel] || null,
      // _wirePriceContext calls querySelectorAll('[data-price-raw]') - return
      // every field so the price focus/blur wiring attaches to the pre-created
      // elements (the inert innerHTML assignment never populates them).
      querySelectorAll: () => Object.values(fields),
      addEventListener() {},
      remove() {}
    };
    fields['.btn-sm.danger'] = makeEl({ value: '' });
    const tbody = {
      innerHTML: '',
      appendChild(child) { trRef = child; }
    };
    const registeredSections = {};
    const sandbox = {
      document: {
        getElementById: (id) => (id === 'modelsTableBody' ? tbody : null),
        querySelectorAll: (sel) => (sel === '#modelsTableBody tr' ? (trRef ? [trRef] : []) : []),
        createElement: () => tr,
        addEventListener: () => {}
      },
      window: {
        chrome: { webview: { postMessage: () => {} } },
        SettingsPanel: { registerSection: (name, mod) => { registeredSections[name] = mod; } },
        addEventListener: () => {}
      },
      setTimeout: () => {},
      clearTimeout: () => {},
      console
    };
    sandbox.global = sandbox;
    const ctx = vm.createContext(sandbox);
    vm.runInContext(sharedSrc, ctx);
    vm.runInContext(src, ctx);

    const mod = registeredSections.models;
    mod.load({
      providers: { deepseek: {} },
      models: { 'deepseek/deepseek-v4-flash': { provider: 'deepseek', input: 0.5, cachedInput: '', output: 0.28, context: '', vision: false, reasoning: true } }
    });
    if (inputEl.value !== '$0.50')
      throw new Error('setup: input display should be $0.50, got ' + inputEl.value);
    // Fixed: the blur handler strips the "$" and keeps the parsed 0.5.
    // BUG: the user focused (value became raw 0.5), pasted "$0.5" (the format
    // they may copy from a pricing page), then blurred; parseFloat("$0.5") was
    // NaN -> 0 and stored as data-price-raw.
    inputEl.focus();
    inputEl.value = '$0.5';
    inputEl.blur();
    const saved = mod.save();
    const savedPrice = saved.models['deepseek/deepseek-v4-flash'].input;
    if (savedPrice !== 0.5)
      throw new Error('$ paste still corrupts the price (BUG present): saved=' + savedPrice + ' raw=' + inputEl.raw + ' display=' + inputEl.value);
    return 'input price $0.50 displayed; user pastes "$0.5" and blurs -> data-price-raw=0.5, display "$0.50", saved input=' +
      savedPrice + ' - the "$"-prefixed paste survives (0.5, not 0), and a blank blur keeps the field blank';
  }
});

// Load the REAL menu-items.js settings section in a vm sandbox with a minimal
// DOM, so the actual Settings UI code (renderTable/readTable/save + the row
// delete buttons) decides what a save can produce.
function loadMenuItemsSandbox() {
  const src = fs.readFileSync(path.join(launcher.REPO_ROOT, 'webui', 'js', 'settings', 'sections', 'menu-items.js'), 'utf8');
  let registered = null;
  const S = {
    dirty: false,
    markDirty() { S.dirty = true; },
    registerSection(name, obj) { registered = obj; }
  };
  function makeEl(tag) {
    const el = {
      tag, value: '', textContent: '', className: '', style: {}, children: [], listeners: {},
      parent: null, selected: false, innerHTML: '',
      appendChild(child) {
        child.parent = el;
        el.children.push(child);
        if (el.tag === 'select' && child.tag === 'option') {
          if (child.selected) el.value = child.value;
          else if (el.children.filter((c) => c.tag === 'option').length === 1) el.value = child.value;
        }
      },
      remove() { if (el.parent) { const i = el.parent.children.indexOf(el); if (i >= 0) el.parent.children.splice(i, 1); } },
      addEventListener(type, fn) { el.listeners[type] = fn; },
      click() { if (el.listeners.click) el.listeners.click(); },
      querySelectorAll(sel) {
        const tags = sel.split(',').map((s) => s.trim());
        const out = [];
        (function walk(node) { for (const c of node.children) { if (tags.indexOf(c.tag) >= 0) out.push(c); walk(c); } })(el);
        return out;
      },
      querySelector() { return null; }
    };
    Object.defineProperty(el, 'innerHTML', {
      get() { return ''; },
      set() { el.children = []; }
    });
    return el;
  }
  const qaTbody = makeEl('tbody'), trayTbody = makeEl('tbody');
  const els = { qaTableBody: qaTbody, trayTableBody: trayTbody, addQaRow: null, addTrayRow: null };
  const sandbox = {
    window: { SettingsShared: S },
    document: {
      getElementById: (id) => (els[id] === undefined || els[id] === null ? null : els[id]),
      addEventListener() {},
      createElement: (tag) => makeEl(tag)
    },
    console
  };
  sandbox.global = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  return { registered, S, qaTbody, trayTbody };
}

scenarios.push({
  id: 179,
  name: 'The tray menu can be left WITHOUT an Exit item - Settings > Menu Items lets the user delete the "E&xit" row, and _rebuildTrayMenu builds the tray exclusively from the user-editable trayMenuItems (no other always-present close path)',
  mode: null,
  regression: true, // FIXED: tray Exit is unconditional (backend + save() re-add)
  settings: {},
  noApp: true,
  async body() {
    // 1. Drive the REAL Settings UI code: load two tray rows, click the row's
    //    delete (✕) button, and save - the UI happily produces a tray config
    //    without any exit action (and can even empty the tray entirely).
    const { registered, trayTbody } = loadMenuItemsSandbox();
    if (!registered) throw new Error('menu-items section did not register (sandbox issue)');
    registered.load({ menuItems: { quickAccess: [], tray: [{ menuText: 'E&xit', action: 'exit' }, { menuText: '&Reload Script', action: 'reload' }] } });
    if (trayTbody.children.length !== 2) throw new Error('tray rows did not render (sandbox issue): ' + trayTbody.children.length);
    // Delete the E&xit row via its ✕ button (tr.remove() + markDirty).
    const exitRow = trayTbody.children[0];
    const exitDeleteBtn = exitRow.children[2] && exitRow.children[2].children[0];
    if (!exitDeleteBtn) throw new Error('delete button missing on the exit row (sandbox issue)');
    exitDeleteBtn.click();
    // Delete the reload row too - the user CAN delete every row, but save()
    // must re-add an Exit item so the saved tray config always keeps a close
    // path.
    const reloadRow = trayTbody.children[0];
    reloadRow.children[2].children[0].click();
    let saved = registered.save();
    let trayActions = saved.menuItems.tray.map((i) => i.action);
    if (trayActions.indexOf('exit') < 0)
      throw new Error('save() must keep an Exit item in the tray config (bug #179): ' + JSON.stringify(trayActions));

    // 2. _rebuildTrayMenu re-adds an UNCONDITIONAL Exit item after the
    //    user-editable items, so the tray can never be left without a close
    //    path even if a no-exit config reaches it.
    const tray = fs.readFileSync(path.join(launcher.REPO_ROOT, 'app', 'TrayMenu.ahk'), 'utf8');
    const exitInsideCase = /case "exit":\s*A_TrayMenu\.Add\(item\.menuText,\s*\(\*\)\s*=>\s*ExitApp\(\)\)/.test(tray);
    const unconditionalExit = /A_TrayMenu\.Add\("E&xit",\s*\(\*\)\s*=>\s*ExitApp\(\)\)/.test(tray);
    const hardcodedOpen = /A_TrayMenu\.Add\("📋 Open Chat Window"/.test(tray) || /A_TrayMenu\.Add\(".*Open Chat Window"/.test(tray);
    if (!exitInsideCase || !unconditionalExit || !hardcodedOpen)
      throw new Error('_rebuildTrayMenu contract broken: exitInsideCase=' + exitInsideCase + ' unconditionalExit=' + unconditionalExit + ' hardcodedOpen=' + hardcodedOpen + '\n' + tray);

    // 3. The chat window X still only HIDES the window and the command menu
    //    has no exit action - the tray's unconditional Exit item is what
    //    guarantees the app can always be closed from the UI.
    const cw = fs.readFileSync(path.join(launcher.REPO_ROOT, 'chat', 'ChatWindow.ahk'), 'utf8');
    const closeHides = /OnEvent\("Close",\s*\(\*\)\s*=>\s*responseWindow\.Hide\(\)\)/.test(cw);
    const cmdMenu = fs.readFileSync(path.join(launcher.REPO_ROOT, 'app', 'menu', 'CommandMenu.ahk'), 'utf8');
    const cmdHasExit = /case\s*["']exit["']|action\s*=\s*["']exit["']/i.test(cmdMenu);
    if (!closeHides || cmdHasExit)
      throw new Error('unexpected extra close path: closeHides=' + closeHides + ' cmdHasExit=' + cmdHasExit);

    return 'Settings UI lets the user delete every tray row, but save() persists tray actions ' + JSON.stringify(trayActions) +
      ' (an Exit item is always re-added); _rebuildTrayMenu also appends an unconditional E&xit item after the user items, and the chat-window X still hides - the app always keeps a close path';
  }
});

scenarios.push({
  id: 187,
  regression: true, // REFUTED lead (2026-08-10): the exercised settings edge matrix round-trips cleanly (comma/quote model ids, blank cachedInput/context, cleared prefixes, dashboard filter binding)
  name: 'Settings deep-merge edge cases round-trip cleanly: comma/quote model ids survive Save -> Load -> ApplyToGlobals and bind in the dashboard filters; blank cachedInput/context keep the CostCalculator fallbacks',
  mode: null,
  noApp: true,
  settings: {},
  async body() {
    const os = require('node:os');
    const outFile = path.join(os.tmpdir(), 'llm-bughunt-db-' + process.pid + '.txt');
    try { fs.unlinkSync(outFile); } catch {}
    const probe = path.join(__dirname, '..', 'probe-bughunt-db.ahk');
    const res = spawnSync(launcher.AHK, ['/ErrorStdOut', probe, outFile, 'settings-edge-roundtrip'], { timeout: 25000, windowsHide: true, encoding: 'utf8' });
    if (res.error) throw new Error('settings-edge probe spawn failed/timed out: ' + res.error.message);
    if (res.stderr) process.stderr.write('[probe stderr] ' + res.stderr);
    const text = fs.readFileSync(outFile, 'utf-8');
    const savedM = text.match(/saved=(\d+)/);
    const commaM = text.match(/commaId=(\d+)/);
    const quoteM = text.match(/quoteId=(\d+)/);
    const fallbackM = text.match(/cachedFallback=(\d+)/);
    const hitsM = text.match(/filterHits=(\d+)/);
    const applyErr = /applyErr='([^']*)'/.exec(text);
    if (!savedM || !commaM || !quoteM || !fallbackM || !hitsM || !applyErr) throw new Error('probe output missing fields: ' + text);
    if (savedM[1] !== '1' || commaM[1] !== '1' || quoteM[1] !== '1' || fallbackM[1] !== '1' || hitsM[1] !== '1' || applyErr[1] !== '')
      throw new Error('settings edge matrix failed (potential bug): ' + text);
    return 'Save -> Load -> ApplyToGlobals with a comma model id (openai/gpt-5,beta), a double-quote model id (openai/gpt-"q"x), blank cachedInput/context, and all-prefixes-cleared providers: saved=1, applyErr empty, both ids round-trip, blank cachedInput falls back to 10% (cost>0), and the comma model id binds in UsageRepo.Query (filterHits=1) - no round-trip bug in the exercised matrix';
  }
});

scenarios.push({
  id: 190,
  name: 'Removing the deepseek provider crashes request resolution: ProviderResolver.Resolve falls back to the hardcoded providers["deepseek"] (a missing-key Map index THROWS in AHK v2) when no prefix matches - the Settings UI allows deleting deepseek (>=1 provider must remain), so a model with an uncovered prefix breaks every request',
  mode: null,
  regression: true, // FIXED: fallback is the first configured provider, never a missing Map key
  noApp: true,
  settings: {},
  async body() {
    const os = require('node:os');
    const outFile = path.join(os.tmpdir(), 'llm-bughunt-db-' + process.pid + '.txt');
    try { fs.unlinkSync(outFile); } catch {}
    const probe = path.join(__dirname, '..', 'probe-bughunt-db.ahk');
    const res = spawnSync(launcher.AHK, ['/ErrorStdOut', probe, outFile, 'provider-resolve-deleted-deepseek'], { timeout: 25000, windowsHide: true, encoding: 'utf8' });
    if (res.error) throw new Error('provider-resolve probe spawn failed/timed out: ' + res.error.message);
    if (res.stderr) process.stderr.write('[probe stderr] ' + res.stderr);
    const text = fs.readFileSync(outFile, 'utf-8');
    const threwM = text.match(/deletedDeepseekThrew=(\d)/);
    const ctrlM = text.match(/openaiControl=([A-Za-z0-9_-]+)/);
    if (!threwM || !ctrlM) throw new Error('probe output missing fields: ' + text);
    const threw = Number(threwM[1]), control = ctrlM[1];
    // FIXED (bug #190): the fallback is no longer hardcoded to
    // providers["deepseek"] - with deepseek removed, the uncovered model
    // resolves to the FIRST configured provider (openai) instead of throwing
    // on the missing Map key.
    if (threw !== 0 || control !== 'openai')
      throw new Error('deleted-deepseek resolution still throws (fix incomplete): threw=' + threw + ' control=' + control + ' text=' + text);
    return 'providers = { openai (prefixes: [openai]) } only (deepseek removed, as the Settings UI allows): ProviderResolver.Resolve("deepseek/deepseek-v4-flash") resolved to the first configured provider "openai" (threw=' + threw +
      ') instead of crashing on the missing providers["deepseek"] key, and the covered openai control resolved to "openai"';
  }
});

scenarios.push({
  id: 196,
  name: 'Fresh-profile default assistant loses isDefault - SettingsDefaults._DefaultsAssistants builds the defaults snapshot WITHOUT isDefault (DefaultSettings marks Natural Conversationalist isDefault:true), so with no settings.json the applied assistants have no default and _applyNewChatDefault falls through to the app default model',
  mode: null,
  noApp: true,
  regression: true, // FIXED bug #196 kept as a regression check
  settings: {},
  async body() {
    const os = require('node:os');
    const outFile = path.join(os.tmpdir(), 'llm-bughunt-db-' + process.pid + '.txt');
    try { fs.unlinkSync(outFile); } catch {}
    const probe = path.join(__dirname, '..', 'probe-bughunt-db.ahk');
    const res = spawnSync(launcher.AHK, ['/ErrorStdOut', probe, outFile, 'default-assistant-isdefault'], { timeout: 25000, windowsHide: true, encoding: 'utf8' });
    if (res.error) throw new Error('default-assistant probe spawn failed/timed out: ' + res.error.message);
    if (res.stderr) process.stderr.write('[probe stderr] ' + res.stderr);
    const text = fs.readFileSync(outFile, 'utf-8');
    const countM = text.match(/defaultsCount=(\d+)/);
    const inDefM = text.match(/isDefaultInDefaults=(\d+)/);
    const appliedM = text.match(/appliedDefaultFlags=(\d+)/);
    if (!countM || !inDefM || !appliedM) throw new Error('probe output missing fields: ' + text);
    const defaultsCount = Number(countM[1]), isDefaultInDefaults = Number(inDefM[1]), appliedDefaultFlags = Number(appliedM[1]);
    // FIXED (bug #196): the defaults snapshot and the applied globals both
    // carry the marked assistant's isDefault flag.
    if (!(defaultsCount > 0 && isDefaultInDefaults >= 1 && appliedDefaultFlags >= 1))
      throw new Error('default assistant isDefault was not preserved (fix incomplete): defaults=' + defaultsCount + ' inDefaults=' + isDefaultInDefaults + ' applied=' + appliedDefaultFlags);
    return 'fresh defaults snapshot has ' + defaultsCount + ' assistant(s), isDefault flags in snapshot=' + isDefaultInDefaults +
      ', applied assistant globals with isDefault=' + appliedDefaultFlags +
      ' - DefaultSettings marks Natural Conversationalist isDefault:true and the defaults builder preserves it, so App Default starts with the marked assistant';
  }
});

scenarios.push({
  id: 199,
  name: 'With zero configured providers, a chat send crashes inside the API-key error handler - ProviderResolver.Resolve returns providerKey="" and ChatRequestBuilder._ShowApiKeyError indexes providers[""] unguarded (a missing Map key THROWS in AHK v2), so the friendly "No API key configured" error never reaches the UI',
  mode: null,
  noApp: true,
  regression: true, // FIXED bug #199 kept as a regression check
  settings: {},
  async body() {
    const os = require('node:os');
    const outFile = path.join(os.tmpdir(), 'llm-bughunt-db-' + process.pid + '.txt');
    try { fs.unlinkSync(outFile); } catch {}
    const probe = path.join(__dirname, '..', 'probe-bughunt-db.ahk');
    const res = spawnSync(launcher.AHK, ['/ErrorStdOut', probe, outFile, 'provider-empty-api-key-error'], { timeout: 25000, windowsHide: true, encoding: 'utf8' });
    if (res.error) throw new Error('provider-empty probe spawn failed/timed out: ' + res.error.message);
    if (res.stderr) process.stderr.write('[probe stderr] ' + res.stderr);
    const text = fs.readFileSync(outFile, 'utf-8');
    const keyM = text.match(/providerKey='([^']*)'/);
    const threwM = text.match(/threw='([^']*)'/);
    if (!keyM || !threwM) throw new Error('probe output missing fields: ' + text);
    const providerKey = keyM[1], threw = threwM[1];
    // FIXED (bug #199): the error handler no longer indexes providers[""],
    // so the friendly key error survives the empty-provider state.
    if (providerKey !== '' || threw !== '')
      throw new Error('provider-less error path still crashes (fix incomplete): key=' + providerKey + ' threw=' + threw);
    return 'providers={}, providerMap={}: ProviderResolver.Resolve returned providerKey="' + providerKey +
      '" and _ShowApiKeyError completed without throwing - the friendly key error reaches the UI';
  }
});

scenarios.push({
  id: 201,
  name: 'Assistant Reasoning dropdown ignores short-form base model ids - ReasoningLevels.levelsForModel only checks the exact models[baseModel] key, so an assistant whose baseModel is "gpt-5-mini" (instead of "openai/gpt-5-mini") falls back to the generic list and offers "None (Disabled)"/"Minimal"/"Medium" options the model does not support (the same short-form family as bugs #43/#51, on the assistant settings path)',
  mode: null,
  noApp: true,
  regression: true, // FIXED bug #201 kept as a regression check
  settings: {},
  async body() {
    const vm = require('node:vm');
    const src = fs.readFileSync(path.join(launcher.REPO_ROOT, 'webui', 'js', 'shared', 'reasoning-levels.js'), 'utf8');
    const sandbox = { window: {}, console };
    sandbox.global = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(src, sandbox);
    const models = {
      'openai/gpt-5-mini': { thinkingLevelMap: { low: 'low', high: 'high' } }
    };
    const html = sandbox.window.ReasoningLevels.buildOptionsHtml(models, 'gpt-5-mini');
    const values = (html.match(/<option value="([^"]*)"/g) || []).map((m) => m.replace(/<option value="/, '').replace(/"/, ''));
    // FIXED (bug #201): the short id resolves to openai/gpt-5-mini, so only
    // its supported levels (low/high) are offered - no generic fallback.
    if (values.indexOf('none') >= 0 || values.indexOf('minimal') >= 0 || values.indexOf('medium') >= 0)
      throw new Error('short-form assistant reasoning still offers unsupported generic levels (fix incomplete): ' + JSON.stringify(values));
    if (values.indexOf('low') < 0 || values.indexOf('high') < 0)
      throw new Error('short-form assistant reasoning missing model-supported levels (fix incomplete): ' + JSON.stringify(values));
    return 'assistant baseModel="gpt-5-mini" (map key openai/gpt-5-mini with thinkingLevelMap {low, high}): ReasoningLevels.buildOptionsHtml returned ' +
      JSON.stringify(values) + ' - the dropdown offers only the levels the model actually supports';
  }
});

scenarios.push({
  id: 266,
  name: 'Backup requires a real destination and Back Up Now uses the displayed folder without a separate Save click',
  regression: true,
  mode: null,
  settings: {},
  async body({ cdp, dataDir }) {
    const target = path.join(os.tmpdir(), 'ahkllm-backup-now-' + process.pid + '-' + Date.now());
    try { fs.rmSync(target, { recursive: true, force: true }); } catch {}
    await showChat();
    await openSettings(cdp);
    await openSection(cdp, 'general');
    await cdp.waitFor('document.getElementById("backupFolder") !== null', 10000, 250, 'backup controls');
    await sleep(300);
    await cdp.clearPosted();
    const emptyState = await cdp.eval(`(() => {
      const folder = document.getElementById('backupFolder');
      const toggle = document.getElementById('backupEnabledToggle');
      toggle.click();
      document.getElementById('backupNowBtn').click();
      return {
        value: folder.value,
        placeholder: folder.placeholder,
        enabled: toggle.classList.contains('on'),
        status: document.getElementById('backupStatus').textContent
      };
    })()`);
    if (emptyState.value !== '' || emptyState.enabled)
      throw new Error('empty backup destination was presented as configured/enabled: ' + JSON.stringify(emptyState));
    if (emptyState.placeholder !== 'Choose a backup folder...' || emptyState.status.indexOf('Choose a backup destination folder first') < 0)
      throw new Error('empty backup destination is still misleading or non-actionable: ' + JSON.stringify(emptyState));
    await sleep(250);
    if ((await cdp.postedMessages()).some((message) => message.includes('"backupNow"')))
      throw new Error('empty backup destination still posted backupNow');

    await cdp.clearPosted();
    await cdp.eval(`(() => {
      const folder = document.getElementById('backupFolder');
      folder.value = ${JSON.stringify(target)};
      folder.dispatchEvent(new Event('input', { bubbles: true }));
      folder.dispatchEvent(new Event('change', { bubbles: true }));
      const toggle = document.getElementById('backupEnabledToggle');
      if (!toggle.classList.contains('on')) toggle.click();
      document.getElementById('backupNowBtn').click();
      return { folder: folder.value, enabled: toggle.classList.contains('on') };
    })()`);
    // Deliberately click Back Up Now directly; the Settings Save button is
    // never pressed. The native path is verified by the resulting ZIP.
    await cdp.waitFor('window.__posted && window.__posted.some((m) => m.includes("backupNow"))', 5000, 100, 'backupNow posted');
    const start = Date.now();
    let saved = null;
    const zip = path.join(target, 'AHKLLM Backup.zip');
    while (Date.now() - start < 30000) {
      try {
        const current = readJsonFile(path.join(dataDir, 'settings.json'));
        if (current.backup && current.backup.folder === target && current.backup.enabled) {
          saved = current;
          if (fs.existsSync(zip)) break;
        }
      } catch {}
      await sleep(300);
    }
    if (!saved) {
      const backupPost = (await cdp.postedMessages()).find((message) => message.includes('backupNow')) || '(missing)';
      throw new Error('Back Up Now did not persist the displayed backup config: ' + target + ' posted=' + backupPost);
    }
    if (!fs.existsSync(zip)) throw new Error('Back Up Now did not publish a ZIP in the displayed folder: ' + target);
    await cdp.waitFor(`(() => {
      const el = document.getElementById('backupStatus');
      return el && /^Last backup:/.test(el.textContent || '');
    })()`, 10000, 100, 'completed backup status');
    const finalStatus = await cdp.eval(`document.getElementById('backupStatus').textContent`);
    if (finalStatus === 'Backup pending' || finalStatus === 'Starting backup...' || finalStatus === 'Backing up...')
      throw new Error('completed manual backup left the UI in a non-terminal state: ' + finalStatus);
    return 'displayed folder ' + target + ' reached settings.json, native manual backup published ' + zip + ', and UI reached terminal status ' + finalStatus;
  }
});

scenarios.push({
  id: 328,
  name: 'Custom OpenAI-compatible provider is usable immediately and preserves stable nested model references',
  regression: true,
  mode: 'sse-success',
  settings: {},
  async body({ cdp, dataDir, mockLog, endpoint }) {
    await showChat();
    await openSettings(cdp);
    await openSection(cdp, 'providers');
    const providerCountBefore = await cdp.eval('document.querySelectorAll("#providerGrid .provider-card").length');
    await cdp.click('#addProviderBtn');
    await cdp.waitFor('document.querySelectorAll("#providerGrid .provider-card").length === ' + (providerCountBefore + 1), 10000, 100, 'custom provider card');

    const customProvider = await cdp.eval(`(() => {
      const cards = [...document.querySelectorAll('#providerGrid .provider-card')];
      const card = cards[cards.length - 1];
      const set = (field, value) => {
        const el = card.querySelector('[data-field="' + field + '"]');
        if (!el) return false;
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        setter.call(el, value);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      };
      set('displayName', 'Xiaomi');
      set('endpoint', ${JSON.stringify(endpoint)});
      set('apiKey', 'e2e-xiaomi-key');
      return {
        key: card.dataset.providerKey,
        name: card.querySelector('[data-field="displayName"]').value,
        idInput: card.querySelector('[data-field="providerId"]').value
      };
    })()`);
    if (customProvider.key !== 'xiaomi' || customProvider.idInput !== 'xiaomi')
      throw new Error('display name did not derive stable provider ID xiaomi: ' + JSON.stringify(customProvider));

    await openSection(cdp, 'models');
    await cdp.click('#addModelBtn');
    await cdp.waitFor('document.querySelectorAll("#modelsTableBody tr").length > 0', 10000, 100, 'custom model row');
    const sameSession = await cdp.eval(`(() => {
      const row = document.querySelector('#modelsTableBody tr:last-child');
      const id = row.querySelector('[data-field="id"]');
      const provider = row.querySelector('[data-field="provider"]');
      const idSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      idSetter.call(id, 'vendor/mimo-v2.5-pro');
      id.dispatchEvent(new Event('input', { bubbles: true }));
      provider.value = 'xiaomi';
      provider.dispatchEvent(new Event('change', { bubbles: true }));
      const selected = [...provider.options].find((o) => o.value === 'xiaomi');
      return { selected: !!selected, label: selected && selected.textContent, id: id.value };
    })()`);
    if (!sameSession.selected || sameSession.label !== 'Xiaomi')
      throw new Error('custom provider was not selectable/readable before Save: ' + JSON.stringify(sameSession));

    await saveSettings(cdp, dataDir);
    const saved = readJsonFile(path.join(dataDir, 'settings.json'));
    if (!saved.providers || !saved.providers.xiaomi || saved.providers.xiaomi.displayName !== 'Xiaomi')
      throw new Error('custom provider did not persist: ' + JSON.stringify(saved.providers && saved.providers.xiaomi));
    const modelKey = 'xiaomi/vendor/mimo-v2.5-pro';
    if (!saved.models || !saved.models[modelKey] || saved.models[modelKey].provider !== 'xiaomi')
      throw new Error('nested custom model reference was mangled: ' + JSON.stringify(saved.models && saved.models[modelKey]));

    await hideSettingsToChat(cdp);
    await cdp.waitFor('window.modelList && window.modelList.xiaomi && window.modelList.xiaomi.some((m) => m.fullId === ' + JSON.stringify(modelKey) + ')', 15000, 200, 'custom model list');
    await cdp.click('#modelCardTrigger');
    await cdp.waitFor('document.getElementById("modelPopover").classList.contains("open")', 5000, 200, 'model picker');
    await cdp.click('.popover-tab[data-target="tab-models"]');
    await cdp.waitFor('[...document.querySelectorAll("#tab-models .selector-item .si-name")].some((e) => e.textContent === "vendor/mimo-v2.5-pro")', 10000, 200, 'custom model selector');
    await cdp.eval(`(() => [...document.querySelectorAll('#tab-models .selector-item')].find((e) => e.querySelector('.si-name') && e.querySelector('.si-name').textContent === 'vendor/mimo-v2.5-pro').click())()`);
    await cdp.waitFor('window._currentSettings && window._currentSettings.model === ' + JSON.stringify(modelKey), 10000, 200, 'custom model selected');
    await sendChatMessage(cdp, 'custom provider smoke test');
    await waitStreamingIdle(cdp, 40000);
    const requests = fs.existsSync(mockLog) ? fs.readFileSync(mockLog, 'utf8').trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line)) : [];
    const customRequest = requests.find((request) => request.body && request.body.model === 'vendor/mimo-v2.5-pro');
    if (!customRequest) throw new Error('mock did not receive the nested custom model: ' + JSON.stringify(requests));
    if (customRequest.authorization !== 'Bearer e2e-xiaomi-key')
      throw new Error('custom provider did not use Bearer auth: ' + JSON.stringify(customRequest.authorization));
    const messages = await cdp.eval('chatMessages.map((message) => message.role + ":" + message.content).join("|")');
    if (messages.indexOf('assistant:Hello from the mock LLM.') < 0)
      throw new Error('custom provider response was not streamed into the chat: ' + messages);
    return 'Xiaomi provider became selectable before Save, saved as xiaomi/vendor/mimo-v2.5-pro, reloaded intact, and streamed through the mock Chat Completions endpoint with Bearer auth';
  }
});

scenarios.push({
  id: 345,
  name: 'Fresh chat immediately shows New Chats Start With model; persisted thread override still wins',
  regression: true,
  mode: null,
  settings: { newChatStartsWith: 'openai/gpt-5-mini' },
  fixtures: {
    threads: [{ id: 't-model-override-345', title: 'Existing Override', active_leaf_id: 'm-model-override-345', model_override: 'deepseek/deepseek-v4-pro' }],
    messages: [{ id: 'm-model-override-345', thread_id: 't-model-override-345', role: 'user', content: 'existing thread' }]
  },
  async body({ cdp, dbPath }) {
    await showChat();
    await cdp.waitFor('window.activeThreadId === "" && window._currentSettings && window._currentSettings.model === "openai/gpt-5-mini"', 15000, 200, 'fresh configured model');
    let card = await cdp.eval(`(() => ({ name: document.querySelector('#modelCardTrigger .name') ? document.querySelector('#modelCardTrigger .name').textContent : '', id: document.querySelector('#modelCardTrigger .id') ? document.querySelector('#modelCardTrigger .id').textContent : '' }))()`);
    if (card.id !== 'openai/gpt-5-mini' || card.name.indexOf('gpt-5-mini') < 0) throw new Error('fresh chat card did not show New Chats Start With model: ' + JSON.stringify(card));
    await cdp.eval(`(() => { const item = document.querySelector('#thread-list .chat-item[data-chat="t-model-override-345"]'); if (!item) return false; item.click(); return true; })()`);
    await cdp.waitFor('window.activeThreadId === "t-model-override-345" && window._currentSettings && window._currentSettings.model === "deepseek/deepseek-v4-pro"', 15000, 200, 'existing override loaded');
    await cdp.click('#new-chat-btn');
    await cdp.waitFor('window.activeThreadId && window.activeThreadId !== "t-model-override-345" && window._currentSettings && window._currentSettings.model === "openai/gpt-5-mini"', 15000, 200, 'new chat configured model');
    const newId = await cdp.eval('window.activeThreadId');
    const rows = seed.query(dbPath, 'SELECT model_override FROM chat_threads WHERE id = ?', [newId]);
    if (!rows.length || rows[0].model_override !== 'openai/gpt-5-mini') throw new Error('new chat did not persist configured model: ' + JSON.stringify({ newId, rows }));
    card = await cdp.eval(`(() => ({ name: document.querySelector('#modelCardTrigger .name') ? document.querySelector('#modelCardTrigger .name').textContent : '', id: document.querySelector('#modelCardTrigger .id') ? document.querySelector('#modelCardTrigger .id').textContent : '' }))()`);
    if (card.id !== 'openai/gpt-5-mini') throw new Error('new chat card regressed after thread creation: ' + JSON.stringify(card));
    return 'threadless startup and New Chat show openai/gpt-5-mini immediately; existing deepseek-v4-pro override remains authoritative';
  }
});

module.exports = scenarios;
