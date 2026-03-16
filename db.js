const Database = require('better-sqlite3');
const path = require('path');
const os = require('os');

const DATA_DIR = path.join(os.homedir(), '.switchboard');
const fs = require('fs');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const DB_PATH = path.join(DATA_DIR, 'switchboard.db');

// Migrate from old locations if needed
const OLD_LOCATIONS = [
  path.join(os.homedir(), '.claude', 'browser', 'switchboard.db'),
  path.join(os.homedir(), '.claude', 'browser', 'session-browser.db'),
  path.join(os.homedir(), '.claude', 'session-browser.db'),
];
if (!fs.existsSync(DB_PATH)) {
  for (const oldPath of OLD_LOCATIONS) {
    if (fs.existsSync(oldPath)) {
      fs.renameSync(oldPath, DB_PATH);
      try { fs.renameSync(oldPath + '-wal', DB_PATH + '-wal'); } catch {}
      try { fs.renameSync(oldPath + '-shm', DB_PATH + '-shm'); } catch {}
      break;
    }
  }
}
const db = new Database(DB_PATH);

db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS session_meta (
    sessionId TEXT PRIMARY KEY,
    name TEXT,
    starred INTEGER DEFAULT 0,
    archived INTEGER DEFAULT 0
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS session_cache (
    sessionId TEXT PRIMARY KEY,
    folder TEXT NOT NULL,
    projectPath TEXT,
    summary TEXT,
    firstPrompt TEXT,
    created TEXT,
    modified TEXT,
    messageCount INTEGER DEFAULT 0,
    slug TEXT
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS cache_meta (
    folder TEXT PRIMARY KEY,
    projectPath TEXT,
    indexMtimeMs REAL
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  )
`);

// Index for fast folder lookups
db.exec('CREATE INDEX IF NOT EXISTS idx_session_cache_folder ON session_cache(folder)');
db.exec('CREATE INDEX IF NOT EXISTS idx_session_cache_slug ON session_cache(slug)');

// --- FTS5 full-text search ---
db.exec(`
  CREATE VIRTUAL TABLE IF NOT EXISTS search_fts USING fts5(
    title, body, tokenize='trigram'
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS search_map (
    rowid INTEGER PRIMARY KEY,
    id TEXT NOT NULL,
    type TEXT NOT NULL,
    folder TEXT
  )
`);

db.exec('CREATE INDEX IF NOT EXISTS idx_search_map_type_id ON search_map(type, id)');

const stmts = {
  get: db.prepare('SELECT * FROM session_meta WHERE sessionId = ?'),
  getAll: db.prepare('SELECT * FROM session_meta'),
  upsertName: db.prepare(`
    INSERT INTO session_meta (sessionId, name) VALUES (?, ?)
    ON CONFLICT(sessionId) DO UPDATE SET name = excluded.name
  `),
  upsertStar: db.prepare(`
    INSERT INTO session_meta (sessionId, starred) VALUES (?, 1)
    ON CONFLICT(sessionId) DO UPDATE SET starred = CASE WHEN starred = 1 THEN 0 ELSE 1 END
  `),
  upsertArchived: db.prepare(`
    INSERT INTO session_meta (sessionId, archived) VALUES (?, ?)
    ON CONFLICT(sessionId) DO UPDATE SET archived = excluded.archived
  `),
  // Session cache statements
  cacheCount: db.prepare('SELECT COUNT(*) as cnt FROM session_cache'),
  cacheGetAll: db.prepare('SELECT * FROM session_cache'),
  cacheUpsert: db.prepare(`
    INSERT INTO session_cache (sessionId, folder, projectPath, summary, firstPrompt, created, modified, messageCount, slug)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(sessionId) DO UPDATE SET
      folder = excluded.folder, projectPath = excluded.projectPath,
      summary = excluded.summary, firstPrompt = excluded.firstPrompt,
      created = excluded.created, modified = excluded.modified,
      messageCount = excluded.messageCount, slug = excluded.slug
  `),
  cacheGetByFolder: db.prepare('SELECT sessionId, modified FROM session_cache WHERE folder = ?'),
  cacheGetFolder: db.prepare('SELECT folder FROM session_cache WHERE sessionId = ?'),
  cacheGetSession: db.prepare('SELECT * FROM session_cache WHERE sessionId = ?'),
  cacheDeleteSession: db.prepare('DELETE FROM session_cache WHERE sessionId = ?'),
  cacheDeleteFolder: db.prepare('DELETE FROM session_cache WHERE folder = ?'),
  // Cache meta statements
  metaGet: db.prepare('SELECT * FROM cache_meta WHERE folder = ?'),
  metaGetAll: db.prepare('SELECT * FROM cache_meta'),
  metaUpsert: db.prepare(`
    INSERT INTO cache_meta (folder, projectPath, indexMtimeMs)
    VALUES (?, ?, ?)
    ON CONFLICT(folder) DO UPDATE SET
      projectPath = excluded.projectPath, indexMtimeMs = excluded.indexMtimeMs
  `),
  metaDelete: db.prepare('DELETE FROM cache_meta WHERE folder = ?'),
  // FTS search statements
  searchDeleteBySession: db.prepare('DELETE FROM search_fts WHERE rowid IN (SELECT rowid FROM search_map WHERE type = \'session\' AND id = ?)'),
  searchMapDeleteBySession: db.prepare('DELETE FROM search_map WHERE type = \'session\' AND id = ?'),
  searchDeleteByFolder: db.prepare('DELETE FROM search_fts WHERE rowid IN (SELECT rowid FROM search_map WHERE type = \'session\' AND folder = ?)'),
  searchMapDeleteByFolder: db.prepare('DELETE FROM search_map WHERE type = \'session\' AND folder = ?'),
  searchDeleteByType: db.prepare('DELETE FROM search_fts WHERE rowid IN (SELECT rowid FROM search_map WHERE type = ?)'),
  searchMapDeleteByType: db.prepare('DELETE FROM search_map WHERE type = ?'),
  searchInsertFts: db.prepare('INSERT OR REPLACE INTO search_fts(rowid, title, body) VALUES (?, ?, ?)'),
  searchInsertMap: db.prepare('INSERT OR REPLACE INTO search_map(id, type, folder) VALUES (?, ?, ?)'),
  searchMapLookup: db.prepare('SELECT rowid FROM search_map WHERE id = ? AND type = ?'),
  searchUpdateTitle: db.prepare('UPDATE search_fts SET title = ? WHERE rowid = (SELECT rowid FROM search_map WHERE id = ? AND type = ?)'),
  searchDeleteByRowid: db.prepare('DELETE FROM search_fts WHERE rowid = ?'),
  searchMapDeleteByRowid: db.prepare('DELETE FROM search_map WHERE rowid = ?'),
  // Settings statements
  settingsGet: db.prepare('SELECT value FROM settings WHERE key = ?'),
  settingsUpsert: db.prepare(`
    INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `),
  settingsDelete: db.prepare('DELETE FROM settings WHERE key = ?'),
  searchQuery: db.prepare(`
    SELECT search_map.id, snippet(search_fts, 1, '<mark>', '</mark>', '...', 40) as snippet
    FROM search_fts
    JOIN search_map ON search_fts.rowid = search_map.rowid
    WHERE search_map.type = ? AND search_fts MATCH ?
    ORDER BY rank
    LIMIT ?
  `),
};

function getMeta(sessionId) {
  return stmts.get.get(sessionId) || null;
}

function getAllMeta() {
  const rows = stmts.getAll.all();
  const map = new Map();
  for (const row of rows) map.set(row.sessionId, row);
  return map;
}

function setName(sessionId, name) {
  stmts.upsertName.run(sessionId, name);
}

function toggleStar(sessionId) {
  stmts.upsertStar.run(sessionId);
  const row = stmts.get.get(sessionId);
  return row.starred;
}

function setArchived(sessionId, archived) {
  stmts.upsertArchived.run(sessionId, archived ? 1 : 0);
}

// --- Session cache functions ---

function isCachePopulated() {
  return stmts.cacheCount.get().cnt > 0;
}

function getAllCached() {
  return stmts.cacheGetAll.all();
}

const upsertCachedSessionsBatch = db.transaction((sessions) => {
  for (const s of sessions) {
    stmts.cacheUpsert.run(
      s.sessionId, s.folder, s.projectPath, s.summary,
      s.firstPrompt, s.created, s.modified, s.messageCount || 0,
      s.slug || null
    );
  }
});

function upsertCachedSessions(sessions) {
  upsertCachedSessionsBatch(sessions);
}

function getCachedByFolder(folder) {
  return stmts.cacheGetByFolder.all(folder);
}

function getCachedFolder(sessionId) {
  const row = stmts.cacheGetFolder.get(sessionId);
  return row ? row.folder : null;
}

function getCachedSession(sessionId) {
  return stmts.cacheGetSession.get(sessionId) || null;
}

function deleteCachedSession(sessionId) {
  stmts.cacheDeleteSession.run(sessionId);
}

function deleteCachedFolder(folder) {
  stmts.cacheDeleteFolder.run(folder);
  stmts.metaDelete.run(folder);
}

function getFolderMeta(folder) {
  return stmts.metaGet.get(folder) || null;
}

function getAllFolderMeta() {
  const rows = stmts.metaGetAll.all();
  const map = new Map();
  for (const row of rows) map.set(row.folder, row);
  return map;
}

function setFolderMeta(folder, projectPath, indexMtimeMs) {
  stmts.metaUpsert.run(folder, projectPath, indexMtimeMs);
}

// --- FTS search functions ---

const upsertSearchEntriesBatch = db.transaction((entries) => {
  for (const e of entries) {
    // Delete any existing FTS row for this (id, type) pair before inserting.
    // search_map uses INSERT OR REPLACE which deletes the old row and creates
    // a new one with a new rowid, but the orphaned FTS5 row keyed to the old
    // rowid would never be cleaned up — causing duplicate search results and
    // unbounded FTS table growth.
    const existing = stmts.searchMapLookup.get(e.id, e.type);
    if (existing) {
      stmts.searchDeleteByRowid.run(existing.rowid);
      stmts.searchMapDeleteByRowid.run(existing.rowid);
    }
    const result = stmts.searchInsertMap.run(e.id, e.type, e.folder || null);
    stmts.searchInsertFts.run(result.lastInsertRowid, e.title || '', e.body || '');
  }
});

function deleteSearchSession(sessionId) {
  stmts.searchDeleteBySession.run(sessionId);
  stmts.searchMapDeleteBySession.run(sessionId);
}

function deleteSearchFolder(folder) {
  stmts.searchDeleteByFolder.run(folder);
  stmts.searchMapDeleteByFolder.run(folder);
}

function deleteSearchType(type) {
  stmts.searchDeleteByType.run(type);
  stmts.searchMapDeleteByType.run(type);
}

function upsertSearchEntries(entries) {
  upsertSearchEntriesBatch(entries);
}

function updateSearchTitle(id, type, title) {
  try {
    stmts.searchUpdateTitle.run(title, id, type);
  } catch {}
}

function searchByType(type, query, limit = 50) {
  try {
    // Wrap in double quotes for exact substring matching with trigram tokenizer.
    // This prevents FTS5 from splitting on punctuation (e.g. "spec.md" → "spec" + "md")
    const escaped = '"' + query.replace(/"/g, '""') + '"';
    return stmts.searchQuery.all(type, escaped, limit);
  } catch {
    return [];
  }
}

function isSearchIndexPopulated() {
  const row = db.prepare('SELECT COUNT(*) as cnt FROM search_map WHERE type = ?').get('session');
  return row.cnt > 0;
}

// --- Settings functions ---

function getSetting(key) {
  const row = stmts.settingsGet.get(key);
  if (!row) return null;
  try { return JSON.parse(row.value); } catch { return row.value; }
}

function setSetting(key, value) {
  stmts.settingsUpsert.run(key, JSON.stringify(value));
}

function deleteSetting(key) {
  stmts.settingsDelete.run(key);
}

function closeDb() {
  try { db.close(); } catch {}
}

module.exports = {
  getMeta, getAllMeta, setName, toggleStar, setArchived,
  isCachePopulated, getAllCached, getCachedByFolder, getCachedFolder, getCachedSession, upsertCachedSessions,
  deleteCachedSession, deleteCachedFolder,
  getFolderMeta, getAllFolderMeta, setFolderMeta,
  upsertSearchEntries, updateSearchTitle, deleteSearchSession, deleteSearchFolder, deleteSearchType,
  searchByType, isSearchIndexPopulated,
  getSetting, setSetting, deleteSetting,
  closeDb,
};
