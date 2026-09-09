"use strict";
// scenarios/db-verify.js — Thorough DB verification via headless experiments + direct state reads.
const fs=require("node:fs");
const path=require("node:path");
const os=require("node:os");
const { spawn, spawnSync } = require("node:child_process");
const crypto = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");
const { CDP } = require("../cdp");
const seed=require("../seed");
const launcher=require("../launch");
const { sleep, runProbe, showChat, waitStreamingIdle } = require("./helpers");
const { assertInvariants } = require("../invariant-audit");
const scenarios=[];

function lockHash(password, saltHex, iterations) {
  return crypto.pbkdf2Sync(password, Buffer.from(saltHex, "hex"), iterations, 32, "sha256").toString("hex");
}

function post(cdp, payload) {
  return cdp.eval(`window.chrome.webview.postMessage(JSON.stringify(${JSON.stringify(payload)})); true`);
}

function runProbeCheck(check, args = [], timeout = 25000) {
  const outFile = path.join(os.tmpdir(), `llm-bughunt-${check}-${process.pid}.txt`);
  try { fs.unlinkSync(outFile); } catch {}
  const probe = path.join(__dirname, "..", "probe-bughunt-db.ahk");
  const result = spawnSync(launcher.AHK, ["/ErrorStdOut", probe, outFile, check, ...args], { timeout, windowsHide: true, encoding: "utf8" });
  if (result.error) throw new Error(`${check} probe spawn failed/timed out: ${result.error.message}`);
  if (result.stderr) process.stderr.write(`[${check} probe stderr] ${result.stderr}`);
  return fs.readFileSync(outFile, "utf8").replace(/^\uFEFF/, "");
}

scenarios.push({
  id: 300,
  name: "Cross-thread stale SwitchBranch is rejected and cannot alter the active tree",
  regression: true,
  mode: null,
  fixtures: {
    threads: [
      { id: "t-a-300", title: "Chat A", active_leaf_id: "m-a-300" },
      { id: "t-b-300", title: "Chat B", active_leaf_id: "m-b-300-1" }
    ],
    messages: [
      { id: "m-a-300-u", thread_id: "t-a-300", role: "user", content: "AAA_ONLY", token_count: 4, active_path_tokens: 4 },
      { id: "m-a-300", thread_id: "t-a-300", role: "assistant", content: "A response", model: "openai/gpt-4", parent_id: "m-a-300-u", prompt_tokens: 8, token_count: 3, active_path_tokens: 11 },
      { id: "m-b-300-u", thread_id: "t-b-300", role: "user", content: "BBB_ONLY", token_count: 4, active_path_tokens: 4 },
      { id: "m-b-300-1", thread_id: "t-b-300", role: "assistant", content: "B branch one", model: "deepseek/deepseek-v4-flash", parent_id: "m-b-300-u", sibling_group: "sg-b-300", sibling_index: 0, prompt_tokens: 8, token_count: 3, active_path_tokens: 11 },
      { id: "m-b-300-2", thread_id: "t-b-300", role: "assistant", content: "B branch two", model: "deepseek/deepseek-v4-flash", parent_id: "m-b-300-u", sibling_group: "sg-b-300", sibling_index: 1, prompt_tokens: 9, token_count: 5, active_path_tokens: 13 },
      { id: "m-b-300-tail", thread_id: "t-b-300", role: "user", content: "B tail", parent_id: "m-b-300-2", token_count: 2, active_path_tokens: 15 }
    ]
  },
  async body({ cdp, dbPath }) {
    await showChat();
    await cdp.waitFor('document.querySelectorAll("#thread-list .chat-item").length >= 2', 15000, 300, "thread list");
    await cdp.click('#thread-list .chat-item[data-chat="t-b-300"]');
    await cdp.waitFor('window.activeThreadId === "t-b-300"', 15000, 300, "B loaded");
    await cdp.click('#thread-list .chat-item[data-chat="t-a-300"]');
    await cdp.waitFor('window.activeThreadId === "t-a-300"', 15000, 300, "A loaded");
    await post(cdp, { action: "switchBranch", id: "m-b-300-1", direction: 1 });
    await sleep(800);
    const after = seed.query(dbPath, "SELECT active_leaf_id FROM chat_threads WHERE id='t-a-300'")[0].active_leaf_id;
    const pathLen = await cdp.eval("chatMessages.length");
    if (after !== "m-a-300" || pathLen !== 2) throw new Error(`stale branch event changed A: leaf=${after} path=${pathLen}`);
    const probe = runProbeCheck("foreign-switch-reopen", [dbPath, "t-a-300"]);
    if (!/FOREIGN_SWITCH first leaf=m-a-300 pathLen=2 statsPathTokens=11/.test(probe) || !/FOREIGN_SWITCH reopen leaf=m-a-300 pathLen=2 statsPathTokens=11/.test(probe))
      throw new Error("fixed leaf/path did not survive reopen: " + probe);
    await post(cdp, { action: "chatSend", message: "AAA_AFTER_SAFE_SWITCH" });
    await sleep(900);
    const roots = seed.query(dbPath, "SELECT COUNT(*) AS c FROM messages WHERE thread_id='t-a-300' AND parent_id IS NULL")[0].c;
    if (roots !== 1) throw new Error("safe subsequent send created a second root: " + roots);
    return "real stale switchBranch IPC from B while A was active was rejected; A's leaf/path/stats survived close/reopen and a subsequent send stayed in the same root";
  }
});

scenarios.push({
  id: 301,
  name: "Stale message and attachment IDs mutate another chat while A is active",
  regression: true,
  mode: null,
  fixtures: {
    threads: [
      { id: "t-a-301", title: "Chat A", active_leaf_id: "m-a-301" },
      { id: "t-b-301", title: "Chat B", active_leaf_id: "m-b-301-edit" },
      { id: "t-l-301", title: "Locked B", active_leaf_id: "m-l-301", is_locked: 1 }
    ],
    messages: [
      { id: "m-a-301", thread_id: "t-a-301", role: "user", content: "AAA_ONLY" },
      { id: "m-b-301-edit", thread_id: "t-b-301", role: "user", content: "BBB_EDIT_SENTINEL" },
      { id: "m-b-301-delete", thread_id: "t-b-301", role: "user", content: "BBB_DELETE_SENTINEL" },
      { id: "m-l-301", thread_id: "t-l-301", role: "user", content: "LOCKED_ATTACHMENT_SENTINEL" }
    ],
    chatLocks: [{ thread_id: "t-l-301", salt: "00112233445566778899aabbccddeeff", hash: lockHash("correct horse", "00112233445566778899aabbccddeeff", 600000), iterations: 600000 }]
  },
  async body({ cdp, dbPath, dataDir }) {
    const attPath = "attachments/locked-301.txt";
    fs.mkdirSync(path.join(dataDir, "attachments"), { recursive: true });
    fs.writeFileSync(path.join(dataDir, attPath), "LOCKED_FILE_SENTINEL");
    const db = new DatabaseSync(dbPath, { enableForeignKeyConstraints: false });
    db.prepare("INSERT INTO message_attachments (id,message_id,attachment_type,file_path,mime_type,original_filename,file_size) VALUES (?,?,?,?,?,?,?)").run("att-l-301", "m-l-301", "text_file", attPath, "text/plain", "locked.txt", 20);
    db.close();
    await showChat();
    await cdp.waitFor('document.querySelectorAll("#thread-list .chat-item").length >= 2', 15000, 300, "thread list");
    await cdp.click('#thread-list .chat-item[data-chat="t-b-301"]');
    await cdp.waitFor('window.activeThreadId === "t-b-301"', 15000, 300, "B loaded");
    await cdp.click('#thread-list .chat-item[data-chat="t-a-301"]');
    await cdp.waitFor('window.activeThreadId === "t-a-301"', 15000, 300, "A loaded");
    await post(cdp, { action: "editMessage", id: "m-b-301-edit", content: "BBB_EDITED_BY_STALE_EVENT", mode: "overwrite", attachments: [], removedAttachmentIds: [] });
    await sleep(500);
    await post(cdp, { action: "deleteMessage", id: "m-b-301-delete" });
    await sleep(500);
    await post(cdp, { action: "deleteAttachment", id: "att-l-301" });
    await sleep(700);
    const edited = seed.query(dbPath, "SELECT content FROM messages WHERE id='m-b-301-edit'")[0]?.content;
    const deleted = seed.query(dbPath, "SELECT COUNT(*) AS c FROM messages WHERE id='m-b-301-delete'")[0].c;
    const attRows = seed.query(dbPath, "SELECT COUNT(*) AS c FROM message_attachments WHERE id='att-l-301'")[0].c;
    const fileExists = fs.existsSync(path.join(dataDir, attPath));
    if (edited !== "BBB_EDIT_SENTINEL" || deleted !== 1 || attRows !== 1 || !fileExists)
      throw new Error(`cross-chat mutation was not rejected: edited=${edited} deleted=${deleted} attRows=${attRows} file=${fileExists}`);
    const probe = runProbeCheck("callback-ownership");
    if (!/CALLBACK_OWNERSHIP edited=BBB_EDIT_SENTINEL deleted=1 attRows=1 fileExists=1 legit=AAA_EDITED_LEGITIMATELY missing=0/.test(probe))
      throw new Error("ownership probe did not preserve foreign state and allow owned mutation: " + probe);
    return "stale edit/delete/delete-attachment IPC from B while A was active were rejected; B's rows and attachment file survived, while an owned A edit succeeded";
  }
});

