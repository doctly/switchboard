const { app, BrowserWindow, dialog, ipcMain, Menu, screen, shell } = require('electron');
const { Worker } = require('worker_threads');
const path = require('path');
const fs = require('fs');
const os = require('os');
const pty = require('node-pty');
const log = require('electron-log');
// getFolderIndexMtimeMs moved to session-cache.js
const { startMcpServer, shutdownMcpServer, shutdownAll: shutdownAllMcp, resolvePendingDiff, rekeyMcpServer, cleanStaleLockFiles } = require('./mcp-bridge');
const { fetchAndTransformUsage } = require('./claude-auth');
log.transports.file.level = app.isPackaged ? 'info' : 'debug';
log.transports.console.level = app.isPackaged ? 'info' : 'debug';

try { require('electron-reloader')(module, { watchRenderer: true }); } catch {};

// Clean env for child processes — strip Electron internals that cause nested
// Electron apps (or node-pty inside them) to malfunction.
const cleanPtyEnv = Object.fromEntries(
  Object.entries(process.env).filter(([k]) =>
    !k.startsWith('ELECTRON_') &&
    !k.startsWith('GOOGLE_API_KEY') &&
    k !== 'NODE_OPTIONS' &&
    k !== 'ORIGINAL_XDG_CURRENT_DESKTOP' &&
    k !== 'WT_SESSION'
  )
);

// Shell profiles → shell-profiles.js
const { discoverShellProfiles, getShellProfiles, resolveShell, isWindows, isWslShell, windowsToWslPath, shellArgs, isSshProfile } = require('./shell-profiles');
const remoteHosts = require('./remote-hosts');
const remoteIndex = require('./remote-index');
const remoteIde = require('./remote-ide');
const { startScheduler } = require('./schedule-runner');
const { encodeProjectPath } = require('./encode-project-path');



// --- Auto-updater (only in packaged builds) ---
let autoUpdater = null;
if (app.isPackaged || process.env.FORCE_UPDATER) {
  autoUpdater = require('electron-updater').autoUpdater;
  autoUpdater.logger = log;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  if (!app.isPackaged) autoUpdater.forceDevUpdateConfig = true;

  function sendUpdaterEvent(type, data) {
    log.info(`[updater] ${type}`, data || '');
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('updater-event', type, data);
    }
  }
  autoUpdater.on('checking-for-update', () => sendUpdaterEvent('checking'));
  autoUpdater.on('update-available', (info) => sendUpdaterEvent('update-available', info));
  autoUpdater.on('update-not-available', (info) => sendUpdaterEvent('update-not-available', info));
  autoUpdater.on('download-progress', (progress) => sendUpdaterEvent('download-progress', progress));
  autoUpdater.on('update-downloaded', (info) => sendUpdaterEvent('update-downloaded', info));
  autoUpdater.on('error', (err) => {
    log.error('[updater] Error:', err?.message || String(err));
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('updater-event', 'error', { message: err?.message || String(err) });
    }
  });
}
const {
  getMeta, getAllMeta, toggleStar, setName, setArchived,
  isCachePopulated, getAllCached, getCachedByFolder, getCachedBySource, getCachedFolder, getCachedSession, upsertCachedSessions,
  deleteCachedSession, deleteCachedFolder, deleteRemoteProjectCache, deleteRemoteProjectCacheByPath,
  getFolderMeta, getAllFolderMeta, setFolderMeta,
  upsertSearchEntries, updateSearchTitle, deleteSearchSession, deleteSearchFolder, deleteSearchType,
  searchByType, isSearchIndexPopulated, searchFtsRecreated,
  getSetting, setSetting, deleteSetting,
  closeDb,
} = require('./db');

const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');
const PLANS_DIR = path.join(os.homedir(), '.claude', 'plans');
const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const STATS_CACHE_PATH = path.join(CLAUDE_DIR, 'stats-cache.json');
const MAX_BUFFER_SIZE = 256 * 1024;

// Active PTY sessions
const activeSessions = new Map();
let mainWindow = null;

function createWindow() {
  // Restore saved window bounds
  const savedBounds = getSetting('global')?.windowBounds;
  let bounds = { width: 1400, height: 900 };

  let restorePosition = null;
  if (savedBounds && savedBounds.width && savedBounds.height) {
    bounds.width = savedBounds.width;
    bounds.height = savedBounds.height;

    // Only restore position if it's on a visible display
    if (savedBounds.x != null && savedBounds.y != null) {
      const displays = screen.getAllDisplays();
      const onScreen = displays.some(d => {
        const b = d.bounds;
        return savedBounds.x >= b.x - 100 && savedBounds.x < b.x + b.width &&
               savedBounds.y >= b.y - 100 && savedBounds.y < b.y + b.height;
      });
      if (onScreen) {
        restorePosition = { x: savedBounds.x, y: savedBounds.y };
      }
    }
  }

  mainWindow = new BrowserWindow({
    ...bounds,
    minWidth: 800,
    minHeight: 500,
    title: 'Switchboard',
    icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  // Set position after creation to prevent macOS from clamping size
  if (restorePosition) {
    mainWindow.setBounds({ ...restorePosition, width: bounds.width, height: bounds.height });
  }

  mainWindow.loadFile(path.join(__dirname, 'public', 'index.html'));

  // Open external links in the system browser instead of a child BrowserWindow
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url).catch(() => {});
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (url !== mainWindow.webContents.getURL()) {
      event.preventDefault();
      if (/^https?:\/\//i.test(url)) shell.openExternal(url).catch(() => {});
    }
  });
  // Override window.open so xterm WebLinksAddon's default handler (which does
  // window.open() then sets location.href) routes through our IPC instead of
  // creating a child BrowserWindow.
  mainWindow.webContents.on('did-finish-load', () => {
    mainWindow.webContents.executeJavaScript(`
      window.open = function(url) {
        if (url && /^https?:\\/\\//i.test(url)) { window.api.openExternal(url); return null; }
        const proxy = {};
        Object.defineProperty(proxy, 'location', { get() {
          const loc = {};
          Object.defineProperty(loc, 'href', {
            set(u) { if (/^https?:\\/\\//i.test(u)) window.api.openExternal(u); }
          });
          return loc;
        }});
        return proxy;
      };
      void 0;
    `);
  });

  // Prevent Cmd+R / Ctrl+Shift+R from reloading the page (Chromium built-in).
  // Ctrl+R alone on macOS is NOT a reload shortcut and must pass through to xterm
  // for reverse-i-search.
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    const key = input.key.toLowerCase();
    if (key === 'r' && input.meta) event.preventDefault();
    if (key === 'r' && input.control && input.shift) event.preventDefault();
  });

  // Save window bounds on move/resize (debounced)
  let boundsTimer = null;
  const saveBounds = () => {
    if (boundsTimer) clearTimeout(boundsTimer);
    boundsTimer = setTimeout(() => {
      if (!mainWindow || mainWindow.isDestroyed() || mainWindow.isMinimized()) return;
      const b = mainWindow.getBounds();
      const global = getSetting('global') || {};
      global.windowBounds = { x: b.x, y: b.y, width: b.width, height: b.height };
      setSetting('global', global);
    }, 500);
  };
  mainWindow.on('resize', saveBounds);
  mainWindow.on('move', saveBounds);

  // Also save immediately before close (debounce may not have flushed)
  mainWindow.on('close', () => {
    if (boundsTimer) clearTimeout(boundsTimer);
    if (!mainWindow.isMinimized()) {
      const b = mainWindow.getBounds();
      const global = getSetting('global') || {};
      global.windowBounds = { x: b.x, y: b.y, width: b.width, height: b.height };
      setSetting('global', global);
    }
  });

  mainWindow.on('closed', () => {
    // On macOS the app stays alive in the dock after the last window closes.
    // Kill all running PTY processes so orphaned `claude` processes don't
    // accumulate in the background with no way for the user to interact.
    for (const [id, session] of activeSessions) {
      if (!session.exited) {
        try { session.pty.kill(); } catch {}
      }
      activeSessions.delete(id);
    }
    mainWindow = null;
  });
}

function buildMenu() {
  const template = [
    {
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// --- Session cache helpers ---

const { deriveProjectPath } = require('./derive-project-path');

// Session cache → session-cache.js
const sessionCache = require('./session-cache');
sessionCache.init({
  PROJECTS_DIR,
  activeSessions,
  getMainWindow: () => mainWindow,
  log,
  db: {
    deleteCachedFolder, getCachedByFolder, upsertCachedSessions, deleteCachedSession,
    deleteSearchFolder, deleteSearchSession, upsertSearchEntries,
    setFolderMeta, getAllFolderMeta, getAllMeta, getAllCached, getSetting, getMeta, setName,
  },
});
const { readSessionFile, readFolderFromFilesystem, refreshFolder, populateCacheFromFilesystem,
        buildProjectsFromCache, notifyRendererProjectsChanged, sendStatus, populateCacheViaWorker } = sessionCache;


// --- IPC: browse-folder ---
ipcMain.handle('browse-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory', 'createDirectory'],
    title: 'Select Project Folder',
  });
  if (result.canceled || !result.filePaths.length) return null;
  return result.filePaths[0];
});

