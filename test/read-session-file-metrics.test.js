const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { readSessionFile, extractDailyMetrics, isToolResultOnly } = require('../read-session-file');

function mkTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-rsfm-'));
}
function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

// Convenience: find the metric row for a given (date, model) pair.
function find(rows, date, model) {
  return rows.find(r => r.date === date && r.model === model);
}

test('isToolResultOnly detects pure tool_result user turns', () => {
  assert.equal(isToolResultOnly([{ type: 'tool_result', content: 'x' }]), true);
  assert.equal(isToolResultOnly([{ type: 'tool_result' }, { type: 'tool_result' }]), true);
  // Mixed content (text + tool_result) is a real message.
  assert.equal(isToolResultOnly([{ type: 'tool_result' }, { type: 'text', text: 'hi' }]), false);
  // Plain text array, empty, or non-array → not tool-result-only.
  assert.equal(isToolResultOnly([{ type: 'text', text: 'hi' }]), false);
  assert.equal(isToolResultOnly([]), false);
  assert.equal(isToolResultOnly('hello'), false);
  assert.equal(isToolResultOnly(undefined), false);
});

test('extractDailyMetrics sums tokens per (date, model) from message.usage', () => {
  const lines = [
    JSON.stringify({ type: 'assistant', timestamp: '2026-06-01T10:00:00.000Z', message: {
      model: 'claude-opus-4-8',
      usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 10, cache_creation_input_tokens: 5 },
    } }),
    JSON.stringify({ type: 'assistant', timestamp: '2026-06-01T11:00:00.000Z', message: {
      model: 'claude-opus-4-8',
      usage: { input_tokens: 200, output_tokens: 80 },
    } }),
  ];
  const rows = extractDailyMetrics(lines, '2026-06-01');
  assert.equal(rows.length, 1);
  const r = find(rows, '2026-06-01', 'claude-opus-4-8');
  assert.ok(r);
  assert.equal(r.inputTokens, 300);
  assert.equal(r.outputTokens, 130);
  assert.equal(r.cacheReadTokens, 10);
  assert.equal(r.cacheCreationTokens, 5);
  assert.equal(r.messageCount, 2);
});

test('extractDailyMetrics buckets by message timestamp, not a single date', () => {
  const lines = [
    JSON.stringify({ type: 'assistant', timestamp: '2026-06-01T23:00:00.000Z', message: { model: 'claude-sonnet-4-6', usage: { input_tokens: 10, output_tokens: 1 } } }),
    JSON.stringify({ type: 'assistant', timestamp: '2026-06-02T01:00:00.000Z', message: { model: 'claude-sonnet-4-6', usage: { input_tokens: 20, output_tokens: 2 } } }),
  ];
  const rows = extractDailyMetrics(lines, '2026-06-02');
  assert.equal(rows.length, 2, 'two distinct dates → two rows');
  assert.equal(find(rows, '2026-06-01', 'claude-sonnet-4-6').inputTokens, 10);
  assert.equal(find(rows, '2026-06-02', 'claude-sonnet-4-6').inputTokens, 20);
});

test('extractDailyMetrics treats <synthetic> and model-less assistant lines as model "" with no tokens', () => {
  const lines = [
    JSON.stringify({ type: 'assistant', timestamp: '2026-06-01T10:00:00.000Z', message: { model: '<synthetic>', usage: { input_tokens: 999, output_tokens: 999 } } }),
    JSON.stringify({ type: 'assistant', timestamp: '2026-06-01T10:01:00.000Z', message: { usage: { input_tokens: 5, output_tokens: 5 } } }),
  ];
  const rows = extractDailyMetrics(lines, '2026-06-01');
  const r = find(rows, '2026-06-01', '');
  assert.ok(r, 'should bucket under empty model');
  assert.equal(r.messageCount, 2, 'both still count as messages');
  assert.equal(r.inputTokens, 0, 'synthetic/model-less tokens are not attributed');
  assert.equal(r.outputTokens, 0);
});

