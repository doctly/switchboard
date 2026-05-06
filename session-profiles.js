// session-profiles.js — persists which profile a session was last launched
// with, so the sidebar can show the correct icon badge across app restarts.
//
// Storage: <userData>/session-profiles.json. Schema:
//   { version: 1, sessions: { <sessionId>: <profileId> } }
//
// Writes are coalesced (debounced) so the IPC chatter from setting a profile
// for every session in a busy startup doesn't thrash the disk. The file is
// rewritten atomically (tmp + rename) regardless.
//
// Profiles can be deleted while sessions still reference them. The renderer
// is responsible for treating a missing profile id as "default" (no badge).

const fs = require('fs');
const path = require('path');

const SCHEMA_VERSION = 1;
const FLUSH_DEBOUNCE_MS = 200;
const MAX_ENTRIES = 5000;  // hard cap so a runaway client can't blow up the file

let _pathOverride = null;
let _state = null;
let _flushTimer = null;
let _logger = null;

function setStorePathForTesting(p) {
  _pathOverride = p;
  _state = null;  // force reload
}

function storePath() {
  if (_pathOverride) return _pathOverride;
  const { app } = require('electron');
  return path.join(app.getPath('userData'), 'session-profiles.json');
}

function emptyState() { return { version: SCHEMA_VERSION, sessions: {} }; }

function load() {
  try {
    const raw = fs.readFileSync(storePath(), 'utf8');
    const data = JSON.parse(raw);
    if (!data || typeof data !== 'object') return emptyState();
    const sessions = (data.sessions && typeof data.sessions === 'object') ? data.sessions : {};
    // Defensive: drop entries with non-string ids/values.
    const cleaned = {};
    for (const [k, v] of Object.entries(sessions)) {
      if (typeof k === 'string' && typeof v === 'string' && k.length <= 128 && v.length <= 64) {
        cleaned[k] = v;
      }
    }
    return { version: SCHEMA_VERSION, sessions: cleaned };
  } catch {
    return emptyState();
  }
}

function getState() {
  if (!_state) _state = load();
  return _state;
}

function flushSync() {
  if (!_state) return;
  const target = storePath();
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const tmp = target + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(_state));
    fs.renameSync(tmp, target);
  } catch (err) {
    if (_logger) _logger.error('[session-profiles] flush failed:', err.message);
  }
}

function scheduleFlush() {
  if (_flushTimer) clearTimeout(_flushTimer);
  _flushTimer = setTimeout(() => {
    _flushTimer = null;
    flushSync();
  }, FLUSH_DEBOUNCE_MS);
  if (_flushTimer.unref) _flushTimer.unref();
}

function recordSessionProfile(sessionId, profileId) {
  if (typeof sessionId !== 'string' || !sessionId) return;
  const state = getState();
  if (typeof profileId === 'string' && profileId) {
    state.sessions[sessionId] = profileId;
  } else {
    delete state.sessions[sessionId];
  }
  // Cap growth: drop oldest insertion-order entries when we exceed MAX_ENTRIES.
  // (Order is preserved across V8's Object key ordering for string keys, so
  // this is good enough — the precise eviction policy doesn't matter much.)
  const keys = Object.keys(state.sessions);
  if (keys.length > MAX_ENTRIES) {
    for (const k of keys.slice(0, keys.length - MAX_ENTRIES)) delete state.sessions[k];
  }
  scheduleFlush();
}

// Called from session-transitions when a temp id maps to a real id; copy
// the mapping over to the real id and remove the temp one. Idempotent.
function rekeySession(oldId, newId) {
  if (typeof oldId !== 'string' || typeof newId !== 'string' || oldId === newId) return;
  const state = getState();
  const v = state.sessions[oldId];
  if (v) {
    state.sessions[newId] = v;
    delete state.sessions[oldId];
    scheduleFlush();
  }
}

function getAllMappings() {
  return { ...getState().sessions };
}

function getProfileForSession(sessionId) {
  return getState().sessions[sessionId] || null;
}

function init(log) {
  _logger = log;
  const { ipcMain, app } = require('electron');
  ipcMain.handle('session-profiles:get-all', () => getAllMappings());
  // Make sure pending writes hit disk before quit.
  app.on('before-quit', flushSync);
}

module.exports = {
  init,
  recordSessionProfile,
  rekeySession,
  getAllMappings,
  getProfileForSession,
  flushSync,
  setStorePathForTesting,
};
