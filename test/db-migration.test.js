const { test } = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

// Build a pre-Phase-2 (v3) DB with the OLD schema (no source column) and a row,
// then load db.js and confirm it migrates in place without losing data.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swb-db-mig-'));
const dbPath = path.join(tmpDir, 'test.db');

{
  const old = new Database(dbPath);
  old.exec(`CREATE TABLE session_cache (
    sessionId TEXT PRIMARY KEY, folder TEXT NOT NULL, projectPath TEXT, summary TEXT,
    firstPrompt TEXT, created TEXT, modified TEXT, messageCount INTEGER DEFAULT 0,
    slug TEXT, aiTitle TEXT)`);
  old.exec(`CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)`);
  old.exec(`CREATE TABLE search_map (rowid INTEGER PRIMARY KEY, id TEXT NOT NULL, type TEXT NOT NULL, folder TEXT)`);
  old.prepare(`INSERT INTO session_cache
    (sessionId, folder, projectPath, summary, firstPrompt, created, modified, messageCount)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run('OLD1', 'F', '/p', 'sum', 'sum', 'C', 'M', 3);
  old.prepare("INSERT INTO settings (key, value) VALUES ('db_version', ?)").run(JSON.stringify(3));
  old.close();
}

process.env.SWITCHBOARD_DATA_DIR = tmpDir;
process.env.SWITCHBOARD_DB_PATH = dbPath;
const db = require('../db');

test('v3→v4 migration adds source column and preserves existing rows as local', () => {
  const rows = db.getAllCached();
  const old = rows.find(r => r.sessionId === 'OLD1');
  assert.ok(old, 'existing row preserved through migration');
  assert.strictEqual(old.source, null, 'pre-existing rows are treated as local (source NULL)');
  assert.strictEqual(old.messageCount, 3, 'existing data intact');
});

test('source-aware queries work after in-place migration', () => {
  db.upsertCachedSessions([{
    sessionId: 'R1', folder: 'F', projectPath: 'ssh://h/~/p', summary: 's', firstPrompt: 's',
    created: 'C', modified: 'M2', messageCount: 1, slug: null, aiTitle: null, source: 'host-1',
  }]);
  assert.deepStrictEqual(db.getCachedBySource('host-1').map(r => r.sessionId), ['R1']);
  // Local folder query still ignores the remote row sharing folder "F"
  assert.deepStrictEqual(db.getCachedByFolder('F').map(r => r.sessionId), ['OLD1']);
});