// --- IPC: add-project ---
ipcMain.handle('add-project', (_event, projectPath) => {
  try {
    // Validate the path exists and is a directory
    const stat = fs.statSync(projectPath);
    if (!stat.isDirectory()) return { error: 'Path is not a directory' };

    // Unhide if previously hidden
    const global = getSetting('global') || {};
    if (global.hiddenProjects && global.hiddenProjects.includes(projectPath)) {
      global.hiddenProjects = global.hiddenProjects.filter(p => p !== projectPath);
      setSetting('global', global);
    }

    // Create the corresponding folder in ~/.claude/projects/ so it persists
    const folder = encodeProjectPath(projectPath);
    const folderPath = path.join(PROJECTS_DIR, folder);
    if (!fs.existsSync(folderPath)) {
      fs.mkdirSync(folderPath, { recursive: true });
    }

    // Seed a minimal .jsonl so deriveProjectPath can read the cwd
    if (!fs.readdirSync(folderPath).some(f => f.endsWith('.jsonl'))) {
      const seedId = require('crypto').randomUUID();
      const seedFile = path.join(folderPath, seedId + '.jsonl');
      const now = new Date().toISOString();
      const line = JSON.stringify({ type: 'user', cwd: projectPath, sessionId: seedId, uuid: require('crypto').randomUUID(), timestamp: now, message: { role: 'user', content: 'New project' } });
      fs.writeFileSync(seedFile, line + '\n');
    }

    // Immediately index the new folder so it's in cache before frontend renders
    refreshFolder(folder);
    notifyRendererProjectsChanged();

    return { ok: true, folder, projectPath };
  } catch (err) {
    return { error: err.message };
  }
});

// --- IPC: remove-project ---
ipcMain.handle('remove-project', (_event, projectPath) => {
  try {
    // Remote projects live in settings only (no local .claude/projects folder).
    if (typeof projectPath === 'string' && projectPath.startsWith('ssh://')) {
      const global = getSetting('global') || {};
      global.remoteProjects = (global.remoteProjects || []).filter(p => p.projectPath !== projectPath);
      // Auto-discovered remote groups aren't in remoteProjects, so also hide the
      // path (a re-sync would otherwise re-surface it) and drop its indexed rows.
      const hidden = global.hiddenProjects || [];
      if (!hidden.includes(projectPath)) hidden.push(projectPath);
      global.hiddenProjects = hidden;
      setSetting('global', global);
      deleteSetting('project:' + projectPath);
      try { deleteRemoteProjectCacheByPath(projectPath); } catch {}
      notifyRendererProjectsChanged();
      return { ok: true };
    }
    // Add to hidden projects list
    const global = getSetting('global') || {};
    const hidden = global.hiddenProjects || [];
    if (!hidden.includes(projectPath)) hidden.push(projectPath);
    global.hiddenProjects = hidden;
    setSetting('global', global);

    // Clean up DB cache and search index for this folder
    const folder = encodeProjectPath(projectPath);
    deleteCachedFolder(folder);
    deleteSearchFolder(folder);
    deleteSetting('project:' + projectPath);

    notifyRendererProjectsChanged();
    return { ok: true };
  } catch (err) {
    return { error: err.message };
  }
});

