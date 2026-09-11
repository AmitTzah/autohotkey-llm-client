// ======================================================
// chat-render.js — Message bubble creation, DOM rendering, incremental updates
// ======================================================

// Persisted across renders so each message ID remembers its own state
// independently, even across branch switches.
var _persistedThinkingStates = {};

// Collapsed/expanded state for search cards, same persistence idea.
var _persistedSearchStates = {};

function _saveThinkingBlockStates() {
  var blocks = document.querySelectorAll('.thinking-block');
  for (var i = 0; i < blocks.length; i++) {
    var msgEl = blocks[i].closest('.msg');
    if (!msgEl) continue;
    var msgId = msgEl.getAttribute('data-msg-id');
    if (!msgId) continue;
    _persistedThinkingStates[msgId] = blocks[i].open;
  }
}

function _restoreThinkingBlockStates() {
  var container = document.getElementById('chat-messages');
  if (!container) return;
  // Scan visible thinking blocks (O(visible) instead of O(persisted)):
  // for a 1000-message tree, only ~10-50 are in the DOM at any time.
  var blocks = container.querySelectorAll('.thinking-block');
  for (var i = 0; i < blocks.length; i++) {
    var msgEl = blocks[i].closest('.msg');
    if (!msgEl) continue;
    var msgId = msgEl.getAttribute('data-msg-id');
    if (!msgId) continue;
    if (!_persistedThinkingStates.hasOwnProperty(msgId)) continue;
    if (_persistedThinkingStates[msgId]) {
      blocks[i].setAttribute('open', '');
    } else {
      blocks[i].removeAttribute('open');
    }
  }
}

function _saveSearchCardStates() {
  var toggles = document.querySelectorAll('.search-card-toggle');
  for (var i = 0; i < toggles.length; i++) {
    var msgEl = toggles[i].closest('.msg');
    if (!msgEl) continue;
    var msgId = msgEl.getAttribute('data-msg-id');
    if (!msgId) continue;
    _persistedSearchStates[msgId] = toggles[i].getAttribute('aria-expanded') === 'true';
  }
}

function _restoreSearchCardStates() {
  var container = document.getElementById('chat-messages');
  if (!container) return;
  var toggles = container.querySelectorAll('.search-card-toggle');
  for (var i = 0; i < toggles.length; i++) {
    var msgEl = toggles[i].closest('.msg');
    if (!msgEl) continue;
    var msgId = msgEl.getAttribute('data-msg-id');
    if (!msgId) continue;
    if (!_persistedSearchStates.hasOwnProperty(msgId)) continue;
    var expanded = _persistedSearchStates[msgId];
    toggles[i].setAttribute('aria-expanded', String(expanded));
    var card = toggles[i].closest('.search-card');
    var results = card ? card.querySelector('.search-card-results') : null;
    if (results) results.hidden = !expanded;
  }
}

function renderChatMessages(messages) {
  var container = document.getElementById('chat-messages');
  if (!container) return;
  _saveThinkingBlockStates();
  _saveSearchCardStates();
  container.innerHTML = '';
  for (var i = 0; i < messages.length; i++) {
    container.appendChild(createMessageBubble(messages[i], i));
  }
  // Error banners are stored per thread by main.js so they survive a chat
  // switch, but never cross into another thread.
  if (typeof _renderThreadErrorBanners === 'function')
    _renderThreadErrorBanners(container, activeThreadId);
  _restoreThinkingBlockStates();
  _restoreSearchCardStates();
  // Render Lucide icons now that bubbles are in the DOM
  if (typeof lucide !== 'undefined') lucide.createIcons();
  // Scroll the parent .thread element
  var scrollEl = document.getElementById('chat-scroll') || container.parentElement;
  if (scrollEl) scrollEl.scrollTop = scrollEl.scrollHeight;
}

function replaceMessagesAfter(startIndex, newMessages, startOffset) {
  var container = document.getElementById('chat-messages');
  if (!container) return;
  _saveThinkingBlockStates();
  _saveSearchCardStates();
  startOffset = startOffset || 0;
  var existingBubbles = container.querySelectorAll('.msg');
  for (var i = startIndex; i < existingBubbles.length; i++) {
    existingBubbles[i].remove();
  }
  if (!newMessages || newMessages.length === 0) {
    _restoreThinkingBlockStates();
    _restoreSearchCardStates();
    return;
  }
  for (var j = startOffset; j < newMessages.length; j++) {
    var bubble = createMessageBubble(newMessages[j], startIndex + (j - startOffset));
    container.appendChild(bubble);
  }
  _restoreThinkingBlockStates();
  _restoreSearchCardStates();
}

