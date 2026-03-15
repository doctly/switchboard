const { app, BrowserWindow, dialog, ipcMain, Menu, screen, shell } = require('electron');
const { Worker } = require('worker_threads');
const path = require('path');
const fs = require('fs');
const os = require('os');
const pty = require('node-pty');
const log = require('electron-log');
const { getFolderIndexMtimeMs } = require('./folder-index-state');
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
    k !== 'ORIGINAL_XDG_CURRENT_DESKTOP'
  )
);

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
  getAllMeta, toggleStar, setName, setArchived,
  isCachePopulated, getAllCached, getCachedByFolder, getCachedFolder, upsertCachedSessions,
  deleteCachedSession, deleteCachedFolder,
  getFolderMeta, getAllFolderMeta, setFolderMeta,
  upsertSearchEntries, deleteSearchSession, deleteSearchFolder, deleteSearchType,
  searchByType, isSearchIndexPopulated,
  getSetting, setSetting, deleteSetting,
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

/** Derive the real project path by reading cwd from the first JSONL entry in the folder */
function deriveProjectPath(folderPath, folder) {
  try {
    const entries = fs.readdirSync(folderPath, { withFileTypes: true });
    // Check direct .jsonl files first
    for (const e of entries) {
      if (e.isFile() && e.name.endsWith('.jsonl')) {
        const firstLine = fs.readFileSync(path.join(folderPath, e.name), 'utf8').split('\n')[0];
        if (firstLine) {
          const parsed = JSON.parse(firstLine);
          if (parsed.cwd) return parsed.cwd;
        }
      }
    }
    // Check session subdirectories (UUID folders with subagent .jsonl files)
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const subDir = path.join(folderPath, e.name);
      try {
        // Look for .jsonl directly in session dir or in subagents/
        const subFiles = fs.readdirSync(subDir, { withFileTypes: true });
        for (const sf of subFiles) {
          let jsonlPath;
          if (sf.isFile() && sf.name.endsWith('.jsonl')) {
            jsonlPath = path.join(subDir, sf.name);
          } else if (sf.isDirectory() && sf.name === 'subagents') {
            const agentFiles = fs.readdirSync(path.join(subDir, 'subagents')).filter(f => f.endsWith('.jsonl'));
            if (agentFiles.length > 0) jsonlPath = path.join(subDir, 'subagents', agentFiles[0]);
          }
          if (jsonlPath) {
            const firstLine = fs.readFileSync(jsonlPath, 'utf8').split('\n')[0];
            if (firstLine) {
              const parsed = JSON.parse(firstLine);
              if (parsed.cwd) return parsed.cwd;
            }
          }
        }
      } catch {}
    }
  } catch {}
  // No cwd found — return null so callers can skip this folder
  return null;
}

/** Parse a single .jsonl file into a session object (or null if invalid) */
function readSessionFile(filePath, folder, projectPath) {
  const sessionId = path.basename(filePath, '.jsonl');
  try {
    const stat = fs.statSync(filePath);
    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.split('\n').filter(Boolean);
    let summary = '';
    let messageCount = 0;
    let textContent = '';
    let slug = null;
    let customTitle = null;
    for (const line of lines) {
      const entry = JSON.parse(line);
      if (entry.slug && !slug) slug = entry.slug;
      if (entry.type === 'custom-title' && entry.customTitle) {
        customTitle = entry.customTitle;
      }
      if (entry.type === 'user' || entry.type === 'assistant' ||
          (entry.type === 'message' && (entry.role === 'user' || entry.role === 'assistant'))) {
        messageCount++;
      }
      const msg = entry.message;
      const text = typeof msg === 'string' ? msg :
        (typeof msg?.content === 'string' ? msg.content :
        (msg?.content?.[0]?.text || ''));
      if (!summary && (entry.type === 'user' || (entry.type === 'message' && entry.role === 'user'))) {
        if (text) summary = text.slice(0, 120);
      }
      if (text && textContent.length < 8000) {
        textContent += text.slice(0, 500) + '\n';
      }
    }
    if (!summary || messageCount < 1) return null;
    return {
      sessionId, folder, projectPath,
      summary, firstPrompt: summary,
      created: stat.birthtime.toISOString(),
      modified: stat.mtime.toISOString(),
      messageCount, textContent, slug, customTitle,
    };
  } catch {
    return null;
  }
}

