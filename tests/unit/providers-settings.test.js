// providers-settings.test.js — Unit tests for webui/js/settings/sections/providers.js
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

function makeEl(tag, overrides) {
    const el = Object.assign({
        tagName: tag,
        value: '',
        textContent: '',
        className: '',
        type: '',
        innerHTML: '',
        style: {},
        dataset: {},
        children: [],
        parentNode: null,
        classList: makeClassList(),
        _listeners: {},
        focused: 0,
        addEventListener(type, fn) { (this._listeners[type] = this._listeners[type] || []).push(fn); },
        fire(type, event) { (this._listeners[type] || []).forEach((fn) => fn.call(this, event || {})); },
        appendChild(child) { child.parentNode = this; this.children.push(child); return child; },
        insertBefore(node, ref) {
            node.parentNode = this;
            const i = ref ? this.children.indexOf(ref) : -1;
            if (i >= 0) this.children.splice(i, 0, node);
            else this.children.push(node);
            return node;
        },
        remove() {
            if (!this.parentNode) return;
            const i = this.parentNode.children.indexOf(this);
            if (i >= 0) this.parentNode.children.splice(i, 1);
            this.parentNode = null;
        },
        focus() { this.focused++; },
    }, overrides);
    Object.defineProperty(el, 'parentElement', {
        get() { return el.parentNode; },
    });
    return el;
}

function loadSection(opts) {
    const { withSettingsPanel, selectorMap, docSelectorMap, grid, addBtn, els } = opts || {};
    const elementMap = els || {};
    const domContentLoaded = [];
    const registered = [];
    const dirtyCalls = [];
    const timers = [];
    const loadHandlers = [];
    const panelStub = {
        registerSection: (name, mod) => { registered.push({ name, mod }); },
        markDirty: () => { dirtyCalls.push(true); },
    };
    const settingsPanel = opts && 'withSettingsPanel' in opts ? withSettingsPanel : panelStub;

    function makeQueriedEl(tag) {
        const el = makeEl(tag);
        el.querySelectorAll = (sel) => (selectorMap && selectorMap[sel]) || [];
        el.querySelector = (sel) => {
            const list = (selectorMap && selectorMap[sel]) || [];
            return list[0] || null;
        };
        return el;
    }

    const sandbox = {
        document: {
            getElementById: (id) => {
                if (id === 'providerGrid') return grid || null;
                if (id === 'addProviderBtn') return addBtn || null;
                return elementMap[id] || null;
            },
            querySelectorAll: (sel) => (docSelectorMap && docSelectorMap[sel]) || [],
            createElement: (tag) => makeQueriedEl(tag),
            addEventListener: (type, fn) => { if (type === 'DOMContentLoaded') domContentLoaded.push(fn); },
        },
        window: {
            SettingsPanel: settingsPanel,
            addEventListener: (type, fn) => { if (type === 'load') loadHandlers.push(fn); },
        },
        setTimeout: (fn) => { timers.push(fn); },
        console,
    };
    sandbox.global = sandbox;

    const sharedSrc = fs.readFileSync(path.resolve(__dirname, '..', '..', 'webui', 'js', 'shared', 'settings-shared.js'), 'utf-8');
    const src = fs.readFileSync(path.resolve(__dirname, '..', '..', 'webui', 'js', 'settings', 'sections', 'providers.js'), 'utf-8');
    const ctx = vm.createContext(sandbox);
    vm.runInContext(sharedSrc, ctx);
    vm.runInContext(src, ctx);

    return {
        sandbox,
        registered,
        dirtyCalls,
        timers,
        loadHandlers,
        module: registered[0] ? registered[0].mod : null,
        makeQueriedEl,
        fireDomReady: () => domContentLoaded.forEach((fn) => fn()),
    };
}

function wireQueries(el, selectorMap) {
    el.querySelectorAll = (sel) => (selectorMap && selectorMap[sel]) || [];
    el.querySelector = (sel) => ((selectorMap && selectorMap[sel]) || [])[0] || null;
    return el;
}