test('extractDailyMetrics counts tool_use blocks', () => {
  const lines = [
    JSON.stringify({ type: 'assistant', timestamp: '2026-06-01T10:00:00.000Z', message: {
      model: 'claude-opus-4-8',
      usage: { input_tokens: 1, output_tokens: 1 },
      content: [
        { type: 'text', text: 'doing things' },
        { type: 'tool_use', name: 'Bash' },
        { type: 'tool_use', name: 'Read' },
      ],
    } }),
  ];
  const rows = extractDailyMetrics(lines, '2026-06-01');
  const r = find(rows, '2026-06-01', 'claude-opus-4-8');
  assert.equal(r.toolCallCount, 2);
});

test('extractDailyMetrics does NOT count tool_result-only user turns as messages', () => {
  const lines = [
    JSON.stringify({ type: 'user', timestamp: '2026-06-01T10:00:00.000Z', message: { content: 'real question' } }),
    JSON.stringify({ type: 'user', timestamp: '2026-06-01T10:00:30.000Z', message: { content: [{ type: 'tool_result', content: 'out' }] } }),
    JSON.stringify({ type: 'assistant', timestamp: '2026-06-01T10:01:00.000Z', message: { model: 'claude-opus-4-8', usage: { input_tokens: 1, output_tokens: 1 } } }),
  ];
  const rows = extractDailyMetrics(lines, '2026-06-01');
  const userRow = find(rows, '2026-06-01', '');
  assert.equal(userRow.messageCount, 1, 'only the real user turn counts, not the tool_result-only one');
});

test('extractDailyMetrics falls back to fallbackDate when timestamp is missing', () => {
  const lines = [
    JSON.stringify({ type: 'assistant', message: { model: 'claude-opus-4-8', usage: { input_tokens: 7, output_tokens: 3 } } }),
  ];
  const rows = extractDailyMetrics(lines, '2026-05-30');
  const r = find(rows, '2026-05-30', 'claude-opus-4-8');
  assert.ok(r);
  assert.equal(r.inputTokens, 7);
});

test('extractDailyMetrics ignores non-message line types and malformed JSON', () => {
  const lines = [
    JSON.stringify({ type: 'summary', summary: 'x', timestamp: '2026-06-01T10:00:00.000Z' }),
    JSON.stringify({ type: 'custom-title', customTitle: 'My session', timestamp: '2026-06-01T10:00:00.000Z' }),
    '{ this is not valid json',
    JSON.stringify({ type: 'assistant', timestamp: '2026-06-01T10:00:00.000Z', message: { model: 'claude-opus-4-8', usage: { input_tokens: 4, output_tokens: 2 } } }),
  ];
  const rows = extractDailyMetrics(lines, '2026-06-01');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].model, 'claude-opus-4-8');
  assert.equal(rows[0].messageCount, 1);
});

test('readSessionFile attaches dailyMetrics to the returned session object', () => {
  const tmp = mkTmp();
  try {
    const lines = [
      JSON.stringify({ type: 'user', timestamp: '2026-06-01T09:00:00.000Z', message: 'hello, please help' }),
      JSON.stringify({ type: 'assistant', timestamp: '2026-06-01T09:01:00.000Z', message: {
        model: 'claude-opus-4-8',
        usage: { input_tokens: 120, output_tokens: 40 },
        content: [{ type: 'tool_use', name: 'Bash' }],
      } }),
      JSON.stringify({ type: 'user', timestamp: '2026-06-01T09:01:30.000Z', message: { content: [{ type: 'tool_result', content: 'ok' }] } }),
    ];
    const file = path.join(tmp, 'sess-1.jsonl');
    fs.writeFileSync(file, lines.join('\n') + '\n', 'utf8');

    const s = readSessionFile(file, 'folder', '/some/project');
    assert.ok(s, 'session should parse');
    assert.ok(Array.isArray(s.dailyMetrics), 'dailyMetrics present');

    const opus = s.dailyMetrics.find(r => r.model === 'claude-opus-4-8');
    assert.ok(opus);
    assert.equal(opus.inputTokens, 120);
    assert.equal(opus.outputTokens, 40);
    assert.equal(opus.toolCallCount, 1);
    assert.equal(opus.messageCount, 1);

    const userBucket = s.dailyMetrics.find(r => r.model === '');
    assert.ok(userBucket);
    assert.equal(userBucket.messageCount, 1, 'only the real user turn, tool_result-only excluded');
  } finally {
    cleanup(tmp);
  }
});
