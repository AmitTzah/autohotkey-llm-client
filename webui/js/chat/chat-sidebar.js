// ======================================================
// chat-sidebar.js — Thread list sidebar, folders, thread switching
// ======================================================

// Map of threadId → { title, folder } — populated by loadThreadList, single source of truth
var _threadMeta = {};
// Array of { id, name } — available folders, populated by loadThreadList
var _folders = [];
// Session-only completion attention state. It intentionally survives thread-list
// rerenders but is cleared when the user opens that chat.
var _threadAttention = {};

function _setThreadAttentionClass(threadId, enabled) {
  var items = document.querySelectorAll('.chat-item');
  for (var i = 0; i < items.length; i++) {
    if (items[i].getAttribute('data-chat') !== threadId) continue;
    if (enabled) items[i].classList.add('completed-unread');
    else items[i].classList.remove('completed-unread');
  }
}

function markThreadCompleted(threadId) {
  if (!threadId || threadId === activeThreadId) return;
  _threadAttention[threadId] = true;
  _setThreadAttentionClass(threadId, true);
}

function clearThreadCompleted(threadId) {
  if (!threadId) return;
  delete _threadAttention[threadId];
  _setThreadAttentionClass(threadId, false);
}

function toggleSidebar() {
  Ipc.postToHost('sidebarAction', { subAction: 'loadThreadList' });
  Ipc.postToHost('sidebarAction', { subAction: 'loadTrashList' });
}

// -----------------------------------------------------------
// Topbar title — one sync point, always reads _threadMeta
// -----------------------------------------------------------

// Called by loadThread, loadThreadList, newChat, threadForked.
// Also called by main.js default handler when AHK sends "updateTopbarTitle" target.
function updateTopbarTitle(data) {
  // External update (from AHK via main.js): store in _threadMeta
  if (data && data.text !== undefined && activeThreadId) {
    if (!_threadMeta[activeThreadId]) _threadMeta[activeThreadId] = {};
    _threadMeta[activeThreadId].title = data.text;
    if (data.folder !== undefined) _threadMeta[activeThreadId].folder = data.folder;
  }

  // Read from _threadMeta for the active thread
  var meta = activeThreadId ? _threadMeta[activeThreadId] : null;
  var title = (meta && meta.title) ? meta.title : 'New Chat';
  var folder = (meta && meta.folder) ? meta.folder : 'Unfiled';

  var titleEl = document.querySelector('.title-text');
  if (titleEl) titleEl.textContent = title;
  var foldEl = document.querySelector('.fold');
  if (foldEl) { foldEl.textContent = folder; foldEl.style.display = ''; }
}

// Format relative date: "Today, 09:53", "Yesterday, 14:20", "Mon, 11:05"
function formatRelativeDate(dateStr) {
  if (!dateStr) return '';
  var d = new Date(dateStr + (dateStr.indexOf('Z') < 0 ? 'Z' : ''));
  if (isNaN(d.getTime())) return dateStr.substring(0, 16);
  var now = new Date();
  var today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  var msgDay = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  var diff = Math.floor((today - msgDay) / 86400000);
  var time = d.toLocaleString(undefined, {hour:'2-digit',minute:'2-digit',hour12:false});
  if (diff === 0) return 'Today, ' + time;
  if (diff === 1) return 'Yesterday, ' + time;
  var days = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  return days[d.getDay()] + ', ' + time;
}

// Provider-specific colored badge for chat items
function _providerIconHtml(model, provider) {
  if (window.ProviderIcons) return window.ProviderIcons.html(model, provider, 20);
  var iconFile = '../icons/openrouter.ico';
  var iconStyle = 'width:24px;height:24px;flex-shrink:0;mix-blend-mode:multiply;';
  if (model) {
    var m = model.toLowerCase();
    if (m.indexOf('deepseek') >= 0) iconFile = '../icons/deepseek.ico';
    else if (m.indexOf('gpt') >= 0 || m.indexOf('o1') >= 0 || m.indexOf('o3') >= 0 || m.indexOf('openai') >= 0) iconFile = '../icons/openai.ico';
    else if (m.indexOf('claude') >= 0 || m.indexOf('anthropic') >= 0) iconFile = '../icons/anthropic.ico';
    else if (m.indexOf('gemini') >= 0 || m.indexOf('gemma') >= 0 || m.indexOf('google') >= 0) iconFile = '../icons/google.ico';
    else if (m.indexOf('perplexity') >= 0) iconFile = '../icons/perplexity.ico';
    else if (m.indexOf('openrouter') >= 0) {
      iconFile = '../icons/openrouter.ico';
      iconStyle = 'width:20px;height:20px;flex-shrink:0;background:#7c3aed;border-radius:50%;padding:2px;mix-blend-mode:normal;';
    }
  }
  return '<img src="' + iconFile + '" style="' + iconStyle + '" alt="">';
}

