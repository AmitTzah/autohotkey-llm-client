// commands-core.js — state, load, save, validate, helpers, registration
(function() {
  var S = window.SettingsShared;
  var _commands = [];
  var _selectedIdx = -1;
  var _submenuOrder = [];
  // Per-group independent ordering: { '__main__': [idx,...], 'TagName': [idx,...] }
  var _groupOrders = {};
  var _models = null;
  var _defaultModel = '';

  function _belongsToGroup(cmd, tag) {
    var tags = cmd.tags || [];
    if (tag === '__main__') return tags.length === 0 || !!cmd.directAccelerator;
    for (var i = 0; i < tags.length; i++) {
      if (tags[i].trim() === tag) return true;
    }
    return false;
  }

  function _ensureGroupOrders() {
    var knownGroups = { '__main__': true };
    _commands.forEach(function(cmd, i) {
      var tags = cmd.tags || [];
      if (tags.length === 0 || cmd.directAccelerator) knownGroups.__main__ = true;
      tags.forEach(function(t) { if (t.trim()) knownGroups[t.trim()] = true; });
    });

    Object.keys(_groupOrders).forEach(function(tag) {
      if (!knownGroups[tag]) {
        delete _groupOrders[tag];
        return;
      }
      var valid = [], seen = {};
      (_groupOrders[tag] || []).forEach(function(idx) {
        if (typeof idx !== 'number' || idx % 1 !== 0 || idx < 0 || idx >= _commands.length ||
            !_belongsToGroup(_commands[idx], tag) || seen[idx]) return;
        valid.push(idx);
        seen[idx] = true;
      });
      _groupOrders[tag] = valid;
    });

    Object.keys(knownGroups).forEach(function(tag) {
      _groupOrders[tag] = _groupOrders[tag] || [];
      _commands.forEach(function(cmd, i) {
        if (_belongsToGroup(cmd, tag) && _groupOrders[tag].indexOf(i) < 0)
          _groupOrders[tag].push(i);
      });
    });
  }

  function _readGroupOrders(saved) {
    var result = {};
    if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return result;
    Object.keys(saved).forEach(function(tag) {
      if (!Array.isArray(saved[tag])) return;
      result[tag] = saved[tag].map(Number).filter(function(idx) { return isFinite(idx) && idx % 1 === 0; });
    });
    return result;
  }

  function _copyGroupOrders() {
    var result = {};
    Object.keys(_groupOrders).forEach(function(tag) { result[tag] = _groupOrders[tag].slice(); });
    return result;
  }

  function load(data) {
    var previous = (_selectedIdx >= 0 && _selectedIdx < _commands.length)
      ? _commands[_selectedIdx] : null;
    _commands = (data && data.commands) ? data.commands : [];
    _submenuOrder = (data && data.submenuOrder) ? data.submenuOrder : [];
    _models = (data && data.models) ? data.models : null;
    // Commands need a plain model default: use "New Chats Start With" when it
    // is a model id, else the app default model (an assistant default has no
    // model for commands).
    _defaultModel = (data && data.newChatStartsWith && data.newChatStartsWith.indexOf('asst:') !== 0)
        ? data.newChatStartsWith
        : 'deepseek/deepseek-v4-flash';
    // The host re-sends the merged settings after every save. Preserve the
    // command the user was editing instead of jumping back to the first
    // command (usually Quick Ask). Commands have no persistent id, so match
    // the stable name + menu label pair; edited values are already present on
    // the previous in-memory command because save() syncs it first.
    var restoredIdx = -1;
    if (previous) {
      for (var i = 0; i < _commands.length; i++) {
        if (_commands[i].commandName === previous.commandName &&
            _commands[i].menuText === previous.menuText) {
          restoredIdx = i;
          break;
        }
      }
    }
    _selectedIdx = restoredIdx;
    _groupOrders = _readGroupOrders(data && data.commandGroupOrders);
    _ensureGroupOrders();
    var selectIdx = restoredIdx >= 0 ? restoredIdx : 0;
    window.Cmds.renderList(selectIdx);
    if (_commands.length > 0) window.Cmds.selectCommand(selectIdx);
    else window.Cmds.showPlaceholder();
  }

  function save() {
    window.Cmds.syncDetail();
    _ensureGroupOrders();
    var rebuilt = _rebuildFromGroupOrders();
    _commands = rebuilt.commands;
    // Remap _selectedIdx and _groupOrders indices using the old→new mapping
    _selectedIdx = rebuilt.oldToNew[_selectedIdx] !== undefined ? rebuilt.oldToNew[_selectedIdx] : -1;
    var mappedOrders = {};
    Object.keys(_groupOrders).forEach(function(tag) {
      mappedOrders[tag] = [];
      _groupOrders[tag].forEach(function(oldIdx) {
        var newIdx = rebuilt.oldToNew[oldIdx];
        if (newIdx !== undefined) mappedOrders[tag].push(newIdx);
      });
    });
    _groupOrders = mappedOrders;
    // Re-render to update DOM data-index attributes with new indices
    window.Cmds.renderList(_selectedIdx >= 0 ? _selectedIdx : 0);
    return { commands: _commands, submenuOrder: _submenuOrder, commandGroupOrders: _copyGroupOrders() };
  }

  // Rebuild _commands from group orders (main first, then tagged groups) and
  // return the old-position → new-position mapping (matched by object reference).
  function _rebuildFromGroupOrders() {
    var newCmds = [];
    var seen = {};
    var main = _groupOrders['__main__'] || [];
    main.forEach(function(i) { if (!seen[i]) { newCmds.push(_commands[i]); seen[i] = true; } });
    var so = _submenuOrder.slice();
    Object.keys(_groupOrders).forEach(function(t) { if (t !== '__main__' && so.indexOf(t) < 0) so.push(t); });
    so.forEach(function(tag) {
      (_groupOrders[tag] || []).forEach(function(i) { if (!seen[i]) { newCmds.push(_commands[i]); seen[i] = true; } });
    });
    var oldToNew = [];
    newCmds.forEach(function(cmd, newPos) {
      for (var oldPos = 0; oldPos < _commands.length; oldPos++) {
        if (_commands[oldPos] === cmd) { oldToNew[oldPos] = newPos; break; }
      }
    });
    return { commands: newCmds, oldToNew: oldToNew };
  }

  // Collect submenu tag accelerators. Returns { tagAccels: {...} }.
  function _collectTagAccels() {
    var tagAccels = {};  // accelerator char → { tag, firstCmdName }
    for (var i = 0; i < _commands.length; i++) {
      var tags = _commands[i].tags || [];
      for (var t = 0; t < tags.length; t++) {
        var tag = tags[t].trim();
        var tagM = tag.match(/^&(.)/);
        if (!tagM) continue;
        var tagKey = tagM[1].toLowerCase();
        if (!tagAccels[tagKey]) {
          tagAccels[tagKey] = { tag: tag, firstCmdName: _commands[i].commandName || 'Unnamed' };
        }
      }
    }
    return tagAccels;
  }

  // Lowercased accelerator key from "&X - Label" style text, or ''.
  function _acceleratorKey(text) {
    var m = (text || '').match(/&(.)/);
    return m ? m[1].toLowerCase() : '';
  }

  // Shared shortcut key when two commands conflict, or '' if they don't.
  function _shortcutConflict(ci, cj) {
    var msKeyI = _acceleratorKey(ci.menuText);
    var msKeyJ = _acceleratorKey(cj.menuText);
    var directKeyI = ci.directAccelerator ? ci.directAccelerator.replace('&', '').toLowerCase() : '';
    var directKeyJ = cj.directAccelerator ? cj.directAccelerator.replace('&', '').toLowerCase() : '';
    var hasTagsI = ci.tags && ci.tags.length > 0;
    var hasTagsJ = cj.tags && cj.tags.length > 0;
    if ((directKeyI && directKeyI === directKeyJ) ||
        (!hasTagsI && !hasTagsJ && msKeyI && msKeyI === msKeyJ) ||
        (directKeyI && !hasTagsJ && msKeyJ && directKeyI === msKeyJ) ||
        (!hasTagsI && msKeyI && directKeyJ && msKeyI === directKeyJ))
      return (directKeyI || msKeyI || '?').toUpperCase();
    return '';
  }

  function _resolveCommandModelKey(cmd) {
    var model = (cmd && cmd.APIModels) ? cmd.APIModels : (_defaultModel || '');
    if (!_models || !model) return model;
    if (_models[model]) return model;
    // A fully-qualified provider/model id is authoritative. If that exact
    // entry is absent from the current catalog, do not silently bind it to a
    // different provider that happens to expose the same bare model name.
    // Bare-name fallback exists only for legacy short ids.
    if (model.indexOf('/') >= 0) return model;
    var keys = Object.keys(_models);
    for (var i = 0; i < keys.length; i++) {
      if (keys[i].split('/')[1] === model) return keys[i];
    }
    return model;
  }

  function validate() {
    window.Cmds.syncDetail();
    var cs = (document.getElementById('chatShortcut') || {}).value || '';
    if (cs) cs = cs.toLowerCase();

    var tagAccels = _collectTagAccels();

    // Check chatShortcut against submenu tag accelerators
    if (cs && tagAccels[cs]) {
      return { valid: false, message: 'Open Chat key "' + cs.toUpperCase() + '" conflicts with submenu "' + tagAccels[cs].tag + '" (used by "' + tagAccels[cs].firstCmdName + '").' };
    }

    for (var i = 0; i < _commands.length; i++) {
      var ci = _commands[i];
      var hasTagsI = ci.tags && ci.tags.length > 0;
      var msKey = _acceleratorKey(ci.menuText);
      var directKey = ci.directAccelerator ? ci.directAccelerator.replace('&', '').toLowerCase() : '';

      if (ci.includeImageContext) {
        if (ci.isFIM)
          return { valid: false, message: 'Attach Screenshot cannot be used with FIM Mode.', selectIdx: i };
        if ((ci.pasteMode || 'chat') !== 'chat')
          return { valid: false, message: 'Attach Screenshot requires Paste Mode "chat".', selectIdx: i };
        var imageModelKey = _resolveCommandModelKey(ci);
        if (_models && imageModelKey && _models[imageModelKey] && !_models[imageModelKey].vision)
          return { valid: false, message: 'Model "' + imageModelKey + '" does not support image input. Choose a vision-capable model or turn off Attach Screenshot.', selectIdx: i };
      }

      // Check chatShortcut against command accelerators (existing logic)
      if (cs && ((!hasTagsI && msKey === cs) || (directKey === cs)))
        return { valid: false, message: 'Open Chat key "' + cs.toUpperCase() + '" conflicts with "' + (ci.commandName||'Unnamed') + '".', selectIdx: i };

      // Check directAccelerator / untagged menuText against submenu tag accelerators
      if (directKey && tagAccels[directKey])
        return { valid: false, message: 'Direct key "&' + directKey.toUpperCase() + '" in "' + (ci.commandName||'Unnamed') + '" conflicts with submenu "' + tagAccels[directKey].tag + '".', selectIdx: i };
      if (!hasTagsI && msKey && tagAccels[msKey])
        return { valid: false, message: 'Menu key "&' + msKey.toUpperCase() + '" in "' + (ci.commandName||'Unnamed') + '" conflicts with submenu "' + tagAccels[msKey].tag + '".', selectIdx: i };

      for (var j = i + 1; j < _commands.length; j++) {
        var cj = _commands[j];
        var conflictKey = _shortcutConflict(ci, cj);
        if (conflictKey)
          return { valid: false, message: 'Menu key "' + conflictKey + '" is used by "' + (ci.commandName||'Unnamed') + '" and "' + (cj.commandName||'Unnamed') + '".', selectIdx: i };
      }
    }
    return { valid: true };
  }

  function mark() { S.markDirty(); }

  function addCommand() {
    _commands.push({ commandName:'New Command', menuText:'New Command', APIModels:'', pasteMode:'chat', stream:false, isFIM:false, showInputBox:false, includeImageContext:false, userMessage:'', tags:[] });
    var idx = _commands.length - 1;
    _groupOrders['__main__'].push(idx);
    window.Cmds.selectCommand(idx);
    mark();
  }

  window.Cmds = {
    commands: function() { return _commands; },
    setCommands: function(c) { _commands = c; },
    models: function() { return _models; },
    defaultModel: function() { return _defaultModel; },
    selectedIdx: function() { return _selectedIdx; },
    setSelectedIdx: function(i) { _selectedIdx = i; },
    submenuOrder: function() { return _submenuOrder; },
    setSubmenuOrder: function(o) { _submenuOrder = o; },
    groupOrders: function() { return _groupOrders; },
    setGroupOrders: function(g) { _groupOrders = g; },
    load: load, save: save, validate: validate,
    mark: mark, escHtml: S.escHtml, addCommand: addCommand,
    ensureGroupOrders: _ensureGroupOrders
  };

  if (typeof document !== 'undefined') {
    document.addEventListener('DOMContentLoaded', function() {
      var addBtn = document.getElementById('addCommandBtn');
      if (addBtn) addBtn.addEventListener('click', addCommand);
    });
  }

  S.registerSection('commands', {
    load: load, save: save, validate: validate,
    selectCommand: function(i) { window.Cmds.selectCommand(i); }
  });
})();
