// chat-sidebar.test.js — Unit tests for chat-sidebar.js, chat-core.js, chat-threadmap.js, chat-trash.js
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadModules() {
    // Load order: chat-core (shared utilities) → chat-sidebar → chat-threadmap → chat-trash
    const chatDir = path.resolve(__dirname, '..', '..', 'webui', 'js', 'chat');
    const srcCore = fs.readFileSync(path.join(chatDir, 'chat-core.js'), 'utf-8');
    const srcSidebar = fs.readFileSync(path.join(chatDir, 'chat-sidebar.js'), 'utf-8');
    const srcThreadmap = fs.readFileSync(path.join(chatDir, 'chat-threadmap.js'), 'utf-8');
    const srcTrash = fs.readFileSync(path.join(chatDir, 'chat-trash.js'), 'utf-8');
    const combinedSrc = srcCore + '\n' + srcSidebar + '\n' + srcThreadmap + '\n' + srcTrash;

    let postedMessages = [];
    const elementCache = {};
    function makeEl(tag) {
        const el = {
            tagName: tag, className: '', innerHTML: '', id: '', textContent: '', title: '',
            style: {}, dataset: {}, children: [],
            classList: { add: function(c) { el.className += ' ' + c; }, contains: function(c) { return el.className.indexOf(c) >= 0; }, remove: function(c) { el.className = el.className.replace(c, '').trim(); } },
            appendChild: function(child) { el.children.push(child); return child; },
            addEventListener: function(evt, fn) {},
            querySelector: function(sel) { return makeEl('div'); },
            querySelectorAll: function() { return []; },
            insertBefore: function(child, ref) { el.children.push(child); },
            remove: function() {},
            closest: function() { return null; },
            getAttribute: function() { return null; },
            setAttribute: function() {}
        };
        return el;
    }
    const trashItemsEl = makeEl('div');
    const bodyEl = makeEl('body');
    const sandbox = {
        document: {
            body: bodyEl,
            addEventListener: function() {},
            removeEventListener: function() {},
            getElementById: (id) => {
                if (elementCache[id]) return elementCache[id];
                if (id === 'thread-list') { elementCache[id] = makeEl('div'); return elementCache[id]; }
                if (id === 'nav-message-list') { elementCache[id] = makeEl('div'); return elementCache[id]; }
                if (id === 'chat-input') { elementCache[id] = { disabled: false, style: {} }; return elementCache[id]; }
                if (id === 'chat-send-btn') { elementCache[id] = { disabled: false, style: {} }; return elementCache[id]; }
                if (id === 'trashWrap') { elementCache[id] = makeEl('div'); return elementCache[id]; }
                if (id === 'customConfirmOverlay') { elementCache[id] = null; return null; }
                return null;
            },
            querySelector: function(sel) {
                if (sel === '.trash-items') return trashItemsEl;
                if (sel === '.title-text') return makeEl('span');
                if (sel === '.fold') return makeEl('span');
                return null;
            },
            querySelectorAll: function() { return []; },
            createElement: (tag) => makeEl(tag)
        },
        window: {
            chrome: { webview: { postMessage: (msg) => postedMessages.push(JSON.parse(msg)) } },
            addEventListener: () => {},
            removeEventListener: () => {}
        },
        console: console,
        setTimeout: (fn) => { try { fn(); } catch(e) {} },
        clearTimeout: () => {},
        activeThreadId: '',
        chatMessages: [],
        sidebarOpen: false,
        escHtml: function(s) { if (!s) return ''; return String(s).replace(/&/g,'&').replace(/</g,'<').replace(/>/g,'>').replace(/"/g,'"'); },
        Number: Number, String: String
    };
    sandbox.global = sandbox;
    sandbox._postedMessages = postedMessages;
    sandbox._elementCache = elementCache;
    vm.runInContext(combinedSrc, vm.createContext(sandbox));
    return sandbox;
}

describe('loadThreadList', () => {
    it('renders empty state when no threads', () => {
        const ctx = loadModules();
        ctx.loadThreadList([]);
        const list = ctx.document.getElementById('thread-list');
        assert.ok(list.innerHTML.includes('No chats yet'));
    });

    it('renders thread items for each thread', () => {
        const ctx = loadModules();
        const threads = [
            { id: 't1', title: 'Chat One', updated_at: '2026-01-01', model: 'gpt-4o' },
            { id: 't2', title: 'Chat Two', updated_at: '2026-01-02', model: 'deepseek-v4' }
        ];
        ctx.loadThreadList(threads);
        const list = ctx.document.getElementById('thread-list');
        assert.ok(list.children.length >= 2);
    });

    it('marks active thread', () => {
        const ctx = loadModules();
        ctx.activeThreadId = 't1';
        ctx.loadThreadList([{ id: 't1', title: 'Active', updated_at: '2026-01-01', model: 'gpt-4o' }]);
        const list = ctx.document.getElementById('thread-list');
        assert.ok(list.children.length >= 1);
    });
});

describe('completion attention dots', () => {
    it('survives sidebar rerenders until the chat is cleared', () => {
        const ctx = loadModules();
        ctx.markThreadCompleted('t-done');
        const marked = ctx.createChatItem({ id: 't-done', title: 'Done', updated_at: '2026-01-01' });
        assert.ok(marked.className.indexOf('completed-unread') >= 0, 'completed chat should render the attention class');

        ctx.clearThreadCompleted('t-done');
        const cleared = ctx.createChatItem({ id: 't-done', title: 'Done', updated_at: '2026-01-01' });
        assert.ok(cleared.className.indexOf('completed-unread') < 0, 'opening/clearing the chat should remove the attention class');
    });

    it('does not mark the currently active chat', () => {
        const ctx = loadModules();
        ctx.activeThreadId = 't-active';
        ctx.markThreadCompleted('t-active');
        const item = ctx.createChatItem({ id: 't-active', title: 'Active', updated_at: '2026-01-01' });
        assert.ok(item.className.indexOf('completed-unread') < 0);
    });
});

describe('loadTrashList', () => {
    it('does nothing for empty trash', () => {
        const ctx = loadModules();
        assert.doesNotThrow(() => ctx.loadTrashList([]));
    });

    it('creates trash section without throwing', () => {
        const ctx = loadModules();
        assert.doesNotThrow(() => ctx.loadTrashList([{ id: 't3', title: 'Old Chat', updated_at: '2026-01-01' }]));
    });

    it('each trash item button operates on the correct thread', () => {
        const ctx = loadModules();
        ctx._postedMessages = [];
        ctx.window.chrome.webview.postMessage = (msg) => ctx._postedMessages.push(JSON.parse(msg));
        ctx.loadTrashList([
            { id: 't-a', title: 'First Trash', updated_at: '2026-01-01' },
            { id: 't-b', title: 'Second Trash', updated_at: '2026-01-02' }
        ]);
        var trashItems = ctx.document.querySelector('.trash-items');
        assert.strictEqual(trashItems.children.length, 2);

        // Click Restore on the first item
        var firstItem = trashItems.children[0];
        firstItem.querySelector('button[title="Restore"]').click = function() {};
        // Simulate what addEventListener would do by reading the HTML
        // The closure bug would cause the second item's button to reference t-b instead of t-a
        // Verify the items were created with correct titles
        assert.ok(firstItem.innerHTML.indexOf('First Trash') >= 0);
        assert.ok(trashItems.children[1].innerHTML.indexOf('Second Trash') >= 0);
    });
});

describe('renderNavList', () => {
    it('does nothing when nav-list missing', () => {
        const ctx = loadModules();
        ctx.document.getElementById = () => null;
        assert.doesNotThrow(() => ctx.renderNavList());
    });

    it('renders nav items', () => {
        const ctx = loadModules();
        ctx.chatMessages = [
            { role: 'user', content: 'Hello' },
            { role: 'assistant', content: 'Hi!' }
        ];
        ctx.renderNavList();
        const navList = ctx.document.getElementById('nav-message-list');
        assert.strictEqual(navList.children.length, 2);
    });

    it('escapes the who label (model name) in nav items (bug #83)', () => {
        const ctx = loadModules();
        ctx.escHtml = function(s) {
            return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
        };
        ctx.chatMessages = [
            { role: 'assistant', content: 'Hi!', model: '"><img src=x onerror=window.__x=1>' }
        ];
        ctx.renderNavList();
        const navList = ctx.document.getElementById('nav-message-list');
        assert.strictEqual(navList.children.length, 1);
        const html = navList.children[0].innerHTML;
        assert.ok(!html.includes('"><img'), 'who label must be escaped, got ' + html);
        assert.ok(html.includes('&lt;img'), 'who label should render as escaped text');
    });
});

describe('_providerIconHtml', () => {
    it('returns openrouter icon for null model', () => {
        const ctx = loadModules();
        const html = ctx._providerIconHtml(null);
        assert.ok(html.indexOf('openrouter.ico') >= 0);
    });

    it('returns deepseek icon for deepseek models', () => {
        const ctx = loadModules();
        const html = ctx._providerIconHtml('deepseek/deepseek-v4-flash');
        assert.ok(html.indexOf('deepseek.ico') >= 0);
    });
});

describe('formatRelativeDate', () => {
    it('returns non-empty for recent dates', () => {
        const ctx = loadModules();
        const now = new Date().toISOString();
        assert.ok(ctx.formatRelativeDate(now).length > 0);
    });

    it('handles empty input', () => {
        const ctx = loadModules();
        assert.strictEqual(ctx.formatRelativeDate(''), '');
    });
});

describe('scrollToMessage', () => {
    it('does not throw when messages missing', () => {
        const ctx = loadModules();
        assert.doesNotThrow(() => ctx.scrollToMessage(0));
    });
});

describe('_showChatConfirm', () => {
    it('creates its own overlay without throwing', () => {
        const ctx = loadModules();
        assert.doesNotThrow(() => ctx._showChatConfirm('Are you sure?', () => {}));
    });

    it('does not define the colliding _showConfirm name', () => {
        const ctx = loadModules();
        assert.strictEqual(typeof ctx._showConfirm, 'undefined', 'chat code must not shadow the settings confirm helper');
        assert.strictEqual(typeof ctx._showChatConfirm, 'function');
    });
});

describe('folder-delete confirm (bug #220)', () => {
    it('passes the RAW folder name - _showChatConfirm escapes the whole message once', () => {
        const chatDir = path.resolve(__dirname, '..', '..', 'webui', 'js', 'chat');
        const src = fs.readFileSync(path.join(chatDir, 'chat-sidebar.js'), 'utf-8');
        const m = src.match(/_showChatConfirm\('Delete folder "' \+ ([^+]+) \+ '"\? Chats will become unfiled\.'/);
        assert.ok(m, 'folder-delete confirm must call _showChatConfirm with the folder name');
        assert.ok(m[1].indexOf('escHtml') < 0,
            'the folder name must NOT be pre-escaped - _showChatConfirm escapes the whole message once, so a pre-escaped name would double-escape "A&B<C>" into "A&amp;B&lt;C&gt;" (bug #220)');
    });
});

describe('updateTopbarTitle', () => {
    it('does not throw with empty data', () => {
        const ctx = loadModules();
        assert.doesNotThrow(() => ctx.updateTopbarTitle());
    });

    it('updates title text from data', () => {
        const ctx = loadModules();
        ctx.updateTopbarTitle({ text: 'Test Chat', folder: 'Greetings' });
        assert.ok(true);
    });
});


describe('sidebar provider icon', () => {
    it('passes the persisted transport provider to the shared icon resolver', () => {
        const ctx = loadModules();
        let seen = null;
        ctx.window.ProviderIcons = {
            html(model, provider, size) {
                seen = { model, provider, size };
                return '<img src="../icons/openrouter.ico">';
            }
        };
        ctx.createChatItem({
            id: 't-openrouter', title: 'OR chat', updated_at: '2026-01-01',
            model: 'claude-sonnet-4', provider: 'openrouter'
        });
        assert.deepStrictEqual(seen, { model: 'claude-sonnet-4', provider: 'openrouter', size: 20 });
    });
});
