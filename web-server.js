'use strict';

/**
 * Switchboard web server mode.
 *
 * Starts an HTTP + WebSocket server that serves the existing frontend and
 * exposes all IPC handlers as HTTP endpoints, with terminal I/O over WebSocket.
 *
 * Usage:
 *   node web-server.js [--port 3000] [--host 0.0.0.0] [--token <token>]
 *
 * A bearer token is printed to stdout on startup. Pass it in subsequent
 * requests as:  Authorization: Bearer <token>
 * or as a query parameter: ?token=<token>
 */

const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const pty = require('node-pty');
const { WebSocketServer } = require('ws');
const { URL } = require('url');

// ── CLI args ─────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
function argVal(flag) {
  const i = argv.indexOf(flag);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : null;
}
const PORT = parseInt(argVal('--port') || process.env.SWITCHBOARD_PORT || '3000', 10);
const HOST = argVal('--host') || process.env.SWITCHBOARD_HOST || '127.0.0.1';
const TOKEN = argVal('--token') || process.env.SWITCHBOARD_TOKEN || crypto.randomBytes(24).toString('hex');

// ── Logging ───────────────────────────────────────────────────────────

const log = {
  info:  (...a) => console.log('[info]',  ...a),
  debug: (...a) => process.env.DEBUG ? console.log('[debug]', ...a) : undefined,
  error: (...a) => console.error('[error]', ...a),
  warn:  (...a) => console.warn('[warn]',  ...a),
};

// ── Module imports (same as main.js) ─────────────────────────────────

const { startMcpServer, shutdownMcpServer, shutdownAll: shutdownAllMcp,
        resolvePendingDiff, rekeyMcpServer, cleanStaleLockFiles } = require('./mcp-bridge');
const { fetchAndTransformUsage } = require('./claude-auth');
const {
  getMeta, getAllMeta, toggleStar, setName, setArchived,
  isCachePopulated, getAllCached, getCachedByFolder, getCachedFolder, getCachedSession,
  upsertCachedSessions, deleteCachedSession, deleteCachedFolder,
  getFolderMeta, getAllFolderMeta, setFolderMeta,
  upsertSearchEntries, updateSearchTitle, deleteSearchSession, deleteSearchFolder,
  deleteSearchType, searchByType, isSearchIndexPopulated, searchFtsRecreated,
  getSetting, setSetting, deleteSetting, closeDb,
} = require('./db');
const { discoverShellProfiles, getShellProfiles, resolveShell,
        isWindows, isWslShell, windowsToWslPath, shellArgs } = require('./shell-profiles');
const { deriveProjectPath } = require('./derive-project-path');

// ── Constants ────────────────────────────────────────────────────────

const PROJECTS_DIR  = path.join(os.homedir(), '.claude', 'projects');
const PLANS_DIR     = path.join(os.homedir(), '.claude', 'plans');
const CLAUDE_DIR    = path.join(os.homedir(), '.claude');
const STATS_CACHE_PATH = path.join(CLAUDE_DIR, 'stats-cache.json');
const MAX_BUFFER_SIZE  = 256 * 1024;
const PUBLIC_DIR    = path.join(__dirname, 'public');
const NODE_MODS_DIR = path.join(__dirname, 'node_modules');

const SETTING_DEFAULTS = {
  permissionMode: null,
  dangerouslySkipPermissions: false,
  worktree: false,
  worktreeName: '',
  chrome: false,
  preLaunchCmd: '',
  addDirs: '',
  visibleSessionCount: 5,
  sidebarWidth: 340,
  terminalTheme: 'switchboard',
  mcpEmulation: false,
  shellProfile: 'auto',
};

// ── Active PTY sessions (same structure as main.js) ──────────────────

const activeSessions = new Map();

// ── WebSocket broadcast (replaces mainWindow.webContents.send) ───────

const wsClients = new Set();

function broadcast(event, ...args) {
  const msg = JSON.stringify({ type: 'event', event, args });
  for (const ws of wsClients) {
    if (ws.readyState === 1 /* OPEN */) {
      ws.send(msg);
    }
  }
}

// ── Fake mainWindow object ────────────────────────────────────────────
// session-cache, session-transitions, and mcp-bridge all call
// mainWindow.webContents.send(event, ...args) — we intercept via broadcast().

const mainWindow = {
  isDestroyed: () => false,
  webContents: {
    send: (event, ...args) => broadcast(event, ...args),
  },
};

// ── Clean PTY env (same as main.js) ──────────────────────────────────

const cleanPtyEnv = Object.fromEntries(
  Object.entries(process.env).filter(([k]) =>
    !k.startsWith('ELECTRON_') &&
    !k.startsWith('GOOGLE_API_KEY') &&
    k !== 'NODE_OPTIONS' &&
    k !== 'ORIGINAL_XDG_CURRENT_DESKTOP' &&
    k !== 'WT_SESSION'
  )
);

// ── Session cache ─────────────────────────────────────────────────────

