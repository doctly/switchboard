const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const sessionCache = require('../session-cache');
const { getFolderIndexMtimeMs } = require('../folder-index-state');

// Minimal valid session transcript: one line carries `cwd` (for deriveProjectPath)
// and a user message (so readSessionFile yields a non-null session).
function writeSession(folderPath, cwd) {
  fs.mkdirSync(folderPath, { recursive: true });
  const line = JSON.stringify({ type: 'user', cwd, message: { role: 'user', content: 'hello' } });
  fs.writeFileSync(path.join(folderPath, 'session.jsonl'), line + '\n', 'utf8');
}

function writeNamedSession(folderPath, cwd, sessionId, timestamp) {
  fs.mkdirSync(folderPath, { recursive: true });
  const line = JSON.stringify({
    type: 'user', cwd, timestamp,
    message: { role: 'user', content: 'hello' },
  });
  fs.writeFileSync(path.join(folderPath, sessionId + '.jsonl'), line + '\n', 'utf8');
}

// In-memory fake of the db layer that init() expects, recording which folders
// actually got (re)indexed (i.e. had refreshFolder do work and upsert sessions).
function makeFakeDb(metaMap, globalSettings = {}) {
  const indexedFolders = new Set();
  const cachedRows = [];
  return {
    indexedFolders,
    cachedRows,
    db: {
      deleteCachedFolder() {},
      getCachedByFolder() { return []; },
      upsertCachedSessions(sessions) {
        for (const s of sessions) { indexedFolders.add(s.folder); cachedRows.push(s); }
      },
      deleteCachedSession() {},
      deleteSearchFolder() {},
      deleteSearchSession() {},
      upsertSearchEntries() {},
      setFolderMeta(folder, projectPath, indexMtimeMs) { metaMap.set(folder, { folder, projectPath, indexMtimeMs }); },
      getAllFolderMeta() { return metaMap; },
      getAllMeta() { return new Map(); },
      getAllCached() { return cachedRows; },
      getSetting(key) { return key === 'global' ? globalSettings : {}; },
      setSetting(key, value) {
        if (key !== 'global' || value === globalSettings) return;
        for (const existingKey of Object.keys(globalSettings)) delete globalSettings[existingKey];
        Object.assign(globalSettings, value);
      },
      getMeta() { return null; },
      setName() {},
      updateCachedAiTitle(sessionId, aiTitle, runtime) {
        const row = cachedRows.find(r => r.sessionId === sessionId && r.runtime === runtime);
        if (!row) return 0;
        row.aiTitle = aiTitle;
        return 1;
      },
      updateSearchTitle() {},
    },
  };
}

test('reconcileCacheFromFilesystem indexes new and stale folders but skips up-to-date ones', () => {
  const projectsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-reconcile-'));
  try {
    // never-indexed (no meta), stale (meta older than disk), and up-to-date folders
    writeSession(path.join(projectsDir, 'proj-new'), '/tmp/proj-new');
    writeSession(path.join(projectsDir, 'proj-stale'), '/tmp/proj-stale');
    writeSession(path.join(projectsDir, 'proj-current'), '/tmp/proj-current');

    const metaMap = new Map();
    metaMap.set('proj-stale', { folder: 'proj-stale', projectPath: '/tmp/proj-stale', indexMtimeMs: 0 });
    metaMap.set('proj-current', {
      folder: 'proj-current', projectPath: '/tmp/proj-current',
      indexMtimeMs: getFolderIndexMtimeMs(path.join(projectsDir, 'proj-current')),
    });

    const fake = makeFakeDb(metaMap);
    sessionCache.init({
      PROJECTS_DIR: projectsDir,
      activeSessions: new Map(),
      getMainWindow: () => null,
      log: console,
      db: fake.db,
    });

    sessionCache.reconcileCacheFromFilesystem();

    assert.ok(fake.indexedFolders.has('proj-new'), 'new folder should be indexed');
    assert.ok(fake.indexedFolders.has('proj-stale'), 'stale folder (older indexMtimeMs) should be re-indexed');
    assert.ok(!fake.indexedFolders.has('proj-current'), 'up-to-date folder should be skipped');
  } finally {
    fs.rmSync(projectsDir, { recursive: true, force: true });
  }
});

test('a new session restores a hidden project', () => {
  const projectsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-restore-hidden-'));
  const projectPath = '/tmp/hidden-worktree';
  const folder = 'hidden-worktree';
  const hiddenAt = Date.now();
  const settings = {
    hiddenProjects: [projectPath],
    hiddenProjectTimestamps: { [projectPath]: hiddenAt },
  };

  try {
    writeNamedSession(
      path.join(projectsDir, folder), projectPath, 'new-session',
      new Date(hiddenAt + 1000).toISOString(),
    );
    const fake = makeFakeDb(new Map(), settings);
    sessionCache.init({
      PROJECTS_DIR: projectsDir, activeSessions: new Map(),
      getMainWindow: () => null, log: console, db: fake.db,
    });

    sessionCache.refreshFolder(folder);

    assert.deepEqual(settings.hiddenProjects, []);
    assert.equal(settings.hiddenProjectTimestamps[projectPath], undefined);
  } finally {
    fs.rmSync(projectsDir, { recursive: true, force: true });
  }
});

