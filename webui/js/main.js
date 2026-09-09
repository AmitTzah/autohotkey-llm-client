// main.js — WebView message routing and application initialization.

window.chrome.webview.addEventListener('message', handleWebMessage);

// Initialize markdown-it with options
var md = window.markdownit({
  // Raw model/user HTML must remain inert because this WebView can message the host.
  // markdown-it escapes inline HTML when html is false.
  html: false,
  // Preserve single-newline soft breaks in model and pasted user content.
  // Structural newlines inside code blocks, lists, and tables are unaffected.
  breaks: true,
  linkify: true,
  typographer: true,
  highlight: function (str, lang) {
    var langLabel = escHtml(lang || 'text');
    var headerHtml = '<div class="code-block-actions-sticky">' +
      '<button class="code-action-btn" title="Copy code" onclick="copyCodeBlock(this)"><i data-lucide="copy" style="width:22px;height:22px;"></i></button>' +
      '<button class="code-action-btn" title="Download" onclick="downloadCodeBlock(this)"><i data-lucide="download" style="width:22px;height:22px;"></i></button>' +
    '</div>' +
    '<div class="code-block-header">' +
      '<span class="code-lang">' + langLabel + '</span>' +
    '</div>';
    if (lang && hljs.getLanguage(lang)) {
      try {
        return '<div class="code-block-wrapper">' + headerHtml +
          '<pre class="hljs"><code>' +
          hljs.highlight(str, { language: lang, ignoreIllegals: true }).value +
          '</code></pre></div>';
      } catch (__) { }
    }
    return '<div class="code-block-wrapper">' + headerHtml +
      '<pre class="hljs"><code>' + md.utils.escapeHtml(str) + '</code></pre></div>';
  }
})
  .use(window.texmath, {
    engine: window.katex,
    delimiters: 'dollars',
    katexOptions: { macros: { "\\RR": "\\mathbb{R}" } }
  });

