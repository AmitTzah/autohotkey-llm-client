// e2e-suite.js - Parallel headless E2E suite for AhkLLM.
//
// Usage:
//   node e2e-suite.js --all                 # every scenario, auto worker count
//   node e2e-suite.js --all --workers=4     # explicit worker count
//   node e2e-suite.js --all --workers=1     # serial/debug mode
//   node e2e-suite.js --scenarios=1,6,15    # specific scenarios
//   node e2e-suite.js --pilot               # quick smoke (1, 3, 6, 15, 22)
//   node e2e-suite.js --check-sync          # report <-> scenarios in sync?
//   node e2e-suite.js --cleanup             # close stale E2E workers + temp files
//   node e2e-suite.js --status              # inspect a running parallel suite
//
// Real-app workers never move, junction, rename, or restore %APPDATA%\AhkLLM.
// AppInfo reads AHKLLM_E2E_DATA_DIR for E2E launches, and every worker gets its own
// TEMP/TMP, data dir, WebView2 dir, ports, logs, probes and result report.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn, spawnSync } = require('node:child_process');
const { CDP } = require('./cdp');
const { startMockServer } = require('./mock-llm-server');
const seed = require('./seed');
const launcher = require('./launch');

const RESULTS_DIR = path.join(__dirname, 'results');
const RESULTS_FILE = path.join(RESULTS_DIR, 'headless-verification.txt');
const RUN_LOCK = path.join(os.tmpdir(), 'ahkllm-e2e-parent.lock');
// The representative ladder showed the best repeatable wall time at eight:
// higher counts add WebView2 startup contention without improving throughput.
const MAX_AUTO_WORKERS = 8;

const scenarios = [].concat(
  require('./scenarios/chat-tree'),
  require('./scenarios/commands'),
  require('./scenarios/settings'),
  require('./scenarios/usage-tokens'),
  require('./scenarios/chat-ui'),
  require('./scenarios/codex-cli'),
  require('./scenarios/search-tools'),
  require('./scenarios/misc'),
  require('./scenarios/chat-locks'),
  require('./scenarios/db-verify')
).sort((a, b) => a.id - b.id);

function argValue(name) {
  const prefix = '--' + name + '=';
  const found = process.argv.slice(2).find((a) => a.startsWith(prefix));
  return found ? found.slice(prefix.length) : '';
}

function selectedIds() {
  const argv = process.argv.slice(2);
  if (argv.includes('--pilot')) return [1, 3, 6, 15, 22];
  if (argv.includes('--all')) return scenarios.map((s) => s.id);
  const raw = argValue('scenarios');
  if (raw) return raw.split(',').filter(Boolean).map((n) => parseInt(n, 10));
  return [1, 3, 6, 15, 22];
}

function selectScenarios(ids) {
  const selected = scenarios.filter((s) => ids.includes(s.id));
  if (selected.length !== ids.length) {
    const unknown = ids.filter((i) => !scenarios.some((s) => s.id === i));
    throw new Error('Unknown scenario ids: ' + unknown.join(','));
  }
  return selected;
}

function checkReportSync() {
  const reportFile = path.join(__dirname, 'BUG_HUNT_REPORT.md');
  if (!fs.existsSync(reportFile)) {
    console.error('Sync FAIL: BUG_HUNT_REPORT.md not found next to e2e-suite.js');
    return false;
  }
  const text = fs.readFileSync(reportFile, 'utf8');
  const start = text.indexOf('## Open bugs');
  const ends = ['## History', '## Refuted', '## Fixed']
    .map((h) => text.indexOf(h))
    .filter((i) => i > start);
  const end = ends.length ? Math.min(...ends) : -1;
  const section = (start >= 0 && end > start) ? text.slice(start, end) : text;
  const reportIds = new Set();
  for (const m of section.matchAll(/\*\*Scenario:\*\*\s*(\d+)/g)) reportIds.add(parseInt(m[1], 10));
  const known = new Set(scenarios.map((s) => s.id));
  const missing = [...reportIds].filter((id) => !known.has(id));
  const unlisted = scenarios.filter((s) => !reportIds.has(s.id) && !s.regression).map((s) => s.id);
  const dupes = [...new Set(scenarios.map((s) => s.id).filter((id, i, arr) => arr.indexOf(id) !== i))];
  let ok = true;
  if (missing.length) { console.error('Sync FAIL: report references missing scenarios: ' + missing.join(', ')); ok = false; }
  if (unlisted.length) { console.error('Sync FAIL: scenarios with no report entry: ' + unlisted.join(', ')); ok = false; }
  if (dupes.length) { console.error('Sync FAIL: duplicate scenario ids: ' + dupes.join(', ')); ok = false; }
  if (ok) {
    const reg = scenarios.filter((s) => s.regression).length;
    console.log('Sync OK: ' + reportIds.size + ' open-bug entries, ' + scenarios.length + ' scenarios (' + reg + ' regression/refuted checks)');
  }
  return ok;
}

function processAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; }
  catch (e) { return !!(e && e.code === 'EPERM'); }
}

function readRunLock() {
  try { return JSON.parse(fs.readFileSync(RUN_LOCK, 'utf8')); }
  catch { return null; }
}

function acquireRunLock() {
  const current = readRunLock();
  if (current && launcher.isE2EParentProcess(Number(current.pid)))
    throw new Error('another headless E2E parent is already running (pid ' + current.pid + ', started ' + (current.startedAt || 'unknown') + ')');
  if (current) {
    try { fs.unlinkSync(RUN_LOCK); }
    catch (e) {
      if (e.code !== 'ENOENT') throw new Error('cannot remove stale E2E run lock: ' + e.message);
    }
  }
  const fd = fs.openSync(RUN_LOCK, 'wx');
  try {
    fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
  } finally {
    fs.closeSync(fd);
  }
}

function releaseRunLock() {
  const current = readRunLock();
  if (!current || Number(current.pid) === process.pid) {
    try { fs.unlinkSync(RUN_LOCK); }
    catch (e) {
      if (e.code !== 'ENOENT') console.error('Could not remove E2E run lock: ' + e.message);
    }
  }
}

function updateRunLock(patch) {
  const current = readRunLock();
  if (!current || Number(current.pid) !== process.pid) return;
  try {
    fs.writeFileSync(RUN_LOCK, JSON.stringify(Object.assign({}, current, patch), null, 2), 'utf8');
  } catch (e) {
    console.error('Could not update E2E run lock: ' + e.message);
  }
}

async function statusCommand() {
  const lock = readRunLock();
  if (!lock) {
    console.log('No E2E run is active.');
    return;
  }
  const parentAlive = launcher.isE2EParentProcess(Number(lock.pid));
  console.log('E2E parent: pid=' + lock.pid + ' alive=' + (parentAlive ? 'yes' : 'no') + ' started=' + (lock.startedAt || 'unknown'));
  if (Array.isArray(lock.selected)) console.log('Selected scenarios: ' + lock.selected.join(','));
  if (lock.runRoot) console.log('Run root: ' + lock.runRoot);
  for (const w of lock.workers || []) {
    const alive = processAlive(Number(w.pid));
    let report = null;
    try { report = JSON.parse(fs.readFileSync(w.reportFile, 'utf8')); } catch {}
    const done = report && Array.isArray(report.results) ? report.results.length : 0;
    const current = report && report.currentScenario ? ' current=#' + report.currentScenario : '';
    const stage = report && report.stage ? ' stage=' + report.stage : '';
    console.log('Worker ' + w.index + ': pid=' + w.pid + ' alive=' + (alive ? 'yes' : 'no') + ' done=' + done + '/' + w.ids.length + current + stage + ' ids=' + w.ids.join(','));
    if (report && report.runnerError) console.log('  error: ' + report.runnerError);
    if (report && Array.isArray(report.results) && report.results.length) {
      for (const r of report.results.slice(-3))
        console.log('  result #' + r.id + ': ' + (r.pass ? 'PASS' : 'FAIL') + ' ' + Number(r.seconds || 0).toFixed(1) + 's | ' + r.detail);
    }
    if (report && report.port) {
      try {
        const targets = await launcher.listTargets(report.port);
        const chat = targets.find((t) => t.type === 'page' && (t.url || '').includes('webui/index.html'));
        console.log('  CDP port=' + report.port + ' targets=' + targets.map((t) => (t.type || '?') + ':' + (t.url || '')).join(', '));
        if (chat && chat.webSocketDebuggerUrl) {
          const probe = await CDP.connect(chat.webSocketDebuggerUrl);
          try {
            const state = await probe.eval(`({ ready: document.readyState, chatMessagesType: typeof chatMessages, href: location.href, bodyText: document.body ? document.body.innerText.slice(0, 160) : '' })`);
            console.log('  page state: ' + JSON.stringify(state));
          } finally { await probe.close(); }
        }
      } catch (e) { console.log('  CDP status error: ' + (e && e.message ? e.message : String(e))); }
    }
    try {
      const debugFile = (w.dataDir || (report && report.dataDir))
        ? path.join(w.dataDir || report.dataDir, 'LLM_Debug_Log.txt') : '';
      if (!debugFile) continue;
      const debugLines = fs.readFileSync(debugFile, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/).filter(Boolean).slice(-8);
      if (debugLines.length) console.log('  debug tail: ' + debugLines.join(' | '));
    } catch (e) {
      if (e.code !== 'ENOENT') console.log('  debug log read error: ' + e.message);
    }
  }
}