// --- IPC: get-projects ---
ipcMain.handle('open-external', (_event, url) => {
  log.info('[open-external IPC]', url);
  if (/^https?:\/\//i.test(url)) return shell.openExternal(url);
});

// --- IPC: MCP bridge ---
ipcMain.on('mcp-diff-response', (_event, sessionId, diffId, action, editedContent) => {
  resolvePendingDiff(sessionId, diffId, action, editedContent);
});

ipcMain.handle('read-file-for-panel', async (_event, filePath) => {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    return { ok: true, content };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('save-file-for-panel', async (_event, filePath, content) => {
  try {
    const resolved = path.resolve(filePath);
    if (!fs.existsSync(resolved)) return { ok: false, error: 'File does not exist' };
    fs.writeFileSync(resolved, content, 'utf8');
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// ── File Watching (for viewer panels) ────────────────────────────────
const fileWatchers = new Map(); // filePath → FSWatcher

ipcMain.handle('watch-file', (_event, filePath) => {
  const resolved = path.resolve(filePath);
  if (fileWatchers.has(resolved)) return { ok: true };
  try {
    let debounce = null;
    const watcher = fs.watch(resolved, (eventType) => {
      if (eventType !== 'change') return;
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(() => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('file-changed', resolved);
        }
      }, 300);
    });
    fileWatchers.set(resolved, watcher);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('unwatch-file', (_event, filePath) => {
  const resolved = path.resolve(filePath);
  const watcher = fileWatchers.get(resolved);
  if (watcher) {
    watcher.close();
    fileWatchers.delete(resolved);
  }
  return { ok: true };
});

ipcMain.handle('get-projects', (_event, showArchived) => {
  try {
    const needsPopulate = !isCachePopulated() || !isSearchIndexPopulated();

    if (needsPopulate) {
      populateCacheViaWorker();
      return [];
    }

    return buildProjectsFromCache(showArchived);
  } catch (err) {
    console.error('Error listing projects:', err);
    return [];
  }
});

// --- IPC: get-plans ---
ipcMain.handle('get-plans', () => {
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
          ? firstLine.slice(2).trim()
          : file.replace(/\.md$/, '');
        plans.push({ filename: file, title, modified: stat.mtime.toISOString() });
      } catch {}
    }
    plans.sort((a, b) => new Date(b.modified) - new Date(a.modified));

    // Index plans for FTS
    try {
      deleteSearchType('plan');
      upsertSearchEntries(plans.map(p => ({
        id: p.filename, type: 'plan', folder: null,
        title: p.title,
        body: fs.readFileSync(path.join(PLANS_DIR, p.filename), 'utf8'),
      })));
    } catch {}

    return plans;
  } catch (err) {
    console.error('Error reading plans:', err);
    return [];
  }
});

// --- IPC: read-plan ---
ipcMain.handle('read-plan', (_event, filename) => {
  try {
    const filePath = path.join(PLANS_DIR, path.basename(filename));
    const content = fs.readFileSync(filePath, 'utf8');
    return { content, filePath };
  } catch (err) {
    console.error('Error reading plan:', err);
    return { content: '', filePath: '' };
  }
});

// --- IPC: save-plan ---
ipcMain.handle('save-plan', (_event, filePath, content) => {
  try {
    const resolved = path.resolve(filePath);
    if (!resolved.startsWith(PLANS_DIR)) {
      return { ok: false, error: 'path outside plans directory' };
    }
    fs.writeFileSync(resolved, content, 'utf8');
    return { ok: true };
  } catch (err) {
    console.error('Error saving plan:', err);
    return { ok: false, error: err.message };
  }
});

// --- IPC: get-stats ---
ipcMain.handle('get-stats', () => {
  try {
    if (!fs.existsSync(STATS_CACHE_PATH)) return null;
    const raw = fs.readFileSync(STATS_CACHE_PATH, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    console.error('Error reading stats cache:', err);
    return null;
  }
});

// --- IPC: refresh-stats (run /stats + /usage via PTY) ---
ipcMain.handle('refresh-stats', async () => {
  // For stats, use the configured shell profile
  const globalSettings = getSetting('global') || {};
  const statsProfileId = globalSettings.shellProfile || SETTING_DEFAULTS.shellProfile;
  const statsShellProfile = resolveShell(statsProfileId);
  const statsShell = statsShellProfile.path;
  const statsShellExtraArgs = statsShellProfile.args || [];
  const ptyEnv = {
    ...cleanPtyEnv,
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    TERM_PROGRAM: 'iTerm.app',
    TERM_PROGRAM_VERSION: '3.6.6',
    FORCE_COLOR: '3',
    ITERM_SESSION_ID: '1',
  };

  // Helper: spawn claude with args, collect output, auto-accept trust, kill when idle
  // waitFor: optional regex tested against stripped output — finish only when matched
  function runClaude(args, { timeoutMs = 15000, waitFor = null } = {}) {
    return new Promise((resolve) => {
      let output = '';
      let settled = false;
      let trustAccepted = false;
      // Track idle: ✳ in OSC title means Claude is idle and waiting for input
      let sawActivity = false;

      const finish = () => {
        if (settled) return;
        settled = true;
        try { p.kill(); } catch {}
        resolve(output);
      };

      const claudeCmd = `claude ${args}`;
      const p = pty.spawn(statsShell, shellArgs(statsShell, claudeCmd, statsShellExtraArgs), {
        name: 'xterm-256color',
        cols: 120,
        rows: 40,
        cwd: os.homedir(),
        env: ptyEnv,
      });

      const strip = (s) => s
        .replace(/\x1b\[[^@-~]*[@-~]/g, '')
        .replace(/\x1b\][^\x07]*\x07/g, '')
        .replace(/\x1b[^[\]].?/g, '');

      p.onData((data) => {
        output += data;

        // Auto-accept trust directory prompt (Enter selects "1. Yes")
        if (!trustAccepted) {
          if (/trust\s*this\s*folder/i.test(strip(output))) {
            trustAccepted = true;
            try { p.write('\r'); } catch {}
            return;
          }
        }

        // If waitFor is set, finish when that pattern appears in stripped output
        if (waitFor) {
          if (waitFor.test(strip(output))) {
            finish();
          }
          return;
        }

        // Default: detect busy→idle transition via OSC title containing ✳
        if (!sawActivity) {
          const oscTitle = data.match(/\x1b\]0;([^\x07\x1b]*)/);
          if (oscTitle) {
            const first = oscTitle[1].charAt(0);
            if (first.charCodeAt(0) >= 0x2800 && first.charCodeAt(0) <= 0x28FF) {
              sawActivity = true;
            }
          }
        } else if (data.includes('\u2733')) {
          finish();
        }
      });

      p.onExit(() => finish());
      setTimeout(finish, timeoutMs);
    });
  }

  try {
    // Run /stats via PTY (for heatmap/chart data) and fetch usage via API in parallel
    const [, usage] = await Promise.all([
      runClaude('"/stats"', { waitFor: /streak/i, timeoutMs: 10000 }),
      fetchAndTransformUsage().catch(() => ({})),
    ]);

    // Read refreshed stats cache
    let stats = null;
    try {
      if (fs.existsSync(STATS_CACHE_PATH)) {
        stats = JSON.parse(fs.readFileSync(STATS_CACHE_PATH, 'utf8'));
      }
    } catch {}

    return { stats, usage: usage || {} };
  } catch (err) {
    log.error('Error refreshing stats:', err);
    return { stats: null, usage: {} };
  }
});

// --- IPC: get-usage (lightweight, API-only, no PTY) ---
ipcMain.handle('get-usage', async () => {
  try {
    return await fetchAndTransformUsage() || {};
  } catch (err) {
    log.error('Error fetching usage:', err);
    return {};
  }
});

// --- IPC: get-memories ---
function folderToShortPath(folder) {
  // Convert "-Users-home-dev-MyClaude" → "dev/MyClaude"
  const parts = folder.replace(/^-/, '').split('-');
  const meaningful = parts.filter(Boolean);
  return meaningful.slice(-2).join('/');
}

/** Scan a directory for .md files (non-recursive). Returns array of { filename, filePath, modified }. */
function scanMdFiles(dir) {
  const results = [];
  try {
    if (!fs.existsSync(dir)) return results;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const e of entries) {
      if (e.isFile() && e.name.endsWith('.md')) {
        const fp = path.join(dir, e.name);
        const content = fs.readFileSync(fp, 'utf8').trim();
        if (content) {
          const stat = fs.statSync(fp);
          results.push({ filename: e.name, filePath: fp, modified: stat.mtime.toISOString() });
        }
      }
    }
  } catch {}
  return results;
}

ipcMain.handle('get-memories', () => {
  const global = getSetting('global') || {};
  const hiddenProjects = new Set(global.hiddenProjects || []);

  // --- Global files ---
  const globalFiles = scanMdFiles(CLAUDE_DIR).map(f => ({ ...f, displayPath: '~/.claude' }));

  // --- Per-project files ---
  const projects = [];
  try {
    if (fs.existsSync(PROJECTS_DIR)) {
      const folders = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true })
        .filter(d => d.isDirectory() && d.name !== '.git')
        .map(d => d.name);

      for (const folder of folders) {
        const folderPath = path.join(PROJECTS_DIR, folder);
        const projectPath = deriveProjectPath(folderPath, folder);
        if (projectPath && hiddenProjects.has(projectPath)) continue;

        // Use same 2-deep short path as Sessions tab (e.g. "dev/MyClaude")
        const shortName = projectPath
          ? projectPath.split('/').filter(Boolean).slice(-2).join('/')
          : folderToShortPath(folder);
        const files = [];
        const seenPaths = new Set();

        // 1. ~/.claude/projects/{folder}/ — claude-home .md files
        const claudeHomeFiles = scanMdFiles(folderPath);
        for (const f of claudeHomeFiles) {
          files.push({ ...f, displayPath: '~/.claude', source: 'claude-home' });
          seenPaths.add(f.filePath);
        }
        // memory/MEMORY.md
        const memoryDir = path.join(folderPath, 'memory');
        const memoryFiles = scanMdFiles(memoryDir);
        for (const f of memoryFiles) {
          files.push({ ...f, displayPath: '~/.claude', source: 'claude-home' });
          seenPaths.add(f.filePath);
        }

        // 2. {projectPath}/ — project root CLAUDE.md, agents.md
        if (projectPath) {
          for (const name of ['CLAUDE.md', 'GEMINI.md', 'agents.md']) {
            const fp = path.join(projectPath, name);
            try {
              if (fs.existsSync(fp)) {
                const content = fs.readFileSync(fp, 'utf8').trim();
                if (content && !seenPaths.has(fp)) {
                  const stat = fs.statSync(fp);
                  files.push({ filename: name, filePath: fp, modified: stat.mtime.toISOString(), displayPath: shortName + '/', source: 'project' });
                  seenPaths.add(fp);
                }
              }
            } catch {}
          }

          // 3. {projectPath}/.claude/ — commands/*.md and other .md files
          const dotClaudeDir = path.join(projectPath, '.claude');
          const dotClaudeFiles = scanMdFiles(dotClaudeDir);
          for (const f of dotClaudeFiles) {
            if (!seenPaths.has(f.filePath)) {
              files.push({ ...f, displayPath: shortName + '/.claude/', source: 'project' });
              seenPaths.add(f.filePath);
            }
          }
          // commands/*.md
          const commandsDir = path.join(dotClaudeDir, 'commands');
          const commandFiles = scanMdFiles(commandsDir);
          for (const f of commandFiles) {
            if (!seenPaths.has(f.filePath)) {
              files.push({ ...f, displayPath: shortName + '/.claude/commands/', source: 'project' });
              seenPaths.add(f.filePath);
            }
          }
        }

        if (files.length > 0) {
          projects.push({ folder, projectPath: projectPath || '', shortName, files });
        }
      }
    }
  } catch (err) {
    console.error('Error scanning memories:', err);
  }

  // Sort projects by most recent file modified date
  projects.sort((a, b) => {
    const aMax = Math.max(...a.files.map(f => new Date(f.modified).getTime()));
    const bMax = Math.max(...b.files.map(f => new Date(f.modified).getTime()));
    return bMax - aMax;
  });

  const result = { global: { files: globalFiles }, projects };

  // Index all files for FTS
  try {
    deleteSearchType('memory');
    const allFiles = [
      ...globalFiles.map(f => ({ ...f, label: 'Global' })),
      ...projects.flatMap(p => p.files.map(f => ({ ...f, label: p.shortName }))),
    ];
    upsertSearchEntries(allFiles.map(f => ({
      id: f.filePath, type: 'memory', folder: null,
      title: f.label + ' ' + f.filename,
      body: fs.readFileSync(f.filePath, 'utf8'),
    })));
  } catch {}

  return result;
});

// --- IPC: read-memory ---
ipcMain.handle('read-memory', (_event, filePath) => {
  try {
    const resolved = path.resolve(filePath);
    // Allow paths under ~/.claude/ or any .md file that exists
    if (!resolved.endsWith('.md')) return '';
    if (!resolved.startsWith(CLAUDE_DIR) && !fs.existsSync(resolved)) return '';
    return fs.readFileSync(resolved, 'utf8');
  } catch (err) {
    console.error('Error reading memory file:', err);
    return '';
  }
});

// --- IPC: save-memory ---
ipcMain.handle('save-memory', (_event, filePath, content) => {
  try {
    const resolved = path.resolve(filePath);
    if (!resolved.endsWith('.md')) return { ok: false, error: 'not a .md file' };
    if (!fs.existsSync(resolved)) return { ok: false, error: 'file does not exist' };
    fs.writeFileSync(resolved, content, 'utf8');
    return { ok: true };
  } catch (err) {
    console.error('Error saving memory file:', err);
    return { ok: false, error: err.message };
  }
});

// --- IPC: search ---
ipcMain.handle('search', (_event, type, query, titleOnly) => {
  return searchByType(type, query, 50, !!titleOnly);
});

// --- IPC: settings ---
ipcMain.handle('get-setting', (_event, key) => {
  return getSetting(key);
});

ipcMain.handle('set-setting', (_event, key, value) => {
  setSetting(key, value);
  return { ok: true };
});

ipcMain.handle('delete-setting', (_event, key) => {
  deleteSetting(key);
  return { ok: true };
});

// --- IPC: remote SSH hosts (Phase 1) ---

// Merged list of remote targets: parsed from ~/.ssh/config plus user-defined
// manual hosts persisted in global settings under `remoteHosts`.
ipcMain.handle('get-remote-targets', () => {
  const manual = (getSetting('global') || {}).remoteHosts || [];
  return remoteHosts.loadRemoteHosts(manual);
});

// Persist the manual host list (config-derived hosts are never written back).
ipcMain.handle('save-remote-hosts', (_event, hosts) => {
  const global = getSetting('global') || {};
  const clean = (Array.isArray(hosts) ? hosts : [])
    .filter(h => h && h.host && String(h.host).trim())
    .map(h => ({
      id: h.id || undefined,
      label: (h.label || '').trim() || undefined,
      host: String(h.host).trim(),
      user: (h.user || '').trim() || undefined,
      port: h.port ? Number(h.port) : undefined,
      identityFile: (h.identityFile || '').trim() || undefined,
      options: h.options,
    }))
    .map(remoteHosts.normalizeManualHost);
  global.remoteHosts = clean;
  setSetting('global', global);
  return { ok: true, hosts: remoteHosts.loadRemoteHosts(clean) };
});

// Interactive Connect: authenticate/verify a host inline (not in the sidebar).
// Runs `ssh -tt <control> <target> true` in a PTY: after auth the trivial command
// exits (code 0 = connected) while ControlPersist keeps the connection warm for
// Browse/sessions. Prompts (password/passphrase/host key) are streamed to a small
// popup terminal in the renderer so the user answers there.
const _connectProcs = new Map();
let _connectSeq = 0;

ipcMain.handle('remote-connect-start', (_event, hostId) => {
  const manual = (getSetting('global') || {}).remoteHosts || [];
  const host = remoteHosts.findRemoteHost(hostId, manual);
  if (!host) return { error: 'unknown host' };
  const sock = remoteHosts.controlSocketPath(os.tmpdir(), host.id);
  const args = ['-tt', ...remoteHosts.controlArgs(sock), ...remoteHosts.hostTargetArgs(host), 'true'];
  const connectId = ++_connectSeq;
  let proc;
  try {
    proc = pty.spawn('ssh', args, { name: 'xterm-256color', cols: 80, rows: 16, cwd: os.homedir(), env: cleanPtyEnv });
  } catch (err) {
    return { error: err.message };
  }
  _connectProcs.set(connectId, proc);
  const send = (channel, ...a) => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, ...a); };
  proc.onData(d => send('remote-connect-data', connectId, d));
  proc.onExit(({ exitCode }) => {
    _connectProcs.delete(connectId);
    send('remote-connect-exit', connectId, exitCode);
  });
  return { connectId };
});