/** Read one folder from filesystem by scanning .jsonl files directly */
function readFolderFromFilesystem(folder) {
  const folderPath = path.join(PROJECTS_DIR, folder);
  const projectPath = deriveProjectPath(folderPath, folder);
  if (!projectPath) return { projectPath: null, sessions: [] };
  const sessions = [];

  try {
    const jsonlFiles = fs.readdirSync(folderPath).filter(f => f.endsWith('.jsonl'));
    for (const file of jsonlFiles) {
      const s = readSessionFile(path.join(folderPath, file), folder, projectPath);
      if (s) sessions.push(s);
    }
  } catch {}

  return { projectPath, sessions };
}

/** Refresh a single folder incrementally: only re-read changed/new .jsonl files */
function refreshFolder(folder) {
  const folderPath = path.join(PROJECTS_DIR, folder);
  if (!fs.existsSync(folderPath)) {
    deleteCachedFolder(folder);
    return;
  }

  const projectPath = deriveProjectPath(folderPath, folder);
  if (!projectPath) {
    setFolderMeta(folder, null, getFolderIndexMtimeMs(folderPath));
    return;
  }

  // Get what's currently cached for this folder
  const cachedSessions = getCachedByFolder(folder);
  const cachedMap = new Map(); // sessionId → modified ISO string
  for (const row of cachedSessions) {
    cachedMap.set(row.sessionId, row.modified);
  }

  // Scan current .jsonl files
  let jsonlFiles;
  try {
    jsonlFiles = fs.readdirSync(folderPath).filter(f => f.endsWith('.jsonl'));
  } catch { return; }

  const currentIds = new Set();
  let changed = false;

  for (const file of jsonlFiles) {
    const filePath = path.join(folderPath, file);
    const sessionId = path.basename(file, '.jsonl');
    currentIds.add(sessionId);

    // Check if file mtime changed
    let fileMtime;
    try { fileMtime = fs.statSync(filePath).mtime.toISOString(); } catch { continue; }

    if (cachedMap.has(sessionId) && cachedMap.get(sessionId) === fileMtime) {
      continue; // unchanged, skip
    }

    // File is new or modified — re-read it
    const s = readSessionFile(filePath, folder, projectPath);
    if (s) {
      upsertCachedSessions([s]);
      deleteSearchSession(sessionId);
      upsertSearchEntries([{
        id: s.sessionId, type: 'session', folder: s.folder,
        title: s.summary, body: s.textContent,
      }]);
      if (s.customTitle) setName(s.sessionId, s.customTitle);
    }
    changed = true;
  }

  // Remove sessions whose .jsonl files were deleted
  for (const sessionId of cachedMap.keys()) {
    if (!currentIds.has(sessionId)) {
      deleteCachedSession(sessionId);
      deleteSearchSession(sessionId);
      changed = true;
    }
  }

  // Update folder mtime
  setFolderMeta(folder, projectPath, getFolderIndexMtimeMs(folderPath));
}

/** Populate entire cache from filesystem (cold start) */
function populateCacheFromFilesystem() {
  try {
    const folders = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true })
      .filter(d => d.isDirectory() && d.name !== '.git')
      .map(d => d.name);

    for (const folder of folders) {
      refreshFolder(folder);
    }
  } catch (err) {
    console.error('Error populating cache:', err);
  }
}