function removeOldRunDirs() {
  let removed = 0;
  let failed = 0;
  try {
    for (const name of fs.readdirSync(os.tmpdir())) {
      if (!name.startsWith('ahkllm-e2e-run-')) continue;
      try { fs.rmSync(path.join(os.tmpdir(), name), { recursive: true, force: true }); removed++; }
      catch (e) {
        failed++;
        console.error('Could not remove stale E2E run dir ' + name + ': ' + e.message);
      }
    }
  } catch (e) {
    failed++;
    console.error('Could not enumerate stale E2E run dirs: ' + e.message);
  }
  return { removed, failed };
}

function cleanupStaleE2E() {
  const processes = launcher.killAllE2EProcesses();
  const mains = launcher.cleanupWorkerMainFiles();
  const dirs = removeOldRunDirs();
  return { processes, mains, dirs: dirs.removed, dirFailures: dirs.failed };
}

function cleanupCommand() {
  const lock = readRunLock();
  const parentPid = lock ? Number(lock.pid) : 0;
  const killedParent = parentPid ? launcher.killE2EParentProcess(parentPid) : false;
  const parentStillAlive = parentPid && launcher.isE2EParentProcess(parentPid);
  if (parentStillAlive) {
    console.error('E2E cleanup could not stop parent pid=' + parentPid + '; refusing to claim cleanup complete while it is still running.');
    return 1;
  }
  const c = cleanupStaleE2E();
  let lockRemoved = true;
  try { fs.unlinkSync(RUN_LOCK); }
  catch (e) {
    if (e.code !== 'ENOENT') {
      lockRemoved = false;
      console.error('Could not remove E2E run lock: ' + e.message);
    }
  }
  const status = [
    'E2E cleanup ' + (lockRemoved && c.processes && !c.dirFailures ? 'complete' : 'incomplete'),
    'parent=' + (killedParent ? parentPid : 'none'),
    'worker Main files=' + c.mains,
    'stale run dirs=' + c.dirs,
    'Real AhkLLM profile was not touched.'
  ].join(', ');
  console.log(status);
  return lockRemoved && c.processes && !c.dirFailures ? 0 : 1;
}

async function closeMockServer(handle) {
  const srv = handle && handle.server;
  if (!srv) return;
  try { if (typeof srv.closeAllConnections === 'function') srv.closeAllConnections(); } catch {}
  if (!srv.listening) return;
  await new Promise((resolve) => {
    try { srv.close(() => resolve()); }
    catch { resolve(); }
  });
}

