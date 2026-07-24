// DOM refs — App.vue (in vue-bundle.js) has mounted and rendered these before this script runs
const terminalsEl = document.getElementById('terminals');
const sidebarContent = document.getElementById('sidebar-content'); // used by grid-view.js for DOM session order
const placeholder = document.getElementById('placeholder');
const terminalHeader = document.getElementById('terminal-header');
const terminalHeaderName = document.getElementById('terminal-header-name');
const terminalHeaderId = document.getElementById('terminal-header-id');
const terminalHeaderStatus = document.getElementById('terminal-header-status');
const terminalHeaderShell = document.getElementById('terminal-header-shell');
const terminalStopBtn = document.getElementById('terminal-stop-btn');
const terminalArea = document.getElementById('terminal-area');
const projectViewer = document.getElementById('project-viewer');
const gridViewer = document.getElementById('grid-viewer');
let gridViewActive = localStorage.getItem('gridViewActive') === '1';

// Map<sessionId, { terminal, element, fitAddon, session, closed }>
const openSessions = new Map();
window._openSessions = openSessions;
let activeSessionId = sessionStorage.getItem('activeSessionId') || null;
function setActiveSession(id) {
  activeSessionId = id;
  if (id) sessionStorage.setItem('activeSessionId', id);
  else sessionStorage.removeItem('activeSessionId');
  if (typeof switchPanel === 'function') switchPanel(id);
  window.vueSidebar?.setActiveSession(id);
}
let showArchived = false;
let showStarredOnly = false;
let showRunningOnly = false;
let showTodayOnly = false;
let cachedProjects = [];
let cachedAllProjects = [];
let activePtyIds = new Set();
let sortedOrder = []; // kept for grid-view.js project-heading ordering; no longer updated by sidebar
let activeTab = 'sessions';
let visibleSessionCount = 10;
let sessionMaxAgeDays = 3;
const pendingSessions = new Map(); // sessionId → { session, projectPath, folder }

window._setVisibleSessionCount = (v) => { visibleSessionCount = v; };
window._setSessionMaxAge = (v) => { sessionMaxAgeDays = v; };
window._applyTerminalTheme = (themeName) => {
  currentThemeName = themeName;
  TERMINAL_THEME = getTerminalTheme();
  for (const [, entry] of openSessions) {
    entry.terminal.options.theme = TERMINAL_THEME;
    entry.element.style.backgroundColor = TERMINAL_THEME.background;
  }
};
let searchMatchIds = null; // null = no search active; Set<string> = matched session IDs
let searchMatchProjectPaths = null; // Set<string> of project paths matched by name

// --- Activity tracking ---
//
// Activity is determined by two signals:
//   1. OSC 0 braille spinner (authoritative: Claude CLI sets title to spinner chars)
//   2. Noise-filtered terminal output (fallback: non-noise, non-TUI-repaint data)
//
// Both feed into setActivity(sessionId, active):
//   active=true  → cli-busy (spinner dot)
//   active=false → response-ready if not focused (terminal state until user clicks)
// OSC 0 idle signal is the authoritative source for marking sessions as idle.
//
const attentionSessions = new Set(); // sessions needing user action (OSC 9)
const responseReadySessions = new Set(); // Claude finished, user hasn't looked (terminal state)
const sessionBusyState = new Map(); // sessionId → boolean (currently active)
const lastActivityTime = new Map(); // sessionId → Date of last terminal output
window.lastActivityTime = lastActivityTime; // exposed for Vue components

// Noise patterns — these don't count as activity
const activityNoiseRe = /file-history-snapshot|^\s*$/;

// Central activity dispatcher
function setActivity(sessionId, active) {
  if (responseReadySessions.has(sessionId)) return;

  const wasActive = sessionBusyState.get(sessionId) || false;
  sessionBusyState.set(sessionId, active);

  if (wasActive && !active && sessionId !== activeSessionId) {
    responseReadySessions.add(sessionId);
    window.vueSidebar?.setResponseReady(sessionId);
  }

  window.vueSidebar?.setBusy(sessionId, active);
}

// Terminal output activity — updates lastActivityTime only, busy state driven by backend
function trackActivity(sessionId, data) {
  if (activityNoiseRe.test(data)) return;
  lastActivityTime.set(sessionId, new Date());
}

function clearUnread(sessionId) {
  responseReadySessions.delete(sessionId);
  window.vueSidebar?.clearNotifications(sessionId);
}

function clearNotifications(sessionId) {
  clearUnread(sessionId);
  attentionSessions.delete(sessionId);
  window.vueSidebar?.clearNotifications(sessionId);
}
// Terminal themes, utils (cleanDisplayName, formatDate, escapeHtml, shellEscape)
// are defined in terminal-themes.js and utils.js (loaded before app.js).

// Terminal key bindings, write buffering, isAtBottom, safeFit, fitAndScroll → terminal-manager.js

// --- IPC listeners from main process ---

window.api.onTerminalData((sessionId, data) => {
  const entry = openSessions.get(sessionId);
  if (entry) {
    let buf = terminalWriteBuffers.get(sessionId);
    if (!buf) {
      buf = { chunks: [], syncDepth: 0, rafId: 0, timerId: 0 };
      terminalWriteBuffers.set(sessionId, buf);
    }
    buf.chunks.push(data);

    // Track sync start/end nesting
    if (data.includes(ESC_SYNC_START)) buf.syncDepth++;
    if (data.includes(ESC_SYNC_END)) buf.syncDepth = Math.max(0, buf.syncDepth - 1);

    if (buf.syncDepth > 0) {
      // Inside a synchronized update — keep buffering.
      // Set a safety timeout so we never hold data forever.
      cancelAnimationFrame(buf.rafId);
      if (!buf.timerId) {
        buf.timerId = setTimeout(() => flushTerminalBuffer(sessionId), SYNC_BUFFER_TIMEOUT);
      }
    } else {
      // Not in a sync block (or sync just ended) — flush on next frame.
      clearTimeout(buf.timerId);
      buf.timerId = 0;
      scheduleFlush(sessionId, buf);
    }
  }
  // Update last activity time (noise-filtered)
  trackActivity(sessionId, data);
});

window.api.onSessionDetected((tempId, realId) => {
  const entry = openSessions.get(tempId);
  if (!entry) return;

  entry.session.sessionId = realId;
  if (activeSessionId === tempId) setActiveSession(realId);

  // Re-key in openSessions
  openSessions.delete(tempId);
  openSessions.set(realId, entry);

  terminalHeaderId.textContent = realId;
  terminalHeaderName.textContent = 'New session';

  // Refresh sidebar to show the new session, then select it
  loadProjects().then(() => {
    const item = document.querySelector(`[data-session-id="${realId}"]`);
    if (item) {
      document.querySelectorAll('.session-item.active').forEach(el => el.classList.remove('active'));
      item.classList.add('active');
    }
  });
  pollActiveSessions();
});

window.api.onSessionForked((oldId, newId) => {
  const entry = openSessions.get(oldId);
  if (!entry) return;

  entry.session.sessionId = newId;
  if (activeSessionId === oldId) setActiveSession(newId);

  openSessions.delete(oldId);
  openSessions.set(newId, entry);

  // Re-key file panel state for the new session ID
  if (typeof rekeyFilePanelState === 'function') rekeyFilePanelState(oldId, newId);

  // Re-key pending session to newId so sidebar item persists until DB has real data
  const pendingEntry = pendingSessions.get(oldId);
  pendingSessions.delete(oldId);
  if (pendingEntry) {
    pendingEntry.sessionId = newId;
    pendingSessions.set(newId, pendingEntry);
  }
  sessionMap.delete(oldId);
  sessionMap.set(newId, entry.session);

  terminalHeaderId.textContent = newId;

  loadProjects().then(() => {
    const item = document.querySelector(`[data-session-id="${newId}"]`);
    if (item) {
      document.querySelectorAll('.session-item.active').forEach(el => el.classList.remove('active'));
      item.classList.add('active');
      const summary = item.querySelector('.session-summary');
      if (summary) terminalHeaderName.textContent = summary.textContent;
    }
  });
  pollActiveSessions();
});

