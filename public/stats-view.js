// --- Stats view ---
// Depends on globals: escapeHtml (utils.js), statsViewerBody (app.js)
// Renders two layers:
//   1) Rich analytics from analytics-cache.json (per-backend tokens, charts, etc.)
//      Renders instantly from the pre-aggregated cache; live-refreshes via
//      'analytics-updated' events from the background worker.
//   2) Legacy heatmap / activity summary from Claude's own stats-cache.json.

let _analyticsListenerCleanup = null;

async function loadStats() {
  statsViewerBody.innerHTML = '';

  // \u2500\u2500 1) Pre-aggregated analytics \u2014 instant render from cache \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
  let analytics = null;
  try { analytics = await window.api.analytics.getCache(); } catch {}
  buildAnalyticsSections(analytics);

  // Live-refresh when the worker posts new data. Only register once per
  // visit (the listener is torn down when stats tab is left).
  if (typeof _analyticsListenerCleanup === 'function') _analyticsListenerCleanup();
  if (window.api.analytics && window.api.analytics.onUpdated) {
    _analyticsListenerCleanup = window.api.analytics.onUpdated(async () => {
      try {
        const fresh = await window.api.analytics.getCache();
        // Re-render only the analytics sections in place.
        const existing = document.getElementById('analytics-sections');
        if (existing) existing.remove();
        buildAnalyticsSections(fresh);
      } catch {}
    });
  }

  // \u2500\u2500 2) Legacy heatmap + summary \u2014 fast path, no PTY spawn \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
  let stats = null;
  try { stats = await window.api.getStats(); } catch {}
  if (stats) {
    const rawDaily = stats.dailyActivity || {};
    let dailyMap = {};
    if (Array.isArray(rawDaily)) {
      for (const entry of rawDaily) {
        dailyMap[entry.date] = entry.messageCount || 0;
      }
    } else {
      for (const [date, data] of Object.entries(rawDaily)) {
        dailyMap[date] = typeof data === 'number' ? data : (data?.messageCount || data?.messages || data?.count || 0);
      }
    }
    const legacyHeader = document.createElement('div');
    legacyHeader.className = 'analytics-section-header';
    legacyHeader.textContent = 'Daily activity (Claude /stats cache)';
    statsViewerBody.appendChild(legacyHeader);
    buildHeatmap(dailyMap);
    buildDailyBarChart(stats);
    buildStatsSummary(stats, dailyMap);

    const notice = document.createElement('div');
    notice.className = 'stats-notice';
    const lastDate = stats.lastComputedDate || 'unknown';
    notice.innerHTML = `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" style="vertical-align:-2px;margin-right:6px;flex-shrink:0"><circle cx="8" cy="8" r="7"/><line x1="8" y1="5" x2="8" y2="9"/><circle cx="8" cy="11.5" r="0.5" fill="currentColor" stroke="none"/></svg>Heatmap above sourced from Claude\u2019s stats cache (last updated ${escapeHtml(lastDate)}). Per-backend analytics above are computed live from your JSONL session history.`;
    statsViewerBody.appendChild(notice);
  } else if (!analytics) {
    statsViewerBody.innerHTML = '<div class="plans-empty">No stats data found. Run some Claude sessions first.</div>';
  }
}

// \u2500\u2500 Per-backend palette \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
// Stable palette: same backend always gets the same colour, derived from
// the profile's icon colour where available, else hashed from id.
function backendColour(backendId) {
  const profilesById = window._profilesById || {};
  const profile = profilesById[backendId];
  if (profile && profile.icon && window.PROFILE_ICONS && window.PROFILE_ICONS[profile.icon]) {
    return window.PROFILE_ICONS[profile.icon].color;
  }
  // Anthropic for default
  if (backendId === 'default') return '#d97757';
  // Hash for unknown backends
  let h = 0;
  for (let i = 0; i < backendId.length; i++) h = ((h << 5) - h + backendId.charCodeAt(i)) | 0;
  const palette = ['#4d6bfe', '#22a06b', '#a855f7', '#fbbf24', '#ec4899', '#0ea5e9', '#14b8a6'];
  return palette[Math.abs(h) % palette.length];
}