const sessionCache = require('./session-cache');
sessionCache.init({
  PROJECTS_DIR,
  activeSessions,
  getMainWindow: () => mainWindow,
  log,
  db: {
    deleteCachedFolder, getCachedByFolder, upsertCachedSessions, deleteCachedSession,
    deleteSearchFolder, deleteSearchSession, upsertSearchEntries,
    setFolderMeta, getAllMeta, getAllCached, getSetting, getMeta, setName,
  },
});
const { readSessionFile, readFolderFromFilesystem, refreshFolder, populateCacheFromFilesystem,
        buildProjectsFromCache, notifyRendererProjectsChanged, sendStatus,
        populateCacheViaWorker } = sessionCache;

// ── Session transitions ───────────────────────────────────────────────

const sessionTransitions = require('./session-transitions');
sessionTransitions.init({ PROJECTS_DIR, activeSessions, getMainWindow: () => mainWindow, log, rekeyMcpServer });
const { detectSessionTransitions } = sessionTransitions;

// ── Auth helper ───────────────────────────────────────────────────────

function isAuthorized(req) {
  const auth = req.headers['authorization'] || '';
  if (auth.startsWith('Bearer ') && auth.slice(7) === TOKEN) return true;
  try {
    const u = new URL(req.url, `http://${req.headers.host}`);
    if (u.searchParams.get('token') === TOKEN) return true;
  } catch {}
  return false;
}

// ── Static file serving ───────────────────────────────────────────────

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico':  'image/x-icon',
  '.svg':  'image/svg+xml',
  '.woff': 'font/woff',
  '.woff2':'font/woff2',
  '.ttf':  'font/ttf',
  '.json': 'application/json; charset=utf-8',
  '.map':  'application/json; charset=utf-8',
};

function serveStatic(res, filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const mime = MIME[ext] || 'application/octet-stream';
  try {
    const data = fs.readFileSync(filePath);
    res.writeHead(200, { 'Content-Type': mime });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end('Not found');
  }
}

// ── IPC handler logic ─────────────────────────────────────────────────
// Each function mirrors its ipcMain.handle counterpart in main.js.

function handleGetProjects(showArchived) {
  try {
    const needsPopulate = !isCachePopulated() || !isSearchIndexPopulated();
    if (needsPopulate) { populateCacheViaWorker(); return []; }
    return buildProjectsFromCache(showArchived);
  } catch (err) {
    log.error('get-projects:', err);
    return [];
  }
}

function handleGetPlans() {
  try {
    if (!fs.existsSync(PLANS_DIR)) return [];
    const files = fs.readdirSync(PLANS_DIR).filter(f => f.endsWith('.md'));
    const plans = [];
    for (const file of files) {
      const filePath = path.join(PLANS_DIR, file);
      try {
        const stat = fs.statSync(filePath);
        const content = fs.readFileSync(filePath, 'utf8');
        const firstLine = content.split('\n').find(l => l.trim());
        const title = firstLine && firstLine.startsWith('# ')
          ? firstLine.slice(2).trim() : file.replace(/\.md$/, '');
        plans.push({ filename: file, title, modified: stat.mtime.toISOString() });
      } catch {}
    }
    plans.sort((a, b) => new Date(b.modified) - new Date(a.modified));
    try {
      deleteSearchType('plan');
      upsertSearchEntries(plans.map(p => ({
        id: p.filename, type: 'plan', folder: null,
        title: p.title,
        body: fs.readFileSync(path.join(PLANS_DIR, p.filename), 'utf8'),
      })));
    } catch {}
    return plans;
  } catch (err) { log.error('get-plans:', err); return []; }
}

function handleReadPlan(filename) {
  try {
    const filePath = path.join(PLANS_DIR, path.basename(filename));
    return { content: fs.readFileSync(filePath, 'utf8'), filePath };
  } catch (err) { return { content: '', filePath: '' }; }
}

function handleSavePlan(filePath, content) {
  try {
    const resolved = path.resolve(filePath);
    if (!resolved.startsWith(PLANS_DIR)) return { ok: false, error: 'path outside plans directory' };
    fs.writeFileSync(resolved, content, 'utf8');
    return { ok: true };
  } catch (err) { return { ok: false, error: err.message }; }
}

function handleGetStats() {
  try {
    if (!fs.existsSync(STATS_CACHE_PATH)) return null;
    return JSON.parse(fs.readFileSync(STATS_CACHE_PATH, 'utf8'));
  } catch { return null; }
}

