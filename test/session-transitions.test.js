const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const sessionTransitions = require('../session-transitions');
const { detectSubagentTransitions, init } = sessionTransitions;

function mkTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-st-'));
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

/** Build a mock mainWindow that records every webContents.send call. */
function makeMockWindow() {
  const events = [];
  return {
    isDestroyed: () => false,
    webContents: {
      send: (channel, payload) => events.push({ channel, payload }),
    },
    _events: events,
  };
}

/** Initialize the module with mocks. Returns the recorded-events array. */
function setupModule() {
  const win = makeMockWindow();
  init({
    PROJECTS_DIR: '/unused',
    activeSessions: new Map(),
    getMainWindow: () => win,
    log: { info: () => {}, debug: () => {}, warn: () => {}, error: () => {} },
    rekeyMcpServer: () => {},
  });
  return win._events;
}

/** Create N agent jsonl files under <folder>/<sessionId>/subagents/ and
 *  set their mtimes to (now - ageMs). Returns the subagents dir. */
function seedAgents(folder, sessionId, agents) {
  const subDir = path.join(folder, sessionId, 'subagents');
  fs.mkdirSync(subDir, { recursive: true });
  for (const { id, ageMs = 0, content = '' } of agents) {
    const filePath = path.join(subDir, `agent-${id}.jsonl`);
    fs.writeFileSync(filePath, content, 'utf8');
    if (ageMs) {
      const t = (Date.now() - ageMs) / 1000;
      fs.utimesSync(filePath, t, t);
    }
  }
  return subDir;
}

test('bootstrap call with 5 pre-existing subagents emits zero events and populates the map', () => {
  const events = setupModule();
  const tmp = mkTmp();
  try {
    const sessionId = 'parent-session';
    seedAgents(tmp, sessionId, [
      { id: 'a1' }, { id: 'a2' }, { id: 'a3' }, { id: 'a4' }, { id: 'a5' },
    ]);

    const session = {}; // knownSubagents undefined → bootstrap
    detectSubagentTransitions(sessionId, session, tmp);

    assert.equal(events.length, 0, 'bootstrap must not emit IPC');
    assert.ok(session.knownSubagents instanceof Map);
    assert.equal(session.knownSubagents.size, 5);
  } finally {
    cleanup(tmp);
  }
});

test('bootstrap marks an old-mtime agent (>60s) as completed: true', () => {
  const events = setupModule();
  const tmp = mkTmp();
  try {
    const sessionId = 'parent';
    seedAgents(tmp, sessionId, [{ id: 'oldie', ageMs: 120_000 }]); // 2 minutes old

    const session = {};
    detectSubagentTransitions(sessionId, session, tmp);

    assert.equal(events.length, 0);
    const entry = session.knownSubagents.get('oldie');
    assert.ok(entry, 'expected an entry for oldie');
    assert.equal(entry.completed, true);
    assert.ok(entry._completedAt, 'expected _completedAt to be stamped');
  } finally {
    cleanup(tmp);
  }
});

test('bootstrap marks a fresh-mtime agent as completed: false (lifecycle continues)', () => {
  const events = setupModule();
  const tmp = mkTmp();
  try {
    const sessionId = 'parent';
    seedAgents(tmp, sessionId, [{ id: 'fresh', ageMs: 5_000 }]); // 5s old, well under 60s

    const session = {};
    detectSubagentTransitions(sessionId, session, tmp);

    assert.equal(events.length, 0, 'bootstrap must still be silent for fresh agents');
    const entry = session.knownSubagents.get('fresh');
    assert.ok(entry);
    assert.equal(entry.completed, false);
    assert.equal(entry._completedAt, null);
  } finally {
    cleanup(tmp);
  }
});

test('post-bootstrap: a brand-new agent file emits exactly one subagent-spawned event', () => {
  const events = setupModule();
  const tmp = mkTmp();
  try {
    const sessionId = 'parent';
    // First, bootstrap with empty subagents dir
    fs.mkdirSync(path.join(tmp, sessionId, 'subagents'), { recursive: true });
    const session = {};
    detectSubagentTransitions(sessionId, session, tmp);
    assert.equal(events.length, 0);
    assert.equal(session.knownSubagents.size, 0);

    // Now drop in a new agent file and re-run
    seedAgents(tmp, sessionId, [{ id: 'newcomer' }]);
    detectSubagentTransitions(sessionId, session, tmp);

    assert.equal(events.length, 1, `expected 1 event, got ${events.length}`);
    assert.equal(events[0].channel, 'subagent-spawned');
    assert.equal(events[0].payload.parentSessionId, sessionId);
    assert.equal(events[0].payload.agentId, 'newcomer');
    assert.equal(session.knownSubagents.get('newcomer').completed, false);
  } finally {
    cleanup(tmp);
  }
});

test('post-bootstrap with no new agents emits zero events (IPC-flood regression)', () => {
  const events = setupModule();
  const tmp = mkTmp();
  try {
    const sessionId = 'parent';
    seedAgents(tmp, sessionId, [{ id: 'a' }, { id: 'b' }, { id: 'c' }]);

    const session = {};
    // Bootstrap absorbs all three silently
    detectSubagentTransitions(sessionId, session, tmp);
    assert.equal(events.length, 0);

    // Subsequent flushes with no new files must stay silent
    detectSubagentTransitions(sessionId, session, tmp);
    detectSubagentTransitions(sessionId, session, tmp);
    detectSubagentTransitions(sessionId, session, tmp);

    assert.equal(events.length, 0, 'no events should fire when nothing changed');
  } finally {
    cleanup(tmp);
  }
});

test('completion: agent alive on call N, stable mtime for >30s on call N+1, emits subagent-completed', () => {
  const events = setupModule();
  const tmp = mkTmp();
  try {
    const sessionId = 'parent';
    const subDir = seedAgents(tmp, sessionId, [{ id: 'slow' }]);
    const filePath = path.join(subDir, 'agent-slow.jsonl');
    const mtimeMs = fs.statSync(filePath).mtimeMs;

    // Pre-seed knownSubagents as if a prior call already saw this agent alive
    // and started the stability timer 31 seconds ago. This skips bootstrap mode
    // since knownSubagents is already defined.
    const session = { knownSubagents: new Map() };
    session.knownSubagents.set('slow', {
      mtimeMs, // same as file's actual mtime → "mtime stable"
      completed: false,
      _stableStart: Date.now() - 31_000, // stability started >30s ago
    });

    detectSubagentTransitions(sessionId, session, tmp);

    assert.equal(events.length, 1, `expected 1 completion event, got ${events.length}: ${JSON.stringify(events)}`);
    assert.equal(events[0].channel, 'subagent-completed');
    assert.equal(events[0].payload.parentSessionId, sessionId);
    assert.equal(events[0].payload.agentId, 'slow');
    assert.equal(session.knownSubagents.get('slow').completed, true);
  } finally {
    cleanup(tmp);
  }
});