window.api.onProcessExited((sessionId, exitCode) => {
  const entry = openSessions.get(sessionId);
  const session = sessionMap.get(sessionId);
  if (entry) {
    entry.closed = true;
  }

  // Clean up terminal UI on exit (uses destroySession to handle grid cards too)
  if (entry) {
    destroySession(sessionId);
  }
  if (gridViewActive) {
    if (window.vueStore) window.vueStore.gridViewerCount = gridCards.size + ' session' + (gridCards.size !== 1 ? 's' : '');
  } else if (activeSessionId === sessionId) {
    setActiveSession(null);
    terminalHeader.style.display = 'none';
    window.vueSidebar?.clearHeader();
    placeholder.style.display = '';
  }

  // Plain terminal sessions: remove from sidebar entirely (ephemeral)
  if (session?.type === 'terminal') {
    pendingSessions.delete(sessionId);
    for (const projList of [cachedProjects, cachedAllProjects]) {
      for (const proj of projList) {
        proj.sessions = proj.sessions.filter(s => s.sessionId !== sessionId);
      }
    }
    sessionMap.delete(sessionId);
    refreshSidebar();
    pollActiveSessions();
    return;
  }

  // Clean up no-op pending sessions (never created a .jsonl)
  if (pendingSessions.has(sessionId)) {
    pendingSessions.delete(sessionId);
    // Remove from cached project data
    for (const projList of [cachedProjects, cachedAllProjects]) {
      for (const proj of projList) {
        proj.sessions = proj.sessions.filter(s => s.sessionId !== sessionId);
      }
    }
    sessionMap.delete(sessionId);
    refreshSidebar();
  }

  pollActiveSessions();
});

// --- Terminal notifications (iTerm2 OSC 9 — "needs attention") ---
window.api.onTerminalNotification((sessionId, message) => {
  // Only mark as needing attention for "attention" messages, not "waiting for input"
  // Matches all four CLI notification types:
  // 1. "Claude Code needs your attention"         → attention
  // 2. "Claude Code needs your approval for the plan" → approval, needs your
  // 3. "Claude needs your permission to use {tool}"   → permission, needs your
  // 4. "Claude Code wants to enter plan mode"         → wants to enter
  if (/attention|approval|permission|needs your|wants to enter/i.test(message) && sessionId !== activeSessionId) {
    attentionSessions.add(sessionId);
    window.vueSidebar?.addAttention(sessionId);
  } else if (/waiting for your input/i.test(message)) {
    // "Claude is waiting for your input" — delayed idle notification, mark response-ready
    setActivity(sessionId, false);
  }

  // Show in header if active
  if (sessionId === activeSessionId && terminalHeaderPtyTitle) {
    terminalHeaderPtyTitle.textContent = message;
    terminalHeaderPtyTitle.style.display = '';
  }
});

// --- CLI busy state (OSC 0 title spinner detection) ---
window.api.onCliBusyState((sessionId, busy) => {
  setActivity(sessionId, busy);
});

// --- Single entry point for all sidebar renders ---
// resort=true: re-sort items by priority+time (use for user-initiated actions)
// resort=false (default): preserve existing DOM order, new items go to top
function refreshSidebar({ resort = false } = {}) {
  // When searching, always use all projects (search ignores archive filter)
  const projects = (searchMatchIds !== null)
    ? cachedAllProjects
    : (showArchived ? cachedAllProjects : cachedProjects);

  // Vue sidebar handles its own filtering; just pass the full project list
  window.vueSidebar?.setProjects(projects);
  window.vueSidebar?.setSearch(searchMatchIds, searchMatchProjectPaths);
  window.vueSidebar?.setFilters({ showStarredOnly, showRunningOnly, showTodayOnly, showArchived });
}

// --- Search & filter handlers moved to App.vue ---
// App.vue calls window.__sb.search(query, titlesOnly) and window.__sb.clearSearch()
// App.vue calls window.__sb.onFilterChange(filters) for filter toggles

function clearSearch() {
  const activeTab = window.vueStore?.activeTab || 'sessions';
  searchMatchIds = null;
  searchMatchProjectPaths = null;
  window.vueSidebar?.setSearch(null, null);
  if (activeTab === 'sessions') {
    refreshSidebar({ resort: true });
  } else if (activeTab === 'plans') {
    renderPlans();
  } else if (activeTab === 'memory') {
    renderMemories();
  } else if (activeTab === 'projects') {
    projectsSearchQuery = '';
    window.vueProjects?.setSearch('');
  }
}

// --- Stop session helper (exposed globally for Vue components) ---
let _stoppingSession = false;
async function confirmAndStopSession(sessionId) {
  if (_stoppingSession) return;
  _stoppingSession = true;
  try {
    if (!confirm('Stop this session?')) return;
    await window.api.stopSession(sessionId);
    activePtyIds.delete(sessionId);

    const session = sessionMap.get(sessionId);
    if (session?.type === 'terminal') {
      // Plain terminals are ephemeral — clean up immediately without waiting for process-exited
      destroySession(sessionId);
      pendingSessions.delete(sessionId);
      for (const projList of [cachedProjects, cachedAllProjects]) {
        for (const proj of projList) {
          proj.sessions = proj.sessions.filter(s => s.sessionId !== sessionId);
        }
      }
      sessionMap.delete(sessionId);
      if (activeSessionId === sessionId) {
        setActiveSession(null);
        placeholder.style.display = '';
      }
      refreshSidebar();
      pollActiveSessions();
      return;
    }

    if (!gridViewActive && activeSessionId === sessionId) {
      setActiveSession(null);
      terminalHeader.style.display = 'none';
      placeholder.style.display = '';
    }
    refreshSidebar();
  } finally {
    _stoppingSession = false;
  }
}

window.confirmAndStopSession = confirmAndStopSession;

// --- Terminal header controls ---
terminalStopBtn.addEventListener('click', () => {
  if (activeSessionId) confirmAndStopSession(activeSessionId);
});


// --- Poll for active PTY sessions ---
async function pollActiveSessions() {
  try {
    const ids = await window.api.getActiveSessions();
    activePtyIds = new Set(ids);
    window.vueSidebar?.setActivePtyIds(ids);
    updateRunningIndicators();
    updateTerminalHeader();
  } catch {}
}

function updateRunningIndicators() {
  document.querySelectorAll('.session-item').forEach(item => {
    const id = item.dataset.sessionId;
    const running = activePtyIds.has(id);
    item.classList.toggle('has-running-pty', running);
    if (!running) {
      item.classList.remove('needs-attention', 'response-ready', 'cli-busy');
      attentionSessions.delete(id);
      responseReadySessions.delete(id);
      sessionBusyState.delete(id);
    }
    const dot = item.querySelector('.session-status-dot');
    if (dot) dot.classList.toggle('running', running);
  });
  // Update slug group running dots
  document.querySelectorAll('.slug-group').forEach(group => {
    const hasRunning = group.querySelector('.session-item.has-running-pty') !== null;
    const dot = group.querySelector('.slug-group-dot');
    if (dot) dot.classList.toggle('running', hasRunning);
  });
  // Update grid cards via Vue
  for (const [sid] of gridCards) {
    const running = activePtyIds.has(sid);
    const busy = sessionBusyState.get(sid) || false;
    const time = formatDate(lastActivityTime.get(sid) || new Date(sessionMap.get(sid)?.modified));
    window.vueGrid?.updateCard(sid, running, busy, time);
  }
}

function updateTerminalHeader() {
  if (!activeSessionId) return;
  const running = activePtyIds.has(activeSessionId);
  terminalHeaderStatus.className = running ? 'running' : 'stopped';
  terminalHeaderStatus.textContent = running ? 'Running' : 'Stopped';
  terminalStopBtn.style.display = running ? '' : 'none';
  updatePtyTitle();
}

