const path = require('path');
const fs = require('fs');
const { Worker } = require('worker_threads');
const { getFolderIndexMtimeMs } = require('./folder-index-state');
const { deriveProjectPath } = require('./derive-project-path');
const { readSessionFile } = require('./read-session-file');
const { encodeProjectPath } = require('./encode-project-path');

/**
 * Session cache module.
 * Call init(ctx) once with the shared context object.
 */
let PROJECTS_DIR, activeSessions, getMainWindow, log;
let deleteCachedFolder, getCachedByFolder, upsertCachedSessions, deleteCachedSession;
let deleteSearchFolder, deleteSearchSession, upsertSearchEntries;
let setFolderMeta, getAllMeta, getAllCached, getSetting, getMeta, setName;

function init(ctx) {
  PROJECTS_DIR = ctx.PROJECTS_DIR;
  activeSessions = ctx.activeSessions;
  getMainWindow = ctx.getMainWindow;
  log = ctx.log;
  // DB functions
  deleteCachedFolder = ctx.db.deleteCachedFolder;
  getCachedByFolder = ctx.db.getCachedByFolder;
  upsertCachedSessions = ctx.db.upsertCachedSessions;
  deleteCachedSession = ctx.db.deleteCachedSession;
  deleteSearchFolder = ctx.db.deleteSearchFolder;
  deleteSearchSession = ctx.db.deleteSearchSession;
  upsertSearchEntries = ctx.db.upsertSearchEntries;
  setFolderMeta = ctx.db.setFolderMeta;
  getAllMeta = ctx.db.getAllMeta;
  getAllCached = ctx.db.getAllCached;
  getSetting = ctx.db.getSetting;
  getMeta = ctx.db.getMeta;
  setName = ctx.db.setName;
}

// readSessionFile is imported from read-session-file.js (shared with worker)

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

  // Collect all changes first, then batch DB writes to minimize lock duration
  const sessionsToUpsert = [];
  const searchEntriesToUpsert = [];
  const namesToSet = [];
  const sessionsToDelete = [];

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
      sessionsToUpsert.push(s);
      const name = s.customTitle || getMeta(s.sessionId)?.name || '';
      searchEntriesToUpsert.push({
        id: s.sessionId, type: 'session', folder: s.folder,
        title: (name ? name + ' ' : '') + s.summary, body: s.textContent,
      });
      if (s.customTitle) namesToSet.push({ id: s.sessionId, name: s.customTitle });
    }
    changed = true;
  }

  // Remove sessions whose .jsonl files were deleted
  for (const sessionId of cachedMap.keys()) {
    if (!currentIds.has(sessionId)) {
      sessionsToDelete.push(sessionId);
      changed = true;
    }
  }

  // Batch all DB writes to reduce lock contention
  if (sessionsToUpsert.length > 0) {
    upsertCachedSessions(sessionsToUpsert);
  }
  for (const entry of searchEntriesToUpsert) {
    deleteSearchSession(entry.id);
  }
  if (searchEntriesToUpsert.length > 0) {
    upsertSearchEntries(searchEntriesToUpsert);
  }
  for (const { id, name } of namesToSet) {
    setName(id, name);
  }
  for (const sessionId of sessionsToDelete) {
    deleteCachedSession(sessionId);
    deleteSearchSession(sessionId);
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

  // Group by folder (worktree sessions appear as separate projects).
  // Only insert a project entry once we have a session that survives the
  // archive filter — otherwise folders whose sessions are all archived would
  // appear in the sidebar as undismissable phantom entries.
  const projectMap = new Map();
  for (const row of cachedRows) {
    if (hiddenProjects.has(row.projectPath)) continue;
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
    if (!projectMap.has(row.folder)) {
      projectMap.set(row.folder, { folder: row.folder, projectPath: row.projectPath, sessions: [] });
    }
    projectMap.get(row.folder).sessions.push(s);
  }

  // Include empty project directories (no sessions yet)
  try {
    const dirs = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true })
      .filter(d => d.isDirectory() && d.name !== '.git');
    for (const d of dirs) {
      if (!projectMap.has(d.name)) {
        const projectPath = deriveProjectPath(path.join(PROJECTS_DIR, d.name), d.name);
        if (projectPath && !hiddenProjects.has(projectPath)) {
          projectMap.set(d.name, { folder: d.name, projectPath, sessions: [] });
        }
      }
    }
  } catch {}

  // Inject active plain terminal sessions so they participate in sorting
  for (const [sessionId, session] of activeSessions) {
    if (session.exited || !session.isPlainTerminal) continue;
    const folder = encodeProjectPath(session.projectPath);
    if (hiddenProjects.has(session.projectPath)) continue;
    if (!projectMap.has(folder)) {
      projectMap.set(folder, { folder, projectPath: session.projectPath, sessions: [] });
    }
    const proj = projectMap.get(folder);
    if (!proj.sessions.some(s => s.sessionId === sessionId)) {
      proj.sessions.push({
        sessionId, summary: 'Terminal', firstPrompt: '', projectPath: session.projectPath,
        name: null, starred: 0, archived: 0, messageCount: 0,
        modified: new Date(session._openedAt).toISOString(),
        created: new Date(session._openedAt).toISOString(),
        type: 'terminal',
      });
    }
  }

  const projects = [];
  for (const proj of projectMap.values()) {
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


function notifyRendererProjectsChanged() {
  const mainWindow = getMainWindow();
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('projects-changed');
  }
}

function sendStatus(text, type) {
  if (text) log.info(`[status] (${type || 'info'}) ${text}`);
  const mw = getMainWindow();
  if (mw && !mw.isDestroyed()) {
    mw.webContents.send('status-update', text, type || 'info');
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
        for (const s of sessions) {
          if (s.customTitle) setName(s.sessionId, s.customTitle);
        }
        upsertSearchEntries(sessions.map(s => {
          // customTitle comes from jsonl; fall back to session_meta.name (set via rename)
          const name = s.customTitle || getMeta(s.sessionId)?.name || '';
          return {
            id: s.sessionId, type: 'session', folder: s.folder,
            title: (name ? name + ' ' : '') + s.summary,
            body: s.textContent,
          };
        }));
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

  // If the worker exits abnormally (SIGSEGV, OOM, uncaught exception) without
  // sending a message, neither the 'message' nor 'error' handler will fire.
  // Reset the flag here to prevent a permanent lockout where the session list
  // stays empty because populateCacheViaWorker() returns immediately.
  worker.on('exit', (code) => {
    if (populatingCache) {
      populatingCache = false;
      if (code !== 0) {
        sendStatus('Scan worker exited unexpectedly', 'error');
      }
    }
  });
}

module.exports = {
  init,
  readSessionFile,
  readFolderFromFilesystem,
  refreshFolder,
  populateCacheFromFilesystem,
  buildProjectsFromCache,
  notifyRendererProjectsChanged,
  sendStatus,
  populateCacheViaWorker,
};
