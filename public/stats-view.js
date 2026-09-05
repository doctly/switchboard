// --- Stats view ---
// Depends on globals: escapeHtml (utils.js), statsViewerBody (app.js)

let cachedUsage = null;
let cachedCodexUsage = null;

async function loadStats() {
  statsViewerBody.innerHTML = '';

  // Show spinner while refreshing
  const spinner = document.createElement('div');
  spinner.className = 'stats-spinner';
  spinner.innerHTML = `<div class="stats-spinner-icon"></div><span>Updating stats\u2026</span>`;
  statsViewerBody.appendChild(spinner);

  // Refresh stats cache via PTY (/stats + /usage)
  let stats, usage;
  // Codex usage is a plain API read, so it runs alongside the Claude refresh
  // (which spawns a PTY) rather than after it.
  const codexPromise = (window.api.getCodexUsage?.() ?? Promise.resolve({})).catch(() => ({}));

  try {
    const result = await window.api.refreshStats();
    stats = result?.stats;
    usage = result?.usage || {};
    cachedUsage = usage;
  } catch {
    // Fallback to cached stats
    stats = await window.api.getStats();
    usage = cachedUsage || {};
  }

  let codexUsage = {};
  try { codexUsage = await codexPromise; } catch {}
  if (codexUsage && Object.keys(codexUsage).length) cachedCodexUsage = codexUsage;

  statsViewerBody.innerHTML = '';

  // Codex counts here too — a Codex-only user has no Claude stats cache, and
  // bailing on that alone would hide their rate limits entirely.
  if (!stats && !Object.keys(usage).length && !Object.keys(codexUsage || {}).length) {
    statsViewerBody.innerHTML = '<div class="plans-empty">No stats data found. Run some sessions first.</div>';
    return;
  }

  if (stats) {
    // dailyActivity may be an array of {date, messageCount, ...} or an object
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
    buildHeatmap(dailyMap);
    buildDailyBarChart(stats);
    buildStatsSummary(stats, dailyMap);
  }

  // Build usage section below charts (from /usage output)
  if (Object.keys(usage).length) {
    buildUsageSection(usage, { runtime: 'claude', title: 'Claude Rate Limits' });
  }

  // A signed-out or switched-off Codex simply contributes no panel.
  if (codexUsage && (codexUsage.limits?.length || codexUsage._error || codexUsage._rateLimited)) {
    buildUsageSection(codexUsage, {
      runtime: 'codex',
      title: 'Codex Rate Limits',
      refetch: () => window.api.getCodexUsage(),
    });
  }

  if (stats) {
    const notice = document.createElement('div');
    notice.className = 'stats-notice';
    const lastDate = stats.lastComputedDate || 'unknown';
    notice.innerHTML = `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" style="vertical-align:-2px;margin-right:6px;flex-shrink:0"><circle cx="8" cy="8" r="7"/><line x1="8" y1="5" x2="8" y2="9"/><circle cx="8" cy="11.5" r="0.5" fill="currentColor" stroke="none"/></svg>Data sourced from Claude\u2019s stats cache (last updated ${escapeHtml(lastDate)}).`;
    statsViewerBody.appendChild(notice);
  }
}

/**
 * One rate-limit panel per CLI.
 *
 * `runtime` keys the container so a refresh replaces only its own panel, and
 * `refetch` is the per-CLI usage call — each refreshes independently, since one
 * being signed out should not blank the other.
 */
