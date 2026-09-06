const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const APP_DIR = path.join(__dirname, '..');
// better-sqlite3 is compiled for Electron's ABI, so plain `node` cannot load
// it (or db.js). Run every DB-touching snippet under Electron-as-Node instead.
// Under plain node, require('electron') returns the path to the binary.
const electronBin = require('electron');

function runInElectronNode(code, dataDir) {
  return spawnSync(electronBin, ['-e', code], {
    cwd: APP_DIR,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', SWITCHBOARD_DATA_DIR: dataDir },
    encoding: 'utf8',
  });
}

// db.js opens its database at require() time, so each scenario loads it in a
// fresh child process pointed at an isolated data dir.
function loadDbModule(dataDir) {
  return runInElectronNode(`require(${JSON.stringify(path.join(APP_DIR, 'db.js'))})`, dataDir);
}

function inspectDb(dataDir) {
  const r = runInElectronNode(`
    const Database = require('better-sqlite3');
    const db = new Database(require('path').join(process.env.SWITCHBOARD_DATA_DIR, 'switchboard.db'), { readonly: true });
    console.log(JSON.stringify({
      cols: db.prepare('PRAGMA table_info(session_cache)').all().map(c => c.name),
      metaCols: db.prepare('PRAGMA table_info(session_meta)').all().map(c => c.name),
      projectCols: db.prepare('PRAGMA table_info(projects)').all().map(c => c.name),
      tables: db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(t => t.name),
      cacheCount: db.prepare('SELECT COUNT(*) AS n FROM session_cache').get().n,
      metaCount: db.prepare('SELECT COUNT(*) AS n FROM cache_meta').get().n,
      version: db.prepare("SELECT value FROM settings WHERE key = 'db_version'").get()?.value,
    }));
  `, dataDir);
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout.trim().split('\n').pop());
}

const PROJECT_TABLES = ['projects', 'project_folders', 'tracks'];

