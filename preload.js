const { contextBridge, ipcRenderer, webUtils } = require('electron');

// Brand strings are resolved in the main process and fetched synchronously
// at preload time (sandbox-compatible). Usage in the renderer:
//   const label = (window.api.strings && window.api.strings.sidebar_sessions) || 'Sessions';
let brandingStringsSnapshot = {};
try {
  const raw = ipcRenderer.sendSync('branding:getStrings');
  if (raw && typeof raw === 'object') brandingStringsSnapshot = Object.freeze({ ...raw });
} catch {}

contextBridge.exposeInMainWorld('api', {
  strings: brandingStringsSnapshot,

  // Disk logging bridge — renderer messages go through main and into
  // electron-log (<userData>/logs/main.log). Use this instead of
  // console.* so logs survive even when DevTools won't open.
  log: {
    debug: (msg, meta) => ipcRenderer.send('renderer-log', 'debug', msg, meta),
    info:  (msg, meta) => ipcRenderer.send('renderer-log', 'info', msg, meta),
    warn:  (msg, meta) => ipcRenderer.send('renderer-log', 'warn', msg, meta),
    error: (msg, meta) => ipcRenderer.send('renderer-log', 'error', msg, meta),
  },
  getLogPath: () => ipcRenderer.invoke('get-log-path'),
  // Invoke (request-response)
  getPlans: () => ipcRenderer.invoke('get-plans'),
  readPlan: (filename) => ipcRenderer.invoke('read-plan', filename),
  savePlan: (filePath, content) => ipcRenderer.invoke('save-plan', filePath, content),
  getStats: () => ipcRenderer.invoke('get-stats'),
  refreshStats: () => ipcRenderer.invoke('refresh-stats'),
  getMemories: () => ipcRenderer.invoke('get-memories'),
  readMemory: (filePath) => ipcRenderer.invoke('read-memory', filePath),
  saveMemory: (filePath, content) => ipcRenderer.invoke('save-memory', filePath, content),
  reloadShellEnv: () => ipcRenderer.invoke('reload-shell-env'),
  getProjects: (showArchived) => ipcRenderer.invoke('get-projects', showArchived),
  getActiveSessions: () => ipcRenderer.invoke('get-active-sessions'),
  getActiveTerminals: () => ipcRenderer.invoke('get-active-terminals'),
  stopSession: (id) => ipcRenderer.invoke('stop-session', id),
  toggleStar: (id) => ipcRenderer.invoke('toggle-star', id),
  renameSession: (id, name) => ipcRenderer.invoke('rename-session', id, name),
  archiveSession: (id, archived) => ipcRenderer.invoke('archive-session', id, archived),
  openTerminal: (id, projectPath, isNew, sessionOptions) => ipcRenderer.invoke('open-terminal', id, projectPath, isNew, sessionOptions),
  search: (type, query, titleOnly) => ipcRenderer.invoke('search', type, query, titleOnly),
  readSessionJsonl: (sessionId) => ipcRenderer.invoke('read-session-jsonl', sessionId),

  // Settings
  getSetting: (key) => ipcRenderer.invoke('get-setting', key),
  setSetting: (key, value) => ipcRenderer.invoke('set-setting', key, value),
  deleteSetting: (key) => ipcRenderer.invoke('delete-setting', key),
  getEffectiveSettings: (projectPath) => ipcRenderer.invoke('get-effective-settings', projectPath),
  getScheduleCreatorCommand: () => ipcRenderer.invoke('get-schedule-creator-command'),
  createScheduleSession: (projectPath) => ipcRenderer.invoke('create-schedule-session', projectPath),
  runScheduleNow: (filePath) => ipcRenderer.invoke('run-schedule-now', filePath),
  getShellProfiles: () => ipcRenderer.invoke('get-shell-profiles'),

  // Claude profiles (env-var bundles applied at session spawn)
  profiles: {
    list: () => ipcRenderer.invoke('profiles:list'),
    save: (profile) => ipcRenderer.invoke('profiles:save', profile),
    delete: (id) => ipcRenderer.invoke('profiles:delete', id),
    setDefault: (id) => ipcRenderer.invoke('profiles:set-default', id),
  },

  // Map of sessionId → profileId. Populated at session spawn; renderer reads
  // the whole map at startup to drive sidebar icon badges.
  sessionProfiles: {
    getAll: () => ipcRenderer.invoke('session-profiles:get-all'),
  },

  // Pre-aggregated per-backend analytics computed by a worker thread from
  // the JSONL session history. getCache returns instantly (cached read);
  // refresh kicks the worker; analytics-updated fires when fresh data is ready.
  analytics: {
    getCache: () => ipcRenderer.invoke('analytics:get-cache'),
    refresh: (opts) => ipcRenderer.invoke('analytics:refresh', opts || {}),
    onUpdated: (cb) => {
      const handler = () => cb();
      ipcRenderer.on('analytics-updated', handler);
      return () => ipcRenderer.removeListener('analytics-updated', handler);
    },
  },

  // Local whisper.cpp HTTP server: status + lifecycle control + scheduled-task
  // (logon-trigger) install for "always available" mode.
  whisper: {
    status: () => ipcRenderer.invoke('whisper:status'),
    ping: () => ipcRenderer.invoke('whisper:ping'),
    start: () => ipcRenderer.invoke('whisper:start'),
    stop: () => ipcRenderer.invoke('whisper:stop'),
    restart: () => ipcRenderer.invoke('whisper:restart'),
    updateSettings: (next) => ipcRenderer.invoke('whisper:update-settings', next),
    onState: (cb) => {
      const handler = (_e, s) => cb(s);
      ipcRenderer.on('whisper-state', handler);
      return () => ipcRenderer.removeListener('whisper-state', handler);
    },
  },

  browseFolder: () => ipcRenderer.invoke('browse-folder'),
  addProject: (projectPath) => ipcRenderer.invoke('add-project', projectPath),
  removeProject: (projectPath) => ipcRenderer.invoke('remove-project', projectPath),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),

  // Send (fire-and-forget)
  sendInput: (id, data) => ipcRenderer.send('terminal-input', id, data),
  resizeTerminal: (id, cols, rows) => ipcRenderer.send('terminal-resize', id, cols, rows),
  closeTerminal: (id) => ipcRenderer.send('close-terminal', id),
  voiceLog: (level, event, data) => ipcRenderer.send('voice-log', level, event, data),
  voiceSaveWav: (bytes) => ipcRenderer.invoke('voice-save-wav', bytes),

  // Listeners (main → renderer)
  onTerminalData: (callback) => {
    ipcRenderer.on('terminal-data', (_event, sessionId, data) => callback(sessionId, data));
  },
  onSessionDetected: (callback) => {
    ipcRenderer.on('session-detected', (_event, tempId, realId) => callback(tempId, realId));
  },
  onProcessExited: (callback) => {
    ipcRenderer.on('process-exited', (_event, sessionId, exitCode) => callback(sessionId, exitCode));
  },
  onTerminalNotification: (callback) => {
    ipcRenderer.on('terminal-notification', (_event, sessionId, message) => callback(sessionId, message));
  },
  onCliBusyState: (callback) => {
    ipcRenderer.on('cli-busy-state', (_event, sessionId, busy) => callback(sessionId, busy));
  },
  onSessionForked: (callback) => {
    ipcRenderer.on('session-forked', (_event, oldId, newId) => callback(oldId, newId));
  },
  onProjectsChanged: (callback) => {
    ipcRenderer.on('projects-changed', () => callback());
  },
  onStatusUpdate: (callback) => {
    ipcRenderer.on('status-update', (_event, text, type) => callback(text, type));
  },

  // File drag-and-drop
  getPathForFile: (file) => webUtils.getPathForFile(file),

  // Platform
  platform: process.platform,

  // App version
  getAppVersion: () => ipcRenderer.invoke('get-app-version'),

  // MCP bridge (main → renderer)
  onMcpOpenDiff: (callback) => {
    ipcRenderer.on('mcp-open-diff', (_event, sessionId, diffId, data) => callback(sessionId, diffId, data));
  },
  onMcpOpenFile: (callback) => {
    ipcRenderer.on('mcp-open-file', (_event, sessionId, data) => callback(sessionId, data));
  },
  onMcpCloseAllDiffs: (callback) => {
    ipcRenderer.on('mcp-close-all-diffs', (_event, sessionId) => callback(sessionId));
  },
  onMcpCloseTab: (callback) => {
    ipcRenderer.on('mcp-close-tab', (_event, sessionId, diffId) => callback(sessionId, diffId));
  },

  // MCP bridge (renderer → main)
  mcpDiffResponse: (sessionId, diffId, action, editedContent) => {
    ipcRenderer.send('mcp-diff-response', sessionId, diffId, action, editedContent);
  },
  readFileForPanel: (filePath) => ipcRenderer.invoke('read-file-for-panel', filePath),
  saveFileForPanel: (filePath, content) => ipcRenderer.invoke('save-file-for-panel', filePath, content),
  watchFile: (filePath) => ipcRenderer.invoke('watch-file', filePath),
  unwatchFile: (filePath) => ipcRenderer.invoke('unwatch-file', filePath),
  onFileChanged: (callback) => {
    ipcRenderer.on('file-changed', (_event, filePath) => callback(filePath));
  },
});
