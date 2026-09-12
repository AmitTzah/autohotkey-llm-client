// chat-input.test.js — Unit tests for chat-input.js: onChatSend payload, retry logic
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { installIpc } = require('./helpers/ipc-test-utils');

function loadInputModule() {
    const src = fs.readFileSync(path.resolve(__dirname, '..', '..', 'webui', 'js', 'chat', 'chat-input.js'), 'utf-8');
    let postedMessages = [];
    const sendBtn = { disabled: false, textContent: '', onclick: null, title: 'Send message', setAttribute(name, value) { this[name] = value; } };
    const sandbox = {
        document: {
            getElementById: (id) => {
                if (id === 'chat-input') return { value: 'test message', style: {}, disabled: false, focus: () => {} };
                if (id === 'chat-send-btn') return sendBtn;
                return null;
            },
            createElement: () => ({ style: {}, appendChild: () => {}, innerHTML: '', remove: () => {} }),
            querySelectorAll: () => [],
        },
        window: { chrome: { webview: { postMessage: (msg) => { postedMessages.push(msg); } } }, addEventListener: () => {} },
        console: console,
        setTimeout: setTimeout, clearTimeout: clearTimeout,
        chatMessages: [],
        isLoading: false,
        activeThreadId: '',
        streamState: { active: false },
        attachmentState: [],
        sessionStorage: { getItem: () => null, setItem: () => {} },
        renderChatMessages: () => {},
        onChatSend: undefined, showLoadingIndicator: undefined, hideLoadingIndicator: undefined,
        setChatButtonsEnabled: undefined, onStopStreaming: undefined,
        retryLastAssistantMessage: undefined, handleChatInputKeydown: undefined,
        autoResizeChatInput: undefined,
        getAttachmentsForSend: () => [],
        clearAttachments: () => {},
        showErrorBanner: () => {},
    };
    sandbox.global = sandbox;
    const ctx = vm.createContext(sandbox);
    installIpc(ctx);
    vm.runInContext(src, ctx);
    return { ctx: sandbox, postedMessages };
}

