const path = require('path');
const fs = require('fs');
const { Worker } = require('worker_threads');
const { getFolderIndexMtimeMs } = require('./folder-index-state');
const { deriveProjectPath } = require('./derive-project-path');
const { readSessionFile, enumerateSessionFiles, resolveJsonlPath } = require('./read-session-file');
const { encodeProjectPath } = require('./encode-project-path');

/**
 * Session cache module.
 * Call init(ctx) once with the shared context object.
 */
let PROJECTS_DIR, activeSessions, getMainWindow, log;
let deleteCachedFolder, getCachedByFolder, upsertCachedSessions, deleteCachedSession;
let deleteSearchFolder, deleteSearchSession, upsertSearchEntries;
let setFolderMeta, getAllFolderMeta, getAllMeta, getAllCached, getSetting, getMeta, setName;

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
  getAllFolderMeta = ctx.db.getAllFolderMeta;
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

  for (const { filePath, parentSessionId } of enumerateSessionFiles(folderPath)) {
    const s = readSessionFile(filePath, folder, projectPath, { parentSessionId });
    if (s) sessions.push(s);
  }

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

  // Get what's currently cached for this folder.
  // cachedMap: DB sessionId → { modified, filePath } so we can do mtime comparison
  // even for subagents whose DB sessionId differs from the on-disk filename.
  const cachedSessions = getCachedByFolder(folder);
  const cachedMap = new Map(); // DB sessionId → { modified, filePath }
  for (const row of cachedSessions) {
    cachedMap.set(row.sessionId, {
      modified: row.modified,
      filePath: resolveJsonlPath(PROJECTS_DIR, row),
    });
  }

  const currentIds = new Set();
  let changed = false;

  // Collect all changes first, then batch DB writes to minimize lock duration
  const sessionsToUpsert = [];
  const searchEntriesToUpsert = [];
  const namesToSet = [];
  const sessionsToDelete = [];

  for (const { filePath, parentSessionId } of enumerateSessionFiles(folderPath)) {
    // Check if file mtime changed.
    // We need the DB sessionId to look up the cache, but we don't know it until after
    // readSessionFile — for subagents it's sub:<parent>:<agentId>. Use the file path
    // to find a matching cached entry instead.
    let fileMtime;
    try { fileMtime = fs.statSync(filePath).mtime.toISOString(); } catch { continue; }

    // Find cached entry by file path (handles both top-level and subagent IDs)
    let cachedEntry = null;
    let cachedDbId = null;
    for (const [dbId, entry] of cachedMap) {
      if (entry.filePath === filePath) {
        cachedEntry = entry;
        cachedDbId = dbId;
        break;
      }
    }

    if (cachedDbId !== null) currentIds.add(cachedDbId);

    if (cachedEntry && cachedEntry.modified === fileMtime) {
      continue; // unchanged, skip
    }

    // File is new or modified — re-read it
    const s = readSessionFile(filePath, folder, projectPath, { parentSessionId });
    if (s) {
      currentIds.add(s.sessionId); // ensure we don't delete a newly-read subagent row
      sessionsToUpsert.push(s);
      // Title precedence: user rename (session_meta.name) > JSONL custom-title > JSONL ai-title.
      // Only customTitle (Claude /title) promotes to session_meta.name — AI titles must NEVER
      // be written there or they'd overwrite the user's UI rename on the next index pass.
      const name = getMeta(s.sessionId)?.name || s.customTitle || s.aiTitle || '';
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

/**
 * Reconcile the cache with the filesystem.
 *
 * Re-indexes only folders that are new or whose newest .jsonl is newer than what
 * we last indexed — a cheap, stat-only gate when nothing changed. This is what
 * keeps sessions from silently going missing: a project folder that changed while
 * the app was closed, or that predates the build which first indexed it, is
 * otherwise never picked up, because the cold-start full scan
 * (populateCacheViaWorker) only runs when the cache is completely empty.
 */
function reconcileCacheFromFilesystem() {
  try {
    const metaMap = getAllFolderMeta();
    const folders = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true })
      .filter(d => d.isDirectory() && d.name !== '.git')
      .map(d => d.name);

    for (const folder of folders) {
      const meta = metaMap.get(folder);
      const folderPath = path.join(PROJECTS_DIR, folder);
      if (!meta || getFolderIndexMtimeMs(folderPath) > (meta.indexMtimeMs || 0)) {
        refreshFolder(folder);
      }
    }
  } catch (err) {
    console.error('Error reconciling cache:', err);
  }
}

