const path = require('path');
const fs = require('fs');
const { Worker } = require('worker_threads');
const { getFolderIndexMtimeMs } = require('./folder-index-state');
const { encodeProjectPath } = require('./encode-project-path');
const { getHarness, DEFAULT_HARNESS, harnessForFolder, availableHarnesses } = require('./harnesses');

const claude = getHarness(DEFAULT_HARNESS);
const { deriveProjectPath, readSessionFile } = claude;

/**
 * Folder key → the directory holding its transcripts.
 *
 * Claude's root is the injected PROJECTS_DIR, not claude.sessionsRoot(): init()
 * is handed that path so tests and the dev data-dir override can repoint it, and
 * resolving through the harness default would quietly ignore them. Prefixed keys
 * belong to a harness with a fixed root of its own, so those do go through it.
 */
function resolveFolderPath(folder) {
  const h = harnessForFolder(folder);
  if (!h.folderPrefix) return path.join(PROJECTS_DIR, folder);
  return h.folderPath(String(folder).slice(h.folderPrefix.length));
}

/**
 * Session cache module.
 * Call init(ctx) once with the shared context object.
 */
let PROJECTS_DIR, activeSessions, getMainWindow, log;
let deleteCachedFolder, getCachedByFolder, getCachedSession, upsertCachedSessions, deleteCachedSession;
let deleteSearchFolder, deleteSearchSession, upsertSearchEntries;
let setFolderMeta, getAllFolderMeta, getAllMeta, getAllCached, getSetting, setSetting, getMeta, setName;
let updateCachedAiTitle, updateSearchTitle;
let indexer = null;
let withImmediateTransaction = null;

function init(ctx) {
  indexer = ctx.indexer || null;
  withImmediateTransaction = ctx.db.withImmediateTransaction || null;
  PROJECTS_DIR = ctx.PROJECTS_DIR;
  activeSessions = ctx.activeSessions;
  getMainWindow = ctx.getMainWindow;
  log = ctx.log;
  // DB functions
  deleteCachedFolder = ctx.db.deleteCachedFolder;
  getCachedByFolder = ctx.db.getCachedByFolder;
  getCachedSession = ctx.db.getCachedSession;
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
  setSetting = ctx.db.setSetting;
  getMeta = ctx.db.getMeta;
  setName = ctx.db.setName;
  updateCachedAiTitle = ctx.db.updateCachedAiTitle;
  updateSearchTitle = ctx.db.updateSearchTitle;
  inlineReadLimitBytes = ctx.inlineReadLimitBytes ?? INLINE_READ_LIMIT_BYTES;
  backgroundReadFailed = false;
}

/**
 * Give hidden projects from older builds a baseline time. Without one, the
 * first ordinary rescan after upgrading could mistake an old transcript for a
 * newly-created session and immediately undo the user's hide choice.
 */
function initializeHiddenProjectTimestamps(now = Date.now()) {
  const global = getSetting('global') || {};
  const hidden = Array.isArray(global.hiddenProjects) ? global.hiddenProjects : [];
  const timestamps = (global.hiddenProjectTimestamps
    && typeof global.hiddenProjectTimestamps === 'object'
    && !Array.isArray(global.hiddenProjectTimestamps))
    ? { ...global.hiddenProjectTimestamps }
    : {};
  let changed = false;

  for (const projectPath of hidden) {
    if (!Number.isFinite(Number(timestamps[projectPath]))) {
      timestamps[projectPath] = now;
      changed = true;
    }
  }
  for (const projectPath of Object.keys(timestamps)) {
    if (!hidden.includes(projectPath)) {
      delete timestamps[projectPath];
      changed = true;
    }
  }

  if (changed) {
    global.hiddenProjectTimestamps = timestamps;
    setSetting('global', global);
  }
}

/**
 * Restore a hidden project when indexing finds a transcript file created after
 * the project was hidden. File birth time distinguishes a new session from an
 * old hidden session merely receiving more output; transcript `created` is a
 * second signal for filesystems with coarse or unavailable birth times.
 */