// -----------------------------------------------------------
// Thread list rendering
// -----------------------------------------------------------

function loadThreadList(threads, folders) {
  var list = document.getElementById('thread-list');
  if (!list) return;
  list.innerHTML = '';

  folders = folders || [];
  threads = threads || [];
  _folders = folders; // Store for move-to-folder dropdown

  // Populate _threadMeta from incoming data (single source of truth)
  for (var i = 0; i < threads.length; i++) {
    var t = threads[i];
    if (!_threadMeta[t.id]) _threadMeta[t.id] = {};
    _threadMeta[t.id].title = t.title;
    _threadMeta[t.id].folder = t.folder_name || '';
  }

  if (threads.length === 0 && folders.length === 0) {
    list.innerHTML = '<div style="padding:1rem;color:var(--text-tertiary);font-size:0.85rem;">No chats yet.</div>';
    updateTopbarTitle();
    return;
  }

  for (var fi = 0; fi < folders.length; fi++) {
    list.appendChild(_buildFolderSection(folders[fi], threads));
  }

  // Unfiled chats
  var unfiled = threads.filter(function(t) { return !t.folder_id; });
  if (unfiled.length > 0 || folders.length === 0) {
    var unfiledLabel = document.createElement('div');
    unfiledLabel.className = 'unfiled-label';
    unfiledLabel.textContent = 'Unfiled';
    list.appendChild(unfiledLabel);

    for (var ui = 0; ui < unfiled.length; ui++) {
      list.appendChild(createChatItem(unfiled[ui]));
    }
  }

  // Sync topbar for active thread (handles title-gen and chat-switch updates)
  updateTopbarTitle();

  if (typeof lucide !== 'undefined') lucide.createIcons();
}

function createChatItem(t) {
  var item = document.createElement('div');
  item.className = 'chat-item';
  if (t.id === activeThreadId) {
    delete _threadAttention[t.id];
    item.classList.add('active');
  } else if (_threadAttention[t.id]) {
    item.classList.add('completed-unread');
  }
  item.setAttribute('data-chat', t.id);

  var dateStr = formatRelativeDate(t.updated_at || t.created_at);

  item.innerHTML =
    '<div class="chat-icon">' + _providerIconHtml(t.model, t.provider) + '</div>' +
    '<div class="chat-meta">' +
      '<div class="chat-name">' + escHtml(t.title || 'New Chat') +
        (t.is_locked ? ' <i data-lucide="lock" style="width:12px;height:12px;vertical-align:-1px;"></i>' : '') +
      '</div>' +
      '<div class="chat-item-bottom">' +
        '<div class="chat-date">' + dateStr + '</div>' +
        '<div class="chat-actions">' +
          (t.is_locked && t.title === 'Locked chat'
            ? ''
            : '<button class="chat-action-btn" title="Rename"><i data-lucide="edit-2"></i></button>') +
          '<button class="chat-action-btn" title="Move to folder"><i data-lucide="folder"></i></button>' +
          '<button class="chat-action-btn" title="Lock options"><i data-lucide="lock"></i></button>' +
          '<button class="chat-action-btn danger" title="Delete"><i data-lucide="trash-2"></i></button>' +
        '</div>' +
      '</div>' +
    '</div>';

  item.addEventListener('click', function(e) {
    if (e.target.closest('.chat-action-btn')) return;
    loadThread(t.id);
  });

  if (item.querySelector('.chat-action-btn[title="Rename"]'))
    _wireRenameHandler(item, t);
  _wireMoveToFolderHandler(item, t);

  // Lock options menu (Lock Chat / Unlock Chat / Change password)
  item.querySelector('.chat-action-btn[title="Lock options"]')
    .addEventListener('click', function(e) {
      e.stopPropagation();
      if (typeof openLockMenu === 'function')
        openLockMenu(t.id, this, t);
    });

  // Delete
  item.querySelector('.chat-action-btn.danger').addEventListener('click', function(e) {
    e.stopPropagation();
    _showChatConfirm('Delete this chat?', function() {
      Ipc.postToHost('sidebarAction', { subAction: 'deleteThread', threadId: t.id });
    });
  });

  return item;
}

