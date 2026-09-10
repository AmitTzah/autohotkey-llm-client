// ======================================================
// model-picker.js — Model/Assistant popover (right panel)
// ======================================================

// Shared helpers (used by both model-picker.js and model-picker-config.js)

var _settingsTimer = null;
function _sendAllSettings(immediate) {
  if (_settingsTimer) clearTimeout(_settingsTimer);
  var send = function() {
    var s = window._currentSettings || {};
    // When assistant is active, don't send the base model as the model field.
    // The assistant manages the model — sending it would cause AHK to treat it
    // as an explicit model switch and clear the assistant.
    var modelToSend = s.assistantName ? '' : (s.model || '');
    // Temperature 0 is a real override; JS truthiness must not serialize it as empty.
    // Only absent/null/empty values clear it.
    var temperatureToSend = (s.temperature === undefined || s.temperature === null || s.temperature === '') ? '' : s.temperature;
    Ipc.postToHost('updateModelSettings', {
      model: modelToSend,
      systemMessage: s.systemMessage || '',
      systemOverrideSet: s.systemOverrideSet === true,
      reasoning: s.reasoning || '',
      temperature: temperatureToSend,
      reasoningOverrideSet: s.reasoningOverrideSet === true,
      temperatureOverrideSet: s.temperatureOverrideSet === true,
      webSearch: !!s.webSearch
    });
  };
  if (immediate) {
    _settingsTimer = null;
    send();
    return;
  }
  _settingsTimer = setTimeout(function() {
    _settingsTimer = null;
    send();
  }, 300);
}

function _supportsTemperatureValue(value) {
  return !(value === false || value === 0 || value === '0' || value === 'false');
}

function _updateModelCard() {
  var s = window._currentSettings || {};
  var card = document.getElementById('modelCardTrigger');
  if (!card) return;
  var nameEl = card.querySelector('.name');
  var idEl = card.querySelector('.id');
  var descEl = card.querySelector('.desc');

  if (s.assistantName) {
    // Assistant mode: name = assistant name, id = base model, desc = system prompt
    if (nameEl) nameEl.textContent = s.assistantName;
    if (idEl) idEl.textContent = s.assistantBaseModel || s.model || '';
    if (descEl) descEl.textContent = s.assistantDescription || '';
  } else if (s.model) {
    // Direct model mode: name = model name, id = full model
    var parts = s.model.split('/');
    if (nameEl) nameEl.textContent = parts[parts.length - 1] || s.model;
    if (idEl) idEl.textContent = s.model;
    if (descEl) descEl.textContent = '';
  }
}

// Map model name → provider icon file
function _providerIconFile(model, provider) {
  if (window.ProviderIcons) return window.ProviderIcons.file(model, provider);
  if (!model) return '../icons/openrouter.ico';
  var m = model.toLowerCase();
  if (m.indexOf('deepseek') >= 0) return '../icons/deepseek.ico';
  if (m.indexOf('gpt') >= 0 || m.indexOf('o1') >= 0 || m.indexOf('o3') >= 0 || m.indexOf('openai') >= 0) return '../icons/openai.ico';
  if (m.indexOf('claude') >= 0 || m.indexOf('anthropic') >= 0) return '../icons/anthropic.ico';
  if (m.indexOf('gemini') >= 0 || m.indexOf('gemma') >= 0 || m.indexOf('google') >= 0) return '../icons/google.ico';
  if (m.indexOf('perplexity') >= 0) return '../icons/perplexity.ico';
  if (m.indexOf('openrouter') >= 0) return '../icons/openrouter.ico';
  return '../icons/openrouter.ico';
}

function _providerIconImgStyle(model, provider) {
  if (window.ProviderIcons) return window.ProviderIcons.style(model, provider, 22);
  var m = model ? model.toLowerCase() : '';
  if (m.indexOf('openrouter') >= 0)
    return 'width:22px;height:22px;background:#7c3aed;border-radius:50%;padding:2px;mix-blend-mode:normal;';
  return 'width:26px;height:26px;mix-blend-mode:multiply;';
}

function populateAssistantDropdown(assistants) {
  window._assistantList = assistants || [];
  _populatePopover();
}

