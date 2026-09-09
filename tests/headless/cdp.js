// cdp.js — Minimal Chrome DevTools Protocol client for WebView2.
// Zero dependencies: Node 24 built-in WebSocket + fetch.
// Drives the page with synthetic input events (no physical mouse/keyboard).
'use strict';

class CDP {
  constructor(ws, { sendTimeoutMs = 10000 } = {}) {
    this.ws = ws;
    this.sendTimeoutMs = sendTimeoutMs;
    this._id = 0;
    this._pending = new Map();
    this._events = [];
    this._listeners = new Map();
    this._closedError = null;
    const failPending = (message) => {
      if (!this._closedError) this._closedError = new Error(message);
      for (const { reject, timer } of this._pending.values()) {
        clearTimeout(timer);
        reject(this._closedError);
      }
      this._pending.clear();
    };
    ws.addEventListener('close', () => failPending('CDP websocket closed'));
    ws.addEventListener('error', () => failPending('CDP websocket error'));
    ws.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.id !== undefined && this._pending.has(msg.id)) {
        const { resolve, reject, timer } = this._pending.get(msg.id);
        this._pending.delete(msg.id);
        clearTimeout(timer);
        if (msg.error) reject(new Error('CDP error ' + msg.error.code + ': ' + msg.error.message));
        else resolve(msg.result);
      } else if (msg.method) {
        const list = this._listeners.get(msg.method);
        if (list) for (const fn of list) fn(msg.params);
      }
    });
  }

  static async connect(wsUrl, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      const timer = setTimeout(() => { try { ws.close(); } catch {} reject(new Error('CDP connect timeout: ' + wsUrl)); }, timeoutMs);
      ws.addEventListener('open', () => { clearTimeout(timer); resolve(new CDP(ws)); });
      ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('CDP connect failed: ' + wsUrl)); });
    });
  }

  send(method, params = {}) {
    const id = ++this._id;
    if (this._closedError) return Promise.reject(this._closedError);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this._pending.has(id)) return;
        this._pending.delete(id);
        reject(new Error('CDP send timeout: ' + method));
      }, this.sendTimeoutMs);
      this._pending.set(id, { resolve, reject, timer });
      try {
        this.ws.send(JSON.stringify({ id, method, params }));
      } catch (e) {
        this._pending.delete(id);
        clearTimeout(timer);
        reject(e);
      }
    });
  }

  on(method, fn) {
    if (!this._listeners.has(method)) this._listeners.set(method, []);
    this._listeners.get(method).push(fn);
  }

  async close() {
    try { this.ws.close(); } catch {}
  }

  // Evaluate an expression in the page and return its value.
  // Throws when the page throws (exceptionDetails present).
  async eval(expression, awaitPromise = true) {
    const res = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise,
      returnByValue: true,
      userGesture: true
    });
    if (res.exceptionDetails) {
      const exc = res.exceptionDetails.exception || {};
      throw new Error('Page exception: ' + (exc.description || exc.value || JSON.stringify(res.exceptionDetails)));
    }
    return res.result ? res.result.value : undefined;
  }

  async evalOrNull(expression) {
    try { return await this.eval(expression); } catch { return null; }
  }

  // Poll a page expression until truthy.
  async waitFor(expression, timeoutMs = 30000, intervalMs = 100, label = expression) {
    const start = Date.now();
    for (;;) {
      if (this._closedError) throw this._closedError;
      const v = await this.evalOrNull(expression);
      if (v) return v;
      if (this._closedError) throw this._closedError;
      if (Date.now() - start > timeoutMs) throw new Error('waitFor timeout: ' + label);
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }

  // Click an element by CSS selector (synthetic click inside the renderer).
  async click(selector) {
    const ok = await this.eval(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return false;
      el.scrollIntoView({ block: 'center', inline: 'center' });
      el.click();
      return true;
    })()`);
    if (!ok) throw new Error('click: element not found: ' + selector);
  }

  async clickIfExists(selector) {
    return await this.eval(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return false;
      el.scrollIntoView({ block: 'center', inline: 'center' });
      el.click();
      return true;
    })()`);
  }

  // Set an input/textarea value the way a user would (native setter + input event).
  async type(selector, text) {
    const ok = await this.eval(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return false;
      el.focus();
      const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
      setter.call(el, ${JSON.stringify(text)});
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`);
    if (!ok) throw new Error('type: element not found: ' + selector);
  }

  async text(selector) {
    return await this.eval(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      return el ? el.textContent : null;
    })()`);
  }

  async attr(selector, name) {
    return await this.eval(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      return el ? el.getAttribute(${JSON.stringify(name)}) : null;
    })()`);
  }

  // Install a hook that records every chrome.webview.postMessage call.
  async installPostMessageHook() {
    await this.eval(`(() => {
      if (!window.__posted) window.__posted = [];
      const current = window.chrome.webview.postMessage;
      if (current && current.__ahkllmPostHook) return;
      const orig = current.bind(window.chrome.webview);
      const wrapped = (m) => {
        window.__posted.push(typeof m === 'string' ? m : JSON.stringify(m));
        return orig(m);
      };
      wrapped.__ahkllmPostHook = true;
      window.chrome.webview.postMessage = wrapped;
    })()`);
  }

  async postedMessages() {
    return await this.eval('window.__posted ? window.__posted.slice() : []');
  }

  async clearPosted() {
    await this.eval('if (window.__posted) window.__posted.length = 0;');
  }
}

module.exports = { CDP };
