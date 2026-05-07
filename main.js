const { app, BrowserWindow, dialog, ipcMain, Menu, screen, shell } = require('electron');
const { Worker } = require('worker_threads');
const path = require('path');
const fs = require('fs');
const os = require('os');
const pty = require('node-pty');
const log = require('electron-log');
// getFolderIndexMtimeMs moved to session-cache.js
const { startMcpServer, shutdownMcpServer, shutdownAll: shutdownAllMcp, resolvePendingDiff, rekeyMcpServer, cleanStaleLockFiles } = require('./mcp-bridge');
const { assertPathAllowed, addAllowedRoot } = require('./path-guard');
const { buildClaudeCmd } = require('./claude-cmd');
const { isSafeExternalUrl } = require('./url-guard');
const branding = require('./branding');
const profilesModule = require('./profiles');
const sessionProfiles = require('./session-profiles');
const analyticsModule = require('./analytics');
const whisperManager = require('./whisper-manager');
const { computeWindowBounds } = require('./window-bounds');

// Sync IPC for the preload to fetch the brand-strings snapshot at load
// time. ipcMain.on handles sendSync via event.returnValue.
ipcMain.on('branding:getStrings', (event) => {
  event.returnValue = branding.strings || {};
});
log.transports.file.level = app.isPackaged ? 'info' : 'debug';
log.transports.console.level = app.isPackaged ? 'info' : 'debug';

if (!app.isPackaged) {
  try { require('electron-reloader')(module, { watchRenderer: true }); } catch {}
}

// Clean env for child processes — strip Electron internals that cause nested
// Electron apps (or node-pty inside them) to malfunction. ANTHROPIC_* and
// CLAUDE_* pass through so users with a private endpoint and token keep them.
const cleanPtyEnv = Object.fromEntries(
  Object.entries(process.env).filter(([k]) =>
    !k.startsWith('ELECTRON_') &&
    !k.startsWith('GOOGLE_API_KEY') &&
    k !== 'NODE_OPTIONS' &&
    k !== 'ORIGINAL_XDG_CURRENT_DESKTOP' &&
    k !== 'WT_SESSION'
  )
);