function backendLabel(backendId) {
  const profilesById = window._profilesById || {};
  if (backendId === 'default') return 'Default (Claude)';
  if (profilesById[backendId]) return profilesById[backendId].name;
  return backendId;
}

function backendIconKey(backendId) {
  const profilesById = window._profilesById || {};
  if (backendId === 'default') return 'anthropic';
  if (profilesById[backendId]) return profilesById[backendId].icon || null;
  return null;
}

function pct(n) { return (n * 100).toFixed(1) + '%'; }
function fmt(n) {
  if (window.analyticsCharts && window.analyticsCharts.formatNumber) return window.analyticsCharts.formatNumber(n);
  return String(Math.round(n));
}

// \u2500\u2500 Build all analytics sections \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
function buildAnalyticsSections(cache) {
  const root = document.createElement('div');
  root.id = 'analytics-sections';

  if (!cache || !cache.totals) {
    const empty = document.createElement('div');
    empty.className = 'plans-empty';
    empty.textContent = 'Computing analytics from your session history\u2026 Open this tab again in a moment.';
    root.appendChild(empty);
    statsViewerBody.appendChild(root);
    return;
  }

  const t = cache.totals;
  const backends = Object.keys(t.byBackend || {}).sort((a, b) =>
    (t.byBackend[b].turns || 0) - (t.byBackend[a].turns || 0)
  );

  // Header w/ refresh + freshness
  const header = document.createElement('div');
  header.className = 'analytics-header';
  const fresh = cache.lastUpdate ? new Date(cache.lastUpdate) : null;
  const freshStr = fresh ? fresh.toLocaleString() : '\u2014';
  header.innerHTML =
    '<div class="analytics-title">Backend analytics</div>' +
    `<div class="analytics-fresh">Last update ${escapeHtml(freshStr)}</div>` +
    '<button class="analytics-refresh-btn" title="Recompute now">Refresh</button>';
  header.querySelector('.analytics-refresh-btn').onclick = async () => {
    try { await window.api.analytics.refresh({ fullScan: false }); } catch {}
  };
  root.appendChild(header);

  // KPI strip
  root.appendChild(buildKpiStrip(t));

  // Per-backend cards
  if (backends.length > 0) {
    const sec = document.createElement('div');
    sec.className = 'analytics-section';
    const h = document.createElement('div');
    h.className = 'analytics-section-header';
    h.textContent = 'By backend';
    sec.appendChild(h);
    const grid = document.createElement('div');
    grid.className = 'analytics-backend-grid';
    for (const bid of backends) {
      grid.appendChild(buildBackendCard(bid, t));
    }
    sec.appendChild(grid);
    root.appendChild(sec);
  }

  // Time series \u2014 daily turns stacked by backend
  root.appendChild(buildDailyStackedSection(t, backends));

  // Compare two backends side-by-side
  if (backends.length >= 2) {
    root.appendChild(buildCompareSection(t, backends));
  }

  // Models breakdown \u2014 flat list of model\u2192token counts across all backends
  root.appendChild(buildModelsSection(t, backends));

  // Recent sessions \u2014 drill-down list
  root.appendChild(buildRecentSessionsSection(t));

  statsViewerBody.appendChild(root);
}

function buildKpiStrip(totals) {
  const strip = document.createElement('div');
  strip.className = 'analytics-kpi-strip';

  const totalIn = totals.inputTokens || 0;
  const totalOut = totals.outputTokens || 0;
  const totalCacheRead = totals.cacheReadTokens || 0;
  const totalCacheCreate = totals.cacheCreationTokens || 0;
  const totalAllInput = totalIn + totalCacheRead;
  const cacheHit = totalAllInput > 0 ? totalCacheRead / totalAllInput : 0;

  const cards = [
    { label: 'Total turns', value: fmt(totals.turns || 0) },
    { label: 'Input tokens', value: fmt(totalIn), sub: 'Fresh prompt' },
    { label: 'Cache reads', value: fmt(totalCacheRead), sub: pct(cacheHit) + ' hit rate' },
    { label: 'Output tokens', value: fmt(totalOut) },
    { label: 'Cache writes', value: fmt(totalCacheCreate) },
    { label: 'Tool-use turns', value: fmt(totals.toolUseTurns || 0),
      sub: totals.turns > 0 ? pct((totals.toolUseTurns || 0) / totals.turns) : '0%' },
    { label: 'Subagents', value: fmt(totals.subagentInvocations || 0) },
  ];
  for (const c of cards) {
    const el = document.createElement('div');
    el.className = 'analytics-kpi';
    const v = document.createElement('div'); v.className = 'analytics-kpi-value'; v.textContent = c.value;
    const l = document.createElement('div'); l.className = 'analytics-kpi-label'; l.textContent = c.label;
    el.appendChild(v); el.appendChild(l);
    if (c.sub) {
      const s = document.createElement('div'); s.className = 'analytics-kpi-sub'; s.textContent = c.sub;
      el.appendChild(s);
    }
    strip.appendChild(el);
  }
  return strip;
}

