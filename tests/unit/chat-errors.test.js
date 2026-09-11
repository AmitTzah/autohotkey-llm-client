// chat-errors.test.js
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadModule() {
  const src = fs.readFileSync(path.resolve(__dirname, '..', '..', 'webui', 'js', 'chat', 'chat-errors.js'), 'utf8');
  const chatMessages = {
    children: [],
    scrollTop: 0,
    scrollHeight: 100,
    appendChild(el) { this.children.push(el); }
  };
  const sandbox = {
    activeThreadId: 'thread-b',
    document: {
      getElementById: (id) => id === 'chat-messages' ? chatMessages : null,
      createElement: () => ({
        className: '',
        dataset: {},
        style: {},
        innerHTML: '',
        remove() {}
      })
    },
    hideLoadingIndicator() {},
    restoreRetryMessagesOnError() {},
    console
  };
  sandbox.window = sandbox;
  vm.runInContext(src, vm.createContext(sandbox));
  return { sandbox, chatMessages };
}

describe('ChatErrors', () => {
  it('queues foreign-thread errors without painting them into the active chat', () => {
    const ctx = loadModule();
    ctx.sandbox.ChatErrors.showError({ message: 'A failed', threadId: 'thread-a' });
    assert.strictEqual(ctx.chatMessages.children.length, 0);

    ctx.sandbox.ChatErrors.renderThreadErrorBanners(ctx.chatMessages, 'thread-a');
    assert.strictEqual(ctx.chatMessages.children.length, 1);
    assert.strictEqual(ctx.chatMessages.children[0].dataset.threadId, 'thread-a');
  });

  it('renders active-thread errors immediately', () => {
    const ctx = loadModule();
    ctx.sandbox.ChatErrors.showError({ message: 'B failed', threadId: 'thread-b' });
    assert.strictEqual(ctx.chatMessages.children.length, 1);
    assert.strictEqual(ctx.chatMessages.children[0].dataset.threadId, 'thread-b');
  });

  it('keeps compatibility globals for existing render/click paths', () => {
    const ctx = loadModule();
    assert.strictEqual(ctx.sandbox.showError, ctx.sandbox.ChatErrors.showError);
    assert.strictEqual(ctx.sandbox.dismissThreadError, ctx.sandbox.ChatErrors.dismissThreadError);
    assert.strictEqual(ctx.sandbox._renderThreadErrorBanners, ctx.sandbox.ChatErrors.renderThreadErrorBanners);
  });
});