// IPC: re-read a whitelist of env vars from the user's login shell rc file.
// Used when the user rotates their Anthropic token in ~/.zshrc and wants
// newly-spawned sessions to pick it up without restarting.
const ENV_RELOAD_WHITELIST = ['ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY', 'CLAUDE_CONFIG_DIR'];
ipcMain.handle('reload-shell-env', async () => {
  if (process.platform === 'win32') {
    return { ok: false, error: 'reload-shell-env is unix-only' };
  }
  try {
    const { execFileSync } = require('child_process');
    const shellPath = process.env.SHELL || '/bin/zsh';
    // Run the interactive login shell and print the whitelisted vars in a
    // NUL-separated KEY=VALUE form. No shell metacharacters are passed in.
    const script = ENV_RELOAD_WHITELIST.map(k => `printf '%s=%s\\0' ${k} "$${k}"`).join('; ');
    const out = execFileSync(shellPath, ['-l', '-i', '-c', script], {
      encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'],
    });
    const updated = {};
    for (const pair of out.split('\0')) {
      if (!pair) continue;
      const idx = pair.indexOf('=');
      if (idx <= 0) continue;
      const k = pair.slice(0, idx);
      const v = pair.slice(idx + 1);
      if (!ENV_RELOAD_WHITELIST.includes(k)) continue;
      if (v) {
        process.env[k] = v;
        cleanPtyEnv[k] = v;
        updated[k] = true;
      } else {
        delete process.env[k];
        delete cleanPtyEnv[k];
      }
    }
    return { ok: true, reloaded: Object.keys(updated) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// Shell profiles → shell-profiles.js
const { discoverShellProfiles, getShellProfiles, resolveShell, isWindows, isWslShell, windowsToWslPath, shellArgs } = require('./shell-profiles');
const { startScheduler } = require('./schedule-runner');
const { encodeProjectPath } = require('./encode-project-path');



// Auto-updater removed: this build never contacts any update server.
const {
  getMeta, getAllMeta, toggleStar, setName, setArchived,
  isCachePopulated, getAllCached, getCachedByFolder, getCachedFolder, getCachedSession, upsertCachedSessions,
  deleteCachedSession, deleteCachedFolder,
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
  // All bounds-computation logic lives in window-bounds.js as a pure
  // function — fully covered by test/window-bounds.test.js. createWindow
  // just collects the inputs and applies the result.
  const savedBounds = getSetting('global')?.windowBounds || null;
  let bounds, restorePosition;
  try {
    const displays = screen.getAllDisplays();
    ({ bounds, restorePosition } = computeWindowBounds(savedBounds, displays));
  } catch {
    bounds = { width: 1400, height: 900 };
    restorePosition = null;
  }

  mainWindow = new BrowserWindow({
    ...bounds,
    minWidth: 800,
    minHeight: 500,
    title: branding.windowTitle,
    icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      experimentalFeatures: false,
    },
  });

  // Keep the window title under branding control — otherwise <title> in
  // index.html would stomp on BrowserWindow's `title` as soon as the page
  // loads. preventDefault on page-title-updated holds the current title.
  mainWindow.on('page-title-updated', (e) => e.preventDefault());
  mainWindow.setTitle(branding.windowTitle);

  // Set position after creation to prevent macOS from clamping size
  if (restorePosition) {
    mainWindow.setBounds({ ...restorePosition, width: bounds.width, height: bounds.height });
  }

  mainWindow.loadFile(path.join(__dirname, 'public', 'index.html'));

  // Open external links in the system browser instead of a child BrowserWindow
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isSafeExternalUrl(url)) shell.openExternal(url).catch(() => {});
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (url !== mainWindow.webContents.getURL()) {
      event.preventDefault();
      if (isSafeExternalUrl(url)) shell.openExternal(url).catch(() => {});
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

  // Save window bounds on move/resize (debounced) + on close (immediate).
  // The debounced save handles in-session resizing; the immediate save on
  // close-request captures the final state even if the user closed the
  // window within the debounce window — which used to lose the latest
  // bounds because the setTimeout fired after isDestroyed() was already true.
  let boundsTimer = null;
  const writeBoundsNow = () => {
    if (!mainWindow || mainWindow.isDestroyed() || mainWindow.isMinimized()) return;
    // getNormalBounds() returns the un-maximized "restore" bounds — what
    // we want to persist. getBounds() returns the *current* size which,
    // when maximized via Windows snap or title-bar double-click, is the
    // entire monitor's work area. Saving that meant the next launch
    // restored the window pinned full-screen with no way to escape.
    const b = (typeof mainWindow.getNormalBounds === 'function')
      ? mainWindow.getNormalBounds()
      : mainWindow.getBounds();
    const global = getSetting('global') || {};
    global.windowBounds = { x: b.x, y: b.y, width: b.width, height: b.height };
    setSetting('global', global);
  };
  const saveBoundsDebounced = () => {
    if (boundsTimer) clearTimeout(boundsTimer);
    boundsTimer = setTimeout(writeBoundsNow, 500);
  };
  mainWindow.on('resize', saveBoundsDebounced);
  mainWindow.on('move', saveBoundsDebounced);
  // Stop taskbar flash when user focuses the window
  mainWindow.on('focus', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.flashFrame(false);
    }
  });
  // 'close' fires while the window is still alive — perfect time to flush.
  // Cancel any pending debounced write so we don't double-save.
  mainWindow.on('close', () => {
    if (boundsTimer) { clearTimeout(boundsTimer); boundsTimer = null; }
    writeBoundsNow();
  });
  // Belt-and-braces for app-wide quit (Cmd+Q on macOS, taskbar quit, etc.).
  app.on('before-quit', () => {
    if (boundsTimer) { clearTimeout(boundsTimer); boundsTimer = null; }
    writeBoundsNow();
  });

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
    setFolderMeta, getAllMeta, getAllCached, getSetting, getMeta, setName,
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

    addAllowedRoot(projectPath);

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
  if (!isSafeExternalUrl(url)) {
    log.warn('[open-external] rejected:', typeof url === 'string' ? url.slice(0, 200) : typeof url);
    return false;
  }
  log.info('[open-external]', url);
  return shell.openExternal(url);
});

