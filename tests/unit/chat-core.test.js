// chat-core.test.js — Unit tests for chat-core.js: renderMarkdown, initChatMode, _makeInlineEditor, escHtml
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { installIpc } = require('./helpers/ipc-test-utils');

function loadModule() {
    const src = fs.readFileSync(path.resolve(__dirname, '..', '..', 'webui', 'js', 'chat', 'chat-core.js'), 'utf-8');
    const elementCache = {};
    let postedMessages = [];
    function makeEl(tag) {
        const el = {
            tagName: tag, className: '', innerHTML: '', id: '', textContent: '', value: '',
            style: { display: '' }, dataset: {}, children: [],
            classList: {
                _classes: [],
                add: function(c) { if (this._classes.indexOf(c) < 0) this._classes.push(c); },
                remove: function(c) { this._classes = this._classes.filter(function(x) { return x !== c; }); },
                contains: function(c) { return this._classes.indexOf(c) >= 0; }
            },
            appendChild: function(child) { el.children.push(child); return child; },
            addEventListener: function(evt, fn) { (this._listeners = this._listeners || {})[evt] = fn; },
            removeEventListener: function() {},
            querySelector: function(sel) {
                if (!el._queryMap) el._queryMap = {};
                if (!el._queryMap[sel]) el._queryMap[sel] = makeEl('div');
                return el._queryMap[sel];
            },
            querySelectorAll: function(sel) {
                if (el._queryAll && el._queryAll[sel]) return el._queryAll[sel];
                return [];
            },
            remove: function() {},
            closest: function() { return null; },
            getAttribute: function() { return null; },
            setAttribute: function(k, v) { this['_attr_' + k] = v; },
            blur: function() {},
            focus: function() { this._focused = true; },
            select: function() {},
            click: function() { if (this._onclick) this._onclick(); if (this._listeners && this._listeners.click) this._listeners.click(); }
        };
        return el;
    }
    const sandbox = {
        document: {
            body: makeEl('body'),
            getElementById: function(id) {
                if (elementCache[id]) return elementCache[id];
                return null;
            },
            querySelector: function(sel) {
                if (elementCache[sel]) return elementCache[sel];
                return null;
            },
            querySelectorAll: function() { return []; },
            createElement: function(tag) { return makeEl(tag); },
            addEventListener: function(evt, fn) { (this._docListeners = this._docListeners || {})[evt] = fn; },
            removeEventListener: function() {}
        },
        window: {
            chrome: { webview: { postMessage: function(msg) { postedMessages.push(msg); } } },
            addEventListener: function() {},
            removeEventListener: function() {},
            _chatConfirmCallback: null
        },
        console: console,
        setTimeout: function(fn) { try { fn(); } catch(e) {}; return 1; },
        clearTimeout: function() {},
        chatMessages: [],
        isChatMode: false,
        isLoading: false,
        streamState: { active: false },
        _threadBusy: Object.create(null),
        isThreadRequestInFlight: function(threadId) {
            return !!sandbox._threadBusy[String(threadId || '')];
        },
        syncChatButtonsForActiveThread: function() {
            var busy = !!sandbox._threadBusy[String(sandbox.activeThreadId || '')];
            sandbox._lastButtonsEnabled = !busy;
            sandbox.isLoading = busy;
            var sendBtn = sandbox.document.getElementById('chat-send-btn');
            var input = sandbox.document.getElementById('chat-input');
            if (sendBtn) sendBtn.disabled = false;
            if (input) input.disabled = busy;
        },
        setChatButtonsEnabled: function(enabled) {
            sandbox._lastButtonsEnabled = enabled;
        },
        activeThreadId: '',
        sessionStorage: { getItem: function() { return null; }, setItem: function() {} },
        md: { render: function(c) { return '<p>' + c + '</p>'; } },
        renderChatMessages: function() {},
        showTokenUsageBar: function() {},
        showLoadingIndicator: function() {},
        hideLoadingIndicator: function() {},
        Number: Number, String: String, Date: Date,
        _persistedThinkingStates: {},
        updateScopedSearchState: function() {},
        onSearchCrossThreadLoaded: function() {},
        closeSearchDropdown: function() {},
        _searchDropdownEl: null,
        _chatConfirmCallback: null,
        escHtml: undefined,
        initChatMode: undefined,
        renderMarkdown: undefined,
        _makeInlineEditor: undefined,
        _showChatConfirm: undefined
    };
    sandbox.global = sandbox;
    sandbox._postedMessages = postedMessages;
    sandbox._elementCache = elementCache;
    const ctx = vm.createContext(sandbox);
    installIpc(ctx);
    vm.runInContext(src, ctx);
    return sandbox;
}

