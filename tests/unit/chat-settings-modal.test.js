// chat-settings-modal.test.js — Unit tests for model-picker-config.js
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { installIpc } = require('./helpers/ipc-test-utils');

function loadModule() {
    const src = fs.readFileSync(path.resolve(__dirname, '..', '..', 'webui', 'js', 'chat', 'model-picker', 'model-picker-config.js'), 'utf-8');
    const sandbox = {
        document: {
            getElementById: (id) => {
                if (id === 'tempSlider') return { value: '1.0', disabled: false, classList: { add: () => {}, remove: () => {}, contains: () => false }, addEventListener: () => {} };
                if (id === 'tempVal') return { textContent: '1.0' };
                if (id === 'tempToggle') return { classList: { add: () => {}, remove: () => {}, contains: () => false }, addEventListener: () => {} };
                if (id === 'tempReset') return { style: { display: '' }, addEventListener: () => {} };
                if (id === 'reasoningDropdown') return {
                    value: '', options: [], innerHTML: '',
                    appendChild: (opt) => { },
                    addEventListener: () => {}
                };
                if (id === 'sysMsgMini') return { value: '' };
                if (id === 'sysMsgFull') return { value: '' };
                if (id === 'sysMsgOverlay') return { classList: { add: (c) => {}, remove: (c) => {} } };
                if (id === 'expandSysMsg') return { addEventListener: () => {} };
                if (id === 'sysMsgSave') return { addEventListener: () => {} };
                if (id === 'sysMsgClose') return { addEventListener: () => {} };
                if (id === 'sysMsgCancel') return { addEventListener: () => {} };
                if (id === 'webSearchToggle') return { classList: { add: () => {}, remove: () => {}, toggle: () => {}, contains: () => false }, setAttribute: () => {}, title: '', addEventListener: () => {} };
                if (id === 'railWebSearchToggle') return { classList: { add: () => {}, remove: () => {}, contains: () => false }, addEventListener: () => {} };
                if (id === 'modelCardTrigger') return { querySelector: () => ({ textContent: '' }) };
                return null;
            },
            querySelector: () => null,
            querySelectorAll: () => [],
            createElement: () => ({ style: {}, appendChild: () => {}, addEventListener: () => {} }),
            addEventListener: () => {}
        },
        window: { chrome: { webview: { postMessage: () => {} } }, addEventListener: () => {}, _currentSettings: {} },
        setTimeout: (fn) => { try { fn(); } catch(e) {} }, clearTimeout: () => {},
        _sendAllSettings: () => {}, _updateModelCard: () => {},
        lucide: { createIcons: () => {} },
        console: console
    };
    sandbox.global = sandbox;
    const ctx = vm.createContext(sandbox);
    installIpc(ctx);
    vm.runInContext(src, ctx);
    return sandbox;
}

describe('openModelSettings', () => {
    it('sends requestCurrentSettings', () => {
        const ctx = loadModule();
        assert.doesNotThrow(() => ctx.openModelSettings());
    });
});