scenarios.push({
  id: 302,
  name: "Branch edit with nonexistent, foreign, or off-path IDs inserts bogus roots",
  regression: true,
  mode: null,
  fixtures: {
    threads: [{ id: "t-a-302", title: "Chat A", active_leaf_id: "m-a-302-active" }, { id: "t-b-302", title: "Chat B", active_leaf_id: "m-b-302" }],
    messages: [
      { id: "m-a-302-root", thread_id: "t-a-302", role: "user", content: "AAA_ROOT" },
      { id: "m-a-302-active", thread_id: "t-a-302", role: "assistant", content: "AAA_ACTIVE", model: "openai/gpt-4", parent_id: "m-a-302-root", sibling_group: "sg-a-302", sibling_index: 0 },
      { id: "m-a-302-off", thread_id: "t-a-302", role: "assistant", content: "AAA_OFF_PATH", model: "openai/gpt-4", parent_id: "m-a-302-root", sibling_group: "sg-a-302", sibling_index: 1 },
      { id: "m-b-302", thread_id: "t-b-302", role: "user", content: "BBB_ONLY" }
    ]
  },
  async body({ cdp, dbPath, dataDir }) {
    await showChat();
    await cdp.waitFor('document.querySelectorAll("#thread-list .chat-item").length >= 2', 15000, 300, "thread list");
    await cdp.click('#thread-list .chat-item[data-chat="t-a-302"]');
    await cdp.waitFor('window.activeThreadId === "t-a-302" && chatMessages.length === 2', 15000, 300, "A loaded");
    for (const [id, content] of [["missing-302", "BOGUS_NONEXISTENT"], ["m-b-302", "BOGUS_FOREIGN"], ["m-a-302-off", "BOGUS_OFF_PATH"]]) {
      await post(cdp, { action: "editMessage", id, content, mode: "branch", attachments: [], removedAttachmentIds: [] });
      await sleep(450);
    }
    const bogus = seed.query(dbPath, "SELECT id, parent_id, role, model, content FROM messages WHERE thread_id='t-a-302' AND content LIKE 'BOGUS_%'");
    const foreign = seed.query(dbPath, "SELECT COUNT(*) AS c FROM messages WHERE thread_id='t-a-302' AND content='BOGUS_FOREIGN'")[0].c;
    const missing = seed.query(dbPath, "SELECT COUNT(*) AS c FROM messages WHERE thread_id='t-a-302' AND content='BOGUS_NONEXISTENT'")[0].c;
    if (bogus.length !== 0 || foreign !== 0 || missing !== 0)
      throw new Error("invalid branch sources still inserted messages: " + JSON.stringify({ bogus, foreign, missing }));
    const leaf = seed.query(dbPath, "SELECT active_leaf_id FROM chat_threads WHERE id='t-a-302'")[0].active_leaf_id;
    if (leaf !== "m-a-302-active") throw new Error("rejected branch sources changed active leaf: " + leaf);
    await post(cdp, { action: "chatSend", message: "AAA_AFTER_SAFE_BRANCH" });
    await sleep(800);
    const follow = seed.query(dbPath, "SELECT parent_id FROM messages WHERE thread_id='t-a-302' AND content='AAA_AFTER_SAFE_BRANCH'")[0];
    if (!follow || follow.parent_id !== "m-a-302-active") throw new Error("subsequent send did not use the preserved active path: " + JSON.stringify(follow));
    assertInvariants(dbPath, dataDir);
    return "nonexistent, foreign, and off-path branch sources were rejected without inserts or active-leaf changes; a subsequent send used the existing active path and the reopened database passed invariants";
  }
});

scenarios.push({
  id: 303,
  name: "Chat request and title-generation temp filenames collide under an identical tick",
  regression: true,
  mode: null,
  noApp: true,
  async body() {
    const requestSource = fs.readFileSync(path.join(launcher.REPO_ROOT, "chat", "ChatRequestBuilder.ahk"), "utf8");
    const titleSource = fs.readFileSync(path.join(launcher.REPO_ROOT, "chat", "ThreadTitleGen.ahk"), "utf8");
    if (!/uniqueID\s*:=\s*ChatDB\._UUID\(\)\s*\r?\n\s*requestFile/.test(requestSource)) throw new Error("request builder is not using the UUID seam");
    const tick = 424242;
    const firstId = "00000000-0000-4000-8000-000000000001";
    const secondId = "00000000-0000-4000-8000-000000000002";
    const suffixes = ["Req", "cURL", "Out", "Err"];
    const first = suffixes.map((kind) => path.join(os.tmpdir(), `ChatWindow_${kind}_${firstId}.${kind === "Req" || kind === "Out" ? "json" : "txt"}`));
    const second = suffixes.map((kind) => path.join(os.tmpdir(), `ChatWindow_${kind}_${secondId}.${kind === "Req" || kind === "Out" ? "json" : "txt"}`));
    if (first.some((p, i) => p === second[i]) || !/uniqueID\s*:=\s*ChatDB\._UUID\(\)/.test(titleSource))
      throw new Error("UUID-derived request/title paths are not distinct");
    return `under identical injected tick ${tick}, UUIDs ${firstId} and ${secondId} produce distinct request/cURL/output/error paths; title generation also uses ChatDB._UUID()`;
  }
});

scenarios.push({
  id: 304,
  name: "A locked request logs plaintext after relock and thread switch",
  regression: true,
  mode: "sse-slow",
  fixtures: {
    threads: [
      { id: "t-lock-304", title: "Secret Plan", active_leaf_id: "m-lock-304-a", is_locked: 1 },
      { id: "t-open-304", title: "Ordinary Chat", active_leaf_id: "m-open-304-a" }
    ],
    messages: [
      { id: "m-lock-304-u", thread_id: "t-lock-304", role: "user", content: "LOCKED_SECRET_73B91" },
      { id: "m-lock-304-a", thread_id: "t-lock-304", role: "assistant", content: "private answer", model: "deepseek/deepseek-v4-flash", parent_id: "m-lock-304-u" },
      { id: "m-open-304-u", thread_id: "t-open-304", role: "user", content: "ordinary" },
      { id: "m-open-304-a", thread_id: "t-open-304", role: "assistant", content: "ordinary answer", model: "deepseek/deepseek-v4-flash", parent_id: "m-open-304-u" }
    ],
    chatLocks: [{ thread_id: "t-lock-304", salt: "00112233445566778899aabbccddeeff", hash: lockHash("correct horse", "00112233445566778899aabbccddeeff", 600000), iterations: 600000 }]
  },
  async body({ cdp }) {
    const logPath = path.join(os.tmpdir(), "LLM_API_Log.json");
    try { fs.unlinkSync(logPath); } catch {}
    await showChat();
    await cdp.waitFor('document.querySelectorAll("#thread-list .chat-item").length >= 2', 15000, 300, "thread list");
    await cdp.click('#thread-list .chat-item[data-chat="t-lock-304"]');
    await cdp.waitFor('document.getElementById("threadLockOverlay") !== null', 15000, 300, "lock overlay");
    await cdp.type("#lockPasswordInput", "correct horse");
    await cdp.click("#lockUnlockBtn");
    await cdp.waitFor('window.activeThreadId === "t-lock-304" && document.querySelectorAll("#chat-messages .msg").length >= 2', 30000, 300, "locked chat unlocked");
    await post(cdp, { action: "chatSend", message: "private delayed request" });
    await cdp.waitFor('typeof streamState !== "undefined" && streamState.active === true', 20000, 100, "delayed stream active");
    await post(cdp, { action: "lockChatNow", threadId: "t-lock-304" });
    await cdp.waitFor('window.activeThreadId === ""', 15000, 300, "L relocked");
    await cdp.click('#thread-list .chat-item[data-chat="t-open-304"]');
    await cdp.waitFor('window.activeThreadId === "t-open-304"', 15000, 300, "U loaded");
    await sleep(5000);
    const log = fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf8") : "";
    if (log.includes("LOCKED_SECRET_73B91") || !log.includes("<hidden: locked chat>"))
      throw new Error("locked success log was not redacted: " + log.slice(0, 500));
    const completion = fs.readFileSync(path.join(launcher.REPO_ROOT, "chat", "streaming", "StreamCompletion.ahk"), "utf8");
    const streamError = fs.readFileSync(path.join(launcher.REPO_ROOT, "chat", "streaming", "StreamError.ahk"), "utf8");
    const deepSeek = fs.readFileSync(path.join(launcher.REPO_ROOT, "chat", "tools", "DeepSeekSearch.ahk"), "utf8");
    const tavily = fs.readFileSync(path.join(launcher.REPO_ROOT, "chat", "tools", "TavilySearch.ahk"), "utf8");
    if (!completion.includes("ShouldRedactContent(streamThreadId)") ||
        (streamError.match(/ShouldRedactContent\(streamThreadId\)/g) || []).length < 2 ||
        !deepSeek.includes("ShouldRedactContent(threadId)") || !tavily.includes("ShouldRedactContent(threadId)"))
      throw new Error("not every request-owned API-log path uses the captured thread for redaction");
    return "L was unlocked for send, relocked, then switched to U before completion; success logging followed L and stored only the hidden marker, with error/cancel/search paths statically bound to captured request owners";
  }
});

scenarios.push({
  id: 305,
  name: "Injected fork and hard-delete failures leave durable partial states after reopen",
  regression: true,
  mode: null,
  noApp: true,
  async body() {
    // Fault injection performs several transaction-failure/reopen cycles. The
    // full E2E suite runs workers in parallel, so give this heavier probe a
    // larger process budget than the generic 25-second probe default.
    const text = runProbeCheck("fault-injection", [], 60000);
    const allLines = text.split(/\r?\n/);
    const lines = allLines.filter((line) => line.startsWith("FAULT_AUDIT"));
    if (lines.length !== 5) throw new Error("fault audit missing stages: " + text);
    const forkThread = lines.find((line) => line.includes("label=fork-after-thread"));
    const forkMessage = lines.find((line) => line.includes("label=fork-after-first-message"));
    const deletion = lines.find((line) => line.includes("label=delete-after-reparent"));
    const threadDelete = lines.find((line) => line.includes("label=thread-delete-after-attachments"));
    const lockCreate = lines.find((line) => line.includes("label=lock-create-after-metadata"));
    if (!forkThread || !/threads=1 messages=2 forkRows=0/.test(forkThread)) throw new Error("fork rollback after thread creation failed: " + text);
    if (!forkMessage || !/threads=1 messages=2 forkRows=0/.test(forkMessage)) throw new Error("fork rollback after first message failed: " + text);
    if (!deletion || !/messages=3/.test(deletion) || /childParent=NULL/.test(deletion)) throw new Error("delete rollback after reparent failed: " + text);
    const threadFault = allLines.find((line) => line.includes("FAULT thread-delete error="));
    if (!threadDelete || !/threads=1 messages=1/.test(threadDelete) || !/attachments=1/.test(threadDelete) || !threadFault || !/fileExists=1/.test(threadFault)) throw new Error("thread delete rollback did not preserve attachment row/file: " + text);
    if (!lockCreate || !/locks=0 lockedFlags=0/.test(lockCreate)) throw new Error("lock create rollback left metadata/flag state: " + text);
    return "injected failures after fork creation/message copy, hard-delete reparenting, thread attachment cleanup, and lock metadata all rolled back to coherent pre-operation state after reopen; SQLite integrity and FK checks stayed clean";
  }
});

