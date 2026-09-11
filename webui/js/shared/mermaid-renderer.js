// mermaid-renderer.js - Lazy rendering for Markdown ```mermaid fences.
(function(root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(root);
  else root.MermaidRenderer = factory(root);
})(typeof globalThis !== 'undefined' ? globalThis : this, function(root) {
  'use strict';

  var MERMAID_MODULE_URL = 'https:' + '//cdn.jsdelivr.net/npm/mermaid@11.17.2/dist/mermaid.esm.min.mjs';
  var initialized = false;
  var observer = null;
  var renderSequence = 0;
  var mermaidPromise = null;
  var customLoader = null;

  function _cssVar(name, fallback) {
    if (!root.document || typeof root.getComputedStyle !== 'function') return fallback;
    var value = root.getComputedStyle(root.document.documentElement).getPropertyValue(name);
    return String(value || '').trim() || fallback;
  }

  function _config() {
    return {
      startOnLoad: false,
      securityLevel: 'strict',
      theme: 'base',
      themeVariables: {
        background: _cssVar('--bg-panel', '#ffffff'),
        primaryColor: _cssVar('--bg-hover', '#f3f4f6'),
        primaryTextColor: _cssVar('--text-primary', '#111827'),
        primaryBorderColor: _cssVar('--border-main', '#d1d5db'),
        lineColor: _cssVar('--text-secondary', '#4b5563'),
        secondaryColor: _cssVar('--bg-main', '#f9fafb'),
        tertiaryColor: _cssVar('--bg-panel', '#ffffff')
      }
    };
  }

  function _loadMermaid() {
    if (root.mermaid) return Promise.resolve(root.mermaid);
    if (mermaidPromise) return mermaidPromise;

    var loader = customLoader || function() {
      return import(MERMAID_MODULE_URL).then(function(mod) {
        return mod && (mod.default || mod);
      });
    };

    mermaidPromise = Promise.resolve().then(loader).then(function(mermaid) {
      if (!mermaid || typeof mermaid.render !== 'function' || typeof mermaid.initialize !== 'function') {
        throw new Error('Mermaid module did not expose the expected API');
      }
      mermaid.initialize(_config());
      return mermaid;
    }).catch(function(error) {
      mermaidPromise = null;
      throw error;
    });

    return mermaidPromise;
  }

  function _appendError(node) {
    if (!root.document || !node || node.querySelector('.mermaid-error-message')) return;
    var errorEl = root.document.createElement('div');
    errorEl.className = 'mermaid-error-message';
    errorEl.textContent = 'Could not render Mermaid diagram. Showing source instead.';
    node.appendChild(errorEl);
  }

  function renderDiagram(node) {
    if (!node || !node.getAttribute) return Promise.resolve(false);
    var state = node.getAttribute('data-mermaid-state');
    if (state === 'rendering' || state === 'rendered') return Promise.resolve(false);

    var sourceEl = node.querySelector && node.querySelector('.mermaid-source');
    var source = sourceEl ? String(sourceEl.textContent || '') : '';
    if (!source.trim()) return Promise.resolve(false);

    node.setAttribute('data-mermaid-state', 'rendering');
    var renderId = 'ahkllm-mermaid-' + (++renderSequence);

    return _loadMermaid()
      .then(function(mermaid) {
        return mermaid.render(renderId, source);
      })
      .then(function(result) {
        var svg = typeof result === 'string' ? result : (result && result.svg);
        if (!svg) throw new Error('Mermaid returned no SVG');

        // Streaming may replace the message DOM before async rendering finishes.
        if (node.isConnected === false) return false;

        node.innerHTML = svg;
        node.setAttribute('data-mermaid-state', 'rendered');
        node.classList.add('mermaid-rendered');

        if (result && typeof result.bindFunctions === 'function') result.bindFunctions(node);
        return true;
      })
      .catch(function(error) {
        // Keep the escaped source visible as the readable failure mode.
        if (node.isConnected !== false) {
          node.setAttribute('data-mermaid-state', 'error');
          node.classList.add('mermaid-error');
          _appendError(node);
        }
        if (root.console && typeof root.console.warn === 'function') {
          root.console.warn('[Mermaid] render failed:', error);
        }
        return false;
      });
  }

  function renderPending(scope) {
    if (!scope) return;
    var nodes = [];

    if (scope.matches && scope.matches('.mermaid-diagram[data-mermaid-state="pending"]')) {
      nodes.push(scope);
    }
    if (scope.querySelectorAll) {
      var found = scope.querySelectorAll('.mermaid-diagram[data-mermaid-state="pending"]');
      for (var i = 0; i < found.length; i++) nodes.push(found[i]);
    }

    for (var j = 0; j < nodes.length; j++) renderDiagram(nodes[j]);
  }

  function init(options) {
    if (initialized) return;
    initialized = true;
    options = options || {};
    customLoader = options.loadMermaid || null;

    if (!root.document) return;

    renderPending(root.document);

    if (typeof root.MutationObserver === 'function' && root.document.body) {
      observer = new root.MutationObserver(function(mutations) {
        for (var i = 0; i < mutations.length; i++) {
          var added = mutations[i].addedNodes || [];
          for (var j = 0; j < added.length; j++) renderPending(added[j]);
        }
      });
      observer.observe(root.document.body, { childList: true, subtree: true });
    }
  }

  return {
    init: init,
    renderDiagram: renderDiagram,
    renderPending: renderPending,
    moduleUrl: MERMAID_MODULE_URL
  };
});
