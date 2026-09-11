// chat-render.test.js — Unit tests for chat-render.js
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Simple DOM parser for innerHTML-based approach
function parseHtml(html) {
  // Basic innerHTML parsing: just detect key class names in the string
  return {
    innerHTML: html,
    className: (html.match(/class="([^"]+)"/) || [,''])[1],
    children: [],
    querySelector: function(sel) {
      if (html.indexOf(sel.replace('.','')) >= 0) {
        return { className: sel.replace('.',''), innerHTML: '', children: [], appendChild: function(){}, querySelector: function(){ return null; } };
      }
      return null;
    },
    querySelectorAll: function() { return []; }
  };
}

function loadRenderModule() {
    const src = fs.readFileSync(path.resolve(__dirname, '..', '..', 'webui', 'js', 'chat', 'chat-render.js'), 'utf-8');
    let createdElements = [];
    function makeEl(tag) {
        const el = {
            tagName: tag, className: '', innerHTML: '', id: '', textContent: '', title: '',
            style: {}, dataset: {}, children: [],
            firstElementChild: null,
            classList: { add: function(c) { el.className += ' ' + c; }, contains: function(c) { return el.className.indexOf(c) >= 0; } },
            appendChild: function(child) { el.children.push(child); return child; },
            addEventListener: function(evt, fn) {},
            querySelector: function(sel) {
              // Simple: return a child-like object if the HTML contains the selector
              if (el.innerHTML.indexOf(sel.replace('.','').replace('#','')) >= 0) {
                return { className: sel.replace('.',''), innerHTML: '', children: [], appendChild: function(){}, querySelector: function(){ return null; }, querySelectorAll: function(){ return []; } };
              }
              return null;
            },
            querySelectorAll: function() { return []; },
            insertBefore: function(child, ref) { el.children.push(child); },
            remove: function() {},
            closest: (sel) => null,
            getAttribute: () => null,
            setAttribute: function(k,v) { this[k] = v; },
            scrollIntoView: () => {},
            scrollTop: 0,
            scrollHeight: 0,
            nextSibling: null,
            firstChild: null
        };
        createdElements.push(el);
        return el;
    }
    let postedMessages = [];
    const sandbox = {
        document: {
            getElementById: (id) => {
                if (id === 'chat-messages') {
                    if (!sandbox._chatMessagesEl) sandbox._chatMessagesEl = makeEl('div');
                    return sandbox._chatMessagesEl;
                }
                return null;
            },
            querySelectorAll: () => [],
            createElement: function(tag) {
              const el = makeEl(tag);
              // Override innerHTML setter to populate firstElementChild and enable querySelector
              var _innerHTML = '';
              Object.defineProperty(el, 'innerHTML', {
                get: function() { return _innerHTML; },
                set: function(val) {
                  _innerHTML = val;
                  // Parse the class from the first element
                  var m = val.match(/class="([^"]+)"/);
                  if (m) el.firstElementChild = { className: m[1], children: [], style: {}, dataset: {}, querySelector: function(s) {
                    if (val.indexOf(s.replace('.','').replace('#','')) >= 0) {
                      return { className: s.replace('.',''), innerHTML: '', children: [], appendChild: function(){}, querySelector: function(){ return null; }, querySelectorAll: function(){ return []; }, style: {}, setAttribute: function(){}, removeAttribute: function(){}, addEventListener: function(){} };
                    }
                    return null;
                  }, querySelectorAll: function() { return []; }, classList: { add: function(){}, contains: function(){ return false; } }, appendChild: function(c){ this.children.push(c); }, addEventListener: function(){}, remove: function(){}, insertBefore: function(){}, closest: function(){ return null; }, setAttribute: function(){}, removeAttribute: function(){} };
                }
              });
              return el;
            },
            body: { appendChild: () => {} },
            addEventListener: () => {}
        },
        window: {
            chrome: { webview: { postMessage: (msg) => postedMessages.push(JSON.parse(msg)) } },
            addEventListener: () => {},
            getSelection: () => ({ toString: () => '', removeAllRanges: () => {}, getRangeAt: () => ({ commonAncestorContainer: {}, getBoundingClientRect: () => ({}) }) })
        },
        console: console,
        chatMessages: [],
        isLoading: false,
        streamState: { active: false },
        setChatButtonsEnabled: (enabled) => { sandbox._lastButtonsEnabled = enabled; },
        md: { render: (c) => '<p>' + c + '</p>' },
        sessionStorage: { getItem: () => null, setItem: () => {} },
        addMessageActions: (container, msg, idx) => {},
        createTokenInfoIcon: () => null,
        hideLoadingIndicator: () => {},
        renderAttachments: () => {},
        escHtml: (s) => String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'),
        Number: Number, String: String, Date: Date,
        isNaN: isNaN,
        navigator: { clipboard: { writeText: async () => {} } }
    };
    sandbox.global = sandbox;
    sandbox._createdElements = createdElements;
    sandbox._postedMessages = postedMessages;
    vm.runInContext(src, vm.createContext(sandbox));
    return sandbox;
}

