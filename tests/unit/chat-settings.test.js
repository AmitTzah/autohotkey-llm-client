// chat-settings.test.js — Unit tests for model-picker.js: populateAssistantDropdown, model card, popover
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { installIpc } = require('./helpers/ipc-test-utils');

function loadSettingsModule() {
    const src = fs.readFileSync(path.resolve(__dirname, '..', '..', 'webui', 'js', 'chat', 'model-picker', 'model-picker.js'), 'utf-8');
    const sandbox = {
        document: {
            getElementById: () => null,
            querySelector: () => null,
            querySelectorAll: () => [],
            createElement: (tag) => ({ tagName: tag, className: '', innerHTML: '', textContent: '', style: {}, classList: { add: () => {}, remove: () => {} }, appendChild: (c) => {}, addEventListener: () => {}, setAttribute: () => {}, getAttribute: () => null }),
            addEventListener: () => {}
        },
        window: { chrome: { webview: { postMessage: () => {} } }, addEventListener: () => {} },
        console: console,
        lucide: { createIcons: () => {} },
        setTimeout: (fn) => { try { fn(); } catch(e) {} },
        clearTimeout: () => {}
    };
    sandbox.global = sandbox;
    const ctx = vm.createContext(sandbox);
    installIpc(ctx);
    vm.runInContext(src, ctx);
    return sandbox;
}

describe('populateAssistantDropdown', () => {
    it('stores assistant list on window._assistantList', () => {
        const ctx = loadSettingsModule();
        ctx.window._assistantList = undefined;
        const assistants = [{ id: 'a1', name: 'Violet', base_model: 'gpt-4o' }];
        ctx.populateAssistantDropdown(assistants);
        assert.ok(ctx.window._assistantList);
        assert.strictEqual(ctx.window._assistantList.length, 1);
    });

    it('handles empty list', () => {
        const ctx = loadSettingsModule();
        assert.doesNotThrow(() => ctx.populateAssistantDropdown([]));
    });
});

describe('_providerIconFile', () => {
    it('returns deepseek icon for deepseek models', () => {
        const ctx = loadSettingsModule();
        assert.ok(ctx._providerIconFile('deepseek/deepseek-v4').indexOf('deepseek.ico') >= 0);
    });

    it('returns openai icon for gpt models', () => {
        const ctx = loadSettingsModule();
        assert.ok(ctx._providerIconFile('openai/gpt-4o').indexOf('openai.ico') >= 0);
    });

    it('returns google icon for gemini models', () => {
        const ctx = loadSettingsModule();
        assert.ok(ctx._providerIconFile('google/gemini-2.5-flash').indexOf('google.ico') >= 0);
    });

    it('returns anthropic icon for claude models', () => {
        const ctx = loadSettingsModule();
        assert.ok(ctx._providerIconFile('anthropic/claude-3').indexOf('anthropic.ico') >= 0);
    });

    it('returns openrouter icon for unknown models', () => {
        const ctx = loadSettingsModule();
        assert.ok(ctx._providerIconFile('unknown/model').indexOf('openrouter.ico') >= 0);
    });

    it('returns the packaged OpenRouter icon for OpenRouter models', () => {
        const ctx = loadSettingsModule();
        assert.ok(ctx._providerIconFile('openrouter/free').indexOf('openrouter.ico') >= 0);
        assert.ok(fs.existsSync(path.resolve(__dirname, '..', '..', 'icons', 'openrouter.ico')),
            'the packaged OpenRouter icon must exist');
    });
});

describe('OpenRouter model selector priority', () => {
    it('places the OpenRouter group before alphabetical provider groups', () => {
        const ctx = loadSettingsModule();
        const pane = {
            innerHTML: '',
            children: [],
            appendChild(child) { this.children.push(child); }
        };
        ctx.document.getElementById = (id) => id === 'tab-models' ? pane : null;
        ctx.window.modelList = {
            google: [{ id: 'gemini', fullId: 'google/gemini' }],
            openrouter: [{ id: 'free', fullId: 'openrouter/free' }],
            deepseek: [{ id: 'deepseek-v4', fullId: 'deepseek/deepseek-v4' }]
        };
        ctx.escHtml = (value) => String(value || '');
        ctx.window._currentSettings = { model: '', assistantName: '' };
        ctx._populateModelsTab();
        assert.strictEqual(pane.children[0].textContent, 'Openrouter');
        assert.ok(pane.children[1].innerHTML.indexOf('>free<') >= 0,
            'openrouter/free must be the first model shown');
        assert.ok(pane.children[1].innerHTML.indexOf('openrouter.ico') >= 0,
            'the first model must use the OpenRouter icon');
        assert.ok(pane.children[1].innerHTML.indexOf('background:#7c3aed') >= 0,
            'the OpenRouter icon must have a visible purple backdrop');
    });
});

