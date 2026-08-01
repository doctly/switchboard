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

// In-memory fake of the db layer that init() expects, recording which folders
// actually got (re)indexed (i.e. had refreshFolder do work and upsert sessions).
function makeFakeDb(metaMap) {
  const indexedFolders = new Set();
  return {
    indexedFolders,
    db: {
      deleteCachedFolder() {},
      getCachedByFolder() { return []; },
      upsertCachedSessions(sessions) { for (const s of sessions) indexedFolders.add(s.folder); },
      deleteCachedSession() {},
      deleteSearchFolder() {},
      deleteSearchSession() {},
      upsertSearchEntries() {},
      setFolderMeta(folder, projectPath, indexMtimeMs) { metaMap.set(folder, { folder, projectPath, indexMtimeMs }); },
      getAllFolderMeta() { return metaMap; },
      getAllMeta() { return new Map(); },
      getAllCached() { return []; },
      getSetting() { return {}; },
      getMeta() { return null; },
      setName() {},
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