function restoreProjectsWithNewSessions(sessions) {
  if (withImmediateTransaction) {
    const hidden = new Set((getSetting('global') || {}).hiddenProjects || []);
    if (!sessions.some(s => hidden.has(s.projectPath))) return [];
    return withImmediateTransaction(() => restoreProjectsWithNewSessionsImpl(sessions));
  }
  return restoreProjectsWithNewSessionsImpl(sessions);
}

function restoreProjectsWithNewSessionsImpl(sessions) {
  if (!sessions.length) return [];

  const global = getSetting('global') || {};
  const hidden = new Set(global.hiddenProjects || []);
  if (!hidden.size) return [];
  const timestamps = global.hiddenProjectTimestamps || {};
  const restored = new Set();

  for (const session of sessions) {
    if (!hidden.has(session.projectPath)) continue;
    const hiddenAt = Number(timestamps[session.projectPath]);
    if (!Number.isFinite(hiddenAt)) continue;

    const creationTimes = [];
    if (session.sessionFile) {
      try {
        const birthtimeMs = fs.statSync(session.sessionFile).birthtimeMs;
        if (Number.isFinite(birthtimeMs) && birthtimeMs > 0) creationTimes.push(birthtimeMs);
      } catch {}
    }
    const transcriptCreatedAt = Date.parse(session.created);
    if (Number.isFinite(transcriptCreatedAt)) creationTimes.push(transcriptCreatedAt);
    const createdAt = creationTimes.length ? Math.max(...creationTimes) : NaN;

    if (Number.isFinite(createdAt) && createdAt >= hiddenAt) {
      restored.add(session.projectPath);
    }
  }

  if (!restored.size) return [];
  global.hiddenProjects = [...hidden].filter(projectPath => !restored.has(projectPath));
  const nextTimestamps = { ...timestamps };
  for (const projectPath of restored) delete nextTimestamps[projectPath];
  global.hiddenProjectTimestamps = nextTimestamps;
  setSetting('global', global);
  for (const projectPath of restored) log.info(`[projects] restored hidden project after new session: ${projectPath}`);
  return [...restored];
}

/**
 * Pull titles stored outside transcripts into the shared cache.
 *
 * Codex writes automatic names and `/rename` changes to session_index.jsonl,
 * not to a rollout. Keeping them in aiTitle preserves the established title
 * precedence: a name set in Switchboard still wins, while Codex's latest title
 * wins over the first-prompt summary.
 */
function refreshHarnessTitles(harness) {
  if (indexer) { indexer.titles(harness.id); return 0; }
  if (!harness?.readSessionTitles || !updateCachedAiTitle) return 0;
  const titles = harness.readSessionTitles();
  if (!(titles instanceof Map)) return 0; // unreadable: retain the last good data

  const metaMap = getAllMeta();
  let changed = 0;
  for (const row of getAllCached()) {
    if ((row.runtime || DEFAULT_HARNESS) !== harness.id) continue;
    const title = titles.get(row.sessionId) || null;
    if ((row.aiTitle || null) === title) continue;

    changed += updateCachedAiTitle(row.sessionId, title, harness.id);
    if (updateSearchTitle) {
      const displayTitle = metaMap.get(row.sessionId)?.name || title || '';
      updateSearchTitle(row.sessionId, 'session', (displayTitle ? displayTitle + ' ' : '') + (row.summary || ''));
    }
  }
  return changed;
}

/**
 * Which harnesses the user has switched off in settings.
 *
 * A disabled harness is not scanned and its sessions are not listed, but its
 * cached rows stay in the database — so switching it back on is an incremental
 * reconcile, not a full re-index.
 */
function disabledHarnessIds() {
  const global = getSetting('global') || {};
  return new Set(global.disabledHarnesses || []);
}

/**
 * Every folder key worth indexing, across every harness available here.
 *
 * Claude's come from the injected PROJECTS_DIR rather than its own root, for
 * the same reason resolveFolderPath does — see the note there. A harness whose
 * home directory is missing contributes nothing and costs one existsSync.
 */
