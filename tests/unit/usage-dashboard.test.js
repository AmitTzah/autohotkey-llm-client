// usage-dashboard.test.js — Unit tests for usage-dashboard.js: data rendering + CSV export
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { installIpc } = require('./helpers/ipc-test-utils');

function loadDashboardModule() {
    const src = fs.readFileSync(path.resolve(__dirname, '..', '..', 'webui', 'js', 'usage-dashboard.js'), 'utf-8');
    let hostObjectCalled = false;
    let hostObjectFilters = null;
    // getElementById must return the SAME element for a given id so tests can
    // set a value (e.g. the time range) and have the module read it back.
    const els = {};
    const makeElement = () => ({
        textContent: '', innerHTML: '', value: '', title: '', style: {},
        classList: { add: function() {}, remove: function() {}, contains: function() { return false; } },
        addEventListener: function() {},
        querySelector: function() { return { dataset: { mode: 'model' }, classList: { add: function() {}, remove: function() {} } }; },
        querySelectorAll: function() { return []; },
        getContext: function() { return { createLinearGradient: () => ({}), fillRect: () => {}, fillText: () => {}, beginPath: () => {}, arc: () => {}, fill: () => {}, stroke: () => {}, moveTo: () => {}, lineTo: () => {}, setLineDash: () => {}, clearRect: () => {}, save: () => {}, restore: () => {}, measureText: () => ({ width: 10 }), canvas: { width: 100, height: 100 } }; },
        appendChild: function() {},
        getAttribute: function() { return null; },
        setAttribute: function() {},
        closest: function() { return null; },
        remove: function() {}
    });
    const sandbox = {
        document: {
            getElementById: (id) => {
                if (!els[id]) els[id] = makeElement();
                return els[id];
            },
            querySelector: function(sel) {
                return { dataset: { mode: 'model' }, classList: { add: function() {}, remove: function() {} }, querySelectorAll: function() { return []; }, addEventListener: function() {} };
            },
            querySelectorAll: function() { return []; },
            createElement: function(tag) {
                return { tagName: tag, textContent: '', innerHTML: '', style: {},
                    getContext: function() { return { createLinearGradient: () => ({}), fillRect: () => {}, fillText: () => {}, beginPath: () => {}, arc: () => {}, fill: () => {}, stroke: () => {}, moveTo: () => {}, lineTo: () => {}, setLineDash: () => {}, clearRect: () => {}, save: () => {}, restore: () => {}, measureText: () => ({ width: 10 }), canvas: { width: 100, height: 100 } }; },
                    appendChild: function() {}, addEventListener: function() {}
                };
            }
        },
        window: { chrome: { webview: { postMessage: () => {} } }, addEventListener: () => {} },
        Chart: function() { return { destroy: function() {}, data: {}, options: {}, update: () => {} }; },
        chrome: { webview: { hostObjects: { Dashboard: { QueryUsage: async (filtersJson) => { hostObjectCalled = true; hostObjectFilters = JSON.parse(filtersJson); return JSON.stringify({ chat: [], commands: [], models: [], providers: [] }); } } } } },
        Blob: function(parts, opts) { return { parts: parts, opts: opts }; },
        URL: { createObjectURL: () => 'blob:test', revokeObjectURL: () => {} },
        setTimeout: () => {}, clearTimeout: () => {},
        allData: null, mainChart: null, MODEL_COLORS: [],
        console: console, Number: Number, String: String
    };
    sandbox.global = sandbox;
    sandbox._hostObjectCalled = () => hostObjectCalled;
    sandbox._hostObjectFilters = () => hostObjectFilters;
    const ctx = vm.createContext(sandbox);
    installIpc(ctx);
    vm.runInContext(src, ctx);
    return sandbox;
}

describe('fmtNum', () => {
    it('formats millions with m suffix', () => {
        const ctx = loadDashboardModule();
        assert.strictEqual(ctx.fmtNum(1500000), '1.5m');
    });

    it('formats thousands with k suffix', () => {
        const ctx = loadDashboardModule();
        assert.strictEqual(ctx.fmtNum(4500), '4.5k');
    });

    it('formats small numbers as-is', () => {
        const ctx = loadDashboardModule();
        assert.strictEqual(ctx.fmtNum(42), '42');
    });

    it('formats zero', () => {
        const ctx = loadDashboardModule();
        assert.strictEqual(ctx.fmtNum(0), '0');
    });
});

