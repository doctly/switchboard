const terminalsEl = document.getElementById('terminals');
const sidebarContent = document.getElementById('sidebar-content');
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

// Map<sessionId, { terminal, element, ws, fitAddon, session }>
const openSessions = new Map();
let activeSessionId = null;
let showArchived = false;
let showStarredOnly = false;
let cachedProjects = [];
let cachedAllProjects = [];
let activePtyIds = new Set();

// --- Archive toggle ---
archiveToggle.addEventListener('click', () => {
  showArchived = !showArchived;
  archiveToggle.classList.toggle('active', showArchived);
  renderProjects(showArchived ? cachedAllProjects : cachedProjects);
});

// --- Star filter toggle ---
starToggle.addEventListener('click', () => {
  showStarredOnly = !showStarredOnly;
  starToggle.classList.toggle('active', showStarredOnly);
  renderProjects(showArchived ? cachedAllProjects : cachedProjects);
});

// --- Search ---
searchInput.addEventListener('input', () => {
  const query = searchInput.value.trim();
  renderProjects(query ? cachedAllProjects : (showArchived ? cachedAllProjects : cachedProjects));
});

// --- Terminal header controls ---
terminalStopBtn.addEventListener('click', async () => {
  if (!activeSessionId) return;
  await fetch(`/api/sessions/${activeSessionId}/stop`, { method: 'POST' });
  pollActiveSessions();
});

terminalRestartBtn.addEventListener('click', () => {
  if (!activeSessionId) return;
  const entry = openSessions.get(activeSessionId);
  if (!entry) return;
  // Tear down and reopen
  entry.terminal.dispose();
  entry.element.remove();
  openSessions.delete(activeSessionId);
  openSession(entry.session);
});

// --- Poll for active PTY sessions ---
async function pollActiveSessions() {
  try {
    const res = await fetch('/api/sessions/active');
    const ids = await res.json();
    activePtyIds = new Set(ids);
    updateRunningIndicators();
    updateTerminalHeader();
  } catch {}
}

function updateRunningIndicators() {
  document.querySelectorAll('.session-status-dot').forEach(dot => {
    const id = dot.dataset.sessionId;
    dot.classList.toggle('running', activePtyIds.has(id));
  });
}

function updateTerminalHeader() {
  if (!activeSessionId) return;
  const running = activePtyIds.has(activeSessionId);
  terminalHeaderStatus.className = running ? 'running' : 'stopped';
  terminalHeaderStatus.textContent = running ? 'Running' : 'Stopped';
  terminalStopBtn.style.display = running ? '' : 'none';
  terminalRestartBtn.style.display = running ? 'none' : '';
}

setInterval(pollActiveSessions, 3000);

// Shared session map so all caches reference the same objects
const sessionMap = new Map();

function dedup(projects) {
  for (const p of projects) {
    for (let i = 0; i < p.sessions.length; i++) {
      const s = p.sessions[i];
      if (sessionMap.has(s.sessionId)) {
        // Merge new data into existing object so all references stay in sync
        Object.assign(sessionMap.get(s.sessionId), s);
        p.sessions[i] = sessionMap.get(s.sessionId);
      } else {
        sessionMap.set(s.sessionId, s);
      }
    }
  }
}

async function loadProjects() {
  const [resDefault, resArchived] = await Promise.all([
    fetch('/api/projects'),
    fetch('/api/projects?archived=1'),
  ]);
  cachedProjects = await resDefault.json();
  cachedAllProjects = await resArchived.json();
  dedup(cachedProjects);
  dedup(cachedAllProjects);
  await pollActiveSessions();
  renderProjects(cachedProjects);
}

function renderProjects(projects) {
  const query = searchInput.value.trim().toLowerCase();

  sidebarContent.innerHTML = '';

  for (const project of projects) {
    let filtered = project.sessions;
    if (showStarredOnly) {
      filtered = filtered.filter(s => s.starred);
    }
    if (query) {
      filtered = filtered.filter(s => {
        const name = (s.name || '').toLowerCase();
        const summary = (s.summary || '').toLowerCase();
        const prompt = (s.firstPrompt || '').toLowerCase();
        const id = s.sessionId.toLowerCase();
        return name.includes(query) || summary.includes(query) || prompt.includes(query) || id.includes(query);
      });
    }

    if (filtered.length === 0) continue;

    const group = document.createElement('div');
    group.className = 'project-group';

    const header = document.createElement('div');
    header.className = 'project-header';
    const shortName = project.projectPath.split('/').filter(Boolean).slice(-2).join('/');
    header.innerHTML = `<span class="arrow">&#9660;</span> <span class="project-name">${shortName}</span>`;

    const newBtn = document.createElement('button');
    newBtn.className = 'project-new-btn';
    newBtn.textContent = '+';
    newBtn.title = 'New session';
    newBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      openNewSession(project);
    });
    header.appendChild(newBtn);

    header.addEventListener('click', (e) => {
      if (e.target === newBtn) return;
      header.classList.toggle('collapsed');
    });

    const sessionsList = document.createElement('div');
    sessionsList.className = 'project-sessions';

    for (const session of filtered) {
      const item = buildSessionItem(session);
      sessionsList.appendChild(item);
    }

    group.appendChild(header);
    group.appendChild(sessionsList);
    sidebarContent.appendChild(group);
  }
}