describe('createMessageBubble — user', () => {
    it('produces a bubble with msg and you classes', () => {
        const ctx = loadRenderModule();
        const bubble = ctx.createMessageBubble({ role: 'user', content: 'Hello', id: 'u1', createdAt: '2026-01-01T13:01:00' }, 0);
        assert.ok(bubble);
        assert.ok(bubble.className.includes('msg'));
        assert.ok(bubble.className.includes('you'));
    });

    it('produces non-null bubble', () => {
        const ctx = loadRenderModule();
        const bubble = ctx.createMessageBubble({ role: 'user', content: 'Hello', id: 'msg-abc123', createdAt: '2026-01-01T13:01:00' }, 0);
        assert.ok(bubble !== null);
        assert.ok(bubble !== undefined);
        assert.ok(bubble.className.length > 0);
    });

    it('renders web-search context messages with the search-context class and author', () => {
        const ctx = loadRenderModule();
        const bubble = ctx.createMessageBubble({ role: 'user', content: '[Web search: AutoHotkey]\\n\\nAnswer: ...', id: 'ctx1', createdAt: '2026-01-01T13:01:00' }, 0);
        assert.ok(bubble.className.includes('search-context'), 'search context messages get a muted card class');
        assert.ok(bubble.className.includes('you'), 'search context stays a user-role bubble');
        assert.ok(bubble.querySelector('.search-card-toggle'), 'search context renders a collapsible card header');
    });

    it('parses the query out of the [Web search: ...] marker line', () => {
        const ctx = loadRenderModule();
        const sc = ctx._parseSearchContext('[Web search: most played song on Spotify 2024]\n\nThe answer body.');
        assert.strictEqual(sc.query, 'most played song on Spotify 2024');
        assert.ok(sc.results.indexOf('The answer body.') === 0, 'results keep everything after the marker line');
        const plain = ctx._parseSearchContext('a normal user message');
        assert.strictEqual(plain.query, '');
        assert.strictEqual(plain.results, 'a normal user message');
    });

    it('builds a collapsed search card showing the query with the raw marker replaced', () => {
        const ctx = loadRenderModule();
        const html = ctx._buildSearchContextHtml({ query: 'AutoHotkey WebView2', results: 'Answer: it works.' });
        assert.ok(html.indexOf('search-card') >= 0, 'card root present');
        assert.ok(html.indexOf('Searched the web for:') >= 0, 'header labels the query');
        assert.ok(html.indexOf('AutoHotkey WebView2') >= 0, 'header shows the query text');
        assert.ok(html.indexOf('search-card-results" hidden') >= 0, 'results are collapsed by default');
        assert.ok(html.indexOf('Answer: it works.') >= 0, 'results body is present inside the card');
        assert.ok(html.indexOf('[Web search:') < 0, 'raw marker is replaced by the card header');
        assert.ok(html.indexOf('aria-expanded="false"') >= 0, 'toggle starts collapsed');
    });
});