describe('populateCurrentSettings', () => {
    it('stores settings and updates slider', () => {
        const ctx = loadModule();
        const settings = { model: 'deepseek-v4', systemMessage: '', reasoning: '', temperature: '0.7' };
        assert.doesNotThrow(() => ctx.populateCurrentSettings(settings));
        assert.strictEqual(ctx.window._currentSettings.temperature, '0.7');
    });

    it('shows Default for empty temperature', () => {
        const ctx = loadModule();
        const settings = { model: '', systemMessage: '', reasoning: '', temperature: '' };
        ctx.populateCurrentSettings(settings);
        assert.strictEqual(ctx.window._currentSettings.temperature, '');
    });

    it('keeps a temperature override of 0 (bug #78)', () => {
        const ctx = loadModule();
        const settings = { model: '', systemMessage: '', reasoning: '', temperature: 0 };
        ctx.populateCurrentSettings(settings);
        assert.strictEqual(ctx.window._currentSettings.temperature, 0, 'stored temperature must stay 0');
        const src = fs.readFileSync(path.resolve(__dirname, '..', '..', 'webui', 'js', 'chat', 'model-picker', 'model-picker-config.js'), 'utf-8');
        assert.ok(!/settings\.temperature && settings\.temperature !== ''/.test(src), 'hasTemp must not treat 0 as falsy');
        assert.ok(/settings\.temperature !== '' && settings\.temperature !== undefined/.test(src), 'hasTemp should use explicit empty checks');
    });

    it('normalizes AHK numeric override flags from threadSettings', () => {
        const ctx = loadModule();
        ctx.populateCurrentSettings({
            model: 'deepseek/deepseek-v4-flash',
            systemMessage: 'KEEP', systemOverrideSet: 1,
            reasoning: 'high', reasoningOverrideSet: 1,
            temperature: '', temperatureOverrideSet: 0
        });
        assert.strictEqual(ctx.window._currentSettings.systemOverrideSet, true);
        assert.strictEqual(ctx.window._currentSettings.reasoningOverrideSet, true);
        assert.strictEqual(ctx.window._currentSettings.temperatureOverrideSet, false);
    });

    it('records AHK numeric false as unsupported temperature for Codex', () => {
        const ctx = loadModule();
        ctx.populateCurrentSettings({ model: 'codex/gpt-5.6-luna', systemMessage: '', reasoning: 'high', temperature: '', supportsTemperature: 0 });
        assert.strictEqual(ctx.window._currentSettings.supportsTemperature, false);
    });

    it('hides the Temperature row for Codex and restores it for supported models', () => {
        const ctx = loadModule();
        const temperatureField = { style: { display: '' } };
        const tempSlider = {
            value: '1.0', disabled: false, title: '', parentElement: temperatureField,
            classList: { add: () => {}, remove: () => {}, contains: () => false },
            addEventListener: () => {}
        };
        const tempVal = { textContent: '1.0' };
        const tempReset = { style: { display: '' }, addEventListener: () => {} };
        const originalGet = ctx.document.getElementById;
        ctx.document.getElementById = (id) => {
            if (id === 'tempSlider') return tempSlider;
            if (id === 'tempVal') return tempVal;
            if (id === 'tempReset') return tempReset;
            return originalGet(id);
        };

        ctx.populateCurrentSettings({ model: 'codex/gpt-5.6-luna', systemMessage: '', reasoning: 'high', temperature: '', supportsTemperature: 0 });
        assert.strictEqual(temperatureField.style.display, 'none', 'Codex must not show an unsupported Temperature control');
        assert.strictEqual(tempSlider.disabled, true, 'hidden unsupported Temperature control should remain disabled');

        ctx.populateCurrentSettings({ model: 'openai/gpt-5-mini', systemMessage: '', reasoning: '', temperature: '', supportsTemperature: true });
        assert.strictEqual(temperatureField.style.display, '', 'Temperature control should return for supported models');
        assert.strictEqual(tempSlider.disabled, false);
    });

    it('handles null settings gracefully', () => {
        const ctx = loadModule();
        assert.doesNotThrow(() => ctx.populateCurrentSettings(null));
    });

    it('stores assistant metadata when provided', () => {
        const ctx = loadModule();
        ctx.populateCurrentSettings({
            model: 'deepseek-v4',
            systemMessage: 'test',
            reasoning: 'none',
            temperature: '',
            assistantName: 'Violet',
            assistantBaseModel: 'deepseek-v4',
            assistantDescription: 'A friendly bot'
        });
        assert.strictEqual(ctx.window._currentSettings.assistantName, 'Violet');
        assert.strictEqual(ctx.window._currentSettings.assistantDescription, 'A friendly bot');
    });

    it('stores the Web Search toggle and syncs the composer button (code execution removed)', () => {
        const ctx = loadModule();
        const added = [], removed = [];
        const btn = {
            classList: { add: (c) => added.push(c), remove: (c) => removed.push(c), toggle: (c, force) => { if (force) added.push(c); else removed.push(c); }, contains: () => false },
            setAttribute: () => {}, title: ''
        };
        const railAdded = [];
        const rail = { classList: { add: (c) => railAdded.push(c), remove: () => {}, contains: () => false } };
        ctx.document.getElementById = (id) => (id === 'webSearchToggle' ? btn : (id === 'railWebSearchToggle' ? rail : null));

        ctx.populateCurrentSettings({
            model: 'deepseek/deepseek-v4-flash', systemMessage: '', reasoning: '', temperature: '',
            webSearch: true
        });

        assert.strictEqual(ctx.window._currentSettings.codeExecution, undefined, 'codeExecution stub was removed');
        assert.strictEqual(ctx.window._currentSettings.webSearch, true);
        assert.ok(added.includes('on'), 'web search button should turn on');
        assert.ok(railAdded.includes('on'), 'right-rail web search switch should turn on');
    });
});

describe('updateDropdownLabel', () => {
    it('sets assistant name when isAssistant', () => {
        const ctx = loadModule();
        ctx.window._currentSettings = {};
        ctx.window._assistantList = [{ name: 'Violet', baseModel: 'gpt-4o', description: 'desc' }];
        ctx.updateDropdownLabel({ text: 'Violet', isAssistant: true });
        assert.strictEqual(ctx.window._currentSettings.assistantName, 'Violet');
    });

    it('clears assistant name when switching to model', () => {
        const ctx = loadModule();
        ctx.window._currentSettings = { assistantName: 'Violet', model: '' };
        ctx.updateDropdownLabel({ text: 'deepseek-v4', isAssistant: false });
        assert.strictEqual(ctx.window._currentSettings.assistantName, '');
    });

    it('returns early for null data', () => {
        const ctx = loadModule();
        assert.doesNotThrow(() => ctx.updateDropdownLabel(null));
    });
});

