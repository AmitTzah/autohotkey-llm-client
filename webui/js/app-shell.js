// app-shell.js - Top-level Chat / Dashboard / Settings navigation.
(function(root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(root);
  else root.AppShell = factory(root);
})(typeof globalThis !== 'undefined' ? globalThis : this, function(root) {
  'use strict';

  var initialized = false;

  function byId(id) {
    return root.document ? root.document.getElementById(id) : null;
  }

  function showChat() {
    var chatLayout = byId('chat-layout');
    var dashPanel = byId('dashboard-panel');
    if (chatLayout) chatLayout.style.display = '';
    if (dashPanel) dashPanel.style.display = 'none';
    var dashboardIcon = byId('dashboard-icon');
    if (dashboardIcon) dashboardIcon.classList.remove('active');
    var sidebarToggle = byId('sidebar-toggle');
    if (sidebarToggle) sidebarToggle.classList.add('active');
  }

  function showDashboardView() {
    var chatLayout = byId('chat-layout');
    var dashPanel = byId('dashboard-panel');
    if (chatLayout) chatLayout.style.display = 'none';
    if (dashPanel) {
      dashPanel.style.display = 'flex';
      if (typeof root.loadData === 'function') root.loadData();
    }
    var dashboardIcon = byId('dashboard-icon');
    if (dashboardIcon) dashboardIcon.classList.add('active');
    var sidebarToggle = byId('sidebar-toggle');
    if (sidebarToggle) sidebarToggle.classList.remove('active');
  }

  function showSettings() {
    var chatLayout = byId('chat-layout');
    var dashPanel = byId('dashboard-panel');
    var settingsNav = byId('settingsNav');
    var alreadyOpen = settingsNav && settingsNav.style.display !== 'none';

    if (chatLayout) chatLayout.style.display = 'none';
    if (dashPanel) dashPanel.style.display = 'none';

    var railLeft = byId('railLeft');
    if (railLeft) railLeft.style.display = 'none';

    if (settingsNav) {
      settingsNav.style.display = '';
      if (settingsNav.offsetWidth < 40) {
        settingsNav.style.width = '340px';
        settingsNav.classList.remove('mini');
      }
    }

    var settingsCenter = byId('settingsCenter');
    if (settingsCenter) settingsCenter.style.display = '';

    var settingsIcon = byId('settings-icon');
    if (settingsIcon) settingsIcon.classList.add('active');
    var dashboardIcon = byId('dashboard-icon');
    if (dashboardIcon) dashboardIcon.classList.remove('active');
    var sidebarToggle = byId('sidebar-toggle');
    if (sidebarToggle) sidebarToggle.classList.remove('active');

    if (root.SettingsPanel && typeof root.SettingsPanel.init === 'function') root.SettingsPanel.init();
    if (!alreadyOpen && root.Ipc) root.Ipc.postToHost('requestAllSettings');
  }

  function hideSettings() {
    var settingsNav = byId('settingsNav');
    if (settingsNav) settingsNav.style.display = 'none';
    var settingsCenter = byId('settingsCenter');
    if (settingsCenter) settingsCenter.style.display = 'none';
    var railLeft = byId('railLeft');
    if (railLeft) railLeft.style.display = '';
    var chatLayout = byId('chat-layout');
    if (chatLayout) chatLayout.style.display = '';
    var settingsIcon = byId('settings-icon');
    if (settingsIcon) settingsIcon.classList.remove('active');
  }

  function showConfirm(title, msg, btnText, onConfirm) {
    var titleEl = byId('confirmModalTitle');
    var msgEl = byId('confirmModalMsg');
    var btn = byId('confirmBtn');
    var modal = byId('confirmModal');
    if (!titleEl || !msgEl || !btn || !modal) return;

    titleEl.textContent = title;
    msgEl.textContent = msg;
    btn.textContent = btnText;

    var handler = function() {
      modal.classList.remove('open');
      btn.removeEventListener('click', handler);
      if (onConfirm) onConfirm();
    };
    btn.addEventListener('click', handler);
    modal.classList.add('open');
  }

  function confirmDiscardSettings(action) {
    if (root.SettingsPanel && root.SettingsPanel.isDirty && root.SettingsPanel.isDirty()) {
      showConfirm('Unsaved Changes', 'You have unsaved changes in Settings. Discard them?', 'Discard', function() {
        root.SettingsPanel.clearDirty();
        action();
      });
    } else {
      action();
    }
  }

  function showDashboard() {
    confirmDiscardSettings(function() {
      hideSettings();
      showDashboardView();
    });
  }

  function wireSettingsModals() {
    var cmdHelpBtn = byId('cmdHelpBtn');
    if (cmdHelpBtn) {
      cmdHelpBtn.addEventListener('click', function() {
        var modal = byId('cmdHelpModal');
        if (modal) modal.classList.add('open');
      });
    }

    ['refreshModal', 'confirmModal', 'sysMsgEditModal', 'cmdHelpModal'].forEach(function(modalId) {
      var modal = byId(modalId);
      if (!modal || !modal.querySelectorAll) return;
      modal.querySelectorAll('.modal-head .icon-btn, .modal-foot .btn-ghost').forEach(function(btn) {
        btn.addEventListener('click', function() { modal.classList.remove('open'); });
      });
    });
  }

  function init() {
    if (initialized || !root.document) return;
    initialized = true;

    wireSettingsModals();

    var settingsIcon = byId('settings-icon');
    if (settingsIcon) settingsIcon.addEventListener('click', showSettings);

    var dashboardIcon = byId('dashboard-icon');
    if (dashboardIcon) dashboardIcon.addEventListener('click', showDashboard);

    var sidebarToggle = byId('sidebar-toggle');
    if (sidebarToggle) {
      sidebarToggle.addEventListener('click', function() {
        confirmDiscardSettings(function() {
          hideSettings();
          showChat();
          var railLeft = byId('railLeft');
          if (railLeft && (railLeft.style.width === '0px' || railLeft.style.width === '' || railLeft.classList.contains('mini'))) {
            railLeft.style.width = '340px';
            railLeft.classList.remove('mini');
          }
          if (typeof root.toggleSidebar === 'function') root.toggleSidebar();
        });
      });
    }
  }

  root._showDashboard = showDashboard;
  root._showChat = showChat;
  root._showSettings = showSettings;
  root._hideSettings = hideSettings;
  root._showConfirm = showConfirm;

  return {
    init: init,
    showChat: showChat,
    showDashboard: showDashboard,
    showSettings: showSettings,
    hideSettings: hideSettings,
    showConfirm: showConfirm,
    confirmDiscardSettings: confirmDiscardSettings
  };
});