describe('_updateModelCard', () => {
    it('does not throw when card missing', () => {
        const ctx = loadSettingsModule();
        ctx.window._currentSettings = { model: 'deepseek/deepseek-v4', assistantName: '' };
        assert.doesNotThrow(() => ctx._updateModelCard());
    });
});

describe('_sendAllSettings', () => {
    it('does not throw (debounced)', () => {
        const ctx = loadSettingsModule();
        ctx.window._currentSettings = { model: 'test', systemMessage: '', reasoning: '', temperature: '' };
        assert.doesNotThrow(() => ctx._sendAllSettings());
    });
});

describe('_makeModelClickHandler — keeps reasoning, clears assistant overrides', () => {
    it('keeps reasoning but clears systemMessage/temperature when switching from assistant to model', () => {
        const ctx = loadSettingsModule();
        // Simulate an assistant being active with overrides set
        ctx.window._currentSettings = {
            model: 'deepseek/deepseek-v4-pro',
            systemMessage: 'You are a helpful assistant.',
            reasoning: 'high',
            temperature: '0.7',
            assistantName: 'Violet',
            assistantBaseModel: 'openai/gpt-4o',
            assistantDescription: 'A creative writing assistant'
        };

        // Capture postMessage calls to verify what gets sent
        var postMessageCalls = [];
        ctx.window.chrome.webview.postMessage = function(msg) { postMessageCalls.push(msg); };

        // Create a mock element with parent (needed for classList.remove on siblings)
        var mockParent = {
            querySelectorAll: function() { return []; }
        };
        var mockEl = {
            parentElement: mockParent,
            classList: { add: function() {} }
        };

        // Invoke the click handler
        var handler = ctx._makeModelClickHandler(mockEl, 'google/gemini-2.5-flash');
        handler();

        // Verify _currentSettings was properly cleared
        assert.strictEqual(ctx.window._currentSettings.model, 'google/gemini-2.5-flash');
        assert.strictEqual(ctx.window._currentSettings.assistantName, '');
        assert.strictEqual(ctx.window._currentSettings.assistantBaseModel, '');
        assert.strictEqual(ctx.window._currentSettings.assistantDescription, '');
        assert.strictEqual(ctx.window._currentSettings.systemMessage, '', 'leaving assistant mode must clear the assistant-owned System Message');
        assert.strictEqual(ctx.window._currentSettings.reasoning, 'high', 'the selected reasoning level must survive a model change');
        assert.strictEqual(ctx.window._currentSettings.temperature, '');
    });

    it('keeps the thread system message and reasoning when switching model-to-model', () => {
        const ctx = loadSettingsModule();
        // Simulate model-to-model switch with a custom system message
        ctx.window._currentSettings = {
            model: 'deepseek/deepseek-v4-pro',
            systemMessage: 'Custom system message',
            systemOverrideSet: true,
            reasoning: 'medium',
            temperature: '1.2',
            assistantName: '',
            assistantBaseModel: '',
            assistantDescription: ''
        };

        var postMessageCalls = [];
        ctx.window.chrome.webview.postMessage = function(msg) { postMessageCalls.push(msg); };

        var mockParent = {
            querySelectorAll: function() { return []; }
        };
        var mockEl = {
            parentElement: mockParent,
            classList: { add: function() {} }
        };

        var handler = ctx._makeModelClickHandler(mockEl, 'anthropic/claude-3');
        handler();

        // Assistant-owned overrides are still cleared, but the user's
        // reasoning selection is preserved on model-to-model switch.
        assert.strictEqual(ctx.window._currentSettings.model, 'anthropic/claude-3');
        assert.strictEqual(ctx.window._currentSettings.systemMessage, 'Custom system message', 'model-to-model switch must preserve the thread System Message');
        assert.strictEqual(ctx.window._currentSettings.systemOverrideSet, true);
        assert.strictEqual(ctx.window._currentSettings.reasoning, 'medium', 'the selected reasoning level must survive a model-to-model switch');
        assert.strictEqual(ctx.window._currentSettings.temperature, '');
    });

    it('hides temperature synchronously for a model that does not support it and restores it for supported models', () => {
        const ctx = loadSettingsModule();
        const tempField = { style: { display: '' } };
        const tempSlider = { parentElement: tempField, disabled: false, title: '' };
        ctx.document.getElementById = (id) => id === 'tempSlider' ? tempSlider : null;
        ctx.window._currentSettings = { model: 'deepseek/deepseek-v4-flash', reasoning: '', temperature: '', assistantName: '' };
        const mockEl = { classList: { add: function() {} } };

        assert.strictEqual(ctx._supportsTemperatureValue(0), false, 'AHK numeric false must mean unsupported');
        ctx._makeModelClickHandler(mockEl, 'codex/gpt-5.6-luna', 0)();
        assert.strictEqual(ctx.window._currentSettings.supportsTemperature, false);
        assert.strictEqual(tempField.style.display, 'none', 'Codex selection should hide the Temperature row immediately');
        assert.strictEqual(tempSlider.disabled, true);

        ctx._makeModelClickHandler(mockEl, 'deepseek/deepseek-v4-flash', true)();
        assert.strictEqual(ctx.window._currentSettings.supportsTemperature, true);
        assert.strictEqual(tempField.style.display, '', 'switching back should restore the Temperature row immediately');
        assert.strictEqual(tempSlider.disabled, false);
    });
});

