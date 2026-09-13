const statusBarInfo = document.getElementById('status-bar-info');
const statusBarActivity = document.getElementById('status-bar-activity');
const terminalsEl = document.getElementById('terminals');
const sidebarContent = document.getElementById('sidebar-content');
const plansContent = document.getElementById('plans-content');
const placeholder = document.getElementById('placeholder');
const archiveToggle = document.getElementById('archive-toggle');
const starToggle = document.getElementById('star-toggle');
const searchInput = document.getElementById('search-input');
const terminalHeader = document.getElementById('terminal-header');
const terminalHeaderName = document.getElementById('terminal-header-name');
const terminalHeaderId = document.getElementById('terminal-header-id');
const terminalHeaderStatus = document.getElementById('terminal-header-status');
const terminalHeaderShell = document.getElementById('terminal-header-shell');
const terminalStopBtn = document.getElementById('terminal-stop-btn');
const runningToggle = document.getElementById('running-toggle');
const todayToggle = document.getElementById('today-toggle');
const planViewer = document.getElementById('plan-viewer');
const planPanel = new ViewerPanel(planViewer, {
  copyPath: true, copyContent: true,
  language: 'markdown', storageKey: 'markdownPreviewMode',
  onSave: (filePath, content) => window.api.savePlan(filePath, content),
});

// currentPlanContent, currentPlanFilePath, currentPlanFilename → plans-memory-view.js
const loadingStatus = document.getElementById('loading-status');
const sessionFilters = document.getElementById('session-filters');
const searchBar = document.getElementById('search-bar');
const statsContent = document.getElementById('stats-content');
const memoryContent = document.getElementById('memory-content');
const statsViewer = document.getElementById('stats-viewer');
const statsViewerBody = document.getElementById('stats-viewer-body');
const memoryViewer = document.getElementById('memory-viewer');
const memoryPanel = new ViewerPanel(memoryViewer, {
  copyPath: true, copyContent: true,
  language: 'markdown', storageKey: 'markdownPreviewMode',
  onSave: (filePath, content) => window.api.saveMemory(filePath, content),
});
const terminalArea = document.getElementById('terminal-area');
const settingsViewer = document.getElementById('settings-viewer');
const globalSettingsBtn = document.getElementById('global-settings-btn');
const addProjectBtn = document.getElementById('add-project-btn');
const projectsContent = document.getElementById('projects-content');
const resortBtn = document.getElementById('resort-btn');
const jsonlViewer = document.getElementById('jsonl-viewer');
const jsonlViewerTitle = document.getElementById('jsonl-viewer-title');
const jsonlViewerSessionId = document.getElementById('jsonl-viewer-session-id');
const jsonlViewerBody = document.getElementById('jsonl-viewer-body');
const gridViewer = document.getElementById('grid-viewer');
const gridViewerCount = document.getElementById('grid-viewer-count');
let gridViewActive = localStorage.getItem('gridViewActive') === '1';

// Map<sessionId, { terminal, element, fitAddon, session, closed }>
const openSessions = new Map();
window._openSessions = openSessions;
// sessionStorage covers renderer reloads; localStorage also restores the last
// terminal after the Electron process itself restarts.
const ACTIVE_SESSION_KEY = 'activeSessionId';
let activeSessionId = sessionStorage.getItem(ACTIVE_SESSION_KEY) || localStorage.getItem(ACTIVE_SESSION_KEY) || null;
function setActiveSession(id) {
  activeSessionId = id;
  if (id) {
    sessionStorage.setItem(ACTIVE_SESSION_KEY, id);
    localStorage.setItem(ACTIVE_SESSION_KEY, id);
  } else {
    sessionStorage.removeItem(ACTIVE_SESSION_KEY);
    localStorage.removeItem(ACTIVE_SESSION_KEY);
  }
  // Update file panel to show this session's open files/diffs
  if (typeof switchPanel === 'function') switchPanel(id);
}
// Persist slug group expand state across reloads
function getExpandedSlugs() {
  try { return new Set(JSON.parse(sessionStorage.getItem('expandedSlugs') || '[]')); } catch { return new Set(); }
}
function saveExpandedSlugs() {
  const expanded = [];
  document.querySelectorAll('.slug-group:not(.collapsed)').forEach(g => { if (g.id) expanded.push(g.id); });
  sessionStorage.setItem('expandedSlugs', JSON.stringify(expanded));
}
let showArchived = false;
let showStarredOnly = false;
let showRunningOnly = false;
let showTodayOnly = false;
let cachedProjects = [];
let cachedAllProjects = [];
// Projects tab (projects-view.js): project → tracks → sessions, from
// getProjectTree. Same session objects as the two caches above (dedupTree).
let cachedProjectTree = { projects: [] };    // archived excluded
let cachedProjectTreeAll = { projects: [] }; // everything
let activePtyIds = new Set();
let sortedOrder = []; // [{ projectPath, itemIds: [itemId, ...] }, ...] — single source of truth for sidebar order
// Only Sessions and Projects are remembered: the others (Plans, Agent Files,
// Stats) are places you visit, not places you work from.
const REMEMBERED_TABS = ['sessions', 'projects'];
const LAST_TAB_KEY = 'lastTab';
function rememberedTab() {
  try {
    const saved = localStorage.getItem(LAST_TAB_KEY);
    return REMEMBERED_TABS.includes(saved) ? saved : 'sessions';
  } catch { return 'sessions'; }
}
let activeTab = 'sessions';
let cachedPlans = [];
let visibleSessionCount = 10;
let sessionMaxAgeDays = 3;
const pendingSessions = new Map(); // sessionId → { session, projectPath, folder }

// Bridge functions for settings-panel.js
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
//   1. OSC 0 spinner (authoritative: Claude CLI prefixes the title with a
//      braille or half-circle spinner frame)
//   2. Noise-filtered terminal output (fallback: non-noise, non-TUI-repaint data)
//
// Both feed into setActivity(sessionId, active):
//   active=true  → cli-busy (spinner dot)
//   active=false → response-ready if not focused (terminal state until user clicks)
// OSC 0 idle signal is the authoritative source for marking sessions as idle.
//
const attentionSessions = new Set(); // sessions needing user action (OSC 9)
const responseReadySessions = new Set(); // CLI finished, user hasn't looked (terminal state)
const sessionBusyState = new Map(); // sessionId → boolean (currently active)

// Unread and needs-you outlive the app. A session that finished, or asked for
// something, while you were away still says so after a restart; only opening
// it (or Mark as read) clears it. Busy is not saved: nothing is running yet.
const SESSION_NOTICES_KEY = 'sessionNotices';

// When something last happened to a session that is worth moving it for: a
// new session started, a turn finished, or the CLI asked for something.
// Opening or resuming a session does not count, so the list holds still under
// a click. Not persisted: every event coincides with a transcript write, so
// after a restart the transcript's own last-message time says the same thing.
const sessionEventTimes = new Map(); // sessionId → ms since epoch

