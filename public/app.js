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
const terminalStopBtn = document.getElementById('terminal-stop-btn');
const terminalRestartBtn = document.getElementById('terminal-restart-btn');
const runningToggle = document.getElementById('running-toggle');
const todayToggle = document.getElementById('today-toggle');
const planViewer = document.getElementById('plan-viewer');
const planViewerTitle = document.getElementById('plan-viewer-title');
const planViewerFilepath = document.getElementById('plan-viewer-filepath');
const planViewerEditorEl = document.getElementById('plan-viewer-editor');
const planCopyPathBtn = document.getElementById('plan-copy-path-btn');
const planCopyContentBtn = document.getElementById('plan-copy-content-btn');
const planSaveBtn = document.getElementById('plan-save-btn');

let currentPlanContent = '';
let currentPlanFilePath = '';
let currentPlanFilename = '';
let planEditorView = null;
const loadingStatus = document.getElementById('loading-status');
const sessionFilters = document.getElementById('session-filters');
const searchBar = document.getElementById('search-bar');
const statsContent = document.getElementById('stats-content');
const configContent = document.getElementById('config-content');
const statsViewer = document.getElementById('stats-viewer');
const statsViewerBody = document.getElementById('stats-viewer-body');
const configViewer = document.getElementById('config-viewer');
const configViewerTitle = document.getElementById('config-viewer-title');
const configViewerFilepath = document.getElementById('config-viewer-filepath');
const configViewerEditorEl = document.getElementById('config-viewer-editor');
const configCopyPathBtn = document.getElementById('config-copy-path-btn');
const configCopyContentBtn = document.getElementById('config-copy-content-btn');
const configSaveBtn = document.getElementById('config-save-btn');

let configEditorView = null;
let currentConfigFilePath = '';
let cachedConfigItems = [];
let currentConfigScope = null; // null = global, string = projectPath
const terminalArea = document.getElementById('terminal-area');
const settingsViewer = document.getElementById('settings-viewer');
const settingsViewerTitle = document.getElementById('settings-viewer-title');
const settingsViewerBody = document.getElementById('settings-viewer-body');
const globalSettingsBtn = document.getElementById('global-settings-btn');
const addProjectBtn = document.getElementById('add-project-btn');
const resortBtn = document.getElementById('resort-btn');
const collapseToggle = document.getElementById('collapse-toggle');
const jsonlViewer = document.getElementById('jsonl-viewer');
const jsonlViewerTitle = document.getElementById('jsonl-viewer-title');
const jsonlViewerSessionId = document.getElementById('jsonl-viewer-session-id');
const jsonlViewerBody = document.getElementById('jsonl-viewer-body');

// Map<sessionId, { terminal, element, fitAddon, session, closed }>
const openSessions = new Map();
let activeSessionId = sessionStorage.getItem('activeSessionId') || null;
function setActiveSession(id) {
  activeSessionId = id;
  if (id) sessionStorage.setItem('activeSessionId', id);
  else sessionStorage.removeItem('activeSessionId');
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
let activePtyIds = new Set();
let sortedOrder = []; // [{ projectPath, itemIds: [itemId, ...] }, ...] — single source of truth for sidebar order
let activeTab = 'sessions';
let cachedPlans = [];
let visibleSessionCount = 10;
let sessionMaxAgeDays = 3;
const pendingSessions = new Map(); // sessionId → { session, projectPath, folder }
let searchMatchIds = null; // null = no search active; Set<string> = matched session IDs
let projectGroups = { groups: [], groupOrder: [] }; // folder groups for sidebar

// --- Activity tracking ---
const unreadSessions = new Set(); // sessions with unseen output
const attentionSessions = new Set(); // sessions needing user action
const lastActivityTime = new Map(); // sessionId → Date of last terminal output

// Noise patterns to ignore for unread tracking
const unreadNoiseRe = /file-history-snapshot|^\s*$/;

function markUnread(sessionId, data) {
  if (sessionId === activeSessionId) return;
  // Skip noise
  if (unreadNoiseRe.test(data)) return;
  if (!unreadSessions.has(sessionId)) {
    unreadSessions.add(sessionId);
    const item = document.querySelector(`.session-item[data-session-id="${sessionId}"]`);
    if (item) item.classList.add('has-unread');
  }
}

function clearUnread(sessionId) {
  unreadSessions.delete(sessionId);
  const item = document.querySelector(`.session-item[data-session-id="${sessionId}"]`);
  if (item) item.classList.remove('has-unread');
}

// --- Terminal themes ---
const TERMINAL_THEMES = {
  switchboard: {
    label: 'Switchboard',
    background: '#1a1a2e', foreground: '#e0e0e0', cursor: '#e94560', selectionBackground: '#3a3a5e',
    black: '#1a1a2e', red: '#e94560', green: '#0dff00', yellow: '#f5a623', blue: '#7b68ee', magenta: '#c678dd', cyan: '#56b6c2', white: '#c5c8c6',
    brightBlack: '#555568', brightRed: '#ff6b81', brightGreen: '#69ff69', brightYellow: '#ffd93d', brightBlue: '#8fa8ff', brightMagenta: '#d19afc', brightCyan: '#7ee8e8', brightWhite: '#eaeaea',
  },
  ghostty: {
    label: 'Ghostty',
    background: '#292c33', foreground: '#ffffff', cursor: '#ffffff', cursorAccent: '#363a43', selectionBackground: '#ffffff', selectionForeground: '#292c33',
    black: '#1d1f21', red: '#bf6b69', green: '#b7bd73', yellow: '#e9c880', blue: '#88a1bb', magenta: '#ad95b8', cyan: '#95bdb7', white: '#c5c8c6',
    brightBlack: '#666666', brightRed: '#c55757', brightGreen: '#bcc95f', brightYellow: '#e1c65e', brightBlue: '#83a5d6', brightMagenta: '#bc99d4', brightCyan: '#83beb1', brightWhite: '#eaeaea',
  },
  tokyoNight: {
    label: 'Tokyo Night',
    background: '#1a1b26', foreground: '#c0caf5', cursor: '#c0caf5', selectionBackground: '#33467c',
    black: '#15161e', red: '#f7768e', green: '#9ece6a', yellow: '#e0af68', blue: '#7aa2f7', magenta: '#bb9af7', cyan: '#7dcfff', white: '#a9b1d6',
    brightBlack: '#414868', brightRed: '#f7768e', brightGreen: '#9ece6a', brightYellow: '#e0af68', brightBlue: '#7aa2f7', brightMagenta: '#bb9af7', brightCyan: '#7dcfff', brightWhite: '#c0caf5',
  },
  catppuccinMocha: {
    label: 'Catppuccin Mocha',
    background: '#1e1e2e', foreground: '#cdd6f4', cursor: '#f5e0dc', selectionBackground: '#45475a',
    black: '#45475a', red: '#f38ba8', green: '#a6e3a1', yellow: '#f9e2af', blue: '#89b4fa', magenta: '#f5c2e7', cyan: '#94e2d5', white: '#bac2de',
    brightBlack: '#585b70', brightRed: '#f38ba8', brightGreen: '#a6e3a1', brightYellow: '#f9e2af', brightBlue: '#89b4fa', brightMagenta: '#f5c2e7', brightCyan: '#94e2d5', brightWhite: '#a6adc8',
  },
  dracula: {
    label: 'Dracula',
    background: '#282a36', foreground: '#f8f8f2', cursor: '#f8f8f2', selectionBackground: '#44475a',
    black: '#21222c', red: '#ff5555', green: '#50fa7b', yellow: '#f1fa8c', blue: '#bd93f9', magenta: '#ff79c6', cyan: '#8be9fd', white: '#f8f8f2',
    brightBlack: '#6272a4', brightRed: '#ff6e6e', brightGreen: '#69ff94', brightYellow: '#ffffa5', brightBlue: '#d6acff', brightMagenta: '#ff92df', brightCyan: '#a4ffff', brightWhite: '#ffffff',
  },
  nord: {
    label: 'Nord',
    background: '#2e3440', foreground: '#d8dee9', cursor: '#d8dee9', selectionBackground: '#434c5e',
    black: '#3b4252', red: '#bf616a', green: '#a3be8c', yellow: '#ebcb8b', blue: '#81a1c1', magenta: '#b48ead', cyan: '#88c0d0', white: '#e5e9f0',
    brightBlack: '#4c566a', brightRed: '#bf616a', brightGreen: '#a3be8c', brightYellow: '#ebcb8b', brightBlue: '#81a1c1', brightMagenta: '#b48ead', brightCyan: '#8fbcbb', brightWhite: '#eceff4',
  },
  solarizedDark: {
    label: 'Solarized Dark',
    background: '#002b36', foreground: '#839496', cursor: '#839496', selectionBackground: '#073642',
    black: '#073642', red: '#dc322f', green: '#859900', yellow: '#b58900', blue: '#268bd2', magenta: '#d33682', cyan: '#2aa198', white: '#eee8d5',
    brightBlack: '#002b36', brightRed: '#cb4b16', brightGreen: '#586e75', brightYellow: '#657b83', brightBlue: '#839496', brightMagenta: '#6c71c4', brightCyan: '#93a1a1', brightWhite: '#fdf6e3',
  },
};

let currentThemeName = 'switchboard';
function getTerminalTheme() {
  return TERMINAL_THEMES[currentThemeName] || TERMINAL_THEMES.switchboard;
}
let TERMINAL_THEME = getTerminalTheme();

// --- Terminal key bindings ---
// Shift+Enter → kitty protocol (CSI 13;2u) so Claude Code treats it as newline, not submit.
// Two layers needed:
//   1. attachCustomKeyEventHandler returning false — blocks xterm's key pipeline (onKey/onData)
//   2. preventDefault on capture-phase keydown — prevents browser inserting \n into textarea
function setupTerminalKeyBindings(terminal, container, getSessionId) {
  terminal.attachCustomKeyEventHandler((e) => {
    if (e.key === 'Enter' && e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) {
      if (e.type === 'keydown') {
        window.api.sendInput(getSessionId(), '\x1b[13;2u');
      }
      return false;
    }
    return true;
  });

  const textarea = container.querySelector('.xterm-helper-textarea');
  if (textarea) {
    textarea.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) {
        e.preventDefault();
      }
    }, { capture: true });
  }
}

// Check whether a terminal is scrolled to the bottom using xterm's buffer API.
// This avoids race conditions with DOM scroll events that fire when content
// is added (changing scrollHeight) before the write callback runs.
function isAtBottom(terminal) {
  const buf = terminal.buffer.active;
  return buf.viewportY >= buf.baseY;
}

// --- IPC listeners from main process ---
// Synchronized output markers — TUI repaints, not meaningful content
const ESC_SYNC_START = '\x1b[?2026h';
const ESC_SYNC_END = '\x1b[?2026l';

// Screen-clear / alt-screen escape sequences.
const ESC_SCREEN_CLEAR = '\x1b[2J';
const ESC_ALT_SCREEN_ON = '\x1b[?1049h';

// After a screen redraw the content may arrive across multiple data chunks.
// Keep scrolling to bottom for a short window after detecting a clear.
let redrawScrollUntil = 0;

window.api.onTerminalData((sessionId, data) => {
  const entry = openSessions.get(sessionId);
  if (entry) {
    // Check scroll position *before* writing — the write may change scrollHeight
    // and cause a DOM scroll event that would give a stale answer.
    const wasAtBottom = isAtBottom(entry.terminal);
    // Screen clears push content into scrollback, moving baseY away from
    // viewportY, so isAtBottom would return false during the redraw.
    if (data.includes(ESC_SCREEN_CLEAR) || data.includes(ESC_ALT_SCREEN_ON)) {
      redrawScrollUntil = Date.now() + 1000;
    }
    const forceScroll = Date.now() < redrawScrollUntil;
    entry.terminal.write(data, () => {
      if (sessionId !== activeSessionId) return;
      if (wasAtBottom || forceScroll) {
        entry.terminal.scrollToBottom();
      }
    });
  }
  // Don't mark activity for synchronized output (TUI repaints)
  const isSyncRedraw = data.startsWith(ESC_SYNC_START) && data.endsWith(ESC_SYNC_END);
  if (!isSyncRedraw) {
    if (!unreadNoiseRe.test(data)) lastActivityTime.set(sessionId, new Date());
    markUnread(sessionId, data);
  }
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

  // Clean up pending session so it doesn't duplicate the real .jsonl entry
  pendingSessions.delete(oldId);
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

  // Clean up terminal UI on exit
  if (entry) {
    window.api.closeTerminal(sessionId);
    entry.terminal.dispose();
    entry.element.remove();
    openSessions.delete(sessionId);
  }
  if (activeSessionId === sessionId) {
    setActiveSession(null);
    terminalHeader.style.display = 'none';
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
  if (/attention|approval|permission|needs your/i.test(message) && sessionId !== activeSessionId) {
    attentionSessions.add(sessionId);
    const item = document.querySelector(`.session-item[data-session-id="${sessionId}"]`);
    if (item) item.classList.add('needs-attention');
  }

  // Show in header if active
  if (sessionId === activeSessionId && terminalHeaderPtyTitle) {
    terminalHeaderPtyTitle.textContent = message;
    terminalHeaderPtyTitle.style.display = '';
  }
});

// --- Progress state (iTerm2 OSC 9;4) ---
// state: 0=clear, 1=progress%, 2=error, 3=indeterminate(busy), 4=warning
const sessionProgressState = new Map();

window.api.onProgressState((sessionId, state, percent) => {
  sessionProgressState.set(sessionId, { state, percent });
  updateProgressIndicators(sessionId);
});

function updateProgressIndicators(sessionId) {
  const info = sessionProgressState.get(sessionId);
  const state = info?.state ?? 0;

  // Update sidebar item
  const item = document.querySelector(`.session-item[data-session-id="${sessionId}"]`);
  if (item) {
    item.classList.toggle('is-busy', state === 3);
    item.classList.toggle('has-progress', state === 1);
    item.classList.toggle('has-error', state === 2);
  }

  // Update terminal header progress bar if this is the active session
  if (sessionId === activeSessionId) {
    const bar = document.getElementById('terminal-progress-bar');
    if (!bar) return;
    bar.className = 'progress-state-' + state;
    if (state === 1) {
      bar.style.setProperty('--progress', (percent || 0) + '%');
    }
  }
}

// --- Single entry point for all sidebar renders ---
// resort=true: re-sort items by priority+time (use for user-initiated actions)
// resort=false (default): preserve existing DOM order, new items go to top
function refreshSidebar({ resort = false } = {}) {
  // When searching, always use all projects (search ignores archive filter)
  let projects = (searchMatchIds !== null)
    ? cachedAllProjects
    : (showArchived ? cachedAllProjects : cachedProjects);

  if (searchMatchIds !== null) {
    projects = projects.map(p => ({
      ...p,
      sessions: p.sessions.filter(s => searchMatchIds.has(s.sessionId)),
    })).filter(p => p.sessions.length > 0);
  }

  renderProjects(projects, resort);
}

// --- Archive toggle ---
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

collapseToggle.addEventListener('click', () => {
  const headers = sidebarContent.querySelectorAll('.project-header');
  const slugGroups = sidebarContent.querySelectorAll('.slug-group');
  const allCollapsed = [...headers].every(h => h.classList.contains('collapsed')) &&
                       [...slugGroups].every(g => g.classList.contains('collapsed'));
  if (allCollapsed) {
    headers.forEach(h => h.classList.remove('collapsed'));
    slugGroups.forEach(g => g.classList.remove('collapsed'));
    collapseToggle.title = 'Collapse all';
    collapseToggle.querySelector('svg').innerHTML = '<path d="M4 4.5l3 2.5-3 2.5"/><line x1="8" y1="2" x2="14" y2="2"/><line x1="8" y1="7" x2="14" y2="7"/><line x1="8" y1="12" x2="14" y2="12"/>';
  } else {
    headers.forEach(h => h.classList.add('collapsed'));
    slugGroups.forEach(g => g.classList.add('collapsed'));
    collapseToggle.title = 'Expand all';
    collapseToggle.querySelector('svg').innerHTML = '<path d="M6 4.5l-3 2.5 3 2.5"/><line x1="8" y1="2" x2="14" y2="2"/><line x1="8" y1="7" x2="14" y2="7"/><line x1="8" y1="12" x2="14" y2="12"/>';
  }
  saveExpandedSlugs();
});

// --- Search (debounced, per-tab FTS) ---
let searchDebounceTimer = null;
const searchClear = document.getElementById('search-clear');

function clearSearch() {
  searchInput.value = '';
  searchBar.classList.remove('has-query');
  if (searchDebounceTimer) { clearTimeout(searchDebounceTimer); searchDebounceTimer = null; }
  if (activeTab === 'sessions') {
    searchMatchIds = null;
    refreshSidebar({ resort: true });
  } else if (activeTab === 'plans') {
    renderPlans(cachedPlans);
  } else if (activeTab === 'config') {
    renderConfig();
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
      if (activeTab === 'sessions') {
        const results = await window.api.search('session', query);
        searchMatchIds = new Set(results.map(r => r.id));
        refreshSidebar({ resort: true });
      } else if (activeTab === 'plans') {
        const results = await window.api.search('plan', query);
        const matchIds = new Set(results.map(r => r.id));
        renderPlans(cachedPlans.filter(p => matchIds.has(p.filename)));
      } else if (activeTab === 'config') {
        const results = await window.api.search('config', query);
        const matchIds = new Set(results.map(r => r.id));
        renderConfig(cachedConfigItems.filter(item => matchIds.has(item.filePath)));
      }
    } catch {
      if (activeTab === 'sessions') {
        searchMatchIds = null;
        refreshSidebar({ resort: true });
      }
    }
  }, 200);
});

