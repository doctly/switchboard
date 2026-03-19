const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // Invoke (request-response)
  getPlans: () => ipcRenderer.invoke('get-plans'),
  readPlan: (filename) => ipcRenderer.invoke('read-plan', filename),
  savePlan: (filePath, content) => ipcRenderer.invoke('save-plan', filePath, content),
  getStats: () => ipcRenderer.invoke('get-stats'),
  refreshStats: () => ipcRenderer.invoke('refresh-stats'),
  getMemories: () => ipcRenderer.invoke('get-memories'),
  readMemory: (filePath) => ipcRenderer.invoke('read-memory', filePath),
  saveMemory: (filePath, content) => ipcRenderer.invoke('save-memory', filePath, content),
  getProjects: (showArchived) => ipcRenderer.invoke('get-projects', showArchived),
  getActiveSessions: () => ipcRenderer.invoke('get-active-sessions'),
  getActiveTerminals: () => ipcRenderer.invoke('get-active-terminals'),
  stopSession: (id) => ipcRenderer.invoke('stop-session', id),
  toggleStar: (id) => ipcRenderer.invoke('toggle-star', id),
  renameSession: (id, name) => ipcRenderer.invoke('rename-session', id, name),
  archiveSession: (id, archived) => ipcRenderer.invoke('archive-session', id, archived),
  openTerminal: (id, projectPath, isNew, sessionOptions) => ipcRenderer.invoke('open-terminal', id, projectPath, isNew, sessionOptions),
  search: (type, query) => ipcRenderer.invoke('search', type, query),
  readSessionJsonl: (sessionId) => ipcRenderer.invoke('read-session-jsonl', sessionId),

  // Settings
  getSetting: (key) => ipcRenderer.invoke('get-setting', key),
  setSetting: (key, value) => ipcRenderer.invoke('set-setting', key, value),
  deleteSetting: (key) => ipcRenderer.invoke('delete-setting', key),
  getEffectiveSettings: (projectPath) => ipcRenderer.invoke('get-effective-settings', projectPath),

  browseFolder: () => ipcRenderer.invoke('browse-folder'),
  addProject: (projectPath) => ipcRenderer.invoke('add-project', projectPath),
  removeProject: (projectPath) => ipcRenderer.invoke('remove-project', projectPath),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),

  // Send (fire-and-forget)
  sendInput: (id, data) => ipcRenderer.send('terminal-input', id, data),
  resizeTerminal: (id, cols, rows) => ipcRenderer.send('terminal-resize', id, cols, rows),
  closeTerminal: (id) => ipcRenderer.send('close-terminal', id),

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

  // App version
  getAppVersion: () => ipcRenderer.invoke('get-app-version'),

  // Auto-updater
  updaterCheck: () => ipcRenderer.invoke('updater-check'),
  updaterDownload: () => ipcRenderer.invoke('updater-download'),
  updaterInstall: () => ipcRenderer.invoke('updater-install'),
  onUpdaterEvent: (callback) => {
    ipcRenderer.on('updater-event', (_event, type, data) => callback(type, data));
  },

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
});
