<template>
  <div id="stats-viewer-body">
    <!-- Empty state -->
    <div v-if="!stats && !hasUsage" class="plans-empty">
      No stats data found. Run some Claude sessions first.
    </div>

    <template v-else>
      <!-- Heatmap -->
      <div v-if="stats" class="heatmap-container">
        <div class="heatmap-month-labels" style="position:relative;height:16px;">
          <span
            v-for="ml in monthLabelList"
            :key="ml.key"
            class="heatmap-month-label"
            style="position:absolute;"
            :style="{ left: ml.left }"
          >{{ ml.label }}</span>
        </div>
        <div class="heatmap-grid-wrapper">
          <div class="heatmap-day-labels">
            <div v-for="name in dayNames" :key="name + Math.random()" class="heatmap-day-label">{{ name }}</div>
          </div>
          <div class="heatmap-grid">
            <div
              v-for="cell in heatmapCells"
              :key="cell.dateStr"
              :class="['heatmap-cell', 'heatmap-level-' + cell.level]"
              :title="cell.title"
            ></div>
          </div>
        </div>
        <div class="heatmap-legend">
          <span class="heatmap-legend-label">Less</span>
          <div v-for="i in [0,1,2,3,4]" :key="i" :class="['heatmap-legend-cell', 'heatmap-level-' + i]"></div>
          <span class="heatmap-legend-label">More</span>
        </div>
      </div>

      <!-- Daily bar chart -->
      <div v-if="stats" class="daily-chart-container">
        <div class="daily-chart-title">Last 30 days</div>
        <div class="daily-chart">
          <div
            v-for="col in dailyChartCols"
            :key="col.dateStr"
            class="daily-chart-col"
            :title="col.tooltip"
          >
            <div class="daily-chart-bar" :style="{ height: col.tokenPct + '%' }"></div>
            <div class="daily-chart-bar-msgs" :style="{ height: col.msgPct + '%' }"></div>
            <div class="daily-chart-label">{{ col.dayNum }}</div>
          </div>
        </div>
        <div class="daily-chart-legend">
          <span class="daily-chart-legend-dot tokens"></span> Tokens
          <span class="daily-chart-legend-dot msgs"></span> Messages
        </div>
      </div>

      <!-- Stats summary cards -->
      <div v-if="stats" class="stats-summary">
        <div v-for="card in summaryCards" :key="card.label" class="stat-card">
          <span class="stat-card-value">{{ card.value }}</span>
          <span class="stat-card-label">{{ card.label }}</span>
        </div>
      </div>

      <!-- Usage / rate limits -->
      <div v-if="hasUsage" class="usage-container">
        <div class="usage-title-row">
          <div class="daily-chart-title">Rate Limits</div>
          <button
            class="usage-refresh-btn"
            :class="{ 'usage-refresh-spinning': usageRefreshing }"
            :disabled="usageRefreshing"
            title="Refresh usage"
            @click="refreshUsage"
            v-html="REFRESH_SVG"
          ></button>
        </div>
        <div v-if="usage._rateLimited" class="usage-rate-limited">
          {{ rateLimitedText }}
        </div>
        <div v-else class="usage-grid">
          <div
            v-for="item in usageCards"
            :key="item.key"
            class="usage-card"
          >
            <div class="usage-card-header">
              <span class="usage-card-label">{{ item.label }}</span>
              <span class="usage-card-pct">{{ item.pct }}%</span>
            </div>
            <div class="usage-track">
              <div
                :class="['usage-fill', item.pct >= 80 ? 'usage-fill-high' : '']"
                :style="{ width: Math.max(item.pct, 1) + '%' }"
              ></div>
            </div>
            <div v-if="item.reset" class="usage-card-reset">Resets {{ item.reset }}</div>
          </div>
        </div>
      </div>

      <!-- Stats notice footer -->
      <div v-if="stats" class="stats-notice" v-html="statsNoticeHtml"></div>
    </template>
  </div>
</template>

<script setup>
import { ref, computed } from 'vue';

// ── Cache ────────────────────────────────────────────────────────
let cachedStats = null;
let cachedUsage = null;
let statsLoadedAt = 0;
const STATS_TTL_MS = 60_000;

// ── Reactive state ────────────────────────────────────────────────
const stats = ref(null);
const usage = ref({});
const usageRefreshing = ref(false);
const refreshing = ref(false);

// ── SVG constant ─────────────────────────────────────────────────
const REFRESH_SVG = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/></svg>';

// ── Derived helpers ───────────────────────────────────────────────
const hasUsage = computed(() => usage.value && Object.keys(usage.value).length > 0);