// --- Terminal header controls ---
terminalStopBtn.addEventListener('click', async () => {
  if (!activeSessionId) return;
  const sid = activeSessionId;
  await window.api.stopSession(sid);
  activePtyIds.delete(sid);
  setActiveSession(null);
  terminalHeader.style.display = 'none';
  placeholder.style.display = '';
  refreshSidebar();
});

terminalRestartBtn.addEventListener('click', () => {
  if (!activeSessionId) return;
  const entry = openSessions.get(activeSessionId);
  if (!entry) return;
  window.api.closeTerminal(activeSessionId);
  entry.terminal.dispose();
  entry.element.remove();
  openSessions.delete(activeSessionId);
  openSession(entry.session);
});

// --- Poll for active PTY sessions ---
async function pollActiveSessions() {
  try {
    const ids = await window.api.getActiveSessions();
    activePtyIds = new Set(ids);
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
      item.classList.remove('has-unread', 'needs-attention', 'is-busy', 'has-progress', 'has-error');
      unreadSessions.delete(id);
      attentionSessions.delete(id);
      sessionProgressState.delete(id);
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
  if (wasEmpty) {
    loadingStatus.textContent = 'Loading\u2026';
    loadingStatus.className = 'active';
    loadingStatus.style.display = '';
  }
  const [defaultProjects, allProjects] = await Promise.all([
    window.api.getProjects(false),
    window.api.getProjects(true),
  ]);
  cachedProjects = defaultProjects;
  cachedAllProjects = allProjects;
  loadingStatus.style.display = 'none';
  loadingStatus.className = '';
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

  // Restore active plain terminals from main process (survives renderer reload)
  try {
    const activeTerminals = await window.api.getActiveTerminals();
    for (const { sessionId, projectPath } of activeTerminals) {
      if (pendingSessions.has(sessionId)) continue; // already tracked
      const folder = projectPath.replace(/[/_]/g, '-').replace(/^-/, '-');
      const session = {
        sessionId, summary: 'Terminal', firstPrompt: '', projectPath,
        name: null, starred: 0, archived: 0, messageCount: 0,
        modified: new Date().toISOString(), created: new Date().toISOString(),
        type: 'terminal',
      };
      pendingSessions.set(sessionId, { session, projectPath, folder });
      sessionMap.set(sessionId, session);
      for (const projList of [cachedProjects, cachedAllProjects]) {
        let proj = projList.find(p => p.projectPath === projectPath);
        if (!proj) {
          proj = { folder, projectPath, sessions: [] };
          projList.push(proj);
        }
        if (!proj.sessions.some(s => s.sessionId === sessionId)) {
          proj.sessions.unshift(session);
        }
      }
    }
  } catch {}

  await pollActiveSessions();
  refreshSidebar({ resort });
  renderDefaultStatus();
}

function slugId(slug) {
  return 'slug-' + slug.replace(/[^a-zA-Z0-9_-]/g, '_');
}

function folderId(projectPath) {
  return 'project-' + projectPath.replace(/[^a-zA-Z0-9_-]/g, '_');
}

function buildSlugGroup(slug, sessions) {
  const group = document.createElement('div');
  const id = slugId(slug);
  const expanded = getExpandedSlugs().has(id);
  group.className = expanded ? 'slug-group' : 'slug-group collapsed';
  group.id = id;

  const mostRecent = sessions.reduce((a, b) => {
    const aTime = lastActivityTime.get(a.sessionId) || new Date(a.modified);
    const bTime = lastActivityTime.get(b.sessionId) || new Date(b.modified);
    return bTime > aTime ? b : a;
  });
  const displayName = cleanDisplayName(mostRecent.name || mostRecent.summary || slug);
  const mostRecentTime = lastActivityTime.get(mostRecent.sessionId) || new Date(mostRecent.modified);
  const timeStr = formatDate(mostRecentTime);

  const header = document.createElement('div');
  header.className = 'slug-group-header';

  const row = document.createElement('div');
  row.className = 'slug-group-row';

  const expand = document.createElement('span');
  expand.className = 'slug-group-expand';
  expand.innerHTML = '<span class="arrow">&#9654;</span>';

  const info = document.createElement('div');
  info.className = 'slug-group-info';

  const nameEl = document.createElement('div');
  nameEl.className = 'slug-group-name';
  nameEl.textContent = displayName;

  const hasRunning = sessions.some(s => activePtyIds.has(s.sessionId));

  const meta = document.createElement('div');
  meta.className = 'slug-group-meta';
  meta.innerHTML = `<span class="slug-group-dot${hasRunning ? ' running' : ''}"></span><span class="slug-group-count">${sessions.length} sessions</span> ${escapeHtml(timeStr)}`;

  const archiveSlugBtn = document.createElement('button');
  archiveSlugBtn.className = 'slug-group-archive-btn';
  archiveSlugBtn.title = 'Archive all sessions in group';
  archiveSlugBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M1,1 L11,1 L11,4 L1,4 Z"/><path d="M1,4 L1,11 L11,11 L11,4"/><line x1="5" y1="6.5" x2="7" y2="6.5"/></svg>';

  info.appendChild(nameEl);
  info.appendChild(meta);
  row.appendChild(expand);
  row.appendChild(info);
  row.appendChild(archiveSlugBtn);
  header.appendChild(row);

  const sessionsContainer = document.createElement('div');
  sessionsContainer.className = 'slug-group-sessions';

  const promoted = [];
  const rest = [];
  for (const session of sessions) {
    if (activePtyIds.has(session.sessionId)) {
      promoted.push(session);
    } else {
      rest.push(session);
    }
  }

  if (promoted.length > 0) {
    group.classList.add('has-promoted');
    for (const session of promoted) {
      sessionsContainer.appendChild(buildSessionItem(session));
    }
    if (rest.length > 0) {
      const moreBtn = document.createElement('div');
      moreBtn.className = 'slug-group-more';
      moreBtn.id = 'sgm-' + id;
      moreBtn.textContent = `+ ${rest.length} more`;

      const olderDiv = document.createElement('div');
      olderDiv.className = 'slug-group-older';
      olderDiv.id = 'sgo-' + id;
      for (const session of rest) {
        olderDiv.appendChild(buildSessionItem(session));
      }

      sessionsContainer.appendChild(moreBtn);
      sessionsContainer.appendChild(olderDiv);
    }
  } else {
    for (const session of sessions) {
      sessionsContainer.appendChild(buildSessionItem(session));
    }
  }

  group.appendChild(header);
  group.appendChild(sessionsContainer);
  return group;
}

// --- Project folder groups ---
async function loadProjectGroups() {
  const global = await window.api.getSetting('global');
  if (global && global.projectGroups) {
    projectGroups = global.projectGroups;
  }
}

async function saveProjectGroups() {
  const global = (await window.api.getSetting('global')) || {};
  global.projectGroups = projectGroups;
  await window.api.setSetting('global', global);
}

function getGroupForProject(projectPath) {
  return projectGroups.groups.find(g => g.projectPaths.includes(projectPath));
}

function createGroup(name) {
  const id = 'g_' + Date.now();
  const group = { id, name, collapsed: false, projectPaths: [] };
  projectGroups.groups.push(group);
  projectGroups.groupOrder.push(id);
  saveProjectGroups();
  return group;
}

function deleteGroup(id) {
  projectGroups.groups = projectGroups.groups.filter(g => g.id !== id);
  projectGroups.groupOrder = projectGroups.groupOrder.filter(gid => gid !== id);
  saveProjectGroups();
}

function addProjectToGroup(groupId, projectPath) {
  for (const g of projectGroups.groups) {
    g.projectPaths = g.projectPaths.filter(p => p !== projectPath);
  }
  const group = projectGroups.groups.find(g => g.id === groupId);
  if (group && !group.projectPaths.includes(projectPath)) {
    group.projectPaths.push(projectPath);
  }
  saveProjectGroups();
}

function removeProjectFromGroup(projectPath) {
  for (const g of projectGroups.groups) {
    g.projectPaths = g.projectPaths.filter(p => p !== projectPath);
  }
  saveProjectGroups();
}

function buildFolderGroupHeader(fg) {
  const header = document.createElement('div');
  header.className = 'folder-group-header';
  header.id = 'fgh-' + fg.id;
  header.innerHTML = `<span class="folder-group-chevron">${fg.collapsed ? '&#9654;' : '&#9660;'}</span><span class="folder-group-name">${escapeHtml(fg.name)}</span>`;
  const deleteBtn = document.createElement('button');
  deleteBtn.className = 'folder-group-delete-btn';
  deleteBtn.title = 'Delete group';
  deleteBtn.innerHTML = '&times;';
  header.appendChild(deleteBtn);
  return header;
}

function buildProjectElement(project, resort) {
  // === Filter ===
  let filtered = project.sessions;
  if (showStarredOnly) {
    filtered = filtered.filter(s => s.starred);
  }
  if (showRunningOnly) {
    filtered = filtered.filter(s => activePtyIds.has(s.sessionId));
  }
  if (showTodayOnly) {
    const now = new Date();
    const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    filtered = filtered.filter(s => {
      if (!s.modified) return false;
      const d = new Date(s.modified);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` === todayStr;
    });
  }
  if (filtered.length === 0 && project.sessions.length > 0) return null;
  const fId = folderId(project.projectPath);

  // === Sort ===
  filtered = [...filtered].sort((a, b) => {
    const aRunning = activePtyIds.has(a.sessionId) || pendingSessions.has(a.sessionId);
    const bRunning = activePtyIds.has(b.sessionId) || pendingSessions.has(b.sessionId);
    const aPri = (a.starred && aRunning ? 3 : aRunning ? 2 : a.starred ? 1 : 0);
    const bPri = (b.starred && bRunning ? 3 : bRunning ? 2 : b.starred ? 1 : 0);
    if (aPri !== bPri) return bPri - aPri;
    return new Date(b.modified) - new Date(a.modified);
  });

  // === Slug grouping ===
  const slugMap = new Map();
  const ungrouped = [];
  for (const session of filtered) {
    if (session.slug) {
      if (!slugMap.has(session.slug)) slugMap.set(session.slug, []);
      slugMap.get(session.slug).push(session);
    } else {
      ungrouped.push(session);
    }
  }

  const allItems = [];
  for (const session of ungrouped) {
    const isRunning = activePtyIds.has(session.sessionId) || pendingSessions.has(session.sessionId);
    allItems.push({
      sortTime: new Date(session.modified).getTime(),
      pinned: !!session.starred, running: isRunning,
      element: buildSessionItem(session),
    });
  }
  for (const [slug, sessions] of slugMap) {
    const mostRecentTime = Math.max(...sessions.map(s => new Date(s.modified).getTime()));
    const hasRunning = sessions.some(s => activePtyIds.has(s.sessionId) || pendingSessions.has(s.sessionId));
    const hasPinned = sessions.some(s => s.starred);
    const element = sessions.length === 1 ? buildSessionItem(sessions[0]) : buildSlugGroup(slug, sessions);
    allItems.push({
      sortTime: mostRecentTime,
      pinned: hasPinned, running: hasRunning,
      element,
    });
  }

  // === Sort render items ===
  const prevEntry = sortedOrder.find(e => e.projectPath === project.projectPath);
  if (resort || !prevEntry) {
    allItems.sort((a, b) => {
      const aPri = (a.pinned && a.running ? 3 : a.running ? 2 : a.pinned ? 1 : 0);
      const bPri = (b.pinned && b.running ? 3 : b.running ? 2 : b.pinned ? 1 : 0);
      if (aPri !== bPri) return bPri - aPri;
      return b.sortTime - a.sortTime;
    });
  } else {
    const orderIndex = new Map(prevEntry.itemIds.map((id, i) => [id, i]));
    allItems.sort((a, b) => {
      const aPos = orderIndex.get(a.element.id);
      const bPos = orderIndex.get(b.element.id);
      if (aPos !== undefined && bPos !== undefined) return aPos - bPos;
      if (aPos === undefined && bPos !== undefined) return -1;
      if (aPos !== undefined && bPos === undefined) return 1;
      return b.sortTime - a.sortTime;
    });
  }

  const orderEntry = { projectPath: project.projectPath, itemIds: allItems.map(item => item.element.id) };

  // === Truncate ===
  let visible = [];
  let older = [];
  if (searchMatchIds !== null || showStarredOnly || showRunningOnly || showTodayOnly) {
    visible = allItems;
  } else {
    let count = 0;
    const ageCutoff = Date.now() - sessionMaxAgeDays * 86400000;
    for (const item of allItems) {
      if (item.running || item.pinned || (count < visibleSessionCount && item.sortTime >= ageCutoff)) {
        visible.push(item);
        count++;
      } else {
        older.push(item);
      }
    }
    if (visible.length === 0 && older.length > 0) {
      visible = older;
      older = [];
    }
  }

  // === Build DOM ===
  const group = document.createElement('div');
  group.className = 'project-group';
  group.id = fId;

  const header = document.createElement('div');
  header.className = 'project-header';
  header.id = 'ph-' + fId;
  const shortName = project.projectPath.split('/').filter(Boolean).slice(-2).join('/');
  header.innerHTML = `<span class="arrow">&#9660;</span> <span class="project-name">${shortName}</span>`;

  const projectConfigBtn = document.createElement('button');
  projectConfigBtn.className = 'project-config-btn';
  projectConfigBtn.title = 'Project config';
  projectConfigBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><line x1="2" y1="4" x2="14" y2="4"/><line x1="2" y1="8" x2="14" y2="8"/><line x1="2" y1="12" x2="14" y2="12"/><circle cx="5" cy="4" r="1.2" fill="#111118" stroke="currentColor"/><circle cx="10" cy="8" r="1.2" fill="#111118" stroke="currentColor"/><circle cx="7" cy="12" r="1.2" fill="#111118" stroke="currentColor"/></svg>';
  header.appendChild(projectConfigBtn);

  const settingsBtn = document.createElement('button');
  settingsBtn.className = 'project-settings-btn';
  settingsBtn.title = 'Project settings';
  settingsBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M6.6 1h2.8l.4 2.1a5.5 5.5 0 0 1 1.3.8l2-.8 1.4 2.4-1.6 1.4a5.6 5.6 0 0 1 0 1.5l1.6 1.4-1.4 2.4-2-.8a5.5 5.5 0 0 1-1.3.8L9.4 15H6.6l-.4-2.1a5.5 5.5 0 0 1-1.3-.8l-2 .8-1.4-2.4 1.6-1.4a5.6 5.6 0 0 1 0-1.5L1.5 6.2l1.4-2.4 2 .8a5.5 5.5 0 0 1 1.3-.8L6.6 1z"/><circle cx="8" cy="8" r="2.5"/></svg>';
  header.appendChild(settingsBtn);

  const archiveGroupBtn = document.createElement('button');
  archiveGroupBtn.className = 'project-archive-btn';
  archiveGroupBtn.title = 'Archive all sessions';
  archiveGroupBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M1,1 L11,1 L11,4 L1,4 Z"/><path d="M1,4 L1,11 L11,11 L11,4"/><line x1="5" y1="6.5" x2="7" y2="6.5"/></svg>';
  header.appendChild(archiveGroupBtn);

  const newBtn = document.createElement('button');
  newBtn.className = 'project-new-btn';
  newBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5"><line x1="6" y1="2" x2="6" y2="10"/><line x1="2" y1="6" x2="10" y2="6"/></svg>';
  newBtn.title = 'New session';
  header.appendChild(newBtn);

  const sessionsList = document.createElement('div');
  sessionsList.className = 'project-sessions';
  sessionsList.id = 'sessions-' + fId;

  for (const item of visible) {
    sessionsList.appendChild(item.element);
  }

  if (older.length > 0) {
    const moreBtn = document.createElement('div');
    moreBtn.className = 'sessions-more-toggle';
    moreBtn.id = 'older-' + fId;
    moreBtn.textContent = `+ ${older.length} older`;
    const olderList = document.createElement('div');
    olderList.className = 'sessions-older';
    olderList.id = 'older-list-' + fId;
    olderList.style.display = 'none';
    for (const item of older) {
      olderList.appendChild(item.element);
    }
    sessionsList.appendChild(moreBtn);
    sessionsList.appendChild(olderList);
  }

  if (searchMatchIds === null && !showStarredOnly && !showRunningOnly) {
    const mostRecent = filtered[0]?.modified;
    if (mostRecent && (Date.now() - new Date(mostRecent)) > sessionMaxAgeDays * 86400000) {
      header.classList.add('collapsed');
    }
  }

  group.appendChild(header);
  group.appendChild(sessionsList);
  return { element: group, orderEntry };
}

function renderProjects(projects, resort) {
  const newSidebar = document.createElement('div');

  // Sort project groups using sortedOrder as source of truth
  if (!resort && sortedOrder.length > 0) {
    const orderIndex = new Map(sortedOrder.map((e, i) => [e.projectPath, i]));
    projects = [...projects].sort((a, b) => {
      const aPos = orderIndex.get(a.projectPath);
      const bPos = orderIndex.get(b.projectPath);
      if (aPos !== undefined && bPos !== undefined) return aPos - bPos;
      if (aPos === undefined && bPos !== undefined) return -1;
      if (aPos !== undefined && bPos === undefined) return 1;
      return 0;
    });
  }
  // projects are now in the correct order (data order for resort, preserved order otherwise)

  const newSortedOrder = [];
  const isSearching = searchMatchIds !== null;

  // Partition projects into folder groups vs ungrouped
  const groupedProjectMap = new Map();
  const ungroupedProjectsList = [];

  for (const project of projects) {
    const fg = !isSearching ? getGroupForProject(project.projectPath) : null;
    if (fg) {
      if (!groupedProjectMap.has(fg.id)) groupedProjectMap.set(fg.id, []);
      groupedProjectMap.get(fg.id).push(project);
    } else {
      ungroupedProjectsList.push(project);
    }
  }

  // Render folder groups in order
  for (const groupId of projectGroups.groupOrder) {
    const fg = projectGroups.groups.find(g => g.id === groupId);
    if (!fg) continue;
    if (isSearching && !groupedProjectMap.has(groupId)) continue;

    const folderGroup = document.createElement('div');
    folderGroup.className = 'folder-group';
    folderGroup.id = 'fg-' + groupId;

    const folderHeader = buildFolderGroupHeader(fg);

    const folderBody = document.createElement('div');
    folderBody.className = 'folder-group-body';
    folderBody.id = 'fgb-' + groupId;
    if (fg.collapsed) folderBody.style.display = 'none';

    if (groupedProjectMap.has(groupId)) {
      for (const project of groupedProjectMap.get(groupId)) {
        const result = buildProjectElement(project, resort);
        if (result) {
          folderBody.appendChild(result.element);
          newSortedOrder.push(result.orderEntry);
        }
      }
    }

    folderGroup.appendChild(folderHeader);
    folderGroup.appendChild(folderBody);
    if (!isSearching) newSidebar.appendChild(folderGroup);
  }

  // Render ungrouped projects (and all projects when searching)
  const rootProjects = isSearching ? projects : ungroupedProjectsList;
  for (const project of rootProjects) {
    const result = buildProjectElement(project, resort);
    if (result) {
      newSidebar.appendChild(result.element);
      newSortedOrder.push(result.orderEntry);
    }
  }

  // Re-apply active state
  if (activeSessionId) {
    const activeItem = newSidebar.querySelector(`[data-session-id="${activeSessionId}"]`);
    if (activeItem) activeItem.classList.add('active');
  }

  morphdom(sidebarContent, newSidebar, {
    childrenOnly: true,
    onBeforeElUpdated(fromEl, toEl) {
      if (fromEl.classList.contains('project-header')) {
        if (fromEl.classList.contains('collapsed')) {
          toEl.classList.add('collapsed');
        } else {
          toEl.classList.remove('collapsed');
        }
      }
      if (fromEl.classList.contains('slug-group')) {
        if (fromEl.classList.contains('collapsed')) {
          toEl.classList.add('collapsed');
        } else {
          toEl.classList.remove('collapsed');
        }
      }
      if (fromEl.classList.contains('sessions-older') && fromEl.style.display !== 'none') {
        toEl.style.display = '';
      }
      if (fromEl.classList.contains('sessions-more-toggle') && fromEl.classList.contains('expanded')) {
        toEl.classList.add('expanded');
        toEl.textContent = '- hide older';
      }
      if (fromEl.classList.contains('slug-group-older') && fromEl.style.display !== 'none') {
        toEl.style.display = '';
      }
      if (fromEl.classList.contains('slug-group-more') && fromEl.classList.contains('expanded')) {
        toEl.classList.add('expanded');
      }
      // Folder group: preserve collapsed state and body visibility
      if (fromEl.classList.contains('folder-group-header')) {
        const fromChevron = fromEl.querySelector('.folder-group-chevron');
        const toChevron = toEl.querySelector('.folder-group-chevron');
        if (fromChevron && toChevron) toChevron.innerHTML = fromChevron.innerHTML;
      }
      if (fromEl.classList.contains('folder-group-body')) {
        toEl.style.display = fromEl.style.display;
      }
      return true;
    },
    getNodeKey(node) {
      return node.id || undefined;
    }
  });

  // Save the full sorted order (project order + item order) as source of truth
  sortedOrder = newSortedOrder;

  rebindSidebarEvents(projects);

  // Restore terminal focus after morphdom DOM updates, but not if the user is typing in the search box
  if (activeSessionId && openSessions.has(activeSessionId) && document.activeElement !== searchInput) {
    openSessions.get(activeSessionId).terminal.focus();
  }
}

function rebindSidebarEvents(projects) {
  // --- Folder group headers ---
  sidebarContent.querySelectorAll('.folder-group-header').forEach(header => {
    const groupId = header.id.replace('fgh-', '');
    const deleteBtn = header.querySelector('.folder-group-delete-btn');
    if (deleteBtn) {
      deleteBtn.onclick = (e) => {
        e.stopPropagation();
        deleteGroup(groupId);
        refreshSidebar();
      };
    }
    const nameEl = header.querySelector('.folder-group-name');
    if (nameEl) {
      nameEl.ondblclick = (e) => {
        e.stopPropagation();
        nameEl.contentEditable = true;
        nameEl.focus();
        const range = document.createRange();
        range.selectNodeContents(nameEl);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        const finish = () => {
          nameEl.contentEditable = false;
          const fg = projectGroups.groups.find(g => g.id === groupId);
          if (fg) {
            fg.name = nameEl.textContent.trim() || fg.name;
            saveProjectGroups();
          }
        };
        nameEl.onblur = finish;
        nameEl.onkeydown = (ev) => {
          if (ev.key === 'Enter') { ev.preventDefault(); nameEl.blur(); }
          if (ev.key === 'Escape') { nameEl.contentEditable = false; refreshSidebar(); }
        };
      };
    }
    header.onclick = (e) => {
      if (e.target.closest('.folder-group-delete-btn') || e.target.closest('.folder-group-name')) return;
      const fg = projectGroups.groups.find(g => g.id === groupId);
      if (fg) {
        fg.collapsed = !fg.collapsed;
        const body = document.getElementById('fgb-' + groupId);
        if (body) body.style.display = fg.collapsed ? 'none' : '';
        const chevron = header.querySelector('.folder-group-chevron');
        if (chevron) chevron.innerHTML = fg.collapsed ? '&#9654;' : '&#9660;';
        saveProjectGroups();
      }
    };
    // Drop target for folder group
    header.ondragover = (e) => { e.preventDefault(); header.classList.add('drag-over'); };
    header.ondragleave = () => { header.classList.remove('drag-over'); };
    header.ondrop = (e) => {
      e.preventDefault();
      header.classList.remove('drag-over');
      const projectPath = e.dataTransfer.getData('text/x-project-path');
      if (projectPath) {
        addProjectToGroup(groupId, projectPath);
        refreshSidebar();
      }
    };
  });

  // --- Make project headers draggable ---
  for (const project of projects) {
    const fId = folderId(project.projectPath);
    const projGroup = document.getElementById(fId);
    const header = document.getElementById('ph-' + fId);
    if (!projGroup || !header) continue;
    header.draggable = true;
    header.ondragstart = (e) => {
      e.dataTransfer.setData('text/x-project-path', project.projectPath);
      e.dataTransfer.effectAllowed = 'move';
      projGroup.classList.add('dragging');
    };
    header.ondragend = () => { projGroup.classList.remove('dragging'); };
  }

  // Drop on sidebar root to ungroup
  sidebarContent.ondragover = (e) => {
    if (!e.target.closest('.folder-group-header')) e.preventDefault();
  };
  sidebarContent.ondrop = (e) => {
    if (!e.target.closest('.folder-group-header')) {
      e.preventDefault();
      const projectPath = e.dataTransfer.getData('text/x-project-path');
      if (projectPath) {
        removeProjectFromGroup(projectPath);
        refreshSidebar();
      }
    }
  };

  for (const project of projects) {
    const fId = folderId(project.projectPath);
    const header = document.getElementById('ph-' + fId);
    if (!header) continue;
    const newBtn = header.querySelector('.project-new-btn');
    if (newBtn) {
      newBtn.onclick = (e) => { e.stopPropagation(); showNewSessionPopover(project, newBtn); };
    }
    const projectConfigBtn = header.querySelector('.project-config-btn');
    if (projectConfigBtn) {
      projectConfigBtn.onclick = (e) => {
        e.stopPropagation();
        // Switch to config tab scoped to this project
        document.querySelectorAll('.sidebar-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === 'config'));
        activeTab = 'config';
        sidebarContent.style.display = 'none';
        plansContent.style.display = 'none';
        statsContent.style.display = 'none';
        configContent.style.display = '';
        sessionFilters.style.display = 'none';
        searchBar.style.display = '';
        searchInput.value = '';
        searchBar.classList.remove('has-query');
        loadConfig(project.projectPath);
      };
    }
    const settingsBtn = header.querySelector('.project-settings-btn');
    if (settingsBtn) {
      settingsBtn.onclick = (e) => { e.stopPropagation(); openSettingsViewer('project', project.projectPath); };
    }
    const archiveGroupBtn = header.querySelector('.project-archive-btn');
    if (archiveGroupBtn) {
      archiveGroupBtn.onclick = async (e) => {
        e.stopPropagation();
        const sessions = project.sessions.filter(s => !s.archived);
        if (sessions.length === 0) return;
        const shortName = project.projectPath.split('/').filter(Boolean).slice(-2).join('/');
        if (!confirm(`Archive all ${sessions.length} session${sessions.length > 1 ? 's' : ''} in ${shortName}?`)) return;
        for (const s of sessions) {
          if (activePtyIds.has(s.sessionId)) {
            await window.api.stopSession(s.sessionId);
          }
          await window.api.archiveSession(s.sessionId, 1);
          s.archived = 1;
        }
        pollActiveSessions();
        loadProjects();
      };
    }
    header.onclick = (e) => {
      if (e.target.closest('.project-new-btn') || e.target.closest('.project-archive-btn') || e.target.closest('.project-settings-btn') || e.target.closest('.project-config-btn')) return;
      header.classList.toggle('collapsed');
    };
  }

  sidebarContent.querySelectorAll('.slug-group-header').forEach(header => {
    const archiveBtn = header.querySelector('.slug-group-archive-btn');
    if (archiveBtn) {
      archiveBtn.onclick = async (e) => {
        e.stopPropagation();
        const group = header.parentElement;
        const sessionItems = group.querySelectorAll('.session-item');
        for (const item of sessionItems) {
          const sid = item.dataset.sessionId;
          const session = sessionMap.get(sid);
          if (!session || session.archived) continue;
          if (activePtyIds.has(sid)) await window.api.stopSession(sid);
          await window.api.archiveSession(sid, 1);
          session.archived = 1;
        }
        pollActiveSessions();
        loadProjects();
      };
    }
    header.onclick = (e) => {
      if (e.target.closest('.slug-group-archive-btn')) return;
      header.parentElement.classList.toggle('collapsed');
      saveExpandedSlugs();
    };
  });

  sidebarContent.querySelectorAll('.slug-group-more').forEach(moreBtn => {
    moreBtn.onclick = () => {
      const group = moreBtn.closest('.slug-group');
      if (group) {
        group.classList.remove('collapsed');
        saveExpandedSlugs();
      }
    };
  });

  sidebarContent.querySelectorAll('.sessions-more-toggle').forEach(moreBtn => {
    const olderList = moreBtn.nextElementSibling;
    if (!olderList || !olderList.classList.contains('sessions-older')) return;
    const count = olderList.children.length;
    moreBtn.onclick = () => {
      const showing = olderList.style.display !== 'none';
      olderList.style.display = showing ? 'none' : '';
      moreBtn.classList.toggle('expanded', !showing);
      moreBtn.textContent = showing ? `+ ${count} older` : '- hide older';
    };
  });

  sidebarContent.querySelectorAll('.session-item').forEach(item => {
    const sessionId = item.dataset.sessionId;
    const session = sessionMap.get(sessionId);
    if (!session) return;

    item.onclick = () => openSession(session);

    const pin = item.querySelector('.session-pin');
    if (pin) {
      pin.onclick = async (e) => {
        e.stopPropagation();
        const { starred } = await window.api.toggleStar(session.sessionId);
        session.starred = starred;
        refreshSidebar({ resort: true });
      };
    }

    const summaryEl = item.querySelector('.session-summary');
    if (summaryEl) {
      summaryEl.ondblclick = (e) => { e.stopPropagation(); startRename(summaryEl, session); };
    }

    const stopBtn = item.querySelector('.session-stop-btn');
    if (stopBtn) {
      stopBtn.onclick = async (e) => {
        e.stopPropagation();
        await window.api.stopSession(session.sessionId);
        activePtyIds.delete(session.sessionId);
        if (activeSessionId === session.sessionId) {
          setActiveSession(null);
          terminalHeader.style.display = 'none';
          placeholder.style.display = '';
        }
        refreshSidebar();
      };
    }

    const forkBtn = item.querySelector('.session-fork-btn');
    if (forkBtn) {
      forkBtn.onclick = async (e) => {
        e.stopPropagation();
        // Find the project for this session
        const project = [...cachedAllProjects, ...cachedProjects].find(p =>
          p.sessions.some(s => s.sessionId === session.sessionId)
        );
        if (project) {
          forkSession(session, project);
        }
      };
    }

    const jsonlBtn = item.querySelector('.session-jsonl-btn');
    if (jsonlBtn) {
      jsonlBtn.onclick = (e) => {
        e.stopPropagation();
        showJsonlViewer(session);
      };
    }

    const archiveBtn = item.querySelector('.session-archive-btn');
    if (archiveBtn) {
      archiveBtn.onclick = async (e) => {
        e.stopPropagation();
        const newVal = session.archived ? 0 : 1;
        if (newVal && activePtyIds.has(session.sessionId)) {
          await window.api.stopSession(session.sessionId);
          pollActiveSessions();
        }
        await window.api.archiveSession(session.sessionId, newVal);
        session.archived = newVal;
        loadProjects();
      };
    }
  });
}

function buildSessionItem(session) {
  const item = document.createElement('div');
  item.className = 'session-item';
  item.id = 'si-' + session.sessionId;
  if (session.type === 'terminal') item.classList.add('is-terminal');
  if (session.archived) item.classList.add('archived-item');
  if (activePtyIds.has(session.sessionId)) item.classList.add('has-running-pty');
  if (unreadSessions.has(session.sessionId)) item.classList.add('has-unread');
  if (attentionSessions.has(session.sessionId)) item.classList.add('needs-attention');
  const progressInfo = sessionProgressState.get(session.sessionId);
  if (progressInfo) {
    if (progressInfo.state === 3) item.classList.add('is-busy');
    if (progressInfo.state === 1) item.classList.add('has-progress');
    if (progressInfo.state === 2) item.classList.add('has-error');
  }
  item.dataset.sessionId = session.sessionId;

  const modified = lastActivityTime.get(session.sessionId) || new Date(session.modified);
  const timeStr = formatDate(modified);
  const displayName = cleanDisplayName(session.name || session.summary);

  const row = document.createElement('div');
  row.className = 'session-row';

  // Pin
  const pin = document.createElement('span');
  pin.className = 'session-pin' + (session.starred ? ' pinned' : '');
  pin.innerHTML = session.starred
    ? '<svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M9.828.722a.5.5 0 0 1 .354.146l4.95 4.95a.5.5 0 0 1-.707.707c-.28-.28-.576-.49-.888-.656L10.073 9.333l-.07 3.181a.5.5 0 0 1-.853.354l-3.535-3.536-4.243 4.243a.5.5 0 1 1-.707-.707l4.243-4.243L1.372 5.11a.5.5 0 0 1 .354-.854l3.18-.07L8.37 .722A3.37 3.37 0 0 1 9.12.074a.5.5 0 0 1 .708.002l-.707.707z"/></svg>'
    : '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2"><path d="M9.828.722a.5.5 0 0 1 .354.146l4.95 4.95a.5.5 0 0 1-.707.707c-.28-.28-.576-.49-.888-.656L10.073 9.333l-.07 3.181a.5.5 0 0 1-.853.354l-3.535-3.536-4.243 4.243a.5.5 0 1 1-.707-.707l4.243-4.243L1.372 5.11a.5.5 0 0 1 .354-.854l3.18-.07L8.37 .722A3.37 3.37 0 0 1 9.12.074a.5.5 0 0 1 .708.002l-.707.707z"/></svg>';

  // Running status dot
  const dot = document.createElement('span');
  dot.className = 'session-status-dot' + (activePtyIds.has(session.sessionId) ? ' running' : '');

  // Info block
  const info = document.createElement('div');
  info.className = 'session-info';

  const summaryEl = document.createElement('div');
  summaryEl.className = 'session-summary';
  summaryEl.textContent = displayName;

  const idEl = document.createElement('div');
  idEl.className = 'session-id';
  idEl.textContent = session.sessionId;

  const metaEl = document.createElement('div');
  metaEl.className = 'session-meta';
  metaEl.textContent = timeStr + (session.messageCount ? ' \u00b7 ' + session.messageCount + ' msgs' : '');

  if (session.type === 'terminal') {
    const badge = document.createElement('span');
    badge.className = 'terminal-badge';
    badge.textContent = '>_';
    summaryEl.prepend(badge);
  }
  info.appendChild(summaryEl);
  info.appendChild(idEl);
  info.appendChild(metaEl);

  // Action buttons container
  const actions = document.createElement('div');
  actions.className = 'session-actions';

  const stopBtn = document.createElement('button');
  stopBtn.className = 'session-stop-btn';
  stopBtn.title = 'Stop session';
  stopBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor"><rect x="2" y="2" width="8" height="8" rx="1"/></svg>';

  const archiveBtn = document.createElement('button');
  archiveBtn.className = 'session-archive-btn';
  archiveBtn.title = session.archived ? 'Unarchive' : 'Archive';
  archiveBtn.innerHTML = session.archived
    ? '<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5"><polyline points="4,7 6,5 8,7"/><line x1="6" y1="5" x2="6" y2="10"/><path d="M1,4 L1,11 L11,11 L11,4"/></svg>'
    : '<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M1,1 L11,1 L11,4 L1,4 Z"/><path d="M1,4 L1,11 L11,11 L11,4"/><line x1="5" y1="6.5" x2="7" y2="6.5"/></svg>';

  const forkBtn = document.createElement('button');
  forkBtn.className = 'session-fork-btn';
  forkBtn.title = 'Fork session';
  forkBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="6" cy="2.5" r="1.5"/><circle cx="3" cy="9.5" r="1.5"/><circle cx="9" cy="9.5" r="1.5"/><line x1="6" y1="4" x2="6" y2="6"/><line x1="6" y1="6" x2="3" y2="8"/><line x1="6" y1="6" x2="9" y2="8"/></svg>';

  const jsonlBtn = document.createElement('button');
  jsonlBtn.className = 'session-jsonl-btn';
  jsonlBtn.title = 'View messages';
  jsonlBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M2 3h8M2 6h6M2 9h4"/></svg>';

  actions.appendChild(stopBtn);
  actions.appendChild(forkBtn);
  actions.appendChild(jsonlBtn);
  actions.appendChild(archiveBtn);

  row.appendChild(pin);
  row.appendChild(dot);
  row.appendChild(info);
  row.appendChild(actions);
  item.appendChild(row);

  return item;
}

function startRename(summaryEl, session) {
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'session-rename-input';
  input.value = session.name || session.summary;

  summaryEl.replaceWith(input);
  input.focus();
  input.select();

  const save = async () => {
    const newName = input.value.trim();
    const nameToSave = (newName && newName !== session.summary) ? newName : null;
    await window.api.renameSession(session.sessionId, nameToSave);
    session.name = nameToSave;

    const newSummary = document.createElement('div');
    newSummary.className = 'session-summary';
    newSummary.textContent = nameToSave || session.summary;
    newSummary.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      startRename(newSummary, session);
    });
    input.replaceWith(newSummary);
  };

  input.addEventListener('blur', save);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') input.blur();
    if (e.key === 'Escape') {
      input.removeEventListener('blur', save);
      const restored = document.createElement('div');
      restored.className = 'session-summary';
      restored.textContent = session.name || session.summary;
      restored.addEventListener('dblclick', (ev) => {
        ev.stopPropagation();
        startRename(restored, session);
      });
      input.replaceWith(restored);
    }
  });
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
  };

  // Track as pending (no .jsonl yet)
  const folder = projectPath.replace(/[/_]/g, '-').replace(/^-/, '-');
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

  // Update sidebar
  document.querySelectorAll('.session-item.active').forEach(el => el.classList.remove('active'));
  const item = document.querySelector(`[data-session-id="${sessionId}"]`);
  if (item) item.classList.add('active');
  document.querySelectorAll('.terminal-container').forEach(el => el.classList.remove('visible'));
  placeholder.style.display = 'none';
  hidePlanViewer();
  setActiveSession(sessionId);
  showTerminalHeader(session);

  // Create terminal
  const container = document.createElement('div');
  container.className = 'terminal-container visible';
  terminalsEl.appendChild(container);

  const terminal = new Terminal({
    fontSize: 12,
    fontFamily: "'SF Mono', 'Fira Code', 'Cascadia Code', Menlo, monospace",
    theme: TERMINAL_THEME,
    cursorBlink: true,
    scrollback: 10000,
    convertEol: true,
    linkHandler: {
      activate: (_event, uri) => {
        if (uri.startsWith('file://') && typeof openFileInPanel === 'function') {
          try { openFileInPanel(sessionId, decodeURIComponent(new URL(uri).pathname)); } catch {}
        } else {
          window.api.openExternal(uri);
        }
      },
      allowNonHttpProtocols: true,
    },
  });

  const fitAddon = new FitAddon.FitAddon();
  terminal.loadAddon(fitAddon);
  terminal.loadAddon(new WebLinksAddon.WebLinksAddon((_event, url) => {
    if (url.startsWith('file://') && typeof openFileInPanel === 'function') {
      try { openFileInPanel(sessionId, decodeURIComponent(new URL(url).pathname)); } catch {}
    } else {
      window.api.openExternal(url);
    }
  }));
  terminal.open(container);
  fitAddon.fit();

  const entry = { terminal, element: container, fitAddon, session, closed: false };
  openSessions.set(sessionId, entry);

  // Wire up terminal input/resize via IPC
  terminal.onData(data => {
    window.api.sendInput(session.sessionId, data);
  });
  setupTerminalKeyBindings(terminal, container, () => session.sessionId);

  terminal.onResize(({ cols, rows }) => {
    window.api.resizeTerminal(session.sessionId, cols, rows);
  });

  terminal.onTitleChange(title => {
    entry.ptyTitle = title;
    if (activeSessionId === session.sessionId) updatePtyTitle();
  });

  terminal.onBell(() => {
    markUnread(session.sessionId, '\x07');
  });

  // Open terminal in main process with session options
  const result = await window.api.openTerminal(sessionId, projectPath, true, sessionOptions || null);
  if (!result.ok) {
    terminal.write(`\r\nError: ${result.error}\r\n`);
    entry.closed = true;
    return;
  }
  if (typeof setSessionMcpActive === 'function') setSessionMcpActive(sessionId, !!result.mcpActive);

  // Send initial resize
  window.api.resizeTerminal(sessionId, terminal.cols, terminal.rows);

  terminal.focus();
  pollActiveSessions();
}

