// main.js - Application composition and WebView bootstrap.

var md = window.MarkdownRenderer.create();

window.chrome.webview.addEventListener('message', window.WebMessageRouter.handle);

document.addEventListener('DOMContentLoaded', function() {
  window.ExternalNavigation.init();
  window.AppShell.init();
  if (window.MermaidRenderer) window.MermaidRenderer.init();

  if (window.ChatInput) window.ChatInput.init();
  if (window.ChatFormat) window.ChatFormat.init();
  if (window.ChatSidebar) window.ChatSidebar.init();
  if (window.ChatTreeModal) window.ChatTreeModal.init();
  if (window.ChatStream) window.ChatStream.init();
  if (window.ChatSearch) window.ChatSearch.init();
  if (window.ModelPickerConfig) window.ModelPickerConfig.init();

  Ipc.postToHost('sidebarAction', { subAction: 'loadThreadList' });
  Ipc.postToHost('sidebarAction', { subAction: 'loadTrashList' });

  try {
    Ipc.postToHost('webViewReady');
  } catch (e) {
    console.error('[Bootstrap] Failed to notify webViewReady:', e);
  }

  var storedContent = sessionStorage.getItem('preMarkdownText');
  if (storedContent && !isChatMode) renderMarkdown(storedContent);
});
