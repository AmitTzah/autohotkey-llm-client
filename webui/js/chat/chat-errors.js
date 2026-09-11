// chat-errors.js - Thread-scoped provider/request error banners.
(function(root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(root);
  else root.ChatErrors = factory(root);
})(typeof globalThis !== 'undefined' ? globalThis : this, function(root) {
  'use strict';

  var threadErrorBanners = {};
  var nextErrorBannerId = 0;

  function createErrorBanner(entry) {
    var el = root.document.createElement('div');
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
    if (threadId && errorId && threadErrorBanners[threadId]) {
      threadErrorBanners[threadId] = threadErrorBanners[threadId].filter(function(entry) {
        return entry.id !== errorId;
      });
    }
    banner.remove();
  }

  function renderThreadErrorBanners(container, threadId) {
    if (!container || !threadId) return;
    var entries = threadErrorBanners[threadId] || [];
    for (var i = 0; i < entries.length; i++) container.appendChild(createErrorBanner(entries[i]));
  }

  function showError(data) {
    var errorThreadId = (data && typeof data === 'object' && data.threadId) ? String(data.threadId) : '';
    var msg = (typeof data === 'string') ? data : (data && data.message ? data.message : 'An error occurred');
    var entry = { message: msg, threadId: errorThreadId };

    if (errorThreadId) {
      entry.id = 'error-' + (++nextErrorBannerId);
      if (!threadErrorBanners[errorThreadId]) threadErrorBanners[errorThreadId] = [];
      threadErrorBanners[errorThreadId].push(entry);
    }

    if (errorThreadId && (!root.activeThreadId || errorThreadId !== root.activeThreadId)) return;

    if (typeof root.hideLoadingIndicator === 'function') root.hideLoadingIndicator();
    if (typeof root.restoreRetryMessagesOnError === 'function') root.restoreRetryMessagesOnError();

    var chatMessages = root.document && root.document.getElementById('chat-messages');
    if (!chatMessages) return;
    chatMessages.appendChild(createErrorBanner(entry));
    chatMessages.scrollTop = chatMessages.scrollHeight;
  }

  root.showError = showError;
  root.dismissThreadError = dismissThreadError;
  root._renderThreadErrorBanners = renderThreadErrorBanners;

  return {
    showError: showError,
    dismissThreadError: dismissThreadError,
    renderThreadErrorBanners: renderThreadErrorBanners
  };
});