// Legacy alias
function openNewSession(project) {
  return launchNewSession(project);
}

function showTerminalHeader(session) {
  const displayName = cleanDisplayName(session.name || session.summary);
  terminalHeaderName.textContent = displayName;
  terminalHeaderId.textContent = session.sessionId;
  terminalHeader.style.display = '';
  updateTerminalHeader();
  updateProgressIndicators(session.sessionId);
}

async function openSession(session) {
  const { sessionId, projectPath } = session;

  // Update sidebar active state
  document.querySelectorAll('.session-item.active').forEach(el => el.classList.remove('active'));
  const item = document.querySelector(`[data-session-id="${sessionId}"]`);
  if (item) item.classList.add('active');

  // Hide all terminal containers and plan viewer
  document.querySelectorAll('.terminal-container').forEach(el => el.classList.remove('visible'));
  placeholder.style.display = 'none';
  hidePlanViewer();
  setActiveSession(sessionId);
  clearUnread(sessionId);
  attentionSessions.delete(sessionId);
  const attentionItem = document.querySelector(`.session-item[data-session-id="${sessionId}"]`);
  if (attentionItem) attentionItem.classList.remove('needs-attention');
  showTerminalHeader(session);

  if (openSessions.has(sessionId)) {
    const entry = openSessions.get(sessionId);
    if (entry.closed) {
      window.api.closeTerminal(sessionId);
      entry.terminal.dispose();
      entry.element.remove();
      openSessions.delete(sessionId);
      // Terminal sessions re-spawn fresh
      if (session.type === 'terminal') {
        launchTerminalSession({ projectPath: session.projectPath });
        return;
      }
    } else {
      entry.element.classList.add('visible');
      entry.terminal.focus();
      // Defer fit — the container just went from display:none to display:block,
      // so the viewport has no dimensions yet.
      requestAnimationFrame(() => {
        entry.fitAddon.fit();
        if (isAtBottom(entry.terminal)) {
          requestAnimationFrame(() => entry.terminal.scrollToBottom());
        }
      });
      return;
    }
  }

  // Create new terminal
  const container = document.createElement('div');
  container.className = 'terminal-container visible';
  terminalsEl.appendChild(container);

  const terminal = new Terminal({
    fontSize: 12,
    fontFamily: "'SF Mono', 'Fira Code', 'Cascadia Code', Menlo, monospace",
    theme: TERMINAL_THEME,
    cursorBlink: true,
    scrollback: 10000,
    convertEol: true,
    linkHandler: {
      activate: (_event, uri) => {
        if (uri.startsWith('file://') && typeof openFileInPanel === 'function') {
          try { openFileInPanel(sessionId, decodeURIComponent(new URL(uri).pathname)); } catch {}
        } else {
          window.api.openExternal(uri);
        }
      },
      allowNonHttpProtocols: true,
    },
  });

  const fitAddon = new FitAddon.FitAddon();
  terminal.loadAddon(fitAddon);
  terminal.loadAddon(new WebLinksAddon.WebLinksAddon((_event, url) => {
    if (url.startsWith('file://') && typeof openFileInPanel === 'function') {
      try { openFileInPanel(sessionId, decodeURIComponent(new URL(url).pathname)); } catch {}
    } else {
      window.api.openExternal(url);
    }
  }));
  terminal.open(container);
  fitAddon.fit();

  const entry = { terminal, element: container, fitAddon, session, closed: false };
  openSessions.set(sessionId, entry);

  // Wire up terminal input/resize via IPC (use entry.session.sessionId so fork re-keying works)
  terminal.onData(data => {
    window.api.sendInput(entry.session.sessionId, data);
  });
  setupTerminalKeyBindings(terminal, container, () => entry.session.sessionId);

  terminal.onResize(({ cols, rows }) => {
    window.api.resizeTerminal(entry.session.sessionId, cols, rows);
  });

  terminal.onTitleChange(title => {
    entry.ptyTitle = title;
    if (activeSessionId === entry.session.sessionId) updatePtyTitle();
  });

  terminal.onBell(() => {
    markUnread(entry.session.sessionId, '\x07');
  });

  // Open terminal in main process with resolved default settings
  const resumeOptions = await resolveDefaultSessionOptions({ projectPath });
  const result = await window.api.openTerminal(sessionId, projectPath, false, resumeOptions);
  if (!result.ok) {
    terminal.write(`\r\nError: ${result.error}\r\n`);
    entry.closed = true;
    return;
  }
  if (typeof setSessionMcpActive === 'function') setSessionMcpActive(sessionId, !!result.mcpActive);

  // Send initial resize
  window.api.resizeTerminal(sessionId, terminal.cols, terminal.rows);

  terminal.focus();
  pollActiveSessions();
}