describe('createMessageBubble — assistant', () => {
    it('produces a bubble with msg and bot classes', () => {
        const ctx = loadRenderModule();
        const bubble = ctx.createMessageBubble({ role: 'assistant', content: 'Hi!', model: 'gpt-4o', id: 'a1', createdAt: '2026-01-01T13:11:00' }, 1);
        assert.ok(bubble.className.includes('msg'));
        assert.ok(bubble.className.includes('bot'));
    });

    it('creates non-null bubble for assistant', () => {
        const ctx = loadRenderModule();
        const bubble = ctx.createMessageBubble({ role: 'assistant', content: 'Answer', reasoning: 'Let me think...', id: 'a1' }, 1);
        assert.ok(bubble !== null);
        assert.ok(bubble.className.includes('bot'));
    });

    it('renders reasoning and an image attachment for an empty-content assistant message', () => {
        const ctx = loadRenderModule();
        const bubble = ctx.createMessageBubble({
            role: 'assistant',
            content: '',
            reasoning: '**Using image generation tool**',
            model: 'gpt-5.6-luna',
            id: 'a-image',
            attachments: [{ id: 'att-image', attachment_type: 'image', mime_type: 'image/png', original_filename: 'codex-generated-1.png', file_size: 3395107, base64: 'iVBORw0KGgo=' }]
        }, 1);
        assert.ok(bubble.querySelector('.thinking-block'), 'assistant reasoning should still render');
        assert.ok(bubble.querySelector('.msg-attachment-image'), 'assistant image attachment should render');
    });

    it('creates non-null bubble for assistant without reasoning', () => {
        const ctx = loadRenderModule();
        const bubble = ctx.createMessageBubble({ role: 'assistant', content: 'Answer', id: 'a1' }, 1);
        assert.ok(bubble !== null);
        assert.ok(bubble.className.includes('bot'));
    });
});

describe('createMessageBubble — system', () => {
    it('produces a bubble with msg and system classes', () => {
        const ctx = loadRenderModule();
        const bubble = ctx.createMessageBubble({ role: 'system', content: 'You are helpful', id: 's1' }, 2);
        assert.ok(bubble.className.includes('msg'));
        assert.ok(bubble.className.includes('system'));
    });

    it('system bubble has correct class', () => {
        const ctx = loadRenderModule();
        const bubble = ctx.createMessageBubble({ role: 'system', content: 'You are helpful', id: 's1' }, 2);
        assert.ok(bubble.className.includes('system'));
    });
});

describe('renderChatMessages', () => {
    it('populates chat-messages container', () => {
        const ctx = loadRenderModule();
        ctx.chatMessages = [{ role: 'user', content: 'Hi', id: 'u1', createdAt: '2026-01-01T13:01:00' }];
        ctx.renderChatMessages(ctx.chatMessages);
        const container = ctx.document.getElementById('chat-messages');
        assert.ok(container.children.length >= 1);
    });
});

describe('appendChatMessage', () => {
    it('adds message to chatMessages array and DOM', () => {
        const ctx = loadRenderModule();
        ctx.chatMessages = [];
        const container = ctx.document.getElementById('chat-messages');
        ctx.appendChatMessage({ role: 'user', content: 'New', id: 'new1', createdAt: '2026-01-01T13:01:00' });
        assert.strictEqual(ctx.chatMessages.length, 1);
        assert.ok(container.children.length >= 1);
    });
});

describe('updateChatMessage', () => {
    it('replaces the matching bubble in place and updates the message array', () => {
        const ctx = loadRenderModule();
        ctx.chatMessages = [{ id: 'ctx1', role: 'user', content: '[Web search: X]\n\nSearching…' }];
        let replaced = null;
        ctx.document.getElementById = (id) => {
            if (id === 'chat-messages') {
                return {
                    querySelector: (sel) => (sel.indexOf('ctx1') >= 0 ? { replaceWith: (el) => { replaced = el; } } : null)
                };
            }
            return null;
        };
        ctx.updateChatMessage({ id: 'ctx1', role: 'user', content: '[Web search: X]\n\nreal results' });
        assert.ok(replaced, 'bubble should be replaced');
        assert.strictEqual(ctx.chatMessages[0].content, '[Web search: X]\n\nreal results');
    });

    it('does nothing when the message id has no bubble', () => {
        const ctx = loadRenderModule();
        ctx.chatMessages = [];
        ctx.document.getElementById = (id) => {
            if (id === 'chat-messages') return { querySelector: () => null };
            return null;
        };
        assert.doesNotThrow(() => ctx.updateChatMessage({ id: 'nope', role: 'user', content: 'x' }));
    });
});