function _wireRenameHandler(item, t) {
  item.querySelector('.chat-action-btn[title="Rename"]').addEventListener('click', function(e) {
    e.stopPropagation();
    _makeInlineEditor(item.querySelector('.chat-name'), item.querySelector('.chat-name').textContent, function(newTitle) {
          Ipc.postToHost('sidebarAction', { subAction: 'renameThread', threadId: t.id, title: newTitle });
    });
  });
}

function _addFolderPickItem(dd, label, folderId, threadId) {
  var item = document.createElement('div');
  item.textContent = label;
  item.style.cssText = 'padding:8px 12px;cursor:pointer;border-radius:4px;font-size:0.85rem;';
  item.addEventListener('mouseenter', function() { this.style.background = 'var(--bg-hover)'; });
  item.addEventListener('mouseleave', function() { this.style.background = ''; });
  item.addEventListener('click', function(ev) {
    ev.stopPropagation();
    Ipc.postToHost('sidebarAction', { subAction: 'moveToFolder', threadId: threadId, folderId: folderId });
    dd.remove();
  });
  dd.appendChild(item);
}

function _wireMoveToFolderHandler(item, t) {
  item.querySelector('.chat-action-btn[title="Move to folder"]').addEventListener('click', function(e) {
    e.stopPropagation();
    var btn = this;
    var existing = document.querySelector('.folder-pick-dropdown');
    if (existing) existing.remove();

    var dd = document.createElement('div');
    dd.className = 'folder-pick-dropdown';
    dd.style.cssText = 'position:fixed;z-index:100;background:var(--bg-panel);border:1px solid var(--border-main);border-radius:8px;box-shadow:var(--shadow-modal);padding:4px;min-width:150px;';
    var rect = btn.getBoundingClientRect();
    dd.style.left = rect.left + 'px'; dd.style.top = (rect.bottom + 2) + 'px';

    _addFolderPickItem(dd, 'Unfiled (no folder)', '__none__', t.id);
    for (var fi = 0; fi < _folders.length; fi++) {
      _addFolderPickItem(dd, _folders[fi].name, _folders[fi].id, t.id);
    }
    document.body.appendChild(dd);
    setTimeout(function() {
      document.addEventListener('click', function closeDd(ev2) {
        if (!dd.contains(ev2.target) && ev2.target !== btn) { dd.remove(); document.removeEventListener('click', closeDd); }
      });
    }, 0);
  });
}