function buildSessionItem(session) {
  const item = document.createElement('div');
  item.className = 'session-item';
  if (session.archived) item.classList.add('archived-item');
  item.dataset.sessionId = session.sessionId;

  const modified = new Date(session.modified);
  const timeStr = formatDate(modified);
  const displayName = session.name || session.summary;

  // Row: star + status dot + info + archive button
  const row = document.createElement('div');
  row.className = 'session-row';

  // Star
  const star = document.createElement('span');
  star.className = 'session-star' + (session.starred ? ' starred' : '');
  star.textContent = session.starred ? '\u2605' : '\u2606';
  star.addEventListener('click', async (e) => {
    e.stopPropagation();
    const res = await fetch(`/api/sessions/${session.sessionId}/star`, { method: 'POST' });
    const { starred } = await res.json();
    session.starred = starred;
    star.classList.toggle('starred', !!starred);
    star.textContent = starred ? '\u2605' : '\u2606';
  });

  // Running status dot
  const dot = document.createElement('span');
  dot.className = 'session-status-dot' + (activePtyIds.has(session.sessionId) ? ' running' : '');
  dot.dataset.sessionId = session.sessionId;

  // Info block
  const info = document.createElement('div');
  info.className = 'session-info';

  const summaryEl = document.createElement('div');
  summaryEl.className = 'session-summary';
  summaryEl.textContent = displayName;

  // Double-click to rename
  summaryEl.addEventListener('dblclick', (e) => {
    e.stopPropagation();
    startRename(summaryEl, session);
  });

  const idEl = document.createElement('div');
  idEl.className = 'session-id';
  idEl.textContent = session.sessionId;

  const metaEl = document.createElement('div');
  metaEl.className = 'session-meta';
  metaEl.textContent = timeStr + (session.messageCount ? ' \u00b7 ' + session.messageCount + ' msgs' : '');

  info.appendChild(summaryEl);
  info.appendChild(idEl);
  info.appendChild(metaEl);

  // Archive button
  const archiveBtn = document.createElement('button');
  archiveBtn.className = 'session-archive-btn';
  archiveBtn.title = session.archived ? 'Unarchive' : 'Archive';
  archiveBtn.textContent = session.archived ? '\u21A9' : '\u2716';
  archiveBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    const newVal = session.archived ? 0 : 1;
    await fetch(`/api/sessions/${session.sessionId}/archive`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ archived: newVal }),
    });
    session.archived = newVal;
    if (!showArchived && newVal) {
      item.remove();
    } else {
      item.classList.toggle('archived-item', !!newVal);
      archiveBtn.title = newVal ? 'Unarchive' : 'Archive';
      archiveBtn.textContent = newVal ? '\u21A9' : '\u2716';
    }
  });

  row.appendChild(star);
  row.appendChild(dot);
  row.appendChild(info);
  row.appendChild(archiveBtn);
  item.appendChild(row);

  item.addEventListener('click', () => openSession(session));
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
    await fetch(`/api/sessions/${session.sessionId}/rename`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: nameToSave }),
    });
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