/** Build projects response from cached data */
function buildProjectsFromCache(showArchived) {
  const metaMap = getAllMeta();
  const cachedRows = getAllCached();
  const global = getSetting('global') || {};
  const hiddenProjects = new Set(global.hiddenProjects || []);

  // Group by folder
  const folderMap = new Map();
  for (const row of cachedRows) {
    if (hiddenProjects.has(row.projectPath)) continue;
    if (!folderMap.has(row.folder)) {
      folderMap.set(row.folder, { folder: row.folder, projectPath: row.projectPath, sessions: [] });
    }
    const meta = metaMap.get(row.sessionId);
    const s = {
      sessionId: row.sessionId,
      summary: row.summary,
      firstPrompt: row.firstPrompt,
      created: row.created,
      modified: row.modified,
      messageCount: row.messageCount,
      projectPath: row.projectPath,
      slug: row.slug || null,
      name: meta?.name || null,
      starred: meta?.starred || 0,
      archived: meta?.archived || 0,
    };
    if (!showArchived && s.archived) continue;
    folderMap.get(row.folder).sessions.push(s);
  }

  // Include empty project directories (no sessions yet)
  try {
    const dirs = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true })
      .filter(d => d.isDirectory() && d.name !== '.git');
    for (const d of dirs) {
      if (!folderMap.has(d.name)) {
        const projectPath = deriveProjectPath(path.join(PROJECTS_DIR, d.name), d.name);
        if (projectPath && !hiddenProjects.has(projectPath)) {
          folderMap.set(d.name, { folder: d.name, projectPath, sessions: [] });
        }
      }
    }
  } catch {}

  const projects = [];
  for (const proj of folderMap.values()) {
    proj.sessions.sort((a, b) => new Date(b.modified) - new Date(a.modified));
    projects.push(proj);
  }

  projects.sort((a, b) => {
    // Empty projects go to the bottom
    if (a.sessions.length === 0 && b.sessions.length > 0) return 1;
    if (b.sessions.length === 0 && a.sessions.length > 0) return -1;
    const aDate = a.sessions[0]?.modified || '';
    const bDate = b.sessions[0]?.modified || '';
    return new Date(bDate) - new Date(aDate);
  });

  return projects;
}

/** Background refresh: check mtimes, refresh stale folders */
function backgroundRefresh() {
  try {
    const folders = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true })
      .filter(d => d.isDirectory() && d.name !== '.git')
      .map(d => d.name);

    const metaMap = getAllFolderMeta();
    const existingFolders = new Set(folders);
    let changed = false;

    // Check for new/changed folders
    for (const folder of folders) {
      const folderPath = path.join(PROJECTS_DIR, folder);
      const currentMtime = getFolderIndexMtimeMs(folderPath);

      const cached = metaMap.get(folder);
      if (!cached || cached.indexMtimeMs !== currentMtime) {
        refreshFolder(folder);
        changed = true;
      }
    }

    // Check for removed folders
    for (const folder of metaMap.keys()) {
      if (!existingFolders.has(folder)) {
        deleteCachedFolder(folder);
        changed = true;
      }
    }

    if (changed) {
      sendStatus('Refresh complete', 'done');
      setTimeout(() => sendStatus(''), 3000);
      notifyRendererProjectsChanged();
    }
  } catch (err) {
    console.error('Error in background refresh:', err);
  }
}

function notifyRendererProjectsChanged() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('projects-changed');
  }
}

function sendStatus(text, type) {
  if (text) log.info(`[status] (${type || 'info'}) ${text}`);
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('status-update', text, type || 'info');
  }
}

// --- Worker-based cache population (non-blocking) ---
let populatingCache = false;

function populateCacheViaWorker() {
  if (populatingCache) return;
  populatingCache = true;
  sendStatus('Scanning projects\u2026', 'active');

  const worker = new Worker(path.join(__dirname, 'workers', 'scan-projects.js'), {
    workerData: { projectsDir: PROJECTS_DIR },
  });

  worker.on('message', (msg) => {
    // Progress updates from worker
    if (msg.type === 'progress') {
      sendStatus(msg.text, 'active');
      return;
    }

    if (!msg.ok) {
      console.error('Worker scan error:', msg.error);
      sendStatus('Scan failed: ' + msg.error, 'error');
      populatingCache = false;
      return;
    }

    sendStatus(`Indexing ${msg.results.length} projects\u2026`, 'active');

    // Write results to DB on main thread (fast)
    let sessionCount = 0;
    for (const { folder, projectPath, sessions, indexMtimeMs } of msg.results) {
      deleteCachedFolder(folder);
      deleteSearchFolder(folder);
      if (sessions.length > 0) {
        sessionCount += sessions.length;
        upsertCachedSessions(sessions);
        upsertSearchEntries(sessions.map(s => ({
          id: s.sessionId, type: 'session', folder: s.folder,
          title: s.summary, body: s.textContent,
        })));
        for (const s of sessions) {
          if (s.customTitle) setName(s.sessionId, s.customTitle);
        }
      }
      setFolderMeta(folder, projectPath, indexMtimeMs);
    }

    populatingCache = false;
    sendStatus(`Indexed ${sessionCount} sessions across ${msg.results.length} projects`, 'done');
    // Clear status after a few seconds
    setTimeout(() => sendStatus(''), 5000);
    notifyRendererProjectsChanged();
  });

  worker.on('error', (err) => {
    console.error('Worker error:', err);
    sendStatus('Worker error: ' + err.message, 'error');
    populatingCache = false;
  });
}

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
    const folder = projectPath.replace(/[/_]/g, '-').replace(/^-/, '-');
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
    const folder = projectPath.replace(/[/_]/g, '-').replace(/^-/, '-');
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

