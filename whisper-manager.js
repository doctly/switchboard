// whisper-manager.js — owns the local whisper.cpp HTTP server.
//
// Two run modes, switched by user via Settings:
//   1. "child" (default) — Switchboard spawns whisper-server.exe as a child
//      process at app start, kills it on app close. Health-checks before
//      reporting ready. No admin needed.
//   2. "scheduled" — User clicked "Install on startup". A Windows logon-
//      triggered scheduled task launches whisper-server in the user's
//      session at every login. Switchboard detects the running server
//      and skips its own spawn.
//
// We deliberately use Scheduled Tasks (schtasks.exe), not Windows
// Services / NSSM. Reasons: services run as SYSTEM by default which
// breaks user-session audio device assumptions, and registering a
// service triggers UAC. A logon scheduled task runs in the user's own
// session, doesn't need admin, and can be removed cleanly with one
// schtasks /Delete call.

const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const { spawn, execFile } = require('child_process');

const TASK_NAME = 'Switchboard-Whisper';
const DEFAULT_PORT = 52391;
const DEFAULT_HOST = '127.0.0.1';
const HEALTH_TIMEOUT_MS = 30000;
const RESTART_BACKOFF_MS = [1000, 2000, 4000, 8000, 16000];
const MAX_LOG_LINES = 200;

// Detected whisper.cpp install paths to try in order. The first one with a
// matching whisper-server.exe is used unless the user overrides via settings.
const WHISPER_BINARY_CANDIDATES = [
  'D:/development/whisper.cpp-src/build/bin/Release/whisper-server.exe',
  'C:/development/whisper.cpp-src/build/bin/Release/whisper-server.exe',
  // Common community install paths — we'll add to this list as we hear of others.
];

const MODEL_FILENAME = 'ggml-large-v3-turbo.bin';
// Model search order, most-specific first:
//   1. Explicit settings override (Settings → Voice → Model Path)
//   2. Same directory as whisper-server.exe (most permissive — works no
//      matter where the user dropped the file)
//   3. <repo-root>/models/ for the standard whisper.cpp project layout
//      (binary at <root>/build/bin/Release/, models at <root>/models/)
//   4. <repo-root>/build/models/ — alternative layouts seen in the wild
//   5. <userData>/whisper-models/ — Switchboard-managed fallback
// We don't auto-download in v1; we surface a clear error and the user
// fetches it via the existing whisper.cpp download-ggml-model script.
function modelSearchPaths(opts, userDataDir) {
  const out = [];
  if (opts.modelPath) out.push(opts.modelPath);
  if (opts.binaryPath) {
    const binDir = path.dirname(opts.binaryPath);
    // 2: alongside the binary
    out.push(path.join(binDir, MODEL_FILENAME));
    // 3: <root>/models/ — for whisper.cpp's canonical layout, that's
    //    4 dirnames up from <root>/build/bin/Release/<exe>.
    const fourUp = path.dirname(path.dirname(path.dirname(path.dirname(opts.binaryPath))));
    out.push(path.join(fourUp, 'models', MODEL_FILENAME));
    // 4: <build>/models/ — 3 dirnames up.
    const threeUp = path.dirname(path.dirname(path.dirname(opts.binaryPath)));
    out.push(path.join(threeUp, 'models', MODEL_FILENAME));
  }
  if (userDataDir) out.push(path.join(userDataDir, 'whisper-models', MODEL_FILENAME));
  return out;
}

let _state = {
  status: 'stopped',     // 'stopped' | 'starting' | 'ready' | 'error'
  error: null,
  port: DEFAULT_PORT,
  host: DEFAULT_HOST,
  binaryPath: null,
  modelPath: null,
  managedBy: 'none',     // 'child' | 'external' | 'none'
  logTail: [],           // last MAX_LOG_LINES from stdout/stderr
  pid: null,
};
let _child = null;
let _restartCount = 0;
let _stopping = false;
let _logger = null;
let _settings = {};
let _userDataDir = null;
let _onStateChange = null;

function getStatus() {
  return {
    status: _state.status,
    error: _state.error,
    port: _state.port,
    host: _state.host,
    binaryPath: _state.binaryPath,
    modelPath: _state.modelPath,
    managedBy: _state.managedBy,
    pid: _state.pid,
    logTail: _state.logTail.slice(-50),
    endpoint: `http://${_state.host}:${_state.port}/inference`,
  };
}

function setState(patch) {
  _state = { ..._state, ...patch };
  if (_onStateChange) {
    try { _onStateChange(getStatus()); } catch {}
  }
}

function pushLog(line) {
  if (!line) return;
  _state.logTail.push(line);
  if (_state.logTail.length > MAX_LOG_LINES) _state.logTail.shift();
}

