// ======================================================
// chat-input.js — Send, loading indicator, keyboard, retry
// ======================================================

// Keep the messages removed when a retry starts so a failed retry can restore them.
// and everything after it). If the retry FAILS, they are restored so the
// original response stays visible instead of being lost until reload.
var _retryRemovedMessages = null;
// Retry restoration is scoped to the same thread and visible path.
// messages were removed from. _retryThreadId records the thread, and
// _retryAnchorId the id of the last remaining message after truncation (the
// anchor of the truncated path; null for a root retry that emptied the UI).
var _retryThreadId = null;
var _retryAnchorId = null;

// Correlated Send -> first-visible-response latency trace. Browser timings use
// performance.now() so they are monotonic; the trace id is forwarded to AHK so
// backend debug-log stages can be matched without logging prompt contents.
var _latencyTraceSeq = 0;
var _latencyTraceActive = null;
function _latencyNow() {
  return (typeof performance !== 'undefined' && performance && typeof performance.now === 'function') ? performance.now() : Date.now();
}
function _latencyStartTrace() {
  var id = 'send-' + Date.now().toString(36) + '-' + (++_latencyTraceSeq);
  _latencyTraceActive = { id: id, startPerf: _latencyNow(), marks: Object.create(null) };
  window.__latencyTrace = _latencyTraceActive;
  console.info('[LATENCY][' + id + '] +0.0ms web.send.begin');
  return _latencyTraceActive;
}
function _latencyMark(stage, detail) {
  if (!_latencyTraceActive) return;
  var elapsed = _latencyNow() - _latencyTraceActive.startPerf;
  console.info('[LATENCY][' + _latencyTraceActive.id + '] +' + elapsed.toFixed(1) + 'ms ' + stage + (detail ? ' ' + detail : ''));
}
function _latencyMarkOnce(key, stage, detail) {
  if (!_latencyTraceActive || _latencyTraceActive.marks[key]) return;
  _latencyTraceActive.marks[key] = true;
  _latencyMark(stage, detail);
}
function _latencyFinish(stage) {
  if (!_latencyTraceActive) return;
  _latencyMark(stage || 'web.request.complete');
  window.__lastLatencyTrace = _latencyTraceActive;
  _latencyTraceActive = null;
}

function onChatSend() {
  var input = document.getElementById('chat-input');
  if (!input) return;

  // If streaming, treat click as "Stop". streamState.active is checked in
  // addition to isLoading so a mismatched composer cannot send again while
  // the first stream is still in flight, preventing a second send from
  // clobbering the active stream.
  if (isLoading || (typeof streamState !== 'undefined' && streamState.active)) {
    onStopStreaming();
    return;
  }

  var message = input.value.trim();
  var attachments = typeof getAttachmentsForSend === 'function' ? getAttachmentsForSend() : [];

  // Check if any attachment is still loading
  if (typeof attachmentState !== 'undefined') {
    var anyLoading = false;
    for (var a = 0; a < attachmentState.length; a++) {
      if (attachmentState[a].loading) { anyLoading = true; }
    }
    if (anyLoading) {
      showErrorBanner('Please wait — file processing in progress');
      return;
    }
  }

  if (message || attachments.length > 0) {
    // Normal send with typed text and/or attachments
    var latencyTrace = _latencyStartTrace();
    if (typeof _sendAllSettings === 'function') {
      _sendAllSettings(true);
      _latencyMark('web.settings.flush-returned');
    }
    input.value = '';
    input.style.height = 'auto';
    isLoading = true;
    showLoadingIndicator();
    var sendBtn = document.getElementById('chat-send-btn');
    if (sendBtn) sendBtn.disabled = true;
    input.disabled = true;
    var payload = { message: message || 'Describe the attached content.' };
    if (attachments.length > 0) payload.attachments = attachments;
    payload.latencyTraceId = latencyTrace.id;
    Ipc.postToHost('chatSend', payload);
    _latencyMark('web.chatSend.posted');
    if (typeof clearAttachments === 'function') clearAttachments();
    return;
  }

  // An empty Send (no text and no attachments) is a no-op; do not reuse
  // another message as an implicit request.
  return;
}

// Show the loading dots indicator
function showLoadingIndicator() {
  // Typed sends and AHK-triggered commands can both request this state.
  if (document.getElementById('chat-loading')) return;
  var container = document.getElementById('chat-messages');
  if (!container) return;
  var indicator = document.createElement('div');
  indicator.className = 'loading-indicator';
  indicator.id = 'chat-loading';
  indicator.innerHTML = '<span class="dot"></span><span class="dot"></span><span class="dot"></span>';
  container.appendChild(indicator);
  container.scrollTop = container.scrollHeight;
}

// Hide the loading dots indicator
function hideLoadingIndicator() {
  var indicator = document.getElementById('chat-loading');
  if (indicator) indicator.remove();
}