// Main message handler from AHK
function handleWebMessage(event) {
  try {
    var message = event.data;

    // Handle JSON string messages from AHK
    if (typeof message === 'string') {
      try {
        message = JSON.parse(message);
      } catch (e) {
        // Not JSON — pass through
      }
    }

    var target = message.target;
    var data = message.data;

    // Acks resolve pending Ipc.request() promises - handle them before the
    // regular message switch (they are not UI messages).
    if (target === 'ack' && typeof Ipc !== 'undefined') {
      Ipc.handleAck(message);
      return;
    }

    // Validate every incoming AHK message against the shared IPC contract.
    // Dev-time guard: report contract violations loudly, never throw.
    if (typeof IPCMessages !== 'undefined' && target) {
      var ipcProblems = IPCMessages.validate(target, data, 'ahk->web');
      if (ipcProblems.length) {
        console.error('[IPC] invalid message from AHK "' + target + '": ' + ipcProblems.join('; '));
      }
    }

    switch (target) {
      case 'initChatMode':
        if (typeof clearThreadLockOverlay === 'function') clearThreadLockOverlay();
        initChatMode(data);
        renderNavList();
        // Switch to chat view if currently on settings/dashboard
        if (typeof window._hideSettings === 'function') window._hideSettings();
        if (typeof window._showChat === 'function') window._showChat();
        break;

      case 'appendChatMessage':
        appendChatMessage(data);
        renderNavList();
        break;

      case 'updateChatMessage':
        updateChatMessage(data);
        break;

      case 'removeLastAssistantMessage':
        removeLastAssistantMessage();
        break;

      case 'renderMarkdown':
        renderMarkdown(Array.isArray(data) ? data[0] : data);
        break;

      case 'setChatButtonsEnabled':
        setChatButtonsEnabled(data);
        break;

      case 'updateTokenUsage':
        updateTokenUsage(data);
        break;

      case 'updateChatView':
        updateChatMessages(data);
        break;

      case 'renderChatTree':
        window._treeData = data;
        var treeOverlay = document.getElementById('treeOverlay');
        if (treeOverlay && treeOverlay.classList.contains('open')) {
          renderChatTree(data);
        }
        break;

      case 'threadList':
        if (Array.isArray(data)) {
          loadThreadList(data, []);
        } else if (data && data.threads) {
          loadThreadList(data.threads, data.folders || []);
        } else {
          loadThreadList(data, []);
        }
        break;

      case 'trashList':
        if (typeof loadTrashList === 'function') loadTrashList(data);
        break;

      case 'loadThread':
        loadThread(data);
        break;

      case 'threadLocked':
        if (typeof handleThreadLocked === 'function') handleThreadLocked(data);
        break;

      case 'threadLockInfo':
        if (typeof handleThreadLockInfo === 'function') handleThreadLockInfo(data);
        break;

      case 'threadForked':
        threadForked(data);
        break;

      case 'streamContent':
      case 'streamReasoning':
      case 'streamModelName':
      case 'streamDone':
      case 'streamCancelled':
        handleStreamMessage(target, data);
        break;

      case 'assistantList':
        window.assistantList = data;
        if (typeof populateAssistantDropdown === 'function') populateAssistantDropdown(data);
        break;

      case 'modelList':
        window.modelList = data;
        if (typeof _populatePopover === 'function') _populatePopover();
        break;

      case 'showError':
        showError(data);
        break;

      case 'threadSettings':
        // Right-rail per-thread payload (requestCurrentSettings). Must not be
        // routed anywhere else - it only feeds the right rail.
        if (typeof populateCurrentSettings === 'function') populateCurrentSettings(data);
        break;

      case 'appSettings':
        // Full merged settings payload (requestAllSettings). Only the settings
        // panel consumes it; the right rail receives threadSettings separately.
        if (window.SettingsPanel && typeof window.SettingsPanel.onSettingsReceived === 'function') {
          window.SettingsPanel.onSettingsReceived(data);
        }
        break;

      case 'systemMessageFiles':
        if (typeof window.updateSystemMessageFiles === 'function') window.updateSystemMessageFiles(data);
        break;

      case 'showDashboard':
        if (typeof window._showDashboard === 'function') window._showDashboard();
        break;

      case 'showSettings':
        if (typeof window._showSettings === 'function') window._showSettings();
        break;

      case 'dropdownLabel':
        window._dropdownLabel = data;
        if (typeof updateDropdownLabel === 'function') updateDropdownLabel(data);
        break;

      case 'searchResults':
        if (typeof handleSearchResults === 'function') handleSearchResults(data);
        break;

      case 'defaultSettings':
        if (window.SettingsPanel && typeof window.SettingsPanel.reloadWithDefaults === 'function') {
          window.SettingsPanel.reloadWithDefaults(data);
        }
        break;

      case 'settingsSaved':
        if (window.SettingsPanel && typeof window.SettingsPanel.handleSettingsSaved === 'function') {
          window.SettingsPanel.handleSettingsSaved(data);
        }
        break;

      case 'modelPricingRefresh':
        if (window.SettingsModels && typeof window.SettingsModels.handleRefreshResult === 'function') {
          window.SettingsModels.handleRefreshResult(data);
        }
        break;

      case 'openRouterModelLookup':
        if (window.SettingsModels && typeof window.SettingsModels.handleOpenRouterLookupResult === 'function') {
          window.SettingsModels.handleOpenRouterLookupResult(data);
        }
        break;

      case 'codexStatus':
        if (window.SettingsProviders && typeof window.SettingsProviders.handleCodexStatus === 'function') {
          window.SettingsProviders.handleCodexStatus(data);
        }
        break;

      case 'iconFileSelected':
        if (window.SettingsIcons && typeof window.SettingsIcons.onFileSelected === 'function') {
          window.SettingsIcons.onFileSelected(data.field, data.path);
        }
        break;

      case 'backupFolderSelected':
        if (window.SettingsGeneral && typeof window.SettingsGeneral.onFolderSelected === 'function') {
          window.SettingsGeneral.onFolderSelected(data.folder);
        }
        break;

      case 'backupStatus':
        if (window.SettingsGeneral && typeof window.SettingsGeneral.onBackupStatus === 'function') {
          window.SettingsGeneral.onBackupStatus(data);
        }
        break;

      case 'updateTopbarTitle':
        if (typeof updateTopbarTitle === 'function') updateTopbarTitle(data);
        break;

      case 'updateBranchInfo':
        if (typeof updateBranchInfo === 'function') updateBranchInfo(data);
        break;

      default:
        // Never dispatch unknown targets dynamically: target names cross a trust
        // boundary and must not become arbitrary global function calls.
        console.log('Unknown message target:', target);
    }
  } catch (error) {
    console.error('Error handling incoming message:', error);
  }
}