async function handleRefreshStats() {
  const globalSettings = getSetting('global') || {};
  const statsProfileId = globalSettings.shellProfile || SETTING_DEFAULTS.shellProfile;
  const statsShellProfile = resolveShell(statsProfileId);
  const statsShell = statsShellProfile.path;
  const statsShellExtraArgs = statsShellProfile.args || [];
  const ptyEnv = {
    ...cleanPtyEnv,
    TERM: 'xterm-256color', COLORTERM: 'truecolor',
    TERM_PROGRAM: 'iTerm.app', TERM_PROGRAM_VERSION: '3.6.6', FORCE_COLOR: '3', ITERM_SESSION_ID: '1',
  };

  function runClaude(args, { timeoutMs = 15000, waitFor = null } = {}) {
    return new Promise((resolve) => {
      let output = '', settled = false, trustAccepted = false, sawActivity = false;
      const finish = () => {
        if (settled) return; settled = true;
        try { p.kill(); } catch {}
        resolve(output);
      };
      const claudeCmd = `claude ${args}`;
      const p = pty.spawn(statsShell, shellArgs(statsShell, claudeCmd, statsShellExtraArgs), {
        name: 'xterm-256color', cols: 120, rows: 40, cwd: os.homedir(), env: ptyEnv,
      });
      const strip = (s) => s.replace(/\x1b\[[^@-~]*[@-~]/g, '').replace(/\x1b\][^\x07]*\x07/g, '').replace(/\x1b[^[\]].?/g, '');
      p.onData((data) => {
        output += data;
        if (!trustAccepted && /trust\s*this\s*folder/i.test(strip(output))) {
          trustAccepted = true;
          try { p.write('\r'); } catch {}
          return;
        }
        if (waitFor) { if (waitFor.test(strip(output))) finish(); return; }
        if (!sawActivity) {
          const oscTitle = data.match(/\x1b\]0;([^\x07\x1b]*)/);
          if (oscTitle) {
            const first = oscTitle[1].charAt(0);
            if (first.charCodeAt(0) >= 0x2800 && first.charCodeAt(0) <= 0x28FF) sawActivity = true;
          }
        } else if (data.includes('\u2733')) finish();
      });
      p.onExit(() => finish());
      setTimeout(finish, timeoutMs);
    });
  }

  try {
    const [, usage] = await Promise.all([
      runClaude('"/stats"', { waitFor: /streak/i, timeoutMs: 10000 }),
      fetchAndTransformUsage().catch(() => ({})),
    ]);
    let stats = null;
    try {
      if (fs.existsSync(STATS_CACHE_PATH)) stats = JSON.parse(fs.readFileSync(STATS_CACHE_PATH, 'utf8'));
    } catch {}
    return { stats, usage: usage || {} };
  } catch (err) { log.error('refresh-stats:', err); return { stats: null, usage: {} }; }
}

async function handleGetUsage() {
  try { return await fetchAndTransformUsage() || {}; } catch { return {}; }
}

function folderToShortPath(folder) {
  return folder.replace(/^-/, '').split('-').filter(Boolean).slice(-2).join('/');
}

function scanMdFiles(dir) {
  const results = [];
  try {
    if (!fs.existsSync(dir)) return results;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.isFile() && e.name.endsWith('.md')) {
        const fp = path.join(dir, e.name);
        const content = fs.readFileSync(fp, 'utf8').trim();
        if (content) results.push({ filename: e.name, filePath: fp, modified: fs.statSync(fp).mtime.toISOString() });
      }
    }
  } catch {}
  return results;
}

function handleGetMemories() {
  const global = getSetting('global') || {};
  const hiddenProjects = new Set(global.hiddenProjects || []);
  const globalFiles = scanMdFiles(CLAUDE_DIR).map(f => ({ ...f, displayPath: '~/.claude' }));
  const projects = [];
  try {
    if (fs.existsSync(PROJECTS_DIR)) {
      for (const d of fs.readdirSync(PROJECTS_DIR, { withFileTypes: true }).filter(d => d.isDirectory() && d.name !== '.git')) {
        const folder = d.name;
        const folderPath = path.join(PROJECTS_DIR, folder);
        const projectPath = deriveProjectPath(folderPath, folder);
        if (projectPath && hiddenProjects.has(projectPath)) continue;
        const shortName = projectPath
          ? projectPath.split('/').filter(Boolean).slice(-2).join('/')
          : folderToShortPath(folder);
        const files = [], seenPaths = new Set();
        for (const f of [...scanMdFiles(folderPath), ...scanMdFiles(path.join(folderPath, 'memory'))]) {
          if (!seenPaths.has(f.filePath)) { files.push({ ...f, displayPath: '~/.claude', source: 'claude-home' }); seenPaths.add(f.filePath); }
        }
        if (projectPath) {
          for (const name of ['CLAUDE.md', 'GEMINI.md', 'agents.md']) {
            const fp = path.join(projectPath, name);
            try {
              if (fs.existsSync(fp) && !seenPaths.has(fp)) {
                const content = fs.readFileSync(fp, 'utf8').trim();
                if (content) {
                  files.push({ filename: name, filePath: fp, modified: fs.statSync(fp).mtime.toISOString(), displayPath: shortName + '/', source: 'project' });
                  seenPaths.add(fp);
                }
              }
            } catch {}
          }
          const dotClaudeDir = path.join(projectPath, '.claude');
          for (const f of [...scanMdFiles(dotClaudeDir), ...scanMdFiles(path.join(dotClaudeDir, 'commands'))]) {
            if (!seenPaths.has(f.filePath)) { files.push({ ...f, displayPath: shortName + '/.claude/', source: 'project' }); seenPaths.add(f.filePath); }
          }
        }
        if (files.length) projects.push({ folder, projectPath: projectPath || '', shortName, files });
      }
    }
  } catch (err) { log.error('get-memories:', err); }
  projects.sort((a, b) => Math.max(...b.files.map(f => new Date(f.modified))) - Math.max(...a.files.map(f => new Date(f.modified))));
  try {
    deleteSearchType('memory');
    upsertSearchEntries([...globalFiles, ...projects.flatMap(p => p.files)].map(f => ({
      id: f.filePath, type: 'memory', folder: null,
      title: (f.displayPath || '') + ' ' + f.filename,
      body: fs.readFileSync(f.filePath, 'utf8'),
    })));
  } catch {}
  return { global: { files: globalFiles }, projects };
}