test('activity in an old session does not restore a hidden project', () => {
  const projectsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-keep-hidden-'));
  const projectPath = '/tmp/hidden-worktree';
  const folder = 'hidden-worktree';

  try {
    const oldCreatedAt = Date.now() - 1000;
    writeNamedSession(
      path.join(projectsDir, folder), projectPath, 'old-session',
      new Date(oldCreatedAt).toISOString(),
    );
    const sessionFile = path.join(projectsDir, folder, 'old-session.jsonl');
    const hiddenAt = Math.max(Date.now(), fs.statSync(sessionFile).birthtimeMs + 1);
    const settings = {
      hiddenProjects: [projectPath],
      hiddenProjectTimestamps: { [projectPath]: hiddenAt },
    };
    fs.appendFileSync(sessionFile, JSON.stringify({
      type: 'assistant', timestamp: new Date(hiddenAt + 1000).toISOString(),
      message: { role: 'assistant', content: 'new activity' },
    }) + '\n');
    const fake = makeFakeDb(new Map(), settings);
    sessionCache.init({
      PROJECTS_DIR: projectsDir, activeSessions: new Map(),
      getMainWindow: () => null, log: console, db: fake.db,
    });

    sessionCache.refreshFolder(folder);

    assert.deepEqual(settings.hiddenProjects, [projectPath]);
  } finally {
    fs.rmSync(projectsDir, { recursive: true, force: true });
  }
});

test('hidden projects from older settings receive a baseline timestamp', () => {
  const settings = { hiddenProjects: ['/tmp/legacy-hidden'] };
  const fake = makeFakeDb(new Map(), settings);
  sessionCache.init({
    PROJECTS_DIR: os.tmpdir(), activeSessions: new Map(),
    getMainWindow: () => null, log: console, db: fake.db,
  });

  sessionCache.initializeHiddenProjectTimestamps(12345);

  assert.equal(settings.hiddenProjectTimestamps['/tmp/legacy-hidden'], 12345);
});

test('a live plain terminal keeps its project filing across renderer reloads', () => {
  const fake = makeFakeDb(new Map());
  sessionCache.init({
    PROJECTS_DIR: os.tmpdir(),
    activeSessions: new Map([['terminal-1', {
      exited: false,
      isPlainTerminal: true,
      projectPath: '/tmp/attached-repo',
      projectId: 'project-1',
      trackId: 'track-1',
      _openedAt: 12345,
    }]]),
    getMainWindow: () => null,
    log: console,
    db: fake.db,
  });

  const projects = sessionCache.buildProjectsFromCache(false);
  const terminal = projects.flatMap(project => project.sessions)
    .find(session => session.sessionId === 'terminal-1');
  assert.equal(terminal.projectId, 'project-1');
  assert.equal(terminal.trackId, 'track-1');
});

// --- codex folders ---

const ROLLOUT = 'rollout-2026-08-26T11-55-02-01a03f6c-fdf9-7c83-86e3-c388f81d765c.jsonl';

function writeRollout(dayDir, cwd) {
  fs.mkdirSync(dayDir, { recursive: true });
  const lines = [
    { timestamp: '2026-08-26T10:00:00Z', type: 'session_meta', payload: { session_id: 'root', cwd } },
    { timestamp: '2026-08-26T10:00:01Z', type: 'response_item',
      payload: { type: 'message', role: 'user', content: [{ type: 'text', text: 'hello' }] } },
  ];
  fs.writeFileSync(path.join(dayDir, ROLLOUT), lines.map(l => JSON.stringify(l)).join('\n') + '\n', 'utf8');
}

