// analytics.js — main-process orchestrator for the analytics worker.
//
// Responsibilities:
//   - Hold the cached aggregate in memory + persist it to <userData>/analytics-cache.json
//   - Schedule worker runs: full at startup, incremental on file change + every 5min
//   - Coalesce simultaneous refresh requests so we never run two workers at once
//   - Expose IPC handlers + emit `analytics-updated` events to the renderer
//
// The cache itself lives separately from existing stats-cache.json so we
// don't fight Claude CLI's own cache file.

const { Worker } = require('worker_threads');
const fs = require('fs');
const path = require('path');
const os = require('os');

const SCAN_DEBOUNCE_MS = 4000;
const PERIODIC_REFRESH_MS = 5 * 60 * 1000;
const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');

let _logger = null;
let _mainWindow = null;
let _cachePath = null;
let _cache = null;
let _running = false;
let _pending = false;
let _watcher = null;
let _debounceTimer = null;
let _periodicTimer = null;

function setMainWindowProvider(getter) { _getMain = getter; }
let _getMain = () => _mainWindow;

function cachePath() {
  if (_cachePath) return _cachePath;
  const { app } = require('electron');
  _cachePath = path.join(app.getPath('userData'), 'analytics-cache.json');
  return _cachePath;
}

function loadCache() {
  try {
    const raw = fs.readFileSync(cachePath(), 'utf8');
    const data = JSON.parse(raw);
    if (data && data.version === 1 && data.totals) return data;
  } catch {}
  return null;
}

function saveCache(cache) {
  try {
    const target = cachePath();
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const tmp = target + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(cache));
    fs.renameSync(tmp, target);
  } catch (err) {
    if (_logger) _logger.error('[analytics] cache write failed:', err.message);
  }
}

function emitUpdate() {
  const win = _getMain();
  if (win && !win.isDestroyed()) {
    try { win.webContents.send('analytics-updated'); } catch {}
  }
}

function runWorker(opts) {
  if (_running) {
    _pending = true;
    return;
  }
  if (!fs.existsSync(PROJECTS_DIR)) {
    if (_logger) _logger.info('[analytics] projects dir does not exist yet — skipping');
    return;
  }
  _running = true;

  let sessionProfiles = {};
  try { sessionProfiles = require('./session-profiles').getAllMappings() || {}; } catch {}

  const fullScan = !!opts.fullScan;
  const startedAt = Date.now();

  const worker = new Worker(path.join(__dirname, 'workers', 'analytics-worker.js'), {
    workerData: {
      projectsDir: PROJECTS_DIR,
      sessionProfiles,
      prevCache: fullScan ? null : _cache,
      fullScan,
    },
  });

  worker.on('message', (msg) => {
    if (msg && msg.type === 'progress') return;  // ignore for now
    if (msg && msg.ok && msg.cache) {
      _cache = msg.cache;
      saveCache(_cache);
      const ms = Date.now() - startedAt;
      if (_logger) _logger.info(`[analytics] ${fullScan ? 'full' : 'incremental'} scan done in ${ms}ms`);
      emitUpdate();
    } else if (msg && msg.error) {
      if (_logger) _logger.error('[analytics] worker error:', msg.error);
    }
  });
  worker.on('error', (err) => {
    if (_logger) _logger.error('[analytics] worker thread error:', err.message);
  });
  worker.on('exit', () => {
    _running = false;
    if (_pending) {
      _pending = false;
      // Coalesce: run one incremental to catch up, never a chain of fulls.
      runWorker({ fullScan: false });
    }
  });
}

function scheduleIncremental() {
  if (_debounceTimer) clearTimeout(_debounceTimer);
  _debounceTimer = setTimeout(() => {
    _debounceTimer = null;
    runWorker({ fullScan: false });
  }, SCAN_DEBOUNCE_MS);
  if (_debounceTimer.unref) _debounceTimer.unref();
}

function startWatcher() {
  if (_watcher || !fs.existsSync(PROJECTS_DIR)) return;
  try {
    _watcher = fs.watch(PROJECTS_DIR, { recursive: true }, (_eventType, filename) => {
      if (filename && filename.endsWith('.jsonl')) scheduleIncremental();
    });
    _watcher.on('error', (err) => {
      if (_logger) _logger.warn('[analytics] watcher error:', err.message);
    });
  } catch (err) {
    if (_logger) _logger.warn('[analytics] could not start watcher:', err.message);
  }
}

function startPeriodic() {
  if (_periodicTimer) return;
  _periodicTimer = setInterval(() => runWorker({ fullScan: false }), PERIODIC_REFRESH_MS);
  if (_periodicTimer.unref) _periodicTimer.unref();
}

function init(log, getMainWindow) {
  _logger = log;
  if (typeof getMainWindow === 'function') _getMain = getMainWindow;
  const { ipcMain } = require('electron');

  _cache = loadCache();

  ipcMain.handle('analytics:get-cache', () => _cache || null);
  ipcMain.handle('analytics:refresh', (_e, opts) => {
    runWorker({ fullScan: !!(opts && opts.fullScan) });
    return { ok: true };
  });

  // Kick a full scan on startup if we have nothing cached, otherwise an
  // incremental to catch up. Either way the renderer gets the cached
  // version instantly via get-cache + the fresh version via the event.
  if (!_cache) {
    runWorker({ fullScan: true });
  } else {
    runWorker({ fullScan: false });
  }
  startWatcher();
  startPeriodic();
}

module.exports = { init, setMainWindowProvider };