function buildDailyMap(s) {
  const rawDaily = s?.dailyActivity || {};
  const dailyMap = {};
  if (Array.isArray(rawDaily)) {
    for (const entry of rawDaily) {
      dailyMap[entry.date] = entry.messageCount || 0;
    }
  } else {
    for (const [date, data] of Object.entries(rawDaily)) {
      dailyMap[date] = typeof data === 'number' ? data : (data?.messageCount || data?.messages || data?.count || 0);
    }
  }
  return dailyMap;
}

// ── Heatmap ───────────────────────────────────────────────────────
const DAY_NAMES = ['', 'Mon', '', 'Wed', '', 'Fri', ''];
const dayNames = DAY_NAMES;
const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const COL_WIDTH = 16; // 13px cell + 3px gap

const monthLabelList = computed(() => {
  if (!stats.value) return [];
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const dayOfWeek = today.getDay();
  const startDate = new Date(today);
  startDate.setDate(startDate.getDate() - (52 * 7 + dayOfWeek));

  const weekStarts = [];
  const d = new Date(startDate);
  while (d <= today) {
    if (d.getDay() === 0) weekStarts.push(new Date(d));
    d.setDate(d.getDate() + 1);
  }

  const labels = [];
  let lastMonth = -1;
  for (let w = 0; w < weekStarts.length; w++) {
    const m = weekStarts[w].getMonth();
    if (m !== lastMonth) {
      labels.push({ key: w + '-' + m, label: MONTHS[m], left: (w * COL_WIDTH) + 'px' });
      lastMonth = m;
    }
  }
  return labels;
});

const heatmapCells = computed(() => {
  if (!stats.value) return [];
  const dailyMap = buildDailyMap(stats.value);

  const nonZero = Object.values(dailyMap).filter(c => c > 0).sort((a, b) => a - b);
  const q1 = nonZero[Math.floor(nonZero.length * 0.25)] || 1;
  const q2 = nonZero[Math.floor(nonZero.length * 0.5)] || 2;
  const q3 = nonZero[Math.floor(nonZero.length * 0.75)] || 3;

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const dayOfWeek = today.getDay();
  const startDate = new Date(today);
  startDate.setDate(startDate.getDate() - (52 * 7 + dayOfWeek));

  const cells = [];
  const cursor = new Date(startDate);
  while (cursor <= today) {
    const dateStr = cursor.toISOString().slice(0, 10);
    const count = dailyMap[dateStr] || 0;
    let level = 0;
    if (count > 0) {
      if (count <= q1) level = 1;
      else if (count <= q2) level = 2;
      else if (count <= q3) level = 3;
      else level = 4;
    }
    const displayDate = cursor.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    cells.push({
      dateStr,
      level,
      title: count > 0 ? `${displayDate}: ${count} messages` : `${displayDate}: No activity`,
    });
    cursor.setDate(cursor.getDate() + 1);
  }
  return cells;
});

// ── Daily bar chart ───────────────────────────────────────────────
const dailyChartCols = computed(() => {
  if (!stats.value) return [];
  const rawTokens = stats.value.dailyModelTokens || [];
  const rawActivity = stats.value.dailyActivity || [];

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

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const days = [];
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

  return days.map((dateStr, i) => {
    const tokenPct = Math.max((tokenValues[i] / maxTokens) * 100, tokenValues[i] > 0 ? 3 : 0);
    const msgPct = Math.max((msgValues[i] / maxMsgs) * 100, msgValues[i] > 0 ? 3 : 0);
    const d = new Date(dateStr);
    const dayLabel = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    let tokStr;
    const tv = tokenValues[i];
    if (tv >= 1e6) tokStr = (tv / 1e6).toFixed(1) + 'M';
    else if (tv >= 1e3) tokStr = (tv / 1e3).toFixed(1) + 'K';
    else tokStr = tv.toString();
    const tooltip = `${dayLabel}\n${tokStr} tokens\n${msgValues[i]} messages\n${toolValues[i]} tool calls`;
    return { dateStr, tokenPct, msgPct, dayNum: d.getDate().toString(), tooltip };
  });
});