function buildBackendCard(bid, totals) {
  const aggMod = window._aggDerive || (function () {
    // Browser-side replica of analytics-aggregator.deriveBackendMetrics
    return function (b) {
      const sessions = Object.keys(b.sessionIds || {}).length;
      const totalInput = (b.inputTokens || 0) + (b.cacheReadTokens || 0);
      return {
        sessions, turns: b.turns || 0,
        inputTokens: b.inputTokens || 0, outputTokens: b.outputTokens || 0,
        cacheReadTokens: b.cacheReadTokens || 0, cacheCreationTokens: b.cacheCreationTokens || 0,
        toolUseTurns: b.toolUseTurns || 0, subagentInvocations: b.subagentInvocations || 0,
        cacheHitRate: totalInput > 0 ? b.cacheReadTokens / totalInput : 0,
        outputInputRatio: b.inputTokens > 0 ? b.outputTokens / b.inputTokens : 0,
        toolUseDensity: b.turns > 0 ? b.toolUseTurns / b.turns : 0,
        subagentRate: b.turns > 0 ? b.subagentInvocations / b.turns : 0,
        models: b.models || {},
      };
    };
  })();
  const m = aggMod(totals.byBackend[bid] || {});
  const colour = backendColour(bid);

  const card = document.createElement('div');
  card.className = 'analytics-backend-card';
  card.style.borderTop = '3px solid ' + colour;

  // Header: icon + name
  const head = document.createElement('div');
  head.className = 'analytics-backend-head';
  const iconKey = backendIconKey(bid);
  if (iconKey && typeof window.renderProfileIcon === 'function') {
    head.appendChild(window.renderProfileIcon(iconKey, 24));
  }
  const name = document.createElement('div');
  name.className = 'analytics-backend-name';
  name.textContent = backendLabel(bid);
  head.appendChild(name);
  card.appendChild(head);

  // Sparkline of recent daily turns
  const dailyValues = lastNDaysSeries(totals.byDay, 30, bid).turns;
  const sparkWrap = document.createElement('div');
  sparkWrap.className = 'analytics-sparkline';
  if (window.analyticsCharts) {
    sparkWrap.appendChild(window.analyticsCharts.sparkline(dailyValues, { width: 240, height: 32, color: colour }));
  }
  card.appendChild(sparkWrap);

  // Metric grid
  const grid = document.createElement('div');
  grid.className = 'analytics-metric-grid';
  const rows = [
    ['Sessions', fmt(m.sessions)],
    ['Turns', fmt(m.turns)],
    ['Tokens in', fmt(m.inputTokens)],
    ['Tokens out', fmt(m.outputTokens)],
    ['Cache read', fmt(m.cacheReadTokens)],
    ['Cache hit', pct(m.cacheHitRate)],
    ['Out/In ratio', m.outputInputRatio.toFixed(2)],
    ['Tool-use density', pct(m.toolUseDensity)],
    ['Subagent rate', pct(m.subagentRate)],
    ['Avg turns/session', m.sessions > 0 ? (m.turns / m.sessions).toFixed(1) : '\u2014'],
  ];
  for (const [k, v] of rows) {
    const r = document.createElement('div');
    r.className = 'analytics-metric-row';
    const ke = document.createElement('span'); ke.className = 'analytics-metric-key'; ke.textContent = k;
    const ve = document.createElement('span'); ve.className = 'analytics-metric-val'; ve.textContent = v;
    r.appendChild(ke); r.appendChild(ve);
    grid.appendChild(r);
  }
  card.appendChild(grid);

  // Models breakdown
  const modelKeys = Object.keys(m.models).sort((a, b) => (m.models[b].turns || 0) - (m.models[a].turns || 0));
  if (modelKeys.length > 0) {
    const mh = document.createElement('div');
    mh.className = 'analytics-models-head';
    mh.textContent = 'Models';
    card.appendChild(mh);
    for (const mk of modelKeys.slice(0, 5)) {
      const mr = document.createElement('div');
      mr.className = 'analytics-model-row';
      const tot = m.models[mk].turns || 0;
      const share = m.turns > 0 ? tot / m.turns : 0;
      mr.innerHTML =
        `<span class="analytics-model-name"></span>` +
        `<span class="analytics-model-bar"><span class="analytics-model-bar-fill" style="width:${(share * 100).toFixed(1)}%;background:${escapeHtml(colour)}"></span></span>` +
        `<span class="analytics-model-share">${fmt(tot)} (${pct(share)})</span>`;
      mr.querySelector('.analytics-model-name').textContent = mk;
      card.appendChild(mr);
    }
  }
  return card;
}