describe('onChatSend — payload construction', () => {
    it('sends chatSend with message text', () => {
        const { ctx, postedMessages } = loadInputModule();
        ctx.isLoading = false;
        ctx.onChatSend();
        assert.strictEqual(postedMessages.length, 1);
        const payload = JSON.parse(postedMessages[0]);
        assert.strictEqual(payload.action, 'chatSend');
        assert.strictEqual(payload.message, 'test message');
    });

    it('flushes pending right-rail settings before posting chatSend (bug #316)', () => {
        const { ctx, postedMessages } = loadInputModule();
        const order = [];
        ctx._sendAllSettings = (immediate) => {
            if (immediate) order.push('settings');
        };
        ctx.window.chrome.webview.postMessage = (message) => {
            order.push(JSON.parse(message).action);
        };
        ctx.isLoading = false;
        ctx.onChatSend();
        assert.deepStrictEqual(order, ['settings', 'chatSend'],
            'the settings IPC must be posted before chatSend');
        assert.strictEqual(postedMessages.length, 0,
            'the test stub replaced the WebView sender');
    });

    it('sends "Describe the attached content." when message is empty and attachments exist', () => {
        const { ctx, postedMessages } = loadInputModule();
        ctx.isLoading = false;
        // Mock empty input
        const origGetEl = ctx.document.getElementById;
        ctx.document.getElementById = (id) => {
            if (id === 'chat-input') return { value: '', style: {}, disabled: false, focus: () => {} };
            if (id === 'chat-send-btn') return { disabled: false, textContent: '', onclick: null, title: 'Send message', setAttribute(name, value) { this[name] = value; } };
            return origGetEl(id);
        };
        ctx.getAttachmentsForSend = () => [{ type: 'image', filename: 'test.png' }];
        ctx.onChatSend();
        const payload = JSON.parse(postedMessages[0]);
        assert.strictEqual(payload.message, 'Describe the attached content.');
        assert.ok(payload.attachments);
        assert.strictEqual(payload.attachments.length, 1);
    });

    it('calls onStopStreaming when the visible thread owns an in-flight request', () => {
        const { ctx, postedMessages } = loadInputModule();
        ctx.activeThreadId = 't-A';
        ctx.setChatButtonsEnabled({ enabled: false, threadId: 't-A' });
        ctx.onChatSend();
        assert.strictEqual(postedMessages.length, 1);
        const payload = JSON.parse(postedMessages[0]);
        assert.strictEqual(payload.action, 'cancelStream');
        assert.strictEqual(payload.threadId, 't-A');
    });

    it('never sends into the same busy thread even if isLoading was reset (bug #214/#218)', () => {
        const { ctx, postedMessages } = loadInputModule();
        ctx.activeThreadId = 't-A';
        ctx.setChatButtonsEnabled({ enabled: false, threadId: 't-A' });
        ctx.isLoading = false; // deliberately desync the visible scalar
        ctx.onChatSend();
        assert.strictEqual(postedMessages.length, 1, 'no chatSend may be posted into the busy thread');
        assert.strictEqual(JSON.parse(postedMessages[0]).action, 'cancelStream',
            'the per-thread ownership map must still route the click to Stop');
    });

    it('retires provisional new-chat busy state when the durable thread id arrives', () => {
        const { ctx } = loadInputModule();

        ctx.activeThreadId = '';
        ctx.setChatButtonsEnabled({ enabled: false, threadId: '' });
        assert.strictEqual(ctx.isThreadRequestInFlight(''), true);

        ctx.activeThreadId = 't-created';
        ctx.setChatButtonsEnabled({ enabled: false, threadId: 't-created' });
        assert.strictEqual(ctx.isThreadRequestInFlight('t-created'), true);

        ctx.activeThreadId = '';
        ctx.syncChatButtonsForActiveThread();
        assert.strictEqual(ctx.isLoading, false,
            'a later blank New Chat must not inherit the first chat\'s provisional Stop state');
    });

    it('keeps chat B sendable while chat A is generating', () => {
        const { ctx, postedMessages } = loadInputModule();
        ctx.activeThreadId = 't-B';
        ctx.setChatButtonsEnabled({ enabled: false, threadId: 't-A' });

        assert.strictEqual(ctx.isLoading, false, 'background A must not mark visible B as loading');
        ctx.onChatSend();

        assert.strictEqual(postedMessages.length, 1);
        assert.strictEqual(JSON.parse(postedMessages[0]).action, 'chatSend',
            'B must still be able to send while A is generating');

        ctx.activeThreadId = 't-A';
        ctx.syncChatButtonsForActiveThread();
        assert.strictEqual(ctx.isLoading, true, 'switching back to A must restore Stop mode');
    });

    it('shows loading dots when AHK starts a request before streaming begins', () => {
        const { ctx } = loadInputModule();
        let shown = 0;
        ctx.showLoadingIndicator = () => { shown++; };
        ctx.streamState = { active: false };
        ctx.setChatButtonsEnabled(false);
        assert.strictEqual(shown, 1,
            'command-triggered requests must show loading dots before the first stream chunk');
    });

    it('updates the send button tooltip and accessible label for Stop mode', () => {
        const { ctx } = loadInputModule();
        const sendBtn = ctx.document.getElementById('chat-send-btn');

        ctx.setChatButtonsEnabled(false);
        assert.strictEqual(sendBtn.title, 'Stop generating');
        assert.strictEqual(sendBtn['aria-label'], 'Stop generating');

        ctx.setChatButtonsEnabled(true);
        assert.strictEqual(sendBtn.title, 'Send message');
        assert.strictEqual(sendBtn['aria-label'], 'Send message');
    });

    it('does not show pre-stream dots over an active stream', () => {
        const { ctx } = loadInputModule();
        let shown = 0;
        ctx.showLoadingIndicator = () => { shown++; };
        ctx.streamState = { active: true };
        ctx.setChatButtonsEnabled(false);
        assert.strictEqual(shown, 0,
            'an active stream should keep its streaming UI');
    });

    it('clears the loading indicator when the composer is enabled (bug #215)', () => {
        const { ctx } = loadInputModule();
        let hidden = 0;
        ctx.hideLoadingIndicator = () => { hidden++; };
        ctx.setChatButtonsEnabled(true);
        assert.strictEqual(hidden, 1, 'enabling the composer must remove any visible loading dots');
    });

    it('fully resets the stream state when the composer is enabled (bug #219)', () => {
        const { ctx } = loadInputModule();
        // A mid-stream provider error posts only setChatButtonsEnabled(true);
        // the stale stream state used to keep the composer wedged in Stop mode.
        ctx.streamState = {
            active: true,
            bubble: { dataset: {} },
            contentDiv: {},
            thinkingDetails: {},
            contentBuffer: 'partial',
            thinkingBuffer: 'thinking'
        };
        ctx.setChatButtonsEnabled(true);
        assert.strictEqual(ctx.streamState.active, false, 'streamState.active must reset');
        assert.strictEqual(ctx.streamState.bubble, null);
        assert.strictEqual(ctx.streamState.contentDiv, null);
        assert.strictEqual(ctx.streamState.thinkingDetails, null);
        assert.strictEqual(ctx.streamState.contentBuffer, '');
        assert.strictEqual(ctx.streamState.thinkingBuffer, '');
    });

    it('does nothing when input is empty and there are no attachments (bug #77)', () => {
        const { ctx, postedMessages } = loadInputModule();
        ctx.isLoading = false;
        ctx.chatMessages = [{ role: 'assistant', content: 'old reply', id: 'm1' }];
        let retried = 0;
        ctx.retryLastAssistantMessage = () => { retried++; };
        const origGetEl = ctx.document.getElementById;
        ctx.document.getElementById = (id) => {
            if (id === 'chat-input') return { value: '', style: {}, disabled: false, focus: () => {} };
            return origGetEl(id);
        };
        ctx.onChatSend();
        assert.strictEqual(postedMessages.length, 0, 'empty Send must not post anything');
        assert.strictEqual(retried, 0, 'empty Send must not retry the last message');
    });
});