const terminalHeaderPtyTitle = document.getElementById('terminal-header-pty-title');

function updatePtyTitle() {
  if (!activeSessionId) return;
  const entry = openSessions.get(activeSessionId);
  const title = entry?.ptyTitle || '';
  window.vueSidebar?.setHeaderPtyTitle(title || null);
  // Legacy DOM fallback
  if (terminalHeaderPtyTitle) {
    terminalHeaderPtyTitle.textContent = title;
    terminalHeaderPtyTitle.style.display = title ? '' : 'none';
  }
}

setInterval(pollActiveSessions, 3000);

// Refresh sidebar timeago labels every 30s so "just now" ticks forward
setInterval(() => {
  for (const [sessionId, time] of lastActivityTime) {
    const item = document.getElementById('si-' + sessionId);
    if (!item) continue;
    const meta = item.querySelector('.session-meta');
    if (!meta) continue;
    const session = sessionMap.get(sessionId);
    const msgSuffix = session?.messageCount ? ' \u00b7 ' + session.messageCount + ' msgs' : '';
    meta.textContent = formatDate(time) + msgSuffix;
  }
}, 30000);

// Shared session map so all caches reference the same objects
const sessionMap = new Map();

function dedup(projects) {
  for (const p of projects) {
    for (let i = 0; i < p.sessions.length; i++) {
      const s = p.sessions[i];
      if (sessionMap.has(s.sessionId)) {
        Object.assign(sessionMap.get(s.sessionId), s);
        p.sessions[i] = sessionMap.get(s.sessionId);
      } else {
        sessionMap.set(s.sessionId, s);
      }
    }
  }
}

async function loadProjects({ resort = false } = {}) {
  const wasEmpty = cachedProjects.length === 0;
  if (wasEmpty && window.vueStore) window.vueStore.loadingStatus = 'Loading\u2026';
  const [defaultProjects, allProjects] = await Promise.all([
    window.api.getProjects(false),
    window.api.getProjects(true),
  ]);
  cachedProjects = defaultProjects;
  cachedAllProjects = allProjects;
  if (window.vueStore) window.vueStore.loadingStatus = '';
  dedup(cachedProjects);
  dedup(cachedAllProjects);

  // Reconcile pending sessions: remove ones that now have real data
  let hasReinjected = false;
  for (const [sid, pending] of [...pendingSessions]) {
    const realExists = allProjects.some(p => p.sessions.some(s => s.sessionId === sid));
    if (realExists) {
      pendingSessions.delete(sid);
    } else {
      hasReinjected = true;
      // Still pending — re-inject into cached data
      for (const projList of [cachedProjects, cachedAllProjects]) {
        let proj = projList.find(p => p.projectPath === pending.projectPath);
        if (!proj) {
          // Project not in list (no other sessions) — create a synthetic entry
          proj = { folder: pending.folder, projectPath: pending.projectPath, sessions: [] };
          projList.unshift(proj);
        }
        if (!proj.sessions.some(s => s.sessionId === sid)) {
          proj.sessions.unshift(pending.session);
        }
      }
    }
  }

  // Track active plain terminals in pendingSessions/sessionMap (data now comes from backend)
  try {
    const activeTerminals = await window.api.getActiveTerminals();
    for (const { sessionId, projectPath } of activeTerminals) {
      if (pendingSessions.has(sessionId)) continue; // already tracked
      const folder = encodeProjectPath(projectPath);
      // Find the session object already injected by the backend
      let session;
      for (const proj of cachedAllProjects) {
        session = proj.sessions.find(s => s.sessionId === sessionId);
        if (session) break;
      }
      if (!session) continue;
      pendingSessions.set(sessionId, { session, projectPath, folder });
      sessionMap.set(sessionId, session);
    }
  } catch {}

  await pollActiveSessions();
  refreshSidebar({ resort });
  renderDefaultStatus();
}




async function launchNewSession(project, sessionOptions) {
  const sessionId = crypto.randomUUID();
  const projectPath = project.projectPath;
  const session = {
    sessionId,
    summary: 'New session',
    firstPrompt: '',
    projectPath,
    name: null,
    starred: 0,
    archived: 0,
    messageCount: 0,
    modified: new Date().toISOString(),
    created: new Date().toISOString(),
    accountId: activeAccountId,
  };

  // Track as pending (no .jsonl yet)
  const folder = encodeProjectPath(projectPath);
  pendingSessions.set(sessionId, { session, projectPath, folder });

  // Inject into cached project data so it appears in sidebar immediately
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

  // Switch to sessions tab and highlight the new session
  if (window.vueStore?.activeTab !== 'sessions') {
    window.vueApp?.setTab('sessions');
  }
  setActiveSession(sessionId);

  // Expand the project group in sidebar if it's collapsed
  const _folderId = 'project-' + projectPath.replace(/[^a-zA-Z0-9_-]/g, '_');
  const _groupHeader = document.getElementById('ph-' + _folderId);
  if (_groupHeader?.classList.contains('collapsed')) _groupHeader.click();

  const entry = createTerminalEntry(session);

  // Open terminal in main process with session options
  const result = await window.api.openTerminal(sessionId, projectPath, true, sessionOptions || null);
  if (!result.ok) {
    entry.terminal.write(`\r\nError: ${result.error}\r\n`);
    entry.closed = true;
    return;
  }
  if (typeof setSessionMcpActive === 'function') setSessionMcpActive(sessionId, !!result.mcpActive);

  showSession(sessionId);
  pollActiveSessions();
}

// Legacy alias
function openNewSession(project) {
  return launchNewSession(project);
}

async function showTerminalHeader(session) {
  // Drive Vue header
  window.vueSidebar?.setHeaderSession(session);

  // Account badge
  if (accounts.length > 1) {
    const acc = getAccountById(session.accountId || 'default');
    window.vueSidebar?.setHeaderAccount(acc.name);
  } else {
    window.vueSidebar?.setHeaderAccount(null);
  }

  // Shell profile (async)
  try {
    const effective = await window.api.getEffectiveSettings(session.projectPath);
    const profileId = effective.shellProfile || 'auto';
    if (profileId !== 'auto') {
      const profiles = await window.api.getShellProfiles();
      const profile = profiles.find(p => p.id === profileId);
      window.vueSidebar?.setHeaderShellProfile(profile ? profile.name : profileId);
    } else {
      window.vueSidebar?.setHeaderShellProfile(null);
    }
  } catch {
    window.vueSidebar?.setHeaderShellProfile(null);
  }

  // Keep legacy DOM header hidden (Vue header renders instead)
  terminalHeader.style.display = 'none';
}

// Terminal lifecycle (createTerminalEntry, destroySession, showSession, setupDragAndDrop) → terminal-manager.js

async function openSession(session, customOptions) {
  const { sessionId, projectPath } = session;

  // If already open, handle closed-session cleanup or just show it
  if (openSessions.has(sessionId)) {
    const entry = openSessions.get(sessionId);
    if (entry.closed) {
      destroySession(sessionId);
      if (session.type === 'terminal') {
        launchTerminalSession({ projectPath: session.projectPath });
        return;
      }
    } else {
      showSession(sessionId);
      return;
    }
  }

  // Create new terminal entry (hidden until showSession)
  const entry = createTerminalEntry(session);

  // Open terminal in main process
  const resumeOptions = customOptions || await resolveDefaultSessionOptions({ projectPath });
  const result = await window.api.openTerminal(sessionId, projectPath, false, resumeOptions);
  if (!result.ok) {
    entry.terminal.write(`\r\nError: ${result.error}\r\n`);
    entry.closed = true;
    return;
  }
  if (typeof setSessionMcpActive === 'function') setSessionMcpActive(sessionId, !!result.mcpActive);

  showSession(sessionId);
  pollActiveSessions();
}