function listAllFolders() {
  const disabled = disabledHarnessIds();
  const folders = [];
  if (!disabled.has(DEFAULT_HARNESS)) {
    try {
      for (const d of fs.readdirSync(PROJECTS_DIR, { withFileTypes: true })) {
        if (d.isDirectory() && d.name !== '.git') folders.push(d.name);
      }
    } catch {}
  }
  for (const h of availableHarnesses()) {
    if (!h.folderPrefix) continue; // the unprefixed namespace is PROJECTS_DIR, above
    if (disabled.has(h.id)) continue;
    try { folders.push(...h.listFolders()); } catch {}
  }
  return folders;
}

/**
 * Work out what refreshing a folder involves without reading a transcript:
 * which files are new or changed (stat only) and which cached sessions lost
 * their file. Null when the folder has nothing to index.
 */
function planFolderRefresh(folder, force = false) {
  const h = harnessForFolder(folder);
  const folderPath = resolveFolderPath(folder);
  if (!fs.existsSync(folderPath)) {
    deleteCachedFolder(folder);
    deleteSearchFolder(folder);
    return null;
  }
  // Never mark writes that arrive during this pass as already indexed. The
  // Claude parser deliberately stops at its initial file size; a later append
  // must remain visible to reconciliation even if its watcher event is missed.
  const indexMtimeMs = getFolderIndexMtimeMs(folderPath);

  // For Claude a folder IS a project, and one with no readable cwd is unusable.
  // A codex folder is a date spanning many projects, so there is no folder-level
  // project to derive — each transcript carries its own, and folderProject stays
  // null (which is also what cache_meta records for it).
  const folderProject = h.deriveProjectPath(folderPath, folder);
  if (h.groupsByProject && !folderProject) {
    setFolderMeta(folder, null, indexMtimeMs);
    return null;
  }

  // Get what's currently cached for this folder
  const cachedSessions = getCachedByFolder(folder);
  const cachedMap = new Map(); // sessionId → fileMtime ISO string (invalidation key)
  for (const row of cachedSessions) {
    cachedMap.set(row.sessionId, row.fileMtime);
  }

  const currentIds = new Set();
  const toRead = [];

  for (const filePath of h.listTranscripts(folderPath)) {
    // Derived from the file name, so this costs no read — which is the whole
    // point of the mtime gate below.
    const sessionId = h.sessionIdFromPath(filePath);
    if (!sessionId) continue;
    currentIds.add(sessionId);

    // Check if file mtime changed
    let stat;
    try { stat = fs.statSync(filePath); } catch { continue; }

    if (!force && cachedMap.has(sessionId) && cachedMap.get(sessionId) === stat.mtime.toISOString()) {
      continue; // unchanged, skip
    }
    toRead.push({ filePath, sessionId, size: stat.size });
  }

  // Sessions whose transcripts were deleted
  const removedIds = [...cachedMap.keys()].filter(sessionId => !currentIds.has(sessionId));

  return { folder, harnessId: h.id, folderProject, indexMtimeMs, toRead, removedIds };
}

/** Read a plan's new or changed transcripts on this thread. */
function readPlannedSessions(plan) {
  const h = getHarness(plan.harnessId);
  const sessions = [];
  for (const { filePath, sessionId } of plan.toRead) {
    // The cached row carries the resume state, so an append costs the size of
    // the append rather than the size of the file. Fetched per changed session
    // on purpose: a folder holds thousands of sessions and only a couple
    // change per flush.
    const sess = h.readSessionFile(filePath, plan.folder, plan.folderProject, getCachedSession(sessionId));
    if (sess) sessions.push(sess);
  }
  return sessions;
}

/** Write a planned folder's freshly read sessions and its removals. */
function applyFolderRefresh(plan, sessions, finalize = true) {
  // Cache rows and their search documents must commit together. Otherwise a
  // worker stopped between the two writes could leave an apparently current
  // transcript permanently absent from search on the next pass.
  if (withImmediateTransaction) {
    return withImmediateTransaction(() => applyFolderRefreshImpl(plan, sessions, finalize));
  }
  return applyFolderRefreshImpl(plan, sessions, finalize);
}

