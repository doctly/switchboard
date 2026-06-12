const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const sessionCache = require('../session-cache');
const { getFolderIndexMtimeMs } = require('../folder-index-state');

// Minimal valid transcript: a `cwd` line (for deriveProjectPath) and a user
// message (so readSessionFile yields a non-null session).
function writeSession(folderPath, cwd) {
  fs.mkdirSync(folderPath, { recursive: true });
  const line = JSON.stringify({ type: 'user', cwd, message: { role: 'user', content: 'hello' } });
  fs.writeFileSync(path.join(folderPath, 'session.jsonl'), line + '\n', 'utf8');
}

// In-memory fake of the db layer init() expects; records which folders actually
// got (re)indexed (i.e. had refreshFolder do work and upsert sessions).
function makeFakeDb(metaMap) {
  const indexed = new Set();
  const noop = () => {};
  return {
    indexed,
    db: {
      deleteCachedFolder: noop,
      getCachedByFolder: () => [],
      upsertCachedSessions: (sessions) => { for (const s of sessions) indexed.add(s.folder); },
      touchCachedModified: noop,
      deleteCachedSession: noop,
      replaceSessionMetrics: noop,
      deleteSearchFolder: noop,
      deleteSearchSession: noop,
      upsertSearchEntries: noop,
      setFolderMeta: (folder, projectPath, indexMtimeMs) => metaMap.set(folder, { folder, projectPath, indexMtimeMs }),
      getAllFolderMeta: () => metaMap,
      getAllMeta: () => new Map(),
      getAllCached: () => [],
      getSetting: () => ({}),
      getMeta: () => null,
      setName: noop,
    },
  };
}

test('reconcileCacheFromFilesystem indexes new and stale folders but skips up-to-date ones', () => {
  const projectsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-reconcile-'));
  try {
    writeSession(path.join(projectsDir, 'proj-new'), '/tmp/proj-new');       // never indexed (no meta)
    writeSession(path.join(projectsDir, 'proj-stale'), '/tmp/proj-stale');   // meta older than disk
    writeSession(path.join(projectsDir, 'proj-current'), '/tmp/proj-current'); // meta == disk

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

    assert.ok(fake.indexed.has('proj-new'), 'new folder should be indexed');
    assert.ok(fake.indexed.has('proj-stale'), 'stale folder (older indexMtimeMs) should be re-indexed');
    assert.ok(!fake.indexed.has('proj-current'), 'up-to-date folder should be skipped');
  } finally {
    fs.rmSync(projectsDir, { recursive: true, force: true });
  }
});
