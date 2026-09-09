// ======================================================
// usage-dashboard.js — Redesigned Usage Dashboard
// Chart.js for time-series, hover tooltips, per-model sections
// ======================================================

var allData = null, mainChart = null;

const MODEL_COLORS = ['#3b82f6','#f59e0b','#10b981','#ef4444','#8b5cf6','#ec4899','#06b6d4','#84cc16','#f97316','#6366f1'];
var modelColors = {};

// Provider/model names are user-controlled; escape them before HTML insertion.
// injecting into HTML (filter dropdown options).
function escHtml(s) {
  if (s === undefined || s === null) return '';
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Generate array of date strings (YYYY-MM-DD) for the selected time range
function getDateRangeLabels() {
  var range = document.getElementById('timeRange').value;
  var labels = [];
  var today = new Date();
  var days;
  // Local date key (YYYY-MM-DD) - toISOString() shifts labels a day in UTC+x
  // timezones because local midnight can still be the previous UTC day.
  function localDateKey(d) {
    var m = String(d.getMonth() + 1);
    var day = String(d.getDate());
    return d.getFullYear() + '-' + (m.length < 2 ? '0' + m : m) + '-' + (day.length < 2 ? '0' + day : day);
  }
  if (range === 'day') days = 1;
  else if (range === 'thisMonth') {
    days = new Date(today.getFullYear(), today.getMonth()+1, 0).getDate();
    today = new Date(today.getFullYear(), today.getMonth()+1, 0);
  } else if (range === 'lastMonth') {
    var lastDay = new Date(today.getFullYear(), today.getMonth(), 0);
    days = lastDay.getDate();
    today = lastDay;
  } else if (range === 'month') days = 30;
  else if (range === 'all') {
    // "All Time" — cover the full history: from the oldest recorded date
    // through today. Without any data, fall back to 365 days.
    days = 365;
    var oldest = null;
    if (allData) {
      for (var i = 0; i < allData.chat.length; i++) {
        var chatDate = allData.chat[i].date;
        if (chatDate && (!oldest || chatDate < oldest)) oldest = chatDate;
      }
      for (var i = 0; i < allData.commands.length; i++) {
        var cmdDate = allData.commands[i].date;
        if (cmdDate && (!oldest || cmdDate < oldest)) oldest = cmdDate;
      }
    }
    if (oldest) {
      var end = new Date(today.getFullYear(), today.getMonth(), today.getDate());
      var start = new Date(oldest + 'T00:00:00');
      days = Math.round((end - start) / 86400000) + 1;
      if (days < 1) days = 1;
    }
  } else days = 365;
  for (var i = days-1; i >= 0; i--) {
    var d = new Date(today);
    d.setDate(d.getDate() - i);
    labels.push(localDateKey(d));
  }
  return labels;
}

function getColor(model, idx) {
  if (!modelColors[model]) modelColors[model] = MODEL_COLORS[Object.keys(modelColors).length % MODEL_COLORS.length];
  return modelColors[model];
}

function fmtNum(n) {
  if (n >= 1000000) return (n/1000000).toFixed(1)+'m';
  if (n >= 1000) return (n/1000).toFixed(1)+'k';
  return String(Math.round(n) || 0);
}

function fmtCost(n) { return '$'+Number(n||0).toFixed(4); }

function fmtCostShort(n) {
  n = Number(n||0);
  if (n >= 1) return '$'+n.toFixed(2);
  if (n >= 0.01) return '$'+n.toFixed(4);
  return '$'+n.toFixed(6);
}

async function loadData() {
  var filters = {
    timeRange: document.getElementById('timeRange').value,
    model: document.getElementById('modelFilter').value,
    provider: document.getElementById('providerFilter').value,
    type: document.getElementById('typeFilter').value
  };
  try {
    var json = await chrome.webview.hostObjects.Dashboard.QueryUsage(JSON.stringify(filters));
    allData = JSON.parse(json);
  } catch(e) {
    allData = { chat: [], commands: [], models: [], providers: [] };
  }
  renderAll();
}

function renderAll() {
  if (!allData) return;
  renderSummary();
  renderMainChart();
  renderModelSections();
  populateFilters();
}

function renderSummary() {
  var cost = 0, calls = 0, tokens = 0, responseTimeMs = 0, ttftMs = 0, ttftCalls = 0, outputTokens = 0, codexCalls = 0;
  var costBreakdown = { cacheHit: 0, cacheMiss: 0, output: 0 };
  for (var i=0; i<allData.chat.length; i++) {
    var c = allData.chat[i];
    tokens += (c.input_tokens||0) + (c.output_tokens||0);
    outputTokens += (c.output_tokens||0);
    cost += (c.total_cost||0);
    calls += (c.message_count||0);
    if ((c.provider || extractProvider(c.model)) === 'codex') codexCalls += (c.message_count||0);
    responseTimeMs += (c.total_response_time_ms||0);
    ttftMs += (c.total_ttft_ms||0);
    ttftCalls += (c.ttft_count||0);
    costBreakdown.cacheHit += (c.cached_input_cost||0);
    costBreakdown.cacheMiss += (c.input_cost||0) - (c.cached_input_cost||0);
    costBreakdown.output += (c.output_cost||0);
  }
  for (var i=0; i<allData.commands.length; i++) {
    var c = allData.commands[i];
    // command_usage.completion_tokens already includes thinking tokens.
    // (same as chat's output_tokens), so adding thinking_tokens would
    // double-count it.
    var cmdOutput = (c.completion_tokens||0);
    tokens += (c.prompt_tokens||0) + cmdOutput;
    outputTokens += cmdOutput;
    cost += (c.total_cost||0);
    calls += (c.call_count||0);
    if ((c.provider || extractProvider(c.model)) === 'codex') codexCalls += (c.call_count||0);
    responseTimeMs += (c.total_response_time_ms||0);
    ttftMs += (c.total_ttft_ms||0);
    ttftCalls += (c.ttft_count||0);
    costBreakdown.cacheHit += (c.cached_input_cost||0);
    costBreakdown.cacheMiss += (c.input_cost||0) - (c.cached_input_cost||0);
    costBreakdown.output += (c.output_cost||0);
  }
  document.getElementById('totalCost').textContent = fmtCostShort(cost);
  var infoIcon = document.getElementById('costInfoIcon');
  var tooltip = document.getElementById('costTooltip');
  if (infoIcon && tooltip) {
    var pct = function(v) { return cost > 0 ? ' (' + Math.round(v / cost * 100) + '%)' : ''; };
    tooltip.textContent = 'Cache hit:  ' + fmtCost(costBreakdown.cacheHit) + pct(costBreakdown.cacheHit) + '\n' +
      'Cache miss: ' + fmtCost(Math.max(0, costBreakdown.cacheMiss)) + pct(Math.max(0, costBreakdown.cacheMiss)) + '\n' +
      'Output:     ' + fmtCost(costBreakdown.output) + pct(costBreakdown.output) +
      (codexCalls > 0 ? '\n\nCodex CLI: ' + codexCalls + ' request' + (codexCalls === 1 ? '' : 's') + ' used your ChatGPT Codex plan allowance. AhkLLM records $0 API cost for those requests; normal Codex plan usage limits still apply.' : '');
  }
  document.getElementById('totalCalls').textContent = fmtNum(calls);
  document.getElementById('totalTokens').textContent = fmtNum(tokens);

  // Speed box
  var speedEl = document.getElementById('speedValue');
  var ttftEl = document.getElementById('ttftValue');
  if (calls > 0 && responseTimeMs > 0) {
    var speed = Math.round(outputTokens / (responseTimeMs / 1000));
    speedEl.textContent = fmtNum(speed) + ' tok/s';

    var avgTtftMs = ttftCalls > 0 ? ttftMs / ttftCalls : 0;
    var ttftDisplay = avgTtftMs >= 1000 ? (avgTtftMs / 1000).toFixed(1) + 's' : Math.round(avgTtftMs) + 'ms';
    ttftEl.textContent = ttftDisplay;
  } else {
    speedEl.textContent = '—';
    ttftEl.textContent = '—';
  }
}

function renderMainChart() {
  if (mainChart) mainChart.destroy();
  var ctx = document.getElementById('mainChart').getContext('2d');
  var mode = document.querySelector('#stackToggle .active').dataset.mode;

  var dateLabels = getDateRangeLabels();
  var days = {}, allKeys = [];
  for (var i=0; i<allData.chat.length; i++) {
    var c = allData.chat[i], d = c.date;
    var key = mode==='provider' ? (c.provider||extractProvider(c.model)) : c.model;
    if (!days[d]) days[d] = {};
    if (!days[d][key]) days[d][key] = 0;
    days[d][key] += (c.total_cost||0);
    if (allKeys.indexOf(key)===-1) allKeys.push(key);
  }
  for (var i=0; i<allData.commands.length; i++) {
    var c = allData.commands[i], d = c.date;
    // Command rows use the same provider fallback as chat rows.
    // (extractProvider(c.model)) - otherwise a command row with provider=""
    // and model="deepseek/gpt-5" charts under an "" series that no filter
    // option can select.
    var key = mode==='provider' ? (c.provider||extractProvider(c.model)) : c.model;
    if (!days[d]) days[d] = {};
    if (!days[d][key]) days[d][key] = 0;
    days[d][key] += (c.total_cost||0);
    if (allKeys.indexOf(key)===-1) allKeys.push(key);
  }

  var datasets = [];
  for (var k=0; k<allKeys.length; k++) {
    var data = [];
    for (var i=0; i<dateLabels.length; i++) data.push((days[dateLabels[i]]||{})[allKeys[k]]||0);
    datasets.push({ label: allKeys[k], data: data, backgroundColor: getColor(allKeys[k],k), borderWidth: 0 });
  }

  mainChart = new Chart(ctx, {
    type: 'bar', data: { labels: dateLabels, datasets: datasets },
    options: {
      responsive: true, maintainAspectRatio: false,
      scales: { x: { stacked: true, grid: { display: false } }, y: { stacked: true, title: { display: true, text: 'USD' }, beginAtZero: true } },
      plugins: { legend: { display: true, position: 'bottom', labels: { boxWidth: 12, font: { size: 10 } } },
        tooltip: {
          backgroundColor: '#fff', titleColor: '#1a1a2e', bodyColor: '#1a1a2e', borderColor: '#e0e0e0', borderWidth: 1,
          callbacks: {
            label: function(ctx) {
              if (!ctx.raw) return null;
              return ctx.dataset.label+': $'+Number(ctx.raw).toFixed(4);
            }
          }
        } }
    }
  });
}

function renderModelSections() {
  var container = document.getElementById('modelSections');
  container.innerHTML = '';
  var dateLabels = getDateRangeLabels();

  var models = {};
  for (var i=0; i<allData.chat.length; i++) {
    var m = allData.chat[i].model; if (!m) continue;
    if (!models[m]) models[m] = { requests: {}, cacheHit: {}, cacheMiss: {}, output: {} };
    var d = allData.chat[i].date;
    var ck = allData.chat[i].cached_tokens||0;
    var inp = allData.chat[i].input_tokens||0;
    models[m].requests[d] = (models[m].requests[d]||0) + (allData.chat[i].message_count||0);
    models[m].cacheHit[d] = (models[m].cacheHit[d]||0) + ck;
    models[m].cacheMiss[d] = (models[m].cacheMiss[d]||0) + Math.max(0, inp - ck);
    models[m].output[d] = (models[m].output[d]||0) + (allData.chat[i].output_tokens||0);
  }
  for (var i=0; i<allData.commands.length; i++) {
    var c = allData.commands[i]; var m = c.model; if (!m) continue;
    if (!models[m]) models[m] = { requests: {}, cacheHit: {}, cacheMiss: {}, output: {} };
    var d = c.date;
    var cmdCached = c.cached_tokens||0;
    var cmdPrompt = c.prompt_tokens||0;
    models[m].requests[d] = (models[m].requests[d]||0) + (c.call_count||0);
    models[m].cacheHit[d] = (models[m].cacheHit[d]||0) + cmdCached;
    models[m].cacheMiss[d] = (models[m].cacheMiss[d]||0) + Math.max(0, cmdPrompt - cmdCached);
    // completion_tokens already includes thinking; do not add it again.
    models[m].output[d] = (models[m].output[d]||0) + (c.completion_tokens||0);
  }

  var entries = Object.entries(models);
  if (!entries.length) { container.innerHTML = '<div style="color:#6b7280;font-size:0.8rem;">No model data for selected filters.</div>'; return; }

  for (var e=0; e<entries.length; e++) {
    var model = entries[e][0], data = entries[e][1];

    var reqData = [], cacheHit = [], cacheMiss = [], output = [];
    for (var i=0; i<dateLabels.length; i++) {
      var d = dateLabels[i];
      reqData.push(data.requests[d]||0);
      cacheHit.push(data.cacheHit[d]||0);
      cacheMiss.push(data.cacheMiss[d]||0);
      output.push(data.output[d]||0);
    }

    var color = getColor(model, e);
    var div = document.createElement('div'); div.className = 'model-section chart-card';
    // Model ids are user-controlled; escape the heading.
    div.innerHTML = '<h6>'+escHtml(model)+'</h6><div class="row"><div class="col-md-6"><div class="chart-container-sm" style="overflow:hidden"><canvas id="req-'+e+'"></canvas></div></div><div class="col-md-6"><div class="chart-container-sm" style="overflow:hidden"><canvas id="tok-'+e+'"></canvas></div></div></div>';
    container.appendChild(div);

    // Requests — smooth area chart
    new Chart(document.getElementById('req-'+e).getContext('2d'), {
      type: 'line',
      data: { labels: dateLabels, datasets: [{ label: 'Requests', data: reqData, borderColor: color, backgroundColor: color+'20', fill: true, tension: 0.3, pointRadius: 3, pointHoverRadius: 5, borderWidth: 2 }] },
      options: { responsive: true, maintainAspectRatio: false, scales: { x: { grid: { display: false } }, y: { beginAtZero: true, title: { display: true, text: 'Requests' } } }, plugins: { legend: { display: false } } }
    });
    // Tokens — stacked bars with full date range
    new Chart(document.getElementById('tok-'+e).getContext('2d'), {
      type: 'bar',
      data: {
        labels: dateLabels,
        datasets: [
          { label: 'Input (Cache hit)', data: cacheHit, backgroundColor: '#86efac' },
          { label: 'Input (Cache miss)', data: cacheMiss, backgroundColor: '#93c5fd' },
          { label: 'Output', data: output, backgroundColor: color }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        scales: {
          x: { stacked: true, grid: { display: false } },
          y: { stacked: true, beginAtZero: true, title: { display: true, text: 'Tokens' } }
        },
        plugins: {
          legend: { display: true, position: 'bottom', labels: { boxWidth: 10, font: { size: 9 }, padding: 8 } },
          tooltip: {
            backgroundColor: '#fff', titleColor: '#1a1a2e', bodyColor: '#1a1a2e', borderColor: '#e0e0e0', borderWidth: 1,
            callbacks: {
              title: function(items) {
                var t = 0;
                for (var i = 0; i < items.length; i++) { t += items[i].raw || 0; }
                if (t === 0) return '';
                return items[0].label + '  ' + fmtNum(t);
              },
              label: function(ctx) {
                if (!ctx.raw) return null;
                return '  ' + ctx.dataset.label + '  ' + fmtNum(ctx.raw);
              }
            }
          }
        }
      }
    });
  }
}

function extractProvider(model) {
  if (!model) return '';
  var idx = model.indexOf('/');
  return idx>0 ? model.substring(0,idx) : '';
}

// Reserved sentinel for "Unknown (blank)" provider rows. "__unknown__" is NOT
// safe as a sentinel because a real provider can be named "__unknown__";
// this value uses characters impossible in a provider name.
var BLANK_PROVIDER_SENTINEL = '__BLANK_PROVIDER__';

function populateFilters() {
  var provSel = document.getElementById('providerFilter'), curP = provSel.value;
  provSel.innerHTML = '<option value="">All Providers</option>';
  (allData.providers||[]).forEach(function(p){ provSel.innerHTML += '<option value="'+escHtml(p)+'">'+escHtml(p)+'</option>'; });
  // Rows whose provider resolves to empty use a selectable reserved sentinel.
  // settings) render in the chart under an empty key - give them a selectable
  // option so that cost can be isolated (the backend scopes it via the
  // reserved "__BLANK_PROVIDER__" sentinel, which can never collide with a
  // real provider name).
  var hasUnknownProvider = false;
  ((allData.chat||[]).concat(allData.commands||[])).forEach(function(c) {
    if (!(c.provider || extractProvider(c.model))) hasUnknownProvider = true;
  });
  if (hasUnknownProvider) provSel.innerHTML += '<option value="' + BLANK_PROVIDER_SENTINEL + '">Unknown (blank)</option>';
  provSel.value = curP;

  // Build model→provider map from data (backend lists don't include provider info)
  var modelProv = {};
  for (var i=0; i<(allData.chat||[]).length; i++) {
    var c = allData.chat[i]; if (c.model && c.provider) modelProv[c.model] = c.provider;
  }
  for (var i=0; i<(allData.commands||[]).length; i++) {
    var c = allData.commands[i]; if (c.model && c.provider) modelProv[c.model] = c.provider;
  }

  var modSel = document.getElementById('modelFilter'), curM = modSel.value;
  modSel.innerHTML = '<option value="">All Models</option>';
  (allData.models||[]).forEach(function(m){
    // Filter by selected provider if one is chosen
    if (!curP || (curP === BLANK_PROVIDER_SENTINEL ? !modelProv[m] : modelProv[m] === curP))
      modSel.innerHTML += '<option value="'+escHtml(m)+'">'+escHtml(m)+'</option>';
  });
  modSel.value = curM;
}

document.getElementById('timeRange').addEventListener('change', loadData);
document.getElementById('providerFilter').addEventListener('change', function() {
  document.getElementById('modelFilter').value = '';  // reset model on provider change
  loadData();
});
document.getElementById('modelFilter').addEventListener('change', loadData);
document.getElementById('typeFilter').addEventListener('change', loadData);
document.getElementById('refreshBtn').addEventListener('click', loadData);

// RFC-4180 CSV field escaping: quote any field containing a comma, quote, or
// line break, doubling embedded quotes because model/provider names are
// user-editable and can contain commas).
function csvField(v) {
  var s = String(v === undefined || v === null ? '' : v);
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

document.getElementById('exportBtn').addEventListener('click', function() {
  var csv = 'Date,Type,Provider,Model,Input,Output,Thinking,Cache,Cache Cost,Output Cost,Total Cost,Calls\n';
  for (var i=0; i<allData.chat.length; i++) {
    var r = allData.chat[i];
    csv += [r.date,'chat',r.provider||'—',r.model,r.input_tokens||0,r.output_tokens||0,r.thinking_tokens||0,r.cached_tokens||0,
      r.cached_input_cost||0,r.output_cost||0,r.total_cost||0,r.message_count||0].map(csvField).join(',')+'\n';
  }
  for (var i=0; i<allData.commands.length; i++) {
    var r = allData.commands[i];
    csv += [r.date,'command',r.provider||'—',r.model,r.prompt_tokens||0,r.completion_tokens||0,r.thinking_tokens||0,r.cached_tokens||0,
      r.cached_input_cost||0,r.output_cost||0,r.total_cost||0,r.call_count||0].map(csvField).join(',')+'\n';
  }
  var blob = new Blob([csv], {type:'text/csv'});
  var a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'usage_export.csv'; a.click();
});

document.querySelector('#stackToggle').addEventListener('click', function(e) {
  if (e.target.tagName!=='BUTTON') return;
  this.querySelectorAll('button').forEach(function(b){ b.classList.remove('active'); });
  e.target.classList.add('active');
  renderMainChart();
});

// Don't auto-load — called when dashboard panel is shown

// Wire API Logs button (inline onclick may not fire in complex DOM)
document.getElementById('apiLogsBtn').addEventListener('click', function() {
  Ipc.postToHost('showApiLogs');
});
