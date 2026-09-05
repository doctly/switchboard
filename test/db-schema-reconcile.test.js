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
      cacheCount: db.prepare('SELECT COUNT(*) AS n FROM session_cache').get().n,
      metaCount: db.prepare('SELECT COUNT(*) AS n FROM cache_meta').get().n,
      version: db.prepare("SELECT value FROM settings WHERE key = 'db_version'").get()?.value,
    }));
  `, dataDir);
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout.trim().split('\n').pop());
}

test('fresh database gets fileMtime column', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-db-fresh-'));
  try {
    const r = loadDbModule(dir);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(inspectDb(dir).cols.includes('fileMtime'));
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

for (const version of [4, 12]) {
  test(`incremental columns upgrade a version-${version} database without losing metadata or search`, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-db-incremental-'));
    try {
      const seed = runInElectronNode(`
        const Database = require('better-sqlite3');
        const db = new Database(require('path').join(process.env.SWITCHBOARD_DATA_DIR, 'switchboard.db'));
        db.exec(\`CREATE TABLE session_cache (
          sessionId TEXT PRIMARY KEY, folder TEXT NOT NULL, projectPath TEXT,
          summary TEXT, firstPrompt TEXT, created TEXT, modified TEXT,
          messageCount INTEGER DEFAULT 0, slug TEXT, aiTitle TEXT, fileMtime TEXT,
          runtime TEXT DEFAULT 'claude', sessionFile TEXT
        )\`);
        db.exec('CREATE TABLE cache_meta (folder TEXT PRIMARY KEY, projectPath TEXT, indexMtimeMs REAL)');
        db.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)');
        db.prepare("INSERT INTO settings (key, value) VALUES ('db_version', ?)").run('${version}');
        db.prepare(\`INSERT INTO session_cache (sessionId, folder, summary, runtime, sessionFile)
          VALUES ('kept', 'codex/day', 'Existing session', 'codex', '/original/rollout.jsonl')\`).run();
        db.prepare("INSERT INTO cache_meta VALUES ('codex/day', NULL, 123)").run();
        // A partial migration from another branch must be adopted too.
        if (${version} > 4) {
          db.exec('ALTER TABLE session_cache ADD COLUMN customTitle TEXT');
          db.prepare("UPDATE session_cache SET customTitle = 'Existing custom title'").run();
        }
        db.exec('CREATE TABLE session_meta (sessionId TEXT PRIMARY KEY, name TEXT, starred INTEGER DEFAULT 0, archived INTEGER DEFAULT 0)');
        db.prepare("INSERT INTO session_meta VALUES ('kept', 'My name', 1, 1)").run();
        db.exec(\`CREATE VIRTUAL TABLE search_fts USING fts5(title, body, tokenize='trigram case_sensitive 0')\`);
        db.exec('CREATE TABLE search_map (rowid INTEGER PRIMARY KEY, id TEXT NOT NULL, type TEXT NOT NULL, folder TEXT)');
        db.prepare("INSERT INTO search_map VALUES (1, 'kept', 'session', 'codex/day')").run();
        db.prepare("INSERT INTO search_fts(rowid, title, body) VALUES (1, 'Existing session', 'searchable history')").run();
        db.close();
      `, dir);
      assert.equal(seed.status, 0, seed.stderr);
      // Upgrade, then reopen again to check reconciliation is idempotent.
      assert.equal(loadDbModule(dir).status, 0);
      const result = runInElectronNode(`
        const api = require('./db');
        const row = api.getCachedSession('kept');
        console.log(JSON.stringify({row, meta:api.getMeta('kept'),
          folder:api.getFolderMeta('codex/day'), hits:api.searchByType('session','searchable'),
          version:api.getSetting('db_version')}));
      `, dir);
      assert.equal(result.status, 0, result.stderr);
      const state = JSON.parse(result.stdout.trim().split('\n').pop());
      assert.equal(state.row.runtime, 'codex');
      assert.equal(state.row.sessionFile, '/original/rollout.jsonl');
      assert.equal(state.row.indexedBytes, 0);
      for (const col of ['textContent', 'headHash', 'firstTimestamp', 'lastTimestamp']) assert.equal(state.row[col], null);
      assert.equal(state.row.customTitle, version > 4 ? 'Existing custom title' : null);
      assert.equal(state.meta.name, 'My name');
      assert.equal(state.meta.starred, 1);
      assert.equal(state.meta.archived, 1);
      assert.equal(state.folder.indexMtimeMs, 123);
      assert.equal(state.hits[0].id, 'kept');
      assert.equal(state.version, version);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
}