function buildUsageSection(usage, { runtime = 'claude', title: titleText = 'Rate Limits', refetch = () => window.api.getUsage() } = {}) {
  // Remove existing usage container if present (for refresh)
  const existing = statsViewerBody.querySelector('.usage-container-' + runtime);
  if (existing) existing.remove();

  const container = document.createElement('div');
  container.className = 'usage-container usage-container-' + runtime;

  const titleRow = document.createElement('div');
  titleRow.className = 'usage-title-row';
  const title = document.createElement('div');
  title.className = 'daily-chart-title';
  title.textContent = titleText;
  titleRow.appendChild(title);

  const refreshBtn = document.createElement('button');
  refreshBtn.className = 'usage-refresh-btn';
  refreshBtn.innerHTML = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/></svg>';
  refreshBtn.title = 'Refresh usage';
  refreshBtn.onclick = async () => {
    refreshBtn.classList.add('usage-refresh-spinning');
    refreshBtn.disabled = true;
    try {
      const freshUsage = await refetch();
      if (freshUsage && Object.keys(freshUsage).length) {
        if (runtime === 'codex') cachedCodexUsage = freshUsage; else cachedUsage = freshUsage;
        buildUsageSection(freshUsage, { runtime, title: titleText, refetch });
      }
    } catch {}
    refreshBtn.classList.remove('usage-refresh-spinning');
    refreshBtn.disabled = false;
  };
  titleRow.appendChild(refreshBtn);
  container.appendChild(titleRow);

  // Show rate limit or error notice
  if (usage._rateLimited || usage._error) {
    const notice = document.createElement('div');
    notice.className = 'usage-rate-limited';
    if (usage._rateLimited) {
      const secs = usage.retryAfterSeconds || 0;
      const mins = Math.ceil(secs / 60);
      notice.textContent = secs > 0
        ? `Usage API rate limited. Try again in ~${mins} min${mins !== 1 ? 's' : ''}.`
        : 'Usage API rate limited. Try again later.';
    } else {
      notice.textContent = usage.message || 'Could not fetch usage data.';
    }
    container.appendChild(notice);
    const statsNotice = statsViewerBody.querySelector('.stats-notice');
    if (statsNotice) statsViewerBody.insertBefore(container, statsNotice);
    else statsViewerBody.appendChild(container);
    return;
  }

  const grid = document.createElement('div');
  grid.className = 'usage-grid';

  // Prefer the API's self-describing `limits` rows: they carry their own label
  // and cover model-scoped windows (e.g. "Week (Fable)") that no fixed key list
  // can anticipate. The flat keys below are the fallback for an older response
  // shape — the per-model ones among them have gone null server-side.
  const items = Array.isArray(usage.limits) && usage.limits.length
    ? usage.limits.map(l => ({ label: l.label, pct: l.percent, reset: l.reset }))
    : [
      { key: 'session', label: 'Current session', resetKey: 'sessionReset' },
      { key: 'weekAll', label: 'Week (all models)', resetKey: 'weekAllReset' },
      { key: 'weekSonnet', label: 'Week (Sonnet)', resetKey: 'weekSonnetReset' },
      { key: 'weekOpus', label: 'Week (Opus)', resetKey: 'weekOpusReset' },
    ].map(i => ({ label: i.label, pct: usage[i.key], reset: usage[i.resetKey] }));

  for (const item of items) {
    if (item.pct === undefined || item.pct === null) continue;
    const pct = item.pct;
    const card = document.createElement('div');
    card.className = 'usage-card';

    const header = document.createElement('div');
    header.className = 'usage-card-header';
    const label = document.createElement('span');
    label.className = 'usage-card-label';
    label.textContent = item.label;
    header.appendChild(label);
    const pctEl = document.createElement('span');
    pctEl.className = 'usage-card-pct';
    pctEl.textContent = pct + '%';
    header.appendChild(pctEl);
    card.appendChild(header);

    const track = document.createElement('div');
    track.className = 'usage-track';
    const fill = document.createElement('div');
    fill.className = 'usage-fill' + (pct >= 80 ? ' usage-fill-high' : '');
    fill.style.width = Math.min(Math.max(pct, 1), 100) + '%';
    track.appendChild(fill);
    card.appendChild(track);

    if (item.reset) {
      const reset = document.createElement('div');
      reset.className = 'usage-card-reset';
      reset.textContent = 'Resets ' + item.reset;
      card.appendChild(reset);
    }

    grid.appendChild(card);
  }

  container.appendChild(grid);

  // Plan, credit balance and reset credits — reported by codex only, and worth
  // showing because a reset credit is a thing the user can actually spend.
  const facts = [];
  if (usage.planType) facts.push(`Plan: ${usage.planType}`);
  if (usage.credits && !usage.credits.unlimited && usage.credits.balance != null
      && usage.credits.balance !== '0') facts.push(`Credits: ${usage.credits.balance}`);
  if (usage.resetCredits) facts.push(`${usage.resetCredits} limit reset${usage.resetCredits !== 1 ? 's' : ''} available`);
  if (facts.length) {
    const meta = document.createElement('div');
    meta.className = 'usage-card-reset usage-account-facts';
    meta.textContent = facts.join(' \u00b7 ');
    container.appendChild(meta);
  }

  // Insert before the stats notice footer if it exists, otherwise append
  const statsNotice = statsViewerBody.querySelector('.stats-notice');
  if (statsNotice) statsViewerBody.insertBefore(container, statsNotice);
  else statsViewerBody.appendChild(container);
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