describe('retryLastAssistantMessage', () => {
    it('does nothing when the visible thread is already generating', () => {
        const { ctx, postedMessages } = loadInputModule();
        ctx.activeThreadId = 't-A';
        ctx.setChatButtonsEnabled({ enabled: false, threadId: 't-A' });
        ctx.retryLastAssistantMessage('msg-1');
        assert.strictEqual(postedMessages.length, 0);
    });

    it('allows regenerate in chat B while chat A is generating', () => {
        const { ctx, postedMessages } = loadInputModule();
        ctx.setChatButtonsEnabled({ enabled: false, threadId: 't-A' });
        ctx.activeThreadId = 't-B';
        ctx.chatMessages = [
            { id: 'u1', role: 'user', content: 'q' },
            { id: 'a1', role: 'assistant', content: 'answer' }
        ];

        ctx.retryLastAssistantMessage('a1');

        assert.strictEqual(postedMessages.length, 1);
        const payload = JSON.parse(postedMessages[0]);
        assert.strictEqual(payload.action, 'retry');
        assert.strictEqual(payload.messageId, 'a1');
    });

    it('sends retry with messageId', () => {
        const { ctx, postedMessages } = loadInputModule();
        ctx.isLoading = false;
        ctx.chatMessages = [
            { id: 'u1', role: 'user', content: 'q' },
            { id: 'msg-1', role: 'assistant', content: 'a' }
        ];
        ctx.retryLastAssistantMessage('msg-1');
        const payload = JSON.parse(postedMessages[0]);
        assert.strictEqual(payload.action, 'retry');
        assert.strictEqual(payload.messageId, 'msg-1');
    });

    it('remembers the removed messages and restores them on a failed retry (bug #169)', () => {
        const { ctx } = loadInputModule();
        ctx.isLoading = false;
        ctx.chatMessages = [
            { id: 'u1', role: 'user', content: 'q' },
            { id: 'a1', role: 'assistant', content: 'original answer' },
            { id: 'u2', role: 'user', content: 'follow-up' },
            { id: 'a2', role: 'assistant', content: 'answer two' }
        ];
        ctx.retryLastAssistantMessage('a1');
        // The retried message and everything after it leave the view:
        assert.deepStrictEqual(ctx.chatMessages.map((m) => m.id), ['u1']);
        // The failed-retry error path restores them (the DB row was intact):
        ctx.restoreRetryMessagesOnError();
        assert.deepStrictEqual(ctx.chatMessages.map((m) => m.id), ['u1', 'a1', 'u2', 'a2']);
        // A second restore is a no-op (state cleared):
        ctx.restoreRetryMessagesOnError();
        assert.deepStrictEqual(ctx.chatMessages.map((m) => m.id), ['u1', 'a1', 'u2', 'a2']);
    });

    it('restores only the last assistant when retrying without a message id', () => {
        const { ctx } = loadInputModule();
        ctx.isLoading = false;
        ctx.chatMessages = [
            { id: 'u1', role: 'user', content: 'q' },
            { id: 'a1', role: 'assistant', content: 'original answer' }
        ];
        // removeLastAssistantMessage lives in chat-render.js; mirror its
        // behavior here so the retry path can be exercised.
        ctx.removeLastAssistantMessage = () => {
            for (var i = ctx.chatMessages.length - 1; i >= 0; i--) {
                if (ctx.chatMessages[i].role === 'assistant') { ctx.chatMessages.splice(i, 1); break; }
            }
        };
        ctx.retryLastAssistantMessage('');
        assert.deepStrictEqual(ctx.chatMessages.map((m) => m.id), ['u1']);
        ctx.restoreRetryMessagesOnError();
        assert.deepStrictEqual(ctx.chatMessages.map((m) => m.id), ['u1', 'a1']);
    });

    it('does not restore thread A messages into thread B UI when the retry fails (bug #216)', () => {
        const { ctx } = loadInputModule();
        ctx.isLoading = false;
        ctx.activeThreadId = 't-A';
        ctx.chatMessages = [
            { id: 'u1', role: 'user', content: 'q' },
            { id: 'a1', role: 'assistant', content: 'first answer' }
        ];
        ctx.retryLastAssistantMessage('a1');
        assert.deepStrictEqual(ctx.chatMessages.map((m) => m.id), ['u1'], 'retry truncates the UI path');
        // Switch to thread B while the retry is in flight - its array replaces
        // the global chatMessages (what initChatMode does on loadThread).
        ctx.activeThreadId = 't-B';
        ctx.chatMessages = [{ id: 'u1b', role: 'user', content: 'question for B' }];
        ctx.restoreRetryMessagesOnError();
        assert.deepStrictEqual(ctx.chatMessages.map((m) => m.id), ['u1b'],
            'thread B UI must NOT gain thread A messages on the failed retry');
        assert.strictEqual(ctx._retryRemovedMessages, null, 'pending restore state must be cleared');
    });

    it('skips the restore when the retry thread was reloaded from the DB (anchor mismatch)', () => {
        const { ctx } = loadInputModule();
        ctx.isLoading = false;
        ctx.activeThreadId = 't-A';
        ctx.chatMessages = [
            { id: 'u1', role: 'user', content: 'q' },
            { id: 'a1', role: 'assistant', content: 'first answer' }
        ];
        ctx.retryLastAssistantMessage('a1');
        assert.deepStrictEqual(ctx.chatMessages.map((m) => m.id), ['u1']);
        // A reload from the DB repopulates the full path (including a1).
        ctx.chatMessages = [
            { id: 'u1', role: 'user', content: 'q' },
            { id: 'a1', role: 'assistant', content: 'first answer' }
        ];
        ctx.restoreRetryMessagesOnError();
        assert.deepStrictEqual(ctx.chatMessages.map((m) => m.id), ['u1', 'a1'],
            'restoring again after a DB reload must not duplicate the messages');
    });

    it('restores into the same thread/path when the retry fails there (bug #216 regression)', () => {
        const { ctx } = loadInputModule();
        ctx.isLoading = false;
        ctx.activeThreadId = 't-A';
        ctx.chatMessages = [
            { id: 'u1', role: 'user', content: 'q' },
            { id: 'a1', role: 'assistant', content: 'first answer' }
        ];
        ctx.retryLastAssistantMessage('a1');
        assert.deepStrictEqual(ctx.chatMessages.map((m) => m.id), ['u1']);
        // Retry fails while the user is still on thread A's truncated path.
        ctx.restoreRetryMessagesOnError();
        assert.deepStrictEqual(ctx.chatMessages.map((m) => m.id), ['u1', 'a1']);
    });
});