describe('fmtCost', () => {
    it('formats to 4 decimal places', () => {
        const ctx = loadDashboardModule();
        assert.strictEqual(ctx.fmtCost(0.00125), '$0.0013');
    });

    it('handles zero', () => {
        const ctx = loadDashboardModule();
        assert.strictEqual(ctx.fmtCost(0), '$0.0000');
    });
});

describe('fmtCostShort', () => {
    it('shows 2 decimals for costs >= 1', () => {
        const ctx = loadDashboardModule();
        assert.strictEqual(ctx.fmtCostShort(5.123), '$5.12');
    });

    it('shows 4 decimals for costs >= 0.01', () => {
        const ctx = loadDashboardModule();
        assert.strictEqual(ctx.fmtCostShort(0.0123), '$0.0123');
    });

    it('shows 6 decimals for small costs', () => {
        const ctx = loadDashboardModule();
        assert.strictEqual(ctx.fmtCostShort(0.000123), '$0.000123');
    });
});

describe('extractProvider', () => {
    it('extracts provider from provider/model format', () => {
        const ctx = loadDashboardModule();
        assert.strictEqual(ctx.extractProvider('deepseek/deepseek-v4'), 'deepseek');
    });

    it('returns empty for no provider prefix', () => {
        const ctx = loadDashboardModule();
        assert.strictEqual(ctx.extractProvider('gpt-4o'), '');
    });
});

describe('getDateRangeLabels', () => {
    it('returns 365 labels for all time', () => {
        const ctx = loadDashboardModule();
        const lbls = ctx.getDateRangeLabels();
        assert.ok(lbls.length >= 365);
    });

    // Regression: "All Time" used the catch-all 365-day branch, so usage older
    // than a year was summed in the summary but never shown on the chart.
    it('all-time labels span the full history (oldest row through today)', () => {
        const ctx = loadDashboardModule();
        ctx.document.getElementById('timeRange').value = 'all';
        const now = new Date();
        const d400 = new Date(now);
        d400.setDate(d400.getDate() - 400);
        // Local date key, matching how getDateRangeLabels derives labels
        // (toISOString would shift a day in UTC+x timezones - bug #42).
        const oldest = d400.getFullYear() + '-' +
            String(d400.getMonth() + 1).padStart(2, '0') + '-' +
            String(d400.getDate()).padStart(2, '0');
        ctx.allData = { chat: [{ date: oldest, total_cost: 5 }], commands: [] };

        const lbls = ctx.getDateRangeLabels();

        // Oldest row is 400 days before today, so the chart needs 401 labels.
        assert.strictEqual(lbls.length, 401, 'all-time chart must span oldest->today');
        const last = new Date(lbls[lbls.length - 1] + 'T00:00:00');
        const first = new Date(lbls[0] + 'T00:00:00');
        assert.strictEqual(Math.round((last - first) / 86400000), 400, 'chart must start at the oldest data row');
    });

    it('all-time labels fall back to 365 days when there is no data', () => {
        const ctx = loadDashboardModule();
        ctx.document.getElementById('timeRange').value = 'all';
        ctx.allData = null;
        assert.strictEqual(ctx.getDateRangeLabels().length, 365);
    });

    it('all-time range keeps 30-day label count unchanged', () => {
        const ctx = loadDashboardModule();
        ctx.document.getElementById('timeRange').value = 'month';
        assert.strictEqual(ctx.getDateRangeLabels().length, 30);
    });
});

