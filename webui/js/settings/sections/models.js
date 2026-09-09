// models.js — Models settings section (pricing/metadata table + refresh modal)
(function() {
  var sectionName = 'models';
  var S = window.SettingsShared;
  var _providerKeys = ['deepseek', 'openai', 'google', 'anthropic'];
  var _openRouterLookups = {}; // IPC reqId -> model table row

  // --- Model id helpers ---

  function stripProvider(id) {
    var i = id.indexOf('/');
    return i >= 0 ? id.substring(i + 1) : id;
  }

  function displayModelId(id, provider) {
    // OpenRouter entries have an outer AhkLLM transport prefix plus the real
    // OpenRouter provider/model slug. Remove only the outer prefix for editing.
    if (provider === 'openrouter') {
      var openRouterId = String(id || '');
      return openRouterId.indexOf('openrouter/') === 0
        ? openRouterId.slice('openrouter/'.length)
        : openRouterId;
    }
    return stripProvider(id);
  }

  function ensureFullId(id, provider) {
    id = String(id || '').trim();
    // OpenRouter model ids are themselves provider/model slugs. Keep the full
    // upstream slug after AhkLLM's transport prefix. openrouter/free remains
    // the built-in backward-compatible free router used by new installs.
    if (provider === 'openrouter') {
      if (id === 'free' || id === 'openrouter/free') return 'openrouter/free';
      if (id.indexOf('openrouter/openrouter/') === 0) return id;
      return 'openrouter/' + id;
    }
    // When a provider is selected it is authoritative; strip any embedded prefix.
    // embedded prefix from the id and rebuild with the selected provider.
    if (provider) {
      var slash = id.indexOf('/');
      if (slash >= 0) {
        var firstSegment = id.slice(0, slash);
        var knownProviders = currentProviderKeys();
        if (firstSegment === provider || knownProviders.indexOf(firstSegment) >= 0)
          id = id.slice(slash + 1);
      }
      return provider + '/' + id;
    }
    return id;
  }

  // --- Pricing / context formatting and parsing ---

  function fmtPrice(v) {
    if (v === undefined || v === null || v === '') return '';
    v = parseFloat(v);
    if (isNaN(v)) return '';
    return (v < 0.01 ? '$' + v.toFixed(4) : v < 1 ? '$' + v.toFixed(3) : '$' + v.toFixed(2));
  }

  function formatContext(n) {
    if (n === undefined || n === null || n === '' || n === 0) return '';
    n = parseInt(n);
    if (isNaN(n)) return '';
    if (n >= 1000000) return (n / 1000000).toFixed(1).replace(/\.0$/, '') + 'M';
    if (n >= 1000) return (n / 1000).toFixed(0) + 'K';
    return n.toString();
  }

  function _parsePrice(el) {
    if (!el) return 0;
    var raw = el.getAttribute('data-price-raw');
    if (raw !== null && raw !== '') return parseFloat(raw) || 0;
    // Strip a leading "$" from pasted prices and preserve a blank field rather
    // than collapsing the app's blank-price value to 0.
    var v = (el.value || '').trim();
    if (v === '') return '';
    return parseFloat(v.replace(/^\$/, '')) || 0;
  }

  // Parse a context string with the k/M display suffix ("128K" -> 128000,
  // "1.5M" -> 1500000). Shared by _parseContext and the blur handler so
  // focus/blur round-trips preserve the suffix.
  function _parseContextString(str) {
    var v = str || '';
    if (/^\d+[kK]$/.test(v)) return parseInt(v) * 1000;
    if (/^\d+[mM]$/.test(v)) return parseInt(v) * 1000000;
    if (/^\d+(\.\d+)?[kK]$/.test(v)) return Math.round(parseFloat(v) * 1000);
    if (/^\d+(\.\d+)?[mM]$/.test(v)) return Math.round(parseFloat(v) * 1000000);
    return parseInt(v) || 0;
  }

  function _parseContext(el) {
    if (!el) return 0;
    var raw = el.getAttribute('data-context-raw');
    if (raw !== null && raw !== '') return parseInt(raw) || 0;
    return _parseContextString(el.value);
  }

  function parsePricingRaw(raw) {
    var fields = {};
    var providerMatch = raw.match(/provider:\s*"([^"]+)"/);
    if (providerMatch) fields.provider = providerMatch[1];
    var m = raw.match(/input:\s*([\d.]+)/);
    if (m) fields.input = parseFloat(m[1]);
    m = raw.match(/cachedInput:\s*([\d.]+)/);
    if (m) fields.cachedInput = parseFloat(m[1]);
    m = raw.match(/output:\s*([\d.]+)/);
    if (m) fields.output = parseFloat(m[1]);
    m = raw.match(/context:\s*(\d+)/);
    if (m) fields.context = parseInt(m[1], 10);
    m = raw.match(/reasoning:\s*(true|false)/i);
    fields.reasoning = m ? m[1].toLowerCase() === 'true' : false;
    m = raw.match(/vision:\s*(true|false)/i);
    fields.vision = m ? m[1].toLowerCase() === 'true' : false;
    // Model metadata (api/compat/thinkingLevelMap/thinkingOff) must survive
    // the refresh -> add -> save round-trip: unlike default model ids, a newly
    // added id has no defaults entry to refill these from, so whatever the
    // fetched entry carries is all it will ever have.
    m = raw.match(/api:\s*"([^"]+)"/);
    if (m) fields.api = m[1];
    m = raw.match(/thinkingOff:\s*"([^"]+)"/);
    if (m) fields.thinkingOff = m[1];
    var compatIdx = raw.indexOf('compat: Map(');
    if (compatIdx >= 0) {
      var compat = _parseAhkMap(raw, compatIdx);
      if (compat) fields.compat = compat;
    }
    var levelsIdx = raw.indexOf('thinkingLevelMap: Map(');
    if (levelsIdx >= 0) {
      var levels = _parseAhkMap(raw, levelsIdx);
      if (levels) fields.thinkingLevelMap = levels;
    }
    return fields;
  }

  function _openRouterPricePerMillion(value) {
    if (value === undefined || value === null || value === '') return '';
    var n = parseFloat(value);
    return isNaN(n) ? '' : n * 1000000;
  }

  function parseOpenRouterModelResponse(raw) {
    var parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    var d = parsed && parsed.data;
    if (!d || !d.id) throw new Error('Invalid OpenRouter model response');

    var pricing = d.pricing || {};
    var arch = d.architecture || {};
    var inputs = Array.isArray(arch.input_modalities) ? arch.input_modalities : [];
    var supported = Array.isArray(d.supported_parameters) ? d.supported_parameters : [];
    var reasoningInfo = d.reasoning || null;
    var reasoning = !!reasoningInfo || supported.indexOf('reasoning') >= 0 || supported.indexOf('reasoning_effort') >= 0;
    var efforts = [];
    if (reasoningInfo && Array.isArray(reasoningInfo.supported_efforts)) {
      efforts = reasoningInfo.supported_efforts.slice();
    } else if (reasoningInfo && reasoningInfo.supported_efforts === null) {
      efforts = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
    } else if (reasoning) {
      efforts = ['low', 'medium', 'high'];
    }
    var levelMap = {};
    efforts.forEach(function(level) {
      if (level && level !== 'none' && level !== 'default') levelMap[level] = level;
    });

    return {
      canonicalId: d.id,
      displayName: d.name || '',
      provider: 'openrouter',
      input: _openRouterPricePerMillion(pricing.prompt),
      cachedInput: _openRouterPricePerMillion(pricing.input_cache_read),
      output: _openRouterPricePerMillion(pricing.completion),
      context: parseInt(d.context_length, 10) || 0,
      vision: inputs.indexOf('image') >= 0,
      reasoning: reasoning,
      api: 'openai-completions',
      compat: {
        thinkingFormat: 'openai',
        supportsReasoningEffort: Object.keys(levelMap).length > 0,
        supportsUsageInStreaming: true,
        maxTokensField: 'max_tokens'
      },
      thinkingLevelMap: levelMap,
      thinkingOff: reasoning && !(reasoningInfo && reasoningInfo.mandatory) ? 'none' : ''
    };
  }

  // Parse an AHK "Map(...)" literal from `text` starting at `fromIndex`
  // (the "Map(" keyword) into a JS object. Values are strings, booleans, or
  // numbers; keys are strings. Used for compat / thinkingLevelMap metadata in
  // the raw fetched entries (scripts/models_metadata.txt format).
  function _parseAhkMap(text, fromIndex) {
    var start = text.indexOf('Map(', fromIndex);
    if (start < 0) return null;
    var i = start + 4; // skip "Map("
    var depth = 0;
    var inStr = false;
    var bodyStart = i;
    var bodyEnd = -1;
    for (; i < text.length; i++) {
      var ch = text[i];
      if (inStr) {
        if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') { inStr = true; continue; }
      if (ch === '(') { depth++; continue; }
      if (ch === ')') {
        if (depth === 0) { bodyEnd = i; break; }
        depth--;
      }
    }
    if (bodyEnd < 0) return null;
    var body = text.slice(bodyStart, bodyEnd);
    var tokens = _splitMapArgs(body);
    var obj = {};
    for (var t = 0; t + 1 < tokens.length; t += 2) {
      var key = _ahkScalar(tokens[t]);
      if (typeof key !== 'string') continue;
      obj[key] = _ahkScalar(tokens[t + 1]);
    }
    return obj;
  }

  // Split Map(...) argument text on top-level commas (ignores commas inside
  // quoted strings).
  function _splitMapArgs(body) {
    var tokens = [];
    var cur = '';
    var inStr = false;
    for (var i = 0; i < body.length; i++) {
      var ch = body[i];
      if (inStr) {
        cur += ch;
        if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') { inStr = true; cur += ch; continue; }
      if (ch === ',') { tokens.push(cur.trim()); cur = ''; continue; }
      cur += ch;
    }
    if (cur.trim()) tokens.push(cur.trim());
    return tokens;
  }

  // Interpret an AHK scalar token: quoted string, true/false, or number.
  function _ahkScalar(token) {
    var s = String(token).trim();
    if (s.length >= 2 && s.charAt(0) === '"' && s.charAt(s.length - 1) === '"')
      return s.slice(1, -1);
    if (s === 'true') return true;
    if (s === 'false') return false;
    if (s !== '' && !isNaN(Number(s))) return Number(s);
    return s;
  }

  function currentProviderKeys() {
    if (window.SettingsProviders && typeof window.SettingsProviders.getProviderOptions === 'function') {
      var options = window.SettingsProviders.getProviderOptions() || [];
      if (options.length) return options.map(function(p) { return p.key; }).filter(Boolean).sort();
    }
    var live = [];
    if (typeof document !== 'undefined' && document.querySelectorAll) {
      document.querySelectorAll('#providerGrid .provider-card').forEach(function(card) {
        var key = card && card.dataset ? String(card.dataset.providerKey || '').trim() : '';
        if (key && live.indexOf(key) < 0) live.push(key);
      });
    }
    // Provider cards are the live source while Settings is open, so models can
    // reference a provider added or removed in the same unsaved edit session.
    return live.length ? live.sort() : _providerKeys.slice();
  }

  function providerLabelForKey(key) {
    if (window.SettingsProviders && typeof window.SettingsProviders.getProviderOptions === 'function') {
      var options = window.SettingsProviders.getProviderOptions() || [];
      for (var i = 0; i < options.length; i++) {
        if (options[i].key === key) return options[i].label || key;
      }
    }
    if (typeof document !== 'undefined' && document.querySelectorAll) {
      var cards = document.querySelectorAll('#providerGrid .provider-card');
      for (var j = 0; j < cards.length; j++) {
        var card = cards[j];
        var cardKey = card && card.dataset ? String(card.dataset.providerKey || '').trim() : '';
        if (cardKey !== key || !card.querySelector) continue;
        var nameEl = card.querySelector('[data-field="displayName"]');
        var name = String(nameEl && nameEl.value || '').trim();
        if (name) return name;
      }
    }
    return key;
  }

  function syncProviderOptions() {
    if (typeof document === 'undefined' || !document.querySelectorAll) return;
    document.querySelectorAll('#modelsTableBody [data-field="provider"], #refreshRightTbody [data-field="provider"]').forEach(function(sel) {
      var current = sel.value || '';
      var replacement = buildProviderSelect(current);
      var match = replacement.match(/^<select[^>]*>([\s\S]*)<\/select>$/);
      if (match) sel.innerHTML = match[1];
      sel.value = current;
    });
  }

  function renameProvider(oldKey, newKey) {
    oldKey = String(oldKey || '').trim();
    newKey = String(newKey || '').trim();
    if (!oldKey || !newKey || oldKey === newKey) return;
    if (typeof document !== 'undefined' && document.querySelectorAll) {
      document.querySelectorAll('#modelsTableBody [data-field="provider"], #refreshRightTbody [data-field="provider"]').forEach(function(sel) {
        if (sel.value === oldKey) sel.value = newKey;
      });
    }
    var idx = _providerKeys.indexOf(oldKey);
    if (idx >= 0) _providerKeys[idx] = newKey;
    syncProviderOptions();
  }

  function buildProviderSelect(current) {
    var html = '<select class="settings-provider-select" data-field="provider">';
    var all = currentProviderKeys();
    if (current != null && current !== '' && all.indexOf(current) < 0) all.unshift(current);
    all.forEach(function(k) {
      var display = providerLabelForKey(k) || k;
      html += '<option value="' + S.escHtml(k) + '" title="Provider ID: ' + S.escHtml(k) + '"' + (k === current ? ' selected' : '') + '>' + S.escHtml(display) + '</option>';
    });
    html += '</select>';
    return html;
  }

  // Emit a data-*-raw attribute only when a value actually exists, so empty
  // rows keep their blank display until the user edits them.
  function _rawAttr(name, value) {
    if (value === undefined || value === null || value === '') return '';
    return ' data-' + name + '-raw="' + value + '"';
  }

  // --- Row builders (single source for the main table and refresh modal) ---

  function _mainRowHtml(id, provider, values, placeholder) {
    var m = values || {};
    var ph = placeholder ? ' placeholder="' + placeholder + '"' : '';
    return '<td class="settings-model-id-cell"><div class="settings-model-id-control"><input class="settings-w-200 settings-model-id-input" value="' + S.escHtml(displayModelId(id, provider)) + '"' + ph + ' data-field="id"><button class="btn-sm lookup-openrouter-model" style="display:none" title="Look up an exact OpenRouter model slug or provider/model ID">Lookup</button></div></td>' +
      '<td>' + buildProviderSelect(provider) + '</td>' +
      '<td><input class="settings-w-80" value="' + fmtPrice(m.input) + '" data-field="input"' + _rawAttr('price', m.input) + '></td>' +
      '<td><input class="settings-w-80" value="' + fmtPrice(m.cachedInput) + '" data-field="cachedInput"' + _rawAttr('price', m.cachedInput) + '></td>' +
      '<td><input class="settings-w-80" value="' + fmtPrice(m.output) + '" data-field="output"' + _rawAttr('price', m.output) + '></td>' +
      '<td><input class="settings-w-60" value="' + formatContext(m.context || 0) + '" data-field="context"' + _rawAttr('context', m.context) + '></td>' +
      '<td class="settings-text-center"><input type="checkbox" ' + (m.vision ? 'checked' : '') + ' data-field="vision"></td>' +
      '<td class="settings-text-center"><input type="checkbox" ' + (m.reasoning ? 'checked' : '') + ' data-field="reasoning"></td>' +
      '<td class="actions"><button class="btn-sm danger">\u2715</button></td>';
  }

  function _rightRowHtml(id, m) {
    var prov = m.provider || '';
    var parts = id.split('/');
    if (!prov && parts.length > 1) prov = parts[0];
    return '<td class="refresh-owned-model-cell"><input class="refresh-owned-model-input" value="' + S.escHtml(displayModelId(id, prov)) + '" data-field="id" data-full-id="' + S.escHtml(id) + '"></td>' +
      '<td>' + buildProviderSelect(prov) + '</td>' +
      '<td><input class="refresh-price-input" value="' + fmtPrice(m.input) + '" data-field="input"' + _rawAttr('price', m.input) + '></td>' +
      '<td><input class="refresh-price-input" value="' + fmtPrice(m.cachedInput) + '" data-field="cachedInput"' + _rawAttr('price', m.cachedInput) + '></td>' +
      '<td><input class="refresh-price-input" value="' + fmtPrice(m.output) + '" data-field="output"' + _rawAttr('price', m.output) + '></td>' +
      '<td><input class="refresh-context-input" value="' + formatContext(m.context || 0) + '" data-field="context"' + _rawAttr('context', m.context) + '></td>' +
      '<td class="settings-text-center"><input type="checkbox" ' + (m.vision ? 'checked' : '') + ' data-field="vision"></td>' +
      '<td class="settings-text-center"><input type="checkbox" ' + (m.reasoning ? 'checked' : '') + ' data-field="reasoning"></td>' +
      '<td class="actions"><button class="btn-sm danger">\u2715</button></td>';
  }

  // --- Row wiring ---

  function _wireFields(tr) {
    tr.querySelectorAll('input, select').forEach(function(el) {
      el.addEventListener('change', mark);
      el.addEventListener('input', mark);
    });
  }

  function _wirePriceContext(tr) {
    tr.querySelectorAll('[data-price-raw]').forEach(function(el) { _wirePriceInput(el); });
    var ctxInp = tr.querySelector('[data-field="context"]');
    if (ctxInp) _wireContextInput(ctxInp);
  }

  function _wirePriceInput(input) {
    input.addEventListener('focus', function() {
      var raw = input.getAttribute('data-price-raw');
      if (raw !== null && raw !== '') input.value = raw;
    });
    input.addEventListener('blur', function() {
      // Parse raw input like _parsePrice: strip a leading "$" and reject invalid text.
      // ("$0.5" must stay 0.5), never silently zero a non-numeric paste, and
      // keep a blank field blank.
      var rawValue = String(input.value || '').trim();
      if (rawValue === '') {
        input.setAttribute('data-price-raw', '');
        input.value = '';
        return;
      }
      var v = parseFloat(rawValue.replace(/^\$/, ''));
      if (isNaN(v)) return;
      input.setAttribute('data-price-raw', v);
      input.value = fmtPrice(v);
    });
  }

  function _wireContextInput(input) {
    input.addEventListener('focus', function() {
      var raw = input.getAttribute('data-context-raw');
      if (raw !== null && raw !== '') input.value = raw;
    });
    input.addEventListener('blur', function() {
      // Parse the displayed k/M suffix before storing the raw context value.
      // parseInt collapsed "128K" to 128 and stored that as the raw value,
      // silently shrinking the saved context 1000x.
      var v = _parseContextString(input.value);
      input.setAttribute('data-context-raw', v);
      input.value = formatContext(v);
    });
  }

  function _wireMainRow(tr) {
    _wireFields(tr);
    _wirePriceContext(tr);
    var lookupBtn = tr.querySelector('.lookup-openrouter-model');
    var providerEl = tr.querySelector('[data-field="provider"]');
    var idEl = tr.querySelector('[data-field="id"]');
    var deleteBtn = tr.querySelector('.btn-sm.danger');
    var idCell = idEl && idEl.closest ? idEl.closest('td') : (idEl && idEl.parentElement ? idEl.parentElement : null);
    var statusEl = tr.querySelector('.settings-model-lookup-status');
    if (!statusEl && idCell && document.createElement && idCell.appendChild) {
      statusEl = document.createElement('div');
      statusEl.className = 'settings-model-lookup-status';
      if (statusEl.setAttribute) statusEl.setAttribute('aria-live', 'polite');
      idCell.appendChild(statusEl);
    }
    function setStatus(text, state) {
      if (!statusEl) return;
      statusEl.textContent = text || '';
      statusEl.className = 'settings-model-lookup-status' + (text ? ' is-visible' : '') +
        (state === 'error' ? ' is-error' : state === 'success' ? ' is-success' : '');
    }
    tr._setOpenRouterLookupStatus = setStatus;
    function syncLookupButton() {
      if (!lookupBtn) return;
      if (!lookupBtn.style) lookupBtn.style = {};
      var slug = String(idEl && idEl.value || '').trim();
      var isOpenRouter = providerEl && providerEl.value === 'openrouter';
      var isBuiltInFree = slug === 'free' || slug === 'openrouter/free';
      lookupBtn.style.display = isOpenRouter && !isBuiltInFree ? '' : 'none';
      if (!isOpenRouter || isBuiltInFree) setStatus('', '');
    }
    if (providerEl) providerEl.addEventListener('change', syncLookupButton);
    if (idEl) idEl.addEventListener('input', function() { setStatus('', ''); syncLookupButton(); });
    if (lookupBtn) lookupBtn.addEventListener('click', function() {
      var slug = String(idEl && idEl.value || '').trim();
      if (!slug) {
        lookupBtn.title = '';
        setStatus('Enter an OpenRouter model slug first.', 'error');
        return;
      }
      lookupBtn.disabled = true;
      lookupBtn.textContent = 'Looking up…';
      lookupBtn.title = '';
      setStatus('Fetching metadata from OpenRouter…', '');
      var reqId = Ipc.postToHost('lookupOpenRouterModel', { modelId: slug });
      _openRouterLookups[reqId] = tr;
    });
    syncLookupButton();
    if (deleteBtn) deleteBtn.addEventListener('click', function() { tr.remove(); mark(); });
  }

  function _wireRightRow(tr, onRemove) {
    _wirePriceContext(tr);
    tr.querySelector('.btn-sm.danger').addEventListener('click', onRemove);
  }

  // Stash model metadata on the row so save() can re-emit it. The Settings
  // table only edits pricing/features, but the entry in settings.json also
  // carries api/compat/thinkingLevelMap/thinkingOff. Dropping them on save is
  // invisible for default ids (SettingsMerge refills from defaults) but
  // permanently breaks newly added ids (no default entry to merge from).
  function _stashMeta(tr, m) {
    if (!tr || !m) return;
    var meta = {};
    if (m.api !== undefined) meta.api = m.api;
    if (m.compat !== undefined) meta.compat = m.compat;
    if (m.thinkingLevelMap !== undefined) meta.thinkingLevelMap = m.thinkingLevelMap;
    if (m.thinkingOff !== undefined) meta.thinkingOff = m.thinkingOff;
    if (m.displayName !== undefined) meta.displayName = m.displayName;
    if (Object.keys(meta).length) tr.dataset.modelMeta = JSON.stringify(meta);
  }

  function _readMeta(tr) {
    if (!tr || !tr.dataset || !tr.dataset.modelMeta) return {};
    try { return JSON.parse(tr.dataset.modelMeta) || {}; } catch (e) { return {}; }
  }

  // Read a row's current values from its DOM elements.
  function _readRowValues(tr) {
    var values = {
      provider: (tr.querySelector('[data-field="provider"]') || {}).value || '',
      input: _parsePrice(tr.querySelector('[data-field="input"]')),
      cachedInput: _parsePrice(tr.querySelector('[data-field="cachedInput"]')),
      output: _parsePrice(tr.querySelector('[data-field="output"]')),
      context: _parseContext(tr.querySelector('[data-field="context"]')),
      vision: (tr.querySelector('[data-field="vision"]') || {}).checked || false,
      reasoning: (tr.querySelector('[data-field="reasoning"]') || {}).checked || false
    };
    var meta = _readMeta(tr);
    for (var k in meta) values[k] = meta[k];
    return values;
  }

  function mark() { S.markDirty(); }

  // --- Main table ---

  function load(data) {
    if (!data || !data.models) return;
    if (data.providers) _providerKeys = Object.keys(data.providers).sort();
    renderTable(data.models);
  }

  function renderTable(models) {
    var tbody = document.getElementById('modelsTableBody');
    if (!tbody) return;
    tbody.innerHTML = '';
    Object.keys(models).sort().forEach(function(key) {
      var m = models[key];
      var tr = document.createElement('tr');
      tr.innerHTML = _mainRowHtml(key, m.provider, m);
      tbody.appendChild(tr);
      _stashMeta(tr, m);
      _wireMainRow(tr);
    });
  }

  function addRow() {
    var tbody = document.getElementById('modelsTableBody'); if (!tbody) return;
    var tr = document.createElement('tr');
    tr.innerHTML = _mainRowHtml('', '', {}, 'model slug or provider/model');
    tbody.appendChild(tr);
    _wireMainRow(tr);
    mark();
  }

  function save() {
    var models = {};
    document.querySelectorAll('#modelsTableBody tr').forEach(function(tr) {
      var id = (tr.querySelector('[data-field="id"]') || {}).value || '';
      if (!id) return;
      var values = _readRowValues(tr);
      var fullId = ensureFullId(id, values.provider);
      models[fullId] = {
        provider: values.provider,
        input: values.input,
        cachedInput: values.cachedInput,
        output: values.output,
        context: values.context,
        vision: values.vision,
        reasoning: values.reasoning
      };
      _applyMeta(models[fullId], values);
      _applyCodexDefaults(models[fullId], values);
    });
    return { models: models };
  }

  // Copy stashed metadata (api/compat/thinkingLevelMap/thinkingOff) onto a
  // saved entry so new model ids don't lose their thinking metadata.
  function _applyCodexDefaults(entry, values) {
    if (!entry || !values || values.provider !== 'codex') return;
    entry.reasoning = true;
    if (values.api === undefined) entry.api = 'codex-cli';
    if (values.compat === undefined) {
      entry.compat = {
        thinkingFormat: 'codex-cli',
        supportsReasoningEffort: true,
        supportsUsageInStreaming: false,
        maxTokensField: ''
      };
    }
    if (values.thinkingLevelMap === undefined) {
      // Unknown future Codex models get only the conservative common efforts.
      // Curated built-ins can expose none/xhigh/max when OpenAI documents them.
      entry.thinkingLevelMap = { low: 'low', medium: 'medium', high: 'high' };
    }
    if (values.thinkingOff === undefined) entry.thinkingOff = 'low';
  }

  function _applyMeta(entry, values) {
    ['api', 'compat', 'thinkingLevelMap', 'thinkingOff', 'displayName'].forEach(function(k) {
      if (values[k] !== undefined) entry[k] = values[k];
    });
  }

  function _collectCurrentModels() {
    var models = [];
    document.querySelectorAll('#modelsTableBody tr').forEach(function(tr) {
      var idEl = tr.querySelector('[data-field="id"]');
      if (!idEl || !idEl.value) return;
      var values = _readRowValues(tr);
      models.push({
        id: ensureFullId(idEl.value, values.provider), // full ID for internal use
        displayId: displayModelId(ensureFullId(idEl.value, values.provider), values.provider), // display without transport-provider prefix
        provider: values.provider,
        input: values.input,
        cachedInput: values.cachedInput,
        output: values.output,
        context: values.context,
        vision: values.vision,
        reasoning: values.reasoning
      });
      _applyMeta(models[models.length - 1], values);
      _applyCodexDefaults(models[models.length - 1], values);
    });
    return models;
  }

  // --- Refresh modal ---

  var _refreshData = {}; // cached parsed refresh data: { modelId: {input, cachedInput, output, context, vision, reasoning} }
  var _refreshAvailable = []; // fetched models from the last refresh: [{ id, raw }]
  var _refreshQuery = '';     // current search filter text

  function _setRefreshPanelHeight(height) {
    var body = document.getElementById('refreshModelsBody');
    var top = document.getElementById('refreshAvailablePanel');
    var splitter = document.getElementById('refreshPanelSplitter');
    if (!body || !top || !splitter || !body.getBoundingClientRect) return;
    var bodyHeight = body.getBoundingClientRect().height || body.clientHeight || 0;
    if (!bodyHeight) return;
    var splitterHeight = splitter.getBoundingClientRect ? splitter.getBoundingClientRect().height : 10;
    var minTop = 180;
    var minBottom = 240;
    var maxTop = Math.max(minTop, bodyHeight - minBottom - (splitterHeight || 10));
    var next = Math.max(minTop, Math.min(maxTop, height));
    top.style.flex = '0 0 ' + Math.round(next) + 'px';
  }

  function _wireRefreshPanelSplitter() {
    var splitter = document.getElementById('refreshPanelSplitter');
    var top = document.getElementById('refreshAvailablePanel');
    if (!splitter || !top || !splitter.dataset || splitter.dataset.resizeWired === 'true') return;
    splitter.dataset.resizeWired = 'true';

    splitter.addEventListener('mousedown', function(e) {
      if (!top.getBoundingClientRect) return;
      e.preventDefault();
      var startY = e.clientY;
      var startHeight = top.getBoundingClientRect().height;
      splitter.classList.add('is-dragging');
      function onMove(ev) { _setRefreshPanelHeight(startHeight + ev.clientY - startY); }
      function onUp() {
        splitter.classList.remove('is-dragging');
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
      }
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });

    splitter.addEventListener('keydown', function(e) {
      if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
      if (!top.getBoundingClientRect) return;
      e.preventDefault();
      var delta = e.key === 'ArrowUp' ? -24 : 24;
      _setRefreshPanelHeight(top.getBoundingClientRect().height + delta);
    });
  }

  function _wireResizableColumns(tableId) {
    var table = document.getElementById(tableId);
    if (!table || !table.dataset || table.dataset.columnsResizable === 'true') return;
    var headers = table.querySelectorAll('thead th');
    var cols = table.querySelectorAll('colgroup col');
    if (!headers.length || headers.length !== cols.length) return;
    table.dataset.columnsResizable = 'true';

    for (var i = 0; i < headers.length - 1; i++) {
      (function(index) {
        var handle = document.createElement('span');
        handle.className = 'refresh-column-resizer';
        handle.setAttribute('aria-hidden', 'true');
        handle.title = 'Drag to resize column';
        handle.addEventListener('mousedown', function(e) {
          if (!headers[index].getBoundingClientRect || !table.getBoundingClientRect) return;
          e.preventDefault();
          e.stopPropagation();
          var startX = e.clientX;
          var startWidth = headers[index].getBoundingClientRect().width;
          var startTableWidth = table.getBoundingClientRect().width;
          var minWidth = index < 2 ? 80 : 54;
          handle.classList.add('is-dragging');
          function onMove(ev) {
            var nextWidth = Math.max(minWidth, startWidth + ev.clientX - startX);
            cols[index].style.width = Math.round(nextWidth) + 'px';
            var parentWidth = table.parentElement ? table.parentElement.clientWidth : 0;
            table.style.width = Math.max(parentWidth, startTableWidth + nextWidth - startWidth) + 'px';
          }
          function onUp() {
            handle.classList.remove('is-dragging');
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onUp);
          }
          document.addEventListener('mousemove', onMove);
          document.addEventListener('mouseup', onUp);
        });
        headers[index].appendChild(handle);
      })(i);
    }
  }

  function _initRefreshLayout() {
    _wireRefreshPanelSplitter();
    _wireResizableColumns('refreshAvailableTable');
    _wireResizableColumns('refreshOwnedTable');
  }

  function _requestModelRefresh() {
    var payload = {};
    if (window.SettingsProviders && typeof window.SettingsProviders.getCurrentProviders === 'function')
      payload.providers = window.SettingsProviders.getCurrentProviders();
    var status = document.getElementById('refreshModelStatus');
    if (status) status.textContent = 'Refreshing model metadata from models.dev…';
    Ipc.postToHost('refreshModelPricing', payload);
  }

  function openRefreshModal() {
    var m = document.getElementById('refreshModal'); if (m) m.classList.add('open');
    var searchInput = document.getElementById('refreshModelSearch');
    if (searchInput) searchInput.value = '';
    _refreshQuery = '';
    _populateRightPanel();
    _initRefreshLayout();
    if (_refreshAvailable.length) _renderAvailableModels();
    _requestModelRefresh();
  }

  function filterAvailableModels(list, query) {
    var q = String(query || '').trim().toLowerCase();
    if (!q) return list.slice();
    return list.filter(function(m) {
      return m.id.toLowerCase().indexOf(q) >= 0 || stripProvider(m.id).toLowerCase().indexOf(q) >= 0;
    });
  }

  function buildAddButtonHtml(modelId, isAdded) {
    var dataId = 'data-id="' + S.escHtml(modelId) + '"';
    if (isAdded)
      return '<button class="btn-sm add-refresh-model settings-nowrap" ' + dataId + ' disabled>Added</button>';
    return '<button class="btn-sm add-refresh-model settings-nowrap" ' + dataId + '>+ Add</button>';
  }

  function _rightPanelIds() {
    var ids = [];
    var tbody = document.getElementById('refreshRightTbody');
    if (!tbody) return ids;
    tbody.querySelectorAll('tr').forEach(function(tr) {
      var idEl = tr.querySelector('[data-field="id"]');
      if (!idEl) return;
      // Prefer the live edited model id over the row's stale data-full-id value.
      // data-full-id attribute, which is only stamped when the row is built.
      var id = idEl.value || idEl.getAttribute('data-full-id');
      if (!id) return;
      // Rows copied from the settings table only hold the display id; fall
      // back to the provider column so they match fetched full ids like
      // "google/gemini-3-flash-preview".
      var provEl = tr.querySelector('[data-field="provider"]');
      var provider = provEl ? provEl.value || '' : '';
      if (provider) {
        ids.push(ensureFullId(id, provider));
        return;
      }
      if (id.indexOf('/') < 0) {
        var provEl = tr.querySelector('[data-field="provider"]');
        var provider = provEl ? provEl.value || '' : '';
        if (provider) id = provider + '/' + id;
      }
      ids.push(id);
    });
    return ids;
  }

  function _renderAvailableModels() {
    var tbody = document.getElementById('refreshLeftTbody');
    if (!tbody) return;
    var added = _rightPanelIds();
    var list = filterAvailableModels(_refreshAvailable, _refreshQuery);
    var html = '';
    list.forEach(function(m) {
      var p = _refreshData[m.id] || {};
      var isAdded = added.indexOf(m.id) >= 0;
      var providerName = p.provider || String(m.id || '').split('/')[0] || '';
      var providerLabel = providerLabelForKey(providerName) || providerName;
      html += '<tr><td class="settings-text-10" title="Provider ID: ' + S.escHtml(providerName) + '">' + S.escHtml(providerLabel) + '</td>' +
        '<td class="settings-text-10">' + S.escHtml(stripProvider(m.id)) + '</td>' +
        '<td>' + fmtPrice(p.input) + '</td>' +
        '<td>' + fmtPrice(p.cachedInput) + '</td>' +
        '<td>' + fmtPrice(p.output) + '</td>' +
        '<td>' + formatContext(p.context) + '</td>' +
        '<td>' + buildAddButtonHtml(m.id, isAdded) + '</td></tr>';
    });
    tbody.innerHTML = html || '<tr><td class="settings-empty-state" colspan="7">' +
      (_refreshAvailable.length ? 'No matching models' : 'Click Refresh to pull latest models') + '</td></tr>';
    tbody.querySelectorAll('.add-refresh-model').forEach(function(btn) {
      btn.addEventListener('click', function() {
        window.SettingsModels.addFromRefresh(this.getAttribute('data-id'));
      });
    });
    var countEl = document.getElementById('refreshModelCount');
    if (countEl) countEl.textContent = _refreshAvailable.length ? list.length + ' of ' + _refreshAvailable.length + ' models' : '';
  }

  function _populateRightPanel() {
    var tbody = document.getElementById('refreshRightTbody');
    if (!tbody) return;
    tbody.innerHTML = '';
    _collectCurrentModels().forEach(function(m) {
      var tr = document.createElement('tr');
      tr.innerHTML = _rightRowHtml(m.id, m);
      tbody.appendChild(tr);
      _stashMeta(tr, m);
      _wireRightRow(tr, function() { tr.remove(); _renderAvailableModels(); });
    });
    if (!tbody.children.length)
      tbody.innerHTML = '<tr><td class="settings-empty-state" colspan="9">No models defined</td></tr>';
  }

  function validate() {
    var providerKeys = currentProviderKeys();
    var seen = {};
    var rows = document.querySelectorAll('#modelsTableBody tr');
    for (var i = 0; i < rows.length; i++) {
      var tr = rows[i];
      var idEl = tr.querySelector('[data-field="id"]');
      var providerEl = tr.querySelector('[data-field="provider"]');
      var id = String(idEl && idEl.value || '').trim();
      if (!id) continue;
      var provider = String(providerEl && providerEl.value || '').trim();
      if (!provider)
        return { valid: false, message: 'Model "' + id + '" needs a provider.' };
      if (providerKeys.indexOf(provider) < 0)
        return { valid: false, message: 'Model "' + id + '" references provider "' + provider + '", which is no longer configured. Reassign or remove the model before saving.' };
      var fullId = ensureFullId(id, provider);
      if (seen[fullId])
        return { valid: false, message: 'Model ID "' + fullId + '" is duplicated.' };
      seen[fullId] = true;
    }
    return { valid: true };
  }

  window.SettingsModels = {
    parsePricingRaw: parsePricingRaw,
    parseOpenRouterModelResponse: parseOpenRouterModelResponse,
    filterAvailableModels: filterAvailableModels,
    buildAddButton: buildAddButtonHtml,
    buildProviderSelect: buildProviderSelect,
    syncProviderOptions: syncProviderOptions,
    renameProvider: renameProvider,
    collectCurrentModels: function() { return _collectCurrentModels(); },
    rightPanelIds: function() { return _rightPanelIds(); },

    handleRefreshResult: function(data) {
      var leftTbody = document.getElementById('refreshLeftTbody');
      if (!leftTbody) return;
      if (data.success && data.models) {
        _refreshData = {};
        _refreshAvailable = data.models;
        var status = document.getElementById('refreshModelStatus');
        var warnings = Array.isArray(data.warnings) ? data.warnings : [];
        if (status) status.textContent = warnings.length
          ? warnings.join(' ')
          : 'Model metadata refreshed from models.dev. OpenRouter remains lookup-only.';
        data.models.forEach(function(m) {
          _refreshData[m.id] = m.meta || (m.raw ? parsePricingRaw(m.raw) : {});
        });
        _renderAvailableModels();
      } else {
        _refreshAvailable = [];
        _refreshQuery = '';
        leftTbody.innerHTML = '<tr><td class="settings-danger" colspan="7">Error: ' + S.escHtml(data.error || 'Unknown error') + '</td></tr>';
        var countEl = document.getElementById('refreshModelCount');
        if (countEl) countEl.textContent = '';
        var status = document.getElementById('refreshModelStatus');
        if (status) status.textContent = '';
      }
    },

    addFromRefresh: function(modelId) {
      if (_rightPanelIds().indexOf(modelId) >= 0) return; // already added
      var p = _refreshData[modelId] || {};
      var tbody = document.getElementById('refreshRightTbody');
      if (!tbody) return;
      // Remove placeholder row if present
      var placeholder = tbody.querySelector('td[colspan]');
      if (placeholder) tbody.innerHTML = '';
      var m = {
        provider: p.provider || '',
        input: p.input !== undefined ? p.input : 0,
        cachedInput: p.cachedInput !== undefined ? p.cachedInput : '',
        output: p.output !== undefined ? p.output : 0,
        context: p.context || 0,
        vision: p.vision || false,
        reasoning: p.reasoning || false
      };
      _applyMeta(m, p);
      var tr = document.createElement('tr');
      tr.innerHTML = _rightRowHtml(modelId, m);
      tbody.appendChild(tr);
      tr.classList.add('refresh-row-added');
      _stashMeta(tr, m);
      _wireRightRow(tr, function() { tr.remove(); _renderAvailableModels(); });
      _renderAvailableModels();
    },

    handleOpenRouterLookupResult: function(data) {
      var tr = data && _openRouterLookups[data.reqId];
      if (!tr) return;
      delete _openRouterLookups[data.reqId];
      var btn = tr.querySelector('.lookup-openrouter-model');
      if (!data.success) {
        if (btn) {
          btn.disabled = false;
          btn.textContent = 'Retry';
          btn.title = data.error || 'OpenRouter model lookup failed';
        }
        if (tr._setOpenRouterLookupStatus)
          tr._setOpenRouterLookupStatus(data.error || 'OpenRouter model lookup failed.', 'error');
        return;
      }
      try {
        var m = parseOpenRouterModelResponse(data.raw);
        // Preserve the user-entered slug so aliases such as
        // ~anthropic/claude-sonnet-latest remain dynamic rather than pinning
        // the canonical id returned by OpenRouter's lookup endpoint.
        var requestedSlug = String(data.resolvedModelId || data.modelId || '').trim();
        tr.innerHTML = _mainRowHtml(requestedSlug, 'openrouter', m);
        _stashMeta(tr, m);
        _wireMainRow(tr);
        mark();
        var refreshedBtn = tr.querySelector('.lookup-openrouter-model');
        if (refreshedBtn) refreshedBtn.textContent = 'Refresh';
        if (tr._setOpenRouterLookupStatus) tr._setOpenRouterLookupStatus('Metadata loaded.', 'success');
      } catch (e) {
        if (btn) {
          btn.disabled = false;
          btn.textContent = 'Retry';
          btn.title = e.message || 'Invalid OpenRouter model metadata';
        }
        if (tr._setOpenRouterLookupStatus)
          tr._setOpenRouterLookupStatus(e.message || 'Invalid OpenRouter model metadata.', 'error');
      }
    },

    cancelRefresh: function() {
      document.getElementById('refreshModal').classList.remove('open');
    },

    saveRefresh: function() {
      var mainTbody = document.getElementById('modelsTableBody');
      var refreshTbody = document.getElementById('refreshRightTbody');
      if (!mainTbody || !refreshTbody) return;
      mainTbody.innerHTML = '';
      refreshTbody.querySelectorAll('tr').forEach(function(tr) {
        var idEl = tr.querySelector('[data-field="id"]');
        if (!idEl) return;
        // The user may have edited the model id; the live value takes precedence.
        // win over the stale data-full-id attribute.
        var id = idEl.value || idEl.getAttribute('data-full-id') || '';
        if (!id) return;
        var values = _readRowValues(tr);
        var newTr = document.createElement('tr');
        newTr.innerHTML = _mainRowHtml(id, values.provider, values);
        mainTbody.appendChild(newTr);
        _stashMeta(newTr, values);
        _wireMainRow(newTr);
      });
      mark();
      document.getElementById('refreshModal').classList.remove('open');
    }
  };

  if (typeof document !== 'undefined') {
    document.addEventListener('DOMContentLoaded', function() {
      var addBtn = document.getElementById('addModelBtn');
      if (addBtn) addBtn.addEventListener('click', addRow);
      var refreshBtn = document.getElementById('refreshPricingBtn');
      if (refreshBtn) refreshBtn.addEventListener('click', openRefreshModal);
      // Wire modal buttons
      var saveBtn = document.getElementById('refreshSaveBtn');
      if (saveBtn) saveBtn.addEventListener('click', function() { window.SettingsModels.saveRefresh(); });
      var modalRefreshBtn = document.getElementById('refreshPricingRefreshBtn');
      if (modalRefreshBtn) modalRefreshBtn.addEventListener('click', function() {
        _requestModelRefresh();
      });
      var refreshSearch = document.getElementById('refreshModelSearch');
      if (refreshSearch) refreshSearch.addEventListener('input', function() {
        _refreshQuery = refreshSearch.value;
        _renderAvailableModels();
      });
    });
  }

  S.registerSection(sectionName, {load: load, save: save, validate: validate});
})();
