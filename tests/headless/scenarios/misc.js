// scenarios/misc.js - Icons, model-id parsing, vision gating, API logs
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
const { CDP } = require('../cdp');
const launcher = require('../launch');
const { sleep, runIconCheck, readJsonFile, showChat, openSettings, openSection, saveSettings, sendChatMessage, waitStreamingIdle } = require('./helpers');

const scenarios = [];

scenarios.push({
  id: 310,
  name: "Force-killed ChatWindow temp artifacts are cleaned by explicit ownership prefixes",
  regression: true,
  mode: null,
  noApp: true,
  async body() {
    const fs = require("node:fs");
    const path = require("node:path");
    const launcher = require("../launch");
    const utils = fs.readFileSync(path.join(launcher.REPO_ROOT, "chat", "ChatUtils.ahk"), "utf8");
    const window = fs.readFileSync(path.join(launcher.REPO_ROOT, "chat", "ChatWindow.ahk"), "utf8");
    const patterns = ["ChatWindow_Req_*.json", "ChatWindow_cURL_*.txt", "ChatWindow_Out_*.json", "ChatWindow_Err_*.txt", "ChatWindow_TitleGen_*.json", "ChatWindow_TitleGen_Out_*.json", "DSearch_Req_*.json", "DSearch_Out_*.json", "DSearch_Err_*.txt", "Tavily_Req_*.json", "Tavily_Out_*.json", "Tavily_Err_*.txt"];
    if (!utils.includes("CleanupOwnedTempFiles()") || !window.includes("CleanupOwnedTempFiles()") || patterns.some((pattern) => !utils.includes(pattern)))
      throw new Error("owned temp cleanup is not wired for every chat/title artifact prefix");
    return "ChatUtils scans the explicit ChatWindow/title/search request, cURL, output, and error prefixes, and ChatWindow invokes cleanup during startup and graceful exit; the AHK unit test verifies stale files are removed while unrelated temp files survive";
  }
});

scenarios.push({
  id: 16,
  name: 'API Logs viewer latency column shows the request duration',
  regression: true, // FIXED bug kept as a regression check (latency must keep rendering)
  mode: 'sse-success',
  settings: {},
  async body({ cdp, port }) {
    await showChat();
    await sendChatMessage(cdp, 'hello from bug 16');
    await waitStreamingIdle(cdp);
    // E2E workers skip the production API Logs prewarm to avoid a second
    // WebView2 stealing the chat CDP endpoint. Open it through the same lazy
    // dashboard path a user uses so this scenario still covers the viewer.
    await cdp.eval('window._showDashboard(); true');
    await cdp.waitFor('document.getElementById("apiLogsBtn") !== null', 10000, 100, 'usage dashboard');
    await cdp.click('#apiLogsBtn');
    const t = await launcher.findTarget(port, 'api-logs.html', 30000);
    if (!t) throw new Error('api-logs viewer target not found');
    const logs = await CDP.connect(t.webSocketDebuggerUrl);
    await logs.waitFor('typeof reloadLogs === "function"', 15000, 100, 'API logs page ready');
    await logs.eval('reloadLogs()');
    await logs.waitFor('document.querySelectorAll("#logBody tr.clickable").length > 0', 15000, 300, 'log rows');
    const latency = await logs.eval('document.querySelector("#logBody tr.clickable td:nth-child(4)").textContent');
    await logs.close();
    // FIXED: the viewer must read responseTimeMs (the field every logger
    // writes) so the column shows the real duration instead of "-".
    if (latency === '-' || latency === '') throw new Error('latency cell still empty: ' + JSON.stringify(latency));
    return 'log row latency cell = ' + JSON.stringify(latency) + ' (viewer reads responseTimeMs)';
  }
});

scenarios.push({
  id: 18,
  name: 'Custom icon picked outside the repo never applies to the chat window',
  regression: true, // FIXED bug kept as a regression check (absolute icon paths must keep loading)
  mode: null,
  settings: { icons: { iconOn: '', iconOff: 'icons/IconOff.ico' } },
  preLaunch(dataDir) {
    // Copy the repo icon to %TEMP% (OUTSIDE the repo) and point iconOn at it.
    const absIco = path.join(os.tmpdir(), 'llm-headless-custom-' + process.pid + '.ico');
    fs.copyFileSync(path.join(launcher.REPO_ROOT, 'icons', 'IconOn.ico'), absIco);
    const settingsFile = path.join(dataDir, 'settings.json');
    const cfg = readJsonFile(settingsFile);
    cfg.icons.iconOn = absIco;
    fs.writeFileSync(settingsFile, JSON.stringify(cfg, null, 2));
  },
  async body({ cdp }) {
    const absIco = path.join(os.tmpdir(), 'llm-headless-custom-' + process.pid + '.ico');
    const mangled = runIconCheck(absIco);
    if (mangled.hCustom === 0) throw new Error('direct LoadPicture of the chosen icon failed; probe=' + JSON.stringify(mangled));
    if (mangled.hMangled !== 0) throw new Error('mangled path unexpectedly loaded; probe=' + JSON.stringify(mangled));
    if (mangled.renderFailed === 1) throw new Error('icon render failed 3x; probe=' + JSON.stringify(mangled));
    if (mangled.customApplied !== 1) throw new Error('custom icon NOT applied to chat window; probe=' + JSON.stringify(mangled));
    // renderFailed is checked before customApplied so probe/GDI failures cannot masquerade as product failures.
    return 'absolute icon path: direct LoadPicture ok (h=' + mangled.hCustom + '), mangled path h=' + mangled.hMangled + ', custom icon applied to chat window (customApplied=1)';
  }
});

scenarios.push({
  id: 138,
  regression: true, // FIXED bug kept as a regression check (chat window icon follows iconOn live)
  name: 'Changing the Active Icon (iconOn) in Settings does not re-apply to the already-open chat window (only the tray updates until restart)',
  mode: null,
  settings: {},
  async body({ cdp, dataDir }) {
    const fs = require('node:fs');
    const path = require('node:path');
    const launcher = require('../launch');
    const onIco = path.join(launcher.REPO_ROOT, 'icons', 'IconOn.ico');
    const offIco = path.join(launcher.REPO_ROOT, 'icons', 'IconOff.ico');
    if (!fs.existsSync(onIco) || !fs.existsSync(offIco)) throw new Error('icons missing (setup)');

    await showChat();
    await sleep(600);
    // Baseline: the chat window must currently show the DEFAULT IconOn icon.
    const before = runIconCheck(onIco);
    if (before.renderFailed === 1) throw new Error('baseline icon render failed (setup): ' + JSON.stringify(before));
    if (before.customApplied !== 1) throw new Error('baseline icon mismatch (setup): ' + JSON.stringify(before));

    // Change the Active Icon in Settings to IconOff.ico and save.
    await openSettings(cdp);
    await openSection(cdp, 'icons');
    await cdp.waitFor('document.getElementById("iconOnPath") !== null', 10000, 250, 'icons section');
    await cdp.type('#iconOnPath', offIco);
    await saveSettings(cdp, dataDir);
    await sleep(1000);

    // The running chat window must now show IconOff.ico if the setting is
    // applied live (the tray icon does via the TrayIcon hook).
    const after = runIconCheck(offIco);
    if (after.renderFailed === 1) throw new Error('post-save icon render failed (measurement): ' + JSON.stringify(after));
    // FIXED (bug #138): ChatWindow registers a chatWindowIcon settings hook
    // that re-applies WM_SETICON from the current iconOn, so the open window
    // follows the saved Active Icon immediately (like the tray icon).
    if (after.customApplied !== 1)
      throw new Error('chat window icon still stale after saving iconOn (bug #138 not fixed): ' + JSON.stringify(after));
    return 'baseline window icon=IconOn (customApplied=1); after saving iconOn=' + path.basename(offIco) +
      ' the open chat window shows the NEW icon (customApplied=' + after.customApplied + ' - applied live)';
  }
});

scenarios.push({
  id: 142,
  regression: true, // FIXED bug kept as a regression check (follow-ups keep the earlier image context)
  name: 'Follow-up messages drop the image context of earlier attached images from the API request (multi-turn vision loses the image after the first exchange)',
  mode: 'sse-success',
  settings: { newChatStartsWith: 'openai/gpt-5-mini' },
  async body({ cdp, mockLog }) {
    const fs = require('node:fs');
    const readChatRequests = () => {
      const logLines = fs.existsSync(mockLog) ? fs.readFileSync(mockLog, 'utf8').trim().split(/\r?\n/).filter(Boolean) : [];
      const chatReqs = logLines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean)
        .filter((r) => r.body && r.body.messages && !r.body.prompt && r.body.max_tokens !== 50);
      return { logLines, chatReqs };
    };
    const waitForChatRequestCount = async (expected, label) => {
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline) {
        const current = readChatRequests();
        if (current.chatReqs.length >= expected) return current;
        await sleep(100);
      }
      const current = readChatRequests();
      throw new Error(label + ': expected at least ' + expected + ' chat request(s), got ' + current.chatReqs.length + ': ' + JSON.stringify(current.logLines));
    };
    await showChat();
    // Exchange 1: a REAL chatSend with an image attachment (vision-capable
    // model would receive image_url; the mock accepts anything).
    await cdp.eval(`(() => {
      Ipc.postToHost('chatSend', {
        message: 'what is this?',
        attachments: [{ type: 'image', filename: 'img.png', mimeType: 'image/png', base64: 'aGVsbG8=', size: 4, extractedText: '', contentHash: 'followup142' }]
      });
      return true;
    })()`);
    // Direct JS->AHK IPC does not synchronously flip renderer loading state.
    // Prove request 1 actually started before waiting for idle, otherwise the
    // old idle state can win this race under parallel E2E load.
    await waitForChatRequestCount(1, 'first image exchange did not reach mock');
    await waitStreamingIdle(cdp, 40000);
    // Exchange 2: plain text follow-up about the same image.
    await sendChatMessage(cdp, 'and what about the colors?');
    await waitForChatRequestCount(2, 'follow-up exchange did not reach mock');
    await waitStreamingIdle(cdp, 40000);

    const { logLines, chatReqs } = readChatRequests();
    if (chatReqs.length !== 2) throw new Error('expected 2 chat requests, got ' + chatReqs.length + ': ' + JSON.stringify(logLines));
    const req1 = chatReqs[0].body;
    const req2 = chatReqs[1].body;
    const hasImage = (req) => JSON.stringify(req.messages).indexOf('image_url') >= 0;
    if (!hasImage(req1)) throw new Error('setup: exchange 1 did not carry the image: ' + JSON.stringify(req1));
    // FIXED (bug #142): the second request must keep the first message's
    // image content part so the model can answer follow-ups about it;
    // _ProcessAttachmentsForPath now attaches every user message's images.
    if (!hasImage(req2))
      throw new Error('follow-up request dropped the earlier image context: ' + JSON.stringify(req2));
    return 'exchange 1 request carries image_url=' + hasImage(req1) + '; exchange 2 request carries image_url=' +
      hasImage(req2) + ' (follow-up API call keeps the earlier image context)';
  }
});

scenarios.push({
  id: 141,
  name: 'Vision gate blocks an image attachment on a non-vision model BEFORE any API request is sent (live audit)',
  regression: true, // audit: _ProcessAttachmentsForLastUser must reject images for non-vision models pre-flight
  mode: 'sse-success',
  settings: {},
  fixtures: {
    threads: [{ id: 't-vis-141', title: 'Vision Gate' }]
  },
  async body({ cdp, mockLog }) {
    const fs = require('node:fs');
    await showChat();
    // Drive a REAL chatSend with an image attachment (the same payload the UI
    // posts after a paste/drop). deepseek-v4-flash has vision:false - the
    // vision gate must fail the request BEFORE any API call.
    await cdp.eval(`(() => {
      Ipc.postToHost('chatSend', {
        message: 'look at this image',
        attachments: [{ type: 'image', filename: 'img.png', mimeType: 'image/png', base64: 'aGVsbG8=', size: 4, extractedText: '', contentHash: 'vis141' }]
      });
      return true;
    })()`);
    try {
      await cdp.waitFor('document.querySelectorAll(".error-banner").length >= 1', 15000, 300, 'vision error banner');
    } catch (e) {
      const diag = await cdp.eval('({ banners: [...document.querySelectorAll(".error-banner")].map((b) => b.textContent), msgs: chatMessages.length, loading: isLoading, posted: (window.__posted || []).slice(-8) })');
      const logLines = fs.existsSync(mockLog) ? fs.readFileSync(mockLog, 'utf8').trim().split(/\r?\n/).filter(Boolean) : [];
      throw new Error('no vision error banner: ' + JSON.stringify(diag) + ' mockLog=' + JSON.stringify(logLines));
    }
    const banner = await cdp.text('.error-banner');
    if (String(banner).indexOf('does not support vision') < 0)
      throw new Error('vision error banner text wrong: ' + JSON.stringify(banner));
    // No chat request may reach the mock endpoint.
    await sleep(1200);
    const logLines = fs.existsSync(mockLog) ? fs.readFileSync(mockLog, 'utf8').trim().split(/\r?\n/).filter(Boolean) : [];
    const chatReqs = logLines.filter((l) => l.indexOf('"messages"') >= 0 && l.indexOf('"max_tokens":50') < 0);
    if (chatReqs.length !== 0)
      throw new Error('vision gate let a request through: ' + JSON.stringify(chatReqs));
    return 'image attachment on deepseek-v4-flash: error banner "' + String(banner).trim() +
      '" shown and 0 chat requests reached the API (vision gate blocks pre-flight)';
  }
});

