// ======================================================
// provider-icons.js — Shared provider icon resolution
//
// The AhkLLM transport provider wins over model-name heuristics. This matters
// for nested OpenRouter ids such as openrouter/anthropic/claude-...: the
// request is routed through OpenRouter, so every provider badge should show
// OpenRouter rather than the upstream model vendor.
// ======================================================
(function(root) {
  'use strict';

  var files = {
    deepseek: '../icons/deepseek.ico',
    openai: '../icons/openai.ico',
    codex: '../icons/openai.ico',
    anthropic: '../icons/anthropic.ico',
    google: '../icons/google.ico',
    perplexity: '../icons/perplexity.ico',
    openrouter: '../icons/openrouter.ico'
  };

  function key(model, explicitProvider) {
    var provider = String(explicitProvider || '').toLowerCase();
    if (files[provider]) return provider;

    var m = String(model || '').toLowerCase();
    var slash = m.indexOf('/');
    if (slash > 0) {
      var outer = m.slice(0, slash);
      if (files[outer]) return outer;
    }

    if (m.indexOf('deepseek') >= 0) return 'deepseek';
    if (m.indexOf('gpt') >= 0 || m.indexOf('o1') >= 0 || m.indexOf('o3') >= 0 || m.indexOf('openai') >= 0) return 'openai';
    if (m.indexOf('claude') >= 0 || m.indexOf('anthropic') >= 0) return 'anthropic';
    if (m.indexOf('gemini') >= 0 || m.indexOf('gemma') >= 0 || m.indexOf('google') >= 0) return 'google';
    if (m.indexOf('perplexity') >= 0) return 'perplexity';
    if (m.indexOf('openrouter') >= 0) return 'openrouter';
    return 'openrouter';
  }

  function file(model, provider) {
    return files[key(model, provider)] || files.openrouter;
  }

  function style(model, provider, size) {
    var px = Number(size) || 20;
    // OpenRouter's purple badge adds 2px padding on every side, so its actual
    // outer footprint is px+4. Give the plain provider artwork that same outer
    // footprint so OpenAI/DeepSeek/Google/etc. do not look undersized beside it.
    if (key(model, provider) === 'openrouter') {
      return 'width:' + px + 'px;height:' + px + 'px;flex-shrink:0;background:#7c3aed;border-radius:50%;padding:2px;mix-blend-mode:normal;';
    }
    var visualPx = px + 4;
    return 'width:' + visualPx + 'px;height:' + visualPx + 'px;flex-shrink:0;mix-blend-mode:multiply;';
  }

  function html(model, provider, size, className) {
    var cls = className ? ' class="' + className + '"' : '';
    return '<img' + cls + ' src="' + file(model, provider) + '" style="' + style(model, provider, size) + '" alt="">';
  }

  root.ProviderIcons = { key: key, file: file, style: style, html: html };
})(typeof window !== 'undefined' ? window : this);
