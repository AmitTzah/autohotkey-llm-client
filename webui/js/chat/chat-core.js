// ======================================================
// chat-core.js -- Core chat state, initialization, and shared utilities
// ======================================================

// Chat state
var chatMessages = [];
var isChatMode = false;
var isLoading = false;
var activeThreadId = "";

// Close all dropdown menus when clicking outside
document.addEventListener('click', function() {
  var menus = document.querySelectorAll('.more-menu');
  for (var i = 0; i < menus.length; i++) {
    menus[i].style.display = 'none';
  }
});

// Initialize chat mode -- called by AHK when a thread loads.
// Accepts either an array of messages (legacy) or { messages: [], threadId: "..." }
function initChatMode(data) {
  isChatMode = true;
  var messages = Array.isArray(data) ? data : (data && data.messages ? data.messages : []);
  chatMessages = messages;

  // The single DOM streamState belongs only to the visible chat. On every
  // thread load, clear it; the AHK layer re-posts that thread's accumulated
  // partial via _RepostActiveStreamForThread when it actually has a stream.
  if (typeof streamState !== 'undefined') {
    streamState.active = false;
    streamState.finalized = false;
    streamState.threadId = '';
    streamState.contentBuffer = '';
    streamState.thinkingBuffer = '';
    streamState.bubble = null;
    streamState.thinkingDetails = null;
    streamState.contentDiv = null;
  }

  // Reset persisted thinking-block states when loading a new thread
  if (typeof _persistedThinkingStates !== 'undefined') {
    _persistedThinkingStates = {};
  }

  // Always adopt the loaded thread id during a thread switch.
  // guard left activeThreadId stale when switching threads (rapid switch,
  // fork, programmatic load), so sends/search targeted the wrong thread.
  if (data && data.threadId) {
    activeThreadId = data.threadId;
  }

  var fimNotice = document.getElementById('fim-notice');
  if (fimNotice) fimNotice.style.display = 'none';

  renderChatMessages(chatMessages);
  showTokenUsageBar();
  // Composer state follows the loaded thread only; background generations are
  // tracked independently in chat-input.js.
  if (typeof syncChatButtonsForActiveThread === 'function') syncChatButtonsForActiveThread();

  // Only show loading if THIS thread already has a request in-flight and the
  // last persisted message is not yet an assistant response.
  if (typeof isThreadRequestInFlight === 'function' &&
      isThreadRequestInFlight(activeThreadId) &&
      chatMessages.length > 0 &&
      chatMessages[chatMessages.length - 1].role !== 'assistant') {
    showLoadingIndicator();
  } else {
    hideLoadingIndicator();
  }

  sessionStorage.setItem('isChatMode', 'true');

  // Re-enable scoped search and handle cross-thread search navigation
  if (typeof updateScopedSearchState === 'function') updateScopedSearchState();
  if (typeof onSearchCrossThreadLoaded === 'function') onSearchCrossThreadLoaded();
}

// Markdown rendering for non-chat modes (FIM fallback)
function renderMarkdown(content) {
  var contentToRender = content || 'There is no content available.';
  sessionStorage.setItem('preMarkdownText', contentToRender);
  var result = md.render(contentToRender);
  var contentElement = document.getElementById('content');
  if (contentElement) contentElement.innerHTML = result;
  if (!isChatMode) {
    var fimNotice = document.getElementById('fim-notice');
    if (fimNotice) fimNotice.style.display = 'block';
    var chatMessagesEl = document.getElementById('chat-messages');
    if (chatMessagesEl) chatMessagesEl.style.display = 'none';
    if (contentElement) contentElement.style.display = 'block';
  } else {
    var chatMessagesEl2 = document.getElementById('chat-messages');
    if (chatMessagesEl2) chatMessagesEl2.style.display = '';
    var contentEl2 = document.getElementById('content');
    if (contentEl2) contentEl2.style.display = 'none';
  }
}