scenarios.push({
  id: 43,
  name: 'Short-form model ids keep thinking metadata (provider prefix not required)',
  regression: true, // FIXED by the ModelId consolidation (step 5)
  mode: 'sse-success',
  settings: {},
  fixtures: {
    threads: [{
      id: 't-think-43', title: 'Short Model Think', active_leaf_id: 'm-think-43',
      model_override: 'deepseek-v4-pro', reasoning_override: 'high'
    }],
    messages: [{ id: 'm-think-43', thread_id: 't-think-43', role: 'user', content: 'hello' }]
  },
  async body({ cdp, mockLog }) {
    await showChat();
    await cdp.waitFor('document.querySelectorAll("#thread-list .chat-item").length > 0', 15000, 300, 'thread list');
    await cdp.click('#thread-list .chat-item');
    await cdp.waitFor('document.querySelectorAll("#chat-messages .msg").length >= 1', 15000, 300, 'thread loaded');
    await sleep(700);
    // FIXED (ModelId.Lookup): the models map is keyed by full ids, but the
    // short form now resolves to its full key, so the right rail gets the
    // model's thinking levels.
    const optionCount = await cdp.eval('document.getElementById("reasoningDropdown") ? document.getElementById("reasoningDropdown").options.length : -1');
    if (optionCount < 2)
      throw new Error('right-rail thinking dropdown has no levels for the short-form model: options=' + optionCount);
    // Send a message and inspect the actual request sent to the (mock) API.
    await sendChatMessage(cdp, 'second message');
    await waitStreamingIdle(cdp, 30000);
    await sleep(500);
    const lines = fs.readFileSync(mockLog, 'utf8').split(/\r?\n/).filter(Boolean);
    const chatReq = lines.map((l) => JSON.parse(l)).find((e) => e.body && e.body.stream === true);
    if (!chatReq) throw new Error('no streaming chat request was logged; lines=' + lines.length);
    const b = chatReq.body;
    // FIXED: the reasoning override must now reach the request for the
    // short-form id.
    if (!b.thinking && !b.reasoning_effort)
      throw new Error('thinking was dropped for the short-form model: ' + JSON.stringify(b));
    return 'thread model_override=deepseek-v4-pro + reasoning_override=high: right-rail dropdown has ' + optionCount +
      ' option(s), and the sent request carries thinking config (model=' + b.model + ')';
  }
});