// Attach event listeners when DOM is ready
document.addEventListener('DOMContentLoaded', function () {
  // Dashboard toggle via icon rail
  var chatLayout = document.getElementById('chat-layout');
  var dashPanel = document.getElementById('dashboard-panel');
  function showDashboard() {
    if (chatLayout) chatLayout.style.display = 'none';
    if (dashPanel) { dashPanel.style.display = 'flex'; if (typeof loadData === 'function') loadData(); }
    var di = document.getElementById('dashboard-icon'); if (di) di.classList.add('active');
    var st = document.getElementById('sidebar-toggle'); if (st) st.classList.remove('active');
  }
  function showChat() {
    if (chatLayout) chatLayout.style.display = '';
    if (dashPanel) dashPanel.style.display = 'none';
    var di = document.getElementById('dashboard-icon'); if (di) di.classList.remove('active');
    var st = document.getElementById('sidebar-toggle'); if (st) st.classList.add('active');
  }
  // Quick Access/IPC bypasses the dashboard rail click handler. Export the
  // full navigation transition so Settings is never left mounted beside it.
  window._showDashboard = function() {
    confirmDiscardSettings(function() {
      hideSettings();
      showDashboard();
    });
  };
  window._showChat = showChat;

  // Settings show/hide — settingsNav replaces railLeft, settingsCenter replaces
  // the chat/dashboard center; railRight and seams stay untouched.
  function showSettings() {
    var settingsNav = document.getElementById('settingsNav');
    var alreadyOpen = settingsNav && settingsNav.style.display !== 'none';

    if (chatLayout) chatLayout.style.display = 'none';
    if (dashPanel) dashPanel.style.display = 'none';
    var railLeft = document.getElementById('railLeft');
    if (railLeft) railLeft.style.display = 'none';
    if (settingsNav) {
      settingsNav.style.display = '';
      // Restore width if the nav was collapsed (notch or auto-collapse)
      if (settingsNav.offsetWidth < 40) {
        settingsNav.style.width = '340px';
        settingsNav.classList.remove('mini');
      }
    }
    var settingsCenter = document.getElementById('settingsCenter');
    if (settingsCenter) settingsCenter.style.display = '';
    var si = document.getElementById('settings-icon');
    if (si) si.classList.add('active');
    var di = document.getElementById('dashboard-icon');
    if (di) di.classList.remove('active');
    var st = document.getElementById('sidebar-toggle');
    if (st) st.classList.remove('active');
    if (window.SettingsPanel && typeof window.SettingsPanel.init === 'function') {
      window.SettingsPanel.init();
    }
    // Don't re-request when already open — that would wipe unsaved edits
    if (!alreadyOpen) {
      Ipc.postToHost('requestAllSettings');
    }
  }

  function hideSettings() {
    var settingsNav = document.getElementById('settingsNav');
    if (settingsNav) settingsNav.style.display = 'none';
    var settingsCenter = document.getElementById('settingsCenter');
    if (settingsCenter) settingsCenter.style.display = 'none';
    var railLeft = document.getElementById('railLeft');
    if (railLeft) railLeft.style.display = '';
    if (chatLayout) chatLayout.style.display = '';
    var si = document.getElementById('settings-icon');
    if (si) si.classList.remove('active');
  }

  // Reusable confirmation modal helper
  window._showConfirm = function(title, msg, btnText, onConfirm) {
    document.getElementById('confirmModalTitle').textContent = title;
    document.getElementById('confirmModalMsg').textContent = msg;
    var btn = document.getElementById('confirmBtn');
    btn.textContent = btnText;
    var handler = function() {
      document.getElementById('confirmModal').classList.remove('open');
      btn.removeEventListener('click', handler);
      if (onConfirm) onConfirm();
    };
    btn.addEventListener('click', handler);
    document.getElementById('confirmModal').classList.add('open');
  };

  // Settings modals: Command Guide opener and close buttons.
  var cmdHelpBtn = document.getElementById('cmdHelpBtn');
  if (cmdHelpBtn) cmdHelpBtn.addEventListener('click', function() {
    document.getElementById('cmdHelpModal').classList.add('open');
  });
  ['refreshModal', 'confirmModal', 'sysMsgEditModal', 'cmdHelpModal'].forEach(function(modalId) {
    var modal = document.getElementById(modalId);
    if (!modal) return;
    modal.querySelectorAll('.modal-head .icon-btn, .modal-foot .btn-ghost').forEach(function(btn) {
      btn.addEventListener('click', function() { modal.classList.remove('open'); });
    });
  });

  // Shows discard modal if dirty, or runs action directly
  function confirmDiscardSettings(action) {
    if (window.SettingsPanel && window.SettingsPanel.isDirty && window.SettingsPanel.isDirty()) {
      window._showConfirm('Unsaved Changes', 'You have unsaved changes in Settings. Discard them?', 'Discard', function() {
        window.SettingsPanel.clearDirty();
        action();
      });
    } else {
      action();
    }
  }

  window._showSettings = showSettings;
  window._hideSettings = hideSettings;

  // Wire Settings icon
  var settingsIcon = document.getElementById('settings-icon');
  if (settingsIcon) settingsIcon.addEventListener('click', function() {
    showSettings();
  });

  var dashIcon = document.getElementById('dashboard-icon');
  if (dashIcon) dashIcon.addEventListener('click', function() {
    confirmDiscardSettings(function() {
      hideSettings();
      showDashboard();
    });
  });
  var sidebarToggle = document.getElementById('sidebar-toggle');
  if (sidebarToggle) sidebarToggle.addEventListener('click', function() {
    confirmDiscardSettings(function() {
      hideSettings();
      showChat();
      var railLeft = document.getElementById('railLeft');
      if (railLeft && (railLeft.style.width === '0px' || railLeft.style.width === '' || railLeft.classList.contains('mini'))) {
      railLeft.style.width = '340px';
      railLeft.classList.remove('mini');
    }
    toggleSidebar();
  });
});

  showTokenUsageBar();

  // Request settings to populate right panel on load
  if (typeof openModelSettings === 'function') openModelSettings();

  // Request thread list and trash list on load (sidebar always visible in new UI)
  Ipc.postToHost('sidebarAction', { subAction: 'loadThreadList' });
  Ipc.postToHost('sidebarAction', { subAction: 'loadTrashList' });

  // Wire topbar rename button — inline editing
  var renameBtn = document.querySelector('.rename-chat-btn');
  if (renameBtn) renameBtn.addEventListener('click', function() {
    var titleEl = document.querySelector('.title-text');
    if (!titleEl || titleEl.querySelector('input')) return; // already editing
    var currentTitle = titleEl.textContent;
    var input = document.createElement('input');
    input.type = 'text';
    input.value = currentTitle;
    input.style.cssText = 'font:inherit;color:inherit;background:var(--bg-hover);border:1px solid var(--border-main);border-radius:6px;padding:2px 8px;width:300px;outline:none;';
    titleEl.textContent = '';
    titleEl.appendChild(input);
    input.focus();
    input.select();
    var save = function() {
      var newTitle = input.value.trim();
      titleEl.textContent = newTitle || currentTitle;
      if (newTitle && newTitle !== currentTitle) {
    Ipc.postToHost('sidebarAction', { subAction: 'renameThread', threadId: activeThreadId, title: newTitle });
      }
    };
    input.addEventListener('blur', save);
    input.addEventListener('keydown', function(e) { if (e.key === 'Enter') { input.blur(); } if (e.key === 'Escape') { titleEl.textContent = currentTitle; } });
  });

  // Wire tree button
  var treeBtn = document.getElementById('treeBtn');
  if (treeBtn) treeBtn.addEventListener('click', function() {
    if (typeof toggleTreeModal === 'function') toggleTreeModal();
  });

  // Sidebar toggle handled above (chat↔dashboard toggle)

  // Chat send button
  // NOTE: Do NOT add a click listener here. setChatButtonsEnabled() manages
  // the button's onclick handler dynamically (onChatSend vs onStopStreaming).
  // A second listener would cause onChatSend to fire twice on mouse clicks,
  // with the second call seeing isLoading=true and cancelling the request.

  // Chat input
  var chatInput = document.getElementById('chat-input');
  if (chatInput) {
    chatInput.addEventListener('keydown', handleChatInputKeydown);
    chatInput.addEventListener('input', autoResizeChatInput);
  }

  // Scroll tracking for streaming auto-scroll
  var chatScrollEl = document.getElementById('chat-scroll');
  if (chatScrollEl) {
    chatScrollEl.addEventListener('scroll', function () {
      var distanceFromBottom = chatScrollEl.scrollHeight - chatScrollEl.scrollTop - chatScrollEl.clientHeight;
      if (typeof streamState !== 'undefined') {
        streamState.userScrolledUp = distanceFromBottom > 5;
      }
    });
  }

  // Copy entire chat button
  var copyAllBtn = document.getElementById('copy-entire-chat-btn');
  if (copyAllBtn) copyAllBtn.addEventListener('click', copyEntireChat);

  // Export chat button (topbar download icon)
  var exportChatBtn = document.getElementById('export-chat-btn');
  if (exportChatBtn) exportChatBtn.addEventListener('click', exportChat);


  // New folder button — inline input (no prompt)
  var newFolderBtn = document.querySelector('.rail-head-actions button[title="New folder"]');
  if (newFolderBtn) newFolderBtn.addEventListener('click', function() {
    var headActions = document.querySelector('.rail-head-actions');
    if (!headActions || headActions.querySelector('.inline-folder-input')) return;
    var input = document.createElement('input');
    input.type = 'text';
    input.className = 'inline-folder-input';
    input.placeholder = 'Folder name';
    input.style.cssText = 'font-size:0.85rem;padding:4px 8px;border:1px solid var(--border-main);border-radius:4px;background:var(--bg-panel);color:var(--text-primary);width:120px;outline:none;';
    headActions.appendChild(input);
    input.focus();
    var save = function() {
      var name = input.value.trim();
      input.remove();
      if (name) {
    Ipc.postToHost('sidebarAction', { subAction: 'createFolder', name: name });
      }
    };
    input.addEventListener('blur', save);
    input.addEventListener('keydown', function(e) { if (e.key === 'Enter') { input.blur(); } if (e.key === 'Escape') { input.remove(); } });
  });

  // New chat button in sidebar
  var newChatBtn = document.getElementById('new-chat-btn');
  if (newChatBtn) newChatBtn.addEventListener('click', newChat);

  // Initialize search inputs
  if (typeof initSearch === 'function') initSearch();

  // Notify AHK that the WebView is ready — AHK responds with initChatMode
  // for the current thread (DB is the single source of truth, not sessionStorage).
  try {
    Ipc.postToHost('webViewReady');
  } catch(e) {}

  // Restore fallback markdown content
  var storedContent = sessionStorage.getItem('preMarkdownText');
  if (storedContent && !isChatMode) {
    renderMarkdown(storedContent);
  }
});