function applyFolderRefreshImpl(plan, sessions, finalize) {
  const searchEntriesToUpsert = [];
  const namesToSet = [];
  for (const sess of sessions) {
    // Title precedence: user rename (session_meta.name) > JSONL custom-title > JSONL ai-title.
    // Only customTitle (Claude /title) promotes to session_meta.name — AI titles must NEVER
    // be written there or they'd overwrite the user's UI rename on the next index pass.
    const name = getMeta(sess.sessionId)?.name || sess.customTitle || sess.aiTitle || '';
    searchEntriesToUpsert.push({
      id: sess.sessionId, type: 'session', folder: sess.folder,
      title: (name ? name + ' ' : '') + sess.summary, body: sess.textContent,
    });
    if (sess.customTitle) namesToSet.push({ id: sess.sessionId, name: sess.customTitle });
  }

  // Batch all DB writes to reduce lock contention
  if (sessions.length > 0) {
    upsertCachedSessions(sessions);
  }
  if (searchEntriesToUpsert.length > 0) {
    // The DB upsert compares the existing content and replaces changed rows
    // atomically. Deleting first would force tool-only updates to reindex.
    upsertSearchEntries(searchEntriesToUpsert);
  }
  for (const { id, name } of namesToSet) {
    setName(id, name);
  }
  for (const sessionId of finalize ? plan.removedIds : []) {
    deleteCachedSession(sessionId);
    deleteSearchSession(sessionId);
  }

  restoreProjectsWithNewSessions(sessions);

  // Update folder mtime
  if (finalize) setFolderMeta(plan.folder, plan.folderProject, plan.indexMtimeMs);
}

/** Refresh a single folder incrementally: only re-read changed/new transcripts */
function refreshFolder(folder) {
  if (indexer) return indexer.folder(folder);
  const plan = planFolderRefresh(folder);
  if (plan) applyFolderRefresh(plan, readPlannedSessions(plan));
}

// A reconcile pass that has to re-read more than this many bytes of
// transcripts reads them on a worker thread. Ordinary passes re-read a few
// changed files and stay inline. A cleared cache can mean gigabytes (a Codex
// transcript is re-read whole), which would stall the window and terminals.
const INLINE_READ_LIMIT_BYTES = 64 * 1024 * 1024;
let inlineReadLimitBytes = INLINE_READ_LIMIT_BYTES;
let backgroundRead = null; // resolves when the worker has reported every folder
const backgroundFolders = new Set(); // folders the worker owns until it reports them
let backgroundReadFailed = false; // after a worker failure, read inline as before

/**
 * Read the planned transcripts on a worker thread. The database lives on this
 * thread, so each folder's sessions are written here as the worker reports it.
 */