// Enable/disable chat input. During streaming, button shows "Stop" to cancel.
function setChatButtonsEnabled(enabled) {
  isLoading = !enabled;
  var sendBtn = document.getElementById('chat-send-btn');
  var input = document.getElementById('chat-input');
  if (sendBtn) {
    if (enabled) {
      sendBtn.innerHTML = '<i data-lucide="send"></i>';
      sendBtn.title = 'Send message';
      sendBtn.setAttribute('aria-label', 'Send message');
      sendBtn.disabled = false;
      sendBtn.onclick = onChatSend;
    } else {
      sendBtn.innerHTML = '<i data-lucide="square"></i>';
      sendBtn.title = 'Stop generating';
      sendBtn.setAttribute('aria-label', 'Stop generating');
      sendBtn.disabled = false;
      sendBtn.onclick = onStopStreaming;
    }
    if (typeof lucide !== 'undefined') lucide.createIcons();
  }
  if (input) input.disabled = !enabled;
  // Command-triggered chats bypass onChatSend(), so AHK disabling the
  // composer is also the signal to show pre-stream loading dots. Active
  // streams already have their assistant/reasoning UI.
  if (!enabled && (typeof streamState === 'undefined' || !streamState.active))
    showLoadingIndicator();
  if (enabled) {
    // Re-enabling the composer means no request is in flight, so reset stream
    // state before allowing another send.
    if (typeof streamState !== 'undefined') {
      streamState.active = false;
      streamState.bubble = null;
      streamState.contentDiv = null;
      streamState.thinkingDetails = null;
      streamState.contentBuffer = '';
      streamState.thinkingBuffer = '';
    }
    // Enabling the composer also clears any visible loading indicator.
    // visible loading dots must clear. This matters when a stream completes
    // (or fails/cancels) while a DIFFERENT thread is visible: onStreamDone is
    // scoped away for the non-current thread and never reaches the indicator
    // through the normal render path, leaving the dots stuck forever.
    hideLoadingIndicator();
    if (input) input.focus();
  }
}

// Cancel streaming — sends cancel message to AHK
function onStopStreaming() {
  Ipc.postToHost('cancelStream');
}

// Retry an assistant message
function retryLastAssistantMessage(messageId) {
  if (isLoading) return;

  _retryRemovedMessages = null;
  _retryThreadId = typeof activeThreadId !== 'undefined' ? activeThreadId : '';
  _retryAnchorId = null;
  if (messageId) {
    for (var i = 0; i < chatMessages.length; i++) {
      if (chatMessages[i].id === messageId && chatMessages[i].role === 'assistant') {
        _retryRemovedMessages = chatMessages.slice(i);
        chatMessages.splice(i);
        break;
      }
    }
    renderChatMessages(chatMessages);
  } else {
    var lastAssistantIdx = -1;
    for (var j = chatMessages.length - 1; j >= 0; j--) {
      if (chatMessages[j].role === 'assistant') { lastAssistantIdx = j; break; }
    }
    if (lastAssistantIdx >= 0) _retryRemovedMessages = chatMessages.slice(lastAssistantIdx);
    removeLastAssistantMessage();
  }
  _retryAnchorId = chatMessages.length ? chatMessages[chatMessages.length - 1].id : null;

  isLoading = true;
  showLoadingIndicator();
  var sendBtn = document.getElementById('chat-send-btn');
  var input = document.getElementById('chat-input');
  if (sendBtn) sendBtn.disabled = true;
  if (input) input.disabled = true;

  var payload = {};
  if (messageId) payload.messageId = messageId;
  Ipc.postToHost('retry', payload);
}

// Restore the retry-removed messages after a failed retry (called from the
// global showError path). The DB row was never touched - only the UI was
// truncated - so this brings the conversation back exactly as it was.
// Restore only into the same thread/path array that supplied the removed messages.
// thread AND the same visible path (anchored by the last remaining message).
// A failed retry while another thread/branch is visible must not push thread
// A's messages into thread B's UI; the DB rows are intact, so the correct
// messages reappear the next time the retry thread/path loads.
function restoreRetryMessagesOnError() {
  if (!_retryRemovedMessages || _retryRemovedMessages.length === 0) return;
  if (typeof activeThreadId !== 'undefined' && activeThreadId !== _retryThreadId) {
    _retryRemovedMessages = null;
    _retryThreadId = null;
    _retryAnchorId = null;
    return;
  }
  var last = chatMessages.length ? chatMessages[chatMessages.length - 1] : null;
  var stillOnRetryPath = _retryAnchorId ? (last && last.id === _retryAnchorId) : chatMessages.length === 0;
  if (!stillOnRetryPath) {
    // The visible path no longer matches the truncated retry path (another
    // branch was loaded, or the thread was reloaded from the DB, which
    // already contains the original messages) - never restore here.
    _retryRemovedMessages = null;
    _retryThreadId = null;
    _retryAnchorId = null;
    return;
  }
  var restored = _retryRemovedMessages;
  _retryRemovedMessages = null;
  _retryThreadId = null;
  _retryAnchorId = null;
  for (var i = 0; i < restored.length; i++) chatMessages.push(restored[i]);
  renderChatMessages(chatMessages);
}

// Keyboard handlers
function handleChatInputKeydown(e) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    onChatSend();
  }
}

function autoResizeChatInput() {
  var input = document.getElementById('chat-input');
  if (!input) return;
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 200) + 'px';
}


var _chatInputInitialized = false;
if (typeof window !== 'undefined') window.ChatInput = {
  init: function() {
    if (_chatInputInitialized) return;
    _chatInputInitialized = true;
    var chatInput = document.getElementById('chat-input');
    if (!chatInput) return;
    chatInput.addEventListener('keydown', handleChatInputKeydown);
    chatInput.addEventListener('input', autoResizeChatInput);
  }
};
