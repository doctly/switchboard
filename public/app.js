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
const planPreviewBtn = document.getElementById('plan-preview-btn');
const planViewerPreviewEl = document.getElementById('plan-viewer-preview');

let currentPlanContent = '';
let currentPlanFilePath = '';
let currentPlanFilename = '';
let planEditorView = null;
let planPreviewMode = localStorage.getItem('planPreviewMode') === 'true';
const loadingStatus = document.getElementById('loading-status');
const sessionFilters = document.getElementById('session-filters');
const searchBar = document.getElementById('search-bar');
const statsContent = document.getElementById('stats-content');
const memoryContent = document.getElementById('memory-content');
const statsViewer = document.getElementById('stats-viewer');
const statsViewerBody = document.getElementById('stats-viewer-body');
const memoryViewer = document.getElementById('memory-viewer');
const memoryViewerTitle = document.getElementById('memory-viewer-title');
const memoryViewerFilename = document.getElementById('memory-viewer-filename');
const memoryViewerEditorEl = document.getElementById('memory-viewer-editor');
const memoryCopyPathBtn = document.getElementById('memory-copy-path-btn');
const memoryCopyContentBtn = document.getElementById('memory-copy-content-btn');
const memorySaveBtn = document.getElementById('memory-save-btn');
const memoryPreviewBtn = document.getElementById('memory-preview-btn');
const memoryViewerPreviewEl = document.getElementById('memory-viewer-preview');
const terminalArea = document.getElementById('terminal-area');
const settingsViewer = document.getElementById('settings-viewer');
const settingsViewerTitle = document.getElementById('settings-viewer-title');
const settingsViewerBody = document.getElementById('settings-viewer-body');
const globalSettingsBtn = document.getElementById('global-settings-btn');
const addProjectBtn = document.getElementById('add-project-btn');
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

// Noise patterns — these don't count as activity
const activityNoiseRe = /file-history-snapshot|^\s*$/;

// Central activity dispatcher
function setActivity(sessionId, active) {
  if (responseReadySessions.has(sessionId)) {
    return;
  }

  const wasActive = sessionBusyState.get(sessionId) || false;
  sessionBusyState.set(sessionId, active);

  if (wasActive && !active) {
    // Activity ended → response-ready if user isn't looking at this session
    if (sessionId !== activeSessionId) {
      responseReadySessions.add(sessionId);
      const item = document.querySelector(`.session-item[data-session-id="${sessionId}"]`);
      if (item) {
        item.classList.remove('cli-busy');
        item.classList.add('response-ready');
      }
    }
  }

  // Sync cli-busy class (only if not response-ready)
  if (!responseReadySessions.has(sessionId)) {
    const item = document.querySelector(`.session-item[data-session-id="${sessionId}"]`);
    if (item) item.classList.toggle('cli-busy', active);
  }
}

// Terminal output activity — updates lastActivityTime only, busy state driven by backend
function trackActivity(sessionId, data) {
  if (activityNoiseRe.test(data)) return;
  lastActivityTime.set(sessionId, new Date());
}

function clearUnread(sessionId) {
  responseReadySessions.delete(sessionId);
  const item = document.querySelector(`.session-item[data-session-id="${sessionId}"]`);
  if (item) {
    item.classList.remove('response-ready');
  }
}

function clearNotifications(sessionId) {
  clearUnread(sessionId);
  attentionSessions.delete(sessionId);
  const item = document.querySelector(`.session-item[data-session-id="${sessionId}"]`);
  if (item) item.classList.remove('needs-attention');
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
const isMac = window.api.platform === 'darwin';
function setupTerminalKeyBindings(terminal, container, getSessionId) {
  terminal.attachCustomKeyEventHandler((e) => {
    // Shift+Enter → newline (kitty protocol CSI 13;2u) so Claude Code treats it as newline, not submit.
    if (e.key === 'Enter' && e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) {
      if (e.type === 'keydown') {
        window.api.sendInput(getSessionId(), '\x1b[13;2u');
      }
      return false;
    }

    // Ctrl+Enter → newline on Windows/Linux (matches PowerShell convention).
    // Send the same Shift+Enter kitty sequence that Claude Code recognizes as newline.
    if (!isMac && e.key === 'Enter' && e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey) {
      if (e.type === 'keydown') {
        window.api.sendInput(getSessionId(), '\x1b[13;2u');
      }
      return false;
    }

    // On Windows/Linux, Ctrl+V is captured by xterm as a control character (0x16)
    // instead of triggering a paste. Return false to block xterm's key pipeline and
    // let Electron's Edit menu { role: 'paste' } handle the actual clipboard paste.
    if (!isMac && e.key === 'v' && e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey) {
      return false;
    }

    // On Windows/Linux, Ctrl+C with a selection should copy instead of sending SIGINT.
    // When nothing is selected, Ctrl+C falls through to xterm (sends SIGINT as normal).
    if (!isMac && e.key === 'c' && e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey) {
      if (terminal.hasSelection()) {
        if (e.type === 'keydown') {
          navigator.clipboard.writeText(terminal.getSelection()).catch(() => {});
        }
        return false;
      }
    }

    return true;
  });

  const textarea = container.querySelector('.xterm-helper-textarea');
  if (textarea) {
    textarea.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.shiftKey || (!isMac && e.ctrlKey)) && !e.altKey && !e.metaKey) {
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

// Fit terminal to container, subtracting 1 row to avoid partial-row clipping.
function safeFit(entry) {
  const dims = entry.fitAddon.proposeDimensions();
  if (dims && dims.rows > 1) {
    entry.terminal.resize(dims.cols, dims.rows);
  } else {
    entry.fitAddon.fit();
  }
}

// Fit a terminal that just became visible (from display:none or reparent).
// Defers to requestAnimationFrame so the container has dimensions.
function fitAndScroll(entry) {
  const wasAtBottom = isAtBottom(entry.terminal);
  requestAnimationFrame(() => {
    safeFit(entry);
    if (wasAtBottom) {
      entry.terminal.scrollToBottom();
    }
  });
}

// --- IPC listeners from main process ---

// Batch incoming terminal data to coalesce IPC chunks into fewer write() calls.
// PTY output arrives in ~1KB IPC chunks which can split synchronized update
// markers (ESC[?2026h / ESC[?2026l) across calls. We hold data until the sync
// end marker arrives so xterm can process the complete update atomically.
// A safety timeout ensures we never hold data indefinitely.
const ESC_SYNC_START = '\x1b[?2026h';
const ESC_SYNC_END = '\x1b[?2026l';
const SYNC_BUFFER_TIMEOUT = 500; // max ms to hold data waiting for sync end
const terminalWriteBuffers = new Map(); // sessionId → { chunks, syncDepth, rafId, timerId }

function flushTerminalBuffer(sessionId) {
  const buf = terminalWriteBuffers.get(sessionId);
  if (!buf) return;
  clearTimeout(buf.timerId);
  cancelAnimationFrame(buf.rafId);
  terminalWriteBuffers.delete(sessionId);

  const entry = openSessions.get(sessionId);
  if (!entry) return;

  const data = buf.chunks.join('');
  const wasAtBottom = isAtBottom(entry.terminal);
  const savedViewportY = entry.terminal.buffer.active.viewportY;
  entry.terminal.write(data, () => {
    if (sessionId !== activeSessionId) return;
    if (wasAtBottom) {
      entry.terminal.scrollToBottom();
    } else {
      // Restore scroll position so redraws don't yank the user away
      entry.terminal.scrollLines(savedViewportY - entry.terminal.buffer.active.viewportY);
    }
  });
}

function scheduleFlush(sessionId, buf) {
  cancelAnimationFrame(buf.rafId);
  buf.rafId = requestAnimationFrame(() => flushTerminalBuffer(sessionId));
}

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
    gridViewerCount.textContent = gridCards.size + ' session' + (gridCards.size !== 1 ? 's' : '');
  } else if (activeSessionId === sessionId) {
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
  // Matches all four CLI notification types:
  // 1. "Claude Code needs your attention"         → attention
  // 2. "Claude Code needs your approval for the plan" → approval, needs your
  // 3. "Claude needs your permission to use {tool}"   → permission, needs your
  // 4. "Claude Code wants to enter plan mode"         → wants to enter
  if (/attention|approval|permission|needs your|wants to enter/i.test(message) && sessionId !== activeSessionId) {
    attentionSessions.add(sessionId);
    const item = document.querySelector(`.session-item[data-session-id="${sessionId}"]`);
    if (item) item.classList.add('needs-attention');
  } else if (/waiting for your input/i.test(message)) {
    // "Claude is waiting for your input" — delayed idle notification, mark response-ready
    setActivity(sessionId, false);
  } else {
    console.log(`[notification] session=${sessionId} (no attention match) message="${message}"`);
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
      if (activeTab === 'sessions') {
        const results = await window.api.search('session', query);
        searchMatchIds = new Set(results.map(r => r.id));
        refreshSidebar({ resort: true });
      } else if (activeTab === 'plans') {
        const results = await window.api.search('plan', query);
        const matchIds = new Set(results.map(r => r.id));
        renderPlans(cachedPlans.filter(p => matchIds.has(p.filename)));
      } else if (activeTab === 'memory') {
        const results = await window.api.search('memory', query);
        const matchIds = new Set(results.map(r => r.id));
        renderMemories(matchIds);
      }
    } catch {
      if (activeTab === 'sessions') {
        searchMatchIds = null;
        refreshSidebar({ resort: true });
      }
    }
  }, 200);
});

