// ipc-contract.test.js - Unit tests for the shared AHK <-> WebView
// message contract (webui/js/shared/ipc-contract.js): registry integrity
// and validate() behavior.
const { describe, it } = require('node:test');
const assert = require('node:assert');
const contract = require('../../webui/js/shared/ipc-contract.js');

describe('ipc-contract registry integrity', () => {
  it('declares unique message names', () => {
    const names = contract.names;
    assert.strictEqual(new Set(names).size, names.length, 'message names must be unique');
  });

  it('uses only valid directions', () => {
    for (const name of contract.names) {
      const dir = contract.messages[name].dir;
      assert.ok(dir === 'ahk->web' || dir === 'web->ahk', name + ' has invalid dir ' + dir);
    }
  });

  it('declares every sidebarAction sub-action used by the app', () => {
    const expected = [
      'createFolder', 'deleteFolder', 'deleteThread', 'deleteThreadForever',
      'loadThread', 'loadThreadList', 'loadTrashList', 'loadTree',
      'moveToFolder', 'navigateToMessage', 'newChat', 'renameFolder',
      'renameThread', 'restoreThread'
    ];
    for (const sa of expected) {
      assert.ok(Array.isArray(contract.subActions[sa]), 'sub-action ' + sa + ' must be declared');
    }
  });
});

describe('ipc-contract validate', () => {
  it('accepts valid messages in both directions', () => {
    assert.deepStrictEqual(contract.validate('initChatMode', { messages: [], threadId: 't1' }, 'ahk->web'), []);
    assert.deepStrictEqual(contract.validate('threadLocked', { threadId: 't1', salt: 'ab', iterations: 1000 }, 'ahk->web'), []);
    assert.deepStrictEqual(contract.validate('threadLockInfo', { threadId: 't1' }, 'ahk->web'), []);
    assert.deepStrictEqual(contract.validate('streamDone', { model: 'm', displayName: '', dbMsg: '', userTokenCount: 0, threadId: 't1' }, 'ahk->web'), []);
    assert.deepStrictEqual(contract.validate('setChatButtonsEnabled', true, 'ahk->web'), []);
    assert.deepStrictEqual(contract.validate('setChatButtonsEnabled', 1, 'ahk->web'), []);
    assert.deepStrictEqual(contract.validate('setChatButtonsEnabled', 0, 'ahk->web'), []);
    assert.deepStrictEqual(contract.validate('trashList', [], 'ahk->web'), []);
    assert.deepStrictEqual(contract.validate('assistantList', [], 'ahk->web'), []);
    assert.deepStrictEqual(contract.validate('streamReasoning', { content: 'thinking', collapsed: 0 }, 'ahk->web'), []);
    assert.deepStrictEqual(contract.validate('systemMessageFiles', { defaultFiles: ['a.txt'], userFiles: ['b.txt'], userFolder: 'C:\\Users\\Test\\AppData\\Roaming\\AhkLLM\\system-messages' }, 'ahk->web'), []);
    assert.deepStrictEqual(contract.validate('chatSend', { message: 'hi' }, 'web->ahk'), []);
    assert.deepStrictEqual(contract.validate('requestSystemMessageFiles', {}, 'web->ahk'), []);
    assert.deepStrictEqual(contract.validate('openSystemMessagesFolder', {}, 'web->ahk'), []);
    assert.deepStrictEqual(contract.validate('openExternalUrl', { url: 'https://example.com' }, 'web->ahk'), []);
    assert.deepStrictEqual(contract.validate('unlockThread', { threadId: 't1', passwordHash: 'h' }, 'web->ahk'), []);
    assert.deepStrictEqual(contract.validate('setThreadLock', { threadId: 't1', mode: 'set', passwordHash: 'h', salt: 's', iterations: 1000, currentPasswordHash: '' }, 'web->ahk'), []);
    assert.deepStrictEqual(contract.validate('lockChatNow', { threadId: 't1' }, 'web->ahk'), []);
    assert.deepStrictEqual(contract.validate('dismissLockedThread', {}, 'web->ahk'), []);
    assert.deepStrictEqual(contract.validate('getThreadLockInfo', { threadId: 't1' }, 'web->ahk'), []);
    assert.deepStrictEqual(contract.validate('chatSend', { message: 'hi', attachments: [] }, 'web->ahk'), []);
    assert.deepStrictEqual(contract.validate('updateModelSettings', { model: 'm', systemMessage: '', reasoning: '', temperature: '', webSearch: false, imageGeneration: false }, 'web->ahk'), []);
    assert.deepStrictEqual(contract.validate('sidebarAction', { subAction: 'moveToFolder', threadId: 't', folderId: 'f' }, 'web->ahk'), []);
    assert.deepStrictEqual(contract.validate('ack', { reqId: 'r1', action: 'saveSettings', ok: true }, 'ahk->web'), []);
  });

  it('flags undeclared message names', () => {
    const problems = contract.validate('madeUpTarget', {}, 'ahk->web');
    assert.ok(problems.some((p) => p.indexOf('undeclared message') >= 0));
  });

  it('flags wrong-direction messages', () => {
    const problems = contract.validate('chatSend', { message: 'x' }, 'ahk->web');
    assert.ok(problems.some((p) => p.indexOf('declared as web->ahk') >= 0));
  });

  it('flags missing required fields', () => {
    const problems = contract.validate('searchMessages', { query: 'x' }, 'web->ahk');
    assert.ok(problems.some((p) => p.indexOf('missing required field "queryId"') >= 0));
  });

  it('flags acks without a correlation id', () => {
    const problems = contract.validate('ack', { action: 'saveSettings', ok: true }, 'ahk->web');
    assert.ok(problems.some((p) => p.indexOf('missing required field "reqId"') >= 0));
  });

  it('flags undeclared payload fields', () => {
    const problems = contract.validate('deleteMessage', { id: 'm1', latencyMs: 5 }, 'web->ahk');
    assert.ok(problems.some((p) => p.indexOf('undeclared field "latencyMs"') >= 0),
      'misspelled field names must be caught (latencyMs vs responseTimeMs class)');
  });

  it('flags unknown sidebarAction sub-actions and missing sub-action fields', () => {
    const unknown = contract.validate('sidebarAction', { subAction: 'explode' }, 'web->ahk');
    assert.ok(unknown.some((p) => p.indexOf('undeclared sidebarAction') >= 0));
    const missing = contract.validate('sidebarAction', { subAction: 'renameThread', threadId: 't' }, 'web->ahk');
    assert.ok(missing.some((p) => p.indexOf('sidebarAction "renameThread" is missing field "title"') >= 0));
  });

  it('distinguishes arrays from plain objects', () => {
    const problems = contract.validate('trashList', {}, 'ahk->web');
    assert.ok(problems.some((p) => p.indexOf('payload should be array') >= 0));
  });

  it('rejects numeric values other than 0/1 for boolean payloads', () => {
    const problems = contract.validate('setChatButtonsEnabled', 2, 'ahk->web');
    assert.ok(problems.some((p) => p.indexOf('payload should be boolean') >= 0));
  });

  it('flags wrong scalar payload types', () => {
    const problems = contract.validate('streamContent', { text: 'x' }, 'ahk->web');
    assert.ok(problems.some((p) => p.indexOf('payload should be string') >= 0));
  });
});