describe('renderSummary', () => {
    it('populates summary cards from data', () => {
        const ctx = loadDashboardModule();
        ctx.allData = {
            chat: [{ input_tokens: 500, output_tokens: 300, total_cost: 0.05, message_count: 3, total_response_time_ms: 1200, total_ttft_ms: 400, cached_input_cost: 0.001, input_cost: 0.02, output_cost: 0.03 }],
            commands: []
        };
        ctx.renderSummary();
        assert.ok(ctx.document.getElementById('totalCost').textContent !== undefined);
        assert.ok(ctx.document.getElementById('totalCalls').textContent !== undefined);
        assert.ok(ctx.document.getElementById('totalTokens').textContent !== undefined);
    });

    it('labels Codex subscription usage as zero API cost without implying unlimited usage', () => {
        const ctx = loadDashboardModule();
        ctx.allData = {
            chat: [{
                model: 'codex/gpt-5.6-luna', provider: 'codex', input_tokens: 50, output_tokens: 20,
                total_cost: 0, message_count: 2, cached_input_cost: 0, input_cost: 0, output_cost: 0,
                total_response_time_ms: 1000, total_ttft_ms: 0, ttft_count: 0
            }],
            commands: []
        };
        ctx.renderSummary();
        const tooltip = ctx.document.getElementById('costTooltip').textContent;
        assert.ok(tooltip.includes('ChatGPT Codex plan allowance'));
        assert.ok(tooltip.includes('normal Codex plan usage limits still apply'));
        assert.strictEqual(ctx.document.getElementById('totalCost').textContent, '$0.000000');
    });

    it('counts command completion_tokens once (thinking already included, bug #52)', () => {
        const ctx = loadDashboardModule();
        ctx.allData = {
            chat: [{
                input_tokens: 10, output_tokens: 100, total_cost: 0, message_count: 1,
                cached_input_cost: 0, input_cost: 0, output_cost: 0,
                total_response_time_ms: 0, total_ttft_ms: 0
            }],
            commands: [{
                prompt_tokens: 10, completion_tokens: 100, thinking_tokens: 40,
                total_cost: 0, call_count: 1, cached_input_cost: 0, input_cost: 0,
                output_cost: 0, total_response_time_ms: 0, total_ttft_ms: 0
            }]
        };
        ctx.renderSummary();
        // 110 (chat) + 110 (command, thinking already inside completion) = 220.
        // Double-counting the command's thinking would yield 260.
        assert.strictEqual(ctx.document.getElementById('totalTokens').textContent, '220');
    });

    it('averages TTFT only across calls with a measured TTFT', () => {
        const ctx = loadDashboardModule();
        ctx.allData = {
            chat: [{
                input_tokens: 10, output_tokens: 5, total_cost: 0, message_count: 1,
                total_response_time_ms: 1000, total_ttft_ms: 400, ttft_count: 1
            }],
            commands: [{
                prompt_tokens: 10, completion_tokens: 5, total_cost: 0, call_count: 1,
                total_response_time_ms: 1000, total_ttft_ms: 0, ttft_count: 0
            }]
        };
        ctx.renderSummary();
        assert.strictEqual(ctx.document.getElementById('ttftValue').textContent, '400ms');
    });
});

describe('populateFilters', () => {
    it('populates provider and model dropdowns', () => {
        const ctx = loadDashboardModule();
        ctx.allData = { chat: [], commands: [], models: ['deepseek/deepseek-v4'], providers: ['deepseek'] };
        ctx.populateFilters();
        assert.ok(true);  // Doesn't throw
    });

    it('escapes provider/model option values and labels (bug #82)', () => {
        const ctx = loadDashboardModule();
        ctx.allData = {
            chat: [], commands: [],
            providers: ['deepseek', '"><img src=x onerror=window.__x=1>'],
            models: ['deepseek-v4-flash', '"><svg onload=window.__y=1>']
        };
        ctx.populateFilters();
        const provHTML = ctx.document.getElementById('providerFilter').innerHTML;
        const modHTML = ctx.document.getElementById('modelFilter').innerHTML;
        assert.ok(!provHTML.includes('"><img'), 'provider option must be escaped, got ' + provHTML);
        assert.ok(!modHTML.includes('"><svg'), 'model option must be escaped, got ' + modHTML);
        assert.ok(provHTML.includes('&lt;img'), 'escaped provider label should render as text');
        assert.ok(modHTML.includes('&lt;svg'), 'escaped model label should render as text');
    });

    it('adds an Unknown (blank) provider option for rows with no provider (bug #168) using a reserved sentinel (bug #182)', () => {
        const ctx = loadDashboardModule();
        ctx.allData = {
            chat: [{ date: '2026-08-10', model: 'gpt-5', provider: '', input_tokens: 12, output_tokens: 9 }],
            commands: [],
            providers: ['deepseek'],
            models: ['gpt-5']
        };
        ctx.populateFilters();
        const provHTML = ctx.document.getElementById('providerFilter').innerHTML;
        assert.ok(provHTML.includes('value="__BLANK_PROVIDER__"'), 'blank-provider rows must be selectable via the reserved sentinel (bug #168/#182), got ' + provHTML);
        assert.ok(provHTML.includes('Unknown'), 'the unknown option should be labeled');
    });

    it('keeps a real provider named __unknown__ selectable by its own value (bug #182)', () => {
        const ctx = loadDashboardModule();
        ctx.allData = {
            chat: [{ date: '2026-08-10', model: 'real/__unknown__', provider: '__unknown__', input_tokens: 10, output_tokens: 5 }],
            commands: [],
            providers: ['__unknown__', 'deepseek'],
            models: ['real/__unknown__']
        };
        ctx.populateFilters();
        const provHTML = ctx.document.getElementById('providerFilter').innerHTML;
        // The real provider renders under its own value; the blank sentinel
        // option uses a DIFFERENT reserved value - no collision.
        assert.ok(provHTML.includes('<option value="__unknown__">__unknown__</option>'), 'real __unknown__ provider must be selectable, got ' + provHTML);
        const unknownCount = (provHTML.match(/value="__unknown__"/g) || []).length;
        assert.strictEqual(unknownCount, 1, 'exactly one __unknown__ option expected (no sentinel collision), got ' + provHTML);
        const blankCount = (provHTML.match(/value="__BLANK_PROVIDER__"/g) || []).length;
        assert.ok(blankCount === 0, 'no blank rows here, so no sentinel option expected, got ' + provHTML);
    });
});

