// profiles.js — Claude session profiles: per-profile env var overrides
//
// A profile is a named bundle of environment variables that get merged into
// a session's pty env at spawn time. Values can be either:
//   - literal strings (e.g. "https://api.deepseek.com/anthropic")
//   - references to system environment variables: "$DEEPSEEK_API_KEY"
//     or "${DEEPSEEK_API_KEY}". Unresolved refs are dropped (not passed
//     through as the literal string), so secrets never leak into the
//     command line if the host env var is missing.
//
// Persistence: <userData>/profiles.json. Plain JSON (no encryption) since
// values are either literals or *references*; actual secrets stay in the
// host process env. Atomic write via tmp+rename.

const fs = require('fs');
const path = require('path');

const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ENV_REF_RE = /^\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))$/;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
// Icon key — references an entry in the renderer-side PROFILE_ICONS catalog.
// Validated as a short slug so a malicious value can't smuggle markup through
// even though the renderer uses createElementNS rather than innerHTML.
const ICON_KEY_RE = /^[a-z][a-z0-9_-]{0,32}$/;
const MAX_PROFILES = 32;
const MAX_ENV_VARS = 64;
const MAX_VALUE_LEN = 4096;

let _profilesPathOverride = null;

function setProfilesPathForTesting(p) { _profilesPathOverride = p; }

function profilesPath() {
  if (_profilesPathOverride) return _profilesPathOverride;
  const { app } = require('electron');
  return path.join(app.getPath('userData'), 'profiles.json');
}

function isPlainObject(o) {
  return o !== null && typeof o === 'object' && !Array.isArray(o);
}

function isValidProfile(p) {
  if (!isPlainObject(p)) return false;
  if (typeof p.id !== 'string' || !ID_RE.test(p.id)) return false;
  if (typeof p.name !== 'string' || !p.name.trim() || p.name.length > 100) return false;
  if (!isPlainObject(p.env)) return false;
  const keys = Object.keys(p.env);
  if (keys.length > MAX_ENV_VARS) return false;
  for (const k of keys) {
    if (!ENV_NAME_RE.test(k)) return false;
    const v = p.env[k];
    if (typeof v !== 'string' || v.length > MAX_VALUE_LEN) return false;
  }
  // Optional icon: must be a known short slug if present.
  if (p.icon !== undefined && p.icon !== null && p.icon !== '') {
    if (typeof p.icon !== 'string' || !ICON_KEY_RE.test(p.icon)) return false;
  }
  return true;
}

function emptyState() { return { profiles: [], defaultProfileId: null }; }

function loadProfiles() {
  try {
    const raw = fs.readFileSync(profilesPath(), 'utf8');
    const data = JSON.parse(raw);
    if (!isPlainObject(data)) return emptyState();
    const profiles = Array.isArray(data.profiles)
      ? data.profiles.filter(isValidProfile).slice(0, MAX_PROFILES)
      : [];
    const defaultProfileId = (typeof data.defaultProfileId === 'string'
      && profiles.find(p => p.id === data.defaultProfileId))
      ? data.defaultProfileId
      : null;
    return { profiles, defaultProfileId };
  } catch {
    return emptyState();
  }
}

function saveProfiles(state) {
  const target = profilesPath();
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = target + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, target);
}

// Resolve a profile's env map: substitute $VAR / ${VAR} references against
// processEnv (defaults to process.env). Unresolved refs are DROPPED, not
// passed through as the literal "$VAR" string.
function resolveEnv(envMap, processEnv) {
  const env = processEnv || process.env;
  const out = {};
  if (!isPlainObject(envMap)) return out;
  for (const [k, v] of Object.entries(envMap)) {
    if (typeof v !== 'string') continue;
    const m = ENV_REF_RE.exec(v);
    if (m) {
      const refName = m[1] || m[2];
      const resolved = env[refName];
      if (typeof resolved === 'string' && resolved.length > 0) {
        out[k] = resolved;
      }
      // unresolved → skip
    } else {
      out[k] = v;
    }
  }
  return out;
}

function getProfileById(id) {
  if (typeof id !== 'string' || !id) return null;
  const { profiles } = loadProfiles();
  return profiles.find(p => p.id === id) || null;
}

function getDefaultProfile() {
  const { profiles, defaultProfileId } = loadProfiles();
  if (!defaultProfileId) return null;
  return profiles.find(p => p.id === defaultProfileId) || null;
}

// Pick the profile to apply for a session given a per-session profileId
// (which may be undefined, meaning "use default", or the literal string
// "none", meaning "no profile — pass-through").
function pickProfileForSession(profileId) {
  if (profileId === 'none') return null;
  if (profileId) return getProfileById(profileId);
  return getDefaultProfile();
}

function init(log) {
  const { ipcMain } = require('electron');

  ipcMain.handle('profiles:list', () => loadProfiles());

  ipcMain.handle('profiles:save', (_e, profile) => {
    if (!isValidProfile(profile)) return { ok: false, error: 'invalid profile' };
    const state = loadProfiles();
    const idx = state.profiles.findIndex(p => p.id === profile.id);
    if (idx >= 0) {
      state.profiles[idx] = profile;
    } else {
      if (state.profiles.length >= MAX_PROFILES) {
        return { ok: false, error: `max ${MAX_PROFILES} profiles` };
      }
      state.profiles.push(profile);
    }
    saveProfiles(state);
    if (log) log.info(`[profiles] Saved profile "${profile.name}" (${profile.id})`);
    return { ok: true };
  });

  ipcMain.handle('profiles:delete', (_e, id) => {
    if (typeof id !== 'string' || !ID_RE.test(id)) return { ok: false, error: 'invalid id' };
    const state = loadProfiles();
    const before = state.profiles.length;
    state.profiles = state.profiles.filter(p => p.id !== id);
    if (state.defaultProfileId === id) state.defaultProfileId = null;
    saveProfiles(state);
    if (log) log.info(`[profiles] Deleted profile ${id} (${before - state.profiles.length} removed)`);
    return { ok: true };
  });

  ipcMain.handle('profiles:set-default', (_e, id) => {
    const state = loadProfiles();
    if (id && (typeof id !== 'string' || !state.profiles.find(p => p.id === id))) {
      return { ok: false, error: 'unknown profile' };
    }
    state.defaultProfileId = id || null;
    saveProfiles(state);
    return { ok: true };
  });
}

module.exports = {
  init,
  loadProfiles,
  saveProfiles,
  resolveEnv,
  getProfileById,
  getDefaultProfile,
  pickProfileForSession,
  isValidProfile,
  setProfilesPathForTesting,
  ENV_REF_RE,
  ENV_NAME_RE,
};
