// stream-state.test.js — Unit tests for stream.js: state machine, persist, cancel
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadStreamModule() {
    const src = fs.readFileSync(path.resolve(__dirname, '..', '..', 'webui', 'js', 'chat', 'stream.js'), 'utf-8');
    let postedMessages = [];
    const sandbox = {
        document: {
            getElementById: () => null, createElement: () => ({ style: {}, appendChild: () => {}, querySelector: () => null, querySelectorAll: () => [], insertBefore: () => {} }),
            querySelectorAll: () => [],
            querySelector: () => null,
        },
        window: { addEventListener: () => {} },
        console: console,
        md: { render: (c) => c },
        escHtml: (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
        setTimeout: setTimeout, clearTimeout: clearTimeout,
        chatMessages: [],
        sessionStorage: { getItem: () => null, setItem: () => {} },
        streamState: undefined,
        scrollToBottom: undefined, startStreaming: undefined, onStreamContent: undefined,
        onStreamReasoning: undefined, _persistStreamedMessage: undefined,
        onStreamDone: undefined, cancelStreaming: undefined,
        createStreamingBubble: undefined, createThinkingBlock: undefined,
        handleStreamMessage: undefined, addStreamingActions: undefined,
        markedCompletedThreads: [],
        markThreadCompleted: (threadId) => sandbox.markedCompletedThreads.push(threadId),
        hideLoadingIndicator: () => {},
        // Mirrors production: enabling the composer clears any visible
        // loading dots (bug #215) and fully resets the stream state (bug
        // #219) - the stream-level tests below rely on it.
        setChatButtonsEnabled: (enabled) => {
            if (enabled) {
                sandbox.hideLoadingIndicator();
                if (sandbox.streamState) {
                    sandbox.streamState.active = false;
                    sandbox.streamState.bubble = null;
                    sandbox.streamState.contentDiv = null;
                    sandbox.streamState.thinkingDetails = null;
                    sandbox.streamState.contentBuffer = '';
                    sandbox.streamState.thinkingBuffer = '';
                }
            }
        },
        addMessageActions: () => {},
    };
    sandbox.global = sandbox;
    vm.runInContext(src, vm.createContext(sandbox));
    return sandbox;
}

describe('streamState defaults', () => {
    it('tracks activity separately from provider reasoning', () => {
        const ctx = loadStreamModule();
        assert.strictEqual(ctx.streamState.thinkingKind, 'reasoning');
        assert.strictEqual(ctx.streamState.activitySearchCount, 0);
    });

    it('initializes with active=false', () => {
        const ctx = loadStreamModule();
        assert.strictEqual(ctx.streamState.active, false);
    });

    it('initializes with empty buffers', () => {
        const ctx = loadStreamModule();
        assert.strictEqual(ctx.streamState.contentBuffer, '');
        assert.strictEqual(ctx.streamState.thinkingBuffer, '');
    });

    it('initializes with userScrolledUp=false', () => {
        const ctx = loadStreamModule();
        assert.strictEqual(ctx.streamState.userScrolledUp, false);
    });
});

describe('createStreamingBubble author label escaping (bug #208)', () => {
    // Bug #208: the streaming bubble's author label used to be concatenated
    // into innerHTML without escaping, so an assistant/model name containing
    // HTML (e.g. <img onerror=...>) was parsed and its handlers executed.
    // Load stream.js with a document mock that captures the bubble HTML.
    function loadBubbleHarness() {
        const src = fs.readFileSync(path.resolve(__dirname, '..', '..', 'webui', 'js', 'chat', 'stream.js'), 'utf-8');
        let capturedHtml = '';
        const fakeContentDiv = { innerHTML: '' };
        const fakeBubble = {
            dataset: {},
            querySelector: (sel) => (sel === '.msg-content' ? fakeContentDiv : null),
            querySelectorAll: () => [],
            insertBefore: () => {},
        };
        const template = {
            set innerHTML(v) { capturedHtml = String(v); },
            get innerHTML() { return capturedHtml; },
            firstElementChild: fakeBubble,
        };
        const sandbox = {
            document: {
                getElementById: (id) => (id === 'chat-messages' ? { appendChild: () => {} } : null),
                createElement: () => template,
                querySelectorAll: () => [],
                querySelector: () => null,
                addEventListener: () => {},
            },
            window: { addEventListener: () => {} },
            console,
            md: { render: (c) => c },
            setTimeout,
            clearTimeout,
            chatMessages: [],
            sessionStorage: { getItem: () => null, setItem: () => {} },
            // Same escape helper chat-core.js provides in the real page.
            escHtml: (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
            hideLoadingIndicator: () => {},
            setChatButtonsEnabled: () => {},
        };
        sandbox.global = sandbox;
        vm.runInContext(src, vm.createContext(sandbox));
        // stream.js declares `var streamState = {...}` at load, which replaces
        // the sandbox value - set the display name the way onStreamModelName
        // does before the bubble is created.
        sandbox.streamState.modelName = '<img src="x" onerror="window.__xssPwned=1">';
        return { sandbox, html: () => capturedHtml };
    }

    it('escapes the author label so markup in a model/assistant name cannot execute', () => {
        const h = loadBubbleHarness();
        const bubble = h.sandbox.createStreamingBubble();
        const html = h.html();
        // The injected name must be rendered as inert text: no raw <img> tag,
        // and the escaped entity must be present in the author span.
        assert.strictEqual(html.indexOf('<img'), -1, 'raw <img> must not appear in the bubble HTML');
        assert.ok(html.indexOf('&lt;img') >= 0, 'author name must be HTML-escaped: ' + html);
        assert.ok(html.indexOf('window.__xssPwned=1') >= 0, 'the payload text should still be visible as text');
        // The author span's textContent (once parsed) is the original name.
        assert.ok(typeof bubble === 'object', 'createStreamingBubble should still return the bubble');
    });

    it('keeps a plain assistant name unchanged', () => {
        const h = loadBubbleHarness();
        h.sandbox.streamState.modelName = 'DeepSeek V4 Flash';
        h.sandbox.createStreamingBubble();
        const html = h.html();
        assert.ok(html.indexOf('>DeepSeek V4 Flash<') >= 0, 'plain names must render as-is: ' + html);
        assert.strictEqual(html.indexOf('&lt;'), -1, 'plain names must not be over-escaped');
    });
});

describe('Codex activity UX', () => {
    it('replaces the visible activity snapshot instead of accumulating pseudo-reasoning', () => {
        const ctx = loadStreamModule();
        const content = { textContent: '' };
        const summary = { innerHTML: '' };
        const details = {
            open: true,
            querySelector: (sel) => sel === 'summary' ? summary : content,
        };
        ctx.startStreaming = () => { ctx.streamState.active = true; };
        ctx.createThinkingBlock = () => details;
        ctx.onStreamReasoning({ content: 'Thinking…', kind: 'activity', replace: true, summary: 'Working', searchCount: 0 });
        ctx.onStreamReasoning({ content: 'Searched the web:\nlatest release', kind: 'activity', replace: true, summary: '1 web search', searchCount: 1 });
        assert.strictEqual(ctx.streamState.thinkingBuffer, 'Searched the web:\nlatest release');
        assert.strictEqual(ctx.streamState.thinkingKind, 'activity');
        assert.strictEqual(ctx.streamState.activitySearchCount, 1);
        assert.ok(summary.innerHTML.includes('1 web search'));
    });

    it('uses persisted one-shot content when activity opened the bubble before completion', () => {
        const ctx = loadStreamModule();
        ctx.activeThreadId = 't1';
        ctx.chatMessages = [{ id: 'u1', role: 'user', content: 'question' }];
        const contentDiv = { innerHTML: '' };
        const summary = { innerHTML: '' };
        const details = {
            open: true,
            querySelector: (sel) => sel === 'summary' ? summary : { textContent: '' },
        };
        ctx.streamState.active = true;
        ctx.streamState.bubble = {
            dataset: {},
            querySelector: (sel) => sel === '.msg-content' ? contentDiv : null,
        };
        ctx.streamState.contentDiv = contentDiv;
        ctx.streamState.contentBuffer = '';
        ctx.streamState.thinkingBuffer = 'Searched the web:\nlatest release';
        ctx.streamState.thinkingKind = 'activity';
        ctx.streamState.activitySearchCount = 1;
        ctx.streamState.thinkingDetails = details;
        ctx.streamState.modelName = 'gpt-5.6-luna';
        ctx.addStreamingActions = () => {};
        ctx.onStreamDone({ model: 'gpt-5.6-luna', threadId: 't1', dbMsg: { id: 'a1', parentId: 'u1', role: 'assistant', content: '0.153.4' } });
        assert.strictEqual(ctx.chatMessages[ctx.chatMessages.length - 1].content, '0.153.4');
        assert.strictEqual(contentDiv.innerHTML, '0.153.4');
    });
});

describe('_persistStreamedMessage dedup', () => {
    it('adds message to chatMessages', () => {
        const ctx = loadStreamModule();
        ctx.chatMessages = [];
        ctx.streamState.bubble = { dataset: {} };
        ctx._persistStreamedMessage('hello', 'gpt-4o', { id: 'msg-1' });
        assert.strictEqual(ctx.chatMessages.length, 1);
        assert.strictEqual(ctx.chatMessages[0].content, 'hello');
        assert.strictEqual(ctx.chatMessages[0].model, 'gpt-4o');
    });

    it('deduplicates by id', () => {
        const ctx = loadStreamModule();
        ctx.chatMessages = [{ id: 'msg-1', role: 'assistant', content: 'hello' }];
        ctx.streamState.bubble = { dataset: {} };
        ctx._persistStreamedMessage('hello again', 'gpt-4o', { id: 'msg-1' });
        assert.strictEqual(ctx.chatMessages.length, 1); // should not add duplicate
    });

    it('deduplicates by content when no id', () => {
        const ctx = loadStreamModule();
        ctx.chatMessages = [{ role: 'assistant', content: 'hello' }];
        ctx.streamState.bubble = { dataset: {} };
        ctx._persistStreamedMessage('hello', 'gpt-4o', null);
        assert.strictEqual(ctx.chatMessages.length, 1); // should not add duplicate
    });

    it('adds new message when content differs and no id', () => {
        const ctx = loadStreamModule();
        ctx.chatMessages = [{ role: 'assistant', content: 'old' }];
        ctx.streamState.bubble = { dataset: {} };
        ctx._persistStreamedMessage('new', 'gpt-4o', null);
        assert.strictEqual(ctx.chatMessages.length, 2);
    });

    it('sets dataset.msgId on bubble', () => {
        const ctx = loadStreamModule();
        ctx.chatMessages = [];
        ctx.streamState.bubble = { dataset: {} };
        ctx._persistStreamedMessage('hello', 'gpt-4o', { id: 'msg-99' });
        assert.strictEqual(ctx.streamState.bubble.dataset.msgId, 'msg-99');
    });
});

describe('_streamBelongsToCurrentPath (bug #195)', () => {
    it('rejects a response whose parent is not the current last message', () => {
        const ctx = loadStreamModule();
        ctx.chatMessages = [{ id: 'b-last', role: 'user', content: 'B' }];
        assert.strictEqual(ctx._streamBelongsToCurrentPath({ id: 'a-msg', parentId: 'a-parent' }), false);
    });

    it('accepts a response whose parent is the current last message', () => {
        const ctx = loadStreamModule();
        ctx.chatMessages = [{ id: 'a-parent', role: 'user', content: 'A' }];
        assert.strictEqual(ctx._streamBelongsToCurrentPath({ id: 'a-msg', parentId: 'a-parent' }), true);
    });

    it('accepts a root retry when the UI path was emptied', () => {
        const ctx = loadStreamModule();
        ctx.chatMessages = [];
        assert.strictEqual(ctx._streamBelongsToCurrentPath({ id: 'root-retry', parentId: '' }), true);
    });
});

describe('cancelStreaming state', () => {
    it('does nothing when not active', () => {
        const ctx = loadStreamModule();
        ctx.streamState.active = false;
        ctx.cancelStreaming({});
        assert.strictEqual(ctx.streamState.active, false);
    });

    it('sets active to false when active', () => {
        const ctx = loadStreamModule();
        ctx.streamState.active = true;
        ctx.streamState.contentBuffer = 'partial';
        ctx.streamState.contentDiv = { innerHTML: '' };
        ctx.cancelStreaming({});
        assert.strictEqual(ctx.streamState.active, false);
    });
});

describe('late streamContent after finalize (Stop race)', () => {
    it('ignores late reasoning after cancellation instead of starting a duplicate bubble', () => {
        const ctx = loadStreamModule();
        ctx.streamState.active = false;
        ctx.streamState.finalized = true;
        ctx.streamState.thinkingBuffer = '';
        let starts = 0;
        ctx.startStreaming = () => { starts++; ctx.streamState.active = true; };

        ctx.onStreamReasoning({ content: 'The world', collapsed: false }, undefined);

        assert.strictEqual(starts, 0, 'late reasoning must not start a new stream session');
        assert.strictEqual(ctx.streamState.active, false);
        assert.strictEqual(ctx.streamState.thinkingBuffer, '');
    });

    // Regression: stopping a stream can let a final SSE chunk arrive after
    // the UI finalized the bubble. It must append to the last assistant
    // bubble - NOT open a duplicate message.
    it('appends the late chunk to the last assistant bubble instead of opening a duplicate', () => {
        const ctx = loadStreamModule();
        ctx.streamState.active = false;
        ctx.streamState.finalized = true;
        ctx.streamState.bubble = null;
        ctx.streamState.contentBuffer = '';
        const contentDiv = { innerHTML: '', textContent: 'A lot' };
        const lastBubble = { querySelector: (sel) => (sel === '.msg-content' ? contentDiv : null) };
        ctx.document.getElementById = (id) => (id === 'chat-messages' ? { querySelectorAll: (sel) => (sel === '.msg.bot' ? [lastBubble] : []) } : null);
        ctx.chatMessages = [{ id: 'm1', role: 'assistant', content: 'A lot' }];
        ctx.onStreamContent(' depends', undefined);
        assert.ok(contentDiv.innerHTML.indexOf('A lot depends') >= 0, 'late chunk must append to the existing bubble');
        assert.strictEqual(ctx.chatMessages[0].content, 'A lot depends');
        assert.strictEqual(ctx.streamState.active, false, 'late chunk must not restart a stream session');
    });

    it('does nothing when no assistant bubble exists', () => {
        const ctx = loadStreamModule();
        ctx.streamState.active = false;
        ctx.streamState.finalized = true;
        ctx.document.getElementById = (id) => (id === 'chat-messages' ? { querySelectorAll: () => [] } : null);
        assert.doesNotThrow(() => ctx.onStreamContent('depends', undefined));
    });

    // Regression: the first chunk of a NEW stream (no finalize happened yet)
    // must start streaming - NOT be swallowed as a "late chunk". This is what
    // made responses appear all-at-once instead of streaming.
    it('starts a fresh stream session when no finalize happened', () => {
        const ctx = loadStreamModule();
        ctx.streamState.active = false;
        ctx.streamState.finalized = false;
        ctx.chatMessages = [];
        const contentDiv = { innerHTML: '' };
        const container = {
            appendChild: () => {},
            querySelectorAll: () => []
        };
        ctx.document.getElementById = (id) => (id === 'chat-messages' ? container : null);
        ctx.document.createElement = () => ({
            style: {}, children: [],
            set innerHTML(v) { this._html = v; },
            get innerHTML() { return this._html || ''; },
            firstElementChild: { querySelector: (sel) => (sel === '.msg-content' ? contentDiv : null) },
            appendChild: (c) => { this.children.push(c); },
            querySelector: () => null,
            querySelectorAll: () => [],
            insertBefore: () => {}
        });
        ctx.onStreamContent('Hello', undefined);
        assert.strictEqual(ctx.streamState.active, true, 'the first chunk must start a stream session');
        assert.strictEqual(ctx.streamState.contentBuffer, 'Hello');
        assert.strictEqual(contentDiv.innerHTML, 'Hello');
    });

    it('clears the finalize marker when a new stream starts (streamModelName)', () => {
        const ctx = loadStreamModule();
        ctx.streamState.finalized = true;
        ctx.onStreamModelName('deepseek-v4-pro', undefined);
        assert.strictEqual(ctx.streamState.finalized, false);
    });
});

describe('onStreamDone thread scoping (bug #195)', () => {
    it('does not persist another thread/branch response into the current array', () => {
        const ctx = loadStreamModule();
        ctx.activeThreadId = 't-B';
        ctx.chatMessages = [{ id: 'b-user', role: 'user', content: 'B question' }];
        ctx.streamState.active = true;
        ctx.streamState.bubble = null;
        ctx.streamState.contentBuffer = 'A answer';
        ctx.streamState.thinkingBuffer = '';
        ctx.streamState.modelName = 'm';
        ctx.streamState.userScrolledUp = false;
        ctx.streamState.contentDiv = null;
        ctx.streamState.thinkingDetails = null;
        ctx.onStreamDone({ model: 'm', threadId: 't-A', dbMsg: { id: 'a-msg', parentId: 'a-user' } });
        assert.strictEqual(ctx.chatMessages.length, 1, 'wrong-thread response must not be pushed into chatMessages');
        // Bug #221: a NON-current stream's completion must NOT clear the
        // current view's stream state - the current thread may still have its
        // own stream in flight (two chat-mode commands can stream at once).
        // The composer reset arrives via setChatButtonsEnabled(true), which
        // AHK posts only when NO request remains.
        assert.strictEqual(ctx.streamState.active, true, 'non-current completion must not clear the current thread stream state');
    });

    it('does not hide the loading indicator for a non-current completion - setChatButtonsEnabled(true) does (bugs #215/#221)', () => {
        const ctx = loadStreamModule();
        ctx.activeThreadId = 't-B';
        ctx.chatMessages = [{ id: 'b-user', role: 'user', content: 'B question' }];
        ctx.streamState.active = true;
        ctx.streamState.bubble = null;
        ctx.streamState.contentBuffer = 'A answer';
        ctx.streamState.thinkingBuffer = '';
        ctx.streamState.modelName = 'm';
        ctx.streamState.userScrolledUp = false;
        ctx.streamState.contentDiv = null;
        ctx.streamState.thinkingDetails = null;
        let hidden = 0;
        ctx.hideLoadingIndicator = () => { hidden++; };
        ctx.onStreamDone({ model: 'm', threadId: 't-A', dbMsg: { id: 'a-msg', parentId: 'a-user' } });
        assert.strictEqual(ctx.chatMessages.length, 1, 'wrong-thread response must not be pushed into chatMessages');
        assert.strictEqual(ctx.streamState.active, true, 'non-current completion must leave the current stream state untouched');
        assert.deepStrictEqual(ctx.markedCompletedThreads, ['t-A'], 'successful completion in another chat should mark that chat for attention');
        assert.strictEqual(hidden, 0, 'the non-current streamDone itself must not clear the loading dots');
        // AHK posts setChatButtonsEnabled(true) once NO request remains - that
        // is the signal that clears the dots and resets the composer.
        ctx.setChatButtonsEnabled(true);
        assert.strictEqual(ctx.streamState.active, false);
        assert.ok(hidden > 0, 'enabling the composer must clear the visible loading dots');
    });
});

describe('concurrent command streams (bug #221)', () => {
    it('keeps the current thread stream state when a NON-current stream completes', () => {
        const ctx = loadStreamModule();
        ctx.activeThreadId = 't-B';
        ctx.chatMessages = [{ id: 'b-user', role: 'user', content: 'B question' }];
        // B's own stream is in flight (current view):
        ctx.streamState.active = true;
        ctx.streamState.bubble = { dataset: {} };
        ctx.streamState.contentBuffer = 'B partial answer';
        ctx.streamState.thinkingBuffer = '';
        ctx.streamState.modelName = 'm';
        ctx.streamState.userScrolledUp = false;
        ctx.streamState.contentDiv = null;
        ctx.streamState.thinkingDetails = null;
        // A's (non-current) stream completes first:
        ctx.onStreamDone({ model: 'm', threadId: 't-A', dbMsg: { id: 'a-msg', parentId: 'a-user' } });
        assert.strictEqual(ctx.streamState.active, true, 'A completing must not clear B\'s in-flight stream state');
        assert.strictEqual(ctx.streamState.contentBuffer, 'B partial answer', 'B\'s accumulated content must survive A\'s completion');
        assert.strictEqual(ctx.chatMessages.length, 1, 'A\'s response must not be persisted into B\'s UI array');
    });

    it('does not clear the current stream state when a NON-current stream is cancelled/errors', () => {
        const ctx = loadStreamModule();
        ctx.activeThreadId = 't-B';
        ctx.chatMessages = [{ id: 'b-user', role: 'user', content: 'B question' }];
        ctx.streamState.active = true;
        ctx.streamState.bubble = { dataset: {} };
        ctx.streamState.contentBuffer = 'B partial answer';
        ctx.streamState.thinkingBuffer = '';
        ctx.streamState.modelName = 'm';
        ctx.streamState.userScrolledUp = false;
        ctx.streamState.contentDiv = null;
        ctx.streamState.thinkingDetails = null;
        // A's stream cancels/errors while B is still streaming:
        ctx.cancelStreaming({ threadId: 't-A', dbMsg: { id: 'a-partial', parentId: 'a-user' } });
        assert.strictEqual(ctx.streamState.active, true, 'A\'s cancel must not clear B\'s in-flight stream state');
        assert.strictEqual(ctx.streamState.contentBuffer, 'B partial answer');
    });
});

describe('onStreamDone reasoning-only responses', () => {
    function makeBubble() {
        const shared = { textContent: '' };
        return {
            dataset: {},
            querySelector(sel) {
                return sel === '.msg-content' ? shared : shared;
            },
            querySelectorAll: () => [],
        };
    }

    it('persists the message and adds actions when only thinking was streamed', () => {
        const ctx = loadStreamModule();
        ctx.chatMessages = [{ role: 'user', content: 'think only please' }];
        const bubble = makeBubble();
        ctx.streamState.active = true;
        ctx.streamState.bubble = bubble;
        ctx.streamState.contentDiv = { innerHTML: '' };
        ctx.streamState.thinkingDetails = { querySelector: () => ({ innerHTML: '', remove: () => {} }) };
        ctx.streamState.contentBuffer = '';
        ctx.streamState.thinkingBuffer = 'reasoning text';
        ctx.streamState.modelName = 'thinking-model';
        let actionsAdded = 0;
        ctx.addStreamingActions = (b, idx) => { actionsAdded++; assert.strictEqual(b, bubble); assert.strictEqual(idx, 1); };

        ctx.onStreamDone({ model: 'thinking-model', dbMsg: { id: 'm-reasoning-1', reasoning: 'reasoning text' } });

        assert.strictEqual(ctx.chatMessages.length, 2);
        assert.strictEqual(ctx.chatMessages[1].role, 'assistant');
        assert.strictEqual(ctx.chatMessages[1].content, '');
        assert.strictEqual(ctx.chatMessages[1].id, 'm-reasoning-1');
        assert.strictEqual(ctx.chatMessages[1].reasoning, 'reasoning text');
        assert.strictEqual(actionsAdded, 1);
    });
});

describe('onStreamDone generated attachments', () => {
    it('preserves and immediately renders attachments when reasoning was streamed', () => {
        const ctx = loadStreamModule();
        ctx.chatMessages = [{ id: 'u-image', role: 'user', content: 'draw it' }];
        const shared = { textContent: '' };
        const bubble = {
            dataset: {},
            querySelector: () => shared,
            querySelectorAll: () => []
        };
        ctx.streamState.active = true;
        ctx.streamState.bubble = bubble;
        ctx.streamState.contentDiv = { innerHTML: '' };
        ctx.streamState.thinkingDetails = { querySelector: () => ({ innerHTML: '', remove: () => {} }) };
        ctx.streamState.contentBuffer = '';
        ctx.streamState.thinkingBuffer = 'Using image generation tool';
        ctx.streamState.modelName = 'gpt-5.6-luna';
        let renders = 0;
        let actionsAdded = 0;
        ctx.renderChatMessages = () => { renders++; };
        ctx.addStreamingActions = () => { actionsAdded++; };
        const attachments = [{ id: 'att-1', attachment_type: 'image', mime_type: 'image/png', base64: 'iVBORw0KGgo=' }];

        ctx.onStreamDone({
            model: 'gpt-5.6-luna',
            dbMsg: { id: 'a-image', role: 'assistant', content: '', reasoning: 'Using image generation tool', parentId: 'u-image', attachments }
        });

        assert.strictEqual(ctx.chatMessages.length, 2);
        assert.strictEqual(ctx.chatMessages[1].id, 'a-image');
        assert.strictEqual(ctx.chatMessages[1].attachments.length, 1, 'persisted attachments must survive into chatMessages');
        assert.strictEqual(ctx.chatMessages[1].attachments[0].id, 'att-1');
        assert.strictEqual(renders, 1, 'generated attachment must render immediately');
        assert.strictEqual(actionsAdded, 0, 'the stale streaming bubble should not receive actions before re-render');
    });
});

describe('onStreamDone single-shot responses (bug #229)', () => {
    // Bug #229: a NON-STREAMING (single-shot) chat response - e.g. a chat-mode
    // command with "Stream Response" OFF, like the default Summarize command -
    // streams no content/reasoning chunks, so the streaming buffers are empty.
    // onStreamDone must still render the persisted assistant message from the
    // streamDone dbMsg; before the fix the bubble only appeared after a reload.
    function makeSingleShotCtx() {
        const ctx = loadStreamModule();
        ctx.activeThreadId = 't-1';
        ctx.chatMessages = [{ id: 'u1', role: 'user', content: 'question' }];
        ctx.streamState.active = false;
        ctx.streamState.bubble = null;
        ctx.streamState.contentDiv = null;
        ctx.streamState.thinkingDetails = null;
        ctx.streamState.contentBuffer = '';
        ctx.streamState.thinkingBuffer = '';
        ctx.streamState.modelName = 'deepseek-v4-pro';
        ctx.streamState.userScrolledUp = false;
        let renders = 0;
        ctx.renderChatMessages = () => { renders++; };
        return { ctx, renders: () => renders };
    }

    it('renders the persisted assistant message from dbMsg when the buffers are empty', () => {
        const { ctx, renders } = makeSingleShotCtx();
        ctx.onStreamDone({
            model: 'deepseek-v4-pro',
            displayName: 'deepseek-v4-pro',
            threadId: 't-1',
            dbMsg: { id: 'a1', role: 'assistant', content: 'The summary the API returned.', parentId: 'u1', tokenCount: 9 }
        });
        assert.strictEqual(ctx.chatMessages.length, 2, 'the single-shot response must be added to chatMessages');
        const a1 = ctx.chatMessages[1];
        assert.strictEqual(a1.id, 'a1');
        assert.strictEqual(a1.role, 'assistant');
        assert.strictEqual(a1.content, 'The summary the API returned.');
        assert.strictEqual(a1.model, 'deepseek-v4-pro');
        assert.strictEqual(renders(), 1, 'the view must be re-rendered so the bubble appears immediately');
    });

    it('does not duplicate an already-present message (dedup by id)', () => {
        const { ctx } = makeSingleShotCtx();
        ctx.chatMessages = [
            { id: 'u1', role: 'user' },
            { id: 'a1', role: 'assistant', content: 'already rendered' }
        ];
        ctx.onStreamDone({
            model: 'deepseek-v4-pro',
            threadId: 't-1',
            dbMsg: { id: 'a1', role: 'assistant', content: 'already rendered' }
        });
        assert.strictEqual(ctx.chatMessages.length, 2, 'an already-present message must not be duplicated');
    });

    it('does not render a non-current single-shot response into the current array', () => {
        const { ctx, renders } = makeSingleShotCtx();
        ctx.activeThreadId = 't-2';
        ctx.onStreamDone({
            model: 'deepseek-v4-pro',
            threadId: 't-1',
            dbMsg: { id: 'a1', role: 'assistant', content: 'other thread summary', parentId: 'u1' }
        });
        assert.strictEqual(ctx.chatMessages.length, 1, 'a wrong-thread single-shot response must not be pushed');
        assert.strictEqual(renders(), 0);
    });
});

describe('Codex image streamDone serialization contract', () => {
    it('passes the sending thread id when rebuilding the persisted assistant payload', () => {
        const src = fs.readFileSync(path.resolve(__dirname, '..', '..', 'chat', 'streaming', 'StreamCompletion.ahk'), 'utf-8');
        assert.ok(
            src.includes('buildStructuredMessagesFromPath([path[path.Length]], streamThreadId)[1]'),
            'streamDone dbMsg must include the thread id so generated attachments are loaded'
        );
    });
});

describe('_updateUserTokenCount', () => {
    it('applies a zero contribution to the last user message (bug #150)', () => {
        const ctx = loadStreamModule();
        ctx.chatMessages = [
            { id: 'u1', role: 'user', tokenCount: 12 },
            { id: 'a1', role: 'assistant' },
            { id: 'u2b', role: 'user', tokenCount: 7 },
            { id: 'a2b', role: 'assistant' }
        ];
        ctx._updateUserTokenCount({ userTokenCount: 0 });
        assert.strictEqual(ctx.chatMessages[2].tokenCount, 0);
    });

    it('applies a positive contribution to the last user message', () => {
        const ctx = loadStreamModule();
        ctx.chatMessages = [{ id: 'u1', role: 'user', tokenCount: 7 }];
        ctx._updateUserTokenCount({ userTokenCount: 9 });
        assert.strictEqual(ctx.chatMessages[0].tokenCount, 9);
    });

    it('skips when userTokenCount is absent', () => {
        const ctx = loadStreamModule();
        ctx.chatMessages = [{ id: 'u1', role: 'user', tokenCount: 5 }];
        ctx._updateUserTokenCount({});
        assert.strictEqual(ctx.chatMessages[0].tokenCount, 5);
    });
});

describe('retry restore state cleared on success (bug #169)', () => {
    it('onStreamDone clears the pending retry-restore messages', () => {
        const ctx = loadStreamModule();
        ctx._retryRemovedMessages = [{ id: 'a1', role: 'assistant' }];
        ctx.chatMessages = [{ role: 'user', content: 'q' }];
        ctx.streamState.active = true;
        ctx.streamState.bubble = null;
        ctx.streamState.contentBuffer = 'new answer';
        ctx.streamState.thinkingBuffer = '';
        ctx.streamState.modelName = 'm';
        ctx.streamState.userScrolledUp = false;
        ctx.streamState.contentDiv = null;
        ctx.streamState.thinkingDetails = null;
        ctx.onStreamDone({ model: 'm' });
        assert.strictEqual(ctx._retryRemovedMessages, null);
    });
});


describe('stream provider attribution', () => {
  it('stores provider from streamModelName payload for the live bubble', () => {
    const ctx = loadStreamModule();
    ctx.onStreamModelName('glm-5.2-free', '', 'openrouter');
    assert.strictEqual(ctx.streamState.modelName, 'glm-5.2-free');
    assert.strictEqual(ctx.streamState.provider, 'openrouter');
  });

  it('persists provider from dbMsg on completion-side message state', () => {
    const ctx = loadStreamModule();
    ctx._persistStreamedMessage('ok', 'claude-sonnet-4', { id: 'a-provider', provider: 'openrouter' });
    assert.strictEqual(ctx.chatMessages[0].provider, 'openrouter');
  });
});
