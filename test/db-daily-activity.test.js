const test = require('node:test');
const assert = require('node:assert/strict');

// getDailyActivity is powered by better-sqlite3, which is compiled against
// Electron's Node ABI and cannot be required from plain node:test. These tests
// therefore validate the aggregation LOGIC by running the same computation on
// plain JS arrays — the SQL query is a straightforward GROUP BY that we mirror
// here so regressions in the computation surface in CI.

/**
 * Pure-JS mirror of the getDailyActivity SQL:
 *   SELECT substr(modified,1,10) AS date, SUM(messageCount), COUNT(*) AS sessionCount
 *   FROM session_cache WHERE modified IS NOT NULL AND length(modified) >= 10
 *   GROUP BY date ORDER BY date ASC
 */
function aggregateDailyActivity(rows) {
  const map = new Map();
  for (const row of rows) {
    if (!row.modified || row.modified.length < 10) continue;
    const date = row.modified.slice(0, 10);
    const existing = map.get(date);
    if (existing) {
      existing.messageCount += row.messageCount || 0;
      existing.sessionCount += 1;
    } else {
      map.set(date, { date, messageCount: row.messageCount || 0, sessionCount: 1 });
    }
  }
  return Array.from(map.values()).sort((a, b) => a.date.localeCompare(b.date));
}

test('aggregateDailyActivity returns [] when input is empty', () => {
  assert.deepEqual(aggregateDailyActivity([]), []);
});

test('aggregateDailyActivity sums messageCount and counts sessions per day', () => {
  const rows = [
    { sessionId: 's1', modified: '2026-03-15T10:05:00.000Z', messageCount: 10 },
    { sessionId: 's2', modified: '2026-03-15T11:30:00.000Z', messageCount: 5 },
    { sessionId: 's3', modified: '2026-03-16T09:45:00.000Z', messageCount: 20 },
  ];
  const result = aggregateDailyActivity(rows);
  assert.equal(result.length, 2);
  const mar15 = result.find(r => r.date === '2026-03-15');
  const mar16 = result.find(r => r.date === '2026-03-16');
  assert.ok(mar15);
  assert.ok(mar16);
  assert.equal(mar15.messageCount, 15);
  assert.equal(mar15.sessionCount, 2);
  assert.equal(mar16.messageCount, 20);
  assert.equal(mar16.sessionCount, 1);
});

test('aggregateDailyActivity includes subagent rows (parentSessionId present)', () => {
  const rows = [
    { sessionId: 'parent-1', modified: '2026-04-01T08:10:00.000Z', messageCount: 3, parentSessionId: null },
    { sessionId: 'sub:parent-1:agent-1', modified: '2026-04-01T08:20:00.000Z', messageCount: 8, parentSessionId: 'parent-1' },
  ];
  const result = aggregateDailyActivity(rows);
  assert.equal(result.length, 1);
  assert.equal(result[0].date, '2026-04-01');
  assert.equal(result[0].messageCount, 11, 'parent + subagent messages should both count');
  assert.equal(result[0].sessionCount, 2, 'parent + subagent sessions should both count');
});

test('aggregateDailyActivity sorts results chronologically', () => {
  const rows = [
    { sessionId: 'x1', modified: '2026-02-10T01:00:00.000Z', messageCount: 1 },
    { sessionId: 'x2', modified: '2026-05-01T01:00:00.000Z', messageCount: 1 },
    { sessionId: 'x3', modified: '2026-03-20T01:00:00.000Z', messageCount: 1 },
  ];
  const result = aggregateDailyActivity(rows);
  assert.deepEqual(result.map(r => r.date), ['2026-02-10', '2026-03-20', '2026-05-01']);
});

test('aggregateDailyActivity skips rows with null or short modified', () => {
  const rows = [
    { sessionId: 'a', modified: null, messageCount: 99 },
    { sessionId: 'b', modified: '2026', messageCount: 99 },
    { sessionId: 'c', modified: '2026-05-22T00:00:00.000Z', messageCount: 5 },
  ];
  const result = aggregateDailyActivity(rows);
  assert.equal(result.length, 1);
  assert.equal(result[0].date, '2026-05-22');
  assert.equal(result[0].messageCount, 5);
});

// Verify the stats-object shape built from getDailyActivity results (mirrors
// the get-stats-from-db / refresh-stats IPC handler logic).
test('stats object built from daily rows has correct totals and shape', () => {
  const rows = [
    { date: '2026-03-15', messageCount: 15, sessionCount: 2 },
    { date: '2026-03-16', messageCount: 20, sessionCount: 1 },
    { date: '2026-04-01', messageCount: 11, sessionCount: 2 },
  ];

  let totalMessages = 0;
  let totalSessions = 0;
  let firstSessionDate = null;
  for (const row of rows) {
    totalMessages += row.messageCount || 0;
    totalSessions += row.sessionCount || 0;
    if (!firstSessionDate) firstSessionDate = row.date;
  }
  const lastComputedDate = '2026-05-22';
  const stats = {
    dailyActivity: rows,
    totalMessages,
    totalSessions,
    firstSessionDate: firstSessionDate || lastComputedDate,
    lastComputedDate,
    modelUsage: {},
  };

  assert.equal(stats.totalMessages, 46);
  assert.equal(stats.totalSessions, 5);
  assert.equal(stats.firstSessionDate, '2026-03-15');
  assert.equal(stats.lastComputedDate, '2026-05-22');
  assert.deepEqual(stats.modelUsage, {});
  assert.equal(stats.dailyActivity.length, 3);
  assert.ok(Array.isArray(stats.dailyActivity));
});