// ── Stats summary ─────────────────────────────────────────────────
function calculateStreak(dailyMap) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  let current = 0, longest = 0, streak = 0;
  const d = new Date(today);
  let started = false;
  for (let i = 0; i < 365; i++) {
    const dateStr = d.toISOString().slice(0, 10);
    const count = dailyMap[dateStr] || 0;
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

const summaryCards = computed(() => {
  if (!stats.value) return [];
  const s = stats.value;
  const dailyMap = buildDailyMap(s);
  const { current: currentStreak, longest: longestStreak } = calculateStreak(dailyMap);

  let totalMessages = 0;
  for (const count of Object.values(dailyMap)) totalMessages += count;
  if (s.totalMessages && s.totalMessages > totalMessages) totalMessages = s.totalMessages;

  const totalSessions = s.totalSessions || Object.keys(dailyMap).length;
  const models = s.modelUsage || {};

  const cards = [
    { value: totalSessions.toLocaleString(), label: 'Total Sessions' },
    { value: totalMessages.toLocaleString(), label: 'Total Messages' },
    { value: currentStreak + 'd', label: 'Current Streak' },
    { value: longestStreak + 'd', label: 'Longest Streak' },
  ];

  for (const [model, mu] of Object.entries(models)) {
    const shortName = model.replace(/^claude-/, '').replace(/-\d{8}$/, '');
    const tokens = (mu?.inputTokens || 0) + (mu?.outputTokens || 0);
    let valueStr;
    if (tokens >= 1e9) valueStr = (tokens / 1e9).toFixed(1) + 'B';
    else if (tokens >= 1e6) valueStr = (tokens / 1e6).toFixed(1) + 'M';
    else if (tokens >= 1e3) valueStr = (tokens / 1e3).toFixed(1) + 'K';
    else valueStr = tokens.toLocaleString();
    cards.push({ value: valueStr, label: shortName + ' tokens' });
  }
  return cards;
});

// ── Usage section ─────────────────────────────────────────────────
const USAGE_ITEMS = [
  { key: 'session', label: 'Current session', resetKey: 'sessionReset' },
  { key: 'weekAll', label: 'Week (all models)', resetKey: 'weekAllReset' },
  { key: 'weekSonnet', label: 'Week (Sonnet)', resetKey: 'weekSonnetReset' },
  { key: 'weekOpus', label: 'Week (Opus)', resetKey: 'weekOpusReset' },
];

const usageCards = computed(() => {
  const u = usage.value;
  if (!u || u._rateLimited || u._error) return [];
  return USAGE_ITEMS
    .filter(item => u[item.key] !== undefined)
    .map(item => ({
      key: item.key,
      label: item.label,
      pct: u[item.key],
      reset: u[item.resetKey] || null,
    }));
});

const rateLimitedText = computed(() => {
  const u = usage.value;
  if (!u?._rateLimited) return '';
  const secs = u.retryAfterSeconds || 0;
  const mins = Math.ceil(secs / 60);
  return secs > 0
    ? `Usage API rate limited. Try again in ~${mins} min${mins !== 1 ? 's' : ''}.`
    : 'Usage API rate limited. Try again later.';
});

// ── Stats notice ──────────────────────────────────────────────────
const statsNoticeHtml = computed(() => {
  if (!stats.value) return '';
  const lastDate = stats.value.lastComputedDate || 'unknown';
  const escaped = window.escapeHtml ? window.escapeHtml(lastDate) : lastDate;
  return `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" style="vertical-align:-2px;margin-right:6px;flex-shrink:0"><circle cx="8" cy="8" r="7"/><line x1="8" y1="5" x2="8" y2="9"/><circle cx="8" cy="11.5" r="0.5" fill="currentColor" stroke="none"/></svg>Data sourced from Claude’s stats cache (last updated ${escaped}).`;
});

// ── Actions ───────────────────────────────────────────────────────

// Fast load: reads from file cache + DB only — no Keychain, no PTY, no dialog.
async function load() {
  const age = Date.now() - statsLoadedAt;
  if (cachedStats && age < STATS_TTL_MS) {
    stats.value = cachedStats;
    usage.value = cachedUsage || {};
    return;
  }
  const [freshStats, freshUsage] = await Promise.all([
    window.api.getStats().catch(() => null),
    window.api.getCachedUsage().catch(() => ({})),
  ]);
  cachedStats = freshStats;
  cachedUsage = freshUsage || {};
  statsLoadedAt = Date.now();
  stats.value = cachedStats;
  usage.value = cachedUsage;
}

// Explicit refresh: spawns PTY + reads Keychain — only on user click.
async function refreshAll() {
  if (refreshing.value) return;
  refreshing.value = true;
  try {
    const result = await window.api.refreshStats();
    if (result?.stats) { cachedStats = result.stats; stats.value = cachedStats; }
    if (result?.usage) { cachedUsage = result.usage; usage.value = cachedUsage; }
    statsLoadedAt = Date.now();
  } catch {}
  refreshing.value = false;
}

async function refreshUsage() {
  usageRefreshing.value = true;
  try {
    const freshUsage = await window.api.getUsage();
    if (freshUsage && Object.keys(freshUsage).length) {
      cachedUsage = freshUsage;
      statsLoadedAt = 0;
      usage.value = freshUsage;
    }
  } catch {}
  usageRefreshing.value = false;
}

function invalidate() {
  cachedStats = null;
  cachedUsage = null;
  statsLoadedAt = 0;
}

defineExpose({ load, refreshAll, invalidate, isRefreshing: refreshing });
</script>