async function runScenario(sc, worker) {
  let server = null;
  let mainPid = 0;
  let cdp = null;
  let mockLog = '';
  const noApp = !!sc.noApp;
  const detail = { step: 'setup' };
  const stage = (name) => {
    detail.step = name;
    if (worker.reportStage) worker.reportStage(name);
  };
  try {
    stage('prepare');
    const refusePort = await launcher.findFreePort();
    let endpoint = 'http://127.0.0.1:' + refusePort + '/v1/chat/completions';
    if (sc.mode) {
      mockLog = path.join(worker.sandboxData || os.tmpdir(), 'mock-requests.jsonl');
      server = await startMockServer(sc.mode, mockLog, sc.mockOpts || {});
      endpoint = 'http://127.0.0.1:' + server.port + '/v1/chat/completions';
    }

    if (!noApp) launcher.resetDataDir(worker.sandboxData);
    const dataDir = noApp ? null : worker.sandboxData;
    if (!noApp) seed.writeSettings(dataDir, sc.settings || {}, endpoint);
    if (!noApp && sc.preLaunch) sc.preLaunch(dataDir, endpoint);
    const dbPath = (!noApp && sc.fixtures)
      ? seed.createDb(dataDir, sc.fixtures)
      : (!noApp ? path.join(dataDir, 'chat_history.db') : null);
    detail.dbPath = dbPath;

    let port = 0;
    if (!noApp) {
      port = await launcher.findFreePort();
      worker.currentPort = port;
      stage('launch-main');
      const envOverrides = typeof sc.launchEnv === 'function'
        ? (sc.launchEnv({ dataDir, endpoint, workerId: worker.workerId }) || {})
        : (sc.launchEnv || {});
      const launched = launcher.launch({
        sandbox: worker.sandboxData,
        port,
        workerId: worker.workerId,
        mainScript: worker.mainScript,
        envOverrides
      });
      mainPid = launched.mainPid;
      detail.port = port;
      stage('wait-webview-target');
      const target = await launcher.waitForChatTarget(port, 30000, launched);
      stage('connect-cdp');
      cdp = await CDP.connect(target.webSocketDebuggerUrl);
      stage('install-cdp-hook');
      await cdp.installPostMessageHook();
      stage('wait-chat-page');
      await cdp.waitFor('document.readyState === "complete" && typeof chatMessages !== "undefined"', 60000, 100, 'chat page ready');
      stage('wait-send-wiring');
      await cdp.waitFor('document.getElementById("chat-send-btn") && document.getElementById("chat-send-btn").onclick !== null', 30000, 100, 'send button wired');
      // The first hook can be installed on WebView2's provisional/initial
      // document if CDP attaches before the final chat navigation completes.
      // Re-install after the real page and handlers are ready so scenario
      // assertions observe the same postMessage calls that AHK receives.
      stage('reinstall-cdp-hook');
      await cdp.installPostMessageHook();
    }

    stage('scenario-body');
    const result = await sc.body({ cdp, dataDir, dbPath, port, endpoint, mockLog });
    if (cdp) await cdp.close();
    cdp = null;
    return { id: sc.id, name: sc.name, pass: true, detail: result };
  } catch (e) {
    if (cdp) try { await cdp.close(); } catch {}
    cdp = null;
    let failureDetail = detail.step + ' -> ' + (e && e.message ? e.message : String(e));
    try {
      const debugFile = worker.sandboxData ? path.join(worker.sandboxData, 'LLM_Debug_Log.txt') : '';
      if (!debugFile) throw new Error('worker debug log path unavailable');
      const debugLines = fs.readFileSync(debugFile, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/).filter(Boolean).slice(-8);
      if (debugLines.length) failureDetail += ' | debug: ' + debugLines.join(' | ');
    } catch (debugError) {
      if (debugError.code !== 'ENOENT') failureDetail += ' | debug log unavailable: ' + debugError.message;
    }
    return {
      id: sc.id,
      name: sc.name,
      pass: false,
      detail: failureDetail,
      dataDir: worker.sandboxData || ''
    };
  } finally {
    if (mainPid) launcher.teardownWorker(mainPid, worker.workerId);
    if (server) await closeMockServer(server);
  }
}

function writeWorkerReport(reportFile, payload) {
  const temporary = reportFile + '.tmp-' + process.pid;
  try {
    fs.writeFileSync(temporary, JSON.stringify(payload, null, 2), 'utf8');
    fs.renameSync(temporary, reportFile);
    return true;
  } catch (e) {
    console.error('Could not write worker report ' + reportFile + ': ' + e.message);
    try { fs.unlinkSync(temporary); }
    catch (cleanupError) {
      if (cleanupError.code !== 'ENOENT') console.error('Could not remove partial worker report ' + temporary + ': ' + cleanupError.message);
    }
    return false;
  }
}

