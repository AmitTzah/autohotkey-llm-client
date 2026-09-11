// ======================================================
// model-picker-config.js — Right panel config + system prompt modal
// ======================================================

function _supportsTemperatureValue(value) {
  return !(value === false || value === 0 || value === '0' || value === 'false');
}

function _settingsBoolValue(value) {
  return value === true || value === 1 || value === '1' || value === 'true';
}

function _isCodexImageModel(model) {
  return typeof model === 'string' && model.toLowerCase().indexOf('codex/') === 0;
}

function _effectiveImageGenerationModel(settings) {
  var s = settings || {};
  return s.assistantName ? (s.assistantBaseModel || '') : (s.model || '');
}

function openModelSettings() {
  // Settings are always visible in right panel — no modal to open
  // Request current settings from AHK
  Ipc.postToHost('requestCurrentSettings');
}

function populateCurrentSettings(settings) {
  if (!settings) return;

  // Store all values (keep empty as empty — don't default to 1.0)
  window._currentSettings = {
    model: settings.model || '',
    systemMessage: settings.systemMessage || '',
    systemOverrideSet: _settingsBoolValue(settings.systemOverrideSet),
    reasoning: settings.reasoning || '',
    reasoningOverrideSet: _settingsBoolValue(settings.reasoningOverrideSet),
    temperatureOverrideSet: _settingsBoolValue(settings.temperatureOverrideSet),
    // Temperature 0 is a valid override; only null/undefined means unset.
    temperature: settings.temperature == null ? '' : settings.temperature,
    fontSize: settings.fontSize || '17',
    assistantName: settings.assistantName || '',
    assistantBaseModel: settings.assistantBaseModel || '',
    assistantDescription: settings.assistantDescription || '',
    webSearch: _settingsBoolValue(settings.webSearch),
    imageGeneration: _settingsBoolValue(settings.imageGeneration),
    supportsTemperature: _supportsTemperatureValue(settings.supportsTemperature)
  };

  // Sync the composer Web Search toggle with the current settings
  _syncWebSearchToggle();

  _syncImageGenerationToggle();

  // Apply per-chat font size
  if (settings.fontSize) {
    document.documentElement.style.setProperty('--chat-font-size', settings.fontSize + 'px');
    var fontDisp = document.getElementById('font-size-display');
    if (fontDisp) fontDisp.textContent = settings.fontSize + 'px';
    if (window.UiControls && window.UiControls.syncFontSize) window.UiControls.syncFontSize(settings.fontSize);
  }

  // Update model card
  _updateModelCard();

  // System prompt mini textarea
  var mini = document.getElementById('sysMsgMini');
  if (mini) mini.value = settings.systemMessage || '';

  // Temperature slider
  var tempSlider = document.getElementById('tempSlider');
  var tempVal = document.getElementById('tempVal');
  var tempReset = document.getElementById('tempReset');
  if (tempSlider) {
    // Use explicit empty checks because temperature 0 is valid.
    // instead of a truthiness check (0 is falsy in JS).
    var supportsTemperature = _supportsTemperatureValue(settings.supportsTemperature);
    var tempField = tempSlider.parentElement;
    if (tempField)
      tempField.style.display = supportsTemperature ? '' : 'none';
    tempSlider.disabled = !supportsTemperature;
    tempSlider.title = supportsTemperature ? '' : 'Temperature is not supported by the Codex CLI backend.';
    var hasTemp = supportsTemperature && settings.temperatureOverrideSet !== true && settings.temperature !== '' && settings.temperature !== undefined && settings.temperature !== null;
    if (hasTemp) {
      tempSlider.value = settings.temperature;
      tempSlider.classList.remove('temp-default');
      if (tempVal) tempVal.textContent = parseFloat(tempSlider.value).toFixed(1);
      if (tempReset) tempReset.style.display = '';
    } else {
      tempSlider.value = '1.0';
      tempSlider.classList.add('temp-default');
      if (tempVal) tempVal.textContent = 'Default';
      if (tempReset) tempReset.style.display = 'none';
    }
  }

  if (tempSlider && !supportsTemperature && tempVal)
    tempVal.textContent = 'Not supported';

  // Thinking dropdown — the backend sends raw level values; the shared
  // ReasoningLevels helper labels and sorts them (Model Default + levels).
  var thinkingDropdown = document.getElementById('reasoningDropdown');
  if (thinkingDropdown) {
    var levels = settings.thinkingLevels || [];
    var currentValue = settings.reasoning || '';
    var rl = (typeof window !== 'undefined') ? window.ReasoningLevels : null;

    thinkingDropdown.innerHTML = rl
      ? rl.buildOptionsHtmlForValues(levels)
      : '<option value="">Model Default</option>' + levels.map(function(lv) {
          return '<option value="' + lv + '">' + lv + '</option>';
        }).join('');

    // Restore current value if still valid
    var valueExists = false;
    for (var i = 0; i < thinkingDropdown.options.length; i++) {
      if (thinkingDropdown.options[i].value === currentValue) {
        valueExists = true;
        break;
      }
    }
    thinkingDropdown.value = valueExists ? currentValue : '';
  }
}

