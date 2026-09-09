// Focused CDP transport regression tests. The fake socket makes close/error
// and timeout paths deterministic without launching WebView2 or sleeping for
// the production ten-second command timeout.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { CDP } = require('../../tests/headless/cdp');

class FakeWebSocket {
  constructor() {
    this.listeners = new Map();
    this.sent = [];
  }

  addEventListener(name, fn) {
    if (!this.listeners.has(name)) this.listeners.set(name, []);
    this.listeners.get(name).push(fn);
  }

  emit(name, value) {
    for (const fn of this.listeners.get(name) || []) fn(value);
  }

  send(message) {
    this.sent.push(JSON.parse(message));
  }

  close() {
    this.emit('close');
  }
}

describe('CDP transport failure handling', () => {
  it('rejects pending commands when the websocket closes', async () => {
    const ws = new FakeWebSocket();
    const cdp = new CDP(ws, { sendTimeoutMs: 1000 });
    const pending = cdp.send('Runtime.evaluate');
    ws.emit('close');
    await assert.rejects(pending, /CDP websocket closed/);
    await assert.rejects(cdp.send('Runtime.evaluate'), /CDP websocket closed/);
  });

  it('rejects pending commands when the websocket errors', async () => {
    const ws = new FakeWebSocket();
    const cdp = new CDP(ws, { sendTimeoutMs: 1000 });
    const pending = cdp.send('Runtime.evaluate');
    ws.emit('error');
    await assert.rejects(pending, /CDP websocket error/);
  });

  it('times out a command that receives no response', async () => {
    const ws = new FakeWebSocket();
    const cdp = new CDP(ws, { sendTimeoutMs: 20 });
    await assert.rejects(cdp.send('Runtime.evaluate'), /CDP send timeout: Runtime.evaluate/);
  });

  it('clears the command timer after a successful response', async () => {
    const ws = new FakeWebSocket();
    const cdp = new CDP(ws, { sendTimeoutMs: 20 });
    const pending = cdp.send('Runtime.evaluate');
    ws.emit('message', { data: JSON.stringify({ id: 1, result: { value: 7 } }) });
    assert.deepEqual(await pending, { value: 7 });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(cdp._pending.size, 0);
  });

  it('stops waitFor when the websocket dies', async () => {
    const ws = new FakeWebSocket();
    const cdp = new CDP(ws, { sendTimeoutMs: 1000 });
    const waiting = cdp.waitFor('window.neverReady', 1000, 1, 'never ready');
    await new Promise((resolve) => setImmediate(resolve));
    ws.emit('close');
    await assert.rejects(waiting, /CDP websocket closed/);
  });

  it('repairs the postMessage recorder when the diagnostics array survives but the wrapper is lost', async () => {
    const delivered = [];
    const nativePost = (message) => { delivered.push(message); };
    const sandbox = {
      window: { chrome: { webview: { postMessage: nativePost } } },
      JSON
    };
    const cdp = Object.create(CDP.prototype);
    cdp.eval = async (script) => vm.runInNewContext(script, sandbox);

    await cdp.installPostMessageHook();
    sandbox.window.chrome.webview.postMessage('first');
    assert.deepEqual(Array.from(sandbox.window.__posted), ['first']);

    // Simulate a document/host-object transition that leaves diagnostics state
    // behind but replaces the wrapped WebView postMessage function.
    sandbox.window.chrome.webview.postMessage = nativePost;
    await cdp.installPostMessageHook();
    sandbox.window.chrome.webview.postMessage('second');

    assert.deepEqual(Array.from(sandbox.window.__posted), ['first', 'second']);
    assert.deepEqual(delivered, ['first', 'second']);
    assert.equal(sandbox.window.chrome.webview.postMessage.__ahkllmPostHook, true);
  });
});