async function runWorker(selected, workerId, reportFile) {
  const needsApp = selected.some((s) => !s.noApp);
  const worker = {
    workerId,
    mainScript: needsApp ? launcher.createWorkerMain(workerId) : '',
    sandboxData: needsApp ? launcher.makeSandbox() : null,
    currentPort: 0
  };
  const results = [];
  let runnerError = '';
  let currentScenario = 0;
  let currentStage = 'idle';
  const flush = (done = false) => writeWorkerReport(reportFile, {
    workerId, results, runnerError, currentScenario, stage: currentStage,
    port: worker.currentPort || 0, dataDir: worker.sandboxData || '', done
  });
  worker.reportStage = (stage) => { currentStage = stage; flush(); };
  flush();
  try {
    console.log('Worker ' + workerId + ' running ' + selected.length + ' scenario(s).');
    for (const sc of selected) {
      currentScenario = sc.id;
      flush();
      const started = Date.now();
      console.log('START | #' + String(sc.id).padStart(2, '0') + ' | ' + sc.name);
      const r = await runScenario(sc, worker);
      r.seconds = Number(((Date.now() - started) / 1000).toFixed(1));
      if (!r.pass && worker.sandboxData && fs.existsSync(worker.sandboxData)) {
        const snapshot = path.join(os.tmpdir(), 'failed-' + sc.id + '-data');
        try {
          fs.rmSync(snapshot, { recursive: true, force: true });
          fs.cpSync(worker.sandboxData, snapshot, { recursive: true });
          r.dataDir = snapshot;
        } catch (snapshotError) {
          console.error('Could not preserve failure data for scenario #' + sc.id + ': ' + snapshotError.message);
        }
      }
      results.push(r);
      currentScenario = 0;
      currentStage = 'idle';
      worker.currentPort = 0;
      flush();
      console.log((r.pass ? 'PASS' : 'FAIL') + ' | #' + String(r.id).padStart(2, '0') + ' | ' + r.name + ' | ' + r.detail + ' | ' + r.seconds.toFixed(1) + 's');
    }
  } catch (e) {
    runnerError = e && e.message ? e.message : String(e);
    flush();
    console.error('Worker runner error: ' + runnerError);
  } finally {
    if (needsApp) {
      const processCleanupOk = launcher.teardownWorker(0, workerId);
      if (!processCleanupOk && !runnerError)
        runnerError = 'marked E2E processes remained during worker cleanup';
      launcher.removeWorkerMain(worker.mainScript);
      if (fs.existsSync(worker.mainScript))
        runnerError = runnerError || 'generated worker Main remained: ' + worker.mainScript;
      if (!launcher.rmrf(worker.sandboxData) && !runnerError)
        runnerError = 'worker data directory cleanup failed: ' + worker.sandboxData;
    }
    currentScenario = 0;
    currentStage = 'done';
    worker.currentPort = 0;
    flush(true);
  }
  process.exit(results.length === selected.length && results.every((r) => r.pass) && !runnerError ? 0 : 1);
}

function loadHistoricalDurations() {
  const out = new Map();
  let text = '';
  try { text = fs.readFileSync(RESULTS_FILE, 'utf8'); } catch { return out; }
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^(?:PASS|FAIL) \| #(\d+) \| .* \| ([0-9]+(?:\.[0-9]+)?)s$/);
    if (m) out.set(Number(m[1]), Number(m[2]));
  }
  return out;
}

function chooseWorkerCount(selected, requestedRaw) {
  if (requestedRaw) {
    const requested = Number(requestedRaw);
    if (!Number.isInteger(requested) || requested < 1 || requested > 32)
      throw new Error('--workers must be an integer from 1 to 32');
    return Math.min(requested, selected.length || 1);
  }
  const cpu = typeof os.availableParallelism === 'function' ? os.availableParallelism() : (os.cpus().length || 2);
  const memoryGiB = os.totalmem() / (1024 * 1024 * 1024);
  const byCpu = Math.max(1, cpu - 2);
  const byMemory = Math.max(1, Math.floor(Math.max(1, memoryGiB - 2)));
  return Math.max(1, Math.min(MAX_AUTO_WORKERS, byCpu, byMemory, selected.length || 1));
}

function shardScenarios(selected, workerCount, historical) {
  const bins = Array.from({ length: workerCount }, () => ({ weight: 0, scenarios: [] }));
  const weighted = selected.map((sc) => ({
    sc,
    weight: historical.has(sc.id) ? Math.max(0.1, historical.get(sc.id)) : (sc.noApp ? 0.25 : 5)
  })).sort((a, b) => b.weight - a.weight || a.sc.id - b.sc.id);
  for (const item of weighted) {
    bins.sort((a, b) => a.weight - b.weight || a.scenarios.length - b.scenarios.length);
    bins[0].scenarios.push(item.sc);
    bins[0].weight += item.weight;
  }
  for (const bin of bins) bin.scenarios.sort((a, b) => a.id - b.id);
  return bins.filter((b) => b.scenarios.length);
}

