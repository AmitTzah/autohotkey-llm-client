// mermaid-renderer.test.js - Lazy Mermaid DOM rendering tests.
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function makeElement(tag) {
  return {
    tagName: tag || 'div',
    className: '',
    textContent: '',
    innerHTML: '',
    isConnected: true,
    children: [],
    attrs: {},
    classList: {
      values: new Set(),
      add(value) { this.values.add(value); },
      contains(value) { return this.values.has(value); }
    },
    getAttribute(name) { return this.attrs[name] || ''; },
    setAttribute(name, value) { this.attrs[name] = String(value); },
    querySelector(selector) {
      if (selector === '.mermaid-source') return this.sourceEl || null;
      if (selector === '.mermaid-error-message') {
        return this.children.find((child) => child.className === 'mermaid-error-message') || null;
      }
      return null;
    },
    querySelectorAll() { return []; },
    appendChild(child) { this.children.push(child); return child; },
    matches(selector) {
      return selector === '.mermaid-diagram[data-mermaid-state="pending"]' &&
        this.className === 'mermaid-diagram' &&
        this.attrs['data-mermaid-state'] === 'pending';
    }
  };
}

function makeDiagram(source) {
  const node = makeElement('div');
  node.className = 'mermaid-diagram';
  node.attrs['data-mermaid-state'] = 'pending';
  node.sourceEl = makeElement('pre');
  node.sourceEl.className = 'mermaid-source';
  node.sourceEl.textContent = source;
  return node;
}

function loadModule() {
  const src = fs.readFileSync(path.resolve(__dirname, '..', '..', 'webui', 'js', 'shared', 'mermaid-renderer.js'), 'utf8');
  const warnings = [];
  const document = {
    documentElement: {},
    body: {},
    createElement: (tag) => makeElement(tag),
    querySelectorAll: () => []
  };
  const sandbox = {
    document,
    console: { warn: (...args) => warnings.push(args) },
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    Promise
  };
  sandbox.window = sandbox;
  vm.runInContext(src, vm.createContext(sandbox));
  return { sandbox, warnings };
}

describe('MermaidRenderer', () => {
  it('pins a specific Mermaid module version', () => {
    const ctx = loadModule();
    assert.match(ctx.sandbox.MermaidRenderer.moduleUrl, /^https:\/\/cdn\.jsdelivr\.net\/npm\/mermaid@11\.17\.2\/dist\/mermaid\.esm\.min\.mjs$/);
  });

  it('renders a pending diagram as SVG with strict Mermaid security', async () => {
    const ctx = loadModule();
    const configs = [];
    const renders = [];
    const mermaid = {
      initialize(config) { configs.push(config); },
      render(id, source) {
        renders.push({ id, source });
        return Promise.resolve({ svg: '<svg><text>ok</text></svg>' });
      }
    };

    ctx.sandbox.MermaidRenderer.init({ loadMermaid: () => Promise.resolve(mermaid) });

    const node = makeDiagram('graph TD\n  A --> B');
    const rendered = await ctx.sandbox.MermaidRenderer.renderDiagram(node);

    assert.strictEqual(rendered, true);
    assert.strictEqual(node.getAttribute('data-mermaid-state'), 'rendered');
    assert.ok(node.classList.contains('mermaid-rendered'));
    assert.match(node.innerHTML, /^<svg>/);
    assert.strictEqual(renders.length, 1);
    assert.strictEqual(renders[0].source, 'graph TD\n  A --> B');
    assert.strictEqual(configs.length, 1);
    assert.strictEqual(configs[0].securityLevel, 'strict');
    assert.strictEqual(configs[0].startOnLoad, false);
  });

  it('keeps source visible and marks the diagram when Mermaid fails', async () => {
    const ctx = loadModule();
    const mermaid = {
      initialize() {},
      render() { return Promise.reject(new Error('bad syntax')); }
    };
    ctx.sandbox.MermaidRenderer.init({ loadMermaid: () => Promise.resolve(mermaid) });

    const node = makeDiagram('not a valid diagram');
    const rendered = await ctx.sandbox.MermaidRenderer.renderDiagram(node);

    assert.strictEqual(rendered, false);
    assert.strictEqual(node.getAttribute('data-mermaid-state'), 'error');
    assert.ok(node.classList.contains('mermaid-error'));
    assert.strictEqual(node.sourceEl.textContent, 'not a valid diagram');
    assert.ok(node.querySelector('.mermaid-error-message'));
    assert.strictEqual(ctx.warnings.length, 1);
  });

  it('does not paint late async output into a detached streaming node', async () => {
    const ctx = loadModule();
    let resolveRender;
    const mermaid = {
      initialize() {},
      render() {
        return new Promise((resolve) => { resolveRender = resolve; });
      }
    };
    ctx.sandbox.MermaidRenderer.init({ loadMermaid: () => Promise.resolve(mermaid) });

    const node = makeDiagram('graph LR\nA --> B');
    const pending = ctx.sandbox.MermaidRenderer.renderDiagram(node);
    for (let i = 0; i < 5 && !resolveRender; i++) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.strictEqual(typeof resolveRender, 'function', 'Mermaid render should have started');
    node.isConnected = false;
    resolveRender({ svg: '<svg>stale</svg>' });

    const rendered = await pending;
    assert.strictEqual(rendered, false);
    assert.strictEqual(node.innerHTML, '');
    assert.strictEqual(node.getAttribute('data-mermaid-state'), 'rendering');
  });
});