function lastNDaysSeries(byDay, n, backendId) {
  const days = [];
  const dt = new Date();
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(dt.getTime() - i * 86400000);
    days.push(d.toISOString().slice(0, 10));
  }
  const turns = days.map(day => {
    const d = (byDay || {})[day];
    if (!d) return 0;
    if (backendId == null) return d.turns || 0;
    const b = (d.byBackend || {})[backendId];
    return b ? (b.turns || 0) : 0;
  });
  const tokens = days.map(day => {
    const d = (byDay || {})[day];
    if (!d) return 0;
    if (backendId == null) return (d.inputTokens || 0) + (d.outputTokens || 0) + (d.cacheReadTokens || 0);
    const b = (d.byBackend || {})[backendId];
    return b ? (b.inputTokens || 0) + (b.outputTokens || 0) + (b.cacheReadTokens || 0) : 0;
  });
  return { days, turns, tokens };
}

function buildDailyStackedSection(totals, backends) {
  const sec = document.createElement('div');
  sec.className = 'analytics-section';
  const h = document.createElement('div');
  h.className = 'analytics-section-header';
  h.textContent = 'Daily activity by backend (last 30 days)';
  sec.appendChild(h);

  const dt = new Date();
  const days = [];
  for (let i = 29; i >= 0; i--) {
    const d = new Date(dt.getTime() - i * 86400000);
    const day = d.toISOString().slice(0, 10);
    const segments = backends.map(bid => {
      const b = ((totals.byDay[day] || {}).byBackend || {})[bid];
      return { name: backendLabel(bid), color: backendColour(bid), value: b ? (b.turns || 0) : 0 };
    });
    days.push({ label: day.slice(5), segments });
  }
  const wrap = document.createElement('div');
  wrap.className = 'analytics-chart-wrap';
  if (window.analyticsCharts) {
    wrap.appendChild(window.analyticsCharts.stackedBarChart(days, { yLabel: 'turns / day' }));
  }
  sec.appendChild(wrap);
  sec.appendChild(buildLegend(backends));
  return sec;
}

function buildLegend(backends) {
  const leg = document.createElement('div');
  leg.className = 'analytics-legend';
  for (const bid of backends) {
    const item = document.createElement('span');
    item.className = 'analytics-legend-item';
    const sw = document.createElement('span');
    sw.className = 'analytics-legend-swatch';
    sw.style.background = backendColour(bid);
    item.appendChild(sw);
    const lbl = document.createElement('span');
    lbl.textContent = backendLabel(bid);
    item.appendChild(lbl);
    leg.appendChild(item);
  }
  return leg;
}

