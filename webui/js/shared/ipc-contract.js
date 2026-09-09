// ======================================================
// ipc-contract.js - Single source of truth for the
// AHK <-> WebView message contract.
//
// Every message crossing the WebView boundary is declared
// here: direction, allowed payload fields, and required
// fields. main.js validates incoming AHK messages and
// ipc.js validates outgoing Web messages (console.error in
// dev; never throws). scripts/check-ipc-contract.js scans
// the sources for postWebMessage(...)/action: '...' names
// and fails when any posted message is not declared here,
// so message names can no longer drift silently.
//
// Works both as a browser script (window.IPCMessages) and
// as a CommonJS module (node tests / check scripts).
// ======================================================
(function(root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.IPCMessages = factory();
})(typeof self !== 'undefined' ? self : this, function() {
  'use strict';

  // dir: 'ahk->web' (AHK posts, WebView receives) | 'web->ahk' (WebView posts, AHK receives)
  // data: type hint for scalar payloads ('string'|'boolean'|'array'|'object'|'any')
  // fields: allowed object keys; required: keys that must be present.
  var messages = {
    // ---------- AHK -> WebView ----------
    'initChatMode': { dir: 'ahk->web', fields: ['messages', 'threadId'], required: ['messages', 'threadId'] },
    'appendChatMessage': { dir: 'ahk->web', data: 'object' },
    'updateChatMessage': { dir: 'ahk->web', data: 'object' },
    'streamContent': { dir: 'ahk->web', data: 'string' },
    'streamReasoning': { dir: 'ahk->web', data: 'object' },
    'streamModelName': { dir: 'ahk->web', fields: ['name', 'provider', 'threadId'], required: ['name'] },
    'streamDone': { dir: 'ahk->web', fields: ['model', 'displayName', 'provider', 'dbMsg', 'userTokenCount', 'threadId'], required: ['model'] },
    'streamCancelled': { dir: 'ahk->web', data: 'any' },
    'setChatButtonsEnabled': { dir: 'ahk->web', data: 'boolean' },
    'updateTokenUsage': { dir: 'ahk->web', data: 'object' },
    'renderChatTree': { dir: 'ahk->web', data: 'any' },
    'threadList': { dir: 'ahk->web', fields: ['threads', 'folders'], required: ['threads', 'folders'] },
    'threadLocked': { dir: 'ahk->web', fields: ['threadId', 'salt', 'iterations'], required: ['threadId'] },
    'threadLockInfo': { dir: 'ahk->web', fields: ['threadId', 'salt', 'iterations'], required: ['threadId'] },
    'trashList': { dir: 'ahk->web', data: 'array' },
    'loadThread': { dir: 'ahk->web', data: 'string' },
    'threadForked': { dir: 'ahk->web', fields: ['newThreadId'], required: ['newThreadId'] },
    'showError': { dir: 'ahk->web', fields: ['message', 'threadId'], required: ['message'] },
    'showDashboard': { dir: 'ahk->web', data: 'any' },
    'showSettings': { dir: 'ahk->web', data: 'any' },
    'threadSettings': { dir: 'ahk->web', fields: ['model', 'systemMessage', 'systemOverrideSet', 'reasoning', 'temperature', 'reasoningOverrideSet', 'temperatureOverrideSet', 'webSearch', 'fontSize', 'assistantName', 'assistantBaseModel', 'assistantDescription', 'thinkingLevels', 'supportsTemperature'], required: ['model'] },
    'appSettings': { dir: 'ahk->web', data: 'object' },
    'defaultSettings': { dir: 'ahk->web', data: 'object' },
    'settingsSaved': { dir: 'ahk->web', fields: ['success', 'error'], required: ['success'] },
    'systemMessageFiles': { dir: 'ahk->web', fields: ['defaultFiles', 'userFiles', 'userFolder'], required: ['defaultFiles', 'userFiles', 'userFolder'] },
    'dropdownLabel': { dir: 'ahk->web', fields: ['text', 'isAssistant'], required: ['text', 'isAssistant'] },
    'assistantList': { dir: 'ahk->web', data: 'array' },
    'modelList': { dir: 'ahk->web', data: 'object' },
    'updateTopbarTitle': { dir: 'ahk->web', fields: ['text', 'folder'], required: ['text', 'folder'] },
    'searchResults': { dir: 'ahk->web', fields: ['results', 'query', 'threadId', 'queryId'], required: ['results', 'query', 'threadId', 'queryId'] },
    'updateBranchInfo': { dir: 'ahk->web', fields: ['msgId', 'siblingInfo'], required: ['msgId', 'siblingInfo'] },
    'updateChatView': { dir: 'ahk->web', data: 'array' },
    'iconFileSelected': { dir: 'ahk->web', fields: ['field', 'path'], required: ['field', 'path'] },
    'backupFolderSelected': { dir: 'ahk->web', fields: ['folder'], required: ['folder'] },
    'backupStatus': { dir: 'ahk->web', data: 'object' },
    'modelPricingRefresh': { dir: 'ahk->web', fields: ['success', 'models', 'warnings', 'error'], required: ['success'] },
    'openRouterModelLookup': { dir: 'ahk->web', fields: ['success', 'reqId', 'modelId', 'resolvedModelId', 'raw', 'error'], required: ['success', 'reqId', 'modelId'] },
    'codexStatus': { dir: 'ahk->web', fields: ['installed', 'version', 'supported', 'authenticated', 'message', 'error'], required: ['installed', 'supported', 'authenticated'] },
    'ack': { dir: 'ahk->web', fields: ['reqId', 'action', 'ok', 'error'], required: ['reqId', 'action', 'ok'] },

    // ---------- WebView -> AHK ----------
    'chatSend': { dir: 'web->ahk', fields: ['message', 'attachments', 'latencyTraceId'], required: ['message'] },
    'editMessage': { dir: 'web->ahk', fields: ['id', 'content', 'mode', 'removedAttachmentIds'], required: ['id', 'content', 'mode'] },
    'retry': { dir: 'web->ahk', data: 'any' },
    'deleteMessage': { dir: 'web->ahk', fields: ['id'], required: ['id'] },
    'deleteAttachment': { dir: 'web->ahk', fields: ['id'], required: ['id'] },
    'forkChat': { dir: 'web->ahk', fields: ['id'], required: ['id'] },
    'switchBranch': { dir: 'web->ahk', fields: ['id', 'direction'], required: ['id', 'direction'] },
    'sidebarAction': { dir: 'web->ahk', fields: ['subAction', 'threadId', 'folderId', 'name', 'title', 'messageId'], required: ['subAction'] },
    'searchMessages': { dir: 'web->ahk', fields: ['query', 'queryId', 'threadId'], required: ['query', 'queryId'] },
    'hideWindow': { dir: 'web->ahk', data: 'any' },
    'switchAssistant': { dir: 'web->ahk', fields: ['assistantId'], required: ['assistantId'] },
    'updateModelSettings': { dir: 'web->ahk', fields: ['model', 'systemMessage', 'systemOverrideSet', 'reasoning', 'temperature', 'reasoningOverrideSet', 'temperatureOverrideSet', 'webSearch'], required: ['model', 'systemMessage', 'reasoning', 'temperature', 'webSearch'] },
    'cancelStream': { dir: 'web->ahk', data: 'any' },
    'requestAssistantList': { dir: 'web->ahk', data: 'any' },
    'requestCurrentSettings': { dir: 'web->ahk', data: 'any' },
    'requestAllSettings': { dir: 'web->ahk', data: 'any' },
    'requestDefaultSettings': { dir: 'web->ahk', data: 'any' },
    'requestSystemMessageFiles': { dir: 'web->ahk', data: 'any' },
    'openSystemMessagesFolder': { dir: 'web->ahk', data: 'any' },
    'saveSettings': { dir: 'web->ahk', fields: ['data'], required: ['data'] },
    'refreshModelPricing': { dir: 'web->ahk', fields: ['providers'] },
    'lookupOpenRouterModel': { dir: 'web->ahk', fields: ['modelId'], required: ['modelId'] },
    'checkCodex': { dir: 'web->ahk', data: 'any' },
    'showApiLogs': { dir: 'web->ahk', data: 'any' },
    'debugLog': { dir: 'web->ahk', fields: ['message'], required: ['message'] },
    'webViewReady': { dir: 'web->ahk', data: 'any' },
    'browseIcon': { dir: 'web->ahk', fields: ['field'], required: ['field'] },
    'browseBackupFolder': { dir: 'web->ahk', fields: ['folder'], required: ['folder'] },
    'backupNow': { dir: 'web->ahk', fields: ['backup'], required: ['backup'] },
    'unlockThread': { dir: 'web->ahk', fields: ['threadId', 'passwordHash'], required: ['threadId', 'passwordHash'] },
    'setThreadLock': { dir: 'web->ahk', fields: ['threadId', 'mode', 'passwordHash', 'salt', 'iterations', 'currentPasswordHash'], required: ['threadId', 'mode', 'passwordHash', 'salt', 'iterations'] },
    'lockChatNow': { dir: 'web->ahk', fields: ['threadId'], required: ['threadId'] },
    'dismissLockedThread': { dir: 'web->ahk', data: 'any' },
    'getThreadLockInfo': { dir: 'web->ahk', fields: ['threadId'], required: ['threadId'] },
    'reloadScript': { dir: 'web->ahk', data: 'any' },
    'updateFontSize': { dir: 'web->ahk', fields: ['fontSize'], required: ['fontSize'] }
  };

  // sidebarAction sub-action -> required payload fields.
  var subActions = {
    'createFolder': ['name'],
    'deleteFolder': ['folderId'],
    'deleteThread': ['threadId'],
    'deleteThreadForever': ['threadId'],
    'loadThread': ['threadId'],
    'loadThreadList': [],
    'loadTrashList': [],
    'loadTree': [],
    'moveToFolder': ['threadId', 'folderId'],
    'navigateToMessage': ['messageId'],
    'newChat': [],
    'renameFolder': ['folderId', 'name'],
    'renameThread': ['threadId', 'title'],
    'restoreThread': ['threadId']
  };

  function typeOf(value) {
    if (value === null) return 'null';
    if (Array.isArray(value)) return 'array';
    return typeof value;
  }

  // Validate a message against the contract. Returns an array of problem
  // strings (empty when valid). Never throws - callers decide how to surface.
  function validate(target, data, dir) {
    var problems = [];
    var m = messages[target];
    if (!m) {
      problems.push('undeclared message "' + target + '" (add it to shared/ipc-contract.js)');
      return problems;
    }
    if (m.dir !== dir) {
      problems.push('message "' + target + '" is declared as ' + m.dir + ' but was sent as ' + dir);
      return problems;
    }
    if (m.data) {
      var typeMatches = typeOf(data) === m.data;
      if (m.data === 'boolean' && (typeof data === 'boolean' || data === 0 || data === 1)) typeMatches = true;
      if (m.data !== 'any' && !typeMatches) {
        problems.push('payload should be ' + m.data + ', got ' + typeOf(data));
      }
      return problems;
    }
    if (typeOf(data) !== 'object') {
      problems.push('payload should be an object, got ' + typeOf(data));
      return problems;
    }
    (m.required || []).forEach(function(f) {
      if (data[f] === undefined) problems.push('missing required field "' + f + '"');
    });
    if (m.fields) {
      Object.keys(data).forEach(function(k) {
        if (m.fields.indexOf(k) < 0) problems.push('undeclared field "' + k + '" (allowed: ' + m.fields.join(', ') + ')');
      });
    }
    if (target === 'sidebarAction') {
      var required = subActions[data.subAction];
      if (!required) {
        problems.push('undeclared sidebarAction "' + data.subAction + '"');
      } else {
        required.forEach(function(f) {
          if (data[f] === undefined) problems.push('sidebarAction "' + data.subAction + '" is missing field "' + f + '"');
        });
      }
    }
    return problems;
  }

  function namesFor(dir) {
    var out = [];
    for (var k in messages) if (messages[k].dir === dir) out.push(k);
    return out.sort();
  }

  return {
    messages: messages,
    subActions: subActions,
    validate: validate,
    namesFor: namesFor,
    names: Object.keys(messages).sort()
  };
});