var _threadErrorBanners = {};
var _nextErrorBannerId = 0;

function _createErrorBanner(entry) {
  var el = document.createElement('div');
  el.className = 'error-banner';
  if (entry.threadId) el.dataset.threadId = entry.threadId;
  if (entry.id) el.dataset.errorId = entry.id;
  el.style.cssText = 'background:var(--danger);color:var(--bg-panel);padding:8px 16px;margin:8px;border-radius:6px;font-size:0.85rem;display:flex;justify-content:space-between;align-items:center;';
  el.innerHTML = '<span>' + String(entry.message).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') + '</span><button onclick="dismissThreadError(this)" style="background:none;border:none;color:inherit;font-size:1.2rem;cursor:pointer;">&times;</button>';
  return el;
}

function dismissThreadError(button) {
  var banner = button && button.parentElement;
  if (!banner) return;
  var threadId = banner.dataset ? banner.dataset.threadId : '';
  var errorId = banner.dataset ? banner.dataset.errorId : '';
  if (threadId && errorId && _threadErrorBanners[threadId]) {
    _threadErrorBanners[threadId] = _threadErrorBanners[threadId].filter(function(entry) {
      return entry.id !== errorId;
    });
  }
  banner.remove();
}

function _renderThreadErrorBanners(container, threadId) {
  if (!container || !threadId) return;
  var entries = _threadErrorBanners[threadId] || [];
  for (var i = 0; i < entries.length; i++) {
    container.appendChild(_createErrorBanner(entries[i]));
  }
}