// Shared HTML escape utility (used by multiple chat modules)
function escHtml(s) {
  if (!s) return '';
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// Shared inline editor -- creates a text input over an element for renaming.
// Calls onSave(newValue) on blur/Enter, restores original on Escape.
function _makeInlineEditor(el, currentValue, onSave, inputWidth) {
  if (!el || el.querySelector('input')) return;
  var input = document.createElement('input');
  input.type = 'text'; input.value = currentValue;
  input.style.cssText = 'font:inherit;color:inherit;background:var(--bg-hover);border:1px solid var(--border-main);border-radius:4px;padding:0 4px;width:' + (inputWidth || '100%') + ';outline:none;font-size:0.85rem;';
  el.textContent = ''; el.appendChild(input); input.focus(); input.select();
  var save = function() {
    var newVal = input.value.trim();
    el.textContent = newVal || currentValue;
    if (newVal && newVal !== currentValue) onSave(newVal);
  };
  input.addEventListener('blur', save);
  input.addEventListener('keydown', function(ev) {
    if (ev.key === 'Enter') input.blur();
    if (ev.key === 'Escape') { el.textContent = currentValue; }
  });
}

// Shared chat-side custom confirmation dialog -- no browser prompt().
// Named _showChatConfirm (not _showConfirm) so it doesn't collide with the
// Settings-panel window._showConfirm(title, msg, btnText, onConfirm) helper.
var _chatConfirmCallback = null;
function _showChatConfirm(message, onYes) {
  var existing = document.getElementById('customConfirmOverlay');
  if (existing) existing.remove();

  _chatConfirmCallback = onYes;
  var overlay = document.createElement('div');
  overlay.id = 'customConfirmOverlay';
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(17,24,39,0.4);backdrop-filter:blur(2px);display:flex;align-items:center;justify-content:center;z-index:200;';
  overlay.innerHTML =
    '<div style="background:var(--bg-panel);border:1px solid var(--border-main);border-radius:12px;padding:24px;max-width:360px;box-shadow:var(--shadow-modal);">' +
      '<div style="font-size:15px;color:var(--text-primary);margin-bottom:16px;line-height:1.5;">' + escHtml(message) + '</div>' +
      '<div style="display:flex;justify-content:flex-end;gap:8px;">' +
        '<button class="cancel-confirm-btn" style="padding:8px 16px;border:1px solid var(--border-main);border-radius:6px;background:transparent;color:var(--text-secondary);cursor:pointer;">Cancel</button>' +
        '<button class="yes-confirm-btn" style="padding:8px 16px;border:none;border-radius:6px;background:var(--danger);color:#fff;cursor:pointer;">Delete</button>' +
      '</div>' +
    '</div>';
  document.body.appendChild(overlay);

  overlay.querySelector('.cancel-confirm-btn').addEventListener('click', function() { overlay.remove(); _chatConfirmCallback = null; });
  overlay.querySelector('.yes-confirm-btn').addEventListener('click', function() {
    overlay.remove();
    var cb = _chatConfirmCallback;
    _chatConfirmCallback = null;
    if (cb) cb();
  });
  overlay.addEventListener('click', function(e) { if (e.target === overlay) { overlay.remove(); _chatConfirmCallback = null; } });
}

// Global Escape handler: closes any open overlay (search, confirm, tree,
// settings confirm) and cancels an in-flight stream. It deliberately does NOT
// hide the chat window — hiding is the configurable Close Windows hotkey's job
// (chat/ChatHotkeys.ahk).
document.addEventListener('keydown', function(e) {
  if (e.key !== 'Escape') return;

  // Search dropdown
  if (typeof closeSearchDropdown === 'function' && typeof _searchDropdownEl !== 'undefined') {
    if (_searchDropdownEl && _searchDropdownEl.style.display !== 'none') {
      closeSearchDropdown();
      return;
    }
  }

  // Confirm dialog
  var confirmOverlay = document.getElementById('customConfirmOverlay');
  if (confirmOverlay) {
    confirmOverlay.remove();
    _chatConfirmCallback = null;
    return;
  }

  // Tree modal
  var treeOverlay = document.getElementById('treeOverlay');
  if (treeOverlay && treeOverlay.classList.contains('open')) {
    treeOverlay.classList.remove('open');
    return;
  }

  // Image overlay (full-size attachment view)
  var imgOverlay = document.querySelector('.image-overlay');
  if (imgOverlay && imgOverlay.style.display === 'flex') {
    imgOverlay.remove();
    return;
  }

  // Settings confirmation modal (e.g. "Reset to Defaults") — cancel it
  var settingsConfirm = document.getElementById('confirmModal');
  if (settingsConfirm && settingsConfirm.classList.contains('open')) {
    settingsConfirm.classList.remove('open');
    return;
  }

  // Streaming -- cancel it
  var streamActive = typeof streamState !== 'undefined' && streamState && streamState.active;
  if ((typeof isLoading !== 'undefined' && isLoading) || streamActive) {
    Ipc.postToHost('cancelStream');
    return;
  }
});
