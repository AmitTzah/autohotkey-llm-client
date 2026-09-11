// general-settings.test.js — Unit tests for webui/js/settings/sections/general.js
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function makeClassList(initial) {
    const classes = initial ? initial.slice() : [];
    return {
        add(c) { if (!classes.includes(c)) classes.push(c); },
        remove(c) { const i = classes.indexOf(c); if (i >= 0) classes.splice(i, 1); },
        contains(c) { return classes.includes(c); },
        toggle(c) { if (this.contains(c)) this.remove(c); else this.add(c); },
    };
}

function makeEl(overrides) {
    return Object.assign({
        value: '',
        innerHTML: '',
        children: [],
        classList: makeClassList(),
        style: {},
        _listeners: {},
        addEventListener(type, fn) { (this._listeners[type] = this._listeners[type] || []).push(fn); },
        fire(type) { (this._listeners[type] || []).forEach((fn) => fn.call(this)); },
        appendChild(child) { this.children.push(child); return child; },
    }, overrides);
}

function loadSection(opts) {
    const { els, withSettingsPanel } = opts || {};
    const elementMap = els || {};
    const domContentLoaded = [];
    const timers = [];
    const registered = [];
    const dirtyCalls = [];
    const ipcCalls = [];

    const panelStub = {
        registerSection: (name, mod) => { registered.push({ name, mod }); },
        markDirty: () => { dirtyCalls.push(true); },
    };
    const settingsPanel = opts && 'withSettingsPanel' in opts ? withSettingsPanel : panelStub;

    const sandbox = {
        document: {
            getElementById: (id) => elementMap[id] || null,
            createElement: () => makeEl(),
            addEventListener: (type, fn) => { if (type === 'DOMContentLoaded') domContentLoaded.push(fn); },
        },
        window: {
            SettingsPanel: settingsPanel,
        },
        Ipc: {
            postToHost: (action, payload) => { ipcCalls.push({ method: 'postToHost', action, payload }); },
            request: (action, payload) => { ipcCalls.push({ method: 'request', action, payload }); return Promise.resolve({ ok: true }); },
        },
        setTimeout: (fn) => { timers.push(fn); },
        console,
    };
    sandbox.global = sandbox;

    const sharedSrc = fs.readFileSync(path.resolve(__dirname, '..', '..', 'webui', 'js', 'shared', 'settings-shared.js'), 'utf-8');
    const src = fs.readFileSync(path.resolve(__dirname, '..', '..', 'webui', 'js', 'settings', 'sections', 'general.js'), 'utf-8');
    const ctx = vm.createContext(sandbox);
    vm.runInContext(sharedSrc, ctx);
    vm.runInContext(src, ctx);

    const registeredModule = settingsPanel ? registered[0] && registered[0].mod : null;
    return {
        sandbox,
        panelStub,
        registered,
        dirtyCalls,
        ipcCalls,
        domContentLoaded,
        timers,
        module: registeredModule || (registered[0] && registered[0].mod),
        fireDomReady: () => domContentLoaded.forEach((fn) => fn()),
    };
}