// Handle window resize
window.addEventListener('resize', () => {
  if (gridViewActive) {
    for (const entry of openSessions.values()) {
      fitAndScroll(entry);
    }
    return;
  }
  if (activeSessionId && openSessions.has(activeSessionId)) {
    const entry = openSessions.get(activeSessionId);
    safeFit(entry);
  }
});

// Tab switching is handled by App.vue (store.activeTab).
// App.vue calls window.__sb.onTabChange(tabName) — defined near bottom of this file.

// Grid view → grid-view.js
// Initialize grid observers now that DOM refs are ready
initGridObservers();


// Stats view (loadStats, buildUsageSection, buildDailyBarChart, buildHeatmap, calculateStreak, buildStatsSummary) → stats-view.js

// Dialogs (resolveDefaultSessionOptions, forkSession, showNewSessionPopover,
// showNewSessionDialog, showResumeSessionDialog, showAddProjectDialog, launchTerminalSession) → dialogs.js


// Sidebar toggle is handled by App.vue (store.sidebarCollapsed).

// --- Sidebar resize ---
{
  const sidebar = document.getElementById('sidebar');
  const handle = document.getElementById('sidebar-resize-handle');
  let dragging = false;

  handle.addEventListener('mousedown', (e) => {
    e.preventDefault();
    dragging = true;
    handle.classList.add('dragging');
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  });

  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const width = Math.min(600, Math.max(200, e.clientX));
    sidebar.style.width = width + 'px';
  });

  window.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    handle.classList.remove('dragging');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    // Refit active terminal
    if (!gridViewActive && activeSessionId && openSessions.has(activeSessionId)) {
      const entry = openSessions.get(activeSessionId);
      safeFit(entry);
    }
    // Save sidebar width to settings
    const width = parseInt(sidebar.style.width);
    if (width) {
      window.api.getSetting('global').then(g => {
        const global = g || {};
        global.sidebarWidth = width;
        window.api.setSetting('global', global);
      });
    }
  });
}

// Grid toggle button is rendered by App.vue. Global keyboard shortcuts:
// When a terminal is focused, xterm's customKeyEventHandler fires first and sets
// e._handled to prevent the document listener from double-firing the same action.
document.addEventListener('keydown', (e) => {
  if (e._handled) return;
  // Cmd/Ctrl+Shift+G → toggle grid view
  const mod = isMac ? e.metaKey : e.ctrlKey;
  if (e.key === 'g' && mod && e.shiftKey && !e.altKey) {
    e.preventDefault();
    toggleGridView();
    return;
  }
  // Session navigation: Cmd+Shift+[/], Cmd+Arrow
  handleSessionNavKey(e);
});

// Warm up xterm.js renderer so first terminal open is fast
setTimeout(() => {
  const warmEl = document.createElement('div');
  warmEl.style.cssText = 'position:absolute;left:-9999px;width:400px;height:200px;';
  document.body.appendChild(warmEl);
  const warmTerm = new Terminal({ cols: 80, rows: 10 });
  const warmFit = new FitAddon.FitAddon();
  warmTerm.loadAddon(warmFit);
  warmTerm.open(warmEl);
  warmTerm.write(' ');
  requestAnimationFrame(() => {
    warmTerm.dispose();
    warmEl.remove();
  });
}, 100);


// --- Init: restore settings ---
(async () => {
  const global = await window.api.getSetting('global');
  if (global) {
    if (global.sidebarWidth) {
      document.getElementById('sidebar').style.width = global.sidebarWidth + 'px';
    }
    if (global.visibleSessionCount) {
      visibleSessionCount = global.visibleSessionCount;
    }
    if (global.sessionMaxAgeDays) {
      sessionMaxAgeDays = global.sessionMaxAgeDays;
    }
    if (global.terminalTheme && TERMINAL_THEMES[global.terminalTheme]) {
      currentThemeName = global.terminalTheme;
      TERMINAL_THEME = getTerminalTheme();
    }
    if (global.monoFont && window.TERMINAL_FONTS?.[global.monoFont]) {
      window._applyTerminalFont?.(window.TERMINAL_FONTS[global.monoFont].family);
    }
    if (global.uiFont && global.uiFont !== 'default' && window.TERMINAL_FONTS?.[global.uiFont]) {
      document.documentElement.style.setProperty('--font-ui', window.TERMINAL_FONTS[global.uiFont].family);
    }
    if (global.showAvatars === false) {
      document.body.classList.add('hide-avatars');
    }
  }
})();

window._setShowAvatars = (val) => {
  document.body.classList.toggle('hide-avatars', !val);
};

window._applyUiFont = (fontKey) => {
  if (fontKey === 'default' || !window.TERMINAL_FONTS?.[fontKey]) {
    document.documentElement.style.removeProperty('--font-ui');
  } else {
    document.documentElement.style.setProperty('--font-ui', window.TERMINAL_FONTS[fontKey].family);
  }
};

// Called by SettingsPanelApp (and window.closeSettingsViewer) after settings closes.
// Restores whichever main-area panel was active before settings opened.
window._restoreAfterSettings = () => {
  if (gridViewActive) {
    terminalArea.style.display = '';
  } else if (activeSessionId && openSessions.has(activeSessionId)) {
    terminalArea.style.display = '';
  } else {
    placeholder.style.display = '';
  }
};

// ── UI state persistence ──────────────────────────────────────────
let _uiState = {};

async function saveUiState(patch) {
  Object.assign(_uiState, patch);
  try { await window.api.setSetting('ui_state', _uiState); } catch {}
}

loadProjects().then(async () => {
  // Restore grid view preference before opening sessions so they enter grid mode
  if (localStorage.getItem('gridViewActive') === '1') {
    showGridView();
  }
  // Restore active session after reload
  if (activeSessionId && !openSessions.has(activeSessionId)) {
    const session = sessionMap.get(activeSessionId);
    if (session) openSession(session);
  }
  // Restore last open panel + sidebar tab
  try {
    _uiState = (await window.api.getSetting('ui_state')) || {};
    // Restore sidebar tab first
    if (_uiState.sidebarTab && _uiState.sidebarTab !== 'sessions') {
      window.vueApp?.setTab(_uiState.sidebarTab);
    }
    // Restore main panel
    if (_uiState.panel === 'project' && _uiState.projectPath) {
      const proj = cachedAllProjects.find(p => p.projectPath === _uiState.projectPath);
      if (proj) {
        openProjectViewer(proj);
        if (_uiState.pvTab) setTimeout(() => window.vueProjectViewer?.setTab(_uiState.pvTab), 50);
      }
    } else if (_uiState.panel === 'stats') {
      hideAllViewers();
      terminalArea.style.display = 'none';
      if (window.vueStore) window.vueStore.showStats = true;
      window.vueStats?.load();
    }
  } catch {}
});

window.api.onLaunchProjectSession((projectPath, continueSession) => {
  if (continueSession) {
    const proj = cachedProjects.find(p => p.projectPath === projectPath);
    const last = proj?.sessions?.find(s => !s.archived);
    if (last) {
      if (window.vueStore?.activeTab !== 'sessions') window.vueApp?.setTab('sessions');
      setActiveSession(last.sessionId);
      openSession(last);
      return;
    }
  }
  launchNewSession({ projectPath });
});

// Live-reload sidebar when filesystem changes are detected
let projectsChangedTimer = null;
let projectsChangedWhileAway = false;
window.api.onProjectsChanged(() => {
  if (projectsChangedTimer) clearTimeout(projectsChangedTimer);

  if (pendingAccountSwitch) {
    pendingAccountSwitch = false;
    if (window.vueStore) window.vueStore.accountSwitching = false;
    loadProjects();
    return;
  }

  const activeTab = window.vueStore?.activeTab || 'sessions';
  if (activeTab !== 'sessions' && activeTab !== 'projects') {
    projectsChangedWhileAway = true;
    return;
  }
  projectsChangedTimer = setTimeout(() => {
    projectsChangedTimer = null;
    const tab = window.vueStore?.activeTab || 'sessions';
    if (tab === 'sessions') {
      loadProjects();
    } else if (tab === 'projects') {
      loadProjects().then(() => renderProjectsPanel());
    }
  }, 300);
});