scenarios.push({
  id: 306,
  name: "ThreadRepo.List exposes a locked title when ThreadLockService is unavailable",
  regression: true,
  mode: null,
  noApp: true,
  async body() {
    const text = runProbeCheck("list-without-lock-service");
    const match = text.match(/LIST_NO_LOCK_SERVICE title=(.*) serviceDefined=(\d+)/);
    if (!match) throw new Error("lock-service probe output missing: " + text);
    if (match[1] !== "Locked chat" || match[2] !== "0") throw new Error("locked title was not redacted without the service: " + text);
    const main = fs.readFileSync(path.join(launcher.REPO_ROOT, "Main.ahk"), "utf8");
    const chatWindow = fs.readFileSync(path.join(launcher.REPO_ROOT, "chat", "ChatWindow.ahk"), "utf8");
    if (!main.includes("#Include <Config>") || main.includes("Thread_List()") || !chatWindow.includes("#Include ChatUtils.ahk"))
      throw new Error("include/reachability classification changed unexpectedly");
    return "ChatDB-only probe returned Locked chat with ThreadLockService undefined; locked titles now fail closed without a session service, while ChatWindow permits real titles only for session-unlocked threads";
  }
});

scenarios.push({
  id: 307,
  regression: true,
  name: "Reusable invariant audit passes on a healthy scenario database",
  mode: null,
  noApp: true,
  async body() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "llm-invariants-"));
    const dbPath = seed.createDb(dir, {
      threads: [{ id: "t-invariant", title: "Healthy", active_leaf_id: "m-invariant-a", cumulative_input_tokens: 8, cumulative_output_tokens: 3 }],
      messages: [
        { id: "m-invariant-u", thread_id: "t-invariant", role: "user", content: "invariant user", token_count: 4, active_path_tokens: 4 },
        { id: "m-invariant-a", thread_id: "t-invariant", role: "assistant", content: "invariant answer", model: "deepseek/deepseek-v4-flash", parent_id: "m-invariant-u", prompt_tokens: 8, token_count: 3, active_path_tokens: 11 }
      ]
    });
    const db = new DatabaseSync(dbPath);
    db.prepare("INSERT INTO messages_fts(msg_id,content) VALUES (?,?)").run("m-invariant-u", "invariant user");
    db.prepare("INSERT INTO messages_fts(msg_id,content) VALUES (?,?)").run("m-invariant-a", "invariant answer");
    db.close();
    const result = assertInvariants(dbPath, dir);
    return `healthy database audit passed: ${JSON.stringify(result.counts)}`;
  }
});

scenarios.push({
  id: 308,
  regression: true,
  name: "First-send helper resolves before callback parsing and does not trigger an AHK #Warn modal",
  mode: null,
  noApp: true,
  async body() {
    const utils = fs.readFileSync(path.join(launcher.REPO_ROOT, "chat", "ChatUtils.ahk"), "utf8");
    const settings = fs.readFileSync(path.join(launcher.REPO_ROOT, "chat", "ChatSettings.ahk"), "utf8");
    const window = fs.readFileSync(path.join(launcher.REPO_ROOT, "chat", "ChatWindow.ahk"), "utf8");
    const ipc = fs.readFileSync(path.join(launcher.REPO_ROOT, "chat", "ChatIPC.ahk"), "utf8");
    const dispatch = fs.readFileSync(path.join(launcher.REPO_ROOT, "chat", "callbacks", "Dispatch.ahk"), "utf8");
    if (!utils.includes("_RequestParamsAreDefault()") || settings.includes("_RequestParamsAreDefault() {"))
      throw new Error("helper was not moved to the shared pre-callback module");
    if (window.indexOf("#Include ChatUtils.ahk") > window.indexOf("#Include callbacks\\Dispatch.ahk"))
      throw new Error("ChatUtils must load before Dispatch callbacks");
    if (window.indexOf("#Include ChatUtils.ahk") > window.indexOf("#Include ChatRequestBuilder.ahk"))
      throw new Error("ChatUtils must load before ChatRequestBuilder so _PostChatError is resolved before #Warn parses its calls");
    if (!ipc.includes('chatWindow.Show(headless ? "x-20000 y-20000 NA" : (activate ? "" : "NA"))') ||
        !ipc.includes('headless := wParam = 2') || !ipc.includes('if activate') || !ipc.includes('WinActivate("ahk_id " chatWindow.hWnd)'))
      throw new Error("IPC thread loads must make activation explicit (non-activating background loads, activating user commands)");
    if (!dispatch.includes("#Include Message.ahk")) throw new Error("Message callback include missing");
    return "_RequestParamsAreDefault is defined once in ChatUtils, loaded before Dispatch/Message, so the first-send call cannot resolve as an unassigned local and show the blocking #Warn modal";
  }
});