function attachmentsEqual(a, b) {
  if (!a && !b) return true;
  if (!a || !b) return false;
  if (a.length !== b.length) return false;
  for (var i = 0; i < a.length; i++) {
    if (a[i].id !== b[i].id) return false;
  }
  return true;
}

function updateChatMessages(newMessages) {
  if (!newMessages) return;
  var container = document.getElementById('chat-messages');
  if (!container) return;
  var divIdx = 0;
  while (divIdx < chatMessages.length && divIdx < newMessages.length) {
    var oldMsg = chatMessages[divIdx];
    var newMsg = newMessages[divIdx];
    if (oldMsg.id !== newMsg.id || oldMsg.content !== newMsg.content || !attachmentsEqual(oldMsg.attachments, newMsg.attachments)) break;
    divIdx++;
  }
  var prevScrollTop = container.scrollTop;
  var prevScrollHeight = container.scrollHeight;
  replaceMessagesAfter(divIdx, newMessages, divIdx);
  chatMessages = newMessages;
  // Rebuilding the chat view during an in-flight request must not re-enable
  // the composer; a second send would overwrite request stream state and orphan the first
  // billed response. Keep the composer in Stop mode for the whole in-flight
  // window (isLoading covers the pre-stream phase, streamState.active the
  // streaming phase); only re-enable when idle.
  var requestInFlight = isLoading || (typeof streamState !== 'undefined' && streamState.active);
  setChatButtonsEnabled(!requestInFlight);
  if (typeof renderNavList === 'function') renderNavList();
  if (prevScrollHeight > 0) {
    var scrollEl = document.getElementById('chat-scroll') || container.parentElement;
    if (scrollEl) scrollEl.scrollTop = Math.round(scrollEl.scrollHeight * (prevScrollTop / (scrollEl.scrollHeight || 1)));
  }
}