function bumpSessionEvent(sessionId) {
  if (!sessionId) return;
  sessionEventTimes.set(sessionId, Date.now());
  saveSessionNotices();
  if (typeof refreshProjectViews === 'function') refreshProjectViews({ reason: 'sessions' });
}

/**
 * The time to sort a session by: the later of its last event and the
 * transcript's last message. A working session rewrites its transcript
 * constantly, so while the CLI is busy the session keeps the time it had when
 * the turn began (frozen in setActivity); the turn ending moves it.
 */
function sessionEventTime(session) {
  const id = session.sessionId;
  const known = sessionEventTimes.get(id) || 0;
  const t = new Date(session.modified).getTime();
  const modified = Number.isFinite(t) ? t : 0;
  if (known && sessionBusyState.get(id) === true) return known;
  return Math.max(known, modified);
}

function saveSessionNotices() {
  try {
    // Ids of sessions that no longer exist cost nothing but should not pile up.
    const cap = (set) => [...set].slice(-200);
    localStorage.setItem(SESSION_NOTICES_KEY, JSON.stringify({ ready: cap(responseReadySessions), attention: cap(attentionSessions) }));
  } catch {}
}
try {
  const saved = JSON.parse(localStorage.getItem(SESSION_NOTICES_KEY) || 'null');
  for (const id of saved?.ready || []) responseReadySessions.add(id);
  for (const id of saved?.attention || []) attentionSessions.add(id);
} catch {}

// Some CLIs (notably Codex) start under a temporary ID and are re-keyed once
// their transcript appears. Activity often begins before that detection, so it
// must move with the rest of the session or the eventual idle event will have
// no matching busy state to transition from.
function rekeySessionActivity(oldId, newId) {
  if (oldId === newId) return;

  if (attentionSessions.delete(oldId)) attentionSessions.add(newId);
  if (responseReadySessions.delete(oldId)) responseReadySessions.add(newId);
  if (sessionBusyState.has(oldId)) {
    sessionBusyState.set(newId, sessionBusyState.get(oldId));
    sessionBusyState.delete(oldId);
  }
  if (activePtyIds.delete(oldId)) activePtyIds.add(newId);
  if (sessionEventTimes.has(oldId)) { sessionEventTimes.set(newId, sessionEventTimes.get(oldId)); sessionEventTimes.delete(oldId); }
  saveSessionNotices();
}

// A session row can be on screen twice: under its folder in the Sessions tab
// and in a project's pane or track card. State classes go to every copy.
function forEachSessionItem(sessionId, fn) {
  document.querySelectorAll(`.session-item[data-session-id="${sessionId}"], .pane-session[data-session-id="${sessionId}"]`).forEach(fn);
}

// Central activity dispatcher
function setActivity(sessionId, active) {
  // response-ready normally stays latched until the user looks at the session.
  // A fresh busy signal is stronger evidence, though: OSC progress clear can
  // briefly report idle between progress runs, and the next title frame or
  // progress start must be able to put the session straight back into running.
  if (active && responseReadySessions.has(sessionId)) {
    responseReadySessions.delete(sessionId);
    forEachSessionItem(sessionId, item => item.classList.remove('response-ready'));
  }

  if (responseReadySessions.has(sessionId)) {
    return;
  }

  const wasActive = sessionBusyState.get(sessionId) || false;
  sessionBusyState.set(sessionId, active);
  if (active && typeof hideSessionHoverPreview === 'function') hideSessionHoverPreview(sessionId);
  // A turn is starting: pin the row where it is until the turn ends.
  if (active && !wasActive) {
    const session = sessionMap.get(sessionId);
    if (session) sessionEventTimes.set(sessionId, sessionEventTime(session));
  }

  if (wasActive && !active) {
    bumpSessionEvent(sessionId);
    // Activity ended → response-ready if user isn't looking at this session
    if (sessionId !== activeSessionId) {
      responseReadySessions.add(sessionId);
      forEachSessionItem(sessionId, item => {
        item.classList.remove('cli-busy');
        item.classList.add('response-ready');
      });
    }
  }

  // Sync cli-busy class (only if not response-ready)
  if (!responseReadySessions.has(sessionId)) {
    forEachSessionItem(sessionId, item => item.classList.toggle('cli-busy', active));
  }
  // The Projects tab rolls working / finished / needs-you up onto its rows.
  if (typeof updateProjectStatusDots === 'function') updateProjectStatusDots();
  saveSessionNotices();
}

function clearUnread(sessionId) {
  responseReadySessions.delete(sessionId);
  forEachSessionItem(sessionId, item => item.classList.remove('response-ready'));
  if (typeof updateProjectStatusDots === 'function') updateProjectStatusDots();
  saveSessionNotices();
}

// User-initiated: put a session back into the response-ready state, as if
// Claude had just finished a turn the user hasn't looked at yet. Mirrors the
// busy→idle transition in setActivity so the sidebar re-renders consistently.
function markUnread(sessionId) {
  if (responseReadySessions.has(sessionId)) return;
  responseReadySessions.add(sessionId);
  sessionBusyState.set(sessionId, false);
  forEachSessionItem(sessionId, item => {
    item.classList.remove('cli-busy');
    item.classList.add('response-ready');
  });
  if (typeof updateProjectStatusDots === 'function') updateProjectStatusDots();
  saveSessionNotices();
}

function clearNotifications(sessionId) {
  // Opening a session is not an event: the row stays where it is so the
  // list does not reshuffle under the pointer.
  clearUnread(sessionId);
  attentionSessions.delete(sessionId);
  forEachSessionItem(sessionId, item => item.classList.remove('needs-attention'));
  if (typeof updateProjectStatusDots === 'function') updateProjectStatusDots();
  saveSessionNotices();
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
});