// Called by main.js when dropdownLabel arrives
function updateDropdownLabel(data) {
  if (!data || !window._currentSettings) return;
  if (!data.isAssistant && data.text) {
    // Only update model if not already set (avoids overwriting full model ID)
    if (!window._currentSettings.model || window._currentSettings.model.indexOf(data.text) < 0) {
      window._currentSettings.model = data.text;
    }
    window._currentSettings.assistantName = '';
    _updateModelCard();
  }
  if (data.isAssistant && data.text) {
    window._currentSettings.assistantName = data.text;
    // Find assistant in list to get base model and description
    if (window._assistantList) {
      for (var i = 0; i < window._assistantList.length; i++) {
        if (window._assistantList[i].name === data.text) {
          window._currentSettings.assistantBaseModel = window._assistantList[i].baseModel || '';
          window._currentSettings.assistantDescription = window._assistantList[i].description || '';
          break;
        }
      }
    }
    _updateModelCard();
  }
}

// Both Web Search controls (composer button + right-rail switch) reflect the
// current per-thread flag.
function _syncWebSearchToggle() {
  var on = !!(window._currentSettings && window._currentSettings.webSearch);
  var btn = document.getElementById('webSearchToggle');
  if (btn) {
    btn.classList.toggle('on', on);
    btn.setAttribute('aria-pressed', String(on));
    btn.title = on ? 'Web Search (on)' : 'Web Search (off)';
  }
  var rail = document.getElementById('railWebSearchToggle');
  if (rail) {
    if (on) rail.classList.add('on');
    else rail.classList.remove('on');
  }
}

function _syncImageGenerationToggle() {
  if (!window._currentSettings) window._currentSettings = {};
  var eligible = _isCodexImageModel(_effectiveImageGenerationModel(window._currentSettings));
  if (!eligible) window._currentSettings.imageGeneration = false;
  var row = document.getElementById('imageGenerationRow');
  if (row) row.style.display = eligible ? '' : 'none';
  var rail = document.getElementById('railImageGenerationToggle');
  if (rail) {
    if (eligible && window._currentSettings.imageGeneration) rail.classList.add('on');
    else rail.classList.remove('on');
  }
}