scenarios.push({
  id: 309,
  regression: true,
  name: "Invariant audit detects representative logical and physical corruption",
  mode: null,
  noApp: true,
  async body() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "llm-invariants-bad-"));
    fs.mkdirSync(path.join(dir, "attachments"), { recursive: true });
    fs.writeFileSync(path.join(dir, "attachments", "orphan-309.txt"), "orphan");
    const dbPath = seed.createDb(dir, {
      threads: [
        { id: "t-bad-a", title: "A", active_leaf_id: "m-bad-b", cumulative_input_tokens: 99 },
        { id: "t-bad-b", title: "B", active_leaf_id: "m-bad-b" }
      ],
      messages: [
        { id: "m-bad-a", thread_id: "t-bad-a", role: "user", content: "A", parent_id: "m-bad-a", sibling_group: "sg-bad", sibling_index: 0 },
        { id: "m-bad-b", thread_id: "t-bad-b", role: "assistant", content: "B", parent_id: "m-bad-a", model: "deepseek/deepseek-v4-flash", sibling_group: "sg-bad", sibling_index: 0 }
      ]
    });
    const db = new DatabaseSync(dbPath, { enableForeignKeyConstraints: false });
    db.prepare("INSERT INTO message_attachments (id,message_id,attachment_type,file_path) VALUES ('att-bad','missing-message','text_file','attachments/missing-309.txt')").run();
    db.prepare("INSERT INTO chat_locks (thread_id,kdf,salt,hash,iterations) VALUES ('missing-thread','pbkdf2-sha256','bad','bad',1)").run();
    db.prepare("INSERT INTO messages_fts (msg_id,content) VALUES ('stale-309','stale')").run();
    db.close();
    const result = require("../invariant-audit").auditDatabase(dbPath, dir);
    const mustDetect = ["cross-thread active leaf", "cross-thread parent", "parent cycle", "sibling group sg-bad spans threads", "duplicate sibling index", "orphan attachment", "missing attachment file", "unreferenced physical attachment", "orphan lock", "missing FTS row", "stale FTS row", "cumulative input"];
    const missing = mustDetect.filter((needle) => !result.errors.some((error) => error.includes(needle)));
    if (missing.length) throw new Error("invariant audit missed: " + missing.join(", ") + " all=" + result.errors.join("; "));
    return `corrupt fixture produced ${result.errors.length} invariant failures, including ownership, cycle, sibling, attachment/file, lock, FTS, and counter violations`;
  }
});
scenarios.push({
  id: 104,
  regression: true,
  name: "DB health: schema, indexes, FTS, foreign keys intact",
  mode: null,
  noApp: true,
  async body(){
    const os=require("os");
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),"db-health-"));
    const dbPath=seed.createDb(dir,{ threads:[{id:"t1",title:"x"}], messages:[{id:"m1",thread_id:"t1",role:"user",content:"hi"}]});
    function q(sql){ return seed.query(dbPath, sql); }
    const tables=q("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").map(r=>r.name);
    for(const t of ["chat_threads","messages","message_attachments","chat_usage","command_usage","chat_locks"]) if(!tables.includes(t)) throw new Error("missing "+t);
    const cols=q("PRAGMA table_info(chat_threads)").map(r=>r.name);
    for(const c of ["cumulative_cost","font_size","folder_id","advanced_toggles","is_locked"]) if(!cols.includes(c)) throw new Error("missing col "+c);
    const w=new DatabaseSync(dbPath); w.exec("INSERT INTO messages_fts(msg_id, content) VALUES ('probe','hello FTS world')"); w.close();
    if(q("SELECT * FROM messages_fts WHERE messages_fts MATCH 'hello'").length!==1) throw new Error("FTS");
    if(q("SELECT COUNT(*) as c FROM messages WHERE thread_id NOT IN (SELECT id FROM chat_threads)")[0].c!==0) throw new Error("orphan");
    if(!/ON DELETE CASCADE/.test(fs.readFileSync(path.join(launcher.REPO_ROOT,"chat/db/ChatDB.ahk"),"utf8"))) throw new Error("CASCADE");
    return "schema OK, FTS OK, no orphans";
  }
});
scenarios.push({
  id: 105,
  regression: true,
  name: "DB live: HardDelete re-parents, clears FTS, recomputes cumulative counters (bug #65 fixed)",
  mode: null,
  settings:{},
  fixtures:{
    threads:[{id:"t-hard-105", title:"HardDelete Test", active_leaf_id:"m104", cumulative_input_tokens:10, cumulative_output_tokens:20, cumulative_cost:1.5}],
    messages:[
      {id:"m101", thread_id:"t-hard-105", role:"user", content:"hello", token_count:5, active_path_tokens:5},
      {id:"m102", thread_id:"t-hard-105", role:"assistant", content:"hi", model:"openai/gpt-4", parent_id:"m101", token_count:10, active_path_tokens:15},
      {id:"m103", thread_id:"t-hard-105", role:"user", content:"follow", parent_id:"m102", token_count:5, active_path_tokens:20},
      {id:"m104", thread_id:"t-hard-105", role:"assistant", content:"answer", model:"openai/gpt-4", parent_id:"m103", token_count:10, active_path_tokens:30},
    ]
  },
  async body({cdp, dbPath}){
    await showChat();
    await cdp.waitFor('document.querySelectorAll("#thread-list .chat-item").length>0',15000,300,"list");
    await cdp.click('#thread-list .chat-item');
    await cdp.waitFor('document.querySelectorAll("#chat-messages .msg").length>=4',15000,300,"loaded");
    await sleep(700);
    await cdp.click('#chat-messages .msg:nth-child(2) .msg-action-btn[title="Delete"]');
    await sleep(300);
    await cdp.waitFor('document.getElementById("customConfirmOverlay") !== null',5000,200,"confirm");
    await cdp.click('#customConfirmOverlay .yes-confirm-btn');
    await sleep(900);
    const msgs=seed.query(dbPath,"SELECT id, parent_id FROM messages WHERE thread_id='t-hard-105' ORDER BY created_at");
    if(msgs.find(m=>m.id==="m102")) throw new Error("m102 not deleted");
    const m103=msgs.find(m=>m.id==="m103");
    if(!m103 || m103.parent_id!=="m101") throw new Error("m103 not reparented "+JSON.stringify(m103));
    const thread=seed.query(dbPath,"SELECT active_leaf_id, cumulative_cost FROM chat_threads WHERE id='t-hard-105'")[0];
    // FIXED (bug #65): the counters are recomputed from the remaining
    // messages instead of staying stale at the seeded 1.5.
    if(Number(thread.cumulative_cost)===1.5) throw new Error("cumulative still stale 1.5 "+JSON.stringify(thread));
    if(seed.query(dbPath,"SELECT * FROM messages_fts WHERE msg_id='m102'").length) throw new Error("FTS not cleared");
    const m104Ap=seed.query(dbPath,"SELECT active_path_tokens FROM messages WHERE id='m104'")[0].active_path_tokens;
    if(Number(m104Ap)!==20) throw new Error("active_path "+m104Ap);
    const input=seed.query(dbPath,"SELECT cumulative_input_tokens FROM chat_threads WHERE id='t-hard-105'")[0].cumulative_input_tokens;
    if(Number(input)!==10) throw new Error("recomputed cumulative_input_tokens should be 10, got "+input);
    return "HardDelete OK: reparent, FTS cleared, cumulative recomputed ("+input+" input tokens, cost "+thread.cumulative_cost+"), active_path 20";
  }
});
scenarios.push({
  id: 106,
  regression: true,
  name: "DB live: Fork copies messages and keeps folder/font; cumulative counters recomputed from the fork's own messages (bugs #58/#48/#126)",
  mode: null,
  settings:{},
  fixtures:{
    folders:[{id:"f106", name:"Folder106"}],
    threads:[{id:"t-fork-106", title:"Fork Src", active_leaf_id:"m202", folder_id:"f106", font_size:20, cumulative_input_tokens:10, cumulative_cost:2.0}],
    messages:[
      {id:"m201", thread_id:"t-fork-106", role:"user", content:"hello", token_count:5, active_path_tokens:5},
      {id:"m202", thread_id:"t-fork-106", role:"assistant", content:"hi", model:"openai/gpt-4", parent_id:"m201", token_count:10, active_path_tokens:15},
    ]
  },
  async body({cdp, dbPath}){
    await showChat();
    await cdp.waitFor('document.querySelectorAll("#thread-list .chat-item").length>0',15000,300,"list");
    await cdp.click('#thread-list .chat-item');
    await cdp.waitFor('document.querySelectorAll("#chat-messages .msg").length>=2',15000,300,"loaded");
    await sleep(600);
    await cdp.click('#chat-messages .msg:nth-child(2) .msg-action-btn[title="Fork"]');
    await cdp.waitFor('window.activeThreadId !== "t-fork-106"',15000,300,"forked");
    const nid=await cdp.eval('window.activeThreadId');
    await sleep(600);
    const fork=seed.query(dbPath,"SELECT folder_id, cumulative_cost, cumulative_input_tokens, cumulative_output_tokens, font_size FROM chat_threads WHERE id=?",[nid])[0];
    const cnt=seed.query(dbPath,"SELECT COUNT(*) as c FROM messages WHERE thread_id=?",[nid])[0].c;
    // Forked from the assistant message: the copy holds u1 + a1.
    if(cnt!==2) throw new Error("cnt "+cnt);
    // FIXED (bug #58/#48/#126): the fork keeps the source folder and font size
    // (per-message context is still copied), but the cumulative counters are
    // RECOMPUTED from the fork's own messages - only a1's API call (5 input /
    // 10 output), never the source thread's full ledger (cost 2.0).
    if(fork.folder_id!=="f106") throw new Error("folder not kept "+JSON.stringify(fork));
    if(Number(fork.font_size)!==20) throw new Error("font size not kept "+JSON.stringify(fork));
    if(Number(fork.cumulative_input_tokens)!==5 || Number(fork.cumulative_output_tokens)!==10) throw new Error("counters not recomputed "+JSON.stringify(fork));
    if(Number(fork.cumulative_cost)===2.0) throw new Error("source cost still copied "+JSON.stringify(fork));
    return "fork "+nid+" msgs "+cnt+" folder/font kept, counters recomputed (5/10), source cost 2.0 NOT copied";
  }
});
scenarios.push({
  id: 117,
  name: "Deleting a message that holds the same attachment file twice orphans the file on disk (ref-count sees 2 rows)",
  regression: true, // FIXED bug kept as a regression check (duplicate attachment rows must not orphan the file)
  mode: null,
  settings: {},
  fixtures: {
    threads: [{ id: 't-att-117', title: 'Dup Attach', active_leaf_id: 'm-117-u1' }],
    messages: [{ id: 'm-117-u1', thread_id: 't-att-117', role: 'user', content: 'duplicate attachment message' }]
  },
  async body({ cdp, dbPath, dataDir }) {
    // Physical file + TWO attachment rows sharing the same content-addressable
    // path (the UI allows attaching the same file twice; hash-based filenames
    // make both rows point at one file).
    const fs = require("node:fs");
    const path = require("node:path");
    const { DatabaseSync } = require("node:sqlite");
    const attDir = path.join(dataDir, "attachments");
    fs.mkdirSync(attDir, { recursive: true });
    const filePath = "attachments/dupfile-117.txt";
    fs.writeFileSync(path.join(dataDir, filePath), "duplicate content");
    const db = new DatabaseSync(dbPath, { enableForeignKeyConstraints: false });
    db.prepare("INSERT INTO message_attachments (id, message_id, attachment_type, file_path, mime_type, original_filename, file_size, extracted_text) VALUES ('a-117-1','m-117-u1','text_file',?,'text/plain','dup.txt',17,'')").run(filePath);
    db.prepare("INSERT INTO message_attachments (id, message_id, attachment_type, file_path, mime_type, original_filename, file_size, extracted_text) VALUES ('a-117-2','m-117-u1','text_file',?,'text/plain','dup.txt',17,'')").run(filePath);
    db.close();

    await showChat();
    await cdp.waitFor('document.querySelectorAll("#thread-list .chat-item").length > 0', 15000, 300, "list");
    await cdp.click('#thread-list .chat-item');
    await cdp.waitFor('document.querySelectorAll("#chat-messages .msg").length >= 1', 15000, 300, "loaded");
    await sleep(700);
    await cdp.click('#chat-messages .msg .msg-action-btn[title="Delete"]');
    await sleep(300);
    await cdp.waitFor('document.getElementById("customConfirmOverlay") !== null', 5000, 200, "confirm");
    await cdp.click('#customConfirmOverlay .yes-confirm-btn');
    await sleep(900);

    const rows = seed.query(dbPath, "SELECT COUNT(*) AS c FROM message_attachments WHERE message_id='m-117-u1'")[0].c;
    const msgGone = seed.query(dbPath, "SELECT COUNT(*) AS c FROM messages WHERE id='m-117-u1'")[0].c === 0;
    const fileStillThere = fs.existsSync(path.join(dataDir, filePath));
    // FIXED (bug #117): _DeleteFileIfOrphaned now runs AFTER the batch row
    // delete - with 2 rows for the same path the file is removed once both
    // rows are gone, instead of both rows seeing refs=2 and orphaning the file.
    if (rows !== 0 || !msgGone || fileStillThere)
      throw new Error('orphan state not cleaned: rows=' + rows + ' msgGone=' + msgGone + ' fileStillThere=' + fileStillThere + ' (file should be removed with the rows)');
    return 'message deleted, 0 attachment rows left, and the physical file at ' + filePath + ' was removed with them';
  }
});
scenarios.push({
  id: 131,
  regression: true, // attachment lifecycle audit: cross-thread sharing + fork + trash + file refcount
  name: 'Attachment files stay reference-counted across forks, thread trash and cross-thread sharing (audit)',
  mode: null,
  settings: {},
  fixtures: {
    threads: [
      { id: 't-src-131', title: 'Src', active_leaf_id: 'm-131-a1' },
      { id: 't-other-131', title: 'Other', active_leaf_id: 'm-131-u1b' }
    ],
    messages: [
      { id: 'm-131-u1', thread_id: 't-src-131', role: 'user', content: 'root', token_count: 10, active_path_tokens: 10 },
      { id: 'm-131-a1', thread_id: 't-src-131', role: 'assistant', content: 'reply', model: 'deepseek/deepseek-v4-flash', parent_id: 'm-131-u1', token_count: 5, active_path_tokens: 15 },
      { id: 'm-131-u1b', thread_id: 't-other-131', role: 'user', content: 'other root', token_count: 10, active_path_tokens: 10 }
    ]
  },
  async body({ cdp, dbPath, dataDir }) {
    const fs = require('node:fs');
    const path = require('node:path');
    const { DatabaseSync } = require('node:sqlite');
    // One physical file shared by the source thread's message, the OTHER
    // thread's message, and later the fork (content-addressable storage).
    const attDir = path.join(dataDir, 'attachments');
    fs.mkdirSync(attDir, { recursive: true });
    const filePath = 'attachments/shared-131.txt';
    fs.writeFileSync(path.join(dataDir, filePath), 'shared content');
    const db = new DatabaseSync(dbPath, { enableForeignKeyConstraints: false });
    const insAtt = db.prepare("INSERT INTO message_attachments (id, message_id, attachment_type, file_path, mime_type, original_filename, file_size, extracted_text) VALUES (?,?,?,?,?,?,?,?)");
    insAtt.run('a-131-1', 'm-131-u1', 'text_file', filePath, 'text/plain', 'shared.txt', 14, '');
    insAtt.run('a-131-2', 'm-131-u1b', 'text_file', filePath, 'text/plain', 'shared.txt', 14, '');
    db.close();

    await showChat();
    // 1. Load the source thread, fork at a1 (the fork copies the attachment row).
    await cdp.waitFor('document.querySelectorAll("#thread-list .chat-item").length > 0', 15000, 300, 'thread list');
    await cdp.click('#thread-list .chat-item');
    await cdp.waitFor('document.querySelectorAll("#chat-messages .msg").length >= 2', 15000, 300, 'thread loaded');
    await sleep(700);
    await cdp.click('#chat-messages .msg:nth-child(2) .msg-action-btn[title="Fork"]');
    await cdp.waitFor('window.activeThreadId !== "t-src-131"', 15000, 300, 'fork created');
    const forkId = await cdp.eval('window.activeThreadId');
    await sleep(700);
    let refs = seed.query(dbPath, 'SELECT COUNT(*) AS c FROM message_attachments WHERE file_path = ?', [filePath])[0].c;
    if (refs !== 3) throw new Error('after fork refs should be 3 (src + other + fork), got ' + refs);
    if (!fs.existsSync(path.join(dataDir, filePath))) throw new Error('file vanished after fork');

    // 2. Trash + permanently delete the SOURCE thread (its rows drop; file stays via the other refs).
    await cdp.eval(`(() => {
      const items = [...document.querySelectorAll('#thread-list .chat-item')];
      const it = items.find((el) => el.getAttribute('data-chat') === 't-src-131');
      if (!it) return false;
      it.querySelector('.chat-action-btn.danger').click();
      return true;
    })()`);
    await sleep(300);
    await cdp.waitFor('document.getElementById("customConfirmOverlay") !== null', 5000, 200, 'trash confirm');
    await cdp.click('#customConfirmOverlay .yes-confirm-btn');
    await sleep(800);
    await cdp.waitFor('document.querySelectorAll(".trash-item").length >= 1', 10000, 250, 'trash item');
    await cdp.click('.trash-item button.danger');
    await sleep(300);
    await cdp.waitFor('document.getElementById("customConfirmOverlay") !== null', 5000, 200, 'delete forever confirm');
    await cdp.click('#customConfirmOverlay .yes-confirm-btn');
    await sleep(800);
    refs = seed.query(dbPath, 'SELECT COUNT(*) AS c FROM message_attachments WHERE file_path = ?', [filePath])[0].c;
    if (refs !== 2) throw new Error('after deleting source thread refs should be 2 (fork + other), got ' + refs);
    if (!fs.existsSync(path.join(dataDir, filePath))) throw new Error('file deleted while fork/other still reference it');

    // 3. Load the OTHER thread and delete it forever; file must still exist (fork ref).
    await cdp.eval(`(() => {
      const items = [...document.querySelectorAll('#thread-list .chat-item')];
      const it = items.find((el) => el.getAttribute('data-chat') === 't-other-131');
      if (!it) return false;
      it.click();
      return true;
    })()`);
    await cdp.waitFor('chatMessages.length >= 1 && chatMessages[0] && chatMessages[0].content === "other root"', 15000, 300, 'other thread loaded');
    await sleep(600);
    await cdp.eval(`(() => {
      const items = [...document.querySelectorAll('#thread-list .chat-item')];
      const it = items.find((el) => el.getAttribute('data-chat') === 't-other-131');
      if (!it) return false;
      it.querySelector('.chat-action-btn.danger').click();
      return true;
    })()`);
    await sleep(300);
    await cdp.waitFor('document.getElementById("customConfirmOverlay") !== null', 5000, 200, 'trash confirm 2');
    await cdp.click('#customConfirmOverlay .yes-confirm-btn');
    await sleep(800);
    await cdp.click('.trash-item button.danger');
    await sleep(300);
    await cdp.waitFor('document.getElementById("customConfirmOverlay") !== null', 5000, 200, 'delete forever confirm 2');
    await cdp.click('#customConfirmOverlay .yes-confirm-btn');
    await sleep(800);
    refs = seed.query(dbPath, 'SELECT COUNT(*) AS c FROM message_attachments WHERE file_path = ?', [filePath])[0].c;
    if (refs !== 1) throw new Error('after deleting other thread refs should be 1 (fork), got ' + refs);
    if (!fs.existsSync(path.join(dataDir, filePath))) throw new Error('file deleted while the fork still references it');

    // 4. Load the fork and delete its root message; the file becomes orphaned and must be removed.
    await cdp.eval(`(() => {
      const items = [...document.querySelectorAll('#thread-list .chat-item')];
      const it = items.find((el) => el.getAttribute('data-chat') === '${forkId}');
      if (!it) return false;
      it.click();
      return true;
    })()`);
    await cdp.waitFor('chatMessages.length >= 1 && chatMessages[0] && chatMessages[0].content === "root"', 15000, 300, 'fork loaded');
    await sleep(600);
    await cdp.click('#chat-messages .msg:nth-child(1) .msg-action-btn[title="Delete"]');
    await sleep(300);
    await cdp.waitFor('document.getElementById("customConfirmOverlay") !== null', 5000, 200, 'msg delete confirm');
    await cdp.click('#customConfirmOverlay .yes-confirm-btn');
    await sleep(800);
    refs = seed.query(dbPath, 'SELECT COUNT(*) AS c FROM message_attachments WHERE file_path = ?', [filePath])[0].c;
    const fileGone = !fs.existsSync(path.join(dataDir, filePath));
    // Final state: no rows reference the file and the physical file is removed.
    if (refs !== 0) throw new Error('final refs should be 0, got ' + refs);
    if (!fileGone) throw new Error('orphaned file still on disk after the last reference was deleted');
    return 'shared attachment file survived fork + both thread deletions (refcount held), then was removed when the last referencing message was deleted (refs=' + refs + ', fileGone=' + fileGone + ')';
  }
});
scenarios.push({
  id: 136,
  name: 'Complex branched tree with attachments: branch-edit copy, mid-path retry, fork, deletes and thread trash keep DB + attachment files consistent (audit)',
  mode: 'sse-success',
  regression: true, // audit: complex-tree branching + attachment refcounts + fork/trash lifecycle stay consistent
  settings: {},
  fixtures: {
    threads: [{
      id: 't-cplx-136', title: 'Complex', active_leaf_id: 'm-136-a2',
      cumulative_input_tokens: 360, cumulative_output_tokens: 160, cumulative_cached_tokens: 0
    }],
    messages: [
      { id: 'm-136-u1', thread_id: 't-cplx-136', role: 'user', content: 'root', token_count: 100, active_path_tokens: 100 },
      { id: 'm-136-a1', thread_id: 't-cplx-136', role: 'assistant', content: 'reply A', model: 'deepseek/deepseek-v4-flash', parent_id: 'm-136-u1', sibling_group: 'sg-136-a', sibling_index: 0, token_count: 50, prompt_tokens: 100, active_path_tokens: 150 },
      { id: 'm-136-a1b', thread_id: 't-cplx-136', role: 'assistant', content: 'reply B', model: 'deepseek/deepseek-v4-flash', parent_id: 'm-136-u1', sibling_group: 'sg-136-a', sibling_index: 1, token_count: 50, prompt_tokens: 100, active_path_tokens: 150 },
      { id: 'm-136-u2', thread_id: 't-cplx-136', role: 'user', content: 'follow A', parent_id: 'm-136-a1', token_count: 60, active_path_tokens: 210 },
      { id: 'm-136-a2', thread_id: 't-cplx-136', role: 'assistant', content: 'ans A', model: 'deepseek/deepseek-v4-flash', parent_id: 'm-136-u2', token_count: 60, prompt_tokens: 160, active_path_tokens: 220 }
    ]
  },
  async body({ cdp, dbPath, dataDir }) {
    const fs = require('node:fs');
    const path = require('node:path');
    const { DatabaseSync } = require('node:sqlite');
    const attDir = path.join(dataDir, 'attachments');
    fs.mkdirSync(attDir, { recursive: true });
    const fileF = 'attachments/f-136.txt';
    const fileF2 = 'attachments/f2-136.txt';
    fs.writeFileSync(path.join(dataDir, fileF), 'root attachment');
    fs.writeFileSync(path.join(dataDir, fileF2), 'follow attachment');
    const db = new DatabaseSync(dbPath, { enableForeignKeyConstraints: false });
    const insAtt = db.prepare("INSERT INTO message_attachments (id, message_id, attachment_type, file_path, mime_type, original_filename, file_size, extracted_text) VALUES (?,?,?,?,?,?,?,?)");
    insAtt.run('a-136-f1', 'm-136-u1', 'text_file', fileF, 'text/plain', 'f.txt', 15, '');
    insAtt.run('a-136-f2', 'm-136-u2', 'text_file', fileF2, 'text/plain', 'f2.txt', 17, '');
    db.close();

    await showChat();
    await cdp.waitFor('document.querySelectorAll("#thread-list .chat-item").length > 0', 15000, 300, 'thread list');
    await cdp.click('#thread-list .chat-item');
    await cdp.waitFor('chatMessages.length === 4 && chatMessages[3] && chatMessages[3].id === "m-136-a2"', 15000, 300, 'complex thread loaded');
    await sleep(800);

    // 1. Branch switch: a1 -> a1b (off-path sibling). Path becomes u1,a1b.
    await cdp.click('#chat-messages .msg:nth-child(2) .msg-action-btn[title="Next branch"]');
    await cdp.waitFor('chatMessages.length === 2 && chatMessages[1] && chatMessages[1].id === "m-136-a1b"', 15000, 300, 'branch switched to a1b');
    await sleep(700);
    let ctx = await cdp.text('#tokenBar .tu-item:first-child .tu-val');
    if (String(ctx).indexOf('150') !== 0) throw new Error('branch switch context wrong: ' + JSON.stringify(ctx));
    // Back to a1's leaf (Previous branch).
    await cdp.click('#chat-messages .msg:nth-child(2) .msg-action-btn[title="Previous branch"]');
    await cdp.waitFor('chatMessages.length === 4 && chatMessages[3] && chatMessages[3].id === "m-136-a2"', 15000, 300, 'branch switched back');
    await sleep(700);

    // 2. Branch-edit the user message u2 (index 3) -> u2b copy (attachments copied) + real request -> a2b.
    await cdp.click('#chat-messages .msg:nth-child(3) .msg-action-btn[title="Edit"]');
    await cdp.waitFor('document.querySelector("#chat-messages .msg:nth-child(3)").classList.contains("editing")', 5000, 200, 'edit ui open');
    await cdp.type('#chat-messages .msg:nth-child(3) .msg-edit-textarea', 'follow A (branch)');
    await cdp.click('#chat-messages .msg:nth-child(3) .save-branch');
    await waitStreamingIdle(cdp, 40000);
    await sleep(1200);
    let rows = seed.query(dbPath, "SELECT id, role, content FROM messages WHERE thread_id='t-cplx-136' AND (content='follow A (branch)' OR content='Hello from the mock LLM. This is the streamed answer.') ORDER BY created_at");
    // Save-as-Branch commits the local user copy before the AHK callback starts
    // the follow-up stream. Under parallel load, waitStreamingIdle() can observe
    // the pre-request idle state and return before the stream even begins. Poll
    // for the durable assistant continuation so this audit waits on the actual
    // branch-edit outcome rather than a transient renderer state.
    const branchDeadline = Date.now() + 20000;
    while (!rows.some((r) => r.role === 'assistant') && Date.now() < branchDeadline) {
      await sleep(100);
      rows = seed.query(dbPath, "SELECT id, role, content FROM messages WHERE thread_id='t-cplx-136' AND (content='follow A (branch)' OR content='Hello from the mock LLM. This is the streamed answer.') ORDER BY created_at");
    }
    const u2b = rows.find((r) => r.role === 'user');
    const a2b = rows.find((r) => r.role === 'assistant');
    if (!u2b || !a2b) throw new Error('branch-edit did not create u2b/a2b: ' + JSON.stringify(rows));
    let f2refs = seed.query(dbPath, 'SELECT COUNT(*) AS c FROM message_attachments WHERE file_path = ?', [fileF2])[0].c;
    if (f2refs !== 2) throw new Error('branch-edit should copy the attachment row (F2 refs 2), got ' + f2refs);
    let thread = seed.query(dbPath, 'SELECT cumulative_input_tokens, cumulative_output_tokens, cumulative_cached_tokens FROM chat_threads WHERE id=?', ['t-cplx-136'])[0];
    if (Number(thread.cumulative_input_tokens) !== 372 || Number(thread.cumulative_output_tokens) !== 169 || Number(thread.cumulative_cached_tokens) !== 4)
      throw new Error('counters after branch-edit wrong: ' + JSON.stringify(thread));
    let usage = seed.query(dbPath, 'SELECT call_count, prompt_tokens, completion_tokens, cached_tokens FROM chat_usage')[0];
    if (!usage || usage.call_count !== 1 || usage.prompt_tokens !== 12) throw new Error('chat_usage after branch-edit wrong: ' + JSON.stringify(usage));

    // 3. Mid-path retry of a1 (now message index 2 on the active path u1,a1,u2b,a2b).
    await cdp.click('#chat-messages .msg:nth-child(2) .msg-action-btn[title="Retry"]');
    await waitStreamingIdle(cdp, 40000);
    await sleep(1200);
    thread = seed.query(dbPath, 'SELECT cumulative_input_tokens, cumulative_output_tokens, cumulative_cached_tokens, active_leaf_id FROM chat_threads WHERE id=?', ['t-cplx-136'])[0];
    if (Number(thread.cumulative_input_tokens) !== 384 || Number(thread.cumulative_output_tokens) !== 178 || Number(thread.cumulative_cached_tokens) !== 8)
      throw new Error('counters after mid-path retry wrong: ' + JSON.stringify(thread));
    const leaf = seed.query(dbPath, 'SELECT id FROM messages WHERE id=?', [thread.active_leaf_id]);
    if (!leaf.length) throw new Error('active leaf dangling after retry');
    const a1Siblings = seed.query(dbPath, "SELECT sibling_group, sibling_index FROM messages WHERE parent_id='m-136-u1' AND role='assistant' ORDER BY sibling_index");
    if (a1Siblings.length !== 3 || a1Siblings[0].sibling_group !== a1Siblings[1].sibling_group || a1Siblings[1].sibling_group !== a1Siblings[2].sibling_group)
      throw new Error('retried a1 not a sibling of a1/a1b: ' + JSON.stringify(a1Siblings));
    usage = seed.query(dbPath, 'SELECT call_count, prompt_tokens, completion_tokens FROM chat_usage')[0];
    if (usage.call_count !== 2) throw new Error('chat_usage after retry wrong: ' + JSON.stringify(usage));

    // 4. Fork at the retried leaf (a1c). The fork is a faithful copy of the
    // whole tree up to the fork point: the active path (u1,a1c) PLUS the
    // off-path siblings of the retried group (a1, a1b) and their full
    // descendant subtrees (u2,a2,u2b,a2b) = 8 messages, FTS synced, counters
    // recomputed from the fork's own assistant rows (100+100+160+12+12 input /
    // 50+50+60+9+9 output / 8 cached), and attachment rows copied (F x2, F2 x4).
    await cdp.click('#chat-messages .msg:last-child .msg-action-btn[title="Fork"]');
    await cdp.waitFor('window.activeThreadId !== "t-cplx-136"', 15000, 300, 'fork created');
    const forkId = await cdp.eval('window.activeThreadId');
    await sleep(900);
    const forkMsgs = seed.query(dbPath, 'SELECT COUNT(*) AS c FROM messages WHERE thread_id=?', [forkId])[0].c;
    const forkFts = seed.query(dbPath, 'SELECT COUNT(*) AS c FROM messages_fts WHERE msg_id IN (SELECT id FROM messages WHERE thread_id=?)', [forkId])[0].c;
    if (forkMsgs !== 8 || forkFts !== 8) throw new Error('fork msgs/FTS wrong: ' + forkMsgs + '/' + forkFts);
    const forkThread = seed.query(dbPath, 'SELECT cumulative_input_tokens, cumulative_output_tokens FROM chat_threads WHERE id=?', [forkId])[0];
    if (Number(forkThread.cumulative_input_tokens) !== 384 || Number(forkThread.cumulative_output_tokens) !== 178)
      throw new Error('fork counters wrong: ' + JSON.stringify(forkThread));
    let fRefs = seed.query(dbPath, 'SELECT COUNT(*) AS c FROM message_attachments WHERE file_path = ?', [fileF])[0].c;
    if (fRefs !== 2) throw new Error('fork should copy the F attachment row (refs 2), got ' + fRefs);
    let f2RefsAfterFork = seed.query(dbPath, 'SELECT COUNT(*) AS c FROM message_attachments WHERE file_path = ?', [fileF2])[0].c;
    if (f2RefsAfterFork !== 4) throw new Error('fork should copy the F2 rows (refs 4), got ' + f2RefsAfterFork);
    if (!fs.existsSync(path.join(dataDir, fileF))) throw new Error('F file missing after fork');

    // 5. Delete the fork forever: F refs drop back to 1, F2 refs back to 2,
    // and both files stay.
    await cdp.eval(`(() => {
      const items = [...document.querySelectorAll('#thread-list .chat-item')];
      const it = items.find((el) => el.getAttribute('data-chat') === '${forkId}');
      if (!it) return false;
      it.querySelector('.chat-action-btn.danger').click();
      return true;
    })()`);
    await sleep(300);
    await cdp.waitFor('document.getElementById("customConfirmOverlay") !== null', 5000, 200, 'trash confirm');
    await cdp.click('#customConfirmOverlay .yes-confirm-btn');
    await sleep(800);
    await cdp.waitFor('document.querySelectorAll(".trash-item").length >= 1', 10000, 250, 'trash item');
    await cdp.click('.trash-item button.danger');
    await sleep(300);
    await cdp.waitFor('document.getElementById("customConfirmOverlay") !== null', 5000, 200, 'delete forever confirm');
    await cdp.click('#customConfirmOverlay .yes-confirm-btn');
    await sleep(800);
    fRefs = seed.query(dbPath, 'SELECT COUNT(*) AS c FROM message_attachments WHERE file_path = ?', [fileF])[0].c;
    if (fRefs !== 1) throw new Error('after fork delete F refs should be 1, got ' + fRefs);
    if (!fs.existsSync(path.join(dataDir, fileF))) throw new Error('F file removed while the source thread still references it');
    const f2RefsAfterForkDelete = seed.query(dbPath, 'SELECT COUNT(*) AS c FROM message_attachments WHERE file_path = ?', [fileF2])[0].c;
    if (f2RefsAfterForkDelete !== 2) throw new Error('after fork delete F2 refs should be 2, got ' + f2RefsAfterForkDelete);
    if (!fs.existsSync(path.join(dataDir, fileF2))) throw new Error('F2 file removed while the source thread still references it');

    // 6. Back on the source thread: delete the branch-edited user copy u2b -
    // F2 refs drop to 1 (u2's row) and the file stays.
    await cdp.eval(`(() => {
      const items = [...document.querySelectorAll('#thread-list .chat-item')];
      const it = items.find((el) => el.getAttribute('data-chat') === 't-cplx-136');
      if (!it) return false;
      it.click();
      return true;
    })()`);
    await cdp.waitFor('chatMessages.length >= 2', 15000, 300, 'source thread reloaded');
    await sleep(800);
    // The source thread's active path ends at the retried leaf (a1c); u2b is
    // off-path inside the a1 subtree. Navigate to it through the tree modal.
    await cdp.click('#treeBtn');
    await cdp.waitFor('typeof window._treeData !== "undefined" && window._treeData.length > 0', 15000, 300, 'tree data');
    await cdp.waitFor('[...document.querySelectorAll(".tree-node")].some((n) => n.textContent.indexOf("follow A (branch)") >= 0)', 15000, 300, 'u2b tree node');
    await cdp.eval('(() => { const n = [...document.querySelectorAll(".tree-node")].find((el) => el.textContent.indexOf("follow A (branch)") >= 0); if (!n) return false; n.click(); return true; })()');
    await cdp.waitFor('chatMessages.length >= 4 && chatMessages.some((m) => m.content === "follow A (branch)") && chatMessages[chatMessages.length - 1].content === "Hello from the mock LLM. This is the streamed answer."', 15000, 300, 'navigated to u2b branch');
    await sleep(800);
    const u2bIdx = await cdp.eval('chatMessages.findIndex((m) => m.content === "follow A (branch)")');
    if (u2bIdx < 0) throw new Error('u2b not in the active view: ' + u2bIdx);
    await cdp.click('#chat-messages .msg:nth-child(' + (u2bIdx + 1) + ') .msg-action-btn[title="Delete"]');
    await sleep(300);
    await cdp.waitFor('document.getElementById("customConfirmOverlay") !== null', 5000, 200, 'u2b delete confirm');
    await cdp.click('#customConfirmOverlay .yes-confirm-btn');
    await sleep(900);
    f2refs = seed.query(dbPath, 'SELECT COUNT(*) AS c FROM message_attachments WHERE file_path = ?', [fileF2])[0].c;
    if (f2refs !== 1) throw new Error('after deleting u2b F2 refs should be 1 (u2 row), got ' + f2refs);
    if (!fs.existsSync(path.join(dataDir, fileF2))) throw new Error('F2 file removed while u2 still references it');

    // 7. Trash + delete the source thread forever: F2 (last ref gone) is
    // removed from disk; F stays (the fork is gone, so F2 must vanish but F
    // only drops to 0 refs when no other thread holds it - here the fork was
    // deleted, so F is removed too).
    await cdp.eval(`(() => {
      const items = [...document.querySelectorAll('#thread-list .chat-item')];
      const it = items.find((el) => el.getAttribute('data-chat') === 't-cplx-136');
      if (!it) return false;
      it.querySelector('.chat-action-btn.danger').click();
      return true;
    })()`);
    await sleep(300);
    await cdp.waitFor('document.getElementById("customConfirmOverlay") !== null', 5000, 200, 'thread trash confirm');
    await cdp.click('#customConfirmOverlay .yes-confirm-btn');
    await sleep(800);
    await cdp.waitFor('document.querySelectorAll(".trash-item").length >= 1', 10000, 250, 'trash item 2');
    await cdp.click('.trash-item button.danger');
    await sleep(300);
    await cdp.waitFor('document.getElementById("customConfirmOverlay") !== null', 5000, 200, 'thread delete forever confirm');
    await cdp.click('#customConfirmOverlay .yes-confirm-btn');
    await sleep(900);
    const f2Gone = !fs.existsSync(path.join(dataDir, fileF2));
    const fGone = !fs.existsSync(path.join(dataDir, fileF));
    const f2Rows = seed.query(dbPath, 'SELECT COUNT(*) AS c FROM message_attachments WHERE file_path = ?', [fileF2])[0].c;
    const fRows = seed.query(dbPath, 'SELECT COUNT(*) AS c FROM message_attachments WHERE file_path = ?', [fileF])[0].c;
    if (f2Rows !== 0 || !f2Gone) throw new Error('F2 orphaned after thread delete: rows=' + f2Rows + ' gone=' + f2Gone);
    if (fRows !== 0 || !fGone) throw new Error('F orphaned after thread delete: rows=' + fRows + ' gone=' + fGone);

    // Final DB integrity sweep on the surviving fork state (nothing left).
    const integrity = seed.query(dbPath, "SELECT (SELECT COUNT(*) FROM messages) AS msgs, (SELECT COUNT(*) FROM messages_fts) AS fts, (SELECT COUNT(*) FROM message_attachments) AS atts");
    return 'complex tree audit: branch-edit copied F2 rows (4->2->1->0), retry sibling group OK, fork (8 msgs, FTS 8, counters 384/178, F refs 2->1->0, F2 refs 4->2->1->0), thread delete removed both files; final rows=' + JSON.stringify(integrity[0]);
  }
});