describe('removeLastAssistantMessage', () => {
    it('removes last assistant message from array', () => {
        const ctx = loadRenderModule();
        ctx.chatMessages = [
            { role: 'user', content: 'Hi', id: 'u1' },
            { role: 'assistant', content: 'Hey', id: 'a1' }
        ];
        ctx.removeLastAssistantMessage();
        assert.strictEqual(ctx.chatMessages.length, 1);
        assert.strictEqual(ctx.chatMessages[0].role, 'user');
    });

    it('removes only last assistant even with multiple', () => {
        const ctx = loadRenderModule();
        ctx.chatMessages = [
            { role: 'user', content: 'Q1', id: 'u1' },
            { role: 'assistant', content: 'A1', id: 'a1' },
            { role: 'user', content: 'Q2', id: 'u2' },
            { role: 'assistant', content: 'A2', id: 'a2' }
        ];
        ctx.removeLastAssistantMessage();
        assert.strictEqual(ctx.chatMessages.length, 3);
    });
});

describe('_buildMetaText', () => {
    it('returns empty for no createdAt', () => {
        const ctx = loadRenderModule();
        assert.strictEqual(ctx._buildMetaText({}), '');
    });

    it('returns user format with · prefix', () => {
        const ctx = loadRenderModule();
        const meta = ctx._buildMetaText({ role: 'user', createdAt: '2025-01-01T12:00:00' });
        assert.ok(meta.indexOf('· ') === 0);
    });

    it('returns assistant format with model prefix', () => {
        const ctx = loadRenderModule();
        const meta = ctx._buildMetaText({ role: 'assistant', model: 'deepseek-v4', createdAt: '2025-01-01T12:00:00' });
        assert.ok(meta.indexOf('deepseek-v4') >= 0);
        assert.ok(meta.indexOf('·') > 0);
    });
});

describe('_prepUserContent line-ending normalization (bugs #222/#224)', () => {
    it('normalizes CRLF and CR to LF', () => {
        const ctx = loadRenderModule();
        assert.strictEqual(ctx._prepUserContent('a\r\nb\rc'), 'a\nb\nc');
    });

    it('keeps single newlines untouched (markdown-it breaks:true turns them into <br>)', () => {
        const ctx = loadRenderModule();
        assert.strictEqual(ctx._prepUserContent('First paragraph.\nSecond paragraph.'), 'First paragraph.\nSecond paragraph.');
    });

    it('no longer injects a literal <br> tag for 3+ newlines (html:false would escape it)', () => {
        const ctx = loadRenderModule();
        const out = ctx._prepUserContent('a\n\n\n\nb');
        assert.strictEqual(out.indexOf('<br>'), -1, '_prepUserContent must not inject raw <br> into markdown source');
        assert.strictEqual(out, 'a\n\n\n\nb');
    });

    it('normalizes empty/undefined content', () => {
        const ctx = loadRenderModule();
        assert.strictEqual(ctx._prepUserContent(''), '');
        assert.strictEqual(ctx._prepUserContent(undefined), '');
    });
});

describe('assistant content single-newline rendering (bug #222)', () => {
    it('createMessageBubble runs assistant content through the same line-ending normalization as user content', () => {
        const chatDir = path.resolve(__dirname, '..', '..', 'webui', 'js', 'chat');
        const src = fs.readFileSync(path.join(chatDir, 'chat-render.js'), 'utf-8');
        const asstIdx = src.indexOf("role === 'assistant'");
        assert.ok(asstIdx >= 0, 'assistant branch not found');
        const branch = src.slice(asstIdx, asstIdx + 800);
        assert.ok(branch.indexOf('_prepUserContent(msg.content)') >= 0,
            'assistant content must be normalized before md.render so single-newline paragraphs stay visible (bug #222)');
    });

});

describe('_buildReasoningHtml', () => {
    it('returns empty for no reasoning', () => {
        const ctx = loadRenderModule();
        assert.strictEqual(ctx._buildReasoningHtml({}), '');
    });

    it('returns thinking block HTML when reasoning present', () => {
        const ctx = loadRenderModule();
        const html = ctx._buildReasoningHtml({ reasoning: 'Let me think...' });
        assert.ok(html.indexOf('thinking-block') >= 0);
        assert.ok(html.indexOf('open') >= 0, 'thinking block should have open attribute by default');
        assert.ok(html.indexOf('Let me think...') >= 0);
    });
});