test('incremental refresh persists resume state and keeps Codex, search and displayed times intact', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-db-refresh-'));
  try {
    const result = runInElectronNode(`
      const assert = require('node:assert/strict');
      const fs = require('fs');
      const path = require('path');
      const db = require('./db');
      const cache = require('./session-cache');
      const projectsDir = path.join(process.env.SWITCHBOARD_DATA_DIR, 'projects');
      const folder = 'project';
      const folderPath = path.join(projectsDir, folder);
      fs.mkdirSync(folderPath, {recursive:true});
      const file = path.join(folderPath, 'session.jsonl');
      const line = x => JSON.stringify(x) + '\\n';
      fs.writeFileSync(file,
        line({type:'user', cwd:'/project', message:'searchable question', timestamp:'2025-01-01T00:00:00Z'}) +
        line({type:'assistant', message:'x'.repeat(2 * 1024 * 1024), timestamp:'2025-01-02T00:00:00Z'}));
      db.upsertCachedSessions([{sessionId:'codex-session', folder:'codex/day', projectPath:'/codex',
        runtime:'codex', sessionFile:'/codex/rollout.jsonl', summary:'Codex question', firstPrompt:'Codex question',
        created:'2025-01-01T00:00:00Z', modified:'2025-01-01T00:00:00Z', fileMtime:'2025-01-01T00:00:00Z', messageCount:1}]);
      db.setName('session', 'My name');
      cache.init({PROJECTS_DIR:projectsDir, activeSessions:new Map(), getMainWindow:()=>null, log:console, db});
      cache.refreshFolder(folder);
      const first = db.getCachedSession('session');
      assert.equal(first.messageCount, 2);
      assert.equal(first.indexedBytes, fs.statSync(file).size);
      assert.equal(first.firstTimestamp, '2025-01-01T00:00:00Z');
      assert.equal(first.lastTimestamp, '2025-01-02T00:00:00Z');
      db.closeDb();
      delete require.cache[require.resolve('./db')];
      const reopened = require('./db');
      cache.init({PROJECTS_DIR:projectsDir, activeSessions:new Map(), getMainWindow:()=>null, log:console, db:reopened});
      fs.appendFileSync(file, line({type:'assistant', message:'appended answer', timestamp:'2025-01-03T00:00:00Z'}) +
        line({type:'ai-title', aiTitle:'Automatic title'}));
      const changedTime = new Date(Date.parse(first.fileMtime) + 1000);
      fs.utimesSync(file, changedTime, changedTime);
      const originalRead = fs.readSync;
      let bytes = 0;
      fs.readSync = function(...args) { const n = originalRead(...args); bytes += n; return n; };
      try { cache.refreshFolder(folder); } finally { fs.readSync = originalRead; }
      // Includes cwd derivation (one bounded chunk), hash validation and the appended records.
      assert.ok(bytes < 512 * 1024, 'refresh re-read the full transcript: ' + bytes);
      const row = reopened.getCachedSession('session');
      assert.equal(row.messageCount, 3);
      assert.equal(row.created, first.created);
      assert.equal(row.modified, '2025-01-03T00:00:00Z');
      assert.equal(row.fileMtime, changedTime.toISOString());
      assert.equal(row.sessionFile, file);
      assert.equal(row.runtime, 'claude');
      assert.equal(row.aiTitle, 'Automatic title');
      assert.ok(row.textContent.includes('searchable question'));
      assert.ok(row.textContent.includes('appended answer'));
      assert.equal(reopened.getMeta('session').name, 'My name');
      assert.equal(reopened.searchByType('session','appended answer')[0].id, 'session');
      const all = reopened.getAllCached();
      assert.equal(all.length, 2);
      for (const item of all) {
        assert.ok(!Object.hasOwn(item, 'textContent'), 'bulk queries must not load parser text');
        assert.ok(!Object.hasOwn(item, 'headHash'));
      }
      assert.equal(all.find(r=>r.sessionId==='codex-session').sessionFile, '/codex/rollout.jsonl');
      const projects = cache.buildProjectsFromCache(false);
      assert.equal(projects.find(p=>p.projectPath==='/codex').sessions[0].runtime, 'codex');
      const visible = projects.find(p=>p.projectPath==='/project').sessions[0];
      assert.equal(visible.modified, row.modified);
      assert.equal(visible.name, 'My name');
      console.log(JSON.stringify({bytesRead:bytes, messageCount:row.messageCount}));
      reopened.closeDb();
    `, dir);
    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