// Status bar
function renderDefaultStatus() {
  const totalSessions = cachedAllProjects.reduce((n, p) => n + p.sessions.length, 0);
  const totalProjects = cachedAllProjects.length;
  const running = activePtyIds.size;
  const parts = [];
  if (running > 0) parts.push(`${running} running`);
  parts.push(`${totalSessions} sessions`);
  parts.push(`${totalProjects} projects`);
  window.vueStatusBar?.setInfo(parts.join(' \u00b7 '));
}

window.api.onStatusUpdate((text, type) => {
  window.vueStatusBar?.setActivity(text, type);
});

// --- Auto-update status + toast ---
function setUpdaterStatus(text, duration) {
  window.vueStatusBar?.setUpdater(text, duration);
}
const updaterHandler = (type, data) => {
  switch (type) {
    case 'checking':
      setUpdaterStatus('Checking for updates…');
      break;
    case 'update-available':
      setUpdaterStatus(`Update available: v${data.version}`);
      break;
    case 'update-not-available':
      setUpdaterStatus('Up to date', 3000);
      break;
    case 'download-progress':
      setUpdaterStatus(`Updating… ${Math.round(data.percent)}%`);
      break;
    case 'update-downloaded': {
      setUpdaterStatus(`v${data.version} ready — restart to update`);
      const dismissed = localStorage.getItem('update-dismissed');
      if (dismissed === data.version) return;
      const toast = document.getElementById('update-toast');
      const msg = document.getElementById('update-toast-msg');
      const notice = (data.releaseName && data.releaseName !== `v${data.version}` && data.releaseName !== data.version) ? `<span class="update-summary">${escapeHtml(data.releaseName)}</span>` : '';
      msg.innerHTML = `New Version Ready<br><span class="update-version">v${data.version}</span> (<a href="https://github.com/fortael/wootonpad/releases" target="_blank" class="update-notes-link">release notes</a>)${notice}`;
      toast.classList.remove('hidden');
      document.getElementById('update-restart-btn').onclick = () => window.api.updaterInstall();
      document.getElementById('update-dismiss-btn').onclick = () => {
        toast.classList.add('hidden');
        localStorage.setItem('update-dismissed', data.version);
      };
      break;
    }
    case 'error':
      setUpdaterStatus('Update check failed', 5000);
      break;
  }
};
window.api.onUpdaterEvent(updaterHandler);

// --- Initialize file panel (MCP bridge UI) ---
if (typeof initFilePanel === 'function') initFilePanel();

// ─── Multi-account ────────────────────────────────────────────────────────────

let accounts = [];
let activeAccountId = 'default';
let accountsUsage = {};
let pendingAccountSwitch = false;

const terminalHeaderAccount = document.getElementById('terminal-header-account');

function getAccountById(id) {
  return accounts.find(a => a.id === id) || { id: 'default', name: 'Default', configDir: '' };
}

function buildUsageChips(usage) {
  if (!usage || usage._error || usage._rateLimited) return [];
  const chips = [];
  if (usage.session != null) chips.push(`${usage.session}% 5h`);
  return chips;
}

function updateAccountDropdown() {
  window.vueAccountDropdown?.setAccounts(accounts, activeAccountId, accountsUsage);
}

function closeAccountDropdown() {
  window.vueAccountDropdown?.close();
}

async function openAccountHomeSession(account) {
  const homedir = await window.api.getHomedir();

  // Reuse an already-open home-dir terminal for this account
  for (const [sid, entry] of openSessions) {
    if (!entry.closed &&
        (entry.session?.accountId || 'default') === account.id &&
        entry.session?.projectPath === homedir) {
      showSession(sid);
      return;
    }
  }

  // Nothing open yet — launch a new session (stays on accounts tab, terminal appears in main area)
  await launchNewSession({ projectPath: homedir }, {});
}

async function switchAccount(id) {
  if (id === activeAccountId) return;
  activeAccountId = id;
  updateAccountDropdown();
  renderAccountsPanel();

  if (window.vueStore) window.vueStore.accountSwitching = true;
  pendingAccountSwitch = true;

  await window.api.setActiveAccountId(id);

  window.vueStats?.invalidate();
  const activeTab = window.vueStore?.activeTab || 'sessions';
  if (activeTab === 'stats') window.vueStats?.load();
  if (activeTab === 'projects') loadProjects().then(() => renderProjectsPanel());
  // accountSwitching stays true — cleared in onProjectsChanged once new data arrives
}

// makeGroup is defined in utils.js (loaded first)
// Keep old name as alias for any remaining callers
function makePanelHeader(titleText, btnLabel, onBtnClick) {
  return makeGroup(titleText, btnLabel, onBtnClick).group;
}

function renderAccountsPanel() {
  window.vueAccounts?.setAccounts(accounts, activeAccountId);
  window.vueAccounts?.setUsage(accountsUsage);
}