describe('_buildAttachmentHtml', () => {
    it('returns empty for no attachments', () => {
        const ctx = loadRenderModule();
        assert.strictEqual(ctx._buildAttachmentHtml({}), '');
    });

    it('renders image attachments for assistant messages', () => {
        const ctx = loadRenderModule();
        const html = ctx._buildAttachmentHtml({ role: 'assistant', attachments: [{ attachment_type: 'image', base64: 'abc123', mime_type: 'image/png', original_filename: 'generated.png' }] });
        assert.ok(html.indexOf('msg-attachment-image') >= 0);
    });

    it('returns image HTML for image attachments', () => {
        const ctx = loadRenderModule();
        const html = ctx._buildAttachmentHtml({
            role: 'user',
            attachments: [{ attachment_type: 'image', base64: 'abc123', mime_type: 'image/png', original_filename: 'test.png' }]
        });
        assert.ok(html.indexOf('msg-attachment-image') >= 0);
    });
});

describe('_buildEditUiHtml', () => {
    it('returns edit UI with cancel and save buttons', () => {
        const ctx = loadRenderModule();
        const html = ctx._buildEditUiHtml({ content: 'test' });
        assert.ok(html.indexOf('msg-edit-ui') >= 0);
        assert.ok(html.indexOf('cancel-edit') >= 0);
        assert.ok(html.indexOf('save-overwrite') >= 0);
    });
});

describe('_saveThinkingBlockStates', () => {
    it('does not throw when no thinking blocks exist', () => {
        const ctx = loadRenderModule();
        ctx._saveThinkingBlockStates();  // should not throw
    });

    it('accumulates open state keyed by message ID into persistent record', () => {
        const ctx = loadRenderModule();
        var savedQsAll = ctx.document.querySelectorAll;
        ctx.document.querySelectorAll = function(sel) {
            if (sel === '.thinking-block') {
                return [
                    { open: true, closest: function(s) { return s === '.msg' ? { getAttribute: function(a) { return a === 'data-msg-id' ? 'msg-aaa' : null; } } : null; } },
                    { open: false, closest: function(s) { return s === '.msg' ? { getAttribute: function(a) { return a === 'data-msg-id' ? 'msg-bbb' : null; } } : null; } }
                ];
            }
            return savedQsAll(sel);
        };
        ctx._saveThinkingBlockStates();
        assert.strictEqual(ctx._persistedThinkingStates['msg-aaa'], true);
        assert.strictEqual(ctx._persistedThinkingStates['msg-bbb'], false);
        ctx.document.querySelectorAll = savedQsAll;
    });

    it('skips blocks without a parent .msg', () => {
        const ctx = loadRenderModule();
        var savedQuerySelectorAll = ctx.document.querySelectorAll;
        ctx.document.querySelectorAll = function(sel) {
            if (sel === '.thinking-block') {
                return [{ open: true, closest: function() { return null; } }];
            }
            return savedQuerySelectorAll(sel);
        };
        // Should not throw — just skips
        ctx._saveThinkingBlockStates();
        ctx.document.querySelectorAll = savedQuerySelectorAll;
    });
});

