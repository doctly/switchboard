const test = require('node:test');
const assert = require('node:assert/strict');

// The session_metrics aggregates in db.js are powered by better-sqlite3, which
// is compiled against Electron's Node ABI and cannot be required from plain
// node:test. These tests validate the aggregation LOGIC by running pure-JS
// mirrors of the SQL (same pattern as db-daily-activity.test.js) on fixture
// rows, so regressions in the GROUP BY shape surface in CI.

// Mirror of getDailyMetrics:
//   SELECT date, SUM(messageCount), SUM(toolCallCount),
//          SUM(inputTokens+outputTokens) AS tokens, COUNT(DISTINCT sessionId)
//   FROM session_metrics GROUP BY date ORDER BY date ASC
function aggregateDailyMetrics(rows) {
  const map = new Map();
  for (const r of rows) {
    let e = map.get(r.date);
    if (!e) {
      e = { date: r.date, messageCount: 0, toolCallCount: 0, tokens: 0, _sessions: new Set() };
      map.set(r.date, e);
    }
    e.messageCount += r.messageCount || 0;
    e.toolCallCount += r.toolCallCount || 0;
    e.tokens += (r.inputTokens || 0) + (r.outputTokens || 0);
    e._sessions.add(r.sessionId);
  }
  return Array.from(map.values())
    .map(e => ({ date: e.date, messageCount: e.messageCount, toolCallCount: e.toolCallCount, tokens: e.tokens, sessionCount: e._sessions.size }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

// Mirror of getModelUsage:
//   SELECT model, SUM(inputTokens), SUM(outputTokens)
//   FROM session_metrics WHERE model != '' GROUP BY model
function aggregateModelUsage(rows) {
  const out = {};
  for (const r of rows) {
    if (!r.model) continue;
    if (!out[r.model]) out[r.model] = { inputTokens: 0, outputTokens: 0 };
    out[r.model].inputTokens += r.inputTokens || 0;
    out[r.model].outputTokens += r.outputTokens || 0;
  }
  return out;
}

// Mirror of getDailyModelTokens:
//   SELECT date, model, SUM(inputTokens+outputTokens) AS tokens
//   FROM session_metrics WHERE model != '' GROUP BY date, model
//   → [{date, tokensByModel: {model: tokens}}] sorted by date
function aggregateDailyModelTokens(rows) {
  const byDate = new Map();
  for (const r of rows) {
    if (!r.model) continue;
    let e = byDate.get(r.date);
    if (!e) { e = { date: r.date, tokensByModel: {} }; byDate.set(r.date, e); }
    e.tokensByModel[r.model] = (e.tokensByModel[r.model] || 0) + (r.inputTokens || 0) + (r.outputTokens || 0);
  }
  return Array.from(byDate.values()).sort((a, b) => a.date.localeCompare(b.date));
}

// Mirror of getTotalCounts (metrics half + parent-only session count):
function aggregateTotals(metricRows, cacheRows) {
  let totalMessages = 0, totalToolCalls = 0, totalTokens = 0;
  for (const r of metricRows) {
    totalMessages += r.messageCount || 0;
    totalToolCalls += r.toolCallCount || 0;
    totalTokens += (r.inputTokens || 0) + (r.outputTokens || 0);
  }
  const totalSessions = cacheRows.filter(r => r.parentSessionId == null).length;
  return { totalSessions, totalMessages, totalToolCalls, totalTokens };
}

const FIXTURE = [
  { sessionId: 's1', date: '2026-06-01', model: 'claude-opus-4-8',  messageCount: 4, toolCallCount: 3, inputTokens: 1000, outputTokens: 200 },
  { sessionId: 's1', date: '2026-06-01', model: '',                 messageCount: 3, toolCallCount: 0, inputTokens: 0,    outputTokens: 0 },
  { sessionId: 's2', date: '2026-06-01', model: 'claude-sonnet-4-6', messageCount: 2, toolCallCount: 1, inputTokens: 500, outputTokens: 100 },
  { sessionId: 's2', date: '2026-06-02', model: 'claude-opus-4-8',  messageCount: 5, toolCallCount: 2, inputTokens: 800, outputTokens: 300 },
];

test('aggregateDailyMetrics sums per day across models and counts distinct sessions', () => {
  const rows = aggregateDailyMetrics(FIXTURE);
  assert.equal(rows.length, 2);
  const d1 = rows.find(r => r.date === '2026-06-01');
  const d2 = rows.find(r => r.date === '2026-06-02');
  assert.equal(d1.messageCount, 9);          // 4 + 3 + 2
  assert.equal(d1.toolCallCount, 4);         // 3 + 0 + 1
  assert.equal(d1.tokens, 1800);             // 1200 + 0 + 600
  assert.equal(d1.sessionCount, 2);          // s1, s2
  assert.equal(d2.messageCount, 5);
  assert.equal(d2.tokens, 1100);
  assert.equal(d2.sessionCount, 1);
});

test('aggregateDailyMetrics sorts dates ascending', () => {
  const rows = aggregateDailyMetrics([
    { sessionId: 'x', date: '2026-06-03', model: 'm', messageCount: 1, inputTokens: 1, outputTokens: 0 },
    { sessionId: 'x', date: '2026-06-01', model: 'm', messageCount: 1, inputTokens: 1, outputTokens: 0 },
  ]);
  assert.deepEqual(rows.map(r => r.date), ['2026-06-01', '2026-06-03']);
});

test('aggregateModelUsage groups tokens by model and excludes empty model', () => {
  const usage = aggregateModelUsage(FIXTURE);
  assert.deepEqual(Object.keys(usage).sort(), ['claude-opus-4-8', 'claude-sonnet-4-6']);
  assert.equal(usage['claude-opus-4-8'].inputTokens, 1800);   // 1000 + 800
  assert.equal(usage['claude-opus-4-8'].outputTokens, 500);   // 200 + 300
  assert.equal(usage['claude-sonnet-4-6'].inputTokens, 500);
  assert.ok(!('' in usage), 'empty-model bucket excluded from model usage');
});

test('aggregateDailyModelTokens returns per-date tokensByModel excluding empty model', () => {
  const daily = aggregateDailyModelTokens(FIXTURE);
  assert.equal(daily.length, 2);
  const d1 = daily.find(r => r.date === '2026-06-01');
  assert.equal(d1.tokensByModel['claude-opus-4-8'], 1200);
  assert.equal(d1.tokensByModel['claude-sonnet-4-6'], 600);
  assert.ok(!('' in d1.tokensByModel), 'empty model not present');
  const d2 = daily.find(r => r.date === '2026-06-02');
  assert.equal(d2.tokensByModel['claude-opus-4-8'], 1100);
});

test('aggregateTotals counts only parent sessions and sums metrics', () => {
  const cacheRows = [
    { sessionId: 's1', parentSessionId: null },
    { sessionId: 's2', parentSessionId: null },
    { sessionId: 'sub:s1:a', parentSessionId: 's1' },
    { sessionId: 'sub:s1:b', parentSessionId: 's1' },
  ];
  const totals = aggregateTotals(FIXTURE, cacheRows);
  assert.equal(totals.totalSessions, 2, 'subagents excluded from session count');
  assert.equal(totals.totalMessages, 14);   // 4+3+2+5
  assert.equal(totals.totalToolCalls, 6);    // 3+0+1+2
  assert.equal(totals.totalTokens, 2900);    // 1200+0+600+1100
});

test('aggregates return empty/zero on no rows', () => {
  assert.deepEqual(aggregateDailyMetrics([]), []);
  assert.deepEqual(aggregateModelUsage([]), {});
  assert.deepEqual(aggregateDailyModelTokens([]), []);
  assert.deepEqual(aggregateTotals([], []), { totalSessions: 0, totalMessages: 0, totalToolCalls: 0, totalTokens: 0 });
});