window.api.onSessionDetected((tempId, realId) => {
  const entry = openSessions.get(tempId);
  if (!entry) return;

  entry.session.sessionId = realId;
  if (activeSessionId === tempId) setActiveSession(realId);
  rekeySessionActivity(tempId, realId);
  rekeyTerminalHistory(tempId, realId);
  if (typeof rekeyProjectSessionState === 'function') rekeyProjectSessionState(tempId, realId);

  // Re-key in openSessions
  openSessions.delete(tempId);
  openSessions.set(realId, entry);

  // Re-key file panel state for the new session ID
  if (typeof rekeyFilePanelState === 'function') rekeyFilePanelState(tempId, realId);

  // Re-key the pending entry so the sidebar row survives until the DB has real
  // data. Without this the temp id keeps being re-injected by loadProjects and
  // the session appears twice.
  const pendingEntry = pendingSessions.get(tempId);
  pendingSessions.delete(tempId);
  if (pendingEntry) {
    pendingEntry.sessionId = realId;
    pendingSessions.set(realId, pendingEntry);
  }
  sessionMap.delete(tempId);
  sessionMap.set(realId, entry.session);

  terminalHeaderId.textContent = realId;

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
  rekeySessionActivity(oldId, newId);
  rekeyTerminalHistory(oldId, newId);
  if (typeof rekeyProjectSessionState === 'function') rekeyProjectSessionState(oldId, newId);

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

window.api.onProcessExited((sessionId, exitCode, signal, userStopped) => {
  const entry = openSessions.get(sessionId);
  const session = sessionMap.get(sessionId);
  if (entry) entry.closed = true;

  const intentional = wasIntentionalExit({ exitCode, signal, userStopped });

  // A Claude session that died stays mounted behind an exit banner so the user
  // can read the error it printed (claude / devbox / shell stderr) — without
  // this, a fast-failing pre-launch command tears the terminal down before the
  // error is readable. Cleanup is deferred to openSession, which destroys the
  // closed entry when the user re-clicks the session. The sidebar row stays
  // put too, so there's somewhere to relaunch from.
  if (session?.type !== 'terminal' && !intentional) {
    if (entry) {
      try {
        const reason = signal ? `signal ${signal}` : `code ${exitCode}`;
        entry.terminal.write(`\r\n\x1b[33m── session exited (${reason}) ──\x1b[0m\r\n`);
      } catch {}
    }
    // A pending session that died never wrote a .jsonl, so loadProjects keeps
    // re-injecting it. Mark it dead so it stops sorting as a running session.
    const pending = pendingSessions.get(sessionId);
    if (pending) pending.exited = true;
    if (gridViewActive) {
      gridViewerCount.textContent = gridCards.size + ' session' + (gridCards.size !== 1 ? 's' : '');
    }
    pollActiveSessions();
    return;
  }

  // Everything else — a raw shell that exited and harness sessions the user
  // ended themselves — goes away, including its retained terminal history.
  // Run cleanup even if the pane was already detached from the renderer.
  destroySession(sessionId);
  if (gridViewActive) {
    gridViewerCount.textContent = gridCards.size + ' session' + (gridCards.size !== 1 ? 's' : '');
  } else if (activeSessionId === sessionId) {
    setActiveSession(null);
    terminalHeader.style.display = 'none';
    placeholder.style.display = '';
  }

  // Drop the sidebar row for sessions with nothing to reopen: plain terminals,
  // and Claude sessions still pending (no .jsonl was ever written). A session
  // that produced real data keeps its row and reloads from the DB.
  if (session?.type === 'terminal' || pendingSessions.has(sessionId)) {
    pendingSessions.delete(sessionId);
    for (const projList of [cachedProjects, cachedAllProjects]) {
      for (const proj of projList) {
        proj.sessions = proj.sessions.filter(s => s.sessionId !== sessionId);
      }
    }
    removeSessionFromTrees(sessionId);
    sessionMap.delete(sessionId);
    refreshSidebar();
    // The pending marker can outlive the .jsonl by a beat (reconciliation only
    // runs in loadProjects), so re-sync: a session that did write real data
    // gets its row back from the DB rather than vanishing until the next watch.
    if (session?.type !== 'terminal') loadProjects();
  }

  pollActiveSessions();
});

// --- Terminal notifications (iTerm2 OSC 9 — "needs attention") ---
window.api.onTerminalNotification((sessionId, message, kind) => {
  // `kind` is classified by the session's harness in main, since the wording is
  // per-CLI: Claude says "needs your permission to use {tool}", codex says
  // "Approval requested: <command>".
  if (kind === 'attention' && sessionId !== activeSessionId) {
    attentionSessions.add(sessionId);
    bumpSessionEvent(sessionId);
    // The same session can be on screen in both tabs.
    document.querySelectorAll(`.session-item[data-session-id="${sessionId}"]`).forEach(item => item.classList.add('needs-attention'));
    if (typeof updateProjectStatusDots === 'function') updateProjectStatusDots();
  } else if (kind === 'idle') {
    // A completion notification is authoritative even if a quick turn never
    // produced a busy frame, or its busy state arrived under a temporary ID.
    // Active sessions are already being viewed, so they only need to go idle.
    if (sessionId === activeSessionId) setActivity(sessionId, false);
    else markUnread(sessionId);
  }

  // Show in header if active
  if (sessionId === activeSessionId && terminalHeaderPtyTitle) {
    terminalHeaderPtyTitle.textContent = message;
    terminalHeaderPtyTitle.style.display = '';
  }
});

// --- CLI busy state (OSC 0 title spinner and OSC 9;4 progress detection) ---
window.api.onCliBusyState((sessionId, busy) => {
  setActivity(sessionId, busy);
});

// --- Single entry point for all sidebar renders ---
// resort=true: re-sort items by priority+time (use for user-initiated actions)
// resort=false (default): preserve existing DOM order, new items go to top
// `reason` is passed straight to the Projects tab: 'sessions' means only the
// session list moved, so the project page patches itself instead of rebuilding.
function refreshSidebar({ resort = false, reason = 'project' } = {}) {
  // When searching, always use all projects (search ignores archive filter)
  let projects = (searchMatchIds !== null)
    ? cachedAllProjects
    : (showArchived ? cachedAllProjects : cachedProjects);

  if (searchMatchIds !== null) {
    projects = projects.map(p => {
      const hasMatchingSessions = p.sessions.some(s => searchMatchIds.has(s.sessionId));
      const projectMatched = searchMatchProjectPaths && searchMatchProjectPaths.has(p.projectPath);
      if (!hasMatchingSessions && !projectMatched) return null;
      return {
        ...p,
        sessions: hasMatchingSessions ? p.sessions.filter(s => searchMatchIds.has(s.sessionId)) : [],
        _projectMatchedOnly: projectMatched && !hasMatchingSessions,
      };
    }).filter(Boolean);
  }

  renderProjects(projects, resort);
  if (typeof refreshProjectViews === 'function') refreshProjectViews({ reason });
}

// --- Archive toggle ---
archiveToggle.innerHTML = ICONS.archive(18);
archiveToggle.addEventListener('click', () => {
  showArchived = !showArchived;
  archiveToggle.classList.toggle('active', showArchived);
  refreshSidebar({ resort: true });
});

// --- Star filter toggle ---
starToggle.addEventListener('click', () => {
  showStarredOnly = !showStarredOnly;
  if (showStarredOnly) { showRunningOnly = false; runningToggle.classList.remove('active'); }
  starToggle.classList.toggle('active', showStarredOnly);
  refreshSidebar({ resort: true });
});

// --- Running filter toggle ---
runningToggle.addEventListener('click', () => {
  showRunningOnly = !showRunningOnly;
  if (showRunningOnly) { showStarredOnly = false; starToggle.classList.remove('active'); }
  runningToggle.classList.toggle('active', showRunningOnly);
  refreshSidebar({ resort: true });
});

// --- Today filter toggle ---
todayToggle.addEventListener('click', () => {
  showTodayOnly = !showTodayOnly;
  todayToggle.classList.toggle('active', showTodayOnly);
  refreshSidebar({ resort: true });
});

// --- Re-sort button ---
resortBtn.addEventListener('click', () => {
  loadProjects({ resort: true });
});

// --- Global settings gear button ---
globalSettingsBtn.innerHTML = ICONS.gear(18);
globalSettingsBtn.addEventListener('click', () => {
  openSettingsViewer('global');
});

// --- "More" button: Plans, Agent Files, Stats and Global settings share one
// menu so the tab strip stays short. The tab buttons stay in the DOM, hidden,
// so everything that clicks them (shortcuts, the quota gauge) keeps working.
const sidebarMoreBtn = document.getElementById('sidebar-more-btn');
const MORE_TABS = ['plans', 'memory', 'stats'];
const moreIdleIcon = sidebarMoreBtn.innerHTML;
const tabButton = (name) => document.querySelector(`.sidebar-tab[data-tab="${name}"]`);
const menuIcon = (svg) => svg.replace(/width="18" height="18"/, 'width="14" height="14"');

/** Show the active hidden tab's icon on the more button, or the dots when none is active. */
function updateMoreButton() {
  const tab = MORE_TABS.includes(activeTab) ? tabButton(activeTab) : null;
  sidebarMoreBtn.innerHTML = tab ? tab.innerHTML : moreIdleIcon;
  sidebarMoreBtn.title = tab ? tab.title : 'More';
  sidebarMoreBtn.classList.toggle('active', !!tab);
}

sidebarMoreBtn.addEventListener('click', (e) => {
  const slackLink = document.getElementById('status-bar-slack');
  const tabItem = (name) => {
    const tab = tabButton(name);
    return { label: tab.title, icon: menuIcon(tab.innerHTML), muted: activeTab === name, onClick: () => tab.click() };
  };
  showContextMenu([
    ...MORE_TABS.map(tabItem),
    { sep: true },
    { label: 'Global settings', icon: ICONS.gear(14), onClick: () => globalSettingsBtn.click() },
    { label: 'Join Slack', icon: slackLink.querySelector('svg').outerHTML, onClick: () => window.api.openExternal(slackLink.href) },
  ], { anchor: e.currentTarget });
});

// --- Add folder / new project buttons ---
addProjectBtn.addEventListener('click', () => {
  showAddProjectDialog();
});

// --- Search (debounced, per-tab FTS) ---
let searchDebounceTimer = null;
const searchClear = document.getElementById('search-clear');
const searchTitlesToggle = document.getElementById('search-titles-toggle');
let searchTitlesOnly = false;

// Load persisted preference
(async () => {
  const saved = await window.api.getSetting('searchTitlesOnly');
  if (saved) {
    searchTitlesOnly = true;
    searchTitlesToggle.classList.add('active');
  }
})();

searchTitlesToggle.addEventListener('click', async () => {
  searchTitlesOnly = !searchTitlesOnly;
  searchTitlesToggle.classList.toggle('active', searchTitlesOnly);
  await window.api.setSetting('searchTitlesOnly', searchTitlesOnly);
  // Re-run current search if there's a query
  const query = searchInput.value.trim();
  if (query) {
    searchInput.dispatchEvent(new Event('input'));
  }
});

function clearSearch() {
  searchInput.value = '';
  searchBar.classList.remove('has-query');
  if (searchDebounceTimer) { clearTimeout(searchDebounceTimer); searchDebounceTimer = null; }
  if (activeTab === 'sessions' || activeTab === 'projects') {
    searchMatchIds = null;
    searchMatchProjectPaths = null;
    refreshSidebar({ resort: true });
  } else if (activeTab === 'plans') {
    renderPlans(cachedPlans);
  } else if (activeTab === 'memory') {
    renderMemories();
  }
}

searchClear.addEventListener('click', () => {
  clearSearch();
  searchInput.focus();
});

searchInput.addEventListener('input', () => {
  // Toggle clear button visibility
  searchBar.classList.toggle('has-query', searchInput.value.length > 0);

  if (searchDebounceTimer) clearTimeout(searchDebounceTimer);
  searchDebounceTimer = setTimeout(async () => {
    searchDebounceTimer = null;
    const query = searchInput.value.trim();

    if (!query) {
      clearSearch();
      return;
    }

    try {
      if (activeTab === 'sessions' || activeTab === 'projects') {
        const results = await window.api.search('session', query, searchTitlesOnly);
        searchMatchIds = new Set(results.map(r => r.id));
        // When title-only, also match project names
        searchMatchProjectPaths = null;
        if (searchTitlesOnly) {
          const lowerQ = query.toLowerCase();
          for (const p of cachedAllProjects) {
            const shortName = shortProjectPath(p.projectPath);
            if (shortName.toLowerCase().includes(lowerQ)) {
              if (!searchMatchProjectPaths) searchMatchProjectPaths = new Set();
              searchMatchProjectPaths.add(p.projectPath);
            }
          }
        }
        refreshSidebar({ resort: true });
      } else if (activeTab === 'plans') {
        const results = await window.api.search('plan', query, searchTitlesOnly);
        const matchIds = new Set(results.map(r => r.id));
        renderPlans(cachedPlans.filter(p => matchIds.has(p.filename)));
      } else if (activeTab === 'memory') {
        const results = await window.api.search('memory', query, searchTitlesOnly);
        const matchIds = new Set(results.map(r => r.id));
        renderMemories(matchIds);
      }
    } catch {
      if (activeTab === 'sessions' || activeTab === 'projects') {
        searchMatchIds = null;
        searchMatchProjectPaths = null;
        refreshSidebar({ resort: true });
      }
    }
  }, 200);
});

// --- Stop session helper ---
/**
 * A row for a session that never produced a transcript, and is not running.
 *
 * These exist so a session that died on launch can be relaunched or read, but
 * nothing on disk backs them — so nothing else can ever clear them, and without
 * a way out they sit in the sidebar for good.
 */
function isDismissibleSession(sessionId) {
  return pendingSessions.has(sessionId) && !activePtyIds.has(sessionId);
}

/** Drop such a row. Purely renderer state, so it cannot come back. */
function dismissSession(sessionId) {
  const session = sessionMap.get(sessionId);
  pendingSessions.delete(sessionId);
  sessionMap.delete(sessionId);
  for (const projList of [cachedProjects, cachedAllProjects]) {
    for (const proj of projList) {
      proj.sessions = proj.sessions.filter(s => s.sessionId !== sessionId);
    }
  }
  if (typeof removeSessionFromTrees === 'function') removeSessionFromTrees(sessionId);
  if (openSessions.has(sessionId)) destroySession(sessionId);
  else {
    forgetTerminalHistory(sessionId);
    if (session?.type === 'terminal') forgetPersistedTerminalSession(sessionId);
  }
  if (activeSessionId === sessionId) {
    setActiveSession(null);
    terminalHeader.style.display = 'none';
    placeholder.style.display = '';
  }
  attentionSessions.delete(sessionId);
  responseReadySessions.delete(sessionId);
  refreshSidebar();
}

async function confirmAndStopSession(sessionId) {
  if (!confirm('Stop this session?')) return;
  await window.api.stopSession(sessionId);
  activePtyIds.delete(sessionId);
  if (!gridViewActive && activeSessionId === sessionId) {
    setActiveSession(null);
    terminalHeader.style.display = 'none';
    placeholder.style.display = '';
  }
  refreshSidebar();
}

// --- Terminal header controls ---
terminalStopBtn.addEventListener('click', () => {
  if (activeTaskView) return;
  if (activeSessionId) confirmAndStopSession(activeSessionId);
});


// --- Poll for active PTY sessions ---
// Adaptive cadence: poll fast (3s) only while PTYs are running; when idle, back
// off to 30s. Every renderer path that starts a session (launchNewSession,
// openSession, launchTerminalSession, onSessionDetected/Forked) calls
// pollActiveSessions() explicitly, which re-arms the fast cadence immediately.
// The 30s idle floor still catches sessions started outside the renderer
// (scheduler-spawned PTYs, other windows) within at most 30s.
const POLL_FAST_MS = 3000;
const POLL_IDLE_MS = 30000;
let pollTimer = null;

function scheduleActiveSessionsPoll() {
  if (pollTimer) clearTimeout(pollTimer);
  const delay = activePtyIds.size > 0 ? POLL_FAST_MS : POLL_IDLE_MS;
  pollTimer = setTimeout(pollActiveSessions, delay);
}

async function pollActiveSessions() {
  try {
    const ids = await window.api.getActiveSessions();
    // A new session that just came alive is news. A resumed one keeps its
    // place until the agent does something.
    for (const id of ids) {
      if (activePtyIds.has(id)) continue;
      const pending = pendingSessions.get(id);
      if (pending && !pending.restored) sessionEventTimes.set(id, Date.now());
    }
    activePtyIds = new Set(ids);
    updateRunningIndicators();
    updateTerminalHeader();
  } catch {}
  scheduleActiveSessionsPoll();
}

function updateRunningIndicators() {
  document.querySelectorAll('.session-item').forEach(item => {
    const id = item.dataset.sessionId;
    const running = activePtyIds.has(id);
    item.classList.toggle('has-running-pty', running);
    if (!running) {
      // Unread and needs-you stay until the user looks; only busy needs a PTY.
      item.classList.remove('cli-busy');
      item.classList.toggle('needs-attention', attentionSessions.has(id));
      item.classList.toggle('response-ready', responseReadySessions.has(id));
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
  if (typeof updateProjectStatusDots === 'function') updateProjectStatusDots();
  // Update grid card dots and status text
  for (const [sid, card] of gridCards) {
    const running = activePtyIds.has(sid);
    const busy = sessionBusyState.get(sid) || false;
    const dot = card.querySelector('.grid-card-dot');
    if (dot) dot.className = 'grid-card-dot ' + (busy ? 'busy' : (running ? 'running' : 'stopped'));
    const footer = card.querySelector('.grid-card-footer');
    if (footer) footer.children[0].textContent = running ? 'Running' : 'Stopped';
    const stopBtn = card.querySelector('.grid-card-stop-btn');
    if (stopBtn) stopBtn.style.display = running ? '' : 'none';
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
  if (!activeSessionId || !terminalHeaderPtyTitle) return;
  const entry = openSessions.get(activeSessionId);
  const title = entry?.ptyTitle || '';
  terminalHeaderPtyTitle.textContent = title;
  terminalHeaderPtyTitle.style.display = title ? '' : 'none';
}

scheduleActiveSessionsPoll();

// Refresh sidebar timeago labels every 30s so "just now" ticks forward
setInterval(() => {
  for (const [sessionId, session] of sessionMap) {
    if (!session.modified) continue;
    const item = document.getElementById('si-' + sessionId);
    if (!item) continue;
    const timeEl = item.querySelector('.session-time');
    if (!timeEl) continue;
    const msgSuffix = session.messageCount ? ' \u00b7 ' + session.messageCount + ' msgs' : '';
    timeEl.textContent = formatDate(new Date(session.modified)) + msgSuffix;
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

/**
 * Raw terminals have no transcript/database row. Recreate their renderer rows
 * from localStorage before the sidebar/project panes render after a restart.
 */
function injectPersistedTerminalRows() {
  for (const saved of persistedTerminalSessions()) {
    if (pendingSessions.has(saved.sessionId)) continue;
    const session = sessionMap.get(saved.sessionId) || saved;
    Object.assign(session, saved);
    sessionMap.set(session.sessionId, session);
    const folder = encodeProjectPath(session.projectPath);
    pendingSessions.set(session.sessionId, {
      session,
      projectPath: session.projectPath,
      folder,
      restored: true,
    });
    for (const projList of [cachedProjects, cachedAllProjects]) {
      let proj = projList.find(p => p.projectPath === session.projectPath);
      if (!proj) {
        proj = { folder, projectPath: session.projectPath, sessions: [] };
        projList.unshift(proj);
      }
      if (!proj.sessions.some(item => item.sessionId === session.sessionId)) proj.sessions.unshift(session);
    }
    injectPendingIntoTree(session);
  }
}

/** Reopen every saved raw terminal as a fresh shell, initially hidden. */
async function restorePersistedTerminalProcesses() {
  const jobs = [];
  for (const saved of persistedTerminalSessions()) {
    if (openSessions.has(saved.sessionId)) continue;
    const session = sessionMap.get(saved.sessionId) || saved;
    jobs.push(openRawTerminalSession(session, { show: false }));
  }
  if (jobs.length) {
    await Promise.all(jobs);
    await pollActiveSessions();
  }
}

async function loadProjects({ resort = false, reason = 'project' } = {}) {
  const wasEmpty = cachedProjects.length === 0;
  if (wasEmpty) {
    loadingStatus.textContent = 'Loading\u2026';
    loadingStatus.className = 'active';
    loadingStatus.style.display = '';
  }
  const [defaultProjects, allProjects, tree, treeAll] = await Promise.all([
    window.api.getProjects(false),
    window.api.getProjects(true),
    window.api.getProjectTree(false).catch(() => ({ projects: [] })),
    window.api.getProjectTree(true).catch(() => ({ projects: [] })),
    // Scheduled tasks ride along: the folder clocks and session chips read them.
    typeof loadSchedules === 'function' ? loadSchedules() : null,
  ]);
  cachedProjects = defaultProjects;
  cachedAllProjects = allProjects;
  cachedProjectTree = tree || { projects: [] };
  cachedProjectTreeAll = treeAll || { projects: [] };
  loadingStatus.style.display = 'none';
  loadingStatus.className = '';
  dedup(cachedProjects);
  dedup(cachedAllProjects);
  dedupTree(cachedProjectTree);
  dedupTree(cachedProjectTreeAll);

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
      injectPendingIntoTree(pending.session);
    }
  }

  // Track active plain terminals in pendingSessions/sessionMap (data now comes from backend)
  try {
    const activeTerminals = await window.api.getActiveTerminals();
    for (const { sessionId, projectPath, projectId, trackId } of activeTerminals) {
      if (pendingSessions.has(sessionId)) continue; // already tracked
      const folder = encodeProjectPath(projectPath);
      // Find the session object already injected by the backend
      let session;
      for (const proj of cachedAllProjects) {
        session = proj.sessions.find(s => s.sessionId === sessionId);
        if (session) break;
      }
      if (!session) continue;
      // An attached folder can sit outside the project's root, so cwd alone is
      // not enough to restore where this ephemeral terminal belongs.
      if (projectId) session.projectId = projectId;
      if (trackId) session.trackId = trackId;
      // Also adopts terminals that were already running when this persistence
      // feature was introduced; the next restart should retain them too.
      persistTerminalSession(session);
      pendingSessions.set(sessionId, { session, projectPath, folder });
      sessionMap.set(sessionId, session);
    }
  } catch {}

  // A full app exit kills raw PTYs, so the main-process active list is empty on
  // the next launch. Their durable descriptors still put them back in the same
  // project/track and starting folder.
  injectPersistedTerminalRows();

  // Project roots and attached folders get their tasks too, even with no
  // sessions of their own, so a project's task menu is complete.
  await hydrateProjectTasks([cachedProjects, cachedAllProjects], treeTaskPaths(cachedProjectTreeAll));
  await pollActiveSessions();
  refreshSidebar({ resort, reason });
  renderDefaultStatus();
}

// Sidebar rendering (slugId, folderId, buildSlugGroup, renderProjects,
// rebindSidebarEvents, buildSessionItem, startRename) → sidebar.js


async function launchNewSession(project, sessionOptions, { focus = true } = {}) {
  // A temporary id. Claude is told to use it (--session-id); codex cannot be,
  // so main watches for its transcript and sends session-detected with the real
  // one, which re-keys everything below.
  const sessionId = crypto.randomUUID();
  const projectPath = project.projectPath;
  const runtime = sessionOptions?.runtime || 'claude';
  const session = {
    sessionId,
    summary: 'New session',
    firstPrompt: '',
    projectPath,
    runtime,
    name: null,
    starred: 0,
    archived: 0,
    messageCount: 0,
    modified: new Date().toISOString(),
    created: new Date().toISOString(),
  };

  // Launched from a project (or one of its tracks): main files the session
  // there when it spawns, and the Projects tab shows it right away.
  const options = { ...(sessionOptions || {}) };
  if (project.projectId) {
    options.projectId = project.projectId;
    if (project.trackId) options.trackId = project.trackId;
    session.projectId = project.projectId;
    session.trackId = project.trackId || null;
  }
  // Started by a scheduled task: the row shows the chip from the first
  // moment, not only once the DB has the link (main records it on spawn).
  if (options.scheduleId) {
    session.scheduleId = options.scheduleId;
    session.scheduledAt = new Date().toISOString();
  }

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
  injectPendingIntoTree(session);
  refreshSidebar();

  const entry = createTerminalEntry(session);

  // Open terminal in main process with session options
  const result = await window.api.openTerminal(sessionId, projectPath, true, Object.keys(options).length ? options : null);
  if (!result.ok) {
    entry.terminal.write(`\r\nError: ${result.error}\r\n`);
    entry.closed = true;
    return;
  }
  if (typeof setSessionMcpActive === 'function') setSessionMcpActive(sessionId, !!result.mcpActive);

  // A scheduled launch runs in the background: it shows up in the lists like
  // any session, but does not take over whatever the user is looking at.
  if (focus) showSession(sessionId);
  pollActiveSessions();
}

// Legacy alias
function openNewSession(project) {
  return launchNewSession(project);
}

async function showTerminalHeader(session) {
  const displayName = cleanDisplayName(session.name || session.aiTitle || session.summary);
  terminalHeaderName.textContent = displayName;
  terminalHeaderId.textContent = session.sessionId;
  terminalHeader.style.display = '';
  updateTerminalHeader();

  // Show active shell profile
  try {
    const effective = await window.api.getEffectiveSettings(session.projectPath);
    const profileId = effective.shellProfile || 'auto';
    if (profileId === 'auto') {
      terminalHeaderShell.style.display = 'none';
    } else {
      const profiles = await window.api.getShellProfiles();
      const profile = profiles.find(p => p.id === profileId);
      terminalHeaderShell.textContent = profile ? profile.name : profileId;
      terminalHeaderShell.style.display = '';
    }
  } catch {
    terminalHeaderShell.style.display = 'none';
  }
}

// Terminal lifecycle (createTerminalEntry, destroySession, showSession, setupDragAndDrop) → terminal-manager.js

async function unarchiveSessionBeforeOpen(session) {
  if (!session.archived) return true;

  const displayName = cleanDisplayName(session.name || session.aiTitle || session.summary) || 'This session';
  if (!confirm(`“${displayName}” is archived.\n\nUnarchive it and open it?`)) return false;

  const result = await window.api.archiveSession(session.sessionId, 0);
  if (result?.error) {
    alert(result.error);
    return false;
  }
  session.archived = 0;
  await loadProjects();
  return true;
}

async function openSession(session, customOptions) {
  if (!await unarchiveSessionBeforeOpen(session)) return;

  const { sessionId, projectPath } = session;

  // If already open, handle closed-session cleanup or just show it
  if (openSessions.has(sessionId)) {
    const entry = openSessions.get(sessionId);
    if (entry.closed) {
      destroySession(sessionId, {
        forgetPersisted: session.type !== 'terminal',
        preserveHistory: true,
      });
      if (session.type === 'terminal') {
        await openRawTerminalSession(session);
        pollActiveSessions();
        return;
      }
    } else {
      showSession(sessionId);
      return;
    }
  }

  if (session.type === 'terminal') {
    await openRawTerminalSession(session);
    pollActiveSessions();
    return;
  }

  // Create new terminal entry (hidden until showSession)
  const entry = createTerminalEntry(session);

  // Open terminal in main process
  const resumeOptions = { ...(customOptions || await resolveDefaultSessionOptions({ projectPath })) };
  // Which CLI to resume with. Main re-reads this from the cached row and only
  // trusts the hint for sessions it has never indexed.
  if (session.runtime) resumeOptions.runtime = session.runtime;
  const result = await window.api.openTerminal(sessionId, projectPath, false, resumeOptions);
  if (!result.ok) {
    entry.terminal.write(`\r\nError: ${result.error}\r\n`);
    entry.closed = true;
    return;
  }
  if (typeof setSessionMcpActive === 'function') setSessionMcpActive(sessionId, !!result.mcpActive);

  // Relaunching a session that had died clears the dead marker on its pending entry
  const pending = pendingSessions.get(sessionId);
  if (pending) pending.exited = false;

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

// --- Tab switching ---
document.querySelectorAll('.sidebar-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    const tabName = tab.dataset.tab;
    // The more button shares the tab styling but opens a menu instead.
    if (!tabName || tabName === activeTab) return;
    // Leaving the Projects tab takes its page, strip and pane with it.
    if (activeTab === 'projects' && typeof leaveProjectViews === 'function') leaveProjectViews();
    activeTab = tabName;
    if (REMEMBERED_TABS.includes(tabName)) { try { localStorage.setItem(LAST_TAB_KEY, tabName); } catch {} }
    document.querySelectorAll('.sidebar-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tabName));
    updateMoreButton();

    // Clear search on tab switch
    searchInput.value = '';
    searchBar.classList.remove('has-query');
    searchMatchIds = null;
    searchMatchProjectPaths = null;

    // Hide all sidebar content areas
    sidebarContent.style.display = 'none';
    projectsContent.style.display = 'none';
    plansContent.style.display = 'none';
    statsContent.style.display = 'none';
    memoryContent.style.display = 'none';
    sessionFilters.style.display = 'none';
    searchBar.style.display = 'none';

    // Sessions and Projects share the main area: the grid, the active
    // terminal, or the placeholder.
    function restoreTerminalArea() {
      hideAllViewers();
      if (gridViewActive) {
        // Grid is still set up — just re-show it and refit
        placeholder.style.display = 'none';
        terminalHeader.style.display = 'none';
        gridViewer.style.display = 'block';
        for (const entry of openSessions.values()) {
          if (!entry.closed) fitAndScroll(entry);
        }
      } else if (activeSessionId && openSessions.has(activeSessionId)) {
        showSession(activeSessionId);
      } else {
        placeholder.style.display = '';
      }
    }

    if (tabName === 'sessions') {
      sessionFilters.style.display = '';
      searchBar.style.display = '';
      searchInput.placeholder = 'Search sessions...';
      sidebarContent.style.display = '';
      restoreTerminalArea();
      // Catch up on changes that happened while on another tab
      if (projectsChangedWhileAway) {
        projectsChangedWhileAway = false;
        loadProjects();
      }
    } else if (tabName === 'projects') {
      searchBar.style.display = '';
      searchInput.placeholder = 'Search projects...';
      projectsContent.style.display = '';
      if (projectsChangedWhileAway) {
        projectsChangedWhileAway = false;
        loadProjects().then(() => showProjectHome());
      } else {
        renderProjectList();
        showProjectHome();
      }
    } else if (tabName === 'plans') {
      searchBar.style.display = '';
      searchInput.placeholder = 'Search plans...';
      plansContent.style.display = '';
      loadPlans();
    } else if (tabName === 'stats') {
      statsContent.style.display = '';
      // Immediately show stats viewer in main area
      placeholder.style.display = 'none';
      terminalArea.style.display = 'none';
      planViewer.style.display = 'none';
      memoryViewer.style.display = 'none';
      settingsViewer.style.display = 'none';
      statsViewer.style.display = 'flex';
      loadStats();
    } else if (tabName === 'memory') {
      searchBar.style.display = '';
      searchInput.placeholder = 'Search agent files...';
      memoryContent.style.display = '';
      loadMemories();
    }
  });
});

// Plans & viewer helpers → plans-memory-view.js


// Grid view → grid-view.js
// Initialize grid observers now that DOM refs are ready
initGridObservers();

// JSONL viewer (renderJsonlText, formatDuration, makeCollapsible, renderJsonlEntry, showJsonlViewer) → jsonl-viewer.js

// Stats view (loadStats, buildUsageSection, buildDailyBarChart, buildHeatmap, calculateStreak, buildStatsSummary) → stats-view.js

// Memory viewer → plans-memory-view.js


// Dialogs (resolveDefaultSessionOptions, forkSession, showNewSessionPopover,
// showNewSessionDialog, showResumeSessionDialog, showAddProjectDialog, launchTerminalSession) → dialogs.js


// --- Sidebar toggle ---
{
  const sidebar = document.getElementById('sidebar');
  const collapseBtn = document.getElementById('sidebar-collapse-btn');
  const expandBtn = document.getElementById('sidebar-expand-btn');

  collapseBtn.addEventListener('click', () => sidebar.classList.add('collapsed'));
  expandBtn.addEventListener('click', () => sidebar.classList.remove('collapsed'));
}

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

// --- Grid view toggle button (next to resort button in sidebar filters) ---
{
  const gridToggleBtn = document.createElement('button');
  gridToggleBtn.id = 'grid-toggle-btn';
  gridToggleBtn.title = 'Session overview';
  gridToggleBtn.innerHTML = '<svg width="14" height="14" stroke="currentColor" fill="none" stroke-width="2" viewBox="0 0 24 24" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7"></rect><rect x="14" y="3" width="7" height="7"></rect><rect x="14" y="14" width="7" height="7"></rect><rect x="3" y="14" width="7" height="7"></rect></svg>';
  gridToggleBtn.addEventListener('click', toggleGridView);
  // Insert next to the resort button
  resortBtn.parentElement.insertBefore(gridToggleBtn, resortBtn);

  // Global keyboard shortcuts (covers non-terminal focus)
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
}

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
  }
})();

loadProjects().then(async () => {
  // Open the tab the user was last working in.
  const lastTab = rememberedTab();
  if (lastTab !== activeTab) document.querySelector(`.sidebar-tab[data-tab="${lastTab}"]`)?.click();
  await restoreActiveTaskView();
  await restorePersistedTerminalProcesses();
  // Restore grid view preference before opening sessions so they enter grid mode
  if (!activeTaskView && localStorage.getItem('gridViewActive') === '1') {
    showGridView();
  }
  // Restore the active session after a renderer reload or full app restart.
  // Raw terminals were reopened above but deliberately left hidden until this
  // point, so an already-open entry still needs showSession().
  if (activeSessionId) {
    const session = sessionMap.get(activeSessionId);
    if (session?.archived) {
      setActiveSession(null);
    } else if (session) {
      if (openSessions.has(activeSessionId)) showSession(activeSessionId);
      else openSession(session);
    }
    else setActiveSession(null);
  }
});

// Live-reload sidebar when filesystem changes are detected
let projectsChangedTimer = null;
// The strongest reason seen while the debounce window is open.
let projectsChangedReason = 'sessions';
let projectsChangedWhileAway = false;
window.api.onProjectsChanged((reason) => {
  // Debounce to avoid rapid re-renders during bulk changes
  if (projectsChangedTimer) clearTimeout(projectsChangedTimer);
  if (activeTab !== 'sessions' && activeTab !== 'projects') {
    projectsChangedWhileAway = true;
    return;
  }
  // A batch that mixes both is a project change: the wider refresh covers both.
  if (reason !== 'sessions') projectsChangedReason = 'project';
  projectsChangedTimer = setTimeout(() => {
    projectsChangedTimer = null;
    const only = projectsChangedReason;
    projectsChangedReason = 'sessions';
    loadProjects({ reason: only });
  }, 300);
});

// Status bar
let activityTimer = null;

function renderDefaultStatus() {
  const totalSessions = cachedAllProjects.reduce((n, p) => n + p.sessions.length, 0);
  const totalProjects = cachedAllProjects.length;
  const running = activePtyIds.size;
  const parts = [];
  if (running > 0) parts.push(`${running} running`);
  parts.push(`${totalSessions} sessions`);
  parts.push(`${totalProjects} folders`);
  const projectCount = (cachedProjectTreeAll?.projects || []).filter(p => p.status === 'active').length;
  if (projectCount > 0) parts.push(`${projectCount} project${projectCount === 1 ? '' : 's'}`);
  statusBarInfo.textContent = parts.join(' \u00b7 ');
}

window.api.onStatusUpdate((text, type) => {
  if (activityTimer) clearTimeout(activityTimer);
  statusBarActivity.textContent = text;
  statusBarActivity.className = type === 'done' ? 'status-done' : '';
  if (!text || type === 'done') {
    activityTimer = setTimeout(() => {
      statusBarActivity.textContent = '';
      statusBarActivity.className = '';
    }, type === 'done' ? 3000 : 0);
  }
});

// --- Auto-update status + toast ---
const statusBarUpdater = document.getElementById('status-bar-updater');
let updaterStatusTimer = null;
function setUpdaterStatus(text, duration) {
  if (updaterStatusTimer) clearTimeout(updaterStatusTimer);
  statusBarUpdater.textContent = text;
  if (duration) {
    updaterStatusTimer = setTimeout(() => { statusBarUpdater.textContent = ''; }, duration);
  }
}
const updaterHandler = (type, data) => {
  switch (type) {
    case 'checking':
      setUpdaterStatus('Checking for updates…');
      break;
    case 'update-available':
      setUpdaterStatus(`Downloading v${data.version}…`);
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
      msg.innerHTML = `New Version Ready<br><span class="update-version">v${data.version}</span> (<a href="https://github.com/doctly/switchboard/releases" target="_blank" class="update-notes-link">release notes</a>)${notice}`;
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

// --- Quota gauges in status bar ---
// One bar per limit window the usage API reports — a 5-hour session window, a
// weekly all-models window, and a weekly window per model. Which one bites
// first varies, and the 5-hour is usually the emptiest while resetting within
// the day, so showing a single window would read as "plenty left" while a
// weekly one is the one actually running out. Rows come from the API
// self-describing, so a newly launched model gets a bar without a code change.
const quotaGaugeEl = document.getElementById('status-bar-quota');

// Full labels ("Week (all models)") are too long for a status bar; the tooltip
// carries them in full.
function shortQuotaLabel(row) {
  // codex names its own windows by length, since it reports a duration in
  // seconds rather than a named bucket like Claude does.
  if (row.short) return row.short;
  if (row.kind === 'session') return '5h';
  if (row.kind === 'weekly_all') return 'Week';
  return row.model || 'Week';
}

function buildQuotaBar(row) {
  const wrap = document.createElement('span');
  wrap.className = 'quota-item';

  if (row.runtime) wrap.classList.add('quota-item-' + row.runtime);

  const label = document.createElement('span');
  label.className = 'quota-label';
  label.textContent = shortQuotaLabel(row);
  wrap.appendChild(label);

  const track = document.createElement('span');
  track.className = 'quota-track';
  const fill = document.createElement('span');
  const pct = row.percent;
  fill.className = 'quota-fill' + (pct >= 80 ? ' quota-high' : pct >= 60 ? ' quota-mid' : '');
  fill.style.width = Math.min(Math.max(pct, 1), 100) + '%';
  track.appendChild(fill);
  wrap.appendChild(track);

  const pctEl = document.createElement('span');
  pctEl.className = 'quota-pct';
  pctEl.textContent = pct + '%';
  wrap.appendChild(pctEl);

  const who = row.runtime === 'codex' ? 'Codex' : 'Claude';
  wrap.title = `${who} \u2014 ${row.label}: ${pct}%` + (row.reset ? ` \u2014 resets ${row.reset}` : '');
  return wrap;
}

function quotaRowsFor(usage, runtime) {
  // Prefer the API's self-describing rows; fall back to the flat 5-hour keys.
  const rows = Array.isArray(usage?.limits) && usage.limits.length
    ? usage.limits
    : (usage?.session !== undefined
      ? [{ kind: 'session', label: 'Current session', percent: usage.session, reset: usage.sessionReset }]
      : []);
  return rows.map(r => ({ runtime, ...r }));
}

/**
 * One CLI's bars behind its logo.
 *
 * The logo goes on the group rather than each bar: with two CLIs on the bar a
 * label like "Week" is ambiguous, but repeating the mark per bar is noise.
 */
function buildQuotaGroup(runtime, rows) {
  const group = document.createElement('span');
  group.className = 'quota-group quota-group-' + runtime;

  const icon = document.createElement('span');
  icon.className = 'quota-runtime-icon';
  icon.innerHTML = runtime === 'codex' ? ICONS.codex(12) : ICONS.claude(12);
  icon.title = runtime === 'codex' ? 'Codex' : 'Claude';
  group.appendChild(icon);

  for (const row of rows) group.appendChild(buildQuotaBar(row));
  return group;
}

async function refreshQuotaGauge() {
  try {
    // Both CLIs, in parallel and independently: one being signed out or
    // switched off must not cost the other its bars.
    const [claudeUsage, codexUsage] = await Promise.all([
      window.api.getUsage().catch(() => ({})),
      window.api.getCodexUsage?.().catch(() => ({})) ?? {},
    ]);
    const groups = [];
    for (const [runtime, usage] of [['claude', claudeUsage], ['codex', codexUsage]]) {
      const rows = quotaRowsFor(usage, runtime);
      if (rows.length) groups.push(buildQuotaGroup(runtime, rows));
    }
    if (!groups.length) { quotaGaugeEl.style.display = 'none'; return; }

    quotaGaugeEl.replaceChildren(...groups);
    quotaGaugeEl.style.display = '';
  } catch {}
}
refreshQuotaGauge();
setInterval(refreshQuotaGauge, 5 * 60 * 1000);

// Switching a CLI on or off changes which bars belong on the gauge and which
// sessions belong in the sidebar. Both are otherwise only refreshed on a timer.
window.api.onHarnessesChanged?.(() => {
  refreshQuotaGauge();
  loadProjects({ resort: true });
});
quotaGaugeEl.addEventListener('click', () => {
  document.querySelector('.sidebar-tab[data-tab="stats"]')?.click();
});

// --- Initialize file panel (MCP bridge UI) ---
if (typeof initFilePanel === 'function') initFilePanel();