describe('_restoreThinkingBlockStates', () => {
    it('does nothing when persistent record is empty', () => {
        const ctx = loadRenderModule();
        ctx._persistedThinkingStates = {};
        ctx._restoreThinkingBlockStates();  // should not throw
    });

    it('does nothing when no thinking blocks in DOM', () => {
        const ctx = loadRenderModule();
        var container = ctx.document.getElementById('chat-messages');
        ctx._persistedThinkingStates = { 'msg-1': true };
        // container.querySelectorAll('.thinking-block') returns [] by default
        ctx._restoreThinkingBlockStates();  // should not throw
    });

    it('sets open attribute when persisted state is true', () => {
        const ctx = loadRenderModule();
        var track = { setOpenCalled: false, removeOpenCalled: false };
        var blockEl = {
            setAttribute: function(name) { if (name === 'open') track.setOpenCalled = true; },
            removeAttribute: function(name) { if (name === 'open') track.removeOpenCalled = true; },
            closest: function(s) { return s === '.msg' ? { getAttribute: function(a) { return a === 'data-msg-id' ? 'msg-1' : null; } } : null; }
        };
        var container = ctx.document.getElementById('chat-messages');
        var savedQsAll = container.querySelectorAll;
        container.querySelectorAll = function(sel) {
            if (sel === '.thinking-block') return [blockEl];
            return [];
        };
        ctx._persistedThinkingStates = { 'msg-1': true };
        ctx._restoreThinkingBlockStates();
        assert.ok(track.setOpenCalled, 'should set open attribute');
        assert.strictEqual(track.removeOpenCalled, false);
        container.querySelectorAll = savedQsAll;
    });

    it('removes open attribute when persisted state is false', () => {
        const ctx = loadRenderModule();
        var track = { setOpenCalled: false, removeOpenCalled: false };
        var blockEl = {
            setAttribute: function(name) { if (name === 'open') track.setOpenCalled = true; },
            removeAttribute: function(name) { if (name === 'open') track.removeOpenCalled = true; },
            closest: function(s) { return s === '.msg' ? { getAttribute: function(a) { return a === 'data-msg-id' ? 'msg-2' : null; } } : null; }
        };
        var container = ctx.document.getElementById('chat-messages');
        var savedQsAll = container.querySelectorAll;
        container.querySelectorAll = function(sel) {
            if (sel === '.thinking-block') return [blockEl];
            return [];
        };
        ctx._persistedThinkingStates = { 'msg-2': false };
        ctx._restoreThinkingBlockStates();
        assert.ok(track.removeOpenCalled, 'should remove open attribute');
        assert.strictEqual(track.setOpenCalled, false);
        container.querySelectorAll = savedQsAll;
    });

    it('skips blocks whose msg ID is not in persistent record', () => {
        const ctx = loadRenderModule();
        var track = { setOpenCalled: false, removeOpenCalled: false };
        var blockEl = {
            setAttribute: function(name) { if (name === 'open') track.setOpenCalled = true; },
            removeAttribute: function(name) { if (name === 'open') track.removeOpenCalled = true; },
            closest: function(s) { return s === '.msg' ? { getAttribute: function(a) { return a === 'data-msg-id' ? 'msg-unknown' : null; } } : null; }
        };
        var container = ctx.document.getElementById('chat-messages');
        var savedQsAll = container.querySelectorAll;
        container.querySelectorAll = function(sel) {
            if (sel === '.thinking-block') return [blockEl];
            return [];
        };
        ctx._persistedThinkingStates = { 'msg-1': false };  // different ID
        ctx._restoreThinkingBlockStates();
        assert.strictEqual(track.setOpenCalled, false, 'should NOT modify block with unknown ID');
        assert.strictEqual(track.removeOpenCalled, false);
        container.querySelectorAll = savedQsAll;
    });

    it('skips blocks without a parent .msg', () => {
        const ctx = loadRenderModule();
        var blockEl = { closest: function(s) { return null; }, setAttribute: function(){}, removeAttribute: function(){} };
        var container = ctx.document.getElementById('chat-messages');
        var savedQsAll = container.querySelectorAll;
        container.querySelectorAll = function(sel) {
            if (sel === '.thinking-block') return [blockEl];
            return [];
        };
        ctx._persistedThinkingStates = { 'msg-1': true };
        ctx._restoreThinkingBlockStates();  // should not throw
        container.querySelectorAll = savedQsAll;
    });
});