// Handle window resize
window.addEventListener('resize', () => {
  if (activeSessionId && openSessions.has(activeSessionId)) {
    const entry = openSessions.get(activeSessionId);
    entry.fitAddon.fit();
  }
});

function cleanDisplayName(name) {
  if (!name) return name;
  const prefix = 'Implement the following plan:';
  if (name.startsWith(prefix)) return name.slice(prefix.length).trim();
  return name;
}

function formatDate(date) {
  const now = new Date();
  const diff = now - date;
  const mins = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);

  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  if (hours < 24) return `${hours}h ago`;
  if (days < 7) return `${days}d ago`;
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// --- Tab switching ---
document.querySelectorAll('.sidebar-tab[data-tab]').forEach(tab => {
  tab.addEventListener('click', () => {
    const tabName = tab.dataset.tab;
    const settingsWasActive = globalSettingsBtn.classList.contains('active');
    if (tabName === activeTab && !settingsWasActive) return;
    activeTab = tabName;
    document.querySelectorAll('.sidebar-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tabName));
    settingsViewer.style.display = 'none';

    // Clear search on tab switch
    searchInput.value = '';
    searchBar.classList.remove('has-query');
    searchMatchIds = null;

    // Hide all sidebar content areas
    sidebarContent.style.display = 'none';
    plansContent.style.display = 'none';
    statsContent.style.display = 'none';
    configContent.style.display = 'none';
    sessionFilters.style.display = 'none';
    searchBar.style.display = 'none';

    if (tabName === 'sessions') {
      sessionFilters.style.display = '';
      searchBar.style.display = '';
      sidebarContent.style.display = '';
      // Restore terminal area if a session is open
      hideAllViewers();
      if (!activeSessionId) {
        placeholder.style.display = '';
      }
      // Catch up on changes that happened while on another tab
      if (projectsChangedWhileAway) {
        projectsChangedWhileAway = false;
        loadProjects();
      }
    } else if (tabName === 'plans') {
      searchBar.style.display = '';
      plansContent.style.display = '';
      loadPlans();
    } else if (tabName === 'stats') {
      statsContent.style.display = '';
      // Immediately show stats viewer in main area
      placeholder.style.display = 'none';
      terminalArea.style.display = 'none';
      planViewer.style.display = 'none';
      configViewer.style.display = 'none';
      settingsViewer.style.display = 'none';
      statsViewer.style.display = 'flex';
      loadStats();
    } else if (tabName === 'config') {
      searchBar.style.display = '';
      configContent.style.display = '';
      currentConfigScope = null;
      loadConfig(null);
    }
  });
});

// --- Plans ---
async function loadPlans() {
  cachedPlans = await window.api.getPlans();
  renderPlans();
}

function renderPlans(plans) {
  plans = plans || cachedPlans;
  plansContent.innerHTML = '';
  if (plans.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'plans-empty';
    empty.textContent = 'No plans found in ~/.claude/plans/';
    plansContent.appendChild(empty);
    return;
  }
  for (const plan of plans) {
    plansContent.appendChild(buildPlanItem(plan));
  }
}

function buildPlanItem(plan) {
  const item = document.createElement('div');
  item.className = 'session-item plan-item';

  const row = document.createElement('div');
  row.className = 'session-row';

  const info = document.createElement('div');
  info.className = 'session-info';

  const titleEl = document.createElement('div');
  titleEl.className = 'session-summary';
  titleEl.textContent = plan.title;

  const filenameEl = document.createElement('div');
  filenameEl.className = 'session-id';
  filenameEl.textContent = plan.filename;

  const metaEl = document.createElement('div');
  metaEl.className = 'session-meta';
  metaEl.textContent = formatDate(new Date(plan.modified));

  info.appendChild(titleEl);
  info.appendChild(filenameEl);
  info.appendChild(metaEl);
  row.appendChild(info);
  item.appendChild(row);

  item.addEventListener('click', () => openPlan(plan));
  return item;
}

async function openPlan(plan) {
  // Mark active in sidebar
  plansContent.querySelectorAll('.plan-item.active').forEach(el => el.classList.remove('active'));
  const items = plansContent.querySelectorAll('.plan-item');
  items.forEach(el => {
    if (el.querySelector('.session-id')?.textContent === plan.filename) {
      el.classList.add('active');
    }
  });

  const result = await window.api.readPlan(plan.filename);
  currentPlanContent = result.content;
  currentPlanFilePath = result.filePath;
  currentPlanFilename = plan.filename;

  // Hide terminal area and placeholder, show plan viewer
  placeholder.style.display = 'none';
  terminalArea.style.display = 'none';
  statsViewer.style.display = 'none';
  configViewer.style.display = 'none';
  settingsViewer.style.display = 'none';
  planViewer.style.display = 'flex';

  planViewerTitle.textContent = plan.title;
  planViewerFilepath.textContent = currentPlanFilePath;

  // Create or update CodeMirror editor
  if (!planEditorView) {
    planEditorView = window.createPlanEditor(planViewerEditorEl);
  }
  planEditorView.dispatch({
    changes: { from: 0, to: planEditorView.state.doc.length, insert: currentPlanContent },
  });
}

// Plan toolbar button handlers
function flashButtonText(btn, text, duration = 1200) {
  const original = btn.textContent;
  btn.textContent = text;
  setTimeout(() => { btn.textContent = original; }, duration);
}

planCopyPathBtn.addEventListener('click', () => {
  navigator.clipboard.writeText(currentPlanFilePath);
  flashButtonText(planCopyPathBtn, 'Copied!');
});

planCopyContentBtn.addEventListener('click', () => {
  const content = planEditorView ? planEditorView.state.doc.toString() : currentPlanContent;
  navigator.clipboard.writeText(content);
  flashButtonText(planCopyContentBtn, 'Copied!');
});

planSaveBtn.addEventListener('click', async () => {
  if (planEditorView) {
    currentPlanContent = planEditorView.state.doc.toString();
  }
  await window.api.savePlan(currentPlanFilePath, currentPlanContent);
  flashButtonText(planSaveBtn, 'Saved!');
});

// --- Config editor buttons ---
configCopyPathBtn.addEventListener('click', () => {
  navigator.clipboard.writeText(currentConfigFilePath);
  flashButtonText(configCopyPathBtn, 'Copied!');
});
configCopyContentBtn.addEventListener('click', () => {
  const content = configEditorView ? configEditorView.state.doc.toString() : '';
  navigator.clipboard.writeText(content);
  flashButtonText(configCopyContentBtn, 'Copied!');
});
configSaveBtn.addEventListener('click', async () => {
  if (!configEditorView) return;
  const content = configEditorView.state.doc.toString();
  await window.api.saveConfig(currentConfigFilePath, content);
  flashButtonText(configSaveBtn, 'Saved!');
});

function hideAllViewers() {
  planViewer.style.display = 'none';
  statsViewer.style.display = 'none';
  configViewer.style.display = 'none';
  settingsViewer.style.display = 'none';
  jsonlViewer.style.display = 'none';
  terminalArea.style.display = '';
}

function hidePlanViewer() {
  hideAllViewers();
}

// --- JSONL Message History Viewer ---
function renderJsonlText(text) {
  let html = escapeHtml(text);
  html = html.replace(/```(\w*)\n([\s\S]*?)```/g, '<pre class="jsonl-code-block"><code>$2</code></pre>');
  html = html.replace(/`([^`]+)`/g, '<code class="jsonl-inline-code">$1</code>');
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  return html;
}

function formatDuration(ms) {
  if (ms < 1000) return ms + 'ms';
  const s = (ms / 1000).toFixed(1);
  return s + 's';
}

function makeCollapsible(className, headerText, bodyContent, startExpanded) {
  const wrapper = document.createElement('div');
  wrapper.className = className;
  const header = document.createElement('div');
  header.className = 'jsonl-toggle' + (startExpanded ? ' expanded' : '');
  header.textContent = headerText;
  const body = document.createElement('pre');
  body.className = 'jsonl-tool-body';
  body.style.display = startExpanded ? '' : 'none';
  if (typeof bodyContent === 'string') {
    body.textContent = bodyContent;
  } else {
    try { body.textContent = JSON.stringify(bodyContent, null, 2); } catch { body.textContent = String(bodyContent); }
  }
  header.onclick = () => {
    const showing = body.style.display !== 'none';
    body.style.display = showing ? 'none' : '';
    header.classList.toggle('expanded', !showing);
  };
  wrapper.appendChild(header);
  wrapper.appendChild(body);
  return wrapper;
}

function renderJsonlEntry(entry) {
  const ts = entry.timestamp;
  const timeStr = ts ? new Date(ts).toLocaleTimeString() : '';

  // --- custom-title ---
  if (entry.type === 'custom-title') {
    const div = document.createElement('div');
    div.className = 'jsonl-entry jsonl-meta-entry';
    div.innerHTML = '<span class="jsonl-meta-icon">T</span> Title set: <strong>' + escapeHtml(entry.customTitle || '') + '</strong>';
    return div;
  }

  // --- system entries ---
  if (entry.type === 'system') {
    const div = document.createElement('div');
    div.className = 'jsonl-entry jsonl-meta-entry';
    if (entry.subtype === 'turn_duration') {
      div.innerHTML = '<span class="jsonl-meta-icon">&#9201;</span> Turn duration: <strong>' + formatDuration(entry.durationMs) + '</strong>'
        + (timeStr ? ' <span class="jsonl-ts">' + timeStr + '</span>' : '');
    } else if (entry.subtype === 'local_command') {
      const cmdMatch = (entry.content || '').match(/<command-name>(.*?)<\/command-name>/);
      const cmd = cmdMatch ? cmdMatch[1] : entry.content || 'unknown';
      div.innerHTML = '<span class="jsonl-meta-icon">$</span> Command: <code class="jsonl-inline-code">' + escapeHtml(cmd) + '</code>'
        + (timeStr ? ' <span class="jsonl-ts">' + timeStr + '</span>' : '');
    } else {
      return null;
    }
    return div;
  }

  // --- progress entries ---
  if (entry.type === 'progress') {
    const data = entry.data;
    if (!data || typeof data !== 'object') return null;
    const dt = data.type;
    if (dt === 'bash_progress') {
      const div = document.createElement('div');
      div.className = 'jsonl-entry jsonl-meta-entry';
      const elapsed = data.elapsedTimeSeconds ? ` (${data.elapsedTimeSeconds}s, ${data.totalLines || 0} lines)` : '';
      div.innerHTML = '<span class="jsonl-meta-icon">&#9658;</span> Bash output' + escapeHtml(elapsed);
      if (data.output || data.fullOutput) {
        const output = data.fullOutput || data.output || '';
        div.appendChild(makeCollapsible('jsonl-tool-result', 'Output', output, false));
      }
      return div;
    }
    // Skip noisy progress types
    return null;
  }

  // --- user / assistant messages ---
  let role = null;
  let contentBlocks = null;

  if (entry.type === 'user' || (entry.type === 'message' && entry.role === 'user')) {
    role = 'user';
    contentBlocks = entry.message?.content || entry.content;
  } else if (entry.type === 'assistant' || (entry.type === 'message' && entry.role === 'assistant')) {
    role = 'assistant';
    contentBlocks = entry.message?.content || entry.content;
  } else {
    return null;
  }

  if (!contentBlocks) return null;
  if (typeof contentBlocks === 'string') {
    contentBlocks = [{ type: 'text', text: contentBlocks }];
  }
  if (!Array.isArray(contentBlocks)) return null;

  const div = document.createElement('div');
  div.className = 'jsonl-entry ' + (role === 'user' ? 'jsonl-user' : 'jsonl-assistant');

  const labelRow = document.createElement('div');
  labelRow.className = 'jsonl-role-label';
  labelRow.textContent = role === 'user' ? 'User' : 'Assistant';
  if (timeStr) {
    const tsSpan = document.createElement('span');
    tsSpan.className = 'jsonl-ts';
    tsSpan.textContent = timeStr;
    labelRow.appendChild(tsSpan);
  }
  div.appendChild(labelRow);

  for (const block of contentBlocks) {
    if (block.type === 'thinking' && block.thinking) {
      div.appendChild(makeCollapsible('jsonl-thinking', 'Thinking', block.thinking, false));
    } else if (block.type === 'text' && block.text) {
      const textEl = document.createElement('div');
      textEl.className = 'jsonl-text';
      textEl.innerHTML = renderJsonlText(block.text);
      div.appendChild(textEl);
    } else if (block.type === 'tool_use') {
      div.appendChild(makeCollapsible('jsonl-tool-call',
        'Tool: ' + (block.name || 'unknown'),
        typeof block.input === 'string' ? block.input : block.input,
        false));
    } else if (block.type === 'tool_result') {
      const resultContent = block.content || block.output || '';
      div.appendChild(makeCollapsible('jsonl-tool-result',
        'Tool Result' + (block.tool_use_id ? ' (' + block.tool_use_id.slice(0, 12) + '...)' : ''),
        resultContent,
        false));
    }
  }

  return div;
}

async function showJsonlViewer(session) {
  const result = await window.api.readSessionJsonl(session.sessionId);
  hideAllViewers();
  placeholder.style.display = 'none';
  terminalArea.style.display = 'none';
  jsonlViewer.style.display = 'flex';

  const displayName = session.name || session.summary || session.sessionId;
  jsonlViewerTitle.textContent = displayName;
  jsonlViewerSessionId.textContent = session.sessionId;
  jsonlViewerBody.innerHTML = '';

  if (result.error) {
    jsonlViewerBody.innerHTML = '<div class="plans-empty">Error loading messages: ' + escapeHtml(result.error) + '</div>';
    return;
  }

  const entries = result.entries || [];
  let rendered = 0;
  for (const entry of entries) {
    const el = renderJsonlEntry(entry);
    if (el) {
      jsonlViewerBody.appendChild(el);
      rendered++;
    }
  }

  if (rendered === 0) {
    jsonlViewerBody.innerHTML = '<div class="plans-empty">No messages found in this session.</div>';
  }
}

// --- Stats ---
async function loadStats() {
  const stats = await window.api.getStats();
  statsViewerBody.innerHTML = '';
  if (!stats) {
    statsViewerBody.innerHTML = '<div class="plans-empty">No stats data found. Run some Claude sessions first.</div>';
    return;
  }
  // dailyActivity may be an array of {date, messageCount, ...} or an object
  const rawDaily = stats.dailyActivity || {};
  let dailyMap = {};
  if (Array.isArray(rawDaily)) {
    for (const entry of rawDaily) {
      dailyMap[entry.date] = entry.messageCount || 0;
    }
  } else {
    for (const [date, data] of Object.entries(rawDaily)) {
      dailyMap[date] = typeof data === 'number' ? data : (data?.messageCount || data?.messages || data?.count || 0);
    }
  }
  buildHeatmap(dailyMap);
  buildDailyBarChart(stats);
  buildStatsSummary(stats, dailyMap);

  const notice = document.createElement('div');
  notice.className = 'stats-notice';
  const lastDate = stats.lastComputedDate || 'unknown';
  notice.innerHTML = `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" style="vertical-align:-2px;margin-right:6px;flex-shrink:0"><circle cx="8" cy="8" r="7"/><line x1="8" y1="5" x2="8" y2="9"/><circle cx="8" cy="11.5" r="0.5" fill="currentColor" stroke="none"/></svg>Data sourced from Claude\u2019s stats cache (last updated ${escapeHtml(lastDate)}). Run <code>/stats</code> in a Claude session to refresh.`;
  statsViewerBody.appendChild(notice);
}

