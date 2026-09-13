const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  terminalBufferText,
  restoredTerminalHistoryAnsi,
  persistedTerminalRecord,
  parsePersistedTerminalSessions,
  forgetTerminalHistory,
} = require('../public/terminal-manager');

function fakeBuffer(rows) {
  return {
    length: rows.length,
    getLine(index) {
      const row = rows[index];
      if (!row) return null;
      return {
        isWrapped: !!row.wrapped,
        translateToString: () => row.text,
      };
    },
  };
}

test('terminal history keeps a bounded tail and joins wrapped rows', () => {
  const buffer = fakeBuffer([
    { text: 'discard me' },
    { text: 'one' },
    { text: ' continued', wrapped: true },
    { text: 'two' },
    { text: '' },
  ]);
  assert.equal(terminalBufferText(buffer, 4, 1000), 'one continued\ntwo');
});

test('terminal history drops a partial first line when capped by characters', () => {
  const buffer = fakeBuffer([
    { text: 'first line' },
    { text: 'second line' },
    { text: 'third line' },
  ]);
  assert.equal(terminalBufferText(buffer, 20, 18), 'third line');
});

test('restored history is grey and resets styling before live output', () => {
  const rendered = restoredTerminalHistoryAnsi('old\ntext');
  assert.match(rendered, /^\x1b\[90mold\r\ntext/);
  assert.match(rendered, /\x1b\[0m\r\n$/);
});

test('raw terminal persistence retains its project, track and starting folder', () => {
  const record = persistedTerminalRecord({
    sessionId: 'terminal-1',
    projectPath: '/work/attached-repo',
    projectId: 'project-1',
    trackId: 'track-1',
    created: '2026-09-04T00:00:00.000Z',
    modified: '2026-09-04T00:00:00.000Z',
    type: 'terminal',
  });
  assert.equal(record.sessionId, 'terminal-1');
  assert.equal(record.projectPath, '/work/attached-repo');
  assert.equal(record.projectId, 'project-1');
  assert.equal(record.trackId, 'track-1');
  assert.equal(record.type, 'terminal');
});

test('only valid raw terminals are restored, once per id', () => {
  const raw = JSON.stringify([
    { sessionId: 'terminal-1', projectPath: '/work/one', projectId: 'project-1', type: 'terminal' },
    { sessionId: 'terminal-1', projectPath: '/work/duplicate', type: 'terminal' },
    { sessionId: 'agent-1', projectPath: '/work/one', type: 'claude' },
    { sessionId: 'missing-path', type: 'terminal' },
  ]);
  assert.deepEqual(
    parsePersistedTerminalSessions(raw).map(session => [session.sessionId, session.projectPath]),
    [['terminal-1', '/work/one']],
  );
  assert.deepEqual(parsePersistedTerminalSessions('{bad json'), []);
});

test('forgetting terminal history removes only the closed or archived session', () => {
  const previousLocalStorage = global.localStorage;
  const values = new Map([['terminalHistory.v1', JSON.stringify({
    closed: { text: 'old output', savedAt: 1 },
    retained: { text: 'keep me', savedAt: 2 },
  })]]);
  global.localStorage = {
    getItem: key => values.get(key) || null,
    setItem: (key, value) => values.set(key, value),
  };
  try {
    forgetTerminalHistory('closed');
    assert.deepEqual(JSON.parse(values.get('terminalHistory.v1')), {
      retained: { text: 'keep me', savedAt: 2 },
    });
  } finally {
    if (previousLocalStorage === undefined) delete global.localStorage;
    else global.localStorage = previousLocalStorage;
  }
});