describe('renderChatMessages preserves thinking block state', () => {
    it('requests the active thread error banners during a thread render (bug #1)', () => {
        const ctx = loadRenderModule();
        ctx.activeThreadId = 'thread-b';
        const container = ctx.document.getElementById('chat-messages');
        var calledWith = null;
        ctx._renderThreadErrorBanners = function(target, threadId) {
            calledWith = { target, threadId };
        };

        ctx.renderChatMessages([]);

        assert.strictEqual(calledWith.target, container, 'the message container should receive the stored banners');
        assert.strictEqual(calledWith.threadId, 'thread-b', 'only the active thread should be rendered');
    });

    it('does not throw with messages containing reasoning', () => {
        const ctx = loadRenderModule();
        ctx.chatMessages = [
            { role: 'user', content: 'Hi', id: 'u1', createdAt: '2026-01-01T13:01:00' },
            { role: 'assistant', content: 'Answer', reasoning: 'Let me think...', model: 'gpt-4o', id: 'a1', createdAt: '2026-01-01T13:02:00' }
        ];
        ctx.renderChatMessages(ctx.chatMessages);
        var container = ctx.document.getElementById('chat-messages');
        assert.ok(container.children.length >= 2, 'should render 2 messages');
    });

    it('restores persisted collapsed state on re-render', () => {
        const ctx = loadRenderModule();
        ctx.chatMessages = [
            { role: 'assistant', content: 'Answer', reasoning: 'Let me think...', model: 'gpt-4o', id: 'a1', createdAt: '2026-01-01T13:02:00' }
        ];

        // User collapsed a1 previously
        ctx._persistedThinkingStates['a1'] = false;

        // Override container.querySelectorAll to return a tracking block for the restore phase
        var container = ctx.document.getElementById('chat-messages');
        var restoreCalled = false;
        var track = { setOpenCalled: false, removeOpenCalled: false };
        var blockEl = {
            setAttribute: function(name) { if (name === 'open') track.setOpenCalled = true; },
            removeAttribute: function(name) { if (name === 'open') track.removeOpenCalled = true; },
            closest: function(s) { return s === '.msg' ? { getAttribute: function(a) { return a === 'data-msg-id' ? 'a1' : null; } } : null; }
        };
        var savedQsAll = container.querySelectorAll;
        container.querySelectorAll = function(sel) {
            if (sel === '.thinking-block') { restoreCalled = true; return [blockEl]; }
            return savedQsAll(sel);
        };

        ctx.renderChatMessages(ctx.chatMessages);
        assert.ok(restoreCalled, 'restore should scan DOM for thinking blocks');
        assert.ok(track.removeOpenCalled, 'should restore collapsed state from persistent record');
        container.querySelectorAll = savedQsAll;
    });

    it('does not throw when rendering empty messages array', () => {
        const ctx = loadRenderModule();
        ctx.renderChatMessages([]);
        var container = ctx.document.getElementById('chat-messages');
        assert.strictEqual(container.children.length, 0);
    });
});