describe('Providers settings section', () => {
    it('load renders provider cards with sorted keys and palette cycling', () => {
        const grid = makeEl('div');
        grid.querySelectorAll = () => [];
        const selectorMap = { '.btn-sm.danger': [makeEl('button')] };
        const ctx = loadSection({ grid, selectorMap });
        ctx.module.load({
            providers: {
                zeta: { displayName: 'Open AI', endpoint: 'https://x', prefixes: ['openai-'], collapseThinking: true },
                alpha: { displayName: 'Anthropic Claude', endpoint: '', prefixes: [], collapseThinking: false },
                beta: { displayName: 'a&b"c<d>', prefixes: ['p1', 'p2'] },
                gamma: { displayName: 'X' },
                delta: {},
            },
        });
        assert.ok(grid.children.length === 5);
        // Keys sorted alphabetically: alpha, beta, delta, gamma, zeta
        assert.ok(grid.children.map((c) => c.dataset.providerKey).join(',') === 'alpha,beta,delta,gamma,zeta');
        assert.ok(grid.children[0].innerHTML.indexOf('AC') >= 0, 'initials from display name');
        assert.ok(grid.children[1].innerHTML.indexOf('a&amp;b&quot;c&lt;d&gt;') >= 0, 'escHtml applied');
        assert.ok(grid.children[4].innerHTML.indexOf('OA') >= 0, 'initials from second word');
    });

    it('renders the built-in Codex card as a local ChatGPT backend with a non-inference health check', () => {
        const grid = makeEl('div');
        grid.querySelectorAll = () => [];
        const ctx = loadSection({ grid, selectorMap: {} });
        ctx.module.load({ providers: { codex: { displayName: 'Codex CLI (ChatGPT subscription)', transport: 'codex-cli' } } });
        const html = grid.children[0].innerHTML;
        assert.ok(html.includes('Check Codex'));
        assert.ok(html.includes('codex --version'));
        assert.ok(html.includes('codex login status'));
        assert.ok(html.includes('does not invoke a model or consume a Codex turn'));
        assert.ok(!html.includes('data-field="apiKey"'), 'Codex provider must not expose/store an OpenAI API key field');
    });

    it('applies Codex status responses to the provider card', () => {
        const providerId = makeEl('input', { value: 'codex' });
        const transport = makeEl('input', { value: 'codex-cli' });
        const statusEl = makeEl('span');
        const checkBtn = makeEl('button', { disabled: true });
        const card = makeEl('div');
        wireQueries(card, {
            '[data-field="providerId"]': [providerId],
            '[data-field="transport"]': [transport],
            '.codex-status': [statusEl],
            '.check-codex': [checkBtn]
        });
        const ctx = loadSection({ docSelectorMap: { '#providerGrid .provider-card': [card] } });
        ctx.sandbox.window.SettingsProviders.handleCodexStatus({
            installed: true, supported: true, authenticated: true,
            message: 'Ready: Codex CLI v0.153.4 is signed in with ChatGPT.', error: ''
        });
        assert.strictEqual(checkBtn.disabled, false);
        assert.ok(statusEl.textContent.includes('signed in with ChatGPT'));
    });

    it('load handles missing grid and missing providers', () => {
        const ctx = loadSection({ grid: null });
        ctx.module.load({ providers: { a: {} } });
        ctx.module.load(null);
        assert.ok(true);
    });

    it('wireProviderCard wires prefix remove, switch, input, remove and key toggle', () => {
        const grid = makeEl('div');
        const rm1 = makeEl('span');
        const rmParent = makeEl('span');
        rm1.parentNode = rmParent;
        const sw = makeEl('div', { classList: makeClassList(['switch']) });
        const inp = makeEl('input');
        const removeBtn = makeEl('button');
        const toggleBtn = makeEl('button');
        const keyInput = makeEl('input', { type: 'password' });
        const prefixDiv = makeEl('div');
        const cardA = makeEl('div');
        const cardB = makeEl('div');
        const selectorMap = {
            '.prefix-tags .badge .remove': [rm1],
            '.switch': [sw],
            'input': [inp, keyInput],
            '.btn-sm.danger': [removeBtn],
            '.toggle-api-key': [toggleBtn],
            '.prefix-tags': [prefixDiv],
            '[data-field="apiKey"]': [keyInput],
            '.provider-card': [cardA, cardB],
        };
        wireQueries(grid, selectorMap);
        const ctx = loadSection({ grid, selectorMap });
        ctx.module.load({ providers: { prov: { displayName: 'P', collapseThinking: false, prefixes: ['x'] } } });
        const card = grid.children[0];

        rm1.fire('click');
        assert.ok(rmParent.children.length === 0 || rmParent.parentNode === null, 'badge removed');
        assert.ok(ctx.dirtyCalls.length >= 1);

        sw.fire('click');
        assert.ok(sw.classList.contains('on'));

        inp.fire('input');
        assert.ok(ctx.dirtyCalls.length >= 2);

        removeBtn.fire('click'); // grid has 2 cards -> removes
        assert.ok(card.parentNode === null, 'card removed');
        assert.ok(ctx.dirtyCalls.length >= 3);

        toggleBtn.fire('click');
        assert.ok(keyInput.type === 'text');
        toggleBtn.fire('click');
        assert.ok(keyInput.type === 'password');
    });

    it('remove button keeps at least one provider card', () => {
        const grid = makeEl('div');
        const removeBtn = makeEl('button');
        const onlyCard = makeEl('div');
        const selectorMap = {
            '.prefix-tags .badge .remove': [],
            '.switch': [],
            'input': [],
            '.btn-sm.danger': [removeBtn],
            '.toggle-api-key': [],
            '.prefix-tags': [],
            '.provider-card': [onlyCard],
        };
        wireQueries(grid, selectorMap);
        const ctx = loadSection({ grid, selectorMap });
        ctx.module.load({ providers: { solo: { displayName: 'S' } } });
        removeBtn.fire('click');
        assert.ok(grid.children.length === 1, 'only provider kept');
        assert.ok(ctx.dirtyCalls.length === 0);
    });

    it('prefix add link appends a tag and saves it on blur', () => {
        const grid = makeEl('div');
        const prefixDiv = makeEl('div');
        const removeSpan = makeEl('span');
        const selectorMap = {
            '.prefix-tags .badge .remove': [],
            '.switch': [],
            'input': [],
            '.btn-sm.danger': [makeEl('button')],
            '.toggle-api-key': [],
            '.prefix-tags': [prefixDiv],
            '.remove': [removeSpan],
        };
        const ctx = loadSection({ grid, selectorMap });
        ctx.module.load({ providers: { p: { displayName: 'P', prefixes: [] } } });
        const addLink = prefixDiv.children[prefixDiv.children.length - 1];
        assert.ok(addLink.textContent === '+ add');
        addLink.fire('click');

        const tag = prefixDiv.children[0];
        const tagInput = tag.children[0];
        assert.ok(tagInput.focused === 1, 'new prefix input focused');
        tagInput.value = 'newprefix';
        tagInput.fire('blur');
        assert.ok(tag.innerHTML.indexOf('newprefix') >= 0);
        assert.ok(ctx.dirtyCalls.length >= 1);

        removeSpan.fire('click');
        assert.ok(tag.parentNode === null, 'prefix badge removed after blur');
        assert.ok(ctx.dirtyCalls.length >= 2);
    });

    it('prefix add link handles empty input with question mark', () => {
        const grid = makeEl('div');
        const prefixDiv = makeEl('div');
        const removeSpan = makeEl('span');
        const selectorMap = {
            '.prefix-tags .badge .remove': [],
            '.switch': [],
            'input': [],
            '.btn-sm.danger': [makeEl('button')],
            '.toggle-api-key': [],
            '.prefix-tags': [prefixDiv],
            '.remove': [removeSpan],
        };
        const ctx = loadSection({ grid, selectorMap });
        ctx.module.load({ providers: { p: { displayName: 'P', prefixes: [] } } });
        const addLink = prefixDiv.children[prefixDiv.children.length - 1];
        addLink.fire('click');
        const tag = prefixDiv.children[0];
        tag.children[0].fire('blur');
        assert.ok(tag.innerHTML.indexOf('?') >= 0);
    });

    it('save collects provider data with direct/env auth mode and prefixes', () => {
        const grid = makeEl('div');
        const providerId = makeEl('input', { value: 'prov-a' });
        providerId.dataset.field = 'providerId';
        const displayName = makeEl('input', { value: 'My Prov' });
        displayName.dataset.field = 'displayName';
        const apiKey = makeEl('input', { value: 'sk-secret' });
        apiKey.dataset.field = 'apiKey';
        const authEnvVar = makeEl('input', { value: '' });
        authEnvVar.dataset.field = 'authEnvVar';
        const endpoint = makeEl('input', { value: 'https://ep' });
        endpoint.dataset.field = 'endpoint';
        const switchOn = makeEl('div', { classList: makeClassList(['switch', 'on']) });
        switchOn.dataset.field = 'collapseThinking';
        const tagA = makeEl('span', { textContent: 'openai- ×' });
        const tagB = makeEl('span', { textContent: '×' });
        const cardA = makeEl('div');
        cardA.dataset.providerKey = 'provA';
        const cardB = makeEl('div');
        cardB.dataset.providerKey = '';
        const selectorMap = {
            '.prefix-tags .badge .remove': [],
            '.switch': [],
            'input': [],
            '.btn-sm.danger': [makeEl('button')],
            '.toggle-api-key': [],
            '.prefix-tags': [],
            '[data-field]': [providerId, displayName, apiKey, authEnvVar, endpoint, switchOn],
            '[data-field="providerId"]': [providerId],
            '.prefix-tags .badge': [tagA, tagB],
            '.provider-card': [cardA, cardB],
        };
        const docSelectorMap = { '#providerGrid .provider-card': [cardA, cardB] };
        const ctx = loadSection({ grid, selectorMap, docSelectorMap });
        for (const card of [cardA, cardB]) wireQueries(card, selectorMap);
        ctx.module.load({ providers: { provA: {}, provB: {} } });
        const data = JSON.parse(JSON.stringify(ctx.module.save()));
        assert.ok(data.providers['prov-a'].displayName === 'My Prov');
        assert.ok(data.providers['prov-a'].authMode === 'direct');
        assert.ok(data.providers['prov-a'].collapseThinking === true);
        assert.ok(data.providers['prov-a'].prefixes.length === 1 && data.providers['prov-a'].prefixes[0] === 'openai-');
        assert.ok(!data.providers['new-provider'], 'blank provider IDs must not create synthetic fallback keys');
    });

    it('save uses env auth mode when only an env var is configured', () => {
        const grid = makeEl('div');
        const authEnvVar = makeEl('input', { value: 'MY_API_KEY' });
        authEnvVar.dataset.field = 'authEnvVar';
        const apiKey = makeEl('input', { value: '' });
        apiKey.dataset.field = 'apiKey';
        const card = makeEl('div');
        card.dataset.providerKey = 'prov';
        const selectorMap = {
            '.prefix-tags .badge .remove': [],
            '.switch': [],
            'input': [],
            '.btn-sm.danger': [makeEl('button')],
            '.toggle-api-key': [],
            '.prefix-tags': [],
            '[data-field]': [authEnvVar, apiKey],
            '.prefix-tags .badge': [],
            '.provider-card': [card],
        };
        wireQueries(card, selectorMap);
        const ctx = loadSection({ grid, selectorMap, docSelectorMap: { '#providerGrid .provider-card': [card] } });
        ctx.module.load({ providers: { prov: {} } });
        const data = JSON.parse(JSON.stringify(ctx.module.save()));
        assert.ok(data.providers.prov.authMode === 'env');
    });

    it('addProvider appends a new card and marks dirty', () => {
        const grid = makeEl('div');
        const addBtn = makeEl('button');
        const selectorMap = {
            '.prefix-tags .badge .remove': [],
            '.switch': [],
            'input': [],
            '.btn-sm.danger': [makeEl('button')],
            '.toggle-api-key': [],
            '.prefix-tags': [],
            '.provider-card': [grid.children[0] || makeEl('div')],
        };
        const ctx = loadSection({ grid, addBtn, selectorMap });
        ctx.fireDomReady();
        addBtn.fire('click');
        assert.ok(grid.children.length === 1);
        assert.strictEqual(grid.children[0].dataset.providerKey, '', 'new providers must not receive timestamp IDs');
        assert.strictEqual(grid.children[0].dataset.isNew, 'true');
        assert.ok(ctx.dirtyCalls.length >= 1);
    });

    it('addProvider handles missing grid and missing add button', () => {
        const ctx = loadSection({ grid: null, addBtn: null });
        ctx.fireDomReady();
        assert.ok(true);
    });

    it('slugifies display names into stable provider IDs', () => {
        const ctx = loadSection({});
        assert.strictEqual(ctx.sandbox.window.SettingsProviders.slugifyProviderId(' Xiaomi MiMo / API '), 'xiaomi-mimo-api');
    });

    it('validates provider IDs, display names, and chat endpoints', () => {
        const providerId = makeEl('input', { value: 'xiaomi' });
        const displayName = makeEl('input', { value: 'Xiaomi' });
        const endpoint = makeEl('input', { value: 'https://api.example.com/v1/chat/completions' });
        const card = makeEl('div');
        wireQueries(card, {
            '[data-field="providerId"]': [providerId],
            '[data-field="displayName"]': [displayName],
            '[data-field="endpoint"]': [endpoint],
        });
        const ctx = loadSection({ docSelectorMap: { '#providerGrid .provider-card': [card] } });
        assert.strictEqual(ctx.module.validate().valid, true);
        providerId.value = 'Xiaomi Bad';
        assert.strictEqual(ctx.module.validate().valid, false);
    });

    it('validates the optional models.dev provider override key', () => {
        const providerId = makeEl('input', { value: 'work-mimo' });
        const displayName = makeEl('input', { value: 'Work MiMo' });
        const endpoint = makeEl('input', { value: 'https://api.example.com/v1/chat/completions' });
        const catalog = makeEl('input', { value: 'xiaomi' });
        const card = makeEl('div');
        wireQueries(card, {
            '[data-field="providerId"]': [providerId],
            '[data-field="displayName"]': [displayName],
            '[data-field="endpoint"]': [endpoint],
            '[data-field="modelsDevProvider"]': [catalog],
        });
        const ctx = loadSection({ docSelectorMap: { '#providerGrid .provider-card': [card] } });
        assert.strictEqual(ctx.module.validate().valid, true);
        catalog.value = 'bad catalog';
        assert.strictEqual(ctx.module.validate().valid, false);
    });

    it('allows legacy timestamp provider IDs to be renamed', () => {
        const grid = makeEl('div');
        grid.querySelectorAll = () => [];
        const selectorMap = {
            '.prefix-tags .badge .remove': [],
            '.switch': [],
            'input': [],
            '.btn-sm.danger': [makeEl('button')],
            '.toggle-api-key': [],
            '.prefix-tags': [],
        };
        const ctx = loadSection({ grid, selectorMap });
        ctx.module.load({ providers: { 'provider-12345': { displayName: 'Xiaomi' } } });
        assert.strictEqual(grid.children[0].dataset.isNew, 'true');
        assert.ok(grid.children[0].innerHTML.includes('Legacy generated ID'));
    });

    it('registers with the settings panel when available', () => {
        const ctx = loadSection({});
        assert.ok(ctx.registered.length === 1);
        assert.ok(ctx.registered[0].name === 'providers');
        assert.ok(typeof ctx.registered[0].mod.load === 'function');
        assert.ok(typeof ctx.registered[0].mod.save === 'function');
    });

    it('defers registration until SettingsPanel appears', () => {
        const ctx = loadSection({ withSettingsPanel: undefined });
        assert.ok(ctx.registered.length === 0);
        assert.ok(ctx.timers.length >= 1);
        ctx.sandbox.window.SettingsPanel = {
            registerSection: (name, mod) => ctx.registered.push({ name, mod }),
            markDirty: () => {},
        };
        ctx.timers.forEach((fn) => fn());
        assert.ok(ctx.registered.length === 1);
        assert.ok(ctx.registered[0].name === 'providers');
    });
});
