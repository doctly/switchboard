const Database = require('better-sqlite3');
const path = require('path');
const os = require('os');

// SWITCHBOARD_DATA_DIR overrides the data dir so a dev/test instance can run
// alongside the installed app without sharing its DB (main.js also isolates
// Electron userData / the single-instance lock off the same variable).
const DATA_DIR = process.env.SWITCHBOARD_DATA_DIR
  ? path.resolve(process.env.SWITCHBOARD_DATA_DIR)
  : path.join(os.homedir(), '.switchboard');
const fs = require('fs');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const DB_PATH = path.join(DATA_DIR, 'switchboard.db');

// Migrate from old locations if needed — never when running against an
// override dir, so a dev instance can't relocate the real app's legacy DB.
const OLD_LOCATIONS = process.env.SWITCHBOARD_DATA_DIR ? [] : [
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
db.pragma('busy_timeout = 5000');

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
    slug TEXT,
    aiTitle TEXT,
    fileMtime TEXT,
    runtime TEXT NOT NULL DEFAULT 'claude',
    sessionFile TEXT
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

// --- Migrations ---
// Each migration runs once, in order. Add new migrations to the end.
let searchFtsRecreated = false;
const migrations = [
  // v1: (superseded by v2)
  () => {},
  // v2: Clear session cache to re-index with corrected worktree paths
  (db) => {
    try { db.exec('DELETE FROM session_cache'); } catch {}
    try { db.exec('DELETE FROM cache_meta'); } catch {}
    try { db.exec('DELETE FROM search_map'); } catch {}
    try { db.exec('DROP TABLE IF EXISTS search_fts'); } catch {}
    searchFtsRecreated = true;
  },
  // v3: Add aiTitle column for AI-generated session titles. Clear cache so a
  // re-index repopulates the column. Also clear session_meta.name entries that
  // were clobbered by AI titles in v0.0.29 (when ai-title was written into the
  // user-name column). We cannot tell with certainty which names came from an
  // AI title vs a manual rename, but the safe heuristic is: drop names whose
  // value matches the JSONL aiTitle on next index. That post-index cleanup is
  // not done here — instead we accept that any pre-fix AI-title pollution
  // remains until the user renames manually, and only future indexes are clean.
  (db) => {
    try { db.exec('ALTER TABLE session_cache ADD COLUMN aiTitle TEXT'); } catch {}
    try { db.exec('DELETE FROM session_cache'); } catch {}
    try { db.exec('DELETE FROM cache_meta'); } catch {}
  },
  // v4: (superseded — fileMtime is added by the schema reconciliation below,
  // keyed on column presence rather than version number)
  () => {},
];

const currentDbVersion = (() => {
  try {
    const row = db.prepare("SELECT value FROM settings WHERE key = 'db_version'").get();
    return row ? JSON.parse(row.value) : 0;
  } catch { return 0; }
})();

for (let i = currentDbVersion; i < migrations.length; i++) {
  migrations[i](db);
}
if (migrations.length > currentDbVersion) {
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('db_version', ?)").run(JSON.stringify(migrations.length));
}

// --- Schema reconciliation ---
// Version-numbered migrations cannot be trusted to add columns: a DB already
// migrated to a HIGHER version by a build from a parallel branch skips this
// branch's migrations entirely (a db_version-5 DB from the subagent branch
// never ran our v4, so the fileMtime ALTER never happened and every prepare()
// below crashed the app at startup). Required columns are therefore ensured by
// inspecting the actual schema, independent of db_version. Errors here are
// deliberately NOT swallowed: a transient failure (e.g. SQLITE_BUSY) must not
// be recorded as migrated — the next launch simply retries.
{
  const cols = new Set(db.prepare('PRAGMA table_info(session_cache)').all().map(c => c.name));
  if (!cols.has('aiTitle')) db.exec('ALTER TABLE session_cache ADD COLUMN aiTitle TEXT');
  if (!cols.has('fileMtime')) {
    db.exec('ALTER TABLE session_cache ADD COLUMN fileMtime TEXT');
    // fileMtime's introduction changed what `modified` means (file mtime →
    // last-message timestamp), so cached values written by pre-fileMtime code
    // are stale. Clear the cache to force a full re-index; without this,
    // dormant folders would keep mtime-based times indefinitely because the
    // folder-level index gate never re-reads them.
    db.exec('DELETE FROM session_cache');
    db.exec('DELETE FROM cache_meta');
  }
  // Which CLI owns a session (`runtime`), and where its transcript actually
  // lives (`sessionFile`).
  //
  // Both already exist in DBs built from a parallel branch, with exactly these
  // semantics — runtime defaulting to 'claude', sessionFile null — so we adopt
  // them rather than adding a second pair that would immediately drift.
  //
  // Neither invalidates the cache. Every row that predates them is a Claude
  // session, which is what the default backfills, and a null sessionFile falls
  // back to the <folder>/<sessionId>.jsonl path Claude has always used (see
  // harnesses/claude.js transcriptPath). Codex needs the column because it
  // names transcripts rollout-<timestamp>-<sessionId>.jsonl, which cannot be
  // reconstructed from the session id alone.
  //
  // The ALTER omits NOT NULL on purpose: the parallel branch's column is
  // nullable, so requiring it here would mean rebuilding the table on DBs that
  // already have data. The default covers inserts, and every read goes through
  // getHarness(), which treats null as Claude.
  if (!cols.has('runtime')) db.exec("ALTER TABLE session_cache ADD COLUMN runtime TEXT DEFAULT 'claude'");
  if (!cols.has('sessionFile')) db.exec('ALTER TABLE session_cache ADD COLUMN sessionFile TEXT');
  // Resume state for Claude's incremental parser. Add by column presence even
  // when a parallel branch already advanced db_version. Existing rows keep
  // their cache/search data and get a full read on their next modification.
  // Raw timestamp bounds are separate from created/modified, whose fallback
  // to file times must not become an accumulator value on a later append.
  for (const col of [
    'customTitle TEXT', 'textContent TEXT', 'headHash TEXT',
    'indexedBytes INTEGER DEFAULT 0', 'firstTimestamp TEXT', 'lastTimestamp TEXT',
  ]) {
    if (!cols.has(col.split(' ')[0])) db.exec(`ALTER TABLE session_cache ADD COLUMN ${col}`);
  }
}

// --- Projects ---
// A project is a piece of work with a folder on disk (`root`). It attaches
// zero or more folders (the cwds sessions run in) and, later, tracks. Sessions
// are assigned through session_meta.projectId / trackId. These live in their
// own tables, never under the `project:<path>` settings key, because hiding a
// folder deletes that key (see remove-project in main.js).
//
// Same rule as above: tables and columns are ensured by inspecting the schema,
// not by db_version, so a DB touched by a parallel branch still gets them.
db.exec(`
  CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    slug TEXT NOT NULL UNIQUE,
    root TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    sharedBranch INTEGER NOT NULL DEFAULT 1,
    branchName TEXT,
    created TEXT NOT NULL,
    modified TEXT NOT NULL
  )
`);
db.exec(`
  CREATE TABLE IF NOT EXISTS project_folders (
    projectId TEXT NOT NULL,
    path TEXT NOT NULL,
    mode TEXT NOT NULL DEFAULT 'in-place',
    sourcePath TEXT,
    branch TEXT,
    sortOrder INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (projectId, path)
  )
`);
db.exec('CREATE INDEX IF NOT EXISTS idx_project_folders_path ON project_folders(path)');
db.exec(`
  CREATE TABLE IF NOT EXISTS tracks (
    id TEXT PRIMARY KEY,
    projectId TEXT NOT NULL,
    name TEXT NOT NULL,
    cwd TEXT,
    cli TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    sortOrder INTEGER NOT NULL DEFAULT 0,
    created TEXT NOT NULL
  )
`);
db.exec('CREATE INDEX IF NOT EXISTS idx_tracks_project ON tracks(projectId)');
// A scheduled task: a saved prompt plus a time. It lives in exactly one place,
// decided by projectId — set, it is listed in the project view under trackId
// (null = General) and runs in the track's cwd; null, it is a folder schedule
// listed on the Sessions tab under `cwd`. Timing is stored as fields
// (`every`, atHour, atMinute, weekday); `every = 'cron'` keeps a raw cron
// string only for schedules imported from the old schedule-*.md files.
db.exec(`
  CREATE TABLE IF NOT EXISTS schedules (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    projectId TEXT,
    trackId TEXT,
    cwd TEXT,
    prompt TEXT NOT NULL,
    every TEXT NOT NULL,
    atHour INTEGER,
    atMinute INTEGER,
    weekday INTEGER,
    cron TEXT,
    cli TEXT,
    enabled INTEGER NOT NULL DEFAULT 1,
    catchUp INTEGER NOT NULL DEFAULT 0,
    sourceFile TEXT,
    lastRunAt TEXT,
    lastSessionId TEXT,
    created TEXT NOT NULL
  )
`);
db.exec('CREATE INDEX IF NOT EXISTS idx_schedules_project ON schedules(projectId)');
{
  const cols = new Set(db.prepare('PRAGMA table_info(session_meta)').all().map(c => c.name));
  if (!cols.has('projectId')) db.exec('ALTER TABLE session_meta ADD COLUMN projectId TEXT');
  if (!cols.has('trackId')) db.exec('ALTER TABLE session_meta ADD COLUMN trackId TEXT');
  if (!cols.has('formerTrackName')) db.exec('ALTER TABLE session_meta ADD COLUMN formerTrackName TEXT');
  // Which schedule started the session, and when it fired. Read by the
  // session row's clock chip; nothing else depends on it.
  if (!cols.has('scheduleId')) db.exec('ALTER TABLE session_meta ADD COLUMN scheduleId TEXT');
  if (!cols.has('scheduledAt')) db.exec('ALTER TABLE session_meta ADD COLUMN scheduledAt TEXT');
}
{
  // Where a project's sessions start by default (null = the project folder).
  // Tracks inherit it unless they set their own cwd.
  const cols = new Set(db.prepare('PRAGMA table_info(projects)').all().map(c => c.name));
  if (!cols.has('defaultCwd')) db.exec('ALTER TABLE projects ADD COLUMN defaultCwd TEXT');
  // Snooze is an overlay on an active project: the row keeps status 'active'
  // and is hidden from the list while snoozedUntil is in the future. Nothing
  // clears the columns at wake time; a past snoozedUntil simply no longer
  // counts, so the renderer decides from the timestamp alone.
  if (!cols.has('snoozedUntil')) db.exec('ALTER TABLE projects ADD COLUMN snoozedUntil TEXT');
  if (!cols.has('snoozedAt')) db.exec('ALTER TABLE projects ADD COLUMN snoozedAt TEXT');
}
// Which session started or finished a plan phase or a todo. Items are matched
// by their text, not their line, so editing the file above an item does not
// orphan its history.
db.exec(`
  CREATE TABLE IF NOT EXISTS plan_links (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    projectId TEXT NOT NULL,
    file TEXT NOT NULL,
    itemText TEXT NOT NULL,
    sessionId TEXT NOT NULL,
    kind TEXT NOT NULL,
    at TEXT NOT NULL
  )
`);
db.exec('CREATE INDEX IF NOT EXISTS idx_plan_links_project ON plan_links(projectId)');

// --- FTS5 full-text search ---
db.exec(`
  CREATE VIRTUAL TABLE IF NOT EXISTS search_fts USING fts5(
    title, body, tokenize='trigram case_sensitive 0'
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
  // Frequent sidebar/title refreshes do not need the potentially large search
  // text or parser state. Keep the harness and transcript-location fields.
  cacheGetAll: db.prepare(`
    SELECT sessionId, folder, projectPath, summary, firstPrompt, created, modified,
           messageCount, slug, aiTitle, fileMtime, runtime, sessionFile
    FROM session_cache
  `),
  cacheUpsert: db.prepare(`
    INSERT INTO session_cache (sessionId, folder, projectPath, summary, firstPrompt, created, modified, messageCount, slug, aiTitle, fileMtime, runtime, sessionFile, customTitle, textContent, headHash, indexedBytes, firstTimestamp, lastTimestamp)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(sessionId) DO UPDATE SET
      folder = excluded.folder, projectPath = excluded.projectPath,
      summary = excluded.summary, firstPrompt = excluded.firstPrompt,
      created = excluded.created, modified = excluded.modified,
      messageCount = excluded.messageCount, slug = excluded.slug,
      aiTitle = excluded.aiTitle, fileMtime = excluded.fileMtime,
      runtime = excluded.runtime, sessionFile = excluded.sessionFile,
      customTitle = excluded.customTitle, textContent = excluded.textContent,
      headHash = excluded.headHash, indexedBytes = excluded.indexedBytes,
      firstTimestamp = excluded.firstTimestamp, lastTimestamp = excluded.lastTimestamp
  `),
  cacheGetByFolder: db.prepare('SELECT sessionId, fileMtime FROM session_cache WHERE folder = ?'),
  cacheGetSession: db.prepare('SELECT * FROM session_cache WHERE sessionId = ?'),
  cacheUpdateAiTitle: db.prepare('UPDATE session_cache SET aiTitle = ? WHERE sessionId = ? AND runtime = ?'),
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
  searchMapLookup: db.prepare('SELECT rowid, folder FROM search_map WHERE id = ? AND type = ?'),
  searchContentMatches: db.prepare('SELECT 1 FROM search_fts WHERE rowid = ? AND title = ? AND body = ?'),
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
      AND (? IS NULL OR search_map.id IN (SELECT value FROM json_each(?)))
    ORDER BY rank
    LIMIT ?
  `),
  searchSessionIds: db.prepare(`
    SELECT search_map.id
    FROM search_map
    CROSS JOIN search_fts ON search_fts.rowid = search_map.rowid
    WHERE search_map.type = 'session'
      AND search_map.id IN (SELECT value FROM json_each(?))
      AND search_fts MATCH ?
  `),
  // Project statements
  projectList: db.prepare('SELECT * FROM projects ORDER BY created'),
  projectGet: db.prepare('SELECT * FROM projects WHERE id = ?'),
  projectGetBySlug: db.prepare('SELECT * FROM projects WHERE slug = ?'),
  projectInsert: db.prepare(`
    INSERT INTO projects (id, name, slug, root, status, sharedBranch, branchName, created, modified)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `),
  projectDelete: db.prepare('DELETE FROM projects WHERE id = ?'),
  projectFoldersList: db.prepare('SELECT * FROM project_folders WHERE projectId = ? ORDER BY sortOrder, path'),
  projectFoldersListAll: db.prepare('SELECT * FROM project_folders ORDER BY projectId, sortOrder, path'),
  projectFolderUpsert: db.prepare(`
    INSERT INTO project_folders (projectId, path, mode, sourcePath, branch, sortOrder)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(projectId, path) DO UPDATE SET
      mode = excluded.mode, sourcePath = excluded.sourcePath,
      branch = excluded.branch, sortOrder = excluded.sortOrder
  `),
  projectFolderDelete: db.prepare('DELETE FROM project_folders WHERE projectId = ? AND path = ?'),
  projectFoldersDeleteByProject: db.prepare('DELETE FROM project_folders WHERE projectId = ?'),
  tracksList: db.prepare('SELECT * FROM tracks WHERE projectId = ? ORDER BY sortOrder, created'),
  tracksListAll: db.prepare('SELECT * FROM tracks ORDER BY projectId, sortOrder, created'),
  trackGet: db.prepare('SELECT * FROM tracks WHERE id = ?'),
  trackInsert: db.prepare(`
    INSERT INTO tracks (id, projectId, name, cwd, cli, status, sortOrder, created)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `),
  trackDelete: db.prepare('DELETE FROM tracks WHERE id = ?'),
  tracksDeleteByProject: db.prepare('DELETE FROM tracks WHERE projectId = ?'),
  schedulesListAll: db.prepare('SELECT * FROM schedules ORDER BY created'),
  schedulesListByProject: db.prepare('SELECT * FROM schedules WHERE projectId = ? ORDER BY created'),
  scheduleGet: db.prepare('SELECT * FROM schedules WHERE id = ?'),
  scheduleInsert: db.prepare(`
    INSERT INTO schedules (id, name, projectId, trackId, cwd, prompt, every, atHour, atMinute, weekday, cron, cli, enabled, catchUp, sourceFile, lastRunAt, lastSessionId, created)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `),
  scheduleDelete: db.prepare('DELETE FROM schedules WHERE id = ?'),
  schedulesDeleteByProject: db.prepare('DELETE FROM schedules WHERE projectId = ?'),
  schedulesClearTrack: db.prepare('UPDATE schedules SET trackId = NULL WHERE trackId = ?'),
  scheduleRekeySession: db.prepare('UPDATE schedules SET lastSessionId = ? WHERE lastSessionId = ?'),
  scheduleLinkSet: db.prepare(`
    INSERT INTO session_meta (sessionId, scheduleId, scheduledAt) VALUES (?, ?, ?)
    ON CONFLICT(sessionId) DO UPDATE SET scheduleId = excluded.scheduleId, scheduledAt = excluded.scheduledAt
  `),
  scheduleLinkRekey: db.prepare('UPDATE session_meta SET scheduleId = ?, scheduledAt = ? WHERE sessionId = ?'),
  scheduleLinkClear: db.prepare('UPDATE session_meta SET scheduleId = NULL, scheduledAt = NULL WHERE scheduleId = ?'),
  // Session ↔ project assignment lives on session_meta so it survives cache
  // rebuilds. name/starred/archived are left untouched by these statements.
  assignmentSet: db.prepare(`
    INSERT INTO session_meta (sessionId, projectId, trackId) VALUES (?, ?, ?)
    ON CONFLICT(sessionId) DO UPDATE SET projectId = excluded.projectId, trackId = excluded.trackId
  `),
  assignmentClearProject: db.prepare('UPDATE session_meta SET projectId = NULL, trackId = NULL WHERE projectId = ?'),
  assignmentClearTrack: db.prepare('UPDATE session_meta SET trackId = NULL WHERE trackId = ?'),
  // Plan links
  planLinkInsert: db.prepare('INSERT INTO plan_links (projectId, file, itemText, sessionId, kind, at) VALUES (?, ?, ?, ?, ?, ?)'),
  planLinksByProject: db.prepare('SELECT * FROM plan_links WHERE projectId = ? ORDER BY at'),
  planLinksDeleteByProject: db.prepare('DELETE FROM plan_links WHERE projectId = ?'),
  planLinksRekey: db.prepare('UPDATE plan_links SET sessionId = ? WHERE sessionId = ?'),
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
      s.slug || null, s.aiTitle || null, s.fileMtime || null,
      s.runtime || 'claude', s.sessionFile || null,
      s.customTitle || null, s.textContent || null, s.headHash || null,
      s.indexedBytes || 0, s.firstTimestamp || null, s.lastTimestamp || null
    );
  }
});

