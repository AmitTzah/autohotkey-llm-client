// web-message-router.test.js
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadRouter() {
  const src = fs.readFileSync(path.resolve(__dirname, '..', '..', 'webui', 'js', 'shared', 'web-message-router.js'), 'utf8');
  const calls = {};
  const sandbox = {
    document: {
      getElementById: () => null
    },
    Ipc: {
      handleAck: (message) => { calls.ack = message; }
    },
    IPCMessages: {
      validate: () => []
    },
    AppShell: {
      hideSettings: () => { calls.hideSettings = true; },
      showChat: () => { calls.showChat = true; },
      showDashboard: () => { calls.showDashboard = true; },
      showSettings: () => { calls.showSettings = true; }
    },
    ChatErrors: {
      showError: (data) => { calls.showError = data; }
    },
    SettingsPanel: {
      onSettingsReceived: (data) => { calls.onSettingsReceived = data; },
      reloadWithDefaults: (data) => { calls.reloadWithDefaults = data; },
      handleSettingsSaved: (data) => { calls.handleSettingsSaved = data; }
    },
    SettingsProviders: {
      handleCodexStatus: (data) => { calls.codexStatus = data; }
    },
    SettingsModels: {},
    SettingsIcons: {},
    SettingsGeneral: {},
    initChatMode: (data) => { calls.initChatMode = data; },
    renderNavList: () => { calls.renderNavList = true; },
    appendChatMessage: (data) => { calls.appendChatMessage = data; },
    updateChatMessage: (data) => { calls.updateChatMessage = data; },
    removeLastAssistantMessage: () => { calls.removeLastAssistantMessage = true; },
    renderMarkdown: (data) => { calls.renderMarkdown = data; },
    setChatButtonsEnabled: (data) => { calls.setChatButtonsEnabled = data; },
    updateTokenUsage: (data) => { calls.updateTokenUsage = data; },
    updateChatMessages: (data) => { calls.updateChatMessages = data; },
    loadThreadList: (threads, folders) => { calls.loadThreadList = { threads, folders }; },
    loadTrashList: (data) => { calls.loadTrashList = data; },
    loadThread: (data) => { calls.loadThread = data; },
    threadForked: (data) => { calls.threadForked = data; },
    handleStreamMessage: (target, data) => { calls.stream = { target, data }; },
    populateAssistantDropdown: (data) => { calls.assistantList = data; },
    populateCurrentSettings: (data) => { calls.threadSettings = data; },
    updateDropdownLabel: (data) => { calls.dropdownLabel = data; },
    handleSearchResults: (data) => { calls.searchResults = data; },
    updateTopbarTitle: (data) => { calls.updateTopbarTitle = data; },
    updateBranchInfo: (data) => { calls.updateBranchInfo = data; },
    console: { log() {}, error() {} }
  };
  sandbox.window = sandbox;
  vm.runInContext(src, vm.createContext(sandbox));
  return { sandbox, calls };
}

function send(ctx, target, data) {
  ctx.sandbox.WebMessageRouter.handle({ data: JSON.stringify({ target, data }) });
}

describe('WebMessageRouter', () => {
  it('routes initChatMode and returns the shell to Chat', () => {
    const ctx = loadRouter();
    const data = [{ id: '1', role: 'user', content: 'hi' }];
    send(ctx, 'initChatMode', data);
    assert.strictEqual(ctx.calls.initChatMode[0].id, '1');
    assert.strictEqual(ctx.calls.renderNavList, true);
    assert.strictEqual(ctx.calls.hideSettings, true);
    assert.strictEqual(ctx.calls.showChat, true);
  });

  it('routes append, stream, thread-list and load-thread messages', () => {
    const ctx = loadRouter();
    send(ctx, 'appendChatMessage', { id: '2' });
    assert.strictEqual(ctx.calls.appendChatMessage.id, '2');

    send(ctx, 'streamContent', 'token');
    assert.deepStrictEqual(ctx.calls.stream, { target: 'streamContent', data: 'token' });

    send(ctx, 'streamDone', { model: 'gpt-5.6' });
    assert.strictEqual(ctx.calls.stream.target, 'streamDone');

    send(ctx, 'threadList', [{ id: 't1' }]);
    assert.strictEqual(ctx.calls.loadThreadList.threads[0].id, 't1');
    assert.deepStrictEqual(JSON.parse(JSON.stringify(ctx.calls.loadThreadList.folders)), []);

    send(ctx, 'loadThread', 'thread-1');
    assert.strictEqual(ctx.calls.loadThread, 'thread-1');
  });

  it('keeps app settings and thread settings on separate consumers', () => {
    const ctx = loadRouter();
    send(ctx, 'threadSettings', { model: 'deepseek/deepseek-v4-flash', systemMessage: 'keep me' });
    assert.strictEqual(ctx.calls.threadSettings.systemMessage, 'keep me');
    assert.strictEqual(ctx.calls.onSettingsReceived, undefined);

    send(ctx, 'appSettings', { commands: [], assistants: [], models: {} });
    assert.ok(ctx.calls.onSettingsReceived);
    assert.strictEqual(ctx.calls.threadSettings.systemMessage, 'keep me');
  });

  it('routes settings/provider and shell messages explicitly', () => {
    const ctx = loadRouter();
    send(ctx, 'codexStatus', { installed: true });
    assert.strictEqual(ctx.calls.codexStatus.installed, true);

    send(ctx, 'showDashboard', {});
    assert.strictEqual(ctx.calls.showDashboard, true);

    send(ctx, 'showSettings', {});
    assert.strictEqual(ctx.calls.showSettings, true);
  });

  it('routes errors through ChatErrors', () => {
    const ctx = loadRouter();
    send(ctx, 'showError', { message: 'Oops', threadId: 't1' });
    assert.strictEqual(ctx.calls.showError.message, 'Oops');
    assert.strictEqual(ctx.calls.showError.threadId, 't1');
  });

  it('handles already-serialized JSON messages', () => {
    const ctx = loadRouter();
    ctx.sandbox.WebMessageRouter.handle({ data: '{"target":"loadThread","data":"thread-123"}' });
    assert.strictEqual(ctx.calls.loadThread, 'thread-123');
  });

  it('routes legacy title/branch targets through explicit cases', () => {
    const ctx = loadRouter();
    send(ctx, 'updateTopbarTitle', { text: 'Renamed', folder: 'Work' });
    assert.strictEqual(ctx.calls.updateTopbarTitle.text, 'Renamed');

    send(ctx, 'updateBranchInfo', { msgId: 'm1', siblingInfo: { index: 1, total: 2 } });
    assert.strictEqual(ctx.calls.updateBranchInfo.siblingInfo.total, 2);
  });

  it('does not invoke arbitrary globals for unknown targets', () => {
    const ctx = loadRouter();
    ctx.sandbox.dangerousGlobal = () => { ctx.calls.dangerousGlobal = true; };
    send(ctx, 'dangerousGlobal', {});
    assert.strictEqual(ctx.calls.dangerousGlobal, undefined);
  });

  it('resolves ack messages before normal UI dispatch', () => {
    const ctx = loadRouter();
    ctx.sandbox.WebMessageRouter.handle({ data: { target: 'ack', requestId: 'r1', ok: true } });
    assert.strictEqual(ctx.calls.ack.requestId, 'r1');
  });
});