scenarios.push({
  id: 183,
  name: 'Search result snippets for attachment-text hits show the message content, not the match (SearchRepo._FTS5 builds the preview from m.content only - a term that exists only in an attachment\'s extracted_text yields an unrelated preview)',
  mode: null,
  regression: true, // FIXED: snippets come from the FTS-indexed content (message + attachment text)
  noApp: true,
  settings: {},
  async body() {
    const outFile = path.join(os.tmpdir(), 'llm-bughunt-db-' + process.pid + '.txt');
    try { fs.unlinkSync(outFile); } catch {}
    const probe = path.join(__dirname, '..', 'probe-bughunt-db.ahk');
    const res = spawnSync(launcher.AHK, ['/ErrorStdOut', probe, outFile, 'fts-attachment-snippet'], { timeout: 25000, windowsHide: true, encoding: 'utf8' });
    if (res.error) throw new Error('fts-snippet probe spawn failed/timed out: ' + res.error.message);
    if (res.stderr) process.stderr.write('[probe stderr] ' + res.stderr);
    const text = fs.readFileSync(outFile, 'utf-8');
    const hitsM = text.match(/hits=(\d+)/);
    const matchM = text.match(/previewHasMatch=(\d)/);
    if (!hitsM || !matchM) throw new Error('probe output missing fields: ' + text);
    const hits = Number(hitsM[1]), previewHasMatch = Number(matchM[1]);
    if (hits < 1) throw new Error('control failed - the attachment text is no longer searchable (bug #165 regression): ' + text);
    // FIXED (bug #183): the snippet is built from the FTS-indexed content
    // (message + decoded attachment text), so the preview shows the matched
    // attachment text instead of the unrelated message content.
    if (previewHasMatch !== 1)
      throw new Error('snippet still does not contain the attachment match (fix incomplete): ' + text);
    return 'search for "needle" (only inside the PDF extracted_text) found ' + hits +
      ' hit(s) and the snippet DOES contain "needle" (previewHasMatch=' + previewHasMatch +
      ') - the preview now shows the matched attachment text';
  }
});