ipcMain.on('remote-connect-input', (_event, connectId, data) => {
  const proc = _connectProcs.get(connectId);
  if (proc) { try { proc.write(data); } catch {} }
});

ipcMain.handle('remote-connect-cancel', (_event, connectId) => {
  const proc = _connectProcs.get(connectId);
  if (proc) { try { proc.kill(); } catch {} }
  _connectProcs.delete(connectId);
  return { ok: true };
});

// Append a host as a proper ~/.ssh/config entry (append-only, backed up once,
// skips if an entry with that alias already exists).
ipcMain.handle('write-ssh-config', (_event, host) => {
  try {
    if (!host || !host.host) return { error: 'host is required' };
    const h = remoteHosts.normalizeManualHost(host);
    const cfgPath = remoteHosts.defaultSshConfigPath();
    const dir = path.dirname(cfgPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const existing = fs.existsSync(cfgPath) ? fs.readFileSync(cfgPath, 'utf8') : '';
    // Dedup: does a Host line already list this alias as a whole word?
    const aliasRe = new RegExp('^\\s*Host\\s+(.*\\s)?' + h.label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(\\s.*)?$', 'mi');
    if (aliasRe.test(existing)) return { error: `Host "${h.label}" already exists in ~/.ssh/config` };
    // One-time backup before the first Switchboard-written change.
    const bak = cfgPath + '.switchboard.bak';
    if (existing && !fs.existsSync(bak)) fs.writeFileSync(bak, existing, { mode: 0o600 });
    const block = (existing && !existing.endsWith('\n') ? '\n' : '') + '\n# added by Switchboard\n' + remoteHosts.buildSshConfigEntry(h) + '\n';
    fs.appendFileSync(cfgPath, block, { mode: 0o600 });
    notifyRendererProjectsChanged();
    return { ok: true, path: cfgPath, label: h.label };
  } catch (err) {
    return { error: err.message };
  }
});

// Non-interactive connectivity probe (key/agent auth only; never prompts).
ipcMain.handle('test-remote-host', (_event, hostId) => {
  const manual = (getSetting('global') || {}).remoteHosts || [];
  const host = remoteHosts.findRemoteHost(hostId, manual);
  if (!host) return Promise.resolve({ ok: false, error: 'unknown host' });
  return new Promise((resolve) => {
    let out = '';
    let done = false;
    const finish = (result) => { if (!done) { done = true; resolve(result); } };
    let proc;
    try {
      proc = pty.spawn('ssh', remoteHosts.testConnectionArgs(host), {
        name: 'xterm-256color', cols: 80, rows: 24, cwd: os.homedir(), env: cleanPtyEnv,
      });
    } catch (err) {
      return finish({ ok: false, error: err.message });
    }
    const killTimer = setTimeout(() => {
      try { proc.kill(); } catch {}
      finish({ ok: false, status: 'unreachable', reachable: false, message: 'Timed out', output: out.trim() });
    }, 15000);
    proc.onData(d => { out += d; if (out.length > 4000) out = out.slice(-4000); });
    proc.onExit(({ exitCode }) => {
      clearTimeout(killTimer);
      // BatchMode never prompts, so a password-auth host "fails" but is reachable.
      // Classify the output so the UI reports reachability honestly.
      const cls = remoteHosts.classifyConnResult(exitCode, out);
      finish({ ok: cls.reachable, exitCode, ...cls, output: out.trim() });
    });
  });
});

// --- IPC: remote projects (Model A — a project can be local or remote) ---

// Register a remote project (host + remote directory) that appears in the
// sidebar alongside local projects. Persisted in global settings.
ipcMain.handle('add-remote-project', (_event, { hostId, remotePath } = {}) => {
  try {
    const global = getSetting('global') || {};
    const manual = global.remoteHosts || [];
    const host = remoteHosts.findRemoteHost(hostId, manual);
    if (!host) return { error: 'unknown host' };
    const dir = (remotePath && String(remotePath).trim()) ? String(remotePath).trim() : '~';
    const projectPath = remoteHosts.remoteProjectPath(host.label, dir);
    const list = global.remoteProjects || [];
    if (!list.some(p => p.projectPath === projectPath)) {
      list.push({ projectPath, hostId: host.id, hostLabel: host.label, remotePath: dir });
      global.remoteProjects = list;
      setSetting('global', global);
    }
    notifyRendererProjectsChanged();
    return { ok: true, projectPath, hostId: host.id, hostLabel: host.label, remotePath: dir };
  } catch (err) {
    return { error: err.message };
  }
});

// List directories at a remote path (for the remote directory browser). Uses the
// shared control socket (BatchMode = never prompts). If the host needs interactive
// auth and has no live connection yet, this fails fast with needsAuth so the UI can
// tell the user to open a session first (which authenticates and persists the master).
ipcMain.handle('remote-browse', (_event, { hostId, path: remotePath } = {}) => {
  const manual = (getSetting('global') || {}).remoteHosts || [];
  const host = remoteHosts.findRemoteHost(hostId, manual);
  if (!host) return Promise.resolve({ ok: false, error: 'unknown host' });
  const dir = (remotePath && String(remotePath).trim()) ? String(remotePath).trim() : '~';
  const sock = remoteHosts.controlSocketPath(os.tmpdir(), host.id);
  const args = remoteHosts.browseArgs(host, sock, dir);
  return new Promise((resolve) => {
    let out = '', err = '', done = false;
    const finish = (r) => { if (!done) { done = true; resolve(r); } };
    let proc;
    try {
      proc = pty.spawn('ssh', args, { name: 'xterm-256color', cols: 80, rows: 24, cwd: os.homedir(), env: cleanPtyEnv });
    } catch (e) {
      return finish({ ok: false, error: e.message });
    }
    const killTimer = setTimeout(() => { try { proc.kill(); } catch {} finish({ ok: false, error: 'timed out', path: dir }); }, 12000);
    // pty merges stdout/stderr; classify on non-zero exit.
    proc.onData(d => { out += d; if (out.length > 20000) out = out.slice(-20000); });
    proc.onExit(({ exitCode }) => {
      clearTimeout(killTimer);
      if (exitCode === 0) {
        return finish({ ok: true, path: dir, dirs: remoteHosts.parseLsDirs(out) });
      }
      const cls = remoteHosts.classifyConnResult(exitCode, out);
      finish({ ok: false, path: dir, needsAuth: cls.reachable && cls.status !== 'unreachable', status: cls.status, message: cls.message, output: out.trim().slice(-500) });
    });
  });
});

// Index a connected host's past remote sessions (Phase 2). Reuses the live
// ControlMaster socket; transcripts are read over SSH and never copied to disk.
// Returns { ok, indexed, deleted } or { ok:false, needsAuth } when no live master.
// `quiet` suppresses the status-bar chatter (used by the silent startup sweep).
async function runRemoteSync(hostId, { quiet = false } = {}) {
  const global = getSetting('global') || {};
  const manual = global.remoteHosts || [];
  const host = remoteHosts.findRemoteHost(hostId, manual);
  if (!host) return { ok: false, error: 'unknown host' };
  const sock = remoteHosts.controlSocketPath(os.tmpdir(), host.id);
  const label = host.label || host.alias || host.id;
  if (!quiet) sendStatus('Syncing remote sessions from ' + label + '…', 'active');
  try {
    const res = await remoteIndex.syncRemoteHost({
      host, sock, hostLabel: label,
      db: { getCachedBySource, upsertCachedSessions, upsertSearchEntries, deleteCachedSession, deleteSearchSession, getMeta, setName },
    });
    log.info(`[remote-sync] host=${host.id} indexed=${res.indexed} deleted=${res.deleted}`);
    notifyRendererProjectsChanged();
    if (!quiet) {
      const msg = res.indexed > 0
        ? `Indexed ${res.indexed} remote session${res.indexed === 1 ? '' : 's'} from ${label}`
        : `No new remote sessions on ${label}`;
      sendStatus(msg, 'done');
      setTimeout(() => sendStatus(''), 4000);
    }
    return res;
  } catch (err) {
    const emsg = (err && err.message) || String(err);
    log.info(`[remote-sync] host=${host.id} FAILED: ${emsg}`);
    if (!quiet) {
      sendStatus(`Couldn't sync ${label} — connect to the host first.`, 'error');
      setTimeout(() => sendStatus(''), 5000);
    }
    return { ok: false, error: emsg, needsAuth: true };
  }
}

ipcMain.handle('sync-remote-host', async (_event, hostId) => {
  return runRemoteSync(hostId);
});

// On startup, silently try to index each registered remote host. Key/agent-auth
// hosts (or ones with a still-live ControlMaster) index without any prompt via
// BatchMode; password hosts fail fast and are simply skipped until the user
// connects. Runs in the background so it never blocks the UI.
function startupRemoteSync() {
  const global = getSetting('global') || {};
  // Every host the user has touched: registered remote projects + manual hosts.
  const ids = [...new Set([
    ...(global.remoteProjects || []).map((p) => p.hostId),
    ...(global.remoteHosts || []).map((h) => h.id),
  ].filter(Boolean))];
  for (const id of ids) {
    runRemoteSync(id, { quiet: true }).catch(() => {});
  }
}

// --- Scheduled tasks ---
const scheduleIpc = require('./schedule-ipc');

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
  // Phase 3: IDE integration for REMOTE sessions (reverse-forward the local IDE
  // over SSH). Off by default — it exposes the local IDE port on the remote host.
  remoteIde: false,
};

ipcMain.handle('get-shell-profiles', () => {
  _shellProfiles = null; // refresh on each request
  return getShellProfiles();
});

ipcMain.handle('get-effective-settings', (_event, projectPath) => {
  const global = getSetting('global') || {};
  const project = projectPath ? (getSetting('project:' + projectPath) || {}) : {};
  const effective = { ...SETTING_DEFAULTS };
  for (const key of Object.keys(SETTING_DEFAULTS)) {
    if (global[key] !== undefined && global[key] !== null) {
      effective[key] = global[key];
    }
    if (project[key] !== undefined && project[key] !== null) {
      effective[key] = project[key];
    }
  }
  return effective;
});

// --- IPC: get-active-sessions ---
ipcMain.handle('get-active-sessions', () => {
  const active = [];
  for (const [sessionId, session] of activeSessions) {
    if (!session.exited) active.push(sessionId);
  }
  return active;
});

// --- IPC: get-active-terminals --- (plain terminal sessions for renderer restore)
ipcMain.handle('get-active-terminals', () => {
  const terminals = [];
  for (const [sessionId, session] of activeSessions) {
    if (!session.exited && session.isPlainTerminal) {
      terminals.push({ sessionId, projectPath: session.projectPath });
    }
  }
  return terminals;
});

// --- IPC: stop-session ---
ipcMain.handle('stop-session', (_event, sessionId) => {
  const session = activeSessions.get(sessionId);
  if (!session || session.exited) return { ok: false, error: 'not running' };
  session.pty.kill();
  return { ok: true };
});

// --- IPC: toggle-star ---
ipcMain.handle('toggle-star', (_event, sessionId) => {
  const starred = toggleStar(sessionId);
  return { starred };
});

// --- IPC: rename-session ---
ipcMain.handle('rename-session', (_event, sessionId, name) => {
  setName(sessionId, name || null);
  // Update search index title to include the new name
  const cached = getCachedSession(sessionId);
  const summary = cached?.summary || '';
  updateSearchTitle(sessionId, 'session', (name ? name + ' ' : '') + summary);
  return { name: name || null };
});

// --- IPC: archive-session ---
ipcMain.handle('read-session-jsonl', async (_event, sessionId) => {
  const cached = getCachedSession(sessionId);
  // Remote (Phase 2): stream the transcript live over SSH — nothing is copied to disk.
  if (cached && cached.source) {
    const global = getSetting('global') || {};
    const manual = global.remoteHosts || [];
    const host = remoteHosts.findRemoteHost(cached.source, manual);
    if (!host) return { error: 'unknown remote host' };
    const sock = remoteHosts.controlSocketPath(os.tmpdir(), host.id);
    try {
      const entries = await remoteIndex.fetchRemoteSessionEntries({ host, sock, folder: cached.folder, sessionId });
      return { entries };
    } catch (err) {
      return { needsConnect: true, hostLabel: host.label || host.id };
    }
  }
  const folder = getCachedFolder(sessionId);
  if (!folder) return { error: 'Session not found in cache' };
  const jsonlPath = path.join(PROJECTS_DIR, folder, sessionId + '.jsonl');
  try {
    const content = fs.readFileSync(jsonlPath, 'utf-8');
    const entries = [];
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      try { entries.push(JSON.parse(line)); } catch {}
    }
    return { entries };
  } catch (err) {
    return { error: err.message };
  }
});

