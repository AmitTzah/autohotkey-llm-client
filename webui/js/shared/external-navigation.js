// external-navigation.js - Open web links outside the embedded WebView.
(function(root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(root);
  else root.ExternalNavigation = factory(root);
})(typeof globalThis !== 'undefined' ? globalThis : this, function(root) {
  'use strict';

  var initialized = false;

  function handleClick(event) {
    var target = event && event.target;
    var link = target && typeof target.closest === 'function'
      ? target.closest('a[href]')
      : null;
    if (!link) return;

    var url = String(link.href || '');
    if (!/^https?:\/\/[^\s]+$/i.test(url)) return;

    event.preventDefault();
    if (root.Ipc && typeof root.Ipc.postToHost === 'function') {
      root.Ipc.postToHost('openExternalUrl', { url: url });
    }
  }

  function init(doc) {
    if (initialized) return;
    doc = doc || root.document;
    if (!doc || typeof doc.addEventListener !== 'function') return;
    doc.addEventListener('click', handleClick);
    initialized = true;
  }

  return {
    init: init,
    handleClick: handleClick
  };
});
