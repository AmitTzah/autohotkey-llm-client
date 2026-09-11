// ======================================================
// chat-format.js — Clipboard, number formatting, token usage bar
// ======================================================

// Format a single message as text (role label + content + attachment extracted text)
function getMessageText(msg) {
  var text = '';
  switch (msg.role) {
    case 'user': text = 'You:\n' + msg.content; break;
    case 'assistant': text = (msg.model || 'Assistant') + ':\n' + msg.content; break;
    case 'system': text = 'System Prompt:\n' + msg.content; break;
  }
  if (msg.attachments && msg.attachments.length) {
    for (var a = 0; a < msg.attachments.length; a++) {
      var att = msg.attachments[a];
      if (att.extracted_text && att.extracted_text !== '__SCANNED_PDF__' && att.extracted_text !== '__LIBRARY_UNAVAILABLE__' && att.extracted_text !== '(no text extracted)') {
        var label = 'File';
        if (att.attachment_type === 'pdf') label = 'PDF';
        else if (att.attachment_type === 'docx') label = 'DOCX';
        text += '\n\n[Attached ' + label + ': ' + (att.original_filename || 'file') + ']\n' + att.extracted_text;
      }
    }
  }
  return text;
}

// Copy a single message's content to clipboard
function copySingleMessage(index) {
  var msg = chatMessages[index];
  if (!msg) return;
  navigator.clipboard.writeText(getMessageText(msg)).then(function() {
    showCopiedFeedback(index);
  }).catch(function(err) {
    console.error('Failed to copy: ', err);
  });
}

// Copy entire chat to clipboard
function copyEntireChat() {
  var parts = [];
  for (var i = 0; i < chatMessages.length; i++) {
    parts.push(getMessageText(chatMessages[i]));
  }

  var fullText = parts.join('\n\n---\n\n');

  navigator.clipboard.writeText(fullText).then(function() {
    var btn = document.getElementById('copy-entire-chat-btn');
    if (!btn) return;
    var originalHTML = btn.innerHTML;
    btn.innerHTML = '<i data-lucide="check" style="width:20px;height:20px;"></i>';
    if (typeof lucide !== 'undefined') lucide.createIcons();
    setTimeout(function() {
      btn.innerHTML = originalHTML;
      if (typeof lucide !== 'undefined') lucide.createIcons();
    }, 2000);
  }).catch(function(err) {
    console.error('Failed to copy chat: ', err);
  });
}