function buildDailyBarChart(stats) {
  const rawTokens = stats.dailyModelTokens || [];
  const rawActivity = stats.dailyActivity || [];

  // Build maps for last 30 days
  const tokenMap = {};
  if (Array.isArray(rawTokens)) {
    for (const entry of rawTokens) {
      let total = 0;
      for (const count of Object.values(entry.tokensByModel || {})) total += count;
      tokenMap[entry.date] = total;
    }
  }
  const activityMap = {};
  if (Array.isArray(rawActivity)) {
    for (const entry of rawActivity) activityMap[entry.date] = entry;
  }

  // Generate last 30 days
  const days = [];
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  for (let i = 29; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    days.push(d.toISOString().slice(0, 10));
  }

  const tokenValues = days.map(d => tokenMap[d] || 0);
  const msgValues = days.map(d => activityMap[d]?.messageCount || 0);
  const toolValues = days.map(d => activityMap[d]?.toolCallCount || 0);
  const maxTokens = Math.max(...tokenValues, 1);
  const maxMsgs = Math.max(...msgValues, 1);

  const container = document.createElement('div');
  container.className = 'daily-chart-container';

  const title = document.createElement('div');
  title.className = 'daily-chart-title';
  title.textContent = 'Last 30 days';
  container.appendChild(title);

  const chart = document.createElement('div');
  chart.className = 'daily-chart';

  for (let i = 0; i < days.length; i++) {
    const col = document.createElement('div');
    col.className = 'daily-chart-col';

    const bar = document.createElement('div');
    bar.className = 'daily-chart-bar';
    const pct = (tokenValues[i] / maxTokens) * 100;
    bar.style.height = Math.max(pct, tokenValues[i] > 0 ? 3 : 0) + '%';

    const msgPct = (msgValues[i] / maxMsgs) * 100;
    const msgBar = document.createElement('div');
    msgBar.className = 'daily-chart-bar-msgs';
    msgBar.style.height = Math.max(msgPct, msgValues[i] > 0 ? 3 : 0) + '%';

    const d = new Date(days[i]);
    const dayLabel = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    let tokStr;
    if (tokenValues[i] >= 1e6) tokStr = (tokenValues[i] / 1e6).toFixed(1) + 'M';
    else if (tokenValues[i] >= 1e3) tokStr = (tokenValues[i] / 1e3).toFixed(1) + 'K';
    else tokStr = tokenValues[i].toString();
    col.title = `${dayLabel}\n${tokStr} tokens\n${msgValues[i]} messages\n${toolValues[i]} tool calls`;

    const label = document.createElement('div');
    label.className = 'daily-chart-label';
    label.textContent = d.getDate().toString();

    col.appendChild(bar);
    col.appendChild(msgBar);
    col.appendChild(label);
    chart.appendChild(col);
  }

  container.appendChild(chart);

  // Legend
  const legend = document.createElement('div');
  legend.className = 'daily-chart-legend';
  legend.innerHTML = '<span class="daily-chart-legend-dot tokens"></span> Tokens <span class="daily-chart-legend-dot msgs"></span> Messages';
  container.appendChild(legend);

  statsViewerBody.appendChild(container);
}