test('fresh database gets fileMtime column', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-db-fresh-'));
  try {
    const r = loadDbModule(dir);
    assert.equal(r.status, 0, r.stderr);
    const state = inspectDb(dir);
    assert.ok(state.cols.includes('fileMtime'));
    for (const t of PROJECT_TABLES) assert.ok(state.tables.includes(t), `${t} table created`);
    assert.ok(state.metaCols.includes('projectId') && state.metaCols.includes('trackId'), 'session_meta carries the assignment columns');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('deleting tracks retains their names and optionally archives only their sessions', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-delete-track-'));
  try {
    const r = runInElectronNode(`
      const assert = require('node:assert/strict');
      const db = require('./db');
      db.insertTrack({ id: 'keep', projectId: 'project', name: 'Keep work', created: '2026-09-05' });
      db.insertTrack({ id: 'archive', projectId: 'project', name: 'Finished work', created: '2026-09-05' });
      db.setSessionAssignment('active', 'project', 'keep');
      db.setSessionAssignment('done', 'project', 'archive');
      db.setSessionAssignment('already-archived', 'project', 'archive');
      db.setArchived('already-archived', 1);
      db.setSessionAssignment('unrelated', 'project', null);
      assert.deepEqual(db.deleteTrack('keep'), ['active']);
      assert.equal(db.getMeta('active').archived, 0);
      assert.equal(db.getMeta('active').formerTrackName, 'Keep work');
      assert.equal(db.getMeta('active').trackId, null);
      assert.deepEqual(new Set(db.deleteTrack('archive', { archiveSessions: true })), new Set(['done', 'already-archived']));
      for (const id of ['done', 'already-archived']) {
        const meta = db.getMeta(id);
        assert.equal(meta.projectId, 'project');
        assert.equal(meta.trackId, null);
        assert.equal(meta.formerTrackName, 'Finished work');
        assert.equal(meta.archived, 1);
      }
      assert.equal(db.getTrack('keep'), null);
      assert.equal(db.getTrack('archive'), null);
      assert.equal(db.getMeta('unrelated').archived, 0);
      db.closeDb();
      delete require.cache[require.resolve('./db')];
      const reopened = require('./db');
      assert.equal(reopened.getMeta('done').formerTrackName, 'Finished work');
      reopened.closeDb();
    `, dir);
    assert.equal(r.status, 0, r.stderr);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// The project tables and the two session_meta columns are added by inspecting
// the schema, not by db_version, so a database from before projects existed
// gets them without losing its names, stars or archive flags.
test('projects tables and session_meta columns are added to an older database', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-db-projects-'));
  try {
    const seed = runInElectronNode(`
      const Database = require('better-sqlite3');
      const db = new Database(require('path').join(process.env.SWITCHBOARD_DATA_DIR, 'switchboard.db'));
      db.exec('CREATE TABLE session_meta (sessionId TEXT PRIMARY KEY, name TEXT, starred INTEGER DEFAULT 0, archived INTEGER DEFAULT 0)');
      db.exec(\`CREATE TABLE session_cache (
        sessionId TEXT PRIMARY KEY, folder TEXT NOT NULL, projectPath TEXT,
        summary TEXT, firstPrompt TEXT, created TEXT, modified TEXT,
        messageCount INTEGER DEFAULT 0, slug TEXT, aiTitle TEXT, fileMtime TEXT,
        runtime TEXT DEFAULT 'claude', sessionFile TEXT
      )\`);
      db.exec('CREATE TABLE cache_meta (folder TEXT PRIMARY KEY, projectPath TEXT, indexMtimeMs REAL)');
      db.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)');
      db.prepare("INSERT INTO settings (key, value) VALUES ('db_version', '4')").run();
      db.prepare("INSERT INTO session_meta (sessionId, name, starred, archived) VALUES ('s1', 'kept', 1, 0)").run();
      // A projects table from the first Phase 1 build, before defaultCwd existed.
      db.exec(\`CREATE TABLE projects (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, slug TEXT NOT NULL UNIQUE, root TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active', sharedBranch INTEGER NOT NULL DEFAULT 1,
        branchName TEXT, created TEXT NOT NULL, modified TEXT NOT NULL
      )\`);
      db.prepare("INSERT INTO projects (id, name, slug, root, created, modified) VALUES ('p1', 'P', 'p', '/tmp/p', 'x', 'x')").run();
    `, dir);
    assert.equal(seed.status, 0, seed.stderr);

    const r = loadDbModule(dir);
    assert.equal(r.status, 0, r.stderr);

    const state = inspectDb(dir);
    for (const t of PROJECT_TABLES) assert.ok(state.tables.includes(t), `${t} table created`);
    assert.ok(state.metaCols.includes('projectId') && state.metaCols.includes('trackId'));
    assert.ok(state.projectCols.includes('defaultCwd'), 'defaultCwd added to an existing projects table');

    const after = JSON.parse(runInElectronNode(`
      const db = require(${JSON.stringify(path.join(APP_DIR, 'db.js'))});
      db.setSessionAssignment('s1', 'p1', null);
      db.setSessionAssignment('s2', 'p1', 't1');
      db.copySessionAssignment('s1', 's3');
      db.moveSessionAssignment('s2', 's4');
      console.log(JSON.stringify({
        s1: db.getMeta('s1'), s2: db.getMeta('s2'), s3: db.getMeta('s3'), s4: db.getMeta('s4'),
      }));
    `, dir).stdout.trim().split('\n').pop());
    assert.equal(after.s1.name, 'kept', 'assignment does not touch the name');
    assert.equal(after.s1.starred, 1, 'assignment does not touch the star');
    assert.equal(after.s1.projectId, 'p1');
    assert.equal(after.s3.projectId, 'p1', 'copy creates the fork\'s row');
    assert.equal(after.s2.projectId, null, 'move clears the temporary id');
    assert.equal(after.s4.projectId, 'p1');
    assert.equal(after.s4.trackId, 't1');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// Regression: a DB migrated to db_version 5 by a parallel branch (different
// v4/v5 migrations, extra columns, no fileMtime) skips this branch's
// version-numbered migrations entirely. Startup must still add fileMtime and
// clear the stale cache instead of crashing at prepare().
test('foreign higher-version database is reconciled, not crashed', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-db-foreign-'));
  try {
    const seed = runInElectronNode(`
      const Database = require('better-sqlite3');
      const db = new Database(require('path').join(process.env.SWITCHBOARD_DATA_DIR, 'switchboard.db'));
      db.exec(\`CREATE TABLE session_cache (
        sessionId TEXT PRIMARY KEY, folder TEXT NOT NULL, projectPath TEXT,
        summary TEXT, firstPrompt TEXT, created TEXT, modified TEXT,
        messageCount INTEGER DEFAULT 0, slug TEXT, aiTitle TEXT,
        parentSessionId TEXT, agentId TEXT, subagentType TEXT,
        description TEXT, runtime TEXT DEFAULT 'claude', sessionFile TEXT
      )\`);
      db.exec('CREATE TABLE cache_meta (folder TEXT PRIMARY KEY, projectPath TEXT, indexMtimeMs REAL)');
      db.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)');
      db.prepare("INSERT INTO settings (key, value) VALUES ('db_version', '5')").run();
      db.prepare("INSERT INTO session_cache (sessionId, folder, modified) VALUES ('s1', 'f1', '2026-01-01T00:00:00Z')").run();
      db.prepare("INSERT INTO cache_meta (folder, indexMtimeMs) VALUES ('f1', 123)").run();
    `, dir);
    assert.equal(seed.status, 0, seed.stderr);

    const r = loadDbModule(dir);
    assert.equal(r.status, 0, r.stderr);

    const state = inspectDb(dir);
    assert.ok(state.cols.includes('fileMtime'), 'fileMtime column added');
    assert.equal(state.cacheCount, 0, 'stale cache cleared for re-index');
    assert.equal(state.metaCount, 0, 'folder index gate cleared for re-index');
    assert.equal(state.version, '5', 'foreign db_version not downgraded');
    for (const col of ['parentSessionId', 'agentId', 'subagentType']) {
      assert.ok(state.cols.includes(col), `foreign column ${col} preserved`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// Adding the harness/sessionFile columns must not cost an existing user their
// index. Unlike fileMtime — which changed what `modified` meant and therefore
// had to wipe the cache — these are purely additive: every pre-existing row is
// a Claude session, which is what the NOT NULL DEFAULT says.
test('runtime/sessionFile are added without dropping cached rows', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-db-harness-'));
  try {
    // A realistic pre-upgrade DB: current schema through fileMtime, no harness.
    const seed = runInElectronNode(`
      const Database = require('better-sqlite3');
      const db = new Database(require('path').join(process.env.SWITCHBOARD_DATA_DIR, 'switchboard.db'));
      db.exec(\`CREATE TABLE session_cache (
        sessionId TEXT PRIMARY KEY, folder TEXT NOT NULL, projectPath TEXT,
        summary TEXT, firstPrompt TEXT, created TEXT, modified TEXT,
        messageCount INTEGER DEFAULT 0, slug TEXT, aiTitle TEXT, fileMtime TEXT
      )\`);
      db.exec('CREATE TABLE cache_meta (folder TEXT PRIMARY KEY, projectPath TEXT, indexMtimeMs REAL)');
      db.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)');
      db.prepare("INSERT INTO settings (key, value) VALUES ('db_version', '4')").run();
      db.prepare(\`INSERT INTO session_cache (sessionId, folder, projectPath, summary, modified, fileMtime)
        VALUES ('old-1', '-Users-me-proj', '/Users/me/proj', 'hello', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')\`).run();
      db.prepare("INSERT INTO cache_meta (folder, indexMtimeMs) VALUES ('-Users-me-proj', 123)").run();
    `, dir);
    assert.equal(seed.status, 0, seed.stderr);

    const r = loadDbModule(dir);
    assert.equal(r.status, 0, r.stderr);

    const row = JSON.parse(runInElectronNode(`
      const Database = require('better-sqlite3');
      const db = new Database(require('path').join(process.env.SWITCHBOARD_DATA_DIR, 'switchboard.db'));
      console.log(JSON.stringify({
        row: db.prepare("SELECT * FROM session_cache WHERE sessionId = 'old-1'").get(),
        cacheCount: db.prepare('SELECT COUNT(*) c FROM session_cache').get().c,
        metaCount: db.prepare('SELECT COUNT(*) c FROM cache_meta').get().c,
      }));
    `, dir).stdout.trim().split('\n').pop());

    assert.equal(row.cacheCount, 1, 'no re-index forced');
    assert.equal(row.metaCount, 1, 'folder index gate kept');
    assert.equal(row.row.runtime, 'claude', 'existing rows backfill to claude');
    assert.equal(row.row.sessionFile, null, 'sessionFile left null, path is reconstructed');
    assert.equal(row.row.summary, 'hello', 'row content untouched');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// A DB that already carries runtime/sessionFile from a parallel branch must be
// adopted as-is, not shadowed by a second pair of columns meaning the same
// thing. This is the shape of the author's real database.
test('a pre-existing runtime column is adopted, not duplicated', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-db-adopt-'));
  try {
    const seed = runInElectronNode(`
      const Database = require('better-sqlite3');
      const db = new Database(require('path').join(process.env.SWITCHBOARD_DATA_DIR, 'switchboard.db'));
      db.exec(\`CREATE TABLE session_cache (
        sessionId TEXT PRIMARY KEY, folder TEXT NOT NULL, projectPath TEXT,
        summary TEXT, firstPrompt TEXT, created TEXT, modified TEXT,
        messageCount INTEGER DEFAULT 0, slug TEXT, aiTitle TEXT,
        parentSessionId TEXT, agentId TEXT, subagentType TEXT, description TEXT,
        runtime TEXT DEFAULT 'claude', sessionFile TEXT, fileMtime TEXT
      )\`);
      db.exec('CREATE TABLE cache_meta (folder TEXT PRIMARY KEY, projectPath TEXT, indexMtimeMs REAL)');
      db.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)');
      db.prepare("INSERT INTO settings (key, value) VALUES ('db_version', '5')").run();
      db.prepare(\`INSERT INTO session_cache (sessionId, folder, summary, modified, fileMtime, runtime)
        VALUES ('old-1', '-Users-me-proj', 'hello', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', 'claude')\`).run();
    `, dir);
    assert.equal(seed.status, 0, seed.stderr);

    const r = loadDbModule(dir);
    assert.equal(r.status, 0, r.stderr);

    const state = inspectDb(dir);
    assert.ok(!state.cols.includes('harness'), 'no duplicate column added alongside runtime');
    assert.equal(state.cols.filter(c => c === 'runtime').length, 1, 'runtime not re-added');
    assert.equal(state.cacheCount, 1, 'rows kept');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
