// external-navigation.test.js
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadModule() {
  const src = fs.readFileSync(path.resolve(__dirname, '..', '..', 'webui', 'js', 'shared', 'external-navigation.js'), 'utf8');
  const posts = [];
  const listeners = {};
  const sandbox = {
    document: { addEventListener: (name, fn) => { listeners[name] = fn; } },
    Ipc: { postToHost: (action, data) => posts.push({ action, data }) },
    console
  };
  sandbox.window = sandbox;
  vm.runInContext(src, vm.createContext(sandbox));
  return { sandbox, posts, listeners };
}

describe('ExternalNavigation', () => {
  it('hands HTTP(S) links to the host and prevents WebView navigation', () => {
    const ctx = loadModule();
    ctx.sandbox.ExternalNavigation.init();

    let prevented = false;
    const target = { closest: () => ({ href: 'https://example.com/news?id=42' }) };
    ctx.listeners.click({ target, preventDefault: () => { prevented = true; } });

    assert.strictEqual(prevented, true);
    assert.deepStrictEqual(JSON.parse(JSON.stringify(ctx.posts)), [{
      action: 'openExternalUrl',
      data: { url: 'https://example.com/news?id=42' }
    }]);
  });

  it('does not hand non-HTTP(S) schemes to the host', () => {
    const ctx = loadModule();
    ctx.sandbox.ExternalNavigation.init();

    for (const href of ['javascript:alert(1)', 'file:///C:/Windows/System32/calc.exe', 'mailto:test@example.com']) {
      let prevented = false;
      ctx.listeners.click({
        target: { closest: () => ({ href }) },
        preventDefault: () => { prevented = true; }
      });
      assert.strictEqual(prevented, false, href);
    }

    assert.strictEqual(ctx.posts.length, 0);
  });

  it('initializes only once', () => {
    const ctx = loadModule();
    ctx.sandbox.ExternalNavigation.init();
    const first = ctx.listeners.click;
    ctx.sandbox.ExternalNavigation.init();
    assert.strictEqual(ctx.listeners.click, first);
  });
});
