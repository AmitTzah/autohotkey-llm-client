// main.test.js - Application bootstrap tests.
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadMain({ storedContent = null, isChatMode = false, failWebViewReady = false } = {}) {
  const src = fs.readFileSync(path.resolve(__dirname, '..', '..', 'webui', 'js', 'main.js'), 'utf8');
  const calls = [];
  const documentListeners = {};
  const messageHandler = function() {};

  const sandbox = {
    window: {
      MarkdownRenderer: { create: () => ({ render: () => '' }) },
      WebMessageRouter: { handle: messageHandler },
      ExternalNavigation: { init: () => calls.push('ExternalNavigation.init') },
      AppShell: { init: () => calls.push('AppShell.init') },
      ChatInput: { init: () => calls.push('ChatInput.init') },
      ChatFormat: { init: () => calls.push('ChatFormat.init') },
      ChatSidebar: { init: () => calls.push('ChatSidebar.init') },
      ChatTreeModal: { init: () => calls.push('ChatTreeModal.init') },
      ChatStream: { init: () => calls.push('ChatStream.init') },
      ChatSearch: { init: () => calls.push('ChatSearch.init') },
      ModelPickerConfig: { init: () => calls.push('ModelPickerConfig.init') },
      chrome: { webview: { addEventListener: (name, fn) => calls.push(['webview', name, fn]) } }
    },
    document: {
      addEventListener: (name, fn) => { documentListeners[name] = fn; }
    },
    Ipc: {
      postToHost: (action, data) => {
        if (failWebViewReady && action === 'webViewReady') throw new Error('bridge unavailable');
        calls.push(['ipc', action, data]);
      }
    },
    sessionStorage: {
      getItem: (key) => key === 'preMarkdownText' ? storedContent : null
    },
    renderMarkdown: (content) => calls.push(['renderMarkdown', content]),
    isChatMode,
    console
  };

  vm.runInContext(src, vm.createContext(sandbox));
  return { sandbox, calls, documentListeners, messageHandler };
}

describe('main bootstrap', () => {
  it('registers the extracted WebMessageRouter as the WebView message handler', () => {
    const ctx = loadMain();
    const registration = ctx.calls.find((x) => Array.isArray(x) && x[0] === 'webview');
    assert.ok(registration);
    assert.strictEqual(registration[1], 'message');
    assert.strictEqual(registration[2], ctx.messageHandler);
  });

  it('initializes feature modules and requests initial sidebar data on DOM ready', () => {
    const ctx = loadMain();
    ctx.documentListeners.DOMContentLoaded();

    for (const name of [
      'ExternalNavigation.init',
      'AppShell.init',
      'ChatInput.init',
      'ChatFormat.init',
      'ChatSidebar.init',
      'ChatTreeModal.init',
      'ChatStream.init',
      'ChatSearch.init',
      'ModelPickerConfig.init'
    ]) {
      assert.ok(ctx.calls.includes(name), name + ' should run');
    }

    const ipc = ctx.calls.filter((x) => Array.isArray(x) && x[0] === 'ipc');
    assert.deepStrictEqual(ipc.map((x) => x[1]), ['sidebarAction', 'sidebarAction', 'webViewReady']);
    assert.strictEqual(ipc[0][2].subAction, 'loadThreadList');
    assert.strictEqual(ipc[1][2].subAction, 'loadTrashList');
  });

  it('restores fallback Markdown only outside chat mode', () => {
    const fallback = loadMain({ storedContent: '# saved', isChatMode: false });
    fallback.documentListeners.DOMContentLoaded();
    assert.ok(fallback.calls.some((x) => Array.isArray(x) && x[0] === 'renderMarkdown' && x[1] === '# saved'));

    const chat = loadMain({ storedContent: '# saved', isChatMode: true });
    chat.documentListeners.DOMContentLoaded();
    assert.ok(!chat.calls.some((x) => Array.isArray(x) && x[0] === 'renderMarkdown'));
  });

  it('reports a webViewReady bridge failure without aborting bootstrap', () => {
    const ctx = loadMain({ failWebViewReady: true });
    const errors = [];
    ctx.sandbox.console = { error: (...args) => errors.push(args) };
    assert.doesNotThrow(() => ctx.documentListeners.DOMContentLoaded());
    assert.strictEqual(errors.length, 1);
    assert.match(String(errors[0][0]), /Failed to notify webViewReady/);
  });

  it('contains composition only, not feature implementations', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '..', '..', 'webui', 'js', 'main.js'), 'utf8');
    assert.doesNotMatch(src, /switch\s*\(target\)/);
    assert.doesNotMatch(src, /function\s+showError/);
    assert.doesNotMatch(src, /function\s+showSettings/);
    assert.doesNotMatch(src, /_handleExternalLinkClick/);
  });
});