/** Build projects response from cached data */
function buildProjectsFromCache(showArchived) {
  const metaMap = getAllMeta();
  const cachedRows = getAllCached();
  const global = getSetting('global') || {};
  const hiddenProjects = new Set(global.hiddenProjects || []);

  // Group by projectPath, not on-disk folder name. Multiple ~/.claude/projects/<folder>/
  // directories can resolve to the same projectPath (Claude Code's folder-name encoding
  // scheme has changed over time, leaving legacy stragglers around), so we merge them into
  // a single sidebar group to avoid duplicate-id collisions in the morphdom render.
  // Only insert a project entry once we have a session that survives the archive filter —
  // otherwise folders whose sessions are all archived would appear in the sidebar as
  // undismissable phantom entries.
  const projectMap = new Map();
  for (const row of cachedRows) {
    if (!row.projectPath) continue;
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
      aiTitle: row.aiTitle || null,
      parentSessionId: row.parentSessionId || null,
      agentId: row.agentId || null,
      subagentType: row.subagentType || null,
      description: row.description || null,
      name: meta?.name || null,
      starred: meta?.starred || 0,
      archived: meta?.archived || 0,
    };
    if (!showArchived && s.archived) continue;
    if (!projectMap.has(row.projectPath)) {
      projectMap.set(row.projectPath, {
        folder: encodeProjectPath(row.projectPath),
        projectPath: row.projectPath,
        sessions: [],
      });
    }
    projectMap.get(row.projectPath).sessions.push(s);
  }

  // Include empty project directories (no sessions yet). Resolve folder→projectPath
  // through cache_meta (populated by the indexer) instead of re-reading a JSONL off
  // disk for every directory on every render. Fall back to deriveProjectPath only
  // for folders the indexer hasn't seen yet, and backfill cache_meta so subsequent
  // renders are pure DB reads.
  try {
    const folderMeta = getAllFolderMeta();
    const dirs = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true })
      .filter(d => d.isDirectory() && d.name !== '.git');
    for (const d of dirs) {
      let projectPath = folderMeta.get(d.name)?.projectPath;
      if (!projectPath) {
        projectPath = deriveProjectPath(path.join(PROJECTS_DIR, d.name), d.name);
        if (projectPath) setFolderMeta(d.name, projectPath, 0);
      }
      if (!projectPath) continue;
      if (hiddenProjects.has(projectPath)) continue;
      if (!projectMap.has(projectPath)) {
        projectMap.set(projectPath, {
          folder: encodeProjectPath(projectPath),
          projectPath,
          sessions: [],
        });
      }
    }
  } catch {}

  // Inject active plain terminal sessions so they participate in sorting
  for (const [sessionId, session] of activeSessions) {
    if (session.exited || !session.isPlainTerminal) continue;
    if (!session.projectPath) continue;
    if (hiddenProjects.has(session.projectPath)) continue;
    if (!projectMap.has(session.projectPath)) {
      projectMap.set(session.projectPath, {
        folder: encodeProjectPath(session.projectPath),
        projectPath: session.projectPath,
        sessions: [],
      });
    }
    const proj = projectMap.get(session.projectPath);
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

// --- Worker-based cache population ---
// Returns a Promise that resolves when the in-flight scan finishes. Concurrent
// callers share the same Promise so the first get-projects after a migration
// can await it instead of seeing an empty list.
let populatePromise = null;

function populateCacheViaWorker() {
  if (populatePromise) return populatePromise;
  sendStatus('Scanning projects\u2026', 'active');

  populatePromise = new Promise((resolve) => {
    let settled = false;
    const settle = () => {
      if (settled) return;
      settled = true;
      populatePromise = null;
      resolve();
    };

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
      settle();
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
          // Only JSONL custom-title (genuine user title) promotes to the DB name column.
          // AI titles must not — see refreshFolder for the rationale.
          if (s.customTitle) setName(s.sessionId, s.customTitle);
        }
        upsertSearchEntries(sessions.map(s => {
          // Search title precedence matches the sidebar: user rename > custom-title > ai-title.
          const name = getMeta(s.sessionId)?.name || s.customTitle || s.aiTitle || '';
          return {
            id: s.sessionId, type: 'session', folder: s.folder,
            title: (name ? name + ' ' : '') + s.summary,
            body: s.textContent,
          };
        }));
      }
      setFolderMeta(folder, projectPath, indexMtimeMs);
    }

    sendStatus(`Indexed ${sessionCount} sessions across ${msg.results.length} projects`, 'done');
    // Clear status after a few seconds
    setTimeout(() => sendStatus(''), 5000);
    notifyRendererProjectsChanged();
    settle();
  });

  worker.on('error', (err) => {
    console.error('Worker error:', err);
    sendStatus('Worker error: ' + err.message, 'error');
    settle();
  });

  // If the worker exits abnormally (SIGSEGV, OOM, uncaught exception) without
  // sending a message, neither the 'message' nor 'error' handler will fire.
  // Resolve here so awaiters aren't stuck forever and the next call can retry.
  worker.on('exit', (code) => {
    if (!settled && code !== 0) {
      sendStatus('Scan worker exited unexpectedly', 'error');
    }
    settle();
  });
  });
}

module.exports = {
  init,
  readSessionFile,
  readFolderFromFilesystem,
  refreshFolder,
  reconcileCacheFromFilesystem,
  buildProjectsFromCache,
  notifyRendererProjectsChanged,
  sendStatus,
  populateCacheViaWorker,
};