scenarios.push({
  id: 51,
  name: 'Vision gate accepts short-form model ids (provider prefix not required) - static check',
  regression: true, // FIXED by the ModelId consolidation (step 5)
  mode: null,
  noApp: true,
  async body() {
    const au = fs.readFileSync(path.join(launcher.REPO_ROOT, 'shared', 'AttachmentUtils.ahk'), 'utf8');
    const crb = fs.readFileSync(path.join(launcher.REPO_ROOT, 'chat', 'ChatRequestBuilder.ahk'), 'utf8');
    const rp = fs.readFileSync(path.join(launcher.REPO_ROOT, 'app', 'RequestProcessor.ahk'), 'utf8');
    const dm = fs.readFileSync(path.join(launcher.REPO_ROOT, 'default-settings', 'DefaultModels.ahk'), 'utf8');
    // FIXED: HasVision resolves through ModelId.Lookup, which accepts short
    // ids (the old models.Has-only check refused short ids - bug #51).
    const hasShortFormFallback = /static HasVision\(modelName\) \{[\s\S]*?ModelResolver\.Lookup\(models, modelName\)/.test(au);
    // Both the chat attachment gate and the command screenshot gate pass the
    // raw model name straight through.
    const chatGateUsesRawName = /_ProcessAttachmentsForPath\(&apiMessages, modelName\)[\s\S]*?AttachmentUtils\.HasVision\(modelName\)/.test(crb);
    const commandGateUsesRawName = /AttachmentUtils\.HasVision\(APIModelsArr\[1\]\)/.test(rp);
    // A vision-capable model exists, keyed ONLY by its full "provider/model" id.
    const m = dm.match(/"openai\/gpt-4\.1-mini", \{([\s\S]*?)\n    \},/);
    const fullEntryHasVision = !!m && /vision: true/.test(m[1]);
    const shortKeyExists = /^\s*"gpt-4\.1-mini", \{/m.test(dm);
    if (!hasShortFormFallback || !chatGateUsesRawName || !commandGateUsesRawName || !fullEntryHasVision || shortKeyExists)
      throw new Error('short-form vision fallback missing: hasShortFormFallback=' + hasShortFormFallback +
        ' chatGateUsesRawName=' + chatGateUsesRawName + ' commandGateUsesRawName=' + commandGateUsesRawName +
        ' fullEntryHasVision=' + fullEntryHasVision + ' shortKeyExists=' + shortKeyExists);
    return 'AttachmentUtils.HasVision resolves short ids via ModelId.Lookup, so "gpt-4.1-mini" finds the vision:true openai/gpt-4.1-mini entry; both gates still pass the raw id, which now works';
  }
});

scenarios.push({
  id: 61,
  name: "Clearing Suspend Banner text resets the banner (SettingsApply assigns empty)",
  regression: true, // FIXED bug kept as a regression check (clearing a UI field must replace the stale global)
  mode: null,
  noApp: true,
  async body() {
    const fs = require("node:fs");
    const path = require("node:path");
    const launcher = require("../launch");
    const sa = fs.readFileSync(path.join(launcher.REPO_ROOT, "app", "settings", "SettingsApply.ahk"), "utf8");
    // FIXED (bug #61): _ApplySuspendBanner assigns the text even when empty.
    const assignsEmptyText = /if sb\.Has\("text"\)\s*\n\s*suspendBannerText := sb\["text"\]/.test(sa);
    const skipsEmpty = /sb\.Has\("text"\) && sb\["text"\] != ""/.test(sa);
    if (!assignsEmptyText || skipsEmpty)
      throw new Error("clearing suspend banner text still skipped (bug #61 not fixed): assignsEmptyText=" + assignsEmptyText + " skipsEmpty=" + skipsEmpty);
    return "SettingsApply._ApplySuspendBanner assigns the text even when empty, so clearing the field resets the banner";
  }
});

scenarios.push({
  id: 62,
  name: "Forking a chat with temperature 0 keeps the override (TreeRepo zero-safe)",
  regression: true, // FIXED bug kept as a regression check (fork must inherit a temperature 0 override)
  mode: null,
  noApp: true,
  async body() {
    const fs=require("node:fs");
    const path=require("node:path");
    const launcher=require("../launch");
    const tr=fs.readFileSync(path.join(launcher.REPO_ROOT,"chat","db","TreeRepo.ahk"),"utf8");
    // FIXED (bug #62): _CopyThreadSettings treats 0 as a valid override.
    const zeroSafe = tr.includes('if settings.temperatureOverride != ""');
    const truthyOnly = tr.includes('if settings.temperatureOverride') && !zeroSafe;
    if (!zeroSafe || truthyOnly)
      throw new Error("fork temp-0 copy not fixed (bug #62): zeroSafe=" + zeroSafe + " truthyOnly=" + truthyOnly);
    return "TreeRepo._CopyThreadSettings checks temperatureOverride != \"\" (0 is a valid override), so forking a thread with temp 0 keeps it";
  }
});

scenarios.push({
  id: 63,
  name: "Thread pricing unit falls back to 10% when cachedInput is empty string",
  regression: true, // FIXED bug kept as a regression check (empty cachedInput must fall back to 10% of input)
  mode: null,
  noApp: true,
  async body() {
    const fs = require("node:fs");
    const path = require("node:path");
    const launcher = require("../launch");
    const tr = fs.readFileSync(path.join(launcher.REPO_ROOT, "chat", "db", "TreeRepo.ahk"), "utf8");
    // FIXED (bug #63): a stored "" is treated as missing.
    const emptySafe = /cachedInput: pricing\.HasOwnProp\("cachedInput"\) && pricing\.cachedInput != ""/.test(tr);
    if (!emptySafe) throw new Error("cachedInput empty fallback not fixed (bug #63): emptySafe=" + emptySafe);
    return "TreeRepo GetThreadStats pricingUnit treats cachedInput=\"\" as missing and falls back to 10% of input";
  }
});



scenarios.push({
  id: 64,
  name: "Context Used includes thinking tokens (header reports full context)",
  regression: true, // FIXED bug kept as a regression check (active_path_tokens must include thinking)
  mode: null,
  noApp: true,
  async body() {
    const sc=fs.readFileSync(require("path").join(require("../launch").REPO_ROOT,"chat","streaming","StreamCompletion.ahk"),"utf8");
    // token_count stays visible-only (that is the message body output).
    const hasVisibleOnly = /token_count: Max\(0, completionTokens - thinkingTokens\)/.test(sc);
    const mr2=fs.readFileSync(require("path").join(require("../launch").REPO_ROOT,"chat","db","MessageRepo.ahk"),"utf8");
    // FIXED (bug #64): active_path_tokens = prompt + visible + thinking.
    const activeIncludesThinking = /activePathTokens := msgObj\.prompt_tokens \+ tc \+ tht/.test(mr2);
    const tr=fs.readFileSync(require("path").join(require("../launch").REPO_ROOT,"chat","db","TreeRepo.ahk"),"utf8");
    // _RecomputeActivePath adds thinking to the prefix sums too. Bug #107
    // refactored the loop to read the always-present path field directly
    // (msg.thinking_tokens), so the old HasProp-guarded form is gone.
    const recomputeIncludesThinking = /prev \+= msg\.thinking_tokens/.test(tr);
    if(!hasVisibleOnly || !activeIncludesThinking || !recomputeIncludesThinking) throw new Error("bug #64 not fixed: visibleOnly=" + hasVisibleOnly + " activeIncludesThinking=" + activeIncludesThinking + " recomputeIncludesThinking=" + recomputeIncludesThinking);
    return "MessageRepo active_path_tokens includes thinking (prompt + visible + thinking) and _RecomputeActivePath adds thinking to prefix sums, so the header Context Used counts reasoning tokens";
  }
});

scenarios.push({
  id: 65,
  name: "Hard-delete recomputes cumulative token/cost counters",
  regression: true, // FIXED bug kept as a regression check (hard delete must decrement the header totals)
  mode: null,
  noApp: true,
  async body() {
    const fs2=require("node:fs");
    const path2=require("node:path");
    const launcher2=require("../launch");
    const mr=fs2.readFileSync(path2.join(launcher2.REPO_ROOT,"chat","db","MessageRepo.ahk"),"utf8");
    const hd=mr.slice(mr.indexOf("static HardDelete"), mr.indexOf("static HardDelete")+3000);
    // FIXED (bug #65): HardDelete recomputes the cumulative counters.
    const recomputes = hd.includes("_RecomputeCumulativeCounters(");
    if(!recomputes) throw new Error("bug #65 not fixed: HardDelete does not recompute cumulative counters");
    return "HardDelete recomputes cumulative_* counters (via _RecomputeCumulativeCounters) so the header totals drop with the deleted message";
  }
});

scenarios.push({
  id: 66,
  name: "Header tooltip says Cumulative (typo fixed)",
  regression: true, // FIXED bug kept as a regression check (tooltip must not be misspelled)
  mode: null,
  noApp: true,
  async body() {
    const fs3=require("node:fs");
    const path3=require("node:path");
    const launcher3=require("../launch");
    const fmt=fs3.readFileSync(path3.join(launcher3.REPO_ROOT,"webui","js","chat","chat-format.js"),"utf8");
    // FIXED (bug #66): the tooltip reads "Cumulative".
    if(/Culminative/.test(fmt)) throw new Error("bug #66 not fixed: Culminative still present");
    if(!/Cumulative Input\/output token usage/.test(fmt)) throw new Error("bug #66 not fixed: corrected label missing");
    return "chat-format.js tooltip reads 'Cumulative Input/output token usage across all conversation branches'";
  }
});



scenarios.push({
  id: 67,
  regression: true,
  name: "Mock SSE usage (prompt 12, completion 9, cached 4) is stored accurately and header reflects it",
  mode: "sse-success",
  settings: {},
  fixtures: {
    threads: [{ id: "t-usage-67", title: "Usage Parse Check", active_leaf_id: "m-usage-67" }],
    messages: [{ id: "m-usage-67", thread_id: "t-usage-67", role: "user", content: "hello" }]
  },
  async body({ cdp, dbPath }) {
    const seed=require("../seed");
    await cdp.waitFor('document.querySelectorAll("#thread-list .chat-item").length > 0', 15000, 300, "thread list");
    await cdp.click('#thread-list .chat-item');
    await cdp.waitFor('document.querySelectorAll("#chat-messages .msg").length >= 1', 15000, 300, "thread loaded");
    await cdp.eval('document.getElementById("chat-input").value=""');
    await cdp.type("#chat-input", "verify usage parse");
    await cdp.click("#chat-send-btn");
    await cdp.waitFor('typeof isLoading !== "undefined" && isLoading === true', 10000, 100, "stream started");
    await cdp.waitFor('typeof streamState !== "undefined" && !streamState.active', 30000, 300, "stream done");
    // Stream completion and the final DB transaction are separate events. A
    // fixed post-completion sleep was occasionally too short under parallel
    // WebView2/AutoHotkey load, so wait for the durable assistant row.
    const persistDeadline = Date.now() + 15000;
    let msgs = [];
    let asst = null;
    while (Date.now() < persistDeadline) {
      msgs = seed.query(dbPath, "SELECT role, token_count, thinking_tokens, cached_tokens, active_path_tokens FROM messages WHERE thread_id='t-usage-67' ORDER BY created_at");
      asst = msgs.filter(m=>m.role==="assistant").pop() || null;
      if (asst) break;
      await new Promise(r=>setTimeout(r,100));
    }
    if(!asst) throw new Error("no assistant: "+JSON.stringify(msgs));
    if(asst.token_count !== 9) throw new Error("assistant token_count wrong: "+JSON.stringify(asst));
    if(asst.cached_tokens !== 4) throw new Error("cached_tokens wrong: "+JSON.stringify(asst));
    if(asst.active_path_tokens !== 21) throw new Error("active_path wrong: "+JSON.stringify(asst));
    await cdp.waitFor('document.getElementById("tokenBar") && (document.getElementById("tokenBar").innerText.includes("21") || [...document.querySelectorAll("#tokenBar .tu-item")].some((item) => item.title.includes("21")))', 15000, 200, "usage header refresh");
    const barTitles=await cdp.eval('[...document.querySelectorAll("#tokenBar .tu-item")].map(e=>e.title)');
    const barText=await cdp.eval('document.getElementById("tokenBar").innerText');
    const hasContext=barText.includes("21") || barTitles.join(" ").includes("21");
    if(!hasContext) throw new Error("header missing 21: bar="+JSON.stringify(barText)+" titles="+JSON.stringify(barTitles));
    return "assistant stored token_count=9 cached=4 active=21 header shows 21";
  }
});
scenarios.push({
  id: 68,
  name: "ProviderResolver legacy prefix match is prefix-only",
  regression: true, // FIXED bug kept as a regression check (substring matches must not resolve to the wrong provider)
  mode: null,
  noApp: true,
  async body() {
    const pr=require("node:fs").readFileSync(require("node:path").join(require("../launch").REPO_ROOT,"api","ProviderResolver.ahk"),"utf8");
    // FIXED (bug #68): legacy short ids match by prefix only.
    const hasPrefixCheck = /SubStr\(modelId, 1, StrLen\(prefix\)\) = prefix/.test(pr);
    const hasSubstring = /if InStr\(modelId, prefix\)/.test(pr);
    if(!hasPrefixCheck || hasSubstring) throw new Error("bug #68 not fixed: hasPrefixCheck=" + hasPrefixCheck + " hasSubstring=" + hasSubstring);
    return "ProviderResolver.Resolve matches legacy short ids by prefix only, so mygpt-custom no longer resolves to the gpt provider";
  }
});

scenarios.push({
  id: 69,
  name: "Search LIKE escapes % _ \\ wildcards (literal search)",
  regression: true, // FIXED bug kept as a regression check (LIKE must match user input literally)
  mode: null,
  noApp: true,
  async body() {
    const sr=require("node:fs").readFileSync(require("node:path").join(require("../launch").REPO_ROOT,"chat","db","SearchRepo.ahk"),"utf8");
    // FIXED (bug #69): _EscapeLike escapes \ % _ before binding the LIKE.
    const escapesBackslash = /StrReplace\(value, "\\", "\\\\"\)/.test(sr);
    const escapesPercent = /StrReplace\(value, "%", "\\%"\)/.test(sr);
    const escapesUnderscore = /StrReplace\(value, "_", "\\_"\)/.test(sr);
    const usesEscaped = sr.includes("_EscapeLike(query)");
    if(!escapesBackslash || !escapesPercent || !escapesUnderscore || !usesEscaped)
      throw new Error("bug #69 not fixed: backslash=" + escapesBackslash + " percent=" + escapesPercent + " underscore=" + escapesUnderscore + " usesEscaped=" + usesEscaped);
    return "SearchRepo._EscapeLike escapes \\ % _ (bound into the LIKE), so searching for % matches only literal percent";
  }
});

scenarios.push({
  id: 70,
  name: "Search FTS5 quotes terms so special characters do not break MATCH",
  regression: true, // FIXED bug kept as a regression check (FTS5 must not choke on special chars)
  mode: null,
  noApp: true,
  async body() {
    const fs=require("node:fs");
    const path=require("node:path");
    const launcher=require("../launch");
    const sr=fs.readFileSync(path.join(launcher.REPO_ROOT,"chat","db","SearchRepo.ahk"),"utf8");
    const fts=sr.slice(sr.indexOf("static _FTS5"), sr.indexOf("static _FTS5")+2500);
    // FIXED (bug #70): terms are quoted for FTS5 MATCH.
    const quotesTerms = /_FTS5QuoteTerm\(trimmed\)/.test(fts);
    const buildsRaw = /ftsExpr \.= trimmed/.test(fts);
    if(!quotesTerms || buildsRaw) throw new Error("bug #70 not fixed: quotesTerms=" + quotesTerms + " buildsRaw=" + buildsRaw);
    return "SearchRepo._FTS5 quotes each term (_FTS5QuoteTerm), so C++ / quoted queries no longer break MATCH";
  }
});

scenarios.push({
  id: 71,
  name: "Clearing Thread Title Generation fields resets the globals",
  regression: true, // FIXED bug kept as a regression check (family #61: cleared fields must reset globals)
  mode: null,
  noApp: true,
  async body() {
    const sa=require("node:fs").readFileSync(require("node:path").join(require("../launch").REPO_ROOT,"app","settings","SettingsApply.ahk"),"utf8");
    // FIXED (bug #71): _ApplyThreadTitles assigns even when empty.
    const assignsModel = /if tt\.Has\("model"\)\s*\n\s*titleGenModel := tt\["model"\]/.test(sa);
    const assignsPrompt = /if tt\.Has\("prompt"\)\s*\n\s*titleGenSystemPrompt := tt\["prompt"\]/.test(sa);
    const skipsModel = /tt\.Has\("model"\) && tt\["model"\] != ""/.test(sa);
    const skipsPrompt = /tt\.Has\("prompt"\) && tt\["prompt"\] != ""/.test(sa);
    if(!assignsModel || !assignsPrompt || skipsModel || skipsPrompt)
      throw new Error("bug #71 not fixed: assignsModel=" + assignsModel + " assignsPrompt=" + assignsPrompt + " skipsModel=" + skipsModel + " skipsPrompt=" + skipsPrompt);
    return "SettingsApply._ApplyThreadTitles assigns cleared values, so title-gen fields reset instead of keeping stale globals";
  }
});

scenarios.push({
  id: 72,
  name: "SystemMessageResolver treats UNC paths as absolute",
  regression: true, // FIXED bug kept as a regression check (UNC paths must be read as-is)
  mode: null,
  noApp: true,
  async body() {
    const sr=require("node:fs").readFileSync(require("node:path").join(require("../launch").REPO_ROOT,"shared","SystemMessageResolver.ahk"),"utf8");
    const checksColon = /if !InStr\(filePath, ":"\)/.test(sr);
    const handlesUnc = /SubStr\(filePath, 1, 1\) = "\\"/.test(sr);
    if(!checksColon || !handlesUnc) throw new Error("bug #72 not fixed: checksColon=" + checksColon + " handlesUnc=" + handlesUnc);
    return "SystemMessageResolver.Resolve treats \\\\server\\share (UNC) and rooted paths as absolute and reads them as-is";
  }
});

scenarios.push({
  id: 73,
  name: "GoogleChatCompletions disabled config includes include_thoughts:false for 2.x",
  regression: true, // FIXED bug kept as a regression check (disabled config must be symmetric with enabled)
  mode: null,
  noApp: true,
  async body() {
    const gc=require("node:fs").readFileSync(require("node:path").join(require("../launch").REPO_ROOT,"api","handlers","GoogleChatCompletions.ahk"),"utf8");
    const disabledStart = gc.indexOf("static DisabledConfig");
    const disabledEnd = gc.indexOf("static ThinkingConfig", disabledStart);
    const disabled = gc.slice(disabledStart, disabledEnd);
    const hasBudget0 = /thinking_budget: 0/.test(disabled);
    const hasIncludeFalse = /include_thoughts: false/.test(disabled);
    if(!hasBudget0 || !hasIncludeFalse) throw new Error("bug #73 not fixed: hasBudget0=" + hasBudget0 + " hasIncludeFalse=" + hasIncludeFalse);
    return "GoogleChatCompletions.DisabledConfig returns {include_thoughts:false, thinking_budget:0} for Gemini 2.x";
  }
});

scenarios.push({
  id: 74,
  name: "SettingsApply clears providerMap when all prefixes are explicitly cleared",
  regression: true, // FIXED bug kept as a regression check (empty prefix sets must clear the map)
  mode: null,
  noApp: true,
  async body() {
    const sa=require("node:fs").readFileSync(require("node:path").join(require("../launch").REPO_ROOT,"app","settings","SettingsApply.ahk"),"utf8");
    // FIXED (bug #74): explicit prefixes (even empty) rebuild providerMap.
    const hasExplicitCheck = /hasExplicitPrefixes/.test(sa);
    const stillGuarded = /if newProviderMap\.Count > 0/.test(sa);
    if(!hasExplicitCheck || stillGuarded) throw new Error("bug #74 not fixed: hasExplicitCheck=" + hasExplicitCheck + " stillGuarded=" + stillGuarded);
    return "SettingsApply._ApplyProviders assigns providerMap whenever prefixes are explicitly defined (an empty set clears it)";
  }
});

scenarios.push({
  id: 75,
  name: "GoogleChatCompletions budget table matches the Gemini family",
  regression: true, // FIXED bug kept as a regression check (budget table must not match arbitrary substrings)
  mode: null,
  noApp: true,
  async body() {
    const gc=require("node:fs").readFileSync(require("node:path").join(require("../launch").REPO_ROOT,"api","handlers","GoogleChatCompletions.ahk"),"utf8");
    const hasSubstring = /if InStr\(modelId, "2\.5-pro"\)/.test(gc);
    const hasFamily = /if InStr\(modelId, "gemini-2\.5-pro"\)/.test(gc);
    if(hasSubstring || !hasFamily) throw new Error("bug #75 not fixed: hasSubstring=" + hasSubstring + " hasFamily=" + hasFamily);
    return "GoogleChatCompletions._BudgetTable matches the gemini-2.5-pro family (not any substring), so my2.5-pro falls back to generic";
  }
});

scenarios.push({
  id: 76,
  name: "initChatMode always updates activeThreadId on thread switch",
  regression: true, // FIXED bug kept as a regression check (loaded thread must become active even when one was already set)
  mode: null,
  noApp: true,
  async body() {
    const cc=require("node:fs").readFileSync(require("node:path").join(require("../launch").REPO_ROOT,"webui","js","chat","chat-core.js"),"utf8");
    const hasGuard = /if \(data && data\.threadId && !activeThreadId\)/.test(cc);
    const assigns = /if \(data && data\.threadId\)\s*\{\s*activeThreadId = data\.threadId/.test(cc);
    if(hasGuard || !assigns) throw new Error("bug #76 not fixed: hasGuard=" + hasGuard + " assigns=" + assigns);
    return "initChatMode always updates activeThreadId from the loaded thread, so thread switches/search/sends target the right thread";
  }
});

scenarios.push({
  id: 77,
  name: "onChatSend empty input is a no-op (no accidental retry)",
  regression: true, // FIXED bug kept as a regression check (empty Send must not re-fire the last message)
  mode: null,
  noApp: true,
  async body() {
    const ci=require("node:fs").readFileSync(require("node:path").join(require("../launch").REPO_ROOT,"webui","js","chat","chat-input.js"),"utf8");
    // Empty Send must return without posting a retry or chatSend request.
    const sendBlock = ci.slice(ci.indexOf("function onChatSend()"), ci.indexOf("// Show the loading dots indicator"));
    const hasNoOp = /if \(message \|\| attachments\.length > 0\)/.test(sendBlock) && /An empty Send/.test(sendBlock);
    const stillRetries = sendBlock.includes("retryLastAssistantMessage(lastMsg.id)") || sendBlock.includes("Ipc.postToHost('retry')");
    if(!hasNoOp || stillRetries) throw new Error("bug #77 not fixed: hasNoOp=" + hasNoOp + " stillRetries=" + stillRetries);
    return "chat-input.js onChatSend returns early for empty input, so an empty Send no longer retries the last message";
  }
});

scenarios.push({
  id: 78,
  name: "Right-rail temperature 0 shows 0.0 (falsy check fixed)",
  regression: true, // FIXED bug kept as a regression check (0 must be a valid displayed temperature)
  mode: null,
  noApp: true,
  async body() {
    const cfg=require("node:fs").readFileSync(require("node:path").join(require("../launch").REPO_ROOT,"webui","js","chat","model-picker","model-picker-config.js"),"utf8");
    // FIXED (bug #78): hasTemp uses explicit empty checks so 0 is valid.
    const hasFalsy = /var hasTemp = settings\.temperature &&/.test(cfg);
    const handlesZero = /settings\.temperature !== '' && settings\.temperature !== undefined/.test(cfg);
    if(hasFalsy || !handlesZero) throw new Error("bug #78 not fixed: hasFalsy=" + hasFalsy + " handlesZero=" + handlesZero);
    return "model-picker-config.js hasTemp uses explicit empty checks, so a 0 override shows 0.0 instead of Default";
  }
});

scenarios.push({
  id: 79,
  name: "SettingsPersistence.Load strips a UTF-8 BOM before parsing",
  regression: true, // FIXED bug kept as a regression check (BOM'd settings files must load)
  mode: null,
  noApp: true,
  async body() {
    const sp=require("node:fs").readFileSync(require("node:path").join(require("../launch").REPO_ROOT,"app","settings","SettingsPersistence.ahk"),"utf8");
    const loadsRaw = /raw := FileRead\(path, "UTF-8"\)/.test(sp);
    const stripsBOM = /Chr\(0xFEFF\)/.test(sp) || /FEFF/.test(sp);
    const parsesDirect = /parsed := jsongo\.Parse\(raw\)/.test(sp);
    if(!loadsRaw || !stripsBOM || !parsesDirect) throw new Error("bug #79 not fixed: loadsRaw=" + loadsRaw + " stripsBOM=" + stripsBOM + " parsesDirect=" + parsesDirect);
    return "SettingsPersistence.Load strips a leading UTF-8 BOM (Chr(0xFEFF)) before jsongo.Parse, so BOM'd settings files load normally";
  }
});

scenarios.push({
  id: 80,
  name: "ThreadRepo escapes threadId in mutators (SQL injection fixed)",
  regression: true, // FIXED bug kept as a regression check (security: crafted ids must not inject SQL)
  mode: null,
  noApp: true,
  async body() {
    const tr=require("node:fs").readFileSync(require("node:path").join(require("../launch").REPO_ROOT,"chat","db","ThreadRepo.ahk"),"utf8");
    const soft = tr.slice(tr.indexOf("static SoftDelete"), tr.indexOf("static SoftDelete")+800);
    const hasBindSoft = /WHERE id=\?;"/.test(soft);
    const hasDirectSoft = /WHERE id='" threadId "'/.test(soft);
    const upd = tr.slice(tr.indexOf("static Update(threadId"), tr.indexOf("static Update(threadId")+800);
    const hasBindUpd = /WHERE id=\?;"/.test(upd);
    if(!hasBindSoft || hasDirectSoft) throw new Error("bug #80 not fixed: soft binds=" + hasBindSoft + " direct=" + hasDirectSoft);
    if(!hasBindUpd) throw new Error("bug #80 not fixed: update binds=" + hasBindUpd);
    return "ThreadRepo SoftDelete/Restore/Delete/Update bind threadId (?) - crafted ids cannot inject SQL";
  }
});

scenarios.push({
  id: 81,
  name: "Branch _setupSiblingGroup escapes msg.id (SQL injection fixed)",
  regression: true, // FIXED bug kept as a regression check (security: crafted message ids must not inject SQL)
  mode: null,
  noApp: true,
  async body() {
    const br=require("node:fs").readFileSync(require("node:path").join(require("../launch").REPO_ROOT,"chat","callbacks","Branch.ahk"),"utf8");
    const snippet = br.slice(br.indexOf("_setupSiblingGroup"), br.indexOf("_setupSiblingGroup")+800);
    const hasBind = /UPDATE messages SET sibling_group=\?, sibling_index=0 WHERE id=\?;/.test(snippet);
    const hasDirect = /WHERE id='" msg\.id "'/.test(snippet);
    if(!hasBind || hasDirect) throw new Error("bug #81 not fixed: hasBind=" + hasBind + " hasDirect=" + hasDirect);
    return "Branch._setupSiblingGroup binds msg.id (?) - crafted message ids cannot inject SQL";
  }
});

scenarios.push({
  id: 82,
  name: "Usage dashboard filter dropdowns escape provider/model names (XSS fixed)",
  regression: true, // FIXED bug kept as a regression check (security: option values/labels must be escaped)
  mode: null,
  noApp: true,
  async body() {
    const dash=require("node:fs").readFileSync(require("node:path").join(require("../launch").REPO_ROOT,"webui","js","usage-dashboard.js"),"utf8");
    const hasEsc = /escHtml\(p\)/.test(dash) && /escHtml\(m\)/.test(dash);
    const hasRaw = /provSel\.innerHTML \+=.*'<option value="'\+p\+/.test(dash);
    if(!hasEsc || hasRaw) throw new Error("bug #82 not fixed: hasEsc=" + hasEsc + " hasRaw=" + hasRaw);
    return "usage-dashboard.js populateFilters escapes provider/model option values and labels (escHtml), so names render as inert text";
  }
});

scenarios.push({
  id: 83,
  name: "Threadmap who label escapes the model name (XSS fixed)",
  regression: true, // FIXED bug kept as a regression check (security: model names in the nav list must be escaped)
  mode: null,
  noApp: true,
  async body() {
    const tm=require("node:fs").readFileSync(require("node:path").join(require("../launch").REPO_ROOT,"webui","js","chat","chat-threadmap.js"),"utf8");
    const hasEsc = /escHtml\(who\)/.test(tm);
    const hasRawWho = /item\.innerHTML =.*\+ who \+/.test(tm);
    if(!hasEsc || hasRawWho) throw new Error("bug #83 not fixed: hasEsc=" + hasEsc + " hasRawWho=" + hasRawWho);
    return "chat-threadmap.js renderNavList escapes the who label (escHtml(who)), so model names render as inert text";
  }
});

scenarios.push({
  id: 84,
  name: "ApiLogsViewer esc() escapes single quotes (title attribute safe)",
  regression: true, // FIXED bug kept as a regression check (security: esc must handle ')
  mode: null,
  noApp: true,
  async body() {
    const html=require("node:fs").readFileSync(require("node:path").join(require("../launch").REPO_ROOT,"webui","api-logs.html"),"utf8");
    const escBody = html.slice(html.indexOf("function esc(s)"), html.indexOf("function esc(s)")+500);
    const escapesQuote = /&#39;/.test(escBody);
    const hasQuoteInRegex = /\[&<>"']/.test(escBody);
    if(!escapesQuote || !hasQuoteInRegex) throw new Error("bug #84 not fixed: escapesQuote=" + escapesQuote + " hasQuoteInRegex=" + hasQuoteInRegex);
    return "webui/api-logs.html esc() escapes single quotes (&#39;), so title attributes cannot be broken";
  }
});

scenarios.push({
  id: 86,
  name: "FIM fallback renderMarkdown uses the html:false markdown renderer (XSS fixed)",
  regression: true, // REFUTED as a duplicate of #57 (fixed in 05e2ccb); kept as a regression check for the FIM fallback path
  mode: null,
  noApp: true,
  async body() {
    const cc=require("node:fs").readFileSync(require("node:path").join(require("../launch").REPO_ROOT,"webui","js","chat","chat-core.js"),"utf8");
    const hasMdRender = /contentElement\.innerHTML = result/.test(cc) && /md\.render\(contentToRender\)/.test(cc);
    const main=require("node:fs").readFileSync(require("node:path").join(require("../launch").REPO_ROOT,"webui","js","main.js"),"utf8");
    const htmlSafe = /html: false/.test(main);
    const htmlTrue = /markdownit\(\{[^}]*html: true/.test(main);
    if(!hasMdRender || !htmlSafe || htmlTrue) throw new Error("bug #86/#57 not fixed: hasMdRender=" + hasMdRender + " htmlSafe=" + htmlSafe + " htmlTrue=" + htmlTrue);
    return "chat-core.js renderMarkdown renders via the html:false md instance (fixed by #57), so FIM fallback content is inert";
  }
});

scenarios.push({
  id: 87,
  name: "UsageRepo lastMonth filter uses local boundaries (matches local labels)",
  regression: true, // FIXED bug kept as a regression check (lastMonth must use local calendar dates)
  mode: null,
  noApp: true,
  async body() {
    const ur=require("node:fs").readFileSync(require("node:path").join(require("../launch").REPO_ROOT,"chat","db","UsageRepo.ahk"),"utf8");
    const urBlock = ur.slice(ur.indexOf("static _WhereDate"), ur.indexOf("static _WhereDate")+1400);
    const lastMonthUsesLocal = /lastMonthStart && monthStart[\s\S]{0,160}params: \[lastMonthStart, monthStart\]/.test(urBlock);
    const queryPassesLocal = /lastMonthStart := FormatTime\(DateAdd\(A_Now, -1/.test(ur);
    if(!lastMonthUsesLocal || !queryPassesLocal) throw new Error("bug #87 not fixed: lastMonthUsesLocal=" + lastMonthUsesLocal + " queryPassesLocal=" + queryPassesLocal);
    return "UsageRepo lastMonth filter uses local month boundaries (FormatTime/DateAdd), matching the dashboard labels";
  }
});

scenarios.push({
  id: 88,
  name: "UsageRepo month (last 30 days) filter uses the local cutoff (matches dashboard)",
  regression: true, // FIXED with bug #87 (local monthCutoff) - kept as a regression check
  mode: null,
  noApp: true,
  async body() {
    const ur=require("node:fs").readFileSync(require("node:path").join(require("../launch").REPO_ROOT,"chat","db","UsageRepo.ahk"),"utf8");
    const monthBlock = ur.slice(ur.indexOf('if range = "month"'), ur.indexOf('if range = "month"')+220);
    const usesLocal = /monthCutoff[\s\S]{0,120}params: \[monthCutoff\]/.test(monthBlock);
    const queryPassesLocal = /monthCutoff := FormatTime\(DateAdd\(A_Now, -29/.test(ur);
    if(!usesLocal || !queryPassesLocal) throw new Error("bug #88 not fixed: usesLocal=" + usesLocal + " queryPassesLocal=" + queryPassesLocal);
    return "UsageRepo month (last 30 days) filter uses the local cutoff (FormatTime/DateAdd), matching the dashboard labels";
  }
});

scenarios.push({
  id: 89,
  name: "CurlBuilder sanitizes the API key in the Authorization header (injection fixed)",
  regression: true, // FIXED bug kept as a regression check (security: crafted keys must not break/inject the curl command)
  mode: null,
  noApp: true,
  async body() {
    const cb=require("node:fs").readFileSync(require("node:path").join(require("../launch").REPO_ROOT,"api","CurlBuilder.ahk"),"utf8");
    const hasSanitize = /_SafeApiKey/.test(cb);
    const rawInterp = /Authorization: Bearer ' providerInfo\.apiKey '/.test(cb);
    if(!hasSanitize || rawInterp) throw new Error("bug #89 not fixed: hasSanitize=" + hasSanitize + " rawInterp=" + rawInterp);
    return "CurlBuilder sanitizes the API key (_SafeApiKey strips \\\" % & | < > ^) before embedding it in the Authorization header";
  }
});

scenarios.push({
  id: 90,
  name: "SettingsMerge.Override guards non-object incoming (settings safe)",
  regression: true, // FIXED bug kept as a regression check (non-object payloads must not pollute settings)
  mode: null,
  noApp: true,
  async body() {
    const sm=require("node:fs").readFileSync(require("node:path").join(require("../launch").REPO_ROOT,"app","settings","SettingsMerge.ahk"),"utf8");
    const overrideBlock = sm.slice(sm.indexOf("static Override"), sm.indexOf("static Override")+300);
    const hasGuard = /if !IsObject\(incoming\)/.test(overrideBlock);
    const rawIter = /for k, v in incoming/.test(overrideBlock) && !hasGuard;
    if(!hasGuard || rawIter) throw new Error("bug #90 not fixed: hasGuard=" + hasGuard + " rawIter=" + rawIter);
    return "SettingsMerge.Override guards non-object incoming payloads (IsObject), so a crafted empty-string payload cannot pollute settings";
  }
});

scenarios.push({
  id: 91,
  name: "InputWindow validateInputAndHide accepts '0' as valid input",
  regression: true, // FIXED bug kept as a regression check ("0" must not be treated as empty)
  mode: null,
  noApp: true,
  async body() {
    const iw=require("node:fs").readFileSync(require("node:path").join(require("../launch").REPO_ROOT,"app","InputWindow.ahk"),"utf8");
    const block = iw.slice(iw.indexOf("validateInputAndHide"), iw.indexOf("validateInputAndHide")+300);
    const usesTrim = /Trim\(this\.EditControl\.Value\) = ""/.test(block);
    const falsyCheck = /if !this\.EditControl\.Value/.test(block);
    if(!usesTrim || falsyCheck) throw new Error("bug #91 not fixed: usesTrim=" + usesTrim + " falsyCheck=" + falsyCheck);
    return "InputWindow.validateInputAndHide treats only empty/whitespace as empty, so '0' is accepted";
  }
});

scenarios.push({
  id: 92,
  name: "Models ensureFullId rebuilds from the provider dropdown (prefix updated)",
  regression: true, // FIXED bug kept as a regression check (selected provider must win over an embedded prefix)
  mode: null,
  noApp: true,
  async body() {
    const m=require("node:fs").readFileSync(require("node:path").join(require("../launch").REPO_ROOT,"webui","js","settings","sections","models.js"),"utf8");
    const block = m.slice(m.indexOf("function ensureFullId"), m.indexOf("// --- Pricing / context", m.indexOf("function ensureFullId")));
    const stripsPrefix = /id = id\.slice\(slash \+ 1\)/.test(block);
    const earlyReturn = /if \(id\.indexOf\('\/'\) >= 0\) return id/.test(block);
    if(!stripsPrefix || earlyReturn) throw new Error("bug #92 not fixed: stripsPrefix=" + stripsPrefix + " earlyReturn=" + earlyReturn);
    return "models.js ensureFullId rebuilds the full id from the provider dropdown (strips embedded prefix), so changing the provider updates the saved id";
  }
});

scenarios.push({
  id: 93,
  name: "SettingsDefaults GetDefaults deep-clones snapshots (hardening)",
  regression: true, // FIXED bug kept as a regression check (snapshot mutations must not corrupt pristine defaults)
  mode: null,
  noApp: true,
  async body() {
    const sd=require("node:fs").readFileSync(require("node:path").join(require("../launch").REPO_ROOT,"app","settings","SettingsDefaults.ahk"),"utf8");
    const doesDeep = /snapshot\[k\] := SettingsDefaults\._DeepClone\(v\)/.test(sd);
    const hasShallow = /snapshot\[k\] := v/.test(sd);
    if(!doesDeep || hasShallow) throw new Error("bug #93 not fixed: doesDeep=" + doesDeep + " hasShallow=" + hasShallow);
    return "SettingsDefaults.GetDefaults deep-clones nested Maps/Arrays, so mutating a snapshot cannot corrupt the pristine defaults";
  }
});

scenarios.push({
  id: 94,
  name: "SettingsDefaults GetDefaults is stable after caching (UUID churn refuted)",
  regression: true, // REFUTED: UUIDs are generated only when building defaults; after CacheInitialDefaults the cached snapshot is returned
  mode: null,
  noApp: true,
  async body() {
    const sd=require("node:fs").readFileSync(require("node:path").join(require("../launch").REPO_ROOT,"app","settings","SettingsDefaults.ahk"),"utf8");
    const caches = /CacheInitialDefaults\(\)/.test(sd) && /_initialDefaultsCaptured/.test(sd);
    const cachedReturn = /snapshot := Map\(\)/.test(sd) && /_initialDefaults/.test(sd);
    if(!caches || !cachedReturn) throw new Error("bug #94 not fixed: caches=" + caches + " cachedReturn=" + cachedReturn);
    return "SettingsDefaults caches the pristine defaults at startup and GetDefaults returns the cached snapshot, so assistant ids are stable after caching (UUID churn refuted)";
  }
});


scenarios.push({
  id: 95,
  name: "Usage dashboard model heading escapes the model id (XSS fixed)",
  regression: true, // FIXED bug kept as a regression check (security: model headings must be escaped)
  mode: null,
  noApp: true,
  async body() {
    const fs=require("node:fs");
    const path=require("node:path");
    const launcher=require("../launch");
    const dash=fs.readFileSync(path.join(launcher.REPO_ROOT,"webui","js","usage-dashboard.js"),"utf8");
    const sec = dash.slice(dash.indexOf("model-section"), dash.indexOf("model-section")+3000);
    const hasEsc = /escHtml\(model\)/.test(sec);
    const hasRawInner = /div\.innerHTML = .<h6>.+model \+/.test(sec);
    if(!hasEsc || hasRawInner) throw new Error("bug #95 not fixed: hasEsc=" + hasEsc + " hasRawInner=" + hasRawInner);
    return "usage-dashboard.js renderModelSections escapes the model heading (escHtml(model)), so model ids render as inert text";
  }
});

scenarios.push({
  id: 96,
  name: "AttachmentRepo escapes msgId/threadId in every statement (SQL injection fixed)",
  regression: true, // FIXED bug kept as a regression check (security: crafted ids must stay literal)
  mode: null,
  noApp: true,
  async body() {
    const fs=require("node:fs");
    const path=require("node:path");
    const launcher=require("../launch");
    const ar=fs.readFileSync(path.join(launcher.REPO_ROOT,"chat","db","AttachmentRepo.ahk"),"utf8");
    const cd=fs.readFileSync(path.join(launcher.REPO_ROOT,"chat","db","ChatDB.ahk"),"utf8");
    // Hardening (bug #96): every msgId/threadId is a bound parameter.
    const insertBinds = ar.includes("VALUES(?, ?, ?, ?, ?, ?, ?, ?);");
    const rawInsert = /VALUES\('" id "', '" msgId "'/.test(ar);
    const getBinds = /static GetByMessage\(msgId\)[\s\S]{0,300}WHERE message_id=\?/.test(ar);
    const getThreadBinds = /static GetByThread\(threadId\)[\s\S]{0,300}WHERE m\.thread_id=\?/.test(ar);
    const delBinds = /static DeleteByMessage\(msgId[^)]*\)[\s\S]{0,700}DELETE FROM message_attachments WHERE message_id=\?/.test(ar);
    const copyBinds = /static CopyForMessage\(sourceMsgId, targetMsgId[^)]*\)[\s\S]{0,500}WHERE message_id=\?[\s\S]{0,1300}VALUES\(\?, \?, \?/.test(ar);
    const ftsSyncBinds = /static FTS_Sync\(msgId, content\)[\s\S]{0,900}DELETE FROM messages_fts WHERE msg_id=\?/.test(cd);
    const ftsRemoveBinds = /static FTS_Remove\(msgId\)[\s\S]{0,200}DELETE FROM messages_fts WHERE msg_id=\?/.test(cd);
    const rawWhere = /WHERE message_id='" msgId "'/.test(ar);
    if(!insertBinds || rawInsert || !getBinds || !getThreadBinds || !delBinds || !copyBinds || !ftsSyncBinds || !ftsRemoveBinds || rawWhere)
      throw new Error("bug #96 not fixed: insertBinds="+insertBinds+" rawInsert="+rawInsert+" getBinds="+getBinds+" getThreadBinds="+getThreadBinds+" delBinds="+delBinds+" copyBinds="+copyBinds+" ftsSyncBinds="+ftsSyncBinds+" ftsRemoveBinds="+ftsRemoveBinds+" rawWhere="+rawWhere);
    return "AttachmentRepo/ChatDB bind msgId/threadId in Insert, GetByMessage, GetByThread, DeleteByMessage, CopyForMessage, FTS_Sync, FTS_Remove - crafted ids stay literal";
  }
});

scenarios.push({
  id: 97,
  name: "SettingsPersistence.Save writes temp file then renames atomically (bug fixed)",
  regression: true, // FIXED bug kept as a regression check (settings must never be deleted before write)
  mode: null,
  noApp: true,
  async body() {
    const fs=require("node:fs");
    const path=require("node:path");
    const launcher=require("../launch");
    const sp=fs.readFileSync(path.join(launcher.REPO_ROOT,"app","settings","SettingsPersistence.ahk"),"utf8");
    const saveBlock=sp.slice(sp.indexOf("static Save"), sp.indexOf("static Save")+1400);
    // FIXED (bug #97): write to a temp file, then rename over the target.
    const hasTempWrite = /tmpPath := path "\.tmp"/.test(saveBlock) && /FileOpen\(tmpPath, "w"/.test(saveBlock);
    const hasAtomicMove = /FileMove\(tmpPath, path, 1\)/.test(saveBlock);
    const deletesFirst = /FileDelete\(path\)/.test(saveBlock);
    const appendsDirect = /FileAppend\(jsonStr, path/.test(saveBlock);
    if(!hasTempWrite || !hasAtomicMove || deletesFirst || appendsDirect)
      throw new Error("bug #97 not fixed: hasTempWrite="+hasTempWrite+" hasAtomicMove="+hasAtomicMove+" deletesFirst="+deletesFirst+" appendsDirect="+appendsDirect);
    return "SettingsPersistence.Save writes settings.json.tmp then FileMove(tmpPath, path, 1) - a mid-write failure can no longer destroy the original settings.json";
  }
});

scenarios.push({
  id: 98,
  name: "StreamHandler cancel branch cleans up _stream state (bug fixed)",
  regression: true, // FIXED bug kept as a regression check (cancel must not leak _stream* keys)
  mode: null,
  noApp: true,
  async body() {
    const fs=require("node:fs");
    const path=require("node:path");
    const launcher=require("../launch");
    const sh=fs.readFileSync(path.join(launcher.REPO_ROOT,"chat","streaming","StreamHandler.ahk"),"utf8");
    const idx = sh.indexOf("if wasCancelled");
    if (idx < 0) throw new Error("bug #98 regression: wasCancelled branch not found");
    const branch = sh.slice(idx, sh.indexOf("return", idx)+20);
    // FIXED (bug #98): the cancel branch must clean up _stream state before return.
    const hasCancelHandler = /_handleStreamCancelled\(\)/.test(branch);
    const hasCleanup = /_cleanupStreamState\(\)/.test(branch);
    const cleanupBeforeReturn = branch.indexOf("_cleanupStreamState()") > 0 && branch.indexOf("_cleanupStreamState()") < branch.indexOf("return");
    if(!hasCancelHandler || !hasCleanup || !cleanupBeforeReturn)
      throw new Error("bug #98 not fixed: hasCancelHandler="+hasCancelHandler+" hasCleanup="+hasCleanup+" cleanupBeforeReturn="+cleanupBeforeReturn);
    return "StreamHandler _finalizeStreaming wasCancelled branch calls _handleStreamCancelled then _cleanupStreamState before return - no _stream* keys leak into the next request";
  }
});
scenarios.push({
  id: 99,
  name: "MessageRepo.Insert escapes parent_id/sibling_group (SQL injection fixed)",
  regression: true, // FIXED bug kept as a regression check (security: crafted ids must stay literal)
  mode: null,
  noApp: true,
  async body() {
    const fs=require("node:fs");
    const path=require("node:path");
    const launcher=require("../launch");
    const mr=fs.readFileSync(path.join(launcher.REPO_ROOT,"chat","db","MessageRepo.ahk"),"utf8");
    // Hardening (bug #99): parent_id and sibling_group are bound parameters,
    // including the active-path parent lookup inside Insert.
    const parentBinds = /parentId := msgObj\.HasProp\("parent_id"\) && msgObj\.parent_id \? msgObj\.parent_id : ""/.test(mr);
    const siblingBinds = /siblingGroup := msgObj\.HasProp\("sibling_group"\) && msgObj\.sibling_group \? msgObj\.sibling_group : ""/.test(mr);
    const parentLookupBinds = /SELECT active_path_tokens FROM messages WHERE id=\?/.test(mr);
    const parentRaw = /WHERE id='" msgObj\.parent_id "'/.test(mr);
    const siblingRaw = /WHERE sibling_group='" msgObj\.sibling_group "'/.test(mr);
    if(!parentBinds || !siblingBinds || !parentLookupBinds || parentRaw || siblingRaw)
      throw new Error("bug #99 not fixed: parentBinds="+parentBinds+" siblingBinds="+siblingBinds+" parentLookupBinds="+parentLookupBinds+" parentRaw="+parentRaw+" siblingRaw="+siblingRaw);
    return "MessageRepo.Insert binds parent_id and sibling_group (and the active-path parent lookup), so crafted ids stay literal";
  }
});

scenarios.push({
  id: 100,
  name: "LLMRequestBuilder._FixStreamBoolean is quote-aware (user content safe)",
  regression: true, // FIXED bug kept as a regression check (boolean fix must not touch string values)
  mode: null,
  noApp: true,
  async body() {
    const fs=require("node:fs");
    const path=require("node:path");
    const launcher=require("../launch");
    const lb=fs.readFileSync(path.join(launcher.REPO_ROOT,"api","LLMRequestBuilder.ahk"),"utf8");
    const block=lb.slice(lb.indexOf("static _FixStreamBoolean"), lb.indexOf("static _FixStreamBoolean")+1400);
    // FIXED (bug #100): no global StrReplace over the whole payload - the
    // rewrite is quote-aware (scans outside string literals).
    const naiveReplace = block.includes('StrReplace(jsonStr,');
    const quoteAware = /inString/.test(block);
    if(naiveReplace || !quoteAware)
      throw new Error("bug #100 not fixed: naiveReplace="+naiveReplace+" quoteAware="+quoteAware);
    return "LLMRequestBuilder._FixStreamBoolean scans outside JSON string literals (inString tracking), so user content containing stream/include_usage snippets can never be rewritten";
  }
});

scenarios.push({
  id: 101,
  name: "SettingsApply._ApplyCommands persists false/0/empty command values (bug fixed)",
  regression: true, // FIXED bug kept as a regression check (clearing a command toggle must persist)
  mode: null,
  noApp: true,
  async body() {
    const fs=require("node:fs");
    const path=require("node:path");
    const launcher=require("../launch");
    const sa=fs.readFileSync(path.join(launcher.REPO_ROOT,"app","settings","SettingsApply.ahk"),"utf8");
    // Key presence is authoritative, so false/0/empty values survive the round-trip.
    const presenceAssigns = /static _SetIfExists\(cmd, c, key\)[\s\S]{0,200}if c\.Has\(key\)\s*\n\s*cmd\.%key% := c\[key\]/.test(sa);
    const noTruthinessHelpers = !/static _SetIfTruthy|static _SetIfNonZero/.test(sa);
    const commandUsesPresence = (sa.match(/_SetIfExists\(cmd, c,/g) || []).length >= 10;
    const tagsKeepsEmpty = /static _SetIfNonEmptyTags\(cmd, c\)[\s\S]{0,400}if c\.Has\("tags"\) && IsObject\(c\["tags"\]\)\s*\n\s*cmd\.tags := c\["tags"\]/.test(sa);
    if(!presenceAssigns || !noTruthinessHelpers || !commandUsesPresence || !tagsKeepsEmpty)
      throw new Error("bug #101 not fixed: presenceAssigns="+presenceAssigns+" noTruthinessHelpers="+noTruthinessHelpers+" commandUsesPresence="+commandUsesPresence+" tagsKeepsEmpty="+tagsKeepsEmpty);
    return "SettingsApply copy helpers assign whenever the key exists - stream/isFIM/showInputBox false, maxContextWords 0 and empty tags all survive the save round-trip";
  }
});

scenarios.push({
  id: 102,
  name: "UsageRepo provider LIKE escapes % _ \\ wildcards (bug fixed)",
  regression: true, // FIXED bug kept as a regression check (LIKE must match provider literally)
  mode: null,
  noApp: true,
  async body() {
    const fs=require("node:fs");
    const path=require("node:path");
    const launcher=require("../launch");
    const ur=fs.readFileSync(path.join(launcher.REPO_ROOT,"chat","db","UsageRepo.ahk"),"utf8");
    // Hardening (bug #102): provider filters are now BOUND parameters
    // (provider=?) - exact match, so LIKE wildcards in a provider value are
    // matched literally with no LIKE pattern to escape.
    const bindsChatProvider = (ur.match(/" provider=\?"/g) || []).length >= 2; // chat + command queries
    const noProviderLikeClause = !/providerChatClause/.test(ur);
    const noUsageEscapeLike = !/static _EscapeLike\(value\)/.test(ur);
    if(!bindsChatProvider || !noProviderLikeClause || !noUsageEscapeLike)
      throw new Error("provider filter not bound: bindsChatProvider="+bindsChatProvider+" noProviderLikeClause="+noProviderLikeClause+" noUsageEscapeLike="+noUsageEscapeLike);
    return "UsageRepo provider filters bind provider=? (exact match) - a provider value containing % _ \\ is matched literally";
  }
});

scenarios.push({
  id: 103,
  name: "TreeRepo.GetThreadStats resolves pricing from the active model (bug fixed)",
  regression: true, // FIXED bug kept as a regression check (pricing must follow the active model, not the first message)
  mode: null,
  noApp: true,
  async body() {
    const fs=require("node:fs");
    const path=require("node:path");
    const launcher=require("../launch");
    const tr=fs.readFileSync(path.join(launcher.REPO_ROOT,"chat","db","TreeRepo.ahk"),"utf8");
    // FIXED (bug #103): pricing resolves from the active model (request ->
    // thread override -> last assistant), never the first message.
    const hasResolver = /_ResolvePricing\(threadId\)/.test(tr);
    const resolvesRequest = /static _ResolvePricing\(threadId\)[\s\S]{0,300}requestParams\["singleAPIModelName"\]/.test(tr);
    const resolvesOverride = /static _ResolvePricing\(threadId\)[\s\S]{0,600}model_override/.test(tr);
    const resolvesLastAssistant = /static _ResolvePricing\(threadId\)[\s\S]{0,1200}role = "assistant"/.test(tr);
    const firstModelQuery = /SELECT model FROM messages WHERE thread_id='" threadId "' AND model IS NOT NULL.*LIMIT 1/.test(tr);
    if(!hasResolver || !resolvesRequest || !resolvesOverride || !resolvesLastAssistant || firstModelQuery)
      throw new Error("bug #103 not fixed: hasResolver="+hasResolver+" resolvesRequest="+resolvesRequest+" resolvesOverride="+resolvesOverride+" resolvesLastAssistant="+resolvesLastAssistant+" firstModelQuery="+firstModelQuery);
    return "TreeRepo.GetThreadStats pricingUnit uses _ResolvePricing (request model -> thread override -> last assistant on the active path) instead of the thread's first message";
  }
});





scenarios.push({
  id: 107,
  name: "TreeRepo._RecomputeActivePath uses current editable-path estimates",
  regression: true,
  mode: null,
  noApp: true,
  async body() {
    const fs=require("node:fs");
    const path=require("node:path");
    const launcher=require("../launch");
    const tr=fs.readFileSync(path.join(launcher.REPO_ROOT,"chat","db","TreeRepo.ahk"),"utf8");
    const defIdx=tr.indexOf("static _RecomputeActivePath");
    const body=tr.slice(defIdx, defIdx+700);
    const stillPrefixSums = /prev \+= msg\.token_count/.test(body);
    const avoidsHistoricalPrompt = !/prev := msg\.prompt_tokens/.test(body);
    const includesThinking = /prev \+= msg\.thinking_tokens/.test(body);
    if(!stillPrefixSums || !avoidsHistoricalPrompt || !includesThinking)
      throw new Error("current-path estimate contract broken: prefix="+stillPrefixSums+" avoidsPrompt="+avoidsHistoricalPrompt+" thinking="+includesThinking);
    return "_RecomputeActivePath prefix-sums current message contributions (including thinking) while leaving historical assistant prompt_tokens for accounting only";
  }
});

scenarios.push({
  id: 108,
  name: "main.js IPC routing uses an explicit allowlist (arbitrary window[target] removed)",
  regression: true, // FIXED bug kept as a regression check (security: crafted targets must not invoke globals)
  mode: null,
  noApp: true,
  async body() {
    const fs=require("node:fs");
    const path=require("node:path");
    const launcher=require("../launch");
    const main=fs.readFileSync(path.join(launcher.REPO_ROOT,"webui","js","main.js"),"utf8");
    // FIXED (bug #108): no dynamic window[target] invocation - the legacy
    // targets (updateTopbarTitle/updateBranchInfo) now have explicit cases.
    const hasDynamicCall = /window\[target\]\(/.test(main);
    const hasAllowlist = /case 'updateTopbarTitle':/.test(main) && /case 'updateBranchInfo':/.test(main);
    if(hasDynamicCall || !hasAllowlist)
      throw new Error("bug #108 not fixed: hasDynamicCall="+hasDynamicCall+" hasAllowlist="+hasAllowlist);
    return "main.js handleWebMessage routes updateTopbarTitle/updateBranchInfo via explicit cases and never calls window[target], so a crafted IPC target cannot invoke arbitrary globals";
  }
});

scenarios.push({
  id: 109,
  name: "Sidebar and ChatDB escape remaining raw ids (SQL injection sweep complete)",
  regression: true, // FIXED bug kept as a regression check (security: crafted ids must stay literal everywhere)
  mode: null,
  noApp: true,
  async body() {
    const fs=require("node:fs");
    const path=require("node:path");
    const launcher=require("../launch");
    const sidebar=fs.readFileSync(path.join(launcher.REPO_ROOT,"chat/callbacks/Sidebar.ahk"),"utf8");
    // Hardening (bug #109): every id is a bound parameter.
    const folderBinds = /DELETE FROM chat_folders WHERE id=\?/.test(sidebar);
    const threadBinds = /WHERE id=\?;", params\["threadId"\]/.test(sidebar);
    const mr=fs.readFileSync(path.join(launcher.REPO_ROOT,"chat/db/MessageRepo.ahk"),"utf8");
    const rawMsgId = (mr.match(/WHERE id='" msgId "'/g) || []).length;
    const boundMsgId = (mr.match(/WHERE id=\?/g) || []).length;
    if(!folderBinds || !threadBinds || rawMsgId > 0 || boundMsgId < 5)
      throw new Error("bug #109 not fixed: folderBinds="+folderBinds+" threadBinds="+threadBinds+" rawMsgId="+rawMsgId+" boundMsgId="+boundMsgId);
    return "Sidebar folderId/threadId and MessageRepo msgId sites all bind ids (?) - no raw id interpolation remains";
  }
});


scenarios.push({
  id: 110,
  name: "Streaming deletes temp files on success and error (credential leak fixed)",
  regression: true, // FIXED bug kept as a regression check (security: Bearer tokens must not linger in %TEMP%)
  mode: null,
  noApp: true,
  async body() {
    const fs=require("node:fs");
    const path=require("node:path");
    const launcher=require("../launch");
    const sc=fs.readFileSync(path.join(launcher.REPO_ROOT,"chat","streaming","StreamCompletion.ahk"),"utf8");
    const se=fs.readFileSync(path.join(launcher.REPO_ROOT,"chat","streaming","StreamError.ahk"),"utf8");
    // FIXED (bug #110): every terminal path deletes the temp files (which
    // contain the Bearer token): success, error, and cancel.
    const hasDeleteOnSuccess = /_handleStreamComplete[\s\S]{0,5000}deleteTempFiles/.test(sc);
    const hasDeleteOnError = /_handleStreamError[\s\S]{0,1200}deleteTempFiles/.test(se);
    const hasDeleteOnCancel = /_handleStreamCancelled[\s\S]{0,400}deleteTempFiles/.test(se);
    if(!hasDeleteOnSuccess || !hasDeleteOnError || !hasDeleteOnCancel)
      throw new Error("bug #110 not fixed: hasDeleteOnSuccess="+hasDeleteOnSuccess+" hasDeleteOnError="+hasDeleteOnError+" hasDeleteOnCancel="+hasDeleteOnCancel);
    return "StreamCompletion._handleStreamComplete and StreamError._handleStreamError now call deleteTempFiles (like the cancel path), so request/cURL files with the Bearer token never linger in %TEMP%";
  }
});

scenarios.push({
  id: 111,
  name: "ApiLogger writes the log atomically via temp + rename (bug fixed)",
  regression: true, // FIXED bug kept as a regression check (crash mid-write must not corrupt the log)
  mode: null,
  noApp: true,
  async body() {
    const fs=require("node:fs");
    const path=require("node:path");
    const launcher=require("../launch");
    const al=fs.readFileSync(path.join(launcher.REPO_ROOT,"api","ApiLogger.ahk"),"utf8");
    // FIXED (bug #111): writes go through a temp file + rename helper.
    const hasAtomicHelper = /static _WriteLogs\(logs\)[\s\S]{0,600}FileMove\(tmpPath, this\.logFilePath, 1\)/.test(al);
    const usesHelper = /this\._WriteLogs\(logs\)/.test(al);
    const directOverwrite = /FileOpen\(this\.logFilePath, "w"[\s\S]{0,120}jsongo\.Stringify\(logs\)/.test(al);
    if(!hasAtomicHelper || !usesHelper || directOverwrite)
      throw new Error("bug #111 not fixed: hasAtomicHelper="+hasAtomicHelper+" usesHelper="+usesHelper+" directOverwrite="+directOverwrite);
    return "ApiLogger.LogRequest/TrimToLimit write via temp file + FileMove (atomic), so a crash mid-write cannot corrupt LLM_API_Log.json";
  }
});

scenarios.push({
  id: 112,
  name: "CurlBuilder rejects empty endpoints (malformed cURL prevented)",
  regression: true, // FIXED bug kept as a regression check (empty endpoint must not produce a URL-less cURL command)
  mode: null,
  noApp: true,
  async body() {
    const fs=require("node:fs");
    const path=require("node:path");
    const launcher=require("../launch");
    const cb=fs.readFileSync(path.join(launcher.REPO_ROOT,"api","CurlBuilder.ahk"),"utf8");
    const crb=fs.readFileSync(path.join(launcher.REPO_ROOT,"chat","ChatRequestBuilder.ahk"),"utf8");
    // FIXED (bug #112): every builder returns "" when the endpoint is empty,
    // and the chat request path surfaces a friendly "No endpoint configured".
    const buildGuard = /static Build\(providerInfo, requestFile, outputFile\)[\s\S]{0,250}if !providerInfo\.endpoint\s*\n\s*return ""/.test(cb);
    const streamGuard = /static BuildStream\(providerInfo, requestFile, outputFile, errorFile\)[\s\S]{0,250}if !providerInfo\.endpoint\s*\n\s*return ""/.test(cb);
    const fimGuard = /if !endpoint\s*\n\s*return ""/.test(cb);
    const friendlyError = /_ShowEndpointError\(providerInfo\)/.test(crb);
    if(!buildGuard || !streamGuard || !fimGuard || !friendlyError)
      throw new Error("bug #112 not fixed: buildGuard="+buildGuard+" streamGuard="+streamGuard+" fimGuard="+fimGuard+" friendlyError="+friendlyError);
    return "CurlBuilder.Build/BuildStream/BuildFIM return '' for empty endpoints and ChatRequestBuilder surfaces a friendly 'No endpoint configured' error";
  }
});

scenarios.push({
  id: 115,
  name: "TreeRepo.GetActivePath/GetTree and MessageRepo._RecomputeCumulativeCounters still interpolate raw thread_id (missed #109-class escape)",
  regression: true, // FIXED bug kept as a regression check (all three call sites must escape thread_id)
  mode: null,
  noApp: true,
  async body() {
    const fs = require("node:fs");
    const os = require("node:os");
    const path = require("node:path");
    const { DatabaseSync } = require("node:sqlite");
    const launcher = require("../launch");
    const seed = require("../seed");

    // 1. Source-level: all three call sites must BIND threadId (? parameter) -
    //    crafted ids can never alter the SQL text.
    const tree = fs.readFileSync(path.join(launcher.REPO_ROOT, "chat", "db", "TreeRepo.ahk"), "utf8");
    const msg = fs.readFileSync(path.join(launcher.REPO_ROOT, "chat", "db", "MessageRepo.ahk"), "utf8");
    const boundInGetActivePath = /FROM messages WHERE thread_id=\?;"/.test(tree);
    const boundInGetTree = /SELECT \* FROM messages WHERE thread_id=\?;"/.test(tree);
    const boundInRecompute = /WHERE thread_id=\?;"/.test(msg);
    if (!boundInGetActivePath || !boundInGetTree || !boundInRecompute)
      throw new Error("raw thread_id interpolation still present (bug #115 not fixed): boundInGetActivePath=" + boundInGetActivePath +
        " boundInGetTree=" + boundInGetTree + " boundInRecompute=" + boundInRecompute);

    // 2. Semantics: prove the interpolation changes the query. With a crafted
    //    thread id "x' OR '1'='1", the raw pattern becomes
    //    WHERE thread_id='x' OR '1'='1'  -> matches EVERY row, while the
    //    escaped form (SQLite.Escape) matches only the literal id.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "llm-escape-115-"));
    const dbPath = seed.createDb(dir, {
      threads: [{ id: "t1", title: "A" }, { id: "t2", title: "B" }],
      messages: [
        { id: "m1", thread_id: "t1", role: "user", content: "one" },
        { id: "m2", thread_id: "t2", role: "user", content: "two" }
      ]
    });
    // FK constraints are irrelevant to this injection proof; keep them off so
    // the crafted id cannot be masked by FK errors (the app now runs
    // PRAGMA foreign_keys=ON since hardening item 2).
    const db = new DatabaseSync(dbPath, { readOnly: true, enableForeignKeyConstraints: false });
    const crafted = "x' OR '1'='1";
    const rawRows = db.prepare("SELECT id FROM messages WHERE thread_id='" + crafted + "';").all();
    const escapedRows = db.prepare("SELECT id FROM messages WHERE thread_id='" + crafted.replace(/'/g, "''") + "';").all();
    db.close();
    if (rawRows.length < 2 || escapedRows.length !== 0)
      throw new Error("crafted-id semantics not reproduced: rawRows=" + rawRows.length + " escapedRows=" + escapedRows.length);
    return "GetActivePath/GetTree/_RecomputeCumulativeCounters now escape thread_id; crafted id '" + crafted +
      "' returns " + rawRows.length + " rows raw vs 0 escaped (SQL injection / wrong-thread reads for crafted ids are closed)";
  }
});

scenarios.push({
  id: 116,
  name: "ThreadRepo.Delete double-escapes the thread id into AttachmentRepo.DeleteByThread - crafted ids orphan attachments",
  regression: true, // FIXED bug kept as a regression check (raw id must reach DeleteByThread, which escapes internally)
  mode: null,
  noApp: true,
  async body() {
    const fs = require("node:fs");
    const os = require("node:os");
    const path = require("node:path");
    const { DatabaseSync } = require("node:sqlite");
    const launcher = require("../launch");
    const seed = require("../seed");

    // 1. Source-level: ThreadRepo.Delete must pass the RAW threadId to
    //    AttachmentRepo.DeleteByThread (which binds it internally) - the old
    //    code passed the already-escaped safeId, double-escaping quotes ('' -> ''''),
    //    so crafted-id threads orphaned their attachment rows/files.
    const tr = fs.readFileSync(path.join(launcher.REPO_ROOT, "chat", "db", "ThreadRepo.ahk"), "utf8");
    const ar = fs.readFileSync(path.join(launcher.REPO_ROOT, "chat", "db", "AttachmentRepo.ahk"), "utf8");
    const noDoubleEscape = !/AttachmentRepo\.DeleteByThread\(safeId\)/.test(tr);
    const passesRawId = /AttachmentRepo\.DeleteByThread\(threadId\)/.test(tr);
    // Keep this semantic check independent of comment/line-wrap drift in the
    // repository method: the query must bind the caller's thread id.
    const bindsThread = ar.includes("WHERE m.thread_id=?");
    if (!passesRawId || !bindsThread || !noDoubleEscape)
      throw new Error("double-escape still present (bug #116 not fixed): passesRawId=" + passesRawId + " bindsThread=" + bindsThread + " noDoubleEscape=" + noDoubleEscape);

    // 2. Semantics: SQLite.Escape doubles every internal quote. So for
    //    threadId "x'" the delete path builds:
    //      messages:      WHERE thread_id='x'' '        -> matches literal "x'"  (messages ARE deleted)
    //      attachments:   WHERE m.thread_id='x'''' '     -> matches literal "x''" (NO rows -> attachments orphaned)
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "llm-escape-116-"));
    const dbPath = seed.createDb(dir, {
      threads: [{ id: "x'", title: "Crafted" }],
      messages: [{ id: "m1", thread_id: "x'", role: "user", content: "hi" }]
    });
    const db = new DatabaseSync(dbPath, { enableForeignKeyConstraints: false });
    db.prepare("INSERT INTO message_attachments (id, message_id, attachment_type, file_path) VALUES ('a1','m1','text_file','attachments/x.txt')").run();
    const crafted = "x'";
    const safeId = crafted.replace(/'/g, "''"); // what ThreadRepo.Delete passes on
    const msgDel = db.prepare("DELETE FROM messages WHERE thread_id='" + safeId + "';").run();
    const attQuery = db.prepare("SELECT COUNT(*) AS c FROM message_attachments a JOIN messages m ON a.message_id = m.id WHERE m.thread_id='" + safeId.replace(/'/g, "''") + "';").all()[0].c;
    const orphanRows = db.prepare("SELECT COUNT(*) AS c FROM message_attachments WHERE message_id='m1';").all()[0].c;
    db.close();
    if (msgDel.changes !== 1 || attQuery !== 0 || orphanRows !== 1)
      throw new Error("crafted-id delete semantics not reproduced: msgDeleted=" + msgDel.changes + " attJoined=" + attQuery + " orphanRows=" + orphanRows);
    return "ThreadRepo.Delete now passes the raw threadId into AttachmentRepo.DeleteByThread (bound once, internally); for thread id 'x'' the messages AND attachment rows are deleted";
  }
});

scenarios.push({
  id: 151,
  name: 'A failed title-generation request permanently disables auto-titles for that thread (the bug #140 dispatch guard is never cleared on failure)',
  mode: null,
  regression: true,
  noApp: true,
  settings: {},
  async body() {
    const src = fs.readFileSync(path.join(launcher.REPO_ROOT, 'chat', 'ThreadTitleGen.ahk'), 'utf8');
    // The guard is set BEFORE the cURL request...
    const setBeforeRequest = /_titleGenRequestedThreads\[threadId\]\s*:=\s*true[\s\S]{0,1200}?ProviderResolver\.Resolve/.test(src);
    // ...and the no-title (failure) path now clears it so a later trigger can retry.
    const failurePathClears = /if\s+title\s*\{[\s\S]*?else\s*\{[\s\S]*?_titleGenRequestedThreads\.Delete\(threadId\)/.test(src);
    // Fixed: the guard still prevents duplicate in-flight/success requests, but
    // a failed attempt is retryable.
    // BUG present: no reset existed, so one failed attempt permanently blocked
    // title generation for the thread in this process.
    if (!setBeforeRequest) throw new Error('guard is not set before the request: ' + JSON.stringify({ setBeforeRequest }));
    if (!failurePathClears) throw new Error('failure path does not clear the dispatch guard (BUG present): ' + JSON.stringify({ failurePathClears }));
    return 'ThreadTitleGen.ahk sets _titleGenRequestedThreads[threadId] before the request and clears it on the no-title/failure path - ' +
      'a transient title-gen failure is retryable (unit-verified: second attempt after a failure fires again and titles the thread)';
  }
});

scenarios.push({
  id: 160,
  name: 'Streamed content is corrupted when a poll boundary splits a UTF-8 multibyte character (the File.Pos byte seek resumes inside a character and inserts replacement chars)',
  mode: null,
  regression: true,
  noApp: true,
  settings: {},
  async body() {
    const outFile = path.join(os.tmpdir(), 'llm-utf8-' + process.pid + '.txt');
    try { fs.unlinkSync(outFile); } catch {}
    const probe = path.join(__dirname, '..', 'probe-utf8.ahk');
    const res = spawnSync(launcher.AHK, ['/ErrorStdOut', probe, outFile], { timeout: 25000, windowsHide: true, encoding: 'utf8' });
    if (res.error) throw new Error('utf8 probe spawn failed/timed out: ' + res.error.message);
    if (res.stderr) process.stderr.write('[probe stderr] ' + res.stderr);
    const text = fs.readFileSync(outFile, 'utf-8');
    const m = text.match(/UTF8SPLIT verdict=([^\s]+)/);
    if (!m) throw new Error('probe output missing split verdict: ' + text);
    const verdict = m[1];
    const detail = text.match(/UTF8SPLIT part1=([^\n]*)/);
    // Fixed: _readFileChunk reads RAW bytes and decodes incrementally (a
    // pending tail keeps incomplete trailing bytes), so a split multibyte
    // character round-trips exactly.
    // BUG present: the old UTF-8-RAW byte-seek produced U+FFFD replacements
    // ("ab\uFFFD" + "\uFFFDcd") instead of "ab\u00E9cd".
    if (verdict !== 'OK-roundtrip')
      throw new Error('split read still mangles (BUG present): ' + verdict);
    return 'UTF-8 poll split: part1="' + (detail ? detail[1] : '?') + '" - the raw-byte incremental decode round-trips the split multibyte char (' + verdict + ')';
  }
});

scenarios.push({
  id: 161,
  name: 'Search FTS5 loses prefix matching when the query ends in an apostrophe (the * guard tests the wrong quote char - terms are always double-quoted)',
  mode: null,
  regression: true,
  noApp: true,
  settings: {},
  async body() {
    const outFile = path.join(os.tmpdir(), 'llm-bughunt-db-' + process.pid + '.txt');
    try { fs.unlinkSync(outFile); } catch {}
    const probe = path.join(__dirname, '..', 'probe-bughunt-db.ahk');
    const res = spawnSync(launcher.AHK, ['/ErrorStdOut', probe, outFile, 'fts5-prefix-quote'], { timeout: 25000, windowsHide: true, encoding: 'utf8' });
    if (res.error) throw new Error('fts probe spawn failed/timed out: ' + res.error.message);
    if (res.stderr) process.stderr.write('[probe stderr] ' + res.stderr);
    const text = fs.readFileSync(outFile, 'utf-8');
    const m = text.match(/FTS5PREFIX plain comp hits=(\d+) comp' hits=(\d+)/);
    if (!m) throw new Error('probe output missing FTS5PREFIX line: ' + text);
    const plain = Number(m[1]), quote = Number(m[2]);
    // Fixed: "comp'" behaves like "comp" - the * is only skipped for a
    // trailing "*" (the old guard wrongly skipped it for "'").
    // BUG present: "comp" -> "comp"* found "complete"/"compass"; "comp'" had
    // no * (lastChar = "'") and matched only the literal token "comp'".
    if (!(plain > 0 && quote === plain))
      throw new Error('FTS5 trailing-apostrophe prefix still broken (BUG present): comp=' + plain + " comp'=" + quote);
    return "SearchRepo._FTS5: query \"comp\" finds " + plain + " message(s) and \"comp'\" finds " + quote +
      " - the trailing-apostrophe query keeps its prefix match (terms are always double-quoted, so only a trailing * disables it)";
  }
});

scenarios.push({
  id: 162,
  name: 'A command with the "Default" model (empty APIModels) silently does NOTHING - the dropdown\'s Default option is never substituted with the app default model',
  mode: null,
  regression: true,
  noApp: true,
  settings: {},
  async body() {
    // Fixed: processInitialRequest substitutes the app default model when
    // APIModels is empty (the "Default" dropdown option), so the request loop
    // always runs.
    // BUG present: StrSplit(RegExReplace("", ...), ",") returned an EMPTY
    // array, so the `for` loop never ran - a silent no-op.
    const src = fs.readFileSync(path.join(launcher.REPO_ROOT, 'app', 'RequestProcessor.ahk'), 'utf8');
    const substitute = /APIModelsArr\.Length = 0[\s\S]{0,160}?APIModelsArr\s*:=\s*\[appDefaultModel\]/.test(src);
    if (!substitute)
      throw new Error('empty APIModels is not substituted with appDefaultModel (BUG present): ' + JSON.stringify({ substitute }));
    return 'RequestProcessor.ahk substitutes the app default model for the "Default" (empty APIModels) command option, ' +
      'so the request loop always runs and the command is never a silent no-op';
  }
});

scenarios.push({
  id: 165,
  name: 'Search cannot find attachment extracted_text - FTS5/LIKE only index message content, so a term inside an attached PDF/office file is unsearchable',
  mode: null,
  regression: true,
  noApp: true,
  settings: {},
  async body() {
    const outFile = path.join(os.tmpdir(), 'llm-bughunt-db-' + process.pid + '.txt');
    try { fs.unlinkSync(outFile); } catch {}
    const probe = path.join(__dirname, '..', 'probe-bughunt-db.ahk');
    const res = spawnSync(launcher.AHK, ['/ErrorStdOut', probe, outFile, 'fts-attachment-text'], { timeout: 25000, windowsHide: true, encoding: 'utf8' });
    if (res.error) throw new Error('fts-att probe spawn failed/timed out: ' + res.error.message);
    if (res.stderr) process.stderr.write('[probe stderr] ' + res.stderr);
    const text = fs.readFileSync(outFile, 'utf-8');
    const m = text.match(/FTSATT search needle hits=(\d+)/);
    if (!m) throw new Error('probe output missing FTSATT line: ' + text);
    const hits = Number(m[1]);
    // Fixed: attachment extracted_text is indexed into the FTS table, so the
    // term inside the attached PDF surfaces the message.
    // BUG present: the attachment's extracted_text held the only occurrence of
    // "needle" and SearchRepo never queried message_attachments.
    if (hits !== 1)
      throw new Error('attachment text still unsearchable (BUG present): hits=' + hits);
    return 'Message says "see attached report"; the PDF attachment\'s extracted_text contains "needle" only - Search("needle") returns ' + hits +
      ' hit (attachment extracted_text is indexed and searchable)';
  }
});

scenarios.push({
  id: 166,
  name: 'Legacy assistant isDefault must not create a second new-chat default or override General > New Chats Start With',
  mode: null,
  regression: true,
  noApp: true,
  settings: {},
  async body() {
    const files = [
      ['chat/db/AssistantRepo.ahk', 'assistant'],
      ['chat/ChatSettings.ahk', 'chat settings'],
      ['app/settings/SettingsApply.ahk', 'settings apply'],
      ['app/menu/CommandMenu.ahk', 'command menu'],
      ['chat/ThreadSettings.ahk', 'thread settings'],
      ['webui/js/chat/model-picker/model-picker.js', 'model picker']
    ];
    const reads = [];
    for (const [rel, label] of files) {
      const src = fs.readFileSync(path.join(launcher.REPO_ROOT, rel), 'utf8');
      // isDefault appearing as a written/carried field (a.Has("isDefault") etc.)
      const writes = /isDefault/.test(src);
      // isDefault being READ for behavior: conditions, comparisons, ternaries.
      const readsBehavior = /if\s+[^;{]*isDefault|isDefault\s*(=+|\?|&&|\|\|)|\.isDefault\b/.test(src);
      if (writes && readsBehavior) reads.push(rel + ':behavior');
      else if (writes) reads.push(rel + ':carry-only');
    }
    // Legacy isDefault may still be carried for settings compatibility, but
    // General > New Chats Start With is the only new-chat default.
    const assistantsUi = fs.readFileSync(path.join(launcher.REPO_ROOT, 'webui', 'js', 'settings', 'sections', 'assistants.js'), 'utf8');
    const uiHasDefaultField = /data-field=["']isDefault["']|Set as Default|Default assistant/i.test(assistantsUi);
    // It must have no runtime consumer and no user-facing default control.




    const behaviorReaders = reads.filter((r) => r.endsWith(':behavior'));
    if (behaviorReaders.length !== 0)
      throw new Error('legacy isDefault still affects runtime behavior: ' + JSON.stringify(behaviorReaders));
    if (uiHasDefaultField)
      throw new Error('Assistants UI still exposes a second default selector');
    return 'legacy isDefault is compatibility metadata only; it has no runtime behavior reader and the Assistants UI exposes no second default selector';

  }
});

scenarios.push({
  id: 167,
  name: 'A failed (or usage-less) title-generation API call is never tracked in the usage dashboard - _TitleGen_TrackUsage returns early when promptTokens <= 0 although the billed call happened',
  mode: null,
  regression: true,
  noApp: true,
  settings: {},
  async body() {
    const src = fs.readFileSync(path.join(launcher.REPO_ROOT, 'chat', 'ThreadTitleGen.ahk'), 'utf8');
    // _TitleGen_TrackUsage is invoked with the parse result after the request;
    // it must record the call even when promptTokens is 0/absent (failure or a
    // response without usage) - the API call was already executed and billed.
    const trackCall = /_TitleGen_TrackUsage\(titleGenModel,\s*providerInfo\.providerKey,\s*promptTokens,\s*completionTokens,\s*thinkingTokens,\s*titleGenStart\)/.test(src);
    const earlyReturn = /_TitleGen_TrackUsage\([\s\S]{0,180}?if promptTokens <= 0\s*return/.test(src);
    if (!trackCall) throw new Error('_TitleGen_TrackUsage call missing (behavior changed)');
    // Fixed: no early return - usage-less title calls are still upserted.
    // BUG present: the function returned early on promptTokens <= 0, so a
    // failed/usage-less title call never reached CommandUsage_Upsert.
    if (earlyReturn) throw new Error('title-gen failure tracking still skipped (BUG present): earlyReturn=' + earlyReturn);
    return 'ThreadTitleGen.ahk calls _TitleGen_TrackUsage AFTER the request with NO promptTokens guard - a failed/usage-less title call (still billed) reaches CommandUsage_Upsert (0 tokens + call_count + response time)';
  }
});

scenarios.push({
  id: 175,
  name: 'Cross-thread search navigation race - _pendingSearchScrollMsgId is consumed by ANY thread\'s initChatMode, so navigating to another thread (or a failed load) silently drops or misroutes the search navigation',
  mode: null,
  regression: true,
  noApp: true,
  settings: {},
  async body() {
    const vm = require('node:vm');
    const posts = [];
    const el = () => ({ style: {}, disabled: false, classList: { add() {}, remove() {}, toggle() {} }, addEventListener() {}, querySelector: () => null, querySelectorAll: () => [], innerHTML: '', appendChild() {} });
    const sandbox = {
      console,
      document: { addEventListener() {}, getElementById: () => el(), querySelector: () => null, querySelectorAll: () => [], createElement: () => el() },
      window: { addEventListener() {} },
      Ipc: { postToHost: (t, d) => posts.push([t, d]) },
      sessionStorage: { getItem: () => null, setItem() {} },
      setTimeout() {}, clearTimeout() {},
      renderChatMessages() {}, showTokenUsageBar() {}, hideLoadingIndicator() {},
      // Bug #214/#218: initChatMode now syncs the composer to the in-flight
      // state via setChatButtonsEnabled (unconditional call) - the sandbox
      // must provide it or every initChatMode invocation throws.
      setChatButtonsEnabled() {},
      updateScopedSearchState() {}, scrollToMessageById() {}
    };
    sandbox.global = sandbox;
    const ctx = vm.createContext(sandbox);
    vm.runInContext(fs.readFileSync(path.join(launcher.REPO_ROOT, 'webui', 'js', 'chat', 'chat-search.js'), 'utf8'), ctx);
    vm.runInContext(fs.readFileSync(path.join(launcher.REPO_ROOT, 'webui', 'js', 'chat', 'chat-core.js'), 'utf8'), ctx);
    // Cross-thread search click on thread A sets the pending scroll id (and,
    // bug #175 fix, the thread it belongs to)...
    vm.runInContext('_pendingSearchScrollMsgId = "m-A-1"; _pendingSearchScrollThreadId = "t-A"; true', ctx);
    posts.length = 0;
    // ...but the user quickly opens thread B; B's initChatMode must NOT consume
    // the pending id (it belongs to A) - no navigation is posted.
    vm.runInContext('initChatMode({ messages: [], threadId: "t-B" }); true', ctx);
    let nav = posts.filter((p) => p[0] === 'sidebarAction' && p[1] && p[1].subAction === 'navigateToMessage');
    const active = vm.runInContext('activeThreadId', ctx);
    // BUG present: B's initChatMode consumed the pending id and posted
    // navigateToMessage(m-A-1) while activeThreadId=B - SetActiveLeaf rejected
    // it (message not in B) and the navigation was silently dropped.
    if (nav.length > 0)
      throw new Error('unrelated thread consumed the pending search navigation (BUG present): nav=' + JSON.stringify(nav));
    const pendingAfterB = vm.runInContext('_pendingSearchScrollMsgId', ctx);
    if (pendingAfterB !== 'm-A-1')
      throw new Error('pending navigation must survive an unrelated thread load: ' + pendingAfterB);
    // A's own load consumes it and navigates:
    vm.runInContext('initChatMode({ messages: [], threadId: "t-A" }); true', ctx);
    nav = posts.filter((p) => p[0] === 'sidebarAction' && p[1] && p[1].subAction === 'navigateToMessage');
    if (!nav.length || nav[0][1].messageId !== 'm-A-1')
      throw new Error('the search navigation must fire when the target thread loads: ' + JSON.stringify(nav));
    // Stale-pending case: a failed load leaves the pending id, but an
    // unrelated thread (C) must NOT consume it; A's later load still does.
    vm.runInContext('_pendingSearchScrollMsgId = "m-A-2"; _pendingSearchScrollThreadId = "t-A"; true', ctx);
    posts.length = 0;
    vm.runInContext('initChatMode({ messages: [], threadId: "t-C" }); true', ctx);
    const staleNav = posts.filter((p) => p[0] === 'sidebarAction' && p[1] && p[1].subAction === 'navigateToMessage');
    if (staleNav.length)
      throw new Error('unrelated thread consumed a stale pending navigation (BUG present): ' + JSON.stringify(staleNav));
    vm.runInContext('initChatMode({ messages: [], threadId: "t-A" }); true', ctx);
    const finalNav = posts.filter((p) => p[0] === 'sidebarAction' && p[1] && p[1].subAction === 'navigateToMessage');
    if (!finalNav.length || finalNav[0][1].messageId !== 'm-A-2')
      throw new Error('the target thread must still receive the stale pending navigation: ' + JSON.stringify(finalNav));
    return 'search click on A (m-A-1) -> user opens B first: B\'s initChatMode leaves the pending id untouched (activeThreadId=' + active +
      '), and A\'s own load posts navigateToMessage(m-A-1); a failed load leaves the pending for A only - C cannot steal it, A still gets m-A-2';
  }
});

scenarios.push({
  id: 176,
  name: 'Inline command failure is silent (no paste, no error, no API-log entry) - regression: Run surfaces failures via _HandleInlineError and uses a unique per-request id',
  mode: null,
  regression: true,
  noApp: true,
  settings: {},
  async body() {
    const src = fs.readFileSync(path.join(launcher.REPO_ROOT, 'app', 'InlineRequestRunner.ahk'), 'utf8');
    const runStart = src.indexOf('static Run(commandName');
    if (runStart < 0) throw new Error('InlineRequestRunner.Run not found');
    const runBlock = src.slice(runStart, runStart + 2600);
    const branchesOnSuccess = /if result\.success\s*\{/.test(runBlock);
    const errorPath = /_HandleInlineError\(/.test(runBlock);
    const uniqueId = /ChatDB\._UUID\(\)/.test(runBlock);
    if (!branchesOnSuccess || !errorPath || !uniqueId)
      throw new Error('inline failure/unique-id path missing (BUG present): ' + JSON.stringify({ branchesOnSuccess, errorPath, uniqueId }));
    return 'InlineRequestRunner.Run branches on result.success, surfaces failures via _HandleInlineError (tooltip + API-log error), and uses a unique per-request id - a failed inline command is no longer a silent no-op';
  }
});

scenarios.push({
  id: 327,
  name: 'Headless window helpers never activate the chat window or steal the interactive desktop focus',
  regression: true,
  mode: null,
  noApp: true,
  settings: {},
  async body() {
    const probe = fs.readFileSync(path.join(launcher.REPO_ROOT, 'tests', 'headless', 'probe.ahk'), 'utf8');
    const showStart = probe.indexOf('case "show-chat":');
    const resizeStart = probe.indexOf('case "resize-chat":');
    const loadStart = probe.indexOf('case "load-thread":');
    const triggerStart = probe.indexOf('case "trigger-llm":');
    const iconStart = probe.indexOf('case "icon-check":');
    const showBlock = showStart >= 0 && resizeStart > showStart ? probe.slice(showStart, resizeStart) : '';
    const resizeBlock = resizeStart >= 0 && iconStart > resizeStart ? probe.slice(resizeStart, iconStart) : '';
    const loadBlock = loadStart >= 0 && triggerStart > loadStart ? probe.slice(loadStart, triggerStart) : '';
    const helperStart = probe.indexOf('MoveOffscreenNoActivate(hwnd');
    const helperBlock = helperStart >= 0 && iconStart > helperStart ? probe.slice(helperStart, iconStart) : '';
    const noActivateFlags = /0x0051/.test(helperBlock) && /0x0450/.test(helperBlock);
    const noActivateShow = /ShowWindow[\s\S]*SW_SHOWNOACTIVATE/.test(helperBlock);
    const loadPrepositions = /MoveOffscreenNoActivate\(hwnd\)[\s\S]*PostMessage\(0x502, 2/.test(loadBlock);
    const ipc = fs.readFileSync(path.join(launcher.REPO_ROOT, 'chat', 'ChatIPC.ahk'), 'utf8');
    const ipcHeadlessMode = /headless := wParam = 2/.test(ipc) && /chatWindow\.Show\(headless \? "x-20000 y-20000 NA"/.test(ipc);
    const legacyActivation = /WinShow\(/.test(showBlock) || /WinMove\(/.test(showBlock) || /WinShow\(/.test(resizeBlock) || /WinMove\(/.test(resizeBlock);
    if (!noActivateFlags || !noActivateShow || !loadPrepositions || !ipcHeadlessMode || legacyActivation)
      throw new Error('headless window helper can activate: ' + JSON.stringify({ noActivateFlags, noActivateShow, loadPrepositions, ipcHeadlessMode, legacyActivation }));
    return 'show-chat, resize-chat, and load-thread use off-screen no-activate positioning; WM_LOAD_THREAD headless mode is explicit and no legacy WinShow/WinMove path remains';
  }
});

scenarios.push({
  id: 186,
  regression: true, // REFUTED lead (2026-08-10): rapid open/close cannot orphan WebView2 - closing the chat window only HIDES it (no per-open teardown); teardown happens at app exit, where Main closes ChatWindow gracefully first and the harness force-kills + sweeps by marker
  name: 'WebView2 teardown under rapid open/close: the chat-window X hides instead of tearing down, Main.OnExit WinCloses ChatWindow first, and the harness sweeps msedgewebview2 by user-data marker - every e2e run exercises launch/teardown',
  mode: null,
  noApp: true,
  settings: {},
  async body() {
    const cw = fs.readFileSync(path.join(launcher.REPO_ROOT, 'chat', 'ChatWindow.ahk'), 'utf8');
    const main = fs.readFileSync(path.join(launcher.REPO_ROOT, 'Main.ahk'), 'utf8');
    const launch = fs.readFileSync(path.join(launcher.REPO_ROOT, 'tests', 'headless', 'launch.js'), 'utf8');
    const closeHides = /OnEvent\("Close"[\s\S]{0,80}responseWindow\.Hide\(\)/.test(cw);
    const onExitWired = /OnExit\(closeChatWindow\)/.test(main);
    const gracefulClose = /WinClose\("ahk_pid " chatWindowPID\)/.test(main);
    const teardownGracefulFirst = /function teardownWorker\(mainPid, workerId\)/.test(launch) && /taskkill/.test(launch) && /killE2EWorkerProcesses/.test(launch);
    const sweepByMarker = /sweepWebView2Dirs/.test(launch) && /llm-webview2/.test(launch) && /llm-webview2-.*worker/.test(launch);
    if (!closeHides || !onExitWired || !gracefulClose || !teardownGracefulFirst || !sweepByMarker)
      throw new Error('teardown contract broken: ' + JSON.stringify({ closeHides, onExitWired, gracefulClose, teardownGracefulFirst, sweepByMarker }));
    return 'chat-window Close event hides the window (no per-open WebView2 teardown to orphan); Main.OnExit WinCloses ChatWindow before force-kill; worker teardown force-kills only the owned PID/marker and sweeps the worker WebView2 folder - every real-app E2E scenario exercises launch + teardown';
  }
});

scenarios.push({
  id: 189,
  name: 'Headless E2E never swaps the real AhkLLM profile; each worker launches against its own explicit data directory',
  mode: null,
  regression: true,
  noApp: true,
  settings: {},
  async body() {
    const suite = fs.readFileSync(path.join(launcher.REPO_ROOT, 'tests', 'headless', 'e2e-suite.js'), 'utf8');
    const launch = fs.readFileSync(path.join(launcher.REPO_ROOT, 'tests', 'headless', 'launch.js'), 'utf8');
    const appInfo = fs.readFileSync(path.join(launcher.REPO_ROOT, 'shared', 'AppInfo.ahk'), 'utf8');
    const suiteNeverSwaps = !/isolateProfile\s*\(/.test(suite) && !/restoreProfile\s*\(/.test(suite) && !/llm-profile-bak-/.test(suite);
    const launchSetsDataDir = /env\.AHKLLM_E2E_DATA_DIR\s*=\s*sandbox/.test(launch);
    const appUsesDataDir = /EnvGet\("AHKLLM_E2E_DATA_DIR"\)/.test(appInfo) && /EnvGet\("AHKLLM_E2E_WORKER"\)/.test(appInfo);
    if (!suiteNeverSwaps || !launchSetsDataDir || !appUsesDataDir)
      throw new Error('E2E profile isolation contract broken: ' + JSON.stringify({ suiteNeverSwaps, launchSetsDataDir, appUsesDataDir }));
    return 'e2e-suite has no profile swap/restore path; launcher passes the worker sandbox through AHKLLM_E2E_DATA_DIR and AppInfo uses it only for marked E2E workers';
  }
});

scenarios.push({
  id: 227,
  name: "Main.ahk resolves its own hidden window with A_ScriptHwnd (fixed #227): the ambiguous WinExist(\"ahk_class AutoHotkey\") class lookup - which could return another AHK script's window and silently drop ChatWindow's settings-updated/loading/reload IPC - must not be used for mainScriptHiddenHwnd",
  regression: true,
  mode: null,
  noApp: true,
  async body() {
    const mainAhk = fs.readFileSync(path.join(launcher.REPO_ROOT, 'Main.ahk'), 'utf8');
    // FIXED: Main must pass ITS OWN script window (A_ScriptHwnd), never a
    // class-lookup result that can match the user's other AHK scripts.
    const usesClassLookup = /mainScriptHiddenHwnd\s*:=\s*WinExist\("ahk_class AutoHotkey"\)/.test(mainAhk);
    const usesOwnHwnd = (mainAhk.match(/mainScriptHiddenHwnd\s*:=\s*A_ScriptHwnd/g) || []).length;
    if (usesClassLookup)
      throw new Error('regression: mainScriptHiddenHwnd still uses the ambiguous WinExist("ahk_class AutoHotkey") lookup (bug #227 not fixed)');
    if (usesOwnHwnd !== 2)
      throw new Error('regression: expected BOTH mainScriptHiddenHwnd resolutions (prewarm + _spawnChatWindow) to use A_ScriptHwnd, found ' + usesOwnHwnd);
    const dispatch = fs.readFileSync(path.join(launcher.REPO_ROOT, 'chat', 'callbacks', 'Dispatch.ahk'), 'utf8');
    const postsToPassedHwnd = /CustomMessages\.notifySettingsUpdated\(requestParams\["mainScriptHiddenHwnd"\]\)/.test(dispatch);
    if (!postsToPassedHwnd)
      throw new Error('regression: Dispatch.ahk no longer posts settings-updated to the passed mainScriptHiddenHwnd');
    return 'Main.ahk resolves mainScriptHiddenHwnd with A_ScriptHwnd in both the prewarm spawn and _spawnChatWindow (no ambiguous class lookup), and Dispatch posts settings-updated to that value - the IPC always targets Main itself';
  }
});

module.exports = scenarios;