function upsertCachedSessions(sessions) {
  upsertCachedSessionsBatch(sessions);
}

function getCachedByFolder(folder) {
  return stmts.cacheGetByFolder.all(folder);
}

function getCachedSession(sessionId) {
  return stmts.cacheGetSession.get(sessionId) || null;
}

function updateCachedAiTitle(sessionId, aiTitle, runtime) {
  return stmts.cacheUpdateAiTitle.run(aiTitle, sessionId, runtime).changes;
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
    const folder = e.folder || null;
    const title = e.title || '';
    const body = e.body || '';
    const existing = stmts.searchMapLookup.get(e.id, e.type);
    // Transcript mtime also changes for tool output and CLI bookkeeping. Keep
    // the FTS row when its searchable content is identical, including across
    // app restarts. Comparing the stored text needs no migration or rebuild.
    if (existing && existing.folder === folder &&
        stmts.searchContentMatches.get(existing.rowid, title, body)) continue;

    // Delete any existing FTS row for this (id, type) pair before inserting.
    // search_map uses INSERT OR REPLACE which deletes the old row and creates
    // a new one with a new rowid, but the orphaned FTS5 row keyed to the old
    // rowid would never be cleaned up — causing duplicate search results and
    // unbounded FTS table growth.
    if (existing) {
      stmts.searchDeleteByRowid.run(existing.rowid);
      stmts.searchMapDeleteByRowid.run(existing.rowid);
    }
    const result = stmts.searchInsertMap.run(e.id, e.type, folder);
    stmts.searchInsertFts.run(result.lastInsertRowid, title, body);
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

function searchByType(type, query, limit = 50, titleOnly = false, sessionIds = null) {
  try {
    // Wrap in double quotes for exact substring matching with trigram tokenizer.
    // This prevents FTS5 from splitting on punctuation (e.g. "spec.md" → "spec" + "md")
    const escaped = '"' + query.replace(/"/g, '""') + '"';
    // FTS5 column filter: prefix with "title:" to restrict match to title column
    const match = titleOnly ? 'title:' + escaped : escaped;
    const scope = sessionIds === null ? null : JSON.stringify(sessionIds);
    return stmts.searchQuery.all(type, match, scope, scope, limit);
  } catch {
    return [];
  }
}

function searchSessionIds(query, sessionIds) {
  if (!query.trim() || !sessionIds.length) return [];
  const match = '"' + query.replace(/"/g, '""') + '"';
  return stmts.searchSessionIds.all(JSON.stringify(sessionIds), match).map(row => row.id);
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

// --- Project functions ---

const PROJECT_PATCH_KEYS = ['name', 'status', 'sharedBranch', 'branchName', 'defaultCwd', 'snoozedUntil', 'snoozedAt', 'modified'];
const TRACK_PATCH_KEYS = ['name', 'cwd', 'cli', 'status', 'sortOrder'];
const SCHEDULE_PATCH_KEYS = ['name', 'trackId', 'cwd', 'prompt', 'every', 'atHour', 'atMinute', 'weekday', 'cron', 'cli', 'enabled', 'catchUp', 'lastRunAt', 'lastSessionId'];

function listProjects() {
  return stmts.projectList.all();
}

function getProject(id) {
  return stmts.projectGet.get(id) || null;
}

function getProjectBySlug(slug) {
  return stmts.projectGetBySlug.get(slug) || null;
}

function insertProject(row) {
  stmts.projectInsert.run(
    row.id, row.name, row.slug, row.root,
    row.status || 'active', row.sharedBranch === false ? 0 : 1, row.branchName || null,
    row.created, row.modified
  );
}

// Only whitelisted columns can change; the patch is applied with one UPDATE so
// callers cannot rename `id`, `slug` or `root` by accident.
function updatePatch(table, allowed, id, patch) {
  const sets = [];
  const values = [];
  for (const key of allowed) {
    if (!(key in patch)) continue;
    sets.push(`${key} = ?`);
    let value = patch[key];
    if (key === 'sharedBranch') value = value ? 1 : 0;
    values.push(value === undefined ? null : value);
  }
  if (!sets.length) return 0;
  values.push(id);
  return db.prepare(`UPDATE ${table} SET ${sets.join(', ')} WHERE id = ?`).run(...values).changes;
}

function updateProject(id, patch) {
  return updatePatch('projects', PROJECT_PATCH_KEYS, id, patch);
}

const deleteProjectTx = db.transaction((id) => {
  stmts.assignmentClearProject.run(id);
  stmts.tracksDeleteByProject.run(id);
  stmts.schedulesDeleteByProject.run(id);
  stmts.projectFoldersDeleteByProject.run(id);
  stmts.planLinksDeleteByProject.run(id);
  stmts.projectDelete.run(id);
});

// --- Plan links ---

function insertPlanLink(row) {
  stmts.planLinkInsert.run(row.projectId, row.file, row.itemText, row.sessionId, row.kind, row.at || new Date().toISOString());
}

function listPlanLinks(projectId) {
  return stmts.planLinksByProject.all(projectId);
}

/** A session that started under a temporary id keeps its links once the real id is known. */
function rekeyPlanLinks(fromId, toId) {
  return stmts.planLinksRekey.run(toId, fromId).changes;
}

function deleteProject(id) {
  deleteProjectTx(id);
}

function listProjectFolders(projectId) {
  return stmts.projectFoldersList.all(projectId);
}

function listAllProjectFolders() {
  return stmts.projectFoldersListAll.all();
}

function upsertProjectFolder(row) {
  stmts.projectFolderUpsert.run(
    row.projectId, row.path, row.mode || 'in-place',
    row.sourcePath || null, row.branch || null, row.sortOrder || 0
  );
}

function deleteProjectFolder(projectId, folderPath) {
  stmts.projectFolderDelete.run(projectId, folderPath);
}

function listTracks(projectId) {
  return stmts.tracksList.all(projectId);
}

function listAllTracks() {
  return stmts.tracksListAll.all();
}

function getTrack(id) {
  return stmts.trackGet.get(id) || null;
}

function insertTrack(row) {
  stmts.trackInsert.run(
    row.id, row.projectId, row.name, row.cwd || null, row.cli || null,
    row.status || 'active', row.sortOrder || 0, row.created
  );
}

function updateTrack(id, patch) {
  return updatePatch('tracks', TRACK_PATCH_KEYS, id, patch);
}

const deleteTrackTx = db.transaction((id, archiveSessions) => {
  const track = stmts.trackGet.get(id);
  if (!track) return [];
  const sessionIds = db.prepare('SELECT sessionId FROM session_meta WHERE trackId = ?').all(id).map(row => row.sessionId);
  db.prepare(`UPDATE session_meta SET formerTrackName = ?, trackId = NULL,
    archived = CASE WHEN ? THEN 1 ELSE archived END WHERE trackId = ?`).run(track.name, archiveSessions ? 1 : 0, id);
  stmts.trackDelete.run(id);
  // Its schedules stay in the project, under General, like its sessions.
  stmts.schedulesClearTrack.run(id);
  return sessionIds;
});

function deleteTrack(id, { archiveSessions = false } = {}) {
  return deleteTrackTx(id, archiveSessions);
}

// --- Schedules ---

function listSchedules() {
  return stmts.schedulesListAll.all();
}

function listSchedulesByProject(projectId) {
  return stmts.schedulesListByProject.all(projectId);
}

function getSchedule(id) {
  return stmts.scheduleGet.get(id) || null;
}

function insertSchedule(row) {
  stmts.scheduleInsert.run(
    row.id, row.name, row.projectId || null, row.trackId || null, row.cwd || null,
    row.prompt, row.every,
    row.atHour ?? null, row.atMinute ?? null, row.weekday ?? null, row.cron || null,
    row.cli || null, row.enabled === false ? 0 : 1, row.catchUp ? 1 : 0,
    row.sourceFile || null, row.lastRunAt || null, row.lastSessionId || null, row.created
  );
}

function updateSchedule(id, patch) {
  const clean = { ...patch };
  if ('enabled' in clean) clean.enabled = clean.enabled ? 1 : 0;
  if ('catchUp' in clean) clean.catchUp = clean.catchUp ? 1 : 0;
  return updatePatch('schedules', SCHEDULE_PATCH_KEYS, id, clean);
}

const deleteScheduleTx = db.transaction((id) => {
  stmts.scheduleLinkClear.run(id);
  stmts.scheduleDelete.run(id);
});

function deleteSchedule(id) {
  deleteScheduleTx(id);
}

/** A session started by a schedule: the row remembers it, and the schedule remembers the run. */
const recordScheduleRunTx = db.transaction((scheduleId, sessionId, at) => {
  stmts.scheduleLinkSet.run(sessionId, scheduleId, at);
  db.prepare('UPDATE schedules SET lastRunAt = ?, lastSessionId = ? WHERE id = ?').run(at, sessionId, scheduleId);
});

function recordScheduleRun(scheduleId, sessionId, at) {
  recordScheduleRunTx(scheduleId, sessionId, at);
}

// A session that started under a temporary id keeps its schedule link once
// the real id is known (codex).
const rekeyScheduleSessionTx = db.transaction((fromId, toId) => {
  const row = stmts.get.get(fromId);
  if (row?.scheduleId) {
    stmts.scheduleLinkSet.run(toId, row.scheduleId, row.scheduledAt);
    stmts.scheduleLinkRekey.run(null, null, fromId);
  }
  stmts.scheduleRekeySession.run(toId, fromId);
});

function rekeyScheduleSession(fromId, toId) {
  rekeyScheduleSessionTx(fromId, toId);
}

function setSessionAssignment(sessionId, projectId, trackId) {
  stmts.assignmentSet.run(sessionId, projectId || null, trackId || null);
}

// A fork inherits its parent's project and track.
function copySessionAssignment(fromId, toId) {
  const row = stmts.get.get(fromId);
  if (!row || (!row.projectId && !row.trackId)) return false;
  stmts.assignmentSet.run(toId, row.projectId || null, row.trackId || null);
  return true;
}

// A Codex session runs under a temporary id until its transcript appears; the
// assignment recorded at launch has to follow it to the real id.
function moveSessionAssignment(fromId, toId) {
  const copied = copySessionAssignment(fromId, toId);
  if (copied) stmts.assignmentSet.run(fromId, null, null);
  return copied;
}

function closeDb() {
  try { db.close(); } catch {}
}

module.exports = {
  getMeta, getAllMeta, setName, toggleStar, setArchived,
  isCachePopulated, getAllCached, getCachedByFolder, getCachedSession, upsertCachedSessions,
  updateCachedAiTitle,
  deleteCachedSession, deleteCachedFolder,
  getFolderMeta, getAllFolderMeta, setFolderMeta,
  upsertSearchEntries, updateSearchTitle, deleteSearchSession, deleteSearchFolder, deleteSearchType,
  searchByType, searchSessionIds, isSearchIndexPopulated, searchFtsRecreated,
  getSetting, setSetting, deleteSetting,
  listProjects, getProject, getProjectBySlug, insertProject, updateProject, deleteProject,
  listProjectFolders, listAllProjectFolders, upsertProjectFolder, deleteProjectFolder,
  listTracks, listAllTracks, getTrack, insertTrack, updateTrack, deleteTrack,
  listSchedules, listSchedulesByProject, getSchedule, insertSchedule, updateSchedule, deleteSchedule,
  recordScheduleRun, rekeyScheduleSession,
  setSessionAssignment, copySessionAssignment, moveSessionAssignment,
  insertPlanLink, listPlanLinks, rekeyPlanLinks,
  closeDb,
};
