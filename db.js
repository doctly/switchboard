const Database = require('better-sqlite3');
const path = require('path');
const os = require('os');

const DATA_DIR = path.join(os.homedir(), '.claude', 'browser');
const fs = require('fs');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const DB_PATH = path.join(DATA_DIR, 'session-browser.db');

// Migrate from old location if needed
const OLD_DB_PATH = path.join(os.homedir(), '.claude', 'session-browser.db');
if (!fs.existsSync(DB_PATH) && fs.existsSync(OLD_DB_PATH)) {
  fs.renameSync(OLD_DB_PATH, DB_PATH);
  // Also move WAL/SHM files if they exist
  try { fs.renameSync(OLD_DB_PATH + '-wal', DB_PATH + '-wal'); } catch {}
  try { fs.renameSync(OLD_DB_PATH + '-shm', DB_PATH + '-shm'); } catch {}
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

module.exports = { getMeta, getAllMeta, setName, toggleStar, setArchived };
