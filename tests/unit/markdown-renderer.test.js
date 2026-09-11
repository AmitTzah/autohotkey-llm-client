// markdown-renderer.test.js - Unit tests for shared Markdown/KaTeX rendering.
const { describe, it } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const renderer = require('../../webui/js/shared/markdown-renderer.js');
const vendorDir = path.resolve(__dirname, '..', '..', 'webui', 'js', 'vendor');
const markdownit = require(path.join(vendorDir, 'markdown-it.min.js'));
const katex = require(path.join(vendorDir, 'katex.min.js'));
const texmath = require(path.join(vendorDir, 'texmath.min.js'));
const hljs = require(path.join(vendorDir, 'highlight.min.js'));

function createRenderer() {
  return renderer.create({ markdownit, katex, texmath, hljs });
}

describe('MarkdownRenderer', () => {
  it('keeps raw HTML inert', () => {
    const md = createRenderer();
    const html = md.render('<script>alert("x")</script>');
    assert.ok(!html.includes('<script>'), 'raw HTML must never become active markup');
    assert.ok(html.includes('&lt;script&gt;'), 'raw HTML should be escaped');
  });

  it('preserves single-newline prose breaks and fenced-code newlines', () => {
    const md = createRenderer();
    const html = md.render('First paragraph.\nSecond paragraph.\nThird paragraph.');
    assert.ok(/<br\s*\/?>/i.test(html), 'single newlines must render as <br>: ' + html);

    const code = md.render('```js\nconst a = 1;\nconst b = 2;\n```\nDone\nNext');
    const codeText = code.replace(/<[^>]+>/g, '');
    assert.ok(/const a = 1;\nconst b = 2;/.test(codeText), 'code blocks must preserve internal newlines: ' + code);
    assert.ok(/<br\s*\/?>/i.test(code), 'prose after the code block must retain soft breaks');
    assert.ok(code.includes('code-block-wrapper'), 'code blocks must keep AhkLLM actions/header markup');
  });

  it('renders dollar and bracket LaTeX through KaTeX', () => {
    const md = createRenderer();
    const cases = [
      '$E = mc^2$',
      '$$\\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}$$',
      '\\(a^2 + b^2 = c^2\\)',
      '\\[\n\\sum_{n=1}^{\\infty} \\frac{1}{n^2} = \\frac{\\pi^2}{6}\n\\]'
    ];

    for (const input of cases) {
      const html = md.render(input);
      assert.match(html, /class="katex(?:\s|"|-)/, 'expected KaTeX markup for: ' + input + '\n' + html);
    }
  });

  it('renders bracket display math immediately after prose', () => {
    const md = createRenderer();
    const input = 'Display brackets:\n\\[\n\\sum_{n=1}^{\\infty} \\frac{1}{n^2} = \\frac{\\pi^2}{6}\n\\]';
    const html = md.render(input);
    assert.match(html, /class="katex-display"/, 'expected display KaTeX markup: ' + html);
    assert.ok(!html.includes('\\[') && !html.includes('\\]'), 'bracket delimiters must not remain visible: ' + html);
  });

  it('normalizes bracket display boundaries without modifying code examples', () => {
    const input = 'Display brackets:\n\\[\n\\sum_{n=1}^{\\infty} n^{-2}\n\\]';
    assert.strictEqual(
      renderer.normalizeBracketDisplayMath(input),
      'Display brackets:\n\n\\[\n\\sum_{n=1}^{\\infty} n^{-2}\n\\]'
    );

    const fenced = '```text\n\\[\nx^2\n\\]\n```';
    assert.strictEqual(renderer.normalizeBracketDisplayMath(fenced), fenced);

    const indented = '    \\[\n    x^2\n    \\]';
    assert.strictEqual(renderer.normalizeBracketDisplayMath(indented), indented);
  });

  it('escapes unknown code languages and code content', () => {
    const md = createRenderer();
    const html = md.render('```<bad>\n<x>&y\n```');
    assert.ok(html.includes('&lt;bad&gt;'), 'language label must be escaped: ' + html);
    assert.ok(html.includes('&lt;x&gt;&amp;y'), 'fallback code content must be escaped: ' + html);
  });
});