describe('escHtml', () => {
    it('converts < > " to HTML entities', () => {
        const ctx = loadModule();
        const result = ctx.escHtml('<script>alert("xss")</script>');
        // escHtml converts < to <, > to >, " to ", & to &
        // Verify raw < and > are absent (converted to entities)
        assert.strictEqual(result.indexOf('<'), -1, 'raw < should be absent');
        assert.strictEqual(result.indexOf('>'), -1, 'raw > should be absent');
        // Verify the escaped entities are present
        var lt = '&' + 'lt;';
        var gt = '&' + 'gt;';
        var quot = '&' + 'quot;';
        assert.ok(result.indexOf(lt) >= 0, 'should contain <');
        assert.ok(result.indexOf(gt) >= 0, 'should contain >');
        assert.ok(result.indexOf(quot) >= 0, 'should contain "');
    });

    it('escapes ampersands', () => {
        const ctx = loadModule();
        var amp = '&' + 'amp;';
        assert.strictEqual(ctx.escHtml('a & b'), 'a ' + amp + ' b');
    });

    it('returns empty string for falsy input', () => {
        const ctx = loadModule();
        assert.strictEqual(ctx.escHtml(''), '');
        assert.strictEqual(ctx.escHtml(null), '');
        assert.strictEqual(ctx.escHtml(undefined), '');
    });

    it('returns empty string for numeric 0 (falsy guard)', () => {
        const ctx = loadModule();
        assert.strictEqual(ctx.escHtml(0), '');
    });

    it('escapes number 42 as string', () => {
        const ctx = loadModule();
        assert.strictEqual(ctx.escHtml(42), '42');
    });

    it('handles text with no special characters unchanged', () => {
        const ctx = loadModule();
        assert.strictEqual(ctx.escHtml('hello world'), 'hello world');
    });
});

describe('renderMarkdown', () => {
    it('renders content into #content element', () => {
        const ctx = loadModule();
        const contentEl = { innerHTML: '', style: { display: '' } };
        ctx._elementCache['content'] = contentEl;
        ctx.isChatMode = false;
        ctx.renderMarkdown('# Hello');
        assert.strictEqual(contentEl.innerHTML, '<p># Hello</p>');
    });

    it('shows fallback text when content is falsy', () => {
        const ctx = loadModule();
        const contentEl = { innerHTML: '', style: { display: '' } };
        ctx._elementCache['content'] = contentEl;
        ctx.renderMarkdown('');
        assert.strictEqual(contentEl.innerHTML,
            '<p>There is no content available.</p>');
    });

    it('shows FIM notice in non-chat mode', () => {
        const ctx = loadModule();
        const contentEl = { innerHTML: '', style: { display: '' } };
        const fimNotice = { style: { display: '' } };
        const chatMessagesEl = { style: { display: '' } };
        ctx._elementCache['content'] = contentEl;
        ctx._elementCache['fim-notice'] = fimNotice;
        ctx._elementCache['chat-messages'] = chatMessagesEl;
        ctx.isChatMode = false;
        ctx.renderMarkdown('text');
        assert.strictEqual(fimNotice.style.display, 'block');
        assert.strictEqual(chatMessagesEl.style.display, 'none');
        assert.strictEqual(contentEl.style.display, 'block');
    });

    it('shows chat messages in chat mode', () => {
        const ctx = loadModule();
        const contentEl = { innerHTML: '', style: { display: '' } };
        const chatMessagesEl = { style: { display: '' } };
        ctx._elementCache['content'] = contentEl;
        ctx._elementCache['chat-messages'] = chatMessagesEl;
        ctx.isChatMode = true;
        ctx.renderMarkdown('text');
        assert.strictEqual(chatMessagesEl.style.display, '');
        assert.strictEqual(contentEl.style.display, 'none');
    });
});