describe('Image Generation model gating', () => {
    it('clears imageGeneration synchronously when switching from Codex to a non-Codex model', () => {
        const ctx = loadSettingsModule();
        ctx.window._currentSettings = { model: 'codex/gpt-5.6-luna', imageGeneration: true, assistantName: '', reasoning: '', temperature: '' };
        const mockEl = { classList: { add: function() {} } };
        ctx._makeModelClickHandler(mockEl, 'deepseek/deepseek-v4-flash', true)();
        assert.strictEqual(ctx.window._currentSettings.imageGeneration, false);
    });
});

describe('_makeAssistantClickHandler — updates mode before posting', () => {
    it('sets assistant state synchronously so an immediate send cannot flush the old model', () => {
        const ctx = loadSettingsModule();
        ctx.window._currentSettings = { model: 'openai/gpt-5-mini', assistantName: '' };
        ctx.window._assistantList = [{
            id: 'a1', name: 'Immediate Assistant', baseModel: 'deepseek/deepseek-v4-flash',
            systemMessage: 'assistant prompt', description: 'description'
        }];
        const mockEl = {
            parentElement: { querySelectorAll: () => [] },
            classList: { add: () => {} }
        };
        ctx._makeAssistantClickHandler(mockEl, 'a1')();
        assert.strictEqual(ctx.window._currentSettings.assistantName, 'Immediate Assistant');
        assert.strictEqual(ctx.window._currentSettings.assistantBaseModel, 'deepseek/deepseek-v4-flash');
        assert.strictEqual(ctx.window._currentSettings.systemMessage, 'assistant prompt');
    });

    it('clears imageGeneration when a non-Codex assistant becomes effective', () => {
        const ctx = loadSettingsModule();
        ctx.window._currentSettings = { model: 'codex/gpt-5.6-luna', imageGeneration: true, assistantName: '' };
        ctx.window._assistantList = [{ id: 'a-img', name: 'No Image', baseModel: 'deepseek/deepseek-v4-flash', systemMessage: '', description: '' }];
        const mockEl = { parentElement: { querySelectorAll: () => [] }, classList: { add: () => {} } };
        ctx._makeAssistantClickHandler(mockEl, 'a-img')();
        assert.strictEqual(ctx.window._currentSettings.imageGeneration, false);
    });

    it('also replaces direct-model reasoning and temperature before an immediate send', () => {
        const ctx = loadSettingsModule();
        ctx.window._currentSettings = {
            model: 'openai/gpt-5-mini', assistantName: '', reasoning: 'high', temperature: 1.2
        };
        ctx.window._assistantList = [{
            id: 'a1', name: 'Configured Assistant', baseModel: 'deepseek/deepseek-v4-flash',
            systemMessage: 'assistant prompt', reasoning: 'low', temperature: 0.2, description: ''
        }];
        const mockEl = {
            parentElement: { querySelectorAll: () => [] },
            classList: { add: () => {} }
        };
        ctx._makeAssistantClickHandler(mockEl, 'a1')();
        assert.strictEqual(ctx.window._currentSettings.reasoning, 'low');
        assert.strictEqual(ctx.window._currentSettings.temperature, 0.2);
    });
});

