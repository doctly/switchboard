const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../public/stats-view.js'), 'utf8');

async function render({ stats = null, statsError = null, usage = {}, codexUsage = {}, reject = false, rejectCache = false } = {}) {
  const body = {
    children: [], html: '',
    set innerHTML(value) { this.html = value; this.children = []; },
    get innerHTML() { return this.html; },
    appendChild(child) { this.children.push(child); },
  };
  const rendered = { charts: [], usage: [] };
  const context = {
    document: { createElement: () => ({ setAttribute(name, value) { this[name] = value; } }) },
    statsViewerBody: body,
    escapeHtml: value => value,
    window: { api: {
      refreshStats: async () => {
        if (reject) throw new Error('IPC unavailable');
        return { stats, statsError, usage };
      },
      getStats: async () => {
        if (rejectCache) throw new Error('cache unavailable');
        return stats;
      },
      getCodexUsage: async () => codexUsage,
    } },
  };
  vm.runInNewContext(source, context);
  context.buildHeatmap = () => {};
  context.buildDailyBarChart = value => rendered.charts.push(value);
  context.buildStatsSummary = () => {};
  context.buildUsageSection = (value, { runtime }) => rendered.usage.push({ runtime, value });
  await context.loadStats();
  return { body, rendered, error: body.children.find(child => child.className === 'stats-refresh-error') };
}

test('failed refresh keeps cached charts and both independent usage panels visible', async () => {
  const stats = { lastComputedDate: '2026-08-20', dailyActivity: [] };
  const { rendered, error } = await render({
    stats, statsError: 'Stats cache did not advance after refreshing.',
    usage: { session: 12 }, codexUsage: { limits: [{ percent: 20 }] },
  });
  assert.equal(rendered.charts[0], stats);
  assert.deepEqual(rendered.usage.map(panel => panel.runtime), ['claude', 'codex']);
  assert.match(error.textContent, /Stats refresh failed.*did not advance.*Showing cached data/);
  assert.equal(error.role, 'status');
});

test('first-time refresh failure displays its error instead of the no-sessions empty state', async () => {
  const { body, error } = await render({ statsError: 'Claude exited before stats finished.' });
  assert.match(error.textContent, /Claude exited/);
  assert.doesNotMatch(error.textContent, /Showing cached/);
  assert.doesNotMatch(body.innerHTML, /Run some sessions first/);
});

test('successful repeat refresh displays no error', async () => {
  const { error, rendered } = await render({ stats: { lastComputedDate: '2026-09-06' } });
  assert.equal(error, undefined);
  assert.equal(rendered.charts.length, 1);
});

test('IPC rejection displays a failure while falling back to cached charts', async () => {
  const { error, rendered } = await render({ stats: { lastComputedDate: '2026-08-20' }, reject: true });
  assert.match(error.textContent, /Could not refresh stats.*Showing cached data/);
  assert.equal(rendered.charts.length, 1);
});

test('a failed cache fallback still clears the spinner and displays the error', async () => {
  const { body, error } = await render({ reject: true, rejectCache: true });
  assert.match(error.textContent, /Could not refresh stats/);
  assert.equal(body.children.some(child => child.className === 'stats-spinner'), false);
});