function buildHeatmap(counts) {
  const container = document.createElement('div');
  container.className = 'heatmap-container';

  // Generate 52 weeks of dates ending today
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const dayOfWeek = today.getDay(); // 0=Sun
  const endDate = new Date(today);
  const startDate = new Date(today);
  startDate.setDate(startDate.getDate() - (52 * 7 + dayOfWeek));

  // Month labels
  const monthLabels = document.createElement('div');
  monthLabels.className = 'heatmap-month-labels';
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  let lastMonth = -1;
  const weekStarts = [];
  const d = new Date(startDate);
  while (d <= endDate) {
    if (d.getDay() === 0) {
      weekStarts.push(new Date(d));
    }
    d.setDate(d.getDate() + 1);
  }

  // Calculate month label positions
  const colWidth = 16; // 13px cell + 3px gap
  for (let w = 0; w < weekStarts.length; w++) {
    const m = weekStarts[w].getMonth();
    if (m !== lastMonth) {
      const label = document.createElement('span');
      label.className = 'heatmap-month-label';
      label.textContent = months[m];
      label.style.position = 'absolute';
      label.style.left = (w * colWidth) + 'px';
      monthLabels.appendChild(label);
      lastMonth = m;
    }
  }
  monthLabels.style.position = 'relative';
  monthLabels.style.height = '16px';
  container.appendChild(monthLabels);

  // Grid wrapper (day labels + grid)
  const wrapper = document.createElement('div');
  wrapper.className = 'heatmap-grid-wrapper';

  // Day labels
  const dayLabels = document.createElement('div');
  dayLabels.className = 'heatmap-day-labels';
  const dayNames = ['', 'Mon', '', 'Wed', '', 'Fri', ''];
  for (const name of dayNames) {
    const label = document.createElement('div');
    label.className = 'heatmap-day-label';
    label.textContent = name;
    dayLabels.appendChild(label);
  }
  wrapper.appendChild(dayLabels);

  // Quartile thresholds
  const nonZero = Object.values(counts).filter(c => c > 0).sort((a, b) => a - b);
  const q1 = nonZero[Math.floor(nonZero.length * 0.25)] || 1;
  const q2 = nonZero[Math.floor(nonZero.length * 0.5)] || 2;
  const q3 = nonZero[Math.floor(nonZero.length * 0.75)] || 3;

  // Grid
  const grid = document.createElement('div');
  grid.className = 'heatmap-grid';

  const cursor = new Date(startDate);
  while (cursor <= endDate) {
    const dateStr = cursor.toISOString().slice(0, 10);
    const count = counts[dateStr] || 0;
    let level = 0;
    if (count > 0) {
      if (count <= q1) level = 1;
      else if (count <= q2) level = 2;
      else if (count <= q3) level = 3;
      else level = 4;
    }

    const cell = document.createElement('div');
    cell.className = `heatmap-cell heatmap-level-${level}`;
    const displayDate = cursor.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    cell.title = count > 0 ? `${displayDate}: ${count} messages` : `${displayDate}: No activity`;
    grid.appendChild(cell);

    cursor.setDate(cursor.getDate() + 1);
  }

  wrapper.appendChild(grid);
  container.appendChild(wrapper);

  // Legend
  const legend = document.createElement('div');
  legend.className = 'heatmap-legend';
  const lessLabel = document.createElement('span');
  lessLabel.className = 'heatmap-legend-label';
  lessLabel.textContent = 'Less';
  legend.appendChild(lessLabel);
  for (let i = 0; i <= 4; i++) {
    const cell = document.createElement('div');
    cell.className = `heatmap-legend-cell heatmap-level-${i}`;
    legend.appendChild(cell);
  }
  const moreLabel = document.createElement('span');
  moreLabel.className = 'heatmap-legend-label';
  moreLabel.textContent = 'More';
  legend.appendChild(moreLabel);
  container.appendChild(legend);

  statsViewerBody.appendChild(container);
}

function calculateStreak(counts) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  let current = 0;
  let longest = 0;
  let streak = 0;

  const d = new Date(today);
  let started = false;
  for (let i = 0; i < 365; i++) {
    const dateStr = d.toISOString().slice(0, 10);
    const count = counts[dateStr] || 0;
    if (count > 0) {
      streak++;
      started = true;
    } else {
      if (started) {
        if (!current) current = streak;
        if (streak > longest) longest = streak;
        streak = 0;
        if (current) started = false;
      }
    }
    d.setDate(d.getDate() - 1);
  }
  if (streak > longest) longest = streak;
  if (!current && streak > 0) current = streak;

  return { current, longest };
}

function buildStatsSummary(stats, dailyMap) {
  const summaryEl = document.createElement('div');
  summaryEl.className = 'stats-summary';

  const { current: currentStreak, longest: longestStreak } = calculateStreak(dailyMap);

  // Total messages from map
  let totalMessages = 0;
  for (const count of Object.values(dailyMap)) {
    totalMessages += count;
  }
  // Prefer stats.totalMessages if available and larger
  if (stats.totalMessages && stats.totalMessages > totalMessages) {
    totalMessages = stats.totalMessages;
  }

  const totalSessions = stats.totalSessions || Object.keys(dailyMap).length;

  // Model usage — values are objects with token counts, show as cards
  const models = stats.modelUsage || {};

  const cards = [
    { value: totalSessions.toLocaleString(), label: 'Total Sessions' },
    { value: totalMessages.toLocaleString(), label: 'Total Messages' },
    { value: currentStreak + 'd', label: 'Current Streak' },
    { value: longestStreak + 'd', label: 'Longest Streak' },
  ];

  for (const [model, usage] of Object.entries(models)) {
    const shortName = model.replace(/^claude-/, '').replace(/-\d{8}$/, '');
    const tokens = (usage?.inputTokens || 0) + (usage?.outputTokens || 0);
    const label = shortName;
    // Format token count in millions/thousands
    let valueStr;
    if (tokens >= 1e9) valueStr = (tokens / 1e9).toFixed(1) + 'B';
    else if (tokens >= 1e6) valueStr = (tokens / 1e6).toFixed(1) + 'M';
    else if (tokens >= 1e3) valueStr = (tokens / 1e3).toFixed(1) + 'K';
    else valueStr = tokens.toLocaleString();
    cards.push({ value: valueStr, label: label + ' tokens' });
  }

  for (const card of cards) {
    const el = document.createElement('div');
    el.className = 'stat-card';
    el.innerHTML = `<span class="stat-card-value">${escapeHtml(card.value)}</span><span class="stat-card-label">${escapeHtml(card.label)}</span>`;
    summaryEl.appendChild(el);
  }

  statsViewerBody.appendChild(summaryEl);
}

// --- Config (unified memory/skills/agents) ---
async function loadConfig(projectPath) {
  currentConfigScope = projectPath;
  cachedConfigItems = await window.api.getConfig(projectPath);
  renderConfig();
}

function renderConfig(items) {
  items = items || cachedConfigItems;
  configContent.innerHTML = '';

  // Breadcrumb for project scope
  if (currentConfigScope) {
    const breadcrumb = document.createElement('div');
    breadcrumb.className = 'config-breadcrumb';
    const backBtn = document.createElement('button');
    backBtn.className = 'config-back-btn';
    backBtn.textContent = 'Global';
    backBtn.addEventListener('click', () => loadConfig(null));
    breadcrumb.appendChild(backBtn);
    breadcrumb.appendChild(document.createTextNode(' / ' + currentConfigScope.split('/').filter(Boolean).slice(-2).join('/')));
    configContent.appendChild(breadcrumb);
  }

  if (items.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'plans-empty';
    empty.textContent = currentConfigScope ? 'No config files found for this project.' : 'No config files found.';
    configContent.appendChild(empty);
    return;
  }

  // Group by category
  const groups = {};
  const categoryOrder = ['memory', 'command', 'skill', 'agent'];
  const categoryLabels = { memory: 'Memory', command: 'Commands', skill: 'Skills', agent: 'Agents' };
  for (const item of items) {
    (groups[item.category] = groups[item.category] || []).push(item);
  }

  for (const cat of categoryOrder) {
    if (!groups[cat]) continue;
    const header = document.createElement('div');
    header.className = 'config-group-header';
    header.textContent = categoryLabels[cat] || cat;
    configContent.appendChild(header);
    for (const item of groups[cat]) {
      configContent.appendChild(buildConfigItem(item));
    }
  }
}

function buildConfigItem(item) {
  const el = document.createElement('div');
  el.className = 'session-item config-item';
  el.dataset.filePath = item.filePath;

  const row = document.createElement('div');
  row.className = 'session-row';

  const info = document.createElement('div');
  info.className = 'session-info';

  const titleEl = document.createElement('div');
  titleEl.className = 'session-summary';

  const badge = document.createElement('span');
  badge.className = `config-type-badge type-${item.badge}`;
  badge.textContent = item.badge;
  titleEl.appendChild(badge);
  titleEl.appendChild(document.createTextNode(item.label));

  const filenameEl = document.createElement('div');
  filenameEl.className = 'session-id';
  filenameEl.textContent = item.filename;

  const metaEl = document.createElement('div');
  metaEl.className = 'session-meta';
  metaEl.textContent = formatDate(new Date(item.modified));

  info.appendChild(titleEl);
  info.appendChild(filenameEl);
  info.appendChild(metaEl);
  row.appendChild(info);
  el.appendChild(row);

  el.addEventListener('click', () => openConfig(item));
  return el;
}