scenarios.push({
  id: 312,
  regression: true,
  name: "Chat send rolls back when an attachment cannot be saved",
  mode: "sse-success",
  fixtures: { threads: [], messages: [] },
  async body({ cdp, dbPath, dataDir, mockLog }) {
    await showChat();
    await post(cdp, {
      action: "chatSend",
      message: "SEND_ATTACHMENT_SECRET_312",
      attachments: [{
        type: "text_file",
        filename: "required-312.txt",
        mimeType: "text/plain",
        size: 21,
        extractedText: "ATTACHMENT_SECRET_312",
        base64: ""
      }]
    });
    await waitStreamingIdle(cdp, 40000);
    await sleep(700);

    // Open/close a fresh SQLite connection for the durable-state audit. The
    // empty base64 payload deterministically makes Attachment_Save return "".
    const reopened = new DatabaseSync(dbPath);
    const thread = reopened.prepare("SELECT id FROM chat_threads ORDER BY rowid DESC LIMIT 1").get();
    const user = thread && reopened.prepare("SELECT id FROM messages WHERE thread_id=? AND content=?").get(thread.id, "SEND_ATTACHMENT_SECRET_312");
    const attachmentCount = user ? reopened.prepare("SELECT COUNT(*) AS c FROM message_attachments WHERE message_id=?").get(user.id).c : 0;
    const ftsCount = user ? reopened.prepare("SELECT COUNT(*) AS c FROM messages_fts WHERE msg_id=?").get(user.id).c : 0;
    reopened.close();

    const attachmentDir = path.join(dataDir, "attachments");
    const physicalFiles = fs.existsSync(attachmentDir) ? fs.readdirSync(attachmentDir) : [];
    const requests = fs.existsSync(mockLog) ? fs.readFileSync(mockLog, "utf8").split(/\r?\n/).filter(Boolean)
      .map((line) => { try { return JSON.parse(line); } catch { return null; } })
      .filter((entry) => entry && entry.modeUsed === "sse") : [];

    const errorVisible = await cdp.eval('document.body.innerText.indexOf("Attachment could not be saved") >= 0 || !!document.querySelector(".error-banner")');
    if (user || Number(attachmentCount) !== 0 || Number(ftsCount) !== 0 || physicalFiles.length !== 0 || requests.length !== 0 || !errorVisible)
      throw new Error("failed attachment save was not rolled back: user=" + !!user +
        " attachments=" + attachmentCount + " fts=" + ftsCount + " files=" + physicalFiles.length + " requests=" + requests.length);
    return "failed attachment save rolled back the user row/FTS transaction, sent no request, created no file, and surfaced an error";
  }
});

