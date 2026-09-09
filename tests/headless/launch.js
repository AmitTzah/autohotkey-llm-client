// launch.js — Launch the real app (Main.ahk) in an isolated sandbox and
// expose its WebView2 pages over CDP. Zero dependencies.
'use strict';
const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn, spawnSync } = require('node:child_process');

const AHK = process.env.AHK_EXE || 'C:\\Program Files\\AutoHotkey\\v2\\AutoHotkey64.exe';
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const MAIN_AHK = path.join(REPO_ROOT, 'Main.ahk');
const PROBE_AHK = path.join(__dirname, 'probe.ahk');
const E2E_MAIN_PREFIX = '.ahkllm-e2e-main-';
// Unique WebView2 user-data folder for the current run. The app's WebView2
// defaults to the SHARED machine Edge folder (%LOCALAPPDATA%\Microsoft\Edge\
// User Data), so a leftover browser process from an aborted run holds it and
// the next launch fails with ERROR_BUSY (0x800700AA, "resource in use"). A
// per-run folder removes the collision entirely, and doubles as a safe marker
// for cleanup (only OUR msedgewebview2.exe processes carry it).
let activeWebView2Dir = '';
// Test data roots are passed explicitly through AHKLLM_E2E_DATA_DIR. The
// launcher never moves, renames, junctions or restores the real user profile.

// Synchronous short sleep for teardown retries without spawning child processes.
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function processExists(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e && e.code === 'EPERM';
  }
}

function waitForProcessExit(pid, timeoutMs = 800) {
  const start = Date.now();
  while (processExists(pid) && Date.now() - start < timeoutMs)
    sleepSync(50);
}

// Remove every leftover llm-webview2-* folder (they are all ours, unique per
// run). The browser processes can hold files briefly after taskkill /F, so
// retry until nothing remains or the bounded attempt budget runs out.
function sweepWebView2Dirs(maxAttempts = 8) {
  let total = 0;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    let removed = 0;
    try {
      for (const name of fs.readdirSync(os.tmpdir())) {
        if (!name.startsWith('llm-webview2-')) continue;
        try { fs.rmSync(path.join(os.tmpdir(), name), { recursive: true, force: true }); removed++; } catch {}
      }
    } catch {}
    if (removed === 0) break;
    total += removed;
    sleepSync(100);
  }
  return total;
}

function findFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

function makeSandbox() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'llm-headless-'));
}

function sanitizeWorkerId(workerId) {
  const id = String(workerId || '').replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 80);
  if (!id) throw new Error('worker id is required');
  return id;
}