function readInBackground(plans) {
  const total = plans.reduce((n, plan) => n + plan.toRead.length, 0);
  for (const plan of plans) backgroundFolders.add(plan.folder);
  sendStatus(`Reading ${total} sessions…`, 'active');

  return new Promise(resolve => {
    const worker = new Worker(path.join(__dirname, 'workers', 'read-transcripts.js'), {
      workerData: {
        plans: plans.map(plan => ({
          folder: plan.folder, harnessId: plan.harnessId, folderProject: plan.folderProject,
          files: plan.toRead.map(({ filePath, sessionId }) => ({ filePath, prev: getCachedSession(sessionId) })),
        })),
      },
    });

    let finished = false;
    function finish(error) {
      if (finished) return;
      finished = true;
      // Folders the worker never reported are planned again by the next pass.
      backgroundFolders.clear();
      backgroundRead = null;
      if (error) {
        backgroundReadFailed = true;
        console.error('Background session read failed:', error);
        sendStatus('Reading sessions failed: ' + error, 'error');
      } else {
        sendStatus(`Read ${total} sessions`, 'done');
        setTimeout(() => sendStatus(''), 5000).unref?.();
      }
      notifyRendererProjectsChanged('sessions');
      resolve();
    }

    worker.on('message', (msg) => {
      if (msg.type === 'done') { finish(); return; }
      if (msg.type !== 'folder') return;
      const plan = plans[msg.index];
      if (msg.error) {
        console.error('Error reconciling folder', plan.folder, msg.error);
      } else {
        try {
          // A transcript written to after the worker read it is left for the
          // next pass: its cached mtime stays stale, so it is read again.
          const sessions = msg.sessions.filter(s => {
            try { return fs.statSync(s.sessionFile).mtime.toISOString() === s.fileMtime; } catch { return false; }
          });
          applyFolderRefresh(plan, sessions);
          refreshHarnessTitles(getHarness(plan.harnessId));
        } catch (err) {
          console.error('Error reconciling folder', plan.folder, err);
        }
      }
      backgroundFolders.delete(plan.folder);
    });
    worker.on('error', (err) => finish(err.message));
    worker.on('exit', (code) => finish(code === 0 ? null : `worker exited with code ${code}`));
  });
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
 *
 * When the pass has more than INLINE_READ_LIMIT_BYTES to re-read, the reads
 * run on a worker and this returns a promise that settles once they are
 * written; otherwise everything is written before it returns null.
 */
function reconcileCacheFromFilesystem() {
  if (indexer) return indexer.reconcile();
  const metaMap = getAllFolderMeta();
  const plans = [];

  for (const folder of listAllFolders()) {
    if (backgroundFolders.has(folder)) continue;
    try {
      const meta = metaMap.get(folder);
      const folderPath = resolveFolderPath(folder);
      if (!meta || getFolderIndexMtimeMs(folderPath) > (meta.indexMtimeMs || 0)) {
        const plan = planFolderRefresh(folder);
        if (plan) plans.push(plan);
      }
    } catch (err) {
      // One unreadable folder must not stop the rest — before this loop was
      // per-harness, a single bad directory aborted the whole pass.
      console.error('Error reconciling folder', folder, err);
    }
  }

  const bytesToRead = plans.reduce((sum, plan) => sum + plan.toRead.reduce((n, f) => n + f.size, 0), 0);
  const inBackground = bytesToRead > inlineReadLimitBytes && !backgroundReadFailed;
  if (inBackground && !backgroundRead) {
    backgroundRead = readInBackground(plans.filter(plan => plan.toRead.length));
  }
  for (const plan of plans) {
    // While another worker is still busy, these wait for a later pass.
    if (inBackground && plan.toRead.length) continue;
    try {
      applyFolderRefresh(plan, readPlannedSessions(plan));
    } catch (err) {
      console.error('Error reconciling folder', plan.folder, err);
    }
  }

  // Some harness metadata changes without touching a transcript. This remains
  // necessary even when every folder above was skipped by the mtime gate.
  const disabled = disabledHarnessIds();
  for (const h of availableHarnesses()) {
    if (!disabled.has(h.id)) refreshHarnessTitles(h);
  }
  return backgroundRead;
}

/** Build projects response from cached data */
function buildProjectsFromCache(showArchived) {
  const metaMap = getAllMeta();
  const cachedRows = getAllCached();
  const global = getSetting('global') || {};
  const hiddenProjects = new Set(global.hiddenProjects || []);
  const disabledHarnesses = new Set(global.disabledHarnesses || []);

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
    // Rows written before the runtime column existed are Claude's.
    if (disabledHarnesses.has(row.runtime || DEFAULT_HARNESS)) continue;
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
      runtime: row.runtime || DEFAULT_HARNESS,
      name: meta?.name || null,
      starred: meta?.starred || 0,
      archived: meta?.archived || 0,
      // Explicit filing into a project / track (projects.js). Null when the
      // session was never filed; the tree builder then falls back to cwd.
      projectId: meta?.projectId || null,
      trackId: meta?.trackId || null,
      formerTrackName: meta?.formerTrackName || null,
      // Started by a schedule (projects.js recordScheduleRun): the row shows a
      // clock chip with the schedule's name and the time it fired.
      scheduleId: meta?.scheduleId || null,
      scheduledAt: meta?.scheduledAt || null,
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
    const dirs = indexer
      ? [...folderMeta.keys()].filter(folder => !harnessForFolder(folder).folderPrefix).map(name => ({ name }))
      : fs.readdirSync(PROJECTS_DIR, { withFileTypes: true })
        .filter(d => d.isDirectory() && d.name !== '.git');
    for (const d of dirs) {
      let projectPath = folderMeta.get(d.name)?.projectPath;
      if (!projectPath && !indexer) {
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
        projectId: session.projectId || null,
        trackId: session.trackId || null,
        formerTrackName: session.formerTrackName || null,
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


/**
 * Tell the renderer the project data moved. `reason` is 'sessions' when only
 * the session list did — a transcript write, a title, a folder rescan. That
 * fires several times a minute while a session runs, and the project page
 * patches itself instead of rebuilding. Anything else defaults to 'project'.
 */
function notifyRendererProjectsChanged(reason = 'project') {
  const mainWindow = getMainWindow();
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('projects-changed', reason === 'sessions' ? 'sessions' : 'project');
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
  if (indexer) return indexer.populate();
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
      restoreProjectsWithNewSessions(sessions);
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

// Used only inside the indexing worker. No transcript bodies cross back to the
// main process. Each small commit releases SQLite's writer lock, then rests so
// startup indexing does not monopolize CPU or disk bandwidth.
async function indexFoldersInWorker({ folders, force = false, progress = () => {}, pauseMs = 10 } = {}) {
  const metaMap = getAllFolderMeta();
  const allFolders = folders || listAllFolders();
  let count = 0;
  let changed = false;
  const externalTitles = new Map();
  for (let i = 0; i < allFolders.length; i++) {
    const folder = allFolders[i];
    const meta = metaMap.get(folder);
    if (!force && !folders && meta && fs.existsSync(resolveFolderPath(folder)) &&
        getFolderIndexMtimeMs(resolveFolderPath(folder)) <= (meta.indexMtimeMs || 0)) continue;
    progress({ text: `Indexing folders (${i + 1}/${allFolders.length})…`, count });
    try {
      const plan = planFolderRefresh(folder, force);
      if (!plan) { changed = true; continue; }
      const h = getHarness(plan.harnessId);
      if (!externalTitles.has(h.id)) externalTitles.set(h.id, h.readSessionTitles?.() || null);
      let batch = [];
      let bytes = 0;
      let stable = true;
      let batchStarted = Date.now();
      const flush = async () => {
        if (batch.length) {
          applyFolderRefresh(plan, batch, false);
          count += batch.length;
          changed = true;
          batch = [];
          bytes = 0;
        }
        // Rest for at least a quarter of the preceding work time as well as
        // yielding between small batches. Very large single files still stay
        // off the UI thread, and do not cause more workers to be spawned.
        await new Promise(resolve => setTimeout(resolve, Math.max(pauseMs, (Date.now() - batchStarted) / 3)));
        batchStarted = Date.now();
      };
      for (const { filePath, sessionId } of plan.toRead) {
        const s = h.readSessionFile(filePath, folder, plan.folderProject, getCachedSession(sessionId));
        if (!s) continue;
        // Include external titles in the first FTS insert, rather than
        // rewriting every Codex search document again after the initial scan.
        const titles = externalTitles.get(h.id);
        if (titles instanceof Map) s.aiTitle = titles.get(s.sessionId) || null;
        // A growing transcript must remain eligible for the next pass.
        try {
          if (fs.statSync(filePath).mtime.toISOString() !== s.fileMtime) stable = false;
        } catch { stable = false; }
        batch.push(s);
        bytes += Buffer.byteLength(s.textContent || '', 'utf8');
        if (batch.length >= 8 || bytes >= 512 * 1024) await flush();
      }
      await flush();
      // Preserve the old folder watermark when a file changed during its read.
      // Its cached parser state still makes the next read incremental.
      if (!stable) plan.indexMtimeMs = meta?.indexMtimeMs || 0;
      applyFolderRefresh(plan, []);
      if (plan.removedIds.length) changed = true;
    } catch (err) {
      log.error('Error indexing folder', folder, err);
      throw err;
    }
  }
  for (const h of availableHarnesses()) {
    if (!disabledHarnessIds().has(h.id) && refreshHarnessTitles(h)) changed = true;
  }
  return { count, changed };
}

module.exports = {
  indexFoldersInWorker,
  init,
  refreshFolder,
  reconcileCacheFromFilesystem,
  buildProjectsFromCache,
  notifyRendererProjectsChanged,
  sendStatus,
  populateCacheViaWorker,
  refreshHarnessTitles,
  initializeHiddenProjectTimestamps,
};