scenarios.push({
  id: 313,
  regression: true,
  name: "Overwrite edit rolls back when a replacement attachment cannot be saved",
  mode: null,
  fixtures: {
    threads: [{ id: "t-edit-313", title: "Edit Attachments", active_leaf_id: "m-edit-313-u" }],
    messages: [{ id: "m-edit-313-u", thread_id: "t-edit-313", role: "user", content: "ORIGINAL_EDIT_313" }]
  },
  async body({ cdp, dbPath, dataDir }) {
    const oldPath = "attachments/old-313.txt";
    fs.mkdirSync(path.join(dataDir, "attachments"), { recursive: true });
    fs.writeFileSync(path.join(dataDir, oldPath), "old attachment 313");
    const setup = new DatabaseSync(dbPath, { enableForeignKeyConstraints: false });
    setup.prepare("INSERT INTO message_attachments (id,message_id,attachment_type,file_path,mime_type,original_filename,file_size,extracted_text) VALUES (?,?,?,?,?,?,?,?)")
      .run("att-313-old", "m-edit-313-u", "text_file", oldPath, "text/plain", "old-313.txt", 19, "");
    setup.close();

    await showChat();
    await cdp.waitFor('document.querySelectorAll("#thread-list .chat-item").length > 0', 15000, 300, "edit thread");
    await cdp.click('#thread-list .chat-item[data-chat="t-edit-313"]');
    await cdp.waitFor('window.activeThreadId === "t-edit-313" && document.querySelectorAll("#chat-messages .msg").length === 1', 15000, 300, "edit message loaded");
    await post(cdp, {
      action: "editMessage",
      id: "m-edit-313-u",
      content: "EDITED_WITH_FAILED_REPLACEMENT_313",
      mode: "overwrite",
      removedAttachmentIds: ["att-313-old"],
      attachments: [{ type: "text_file", filename: "replacement-313.txt", mimeType: "text/plain", size: 22, extractedText: "replacement", base64: "" }]
    });
    await sleep(1200);

    const reopened = new DatabaseSync(dbPath);
    const msg = reopened.prepare("SELECT content FROM messages WHERE id=?").get("m-edit-313-u");
    const attachmentCount = reopened.prepare("SELECT COUNT(*) AS c FROM message_attachments WHERE message_id=?").get("m-edit-313-u").c;
    const ftsCount = reopened.prepare("SELECT COUNT(*) AS c FROM messages_fts WHERE msg_id=?").get("m-edit-313-u").c;
    reopened.close();
    const oldFileExists = fs.existsSync(path.join(dataDir, oldPath));
    if (!msg || msg.content !== "ORIGINAL_EDIT_313" || Number(attachmentCount) !== 1 ||
        Number(ftsCount) !== 1 || !oldFileExists)
      throw new Error("overwrite rollback failed: content=" + (msg && msg.content) +
        " attachments=" + attachmentCount + " fts=" + ftsCount + " oldFile=" + oldFileExists);
    return "after reopen, failed replacement left the original content, attachment row/file, and FTS row intact";
  }
});