describe('initChatMode', () => {
    it('sets isChatMode and populates chatMessages from array', () => {
        const ctx = loadModule();
        ctx.initChatMode([{ role: 'user', content: 'hi', id: 'm1' }]);
        assert.strictEqual(ctx.isChatMode, true);
        assert.strictEqual(ctx.chatMessages.length, 1);
        assert.strictEqual(ctx.chatMessages[0].role, 'user');
    });

    it('handles object with messages property', () => {
        const ctx = loadModule();
        ctx.initChatMode({ messages: [{ role: 'assistant', content: 'hello', id: 'a1' }], threadId: 't123' });
        assert.strictEqual(ctx.chatMessages.length, 1);
        assert.strictEqual(ctx.chatMessages[0].role, 'assistant');
    });

    it('sets activeThreadId from threadId when not already set', () => {
        const ctx = loadModule();
        ctx.activeThreadId = '';
        ctx.initChatMode({ messages: [], threadId: 'thread-456' });
        assert.strictEqual(ctx.activeThreadId, 'thread-456');
    });

    it('updates activeThreadId when switching threads (bug #76)', () => {
        const ctx = loadModule();
        ctx.activeThreadId = 'existing-thread';
        ctx.initChatMode({ messages: [], threadId: 'new-thread' });
        assert.strictEqual(ctx.activeThreadId, 'new-thread');
    });

    it('resets persisted thinking block states', () => {
        const ctx = loadModule();
        ctx._persistedThinkingStates = { 'msg-1': false };
        ctx.initChatMode([]);
        assert.strictEqual(Object.keys(ctx._persistedThinkingStates).length, 0);
    });

    it('hides FIM notice', () => {
        const ctx = loadModule();
        const fimNotice = { style: { display: 'block' } };
        ctx._elementCache['fim-notice'] = fimNotice;
        ctx.initChatMode([]);
        assert.strictEqual(fimNotice.style.display, 'none');
    });

    it('enables chat input and send button', () => {
        const ctx = loadModule();
        const chatInput = { disabled: true, style: {} };
        const sendBtn = { disabled: true, style: {} };
        ctx._elementCache['chat-input'] = chatInput;
        ctx._elementCache['chat-send-btn'] = sendBtn;
        ctx.initChatMode([]);
        assert.strictEqual(chatInput.disabled, false);
        assert.strictEqual(sendBtn.disabled, false);
    });

    it('shows loading when the loaded thread is busy and last message is not assistant', () => {
        const ctx = loadModule();
        ctx._threadBusy['thread-a'] = true;
        let loadingShown = false;
        ctx.showLoadingIndicator = function() { loadingShown = true; };
        ctx.initChatMode({ messages: [{ role: 'user', content: 'q', id: 'u1' }], threadId: 'thread-a' });
        assert.ok(loadingShown, 'loading indicator should be shown for the busy loaded thread');
    });

    it('hides loading when a busy loaded thread already ends with an assistant', () => {
        const ctx = loadModule();
        ctx._threadBusy['thread-a'] = true;
        let loadingHidden = false;
        ctx.hideLoadingIndicator = function() { loadingHidden = true; };
        ctx.initChatMode({ messages: [{ role: 'assistant', content: 'a', id: 'a1' }], threadId: 'thread-a' });
        assert.ok(loadingHidden, 'loading indicator should be hidden');
        assert.strictEqual(ctx.isLoading, true, 'the busy thread must still stay in Stop mode');
    });

    it('keeps chat B in Send mode while chat A is busy, then restores Stop when A is loaded', () => {
        const ctx = loadModule();
        ctx._threadBusy['t-A'] = true;
        const chatInput = { disabled: false, style: {}, focus: () => {} };
        const sendBtn = { disabled: false, onclick: null };
        ctx._elementCache['chat-input'] = chatInput;
        ctx._elementCache['chat-send-btn'] = sendBtn;

        ctx.initChatMode({ messages: [{ role: 'assistant', content: 'b', id: 'b1' }], threadId: 't-B' });
        assert.strictEqual(ctx._lastButtonsEnabled, true, 'idle B must remain sendable while A generates');
        assert.strictEqual(chatInput.disabled, false);

        ctx.initChatMode({ messages: [{ role: 'user', content: 'a', id: 'a1' }], threadId: 't-A' });
        assert.strictEqual(ctx._lastButtonsEnabled, false, 'loading A again must restore Stop mode');
        assert.strictEqual(chatInput.disabled, true);
        assert.strictEqual(ctx.isLoading, true);
    });

    it('keeps the composer disabled during this thread\'s pre-stream phase', () => {
        const ctx = loadModule();
        ctx._threadBusy['t-A'] = true;
        const chatInput = { disabled: false, style: {}, focus: () => {} };
        const sendBtn = { disabled: false, onclick: null };
        ctx._elementCache['chat-input'] = chatInput;
        ctx._elementCache['chat-send-btn'] = sendBtn;
        ctx.initChatMode({ messages: [{ role: 'user', content: 'q', id: 'u1' }], threadId: 't-A' });
        assert.strictEqual(ctx._lastButtonsEnabled, false, 'the busy loaded thread must keep the composer disabled');
        assert.strictEqual(chatInput.disabled, true);
        assert.strictEqual(ctx.isLoading, true);
    });

    it('sets sessionStorage isChatMode', () => {
        const ctx = loadModule();
        let stored = null;
        ctx.sessionStorage.setItem = function(k, v) { stored = v; };
        ctx.initChatMode([]);
        assert.strictEqual(stored, 'true');
    });
});