describe('_sendAllSettings', () => {
    it('includes the right-rail Web Search flag in the payload (code execution removed)', () => {
        const ctx = loadSettingsModule();
        const posted = [];
        ctx.window.chrome.webview.postMessage = (m) => posted.push(m);
        ctx.window._currentSettings = {
            model: 'deepseek/deepseek-v4-flash', systemMessage: '', reasoning: '', temperature: '',
            webSearch: true
        };
        ctx._sendAllSettings();
        assert.strictEqual(posted.length, 1);
        const payload = JSON.parse(posted[0]);
        assert.strictEqual(payload.action, 'updateModelSettings');
        assert.strictEqual(payload.codeExecution, undefined, 'codeExecution stub was removed');
        assert.strictEqual(payload.webSearch, true);
        assert.strictEqual(payload.imageGeneration, false);
    });

    it('includes the Codex image-generation flag in the settings payload', () => {
        const ctx = loadSettingsModule();
        const posted = [];
        ctx.window.chrome.webview.postMessage = (m) => posted.push(m);
        ctx.window._currentSettings = {
            model: 'codex/gpt-5.6-luna', systemMessage: '', reasoning: '', temperature: '',
            webSearch: false, imageGeneration: true
        };
        ctx._sendAllSettings();
        const payload = JSON.parse(posted[0]);
        assert.strictEqual(payload.imageGeneration, true);
    });

    it('includes explicit empty override flags in the payload', () => {
        const ctx = loadSettingsModule();
        const posted = [];
        ctx.window.chrome.webview.postMessage = (m) => posted.push(m);
        ctx.window._currentSettings = {
            model: '', systemMessage: '', systemOverrideSet: true, reasoning: '', temperature: '', assistantName: 'Defaults',
            reasoningOverrideSet: true, temperatureOverrideSet: true
        };
        ctx._sendAllSettings();
        const payload = JSON.parse(posted[0]);
        assert.strictEqual(payload.systemOverrideSet, true);
        assert.strictEqual(payload.reasoningOverrideSet, true);
        assert.strictEqual(payload.temperatureOverrideSet, true);
    });

    it('keeps a temperature override of 0 in the payload (bug #193)', () => {
        const ctx = loadSettingsModule();
        const posted = [];
        ctx.window.chrome.webview.postMessage = (m) => posted.push(m);
        ctx.window._currentSettings = {
            model: '', systemMessage: '', reasoning: '', temperature: 0,
            webSearch: false, assistantName: ''
        };
        ctx._sendAllSettings();
        assert.strictEqual(posted.length, 1);
        const payload = JSON.parse(posted[0]);
        assert.strictEqual(payload.action, 'updateModelSettings');
        assert.strictEqual(payload.temperature, 0, 'a numeric 0 temperature must survive the send (0 is falsy in JS)');

        // A truly empty temperature must still serialize as "".
        ctx.window._currentSettings.temperature = '';
        posted.length = 0;
        ctx._sendAllSettings();
        assert.strictEqual(posted.length, 1);
        assert.strictEqual(JSON.parse(posted[0]).temperature, '');
    });
});


describe('model picker transport provider icon', () => {
    it('passes explicit OpenRouter provider to the shared resolver', () => {
        const ctx = loadSettingsModule();
        let seen = null;
        ctx.window.ProviderIcons = {
            file(model, provider) { seen = { model, provider }; return '../icons/openrouter.ico'; },
            style() { return ''; }
        };
        const icon = ctx._providerIconFile('openrouter/openai/gpt-5.6-sol', 'openrouter');
        assert.ok(icon.includes('openrouter.ico'));
        assert.deepStrictEqual(seen, { model: 'openrouter/openai/gpt-5.6-sol', provider: 'openrouter' });
    });
});