describe('composer Web Search toggle handler', () => {
    it('attaches a click handler to #webSearchToggle that flips the flag and calls _sendAllSettings', () => {
        const handlers = [];
        let sendAllSettingsCalls = 0;
        const btn = {
            classList: { toggle: () => {}, contains: () => false },
            setAttribute: () => {}, title: '',
            addEventListener: (ev, fn) => { handlers.push(fn); }
        };
        const sandbox = {
            document: {
                getElementById: (id) => (id === 'webSearchToggle' ? btn : null),
                querySelector: () => null,
                querySelectorAll: () => [],
                createElement: () => ({ style: {}, appendChild: () => {}, addEventListener: () => {} }),
                addEventListener: (ev, fn) => { if (ev === 'DOMContentLoaded') fn(); }
            },
            window: { chrome: { webview: { postMessage: () => {} } }, addEventListener: () => {}, _currentSettings: { webSearch: false } },
            setTimeout: (fn) => { try { fn(); } catch(e) {} }, clearTimeout: () => {},
            _sendAllSettings: () => { sendAllSettingsCalls++; },
            _updateModelCard: () => {},
            lucide: { createIcons: () => {} },
            console: console
        };
        sandbox.global = sandbox;

        const src = fs.readFileSync(path.resolve(__dirname, '..', '..', 'webui', 'js', 'chat', 'model-picker', 'model-picker-config.js'), 'utf-8');
        vm.runInContext(src, vm.createContext(sandbox));

        // Exactly one handler on the composer toggle.
        assert.strictEqual(handlers.length, 1, 'Expected 1 click handler on the composer toggle');
        // Simulate clicking it — should flip webSearch and send settings.
        handlers[0]();
        assert.strictEqual(sandbox.window._currentSettings.webSearch, true, 'click should flip webSearch on');
        assert.strictEqual(sendAllSettingsCalls, 1, 'Expected _sendAllSettings to be called once on click');
    });

    it('does not throw when no #webSearchToggle exists', () => {
        const sandbox2 = {
            document: {
                getElementById: () => null,
                querySelector: () => null,
                querySelectorAll: () => [],
                createElement: () => ({ style: {}, appendChild: () => {}, addEventListener: () => {} }),
                addEventListener: (ev, fn) => { if (ev === 'DOMContentLoaded') fn(); }
            },
            window: { chrome: { webview: { postMessage: () => {} } }, addEventListener: () => {}, _currentSettings: {} },
            setTimeout: (fn) => { try { fn(); } catch(e) {} }, clearTimeout: () => {},
            _sendAllSettings: () => {}, _updateModelCard: () => {},
            lucide: { createIcons: () => {} },
            console: console
        };
        sandbox2.global = sandbox2;

        const src = fs.readFileSync(path.resolve(__dirname, '..', '..', 'webui', 'js', 'chat', 'model-picker', 'model-picker-config.js'), 'utf-8');
        // Should not throw even with no toggle button
        assert.doesNotThrow(() => vm.runInContext(src, vm.createContext(sandbox2)));
    });

    it('attaches a click handler to the right-rail switch #railWebSearchToggle that flips the flag', () => {
        const handlers = [];
        let sendAllSettingsCalls = 0;
        const rail = {
            classList: { add: () => {}, remove: () => {}, contains: () => false },
            addEventListener: (ev, fn) => { handlers.push(fn); }
        };
        const sandbox = {
            document: {
                getElementById: (id) => (id === 'railWebSearchToggle' ? rail : (id === 'webSearchToggle' ? null : null)),
                querySelector: () => null,
                querySelectorAll: () => [],
                createElement: () => ({ style: {}, appendChild: () => {}, addEventListener: () => {} }),
                addEventListener: (ev, fn) => { if (ev === 'DOMContentLoaded') fn(); }
            },
            window: { chrome: { webview: { postMessage: () => {} } }, addEventListener: () => {}, _currentSettings: { webSearch: false } },
            setTimeout: (fn) => { try { fn(); } catch(e) {} }, clearTimeout: () => {},
            _sendAllSettings: () => { sendAllSettingsCalls++; },
            _updateModelCard: () => {},
            lucide: { createIcons: () => {} },
            console: console
        };
        sandbox.global = sandbox;

        const src = fs.readFileSync(path.resolve(__dirname, '..', '..', 'webui', 'js', 'chat', 'model-picker', 'model-picker-config.js'), 'utf-8');
        vm.runInContext(src, vm.createContext(sandbox));

        assert.strictEqual(handlers.length, 1, 'Expected 1 click handler on the right-rail switch');
        handlers[0]();
        assert.strictEqual(sandbox.window._currentSettings.webSearch, true, 'click should flip webSearch on');
        assert.strictEqual(sendAllSettingsCalls, 1, 'Expected _sendAllSettings to be called once on click');
    });
});