function prefixStream(stream, label) {
  let pending = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    pending += chunk;
    const lines = pending.split(/\r?\n/);
    pending = lines.pop();
    for (const line of lines) process.stdout.write('[' + label + '] ' + line + '\n');
  });
  stream.on('end', () => { if (pending) process.stdout.write('[' + label + '] ' + pending + '\n'); });
}

function killNodeTree(pid) {
  if (!pid) return;
  try {
    const result = spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 15000 });
    if (result.error) console.error('Could not stop worker pid=' + pid + ': ' + result.error.message);
    if (processAlive(pid)) console.error('Worker pid=' + pid + ' is still alive after cleanup request.');
  } catch (e) {
    console.error('Could not stop worker pid=' + pid + ': ' + e.message);
  }
}

function spawnWorker(bin, workerId, runRoot) {
  const workerRoot = fs.mkdtempSync(path.join(runRoot, 'worker-' + bin.index + '-'));
  const reportFile = path.join(workerRoot, 'report.json');
  const ids = bin.scenarios.map((s) => s.id);
  const args = [
    __filename,
    '--internal-worker',
    '--scenarios=' + ids.join(','),
    '--worker-id=' + workerId,
    '--worker-report=' + reportFile
  ];
  const env = Object.assign({}, process.env, {
    TEMP: workerRoot,
    TMP: workerRoot,
    AHKLLM_E2E_WORKER: workerId
  });
  const child = spawn(process.execPath, args, {
    cwd: launcher.REPO_ROOT,
    env,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  prefixStream(child.stdout, 'W' + bin.index);
  prefixStream(child.stderr, 'W' + bin.index + ' ERR');
  const done = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));
  return { child, done, reportFile, workerRoot, ids, index: bin.index, workerId };
}

function readWorkerReport(handle) {
  try { return JSON.parse(fs.readFileSync(handle.reportFile, 'utf8')); }
  catch (e) {
    return {
      workerId: 'worker-' + handle.index,
      results: [],
      runnerError: 'worker report missing/unreadable: ' + e.message
    };
  }
}

function writeFinalResults(selected, reports, workerCount, runRoot, elapsedMs) {
  const byId = new Map();
  const workerErrors = [];
  for (const report of reports) {
    if (report.runnerError) workerErrors.push(report.workerId + ': ' + report.runnerError);
    for (const result of report.results || []) byId.set(result.id, result);
  }
  const merged = selected.map((sc) => byId.get(sc.id) || ({
    id: sc.id,
    name: sc.name,
    pass: false,
    detail: 'worker exited without a result',
    seconds: 0
  }));
  const lines = ['# ' + new Date().toISOString() + ' | run of ' + selected.length + ' scenario(s) with ' + workerCount + ' worker(s)'];
  for (const r of merged) {
    if (r.dataDir) lines.push('  (data dir for inspection: ' + r.dataDir + ')');
    lines.push((r.pass ? 'PASS' : 'FAIL') + ' | #' + String(r.id).padStart(2, '0') + ' | ' + r.name + ' | ' + r.detail + ' | ' + Number(r.seconds || 0).toFixed(1) + 's');
  }
  const passCount = merged.filter((r) => r.pass).length;
  const failed = merged.filter((r) => !r.pass).map((r) => '#' + r.id);
  const summary = 'Summary: ' + passCount + '/' + selected.length + ' scenarios PASS' + (failed.length ? ' — FAILED: ' + failed.join(', ') : '');
  const slowest = merged.slice().sort((a, b) => Number(b.seconds || 0) - Number(a.seconds || 0)).slice(0, 10);
  const slowLine = 'Slowest scenarios: ' + (slowest.length ? slowest.map((r) => '#' + r.id + '=' + Number(r.seconds || 0).toFixed(1) + 's').join(', ') : 'none');
  const elapsedLine = 'Elapsed: ' + (Number(elapsedMs || 0) / 1000).toFixed(1) + 's';
  const syncOk = checkReportSync();
  const syncLine = syncOk ? 'OK' : 'MISMATCH — update BUG_HUNT_REPORT.md or scenarios/*.js';
  lines.push('', summary, slowLine, elapsedLine, 'Workers: ' + workerCount, 'Real profile touched: no (AHKLLM_E2E_DATA_DIR override)', 'Report sync: ' + syncLine);
  if (workerErrors.length) lines.push('Worker errors: ' + workerErrors.join('; '));
  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  fs.writeFileSync(RESULTS_FILE, lines.join('\n') + '\n', 'utf8');
  console.log('\n' + summary);
  console.log(slowLine);
  console.log(elapsedLine);
  console.log('Workers: ' + workerCount);
  console.log('Results written to ' + RESULTS_FILE);
  console.log('Real profile touched: no');
  console.log('Report sync: ' + syncLine);
  if (failed.length || workerErrors.length) console.log('Failure artifacts kept under ' + runRoot);
  return { passCount, total: selected.length, ok: passCount === selected.length && !workerErrors.length && syncOk };
}