function buildCompareSection(totals, backends) {
  const sec = document.createElement('div');
  sec.className = 'analytics-section';
  const h = document.createElement('div');
  h.className = 'analytics-section-header';
  h.textContent = 'Side-by-side comparison';
  sec.appendChild(h);

  const controls = document.createElement('div');
  controls.className = 'analytics-compare-controls';
  const lSel = document.createElement('select'); lSel.className = 'analytics-compare-sel';
  const rSel = document.createElement('select'); rSel.className = 'analytics-compare-sel';
  for (const sel of [lSel, rSel]) {
    for (const bid of backends) {
      const o = document.createElement('option');
      o.value = bid; o.textContent = backendLabel(bid);
      sel.appendChild(o);
    }
  }
  lSel.value = backends[0];
  rSel.value = backends[1] || backends[0];
  controls.appendChild(lSel);
  controls.appendChild(document.createTextNode(' vs '));
  controls.appendChild(rSel);
  sec.appendChild(controls);

  const tableWrap = document.createElement('div');
  tableWrap.className = 'analytics-compare-table';
  sec.appendChild(tableWrap);

  function aggView(bid) {
    const b = totals.byBackend[bid] || {};
    const sessions = Object.keys(b.sessionIds || {}).length;
    const ti = (b.inputTokens || 0);
    const to = (b.outputTokens || 0);
    const cr = (b.cacheReadTokens || 0);
    const cc = (b.cacheCreationTokens || 0);
    const totalIn = ti + cr;
    return {
      Sessions: fmt(sessions),
      Turns: fmt(b.turns || 0),
      'Input tokens': fmt(ti),
      'Output tokens': fmt(to),
      'Cache read': fmt(cr),
      'Cache creation': fmt(cc),
      'Cache hit rate': totalIn > 0 ? pct(cr / totalIn) : '\u2014',
      'Out/In ratio': ti > 0 ? (to / ti).toFixed(2) : '\u2014',
      'Tool-use density': b.turns > 0 ? pct((b.toolUseTurns || 0) / b.turns) : '\u2014',
      'Subagent rate': b.turns > 0 ? pct((b.subagentInvocations || 0) / b.turns) : '\u2014',
      'Avg turns/session': sessions > 0 ? (b.turns / sessions).toFixed(1) : '\u2014',
    };
  }

  function render() {
    const lv = aggView(lSel.value);
    const rv = aggView(rSel.value);
    const keys = Object.keys(lv);
    tableWrap.innerHTML = '';
    const tbl = document.createElement('table');
    tbl.className = 'analytics-compare-tbl';
    const head = document.createElement('tr');
    const lLabel = document.createElement('th'); lLabel.textContent = backendLabel(lSel.value); lLabel.style.color = backendColour(lSel.value);
    const mid = document.createElement('th'); mid.textContent = '';
    const rLabel = document.createElement('th'); rLabel.textContent = backendLabel(rSel.value); rLabel.style.color = backendColour(rSel.value);
    head.appendChild(lLabel); head.appendChild(mid); head.appendChild(rLabel);
    tbl.appendChild(head);
    for (const k of keys) {
      const tr = document.createElement('tr');
      const l = document.createElement('td'); l.textContent = lv[k]; l.style.color = backendColour(lSel.value);
      const m = document.createElement('td'); m.className = 'analytics-compare-key'; m.textContent = k;
      const r = document.createElement('td'); r.textContent = rv[k]; r.style.color = backendColour(rSel.value);
      tr.appendChild(l); tr.appendChild(m); tr.appendChild(r);
      tbl.appendChild(tr);
    }
    tableWrap.appendChild(tbl);
  }
  lSel.onchange = render;
  rSel.onchange = render;
  render();
  return sec;
}