function handleReadMemory(filePath) {
  try {
    const resolved = path.resolve(filePath);
    if (!resolved.endsWith('.md')) return '';
    if (!resolved.startsWith(CLAUDE_DIR) && !fs.existsSync(resolved)) return '';
    return fs.readFileSync(resolved, 'utf8');
  } catch { return ''; }
}

function handleSaveMemory(filePath, content) {
  try {
    const resolved = path.resolve(filePath);
    if (!resolved.endsWith('.md')) return { ok: false, error: 'not a .md file' };
    if (!fs.existsSync(resolved)) return { ok: false, error: 'file does not exist' };
    fs.writeFileSync(resolved, content, 'utf8');
    return { ok: true };
  } catch (err) { return { ok: false, error: err.message }; }
}

function handleAddProject(projectPath) {
  try {
    const stat = fs.statSync(projectPath);
    if (!stat.isDirectory()) return { error: 'Path is not a directory' };
    const global = getSetting('global') || {};
    if (global.hiddenProjects && global.hiddenProjects.includes(projectPath)) {
      global.hiddenProjects = global.hiddenProjects.filter(p => p !== projectPath);
      setSetting('global', global);
    }
    const folder = projectPath.replace(/[/_]/g, '-').replace(/^-/, '-');
    const folderPath = path.join(PROJECTS_DIR, folder);
    if (!fs.existsSync(folderPath)) fs.mkdirSync(folderPath, { recursive: true });
    if (!fs.readdirSync(folderPath).some(f => f.endsWith('.jsonl'))) {
      const seedId = crypto.randomUUID();
      const now = new Date().toISOString();
      const line = JSON.stringify({ type: 'user', cwd: projectPath, sessionId: seedId, uuid: crypto.randomUUID(), timestamp: now, message: { role: 'user', content: 'New project' } });
      fs.writeFileSync(path.join(folderPath, seedId + '.jsonl'), line + '\n');
    }
    refreshFolder(folder);
    notifyRendererProjectsChanged();
    return { ok: true, folder, projectPath };
  } catch (err) { return { error: err.message }; }
}

function handleRemoveProject(projectPath) {
  try {
    const global = getSetting('global') || {};
    const hidden = global.hiddenProjects || [];
    if (!hidden.includes(projectPath)) hidden.push(projectPath);
    global.hiddenProjects = hidden;
    setSetting('global', global);
    const folder = projectPath.replace(/[/_]/g, '-').replace(/^-/, '-');
    deleteCachedFolder(folder);
    deleteSearchFolder(folder);
    deleteSetting('project:' + projectPath);
    notifyRendererProjectsChanged();
    return { ok: true };
  } catch (err) { return { error: err.message }; }
}

function handleSearch(type, query, titleOnly) {
  return searchByType(type, query, 50, !!titleOnly);
}

function handleGetActiveSessions() {
  const active = [];
  for (const [id, s] of activeSessions) { if (!s.exited) active.push(id); }
  return active;
}

function handleGetActiveTerminals() {
  const terminals = [];
  for (const [id, s] of activeSessions) {
    if (!s.exited && s.isPlainTerminal) terminals.push({ sessionId: id, projectPath: s.projectPath });
  }
  return terminals;
}

function handleStopSession(sessionId) {
  const s = activeSessions.get(sessionId);
  if (!s || s.exited) return { ok: false, error: 'not running' };
  s.pty.kill();
  return { ok: true };
}

function handleToggleStar(sessionId) { return { starred: toggleStar(sessionId) }; }

function handleRenameSession(sessionId, name) {
  setName(sessionId, name || null);
  const cached = getCachedSession(sessionId);
  updateSearchTitle(sessionId, 'session', (name ? name + ' ' : '') + (cached?.summary || ''));
  return { name: name || null };
}

function handleArchiveSession(sessionId, archived) {
  const val = archived ? 1 : 0;
  setArchived(sessionId, val);
  return { archived: val };
}