describe('_makeInlineEditor', () => {
    it('creates an input inside the target element', () => {
        const ctx = loadModule();
        const el = { textContent: 'Old Name', children: [],
            querySelector: function() { return null; },
            appendChild: function(c) { this.children.push(c); }
        };
        ctx._makeInlineEditor(el, 'Old Name', function() {}, '200px');
        assert.strictEqual(el.children.length, 1);
        assert.strictEqual(el.children[0].tagName, 'input');
        assert.strictEqual(el.children[0].value, 'Old Name');
    });

    it('does nothing if element already contains an input', () => {
        const ctx = loadModule();
        const el = {
            textContent: 'Old',
            children: [],
            querySelector: function(sel) { return sel === 'input' ? { tagName: 'input' } : null; }
        };
        const origCreate = ctx.document.createElement;
        let created = false;
        ctx.document.createElement = function(tag) { created = true; return origCreate(tag); };
        ctx._makeInlineEditor(el, 'Old', function() {});
        assert.strictEqual(created, false, 'should not create another input');
        ctx.document.createElement = origCreate;
    });

    it('does nothing when element is null', () => {
        const ctx = loadModule();
        assert.doesNotThrow(() => ctx._makeInlineEditor(null, 'test', function() {}));
    });
});

describe('global Escape handler', () => {
    it('cancels the stream while loading (posts cancelStream)', () => {
        const ctx = loadModule();
        ctx.isLoading = true;
        ctx.document._docListeners.keydown({ key: 'Escape' });
        assert.strictEqual(ctx._postedMessages.length, 1);
        assert.strictEqual(JSON.parse(ctx._postedMessages[0]).action, 'cancelStream');
    });

    it('cancels when streamState is active even if isLoading is temporarily false', () => {
        const ctx = loadModule();
        ctx.isLoading = false;
        ctx.streamState.active = true;
        ctx.document._docListeners.keydown({ key: 'Escape' });
        assert.strictEqual(ctx._postedMessages.length, 1);
        assert.strictEqual(JSON.parse(ctx._postedMessages[0]).action, 'cancelStream');
    });

    it('does nothing when not streaming (Escape must not hide the window)', () => {
        const ctx = loadModule();
        ctx.isLoading = false;
        ctx.document._docListeners.keydown({ key: 'Escape' });
        assert.strictEqual(ctx._postedMessages.length, 0, 'Escape should post nothing when idle');
    });

    it('closes the settings confirm modal on Escape', () => {
        const ctx = loadModule();
        const modal = {
            classList: {
                _open: true,
                contains: function(c) { return c === 'open' && this._open; },
                remove: function(c) { if (c === 'open') this._open = false; },
                add: function() {}
            }
        };
        ctx._elementCache['confirmModal'] = modal;
        ctx.isLoading = false;
        ctx.document._docListeners.keydown({ key: 'Escape' });
        assert.strictEqual(modal.classList._open, false, 'confirm modal should close on Escape');
        assert.strictEqual(ctx._postedMessages.length, 0);
    });
});

describe('_showChatConfirm', () => {
    it('opens its own overlay with the message and runs the callback on confirm', () => {
        const ctx = loadModule();
        let confirmed = false;
        ctx._showChatConfirm('Delete this chat?', () => { confirmed = true; });
        const overlay = ctx.document.body.children[0];
        assert.ok(overlay, 'overlay should be appended to the body');
        assert.strictEqual(overlay.id, 'customConfirmOverlay');
        assert.ok(overlay.innerHTML.indexOf('Delete this chat?') >= 0, 'message should be shown in the overlay');
        overlay.querySelector('.yes-confirm-btn').click();
        assert.strictEqual(confirmed, true, 'confirm callback should fire');
    });

    it('does not run the callback when cancelled', () => {
        const ctx = loadModule();
        let confirmed = false;
        ctx._showChatConfirm('Delete this chat?', () => { confirmed = true; });
        ctx.document.body.children[0].querySelector('.cancel-confirm-btn').click();
        assert.strictEqual(confirmed, false);
    });

    it('does not define the colliding _showConfirm name', () => {
        const ctx = loadModule();
        assert.strictEqual(typeof ctx._showConfirm, 'undefined');
        assert.strictEqual(typeof ctx._showChatConfirm, 'function');
    });
});