describe('renderMainChart provider mode (bug #200)', () => {
    it('keys command rows by the model provider when provider is empty', () => {
        const sandbox = loadDashboardModule();
        let captured = null;
        sandbox.Chart = function(ctx, cfg) { captured = cfg; return { destroy: function() {}, update: function() {} }; };
        sandbox.document.querySelector = function() {
            return { dataset: { mode: 'provider' }, classList: { add: function() {}, remove: function() {} }, querySelectorAll: function() { return []; }, addEventListener: function() {} };
        };
        sandbox.allData = {
            chat: [],
            commands: [{
                date: '2026-08-12', model: 'deepseek/gpt-5', provider: '',
                prompt_tokens: 10, completion_tokens: 5, cached_tokens: 0,
                total_cost: 0.5
            }],
            providers: ['deepseek'],
            models: ['deepseek/gpt-5']
        };
        sandbox.mainChart = null;
        sandbox.renderMainChart();
        const labels = captured.data.datasets.map((d) => d.label);
        assert.ok(labels.indexOf('deepseek') >= 0, 'command row should chart under its model provider prefix: ' + JSON.stringify(labels));
        assert.ok(labels.indexOf('') < 0, 'empty provider must not create an unfilterable "" series (bug #200): ' + JSON.stringify(labels));
    });
});

describe('renderModelSections XSS (bug #95)', () => {
    it('escapes the model heading', () => {
        const ctx = loadDashboardModule();
        const container = ctx.document.getElementById('modelSections');
        let appended = null;
        container.appendChild = (child) => { appended = child; };
        ctx.allData = {
            chat: [{
                date: '2026-08-07', model: '"><img src=x onerror=window.__h=1>',
                provider: 'deepseek', output_tokens: 10, input_tokens: 5, message_count: 1,
                total_cost: 0, cached_input_cost: 0, input_cost: 0, output_cost: 0,
                total_response_time_ms: 0, total_ttft_ms: 0
            }],
            commands: [], models: [], providers: []
        };
        ctx.renderModelSections();
        assert.ok(appended, 'model section should be appended');
        const html = appended.innerHTML;
        assert.ok(!html.includes('"><img'), 'model heading must be escaped, got ' + html);
        assert.ok(html.includes('&lt;img'), 'model heading should render as escaped text');
    });
});

describe('loadData', () => {
    it('calls host object with filters', async () => {
        const ctx = loadDashboardModule();
        await ctx.loadData();
        assert.ok(ctx._hostObjectCalled());
        const filters = ctx._hostObjectFilters();
        assert.ok(filters.timeRange !== undefined);
        assert.ok(filters.type !== undefined);
    });
});

describe('csvField (bug #163)', () => {
    it('quotes fields containing commas, quotes, or line breaks (RFC-4180)', () => {
        const ctx = loadDashboardModule();
        assert.strictEqual(ctx.csvField('openai/gpt-5,beta'), '"openai/gpt-5,beta"');
        assert.strictEqual(ctx.csvField('say "hi"'), '"say ""hi"""');
        assert.strictEqual(ctx.csvField('a\nb'), '"a\nb"');
        assert.strictEqual(ctx.csvField('plain'), 'plain');
        assert.strictEqual(ctx.csvField(12), '12');
        assert.strictEqual(ctx.csvField(null), '');
    });
});