// Wire right panel controls
if (typeof document !== 'undefined' && document.addEventListener) {
document.addEventListener('DOMContentLoaded', function() {
  window._currentSettings = { model: '', systemMessage: '', systemOverrideSet: false, reasoning: '', temperature: '', webSearch: false, imageGeneration: false };

  // Temperature slider — auto-enable on interaction, reset to default
  var tempSlider = document.getElementById('tempSlider');
  var tempVal = document.getElementById('tempVal');
  var tempReset = document.getElementById('tempReset');
  if (tempSlider) {
    tempSlider.addEventListener('input', function() {
      // Auto-enable on first interaction
      if (tempSlider.classList.contains('temp-default')) {
        tempSlider.classList.remove('temp-default');
        if (tempReset) tempReset.style.display = '';
      }
      if (tempVal) tempVal.textContent = parseFloat(tempSlider.value).toFixed(1);
    });
    tempSlider.addEventListener('change', function() {
      window._currentSettings.temperature = tempSlider.value;
      window._currentSettings.temperatureOverrideSet = false;
      _sendAllSettings();
    });
  }
  if (tempReset) {
    tempReset.addEventListener('click', function() {
      tempSlider.value = '1.0';
      tempSlider.classList.add('temp-default');
      if (tempVal) tempVal.textContent = 'Default';
      tempReset.style.display = 'none';
      window._currentSettings.temperature = '';
      window._currentSettings.temperatureOverrideSet = true;
      _sendAllSettings();
    });
  }

  // System prompt expand modal
  var expandBtn = document.getElementById('expandSysMsg');
  if (expandBtn) expandBtn.addEventListener('click', function() {
    var overlay = document.getElementById('sysMsgOverlay');
    var mini = document.getElementById('sysMsgMini');
    var full = document.getElementById('sysMsgFull');
    if (overlay && mini && full) {
      full.value = mini.value;
      updateSysMsgCharCount();
      overlay.classList.add('open');
    }
  });

  // Direct typing in the mini field must behave like the modal Save path:
  // update _currentSettings and post the debounced updateModelSettings.
  // Typing in the system prompt field must update current settings and persist through IPC.
  // typed straight into the field never reached requestParams / the API call.
  var sysMsgMini = document.getElementById('sysMsgMini');
  if (sysMsgMini) sysMsgMini.addEventListener('input', function() {
    if (!window._currentSettings) window._currentSettings = {};
    window._currentSettings.systemMessage = sysMsgMini.value;
    window._currentSettings.systemOverrideSet = true;
    _sendAllSettings();
  });

  // Live char count for the system prompt modal (regression: the counter
  // stayed "0 chars" because nothing updated it on input).
  var sysMsgFull = document.getElementById('sysMsgFull');
  if (sysMsgFull) sysMsgFull.addEventListener('input', updateSysMsgCharCount);

  function updateSysMsgCharCount() {
    var full = document.getElementById('sysMsgFull');
    var counter = document.getElementById('charCount');
    if (!full || !counter) return;
    counter.textContent = (full.value || '').length + ' chars';
  }

  // System prompt save
  var sysMsgSave = document.getElementById('sysMsgSave');
  if (sysMsgSave) sysMsgSave.addEventListener('click', function() {
    var full = document.getElementById('sysMsgFull');
    var mini = document.getElementById('sysMsgMini');
    var overlay = document.getElementById('sysMsgOverlay');
    if (full && mini) {
      mini.value = full.value;
      window._currentSettings.systemMessage = full.value;
      window._currentSettings.systemOverrideSet = true;
      _sendAllSettings();
    }
    if (overlay) overlay.classList.remove('open');
  });

  // System prompt close/cancel
  var sysMsgClose = document.getElementById('sysMsgClose');
  var sysMsgCancel = document.getElementById('sysMsgCancel');
  if (sysMsgClose) sysMsgClose.addEventListener('click', function() {
    document.getElementById('sysMsgOverlay').classList.remove('open');
  });
  if (sysMsgCancel) sysMsgCancel.addEventListener('click', function() {
    document.getElementById('sysMsgOverlay').classList.remove('open');
  });
  // Overlay background click
  var sysMsgOverlay = document.getElementById('sysMsgOverlay');
  if (sysMsgOverlay) sysMsgOverlay.addEventListener('click', function(e) {
    if (e.target === sysMsgOverlay) sysMsgOverlay.classList.remove('open');
  });

  // Thinking level dropdown
  var thinkingDropdown = document.getElementById('reasoningDropdown');
  if (thinkingDropdown) thinkingDropdown.addEventListener('change', function() {
    window._currentSettings.reasoning = thinkingDropdown.value;
    // Both a concrete level and an explicit Model Default are per-thread
    // choices.  The empty value means "inherit/default" only when its flag is
    // true; a non-empty value must also be marked explicit or it is discarded
    // on the next ThreadSettings restore.
    window._currentSettings.reasoningOverrideSet = true;
    _sendAllSettings();
  });

  // Composer Web Search toggle (the only tool): flips the per-thread flag
  // and re-syncs the button state.
  var webSearchToggle = document.getElementById('webSearchToggle');
  if (webSearchToggle) webSearchToggle.addEventListener('click', function() {
    if (!window._currentSettings) window._currentSettings = {};
    window._currentSettings.webSearch = !window._currentSettings.webSearch;
    _syncWebSearchToggle();
    _sendAllSettings();
  });

  // Right-rail Web Search switch (same per-thread flag as the composer
  // button; both stay in sync).
  var railWebSearchToggle = document.getElementById('railWebSearchToggle');
  if (railWebSearchToggle) railWebSearchToggle.addEventListener('click', function() {
    if (!window._currentSettings) window._currentSettings = {};
    window._currentSettings.webSearch = !window._currentSettings.webSearch;
    _syncWebSearchToggle();
    _sendAllSettings();
  });

  var railImageGenerationToggle = document.getElementById('railImageGenerationToggle');
  if (railImageGenerationToggle) railImageGenerationToggle.addEventListener('click', function() {
    if (!window._currentSettings) window._currentSettings = {};
    if (!_isCodexImageModel(_effectiveImageGenerationModel(window._currentSettings))) {
      window._currentSettings.imageGeneration = false;
      _syncImageGenerationToggle();
      return;
    }
    window._currentSettings.imageGeneration = !window._currentSettings.imageGeneration;
    _syncImageGenerationToggle();
    _sendAllSettings();
  });

  // Model card click — handled by chat-settings.js
});

} // end DOMContentLoaded guard


if (typeof window !== 'undefined') window.ModelPickerConfig = {
  init: openModelSettings
};