// Export entire chat to a .txt file (same content as copyEntireChat, saved as a download)
function exportChat() {
  var parts = [];
  for (var i = 0; i < chatMessages.length; i++) {
    parts.push(getMessageText(chatMessages[i]));
  }

  var fullText = parts.join('\n\n---\n\n');

  var title = (typeof _threadMeta !== 'undefined' && activeThreadId && _threadMeta[activeThreadId] && _threadMeta[activeThreadId].title)
    ? _threadMeta[activeThreadId].title
    : 'chat';
  var safeName = String(title).replace(/[\\/:*?"<>|]/g, '-').replace(/\s+/g, '_').slice(0, 60) || 'chat';

  var blob = new Blob([fullText], { type: 'text/plain' });
  var url = URL.createObjectURL(blob);
  var a = document.createElement('a');
  a.href = url;
  a.download = safeName + '.txt';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);

  var btn = document.getElementById('export-chat-btn');
  if (btn) {
    var originalHTML = btn.innerHTML;
    btn.innerHTML = '<i data-lucide="check" style="width:20px;height:20px;"></i>';
    if (typeof lucide !== 'undefined') lucide.createIcons();
    setTimeout(function() {
      btn.innerHTML = originalHTML;
      if (typeof lucide !== 'undefined') lucide.createIcons();
    }, 2000);
  }
}

// Show checkmark feedback on a message's copy button
function showCopiedFeedback(index) {
  var container = document.getElementById('chat-messages');
  if (!container) return;
  var bubbles = container.querySelectorAll('.msg');
  if (bubbles[index]) {
    var copyBtn = bubbles[index].querySelector('.msg-action-btn[title="Copy"]');
    if (copyBtn) {
      var originalHTML = copyBtn.innerHTML;
      copyBtn.innerHTML = '<i data-lucide="check"></i>';
      if (typeof lucide !== 'undefined') lucide.createIcons();
      setTimeout(function() {
        copyBtn.innerHTML = originalHTML;
        if (typeof lucide !== 'undefined') lucide.createIcons();
      }, 2000);
    }
  }
}

// Copy code block content to clipboard
function copyCodeBlock(btn) {
  var wrapper = btn.closest('.code-block-wrapper');
  if (!wrapper) return;
  var codeEl = wrapper.querySelector('code');
  if (!codeEl) return;
  navigator.clipboard.writeText(codeEl.textContent || '').then(function() {
    var originalHTML = btn.innerHTML;
    btn.innerHTML = '<i data-lucide="check" style="width:22px;height:22px;"></i>';
    btn.classList.add('copied');
    if (typeof lucide !== 'undefined') lucide.createIcons();
    setTimeout(function() {
      btn.innerHTML = originalHTML;
      btn.classList.remove('copied');
      if (typeof lucide !== 'undefined') lucide.createIcons();
    }, 2000);
  }).catch(function(err) {
    console.error('Failed to copy code block: ', err);
  });
}

// Download code block content as a file
function downloadCodeBlock(btn) {
  var wrapper = btn.closest('.code-block-wrapper');
  if (!wrapper) return;
  var codeEl = wrapper.querySelector('code');
  if (!codeEl) return;
  var langLabel = wrapper.querySelector('.code-lang');
  var lang = langLabel ? langLabel.textContent.trim() : 'txt';
  var extension = _langToExtension(lang);
  var content = codeEl.textContent || '';
  var blob = new Blob([content], { type: 'text/plain' });
  var url = URL.createObjectURL(blob);
  var a = document.createElement('a');
  a.href = url;
  a.download = 'snippet.' + extension;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// Map language label to file extension
function _langToExtension(lang) {
  var map = {
    javascript: 'js', js: 'js', typescript: 'ts', ts: 'ts', tsx: 'tsx', jsx: 'jsx',
    python: 'py', py: 'py', java: 'java', c: 'c', cpp: 'cpp', 'c++': 'cpp',
    rust: 'rs', rs: 'rs', go: 'go', ruby: 'rb', rb: 'rb', php: 'php',
    swift: 'swift', kotlin: 'kt', kt: 'kt', scala: 'scala', r: 'r',
    sql: 'sql', bash: 'sh', sh: 'sh', shell: 'sh', powershell: 'ps1', ps1: 'ps1',
    bat: 'bat', cmd: 'bat', json: 'json', xml: 'xml', html: 'html',
    css: 'css', scss: 'scss', less: 'less', yaml: 'yml', yml: 'yml',
    toml: 'toml', ini: 'ini', markdown: 'md', md: 'md',
    ahk: 'ahk', autohotkey: 'ahk', dockerfile: 'dockerfile', docker: 'dockerfile',
    graphql: 'graphql', gql: 'graphql', perl: 'pl', lua: 'lua',
    dart: 'dart', elixir: 'ex', ex: 'ex', elm: 'elm', erlang: 'erl',
    haskell: 'hs', hs: 'hs', clojure: 'clj', clj: 'clj', ocaml: 'ml',
    pascal: 'pas', fortran: 'f90', julia: 'jl', matlab: 'm',
    makefile: 'makefile', cmake: 'cmake', nix: 'nix', groovy: 'groovy',
    vbnet: 'vb', 'vb.net': 'vb', fsharp: 'fs', 'f#': 'fs',
    diff: 'diff', patch: 'patch', properties: 'properties',
    proto: 'proto', protobuf: 'proto', csv: 'csv', tex: 'tex', latex: 'tex'
  };
  var normalized = lang.toLowerCase().replace(/[^a-z0-9+#]/g, '');
  return map[normalized] || 'txt';
}

// Format helpers
function formatNumber(n) {
  return n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

// Compact number format: 1234567 -> "1.2m", 1234 -> "1.2k"
function formatCompact(n) {
  if (n >= 1000000) return (n / 1000000).toFixed(1).replace(/\.0$/, '') + 'm';
  if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
  return String(n);
}

// Token usage bar
function showTokenUsageBar() {
  var bar = document.getElementById('tokenBar');
  if (!bar) return;

  // Always show zeros — updated by postThreadStats when data is available
  updateTokenUsage({
    activePathTokens: 0,
    contextWindow: 0,
    cumulativePromptTokens: 0,
    cumulativeCompletionTokens: 0,
    cumulativeCachedTokens: 0,
    cumulativeCost: 0,
    cumulativeInputCost: 0,
    cumulativeCachedInputCost: 0,
    cumulativeOutputCost: 0
  });
}

function updateTokenUsage(data) {
  var bar = document.getElementById('tokenBar');
  if (!bar) return;

  // Stats carry their owning thread id so completions cannot repaint another thread.
  // thread A must not repaint thread B's header while B is the active thread.
  if (data && data.threadId && activeThreadId && data.threadId !== activeThreadId) return;

  var cu = data.activePathTokens || 0;
  var cw = data.contextWindow || 0;
  var pt = data.cumulativeInputTokens || 0;
  var ct = data.cumulativeOutputTokens || 0;
  var ckt = data.cumulativeCachedTokens || 0;
  var cost = Number(data.cumulativeCost || 0).toFixed(2);

  // Cost gets dynamic breakdown; others get field explanation
  var costTip = 'Input: $' + (Number(data.cumulativeInputCost) || 0).toFixed(4) +
    '  |  Cached: $' + (Number(data.cumulativeCachedInputCost) || 0).toFixed(4) +
    '  |  Output: $' + (Number(data.cumulativeOutputCost) || 0).toFixed(4);

  bar.innerHTML =
    '<div class="tu-item" title="Context used from the active conversation path">' +
      '<i data-lucide="hash" class="tu-icon"></i>' +
      '<span class="tu-val">' + formatCompact(cu) + (cw ? ' / ' + formatCompact(cw) : '') + '</span>' +
    '</div>' +
    // This tooltip describes cumulative input/output usage across branches.
    '<div class="tu-item" title="Cumulative Input/output token usage across all conversation branches">' +
      '<i data-lucide="activity" class="tu-icon"></i>' +
      '<span class="tu-val">\u2191 ' + formatCompact(pt) + ' &nbsp;\u2193 ' + formatCompact(ct) + '</span>' +
    '</div>' +
    '<div class="tu-item" title="Input tokens that were cache hits">' +
      '<i data-lucide="database" class="tu-icon"></i>' +
      '<span class="tu-val">' + formatCompact(ckt) + '</span>' +
    '</div>' +
    '<div class="tu-item" title="' + costTip + '">' +
      '<i data-lucide="dollar-sign" class="tu-icon"></i>' +
      '<span class="tu-val">$' + cost + '</span>' +
    '</div>';

  if (typeof lucide !== 'undefined') lucide.createIcons();
}


var _chatFormatInitialized = false;
if (typeof window !== 'undefined') window.ChatFormat = {
  init: function() {
    if (_chatFormatInitialized) return;
    _chatFormatInitialized = true;

    showTokenUsageBar();

    var copyAllBtn = document.getElementById('copy-entire-chat-btn');
    if (copyAllBtn) copyAllBtn.addEventListener('click', copyEntireChat);

    var exportChatBtn = document.getElementById('export-chat-btn');
    if (exportChatBtn) exportChatBtn.addEventListener('click', exportChat);
  }
};