// A codex date folder holds sessions from many projects, so it has no
// folder-level project path. refreshFolder used to bail on exactly that
// condition, which would have skipped every codex folder silently.
test('reconcile indexes codex date folders even though they have no folder project', () => {
  const projectsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-claude-'));
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-codex-'));
  const prevHome = process.env.CODEX_HOME;
  try {
    process.env.CODEX_HOME = codexHome;
    writeRollout(path.join(codexHome, 'sessions', '2026', '08', '26'), '/tmp/some-project');

    const metaMap = new Map();
    const fake = makeFakeDb(metaMap);
    sessionCache.init({
      PROJECTS_DIR: projectsDir, activeSessions: new Map(),
      getMainWindow: () => null, log: console, db: fake.db,
    });

    sessionCache.reconcileCacheFromFilesystem();
    assert.ok(fake.indexedFolders.has('codex/2026/08/26'), 'codex folder should be indexed');
    // cache_meta records a null project for it — many projects share the folder.
    assert.equal(metaMap.get('codex/2026/08/26').projectPath, null);

    // Second pass: unchanged on disk, so the mtime gate must skip it. Without
    // this the date folders would be fully re-read on every get-projects call.
    const second = makeFakeDb(metaMap);
    sessionCache.init({
      PROJECTS_DIR: projectsDir, activeSessions: new Map(),
      getMainWindow: () => null, log: console, db: second.db,
    });
    sessionCache.reconcileCacheFromFilesystem();
    assert.equal(second.indexedFolders.size, 0, 'up-to-date codex folder should be skipped');
  } finally {
    if (prevHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = prevHome;
    fs.rmSync(projectsDir, { recursive: true, force: true });
    fs.rmSync(codexHome, { recursive: true, force: true });
  }
});

test('a new Codex session also restores its hidden project', () => {
  const projectsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-claude-'));
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-codex-'));
  const prevHome = process.env.CODEX_HOME;
  const projectPath = '/tmp/hidden-codex-project';
  const hiddenAt = Date.parse('2026-08-25T00:00:00Z');
  const settings = {
    hiddenProjects: [projectPath],
    hiddenProjectTimestamps: { [projectPath]: hiddenAt },
  };
  try {
    process.env.CODEX_HOME = codexHome;
    writeRollout(path.join(codexHome, 'sessions', '2026', '08', '26'), projectPath);
    const fake = makeFakeDb(new Map(), settings);
    sessionCache.init({
      PROJECTS_DIR: projectsDir, activeSessions: new Map(),
      getMainWindow: () => null, log: console, db: fake.db,
    });

    sessionCache.refreshFolder('codex/2026/08/26');

    assert.deepEqual(settings.hiddenProjects, []);
  } finally {
    if (prevHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = prevHome;
    fs.rmSync(projectsDir, { recursive: true, force: true });
    fs.rmSync(codexHome, { recursive: true, force: true });
  }
});

test('reconcile captures Codex auto-titles and rename changes without a transcript change', () => {
  const projectsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-claude-'));
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-codex-'));
  const prevHome = process.env.CODEX_HOME;
  try {
    process.env.CODEX_HOME = codexHome;
    writeRollout(path.join(codexHome, 'sessions', '2026', '08', '26'), '/tmp/titled-project');
    const indexPath = path.join(codexHome, 'session_index.jsonl');
    fs.writeFileSync(indexPath, JSON.stringify({
      id: '01a03f6c-fdf9-7c83-86e3-c388f81d765c',
      thread_name: 'Automatic title', updated_at: '2026-08-26T10:01:00Z',
    }) + '\n');

    const fake = makeFakeDb(new Map());
    sessionCache.init({
      PROJECTS_DIR: projectsDir, activeSessions: new Map(),
      getMainWindow: () => null, log: console, db: fake.db,
    });

    sessionCache.reconcileCacheFromFilesystem();
    assert.equal(fake.cachedRows[0].aiTitle, 'Automatic title');

    fs.appendFileSync(indexPath, JSON.stringify({
      id: '01a03f6c-fdf9-7c83-86e3-c388f81d765c',
      thread_name: 'Renamed in Codex', updated_at: '2026-08-26T10:02:00Z',
    }) + '\n');
    fake.indexedFolders.clear();

    sessionCache.reconcileCacheFromFilesystem();
    assert.equal(fake.indexedFolders.size, 0, 'the unchanged rollout stays behind the mtime gate');
    assert.equal(fake.cachedRows[0].aiTitle, 'Renamed in Codex');
  } finally {
    if (prevHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = prevHome;
    fs.rmSync(projectsDir, { recursive: true, force: true });
    fs.rmSync(codexHome, { recursive: true, force: true });
  }
});

test('a codex home that does not exist contributes nothing and does not throw', () => {
  const projectsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-nocodex-'));
  const prevHome = process.env.CODEX_HOME;
  try {
    process.env.CODEX_HOME = path.join(os.tmpdir(), 'switchboard-definitely-absent-' + process.pid);
    writeSession(path.join(projectsDir, 'proj'), '/tmp/proj');

    const metaMap = new Map();
    const fake = makeFakeDb(metaMap);
    sessionCache.init({
      PROJECTS_DIR: projectsDir, activeSessions: new Map(),
      getMainWindow: () => null, log: console, db: fake.db,
    });

    sessionCache.reconcileCacheFromFilesystem();
    assert.ok(fake.indexedFolders.has('proj'), 'claude folders still indexed');
    assert.equal([...fake.indexedFolders].filter(f => f.startsWith('codex/')).length, 0);
  } finally {
    if (prevHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = prevHome;
    fs.rmSync(projectsDir, { recursive: true, force: true });
  }
});

// --- switching a CLI off and on ---

function setUpBoth(globalSettings) {
  const projectsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-claude-'));
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-codex-'));
  process.env.CODEX_HOME = codexHome;
  writeSession(path.join(projectsDir, 'proj'), '/tmp/proj');
  writeRollout(path.join(codexHome, 'sessions', '2026', '08', '26'), '/tmp/codex-project');
  const metaMap = new Map();
  const fake = makeFakeDb(metaMap, globalSettings);
  sessionCache.init({
    PROJECTS_DIR: projectsDir, activeSessions: new Map(),
    getMainWindow: () => null, log: console, db: fake.db,
  });
  return { projectsDir, codexHome, metaMap, fake };
}

test('a disabled CLI is not scanned at all', () => {
  const prev = process.env.CODEX_HOME;
  const { projectsDir, codexHome, fake } = setUpBoth({ disabledHarnesses: ['codex'] });
  try {
    sessionCache.reconcileCacheFromFilesystem();
    assert.ok(fake.indexedFolders.has('proj'), 'the enabled CLI is still scanned');
    assert.equal([...fake.indexedFolders].filter(f => f.startsWith('codex/')).length, 0,
      'the disabled CLI is not read from disk');
  } finally {
    if (prev === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = prev;
    fs.rmSync(projectsDir, { recursive: true, force: true });
    fs.rmSync(codexHome, { recursive: true, force: true });
  }
});

test('Claude can be the one switched off', () => {
  const prev = process.env.CODEX_HOME;
  const { projectsDir, codexHome, fake } = setUpBoth({ disabledHarnesses: ['claude'] });
  try {
    sessionCache.reconcileCacheFromFilesystem();
    assert.ok(fake.indexedFolders.has('codex/2026/08/26'));
    assert.ok(!fake.indexedFolders.has('proj'), 'the Claude projects dir is not read');
  } finally {
    if (prev === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = prev;
    fs.rmSync(projectsDir, { recursive: true, force: true });
    fs.rmSync(codexHome, { recursive: true, force: true });
  }
});

// The question this whole design turns on: if a disabled CLI is never scanned,
// does switching it back on actually pick up what it did in the meantime?
test('switching a CLI back on scans what it missed', () => {
  const prev = process.env.CODEX_HOME;
  const settings = { disabledHarnesses: ['codex'] };
  const { projectsDir, codexHome, metaMap, fake } = setUpBoth(settings);
  try {
    sessionCache.reconcileCacheFromFilesystem();
    assert.equal([...fake.indexedFolders].filter(f => f.startsWith('codex/')).length, 0);

    // A codex session happens while it is switched off.
    writeRollout(path.join(codexHome, 'sessions', '2026', '08', '27'), '/tmp/while-off');

    // Switch it on and reconcile, exactly as set-setting does.
    settings.disabledHarnesses = [];
    const after = makeFakeDb(metaMap, settings);
    sessionCache.init({
      PROJECTS_DIR: projectsDir, activeSessions: new Map(),
      getMainWindow: () => null, log: console, db: after.db,
    });
    sessionCache.reconcileCacheFromFilesystem();

    assert.ok(after.indexedFolders.has('codex/2026/08/26'), 'history from before it was switched off');
    assert.ok(after.indexedFolders.has('codex/2026/08/27'), 'the session it had while switched off');
  } finally {
    if (prev === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = prev;
    fs.rmSync(projectsDir, { recursive: true, force: true });
    fs.rmSync(codexHome, { recursive: true, force: true });
  }
});

test('a disabled CLI\'s sessions are hidden but its cached rows are kept', () => {
  const prev = process.env.CODEX_HOME;
  const settings = {};
  const { projectsDir, codexHome, fake } = setUpBoth(settings);
  try {
    sessionCache.reconcileCacheFromFilesystem();
    const shown = () => sessionCache.buildProjectsFromCache(true)
      .flatMap(p => p.sessions).map(s => s.runtime || 'claude');

    assert.ok(shown().includes('codex'), 'listed while switched on');

    settings.disabledHarnesses = ['codex'];
    assert.ok(!shown().includes('codex'), 'hidden while switched off');
    assert.ok(shown().includes('claude'), 'the other CLI is unaffected');
    // Nothing was deleted — that is what makes switching back on cheap.
    assert.ok(fake.cachedRows.some(r => r.runtime === 'codex'), 'rows kept in the cache');

    settings.disabledHarnesses = [];
    assert.ok(shown().includes('codex'), 'listed again immediately, with no re-index');
  } finally {
    if (prev === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = prev;
    fs.rmSync(projectsDir, { recursive: true, force: true });
    fs.rmSync(codexHome, { recursive: true, force: true });
  }
});
