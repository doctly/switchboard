const { test } = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

// Temp DB (needs the Electron-built better-sqlite3 → run via `npm test`).
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swb-sync-'));
process.env.SWITCHBOARD_DATA_DIR = tmpDir;
process.env.SWITCHBOARD_DB_PATH = path.join(tmpDir, 'test.db');
const db = require('../db');

const { syncRemoteHost } = require('../remote-index');

const userMsg = (t, ts) => JSON.stringify({ type: 'user', timestamp: ts, message: { role: 'user', content: t } });
const asstMsg = (t, ts) => JSON.stringify({ type: 'assistant', timestamp: ts, message: { role: 'assistant', content: [{ type: 'text', text: t }] } });

const HOST = { id: 'h1', label: 'gpu' };
const PROJ_A = '/home/u/.claude/projects/-home-u-proj-a/S1.jsonl';
const PROJ_B = '/home/u/.claude/projects/-home-u-proj-b/S2.jsonl';
const CONTENT = {
  [PROJ_A]: [userMsg('work on A', '2026-01-01T00:00:00Z'), asstMsg('ok', '2026-01-01T00:01:00Z')].join('\n'),
  [PROJ_B]: [userMsg('work on B', '2026-01-02T00:00:00Z'), asstMsg('ok', '2026-01-02T00:01:00Z')].join('\n'),
};

function fakeRunners(listingLines) {
  return {
    runText: async () => listingLines.join('\n'),
    runRaw: async (_kind, paths) => {
      const parts = [];
      for (const p of paths) {
        if (CONTENT[p]) parts.push(Buffer.from(`SWBF ${Buffer.byteLength(CONTENT[p])} ${p}\n`), Buffer.from(CONTENT[p]));
      }
      return Buffer.concat(parts);
    },
  };
}

test('syncRemoteHost auto-discovers ALL sessions on the host, grouped by cwd', async () => {
  const listing = [
    `${PROJ_A}\t1700000000\t"cwd":"/home/u/proj-a"`,
    `${PROJ_B}\t1700000100\t"cwd":"/home/u/proj-b"`,
  ];
  const { runText, runRaw } = fakeRunners(listing);
  const res = await syncRemoteHost({ host: HOST, sock: '/tmp/s', db, runText, runRaw });
  assert.strictEqual(res.indexed, 2, 'both sessions indexed with no registered projects');

  const rows = db.getAllCached();
  const s1 = rows.find(r => r.sessionId === 'S1');
  const s2 = rows.find(r => r.sessionId === 'S2');
  assert.strictEqual(s1.source, 'h1');
  assert.strictEqual(s1.projectPath, 'ssh://gpu/~/proj-a', 'cwd → ~/proj-a project path');
  assert.strictEqual(s2.projectPath, 'ssh://gpu/~/proj-b', 'cwd → ~/proj-b project path');
  assert.strictEqual(s1.summary, 'work on A');

  assert.ok(db.searchByType('session', 'work on B', 50).some(h => h.id === 'S2'), 'remote sessions searchable');
});

test('syncRemoteHost prunes sessions that vanished from the host', async () => {
  // Only proj-a remains in the listing now; S2 should be removed.
  const { runText, runRaw } = fakeRunners([`${PROJ_A}\t1700000000\t"cwd":"/home/u/proj-a"`]);
  const res = await syncRemoteHost({ host: HOST, sock: '/tmp/s', db, runText, runRaw });
  assert.strictEqual(res.deleted, 1);
  assert.strictEqual(db.getAllCached().find(r => r.sessionId === 'S2'), undefined);
  assert.strictEqual(db.searchByType('session', 'work on B', 50).length, 0);
});

test('syncRemoteHost skips sessions with no cwd', async () => {
  const NOCWD = '/home/u/.claude/projects/-home-u-x/S9.jsonl';
  const { runText, runRaw } = fakeRunners([
    `${PROJ_A}\t1700000000\t"cwd":"/home/u/proj-a"`,
    `${NOCWD}\t1700000200\t`,
  ]);
  await syncRemoteHost({ host: HOST, sock: '/tmp/s', db, runText, runRaw });
  assert.strictEqual(db.getAllCached().find(r => r.sessionId === 'S9'), undefined);
});
