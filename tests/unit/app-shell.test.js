// app-shell.test.js
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function makeEl() {
  return {
    style: { display: '' },
    offsetWidth: 340,
    classList: {
      values: new Set(),
      add(x) { this.values.add(x); },
      remove(x) { this.values.delete(x); },
      contains(x) { return this.values.has(x); }
    },
    listeners: {},
    addEventListener(name, fn) { this.listeners[name] = fn; },
    removeEventListener() {},
    querySelectorAll() { return []; }
  };
}

function loadModule() {
  const src = fs.readFileSync(path.resolve(__dirname, '..', '..', 'webui', 'js', 'app-shell.js'), 'utf8');
  const ids = {};
  for (const id of ['chat-layout','dashboard-panel','settingsNav','railLeft','settingsCenter','settings-icon','dashboard-icon','sidebar-toggle','confirmModalTitle','confirmModalMsg','confirmBtn','confirmModal','cmdHelpBtn','cmdHelpModal']) {
    ids[id] = makeEl();
  }
  ids.settingsNav.style.display = 'none';
  ids.settingsCenter.style.display = 'none';
  ids.dashboardPanel = ids['dashboard-panel'];

  const posts = [];
  const sandbox = {
    document: { getElementById: (id) => ids[id] || null },
    Ipc: { postToHost: (action, data) => posts.push({ action, data }) },
    SettingsPanel: {
      init() {},
      isDirty: () => false,
      clearDirty() {}
    },
    loadData() { sandbox.loadDataCalled = true; },
    toggleSidebar() { sandbox.toggleSidebarCalled = true; },
    console
  };
  sandbox.window = sandbox;
  vm.runInContext(src, vm.createContext(sandbox));
  return { sandbox, ids, posts };
}

describe('AppShell', () => {
  it('shows Settings and requests settings only when opening it', () => {
    const ctx = loadModule();
    ctx.sandbox.AppShell.showSettings();

    assert.strictEqual(ctx.ids['chat-layout'].style.display, 'none');
    assert.strictEqual(ctx.ids.settingsNav.style.display, '');
    assert.strictEqual(ctx.posts.length, 1);
    assert.strictEqual(ctx.posts[0].action, 'requestAllSettings');

    ctx.sandbox.AppShell.showSettings();
    assert.strictEqual(ctx.posts.length, 1, 'already-open settings must not re-request and wipe edits');
  });

  it('shows Dashboard through the full settings-safe transition', () => {
    const ctx = loadModule();
    ctx.ids.settingsNav.style.display = '';
    ctx.sandbox.AppShell.showDashboard();

    assert.strictEqual(ctx.ids.settingsNav.style.display, 'none');
    assert.strictEqual(ctx.ids['dashboard-panel'].style.display, 'flex');
    assert.strictEqual(ctx.ids['chat-layout'].style.display, 'none');
    assert.strictEqual(ctx.sandbox.loadDataCalled, true);
  });

  it('exports compatibility aliases used by existing callers', () => {
    const ctx = loadModule();
    assert.strictEqual(ctx.sandbox._showChat, ctx.sandbox.AppShell.showChat);
    assert.strictEqual(ctx.sandbox._showSettings, ctx.sandbox.AppShell.showSettings);
    assert.strictEqual(ctx.sandbox._hideSettings, ctx.sandbox.AppShell.hideSettings);
    assert.strictEqual(ctx.sandbox._showConfirm, ctx.sandbox.AppShell.showConfirm);
  });
});