function buildModelsSection(totals, backends) {
  const sec = document.createElement('div');
  sec.className = 'analytics-section';
  const h = document.createElement('div');
  h.className = 'analytics-section-header';
  h.textContent = 'All models seen';
  sec.appendChild(h);

  // Aggregate across backends
  const flat = {};
  for (const bid of backends) {
    const b = totals.byBackend[bid] || {};
    for (const [model, mb] of Object.entries(b.models || {})) {
      if (!flat[model]) flat[model] = { turns: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, backends: new Set() };
      flat[model].turns += mb.turns || 0;
      flat[model].inputTokens += mb.inputTokens || 0;
      flat[model].outputTokens += mb.outputTokens || 0;
      flat[model].cacheReadTokens += mb.cacheReadTokens || 0;
      flat[model].backends.add(bid);
    }
  }
  const sorted = Object.entries(flat).sort((a, b) => b[1].turns - a[1].turns);
  if (sorted.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'plans-empty';
    empty.textContent = 'No model usage recorded yet.';
    sec.appendChild(empty);
    return sec;
  }
  const tbl = document.createElement('table');
  tbl.className = 'analytics-models-tbl';
  const head = document.createElement('tr');
  for (const h of ['Model', 'Turns', 'Tokens in', 'Tokens out', 'Cache read', 'Used by']) {
    const th = document.createElement('th'); th.textContent = h; head.appendChild(th);
  }
  tbl.appendChild(head);
  for (const [model, m] of sorted) {
    const tr = document.createElement('tr');
    const cells = [
      model,
      fmt(m.turns),
      fmt(m.inputTokens),
      fmt(m.outputTokens),
      fmt(m.cacheReadTokens),
      [...m.backends].map(backendLabel).join(', '),
    ];
    for (const c of cells) {
      const td = document.createElement('td'); td.textContent = c; tr.appendChild(td);
    }
    tbl.appendChild(tr);
  }
  sec.appendChild(tbl);
  return sec;
}

function buildRecentSessionsSection(totals) {
  const sec = document.createElement('div');
  sec.className = 'analytics-section';
  const h = document.createElement('div');
  h.className = 'analytics-section-header';
  h.textContent = 'Recent sessions';
  sec.appendChild(h);

  const recent = totals.recentSessions || {};
  const sorted = Object.values(recent)
    .sort((a, b) => (b.lastTimestamp || '').localeCompare(a.lastTimestamp || ''))
    .slice(0, 50);

  if (sorted.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'plans-empty';
    empty.textContent = 'No sessions yet.';
    sec.appendChild(empty);
    return sec;
  }

  const tbl = document.createElement('table');
  tbl.className = 'analytics-models-tbl';
  const head = document.createElement('tr');
  for (const h of ['Session', 'Backend', 'Model', 'Turns', 'Tokens', 'Last activity']) {
    const th = document.createElement('th'); th.textContent = h; head.appendChild(th);
  }
  tbl.appendChild(head);
  for (const s of sorted) {
    const tr = document.createElement('tr');
    const sid = (s.sessionId || '').slice(0, 8);
    const bid = s.profileId || 'default';
    const cells = [
      sid,
      backendLabel(bid),
      s.dominantModel || '\u2014',
      fmt(s.turns || 0),
      fmt(s.totalTokens || 0),
      s.lastTimestamp ? new Date(s.lastTimestamp).toLocaleString() : '\u2014',
    ];
    for (let i = 0; i < cells.length; i++) {
      const td = document.createElement('td');
      td.textContent = cells[i];
      if (i === 1) td.style.color = backendColour(bid);
      tr.appendChild(td);
    }
    tbl.appendChild(tr);
  }
  sec.appendChild(tbl);
  return sec;
}

