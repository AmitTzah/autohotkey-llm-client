// commands-screenshot.test.js — generalized Attach Screenshot command behavior
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadCore() {
  const sharedSrc = fs.readFileSync(path.resolve(__dirname, '..', '..', 'webui', 'js', 'shared', 'settings-shared.js'), 'utf-8');
  const coreSrc = fs.readFileSync(path.resolve(__dirname, '..', '..', 'webui', 'js', 'settings', 'sections', 'commands', 'commands-core.js'), 'utf-8');
  const sandbox = {
    document: {
      getElementById: function(id) { return id === 'chatShortcut' ? { value: '' } : null; },
      addEventListener: function() {}
    },
    window: { Cmds: {}, SettingsPanel: { markDirty: function() {}, registerSection: function() {} } },
    console: console
  };
  sandbox.global = sandbox;
  const ctx = vm.createContext(sandbox);
  vm.runInContext(sharedSrc, ctx);
  vm.runInContext(coreSrc, ctx);
  const C = sandbox.window.Cmds;
  C.renderList = function() {};
  C.selectCommand = function() {};
  C.showPlaceholder = function() {};
  C.syncDetail = function() {};
  return C;
}

function validateCommand(command, model) {
  const C = loadCore();
  const models = {};
  if (model) models[command.APIModels] = model;
  C.load({ commands: [command], models: models, commandGroupOrders: {}, submenuOrder: [] });
  C.syncDetail = function() {};
  return C.validate();
}

describe('Attach Screenshot command option', () => {
  it('is rendered and synchronized by the Commands detail panel', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '..', '..', 'webui', 'js', 'settings', 'sections', 'commands', 'commands-render.js'), 'utf-8');
    assert.ok(src.includes('id="cmdIncludeImageContext"'), 'Behavior card must expose Attach Screenshot');
    assert.ok(src.includes("_setToggle('cmdIncludeImageContext', !!cmd.includeImageContext)"), 'saved state must load into the toggle');
    assert.ok(src.includes("cmd.includeImageContext = d.getElementById('cmdIncludeImageContext').classList.contains('on')"), 'toggle must save back to the command');
  });

  it('new commands default Attach Screenshot to off', () => {
    const C = loadCore();
    C.load({ commands: [], models: {}, commandGroupOrders: {}, submenuOrder: [] });
    C.addCommand();
    assert.strictEqual(C.commands()[0].includeImageContext, false);
  });

  it('requires chat paste mode', () => {
    const result = validateCommand({ commandName:'Shot', menuText:'Shot', APIModels:'vision/model', pasteMode:'replace', includeImageContext:true, tags:[] }, { vision:true });
    assert.strictEqual(result.valid, false);
    assert.match(result.message, /Paste Mode/);
  });

  it('cannot be combined with FIM', () => {
    const result = validateCommand({ commandName:'Shot', menuText:'Shot', APIModels:'vision/model', pasteMode:'chat', isFIM:true, includeImageContext:true, tags:[] }, { vision:true });
    assert.strictEqual(result.valid, false);
    assert.match(result.message, /FIM Mode/);
  });

  it('rejects a known non-vision model', () => {
    const result = validateCommand({ commandName:'Shot', menuText:'Shot', APIModels:'text/model', pasteMode:'chat', includeImageContext:true, tags:[] }, { vision:false });
    assert.strictEqual(result.valid, false);
    assert.match(result.message, /does not support image input/);
  });

  it('does not cross providers when a fully-qualified command model is missing', () => {
    const C = loadCore();
    const command = {
      commandName:'Shot', menuText:'Shot', APIModels:'openai/gpt-5.6-luna',
      pasteMode:'chat', includeImageContext:true, tags:[]
    };
    C.load({
      commands: [command],
      models: { 'codex/gpt-5.6-luna': { vision:false } },
      commandGroupOrders: {}, submenuOrder: []
    });
    C.syncDetail = function() {};
    const result = C.validate();
    assert.strictEqual(result.valid, true,
      'openai/gpt-5.6-luna must not be rebound to codex/gpt-5.6-luna by bare-name fallback');
  });

  it('accepts numeric vision=1 from AHK settings payloads', () => {
    const result = validateCommand({ commandName:'Shot', menuText:'Shot', APIModels:'vision/model', pasteMode:'chat', includeImageContext:true, tags:[] }, { vision:1 });
    assert.strictEqual(result.valid, true);
  });

  it('accepts a normal chat command with a vision-capable model', () => {
    const result = validateCommand({ commandName:'Shot', menuText:'Shot', APIModels:'vision/model', pasteMode:'chat', includeImageContext:true, tags:[] }, { vision:true });
    assert.strictEqual(result.valid, true);
  });
});