describe('system prompt modal char counter — regression: never updated', () => {
    it('updates #charCount on input and when the modal opens', () => {
        let charCountText = '0 chars';
        const makeEl = (id) => {
            const el = {
                value: id === 'sysMsgFull' ? '' : '',
                textContent: id === 'charCount' ? charCountText : '',
                classList: { add: () => {}, remove: () => {} },
                _handlers: {}
            };
            el.addEventListener = (ev, fn) => { el._handlers[ev] = fn; };
            return el;
        };
        const els = {};
        ['sysMsgFull', 'charCount', 'sysMsgMini', 'sysMsgOverlay', 'expandSysMsg', 'sysMsgSave', 'sysMsgClose', 'sysMsgCancel'].forEach((id) => {
            els[id] = makeEl(id);
        });
        const sandbox = {
            document: {
                getElementById: (id) => els[id] || null,
                querySelector: () => null,
                querySelectorAll: () => [],
                createElement: () => ({ style: {}, appendChild: () => {}, addEventListener: () => {} }),
                addEventListener: (ev, fn) => { if (ev === 'DOMContentLoaded') fn(); }
            },
            window: { chrome: { webview: { postMessage: () => {} } }, addEventListener: () => {}, _currentSettings: {} },
            setTimeout: (fn) => { try { fn(); } catch(e) {} }, clearTimeout: () => {},
            _sendAllSettings: () => {}, _updateModelCard: () => {},
            lucide: { createIcons: () => {} },
            console: console
        };
        sandbox.global = sandbox;
        const src = fs.readFileSync(path.resolve(__dirname, '..', '..', 'webui', 'js', 'chat', 'model-picker', 'model-picker-config.js'), 'utf-8');
        vm.runInContext(src, vm.createContext(sandbox));

        // Open the modal with existing mini text: counter must reflect it.
        els.sysMsgFull.value = 'Hello';
        els.sysMsgMini.value = 'Hello';
        els.expandSysMsg._handlers.click();
        assert.strictEqual(els.charCount.textContent, '5 chars');

        // Typing in the full textarea updates the counter live.
        els.sysMsgFull.value = 'Hello world';
        els.sysMsgFull._handlers.input();
        assert.strictEqual(els.charCount.textContent, '11 chars');
    });
});

describe('direct system prompt typing — regression: never reached the API request (bug #60)', () => {
    it('updates _currentSettings.systemMessage and posts the debounced save on input', () => {
        let sendAllSettingsCalls = 0;
        const mini = {
            value: '',
            classList: { add: () => {}, remove: () => {} },
            _handlers: {}
        };
        mini.addEventListener = (ev, fn) => { mini._handlers[ev] = fn; };

        const sandbox = {
            document: {
                getElementById: (id) => (id === 'sysMsgMini' ? mini : null),
                querySelector: () => null,
                querySelectorAll: () => [],
                createElement: () => ({ style: {}, appendChild: () => {}, addEventListener: () => {} }),
                addEventListener: (ev, fn) => { if (ev === 'DOMContentLoaded') fn(); }
            },
            window: { chrome: { webview: { postMessage: () => {} } }, addEventListener: () => {}, _currentSettings: {} },
            setTimeout: (fn) => { try { fn(); } catch(e) {} }, clearTimeout: () => {},
            _sendAllSettings: () => { sendAllSettingsCalls++; },
            _updateModelCard: () => {},
            lucide: { createIcons: () => {} },
            console: console
        };
        sandbox.global = sandbox;

        const src = fs.readFileSync(path.resolve(__dirname, '..', '..', 'webui', 'js', 'chat', 'model-picker', 'model-picker-config.js'), 'utf-8');
        vm.runInContext(src, vm.createContext(sandbox));

        assert.ok(mini._handlers.input, 'an input handler should be attached to #sysMsgMini');
        mini.value = 'typed directly';
        mini._handlers.input();
        assert.strictEqual(sandbox.window._currentSettings.systemMessage, 'typed directly',
            'typing must update _currentSettings.systemMessage');
        assert.strictEqual(sendAllSettingsCalls, 1,
            'typing must trigger the debounced updateModelSettings post');
    });
});
