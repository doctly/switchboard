// --- Dialogs & session launch helpers ---
// Depends on globals: launchNewSession, cachedProjects, cachedAllProjects, sessionMap,
// pendingSessions, openSessions, activePtyIds, refreshSidebar, pollActiveSessions (app.js)
// Depends on: ICONS (icons.js)

// --- New session dialog ---
async function resolveDefaultSessionOptions(project) {
  const effective = await window.api.getEffectiveSettings(project.projectPath);
  const options = {};
  if (effective.dangerouslySkipPermissions) {
    options.dangerouslySkipPermissions = true;
  } else if (effective.permissionMode) {
    options.permissionMode = effective.permissionMode;
  }
  if (effective.worktree) {
    options.worktree = true;
    if (effective.worktreeName) options.worktreeName = effective.worktreeName;
  }
  if (effective.chrome) options.chrome = true;
  if (effective.preLaunchCmd) options.preLaunchCmd = effective.preLaunchCmd;
  if (effective.addDirs) options.addDirs = effective.addDirs;
  if (effective.mcpEmulation === false) options.mcpEmulation = false;
  return options;
}

async function forkSession(session, project) {
  const options = await resolveDefaultSessionOptions(project);
  options.forkFrom = session.sessionId;
  launchNewSession(project, options);
}

async function launchScheduleCreator(project) {
  const options = await resolveDefaultSessionOptions(project);
  // Pre-create a JSONL session with the schedule creation prompt, then resume into it
  const result = await window.api.createScheduleSession(project.projectPath);
  if (!result || !result.sessionId) return;

  const session = {
    sessionId: result.sessionId,
    summary: 'Create scheduled task',
    firstPrompt: '',
    projectPath: project.projectPath,
    name: null,
    starred: 0,
    archived: 0,
    messageCount: 1,
    modified: new Date().toISOString(),
    created: new Date().toISOString(),
  };

  // Inject into sidebar
  const folder = encodeProjectPath(project.projectPath);
  pendingSessions.set(result.sessionId, { session, projectPath: project.projectPath, folder });
  sessionMap.set(result.sessionId, session);
  for (const projList of [cachedProjects, cachedAllProjects]) {
    let proj = projList.find(p => p.projectPath === project.projectPath);
    if (!proj) {
      proj = { folder, projectPath: project.projectPath, sessions: [] };
      projList.unshift(proj);
    }
    proj.sessions.unshift(session);
  }
  refreshSidebar();

  const entry = createTerminalEntry(session);
  // Resume the pre-seeded session
  options.appendSystemPrompt = result.systemPrompt;
  const openResult = await window.api.openTerminal(result.sessionId, project.projectPath, false, options);
  if (!openResult.ok) {
    entry.terminal.write(`\r\nError: ${openResult.error}\r\n`);
    entry.closed = true;
    return;
  }
  if (typeof setSessionMcpActive === 'function') setSessionMcpActive(result.sessionId, !!openResult.mcpActive);
  showSession(result.sessionId);
  pollActiveSessions();
}

async function showNewSessionPopover(project, anchorEl) {
  const callbacks = {
    onClaude: async (proj) => { launchNewSession(proj, await resolveDefaultSessionOptions(proj)); },
    onClaudeConfig: (proj) => showNewSessionDialog(proj),
    onTerminal: (proj) => launchTerminalSession(proj),
  };
  window.vueDialogs?.openPopover(project, anchorEl, callbacks);
}

async function launchTerminalSession(project) {
  const sessionId = crypto.randomUUID();
  const projectPath = project.projectPath;
  const session = {
    sessionId,
    summary: 'Terminal',
    firstPrompt: '',
    projectPath,
    name: null,
    starred: 0,
    archived: 0,
    messageCount: 0,
    modified: new Date().toISOString(),
    created: new Date().toISOString(),
    type: 'terminal',
  };

  // Track as pending
  const folder = encodeProjectPath(projectPath);
  pendingSessions.set(sessionId, { session, projectPath, folder });

  // Inject into cached project data
  sessionMap.set(sessionId, session);
  for (const projList of [cachedProjects, cachedAllProjects]) {
    let proj = projList.find(p => p.projectPath === projectPath);
    if (!proj) {
      proj = { folder, projectPath, sessions: [] };
      projList.unshift(proj);
    }
    proj.sessions.unshift(session);
  }
  refreshSidebar();

  const entry = createTerminalEntry(session);

  const result = await window.api.openTerminal(sessionId, projectPath, true, { type: 'terminal' });
  if (!result.ok) {
    entry.terminal.write(`\r\nError: ${result.error}\r\n`);
    entry.closed = true;
    return;
  }

  showSession(sessionId);
  pollActiveSessions();
}

async function showNewSessionDialog(project) {
  const effective = await window.api.getEffectiveSettings(project.projectPath);
  window.vueDialogs?.openNewSession(project, effective, (options) => launchNewSession(project, options));
}

async function showResumeSessionDialog(session) {
  const effective = await window.api.getEffectiveSettings(session.projectPath);
  window.vueDialogs?.openResumeSession(session, effective, (options) => openSession(session, options));
}

function showAddProjectDialog() {
  window.vueDialogs?.openAddProject(async () => { await loadProjects(); });
}