async function runParent(selected) {
  acquireRunLock();
  const startedAt = Date.now();
  let runRoot = '';
  const handles = [];
  let interrupted = false;
  const onInterrupt = (signal) => {
    if (interrupted) process.exit(130);
    interrupted = true;
    console.error('\n[' + signal + '] stopping E2E workers...');
    for (const h of handles) killNodeTree(h.child.pid);
    launcher.killAllE2EProcesses();
    launcher.cleanupWorkerMainFiles();
    releaseRunLock();
    process.exit(130);
  };
  process.on('SIGINT', onInterrupt);
  process.on('SIGTERM', onInterrupt);

  try {
  const stale = cleanupStaleE2E();
    if (stale.mains || stale.dirs) console.log('Cleaned stale E2E artifacts: Main files=' + stale.mains + ', run dirs=' + stale.dirs);

    if (selected.some((s) => !s.noApp) && launcher.preflight()) {
      throw new Error('AhkLLM is already running. Close the normal app before E2E so global hotkeys/window probes cannot overlap. The suite no longer touches its real profile.');
    }

    const workerCount = chooseWorkerCount(selected, argValue('workers'));
    const historical = loadHistoricalDurations();
    const shards = shardScenarios(selected, workerCount, historical).map((b, i) => Object.assign(b, { index: i + 1 }));
    runRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ahkllm-e2e-run-'));
    console.log('Running ' + selected.length + ' scenarios with ' + shards.length + ' worker(s).');
    console.log('Isolation: per-worker data dir + TEMP/TMP + WebView2; real %APPDATA%\\AhkLLM is untouched.');

    const stamp = Date.now().toString(36);
    for (const bin of shards) {
      const workerId = 'w' + bin.index + '-' + process.pid + '-' + stamp;
    handles.push(spawnWorker(bin, workerId, runRoot));
    }
    updateRunLock({
      runRoot,
      selected: selected.map((s) => s.id),
      workers: handles.map((h) => ({ index: h.index, workerId: h.workerId, pid: h.child.pid, reportFile: h.reportFile, ids: h.ids }))
    });
    await Promise.all(handles.map((h) => h.done));
    const reports = handles.map(readWorkerReport);
    const final = writeFinalResults(selected, reports, shards.length, runRoot, Date.now() - startedAt);
    if (final.ok) {
      try { fs.rmSync(runRoot, { recursive: true, force: true }); }
      catch (e) {
        console.error('Could not remove successful E2E run root ' + runRoot + ': ' + e.message);
        return 1;
      }
      if (fs.existsSync(runRoot)) {
        console.error('Successful E2E run root still exists: ' + runRoot);
        return 1;
      }
    }
    return final.ok ? 0 : 1;
  } finally {
    for (const h of handles) {
      if (processAlive(h.child.pid)) killNodeTree(h.child.pid);
    }
    launcher.killAllE2EProcesses();
    launcher.cleanupWorkerMainFiles();
    releaseRunLock();
  }
}

async function main() {
  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  if (process.argv.includes('--check-sync')) process.exit(checkReportSync() ? 0 : 1);
  if (process.argv.includes('--cleanup')) process.exit(cleanupCommand());
  if (process.argv.includes('--status')) { await statusCommand(); process.exit(0); }

  const selected = selectScenarios(selectedIds());
  if (process.argv.includes('--internal-worker')) {
    const workerId = argValue('worker-id') || process.env.AHKLLM_E2E_WORKER;
    const reportFile = argValue('worker-report');
    if (!workerId || !reportFile) throw new Error('internal worker missing worker id/report path');
    await runWorker(selected, workerId, reportFile);
    return;
  }

  const code = await runParent(selected);
  process.exit(code);
}

main().catch((e) => {
  console.error('Runner error:', e && e.stack ? e.stack : e);
  releaseRunLock();
  process.exit(2);
});