async function openConfig(item) {
  configContent.querySelectorAll('.config-item.active').forEach(el => el.classList.remove('active'));
  const target = configContent.querySelector(`.config-item[data-file-path="${CSS.escape(item.filePath)}"]`);
  if (target) target.classList.add('active');

  const content = await window.api.readConfig(item.filePath);
  currentConfigFilePath = item.filePath;

  placeholder.style.display = 'none';
  terminalArea.style.display = 'none';
  planViewer.style.display = 'none';
  statsViewer.style.display = 'none';
  settingsViewer.style.display = 'none';
  configViewer.style.display = 'flex';

  configViewerTitle.textContent = item.label;
  configViewerFilepath.textContent = item.filePath;

  if (!configEditorView) {
    configEditorView = window.createPlanEditor(configViewerEditorEl);
  }
  configEditorView.dispatch({
    changes: { from: 0, to: configEditorView.state.doc.length, insert: content },
  });
}

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

function showNewSessionPopover(project, anchorEl) {
  // Remove any existing popover
  document.querySelectorAll('.new-session-popover').forEach(el => el.remove());

  const popover = document.createElement('div');
  popover.className = 'new-session-popover';

  const claudeBtn = document.createElement('button');
  claudeBtn.className = 'popover-option';
  claudeBtn.innerHTML = '<img src="https://claude.ai/favicon.ico" class="popover-option-icon claude-icon" alt=""> Claude';
  claudeBtn.onclick = async () => { popover.remove(); launchNewSession(project, await resolveDefaultSessionOptions(project)); };

  const claudeOptsBtn = document.createElement('button');
  claudeOptsBtn.className = 'popover-option';
  claudeOptsBtn.innerHTML = '<img src="https://claude.ai/favicon.ico" class="popover-option-icon claude-icon" alt=""> Claude (Configure...)';
  claudeOptsBtn.onclick = () => { popover.remove(); showNewSessionDialog(project); };

  const termBtn = document.createElement('button');
  termBtn.className = 'popover-option popover-option-terminal';
  termBtn.innerHTML = '<span class="popover-option-icon terminal-icon">&gt;_</span> Terminal';
  termBtn.onclick = () => { popover.remove(); launchTerminalSession(project); };

  popover.appendChild(claudeBtn);
  popover.appendChild(claudeOptsBtn);
  popover.appendChild(termBtn);

  // Position relative to anchor, flip upward if it would overflow
  document.body.appendChild(popover);
  const rect = anchorEl.getBoundingClientRect();
  const popoverHeight = popover.offsetHeight;
  if (rect.bottom + 4 + popoverHeight > window.innerHeight) {
    popover.style.top = (rect.top - popoverHeight - 4) + 'px';
  } else {
    popover.style.top = (rect.bottom + 4) + 'px';
  }
  popover.style.left = rect.left + 'px';

  // Close on click outside
  function onClickOutside(e) {
    if (!popover.contains(e.target) && e.target !== anchorEl) {
      popover.remove();
      document.removeEventListener('mousedown', onClickOutside);
    }
  }
  setTimeout(() => document.addEventListener('mousedown', onClickOutside), 0);
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
  const folder = projectPath.replace(/[/_]/g, '-').replace(/^-/, '-');
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

  // Update sidebar
  document.querySelectorAll('.session-item.active').forEach(el => el.classList.remove('active'));
  const item = document.querySelector(`[data-session-id="${sessionId}"]`);
  if (item) item.classList.add('active');
  document.querySelectorAll('.terminal-container').forEach(el => el.classList.remove('visible'));
  placeholder.style.display = 'none';
  hidePlanViewer();
  setActiveSession(sessionId);
  showTerminalHeader(session);

  // Create terminal
  const container = document.createElement('div');
  container.className = 'terminal-container visible';
  terminalsEl.appendChild(container);

  const terminal = new Terminal({
    fontSize: 12,
    fontFamily: "'SF Mono', 'Fira Code', 'Cascadia Code', Menlo, monospace",
    theme: TERMINAL_THEME,
    cursorBlink: true,
    scrollback: 10000,
    convertEol: true,
    linkHandler: {
      activate: (_event, uri) => {
        if (uri.startsWith('file://') && typeof openFileInPanel === 'function') {
          try { openFileInPanel(sessionId, decodeURIComponent(new URL(uri).pathname)); } catch {}
        } else {
          window.api.openExternal(uri);
        }
      },
      allowNonHttpProtocols: true,
    },
  });

  const fitAddon = new FitAddon.FitAddon();
  terminal.loadAddon(fitAddon);
  terminal.loadAddon(new WebLinksAddon.WebLinksAddon((_event, url) => {
    if (url.startsWith('file://') && typeof openFileInPanel === 'function') {
      try { openFileInPanel(sessionId, decodeURIComponent(new URL(url).pathname)); } catch {}
    } else {
      window.api.openExternal(url);
    }
  }));
  terminal.open(container);
  fitAddon.fit();

  const entry = { terminal, element: container, fitAddon, session, closed: false };
  openSessions.set(sessionId, entry);

  terminal.onData(data => {
    window.api.sendInput(session.sessionId, data);
  });
  setupTerminalKeyBindings(terminal, container, () => session.sessionId);

  terminal.onResize(({ cols, rows }) => {
    window.api.resizeTerminal(session.sessionId, cols, rows);
  });

  terminal.onTitleChange(title => {
    entry.ptyTitle = title;
    if (activeSessionId === session.sessionId) updatePtyTitle();
  });

  terminal.onBell(() => {
    markUnread(session.sessionId, '\x07');
  });

  const result = await window.api.openTerminal(sessionId, projectPath, true, { type: 'terminal' });
  if (!result.ok) {
    terminal.write(`\r\nError: ${result.error}\r\n`);
    entry.closed = true;
    return;
  }
  window.api.resizeTerminal(sessionId, terminal.cols, terminal.rows);
  terminal.focus();
  pollActiveSessions();
}

async function showNewSessionDialog(project) {
  const effective = await window.api.getEffectiveSettings(project.projectPath);

  const overlay = document.createElement('div');
  overlay.className = 'new-session-overlay';

  const dialog = document.createElement('div');
  dialog.className = 'new-session-dialog';

  let selectedMode = effective.permissionMode || null;
  let dangerousSkip = effective.dangerouslySkipPermissions || false;

  const modes = [
    { value: null, label: 'Default', desc: 'Prompt for all actions' },
    { value: 'acceptEdits', label: 'Accept Edits', desc: 'Auto-accept file edits, prompt for others' },
    { value: 'plan', label: 'Plan Mode', desc: 'Read-only exploration, no writes' },
    { value: 'dontAsk', label: "Don't Ask", desc: 'Auto-deny tools not explicitly allowed' },
    { value: 'bypassPermissions', label: 'Bypass', desc: 'Auto-accept all tool calls' },
  ];

  function renderModeGrid() {
    return modes.map(m => {
      const isSelected = !dangerousSkip && selectedMode === m.value;
      return `<button class="permission-option${isSelected ? ' selected' : ''}" data-mode="${m.value}"><span class="perm-name">${m.label}</span><span class="perm-desc">${m.desc}</span></button>`;
    }).join('') +
    `<button class="permission-option dangerous${dangerousSkip ? ' selected' : ''}" data-mode="dangerous-skip"><span class="perm-name">Dangerous Skip</span><span class="perm-desc">Skip all safety prompts (use with caution)</span></button>`;
  }

  dialog.innerHTML = `
    <h3>New Session — ${escapeHtml(project.projectPath.split('/').filter(Boolean).slice(-2).join('/'))}</h3>
    <div class="settings-field">
      <div class="settings-label">Permission Mode</div>
      <div class="permission-grid" id="nsd-mode-grid">${renderModeGrid()}</div>
    </div>
    <div class="settings-field">
      <div class="settings-checkbox-row">
        <input type="checkbox" id="nsd-worktree" ${effective.worktree ? 'checked' : ''}>
        <label for="nsd-worktree">Worktree</label>
        <input type="text" class="settings-input" id="nsd-worktree-name" placeholder="name (optional)" value="${escapeHtml(effective.worktreeName || '')}" style="width:160px;margin-left:8px;">
      </div>
    </div>
    <div class="settings-field">
      <div class="settings-checkbox-row">
        <input type="checkbox" id="nsd-chrome" ${effective.chrome ? 'checked' : ''}>
        <label for="nsd-chrome">Chrome</label>
      </div>
    </div>
    <div class="settings-field">
      <div class="settings-label">Pre-launch Command</div>
      <input type="text" class="settings-input" id="nsd-pre-launch" placeholder="e.g. aws-vault exec profile --" value="${escapeHtml(effective.preLaunchCmd || '')}">
    </div>
    <div class="settings-field">
      <div class="settings-label">Add Directories (comma-separated)</div>
      <input type="text" class="settings-input" id="nsd-add-dirs" placeholder="/path/to/dir1, /path/to/dir2" value="${escapeHtml(effective.addDirs || '')}">
    </div>
    <div class="new-session-actions">
      <button class="new-session-cancel-btn">Cancel</button>
      <button class="new-session-start-btn">Start</button>
    </div>
  `;

  overlay.appendChild(dialog);
  document.body.appendChild(overlay);

  // Bind mode grid clicks
  const modeGrid = dialog.querySelector('#nsd-mode-grid');
  modeGrid.addEventListener('click', (e) => {
    const btn = e.target.closest('.permission-option');
    if (!btn) return;
    const mode = btn.dataset.mode;
    if (mode === 'dangerous-skip') {
      dangerousSkip = !dangerousSkip;
      if (dangerousSkip) selectedMode = null;
    } else {
      dangerousSkip = false;
      selectedMode = mode === 'null' ? null : mode;
    }
    modeGrid.innerHTML = renderModeGrid();
  });

  function close() {
    overlay.remove();
  }

  function start() {
    const options = {};
    if (dangerousSkip) {
      options.dangerouslySkipPermissions = true;
    } else if (selectedMode) {
      options.permissionMode = selectedMode;
    }
    if (dialog.querySelector('#nsd-worktree').checked) {
      options.worktree = true;
      options.worktreeName = dialog.querySelector('#nsd-worktree-name').value.trim();
    }
    if (dialog.querySelector('#nsd-chrome').checked) {
      options.chrome = true;
    }
    const preLaunch = dialog.querySelector('#nsd-pre-launch').value.trim();
    if (preLaunch) options.preLaunchCmd = preLaunch;
    options.addDirs = dialog.querySelector('#nsd-add-dirs').value.trim();
    close();
    launchNewSession(project, options);
  }

  dialog.querySelector('.new-session-cancel-btn').onclick = close;
  dialog.querySelector('.new-session-start-btn').onclick = start;
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

  // Keyboard support
  function onKey(e) {
    if (e.key === 'Escape') { close(); document.removeEventListener('keydown', onKey); }
    if (e.key === 'Enter' && !e.target.matches('input')) { start(); document.removeEventListener('keydown', onKey); }
  }
  document.addEventListener('keydown', onKey);
}