ipcMain.handle('get-projects', (_event, showArchived) => {
  try {
    const needsPopulate = !isCachePopulated() || !isSearchIndexPopulated();

    if (needsPopulate) {
      populateCacheViaWorker();
      return [];
    }

    const projects = buildProjectsFromCache(showArchived);

    // Non-blocking background refresh
    if (!populatingCache) {
      setImmediate(backgroundRefresh);
    }

    return projects;
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

// --- IPC: get-memories ---
function folderToShortPath(folder) {
  // Convert "-Users-home-dev-MyClaude" → "dev/MyClaude"
  const parts = folder.replace(/^-/, '').split('-');
  // Take last 2 meaningful segments
  const meaningful = parts.filter(Boolean);
  return meaningful.slice(-2).join('/');
}

ipcMain.handle('get-memories', () => {
  const memories = [];
  try {
    // Global CLAUDE.md
    const globalClaude = path.join(CLAUDE_DIR, 'CLAUDE.md');
    if (fs.existsSync(globalClaude)) {
      const content = fs.readFileSync(globalClaude, 'utf8').trim();
      if (content) {
        const stat = fs.statSync(globalClaude);
        memories.push({
          type: 'global',
          label: 'Global',
          filename: 'CLAUDE.md',
          filePath: globalClaude,
          modified: stat.mtime.toISOString(),
        });
      }
    }

    // Per-project CLAUDE.md and memory/MEMORY.md
    if (fs.existsSync(PROJECTS_DIR)) {
      const folders = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true })
        .filter(d => d.isDirectory() && d.name !== '.git')
        .map(d => d.name);

      for (const folder of folders) {
        const shortPath = folderToShortPath(folder);
        const folderPath = path.join(PROJECTS_DIR, folder);

        // CLAUDE.md in project folder
        const claudeMd = path.join(folderPath, 'CLAUDE.md');
        if (fs.existsSync(claudeMd)) {
          const content = fs.readFileSync(claudeMd, 'utf8').trim();
          if (content) {
            const stat = fs.statSync(claudeMd);
            memories.push({
              type: 'project',
              label: shortPath,
              filename: 'CLAUDE.md',
              filePath: claudeMd,
              modified: stat.mtime.toISOString(),
            });
          }
        }

        // memory/MEMORY.md in project folder
        const memoryMd = path.join(folderPath, 'memory', 'MEMORY.md');
        if (fs.existsSync(memoryMd)) {
          const content = fs.readFileSync(memoryMd, 'utf8').trim();
          if (content) {
            const stat = fs.statSync(memoryMd);
            memories.push({
              type: 'auto',
              label: shortPath,
              filename: 'MEMORY.md',
              filePath: memoryMd,
              modified: stat.mtime.toISOString(),
            });
          }
        }
      }
    }
  } catch (err) {
    console.error('Error scanning memories:', err);
  }

  // Index memories for FTS
  try {
    deleteSearchType('memory');
    upsertSearchEntries(memories.map(m => ({
      id: m.filePath, type: 'memory', folder: null,
      title: m.label + ' ' + m.filename,
      body: fs.readFileSync(m.filePath, 'utf8'),
    })));
  } catch {}

  return memories;
});

// --- IPC: read-memory ---
ipcMain.handle('read-memory', (_event, filePath) => {
  try {
    // Validate path is under ~/.claude/
    const resolved = path.resolve(filePath);
    if (!resolved.startsWith(CLAUDE_DIR)) {
      return '';
    }
    return fs.readFileSync(resolved, 'utf8');
  } catch (err) {
    console.error('Error reading memory file:', err);
    return '';
  }
});

// --- IPC: search ---
ipcMain.handle('search', (_event, type, query) => {
  return searchByType(type, query, 50);
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
};

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
ipcMain.handle('open-terminal', (_event, sessionId, projectPath, isNew, sessionOptions) => {
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

    return { ok: true, reattached: true };
  }

  // Spawn new PTY
  if (!fs.existsSync(projectPath)) {
    return { ok: false, error: `project directory no longer exists: ${projectPath}` };
  }

  const shell = process.env.SHELL || '/bin/zsh';
  const isPlainTerminal = sessionOptions?.type === 'terminal';

  let knownJsonlFiles = new Set();
  let sessionSlug = null;
  let projectFolder = null;

  if (!isPlainTerminal) {
    // Snapshot existing .jsonl files before spawning (for new session + fork/plan detection)
    projectFolder = projectPath.replace(/[/_]/g, '-').replace(/^-/, '-');
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
  try {
    if (isPlainTerminal) {
      // Plain terminal: interactive login shell, no claude command
      // Inject a shell function to override `claude` with a helpful message
      const claudeShim = 'claude() { echo "\\033[33mTo start a Claude session, use the + button in the sidebar.\\033[0m"; return 1; }; export -f claude 2>/dev/null;';
      ptyProcess = pty.spawn(shell, ['-l', '-i'], {
        name: 'xterm-256color',
        cols: 120,
        rows: 30,
        cwd: projectPath,
        env: {
          ...cleanPtyEnv,
          TERM: 'xterm-256color', COLORTERM: 'truecolor', TERM_PROGRAM: 'iTerm.app', FORCE_COLOR: '3', ITERM_SESSION_ID: '1',
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

      if (sessionOptions?.preLaunchCmd) {
        claudeCmd = sessionOptions.preLaunchCmd + ' ' + claudeCmd;
      }

      ptyProcess = pty.spawn(shell, ['-l', '-i', '-c', claudeCmd], {
        name: 'xterm-256color',
        cols: 120,
        rows: 30,
        cwd: projectPath,
        // TERM_PROGRAM=iTerm.app: Claude Code checks this to decide whether to emit
        // OSC 9 notifications (e.g. "needs your attention"). Without it, the packaged
        // app's minimal Electron environment won't trigger those sequences.
        env: { ...cleanPtyEnv, TERM: 'xterm-256color', COLORTERM: 'truecolor', TERM_PROGRAM: 'iTerm.app', FORCE_COLOR: '3', ITERM_SESSION_ID: '1' },
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
  };
  activeSessions.set(sessionId, session);

  ptyProcess.onData(data => {
    const currentId = session.realSessionId || sessionId;

    // Log all OSC sequences (title changes, bells, etc.)
    if (data.includes('\x1b]')) {
      const oscMatches = data.matchAll(/\x1b\](\d+);([^\x07\x1b]*)(?:\x07|\x1b\\)/g);
      for (const m of oscMatches) {
        const code = m[1];
        const payload = m[2].slice(0, 120);
        // Skip notification (9) — already logged below
        if (code !== '9') log.debug(`[OSC ${code}] session=${currentId} payload="${payload}"`);
      }
      // Parse iTerm2 OSC 9 notification (terminated by BEL \x07 or ST \x1b\\)
      const notifMatch = data.match(/\x1b\]9;([^\x07\x1b]*)(?:\x07|\x1b\\)/);
      if (notifMatch && !notifMatch[1].startsWith('4;')) {
        const message = notifMatch[1];
        log.debug(`[OSC 9] session=${currentId} message="${message}"`);
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('terminal-notification', currentId, message);
        }
      }

      // Parse iTerm2 OSC 9;4 progress sequences
      const progressMatch = data.match(/\x1b\]9;4;(\d)(?:;(\d+))?(?:\x07|\x1b\\)/);
      if (progressMatch) {
        const state = parseInt(progressMatch[1]);
        const percent = progressMatch[2] ? parseInt(progressMatch[2]) : -1;
        log.debug(`[OSC 9;4] session=${currentId} state=${state} percent=${percent}`);
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('progress-state', currentId, state, percent);
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
    const realId = session.realSessionId || sessionId;
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('process-exited', realId, exitCode);
    }
    activeSessions.delete(realId);
  });

  if (sessionOptions?.forkFrom) {
    log.info(`[fork-spawn] tempId=${sessionId} forkFrom=${sessionOptions.forkFrom} folder=${projectFolder} knownFiles=${knownJsonlFiles.size}`);
  }

  return { ok: true, reattached: false };
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

// --- Fork / plan-accept detection ---

/** Read first few lines of a new .jsonl to extract signals */
function readNewSessionSignals(filePath) {
  try {
    const head = fs.readFileSync(filePath, 'utf8').slice(0, 8000);
    const lines = head.split('\n').filter(Boolean);
    let forkedFrom = null;
    let planContent = false;
    let slug = null;
    let parentSessionId = null;
    for (const line of lines) {
      const entry = JSON.parse(line);
      if (entry.forkedFrom) forkedFrom = entry.forkedFrom.sessionId;
      if (entry.planContent) planContent = true;
      if (entry.slug && !slug) slug = entry.slug;
      // --fork-session copies messages with original sessionId
      if (entry.sessionId && !parentSessionId) parentSessionId = entry.sessionId;
      // Stop after finding a user or assistant message
      if (entry.type === 'user' || entry.type === 'assistant') break;
    }
    return { forkedFrom, planContent, slug, parentSessionId };
  } catch {
    return { forkedFrom: null, planContent: false, slug: null, parentSessionId: null };
  }
}

/** Read tail of old session file for ExitPlanMode and slug */
function readOldSessionTail(filePath) {
  try {
    const stat = fs.statSync(filePath);
    const size = stat.size;
    const readSize = Math.min(size, 8192);
    const buf = Buffer.alloc(readSize);
    const fd = fs.openSync(filePath, 'r');
    fs.readSync(fd, buf, 0, readSize, size - readSize);
    fs.closeSync(fd);
    const tail = buf.toString('utf8');
    const hasExitPlanMode = tail.includes('ExitPlanMode');
    // Extract slug from tail (last occurrence)
    let slug = null;
    const slugMatches = tail.match(/"slug"\s*:\s*"([^"]+)"/g);
    if (slugMatches) {
      const last = slugMatches[slugMatches.length - 1].match(/"slug"\s*:\s*"([^"]+)"/);
      if (last) slug = last[1];
    }
    return { hasExitPlanMode, slug };
  } catch {
    return { hasExitPlanMode: false, slug: null };
  }
}

/** Detect fork or plan-accept transitions for active PTY sessions in a folder */
function detectSessionTransitions(folder) {
  const folderPath = path.join(PROJECTS_DIR, folder);
  let currentFiles;
  try {
    currentFiles = fs.readdirSync(folderPath).filter(f => f.endsWith('.jsonl'));
  } catch { return; }

  for (const [sessionId, session] of [...activeSessions]) {
    if (session.exited || session.isPlainTerminal || !session.knownJsonlFiles || session.projectFolder !== folder) {
      if (!session.exited && !session.isPlainTerminal && session.forkFrom) {
        log.info(`[fork-detect] skipped session=${sessionId} forkFrom=${session.forkFrom||'none'} reason=${session.exited ? 'exited' : session.isPlainTerminal ? 'terminal' : !session.knownJsonlFiles ? 'noKnown' : 'folderMismatch('+session.projectFolder+' vs '+folder+')'}`);
      }
      continue;
    }

    const newFiles = currentFiles.filter(f => !session.knownJsonlFiles.has(f));

    log.debug(`[detect] session=${sessionId} forkFrom=${session.forkFrom||'none'} folder=${folder} newFiles=${newFiles.length} knownCount=${session.knownJsonlFiles.size} currentCount=${currentFiles.length}`);

    if (newFiles.length === 0) continue;

    const emptyFiles = new Set(); // files with no signals yet (still being written)

    for (const newFile of newFiles) {
      const newFilePath = path.join(folderPath, newFile);
      const newId = path.basename(newFile, '.jsonl');
      const signals = readNewSessionSignals(newFilePath);

      // File exists but has no parseable content yet — skip and retry next cycle
      if (!signals.forkedFrom && !signals.parentSessionId && !signals.slug && !signals.planContent) {
        emptyFiles.add(newFile);
        log.debug(`[detect] session=${sessionId} skipping empty newFile=${newId}`);
        continue;
      }

      log.debug(`[detect] session=${sessionId} checking newFile=${newId} signals=${JSON.stringify({forkedFrom: signals.forkedFrom||null, parentSessionId: signals.parentSessionId||null, slug: signals.slug||null})} forkFrom=${session.forkFrom||'none'}`);

      let matched = false;

      // Fork: forkedFrom.sessionId matches this active PTY or the session it was forked from
      if (signals.forkedFrom === sessionId || (session.forkFrom && signals.forkedFrom === session.forkFrom)) {
        matched = true;
      }
      // --fork-session: new file's parentSessionId matches the forkFrom source,
      // and the new file's name (newId) differs from both our PTY id and the source
      if (!matched && session.forkFrom && signals.parentSessionId === session.forkFrom && newId !== session.forkFrom) {
        matched = true;
      }

      // Plan-accept: shared slug + planContent + old session has ExitPlanMode
      if (!matched && signals.planContent && signals.slug) {
        const oldFilePath = path.join(folderPath, sessionId + '.jsonl');
        const oldTail = readOldSessionTail(oldFilePath);
        if (oldTail.hasExitPlanMode && oldTail.slug === signals.slug) {
          // Temporal check: new file created within 30s of old file's last modification
          try {
            const oldMtime = fs.statSync(oldFilePath).mtimeMs;
            const newMtime = fs.statSync(newFilePath).mtimeMs;
            if (Math.abs(newMtime - oldMtime) < 30000) {
              matched = true;
            }
          } catch {}
        }
      }

      if (matched) {
        log.info(`[session-transition] ${sessionId} → ${newId} (${signals.forkedFrom || session.forkFrom ? 'fork' : 'plan-accept'})`);
        session.knownJsonlFiles = new Set(currentFiles);
        session.realSessionId = newId;
        // Update slug from new session
        if (signals.slug) session.sessionSlug = signals.slug;
        activeSessions.delete(sessionId);
        activeSessions.set(newId, session);
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('session-forked', sessionId, newId);
        }
        break; // Only one transition per session per flush
      }
    }

    // Update known files, but exclude empty ones so they get rechecked next cycle
    const updated = new Set(currentFiles);
    for (const f of emptyFiles) updated.delete(f);
    session.knownJsonlFiles = updated;
  }
}

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

// --- PTY warmup (preload native module + shell profile + claude TUI) ---
function warmupPty() {
  sendStatus('Warming up terminal\u2026', 'active');
  try {
    const shell = process.env.SHELL || '/bin/zsh';
    const p = pty.spawn(shell, ['-l', '-i', '-c', 'claude'], {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd: os.homedir(),
      env: { ...cleanPtyEnv, TERM: 'xterm-256color', COLORTERM: 'truecolor', TERM_PROGRAM: 'iTerm.app', FORCE_COLOR: '3', ITERM_SESSION_ID: '1' },
    });
    p.onExit(() => {
      sendStatus('Terminal ready', 'done');
      setTimeout(() => sendStatus(''), 3000);
    });
    setTimeout(() => { try { p.kill(); } catch {} }, 5000);
  } catch {
    sendStatus('');
  }
}

// --- App lifecycle ---
app.whenReady().then(() => {
  buildMenu();
  createWindow();
  startProjectsWatcher();

  // Warm up node-pty so first real spawn is fast
  setTimeout(warmupPty, 500);

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
