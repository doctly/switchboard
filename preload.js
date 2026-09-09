const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // Invoke (request-response)
  getPlans: () => ipcRenderer.invoke('get-plans'),
  readPlan: (filename) => ipcRenderer.invoke('read-plan', filename),
  savePlan: (filePath, content) => ipcRenderer.invoke('save-plan', filePath, content),
  getStats: () => ipcRenderer.invoke('get-stats'),
  refreshStats: () => ipcRenderer.invoke('refresh-stats'),
  getUsage: () => ipcRenderer.invoke('get-usage'),
  getCodexUsage: () => ipcRenderer.invoke('get-codex-usage'),
  getMemories: () => ipcRenderer.invoke('get-memories'),
  readMemory: (filePath) => ipcRenderer.invoke('read-memory', filePath),
  saveMemory: (filePath, content) => ipcRenderer.invoke('save-memory', filePath, content),
  getProjects: (showArchived) => ipcRenderer.invoke('get-projects', showArchived),
  getHarnesses: () => ipcRenderer.invoke('get-harnesses'),
  getActiveSessions: () => ipcRenderer.invoke('get-active-sessions'),
  getActiveTerminals: () => ipcRenderer.invoke('get-active-terminals'),
  stopSession: (id) => ipcRenderer.invoke('stop-session', id),
  toggleStar: (id) => ipcRenderer.invoke('toggle-star', id),
  renameSession: (id, name) => ipcRenderer.invoke('rename-session', id, name),
  archiveSession: (id, archived) => ipcRenderer.invoke('archive-session', id, archived),
  openTerminal: (id, projectPath, isNew, sessionOptions) => ipcRenderer.invoke('open-terminal', id, projectPath, isNew, sessionOptions),
  search: (type, query, titleOnly) => ipcRenderer.invoke('search', type, query, titleOnly),
  searchSessionIds: (query, sessionIds) => ipcRenderer.invoke('search-session-ids', query, sessionIds),
  readSessionJsonl: (sessionId) => ipcRenderer.invoke('read-session-jsonl', sessionId),
  getSessionLastMessage: (sessionId) => ipcRenderer.invoke('get-session-last-message', sessionId),

  // Settings
  getSetting: (key) => ipcRenderer.invoke('get-setting', key),
  setSetting: (key, value) => ipcRenderer.invoke('set-setting', key, value),
  deleteSetting: (key) => ipcRenderer.invoke('delete-setting', key),
  getEffectiveSettings: (projectPath) => ipcRenderer.invoke('get-effective-settings', projectPath),
  getScheduleCreatorCommand: () => ipcRenderer.invoke('get-schedule-creator-command'),
  createScheduleSession: (projectPath) => ipcRenderer.invoke('create-schedule-session', projectPath),
  runScheduleNow: (filePath) => ipcRenderer.invoke('run-schedule-now', filePath),
  getShellProfiles: () => ipcRenderer.invoke('get-shell-profiles'),

  // Project/worktree tasks
  listProjectTasks: (projectPath) => ipcRenderer.invoke('list-project-tasks', projectPath),
  listTasksForProjects: (projectPaths) => ipcRenderer.invoke('list-tasks-for-projects', projectPaths),
  getTaskRun: (projectPath, label) => ipcRenderer.invoke('get-task-run', projectPath, label),
  startTask: (projectPath, label) => ipcRenderer.invoke('start-task', projectPath, label),
  stopTask: (projectPath, label) => ipcRenderer.invoke('stop-task', projectPath, label),
  stopAllTasks: (projectPath) => ipcRenderer.invoke('stop-all-tasks', projectPath),
  restartTask: (projectPath, label) => ipcRenderer.invoke('restart-task', projectPath, label),

  browseFolder: () => ipcRenderer.invoke('browse-folder'),
  addProject: (projectPath) => ipcRenderer.invoke('add-project', projectPath),
  removeProject: (projectPath) => ipcRenderer.invoke('remove-project', projectPath),

  // Projects (a piece of work with a folder on disk; see projects.js)
  getProjectTree: (showArchived) => ipcRenderer.invoke('get-project-tree', showArchived),
  createProject: (spec) => ipcRenderer.invoke('create-project', spec),
  updateProject: (id, patch) => ipcRenderer.invoke('update-project', id, patch),
  deleteProject: (id) => ipcRenderer.invoke('delete-project', id),
  attachProjectFolder: (id, spec) => ipcRenderer.invoke('attach-project-folder', id, spec),
  detachProjectFolder: (id, folderPath, opts) => ipcRenderer.invoke('detach-project-folder', id, folderPath, opts),
  setSessionAssignment: (sessionId, projectId, trackId) => ipcRenderer.invoke('set-session-assignment', sessionId, projectId, trackId),
  getProjectsRoot: () => ipcRenderer.invoke('get-projects-root'),
  getProjectGitStatus: (id, opts) => ipcRenderer.invoke('get-project-git-status', id, opts),
  getProjectGitInfo: (id) => ipcRenderer.invoke('get-project-git-info', id),
  getProjectGitDiff: (id, folderPath, filePath) => ipcRenderer.invoke('get-project-git-diff', id, folderPath, filePath),
  getFolderGitStatus: (folderPath) => ipcRenderer.invoke('get-folder-git-status', folderPath),
  listEnvFiles: (folderPath) => ipcRenderer.invoke('list-env-files', folderPath),
  saveProjectBrief: (id, content) => ipcRenderer.invoke('save-project-brief', id, content),
  createProjectFile: (id, name, content) => ipcRenderer.invoke('create-project-file', id, name, content),
  addProjectFiles: (id, sourcePaths) => ipcRenderer.invoke('add-project-files', id, sourcePaths),
  getProjectPlan: (id) => ipcRenderer.invoke('get-project-plan', id),
  setPlanItem: (id, kind, line, done) => ipcRenderer.invoke('set-plan-item', id, kind, line, done),
  appendPlanItem: (id, kind, text) => ipcRenderer.invoke('append-plan-item', id, kind, text),
  editPlanItem: (id, kind, line, text) => ipcRenderer.invoke('edit-plan-item', id, kind, line, text),
  adoptPlan: (id, filename, opts) => ipcRenderer.invoke('adopt-plan', id, filename, opts),
  listTemplates: () => ipcRenderer.invoke('list-templates'),
  onProjectPlanChanged: (callback) => {
    ipcRenderer.on('project-plan-changed', (_event, projectId) => callback(projectId));
  },
  createTrack: (projectId, spec) => ipcRenderer.invoke('create-track', projectId, spec),
  updateTrack: (id, patch) => ipcRenderer.invoke('update-track', id, patch),
  deleteTrack: (id, options) => ipcRenderer.invoke('delete-track', id, options),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  openPath: (target) => ipcRenderer.invoke('open-path', target),
  writeClipboard: (text) => ipcRenderer.invoke('clipboard-write-text', text),

  // Send (fire-and-forget)
  sendInput: (id, data) => ipcRenderer.send('terminal-input', id, data),
  resizeTerminal: (id, cols, rows) => ipcRenderer.send('terminal-resize', id, cols, rows),
  closeTerminal: (id) => ipcRenderer.send('close-terminal', id),
  sendTaskInput: (projectPath, label, data) => ipcRenderer.send('task-input', projectPath, label, data),
  resizeTask: (projectPath, label, cols, rows) => ipcRenderer.send('task-resize', projectPath, label, cols, rows),

  // Listeners (main → renderer)
  onTerminalData: (callback) => {
    ipcRenderer.on('terminal-data', (_event, sessionId, data) => callback(sessionId, data));
  },
  onSessionDetected: (callback) => {
    ipcRenderer.on('session-detected', (_event, tempId, realId) => callback(tempId, realId));
  },
  onHarnessesChanged: (callback) => {
    ipcRenderer.on('harnesses-changed', () => callback());
  },
  onProcessExited: (callback) => {
    ipcRenderer.on('process-exited', (_event, sessionId, exitCode, signal, userStopped) =>
      callback(sessionId, exitCode, signal, userStopped));
  },
  onTerminalNotification: (callback) => {
    ipcRenderer.on('terminal-notification', (_event, sessionId, message, kind) => callback(sessionId, message, kind));
  },
  onCliBusyState: (callback) => {
    ipcRenderer.on('cli-busy-state', (_event, sessionId, busy) => callback(sessionId, busy));
  },
  onSessionForked: (callback) => {
    ipcRenderer.on('session-forked', (_event, oldId, newId) => callback(oldId, newId));
  },
  onProjectsChanged: (callback) => {
    ipcRenderer.on('projects-changed', (_e, reason) => callback(reason || 'project'));
  },
  onStatusUpdate: (callback) => {
    ipcRenderer.on('status-update', (_event, text, type) => callback(text, type));
  },
  onTaskOutput: (callback) => {
    ipcRenderer.on('task-output', (_event, projectPath, label, data) => callback(projectPath, label, data));
  },
  onTaskStateChanged: (callback) => {
    ipcRenderer.on('task-state-changed', (_event, run) => callback(run));
  },
  onProjectTasksChanged: (callback) => {
    ipcRenderer.on('project-tasks-changed', (_event, projectPath) => callback(projectPath));
  },

  // File drag-and-drop
  getPathForFile: (file) => webUtils.getPathForFile(file),

  // Platform
  platform: process.platform,

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
  listProjectDirectory: (projectPath, relativePath) => ipcRenderer.invoke('list-project-directory', projectPath, relativePath),
  readProjectFile: (projectPath, relativePath) => ipcRenderer.invoke('read-project-file', projectPath, relativePath),
  manageProjectEntry: (projectPath, relativePath, action, newName) => ipcRenderer.invoke('manage-project-entry', projectPath, relativePath, action, newName),
  saveFileForPanel: (filePath, content) => ipcRenderer.invoke('save-file-for-panel', filePath, content),
  watchFile: (filePath) => ipcRenderer.invoke('watch-file', filePath),
  unwatchFile: (filePath) => ipcRenderer.invoke('unwatch-file', filePath),
  onFileChanged: (callback) => {
    ipcRenderer.on('file-changed', (_event, filePath) => callback(filePath));
  },
});