ipcMain.handle('archive-session', (_event, sessionId, archived) => {
  const val = archived ? 1 : 0;
  setArchived(sessionId, val);
  return { archived: val };
});

// Phase 3: set up IDE-over-SSH for a remote claude session. Starts the local IDE
// MCP server (with a reader that cats old-file content over SSH), brings up the
// control master, and reverse-forwards the local port to a free remote port.
// Returns { mcpServer, remotePort, sock } or null (IDE skipped — session still runs).
function setupRemoteIdeTunnel(sessionId, host, sock, remoteDir, mainWindow, log) {
  const cp = require('child_process');
  // Ensure the control master is live (creates it if needed) before -O forward.
  try {
    const probe = cp.spawnSync('ssh', remoteIndex.sshCmdArgs(host, sock, 'true'), { timeout: 9000 });
    if (probe.status !== 0) { log.info('[remote-ide] master probe failed — skipping IDE'); return Promise.resolve(null); }
  } catch (e) { log.info('[remote-ide] master probe error — skipping IDE: ' + e.message); return Promise.resolve(null); }

  // Old-file reader: cat the file on the remote host over the shared socket (sync;
  // used by openDiff/openFile which call it synchronously).
  const readOldFile = (p) => cp.execFileSync('ssh', remoteIde.remoteCatArgs(host, sock, p),
    { encoding: 'utf8', timeout: 12000, maxBuffer: 32 * 1024 * 1024 });

  return startMcpServer(sessionId, [remoteDir], mainWindow, log, { readOldFile }).then((mcpServer) => {
    for (let attempt = 0; attempt < 6; attempt++) {
      const remotePort = remoteIde.candidateRemotePort(mcpServer.port, attempt);
      const fwd = cp.spawnSync('ssh', remoteIde.reverseForwardArgs(host, sock, remotePort, mcpServer.port), { timeout: 9000 });
      if (fwd.status === 0) {
        log.info(`[remote-ide] session=${sessionId} tunnel remote:${remotePort} -> local:${mcpServer.port}`);
        return { mcpServer, remotePort, sock };
      }
    }
    log.info('[remote-ide] could not allocate a remote forward port — skipping IDE');
    try { shutdownMcpServer(sessionId); } catch {}
    return null;
  }).catch((e) => { log.info('[remote-ide] setup failed: ' + e.message); return null; });
}

// Tear down a remote IDE tunnel: cancel the reverse forward + remove the remote lock.
function teardownRemoteIdeTunnel(host, sock, remotePort, localPort, log) {
  const cp = require('child_process');
  try { cp.spawnSync('ssh', remoteIde.cancelForwardArgs(host, sock, remotePort, localPort), { timeout: 8000 }); } catch {}
  try { cp.spawnSync('ssh', remoteIde.remoteLockCleanupArgs(host, sock, remotePort), { timeout: 8000 }); } catch {}
}

