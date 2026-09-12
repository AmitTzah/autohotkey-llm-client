// ======================================================
// chat-trash.js — Trash list sidebar
// ======================================================

function loadTrashList(threads) {
  var trashItems = document.querySelector('.trash-items');
  if (!trashItems) return;
  trashItems.innerHTML = '';

  if (!threads || threads.length === 0) {
    var trashWrap2 = document.getElementById('trashWrap');
    if (trashWrap2) trashWrap2.classList.add('collapsed');
    return;
  }

  for (var i = 0; i < threads.length; i++) {
    (function(t) {
      var item = document.createElement('div');
      item.className = 'trash-item';
      item.innerHTML =
        '<div class="chat-name">' + escHtml(t.title || 'New Chat') + '</div>' +
        '<div class="trash-item-acts">' +
          '<button title="Restore"><i data-lucide="rotate-ccw" style="width:16px;height:16px;"></i></button>' +
          '<button class="danger" title="Delete forever"><i data-lucide="x" style="width:16px;height:16px;"></i></button>' +
        '</div>';

      item.querySelector('button[title="Restore"]').addEventListener('click', function() {
    Ipc.postToHost('sidebarAction', { subAction: 'restoreThread', threadId: t.id });
      });
      item.querySelector('button.danger').addEventListener('click', function() {
        _showChatConfirm('Permanently delete?', function() {
    Ipc.postToHost('sidebarAction', { subAction: 'deleteThreadForever', threadId: t.id });
        });
      });

      trashItems.appendChild(item);
    })(threads[i]);
  }

  // Preserve the user's disclosure choice across trash data refreshes.
  // Thread loads refresh both sidebar lists, so auto-expanding non-empty Trash
  // here makes it open whenever a chat is selected. Empty Trash still collapses
  // above because there is nothing useful to disclose.

  if (typeof lucide !== 'undefined') lucide.createIcons();
}

// Trash toggle (collapsed by default)
if (typeof document !== 'undefined' && document.addEventListener) {
  document.addEventListener('DOMContentLoaded', function() {
    var trashToggle = document.getElementById('trashToggle');
    if (trashToggle) {
      trashToggle.addEventListener('click', function() {
        document.getElementById('trashWrap').classList.toggle('collapsed');
      });
    }
  });
}
