// test/analytics-aggregator.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const agg = require('../analytics-aggregator.js');

function asstLine({ ts, model, usage, content }) {
  return JSON.stringify({
    type: 'assistant', timestamp: ts,
    message: { model, usage, content: content || [] },
  });
}

test('processLine: ignores non-assistant entries', () => {
  const s = agg.emptyState();
  agg.processLine(JSON.stringify({ type: 'user', message: { content: 'hi' } }), 's1', '/p', () => 'default', s);
  agg.processLine(JSON.stringify({ type: 'file-history-snapshot', x: 1 }), 's1', '/p', () => 'default', s);
  assert.deepStrictEqual(s.byBackend, {});
  assert.strictEqual(s.totals.turns, 0);
});

test('processLine: aggregates token counts and tags by backend', () => {
  const s = agg.emptyState();
  const line = asstLine({
    ts: '2026-05-01T10:00:00Z',
    model: 'deepseek-v4-pro',
    usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 200, cache_creation_input_tokens: 10 },
    content: [{ type: 'text', text: 'ok' }],
  });
  agg.processLine(line, 's-1', '/p', (sid) => 'deepseek', s);

  assert.strictEqual(s.byBackend.deepseek.turns, 1);
  assert.strictEqual(s.byBackend.deepseek.inputTokens, 100);
  assert.strictEqual(s.byBackend.deepseek.outputTokens, 50);
  assert.strictEqual(s.byBackend.deepseek.cacheReadTokens, 200);
  assert.strictEqual(s.byBackend.deepseek.cacheCreationTokens, 10);
  assert.deepStrictEqual(Object.keys(s.byBackend.deepseek.sessionIds), ['s-1']);
  assert.strictEqual(s.byBackend.deepseek.models['deepseek-v4-pro'].turns, 1);
});

test('processLine: detects tool_use and Task subagents', () => {
  const s = agg.emptyState();
  agg.processLine(asstLine({
    ts: '2026-05-01T10:00:00Z', model: 'm', usage: { output_tokens: 1 },
    content: [
      { type: 'text', text: 'about to call tools' },
      { type: 'tool_use', name: 'Read', input: {} },
      { type: 'tool_use', name: 'Task', input: {} },
    ],
  }), 's', '/p', () => 'b', s);
  assert.strictEqual(s.byBackend.b.toolUseTurns, 1);
  assert.strictEqual(s.byBackend.b.subagentInvocations, 1);
});

test('processLine: skips zero-usage turns (streaming chunk debris)', () => {
  const s = agg.emptyState();
  agg.processLine(asstLine({
    ts: '2026-05-01T10:00:00Z', model: 'm', usage: {},
  }), 's', '/p', () => 'b', s);
  assert.deepStrictEqual(s.byBackend, {});
});

test('processLine: rolls up by day correctly', () => {
  const s = agg.emptyState();
  agg.processLine(asstLine({ ts: '2026-05-01T10:00:00Z', model: 'm', usage: { output_tokens: 5 } }), 's', '/p', () => 'b', s);
  agg.processLine(asstLine({ ts: '2026-05-01T15:00:00Z', model: 'm', usage: { output_tokens: 7 } }), 's', '/p', () => 'b', s);
  agg.processLine(asstLine({ ts: '2026-05-02T05:00:00Z', model: 'm', usage: { output_tokens: 3 } }), 's', '/p', () => 'b', s);
  assert.strictEqual(s.byDay['2026-05-01'].outputTokens, 12);
  assert.strictEqual(s.byDay['2026-05-02'].outputTokens, 3);
  assert.strictEqual(s.byDay['2026-05-01'].byBackend.b.outputTokens, 12);
});

test('processLine: malformed JSON is silently skipped', () => {
  const s = agg.emptyState();
  agg.processLine('{not json', 's', '/p', () => 'b', s);
  agg.processLine('', 's', '/p', () => 'b', s);
  assert.deepStrictEqual(s.byBackend, {});
});

test('processLine: backendResolver fallback to "default"', () => {
  const s = agg.emptyState();
  agg.processLine(asstLine({ ts: '2026-05-01T10:00:00Z', model: 'm', usage: { output_tokens: 1 } }),
    's', '/p', () => null, s);
  assert.ok(s.byBackend.default);
  assert.strictEqual(s.byBackend.default.turns, 1);
});