function buildDailyBarChart(stats) {
  const rawTokens = stats.dailyModelTokens || [];
  const rawActivity = stats.dailyActivity || [];

  // Build maps for last 30 days
  const tokenMap = {};
  if (Array.isArray(rawTokens)) {
    for (const entry of rawTokens) {
      let total = 0;
      for (const count of Object.values(entry.tokensByModel || {})) total += count;
      tokenMap[entry.date] = total;
    }
  }
  const activityMap = {};
  if (Array.isArray(rawActivity)) {
    for (const entry of rawActivity) activityMap[entry.date] = entry;
  }

  // Generate last 30 days
  const days = [];
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  for (let i = 29; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    days.push(d.toISOString().slice(0, 10));
  }

  const tokenValues = days.map(d => tokenMap[d] || 0);
  const msgValues = days.map(d => activityMap[d]?.messageCount || 0);
  const toolValues = days.map(d => activityMap[d]?.toolCallCount || 0);
  const maxTokens = Math.max(...tokenValues, 1);
  const maxMsgs = Math.max(...msgValues, 1);

  const container = document.createElement('div');
  container.className = 'daily-chart-container';

  const title = document.createElement('div');
  title.className = 'daily-chart-title';
  title.textContent = 'Last 30 days';
  container.appendChild(title);

  const chart = document.createElement('div');
  chart.className = 'daily-chart';

  for (let i = 0; i < days.length; i++) {
    const col = document.createElement('div');
    col.className = 'daily-chart-col';

    const bar = document.createElement('div');
    bar.className = 'daily-chart-bar';
    const pct = (tokenValues[i] / maxTokens) * 100;
    bar.style.height = Math.max(pct, tokenValues[i] > 0 ? 3 : 0) + '%';

    const msgPct = (msgValues[i] / maxMsgs) * 100;
    const msgBar = document.createElement('div');
    msgBar.className = 'daily-chart-bar-msgs';
    msgBar.style.height = Math.max(msgPct, msgValues[i] > 0 ? 3 : 0) + '%';

    const d = new Date(days[i]);
    const dayLabel = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    let tokStr;
    if (tokenValues[i] >= 1e6) tokStr = (tokenValues[i] / 1e6).toFixed(1) + 'M';
    else if (tokenValues[i] >= 1e3) tokStr = (tokenValues[i] / 1e3).toFixed(1) + 'K';
    else tokStr = tokenValues[i].toString();
    col.title = `${dayLabel}\n${tokStr} tokens\n${msgValues[i]} messages\n${toolValues[i]} tool calls`;

    const label = document.createElement('div');
    label.className = 'daily-chart-label';
    label.textContent = d.getDate().toString();

    col.appendChild(bar);
    col.appendChild(msgBar);
    col.appendChild(label);
    chart.appendChild(col);
  }

  container.appendChild(chart);

  // Legend
  const legend = document.createElement('div');
  legend.className = 'daily-chart-legend';
  legend.innerHTML = '<span class="daily-chart-legend-dot tokens"></span> Tokens <span class="daily-chart-legend-dot msgs"></span> Messages';
  container.appendChild(legend);

  statsViewerBody.appendChild(container);
}

function buildHeatmap(counts) {
  const container = document.createElement('div');
  container.className = 'heatmap-container';

  // Generate 52 weeks of dates ending today
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const dayOfWeek = today.getDay(); // 0=Sun
  const endDate = new Date(today);
  const startDate = new Date(today);
  startDate.setDate(startDate.getDate() - (52 * 7 + dayOfWeek));

  // Month labels
  const monthLabels = document.createElement('div');
  monthLabels.className = 'heatmap-month-labels';
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  let lastMonth = -1;
  const weekStarts = [];
  const d = new Date(startDate);
  while (d <= endDate) {
    if (d.getDay() === 0) {
      weekStarts.push(new Date(d));
    }
    d.setDate(d.getDate() + 1);
  }

  // Calculate month label positions
  const colWidth = 16; // 13px cell + 3px gap
  for (let w = 0; w < weekStarts.length; w++) {
    const m = weekStarts[w].getMonth();
    if (m !== lastMonth) {
      const label = document.createElement('span');
      label.className = 'heatmap-month-label';
      label.textContent = months[m];
      label.style.position = 'absolute';
      label.style.left = (w * colWidth) + 'px';
      monthLabels.appendChild(label);
      lastMonth = m;
    }
  }
  monthLabels.style.position = 'relative';
  monthLabels.style.height = '16px';
  container.appendChild(monthLabels);

  // Grid wrapper (day labels + grid)
  const wrapper = document.createElement('div');
  wrapper.className = 'heatmap-grid-wrapper';

  // Day labels
  const dayLabels = document.createElement('div');
  dayLabels.className = 'heatmap-day-labels';
  const dayNames = ['', 'Mon', '', 'Wed', '', 'Fri', ''];
  for (const name of dayNames) {
    const label = document.createElement('div');
    label.className = 'heatmap-day-label';
    label.textContent = name;
    dayLabels.appendChild(label);
  }
  wrapper.appendChild(dayLabels);

  // Quartile thresholds
  const nonZero = Object.values(counts).filter(c => c > 0).sort((a, b) => a - b);
  const q1 = nonZero[Math.floor(nonZero.length * 0.25)] || 1;
  const q2 = nonZero[Math.floor(nonZero.length * 0.5)] || 2;
  const q3 = nonZero[Math.floor(nonZero.length * 0.75)] || 3;

  // Grid
  const grid = document.createElement('div');
  grid.className = 'heatmap-grid';

  const cursor = new Date(startDate);
  while (cursor <= endDate) {
    const dateStr = cursor.toISOString().slice(0, 10);
    const count = counts[dateStr] || 0;
    let level = 0;
    if (count > 0) {
      if (count <= q1) level = 1;
      else if (count <= q2) level = 2;
      else if (count <= q3) level = 3;
      else level = 4;
    }

    const cell = document.createElement('div');
    cell.className = `heatmap-cell heatmap-level-${level}`;
    const displayDate = cursor.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    cell.title = count > 0 ? `${displayDate}: ${count} messages` : `${displayDate}: No activity`;
    grid.appendChild(cell);

    cursor.setDate(cursor.getDate() + 1);
  }

  wrapper.appendChild(grid);
  container.appendChild(wrapper);

  // Legend
  const legend = document.createElement('div');
  legend.className = 'heatmap-legend';
  const lessLabel = document.createElement('span');
  lessLabel.className = 'heatmap-legend-label';
  lessLabel.textContent = 'Less';
  legend.appendChild(lessLabel);
  for (let i = 0; i <= 4; i++) {
    const cell = document.createElement('div');
    cell.className = `heatmap-legend-cell heatmap-level-${i}`;
    legend.appendChild(cell);
  }
  const moreLabel = document.createElement('span');
  moreLabel.className = 'heatmap-legend-label';
  moreLabel.textContent = 'More';
  legend.appendChild(moreLabel);
  container.appendChild(legend);

  statsViewerBody.appendChild(container);
}