// --- IPC: MCP bridge ---
ipcMain.on('mcp-diff-response', (_event, sessionId, diffId, action, editedContent) => {
  resolvePendingDiff(sessionId, diffId, action, editedContent);
});

ipcMain.handle('read-file-for-panel', async (_event, filePath) => {
  const check = assertPathAllowed(filePath, 'read');
  if (!check.ok) return { ok: false, error: check.error };
  try {
    const content = fs.readFileSync(check.resolved, 'utf8');
    return { ok: true, content };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('save-file-for-panel', async (_event, filePath, content) => {
  const check = assertPathAllowed(filePath, 'write');
  if (!check.ok) return { ok: false, error: check.error };
  try {
    if (!fs.existsSync(check.resolved)) return { ok: false, error: 'File does not exist' };
    fs.writeFileSync(check.resolved, content, 'utf8');
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// ── File Watching (for viewer panels) ────────────────────────────────
// Capped so a runaway / malicious renderer can't exhaust main-process fd's.
const fileWatchers = new Map(); // filePath → FSWatcher
const MAX_FILE_WATCHERS = 100;

ipcMain.handle('watch-file', (_event, filePath) => {
  const check = assertPathAllowed(filePath, 'read');
  if (!check.ok) return { ok: false, error: check.error };
  const resolved = check.resolved;
  if (fileWatchers.has(resolved)) return { ok: true };
  if (fileWatchers.size >= MAX_FILE_WATCHERS) {
    return { ok: false, error: 'watcher limit reached' };
  }
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
  const check = assertPathAllowed(filePath, 'read');
  if (!check.ok) return { ok: false, error: check.error };
  const watcher = fileWatchers.get(check.resolved);
  if (watcher) {
    watcher.close();
    fileWatchers.delete(check.resolved);
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
    // Run /stats via PTY only — usage API removed.
    await runClaude('"/stats"', { waitFor: /streak/i, timeoutMs: 10000 });

    let stats = null;
    try {
      if (fs.existsSync(STATS_CACHE_PATH)) {
        stats = JSON.parse(fs.readFileSync(STATS_CACHE_PATH, 'utf8'));
      }
    } catch {}

    return { stats, usage: {} };
  } catch (err) {
    log.error('Error refreshing stats:', err);
    return { stats: null, usage: {} };
  }
});

// get-usage handler removed: usage API calls have been disabled.
ipcMain.handle('get-usage', () => ({}));

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
        if (projectPath) addAllowedRoot(projectPath);
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
  const check = assertPathAllowed(filePath, 'read');
  if (!check.ok) return '';
  if (!check.resolved.endsWith('.md')) return '';
  try {
    return fs.readFileSync(check.resolved, 'utf8');
  } catch (err) {
    console.error('Error reading memory file:', err);
    return '';
  }
});

// --- IPC: save-memory ---
ipcMain.handle('save-memory', (_event, filePath, content) => {
  const check = assertPathAllowed(filePath, 'write');
  if (!check.ok) return { ok: false, error: check.error };
  if (!check.resolved.endsWith('.md')) return { ok: false, error: 'not a .md file' };
  try {
    if (!fs.existsSync(check.resolved)) return { ok: false, error: 'file does not exist' };
    fs.writeFileSync(check.resolved, content, 'utf8');
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
// Renderer can only read/write keys that settings-guard accepts. Keeps
// the renderer out of internal / future-reserved keys.
const { isAllowedSettingKey } = require('./settings-guard');

ipcMain.handle('get-setting', (_event, key) => {
  if (!isAllowedSettingKey(key)) return null;
  return getSetting(key);
});

ipcMain.handle('set-setting', (_event, key, value) => {
  if (!isAllowedSettingKey(key)) return { ok: false, error: 'setting key not allowed' };
  setSetting(key, value);
  return { ok: true };
});

ipcMain.handle('delete-setting', (_event, key) => {
  if (!isAllowedSettingKey(key)) return { ok: false, error: 'setting key not allowed' };
  deleteSetting(key);
  return { ok: true };
});

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
  agentTeams: false,
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
ipcMain.handle('read-session-jsonl', (_event, sessionId) => {
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

  // Spawn new PTY
  if (!fs.existsSync(projectPath)) {
    return { ok: false, error: `project directory no longer exists: ${projectPath}` };
  }
  addAllowedRoot(projectPath);

  const isPlainTerminal = sessionOptions?.type === 'terminal';

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
  const useWslProfile = isWslShell(requestedProfile.path) && isPlainTerminal;
  const shellProfile = (isWslShell(requestedProfile.path) && !isPlainTerminal)
    ? resolveShell('auto')
    : requestedProfile;
  const shell = shellProfile.path;
  const shellExtraArgs = [...(shellProfile.args || [])];
  const isWsl = isWslShell(shell);
  // For WSL, convert Windows path to /mnt/ path and pass via --cd;
  // the spawn cwd must remain a valid Windows path for wsl.exe itself.
  if (isWsl) {
    const wslCwd = windowsToWslPath(projectPath);
    shellExtraArgs.unshift('--cd', wslCwd);
  }
  log.info(`[shell] profile=${shellProfile.id} shell=${shell} args=${JSON.stringify(shellExtraArgs)}`);

  let knownJsonlFiles = new Set();
  let sessionSlug = null;
  let projectFolder = null;

  if (!isPlainTerminal) {
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
  try {
    if (isPlainTerminal) {
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
      // Build claude command. All validation & shell-escaping lives in
      // claude-cmd.js for test coverage.
      let tmpPrompt = null;
      if (sessionOptions?.appendSystemPrompt) {
        tmpPrompt = path.join(os.tmpdir(), `${branding.tmpFilePrefix}-prompt-${sessionId}.md`);
        fs.writeFileSync(tmpPrompt, sessionOptions.appendSystemPrompt);
      }
      const built = buildClaudeCmd({ sessionId, isNew, sessionOptions, tmpPromptPath: tmpPrompt });
      if (!built.ok) {
        if (tmpPrompt) { try { fs.unlinkSync(tmpPrompt); } catch {} }
        return built;
      }
      let claudeCmd = built.cmd;

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

      // Apply Claude profile env (per-session profileId → fall back to global default).
      // Profile values override base env. Refs like "$DEEPSEEK_API_KEY" resolve against
      // the host process env; unresolved refs are dropped (not passed through literally).
      // Also record the chosen profile id (or the resolved-default's id) so the sidebar
      // can render the right icon badge — including across app restarts.
      try {
        const profile = profilesModule.pickProfileForSession(sessionOptions?.profileId);
        if (profile) {
          const resolved = profilesModule.resolveEnv(profile.env);
          Object.assign(ptyEnv, resolved);
          const dropped = Object.keys(profile.env).filter(k => !(k in resolved));
          log.info(`[profiles] Applied "${profile.name}" (${profile.id}): ${Object.keys(resolved).length} var(s)${dropped.length ? `, ${dropped.length} unresolved ref(s) dropped: ${dropped.join(',')}` : ''}`);
          sessionProfiles.recordSessionProfile(sessionId, profile.id);
        } else if (sessionOptions?.profileId === 'none') {
          // Explicit pass-through clears any previously-recorded mapping so
          // the badge disappears on the next sidebar render.
          sessionProfiles.recordSessionProfile(sessionId, null);
        }
      } catch (err) {
        log.error(`[profiles] Failed to apply profile: ${err.message}`);
      }

      // Agent teams: when disabled (default), prevent the Claude CLI from
      // spawning sub-agents via the Task tool. When enabled, sub-agents are
      // allowed and the profile's CLAUDE_CODE_SUBAGENT_MODEL (if any) is used.
      if (!sessionOptions?.agentTeams) {
        ptyEnv.CLAUDE_CODE_DISABLE_SUBAGENTS = '1';
      }

      // Schedule cleanup of the system-prompt temp file once the shell has
      // had time to $(cat ...) it into the command line. Also unlink on
      // session exit and app quit as belt-and-braces.
      if (tmpPrompt) {
        const doUnlink = () => { try { fs.unlinkSync(tmpPrompt); } catch {} };
        setTimeout(doUnlink, 30_000).unref?.();
        app.once('before-quit', doUnlink);
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
    isPlainTerminal, forkFrom: sessionOptions?.forkFrom || null,
    mcpServer, _openedAt: Date.now(),
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
            // Flash taskbar (Windows) / bounce dock (macOS) when attention is needed
            // and the window is not focused — so the user notices even when alt-tabbed away.
            if (/attention|approval|permission|needs your|wants to enter/i.test(payload) && !mainWindow.isFocused()) {
              mainWindow.flashFrame(true);
            }
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

// Auto-updater IPC removed — handlers below return inert results so any
// stray renderer callers don't throw. The renderer itself no longer wires
// these up.
ipcMain.handle('updater-check', () => ({ available: false, disabled: true }));
ipcMain.handle('updater-download', () => {});
ipcMain.handle('updater-install', () => {});

// --- App lifecycle ---
app.whenReady().then(() => {
  // Content-Security-Policy: lock the renderer to same-origin script/style
  // execution. xterm/codemirror are bundled locally; markdown is rendered
  // through DOMPurify before reaching the DOM, so 'unsafe-inline' is not
  // required for scripts. Inline styles are still allowed (xterm injects
  // colour styles at runtime via setAttribute('style', …)).
  const { session } = require('electron');
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          "default-src 'self'; " +
          "script-src 'self'; " +
          "style-src 'self' 'unsafe-inline'; " +
          "img-src 'self' data: blob:; " +
          "font-src 'self' data:; " +
          // 127.0.0.1 + localhost on any port for local services
          // (whisper.cpp transcription server, future local proxies, etc.).
          // Routable network is still blocked.
          "connect-src 'self' http://127.0.0.1:* http://localhost:* ws://127.0.0.1:* ws://localhost:*; " +
          "object-src 'none'; " +
          "base-uri 'self'; " +
          "frame-ancestors 'none'"
        ],
      },
    });
  });

  // Seed path-guard allowed roots from every known Claude projects folder
  // so the file panel can read project files immediately at startup.
  try {
    if (fs.existsSync(PROJECTS_DIR)) {
      for (const folder of fs.readdirSync(PROJECTS_DIR)) {
        try {
          const pp = deriveProjectPath(path.join(PROJECTS_DIR, folder), folder);
          if (pp) addAllowedRoot(pp);
        } catch {}
      }
    }
  } catch {}

  buildMenu();
  createWindow();
  startProjectsWatcher();
  scheduleIpc.ensureScheduleCreatorCommand();

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
  profilesModule.init(log);
  sessionProfiles.init(log);
  analyticsModule.init(log, () => mainWindow);
  whisperManager.init({
    log,
    app,
    ipcMain,
    getMainWindow: () => mainWindow,
    getVoiceSettings: () => (getSetting('global') || {}).voice || {},
  });
  startScheduler(log, runScheduleCommand);

  // Re-index search if FTS table was recreated (e.g. tokenizer config change)
  if (searchFtsRecreated) populateCacheViaWorker();

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
