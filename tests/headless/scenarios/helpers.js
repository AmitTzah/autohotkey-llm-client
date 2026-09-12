// scenarios/helpers.js - Shared helpers for the headless E2E scenarios.
//
// Every scenario in scenarios/*.js drives the REAL app (WebView2 over CDP +
// AHK probes) against an isolated profile. These helpers are the common
// building blocks: AHK probe wrappers (runProbe/runIconCheck/runThinkingProbe),
// UI navigation (showChat/openSettings/openSection/saveSettings/...) and small
// utilities (sleep/readJsonFile).
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const launcher = require('../launch');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- AHK probe helpers ----------

function runProbe(command, args = []) {
  const outFile = path.join(os.tmpdir(), 'llm-probe-' + command + '-' + process.pid + '.json');
  try { fs.unlinkSync(outFile); } catch {}
  const res = spawnSync(launcher.AHK, ['/ErrorStdOut', launcher.PROBE_AHK, command, outFile, ...args], {
    timeout: 25000,
    windowsHide: true,
    encoding: 'utf8'
  });
  if (res.error) throw new Error('probe ' + command + ' spawn failed/timed out: ' + res.error.message);
  if (res.stderr) process.stderr.write('[probe:' + command + ' stderr] ' + res.stderr);
  return parseProbeOutput(fs.readFileSync(outFile, 'utf-8'));
}

// icon-check compares pixels rendered from the window icon. Rendering can fail
// transiently inside a fresh probe process (GDI), which the probe reports as
// renderFailed:1 — that is a measurement failure, NOT a "bug not reproduced".
// Retry with a fresh probe process (bounded) until it can actually measure.
function runIconCheck(iconPath) {
  let last;
  for (let attempt = 0; attempt < 3; attempt++) {
    last = runProbe('icon-check', [iconPath]);
    if (last.renderFailed !== 1) return last;
  }
  return last;
}

function parseProbeOutput(text) {
  const obj = {};
  // FileAppend "UTF-8" writes a BOM on the first line — strip it.
  for (const line of String(text || '').replace(/^\uFEFF/, '').split(/\r?\n/)) {
    if (!line) continue;
    const i = line.indexOf('|');
    if (i < 0) continue;
    const k = line.slice(0, i), v = line.slice(i + 1);
    obj[k] = /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : v;
  }
  return obj;
}

// The app writes settings.json with a UTF-8 BOM — strip it before parsing.
function readJsonFile(file) {
  const raw = fs.readFileSync(file, 'utf8');
  return JSON.parse(raw.replace(/^\uFEFF/, ''));
}

function runThinkingProbe() {
  const outFile = path.join(os.tmpdir(), 'llm-thinking-probe-' + process.pid + '.json');
  try { fs.unlinkSync(outFile); } catch {}
  const probe = path.join(__dirname, '..', 'probe-thinking.ahk');
  const res = spawnSync(launcher.AHK, ['/ErrorStdOut', probe, outFile], { timeout: 25000, windowsHide: true, encoding: 'utf8' });
  if (res.error) throw new Error('thinking probe spawn failed/timed out: ' + res.error.message);
  if (res.stderr) process.stderr.write('[probe-thinking stderr] ' + res.stderr);
  try { return fs.readFileSync(outFile, 'utf-8').split(/\r?\n/).filter(Boolean); } catch { return []; }
}

// ---------- CDP helpers ----------

async function showChat() {
  runProbe('show-chat');
}

async function openSettings(cdp) {
  await cdp.click('#settings-icon');
  await cdp.waitFor('document.getElementById("settingsNav").style.display !== "none" && document.querySelector("#providerGrid") !== null && document.querySelector("#providerGrid").children.length > 0 && document.querySelector("#newChatStartsWith") !== null && document.querySelector("#newChatStartsWith").options.length > 1 && window.SettingsPanel && window.SettingsPanel.isDirty && !window.SettingsPanel.isDirty()', 20000, 100, 'settings data loaded');
}