function showError(data) {
  // data is { message: string, threadId?: string }
  var errorThreadId = (data && typeof data === 'object' && data.threadId) ? String(data.threadId) : '';
  var msg = (typeof data === 'string') ? data : (data && data.message ? data.message : 'An error occurred');
  var entry = { message: msg, threadId: errorThreadId };
  if (errorThreadId) {
    entry.id = 'error-' + (++_nextErrorBannerId);
    if (!_threadErrorBanners[errorThreadId]) _threadErrorBanners[errorThreadId] = [];
    _threadErrorBanners[errorThreadId].push(entry);
  }
  // Async request failures can arrive after the user has switched chats. A
  // provider error must only be rendered in the chat that owns the request,
  // but it remains queued there until dismissed if that chat is not visible.
  if (errorThreadId && (typeof activeThreadId === 'undefined' || errorThreadId !== activeThreadId)) return;
  hideLoadingIndicator();
  // A failed retry restores the response that was only removed from the UI.
  if (typeof restoreRetryMessagesOnError === 'function') restoreRetryMessagesOnError();
  var chatMessages = document.getElementById('chat-messages');
  if (!chatMessages) return;
  chatMessages.appendChild(_createErrorBanner(entry));
  chatMessages.scrollTop = chatMessages.scrollHeight;
}
