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

test('schedule settings preserve explicit defaults and separate CLI choices across restarts', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-schedule-config-'));
  try {
    const r = runInElectronNode(`
      const assert = require('node:assert/strict');
      let db = require('./db');
      const sessionConfig = { claude: { permissionMode: null, chrome: false, addDirs: '',
        allowedTools: 'Read,Write', appendSystemPrompt: 'Follow the task instructions.' },
        codex: { codexSandbox: 'read-only', codexModel: 'chosen-model' } };
      db.insertSchedule({ id: 'configured', name: 'Configured', cwd: '/project', prompt: 'Do it',
        every: 'hour', created: '2026-09-01T00:00:00Z', sessionConfig });
      db.insertSchedule({ id: 'inherited', name: 'Inherited', cwd: '/project', prompt: 'Do it',
        every: 'hour', created: '2026-09-01T00:00:00Z' });
      db.closeDb();
      delete require.cache[require.resolve('./db')];
      db = require('./db');
      assert.deepEqual(db.getSchedule('configured').sessionConfig, sessionConfig);
      assert.deepEqual(db.getSchedule('inherited').sessionConfig, {});
      assert.deepEqual(db.listSchedules().find(s => s.id === 'configured').sessionConfig, sessionConfig);
      db.updateSchedule('configured', { name: 'Renamed' });
      assert.deepEqual(db.getSchedule('configured').sessionConfig, sessionConfig);
      db.updateSchedule('configured', { sessionConfig: {} });
      db.closeDb();
      delete require.cache[require.resolve('./db')];
      db = require('./db');
      assert.deepEqual(db.getSchedule('configured').sessionConfig, {});
      db.closeDb();
    `, dir);
    assert.equal(r.status, 0, r.stderr);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('legacy schedule imports survive restarts and deletion, and failed inserts remain retryable', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-schedule-imports-'));
  try {
    const r = runInElectronNode(`
      const assert = require('node:assert/strict');
      let db = require('./db');
      const row = { id: 'legacy', name: 'Existing task', cwd: '/project',
        prompt: 'Do the task', every: 'hour', created: '2026-09-01T00:00:00Z',
        sourceFile: '/project/schedule-example.md' };
      // Simulate a schedule imported before the per-file ledger existed.
      db.insertSchedule(row);
      db.setSetting('schedules_imported_from_files', { at: row.created, count: 1 });
      const reopen = () => {
        db.closeDb();
        delete require.cache[require.resolve('./db')];
        db = require('./db');
      };
      reopen();
      assert.deepEqual(db.getImportedScheduleFiles(), [row.sourceFile]);
      db.updateSchedule(row.id, { name: 'User edit', enabled: false });
      assert.equal(db.importLegacySchedule({ ...row, id: 'duplicate' }), false);
      assert.equal(db.getSchedule(row.id).name, 'User edit');
      assert.equal(db.getSchedule(row.id).enabled, 0);
      db.deleteSchedule(row.id);
      reopen();
      assert.equal(db.importLegacySchedule(row), false, 'a deleted task stays deleted');
      assert.deepEqual(db.listSchedules(), []);

      const later = { ...row, id: 'later', sourceFile: '/project/schedule-later.md' };
      assert.throws(() => db.importLegacySchedule({ ...later, prompt: null }));
      assert.ok(!db.getImportedScheduleFiles().includes(later.sourceFile), 'failed insert rolls back the ledger');
      reopen();
      assert.equal(db.importLegacySchedule(later), true, 'failed source can be retried');
      reopen();
      assert.equal(db.importLegacySchedule(later), false);
      assert.equal(db.listSchedules().length, 1);
      assert.equal(db.getSchedule(later.id).sourceFile, later.sourceFile);
      db.closeDb();
    `, dir);
    assert.equal(r.status, 0, r.stderr);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('identical search entries perform no database writes, including after reopening', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-search-noop-'));
  try {
    const r = runInElectronNode(`
      const assert = require('node:assert/strict');
      const Database = require('better-sqlite3');
      let db = require('./db');
      const observer = new Database(require('path').join(process.env.SWITCHBOARD_DATA_DIR, 'switchboard.db'));
      const version = () => observer.pragma('data_version', { simple: true });
      const entry = { id: 'session', type: 'session', folder: 'folder', title: 'original title',
        body: 'conversation '.repeat(1000) + 'move_fna_lines' };
      db.upsertSearchEntries([entry]);
      let before = version();
      db.upsertSearchEntries([entry, { ...entry }]);
      assert.equal(version(), before, 'identical entries must not commit any writes');

      db.closeDb();
      delete require.cache[require.resolve('./db')];
      db = require('./db');
      before = version();
      db.upsertSearchEntries([entry]);
      assert.equal(version(), before, 'the comparison must survive an app restart');

      const renamed = { ...entry, title: 'renamed title' };
      db.upsertSearchEntries([renamed]);
      assert.deepEqual(db.searchSessionIds('renamed title', ['session']), ['session']);
      assert.deepEqual(db.searchSessionIds('original title', ['session']), []);
      const changed = { ...renamed, body: 'replacement conversation' };
      db.upsertSearchEntries([changed]);
      assert.deepEqual(db.searchSessionIds('replacement conversation', ['session']), ['session']);
      assert.deepEqual(db.searchSessionIds('move_fna_lines', ['session']), []);
      db.upsertSearchEntries([{ ...changed, folder: 'moved' }]);
      assert.equal(observer.prepare('SELECT folder FROM search_map WHERE id = ?').get('session').folder, 'moved');
      assert.equal(observer.prepare('SELECT COUNT(*) AS n FROM search_map').get().n, 1);
      assert.equal(observer.prepare('SELECT COUNT(*) AS n FROM search_fts').get().n, 1);

      // A missing FTS row must be repaired even if the mapping still exists.
      observer.exec('DELETE FROM search_fts');
      db.upsertSearchEntries([{ ...changed, folder: 'moved' }]);
      assert.deepEqual(db.searchSessionIds('replacement conversation', ['session']), ['session']);

      // Existing short excerpts upgrade when refreshed; they are not mistaken
      // for identical full conversations just because the title is unchanged.
      db.upsertSearchEntries([{ ...entry, id: 'legacy', body: 'conversation' }]);
      db.upsertSearchEntries([{ ...entry, id: 'legacy' }]);
      assert.deepEqual(db.searchSessionIds('move_fna_lines', ['legacy']), ['legacy']);
      db.deleteSearchSession('legacy');
      assert.deepEqual(db.searchSessionIds('move_fna_lines', ['legacy']), []);
      db.closeDb();
      observer.close();
    `, dir);
    assert.equal(r.status, 0, r.stderr);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('tool-only transcript refreshes update metadata without writing the search index', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-search-refresh-'));
  try {
    const r = runInElectronNode(`
      const assert = require('node:assert/strict');
      const fs = require('node:fs');
      const path = require('node:path');
      const Database = require('better-sqlite3');
      const statements = [];
      // Trace the real SQLite connection so cache writes cannot hide an
      // unnecessary FTS delete/insert behind unchanged final search results.
      require.cache[require.resolve('better-sqlite3')].exports = function(filename, options) {
        return new Database(filename, { ...options, verbose: sql => statements.push(sql) });
      };
      const db = require('./db');
      const cache = require('./session-cache');
      const projectsDir = path.join(process.env.SWITCHBOARD_DATA_DIR, 'transcripts');
      const folderPath = path.join(projectsDir, 'project');
      fs.mkdirSync(folderPath, { recursive: true });
      const file = path.join(folderPath, 'session.jsonl');
      fs.writeFileSync(file, JSON.stringify({ type: 'user', cwd: '/tmp/project',
        message: { content: 'original question' } }) + '\\n');
      const append = entry => {
        const mtime = fs.statSync(file).mtimeMs;
        fs.appendFileSync(file, JSON.stringify(entry) + '\\n');
        fs.utimesSync(file, new Date(), new Date(mtime + 5000));
      };
      const searchWrites = () => statements.filter(sql =>
        /^\\s*(INSERT|UPDATE|DELETE)\\b/i.test(sql) && /\\bsearch_(fts|map)\\b/.test(sql));
      cache.init({ PROJECTS_DIR: projectsDir, activeSessions: new Map(),
        getMainWindow: () => null, log: console, db });
      cache.refreshFolder('project');
      assert.deepEqual(db.searchSessionIds('original question', ['session']), ['session']);

      statements.length = 0;
      append({ type: 'assistant', message: { content: [
        { type: 'tool_use', name: 'Bash', input: { command: 'tool_input_marker' } },
      ] } });
      append({ type: 'user', message: { content: [
        { type: 'tool_result', content: 'tool_output_marker' },
      ] } });
      append({ type: 'last-prompt', lastPrompt: 'original question' });
      cache.refreshFolder('project');
      assert.deepEqual(searchWrites(), [], 'tool calls, results and bookkeeping must not rewrite FTS');
      assert.equal(db.getCachedSession('session').fileMtime, fs.statSync(file).mtime.toISOString());
      assert.equal(db.getCachedSession('session').messageCount, 3);
      assert.deepEqual(db.searchSessionIds('tool_output_marker', ['session']), []);

      statements.length = 0;
      append({ type: 'assistant', message: { content: 'new answer move_fna_lines' } });
      cache.refreshFolder('project');
      assert.ok(searchWrites().length > 0, 'new conversation text must update FTS');
      assert.deepEqual(db.searchSessionIds('move_fna_lines', ['session']), ['session']);

      statements.length = 0;
      append({ type: 'custom-title', customTitle: 'renamed conversation' });
      cache.refreshFolder('project');
      assert.ok(searchWrites().length > 0, 'renaming must remain searchable');
      assert.deepEqual(db.searchSessionIds('renamed conversation', ['session']), ['session']);

      statements.length = 0;
      cache.refreshFolder('project');
      assert.deepEqual(searchWrites(), [], 'an unchanged file must still skip indexing');
      fs.unlinkSync(file);
      // Keep the folder's cwd discoverable when its session is deleted.
      fs.writeFileSync(path.join(folderPath, 'empty.jsonl'), JSON.stringify({ type: 'system', cwd: '/tmp/project' }) + '\\n');
      cache.refreshFolder('project');
      assert.deepEqual(db.searchSessionIds('move_fna_lines', ['session']), []);
      db.closeDb();
    `, dir);
    assert.equal(r.status, 0, r.stderr);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('session search scopes before limiting and supports archived and title-only matches', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-scoped-search-'));
  try {
    const r = runInElectronNode(`
      const assert = require('node:assert/strict');
      const db = require('./db');
      db.upsertSearchEntries([
        ...Array.from({ length: 1000 }, (_, i) => ({ id: 'outside-' + i, type: 'session', title: 'needle' })),
        { id: 'active', type: 'session', title: 'needle active' },
        { id: 'archived', type: 'session', title: 'older session', body: 'needle in transcript' },
      ]);
      db.setArchived('archived', 1);
      const scope = ['active', 'archived'];
      assert.deepEqual(new Set(db.searchByType('session', 'needle', 50, false, scope).map(r => r.id)), new Set(scope));
      assert.deepEqual(db.searchByType('session', 'needle', 50, true, scope).map(r => r.id), ['active']);
      assert.deepEqual(db.searchByType('session', 'needle', 50, false, []), []);
      assert.equal(db.searchByType('session', 'needle').length, 50);
      assert.deepEqual(new Set(db.searchSessionIds('needle', scope)), new Set(scope));
      assert.deepEqual(db.searchSessionIds('transcript', scope), ['archived']);
      assert.deepEqual(db.searchSessionIds('needle', []), []);
      assert.deepEqual(db.searchSessionIds('', scope), []);
      assert.deepEqual(db.searchSessionIds('" OR needle', scope), []);
      const start = performance.now();
      for (let i = 0; i < 100; i++) db.searchSessionIds('needle', scope);
      console.log('Scoped ID search average ms:', (performance.now() - start) / 100);
      db.closeDb();
    `, dir);
    assert.equal(r.status, 0, r.stderr);
    console.log(r.stdout.trim());
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

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
