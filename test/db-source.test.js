const { test, before } = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

// Point the DB at a throwaway temp file BEFORE requiring db.js.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swb-db-src-'));
process.env.SWITCHBOARD_DATA_DIR = tmpDir;
process.env.SWITCHBOARD_DB_PATH = path.join(tmpDir, 'test.db');

const db = require('../db');

const localSession = (id, folder, projectPath, modified) => ({
  sessionId: id, folder, projectPath, summary: 's', firstPrompt: 's',
  created: 'C', modified, messageCount: 1, slug: null, aiTitle: null,
});
const remoteSession = (id, folder, projectPath, modified, source) => ({
  ...localSession(id, folder, projectPath, modified), source,
});

test('source defaults to NULL for local rows and is stored for remote rows', () => {
  db.upsertCachedSessions([
    localSession('L1', 'F', '/local/p', 'M1'),
    remoteSession('R1', 'F', 'ssh://gpu/~/p', 'M2', 'host-1'),
  ]);
  const rows = db.getAllCached();
  const l = rows.find(r => r.sessionId === 'L1');
  const r = rows.find(r => r.sessionId === 'R1');
  assert.strictEqual(l.source, null);
  assert.strictEqual(r.source, 'host-1');
});

test('getCachedByFolder returns only local rows (source IS NULL)', () => {
  // L1 (local) and R1 (remote) share folder "F"
  const rows = db.getCachedByFolder('F');
  assert.deepStrictEqual(rows.map(r => r.sessionId), ['L1']);
});

test('getCachedBySource returns remote rows for a host', () => {
  const rows = db.getCachedBySource('host-1');
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].sessionId, 'R1');
  assert.strictEqual(rows[0].modified, 'M2');
});

test('deleteCachedFolder removes only local rows, leaving remote rows in the same folder', () => {
  db.deleteCachedFolder('F');
  const rows = db.getAllCached();
  assert.strictEqual(rows.find(r => r.sessionId === 'L1'), undefined);
  assert.ok(rows.find(r => r.sessionId === 'R1'), 'remote row must survive local folder delete');
});

test('search indexes both local and remote sessions; source is stored', () => {
  db.upsertCachedSessions([
    localSession('L2', 'G', '/local/g', 'M3'),
    remoteSession('R2', 'H', 'ssh://gpu/~/g', 'M4', 'host-1'),
  ]);
  db.upsertSearchEntries([
    { id: 'L2', type: 'session', folder: 'G', source: null, title: 'local widget', body: 'alpha' },
    { id: 'R2', type: 'session', folder: 'H', source: 'host-1', title: 'remote widget', body: 'beta' },
  ]);
  const hits = db.searchByType('session', 'widget', 50).map(h => h.id).sort();
  assert.deepStrictEqual(hits, ['L2', 'R2']);
});

test('deleteRemoteProjectCache removes only that host+project rows and their search entries', () => {
  db.deleteRemoteProjectCache('host-1', 'ssh://gpu/~/g');
  const rows = db.getAllCached();
  assert.strictEqual(rows.find(r => r.sessionId === 'R2'), undefined, 'remote cache row removed');
  assert.ok(rows.find(r => r.sessionId === 'L2'), 'unrelated local row kept');
  const hits = db.searchByType('session', 'widget', 50).map(h => h.id);
  assert.deepStrictEqual(hits, ['L2'], 'remote search entry removed, local kept');
});