// --- Settings viewer ---
async function openSettingsViewer(scope, projectPath) {
  const isProject = scope === 'project';
  const settingsKey = isProject ? 'project:' + projectPath : 'global';
  const current = (await window.api.getSetting(settingsKey)) || {};
  const globalSettings = isProject ? ((await window.api.getSetting('global')) || {}) : {};

  const shortName = isProject
    ? projectPath.split('/').filter(Boolean).slice(-2).join('/')
    : 'Global';

  settingsViewerTitle.textContent = (isProject ? 'Project Settings — ' : 'Global Settings — ') + shortName;

  // Show settings viewer
  placeholder.style.display = 'none';
  terminalArea.style.display = 'none';
  planViewer.style.display = 'none';
  statsViewer.style.display = 'none';
  configViewer.style.display = 'none';
  settingsViewer.style.display = 'flex';

  function useGlobalCheckbox(fieldName, label) {
    if (!isProject) return '';
    const useGlobal = current[fieldName] === undefined || current[fieldName] === null;
    return `<label class="settings-use-global"><input type="checkbox" data-field="${fieldName}" class="use-global-cb" ${useGlobal ? 'checked' : ''}> Use global default</label>`;
  }

  function fieldValue(fieldName, fallback) {
    if (isProject && (current[fieldName] === undefined || current[fieldName] === null)) {
      return globalSettings[fieldName] !== undefined ? globalSettings[fieldName] : fallback;
    }
    return current[fieldName] !== undefined ? current[fieldName] : fallback;
  }

  function fieldDisabled(fieldName) {
    if (!isProject) return '';
    return (current[fieldName] === undefined || current[fieldName] === null) ? 'disabled' : '';
  }

  const permModeValue = fieldValue('permissionMode', '');
  const worktreeValue = fieldValue('worktree', false);
  const worktreeNameValue = fieldValue('worktreeName', '');
  const chromeValue = fieldValue('chrome', false);
  const preLaunchValue = fieldValue('preLaunchCmd', '');
  const addDirsValue = fieldValue('addDirs', '');
  const visCountValue = fieldValue('visibleSessionCount', 10);
  const maxAgeValue = fieldValue('sessionMaxAgeDays', 3);
  const themeValue = fieldValue('terminalTheme', 'switchboard');
  const mcpEmulationValue = fieldValue('mcpEmulation', true);

  settingsViewerBody.innerHTML = `
    <div class="settings-form">
      <div class="settings-section">
        <div class="settings-section-title">Claude CLI Options</div>
        <div class="settings-hint">These options are passed to the <code>claude</code> command when launching sessions.</div>

        <div class="settings-field">
          <div class="settings-field-header">
            <span class="settings-label">Permission Mode</span>
            ${useGlobalCheckbox('permissionMode')}
          </div>
          <select class="settings-select" id="sv-perm-mode" ${fieldDisabled('permissionMode')}>
            <option value="">Default (none)</option>
            <option value="acceptEdits" ${permModeValue === 'acceptEdits' ? 'selected' : ''}>Accept Edits</option>
            <option value="plan" ${permModeValue === 'plan' ? 'selected' : ''}>Plan Mode</option>
            <option value="dontAsk" ${permModeValue === 'dontAsk' ? 'selected' : ''}>Don't Ask</option>
            <option value="bypassPermissions" ${permModeValue === 'bypassPermissions' ? 'selected' : ''}>Bypass</option>
          </select>
        </div>

        <div class="settings-field">
          <div class="settings-field-header">
            <span class="settings-label">Worktree</span>
            ${useGlobalCheckbox('worktree')}
          </div>
          <div class="settings-checkbox-row">
            <input type="checkbox" id="sv-worktree" ${worktreeValue ? 'checked' : ''} ${fieldDisabled('worktree')}>
            <label for="sv-worktree">Enable worktree for new sessions</label>
          </div>
        </div>

        <div class="settings-field">
          <div class="settings-field-header">
            <span class="settings-label">Worktree Name</span>
            ${useGlobalCheckbox('worktreeName')}
          </div>
          <input type="text" class="settings-input" id="sv-worktree-name" placeholder="auto" value="${escapeHtml(worktreeNameValue)}" ${fieldDisabled('worktreeName')}>
        </div>

        <div class="settings-field">
          <div class="settings-field-header">
            <span class="settings-label">Chrome</span>
            ${useGlobalCheckbox('chrome')}
          </div>
          <div class="settings-checkbox-row">
            <input type="checkbox" id="sv-chrome" ${chromeValue ? 'checked' : ''} ${fieldDisabled('chrome')}>
            <label for="sv-chrome">Enable Chrome browser automation</label>
          </div>
        </div>

        <div class="settings-field">
          <div class="settings-field-header">
            <span class="settings-label">Additional Directories</span>
            ${useGlobalCheckbox('addDirs')}
          </div>
          <input type="text" class="settings-input" id="sv-add-dirs" placeholder="/path/to/dir1, /path/to/dir2" value="${escapeHtml(addDirsValue)}" ${fieldDisabled('addDirs')}>
        </div>
      </div>

      <div class="settings-section">
        <div class="settings-section-title">Session Launch</div>
        <div class="settings-hint">Options that control how sessions are started.</div>

        <div class="settings-field">
          <div class="settings-field-header">
            <span class="settings-label">Pre-launch Command</span>
            ${useGlobalCheckbox('preLaunchCmd')}
          </div>
          <div class="settings-hint">Prepended to the claude command (e.g. "aws-vault exec profile --" or "source .env &&")</div>
          <input type="text" class="settings-input" id="sv-pre-launch" placeholder="e.g. aws-vault exec profile --" value="${escapeHtml(preLaunchValue)}" ${fieldDisabled('preLaunchCmd')}>
        </div>
      </div>

      <div class="settings-section">
        <div class="settings-section-title">Application</div>
        <div class="settings-hint">Switchboard display and appearance settings.</div>

        ${!isProject ? `<div class="settings-field">
          <div class="settings-field-header">
            <span class="settings-label">Terminal Theme</span>
          </div>
          <select class="settings-select" id="sv-terminal-theme">
            ${Object.entries(TERMINAL_THEMES).map(([key, t]) =>
              `<option value="${key}" ${themeValue === key ? 'selected' : ''}>${escapeHtml(t.label)}</option>`
            ).join('')}
          </select>
        </div>` : ''}

        <div class="settings-field">
          <div class="settings-field-header">
            <span class="settings-label">Max Visible Sessions</span>
            ${useGlobalCheckbox('visibleSessionCount')}
          </div>
          <div class="settings-hint">Show up to this many sessions before collapsing the rest behind "+N older"</div>
          <input type="number" class="settings-input" id="sv-visible-count" min="1" max="100" value="${visCountValue}" ${fieldDisabled('visibleSessionCount')}>
        </div>

        ${!isProject ? `<div class="settings-field">
          <div class="settings-field-header">
            <span class="settings-label">Hide Sessions Older Than (days)</span>
          </div>
          <div class="settings-hint">Sessions older than this are hidden behind "+N older" even if under the count limit</div>
          <input type="number" class="settings-input" id="sv-max-age" min="1" max="365" value="${maxAgeValue}">
        </div>` : ''}

        ${!isProject ? `<div class="settings-field">
          <div class="settings-field-header">
            <span class="settings-label">IDE Emulation</span>
          </div>
          <div class="settings-checkbox-row">
            <input type="checkbox" id="sv-mcp-emulation" ${mcpEmulationValue ? 'checked' : ''}>
            <label for="sv-mcp-emulation">Emulate an IDE for Claude CLI sessions</label>
          </div>
          <div class="settings-hint">When enabled, Switchboard acts as an IDE so Claude can open files and diffs in a side panel. Disable this if you want Claude to use your own IDE (e.g. VS Code, Cursor) instead. Changes take effect for new sessions only — running sessions are not affected.</div>
        </div>` : ''}
      </div>

      <button class="settings-save-btn" id="sv-save-btn">Save Settings</button>
      ${isProject ? '<button class="settings-remove-btn" id="sv-remove-btn">Remove Project</button>' : ''}
    </div>
  `;

  // Use-global checkboxes toggle field disabled state
  settingsViewerBody.querySelectorAll('.use-global-cb').forEach(cb => {
    cb.addEventListener('change', () => {
      const field = cb.dataset.field;
      const inputs = settingsViewerBody.querySelectorAll(`#sv-perm-mode, #sv-worktree, #sv-worktree-name, #sv-add-dirs, #sv-visible-count`);
      // Map field name to input element
      const fieldMap = {
        permissionMode: 'sv-perm-mode',
        worktree: 'sv-worktree',
        worktreeName: 'sv-worktree-name',
        chrome: 'sv-chrome',
        preLaunchCmd: 'sv-pre-launch',
        addDirs: 'sv-add-dirs',
        visibleSessionCount: 'sv-visible-count',
      };
      const input = settingsViewerBody.querySelector('#' + fieldMap[field]);
      if (input) input.disabled = cb.checked;
    });
  });

  // Save button
  settingsViewerBody.querySelector('#sv-save-btn').addEventListener('click', async () => {
    const settings = {};

    if (isProject) {
      // Only save fields where "use global" is unchecked
      settingsViewerBody.querySelectorAll('.use-global-cb').forEach(cb => {
        if (!cb.checked) {
          const field = cb.dataset.field;
          const fieldMap = {
            permissionMode: () => settingsViewerBody.querySelector('#sv-perm-mode').value || null,
            worktree: () => settingsViewerBody.querySelector('#sv-worktree').checked,
            worktreeName: () => settingsViewerBody.querySelector('#sv-worktree-name').value.trim(),
            chrome: () => settingsViewerBody.querySelector('#sv-chrome').checked,
            preLaunchCmd: () => settingsViewerBody.querySelector('#sv-pre-launch').value.trim(),
            addDirs: () => settingsViewerBody.querySelector('#sv-add-dirs').value.trim(),
            visibleSessionCount: () => parseInt(settingsViewerBody.querySelector('#sv-visible-count').value) || 10,
          };
          if (fieldMap[field]) settings[field] = fieldMap[field]();
        }
      });
    } else {
      settings.permissionMode = settingsViewerBody.querySelector('#sv-perm-mode').value || null;
      settings.worktree = settingsViewerBody.querySelector('#sv-worktree').checked;
      settings.worktreeName = settingsViewerBody.querySelector('#sv-worktree-name').value.trim();
      settings.chrome = settingsViewerBody.querySelector('#sv-chrome').checked;
      settings.preLaunchCmd = settingsViewerBody.querySelector('#sv-pre-launch').value.trim();
      settings.addDirs = settingsViewerBody.querySelector('#sv-add-dirs').value.trim();
      settings.visibleSessionCount = parseInt(settingsViewerBody.querySelector('#sv-visible-count').value) || 10;
      settings.sessionMaxAgeDays = parseInt(settingsViewerBody.querySelector('#sv-max-age').value) || 3;
      settings.terminalTheme = settingsViewerBody.querySelector('#sv-terminal-theme').value || 'switchboard';
      settings.mcpEmulation = settingsViewerBody.querySelector('#sv-mcp-emulation').checked;
    }

    // Preserve windowBounds and sidebarWidth if they exist
    if (!isProject) {
      const existing = (await window.api.getSetting('global')) || {};
      if (existing.windowBounds) settings.windowBounds = existing.windowBounds;
      if (existing.sidebarWidth) settings.sidebarWidth = existing.sidebarWidth;
    }

    await window.api.setSetting(settingsKey, settings);

    // Update visibleSessionCount, sessionMaxAgeDays, and theme
    if (!isProject) {
      if (settings.visibleSessionCount) visibleSessionCount = settings.visibleSessionCount;
      if (settings.sessionMaxAgeDays) sessionMaxAgeDays = settings.sessionMaxAgeDays;
      if (settings.terminalTheme) {
        currentThemeName = settings.terminalTheme;
        TERMINAL_THEME = getTerminalTheme();
        // Apply to all open terminals
        for (const [, entry] of openSessions) {
          entry.terminal.options.theme = TERMINAL_THEME;
        }
      }
      refreshSidebar();
    }

    // Notify if IDE Emulation changed
    if (!isProject && settings.mcpEmulation !== mcpEmulationValue) {
      const notice = document.createElement('div');
      notice.className = 'settings-notice';
      notice.textContent = 'IDE Emulation setting changed. New sessions will use the updated setting \u2014 running sessions are not affected.';
      const saveBtn = settingsViewerBody.querySelector('#sv-save-btn');
      saveBtn.parentElement.insertBefore(notice, saveBtn);
      setTimeout(() => notice.remove(), 8000);
    }

    // Flash save confirmation
    const btn = settingsViewerBody.querySelector('#sv-save-btn');
    btn.classList.add('saved');
    btn.textContent = 'Saved!';
    setTimeout(() => { btn.classList.remove('saved'); btn.textContent = 'Save Settings'; }, 1500);
  });

  // Remove project button
  const removeBtn = settingsViewerBody.querySelector('#sv-remove-btn');
  if (removeBtn) {
    removeBtn.addEventListener('click', async () => {
      if (!confirm(`Remove project "${shortName}" from Switchboard?\n\nThis hides the project from the sidebar. Your session files are not deleted.`)) return;
      await window.api.removeProject(projectPath);
      settingsViewer.style.display = 'none';
      placeholder.style.display = 'flex';
      loadProjects();
    });
  }
}

// Global settings gear button
globalSettingsBtn.addEventListener('click', () => {
  // Deactivate other tabs, activate settings
  document.querySelectorAll('.sidebar-tab').forEach(t => t.classList.remove('active'));
  globalSettingsBtn.classList.add('active');
  // Hide all sidebar content
  sidebarContent.style.display = 'none';
  plansContent.style.display = 'none';
  statsContent.style.display = 'none';
  configContent.style.display = 'none';
  sessionFilters.style.display = 'none';
  searchBar.style.display = 'none';
  openSettingsViewer('global');
});

// Add project button
addProjectBtn.addEventListener('click', () => {
  showAddProjectDialog();
});

const addGroupBtn = document.getElementById('add-group-btn');
if (addGroupBtn) {
  addGroupBtn.addEventListener('click', () => {
    const overlay = document.createElement('div');
    overlay.className = 'add-project-overlay';
    const dialog = document.createElement('div');
    dialog.className = 'add-project-dialog';
    dialog.innerHTML = `
      <h3>Add Group</h3>
      <div class="add-project-hint">Create a named folder to organize projects in the sidebar.</div>
      <div class="folder-input-row">
        <input type="text" id="add-group-name" placeholder="Group name" autocomplete="off" spellcheck="false">
      </div>
      <div class="add-project-error" id="add-group-error"></div>
      <div class="add-project-actions">
        <button class="add-project-cancel-btn">Cancel</button>
        <button class="add-project-add-btn">Create</button>
      </div>
    `;
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);
    const nameInput = dialog.querySelector('#add-group-name');
    const errorEl = dialog.querySelector('#add-group-error');
    nameInput.focus();
    function close() { overlay.remove(); document.removeEventListener('keydown', onKey); }
    function submit() {
      const name = nameInput.value.trim();
      if (!name) { errorEl.textContent = 'Please enter a name.'; errorEl.style.display = 'block'; return; }
      createGroup(name);
      close();
      refreshSidebar();
    }
    function onKey(e) {
      if (e.key === 'Escape') close();
      if (e.key === 'Enter') submit();
    }
    document.addEventListener('keydown', onKey);
    dialog.querySelector('.add-project-cancel-btn').onclick = close;
    dialog.querySelector('.add-project-add-btn').onclick = submit;
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  });
}

function showAddProjectDialog() {
  const overlay = document.createElement('div');
  overlay.className = 'add-project-overlay';

  const dialog = document.createElement('div');
  dialog.className = 'add-project-dialog';

  dialog.innerHTML = `
    <h3>Add Project</h3>
    <div class="add-project-hint">Select a folder to create a new project. To start a session in an existing project, use the + on its project header.</div>
    <div class="folder-input-row">
      <input type="text" id="add-project-path" placeholder="/path/to/project" autocomplete="off" spellcheck="false">
      <button class="add-project-browse-btn">Browse</button>
    </div>
    <div class="add-project-error" id="add-project-error"></div>
    <div class="add-project-actions">
      <button class="add-project-cancel-btn">Cancel</button>
      <button class="add-project-add-btn">Add</button>
    </div>
  `;

  overlay.appendChild(dialog);
  document.body.appendChild(overlay);

  const pathInput = dialog.querySelector('#add-project-path');
  const errorEl = dialog.querySelector('#add-project-error');
  pathInput.focus();

  function close() {
    overlay.remove();
    document.removeEventListener('keydown', onKey);
  }

  async function addProject() {
    const projectPath = pathInput.value.trim();
    if (!projectPath) {
      errorEl.textContent = 'Please enter a folder path.';
      errorEl.style.display = 'block';
      return;
    }
    errorEl.style.display = 'none';
    const result = await window.api.addProject(projectPath);
    if (result.error) {
      errorEl.textContent = result.error;
      errorEl.style.display = 'block';
      return;
    }
    close();

    await loadProjects();
  }

  dialog.querySelector('.add-project-browse-btn').onclick = async () => {
    const folder = await window.api.browseFolder();
    if (folder) pathInput.value = folder;
  };

  dialog.querySelector('.add-project-cancel-btn').onclick = close;
  dialog.querySelector('.add-project-add-btn').onclick = addProject;
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

  function onKey(e) {
    if (e.key === 'Escape') close();
    if (e.key === 'Enter') addProject();
  }
  document.addEventListener('keydown', onKey);
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
    if (activeSessionId && openSessions.has(activeSessionId)) {
      const entry = openSessions.get(activeSessionId);
      entry.fitAddon.fit();
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
    if (global.projectGroups) {
      projectGroups = global.projectGroups;
    }
  }
})();

loadProjects().then(() => {
  // Restore active session after reload
  if (activeSessionId && !openSessions.has(activeSessionId)) {
    const session = sessionMap.get(activeSessionId);
    if (session) openSession(session);
  }
});

// Live-reload sidebar when filesystem changes are detected
let projectsChangedTimer = null;
let projectsChangedWhileAway = false;
window.api.onProjectsChanged(() => {
  // Debounce to avoid rapid re-renders during bulk changes
  if (projectsChangedTimer) clearTimeout(projectsChangedTimer);
  if (activeTab !== 'sessions') {
    projectsChangedWhileAway = true;
    return;
  }
  projectsChangedTimer = setTimeout(() => {
    projectsChangedTimer = null;
    loadProjects();
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
  parts.push(`${totalProjects} projects`);
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
      msg.innerHTML = `New Version Ready<br><span class="update-version">v${data.version}</span>`;
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