function _buildFolderSection(folder, threads) {
  var folderThreads = threads.filter(function(t) { return t.folder_id === folder.id; });
  var folderDiv = document.createElement('div');
  folderDiv.className = 'folder';
  folderDiv.setAttribute('data-folder', folder.id);

  var head = document.createElement('div');
  head.className = 'folder-head';
  head.innerHTML = '<div style="display:flex; align-items:center; gap:8px; flex:1;">' +
    '<i data-lucide="chevron-down" class="folder-chevron"></i>' +
    '<span class="folder-name">' + escHtml(folder.name) + '</span>' +
    '<span class="folder-count">' + folderThreads.length + '</span></div>' +
    '<div class="folder-actions">' +
      '<button class="folder-action-btn" title="Rename Folder"><i data-lucide="edit-2" style="width:16px;height:16px;"></i></button>' +
      '<button class="folder-action-btn danger folder-delete-btn" title="Delete Folder"><i data-lucide="trash-2" style="width:16px;height:16px;"></i></button></div>';

  head.addEventListener('click', function(e) {
    if (e.target.closest('.folder-action-btn')) return;
    this.closest('.folder').classList.toggle('collapsed');
  });
  head.querySelector('.folder-action-btn:not(.danger)').addEventListener('click', function(e) {
    e.stopPropagation();
    _makeInlineEditor(this.closest('.folder-head').querySelector('.folder-name'), folder.name, function(newName) {
    Ipc.postToHost('sidebarAction', { subAction: 'renameFolder', folderId: folder.id, name: newName });
    }, '120px');
  });
  head.querySelector('.folder-delete-btn').addEventListener('click', function(e) {
    e.stopPropagation();
    // Pass the raw folder name; _showChatConfirm escapes the complete message once.
    // message once (escHtml), so a pre-escaped name would be double-escaped
    // and the confirm dialog would show HTML entities instead of characters
    // like "A&B<C>".
    _showChatConfirm('Delete folder "' + folder.name + '"? Chats will become unfiled.', function() {
    Ipc.postToHost('sidebarAction', { subAction: 'deleteFolder', folderId: folder.id });
    });
  });
  folderDiv.appendChild(head);

  var chatsDiv = document.createElement('div');
  chatsDiv.className = 'folder-chats';
  for (var ci = 0; ci < folderThreads.length; ci++) {
    chatsDiv.appendChild(createChatItem(folderThreads[ci]));
  }
  folderDiv.appendChild(chatsDiv);
  return folderDiv;
}

// -----------------------------------------------------------
// Thread switching
// -----------------------------------------------------------

function _setActiveHighlight(threadId) {
  var allItems = document.querySelectorAll('.chat-item');
  for (var i = 0; i < allItems.length; i++) {
    var chatId = allItems[i].getAttribute('data-chat');
    if (chatId === threadId) {
      allItems[i].classList.add('active');
    } else {
      allItems[i].classList.remove('active');
    }
  }
}

function loadThread(threadId) {
  if (!threadId) {
    activeThreadId = "";
    updateTopbarTitle();
    if (typeof updateScopedSearchState === 'function') updateScopedSearchState();
    return;
  }
  if (typeof window._showChat === 'function') window._showChat();
  clearThreadCompleted(threadId);
  activeThreadId = threadId;
  updateTopbarTitle();
  _setActiveHighlight(threadId);
    Ipc.postToHost('sidebarAction', { subAction: 'loadThread', threadId: threadId });
}

function newChat() {
  activeThreadId = '';
  updateTopbarTitle();
  _setActiveHighlight('');
    Ipc.postToHost('sidebarAction', { subAction: 'newChat' });
}

function threadForked(data) {
  loadThread(data.newThreadId);
  Ipc.postToHost('sidebarAction', { subAction: 'loadThreadList' });
}


var _chatSidebarInitialized = false;

function _wireTopbarRename() {
  var renameBtn = document.querySelector('.rename-chat-btn');
  if (!renameBtn) return;

  renameBtn.addEventListener('click', function() {
    var titleEl = document.querySelector('.title-text');
    if (!titleEl || titleEl.querySelector('input')) return;

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
    input.addEventListener('keydown', function(e) {
      if (e.key === 'Enter') input.blur();
      if (e.key === 'Escape') titleEl.textContent = currentTitle;
    });
  });
}

function _wireNewFolderButton() {
  var newFolderBtn = document.querySelector('.rail-head-actions button[title="New folder"]');
  if (!newFolderBtn) return;

  newFolderBtn.addEventListener('click', function() {
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
      if (name) Ipc.postToHost('sidebarAction', { subAction: 'createFolder', name: name });
    };

    input.addEventListener('blur', save);
    input.addEventListener('keydown', function(e) {
      if (e.key === 'Enter') input.blur();
      if (e.key === 'Escape') input.remove();
    });
  });
}

if (typeof window !== 'undefined') window.ChatSidebar = {
  init: function() {
    if (_chatSidebarInitialized) return;
    _chatSidebarInitialized = true;

    _wireTopbarRename();
    _wireNewFolderButton();

    var newChatBtn = document.getElementById('new-chat-btn');
    if (newChatBtn) newChatBtn.addEventListener('click', newChat);
  }
};