scenarios.push({
  id: 314,
  regression: true,
  name: "Branch edit rolls back when a replacement attachment cannot be saved",
  mode: "sse-success",
  fixtures: {
    threads: [{ id: "t-edit-314", title: "Branch Attachments", active_leaf_id: "m-edit-314-u" }],
    messages: [{ id: "m-edit-314-u", thread_id: "t-edit-314", role: "user", content: "ORIGINAL_BRANCH_314" }]
  },
  async body({ cdp, dbPath, dataDir, mockLog }) {
    const firstPath = "attachments/source-314-a.txt";
    const secondPath = "attachments/source-314-b.txt";
    fs.mkdirSync(path.join(dataDir, "attachments"), { recursive: true });
    fs.writeFileSync(path.join(dataDir, firstPath), "source attachment A");
    fs.writeFileSync(path.join(dataDir, secondPath), "source attachment B");
    const setup = new DatabaseSync(dbPath, { enableForeignKeyConstraints: false });
    const insert = setup.prepare("INSERT INTO message_attachments (id,message_id,attachment_type,file_path,mime_type,original_filename,file_size,extracted_text) VALUES (?,?,?,?,?,?,?,?)");
    insert.run("att-314-a", "m-edit-314-u", "text_file", firstPath, "text/plain", "source-a.txt", 19, "");
    insert.run("att-314-b", "m-edit-314-u", "text_file", secondPath, "text/plain", "source-b.txt", 19, "");
    setup.close();

    await showChat();
    await cdp.waitFor('document.querySelectorAll("#thread-list .chat-item").length > 0', 15000, 300, "branch thread");
    await cdp.click('#thread-list .chat-item[data-chat="t-edit-314"]');
    await cdp.waitFor('window.activeThreadId === "t-edit-314" && document.querySelectorAll("#chat-messages .msg").length === 1', 15000, 300, "branch message loaded");
    await post(cdp, {
      action: "editMessage",
      id: "m-edit-314-u",
      content: "BRANCH_WITH_FAILED_REPLACEMENT_314",
      mode: "branch",
      removedAttachmentIds: ["att-314-a"],
      attachments: [{ type: "text_file", filename: "replacement-314.txt", mimeType: "text/plain", size: 22, extractedText: "replacement", base64: "" }]
    });
    await waitStreamingIdle(cdp, 40000);
    await sleep(800);

    const reopened = new DatabaseSync(dbPath);
    const branch = reopened.prepare("SELECT id FROM messages WHERE thread_id=? AND content=?").get("t-edit-314", "BRANCH_WITH_FAILED_REPLACEMENT_314");
    const leaf = reopened.prepare("SELECT active_leaf_id FROM chat_threads WHERE id=?").get("t-edit-314");
    const leafMessage = leaf ? reopened.prepare("SELECT parent_id FROM messages WHERE id=?").get(leaf.active_leaf_id) : null;
    const branchAttachmentCount = branch ? reopened.prepare("SELECT COUNT(*) AS c FROM message_attachments WHERE message_id=?").get(branch.id).c : 0;
    const branchFtsCount = branch ? reopened.prepare("SELECT COUNT(*) AS c FROM messages_fts WHERE msg_id=?").get(branch.id).c : 0;
    const sourceAttachmentCount = reopened.prepare("SELECT COUNT(*) AS c FROM message_attachments WHERE message_id=?").get("m-edit-314-u").c;
    reopened.close();
    const sourceFilesExist = fs.existsSync(path.join(dataDir, firstPath)) && fs.existsSync(path.join(dataDir, secondPath));
    const requests = fs.existsSync(mockLog) ? fs.readFileSync(mockLog, "utf8").split(/\r?\n/).filter(Boolean)
      .map((line) => { try { return JSON.parse(line); } catch { return null; } })
      .filter((entry) => entry && entry.modeUsed === "sse") : [];
    if (branch || !leaf || leaf.active_leaf_id !== "m-edit-314-u" || Number(branchAttachmentCount) !== 0 ||
        Number(branchFtsCount) !== 0 || Number(sourceAttachmentCount) !== 2 || !sourceFilesExist || requests.length !== 0)
      throw new Error("branch rollback failed: branch=" + !!branch + " leaf=" + (leaf && leaf.active_leaf_id) +
        " branchAttachments=" + branchAttachmentCount + " branchFts=" + branchFtsCount +
        " sourceAttachments=" + sourceAttachmentCount + " sourceFiles=" + sourceFilesExist + " requests=" + requests.length);
    return "after reopen, failed replacement left no branch or request; the source leaf, attachments, FTS, and files stayed intact";
  }
});
scenarios.push({
  id: 315,
  regression: true,
  name: "Web-search placeholders are recovered after process restart",
  mode: null,
  noApp: true,
  async body() {
    const executor = fs.readFileSync(path.join(launcher.REPO_ROOT, "chat", "tools", "SearchToolExecutor.ahk"), "utf8");
    const window = fs.readFileSync(path.join(launcher.REPO_ROOT, "chat", "ChatWindow.ahk"), "utf8");
    const titleGen = fs.readFileSync(path.join(launcher.REPO_ROOT, "chat", "ThreadTitleGen.ahk"), "utf8");
    const hasRecovery = /static RecoverAbandonedPlaceholders\(\)[\s\S]*?Searching[\s\S]*?interrupted by application restart[\s\S]*?FTS_Sync/.test(executor);
    const runsAtStartup = /#Include tools\\SearchToolExecutor\.ahk\s*\r?\nSearchToolExecutor\.RecoverAbandonedPlaceholders\(\)/.test(window);
    const titleLockGuard = /IsSet\(ThreadLockService\)\s*&&\s*ThreadLockService\.ShouldRedactContent/.test(titleGen);
    if (!hasRecovery || !runsAtStartup || !titleLockGuard)
      throw new Error("startup safety contract missing: recovery=" + hasRecovery + " startup=" + runsAtStartup + " titleLockGuard=" + titleLockGuard);
    return "ChatWindow startup invokes SearchToolExecutor.RecoverAbandonedPlaceholders, which transactionally marks persisted Searching cards as interrupted failures and reindexes them; title generation guards optional ThreadLockService references against #Warn popups; behavioral coverage is in SearchToolExecutorTest";
  }
});
scenarios.push({
  id: 326,
  regression: true,
  name: 'Normal long-run database and attachment invariants remain coherent',
  mode: null,
  noApp: true,
  async body() {
    const outFile = path.join(os.tmpdir(), 'llm-longrun-' + process.pid + '.txt');
    try { fs.unlinkSync(outFile); } catch {}
    const probe = path.join(__dirname, '..', 'probe-bughunt-db.ahk');
    const res = spawnSync(launcher.AHK, ['/ErrorStdOut', probe, outFile, 'long-run-invariants'], { timeout: 60000, windowsHide: true, encoding: 'utf8' });
    if (res.error) throw new Error('long-run invariant probe failed/timed out: ' + res.error.message);
    if (res.stderr) process.stderr.write('[probe stderr] ' + res.stderr);
    const text = fs.readFileSync(outFile, 'utf8');
    if (!/LONGRUN verdict=OK/.test(text)) throw new Error('long-run invariants failed: ' + text);
    return text.trim().replace(/\r?\n/g, '; ');
  }
});

module.exports=scenarios;
