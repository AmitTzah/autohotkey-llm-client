// markdown-renderer.js - Shared Markdown/KaTeX renderer configuration.
(function(root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(root);
  else root.MarkdownRenderer = factory(root);
})(typeof globalThis !== 'undefined' ? globalThis : this, function(root) {
  'use strict';

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // markdown-it-texmath recognizes \\[...\\] as block math only when the
  // opening delimiter starts a Markdown block. Models commonly put a label on
  // the immediately preceding line, so ensure a block boundary before a
  // standalone \\[ delimiter. Fenced and indented code remain literal.
  function normalizeBracketDisplayMath(content) {
    var lines = String(content || '').split('\n');
    var output = [];
    var fenceChar = '';
    var fenceLength = 0;

    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      var fenceMatch = line.match(/^\s*(`{3,}|~{3,})/);
      if (fenceMatch) {
        var marker = fenceMatch[1];
        if (!fenceChar) {
          fenceChar = marker.charAt(0);
          fenceLength = marker.length;
        } else if (marker.charAt(0) === fenceChar && marker.length >= fenceLength) {
          fenceChar = '';
          fenceLength = 0;
        }
        output.push(line);
        continue;
      }

      var isIndentedCode = /^(?: {4}|\t)/.test(line);
      var isOpen = !fenceChar && !isIndentedCode && /^\\\[\s*$/.test(line);
      var isClose = !fenceChar && !isIndentedCode && /^\\\]\s*$/.test(line);

      if (isOpen && output.length && output[output.length - 1].trim() !== '') {
        output.push('');
      }

      output.push(line);

      if (isClose && i + 1 < lines.length && lines[i + 1].trim() !== '') {
        output.push('');
      }
    }

    return output.join('\n');
  }

  function create(deps) {
    deps = deps || {};
    var markdownit = deps.markdownit || root.markdownit;
    var texmath = deps.texmath || root.texmath;
    var katex = deps.katex || root.katex;
    var hljs = deps.hljs || root.hljs;

    if (typeof markdownit !== 'function') throw new Error('Markdown renderer requires markdown-it');
    if (!texmath) throw new Error('Markdown renderer requires markdown-it-texmath');
    if (!katex) throw new Error('Markdown renderer requires KaTeX');

    var md = markdownit({
      // Raw model/user HTML must remain inert because this WebView can message the host.
      html: false,
      // Preserve single-newline soft breaks in model and pasted user content.
      breaks: true,
      linkify: true,
      typographer: true,
      highlight: function(str, lang) {
        var langLabel = escapeHtml(lang || 'text');
        var headerHtml = '<div class="code-block-actions-sticky">' +
          '<button class="code-action-btn" title="Copy code" onclick="copyCodeBlock(this)"><i data-lucide="copy" style="width:22px;height:22px;"></i></button>' +
          '<button class="code-action-btn" title="Download" onclick="downloadCodeBlock(this)"><i data-lucide="download" style="width:22px;height:22px;"></i></button>' +
        '</div>' +
        '<div class="code-block-header">' +
          '<span class="code-lang">' + langLabel + '</span>' +
        '</div>';

        if (lang && hljs && typeof hljs.getLanguage === 'function' && hljs.getLanguage(lang)) {
          try {
            return '<div class="code-block-wrapper">' + headerHtml +
              '<pre class="hljs"><code>' +
              hljs.highlight(str, { language: lang, ignoreIllegals: true }).value +
              '</code></pre></div>';
          } catch (__) { }
        }

        return '<div class="code-block-wrapper">' + headerHtml +
          '<pre class="hljs"><code>' + escapeHtml(str) + '</code></pre></div>';
      }
    }).use(texmath, {
      engine: katex,
      delimiters: ['dollars', 'brackets'],
      katexOptions: { macros: { "\\RR": "\\mathbb{R}" } }
    });

    var defaultFence = md.renderer.rules.fence;
    md.renderer.rules.fence = function(fences, idx, options, env, self) {
      var fence = fences[idx];
      var info = String(fence.info || '').trim().split(/\s+/)[0].toLowerCase();
      if (info === 'mermaid') {
        return '<div class="mermaid-diagram" data-mermaid-state="pending">' +
          '<pre class="mermaid-source">' + escapeHtml(fence.content || '') + '</pre>' +
          '</div>\n';
      }
      return defaultFence(fences, idx, options, env, self);
    };

    var render = md.render.bind(md);
    md.render = function(content, env) {
      return render(normalizeBracketDisplayMath(content), env);
    };

    return md;
  }

  return {
    create: create,
    normalizeBracketDisplayMath: normalizeBracketDisplayMath
  };
});