// Normalize CRLF/CR to LF before markdown rendering. markdown-it is configured
// with breaks:true so single-newline paragraph breaks remain visible.
function _prepUserContent(content) {
  return (content || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function _buildMsgBubble(roleClass, msgId, authorName, metaText, contentHtml, middleHtml, editUiHtml, headPrefixHtml) {
  return '        <div class="msg ' + roleClass + '"' + (msgId ? ' data-msg-id="' + msgId + '"' : '') + '>\n' +
    '          <div class="msg-body">\n' +
    '            <div class="msg-head">\n' +
    (headPrefixHtml || '') +
    '              <span class="msg-author">' + escHtml(authorName) + '</span>\n' +
    '              <span class="msg-meta">' + metaText + '</span>\n' +
    '            </div>\n' +
    middleHtml +
    '            <div class="msg-content">' + contentHtml + '</div>\n' +
    (editUiHtml ? '\n' + editUiHtml + '\n' : '') +
    '            <div class="msg-actions"></div>\n' +
    '          </div>\n' +
    '        </div>';
}

function createMessageBubble(msg, index) {
  var msgId = msg.id || '';
  var metaText = _buildMetaText(msg);
  var role = msg.role;

  var roleClass, authorName, contentHtml, middleHtml, editUiHtml, headPrefixHtml = '', isSearchContext = false;
  if (role === 'user') {
    // Web-search context messages (persisted as plain user-role text so API
    // history round-trips without schema changes) render as a muted,
    // collapsible card: the query in the header, the results hidden until
    // the user expands them.
    isSearchContext = typeof msg.content === 'string' && msg.content.indexOf('[Web search:') === 0;
    roleClass = isSearchContext ? 'you search-context' : 'you';
    authorName = isSearchContext ? 'Web Search' : 'You';
    contentHtml = isSearchContext
      ? _buildSearchContextHtml(_parseSearchContext(msg.content), msgId)
      : md.render(_prepUserContent(msg.content));
    middleHtml = _buildAttachmentHtml(msg);
    editUiHtml = _buildEditUiHtml(msg);
  } else if (role === 'assistant') {
    roleClass = 'bot';
    authorName = msg.model || 'Assistant';
    if (window.ProviderIcons) headPrefixHtml = window.ProviderIcons.html(msg.model, msg.provider, 18, 'msg-provider-icon');
    // Normalize assistant line endings the same way as user content.
    // as user content - markdown-it's breaks:true then keeps single-newline
    // paragraph breaks visible instead of collapsing them into one block.
    contentHtml = md.render(_prepUserContent(msg.content));
    middleHtml = _buildReasoningHtml(msg) + _buildAttachmentHtml(msg);
    editUiHtml = _buildEditUiHtml(msg);
  } else {
    roleClass = 'system';
    authorName = 'System Prompt';
    contentHtml = md.render(msg.content || '');
    middleHtml = '';
    editUiHtml = '';
  }

  var template = document.createElement('div');
  template.innerHTML = _buildMsgBubble(roleClass, msgId, authorName, metaText, contentHtml, middleHtml, editUiHtml, headPrefixHtml);
  var bubble = template.firstElementChild;

  if (isSearchContext) _wireSearchCardToggle(bubble, msgId);

  if (role !== 'system') {
    var actionsDiv = bubble.querySelector('.msg-actions');
    if (actionsDiv) addMessageActions(actionsDiv, msg, index);
  }

  if (typeof lucide !== 'undefined') lucide.createIcons();
  return bubble;
}

// Split a persisted "[Web search: <query>]" message into its query and
// results body (the marker line is replaced by the card header).
function _parseSearchContext(content) {
  var text = String(content || '');
  var query = '';
  var results = text;
  var m = /^\[Web search: ([^\]]*)\](?:\r?\n)*/.exec(text);
  if (m) {
    query = m[1];
    results = text.slice(m[0].length);
  }
  return { query: query, results: results };
}

// Collapsible search-result card: header shows the query, the results body
// is hidden by default and revealed by the toggle. When a persisted
// expanded state exists for msgId it wins; otherwise live
// ("Searching...") cards start expanded so progress is visible.
function _buildSearchContextHtml(sc, msgId) {
  var q = escHtml(sc.query || '');
  var body = md.render(_prepUserContent(sc.results || ''));
  var live = /Searching(\.\.\.|…)/.test(sc.results || '');
  var expanded;
  if (msgId && _persistedSearchStates.hasOwnProperty(msgId)) {
    expanded = _persistedSearchStates[msgId];
  } else {
    expanded = live;
  }
  return '<div class="search-card">' +
    '<button type="button" class="search-card-toggle" aria-expanded="' + (expanded ? 'true' : 'false') + '" title="Show or hide the search results">' +
    '<i data-lucide="search" style="width:14px;height:14px;flex-shrink:0;"></i>' +
    '<span class="search-card-title">Searched the web for: <strong>' + q + '</strong></span>' +
    '<i data-lucide="chevron-down" class="search-card-caret" style="width:14px;height:14px;flex-shrink:0;"></i>' +
    '</button>' +
    '<div class="search-card-results"' + (expanded ? '' : ' hidden') + '>' + body + '</div>' +
    '</div>';
}

// Toggle the card's results on click, keep aria-expanded in sync, and
// persist the state so streaming updates don't clobber a user collapse.
function _wireSearchCardToggle(bubble, msgId) {
  var toggle = bubble.querySelector('.search-card-toggle');
  if (!toggle) return;
  var id = msgId || (bubble.getAttribute('data-msg-id') || '');
  toggle.addEventListener('click', function() {
    var card = toggle.closest('.search-card');
    var results = card ? card.querySelector('.search-card-results') : null;
    var expanded = toggle.getAttribute('aria-expanded') === 'true';
    toggle.setAttribute('aria-expanded', String(!expanded));
    if (results) results.hidden = expanded;
    if (id) _persistedSearchStates[id] = !expanded;
  });
}

function _buildMetaText(msg) {
  if (!msg.createdAt) return '';
  var d = new Date(msg.createdAt + 'Z');
  if (isNaN(d.getTime())) return '';
  var timeStr = d.toLocaleString(undefined, {hour:'2-digit',minute:'2-digit',hour12:false});
  if (msg.role === 'assistant') return escHtml(msg.model || '') + ' · ' + timeStr;
  if (msg.role === 'user') return '· ' + timeStr;
  return timeStr;
}

function _buildReasoningHtml(msg) {
  if (!msg.reasoning) return '';
  return '\n            <details class="thinking-block" open>\n' +
    '              <summary><i data-lucide="brain" style="width:16px;height:16px;"></i> Thought Process</summary>\n' +
    '              <div class="thinking-content">' + escHtml(msg.reasoning) + '</div>\n' +
    '            </details>';
}

function _formatFileSize(bytes) {
  if (!bytes || bytes === 0) return '0B';
  if (bytes < 1024) return bytes + 'B';
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + 'KB';
  return (bytes / 1048576).toFixed(1) + 'MB';
}

function _buildAttachmentHtml(msg) {
  if (!msg.attachments || !msg.attachments.length) return '';
  var html = '';
  var hasScannedPDF = false;

  // Pre-scan for scanned PDF banner (show once per message)
  for (var a = 0; a < msg.attachments.length; a++) {
    if (msg.attachments[a].extracted_text === '__SCANNED_PDF__') {
      hasScannedPDF = true;
      break;
    }
  }
  if (hasScannedPDF) {
    html += '\n            <div class="scan-banner">\n' +
      '              <span>\u26A0\uFE0F No extractable text (scanned PDF) \u2014 attached as image(s)</span>\n' +
      '              <button onclick="this.parentElement.remove()">\u00D7</button>\n' +
      '            </div>';
  }

  for (var a = 0; a < msg.attachments.length; a++) {
    var att = msg.attachments[a];
    var attId = att.id || '';

    if (att.attachment_type === 'image' && att.base64) {
      var imgSrc = 'data:' + (att.mime_type || 'image/png') + ';base64,' + att.base64;
      html += '\n            <div class="msg-attachment-image">\n' +
        '              <img src="' + imgSrc + '" alt="' + escHtml(att.original_filename || 'image') + '" onclick="(function(){var o=document.createElement(\'div\');o.className=\'image-overlay\';o.style.display=\'flex\';var i=document.createElement(\'img\');i.src=this.src;o.appendChild(i);o.addEventListener(\'click\',function(){this.remove()});document.body.appendChild(o);}).call(this)">\n' +
        '              <div class="msg-attachment-info">\n' +
        '                <i data-lucide="image" class="file-icon"></i>\n' +
        '                <span class="file-name">' + escHtml(att.original_filename || 'image') + '</span>\n' +
        '                <span class="file-size">' + _formatFileSize(att.file_size) + '</span>\n' +
        (attId ? '                <button class="msg-attachment-delete" data-attachment-id="' + attId + '" title="Remove attachment">\u00D7</button>\n' : '') +
        '              </div>\n' +
        '            </div>';
    } else {
      var iconName = typeof getAttachmentIcon === 'function' ? getAttachmentIcon(att.mime_type || '', att.original_filename || '') : 'file-text';
      var iconHtml;
      if (iconName.indexOf('icons/') === 0) {
        iconHtml = '<img src="' + iconName + '" class="file-icon">';
      } else {
        iconHtml = '<i data-lucide="' + iconName + '" class="file-icon"></i>';
      }
      html += '\n            <div class="msg-attachment-file">\n' +
        '              ' + iconHtml + '\n' +
        '              <span class="file-name">' + escHtml(att.original_filename || 'file') + '</span>\n' +
        '              <span class="file-size">' + _formatFileSize(att.file_size) + '</span>\n' +
        (attId ? '              <button class="msg-attachment-delete" data-attachment-id="' + attId + '" title="Remove attachment">\u00D7</button>\n' : '') +
        '            </div>';
      // Extraction failure banner (visible warning, not collapsible)
      if (att.extracted_text && att.extracted_text.indexOf('(extraction failed') === 0) {
        html += '\n            <div class="scan-banner">\n' +
          '              <span>\u26A0\uFE0F ' + escHtml(att.extracted_text) + '</span>\n' +
          '            </div>';
      // Extracted text preview
      } else if (att.extracted_text && att.extracted_text !== '__SCANNED_PDF__' && att.extracted_text !== '__LIBRARY_UNAVAILABLE__' && att.extracted_text !== '(no text extracted)') {
        var extractedEscaped = escHtml(att.extracted_text);
        html += '\n            <details class="msg-attachment-text-preview">\n' +
          '              <summary>\uD83D\uDCCB Extracted text' +
          '                <button class="copy-extract-btn" title="Copy extracted text" onclick="var p=this.parentElement.parentElement.querySelector(\'pre\');if(p){navigator.clipboard.writeText(p.textContent).then(function(){var b=this;b.innerHTML=\'<i data-lucide=check style=width:13px;height:13px></i>\';lucide.createIcons();setTimeout(function(){b.innerHTML=\'<i data-lucide=copy style=width:13px;height:13px></i>\';lucide.createIcons();},2000)}.bind(this))}" style="background:none;border:none;cursor:pointer;color:var(--text-tertiary);padding:0 2px;margin-left:6px;vertical-align:-2px;"><i data-lucide="copy" style="width:13px;height:13px;"></i></button>' +
          '              </summary>\n' +
          '              <pre>' + extractedEscaped + '</pre>\n' +
          '            </details>';
      } else if (att.extracted_text === '__SCANNED_PDF__' && !hasScannedPDF) {
        html += '\n            <div class="scan-banner">\n' +
          '              <span>\u26A0\uFE0F No extractable text (scanned PDF) \u2014 attached as image(s)</span>\n' +
          '              <button onclick="this.parentElement.remove()">\u00D7</button>\n' +
          '            </div>';
      }
    }
  }
  return html;
}

function _buildEditUiHtml(msg) {
  return '            <div class="msg-edit-ui">\n' +
    '              <textarea class="msg-edit-textarea">' + escHtml(msg.content || '') + '</textarea>\n' +
    '              <div class="msg-edit-actions">\n' +
    '                <button class="ghost-btn cancel-edit">Cancel</button>\n' +
    '                <div style="display:flex; gap:12px;">\n' +
    '                  <button class="ghost-btn save-branch"><i data-lucide="git-branch" style="width:16px;height:16px;"></i> Save as Branch</button>\n' +
    '                  <button class="btn-primary save-overwrite">Overwrite</button>\n' +
    '                </div>\n' +
    '              </div>\n' +
    '            </div>';
}

function appendChatMessage(message) {
  chatMessages.push(message);
  var container = document.getElementById('chat-messages');
  if (!container) return;
  container.appendChild(createMessageBubble(message, chatMessages.length - 1));
  if (typeof lucide !== 'undefined') lucide.createIcons();
  var scrollEl = document.getElementById('chat-scroll');
  if (scrollEl) scrollEl.scrollTop = scrollEl.scrollHeight;
  hideLoadingIndicator();
}

// Replace an existing bubble's content in place (used to turn a "Searching…"
// search card into the real results card without re-rendering the chat).
function updateChatMessage(message) {
  if (!message || !message.id) return;
  var container = document.getElementById('chat-messages');
  if (!container) return;
  var old = container.querySelector('[data-msg-id="' + message.id + '"]');
  if (!old) return;
  // Preserve the user's collapsed/expanded choice across the replace - the
  // streaming progress re-renders the card every ~250ms and would otherwise
  // clobber a user-initiated collapse.
  var oldToggle = old.querySelector ? old.querySelector('.search-card-toggle') : null;
  // A live card is expanded only to show progress. Preserve the DOM state
  // here only after the user has explicitly toggled it; otherwise the final
  // result card would inherit the temporary live expansion.
  if (oldToggle && Object.prototype.hasOwnProperty.call(_persistedSearchStates, message.id))
    _persistedSearchStates[message.id] = oldToggle.getAttribute('aria-expanded') === 'true';
  var idx = -1;
  for (var i = 0; i < chatMessages.length; i++) {
    if (chatMessages[i] && chatMessages[i].id === message.id) { idx = i; break; }
  }
  if (idx >= 0) chatMessages[idx] = message;
  var fresh = createMessageBubble(message, idx >= 0 ? idx : chatMessages.length - 1);
  old.replaceWith(fresh);
  if (typeof lucide !== 'undefined') lucide.createIcons();
}

function removeLastAssistantMessage() {
  for (var i = chatMessages.length - 1; i >= 0; i--) {
    if (chatMessages[i].role === 'assistant') {
      chatMessages.splice(i, 1);
      break;
    }
  }
  renderChatMessages(chatMessages);
}