describe('General settings section', () => {
    it('load populates thread title, api log and trash fields', () => {
        const toggle = makeEl({ classList: makeClassList() });
        const fields = makeEl({ classList: makeClassList(['fields-disabled']) });
        const modelSel = makeEl({ innerHTML: '' });
        const prompt = makeEl({ value: 'Summarize' });
        const maxTok = makeEl({ value: '123' });
        const logEntries = makeEl({ value: '5' });
        const trashDays = makeEl({ value: '7' });

        const optionEls = [];
        const els = {
            titleGenToggle: toggle,
            titleGenFields: fields,
            titleGenModel: modelSel,
            titleGenPrompt: prompt,
            titleGenMaxTokens: maxTok,
            apiLogMaxEntries: logEntries,
            trashRetentionDays: trashDays,

        };
        const ctx = loadSection({ els });
        ctx.fireDomReady();

        // document.createElement('option') is used by fillSelect — patch it
        // after load so the loaded module sees option elements.
        ctx.sandbox.document.createElement = () => {
            const opt = makeEl();
            opt.value = '';
            opt.textContent = '';
            optionEls.push(opt);
            return opt;
        };

        ctx.module.load({
            threadTitles: { enabled: true, model: 'new-model', prompt: 'Tl;dr', maxTokens: 75 },
            models: { 'gpt-5': {}, 'anthropic/claude-new': {}, 'deepseek/deepseek-v4-flash': {} },
            apiLogs: { maxEntries: 40 },
            trash: { retentionDays: 14 },

        });

        assert.ok(toggle.classList.contains('on'));
        assert.ok(!fields.classList.contains('fields-disabled'));
        assert.ok(modelSel.innerHTML === '');
        assert.ok(prompt.value === 'Tl;dr');
        assert.ok(String(maxTok.value) === '75');
        assert.ok(String(logEntries.value) === '40');
        assert.ok(String(trashDays.value) === '14');

        // fillSelect unshifted the unknown current model and set the value.
        assert.ok(modelSel.value === 'new-model');
        assert.ok(optionEls.length === 4, 'four model options created');
        assert.ok(optionEls[0].value === 'new-model');
    });

    it('load handles disabled thread titles', () => {
        const toggle = makeEl({ classList: makeClassList(['on']) });
        const fields = makeEl({ classList: makeClassList() });
        const ctx = loadSection({ els: { titleGenToggle: toggle, titleGenFields: fields } });
        ctx.module.load({ threadTitles: { enabled: false, model: '', prompt: '', maxTokens: 50 } });
        assert.ok(!toggle.classList.contains('on'));
        assert.ok(fields.classList.contains('fields-disabled'));
    });

    it('load fills the new-chat default dropdown (app default, assistants, models)', () => {
        const ncs = makeEl();
        const created = [];
        const ctx = loadSection({ els: { newChatStartsWith: ncs } });
        ctx.sandbox.document.createElement = (tag) => {
            const el = makeEl();
            el.tagName = tag;
            created.push(el);
            return el;
        };

        ctx.module.load({
            models: { 'b-model': {}, 'a-model': {} },
            assistants: [{ id: 'asst-1', name: 'My Assistant', baseModel: 'a-model' }],
            newChatStartsWith: 'asst:asst-1',
        });
        assert.strictEqual(ncs.value, 'asst:asst-1');
        const opts = created.filter((el) => el.tagName === 'option');
        assert.strictEqual(opts.length, 4, 'expected app default + 1 assistant + 2 model options, got ' + opts.length);
        assert.strictEqual(opts[0].value, '');
        assert.ok(opts[0].textContent.indexOf('App Default') >= 0);
        assert.ok(opts.some((o) => o.value === 'asst:asst-1' && o.textContent === 'My Assistant'));
        assert.ok(opts.some((o) => o.value === 'a-model'));
        const groups = created.filter((el) => el.tagName === 'optgroup');
        assert.strictEqual(groups.length, 2);
        assert.ok(groups.some((g) => g.label === 'Assistants'));
        assert.ok(groups.some((g) => g.label === 'Models'));
    });

    it('keeps App Default tied to the app model even when legacy isDefault metadata exists', () => {
        const ncs = makeEl();
        const created = [];
        const ctx = loadSection({ els: { newChatStartsWith: ncs } });
        ctx.sandbox.document.createElement = (tag) => {
            const el = makeEl();
            el.tagName = tag;
            created.push(el);
            return el;
        };
        ctx.module.load({
            models: { 'a-model': {} },
            assistants: [{ id: 'asst-1', name: 'My Assistant', baseModel: 'a-model', isDefault: true }],
            newChatStartsWith: '',
        });
        const opts = created.filter((el) => el.tagName === 'option');
        assert.strictEqual(opts[0].value, '');
        assert.ok(opts[0].textContent.indexOf('App Default (deepseek/deepseek-v4-flash)') >= 0,
            'App Default must not have a hidden assistant fallback, got ' + opts[0].textContent);
    });

    it('load tolerates missing data and missing elements', () => {
        const ctx = loadSection({});
        ctx.module.load(null);
        ctx.module.load({});
        ctx.module.load({ threadTitles: { enabled: true }, apiLogs: {}, trash: {} });
        assert.ok(true);
    });

    it('save collects values with defaults and fallbacks', () => {
        const toggle = makeEl({ classList: makeClassList(['on']) });
        const ctx = loadSection({
            els: {
                titleGenToggle: toggle,
                titleGenModel: makeEl({ value: 'gpt-5' }),
                titleGenPrompt: makeEl({ value: 'Sum' }),
                titleGenMaxTokens: makeEl({ value: '99' }),
                apiLogMaxEntries: makeEl({ value: '12' }),
                trashRetentionDays: makeEl({ value: '3' }),

                newChatStartsWith: makeEl({ value: 'asst:asst-1' }),
            tavilyApiKey: makeEl({ value: 'tvly-test' }),
                backupEnabledToggle: makeEl({ classList: makeClassList(['on']) }),
                backupFolder: makeEl({ value: 'C:\\Backups' }),
            },
        });
        const data = ctx.module.save();
        assert.strictEqual(JSON.stringify(data), JSON.stringify({
            threadTitles: { enabled: true, model: 'gpt-5', prompt: 'Sum', maxTokens: 99 },
            generationNotifications: { mode: 'attention', sound: 'system', customPath: '' },
            apiLogs: { maxEntries: 12 },
            trash: { retentionDays: 3 },

            tavilyApiKey: 'tvly-test',
            newChatStartsWith: 'asst:asst-1',
            backup: { enabled: true, folder: 'C:\\Backups' },
        }));
    });

    it('loads and saves generation notification settings', () => {
        const mode = makeEl({ value: '' });
        const type = makeEl({ value: '' });
        const soundPath = makeEl({ value: '', disabled: false });
        const browse = makeEl({ disabled: false });
        const ctx = loadSection({ els: {
            completionSoundMode: mode,
            completionSoundType: type,
            completionSoundPath: soundPath,
            completionSoundBrowseBtn: browse,
        } });

        ctx.module.load({ generationNotifications: {
            mode: 'always', sound: 'custom', customPath: 'C:\\sounds\\done.wav',
        } });
        assert.strictEqual(mode.value, 'always');
        assert.strictEqual(type.value, 'custom');
        assert.strictEqual(soundPath.value, 'C:\\sounds\\done.wav');
        assert.strictEqual(soundPath.disabled, false);
        assert.strictEqual(browse.disabled, false);
        assert.deepStrictEqual(JSON.parse(JSON.stringify(ctx.module.save().generationNotifications)), {
            mode: 'always', sound: 'custom', customPath: 'C:\\sounds\\done.wav',
        });
    });

    it('requires a custom WAV path only when custom completion sound is active', () => {
        const mode = makeEl({ value: 'attention' });
        const type = makeEl({ value: 'custom' });
        const soundPath = makeEl({ value: '   ' });
        const ctx = loadSection({ els: {
            completionSoundMode: mode,
            completionSoundType: type,
            completionSoundPath: soundPath,
        } });
        assert.strictEqual(ctx.module.validate().valid, false);

        mode.value = 'never';
        assert.strictEqual(ctx.module.validate().valid, true, 'disabled completion sounds may keep an empty custom path');
    });

    it('completion sound Browse posts the current path to native IPC', () => {
        const browse = makeEl();
        const type = makeEl({ value: 'custom' });
        const soundPath = makeEl({ value: ' C:\\sounds\\done.wav ' });
        const ctx = loadSection({ els: {
            completionSoundType: type,
            completionSoundPath: soundPath,
            completionSoundBrowseBtn: browse,
        } });
        ctx.fireDomReady();
        browse.fire('click');
        const call = ctx.ipcCalls.find((c) => c.action === 'browseCompletionSound');
        assert.ok(call);
        assert.strictEqual(call.payload.path, 'C:\\sounds\\done.wav');
    });

    it('loads and saves backup settings, including the disabled defaults', () => {
        const toggle = makeEl({ classList: makeClassList() });
        const folder = makeEl();
        const status = makeEl();
        const ctx = loadSection({ els: { backupEnabledToggle: toggle, backupFolder: folder, backupStatus: status } });
        ctx.module.load({ backup: { enabled: true, folder: 'D:\\Synced\\AHKLLM' }, backupStatus: { text: 'Last backup: Aug 25, 2026 17:40' } });
        assert.ok(toggle.classList.contains('on'));
        assert.strictEqual(folder.value, 'D:\\Synced\\AHKLLM');
        assert.strictEqual(status.textContent, 'Last backup: Aug 25, 2026 17:40');
        const saved = ctx.module.save();
        assert.strictEqual(JSON.stringify(saved.backup), JSON.stringify({ enabled: true, folder: 'D:\\Synced\\AHKLLM' }));

        const empty = loadSection({}).module.save();
        assert.strictEqual(JSON.stringify(empty.backup), JSON.stringify({ enabled: false, folder: '' }));
    });

    it('save falls back to defaults when elements are missing or values are invalid', () => {
        const ctx = loadSection({
            els: {
                titleGenMaxTokens: makeEl({ value: 'abc' }),
                apiLogMaxEntries: makeEl({ value: '' }),
                trashRetentionDays: makeEl({ value: 'x' }),
            },
        });
        const data = ctx.module.save();
        assert.ok(data.threadTitles.enabled === true, 'toggle missing -> enabled default true');
        assert.ok(data.threadTitles.model === 'deepseek/deepseek-v4-flash');
        assert.ok(data.threadTitles.prompt === '');
        assert.ok(data.threadTitles.maxTokens === 50);
        assert.deepStrictEqual(JSON.parse(JSON.stringify(data.generationNotifications)), { mode: 'attention', sound: 'system', customPath: '' });
        assert.ok(data.apiLogs.maxEntries === 20);
        assert.ok(data.trash.retentionDays === 30);

        assert.ok(data.tavilyApiKey === '');
        assert.ok(data.newChatStartsWith === '');
    });

    it('wireToggle toggles fields and marks dirty on click', () => {
        const toggle = makeEl({ classList: makeClassList() });
        const fields = makeEl({ classList: makeClassList(['fields-disabled']) });
        const ctx = loadSection({ els: { titleGenToggle: toggle, titleGenFields: fields } });
        ctx.fireDomReady();

        toggle.fire('click');
        assert.ok(toggle.classList.contains('on'));
        assert.ok(!fields.classList.contains('fields-disabled'));
        assert.ok(ctx.dirtyCalls.length >= 1);

        toggle.fire('click');
        assert.ok(!toggle.classList.contains('on'));
        assert.ok(fields.classList.contains('fields-disabled'));
    });

    it('wireToggle and wireDirty handle missing elements', () => {
        const container = makeEl();
        const ctx = loadSection({ els: { secGeneral: container } });
        ctx.fireDomReady(); // no toggle/fields, no inputs — must not throw
        assert.ok(true);
    });

    it('trims the backup destination before saving', () => {
        const ctx = loadSection({ els: {
            backupEnabledToggle: makeEl({ classList: makeClassList(['on']) }),
            backupFolder: makeEl({ value: '  C:\\\\Backups  ' }),
        } });
        assert.strictEqual(ctx.module.save().backup.folder, 'C:\\\\Backups');
    });

    it('rejects an enabled automatic backup with no destination folder', () => {
        const toggle = makeEl({ classList: makeClassList(['on']) });
        const folder = makeEl({ value: '   ' });
        const ctx = loadSection({ els: { backupEnabledToggle: toggle, backupFolder: folder } });
        const result = ctx.module.validate();
        assert.strictEqual(result.valid, false);
        assert.ok(result.message.includes('backup destination folder'));

        toggle.classList.remove('on');
        assert.strictEqual(ctx.module.validate().valid, true, 'disabled automatic backups may have no folder');
    });

    it('empty destination cannot look enabled or send Back Up Now', async () => {
        const now = makeEl();
        const folder = makeEl({ value: '' });
        const toggle = makeEl({ classList: makeClassList() });
        const status = makeEl({ textContent: '' });
        const ctx = loadSection({ els: {
            backupNowBtn: now,
            backupFolder: folder,
            backupEnabledToggle: toggle,
            backupStatus: status,
        } });
        ctx.fireDomReady();

        toggle.fire('click');
        assert.ok(!toggle.classList.contains('on'), 'automatic backup must stay off until a folder is configured');
        assert.strictEqual(status.textContent, 'Choose a backup destination folder first');

        now.fire('click');
        await new Promise((resolve) => setImmediate(resolve));
        assert.ok(!ctx.ipcCalls.some((call) => call.action === 'backupNow'), 'empty destination must not reach native backup IPC');
        assert.strictEqual(status.textContent, 'Choose a backup destination folder first');
    });

    it('Back Up Now sends the currently displayed folder to the native request', async () => {
        const now = makeEl();
        const folder = makeEl({ value: 'D:\\Displayed\\Backup' });
        const toggle = makeEl({ classList: makeClassList(['on']) });
        const ctx = loadSection({ els: {
            backupNowBtn: now,
            backupFolder: folder,
            backupEnabledToggle: toggle,
        } });
        ctx.fireDomReady();

        now.fire('click');
        await new Promise((resolve) => setImmediate(resolve));
        const request = ctx.ipcCalls.find((call) => call.method === 'request' && call.action === 'backupNow');
        assert.ok(request, 'manual backup must reach IPC');
        assert.strictEqual(request.payload.backup.enabled, true);
        assert.strictEqual(request.payload.backup.folder, 'D:\\Displayed\\Backup');
    });

    it('Back Up Now shows a start state instead of pretending the backup is only queued', async () => {
        const now = makeEl();
        const status = makeEl({ textContent: '' });
        const ctx = loadSection({ els: {
            backupNowBtn: now,
            backupFolder: makeEl({ value: 'D:\\Displayed\\Backup' }),
            backupEnabledToggle: makeEl({ classList: makeClassList(['on']) }),
            backupStatus: status,
        } });
        ctx.fireDomReady();

        now.fire('click');
        assert.strictEqual(status.textContent, 'Starting backup...');
        await new Promise((resolve) => setImmediate(resolve));
    });

    it('wireDirty marks dirty on change and input for every field', () => {
        const input = makeEl();
        const select = makeEl();
        const textarea = makeEl();
        const container = makeEl();
        container.querySelectorAll = (sel) => (sel === 'input, select, textarea' ? [input, select, textarea] : []);
        const ctx = loadSection({ els: { 'sec-general': container } });
        ctx.fireDomReady();

        input.fire('change');
        select.fire('input');
        textarea.fire('change');
        assert.ok(ctx.dirtyCalls.length >= 3);
    });

    it('registers with the settings panel when available', () => {
        const ctx = loadSection({});
        assert.ok(ctx.registered.length === 1);
        assert.ok(ctx.registered[0].name === 'general');
        assert.ok(typeof ctx.registered[0].mod.load === 'function');
        assert.ok(typeof ctx.registered[0].mod.save === 'function');
        assert.ok(typeof ctx.registered[0].mod.validate === 'function');
    });

    it('defers registration until SettingsPanel appears', () => {
        const ctx = loadSection({ withSettingsPanel: undefined });
        assert.ok(ctx.registered.length === 0);
        assert.ok(ctx.timers.length >= 1, 'registration retry scheduled');
        ctx.sandbox.window.SettingsPanel = ctx.panelStub;
        ctx.timers.forEach((fn) => fn());
        assert.ok(ctx.registered.length === 1);
        assert.ok(ctx.registered[0].name === 'general');
    });
});