function handleReadSessionJsonl(sessionId) {
  const folder = getCachedFolder(sessionId);
  if (!folder) return { error: 'Session not found in cache' };
  const jsonlPath = path.join(PROJECTS_DIR, folder, sessionId + '.jsonl');
  try {
    const entries = [];
    for (const line of fs.readFileSync(jsonlPath, 'utf-8').split('\n')) {
      if (line.trim()) try { entries.push(JSON.parse(line)); } catch {}
    }
    return { entries };
  } catch (err) { return { error: err.message }; }
}

function handleGetSetting(key) { return getSetting(key); }
function handleSetSetting(key, value) { setSetting(key, value); return { ok: true }; }
function handleDeleteSetting(key) { deleteSetting(key); return { ok: true }; }

function handleGetShellProfiles() { return getShellProfiles(); }

function handleGetEffectiveSettings(projectPath) {
  const global = getSetting('global') || {};
  const project = projectPath ? (getSetting('project:' + projectPath) || {}) : {};
  const effective = { ...SETTING_DEFAULTS };
  for (const key of Object.keys(SETTING_DEFAULTS)) {
    if (global[key] !== undefined && global[key] !== null) effective[key] = global[key];
    if (project[key] !== undefined && project[key] !== null) effective[key] = project[key];
  }
  return effective;
}

function handleReadFileForPanel(filePath) {
  try { return { ok: true, content: fs.readFileSync(filePath, 'utf8') }; }
  catch (err) { return { ok: false, error: err.message }; }
}

function handleSaveFileForPanel(filePath, content) {
  try {
    const resolved = path.resolve(filePath);
    if (!fs.existsSync(resolved)) return { ok: false, error: 'File does not exist' };
    fs.writeFileSync(resolved, content, 'utf8');
    return { ok: true };
  } catch (err) { return { ok: false, error: err.message }; }
}

const fileWatchers = new Map();

function handleWatchFile(filePath) {
  const resolved = path.resolve(filePath);
  if (fileWatchers.has(resolved)) return { ok: true };
  try {
    let debounce = null;
    const watcher = fs.watch(resolved, (eventType) => {
      if (eventType !== 'change') return;
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(() => broadcast('file-changed', resolved), 300);
    });
    fileWatchers.set(resolved, watcher);
    return { ok: true };
  } catch (err) { return { ok: false, error: err.message }; }
}

function handleUnwatchFile(filePath) {
  const resolved = path.resolve(filePath);
  const watcher = fileWatchers.get(resolved);
  if (watcher) { watcher.close(); fileWatchers.delete(resolved); }
  return { ok: true };
}