// --- Stop session helper ---
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
  if (activeSessionId) confirmAndStopSession(activeSessionId);
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

  // Track active plain terminals in pendingSessions/sessionMap (data now comes from backend)
  try {
    const activeTerminals = await window.api.getActiveTerminals();
    for (const { sessionId, projectPath } of activeTerminals) {
      if (pendingSessions.has(sessionId)) continue; // already tracked
      const folder = projectPath.replace(/[/_]/g, '-').replace(/^-/, '-');
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
  archiveSlugBtn.innerHTML = ICONS.archive(14);

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

  for (const project of projects) {
    // === STEP 1: Filter ===
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
    const anyFilterActive = showStarredOnly || showRunningOnly || showTodayOnly || searchMatchIds !== null;
    if (filtered.length === 0 && (project.sessions.length > 0 || anyFilterActive)) continue;
    const fId = folderId(project.projectPath);

    // === STEP 2: Sort ===
    // Priority: pinned+running > running > pinned > rest (by modified desc)
    filtered = [...filtered].sort((a, b) => {
      const aRunning = activePtyIds.has(a.sessionId) || pendingSessions.has(a.sessionId);
      const bRunning = activePtyIds.has(b.sessionId) || pendingSessions.has(b.sessionId);
      const aPri = (a.starred && aRunning ? 3 : aRunning ? 2 : a.starred ? 1 : 0);
      const bPri = (b.starred && bRunning ? 3 : bRunning ? 2 : b.starred ? 1 : 0);
      if (aPri !== bPri) return bPri - aPri;
      return new Date(b.modified) - new Date(a.modified);
    });

    // === STEP 3: Slug grouping ===
    const slugMap = new Map(); // slug → sessions[]
    const ungrouped = [];
    for (const session of filtered) {
      if (session.slug) {
        if (!slugMap.has(session.slug)) slugMap.set(session.slug, []);
        slugMap.get(session.slug).push(session);
      } else {
        ungrouped.push(session);
      }
    }

    // Build render items (slug group = 1 item)
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

    // === STEP 4: Sort render items ===
    const prevEntry = sortedOrder.find(e => e.projectPath === project.projectPath);
    if (resort || !prevEntry) {
      // Full sort by priority + modified time
      allItems.sort((a, b) => {
        const aPri = (a.pinned && a.running ? 3 : a.running ? 2 : a.pinned ? 1 : 0);
        const bPri = (b.pinned && b.running ? 3 : b.running ? 2 : b.pinned ? 1 : 0);
        if (aPri !== bPri) return bPri - aPri;
        return b.sortTime - a.sortTime;
      });
    } else {
      // Preserve last-sorted order; new items go to top
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
    // Save current order for this project
    newSortedOrder.push({ projectPath: project.projectPath, itemIds: allItems.map(item => item.element.id) });

    // === STEP 5: Truncate — split into visible vs older ===
    let visible = [];
    let older = [];
    if (searchMatchIds !== null || showStarredOnly || showRunningOnly || showTodayOnly) {
      visible = allItems;
    } else {
      let count = 0;
      const ageCutoff = Date.now() - sessionMaxAgeDays * 86400000;
      for (const item of allItems) {
        // Running and pinned always show; others must be within count AND age limit
        if (item.running || item.pinned || (count < visibleSessionCount && item.sortTime >= ageCutoff)) {
          visible.push(item);
          count++;
        } else {
          older.push(item);
        }
      }
      // If visible is empty but older has items, show them directly
      if (visible.length === 0 && older.length > 0) {
        visible = older;
        older = [];
      }
    }

    // === STEP 6: Build DOM ===
    const group = document.createElement('div');
    group.className = 'project-group';
    group.id = fId;

    const header = document.createElement('div');
    header.className = 'project-header';
    header.id = 'ph-' + fId;
    const shortName = project.projectPath.split('/').filter(Boolean).slice(-2).join('/');
    header.innerHTML = `<span class="arrow">&#9660;</span> <span class="project-name">${shortName}</span>`;

    const settingsBtn = document.createElement('button');
    settingsBtn.className = 'project-settings-btn';
    settingsBtn.title = 'Project settings';
    settingsBtn.innerHTML = ICONS.gear(16);
    header.appendChild(settingsBtn);

    const archiveGroupBtn = document.createElement('button');
    archiveGroupBtn.className = 'project-archive-btn';
    archiveGroupBtn.title = 'Archive all sessions';
    archiveGroupBtn.innerHTML = ICONS.archive(18);
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

    // Auto-collapse if most recent session is older than 5 days
    if (searchMatchIds === null && !showStarredOnly && !showRunningOnly) {
      const mostRecent = filtered[0]?.modified;
      if (mostRecent && (Date.now() - new Date(mostRecent)) > sessionMaxAgeDays * 86400000) {
        header.classList.add('collapsed');
      }
    }

    group.appendChild(header);
    group.appendChild(sessionsList);
    newSidebar.appendChild(group);
  }

  // Re-apply active state
  if (activeSessionId) {
    const activeItem = newSidebar.querySelector(`[data-session-id="${activeSessionId}"]`);
    if (activeItem) activeItem.classList.add('active');
  }

  morphdom(sidebarContent, newSidebar, {
    childrenOnly: true,
    onBeforeElUpdated(fromEl, toEl) {
      // Skip updating session items that have an active rename input
      if (fromEl.classList.contains('session-item') && fromEl.querySelector('.session-rename-input')) {
        return false;
      }
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
      return true;
    },
    getNodeKey(node) {
      return node.id || undefined;
    }
  });

  // Save the full sorted order (project order + item order) as source of truth
  sortedOrder = newSortedOrder;

  rebindSidebarEvents(projects);

  // Restore terminal focus after morphdom DOM updates, but not if the user is
  // interacting with an input/textarea (search box, rename input, dialogs, etc.)
  const ae = document.activeElement;
  const isUserTyping = ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.isContentEditable || ae.closest('.modal-overlay'));
  if (activeSessionId && openSessions.has(activeSessionId) && !isUserTyping) {
    openSessions.get(activeSessionId).terminal.focus();
  }
}

function rebindSidebarEvents(projects) {
  for (const project of projects) {
    const fId = folderId(project.projectPath);
    const header = document.getElementById('ph-' + fId);
    if (!header) continue;
    const newBtn = header.querySelector('.project-new-btn');
    if (newBtn) {
      newBtn.onclick = (e) => { e.stopPropagation(); showNewSessionPopover(project, newBtn); };
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
      if (e.target.closest('.project-new-btn') || e.target.closest('.project-archive-btn') || e.target.closest('.project-settings-btn')) return;
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
      stopBtn.onclick = (e) => {
        e.stopPropagation();
        confirmAndStopSession(session.sessionId);
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

  // Auto-expand slug group if it contains the active session
  if (activeSessionId) {
    const activeItem = sidebarContent.querySelector(`[data-session-id="${activeSessionId}"]`);
    const collapsedGroup = activeItem?.closest('.slug-group.collapsed');
    if (collapsedGroup) {
      collapsedGroup.classList.remove('collapsed');
      saveExpandedSlugs();
    }
  }
}

function buildSessionItem(session) {
  const item = document.createElement('div');
  item.className = 'session-item';
  item.id = 'si-' + session.sessionId;
  if (session.type === 'terminal') item.classList.add('is-terminal');
  if (session.archived) item.classList.add('archived-item');
  if (activePtyIds.has(session.sessionId)) item.classList.add('has-running-pty');
  if (attentionSessions.has(session.sessionId)) item.classList.add('needs-attention');
  if (responseReadySessions.has(session.sessionId)) item.classList.add('response-ready');
  if (sessionBusyState.get(session.sessionId)) item.classList.add('cli-busy');
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
    badge.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"/></svg>';
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
  archiveBtn.innerHTML = ICONS.archive(16);

  const forkBtn = document.createElement('button');
  forkBtn.className = 'session-fork-btn';
  forkBtn.title = 'Fork session';
  forkBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 3h5v5"/><path d="M8 3h-5v5"/><path d="M21 3l-7.536 7.536a5 5 0 0 0-1.464 3.534v6.93"/><path d="M3 3l7.536 7.536a5 5 0 0 1 1.464 3.534v.93"/></svg>';

  const jsonlBtn = document.createElement('button');
  jsonlBtn.className = 'session-jsonl-btn';
  jsonlBtn.title = 'View messages';
  jsonlBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 9a2 2 0 0 1-2 2H6l-4 4V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2z"/><path d="M18 9h2a2 2 0 0 1 2 2v11l-4-4h-6a2 2 0 0 1-2-2v-1"/></svg>';

  actions.appendChild(stopBtn);
  if (session.type !== 'terminal') {
    actions.appendChild(forkBtn);
    actions.appendChild(jsonlBtn);
    actions.appendChild(archiveBtn);
  }

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
  const displayName = cleanDisplayName(session.name || session.summary);
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

// --- Shared terminal lifecycle helpers ---

// Create an xterm instance, wire up IPC, and register in openSessions.
// Returns the entry. Does NOT make it visible or fit it — call showSession() for that.
function createTerminalEntry(session) {
  const { sessionId } = session;
  const container = document.createElement('div');
  container.className = 'terminal-container';
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
  container.style.backgroundColor = TERMINAL_THEME.background;

  const entry = { terminal, element: container, fitAddon, session, closed: false };
  openSessions.set(sessionId, entry);

  // Wire up IPC (use entry.session.sessionId so fork re-keying works)
  terminal.onData(data => {
    if (data === '\x1b[I' || data === '\x1b[O') return;
    window.api.sendInput(entry.session.sessionId, data);
  });
  setupTerminalKeyBindings(terminal, container, () => entry.session.sessionId);
  setupDragAndDrop(container, () => entry.session.sessionId);
  terminal.onResize(({ cols, rows }) => {
    window.api.resizeTerminal(entry.session.sessionId, cols, rows);
  });
  terminal.onTitleChange(title => {
    entry.ptyTitle = title;
    if (activeSessionId === entry.session.sessionId) updatePtyTitle();
  });
  terminal.onBell(() => {
    trackActivity(entry.session.sessionId, '\x07');
  });

  return entry;
}

// Clean up a closed session entry (dispose terminal, remove DOM, remove from maps).
function destroySession(sessionId) {
  const entry = openSessions.get(sessionId);
  if (!entry) return;
  window.api.closeTerminal(sessionId);
  entry.terminal.dispose();
  entry.element.remove();
  openSessions.delete(sessionId);
  const card = gridCards.get(sessionId);
  if (card) { card.remove(); gridCards.delete(sessionId); }
}

// Make a session visible in the current view mode (grid or single).
// Handles sidebar highlight, notifications, header, fit, and focus.
function showSession(sessionId) {
  const entry = openSessions.get(sessionId);
  const session = sessionMap.get(sessionId) || (entry && entry.session);

  // Update sidebar active state
  document.querySelectorAll('.session-item.active').forEach(el => el.classList.remove('active'));
  const item = document.querySelector(`[data-session-id="${sessionId}"]`);
  if (item) item.classList.add('active');
  setActiveSession(sessionId);
  clearNotifications(sessionId);

  if (gridViewActive) {
    // Ensure grid layout is set up (e.g. on first session after startup restore)
    if (!terminalsEl.classList.contains('grid-layout')) {
      showGridView();
    }
    if (entry && gridCards.has(sessionId)) {
      // Already in grid — just focus it
      focusGridCard(sessionId);
    } else if (entry) {
      // New entry not yet in grid — wrap and focus
      wrapInGridCard(sessionId);
      fitAndScroll(entry);
      requestAnimationFrame(() => focusGridCard(sessionId));
      gridViewerCount.textContent = gridCards.size + ' session' + (gridCards.size !== 1 ? 's' : '');
    }
  } else {
    // Single terminal view
    document.querySelectorAll('.terminal-container').forEach(el => el.classList.remove('visible'));
    placeholder.style.display = 'none';
    hidePlanViewer();
    if (session) showTerminalHeader(session);
    if (entry) {
      entry.element.classList.add('visible');
      entry.terminal.focus();
      fitAndScroll(entry);
    }
  }
}

// --- End shared terminal lifecycle helpers ---

async function openSession(session) {
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
  const resumeOptions = await resolveDefaultSessionOptions({ projectPath });
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

function cleanDisplayName(name) {
  if (!name) return name;
  const prefix = 'Implement the following plan:';
  if (name.startsWith(prefix)) name = name.slice(prefix.length).trim();
  // Strip XML/HTML-like tags (e.g. <command>, </message>, <system-reminder>)
  name = name.replace(/<\/?[a-zA-Z][a-zA-Z0-9_-]*(?:\s[^>]*)?\/?>/g, ' ');
  // Collapse multiple spaces and trim
  name = name.replace(/\s+/g, ' ').trim();
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

function shellEscape(path) {
  return "'" + path.replace(/'/g, "'\\''") + "'";
}

function setupDragAndDrop(container, getSessionId) {
  let dragCounter = 0;
  container.addEventListener('dragenter', (e) => {
    e.preventDefault();
    dragCounter++;
    container.classList.add('drag-over');
  });
  container.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  });
  container.addEventListener('dragleave', () => {
    dragCounter--;
    if (dragCounter <= 0) {
      dragCounter = 0;
      container.classList.remove('drag-over');
    }
  });
  container.addEventListener('drop', (e) => {
    e.preventDefault();
    dragCounter = 0;
    container.classList.remove('drag-over');
    const files = e.dataTransfer.files;
    if (!files.length) return;
    const paths = Array.from(files).map(f => shellEscape(window.api.getPathForFile(f)));
    window.api.sendInput(getSessionId(), paths.join(' '));
  });
}

// --- Tab switching ---
document.querySelectorAll('.sidebar-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    const tabName = tab.dataset.tab;
    if (tabName === activeTab) return;
    activeTab = tabName;
    document.querySelectorAll('.sidebar-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tabName));

    // Clear search on tab switch
    searchInput.value = '';
    searchBar.classList.remove('has-query');
    searchMatchIds = null;

    // Hide all sidebar content areas
    sidebarContent.style.display = 'none';
    plansContent.style.display = 'none';
    statsContent.style.display = 'none';
    memoryContent.style.display = 'none';
    sessionFilters.style.display = 'none';
    searchBar.style.display = 'none';

    if (tabName === 'sessions') {
      sessionFilters.style.display = '';
      searchBar.style.display = '';
      searchInput.placeholder = 'Search sessions...';
      sidebarContent.style.display = '';
      // Restore terminal area
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
      // Catch up on changes that happened while on another tab
      if (projectsChangedWhileAway) {
        projectsChangedWhileAway = false;
        loadProjects();
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
  memoryViewer.style.display = 'none';
  settingsViewer.style.display = 'none';
  planViewer.style.display = 'flex';

  planViewerTitle.textContent = plan.title;
  planViewerFilepath.textContent = currentPlanFilePath;

  // Reset to edit mode first so the editor can be updated
  if (planPreviewMode) {
    toggleMarkdownPreview({
      editorEl: planViewerEditorEl, previewEl: planViewerPreviewEl,
      toggleBtn: planPreviewBtn, editorView: planEditorView, isPreview: true,
    });
  }

  // Create or update CodeMirror editor
  if (!planEditorView) {
    planEditorView = window.createPlanEditor(planViewerEditorEl);
  }
  planEditorView.dispatch({
    changes: { from: 0, to: planEditorView.state.doc.length, insert: currentPlanContent },
  });

  // Apply saved preview preference
  if (planPreviewMode) {
    toggleMarkdownPreview({
      editorEl: planViewerEditorEl, previewEl: planViewerPreviewEl,
      toggleBtn: planPreviewBtn, editorView: planEditorView, isPreview: false,
    });
  }
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

function toggleMarkdownPreview({ editorEl, previewEl, toggleBtn, editorView, isPreview, storageKey }) {
  if (!isPreview) {
    const content = editorView ? editorView.state.doc.toString() : '';
    previewEl.innerHTML = window.marked.parse(content);
    editorEl.style.display = 'none';
    previewEl.style.display = 'block';
    toggleBtn.textContent = 'Edit';
    toggleBtn.classList.add('active');
    if (storageKey) localStorage.setItem(storageKey, 'true');
    return true;
  } else {
    previewEl.style.display = 'none';
    editorEl.style.display = '';
    toggleBtn.textContent = 'Preview';
    toggleBtn.classList.remove('active');
    if (storageKey) localStorage.setItem(storageKey, 'false');
    return false;
  }
}

planPreviewBtn.addEventListener('click', () => {
  planPreviewMode = toggleMarkdownPreview({
    editorEl: planViewerEditorEl,
    previewEl: planViewerPreviewEl,
    toggleBtn: planPreviewBtn,
    editorView: planEditorView,
    isPreview: planPreviewMode,
    storageKey: 'planPreviewMode',
  });
});

function hideAllViewers() {
  planViewer.style.display = 'none';
  statsViewer.style.display = 'none';
  memoryViewer.style.display = 'none';
  settingsViewer.style.display = 'none';
  jsonlViewer.style.display = 'none';
  terminalArea.style.display = '';
}

function hidePlanViewer() {
  hideAllViewers();
}

// --- Session Grid Overview ---
// No reparenting — terminals stay in #terminals. We wrap each terminal container
// with an in-place card overlay (header/footer) and switch #terminals to grid layout.

let gridCards = new Map(); // sessionId → card wrapper element
let gridFocusedSessionId = null;

function wrapInGridCard(sessionId) {
  const entry = openSessions.get(sessionId);
  const session = sessionMap.get(sessionId) || (entry && entry.session);
  if (!session || !entry) return;

  const displayName = cleanDisplayName(session.name || session.summary) || sessionId;
  const shortProject = session.projectPath ? session.projectPath.split('/').filter(Boolean).slice(-2).join('/') : '';

  // Create card wrapper
  const card = document.createElement('div');
  card.className = 'grid-card';
  card.dataset.sessionId = sessionId;

  // Header
  const header = document.createElement('div');
  header.className = 'grid-card-header';
  const dot = document.createElement('span');
  dot.className = 'grid-card-dot';
  header.appendChild(dot);
  const name = document.createElement('span');
  name.className = 'grid-card-name';
  name.textContent = displayName;
  header.appendChild(name);
  const project = document.createElement('span');
  project.className = 'grid-card-project';
  project.textContent = shortProject;
  header.appendChild(project);

  const stopBtn = document.createElement('button');
  stopBtn.className = 'grid-card-stop-btn';
  stopBtn.title = 'Stop session';
  stopBtn.innerHTML = '<svg width="10" height="10" viewBox="0 0 12 12" fill="currentColor"><rect x="2" y="2" width="8" height="8" rx="1"/></svg>';
  stopBtn.style.display = activePtyIds.has(sessionId) ? '' : 'none';
  stopBtn.onclick = (e) => {
    e.stopPropagation();
    confirmAndStopSession(sessionId);
  };
  header.appendChild(stopBtn);

  // Footer
  const footer = document.createElement('div');
  footer.className = 'grid-card-footer';
  const statusSpan = document.createElement('span');
  const timeSpan = document.createElement('span');
  timeSpan.textContent = formatDate(lastActivityTime.get(sessionId) || new Date(session.modified));
  footer.appendChild(statusSpan);
  footer.appendChild(timeSpan);

  // Build the card DOM
  card.appendChild(header);
  entry.element.classList.add('visible', 'grid-mode');
  card.appendChild(entry.element);
  card.appendChild(footer);

  // Insert card into the correct project group in the grid
  if (gridViewActive) {
    const pp = session.projectPath || '';
    // Find or create the project heading for this session
    let targetHeading = null;
    for (const h of terminalsEl.querySelectorAll('.grid-project-heading')) {
      if (h.dataset.projectPath === pp) { targetHeading = h; break; }
    }
    if (!targetHeading) {
      targetHeading = document.createElement('div');
      targetHeading.className = 'grid-project-heading';
      targetHeading.dataset.projectPath = pp;
      targetHeading.textContent = pp ? pp.split('/').filter(Boolean).slice(-2).join('/') : 'Other';
      // Insert heading in sortedOrder position
      const orderIndex = new Map(sortedOrder.map((e, i) => [e.projectPath, i]));
      const myIdx = orderIndex.get(pp);
      let inserted = false;
      if (myIdx !== undefined) {
        for (const h of terminalsEl.querySelectorAll('.grid-project-heading')) {
          const hIdx = orderIndex.get(h.dataset.projectPath);
          if (hIdx !== undefined && hIdx > myIdx) {
            terminalsEl.insertBefore(targetHeading, h);
            inserted = true;
            break;
          }
        }
      }
      if (!inserted) terminalsEl.appendChild(targetHeading);
    }
    // Insert card after the heading and any existing cards in this group
    // (find next heading or end of container)
    let insertBefore = targetHeading.nextSibling;
    while (insertBefore && !insertBefore.classList.contains('grid-project-heading')) {
      insertBefore = insertBefore.nextSibling;
    }
    terminalsEl.insertBefore(card, insertBefore);
  } else {
    // Not in grid view — just place where the terminal container was
    terminalsEl.appendChild(card);
  }

  // Click header or footer to focus
  header.addEventListener('mousedown', (e) => {
    e.stopPropagation();
    focusGridCard(sessionId);
  });
  // Double-click header to switch to full terminal view
  header.addEventListener('dblclick', (e) => {
    e.stopPropagation();
    gridFocusedSessionId = sessionId;
    toggleGridView();
  });
  footer.addEventListener('mousedown', (e) => {
    e.stopPropagation();
    focusGridCard(sessionId);
  });

  // Clicking/focusing the terminal area also selects the card
  entry.element.addEventListener('focusin', () => {
    if (gridViewActive && gridFocusedSessionId !== sessionId) {
      focusGridCard(sessionId);
    }
  });

  gridCards.set(sessionId, card);
  // Set initial status from the single source of truth
  updateRunningIndicators();
}

function unwrapGridCards() {
  for (const [sid, card] of gridCards) {
    const entry = openSessions.get(sid);
    if (entry) {
      entry.element.classList.remove('grid-mode', 'visible');
      // Move terminal container back out of the card, before the card
      card.parentNode.insertBefore(entry.element, card);
    }
    card.remove();
  }
  gridCards.clear();
  // Remove project headings inserted by showGridView
  terminalsEl.querySelectorAll('.grid-project-heading').forEach(el => el.remove());
}

function focusGridCard(sessionId) {
  gridFocusedSessionId = sessionId;
  setActiveSession(sessionId);
  clearNotifications(sessionId);
  // Update sidebar active highlight
  document.querySelectorAll('.session-item.active').forEach(el => el.classList.remove('active'));
  const sidebarItem = document.querySelector(`.session-item[data-session-id="${sessionId}"]`);
  if (sidebarItem) sidebarItem.classList.add('active');
  // Update visual focus
  document.querySelectorAll('.grid-card').forEach(c => c.classList.remove('focused'));
  const card = gridCards.get(sessionId);
  if (card) card.classList.add('focused');
  const entry = openSessions.get(sessionId);
  if (entry) entry.terminal.focus();
}

function showGridView() {
  gridViewActive = true;
  localStorage.setItem('gridViewActive', '1');
  placeholder.style.display = 'none';
  terminalHeader.style.display = 'none';

  // Hide other viewers but keep terminal-area visible
  planViewer.style.display = 'none';
  statsViewer.style.display = 'none';
  memoryViewer.style.display = 'none';
  settingsViewer.style.display = 'none';
  jsonlViewer.style.display = 'none';
  terminalArea.style.display = '';

  // Switch #terminals to grid layout
  terminalsEl.classList.add('grid-layout');

  // Collect open (non-closed) session IDs
  const openSet = new Set();
  for (const [sid, entry] of openSessions) {
    if (!entry.closed) openSet.add(sid);
  }

  // Use cachedProjects sorted by sortedOrder — same grouping & order as sidebar
  let projects = [...cachedProjects];
  if (sortedOrder.length > 0) {
    const orderIndex = new Map(sortedOrder.map((e, i) => [e.projectPath, i]));
    projects.sort((a, b) => {
      const aPos = orderIndex.get(a.projectPath);
      const bPos = orderIndex.get(b.projectPath);
      if (aPos !== undefined && bPos !== undefined) return aPos - bPos;
      if (aPos === undefined && bPos !== undefined) return -1;
      if (aPos !== undefined && bPos === undefined) return 1;
      return 0;
    });
  }

  // Hide all terminals first, then wrap each group with a heading + cards
  document.querySelectorAll('.terminal-container').forEach(el => el.classList.remove('visible'));
  const sessionIds = [];
  for (const project of projects) {
    const openInProject = project.sessions
      .filter(s => openSet.has(s.sessionId))
      .sort((a, b) => {
        const aRun = activePtyIds.has(a.sessionId) ? 1 : 0;
        const bRun = activePtyIds.has(b.sessionId) ? 1 : 0;
        if (aRun !== bRun) return bRun - aRun;
        const aTime = (lastActivityTime.get(a.sessionId) || new Date(0)).getTime();
        const bTime = (lastActivityTime.get(b.sessionId) || new Date(0)).getTime();
        return bTime - aTime;
      });
    if (openInProject.length === 0) continue;
    // Add project heading
    const heading = document.createElement('div');
    heading.className = 'grid-project-heading';
    heading.dataset.projectPath = project.projectPath;
    heading.textContent = project.projectPath.split('/').filter(Boolean).slice(-2).join('/');
    terminalsEl.appendChild(heading);
    // Add cards for this project
    for (const s of openInProject) {
      wrapInGridCard(s.sessionId);
      sessionIds.push(s.sessionId);
    }
  }

  // Show grid header bar with session count
  gridViewer.style.display = 'block';
  gridViewerCount.textContent = sessionIds.length + ' session' + (sessionIds.length !== 1 ? 's' : '');

  const btn = document.getElementById('grid-toggle-btn');
  if (btn) btn.classList.add('active');

  // Fit all terminals after layout resolves
  for (const sid of sessionIds) {
    const entry = openSessions.get(sid);
    if (entry) fitAndScroll(entry);
  }
  // Focus active or first (deferred so fitAndScroll's rAF runs first)
  requestAnimationFrame(() => {
    const toFocus = activeSessionId && sessionIds.includes(activeSessionId) ? activeSessionId : sessionIds[0];
    if (toFocus) focusGridCard(toFocus);
  });
}

function updateGridColumns() {
  if (!gridViewActive) return;
  const width = terminalsEl.clientWidth;
  const minCardWidth = 560;
  const gap = 14;
  const fitCols = Math.max(1, Math.floor((width + gap) / (minCardWidth + gap)));
  const cardCount = terminalsEl.querySelectorAll('.grid-card').length;
  const cols = Math.max(1, Math.min(fitCols, cardCount || 1));
  terminalsEl.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
}
new ResizeObserver(updateGridColumns).observe(terminalsEl);
new MutationObserver(updateGridColumns).observe(terminalsEl, { childList: true });

function hideGridView() {
  gridViewActive = false;
  localStorage.setItem('gridViewActive', '0');
  unwrapGridCards();
  terminalsEl.classList.remove('grid-layout');
  terminalsEl.style.gridTemplateColumns = '';
  gridViewer.style.display = 'none';
  const btn = document.getElementById('grid-toggle-btn');
  if (btn) btn.classList.remove('active');
}

function toggleGridView() {
  if (gridViewActive) {
    const restoreId = gridFocusedSessionId || activeSessionId;
    hideGridView();
    gridFocusedSessionId = null;
    if (restoreId && openSessions.has(restoreId)) {
      showSession(restoreId);
    } else {
      placeholder.style.display = '';
    }
  } else {
    terminalHeader.style.display = 'none';
    showGridView();
  }
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
let cachedUsage = null;

async function loadStats() {
  statsViewerBody.innerHTML = '';

  // Show spinner while refreshing
  const spinner = document.createElement('div');
  spinner.className = 'stats-spinner';
  spinner.innerHTML = `<div class="stats-spinner-icon"></div><span>Updating stats\u2026</span>`;
  statsViewerBody.appendChild(spinner);

  // Refresh stats cache via PTY (/stats + /usage)
  let stats, usage;
  try {
    const result = await window.api.refreshStats();
    stats = result?.stats;
    usage = result?.usage || {};
    cachedUsage = usage;
  } catch {
    // Fallback to cached stats
    stats = await window.api.getStats();
    usage = cachedUsage || {};
  }

  statsViewerBody.innerHTML = '';

  if (!stats && !Object.keys(usage).length) {
    statsViewerBody.innerHTML = '<div class="plans-empty">No stats data found. Run some Claude sessions first.</div>';
    return;
  }

  if (stats) {
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
  }

  // Build usage section below charts (from /usage output)
  if (Object.keys(usage).length) {
    buildUsageSection(usage);
  }

  if (stats) {
    const notice = document.createElement('div');
    notice.className = 'stats-notice';
    const lastDate = stats.lastComputedDate || 'unknown';
    notice.innerHTML = `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" style="vertical-align:-2px;margin-right:6px;flex-shrink:0"><circle cx="8" cy="8" r="7"/><line x1="8" y1="5" x2="8" y2="9"/><circle cx="8" cy="11.5" r="0.5" fill="currentColor" stroke="none"/></svg>Data sourced from Claude\u2019s stats cache (last updated ${escapeHtml(lastDate)}).`;
    statsViewerBody.appendChild(notice);
  }
}

function buildUsageSection(usage) {
  // Remove existing usage container if present (for refresh)
  const existing = statsViewerBody.querySelector('.usage-container');
  if (existing) existing.remove();

  const container = document.createElement('div');
  container.className = 'usage-container';

  const titleRow = document.createElement('div');
  titleRow.className = 'usage-title-row';
  const title = document.createElement('div');
  title.className = 'daily-chart-title';
  title.textContent = 'Rate Limits';
  titleRow.appendChild(title);

  const refreshBtn = document.createElement('button');
  refreshBtn.className = 'usage-refresh-btn';
  refreshBtn.innerHTML = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/></svg>';
  refreshBtn.title = 'Refresh usage';
  refreshBtn.onclick = async () => {
    refreshBtn.classList.add('usage-refresh-spinning');
    refreshBtn.disabled = true;
    try {
      const freshUsage = await window.api.getUsage();
      if (freshUsage && Object.keys(freshUsage).length) {
        cachedUsage = freshUsage;
        buildUsageSection(freshUsage);
      }
    } catch {}
    refreshBtn.classList.remove('usage-refresh-spinning');
    refreshBtn.disabled = false;
  };
  titleRow.appendChild(refreshBtn);
  container.appendChild(titleRow);

  // Show rate limit or error notice
  if (usage._rateLimited || usage._error) {
    const notice = document.createElement('div');
    notice.className = 'usage-rate-limited';
    if (usage._rateLimited) {
      const secs = usage.retryAfterSeconds || 0;
      const mins = Math.ceil(secs / 60);
      notice.textContent = secs > 0
        ? `Usage API rate limited. Try again in ~${mins} min${mins !== 1 ? 's' : ''}.`
        : 'Usage API rate limited. Try again later.';
    } else {
      notice.textContent = usage.message || 'Could not fetch usage data.';
    }
    container.appendChild(notice);
    const statsNotice = statsViewerBody.querySelector('.stats-notice');
    if (statsNotice) statsViewerBody.insertBefore(container, statsNotice);
    else statsViewerBody.appendChild(container);
    return;
  }

  const grid = document.createElement('div');
  grid.className = 'usage-grid';

  const items = [
    { key: 'session', label: 'Current session', resetKey: 'sessionReset' },
    { key: 'weekAll', label: 'Week (all models)', resetKey: 'weekAllReset' },
    { key: 'weekSonnet', label: 'Week (Sonnet)', resetKey: 'weekSonnetReset' },
    { key: 'weekOpus', label: 'Week (Opus)', resetKey: 'weekOpusReset' },
  ];

  for (const item of items) {
    if (usage[item.key] === undefined) continue;
    const pct = usage[item.key];
    const card = document.createElement('div');
    card.className = 'usage-card';

    const header = document.createElement('div');
    header.className = 'usage-card-header';
    const label = document.createElement('span');
    label.className = 'usage-card-label';
    label.textContent = item.label;
    header.appendChild(label);
    const pctEl = document.createElement('span');
    pctEl.className = 'usage-card-pct';
    pctEl.textContent = pct + '%';
    header.appendChild(pctEl);
    card.appendChild(header);

    const track = document.createElement('div');
    track.className = 'usage-track';
    const fill = document.createElement('div');
    fill.className = 'usage-fill' + (pct >= 80 ? ' usage-fill-high' : '');
    fill.style.width = Math.max(pct, 1) + '%';
    track.appendChild(fill);
    card.appendChild(track);

    if (usage[item.resetKey]) {
      const reset = document.createElement('div');
      reset.className = 'usage-card-reset';
      reset.textContent = 'Resets ' + usage[item.resetKey];
      card.appendChild(reset);
    }

    grid.appendChild(card);
  }

  container.appendChild(grid);
  // Insert before the stats notice footer if it exists, otherwise append
  const statsNotice = statsViewerBody.querySelector('.stats-notice');
  if (statsNotice) statsViewerBody.insertBefore(container, statsNotice);
  else statsViewerBody.appendChild(container);
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

// --- Memory ---
let cachedMemoryData = { global: { files: [] }, projects: [] };
let memoryEditorView = null;
let currentMemoryFilePath = null;
let currentMemoryContent = '';
let memoryPreviewMode = localStorage.getItem('memoryPreviewMode') === 'true';
const memoryCollapsedState = new Map(); // key → boolean (true = collapsed)

async function loadMemories() {
  cachedMemoryData = await window.api.getMemories();
  renderMemories();
}

function renderMemories(filterIds) {
  memoryContent.innerHTML = '';
  const data = cachedMemoryData;
  const allFiles = [...data.global.files, ...data.projects.flatMap(p => p.files)];
  if (allFiles.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'plans-empty';
    empty.textContent = 'No memory files found.';
    memoryContent.appendChild(empty);
    return;
  }

  // Global group
  if (data.global.files.length > 0) {
    const globalFiles = filterIds ? data.global.files.filter(f => filterIds.has(f.filePath)) : data.global.files;
    if (globalFiles.length > 0) {
      memoryContent.appendChild(buildMemoryGroup('__global__', 'Global', globalFiles));
    }
  }

  // Per-project groups
  for (const proj of data.projects) {
    const projFiles = filterIds ? proj.files.filter(f => filterIds.has(f.filePath)) : proj.files;
    if (projFiles.length === 0) continue;
    memoryContent.appendChild(buildMemoryGroup(proj.folder, proj.shortName, projFiles));
  }
}

function buildMemoryGroup(key, label, files) {
  const group = document.createElement('div');
  group.className = 'project-group';
  const isCollapsed = memoryCollapsedState.get(key) === true; // default expanded
  if (isCollapsed) group.classList.add('collapsed');

  // Header
  const header = document.createElement('div');
  header.className = 'project-header';

  const arrow = document.createElement('span');
  arrow.className = 'arrow';
  arrow.innerHTML = '&#9660;';
  header.appendChild(arrow);

  const nameSpan = document.createElement('span');
  nameSpan.className = 'project-name';
  nameSpan.textContent = label;
  header.appendChild(nameSpan);

  const countBadge = document.createElement('span');
  countBadge.className = 'memory-file-count';
  countBadge.textContent = files.length;
  header.appendChild(countBadge);

  header.addEventListener('click', () => {
    const nowCollapsed = !group.classList.contains('collapsed');
    group.classList.toggle('collapsed');
    memoryCollapsedState.set(key, nowCollapsed);
  });

  group.appendChild(header);

  // Files list
  const filesList = document.createElement('div');
  filesList.className = 'project-sessions';
  for (const file of files) {
    filesList.appendChild(buildMemoryItem(file));
  }
  group.appendChild(filesList);

  return group;
}

function buildMemoryItem(file) {
  const item = document.createElement('div');
  item.className = 'session-item memory-item';
  item.dataset.filepath = file.filePath;

  const row = document.createElement('div');
  row.className = 'session-row';

  // Brain icon (same position as session pin)
  const brain = document.createElement('span');
  brain.className = 'memory-brain-icon';
  brain.innerHTML = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z"/><path d="M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z"/><path d="M15 13a4.5 4.5 0 0 1-3-4 4.5 4.5 0 0 1-3 4"/><path d="M17.599 6.5a3 3 0 0 0 .399-1.375"/><path d="M6.003 5.125A3 3 0 0 0 6.401 6.5"/><path d="M3.477 10.896a4 4 0 0 1 .585-.396"/><path d="M19.938 10.5a4 4 0 0 1 .585.396"/><path d="M6 18a4 4 0 0 1-1.967-.516"/><path d="M19.967 17.484A4 4 0 0 1 18 18"/></svg>';
  row.appendChild(brain);

  const info = document.createElement('div');
  info.className = 'session-info';

  const titleEl = document.createElement('div');
  titleEl.className = 'session-summary';
  titleEl.textContent = file.filename;

  const pathEl = document.createElement('div');
  pathEl.className = 'session-id';
  pathEl.textContent = file.displayPath;

  const metaEl = document.createElement('div');
  metaEl.className = 'session-meta';
  metaEl.textContent = formatDate(new Date(file.modified));

  info.appendChild(titleEl);
  info.appendChild(pathEl);
  info.appendChild(metaEl);
  row.appendChild(info);
  item.appendChild(row);

  item.addEventListener('click', () => openMemory(file));
  return item;
}

async function openMemory(file) {
  // Mark active in sidebar
  memoryContent.querySelectorAll('.memory-item.active').forEach(el => el.classList.remove('active'));
  const target = memoryContent.querySelector(`.memory-item[data-filepath="${CSS.escape(file.filePath)}"]`);
  if (target) target.classList.add('active');

  const content = await window.api.readMemory(file.filePath);
  currentMemoryFilePath = file.filePath;
  currentMemoryContent = content;

  // Show memory viewer in main area
  placeholder.style.display = 'none';
  terminalArea.style.display = 'none';
  planViewer.style.display = 'none';
  statsViewer.style.display = 'none';
  settingsViewer.style.display = 'none';
  memoryViewer.style.display = 'flex';

  memoryViewerTitle.textContent = file.filename;
  memoryViewerFilename.textContent = file.filePath;

  // Reset to edit mode first so the editor can be updated
  if (memoryPreviewMode) {
    toggleMarkdownPreview({
      editorEl: memoryViewerEditorEl, previewEl: memoryViewerPreviewEl,
      toggleBtn: memoryPreviewBtn, editorView: memoryEditorView, isPreview: true,
    });
  }

  // Create or update CodeMirror editor
  if (!memoryEditorView) {
    memoryEditorView = window.createPlanEditor(memoryViewerEditorEl);
  }
  memoryEditorView.dispatch({
    changes: { from: 0, to: memoryEditorView.state.doc.length, insert: content },
  });

  // Apply saved preview preference
  if (memoryPreviewMode) {
    toggleMarkdownPreview({
      editorEl: memoryViewerEditorEl, previewEl: memoryViewerPreviewEl,
      toggleBtn: memoryPreviewBtn, editorView: memoryEditorView, isPreview: false,
    });
  }
}

// Memory toolbar handlers
memoryCopyPathBtn.addEventListener('click', () => {
  navigator.clipboard.writeText(currentMemoryFilePath);
  flashButtonText(memoryCopyPathBtn, 'Copied!');
});

memoryCopyContentBtn.addEventListener('click', () => {
  const content = memoryEditorView ? memoryEditorView.state.doc.toString() : currentMemoryContent;
  navigator.clipboard.writeText(content);
  flashButtonText(memoryCopyContentBtn, 'Copied!');
});

memorySaveBtn.addEventListener('click', async () => {
  if (memoryEditorView && currentMemoryFilePath) {
    currentMemoryContent = memoryEditorView.state.doc.toString();
    await window.api.saveMemory(currentMemoryFilePath, currentMemoryContent);
    flashButtonText(memorySaveBtn, 'Saved!');
  }
});

memoryPreviewBtn.addEventListener('click', () => {
  memoryPreviewMode = toggleMarkdownPreview({
    editorEl: memoryViewerEditorEl,
    previewEl: memoryViewerPreviewEl,
    toggleBtn: memoryPreviewBtn,
    editorView: memoryEditorView,
    isPreview: memoryPreviewMode,
    storageKey: 'memoryPreviewMode',
  });
});

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
  claudeBtn.innerHTML = '<svg class="popover-option-icon claude-icon" width="16" height="16" viewBox="0 0 1200 1200" fill="#d97757" stroke="none"><path d="M 233.959793 800.214905 L 468.644287 668.536987 L 472.590637 657.100647 L 468.644287 650.738403 L 457.208069 650.738403 L 417.986633 648.322144 L 283.892639 644.69812 L 167.597321 639.865845 L 54.926208 633.825623 L 26.577238 627.785339 L 3.3e-05 592.751709 L 2.73832 575.27533 L 26.577238 559.248352 L 60.724873 562.228149 L 136.187973 567.382629 L 249.422867 575.194763 L 331.570496 580.026978 L 453.261841 592.671082 L 472.590637 592.671082 L 475.328857 584.859009 L 468.724915 580.026978 L 463.570557 575.194763 L 346.389313 495.785217 L 219.543671 411.865906 L 153.100723 363.543762 L 117.181267 339.060425 L 99.060455 316.107361 L 91.248367 266.01355 L 123.865784 230.093994 L 167.677887 233.073853 L 178.872513 236.053772 L 223.248367 270.201477 L 318.040283 343.570496 L 441.825592 434.738342 L 459.946411 449.798706 L 467.194672 444.64447 L 468.080597 441.020203 L 459.946411 427.409485 L 392.617493 305.718323 L 320.778564 181.932983 L 288.80542 130.630859 L 280.348999 99.865845 C 277.369171 87.221436 275.194641 76.590698 275.194641 63.624268 L 312.322174 13.20813 L 332.8591 6.604126 L 382.389313 13.20813 L 403.248352 31.328979 L 434.013519 101.71814 L 483.865753 212.537048 L 561.181274 363.221497 L 583.812134 407.919434 L 595.892639 449.315491 L 600.40271 461.959839 L 608.214783 461.959839 L 608.214783 454.711609 L 614.577271 369.825623 L 626.335632 265.61084 L 637.771851 131.516846 L 641.718201 93.745117 L 660.402832 48.483276 L 697.530334 24.000122 L 726.52356 37.852417 L 750.362549 72 L 747.060486 94.067139 L 732.886047 186.201416 L 705.100708 330.52356 L 686.979919 427.167847 L 697.530334 427.167847 L 709.61084 415.087341 L 758.496704 350.174561 L 840.644348 247.490051 L 876.885925 206.738342 L 919.167847 161.71814 L 946.308838 140.29541 L 997.61084 140.29541 L 1035.38269 196.429626 L 1018.469849 254.416199 L 965.637634 321.422852 L 921.825562 378.201538 L 859.006714 462.765259 L 819.785278 530.41626 L 823.409424 535.812073 L 832.75177 534.92627 L 974.657776 504.724915 L 1051.328979 490.872559 L 1142.818848 475.167786 L 1184.214844 494.496582 L 1188.724854 514.147644 L 1172.456421 554.335693 L 1074.604126 578.496765 L 959.838989 601.449829 L 788.939636 641.879272 L 786.845764 643.409485 L 789.261841 646.389343 L 866.255127 653.637634 L 899.194702 655.409424 L 979.812134 655.409424 L 1129.932861 666.604187 L 1169.154419 692.537109 L 1192.671265 724.268677 L 1188.724854 748.429688 L 1128.322144 779.194641 L 1046.818848 759.865845 L 856.590759 714.604126 L 791.355774 698.335754 L 782.335693 698.335754 L 782.335693 703.731567 L 836.69812 756.885986 L 936.322205 846.845581 L 1061.073975 962.81897 L 1067.436279 991.490112 L 1051.409424 1014.120911 L 1034.496704 1011.704712 L 924.885986 929.234924 L 882.604126 892.107544 L 786.845764 811.48999 L 780.483276 811.48999 L 780.483276 819.946289 L 802.550415 852.241699 L 919.087341 1027.409424 L 925.127625 1081.127686 L 916.671204 1098.604126 L 886.469849 1109.154419 L 853.288696 1103.114136 L 785.073914 1007.355835 L 714.684631 899.516785 L 657.906067 802.872498 L 650.979858 806.81897 L 617.476624 1167.704834 L 601.771851 1186.147705 L 565.530212 1200 L 535.328857 1177.046997 L 519.302124 1139.919556 L 535.328857 1066.550537 L 554.657776 970.792053 L 570.362488 894.68457 L 584.536926 800.134277 L 592.993347 768.724976 L 592.429626 766.630859 L 585.503479 767.516968 L 514.22821 865.369263 L 405.825531 1011.865906 L 320.053711 1103.677979 L 299.516815 1111.812256 L 263.919525 1093.369263 L 267.221497 1060.429688 L 287.114136 1031.114136 L 405.825531 880.107361 L 477.422913 786.52356 L 523.651062 732.483276 L 523.328918 724.671265 L 520.590698 724.671265 L 205.288605 929.395935 L 149.154434 936.644409 L 124.993355 914.01355 L 127.973183 876.885986 L 139.409409 864.80542 L 234.201385 799.570435 L 233.879227 799.8927 Z"/></svg> Claude';
  claudeBtn.onclick = async () => { popover.remove(); launchNewSession(project, await resolveDefaultSessionOptions(project)); };

  const claudeOptsBtn = document.createElement('button');
  claudeOptsBtn.className = 'popover-option';
  claudeOptsBtn.innerHTML = '<svg class="popover-option-icon claude-icon" width="16" height="16" viewBox="0 0 1200 1200" fill="#d97757" stroke="none"><path d="M 233.959793 800.214905 L 468.644287 668.536987 L 472.590637 657.100647 L 468.644287 650.738403 L 457.208069 650.738403 L 417.986633 648.322144 L 283.892639 644.69812 L 167.597321 639.865845 L 54.926208 633.825623 L 26.577238 627.785339 L 3.3e-05 592.751709 L 2.73832 575.27533 L 26.577238 559.248352 L 60.724873 562.228149 L 136.187973 567.382629 L 249.422867 575.194763 L 331.570496 580.026978 L 453.261841 592.671082 L 472.590637 592.671082 L 475.328857 584.859009 L 468.724915 580.026978 L 463.570557 575.194763 L 346.389313 495.785217 L 219.543671 411.865906 L 153.100723 363.543762 L 117.181267 339.060425 L 99.060455 316.107361 L 91.248367 266.01355 L 123.865784 230.093994 L 167.677887 233.073853 L 178.872513 236.053772 L 223.248367 270.201477 L 318.040283 343.570496 L 441.825592 434.738342 L 459.946411 449.798706 L 467.194672 444.64447 L 468.080597 441.020203 L 459.946411 427.409485 L 392.617493 305.718323 L 320.778564 181.932983 L 288.80542 130.630859 L 280.348999 99.865845 C 277.369171 87.221436 275.194641 76.590698 275.194641 63.624268 L 312.322174 13.20813 L 332.8591 6.604126 L 382.389313 13.20813 L 403.248352 31.328979 L 434.013519 101.71814 L 483.865753 212.537048 L 561.181274 363.221497 L 583.812134 407.919434 L 595.892639 449.315491 L 600.40271 461.959839 L 608.214783 461.959839 L 608.214783 454.711609 L 614.577271 369.825623 L 626.335632 265.61084 L 637.771851 131.516846 L 641.718201 93.745117 L 660.402832 48.483276 L 697.530334 24.000122 L 726.52356 37.852417 L 750.362549 72 L 747.060486 94.067139 L 732.886047 186.201416 L 705.100708 330.52356 L 686.979919 427.167847 L 697.530334 427.167847 L 709.61084 415.087341 L 758.496704 350.174561 L 840.644348 247.490051 L 876.885925 206.738342 L 919.167847 161.71814 L 946.308838 140.29541 L 997.61084 140.29541 L 1035.38269 196.429626 L 1018.469849 254.416199 L 965.637634 321.422852 L 921.825562 378.201538 L 859.006714 462.765259 L 819.785278 530.41626 L 823.409424 535.812073 L 832.75177 534.92627 L 974.657776 504.724915 L 1051.328979 490.872559 L 1142.818848 475.167786 L 1184.214844 494.496582 L 1188.724854 514.147644 L 1172.456421 554.335693 L 1074.604126 578.496765 L 959.838989 601.449829 L 788.939636 641.879272 L 786.845764 643.409485 L 789.261841 646.389343 L 866.255127 653.637634 L 899.194702 655.409424 L 979.812134 655.409424 L 1129.932861 666.604187 L 1169.154419 692.537109 L 1192.671265 724.268677 L 1188.724854 748.429688 L 1128.322144 779.194641 L 1046.818848 759.865845 L 856.590759 714.604126 L 791.355774 698.335754 L 782.335693 698.335754 L 782.335693 703.731567 L 836.69812 756.885986 L 936.322205 846.845581 L 1061.073975 962.81897 L 1067.436279 991.490112 L 1051.409424 1014.120911 L 1034.496704 1011.704712 L 924.885986 929.234924 L 882.604126 892.107544 L 786.845764 811.48999 L 780.483276 811.48999 L 780.483276 819.946289 L 802.550415 852.241699 L 919.087341 1027.409424 L 925.127625 1081.127686 L 916.671204 1098.604126 L 886.469849 1109.154419 L 853.288696 1103.114136 L 785.073914 1007.355835 L 714.684631 899.516785 L 657.906067 802.872498 L 650.979858 806.81897 L 617.476624 1167.704834 L 601.771851 1186.147705 L 565.530212 1200 L 535.328857 1177.046997 L 519.302124 1139.919556 L 535.328857 1066.550537 L 554.657776 970.792053 L 570.362488 894.68457 L 584.536926 800.134277 L 592.993347 768.724976 L 592.429626 766.630859 L 585.503479 767.516968 L 514.22821 865.369263 L 405.825531 1011.865906 L 320.053711 1103.677979 L 299.516815 1111.812256 L 263.919525 1093.369263 L 267.221497 1060.429688 L 287.114136 1031.114136 L 405.825531 880.107361 L 477.422913 786.52356 L 523.651062 732.483276 L 523.328918 724.671265 L 520.590698 724.671265 L 205.288605 929.395935 L 149.154434 936.644409 L 124.993355 914.01355 L 127.973183 876.885986 L 139.409409 864.80542 L 234.201385 799.570435 L 233.879227 799.8927 Z"/></svg> Claude (Configure...)';
  claudeOptsBtn.onclick = () => { popover.remove(); showNewSessionDialog(project); };

  const termBtn = document.createElement('button');
  termBtn.className = 'popover-option popover-option-terminal';
  termBtn.innerHTML = '<svg class="popover-option-icon terminal-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"/></svg> Terminal';
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
    if (effective.mcpEmulation === false) options.mcpEmulation = false;
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
function closeSettingsViewer() {
  settingsViewer.style.display = 'none';
  if (activeSessionId && openSessions.has(activeSessionId)) {
    terminalArea.style.display = '';
    terminalHeader.style.display = '';
  } else if (gridViewActive) {
    terminalArea.style.display = '';
  } else {
    placeholder.style.display = '';
  }
}

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
  memoryViewer.style.display = 'none';
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
  const shellProfileValue = fieldValue('shellProfile', 'auto');

  // Discover available shell profiles
  let shellProfiles = [];
  try { shellProfiles = await window.api.getShellProfiles(); } catch {};

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
            <span class="settings-label">Shell Profile</span>
            ${useGlobalCheckbox('shellProfile')}
          </div>
          <div class="settings-hint">Shell used for terminal and Claude sessions. Changes take effect for new sessions only.</div>
          <select class="settings-select" id="sv-shell-profile" ${fieldDisabled('shellProfile')}>
            <option value="auto" ${shellProfileValue === 'auto' ? 'selected' : ''}>Auto (detect)</option>
            ${shellProfiles.map(p =>
              `<option value="${escapeHtml(p.id)}" ${shellProfileValue === p.id ? 'selected' : ''}>${escapeHtml(p.name)}</option>`
            ).join('')}
          </select>
        </div>

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

      ${!isProject ? `<div class="settings-section settings-updates-section">
        <div class="settings-section-title">Updates</div>
        <div class="settings-updates-row">
          <span class="settings-current-version" id="sv-current-version"></span>
          <span class="settings-update-status" id="sv-update-status"></span>
          <button class="settings-check-updates-btn" id="sv-check-updates-btn">Check for Updates</button>
        </div>
      </div>` : ''}

      <div class="settings-btn-row">
        <button class="settings-cancel-btn" id="sv-cancel-btn">Cancel</button>
        <button class="settings-save-btn" id="sv-save-btn">Save Settings</button>
      </div>
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
        shellProfile: 'sv-shell-profile',
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
            shellProfile: () => settingsViewerBody.querySelector('#sv-shell-profile').value || 'auto',
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
      settings.shellProfile = settingsViewerBody.querySelector('#sv-shell-profile').value || 'auto';
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
          entry.element.style.backgroundColor = TERMINAL_THEME.background;
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

    closeSettingsViewer();
  });

  // Cancel button
  settingsViewerBody.querySelector('#sv-cancel-btn').addEventListener('click', () => {
    closeSettingsViewer();
  });

  // Check for updates button + current version + inline status
  const checkUpdatesBtn = settingsViewerBody.querySelector('#sv-check-updates-btn');
  if (checkUpdatesBtn) {
    const updateStatusEl = settingsViewerBody.querySelector('#sv-update-status');
    window.api.getAppVersion().then(v => {
      const el = settingsViewerBody.querySelector('#sv-current-version');
      if (el) el.textContent = `v${v}`;
    });
    const settingsUpdaterHandler = (type, data) => {
      if (!updateStatusEl) return;
      switch (type) {
        case 'checking': updateStatusEl.textContent = '— checking…'; break;
        case 'update-available': updateStatusEl.textContent = `— v${data.version} available`; break;
        case 'update-not-available': updateStatusEl.textContent = '— up to date'; break;
        case 'download-progress': updateStatusEl.textContent = `— downloading ${Math.round(data.percent)}%`; break;
        case 'update-downloaded': updateStatusEl.textContent = `— v${data.version} ready, restart to update`; break;
        case 'error': updateStatusEl.textContent = '— check failed'; break;
      }
    };
    window.api.onUpdaterEvent(settingsUpdaterHandler);
    checkUpdatesBtn.addEventListener('click', () => {
      window.api.updaterCheck();
    });
  }

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
globalSettingsBtn.innerHTML = ICONS.gear(18);
globalSettingsBtn.addEventListener('click', () => {
  openSettingsViewer('global');
});

// Add project button
addProjectBtn.addEventListener('click', () => {
  showAddProjectDialog();
});

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

loadProjects().then(() => {
  // Restore grid view preference before opening sessions so they enter grid mode
  if (localStorage.getItem('gridViewActive') === '1') {
    showGridView();
  }
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

// --- Initialize file panel (MCP bridge UI) ---
if (typeof initFilePanel === 'function') initFilePanel();