function findBinary(opts) {
  if (opts && opts.binaryPath && fs.existsSync(opts.binaryPath)) return opts.binaryPath;
  for (const p of WHISPER_BINARY_CANDIDATES) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function findModel(opts, userDataDir) {
  for (const p of modelSearchPaths(opts || {}, userDataDir)) {
    if (p && fs.existsSync(p)) return p;
  }
  return null;
}

// HTTP probe — assumes the server is alive when GET / returns any 2xx/4xx
// (whisper-server returns its index page; even a 404 is fine — means TCP +
// HTTP layer are responsive).
function probe(host, port, timeoutMs) {
  return new Promise((resolve) => {
    const req = http.get({ host, port, path: '/', timeout: timeoutMs || 1500 }, (res) => {
      res.resume();
      resolve(true);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

async function waitUntilReady(host, port, deadlineMs) {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    if (await probe(host, port, 1500)) return true;
    await new Promise(r => setTimeout(r, 400));
  }
  return false;
}

async function detectExternal(host, port) {
  // If something already responds on the configured port, treat it as
  // externally-managed (e.g. user installed the scheduled task, or runs
  // whisper-server themselves) and don't spawn our own.
  return probe(host, port, 1000);
}

async function spawnChild() {
  if (_stopping) return;
  const binary = findBinary(_settings);
  if (!binary) {
    setState({
      status: 'error',
      error: 'whisper-server.exe not found. Set its path in Settings → Voice or build whisper.cpp.',
      managedBy: 'none',
    });
    return;
  }
  // Pass the *discovered* binary path into the model search so binary-
  // relative locations (binary-adjacent dir, project-root models/, etc.)
  // are checked even when the user hasn't pinned a binaryPath in settings.
  const model = findModel({ ..._settings, binaryPath: binary }, _userDataDir);
  if (!model) {
    setState({
      status: 'error',
      error: `Model "${MODEL_FILENAME}" not found. Drop it next to whisper-server, or place it under "${path.join(_userDataDir || '', 'whisper-models')}".`,
      binaryPath: binary,
      managedBy: 'none',
    });
    return;
  }

  setState({
    status: 'starting',
    error: null,
    binaryPath: binary,
    modelPath: model,
    managedBy: 'child',
    pid: null,
  });

  const args = [
    '-m', model,
    '--host', _state.host,
    '--port', String(_state.port),
    // -1 lets ggml pick CPU thread count; default 4 is usually fine on modern boxes.
    '--threads', String(Math.max(4, Math.min(16, os.cpus().length || 4))),
  ];
  if (_settings.extraArgs && Array.isArray(_settings.extraArgs)) args.push(..._settings.extraArgs);

  const child = spawn(binary, args, {
    cwd: path.dirname(binary),
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  _child = child;
  setState({ pid: child.pid });

  child.stdout.on('data', (d) => {
    for (const line of d.toString('utf8').split('\n')) {
      const s = line.trimEnd();
      if (s) pushLog(s);
    }
  });
  child.stderr.on('data', (d) => {
    for (const line of d.toString('utf8').split('\n')) {
      const s = line.trimEnd();
      if (s) pushLog(s);
    }
  });
  child.on('exit', (code, signal) => {
    if (_logger) _logger.info(`[whisper] child exited code=${code} signal=${signal}`);
    _child = null;
    if (_stopping) return;
    // Unexpected exit → backoff restart.
    const delay = RESTART_BACKOFF_MS[Math.min(_restartCount, RESTART_BACKOFF_MS.length - 1)];
    _restartCount++;
    setState({ status: 'error', error: `whisper-server exited (${code}); restarting in ${delay}ms`, pid: null });
    setTimeout(() => { if (!_stopping) spawnChild(); }, delay);
  });
  child.on('error', (err) => {
    if (_logger) _logger.error('[whisper] spawn error:', err.message);
    setState({ status: 'error', error: err.message, pid: null });
  });

  const ready = await waitUntilReady(_state.host, _state.port, HEALTH_TIMEOUT_MS);
  if (ready) {
    _restartCount = 0;
    setState({ status: 'ready', error: null });
    if (_logger) _logger.info(`[whisper] ready at http://${_state.host}:${_state.port}`);
  } else {
    setState({ status: 'error', error: 'whisper-server failed to respond within timeout' });
  }
}

function killChild() {
  _stopping = true;
  if (_child) {
    try { _child.kill(); } catch {}
    _child = null;
  }
  setState({ status: 'stopped', pid: null, managedBy: 'none' });
}

async function start() {
  _stopping = false;
  setState({ port: _settings.port || DEFAULT_PORT, host: _settings.host || DEFAULT_HOST });

  // Externally managed (scheduled task or user-launched)?
  if (await detectExternal(_state.host, _state.port)) {
    const detectedBinary = findBinary(_settings);
    setState({
      status: 'ready',
      error: null,
      managedBy: 'external',
      binaryPath: detectedBinary,
      modelPath: findModel({ ..._settings, binaryPath: detectedBinary }, _userDataDir),
    });
    if (_logger) _logger.info(`[whisper] using externally-managed server at ${_state.host}:${_state.port}`);
    return;
  }

  if (_settings.autoStart === false) {
    setState({ status: 'stopped', managedBy: 'none' });
    return;
  }

  await spawnChild();
}

// ── Scheduled-task install / uninstall (Windows only) ────────────────────
// Runs at user logon, in the user's session (audio + GPU access work).
// No UAC needed because we use /SC ONLOGON (per-user task).

function isWindows() { return process.platform === 'win32'; }

function installScheduledTask() {
  return new Promise((resolve) => {
    if (!isWindows()) return resolve({ ok: false, error: 'scheduled-task install is Windows-only' });
    const binary = findBinary(_settings);
    const model = findModel(_settings, _userDataDir);
    if (!binary) return resolve({ ok: false, error: 'whisper-server.exe not found' });
    if (!model) return resolve({ ok: false, error: 'model file not found' });

    // Build the command line. schtasks /TR wants the full command quoted.
    const cmd = `"${binary}" -m "${model}" --host ${_state.host} --port ${_state.port}`;
    const args = [
      '/Create', '/F',
      '/SC', 'ONLOGON',
      '/TN', TASK_NAME,
      '/TR', cmd,
      '/RL', 'LIMITED',  // user-level, no admin
    ];
    execFile('schtasks.exe', args, { windowsHide: true }, (err, stdout, stderr) => {
      if (err) return resolve({ ok: false, error: (stderr || err.message).trim() });
      resolve({ ok: true });
    });
  });
}

function uninstallScheduledTask() {
  return new Promise((resolve) => {
    if (!isWindows()) return resolve({ ok: false, error: 'scheduled-task uninstall is Windows-only' });
    execFile('schtasks.exe', ['/Delete', '/F', '/TN', TASK_NAME], { windowsHide: true }, (err, _stdout, stderr) => {
      if (err) return resolve({ ok: false, error: (stderr || err.message).trim() });
      resolve({ ok: true });
    });
  });
}

function queryScheduledTask() {
  return new Promise((resolve) => {
    if (!isWindows()) return resolve({ installed: false });
    execFile('schtasks.exe', ['/Query', '/TN', TASK_NAME], { windowsHide: true }, (err, stdout) => {
      if (err) return resolve({ installed: false });
      resolve({ installed: true, info: (stdout || '').trim() });
    });
  });
}

// Run the scheduled task immediately (e.g. after install).
function runScheduledTask() {
  return new Promise((resolve) => {
    if (!isWindows()) return resolve({ ok: false });
    execFile('schtasks.exe', ['/Run', '/TN', TASK_NAME], { windowsHide: true }, (err) => {
      resolve({ ok: !err });
    });
  });
}

// ── Lifecycle ────────────────────────────────────────────────────────────

async function init({ log, app, getMainWindow, ipcMain, getVoiceSettings }) {
  _logger = log;
  _userDataDir = app.getPath('userData');

  // Settings come from the caller — main.js owns the settings store and
  // passes a getter so this module stays decoupled.
  _settings = (typeof getVoiceSettings === 'function' ? getVoiceSettings() : null) || {};

  ipcMain.handle('whisper:status', () => getStatus());
  ipcMain.handle('whisper:start', async () => { await start(); return getStatus(); });
  ipcMain.handle('whisper:stop', () => { killChild(); return getStatus(); });
  ipcMain.handle('whisper:restart', async () => { killChild(); _stopping = false; await start(); return getStatus(); });
  ipcMain.handle('whisper:install-task', async () => installScheduledTask());
  ipcMain.handle('whisper:uninstall-task', async () => uninstallScheduledTask());
  ipcMain.handle('whisper:query-task', async () => queryScheduledTask());
  ipcMain.handle('whisper:update-settings', async (_e, next) => {
    _settings = { ..._settings, ...(next || {}) };
    return { ok: true };
  });

  _onStateChange = (s) => {
    const win = getMainWindow && getMainWindow();
    if (win && !win.isDestroyed()) {
      try { win.webContents.send('whisper-state', s); } catch {}
    }
  };

  app.on('before-quit', killChild);

  // Don't block startup — kick start in the background.
  start().catch((err) => log && log.error('[whisper] start failed:', err.message));
}

module.exports = {
  init,
  start,
  killChild,
  getStatus,
  installScheduledTask,
  uninstallScheduledTask,
  queryScheduledTask,
  runScheduledTask,
  // Exposed for tests
  _internal: { findBinary, findModel, modelSearchPaths, probe, waitUntilReady },
  TASK_NAME, DEFAULT_PORT, DEFAULT_HOST,
};