test('processChunk: returns bytes consumed only up to last newline', () => {
  const s = agg.emptyState();
  const l1 = asstLine({ ts: '2026-05-01T10:00:00Z', model: 'm', usage: { output_tokens: 1 } });
  const l2 = asstLine({ ts: '2026-05-01T11:00:00Z', model: 'm', usage: { output_tokens: 2 } });
  // Two complete lines + a partial third
  const text = l1 + '\n' + l2 + '\n' + '{partial-line';
  const consumed = agg.processChunk(text, 's', '/p', () => 'b', s);
  assert.strictEqual(consumed, Buffer.byteLength(l1 + '\n' + l2, 'utf8') + 1);
  assert.strictEqual(s.byBackend.b.turns, 2);
});

test('processChunk: returns 0 when no newline', () => {
  const s = agg.emptyState();
  const consumed = agg.processChunk('{partial', 's', '/p', () => 'b', s);
  assert.strictEqual(consumed, 0);
  assert.deepStrictEqual(s.byBackend, {});
});

test('deriveBackendMetrics: cache hit rate, ratios, density', () => {
  const s = agg.emptyState();
  // 2 turns: 1 has tool_use, 1 has subagent
  agg.processLine(asstLine({
    ts: '2026-05-01T10:00:00Z', model: 'm',
    usage: { input_tokens: 100, output_tokens: 200, cache_read_input_tokens: 300 },
    content: [{ type: 'tool_use', name: 'Read', input: {} }],
  }), 's1', '/p', () => 'b', s);
  agg.processLine(asstLine({
    ts: '2026-05-01T11:00:00Z', model: 'm',
    usage: { input_tokens: 50, output_tokens: 50, cache_read_input_tokens: 100 },
    content: [{ type: 'tool_use', name: 'Task', input: {} }],
  }), 's2', '/p', () => 'b', s);

  const m = agg.deriveBackendMetrics(s.byBackend.b);
  assert.strictEqual(m.sessions, 2);
  assert.strictEqual(m.turns, 2);
  assert.strictEqual(m.toolUseTurns, 2);
  assert.strictEqual(m.subagentInvocations, 1);
  // cacheReadTokens = 400, inputTokens = 150, totalInput = 550 → hit rate = 400/550
  assert.ok(Math.abs(m.cacheHitRate - 400 / 550) < 1e-9);
  // outputTokens = 250, inputTokens = 150 → ratio = 250/150
  assert.ok(Math.abs(m.outputInputRatio - 250 / 150) < 1e-9);
  // toolUseTurns / turns = 2/2 = 1
  assert.strictEqual(m.toolUseDensity, 1);
  // subagentInvocations / turns = 1/2
  assert.strictEqual(m.subagentRate, 0.5);
  assert.strictEqual(m.avgTurnsPerSession, 1);
});

test('processLine: multiple sessions count distinctly per backend', () => {
  const s = agg.emptyState();
  for (let i = 0; i < 5; i++) {
    agg.processLine(asstLine({
      ts: '2026-05-01T10:00:00Z', model: 'm', usage: { output_tokens: 1 },
    }), 'session-' + i, '/p', () => 'b', s);
  }
  assert.strictEqual(Object.keys(s.byBackend.b.sessionIds).length, 5);
  assert.strictEqual(s.byBackend.b.turns, 5);
});

test('pruneDays: drops days older than retention window', () => {
  const s = agg.emptyState();
  s.byDay['2020-01-01'] = { turns: 1 };
  s.byDay['2020-01-02'] = { turns: 1 };
  // Today's date — should survive any reasonable retention setting
  const today = new Date().toISOString().slice(0, 10);
  s.byDay[today] = { turns: 1 };
  agg.pruneDays(s, 30);
  assert.strictEqual(s.byDay['2020-01-01'], undefined);
  assert.strictEqual(s.byDay['2020-01-02'], undefined);
  assert.ok(s.byDay[today]);
});

test('processLine: dominantModel reflects most-recent model for the session', () => {
  const s = agg.emptyState();
  agg.processLine(asstLine({ ts: '2026-05-01T10:00:00Z', model: 'first-model', usage: { output_tokens: 1 } }),
    'sx', '/p', () => 'b', s);
  agg.processLine(asstLine({ ts: '2026-05-01T11:00:00Z', model: 'second-model', usage: { output_tokens: 1 } }),
    'sx', '/p', () => 'b', s);
  assert.strictEqual(s.recentSessions['sx'].dominantModel, 'second-model');
  assert.strictEqual(s.recentSessions['sx'].turns, 2);
});