function calculateStreak(counts) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  let current = 0;
  let longest = 0;
  let streak = 0;

  const d = new Date(today);
  let started = false;
  for (let i = 0; i < 365; i++) {
    const dateStr = d.toISOString().slice(0, 10);
    const count = counts[dateStr] || 0;
    if (count > 0) {
      streak++;
      started = true;
    } else {
      if (started) {
        if (!current) current = streak;
        if (streak > longest) longest = streak;
        streak = 0;
        if (current) started = false;
      }
    }
    d.setDate(d.getDate() - 1);
  }
  if (streak > longest) longest = streak;
  if (!current && streak > 0) current = streak;

  return { current, longest };
}

function buildStatsSummary(stats, dailyMap) {
  const summaryEl = document.createElement('div');
  summaryEl.className = 'stats-summary';

  const { current: currentStreak, longest: longestStreak } = calculateStreak(dailyMap);

  // Total messages from map
  let totalMessages = 0;
  for (const count of Object.values(dailyMap)) {
    totalMessages += count;
  }
  // Prefer stats.totalMessages if available and larger
  if (stats.totalMessages && stats.totalMessages > totalMessages) {
    totalMessages = stats.totalMessages;
  }

  const totalSessions = stats.totalSessions || Object.keys(dailyMap).length;

  // Model usage — values are objects with token counts, show as cards
  const models = stats.modelUsage || {};

  const cards = [
    { value: totalSessions.toLocaleString(), label: 'Total Sessions' },
    { value: totalMessages.toLocaleString(), label: 'Total Messages' },
    { value: currentStreak + 'd', label: 'Current Streak' },
    { value: longestStreak + 'd', label: 'Longest Streak' },
  ];

  for (const [model, usage] of Object.entries(models)) {
    const shortName = model.replace(/^claude-/, '').replace(/-\d{8}$/, '');
    const tokens = (usage?.inputTokens || 0) + (usage?.outputTokens || 0);
    const label = shortName;
    // Format token count in millions/thousands
    let valueStr;
    if (tokens >= 1e9) valueStr = (tokens / 1e9).toFixed(1) + 'B';
    else if (tokens >= 1e6) valueStr = (tokens / 1e6).toFixed(1) + 'M';
    else if (tokens >= 1e3) valueStr = (tokens / 1e3).toFixed(1) + 'K';
    else valueStr = tokens.toLocaleString();
    cards.push({ value: valueStr, label: label + ' tokens' });
  }

  for (const card of cards) {
    const el = document.createElement('div');
    el.className = 'stat-card';
    el.innerHTML = `<span class="stat-card-value">${escapeHtml(card.value)}</span><span class="stat-card-label">${escapeHtml(card.label)}</span>`;
    summaryEl.appendChild(el);
  }

  statsViewerBody.appendChild(summaryEl);
}