function _renderAccountsPanelOld() {
  if (!accountsContent) return;
  accountsContent.innerHTML = '';

  const { list: accountsList } = makeGroup('Accounts');
  accountsContent.appendChild(accountsList.parentElement);

  for (const acc of accounts) {
    // Trailing: edit button + open button + delete button
    const actions = document.createElement('div');
    actions.className = 'account-card-actions';

    const openBtn = document.createElement('button');
    openBtn.className = 'account-open-btn';
    openBtn.dataset.tooltip = 'Open Claude session in home directory';
    openBtn.textContent = 'Open Claude';
    openBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (acc.id !== activeAccountId) await switchAccount(acc.id);
      await openAccountHomeSession(acc);
    });

    const editBtn = document.createElement('button');
    editBtn.className = 'account-edit-btn';
    editBtn.dataset.tooltip = 'Rename';
    editBtn.innerHTML = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>';

    actions.appendChild(editBtn);
    actions.appendChild(openBtn);

    if (acc.id !== 'default') {
      const del = document.createElement('button');
      del.className = 'account-row-del';
      del.dataset.tooltip = 'Remove account';
      del.innerHTML = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4h6v2"/></svg>';
      del.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (!confirm(`Remove account "${acc.name}"?`)) return;
        if (activeAccountId === acc.id) await switchAccount('default');
        accounts = accounts.filter(a => a.id !== acc.id);
        await window.api.deleteAccount(acc.id);
        updateAccountDropdown();
        renderAccountsPanel();
      });
      actions.appendChild(del);
    }

    // ── Usage block (children slot) ──
    const accUsage = accountsUsage[acc.id] || {};
    const usageDefs = [
      { key: 'session', resetInKey: 'sessionResetIn', label: '5h' },
      { key: 'weekAll', resetInKey: 'weekAllResetIn', label: '7d' },
    ];
    const usageRows = usageDefs.filter(d => accUsage[d.key] != null);
    let usageBlock = null;
    if (usageRows.length) {
      usageBlock = document.createElement('div');
      usageBlock.className = 'account-usage-block';
      for (const d of usageRows) {
        const pct = accUsage[d.key];
        const barPct = Math.min(pct, 100);
        const usageRow = document.createElement('div');
        usageRow.className = 'account-usage-row';

        const label = document.createElement('span');
        label.className = 'account-usage-label';
        label.textContent = d.label;

        const barWrap = document.createElement('div');
        barWrap.className = 'account-usage-bar';
        const barFill = document.createElement('div');
        barFill.className = 'account-usage-bar-fill' + (barPct >= 90 ? ' danger' : barPct >= 70 ? ' warn' : '');
        barFill.style.width = barPct + '%';
        barWrap.appendChild(barFill);

        const usageInfo = document.createElement('span');
        usageInfo.className = 'account-usage-info';
        const resetIn = accUsage[d.resetInKey];
        usageInfo.textContent = `${pct}%` + (resetIn ? `  · resets in ${resetIn}~` : '');

        usageRow.appendChild(label);
        usageRow.appendChild(barWrap);
        usageRow.appendChild(usageInfo);
        usageBlock.appendChild(usageRow);
      }
      if (accUsage._cached) {
        const stale = document.createElement('div');
        stale.className = 'account-usage-cached-note';
        stale.textContent = 'cached data';
        usageBlock.appendChild(stale);
      }
    }

    const { item: card, titleEl: nameEl } = buildListItem({
      title: acc.name,
      subtitle: acc.configDir || '~/.claude (default)',
      trailing: actions,
      classes: ['account-item', acc.id === activeAccountId ? 'active' : ''],
      children: usageBlock,
    });

    // Inline name editing via dblclick on title
    const nameEditInput = document.createElement('input');
    nameEditInput.className = 'account-row-name-input';
    nameEditInput.value = acc.name;
    nameEditInput.style.display = 'none';
    nameEl.after(nameEditInput);

    const startEdit = (e) => {
      e?.stopPropagation();
      nameEl.style.display = 'none';
      editBtn.style.display = 'none';
      nameEditInput.style.display = '';
      nameEditInput.focus();
      nameEditInput.select();
    };
    const saveNameEdit = async () => {
      const newName = nameEditInput.value.trim() || acc.name;
      if (newName !== acc.name) {
        acc.name = newName;
        await window.api.renameAccount(acc.id, newName);
        updateAccountDropdown();
      }
      nameEditInput.style.display = 'none';
      nameEl.textContent = acc.name;
      nameEl.style.display = '';
      editBtn.style.display = '';
    };
    editBtn.addEventListener('click', startEdit);
    nameEl.addEventListener('dblclick', startEdit);
    nameEditInput.addEventListener('blur', saveNameEdit);
    nameEditInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); nameEditInput.blur(); }
      if (e.key === 'Escape') { nameEditInput.value = acc.name; nameEditInput.blur(); }
    });
    nameEditInput.addEventListener('click', (e) => e.stopPropagation());

    // Click card body = switch account (but not open session)
    card.addEventListener('click', async () => {
      if (acc.id !== activeAccountId) await switchAccount(acc.id);
    });
    accountsList.appendChild(card);
  }

  // Add account section
  const { list: addList } = makeGroup('Add account');
  accountsContent.appendChild(addList.parentElement);

  const desc = document.createElement('p');
  desc.className = 'accounts-add-desc';
  desc.textContent = 'Each account uses its own Claude credentials and session history. Add a second account to switch between personal and work Claude Pro plans, or any two separate logins.';
  addList.appendChild(desc);

  const form = document.createElement('div');
  form.className = 'accounts-add-form';

  const newNameInput = document.createElement('input');
  newNameInput.placeholder = 'Account name (e.g. Work)';

  const addBtn = document.createElement('button');
  addBtn.className = 'accounts-add-btn';
  addBtn.textContent = 'Add account';

  addBtn.addEventListener('click', async () => {
    const name = newNameInput.value.trim();
    if (!name) return;
    addBtn.disabled = true;
    addBtn.textContent = 'Adding…';
    const newAcc = await window.api.createAccount(name);
    addBtn.disabled = false;
    addBtn.textContent = 'Add account';
    if (!newAcc) return;
    accounts = [...accounts, newAcc];
    newNameInput.value = '';
    await refreshAccountUsage();
    updateAccountDropdown();
    renderAccountsPanel();
  });

  newNameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') addBtn.click(); });

  form.appendChild(newNameInput);
  form.appendChild(addBtn);
  addList.appendChild(form);
}

let projectsSearchQuery = '';
let projectsSortOrder = 'name'; // 'name' | 'changes'
const projectInfoCache = new Map(); // persists across renders

function openProjectViewer(project) {
  hideAllViewers();
  placeholder.style.display = 'none';
  terminalArea.style.display = 'none';
  projectViewer.style.display = 'flex';
  window.vueProjectViewer?.open(project);
  saveUiState({ panel: 'project', projectPath: project.projectPath });
}

function renderProjectsPanel() {
  window.vueProjects?.setProjects(cachedAllProjects);
}

