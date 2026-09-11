// web-message-router.js - Explicit AHK -> WebView message dispatch.
(function(root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(root);
  else root.WebMessageRouter = factory(root);
})(typeof globalThis !== 'undefined' ? globalThis : this, function(root) {
  'use strict';

  function handleWebMessage(event) {
    try {
      var message = event.data;

      if (typeof message === 'string') {
        try {
          message = JSON.parse(message);
        } catch (e) {
          // Non-JSON messages fall through to the unknown-target path.
        }
      }

      var target = message && message.target;
      var data = message && message.data;

      if (target === 'ack' && root.Ipc) {
        root.Ipc.handleAck(message);
        return;
      }

      if (root.IPCMessages && target) {
        var ipcProblems = root.IPCMessages.validate(target, data, 'ahk->web');
        if (ipcProblems.length && root.console) {
          root.console.error('[IPC] invalid message from AHK "' + target + '": ' + ipcProblems.join('; '));
        }
      }

      switch (target) {
        case 'initChatMode':
          if (typeof root.clearThreadLockOverlay === 'function') root.clearThreadLockOverlay();
          root.initChatMode(data);
          root.renderNavList();
          if (root.AppShell) {
            root.AppShell.hideSettings();
            root.AppShell.showChat();
          }
          break;

        case 'appendChatMessage':
          root.appendChatMessage(data);
          root.renderNavList();
          break;

        case 'updateChatMessage':
          root.updateChatMessage(data);
          break;

        case 'removeLastAssistantMessage':
          root.removeLastAssistantMessage();
          break;

        case 'renderMarkdown':
          root.renderMarkdown(Array.isArray(data) ? data[0] : data);
          break;

        case 'setChatButtonsEnabled':
          root.setChatButtonsEnabled(data);
          break;

        case 'updateTokenUsage':
          root.updateTokenUsage(data);
          break;

        case 'updateChatView':
          root.updateChatMessages(data);
          break;

        case 'renderChatTree':
          root._treeData = data;
          var treeOverlay = root.document && root.document.getElementById('treeOverlay');
          if (treeOverlay && treeOverlay.classList.contains('open')) root.renderChatTree(data);
          break;

        case 'threadList':
          if (Array.isArray(data)) root.loadThreadList(data, []);
          else if (data && data.threads) root.loadThreadList(data.threads, data.folders || []);
          else root.loadThreadList(data, []);
          break;

        case 'trashList':
          if (typeof root.loadTrashList === 'function') root.loadTrashList(data);
          break;

        case 'loadThread':
          root.loadThread(data);
          break;

        case 'threadLocked':
          if (typeof root.handleThreadLocked === 'function') root.handleThreadLocked(data);
          break;

        case 'threadLockInfo':
          if (typeof root.handleThreadLockInfo === 'function') root.handleThreadLockInfo(data);
          break;

        case 'threadForked':
          root.threadForked(data);
          break;

        case 'streamContent':
        case 'streamReasoning':
        case 'streamModelName':
        case 'streamDone':
        case 'streamCancelled':
          root.handleStreamMessage(target, data);
          break;

        case 'assistantList':
          root.assistantList = data;
          if (typeof root.populateAssistantDropdown === 'function') root.populateAssistantDropdown(data);
          break;

        case 'modelList':
          root.modelList = data;
          if (typeof root._populatePopover === 'function') root._populatePopover();
          break;

        case 'showError':
          if (root.ChatErrors) root.ChatErrors.showError(data);
          else if (typeof root.showError === 'function') root.showError(data);
          break;

        case 'threadSettings':
          if (typeof root.populateCurrentSettings === 'function') root.populateCurrentSettings(data);
          break;

        case 'appSettings':
          if (root.SettingsPanel && typeof root.SettingsPanel.onSettingsReceived === 'function') {
            root.SettingsPanel.onSettingsReceived(data);
          }
          break;

        case 'systemMessageFiles':
          if (typeof root.updateSystemMessageFiles === 'function') root.updateSystemMessageFiles(data);
          break;

        case 'showDashboard':
          if (root.AppShell) root.AppShell.showDashboard();
          break;

        case 'showSettings':
          if (root.AppShell) root.AppShell.showSettings();
          break;

        case 'dropdownLabel':
          root._dropdownLabel = data;
          if (typeof root.updateDropdownLabel === 'function') root.updateDropdownLabel(data);
          break;

        case 'searchResults':
          if (typeof root.handleSearchResults === 'function') root.handleSearchResults(data);
          break;

        case 'defaultSettings':
          if (root.SettingsPanel && typeof root.SettingsPanel.reloadWithDefaults === 'function') {
            root.SettingsPanel.reloadWithDefaults(data);
          }
          break;

        case 'settingsSaved':
          if (root.SettingsPanel && typeof root.SettingsPanel.handleSettingsSaved === 'function') {
            root.SettingsPanel.handleSettingsSaved(data);
          }
          break;

        case 'modelPricingRefresh':
          if (root.SettingsModels && typeof root.SettingsModels.handleRefreshResult === 'function') {
            root.SettingsModels.handleRefreshResult(data);
          }
          break;

        case 'openRouterModelLookup':
          if (root.SettingsModels && typeof root.SettingsModels.handleOpenRouterLookupResult === 'function') {
            root.SettingsModels.handleOpenRouterLookupResult(data);
          }
          break;

        case 'codexStatus':
          if (root.SettingsProviders && typeof root.SettingsProviders.handleCodexStatus === 'function') {
            root.SettingsProviders.handleCodexStatus(data);
          }
          break;

        case 'iconFileSelected':
          if (root.SettingsIcons && typeof root.SettingsIcons.onFileSelected === 'function') {
            root.SettingsIcons.onFileSelected(data.field, data.path);
          }
          break;

        case 'completionSoundSelected':
          if (root.SettingsGeneral && typeof root.SettingsGeneral.onCompletionSoundSelected === 'function') {
            root.SettingsGeneral.onCompletionSoundSelected(data.path);
          }
          break;

        case 'backupFolderSelected':
          if (root.SettingsGeneral && typeof root.SettingsGeneral.onFolderSelected === 'function') {
            root.SettingsGeneral.onFolderSelected(data.folder);
          }
          break;

        case 'backupStatus':
          if (root.SettingsGeneral && typeof root.SettingsGeneral.onBackupStatus === 'function') {
            root.SettingsGeneral.onBackupStatus(data);
          }
          break;

        case 'updateTopbarTitle':
          if (typeof root.updateTopbarTitle === 'function') root.updateTopbarTitle(data);
          break;

        case 'updateBranchInfo':
          if (typeof root.updateBranchInfo === 'function') root.updateBranchInfo(data);
          break;

        default:
          if (root.console) root.console.log('Unknown message target:', target);
      }
    } catch (error) {
      if (root.console) root.console.error('Error handling incoming message:', error);
    }
  }

  root.handleWebMessage = handleWebMessage;

  return {
    handle: handleWebMessage
  };
});