// --- IPC: open-terminal ---
ipcMain.handle('open-terminal', async (_event, sessionId, projectPath, isNew, sessionOptions) => {
  if (!mainWindow) return { ok: false, error: 'no window' };

  // Reattach to existing session
  if (activeSessions.has(sessionId)) {
    const session = activeSessions.get(sessionId);
    session.rendererAttached = true;
    session.firstResize = !session.isPlainTerminal;

    // If TUI is in alternate screen mode, send escape to switch into it
    if (session.altScreen && !session.isPlainTerminal) {
      mainWindow.webContents.send('terminal-data', sessionId, '\x1b[?1049h');
    }

    // Send buffered output for reattach
    for (const chunk of session.outputBuffer) {
      mainWindow.webContents.send('terminal-data', sessionId, chunk);
    }

    if (!session.isPlainTerminal) {
      // Hide cursor after buffer replay — the live PTY stream or resize nudge
      // will re-show it at the correct position, avoiding a stale cursor artifact
      mainWindow.webContents.send('terminal-data', sessionId, '\x1b[?25l');
    }

    return { ok: true, reattached: true, mcpActive: !!session.mcpServer };
  }

  const isPlainTerminal = sessionOptions?.type === 'terminal';

  // Remote (SSH) session? Resolve the host + ssh profile up front so we can skip
  // local-filesystem checks below. Remote sessions run over `ssh` and their
  // project directory lives on the remote host, not locally.
  const remoteHostId = sessionOptions?.remoteHostId || null;
  let remoteHost = null;
  if (remoteHostId) {
    const manual = (getSetting('global') || {}).remoteHosts || [];
    remoteHost = remoteHosts.findRemoteHost(remoteHostId, manual);
    if (!remoteHost) return { ok: false, error: `unknown remote host: ${remoteHostId}` };
  }
  const isRemote = !!remoteHost;

  // Spawn new PTY. Local sessions require an existing project directory; remote
  // sessions do not (the directory is on the remote host).
  if (!isRemote && !fs.existsSync(projectPath)) {
    return { ok: false, error: `project directory no longer exists: ${projectPath}` };
  }

  // Resolve the shell to spawn.
  let shell, shellExtraArgs, isWsl;
  if (isRemote) {
    shell = 'ssh';
    // -t (PTY) + connection multiplexing (shared control socket) + target. The
    // control socket lets the directory browser reuse this authenticated
    // connection, so the user only authenticates once per host.
    const sock = remoteHosts.controlSocketPath(os.tmpdir(), remoteHost.id);
    shellExtraArgs = ['-t', ...remoteHosts.controlArgs(sock), ...remoteHosts.hostTargetArgs(remoteHost)];
    isWsl = false;
    log.info(`[shell] remote host=${remoteHost.id} shell=ssh args=${JSON.stringify(shellExtraArgs)}`);
  } else {
    // Resolve shell profile from effective settings
    const effectiveProfileId = (() => {
      const global = getSetting('global') || {};
      const project = projectPath ? (getSetting('project:' + projectPath) || {}) : {};
      let profileId = SETTING_DEFAULTS.shellProfile;
      if (global.shellProfile !== undefined && global.shellProfile !== null) profileId = global.shellProfile;
      if (project.shellProfile !== undefined && project.shellProfile !== null) profileId = project.shellProfile;
      return profileId;
    })();
    // WSL profiles only work for plain terminals — Claude CLI sessions need the
    // Windows shell because session data lives on the Windows filesystem.
    const requestedProfile = resolveShell(effectiveProfileId);
    const shellProfile = (isWslShell(requestedProfile.path) && !isPlainTerminal)
      ? resolveShell('auto')
      : requestedProfile;
    shell = shellProfile.path;
    shellExtraArgs = [...(shellProfile.args || [])];
    isWsl = isWslShell(shell);
    // For WSL, convert Windows path to /mnt/ path and pass via --cd;
    // the spawn cwd must remain a valid Windows path for wsl.exe itself.
    if (isWsl) {
      const wslCwd = windowsToWslPath(projectPath);
      shellExtraArgs.unshift('--cd', wslCwd);
    }
    log.info(`[shell] profile=${shellProfile.id} shell=${shell} args=${JSON.stringify(shellExtraArgs)}`);
  }

  let knownJsonlFiles = new Set();
  let sessionSlug = null;
  let projectFolder = null;

  if (!isPlainTerminal && !isRemote) {
    // Snapshot existing .jsonl files before spawning (for new session + fork/plan detection)
    projectFolder = encodeProjectPath(projectPath);
    const claudeProjectDir = path.join(PROJECTS_DIR, projectFolder);
    if (fs.existsSync(claudeProjectDir)) {
      try {
        knownJsonlFiles = new Set(
          fs.readdirSync(claudeProjectDir).filter(f => f.endsWith('.jsonl'))
        );
      } catch {}
    }

    // Read slug from the session's jsonl file (for plan-accept detection)
    if (!isNew) {
      try {
        const jsonlPath = path.join(claudeProjectDir, sessionId + '.jsonl');
        const head = fs.readFileSync(jsonlPath, 'utf8').slice(0, 8000);
        const firstLines = head.split('\n').filter(Boolean);
        for (const line of firstLines) {
          const entry = JSON.parse(line);
          if (entry.slug) { sessionSlug = entry.slug; break; }
        }
      } catch {}
    }
  }

  let ptyProcess;
  let mcpServer = null;
  let ideInfo = null; // Phase 3 remote-IDE tunnel info (outer scope for teardown)
  try {
    if (isRemote) {
      // Remote (SSH) session: run Claude (or a login shell) on the remote host.
      // No claude shim. IDE/MCP emulation is opt-in (Phase 3): when enabled we
      // reverse-forward the local IDE port so the remote CLI can reach it.
      const remoteMode = sessionOptions?.remoteMode === 'shell' ? 'shell' : 'claude';
      const remoteDir = sessionOptions?.remoteDir || '~';

      // Resolve the effective IDE-over-SSH setting: global default, overridden per
      // remote project (the gear on a remote project writes project:ssh://... ).
      let remoteIdeEnabled = false;
      if (remoteMode === 'claude') {
        const g = getSetting('global') || {};
        const proj = getSetting('project:' + projectPath) || {};
        remoteIdeEnabled = (g.remoteIde !== undefined && g.remoteIde !== null) ? !!g.remoteIde : !!SETTING_DEFAULTS.remoteIde;
        if (proj.remoteIde !== undefined && proj.remoteIde !== null) remoteIdeEnabled = !!proj.remoteIde;
      }

      let idePreExec = '';
      if (remoteIdeEnabled) {
        const sock = remoteHosts.controlSocketPath(os.tmpdir(), remoteHost.id);
        ideInfo = await setupRemoteIdeTunnel(sessionId, remoteHost, sock, remoteDir, mainWindow, log);
        if (ideInfo) {
          mcpServer = ideInfo.mcpServer;
          idePreExec = remoteIde.remoteIdeLockScript(ideInfo.remotePort, ideInfo.mcpServer.authToken);
        }
      }

      let innerCmd = null;
      if (remoteMode === 'claude') {
        let cc = 'claude';
        if (sessionOptions?.dangerouslySkipPermissions) {
          cc += ' --dangerously-skip-permissions';
        } else if (sessionOptions?.permissionMode) {
          cc += ` --permission-mode "${sessionOptions.permissionMode}"`;
        }
        if (sessionOptions?.addDirs) {
          const dirs = sessionOptions.addDirs.split(',').map(d => d.trim()).filter(Boolean);
          for (const dir of dirs) cc += ` --add-dir "${dir}"`;
        }
        // Resume / fork a past remote session on the host (the transcript lives
        // there — same --resume the CLI uses locally, run in the session's dir).
        if (sessionOptions?.forkFrom) {
          cc += ` --resume "${sessionOptions.forkFrom}" --fork-session`;
        } else if (sessionOptions?.resume) {
          cc += ` --resume "${sessionOptions.resume}"`;
        }
        if (ideInfo) cc += ' --ide';
        // Pre-launch command wraps the claude invocation (same as local:
        // "<preLaunch> claude …", e.g. "aws-vault exec profile -- claude …").
        if (sessionOptions?.preLaunchCmd) cc = sessionOptions.preLaunchCmd + ' ' + cc;
        innerCmd = cc;
      }
      const remoteCmd = remoteHosts.buildRemoteCommand(remoteMode, remoteDir, innerCmd, idePreExec);
      ptyProcess = pty.spawn(shell, shellArgs(shell, remoteCmd, shellExtraArgs), {
        name: 'xterm-256color',
        cols: 120,
        rows: 30,
        cwd: os.homedir(), // local cwd; the remote cd happens inside remoteCmd
        env: {
          ...cleanPtyEnv,
          TERM: 'xterm-256color', COLORTERM: 'truecolor',
          TERM_PROGRAM: 'iTerm.app', TERM_PROGRAM_VERSION: '3.6.6', FORCE_COLOR: '3', ITERM_SESSION_ID: '1',
        },
      });
    } else if (isPlainTerminal) {
      // Plain terminal: interactive login shell, no claude command
      // Inject a shell function to override `claude` with a helpful message
      const claudeShim = 'claude() { echo "\\033[33mTo start a Claude session, use the + button in the sidebar.\\033[0m"; return 1; }; export -f claude 2>/dev/null;';
      ptyProcess = pty.spawn(shell, shellArgs(shell, undefined, shellExtraArgs), {
        name: 'xterm-256color',
        cols: 120,
        rows: 30,
        cwd: isWsl ? os.homedir() : projectPath,
        env: {
          ...cleanPtyEnv,
          TERM: 'xterm-256color', COLORTERM: 'truecolor', TERM_PROGRAM: 'iTerm.app', TERM_PROGRAM_VERSION: '3.6.6', FORCE_COLOR: '3', ITERM_SESSION_ID: '1',
          CLAUDECODE: '1',
          // ZDOTDIR trick won't work reliably; instead inject via ENV (sh/bash) or precmd
          ENV: claudeShim,
          BASH_ENV: claudeShim,
        },
      });
      // For zsh, ENV/BASH_ENV don't apply — write the function after shell starts
      setTimeout(() => {
        if (!ptyProcess._isDisposed) {
          try {
            ptyProcess.write(claudeShim + ' clear\n');
          } catch {}
        }
      }, 300);
    } else {
      // Build claude command with session options
      let claudeCmd;
      if (sessionOptions?.forkFrom) {
        claudeCmd = `claude --resume "${sessionOptions.forkFrom}" --fork-session`;
      } else if (isNew) {
        claudeCmd = `claude --session-id "${sessionId}"`;
      } else {
        claudeCmd = `claude --resume "${sessionId}"`;
      }

      if (sessionOptions) {
        if (sessionOptions.dangerouslySkipPermissions) {
          claudeCmd += ' --dangerously-skip-permissions';
        } else if (sessionOptions.permissionMode) {
          claudeCmd += ` --permission-mode "${sessionOptions.permissionMode}"`;
        }
        if (sessionOptions.worktree) {
          claudeCmd += ' --worktree';
          if (sessionOptions.worktreeName) {
            claudeCmd += ` "${sessionOptions.worktreeName}"`;
          }
        }
        if (sessionOptions.chrome) {
          claudeCmd += ' --chrome';
        }
        if (sessionOptions.addDirs) {
          const dirs = sessionOptions.addDirs.split(',').map(d => d.trim()).filter(Boolean);
          for (const dir of dirs) {
            claudeCmd += ` --add-dir "${dir}"`;
          }
        }
      }

      if (sessionOptions?.appendSystemPrompt) {
        // Write to a temp file and use shell substitution to avoid quoting issues
        const tmpPrompt = path.join(os.tmpdir(), `switchboard-prompt-${sessionId}.md`);
        fs.writeFileSync(tmpPrompt, sessionOptions.appendSystemPrompt);
        claudeCmd += ` --append-system-prompt "$(cat '${tmpPrompt}')"`;
      }

      if (sessionOptions?.preLaunchCmd) {
        claudeCmd = sessionOptions.preLaunchCmd + ' ' + claudeCmd;
      }

      // Start MCP server for this session so Claude CLI sends diffs/file opens to Switchboard
      // (skip if user disabled IDE emulation in global settings)
      if (sessionOptions?.mcpEmulation !== false) {
        try {
          mcpServer = await startMcpServer(sessionId, [projectPath], mainWindow, log);
          claudeCmd += ' --ide';
        } catch (err) {
          log.error(`[mcp] Failed to start MCP server for ${sessionId}: ${err.message}`);
        }
      }

      const ptyEnv = {
        ...cleanPtyEnv,
        TERM: 'xterm-256color', COLORTERM: 'truecolor',
        TERM_PROGRAM: 'iTerm.app', TERM_PROGRAM_VERSION: '3.6.6', FORCE_COLOR: '3', ITERM_SESSION_ID: '1',
      };
      if (mcpServer) {
        ptyEnv.CLAUDE_CODE_SSE_PORT = String(mcpServer.port);
      }

      ptyProcess = pty.spawn(shell, shellArgs(shell, claudeCmd, shellExtraArgs), {
        name: 'xterm-256color',
        cols: 120,
        rows: 30,
        cwd: isWsl ? os.homedir() : projectPath,
        // TERM_PROGRAM=iTerm.app: Claude Code checks this to decide whether to emit
        // OSC 9 notifications (e.g. "needs your attention"). Without it, the packaged
        // app's minimal Electron environment won't trigger those sequences.
        env: ptyEnv,
      });

    }
  } catch (err) {
    return { ok: false, error: `Error spawning PTY: ${err.message}` };
  }

  const session = {
    pty: ptyProcess, rendererAttached: true, exited: false,
    outputBuffer: [], outputBufferSize: 0, altScreen: false,
    projectPath, firstResize: true,
    projectFolder, knownJsonlFiles, sessionSlug,
    // Remote sessions are treated as live "terminal" entries so they flow through
    // the sidebar's active-session injection (no local .jsonl indexing yet).
    isPlainTerminal: isPlainTerminal || isRemote,
    remote: isRemote, remoteHost: remoteHost || null,
    remoteMode: isRemote ? (sessionOptions?.remoteMode === 'shell' ? 'shell' : 'claude') : null,
    forkFrom: sessionOptions?.forkFrom || null,
    mcpServer, _openedAt: Date.now(),
    // Phase 3: remote IDE reverse-tunnel teardown info (present only when enabled).
    remoteIde: (isRemote && ideInfo)
      ? { remotePort: ideInfo.remotePort, localPort: ideInfo.mcpServer.port, sock: ideInfo.sock }
      : null,
  };
  activeSessions.set(sessionId, session);

  ptyProcess.onData(data => {
    const currentId = session.realSessionId || sessionId;

    // Parse OSC sequences (title changes, progress, notifications, etc.)
    if (data.includes('\x1b]')) {
      const oscMatches = data.matchAll(/\x1b\](\d+);([^\x07\x1b]*)(?:\x07|\x1b\\)/g);
      for (const m of oscMatches) {
        const code = m[1];
        const payload = m[2].slice(0, 120);
        // Detect Claude CLI busy state from OSC 0 title (spinner chars = busy, ✳ = idle)
        if (code === '0') {
          const firstChar = payload.charAt(0);
          const isBusy = firstChar.charCodeAt(0) >= 0x2800 && firstChar.charCodeAt(0) <= 0x28FF;
          const isIdle = firstChar === '\u2733'; // ✳
          log.debug(`[OSC 0] session=${currentId} char=U+${firstChar.charCodeAt(0).toString(16).toUpperCase()} busy=${isBusy} idle=${isIdle} wasBusy=${!!session._cliBusy}`);
          if (isBusy && !session._cliBusy) {
            session._cliBusy = true;
            session._oscIdle = false;
            log.debug(`[OSC 0] session=${currentId} → BUSY`);
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send('cli-busy-state', currentId, true);
            }
          } else if (isIdle && session._cliBusy) {
            session._cliBusy = false;
            session._oscIdle = true;
            log.debug(`[OSC 0] session=${currentId} → IDLE`);
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send('cli-busy-state', currentId, false);
            }
          }
        }
      }
      // Parse iTerm2 OSC 9 sequences (terminated by BEL \x07 or ST \x1b\\)
      const osc9Matches = data.matchAll(/\x1b\]9;([^\x07\x1b]*)(?:\x07|\x1b\\)/g);
      for (const osc9 of osc9Matches) {
        const payload = osc9[1];
        // OSC 9;4 progress: 4;0; = clear/done, 4;1;N = running at N%, 4;2;N = error, 4;3; = indeterminate
        if (payload.startsWith('4;')) {
          const level = payload.split(';')[1];
          if (level === '0') continue; // 4;0 is also used for clearing, making it unreliable as an idle signal
          log.debug(`[OSC 9;4] session=${currentId} level=${level} payload="${payload}" wasBusy=${!!session._cliBusy}`);
          if ((level === '1' || level === '2' || level === '3') && !session._cliBusy) {
            session._cliBusy = true;
            session._oscIdle = false;
            log.debug(`[OSC 9;4] session=${currentId} → BUSY`);
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send('cli-busy-state', currentId, true);
            }
          }
        } else {
          // Regular notification (attention, permission, etc.)
          log.info(`[OSC 9] session=${currentId} message="${payload}"`);
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('terminal-notification', currentId, payload);
          }
        }
      }
    }

    // Standalone BEL (not part of an OSC sequence)
    if (data.includes('\x07') && !data.includes('\x1b]')) {
      log.info(`[BEL] session=${currentId}`);
    }

    // Track alternate screen mode (only if data contains the marker)
    if (data.includes('\x1b[?')) {
      if (data.includes('\x1b[?1049h') || data.includes('\x1b[?47h')) {
        session.altScreen = true;
        log.info(`[altscreen] session=${currentId} ON`);
      }
      if (data.includes('\x1b[?1049l') || data.includes('\x1b[?47l')) {
        session.altScreen = false;
        log.info(`[altscreen] session=${currentId} OFF`);
      }
    }

    // Buffer output (skip resize-triggered redraws for plain terminals)
    if (!session._suppressBuffer) {
      session.outputBuffer.push(data);
      session.outputBufferSize += data.length;
      while (session.outputBufferSize > MAX_BUFFER_SIZE && session.outputBuffer.length > 1) {
        session.outputBufferSize -= session.outputBuffer.shift().length;
      }
    }

    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('terminal-data', currentId, data);
    }
  });

  ptyProcess.onExit(({ exitCode }) => {
    session.exited = true;
    // Clean up MCP server
    const mcpId = session.realSessionId || sessionId;
    shutdownMcpServer(mcpId);
    session.mcpServer = null;

    // Phase 3: tear down the remote IDE reverse-tunnel + remote lock file.
    if (session.remoteIde && session.remoteHost) {
      const { remotePort, localPort, sock } = session.remoteIde;
      try { teardownRemoteIdeTunnel(session.remoteHost, sock, remotePort, localPort, log); } catch {}
      session.remoteIde = null;
    }

    const realId = session.realSessionId || sessionId;
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('process-exited', realId, exitCode);
      // If a fork/plan-accept transition re-keyed this session under realId
      // but the PTY exited before transition detection ran, also notify the
      // renderer for the original sessionId so it doesn't stay stuck as "Running".
      if (realId !== sessionId && activeSessions.has(sessionId)) {
        mainWindow.webContents.send('process-exited', sessionId, exitCode);
      }
    }
    activeSessions.delete(realId);
    // Clean up the original key too in case transition detection hasn't run yet
    activeSessions.delete(sessionId);

    // A remote Claude session just wrote/updated its transcript on the host —
    // re-index that host so the past session shows up in the sidebar/search.
    if (session.remote && session.remoteHost && session.remoteMode !== 'shell') {
      const hid = session.remoteHost.id;
      setTimeout(() => { runRemoteSync(hid).catch(() => {}); }, 1500);
    }
  });

  if (sessionOptions?.forkFrom) {
    log.info(`[fork-spawn] tempId=${sessionId} forkFrom=${sessionOptions.forkFrom} folder=${projectFolder} knownFiles=${knownJsonlFiles.size}`);
  }

  return { ok: true, reattached: false, mcpActive: !!mcpServer };
});