// Wire model card trigger click → open popover
if (typeof document !== 'undefined' && document.addEventListener) {
document.addEventListener('DOMContentLoaded', function() {
  var trigger = document.getElementById('modelCardTrigger');
  if (!trigger) return;

  trigger.addEventListener('click', function() {
    var popover = document.getElementById('modelPopover');
    var overlay = document.getElementById('popoverOverlay');
    if (!popover) return;
    if (popover.classList.contains('open')) {
      popover.classList.remove('open');
      if (overlay) overlay.style.display = 'none';
      return;
    }
    _populatePopover();
    var rect = trigger.getBoundingClientRect();
    popover.classList.add('open');
    popover.style.left = Math.max(10, rect.left - 316) + 'px';
    popover.style.top = rect.top + 'px';
    if (overlay) overlay.style.display = 'block';
  });

  // Close on overlay click
  var popoverOverlay = document.getElementById('popoverOverlay');
  if (popoverOverlay) popoverOverlay.addEventListener('click', function() {
    var p = document.getElementById('modelPopover');
    if (p) p.classList.remove('open');
    popoverOverlay.style.display = 'none';
  });

  // Wire popover tabs
  document.querySelectorAll('.popover-tab').forEach(function(tab) {
    tab.addEventListener('click', function() {
      document.querySelectorAll('.popover-tab').forEach(function(t) { t.classList.remove('active'); });
      document.querySelectorAll('.popover-pane').forEach(function(p) { p.classList.remove('active'); });
      tab.classList.add('active');
      var target = document.getElementById(tab.getAttribute('data-target'));
      if (target) target.classList.add('active');
    });
  });
});
} // end DOMContentLoaded guard

function _populatePopover() {
  _populateAssistantsTab();
  _populateModelsTab();
}

function _populateAssistantsTab() {
  var pane = document.getElementById('tab-assistants');
  if (!pane || !window._assistantList) return;
  pane.innerHTML = '';
  for (var a = 0; a < window._assistantList.length; a++) {
    var asst = window._assistantList[a];
    var item = document.createElement('div');
    item.className = 'selector-item';
    if (window._currentSettings && window._currentSettings.assistantName === asst.name) {
      item.classList.add('active');
    }
    var iconSrc = _providerIconFile(asst.baseModel);
    item.innerHTML =
      '<div class="si-icon" style="background:transparent;"><img src="' + iconSrc + '" style="' + _providerIconImgStyle(asst.baseModel) + '" alt=""></div>' +
      '<div class="si-text">' +
        '<div class="si-name">' + escHtml(asst.name || '') + '</div>' +
        '<div class="si-desc">' + escHtml(asst.description || '') + (asst.baseModel ? ' · ' + escHtml(asst.baseModel) : '') + '</div>' +
      '</div>' +
      '<div class="si-radio"></div>';
    item.addEventListener('click', _makeAssistantClickHandler(item, asst.id));
    pane.appendChild(item);
  }
}

function _makeAssistantClickHandler(el, asstId) {
  return function() {
    var allItems = el.parentElement.querySelectorAll('.selector-item');
    for (var si = 0; si < allItems.length; si++) allItems[si].classList.remove('active');
    el.classList.add('active');
    var sysPrompt = '';
    var selectedAssistant = null;
    if (window._assistantList) {
      for (var ai = 0; ai < window._assistantList.length; ai++) {
        if (window._assistantList[ai].id === asstId) {
          selectedAssistant = window._assistantList[ai];
          sysPrompt = selectedAssistant.systemMessage || '';
          break;
        }
      }
    }
    var mini = document.getElementById('sysMsgMini');
    if (mini) mini.value = sysPrompt;
    if (!window._currentSettings) window._currentSettings = {};
    window._currentSettings.systemMessage = sysPrompt;
    // Update the renderer state before posting switchAssistant. Send can be
    // clicked in the same turn, and _sendAllSettings must see assistant mode
    // before it serializes the current model selection.
    window._currentSettings.assistantName = selectedAssistant ? (selectedAssistant.name || '') : '';
    window._currentSettings.assistantBaseModel = selectedAssistant ? (selectedAssistant.baseModel || '') : '';
    window._currentSettings.assistantDescription = selectedAssistant ? (selectedAssistant.description || '') : '';
    window._currentSettings.reasoning = selectedAssistant && selectedAssistant.reasoning != null
      ? selectedAssistant.reasoning : '';
    window._currentSettings.temperature = selectedAssistant && selectedAssistant.temperature != null
      ? selectedAssistant.temperature : '';
    window._currentSettings.systemOverrideSet = false;
    window._currentSettings.reasoningOverrideSet = false;
    window._currentSettings.temperatureOverrideSet = false;
    Ipc.postToHost('switchAssistant', { assistantId: asstId });
    var p = document.getElementById('modelPopover'); if (p) p.classList.remove('open');
    var ov = document.getElementById('popoverOverlay'); if (ov) ov.style.display = 'none';
  };
}