describe('replaceMessagesAfter preserves thinking block state', () => {
    it('does not affect sibling branch (different IDs, independent state)', () => {
        const ctx = loadRenderModule();
        ctx.chatMessages = [
            { role: 'user', content: 'Q1', id: 'u1', createdAt: '2026-01-01T13:01:00' },
            { role: 'assistant', content: 'A1', reasoning: 'thinking...', model: 'gpt-4o', id: 'a1', createdAt: '2026-01-01T13:02:00' }
        ];
        ctx.renderChatMessages(ctx.chatMessages);

        // User collapsed a1
        ctx._persistedThinkingStates['a1'] = false;

        // Branch switch: a1 replaced with a1-b (different ID, no persisted state)
        var container = ctx.document.getElementById('chat-messages');
        var track = { setOpenCalled: false, removeOpenCalled: false };
        var blockA1b = {
            setAttribute: function(name) { if (name === 'open') track.setOpenCalled = true; },
            removeAttribute: function(name) { if (name === 'open') track.removeOpenCalled = true; },
            closest: function(s) { return s === '.msg' ? { getAttribute: function(a) { return a === 'data-msg-id' ? 'a1-b' : null; } } : null; }
        };
        var savedQsAll = container.querySelectorAll;
        container.querySelectorAll = function(sel) {
            if (sel === '.thinking-block') return [blockA1b];
            if (sel === '.msg') return container.children;
            return savedQsAll(sel);
        };

        var newMessages = [
            { role: 'user', content: 'Q1', id: 'u1', createdAt: '2026-01-01T13:01:00' },
            { role: 'assistant', content: 'A1-branch-B', reasoning: 'different...', model: 'gpt-4o', id: 'a1-b', createdAt: '2026-01-01T13:03:00' }
        ];
        ctx.replaceMessagesAfter(1, newMessages, 1);

        // a1-b is NOT in persistent record — should NOT be modified
        assert.strictEqual(track.setOpenCalled, false, 'a1-b should NOT be collapsed (no persisted state)');
        assert.strictEqual(track.removeOpenCalled, false);
        container.querySelectorAll = savedQsAll;
    });

    it('restores collapsed state when switching back to original branch', () => {
        const ctx = loadRenderModule();
        ctx.chatMessages = [
            { role: 'assistant', content: 'A1', reasoning: 'thinking...', model: 'gpt-4o', id: 'a1', createdAt: '2026-01-01T13:02:00' }
        ];
        ctx.renderChatMessages(ctx.chatMessages);

        // User collapsed a1
        ctx._persistedThinkingStates['a1'] = false;

        var container = ctx.document.getElementById('chat-messages');
        var track = { setOpenCalled: false, removeOpenCalled: false };
        var blockA1 = {
            setAttribute: function(name) { if (name === 'open') track.setOpenCalled = true; },
            removeAttribute: function(name) { if (name === 'open') track.removeOpenCalled = true; },
            closest: function(s) { return s === '.msg' ? { getAttribute: function(a) { return a === 'data-msg-id' ? 'a1' : null; } } : null; }
        };
        var savedQsAll = container.querySelectorAll;
        container.querySelectorAll = function(sel) {
            if (sel === '.thinking-block') return [blockA1];
            if (sel === '.msg') return container.children;
            return savedQsAll(sel);
        };

        ctx.replaceMessagesAfter(0,
            [{ role: 'assistant', content: 'A1', reasoning: 'thinking...', model: 'gpt-4o', id: 'a1', createdAt: '2026-01-01T13:02:00' }], 0);

        assert.ok(track.removeOpenCalled, 'should restore collapsed state when switching back');
        assert.strictEqual(track.setOpenCalled, false);
        container.querySelectorAll = savedQsAll;
    });

    it('handles empty newMessages correctly', () => {
        const ctx = loadRenderModule();
        ctx.chatMessages = [
            { role: 'user', content: 'Q1', id: 'u1', createdAt: '2026-01-01T13:01:00' }
        ];
        ctx.renderChatMessages(ctx.chatMessages);
        ctx.replaceMessagesAfter(0, [], 0);
    });
});

describe('updateChatMessages composer state (bug #214)', () => {
    it('keeps the composer disabled while a stream is in flight', () => {
        const ctx = loadRenderModule();
        ctx.streamState = { active: true };
        ctx.updateChatMessages([{ role: 'user', content: 'q', id: 'u1' }]);
        assert.strictEqual(ctx._lastButtonsEnabled, false, 'a branch switch mid-stream must not re-enable the composer');
    });

    it('keeps the composer disabled during the pre-stream phase (isLoading, no stream content yet)', () => {
        const ctx = loadRenderModule();
        ctx.streamState = { active: false };
        ctx.isLoading = true;
        ctx.updateChatMessages([{ role: 'user', content: 'q', id: 'u1' }]);
        assert.strictEqual(ctx._lastButtonsEnabled, false, 'an in-flight request must keep the composer disabled');
    });

    it('re-enables the composer when idle', () => {
        const ctx = loadRenderModule();
        ctx.streamState = { active: false };
        ctx.isLoading = false;
        ctx.updateChatMessages([{ role: 'user', content: 'q', id: 'u1' }]);
        assert.strictEqual(ctx._lastButtonsEnabled, true);
    });
});


describe('assistant provider icon', () => {
  it('renders the persisted transport provider rather than inferring from model name', () => {
    const ctx = loadRenderModule();
    let seen = null;
    ctx.window.ProviderIcons = {
      html(model, provider, size, className) {
        seen = { model, provider, size, className };
        return '<img class="msg-provider-icon" src="../icons/openrouter.ico">';
      }
    };
    ctx.createMessageBubble({
      role: 'assistant', content: 'ok', id: 'a-provider',
      model: 'claude-sonnet-4', provider: 'openrouter', createdAt: '2026-01-01T13:01:00'
    }, 0);
    assert.deepStrictEqual(seen, {
      model: 'claude-sonnet-4', provider: 'openrouter', size: 18, className: 'msg-provider-icon'
    });
  });
});