function _renderProjectsPanelOld() {
  if (!projectsContent) return;
  projectsContent.innerHTML = '';

  const allProjects = cachedAllProjects;

  const { group: projectsGroup, list: projectsList } = makeGroup(
    `Projects (${allProjects.length})`, 'Add', () => showAddProjectDialog()
  );
  projectsContent.appendChild(projectsGroup);

  // Sort buttons — inside project-header (next to the Add button)
  const sortWrap = document.createElement('div');
  sortWrap.className = 'projects-sort-wrap';
  for (const [key, label] of [['name', 'Name'], ['changes', 'Changes']]) {
    const btn = document.createElement('button');
    btn.className = 'projects-sort-btn' + (projectsSortOrder === key ? ' active' : '');
    btn.textContent = label;
    btn.addEventListener('click', () => {
      projectsSortOrder = key;
      renderProjectsList(projectsSearchQuery);
      sortWrap.querySelectorAll('.projects-sort-btn').forEach(b => b.classList.toggle('active', b === btn));
    });
    sortWrap.appendChild(btn);
  }
  projectsGroup.querySelector('.project-header').appendChild(sortWrap);

  const listEl = document.createElement('div');
  listEl.id = 'projects-list';
  projectsList.appendChild(listEl);

  function renderInfoEl(infoEl, info) {
    if (!info) return;
    infoEl.innerHTML = '';
    let hasContent = false;

    // Merge branch info into the card's meta row
    const card = infoEl.closest('.project-item');
    const metaEl = card && card.querySelector('.session-meta');
    if (metaEl) {
      const base = metaEl.dataset.baseText || metaEl.textContent;
      metaEl.dataset.baseText = base;
      if (info.branch) {
        metaEl.innerHTML = '';
        metaEl.appendChild(document.createTextNode(base + ' · '));
        const branchIcon = document.createElement('span');
        branchIcon.className = 'project-env-branch-icon';
        branchIcon.textContent = '⎇';
        metaEl.appendChild(branchIcon);
        metaEl.appendChild(document.createTextNode(' ' + info.branch));
        if (info.added) {
          const a = document.createElement('span');
          a.className = 'project-env-added';
          a.textContent = ` +${info.added}`;
          metaEl.appendChild(a);
        }
        if (info.deleted) {
          const d = document.createElement('span');
          d.className = 'project-env-deleted';
          d.textContent = ` −${info.deleted}`;
          metaEl.appendChild(d);
        }
      } else {
        metaEl.textContent = base;
      }
    }

    if (info.containers && info.containers.length) {
      hasContent = true;
      const box = document.createElement('div');
      box.className = 'project-env-containers-box';
      const boxHdr = document.createElement('div');
      boxHdr.className = 'project-env-containers-hdr';
      boxHdr.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 7V5a2 2 0 0 0-4 0v2M8 7V5a2 2 0 0 0-4 0v2"/></svg> CONTAINERS · ${info.containers.length}`;
      box.appendChild(boxHdr);
      for (const c of info.containers) {
        const row = document.createElement('div');
        const isRunning = c.state.includes('running');
        const isStarting = !isRunning && (c.state.includes('starting') || c.status?.toLowerCase().includes('starting'));
        row.className = 'project-env-container-row';
        const dot = document.createElement('span');
        dot.className = 'project-env-dot' + (isRunning ? ' running' : isStarting ? ' starting' : '');
        const uptime = parseContainerUptime(c.status);
        const nameEl = document.createElement('span');
        nameEl.className = 'project-env-cname';
        nameEl.textContent = c.name;
        const uptimeEl = document.createElement('span');
        uptimeEl.className = 'project-env-cuptime';
        uptimeEl.textContent = uptime || '';
        row.appendChild(dot);
        row.appendChild(nameEl);
        row.appendChild(uptimeEl);
        if (!isRunning && c.state && c.state !== 'exited') {
          const badge = document.createElement('span');
          badge.className = 'project-env-cbadge' + (isStarting ? ' starting' : '');
          badge.textContent = c.state;
          row.appendChild(badge);
        }
        box.appendChild(row);
      }
      infoEl.appendChild(box);
    }
    const hasBranch = !!(info.branch || (metaEl && info.branch));
    if (hasBranch || hasContent) infoEl.classList.add('loaded');
  }

  // Background queue: fetch git+docker info one project at a time
  let infoQueueAborted = false;
  async function runInfoQueue(projects) {
    for (const project of projects) {
      if (infoQueueAborted) break;
      const infoEl = listEl.querySelector(`[data-project-info="${CSS.escape(project.projectPath)}"]`);
      if (!infoEl) continue;
      // Show cached immediately (no flash)
      const prev = projectInfoCache.get(project.projectPath);
      if (prev) renderInfoEl(infoEl, prev);
      try {
        const info = await window.api.getProjectInfo(project.projectPath);
        if (infoQueueAborted) break;
        if (!info) continue;
        projectInfoCache.set(project.projectPath, info);
        renderInfoEl(infoEl, info);
      } catch {}
    }
  }

  function renderProjectsList(query) {
    infoQueueAborted = true; // cancel previous queue if re-rendering
    listEl.innerHTML = '';
    infoQueueAborted = false;

    const q = query.trim().toLowerCase();
    let filtered = q
      ? allProjects.filter(p => {
          const name = p.projectPath.split('/').filter(Boolean).pop() || '';
          return name.toLowerCase().includes(q) || p.projectPath.toLowerCase().includes(q);
        })
      : [...allProjects];

    if (projectsSortOrder === 'name') {
      filtered.sort((a, b) => {
        const na = a.projectPath.split('/').filter(Boolean).pop() || '';
        const nb = b.projectPath.split('/').filter(Boolean).pop() || '';
        return na.localeCompare(nb);
      });
    } else if (projectsSortOrder === 'changes') {
      filtered.sort((a, b) => {
        const ia = projectInfoCache.get(a.projectPath);
        const ib = projectInfoCache.get(b.projectPath);
        const sa = (ia?.added || 0) + (ia?.deleted || 0);
        const sb = (ib?.added || 0) + (ib?.deleted || 0);
        return sb - sa;
      });
    }

    if (!filtered.length) {
      const empty = document.createElement('div');
      empty.className = 'projects-empty-hint';
      empty.textContent = q ? 'No matching projects.' : 'No projects yet. Click Add to select a folder.';
      listEl.appendChild(empty);
      return;
    }

    for (const project of filtered) {
      const name = project.projectPath.split('/').filter(Boolean).pop() || project.projectPath;
      const lastSession = project.sessions[0];
      const lastActivity = lastSession ? formatDate(new Date(lastSession.modified)) : '—';
      const sessionCount = project.sessions.length;
      const { initials, color } = getProjectAvatar(project.projectPath);

      // Leading: avatar
      const avatarEl = document.createElement('span');
      avatarEl.className = 'project-card-avatar';
      avatarEl.textContent = initials;
      avatarEl.style.background = color;

      // Trailing: action buttons
      const cardActions = document.createElement('div');
      cardActions.className = 'project-card-actions';

      const newBtn = document.createElement('button');
      newBtn.className = 'project-card-new-btn';
      newBtn.dataset.tooltip = 'New session';
      newBtn.innerHTML = '<svg width="13" height="13" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><line x1="6" y1="1" x2="6" y2="11"/><line x1="1" y1="6" x2="11" y2="6"/></svg>';
      newBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        showNewSessionPopover(project, newBtn);
      });

      const delBtn = document.createElement('button');
      delBtn.className = 'project-card-del-btn';
      delBtn.dataset.tooltip = 'Remove project';
      delBtn.innerHTML = ICONS.trash(13);
      delBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (!confirm(`Remove "${name}" from the project list?\n\nSession files are not deleted.`)) return;
        await window.api.removeProject(project.projectPath);
      });

      cardActions.appendChild(newBtn);
      cardActions.appendChild(delBtn);

      // Env area (children slot) — spans full width below the row
      const envEl = document.createElement('div');
      envEl.className = 'project-card-env';
      envEl.dataset.projectInfo = project.projectPath;

      const metaText = `${sessionCount} session${sessionCount !== 1 ? 's' : ''} · ${lastActivity}`;
      const { item: card, subtitleEl: pathEl, metaEl } = buildListItem({
        title: name,
        subtitle: project.projectPath,
        meta: metaText,
        leading: avatarEl,
        trailing: cardActions,
        classes: ['project-item'],
        children: envEl,
      });
      pathEl.dataset.tooltip = project.projectPath;
      metaEl.dataset.baseText = metaText;

      card.addEventListener('click', (e) => {
        if (e.target.closest('.project-card-actions')) return;
        listEl.querySelectorAll('.project-item.active').forEach(c => c.classList.remove('active'));
        card.classList.add('active');
        openProjectViewer(project);
      });

      listEl.appendChild(card);
    }

    // Start background info loading
    runInfoQueue(filtered);
  }

  renderProjectsList(projectsSearchQuery);
}

async function refreshAccountUsage() {
  try {
    accountsUsage = await window.api.getAccountsUsage();
    window.vueAccounts?.setUsage(accountsUsage);
    window.vueAccountDropdown?.setUsage(accountsUsage);
  } catch {}
}

async function initAccounts() {
  [accounts, activeAccountId] = await Promise.all([
    window.api.getAccounts(),
    window.api.getActiveAccountId(),
  ]);
  await refreshAccountUsage();
  updateAccountDropdown();
}

// Custom tooltip system
(function () {
  const tip = document.getElementById('app-tooltip');
  if (!tip) return;
  let timer = null;
  let activeEl = null;

  function showTip(el) {
    tip.textContent = el.dataset.tooltip;
    tip.style.display = 'block';
    tip.style.opacity = '0';

    const rect = el.getBoundingClientRect();
    const tw = tip.offsetWidth;
    const th = tip.offsetHeight;
    let left = rect.left + rect.width / 2 - tw / 2;
    let top = rect.bottom + 6;
    if (left < 4) left = 4;
    if (left + tw > window.innerWidth - 4) left = window.innerWidth - tw - 4;
    if (top + th > window.innerHeight - 4) top = rect.top - th - 6;

    tip.style.left = left + 'px';
    tip.style.top = top + 'px';
    tip.style.opacity = '1';
  }

  function hideTip() {
    clearTimeout(timer);
    tip.style.opacity = '0';
    activeEl = null;
  }

  document.addEventListener('mouseover', (e) => {
    const el = e.target.closest('[data-tooltip]');
    if (el === activeEl) return;
    clearTimeout(timer);
    tip.style.opacity = '0';
    activeEl = el;
    if (!el) return;
    timer = setTimeout(() => showTip(el), 350);
  });

  document.addEventListener('mouseout', (e) => {
    if (!activeEl) return;
    if (!activeEl.contains(e.relatedTarget)) hideTip();
  });

  document.addEventListener('click', hideTip);
  document.addEventListener('scroll', hideTip, true);
}());

initAccounts();