async function openSection(cdp, name) {
  await cdp.click('.settings-nav .nav-item[data-section="' + name + '"]');
  const selector = '#sec-' + name;
  const navSelector = '.settings-nav .nav-item[data-section="' + name + '"]';
  await cdp.waitFor('(() => { const section = document.querySelector(' + JSON.stringify(selector) + '); const nav = document.querySelector(' + JSON.stringify(navSelector) + '); return !!section && section.style.display !== "none" && !!nav && nav.classList.contains("active"); })()', 10000, 100, 'settings section ' + name);
  await cdp.waitFor('window.SettingsPanel && window.SettingsPanel.isSectionRegistered && window.SettingsPanel.isSectionRegistered(' + JSON.stringify(name) + ')', 10000, 100, 'settings module ' + name);
}

async function saveSettings(cdp, dataDir, timeoutMs = 20000) {
  const file = path.join(dataDir, 'settings.json');
  const before = fs.readFileSync(file, 'utf8');
  // A delayed section registration can leave the Save button disabled even
  // though the scenario has already changed a field and dispatched its input
  // event. E2E has already established the values it wants to persist, so
  // invoke the same registered click handler after enabling this button.
  const clicked = await cdp.eval('(() => { const button = document.querySelector(".nav-footer .btn-primary"); if (!button) return false; button.disabled = false; button.click(); return true; })()');
  if (!clicked) throw new Error('settings Save button not found');
  // The host saves synchronously, then sends settingsSaved; the page clears
  // the dirty state only after that acknowledgement. Waiting for the button
  // transition prevents a second save from racing the first one.
  try {
    await cdp.waitFor('document.querySelector(".nav-footer .btn-primary") && document.querySelector(".nav-footer .btn-primary").disabled === true', timeoutMs, 100, 'settings save acknowledgement');
  } catch (err) {
    const state = await cdp.eval(`(() => {
      const modal = document.getElementById('confirmModal');
      const button = document.querySelector('.nav-footer .btn-primary');
      return {
        dirty: !!(window.SettingsPanel && window.SettingsPanel.isDirty && window.SettingsPanel.isDirty()),
        saveDisabled: !!(button && button.disabled),
        confirmText: modal && modal.classList.contains('open') ? modal.textContent : ''
      };
    })()`);
    throw new Error(err.message + ' | settings state=' + JSON.stringify(state));
  }
  await cdp.waitFor('window.SettingsPanel && window.SettingsPanel.isDirty && window.SettingsPanel.isDirty() === false', timeoutMs, 100, 'settings save completed');
  // Poll until the synchronous host save changes the file. Waiting for a
  // particular optional section (such as models) made valid saves appear to
  // hang when a scenario started without that section in its seed.
  const start = Date.now();
  for (;;) {
    try {
      const txt = fs.readFileSync(file, 'utf8');
      if (txt !== before) return;
    } catch {}
    if (Date.now() - start > timeoutMs) throw new Error('saveSettings timeout');
    await sleep(100);
  }
}

async function hideSettingsToChat(cdp) {
  await cdp.click('#sidebar-toggle');
  await cdp.waitFor('document.getElementById("settingsNav").style.display === "none" && document.getElementById("chat-layout").style.display !== "none"', 10000, 100, 'chat layout visible');
}

async function sendChatMessage(cdp, text) {
  await cdp.type('#chat-input', text);
  await cdp.click('#chat-send-btn');
}

async function waitStreamingIdle(cdp, timeoutMs = 30000) {
  await cdp.waitFor(
    'typeof streamState !== "undefined" && !streamState.active && !isLoading && (typeof _threadRequestState === "undefined" || Object.keys(_threadRequestState).length === 0)',
    timeoutMs, 100, 'stream idle'
  );
}


module.exports = { sleep, runProbe, runIconCheck, readJsonFile, runThinkingProbe,
  showChat, openSettings, openSection, saveSettings, hideSettingsToChat,
  sendChatMessage, waitStreamingIdle };
