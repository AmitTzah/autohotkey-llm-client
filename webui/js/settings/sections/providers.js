// providers.js — Providers settings section
(function() {
  var sectionName = 'providers';
  var S = window.SettingsShared;
  var BUILTIN_PROVIDER_IDS = ['deepseek', 'openai', 'openrouter', 'google', 'codex'];

  function load(data) {
    if (!data || !data.providers) return;
    renderCards(data.providers);
    syncModelsProviderOptions();
  }

  var PALETTE = [
    { bg: '#E0E7FF', fg: '#4F46E5' },
    { bg: '#E0F2E0', fg: '#10B981' },
    { bg: '#FEF3C7', fg: '#F59E0B' },
    { bg: '#FCE7F3', fg: '#DB2777' }
  ];

  function getInitials(name) {
    var parts = (name || '').split(/[\s-]+/);
    return (parts[0].charAt(0) + (parts[1] ? parts[1].charAt(0) : '')).toUpperCase();
  }

  function slugifyProviderId(value) {
    return String(value || '')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^[-._]+|[-._]+$/g, '');
  }

  function isCustomProvider(key, p) {
    if (p && p.custom === true) return true;
    return BUILTIN_PROVIDER_IDS.indexOf(key) < 0;
  }

  function _field(card, name) {
    return card && card.querySelector ? card.querySelector('[data-field="' + name + '"]') : null;
  }

  function providerIdForCard(card) {
    var idInput = _field(card, 'providerId');
    var value = idInput ? idInput.value : (card && card.dataset ? card.dataset.providerKey : '');
    return String(value || '').trim();
  }

  function syncModelsProviderOptions() {
    if (window.SettingsModels && typeof window.SettingsModels.syncProviderOptions === 'function')
      window.SettingsModels.syncProviderOptions();
  }

  function updateProviderIdentity(card, nextKey) {
    if (!card || !card.dataset) return;
    var oldKey = String(card.dataset.providerKey || '').trim();
    nextKey = String(nextKey || '').trim();
    card.dataset.providerKey = nextKey;
    if (oldKey && nextKey && oldKey !== nextKey && window.SettingsModels && typeof window.SettingsModels.renameProvider === 'function')
      window.SettingsModels.renameProvider(oldKey, nextKey);
    syncModelsProviderOptions();
  }

  function syncCardHeader(card) {
    if (!card || !card.querySelector) return;
    var nameInput = _field(card, 'displayName');
    var idInput = _field(card, 'providerId');
    var name = String(nameInput && nameInput.value || '').trim() || String(idInput && idInput.value || '').trim() || 'New Provider';
    var title = card.querySelector('.provider-card-title');
    var icon = card.querySelector('.provider-icon');
    if (title) title.textContent = name;
    if (icon) icon.textContent = getInitials(name) || '?';
  }

  function isCodexProvider(p, key) {
    return key === 'codex' || (p && p.transport === 'codex-cli');
  }

  function providerCardHTML(p, key, palIdx, isNew) {
    var colors = PALETTE[palIdx % PALETTE.length];
    var title = p.displayName || key || 'New Provider';
    var legacyGeneratedId = /^provider-\d+$/.test(key || '');
    var idAttrs = isNew ? '' : ' readonly';
    var idHint = legacyGeneratedId
      ? 'Legacy generated ID. Rename it to a stable ID such as xiaomi; linked model rows will be updated before save.'
      : (isNew
        ? 'Stable lowercase ID used in model IDs (for example xiaomi/model-name). It cannot be renamed after saving.'
        : 'Stable ID used in model IDs. Existing provider IDs are read-only to avoid breaking model references.');
    if (isCodexProvider(p, key)) {
      return '<div class="provider-card-header"><div class="provider-icon" style="background:' + colors.bg + ';color:' + colors.fg + ';">' + S.escHtml(getInitials(title) || 'C') + '</div><span class="settings-fw-600 provider-card-title">' + S.escHtml(title) + '</span><span class="badge settings-ml-auto">Built-in local backend</span></div>' +
        '<input type="hidden" value="codex-cli" data-field="transport">' +
        '<input type="hidden" value="chatgpt-subscription" data-field="billingMode">' +
        '<input type="hidden" value="chatgpt" data-field="authMode">' +
        '<div class="field"><label class="field-label">Provider ID</label><input class="settings-mono-input" type="text" value="' + S.escHtml(key || 'codex') + '" data-field="providerId" readonly><div class="field-hint">Codex models use IDs such as <code>codex/gpt-5.6-luna</code>.</div></div>' +
        '<div class="field"><label class="field-label">Display Name</label><input type="text" value="' + S.escHtml(p.displayName || 'Codex CLI (ChatGPT subscription)') + '" data-field="displayName"></div>' +
        '<div class="field"><label class="field-label">Authentication</label><div class="field-hint">Uses the official Codex CLI installed on this PC and its existing ChatGPT login. AhkLLM does not store an OpenAI API key for this provider. Install Codex separately and run <code>codex login</code> if needed.</div></div>' +
        '<div class="field"><label class="field-label">Codex status</label><div class="settings-flex-row-6"><button type="button" class="btn-sm check-codex">Check Codex</button><span class="codex-status settings-text-xs-muted" aria-live="polite">Not checked</span></div><div class="field-hint">Requires Codex CLI 0.153.0 or newer; AhkLLM is tested against 0.153.x and allows compatible newer releases. The check runs <code>codex --version</code> and <code>codex login status</code> only; it does not invoke a model or consume a Codex turn.</div></div>' +
        '<div class="field"><label class="field-label">Execution profile</label><div class="field-hint">Normal AhkLLM chat disables known local execution/inspection and agent tool surfaces, with a read-only sandbox as a write backstop. The Web Search toggle uses Codex hosted web search inside the same Codex turn.</div></div>' +
        '<div class="toggle-row"><div><div class="lbl">Collapse thinking blocks by default</div><div class="settings-text-xs-muted">Used when reasoning content is available</div></div><div class="switch' + (p.collapseThinking ? ' on' : '') + '" data-field="collapseThinking"><div class="knob"></div></div></div>';
    }
    return '<div class="provider-card-header"><div class="provider-icon" style="background:' + colors.bg + ';color:' + colors.fg + ';">' + S.escHtml(getInitials(title) || '?') + '</div><span class="settings-fw-600 provider-card-title">' + S.escHtml(title) + '</span><button class="btn-sm danger settings-ml-auto">Remove</button></div>' +
      '<div class="field"><label class="field-label">Provider ID</label><input class="settings-mono-input" type="text" value="' + S.escHtml(key || '') + '" placeholder="xiaomi" data-field="providerId"' + idAttrs + '><div class="field-hint">' + idHint + '</div></div>' +
      '<div class="field"><label class="field-label">Display Name</label><input type="text" value="' + S.escHtml(p.displayName || '') + '" placeholder="Xiaomi" data-field="displayName"></div>' +
      '<div class="field"><label class="field-label">Chat Completions Endpoint</label><input type="text" value="' + S.escHtml(p.endpoint || '') + '" placeholder="https://api.example.com/v1/chat/completions" data-field="endpoint"><div class="field-hint">Custom providers must accept OpenAI-compatible Chat Completions requests.</div></div>' +
      '<div class="field"><label class="field-label">models.dev Provider <span class="hint">optional catalog override</span></label><input class="settings-mono-input" type="text" value="' + S.escHtml(p.modelsDevProvider || '') + '" placeholder="Auto: ' + S.escHtml(key || 'provider-id') + '" data-field="modelsDevProvider"><div class="field-hint">Fetch Latest Models uses this models.dev catalog key. Leave blank to use the Provider ID. Example: provider ID <code>work-mimo</code> can use catalog <code>xiaomi</code>. OpenRouter remains lookup-only.</div></div>' +
      '<div class="field"><label class="field-label">FIM Endpoint <span class="hint">optional</span></label><input type="text" value="' + S.escHtml(p.fimEndpoint || '') + '" data-field="fimEndpoint"></div>' +
      '<div class="field"><label class="field-label">API Key <span class="hint">env variable (preferred)</span></label><input class="settings-mono-input" type="text" value="' + S.escHtml(p.authEnvVar || '') + '" data-field="authEnvVar"><div class="field-hint">Bearer authentication. Set via: setx ' + S.escHtml(p.authEnvVar || 'KEY') + ' your-key</div></div>' +
      '<div class="field"><label class="field-label">API Key <span class="hint">or enter directly</span></label><div class="settings-flex-row-6"><input class="settings-mono-flex" type="password" value="' + S.escHtml(p.apiKey || '') + '" data-field="apiKey" placeholder="sk-..."><button class="btn-sm toggle-api-key" title="Show/hide">' + String.fromCharCode(0x1F441) + '</button></div><div class="field-hint settings-warning">\u26A0 Direct entry stores key in settings.json</div></div>' +
      '<div class="field"><label class="field-label">Model Name Prefixes <span class="hint">routes unprefixed model names to this provider</span></label><div class="prefix-tags" data-field="prefixes">' + renderPrefixes(p.prefixes || []) + '</div></div>' +
      '<div class="toggle-row"><div><div class="lbl">Collapse thinking blocks by default</div><div class="settings-text-xs-muted">When streaming, reasoning/thinking content is hidden until expanded</div></div><div class="switch' + (p.collapseThinking ? ' on' : '') + '" data-field="collapseThinking"><div class="knob"></div></div></div>';
  }

  function wireProviderCard(card, grid) {
    card.querySelectorAll('.prefix-tags .badge .remove').forEach(function(rm) {
      rm.addEventListener('click', function() { rm.parentElement.remove(); mark(); });
    });
    card.querySelectorAll('.switch').forEach(function(sw) {
      sw.addEventListener('click', function() { this.classList.toggle('on'); mark(); });
    });
    card.querySelectorAll('input').forEach(function(inp) {
      inp.addEventListener('input', function() { mark(); });
    });

    var idInput = _field(card, 'providerId');
    var displayNameInput = _field(card, 'displayName');
    var isNew = card.dataset && card.dataset.isNew === 'true';

    if (idInput && isNew) {
      idInput.addEventListener('input', function() {
        card.dataset.providerIdTouched = 'true';
        updateProviderIdentity(card, idInput.value);
        syncCardHeader(card);
      });
      idInput.addEventListener('blur', function() {
        var normalized = slugifyProviderId(idInput.value);
        if (normalized !== idInput.value) idInput.value = normalized;
        updateProviderIdentity(card, normalized);
        syncCardHeader(card);
        mark();
      });
    }

    if (displayNameInput) {
      displayNameInput.addEventListener('input', function() {
        if (isNew && idInput && card.dataset.providerIdTouched !== 'true') {
          idInput.value = slugifyProviderId(displayNameInput.value);
          updateProviderIdentity(card, idInput.value);
        } else {
          syncModelsProviderOptions();
        }
        syncCardHeader(card);
      });
    }

    var removeBtn = card.querySelector('.btn-sm.danger');
    if (removeBtn) removeBtn.addEventListener('click', function() {
      if (grid.querySelectorAll('.provider-card').length <= 1) return;
      card.remove();
      mark();
      syncModelsProviderOptions();
    });

    var toggleBtn = card.querySelector('.toggle-api-key');
    if (toggleBtn) {
      toggleBtn.addEventListener('click', function() {
        var keyInput = card.querySelector('[data-field="apiKey"]');
        if (keyInput) keyInput.type = keyInput.type === 'password' ? 'text' : 'password';
      });
    }

    var checkCodexBtn = card.querySelector('.check-codex');
    if (checkCodexBtn) {
      checkCodexBtn.addEventListener('click', function() {
        var statusEl = card.querySelector('.codex-status');
        checkCodexBtn.disabled = true;
        if (statusEl) statusEl.textContent = 'Checking...';
        if (typeof Ipc !== 'undefined' && Ipc && typeof Ipc.postToHost === 'function')
          Ipc.postToHost('checkCodex');
      });
    }

    var prefixDiv = card.querySelector('.prefix-tags');
    if (prefixDiv) {
      var addLink = document.createElement('span');
      addLink.style.cssText = 'font-size:11px;color:var(--text-tertiary);cursor:pointer;';
      addLink.textContent = '+ add';
      addLink.addEventListener('click', function() {
        var tag = document.createElement('span'); tag.className = 'badge';
        var inp = document.createElement('input'); inp.style.cssText = 'width:60px;border:none;background:transparent;font-size:10px;outline:none;';
        inp.addEventListener('blur', function() { tag.innerHTML = S.escHtml(inp.value || '?') + ' <span class=remove>\u00D7</span>'; tag.querySelector('.remove').addEventListener('click', function() { tag.remove(); mark(); }); mark(); });
        tag.appendChild(inp); prefixDiv.insertBefore(tag, addLink); inp.focus();
      });
      prefixDiv.appendChild(addLink);
    }
  }

  function renderCards(providers) {
    var grid = document.getElementById('providerGrid');
    if (!grid) return;
    grid.innerHTML = '';
    var keys = Object.keys(providers).sort();
    keys.forEach(function(key, idx) {
      var p = providers[key];
      var card = document.createElement('div');
      card.className = 'provider-card';
      card.dataset.providerKey = key;
      var legacyGeneratedId = /^provider-\d+$/.test(key);
      card.dataset.isNew = legacyGeneratedId ? 'true' : 'false';
      card.dataset.providerIdTouched = legacyGeneratedId ? 'true' : 'false';
      card.dataset.customProvider = isCustomProvider(key, p) ? 'true' : 'false';
      card.innerHTML = providerCardHTML(p, key, idx, legacyGeneratedId);
      grid.appendChild(card);
      wireProviderCard(card, grid);
    });
  }

  function renderPrefixes(prefixes) {
    var html = '';
    (prefixes || []).forEach(function(p) { html += '<span class="badge">' + S.escHtml(p) + ' <span class="remove">\u00D7</span></span>'; });
    return html;
  }

  function mark() { S.markDirty(); }

  function collectProviders() {
    var providers = {};
    document.querySelectorAll('#providerGrid .provider-card').forEach(function(card) {
      var key = providerIdForCard(card);
      if (!key) return;
      var obj = {};
      card.querySelectorAll('[data-field]').forEach(function(el) {
        var field = el.dataset.field;
        if (field === 'providerId' || field === 'prefixes') return;
        if (el.classList.contains('switch')) obj[field] = el.classList.contains('on');
        else obj[field] = el.value || '';
      });
      if (obj.transport === 'codex-cli') {
        obj.authMode = 'chatgpt';
        obj.billingMode = obj.billingMode || 'chatgpt-subscription';
        obj.endpoint = '';
        obj.fimEndpoint = '';
        obj.authEnvVar = '';
        obj.apiKey = '';
      } else {
        obj.transport = obj.transport || 'http';
        obj.billingMode = obj.billingMode || 'api';
        obj.authMode = (obj.apiKey && !obj.authEnvVar) ? 'direct' : 'env';
      }
      obj.custom = card.dataset && card.dataset.customProvider === 'true';
      obj.prefixes = [];
      card.querySelectorAll('.prefix-tags .badge').forEach(function(tag) {
        var txt = tag.textContent.replace('\u00D7', '').trim();
        if (txt) obj.prefixes.push(txt);
      });
      providers[key] = obj;
    });
    return providers;
  }

  function getProviderOptions() {
    var options = [];
    document.querySelectorAll('#providerGrid .provider-card').forEach(function(card) {
      var key = providerIdForCard(card);
      if (!key) return;
      var displayNameInput = _field(card, 'displayName');
      var label = String(displayNameInput && displayNameInput.value || '').trim() || key;
      options.push({ key: key, label: label });
    });
    options.sort(function(a, b) { return a.label.localeCompare(b.label) || a.key.localeCompare(b.key); });
    return options;
  }

  function handleCodexStatus(data) {
    data = data || {};
    var cards = document.querySelectorAll('#providerGrid .provider-card');
    for (var i = 0; i < cards.length; i++) {
      var card = cards[i];
      var transportEl = _field(card, 'transport');
      if (providerIdForCard(card) !== 'codex' && String(transportEl && transportEl.value || '') !== 'codex-cli') continue;
      var statusEl = card.querySelector('.codex-status');
      var button = card.querySelector('.check-codex');
      if (button) button.disabled = false;
      if (statusEl) {
        statusEl.textContent = data.message || (data.authenticated ? 'Codex is ready.' : 'Codex is not ready.');
        statusEl.title = data.error || '';
      }
    }
  }

  function save() {
    return { providers: collectProviders() };
  }

  function validate() {
    var seen = {};
    var cards = document.querySelectorAll('#providerGrid .provider-card');
    for (var i = 0; i < cards.length; i++) {
      var card = cards[i];
      var key = providerIdForCard(card);
      var nameEl = _field(card, 'displayName');
      var endpointEl = _field(card, 'endpoint');
      var name = String(nameEl && nameEl.value || '').trim();
      var endpoint = String(endpointEl && endpointEl.value || '').trim();
      if (!key)
        return { valid: false, message: 'Every provider needs a Provider ID (for example xiaomi).' };
      if (!/^[a-z0-9][a-z0-9._-]*$/.test(key))
        return { valid: false, message: 'Provider ID "' + key + '" is invalid. Use lowercase letters, numbers, dots, underscores, or hyphens.' };
      var catalogEl = _field(card, 'modelsDevProvider');
      var catalog = String(catalogEl && catalogEl.value || '').trim();
      if (catalog && !/^[a-z0-9][a-z0-9._-]*$/.test(catalog))
        return { valid: false, message: 'models.dev Provider "' + catalog + '" is invalid. Use the catalog key from models.dev.' };
      if (seen[key])
        return { valid: false, message: 'Provider ID "' + key + '" is duplicated.' };
      seen[key] = true;
      if (!name)
        return { valid: false, message: 'Provider "' + key + '" needs a display name.' };
      var transportEl = _field(card, 'transport');
      var transport = String(transportEl && transportEl.value || 'http').trim() || 'http';
      if (transport === 'codex-cli') continue;
      if (!endpoint)
        return { valid: false, message: 'Provider "' + name + '" needs an OpenAI-compatible Chat Completions endpoint.' };
    }
    return { valid: true };
  }

  function addProvider() {
    var grid = document.getElementById('providerGrid'); if (!grid) return;
    var card = document.createElement('div');
    card.className = 'provider-card';
    card.dataset.providerKey = '';
    card.dataset.isNew = 'true';
    card.dataset.customProvider = 'true';
    card.dataset.providerIdTouched = 'false';
    var p = { displayName: '', endpoint: '', modelsDevProvider: '', fimEndpoint: '', authEnvVar: '', apiKey: '', prefixes: [], collapseThinking: false };
    card.innerHTML = providerCardHTML(p, '', 0, true);
    grid.appendChild(card);
    wireProviderCard(card, grid);
    var nameInput = _field(card, 'displayName');
    if (nameInput && nameInput.focus) nameInput.focus();
    mark();
    syncModelsProviderOptions();
  }

  window.SettingsProviders = {
    getCurrentProviders: collectProviders,
    getProviderOptions: getProviderOptions,
    providerIdForCard: providerIdForCard,
    slugifyProviderId: slugifyProviderId,
    handleCodexStatus: handleCodexStatus
  };

  if (typeof document !== 'undefined') {
    document.addEventListener('DOMContentLoaded', function() {
      var addBtn = document.getElementById('addProviderBtn');
      if (addBtn) addBtn.addEventListener('click', addProvider);
    });
  }
  S.registerSection(sectionName, {load: load, save: save, validate: validate});
})();