function openNewSession(project) {
  const tempId = 'new-' + crypto.randomUUID();
  const projectPath = project.projectPath;
  const session = {
    sessionId: tempId,
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

  // Update sidebar
  document.querySelectorAll('.session-item.active').forEach(el => el.classList.remove('active'));
  document.querySelectorAll('.terminal-container').forEach(el => el.classList.remove('visible'));
  placeholder.style.display = 'none';
  activeSessionId = tempId;
  showTerminalHeader(session);

  // Create terminal
  const container = document.createElement('div');
  container.className = 'terminal-container visible';
  terminalsEl.appendChild(container);

  const terminal = new Terminal({
    fontSize: 14,
    fontFamily: "'SF Mono', 'Fira Code', 'Cascadia Code', Menlo, monospace",
    theme: {
      background: '#1a1a2e',
      foreground: '#e0e0e0',
      cursor: '#e94560',
      selectionBackground: '#3a3a5e',
    },
    cursorBlink: true,
    scrollback: 10000,
    convertEol: true,
  });

  const fitAddon = new FitAddon.FitAddon();
  terminal.loadAddon(fitAddon);
  terminal.open(container);
  fitAddon.fit();

  const wsProtocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${wsProtocol}//${location.host}/ws?sessionId=${encodeURIComponent(tempId)}&projectPath=${encodeURIComponent(projectPath)}&new=1`;
  const ws = new WebSocket(wsUrl);

  ws.onopen = () => {
    ws.send(JSON.stringify({ type: 'resize', cols: terminal.cols, rows: terminal.rows }));
  };

  ws.onmessage = (event) => {
    // Check for session ID detection message
    if (typeof event.data === 'string' && event.data.startsWith('{')) {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === 'session-detected') {
          session.sessionId = msg.sessionId;
          activeSessionId = msg.sessionId;
          // Re-key in openSessions
          const entry = openSessions.get(tempId);
          if (entry) {
            openSessions.delete(tempId);
            openSessions.set(msg.sessionId, entry);
            entry.session = session;
          }
          terminalHeaderId.textContent = msg.sessionId;
          terminalHeaderName.textContent = 'New session';
          // Refresh sidebar to show the new session, then select it
          loadProjects().then(() => {
            const item = document.querySelector(`[data-session-id="${msg.sessionId}"]`);
            if (item) {
              document.querySelectorAll('.session-item.active').forEach(el => el.classList.remove('active'));
              item.classList.add('active');
            }
          });
          pollActiveSessions();
          return;
        }
      } catch {}
    }
    terminal.write(event.data);
  };

  ws.onclose = () => {
    terminal.write('\r\n[Connection closed]\r\n');
    const entry = openSessions.get(session.sessionId) || openSessions.get(tempId);
    if (entry) entry.closed = true;
    pollActiveSessions();
  };

  terminal.onData(data => {
    if (ws.readyState === WebSocket.OPEN) ws.send(data);
  });

  terminal.onResize(({ cols, rows }) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'resize', cols, rows }));
    }
  });

  const entry = { terminal, element: container, ws, fitAddon, session };
  openSessions.set(tempId, entry);
  terminal.focus();
  pollActiveSessions();
}

function showTerminalHeader(session) {
  const displayName = session.name || session.summary;
  terminalHeaderName.textContent = displayName;
  terminalHeaderId.textContent = session.sessionId;
  terminalHeader.style.display = '';
  updateTerminalHeader();
}

function openSession(session) {
  const { sessionId, projectPath } = session;

  // Update sidebar active state
  document.querySelectorAll('.session-item.active').forEach(el => el.classList.remove('active'));
  const item = document.querySelector(`[data-session-id="${sessionId}"]`);
  if (item) item.classList.add('active');

  // Hide all terminal containers
  document.querySelectorAll('.terminal-container').forEach(el => el.classList.remove('visible'));
  placeholder.style.display = 'none';
  activeSessionId = sessionId;
  showTerminalHeader(session);

  if (openSessions.has(sessionId)) {
    const entry = openSessions.get(sessionId);
    if (entry.closed) {
      // Session ended — tear down old terminal and create fresh one
      entry.terminal.dispose();
      entry.element.remove();
      openSessions.delete(sessionId);
    } else {
      // Reuse existing live terminal
      entry.element.classList.add('visible');
      entry.fitAddon.fit();
      entry.terminal.scrollToBottom();
      entry.terminal.focus();
      return;
    }
  }

  // Create new terminal
  const container = document.createElement('div');
  container.className = 'terminal-container visible';
  terminalsEl.appendChild(container);

  const terminal = new Terminal({
    fontSize: 14,
    fontFamily: "'SF Mono', 'Fira Code', 'Cascadia Code', Menlo, monospace",
    theme: {
      background: '#1a1a2e',
      foreground: '#e0e0e0',
      cursor: '#e94560',
      selectionBackground: '#3a3a5e',
    },
    cursorBlink: true,
    scrollback: 10000,
    convertEol: true,
  });

  const fitAddon = new FitAddon.FitAddon();
  terminal.loadAddon(fitAddon);
  terminal.open(container);
  fitAddon.fit();

  // Connect WebSocket
  const wsProtocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${wsProtocol}//${location.host}/ws?sessionId=${encodeURIComponent(sessionId)}&projectPath=${encodeURIComponent(projectPath)}`;
  const ws = new WebSocket(wsUrl);

  ws.onopen = () => {
    ws.send(JSON.stringify({ type: 'resize', cols: terminal.cols, rows: terminal.rows }));
  };

  ws.onmessage = (event) => {
    terminal.write(event.data);
  };

  ws.onclose = () => {
    terminal.write('\r\n[Connection closed]\r\n');
    const entry = openSessions.get(sessionId);
    if (entry) entry.closed = true;
    pollActiveSessions();
  };

  terminal.onData(data => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(data);
    }
  });

  terminal.onResize(({ cols, rows }) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'resize', cols, rows }));
    }
  });

  const entry = { terminal, element: container, ws, fitAddon, session };
  openSessions.set(sessionId, entry);

  terminal.focus();
  pollActiveSessions();
}

// Handle window resize
window.addEventListener('resize', () => {
  if (activeSessionId && openSessions.has(activeSessionId)) {
    openSessions.get(activeSessionId).fitAddon.fit();
  }
});

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

loadProjects();