async function handleOpenTerminal(sessionId, projectPath, isNew, sessionOptions) {
  // Reattach to existing session
  if (activeSessions.has(sessionId)) {
    const session = activeSessions.get(sessionId);
    session.rendererAttached = true;
    session.firstResize = !session.isPlainTerminal;
    if (session.altScreen && !session.isPlainTerminal) broadcast('terminal-data', sessionId, '\x1b[?1049h');
    for (const chunk of session.outputBuffer) broadcast('terminal-data', sessionId, chunk);
    if (!session.isPlainTerminal) broadcast('terminal-data', sessionId, '\x1b[?25l');
    return { ok: true, reattached: true, mcpActive: !!session.mcpServer };
  }

  if (!fs.existsSync(projectPath)) return { ok: false, error: `project directory no longer exists: ${projectPath}` };

  const isPlainTerminal = sessionOptions?.type === 'terminal';
  const effectiveProfileId = (() => {
    const g = getSetting('global') || {};
    const p = projectPath ? (getSetting('project:' + projectPath) || {}) : {};
    let id = SETTING_DEFAULTS.shellProfile;
    if (g.shellProfile != null) id = g.shellProfile;
    if (p.shellProfile != null) id = p.shellProfile;
    return id;
  })();
  const requestedProfile = resolveShell(effectiveProfileId);
  const shellProfile = (isWslShell(requestedProfile.path) && !isPlainTerminal) ? resolveShell('auto') : requestedProfile;
  const shell = shellProfile.path;
  const shellExtraArgs = [...(shellProfile.args || [])];
  const isWsl = isWslShell(shell);
  if (isWsl) shellExtraArgs.unshift('--cd', windowsToWslPath(projectPath));

  let knownJsonlFiles = new Set(), sessionSlug = null, projectFolder = null;

  if (!isPlainTerminal) {
    projectFolder = projectPath.replace(/[/_]/g, '-').replace(/^-/, '-');
    const claudeProjectDir = path.join(PROJECTS_DIR, projectFolder);
    if (fs.existsSync(claudeProjectDir)) {
      try { knownJsonlFiles = new Set(fs.readdirSync(claudeProjectDir).filter(f => f.endsWith('.jsonl'))); } catch {}
    }
    if (!isNew) {
      try {
        const jsonlPath = path.join(claudeProjectDir, sessionId + '.jsonl');
        const head = fs.readFileSync(jsonlPath, 'utf8').slice(0, 8000);
        for (const line of head.split('\n').filter(Boolean)) {
          const entry = JSON.parse(line);
          if (entry.slug) { sessionSlug = entry.slug; break; }
        }
      } catch {}
    }
  }

  let ptyProcess, mcpServer = null;
  try {
    if (isPlainTerminal) {
      const claudeShim = 'claude() { echo "\\033[33mTo start a Claude session, use the + button in the sidebar.\\033[0m"; return 1; }; export -f claude 2>/dev/null;';
      ptyProcess = pty.spawn(shell, shellArgs(shell, undefined, shellExtraArgs), {
        name: 'xterm-256color', cols: 120, rows: 30,
        cwd: isWsl ? os.homedir() : projectPath,
        env: { ...cleanPtyEnv, TERM: 'xterm-256color', COLORTERM: 'truecolor', TERM_PROGRAM: 'iTerm.app', TERM_PROGRAM_VERSION: '3.6.6', FORCE_COLOR: '3', ITERM_SESSION_ID: '1', CLAUDECODE: '1', ENV: claudeShim, BASH_ENV: claudeShim },
      });
      setTimeout(() => { if (!ptyProcess._isDisposed) try { ptyProcess.write(claudeShim + ' clear\n'); } catch {} }, 300);
    } else {
      let claudeCmd;
      if (sessionOptions?.forkFrom) claudeCmd = `claude --resume "${sessionOptions.forkFrom}" --fork-session`;
      else if (isNew) claudeCmd = `claude --session-id "${sessionId}"`;
      else claudeCmd = `claude --resume "${sessionId}"`;

      if (sessionOptions) {
        if (sessionOptions.dangerouslySkipPermissions) claudeCmd += ' --dangerously-skip-permissions';
        else if (sessionOptions.permissionMode) claudeCmd += ` --permission-mode "${sessionOptions.permissionMode}"`;
        if (sessionOptions.worktree) { claudeCmd += ' --worktree'; if (sessionOptions.worktreeName) claudeCmd += ` "${sessionOptions.worktreeName}"`; }
        if (sessionOptions.chrome) claudeCmd += ' --chrome';
        if (sessionOptions.addDirs) {
          for (const dir of sessionOptions.addDirs.split(',').map(d => d.trim()).filter(Boolean))
            claudeCmd += ` --add-dir "${dir}"`;
        }
      }
      if (sessionOptions?.preLaunchCmd) claudeCmd = sessionOptions.preLaunchCmd + ' ' + claudeCmd;

      if (sessionOptions?.mcpEmulation !== false) {
        try {
          mcpServer = await startMcpServer(sessionId, [projectPath], mainWindow, log);
          claudeCmd += ' --ide';
        } catch (err) { log.error(`[mcp] Failed to start for ${sessionId}: ${err.message}`); }
      }

      const ptyEnv = { ...cleanPtyEnv, TERM: 'xterm-256color', COLORTERM: 'truecolor', TERM_PROGRAM: 'iTerm.app', TERM_PROGRAM_VERSION: '3.6.6', FORCE_COLOR: '3', ITERM_SESSION_ID: '1' };
      if (mcpServer) ptyEnv.CLAUDE_CODE_SSE_PORT = String(mcpServer.port);

      ptyProcess = pty.spawn(shell, shellArgs(shell, claudeCmd, shellExtraArgs), {
        name: 'xterm-256color', cols: 120, rows: 30,
        cwd: isWsl ? os.homedir() : projectPath,
        env: ptyEnv,
      });
    }
  } catch (err) { return { ok: false, error: `Error spawning PTY: ${err.message}` }; }

  const session = {
    pty: ptyProcess, rendererAttached: true, exited: false,
    outputBuffer: [], outputBufferSize: 0, altScreen: false,
    projectPath, firstResize: true,
    projectFolder, knownJsonlFiles, sessionSlug,
    isPlainTerminal, forkFrom: sessionOptions?.forkFrom || null,
    mcpServer, _openedAt: Date.now(),
  };
  activeSessions.set(sessionId, session);

  ptyProcess.onData(data => {
    const currentId = session.realSessionId || sessionId;

    if (data.includes('\x1b]')) {
      for (const m of data.matchAll(/\x1b\](\d+);([^\x07\x1b]*)(?:\x07|\x1b\\)/g)) {
        const code = m[1], payload = m[2].slice(0, 120);
        if (code === '0') {
          const firstChar = payload.charAt(0);
          const isBusy = firstChar.charCodeAt(0) >= 0x2800 && firstChar.charCodeAt(0) <= 0x28FF;
          const isIdle = firstChar === '\u2733';
          if (isBusy && !session._cliBusy) { session._cliBusy = true; session._oscIdle = false; broadcast('cli-busy-state', currentId, true); }
          else if (isIdle && session._cliBusy) { session._cliBusy = false; session._oscIdle = true; broadcast('cli-busy-state', currentId, false); }
        }
      }
      for (const osc9 of data.matchAll(/\x1b\]9;([^\x07\x1b]*)(?:\x07|\x1b\\)/g)) {
        const payload = osc9[1];
        if (payload.startsWith('4;')) {
          const level = payload.split(';')[1];
          if (level === '0') continue;
          if ((level === '1' || level === '2' || level === '3') && !session._cliBusy) {
            session._cliBusy = true; session._oscIdle = false; broadcast('cli-busy-state', currentId, true);
          }
        } else { broadcast('terminal-notification', currentId, payload); }
      }
    }

    if (data.includes('\x1b[?')) {
      if (data.includes('\x1b[?1049h') || data.includes('\x1b[?47h')) session.altScreen = true;
      if (data.includes('\x1b[?1049l') || data.includes('\x1b[?47l')) session.altScreen = false;
    }

    if (!session._suppressBuffer) {
      session.outputBuffer.push(data);
      session.outputBufferSize += data.length;
      while (session.outputBufferSize > MAX_BUFFER_SIZE && session.outputBuffer.length > 1)
        session.outputBufferSize -= session.outputBuffer.shift().length;
    }

    broadcast('terminal-data', currentId, data);
  });

  ptyProcess.onExit(({ exitCode }) => {
    session.exited = true;
    const mcpId = session.realSessionId || sessionId;
    shutdownMcpServer(mcpId);
    session.mcpServer = null;
    const realId = session.realSessionId || sessionId;
    broadcast('process-exited', realId, exitCode);
    if (realId !== sessionId && activeSessions.has(sessionId)) broadcast('process-exited', sessionId, exitCode);
    activeSessions.delete(realId);
    activeSessions.delete(sessionId);
  });

  return { ok: true, reattached: false, mcpActive: !!mcpServer };
}