// --- IPC: terminal-input (fire-and-forget) ---
ipcMain.on('terminal-input', (_event, sessionId, data) => {
  const session = activeSessions.get(sessionId);
  if (session && !session.exited) {
    session.pty.write(data);
  }
});

// --- IPC: terminal-resize (fire-and-forget) ---
ipcMain.on('terminal-resize', (_event, sessionId, cols, rows) => {
  const session = activeSessions.get(sessionId);
  if (session && !session.exited) {
    // For plain terminals, suppress buffering during resize to avoid
    // accumulating prompt redraws that pollute reattach replay
    if (session.isPlainTerminal) session._suppressBuffer = true;

    session.pty.resize(cols, rows);

    if (session.isPlainTerminal) {
      setTimeout(() => { session._suppressBuffer = false; }, 200);
    }

    // First resize: nudge to force TUI redraw on reattach (skip for plain terminals — causes duplicate prompts)
    if (session.firstResize && !session.isPlainTerminal) {
      session.firstResize = false;
      setTimeout(() => {
        try {
          session.pty.resize(cols + 1, rows);
          setTimeout(() => {
            try { session.pty.resize(cols, rows); } catch {}
          }, 50);
        } catch {}
      }, 50);
    }
  }
});

// --- IPC: close-terminal ---
ipcMain.on('close-terminal', (_event, sessionId) => {
  const session = activeSessions.get(sessionId);
  if (session) {
    session.rendererAttached = false;
    if (session.exited) {
      activeSessions.delete(sessionId);
    }
  }
});