function _populateModelsTab() {
  var pane = document.getElementById('tab-models');
  if (!pane || !window.modelList) return;
  pane.innerHTML = '';
  var providerKeys = Object.keys(window.modelList).sort(function(a, b) {
    if (a === 'openrouter') return b === 'openrouter' ? 0 : -1;
    if (b === 'openrouter') return 1;
    return a < b ? -1 : a > b ? 1 : 0;
  });
  for (var p = 0; p < providerKeys.length; p++) {
    var provider = providerKeys[p];
    var models = window.modelList[provider];
    var groupLabel = document.createElement('div');
    groupLabel.className = 'si-group-label';
    groupLabel.textContent = provider.charAt(0).toUpperCase() + provider.slice(1);
    if (p > 0) groupLabel.style.paddingTop = '8px';
    pane.appendChild(groupLabel);
    for (var m = 0; m < models.length; m++) {
      var model = models[m];
      var mItem = document.createElement('div');
      mItem.className = 'selector-item';
      var hasAsst = window._currentSettings && window._currentSettings.assistantName;
      var curModel = !hasAsst ? ((window._currentSettings && window._currentSettings.model) || '') : '';
      var curShort = curModel.indexOf('/') >= 0 ? curModel.split('/').pop() : curModel;
      if (!hasAsst && (curModel === model.fullId || curShort === model.id || curModel === model.id)) {
        mItem.classList.add('active');
      }
      var iconSrc = _providerIconFile(model.fullId, provider);
      mItem.innerHTML =
        '<div class="si-icon" style="background:transparent;"><img src="' + iconSrc + '" style="' + _providerIconImgStyle(model.fullId, provider) + '" alt=""></div>' +
        '<div class="si-text">' +
          '<div class="si-name">' + escHtml(model.id || '') + '</div>' +
          '<div class="si-desc">' + escHtml(provider) + '</div>' +
        '</div>' +
        '<div class="si-radio"></div>';
      mItem.addEventListener('click', _makeModelClickHandler(mItem, model.fullId, model.supportsTemperature));
      pane.appendChild(mItem);
    }
  }
}

function _makeModelClickHandler(el, fullId, supportsTemperature) {
    return function() {
        var allItems = document.querySelectorAll('#tab-models .selector-item');
        for (var si = 0; si < allItems.length; si++) allItems[si].classList.remove('active');
        el.classList.add('active');
        if (!window._currentSettings) window._currentSettings = {};
        var wasAssistant = !!window._currentSettings.assistantName;
        window._currentSettings.model = fullId;
        // Clear assistant when user explicitly picks a model
        window._currentSettings.assistantName = '';
        window._currentSettings.assistantBaseModel = '';
        window._currentSettings.assistantDescription = '';
        // Keep the selected reasoning level across model changes (it only
        // falls back to Model Default when the new model doesn't support
        // it). Still clear assistant-owned system prompt / temperature.
        if (wasAssistant) {
            window._currentSettings.systemMessage = '';
            window._currentSettings.systemOverrideSet = false;
        }
        window._currentSettings.temperature = '';
        window._currentSettings.reasoningOverrideSet = window._currentSettings.reasoning !== '';
        window._currentSettings.temperatureOverrideSet = false;
        var temperatureSupported = _supportsTemperatureValue(supportsTemperature);
        window._currentSettings.supportsTemperature = temperatureSupported;
        var tempSlider = document.getElementById('tempSlider');
        if (tempSlider) {
            var tempField = tempSlider.parentElement;
            if (tempField) tempField.style.display = temperatureSupported ? '' : 'none';
            tempSlider.disabled = !temperatureSupported;
            tempSlider.title = temperatureSupported ? '' : 'Temperature is not supported by the Codex CLI backend.';
        }
        _sendAllSettings();
        _updateModelCard();
        var pop = document.getElementById('modelPopover'); if (pop) pop.classList.remove('open');
        var ov = document.getElementById('popoverOverlay'); if (ov) ov.style.display = 'none';
    };
}