// --- App.vue side-effect callbacks ---
// App.vue calls these when the user interacts with the sidebar shell
// (tabs, filters, search). Each callback syncs local app.js state and
// triggers whatever data loading or rendering is needed.
window.__sb = {
  onTabChange(tabName) {
    activeTab = tabName;
    searchMatchIds = null;
    searchMatchProjectPaths = null;
    window.vueSidebar?.setSearch(null, null);
    saveUiState({ sidebarTab: tabName });

    if (tabName === 'sessions') {
      saveUiState({ panel: 'terminal', sidebarTab: tabName });
      if (gridViewActive) {
        for (const entry of openSessions.values()) {
          if (!entry.closed) fitAndScroll(entry);
        }
      } else if (activeSessionId && openSessions.has(activeSessionId)) {
        showSession(activeSessionId);
      } else {
        placeholder.style.display = '';
      }
      if (projectsChangedWhileAway) {
        projectsChangedWhileAway = false;
        loadProjects();
      }
    } else if (tabName === 'plans') {
      hideAllViewers();
      loadPlans();
    } else if (tabName === 'stats') {
      saveUiState({ panel: 'stats' });
      hideAllViewers();
      terminalArea.style.display = 'none';
      if (window.vueStore) window.vueStore.showStats = true;
      window.vueStats?.load();
    } else if (tabName === 'memory') {
      saveUiState({ panel: 'memory' });
      hideAllViewers();
      loadMemories();
    } else if (tabName === 'accounts') {
      hideAllViewers();
      renderAccountsPanel();
      refreshAccountUsage().then(() => renderAccountsPanel());
    } else if (tabName === 'projects') {
      if (projectsChangedWhileAway) {
        projectsChangedWhileAway = false;
        loadProjects().then(() => renderProjectsPanel());
      } else {
        renderProjectsPanel();
      }
    }
  },

  onFilterChange({ showStarredOnly: s, showRunningOnly: r, showTodayOnly: t, showArchived: a }) {
    showStarredOnly = s;
    showRunningOnly = r;
    showTodayOnly = t;
    showArchived = a;
    refreshSidebar({ resort: true });
  },

  async search(query, titlesOnly) {
    const tab = activeTab;
    try {
      if (tab === 'sessions') {
        const results = await window.api.search('session', query, titlesOnly);
        searchMatchIds = new Set(results.map(r => r.id));
        searchMatchProjectPaths = null;
        if (titlesOnly) {
          const matchProjects = new Set();
          for (const r of results) {
            const s = sessionMap.get(r.id);
            if (s?.projectPath) matchProjects.add(s.projectPath);
          }
          searchMatchProjectPaths = matchProjects;
        }
        window.vueSidebar?.setSearch(searchMatchIds, searchMatchProjectPaths);
        refreshSidebar({ resort: true });
      } else if (tab === 'plans') {
        const results = await window.api.search('plan', query, titlesOnly);
        const matchIds = new Set(results.map(r => r.id));
        renderPlans(window.cachedPlans.filter(p => matchIds.has(p.filename)));
      } else if (tab === 'memory') {
        const results = await window.api.search('memory', query, titlesOnly);
        renderMemories(new Set(results.map(r => r.id)));
      } else if (tab === 'projects') {
        projectsSearchQuery = query;
        window.vueProjects?.setSearch(query);
      }
    } catch {
      if (tab === 'sessions') {
        searchMatchIds = null;
        searchMatchProjectPaths = null;
        window.vueSidebar?.setSearch(null, null);
        refreshSidebar({ resort: true });
      }
    }
  },

  clearSearch,

  resort: () => loadProjects({ resort: true }),

  addProject: () => showAddProjectDialog(),

  openGlobalSettings: () => openSettingsViewer('global'),

  toggleGridView: () => toggleGridView(),

  openSession: (session) => openSession(session),

  stopSession: (id) => confirmAndStopSession(id),

  toggleStar: async (id) => {
    const { starred } = await window.api.toggleStar(id);
    const s = sessionMap.get(id);
    if (s) s.starred = starred;
    refreshSidebar({ resort: true });
  },

  archiveSession: async (id) => {
    const session = sessionMap.get(id);
    if (!session) return;
    const newVal = session.archived ? 0 : 1;
    if (newVal && activePtyIds.has(id)) {
      await window.api.stopSession(id);
      pollActiveSessions();
    }
    await window.api.archiveSession(id, newVal);
    session.archived = newVal;
    loadProjects();
  },

  forkSession: (id) => {
    const session = sessionMap.get(id);
    const project = [...cachedAllProjects, ...cachedProjects].find(p =>
      p.sessions.some(s => s.sessionId === id)
    );
    if (session && project && typeof forkSession === 'function') forkSession(session, project);
  },

  showJsonl: (id) => {
    const session = sessionMap.get(id);
    if (!session) return;
    hideAllViewers();
    terminalArea.style.display = 'none';
    if (window.vueStore) window.vueStore.showJsonl = true;
    window.vueJsonlViewer?.open(session);
  },

  launchConfig: (id) => {
    const session = sessionMap.get(id);
    if (session && typeof showResumeSessionDialog === 'function') showResumeSessionDialog(session);
  },

  renameSession: async (id, name) => {
    await window.api.renameSession(id, name);
    const s = sessionMap.get(id);
    if (s) s.name = name;
    // Replace the session object in Vue's reactive array via splice — this is the
    // only reliable way to force ProjectGroup.allItems to recompute, because simple
    // property mutation on the nested object is not always detected by Vue's watcher.
    if (window.vueStore?.projects) {
      outer: for (const p of window.vueStore.projects) {
        if (!p.sessions) continue;
        for (let i = 0; i < p.sessions.length; i++) {
          if (p.sessions[i]?.sessionId === id) {
            p.sessions.splice(i, 1, { ...p.sessions[i], name });
            break outer;
          }
        }
      }
    }
    refreshSidebar();
  },

  newSession: (project, anchorEl) => {
    if (typeof showNewSessionPopover === 'function') showNewSessionPopover(project, anchorEl);
  },

  openSettings: (path) => openSettingsViewer('project', path),

  archiveSessions: async (sessions) => {
    const active = sessions.filter(s => !s.archived);
    if (!active.length) return;
    const shortName = active[0]?.projectPath?.split('/').filter(Boolean).slice(-2).join('/') || '';
    if (!confirm(`Archive all ${active.length} session${active.length > 1 ? 's' : ''} in ${shortName}?`)) return;
    for (const s of active) {
      if (activePtyIds.has(s.sessionId)) await window.api.stopSession(s.sessionId);
      await window.api.archiveSession(s.sessionId, 1);
      s.archived = 1;
    }
    pollActiveSessions();
    loadProjects();
  },

  removeProject: async (path) => {
    const name = path.split('/').pop();
    if (!confirm(`Hide worktree "${name}"?\n\nSession files are not deleted.`)) return;
    await window.api.removeProject(path);
    loadProjects();
  },

  openPlan: (plan) => openPlan(plan),

  openMemory: (file) => openMemory(file),

  switchAccount: (id) => switchAccount(id),

  openAccountHomeSession: (acc) => openAccountHomeSession(acc),

  renameAccount: async (id, name) => {
    await window.api.renameAccount(id, name);
    updateAccountDropdown();
  },

  deleteAccount: async (id) => {
    if (activeAccountId === id) await switchAccount('default');
    accounts = accounts.filter(a => a.id !== id);
    await window.api.deleteAccount(id);
    updateAccountDropdown();
    renderAccountsPanel();
  },

  createAccount: async (name) => {
    const newAcc = await window.api.createAccount(name);
    if (!newAcc) return null;
    accounts = [...accounts, newAcc];
    await refreshAccountUsage();
    updateAccountDropdown();
    renderAccountsPanel();
    return newAcc;
  },

  openProject: (project) => openProjectViewer(project),
  onPvTabChange: (tab) => saveUiState({ pvTab: tab }),

  openSessionById: (sessionId) => {
    const session = sessionMap.get(sessionId);
    if (!session) return;
    hideAllViewers();
    window.vueApp?.setTab('sessions');
    openSession(session);
  },

  projectRemoved: () => loadProjects().then(() => renderProjectsPanel()),
};

// Sync initial account dropdown state (initAccounts may already have run)
updateAccountDropdown();