// Session transitions → session-transitions.js
const sessionTransitions = require('./session-transitions');
sessionTransitions.init({ PROJECTS_DIR, activeSessions, getMainWindow: () => mainWindow, log, rekeyMcpServer });
const { detectSessionTransitions } = sessionTransitions;

// --- fs.watch on projects directory ---
let projectsWatcher = null;

function startProjectsWatcher() {
  if (!fs.existsSync(PROJECTS_DIR)) return;

  const pendingFolders = new Set();
  let debounceTimer = null;

  function flushChanges() {
    debounceTimer = null;
    const folders = new Set(pendingFolders);
    pendingFolders.clear();

    let changed = false;
    for (const folder of folders) {
      const folderPath = path.join(PROJECTS_DIR, folder);
      if (fs.existsSync(folderPath)) {
        detectSessionTransitions(folder);
        refreshFolder(folder);
      } else {
        deleteCachedFolder(folder);
      }
      changed = true;
    }

    if (changed) {
      notifyRendererProjectsChanged();
    }
  }

  try {
    projectsWatcher = fs.watch(PROJECTS_DIR, { recursive: true }, (_eventType, filename) => {
      if (!filename) return;

      // filename is relative, e.g. "folder-name/sessions-index.json" or "folder-name/abc.jsonl"
      const parts = filename.split(path.sep);
      const folder = parts[0];
      if (!folder || folder === '.git') return;

      // Only care about .jsonl changes or top-level folder add/remove
      const basename = parts[parts.length - 1];
      if (parts.length === 1) {
        pendingFolders.add(folder);
      } else if (basename.endsWith('.jsonl')) {
        pendingFolders.add(folder);
      } else {
        return;
      }

      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(flushChanges, 500);
    });

    projectsWatcher.on('error', (err) => {
      console.error('Projects watcher error:', err);
    });
  } catch (err) {
    console.error('Failed to start projects watcher:', err);
  }
}

// --- IPC: app version ---
ipcMain.handle('get-app-version', () => app.getVersion());

// --- IPC: auto-updater ---
ipcMain.handle('updater-check', () => {
  if (!autoUpdater) return { available: false, dev: true };
  return autoUpdater.checkForUpdates();
});
ipcMain.handle('updater-download', () => {
  if (!autoUpdater) return;
  return autoUpdater.downloadUpdate();
});
ipcMain.handle('updater-install', () => {
  if (!autoUpdater) return;
  autoUpdater.quitAndInstall();
});

// --- App lifecycle ---
app.whenReady().then(() => {
  buildMenu();
  createWindow();
  startProjectsWatcher();
  scheduleIpc.ensureScheduleCreatorCommand();
  // Index already-reachable remote hosts in the background (Phase 2), so past
  // remote sessions show up on launch without a manual connect/refresh.
  setTimeout(() => { try { startupRemoteSync(); } catch {} }, 2000);
  // Remove our own stale IDE lock files left by a previous crash (Phase 3).
  try { cleanStaleLockFiles(log); } catch {}

  // Shared runCommand for both cron scheduler and manual "run now"
  const { spawn: cpSpawn } = require('child_process');
  function runScheduleCommand(cmd, cwd, name, onDone) {
    const globalSettings = getSetting('global') || {};
    const profileId = globalSettings.shellProfile || SETTING_DEFAULTS.shellProfile;
    const profile = resolveShell(profileId);
    const shell = profile.path;
    const args = shellArgs(shell, cmd, profile.args || []);

    log.info(`[schedule] Running: ${shell} ${args.join(' ')}`);
    const child = cpSpawn(shell, args, {
      cwd,
      stdio: ['ignore', 'ignore', 'pipe'],
      env: { ...cleanPtyEnv, FORCE_COLOR: '0' },
    });

    let stderr = '';
    child.stderr.on('data', (data) => { stderr += data.toString(); });

    child.on('exit', (code) => {
      if (stderr.trim()) log.error(`[schedule] ${name} stderr:\n${stderr.trim()}`);
      log.info(`[schedule] ${name} finished (exit ${code})`);
      if (onDone) onDone();
    });

    child.on('error', (err) => {
      log.error(`[schedule] ${name} error:`, err.message);
      if (onDone) onDone();
    });
  }

  scheduleIpc.init(log, runScheduleCommand);
  startScheduler(log, runScheduleCommand);

  // Re-index search if FTS table was recreated (e.g. tokenizer config change)
  if (searchFtsRecreated) populateCacheViaWorker();

  // Check for updates after launch
  if (autoUpdater) {
    setTimeout(() => autoUpdater.checkForUpdates().catch(e => log.error('[updater] check failed:', e?.message || String(e))), 5000);
    // Re-check every 4 hours for long-running sessions
    setInterval(() => autoUpdater.checkForUpdates().catch(e => log.error('[updater] check failed:', e?.message || String(e))), 4 * 60 * 60 * 1000);
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  // Shut down all MCP servers
  shutdownAllMcp();

  // Close filesystem watcher
  if (projectsWatcher) {
    projectsWatcher.close();
    projectsWatcher = null;
  }

  // Kill all PTY processes on quit
  for (const [, session] of activeSessions) {
    if (!session.exited) {
      try { session.pty.kill(); } catch {}
    }
  }
});

// Close SQLite after all windows are closed to avoid "connection is not open" errors
app.on('will-quit', () => {
  closeDb();
});