// ── HTTP request handler ──────────────────────────────────────────────

async function handleRequest(req, res) {
  const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = u.pathname;

  // Auth check — skip for root page so browsers can display a login error
  if (pathname !== '/' && !pathname.startsWith('/node_modules/') && !isAuthorized(req)) {
    // Allow unauthenticated load of the app shell so the UI can prompt for token
    const isPublicAsset = pathname.startsWith('/public/') || ['.js', '.css', '.png', '.ico', '.svg', '.woff', '.woff2'].some(e => pathname.endsWith(e));
    if (!isPublicAsset) {
      res.writeHead(401, { 'WWW-Authenticate': 'Bearer realm="Switchboard"', 'Content-Type': 'text/plain' });
      res.end('Unauthorized');
      return;
    }
  }

  // ── Static files ──
  if (pathname === '/' || pathname === '/index.html') {
    return serveStatic(res, path.join(PUBLIC_DIR, 'index.html'));
  }
  if (pathname.startsWith('/node_modules/')) {
    return serveStatic(res, path.join(__dirname, pathname));
  }
  const localFile = path.join(PUBLIC_DIR, pathname.replace(/^\//, ''));
  if (!pathname.startsWith('/api/') && fs.existsSync(localFile) && fs.statSync(localFile).isFile()) {
    return serveStatic(res, localFile);
  }

  // ── API ──
  if (pathname === '/api/invoke' && req.method === 'POST') {
    let body = '';
    req.on('data', d => { body += d; });
    req.on('end', async () => {
      let parsed;
      try { parsed = JSON.parse(body); } catch {
        res.writeHead(400); res.end('Bad JSON'); return;
      }
      const { channel, args = [] } = parsed;
      let result;
      try {
        result = await dispatch(channel, args);
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    });
    return;
  }

  res.writeHead(404);
  res.end('Not found');
}

async function dispatch(channel, args) {
  switch (channel) {
    case 'get-projects':           return handleGetProjects(args[0]);
    case 'get-plans':              return handleGetPlans();
    case 'read-plan':              return handleReadPlan(args[0]);
    case 'save-plan':              return handleSavePlan(args[0], args[1]);
    case 'get-stats':              return handleGetStats();
    case 'refresh-stats':          return handleRefreshStats();
    case 'get-usage':              return handleGetUsage();
    case 'get-memories':           return handleGetMemories();
    case 'read-memory':            return handleReadMemory(args[0]);
    case 'save-memory':            return handleSaveMemory(args[0], args[1]);
    case 'add-project':            return handleAddProject(args[0]);
    case 'remove-project':         return handleRemoveProject(args[0]);
    case 'search':                 return handleSearch(args[0], args[1], args[2]);
    case 'get-active-sessions':    return handleGetActiveSessions();
    case 'get-active-terminals':   return handleGetActiveTerminals();
    case 'stop-session':           return handleStopSession(args[0]);
    case 'toggle-star':            return handleToggleStar(args[0]);
    case 'rename-session':         return handleRenameSession(args[0], args[1]);
    case 'archive-session':        return handleArchiveSession(args[0], args[1]);
    case 'read-session-jsonl':     return handleReadSessionJsonl(args[0]);
    case 'get-setting':            return handleGetSetting(args[0]);
    case 'set-setting':            return handleSetSetting(args[0], args[1]);
    case 'delete-setting':         return handleDeleteSetting(args[0]);
    case 'get-shell-profiles':     return handleGetShellProfiles();
    case 'get-effective-settings': return handleGetEffectiveSettings(args[0]);
    case 'read-file-for-panel':    return handleReadFileForPanel(args[0]);
    case 'save-file-for-panel':    return handleSaveFileForPanel(args[0], args[1]);
    case 'watch-file':             return handleWatchFile(args[0]);
    case 'unwatch-file':           return handleUnwatchFile(args[0]);
    case 'open-terminal':          return handleOpenTerminal(args[0], args[1], args[2], args[3]);
    case 'browse-folder':          return null; // no native dialog in web mode
    case 'open-external':          return null; // browser handles this natively
    case 'get-app-version': {
      try { return require('./package.json').version; } catch { return '0.0.0'; }
    }
    case 'updater-check':    return { available: false, web: true };
    case 'updater-download': return null;
    case 'updater-install':  return null;
    default: throw new Error(`Unknown channel: ${channel}`);
  }
}

// ── Projects watcher ─────────────────────────────────────────────────

function startProjectsWatcher() {
  if (!fs.existsSync(PROJECTS_DIR)) return;
  const pending = new Set();
  let timer = null;
  function flush() {
    timer = null;
    const folders = new Set(pending); pending.clear();
    let changed = false;
    for (const folder of folders) {
      const fp = path.join(PROJECTS_DIR, folder);
      if (fs.existsSync(fp)) { detectSessionTransitions(folder); refreshFolder(folder); }
      else deleteCachedFolder(folder);
      changed = true;
    }
    if (changed) notifyRendererProjectsChanged();
  }
  try {
    const watcher = fs.watch(PROJECTS_DIR, { recursive: true }, (_type, filename) => {
      if (!filename) return;
      const parts = filename.split(path.sep);
      const folder = parts[0];
      if (!folder || folder === '.git') return;
      const basename = parts[parts.length - 1];
      if (parts.length === 1 || basename.endsWith('.jsonl')) {
        pending.add(folder);
        if (timer) clearTimeout(timer);
        timer = setTimeout(flush, 500);
      }
    });
    watcher.on('error', err => log.error('Projects watcher error:', err));
  } catch (err) { log.error('Failed to start projects watcher:', err); }
}

// ── Start ─────────────────────────────────────────────────────────────

function start() {
  if (searchFtsRecreated) populateCacheViaWorker();
  cleanStaleLockFiles && cleanStaleLockFiles();
  startProjectsWatcher();

  const server = http.createServer(handleRequest);

  // WebSocket server on same HTTP server
  const wss = new WebSocketServer({ server });

  wss.on('connection', (ws, req) => {
    // Auth check for WS (token in query string)
    try {
      const u = new URL(req.url, `http://${req.headers.host}`);
      if (u.searchParams.get('token') !== TOKEN) { ws.close(4001, 'Unauthorized'); return; }
    } catch { ws.close(4001, 'Unauthorized'); return; }

    wsClients.add(ws);

    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }

      switch (msg.type) {
        case 'terminal-input': {
          const s = activeSessions.get(msg.sessionId);
          if (s && !s.exited) s.pty.write(msg.data);
          break;
        }
        case 'terminal-resize': {
          const s = activeSessions.get(msg.sessionId);
          if (s && !s.exited) {
            if (s.isPlainTerminal) s._suppressBuffer = true;
            s.pty.resize(msg.cols, msg.rows);
            if (s.isPlainTerminal) setTimeout(() => { s._suppressBuffer = false; }, 200);
            if (s.firstResize && !s.isPlainTerminal) {
              s.firstResize = false;
              setTimeout(() => {
                try { s.pty.resize(msg.cols + 1, msg.rows); setTimeout(() => { try { s.pty.resize(msg.cols, msg.rows); } catch {} }, 50); } catch {}
              }, 50);
            }
          }
          break;
        }
        case 'close-terminal': {
          const s = activeSessions.get(msg.sessionId);
          if (s) { s.rendererAttached = false; if (s.exited) activeSessions.delete(msg.sessionId); }
          break;
        }
        case 'mcp-diff-response': {
          resolvePendingDiff(msg.sessionId, msg.diffId, msg.action, msg.editedContent);
          break;
        }
      }
    });

    ws.on('close', () => wsClients.delete(ws));
    ws.on('error', () => wsClients.delete(ws));
  });

  server.listen(PORT, HOST, () => {
    console.log('');
    console.log('  Switchboard web server running');
    console.log(`  URL:   http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
    console.log(`  Token: ${TOKEN}`);
    console.log('');
    console.log('  Open the URL in your browser. When prompted, enter the token above.');
    console.log('  Or append ?token=<token> to the URL to authenticate automatically.');
    console.log('');
  });

  process.on('SIGINT',  () => shutdown());
  process.on('SIGTERM', () => shutdown());

  function shutdown() {
    shutdownAllMcp();
    for (const [, s] of activeSessions) { if (!s.exited) try { s.pty.kill(); } catch {} }
    for (const w of fileWatchers.values()) w.close();
    closeDb();
    server.close(() => process.exit(0));
  }
}

start();