// Main.ahk is #SingleInstance in production. Parallel E2E workers use unique
// copies in the repo root so A_ScriptDir remains exactly the production root
// while each worker gets its own AutoHotkey script identity.
function createWorkerMain(workerId) {
  const id = sanitizeWorkerId(workerId);
  const target = path.join(REPO_ROOT, E2E_MAIN_PREFIX + id + '.ahk');
  let src = fs.readFileSync(MAIN_AHK, 'utf8');
  if (!/^#SingleInstance\b/m.test(src)) throw new Error('Main.ahk is missing #SingleInstance');
  src = src.replace(/^#SingleInstance\b.*$/m, '#SingleInstance Force\n#NoTrayIcon');
  fs.writeFileSync(target, src, 'utf8');
  return target;
}

// Standalone screenshot/video/cleanup tools use the same explicit worker
// contract as e2e-suite.js. The returned restoreEnv callback affects only the
// current Node process, so a child app sees the marker and private temp roots.
function createWorkerContext(workerId) {
  const id = sanitizeWorkerId(workerId);
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ahkllm-e2e-temp-'));
  const dataDir = path.join(tempRoot, 'data');
  let mainScript;
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    mainScript = createWorkerMain(id);
  } catch (e) {
    rmrf(tempRoot);
    throw e;
  }
  const previous = new Map();
  for (const [key, value] of Object.entries({
    TEMP: tempRoot,
    TMP: tempRoot,
    AHKLLM_E2E_WORKER: id,
    AHKLLM_E2E_DATA_DIR: dataDir
  })) {
    previous.set(key, process.env[key]);
    process.env[key] = value;
  }
  return {
    workerId: id,
    tempRoot,
    dataDir,
    mainScript,
    restoreEnv() {
      for (const [key, value] of previous) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  };
}

function disposeWorkerContext(context) {
  if (!context) return true;
  context.restoreEnv();
  removeWorkerMain(context.mainScript);
  return rmrf(context.tempRoot) && !fs.existsSync(context.tempRoot);
}

function removeWorkerMain(mainScript) {
  if (!mainScript) return;
  const resolved = path.resolve(mainScript);
  if (path.dirname(resolved) !== REPO_ROOT || !path.basename(resolved).startsWith(E2E_MAIN_PREFIX)) return;
  try { fs.unlinkSync(resolved); }
  catch (e) {
    if (e.code !== 'ENOENT') console.error('Could not remove generated E2E Main ' + resolved + ': ' + e.message);
  }
}

function cleanupWorkerMainFiles() {
  let removed = 0;
  try {
    for (const name of fs.readdirSync(REPO_ROOT)) {
      if (!name.startsWith(E2E_MAIN_PREFIX) || !name.endsWith('.ahk')) continue;
      try { fs.unlinkSync(path.join(REPO_ROOT, name)); removed++; }
      catch (e) {
        if (e.code !== 'ENOENT') console.error('Could not remove generated E2E Main ' + name + ': ' + e.message);
      }
    }
  } catch (e) {
    console.error('Could not enumerate generated E2E Main files: ' + e.message);
  }
  return removed;
}

function rmrf(dir) {
  if (!dir) return true;
  try { fs.rmSync(dir, { recursive: true, force: true }); return true; }
  catch (e) {
    console.error('Could not remove temporary directory ' + dir + ': ' + e.message);
    return false;
  }
}

// Wipe the worker data dir so each scenario starts from a clean profile.
function resetDataDir(sandboxData) {
  fs.rmSync(sandboxData, { recursive: true, force: true });
  fs.mkdirSync(sandboxData, { recursive: true });
}

// Pre-flight: bail out if the real app is already running (#SingleInstance).
function preflight() {
  const outFile = path.join(os.tmpdir(), 'llm-preflight-' + process.pid + '-' + Date.now() + '.json');
  try {
    const res = spawnSync(AHK, [PROBE_AHK, 'preflight', outFile], {
      timeout: 15000,
      windowsHide: true,
      encoding: 'utf8'
    });
    if (res.error) throw new Error('preflight probe failed: ' + res.error.message);
    if (res.status !== 0) throw new Error('preflight probe exited with code ' + res.status + (res.stderr ? ': ' + res.stderr.trim() : ''));
    if (!fs.existsSync(outFile)) throw new Error('preflight probe produced no output');
    const out = {};
    for (const line of fs.readFileSync(outFile, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/)) {
      const separator = line.indexOf('|');
      if (separator < 0) continue;
      const key = line.slice(0, separator);
      const value = line.slice(separator + 1);
      out[key] = /^-?\d+(\.\d+)?$/.test(value) ? Number(value) : value;
    }
    return !!out.running;
  } finally {
    try { fs.unlinkSync(outFile); }
    catch (e) {
      if (e.code !== 'ENOENT') console.error('Could not remove preflight output ' + outFile + ': ' + e.message);
    }
  }
}

// Launch the app with an isolated environment. Returns { mainPid, port, cdpBase }.
function launch({ sandbox, port, workerId = '', mainScript = MAIN_AHK, envOverrides = null }) {
  const worker = workerId ? sanitizeWorkerId(workerId) : '';
  activeWebView2Dir = path.join(os.tmpdir(), 'llm-webview2-' + (worker ? worker + '-' : '') + Date.now() + '-' + Math.random().toString(36).slice(2, 8));
  const env = Object.assign({}, process.env, {
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=' + port + ' --remote-allow-origins=*',
    WEBVIEW2_USER_DATA_FOLDER: activeWebView2Dir,
    DEEPSEEK_API_KEY: 'sk-headless-test',
    OPENAI_API_KEY: 'sk-headless-test',
    GOOGLE_API_KEY: 'sk-headless-test'
  });
  if (envOverrides) Object.assign(env, envOverrides);
  if (sandbox) env.AHKLLM_E2E_DATA_DIR = sandbox;
  if (worker) env.AHKLLM_E2E_WORKER = worker;
  const args = ['/ErrorStdOut', mainScript];
  if (worker) args.push('--e2e-worker=' + worker);
  const child = spawn(AHK, args, {
    env,
    cwd: REPO_ROOT,
    windowsHide: false, // the chat window must be visible to render
    detached: false,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const diagnostics = { stdout: '', stderr: '', spawnError: '' };
  child.stdout.on('data', (chunk) => { diagnostics.stdout += String(chunk); });
  child.stderr.on('data', (chunk) => { diagnostics.stderr += String(chunk); });
  child.on('error', (err) => { diagnostics.spawnError = err && err.message ? err.message : String(err); });
  return { mainPid: child.pid, port, webView2Dir: activeWebView2Dir, child, diagnostics };
}

async function listTargets(port) {
  const res = await fetch('http://127.0.0.1:' + port + '/json/list');
  if (!res.ok) throw new Error('CDP /json/list HTTP ' + res.status);
  return await res.json();
}

// Wait until the CDP endpoint reports the chat page (webui/index.html).
async function waitForChatTarget(port, timeoutMs = 30000, launched = null) {
  const checkLaunch = () => {
    if (!launched || !launched.child) return;
    if (launched.diagnostics && launched.diagnostics.spawnError)
      throw new Error('Main spawn failed: ' + launched.diagnostics.spawnError);
    if (launched.child.exitCode !== null) {
      const diag = launched.diagnostics || {};
      const output = String(diag.stderr || diag.stdout || '').trim();
      throw new Error('Main exited before WebView2 became ready (exit ' + launched.child.exitCode + ')' + (output ? ': ' + output : ''));
    }
  };
  const start = Date.now();
  for (;;) {
    try {
      const targets = await listTargets(port);
      const chat = targets.find((t) => t.type === 'page' && (t.url || '').includes('webui/index.html'));
      if (chat && chat.webSocketDebuggerUrl) return chat;
    } catch {}
    checkLaunch();
    if (Date.now() - start > timeoutMs) {
      const diag = launched && launched.diagnostics ? String(launched.diagnostics.stderr || launched.diagnostics.stdout || '').trim() : '';
      throw new Error('waitForChatTarget timeout (port ' + port + ')' + (diag ? ': ' + diag : ''));
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function findTarget(port, urlPart, timeoutMs = 30000) {
  const start = Date.now();
  for (;;) {
    try {
      const targets = await listTargets(port);
      const t = targets.find((x) => x.type === 'page' && (x.url || '').includes(urlPart));
      if (t && t.webSocketDebuggerUrl) return t;
    } catch {}
    if (Date.now() - start > timeoutMs) return null;
    await new Promise((r) => setTimeout(r, 100));
  }
}

function killE2EWorkerProcesses(workerId) {
  const worker = sanitizeWorkerId(workerId);
  const ps = [
    '-NoProfile', '-Command',
    "$marker = [regex]::Escape('--e2e-worker=" + worker + "'); $procs = Get-CimInstance Win32_Process | Where-Object { ($_.Name -eq 'AutoHotkey64.exe') -and ($_.CommandLine -match ($marker + '(?=\"|\\s|$)')) }; foreach ($p in $procs) { taskkill.exe /PID $p.ProcessId /T /F 2>$null | Out-Null };",
    "$wv = Get-CimInstance Win32_Process | Where-Object { ($_.Name -eq 'msedgewebview2.exe') -and ($_.CommandLine -like '*llm-webview2-" + worker + "-*') }; foreach ($p in $wv) { taskkill.exe /PID $p.ProcessId /T /F 2>$null | Out-Null };",
    "for($attempt=0; $attempt -lt 20; $attempt++){ $leftA = @(Get-CimInstance Win32_Process | Where-Object { ($_.Name -eq 'AutoHotkey64.exe') -and ($_.CommandLine -match ($marker + '(?=\"|\\s|$)')) }).Count; $leftW = @(Get-CimInstance Win32_Process | Where-Object { ($_.Name -eq 'msedgewebview2.exe') -and ($_.CommandLine -like '*llm-webview2-" + worker + "-*') }).Count; if (($leftA + $leftW) -eq 0) { exit 0 }; Start-Sleep -Milliseconds 100 }; Write-Error ('E2E worker processes remain for ' + $marker); exit 1"
  ];
  const result = spawnSync('powershell.exe', ['-NoProfile', '-Command', ps.slice(2).join(' ')], {
    timeout: 25000, windowsHide: true, encoding: 'utf8'
  });
  if (result.error) console.error('E2E worker cleanup failed for ' + worker + ': ' + result.error.message);
  if (result.status !== 0 && result.stderr) console.error(result.stderr.trim());
  return result.status === 0;
}

function isE2EParentProcess(pid) {
  const targetPid = Number(pid);
  if (!Number.isInteger(targetPid) || targetPid <= 0) return false;
  const script = "$p = Get-CimInstance Win32_Process -Filter \"ProcessId=" + targetPid + "\" -ErrorAction SilentlyContinue; " +
    "if ($p -and $p.Name -eq 'node.exe' -and $p.CommandLine -match 'e2e-suite\\.js' -and $p.CommandLine -notmatch '--internal-worker') { '1' } else { '0' }";
  const res = spawnSync('powershell.exe', ['-NoProfile', '-Command', script], {
    timeout: 15000, windowsHide: true, encoding: 'utf8'
  });
  return String(res.stdout || '').trim() === '1';
}

function killE2EParentProcess(pid) {
  const targetPid = Number(pid);
  if (!isE2EParentProcess(targetPid)) return false;
  try {
    const result = spawnSync('taskkill', ['/PID', String(targetPid), '/T', '/F'], { windowsHide: true, timeout: 15000 });
    if (result.error) {
      console.error('Could not stop E2E parent pid=' + targetPid + ': ' + result.error.message);
      return false;
    }
    waitForProcessExit(targetPid, 2000);
    if (processExists(targetPid)) {
      console.error('E2E parent pid=' + targetPid + ' is still alive after taskkill (status ' + result.status + ').');
      return false;
    }
    return true;
  } catch (e) {
    console.error('Could not stop E2E parent pid=' + targetPid + ': ' + e.message);
    return false;
  }
}

function killAllE2EProcesses() {
  const ps = [
    '-NoProfile', '-Command',
    "$procs = Get-CimInstance Win32_Process | Where-Object { ($_.Name -eq 'AutoHotkey64.exe') -and (($_.CommandLine -match '\\.ahkllm-e2e-main-') -or ($_.CommandLine -match '--e2e-worker=')) }; foreach ($p in $procs) { taskkill.exe /PID $p.ProcessId /T /F 2>$null | Out-Null };",
    "$wv = Get-CimInstance Win32_Process | Where-Object { ($_.Name -eq 'msedgewebview2.exe') -and ($_.CommandLine -match 'llm-webview2-w[0-9]+-') }; foreach ($p in $wv) { taskkill.exe /PID $p.ProcessId /T /F 2>$null | Out-Null };",
    "$nodes = Get-CimInstance Win32_Process | Where-Object { ($_.Name -eq 'node.exe') -and ($_.CommandLine -like '*e2e-suite.js*--internal-worker*') }; foreach ($p in $nodes) { taskkill.exe /PID $p.ProcessId /T /F 2>$null | Out-Null };",
    "for($attempt=0; $attempt -lt 20; $attempt++){ $leftA = @(Get-CimInstance Win32_Process | Where-Object { ($_.Name -eq 'AutoHotkey64.exe') -and (($_.CommandLine -match '\\.ahkllm-e2e-main-') -or ($_.CommandLine -match '--e2e-worker=')) }).Count; $leftW = @(Get-CimInstance Win32_Process | Where-Object { ($_.Name -eq 'msedgewebview2.exe') -and ($_.CommandLine -match 'llm-webview2-w[0-9]+-') }).Count; $leftN = @(Get-CimInstance Win32_Process | Where-Object { ($_.Name -eq 'node.exe') -and ($_.CommandLine -like '*e2e-suite.js*--internal-worker*') }).Count; if (($leftA + $leftW + $leftN) -eq 0) { exit 0 }; Start-Sleep -Milliseconds 100 }; Write-Error 'marked E2E processes remain after cleanup'; exit 1"
  ];
  const result = spawnSync('powershell.exe', ['-NoProfile', '-Command', ps.slice(2).join(' ')], {
    timeout: 25000, windowsHide: true, encoding: 'utf8'
  });
  if (result.error) console.error('E2E cleanup failed: ' + result.error.message);
  if (result.status !== 0 && result.stderr) console.error(result.stderr.trim());
  return result.status === 0;
}

// Kill every leftover node.exe running an offscreen video scene for THIS repo,
// matched by command line: any script under scripts/videos/ (both the absolute
// "...ahkllm\scripts\videos\foo.js" form and the relative "scripts/videos/foo.js"
// form the orphaned runs left behind - hero-offscreen, commands-chat-offscreen,
// branch-navigation-offscreen, diag-retry, ...). Never a blanket node kill, so
// the user's own node processes elsewhere are untouched. excludePid defaults to
// the caller, so a scene (or the runner) never kills itself. Covers the orphaned
// node processes from runs that hung: they kept their mock server / CDP socket
// alive and never exited (the offscreen-pipeline leak).
function killOffscreenNodeProcesses(excludePid = process.pid) {
  const ps = [
    '-NoProfile', '-Command',
    "$self = " + Number(excludePid) + "; $procs = Get-CimInstance Win32_Process | Where-Object { ($_.Name -eq 'node.exe') -and ($_.ProcessId -ne $self) -and ($_.CommandLine -match 'scripts[\\\\/]videos[\\\\/]') }; foreach ($p in $procs) { taskkill.exe /PID $p.ProcessId /T /F 2>$null | Out-Null }"
  ];
  spawnSync('powershell.exe', ps, { timeout: 25000, windowsHide: true });
}

// Count leftover offscreen node processes (diagnostics/verification).
function countOffscreenNodeProcesses(excludePid = process.pid) {
  const ps = spawnSync('powershell.exe', ['-NoProfile', '-Command',
    // @(...) is required: a bare (...).Count on a SINGLE result performs
    // member enumeration on the CIM object and returns empty.
    "$self = " + Number(excludePid) + "; @(Get-CimInstance Win32_Process | Where-Object { ($_.Name -eq 'node.exe') -and ($_.ProcessId -ne $self) -and ($_.CommandLine -match 'scripts[\\\\/]videos[\\\\/]') }).Count"
  ], { timeout: 25000, windowsHide: true, encoding: 'utf8' });
  return Number((ps.stdout || '').trim()) || 0;
}

// Remove every leftover temp dir the harness/scenes create: llm-webview2-*
// (per-worker WebView2 user-data folders), llm-escape-* (E2E SQL-injection
// proof dirs), and ahkllm-frames-* (offscreen capture frames). These prefixes
// are private harness artifacts; this function never inspects or removes the
// real AhkLLM profile.
function sweepTempDirs() {
  let removed = 0;
  removed += sweepWebView2Dirs(8);
  try {
    for (const name of fs.readdirSync(os.tmpdir())) {
      if (name.startsWith('llm-escape-') || name.startsWith('ahkllm-frames-')) {
        try { fs.rmSync(path.join(os.tmpdir(), name), { recursive: true, force: true }); removed++; } catch {}
      }
    }
  } catch {}
  return removed;
}

// Self-healing sweep for the offscreen video pipeline: kill orphaned offscreen
// Node processes and clean private temp artifacts. E2E app processes are
// handled separately by their worker marker; this sweep never kills a normal
// AhkLLM instance.
function sweepOffscreenArtifacts() {
  const parts = [];
  const orphansBefore = countOffscreenNodeProcesses();
  killOffscreenNodeProcesses();
  const removed = sweepTempDirs();
  const orphansAfter = countOffscreenNodeProcesses();
  if (orphansBefore > 0 && orphansAfter === 0)
    parts.push('killed ' + orphansBefore + ' orphaned offscreen node process(es)');
  if (removed > 0) parts.push('removed ' + removed + ' temp dir(s)');
  return parts.join('; ') || 'nothing to clean up';
}

// Parallel workers use PID-tree cleanup plus a worker-id backstop. This never
// runs the legacy repo-wide sweep while sibling workers are alive.
function teardownWorker(mainPid, workerId) {
  const worker = sanitizeWorkerId(workerId);
  if (mainPid) {
    try {
      const result = spawnSync('taskkill', ['/PID', String(mainPid), '/T', '/F'], { windowsHide: true, timeout: 15000 });
      if (result.error) console.error('Could not stop worker Main pid=' + mainPid + ': ' + result.error.message);
      waitForProcessExit(mainPid, 1200);
    } catch (e) { console.error('Could not stop worker Main pid=' + mainPid + ': ' + e.message); }
  }
  const processCleanupOk = killE2EWorkerProcesses(worker);
  sweepWebView2Dirs(8);
  activeWebView2Dir = '';
  return processCleanupOk;
}

module.exports = { findFreePort, makeSandbox, rmrf, preflight, launch, waitForChatTarget, findTarget, createWorkerMain, createWorkerContext, disposeWorkerContext, teardownWorker, killE2EWorkerProcesses, isE2EParentProcess, killE2EParentProcess, killAllE2EProcesses, killOffscreenNodeProcesses, countOffscreenNodeProcesses, sweepTempDirs, sweepOffscreenArtifacts, resetDataDir, sweepWebView2Dirs, removeWorkerMain, cleanupWorkerMainFiles, AHK, PROBE_AHK, REPO_ROOT, MAIN_AHK, listTargets };
