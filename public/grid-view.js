// --- Session Grid Overview ---
// No reparenting — terminals stay in #terminals. We wrap each terminal container
// with an in-place card overlay (header/footer) and switch #terminals to grid layout.
//
// Depends on globals from app.js: openSessions, activeSessionId, sessionMap, activePtyIds,
// sortedOrder, sidebarContent, terminalsEl, gridViewActive, gridViewer, gridViewerCount,
// placeholder, terminalHeader, planViewer, statsViewer, memoryViewer, settingsViewer,
// jsonlViewer, terminalArea, cachedProjects, isMac
// Depends on: cleanDisplayName, formatDate (utils.js), fitAndScroll, showSession (terminal-manager.js)

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
  if (card) {
    card.classList.add('focused');
    card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
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

  // Hide all terminals first, then wrap cards in sidebar order (grouped by project)
  document.querySelectorAll('.terminal-container').forEach(el => el.classList.remove('visible'));
  const sessionIds = [];
  // Walk sidebar items to get sessions in display order, grouped by project
  const sidebarItems = sidebarContent.querySelectorAll('.session-item[data-session-id]');
  let currentProjectPath = null;
  for (const item of sidebarItems) {
    const sid = item.dataset.sessionId;
    if (!openSet.has(sid)) continue;
    // Determine project path for this session
    const session = sessionMap.get(sid);
    const projectPath = session ? session.projectPath : null;
    // Add project heading when project changes
    if (projectPath && projectPath !== currentProjectPath) {
      currentProjectPath = projectPath;
      const heading = document.createElement('div');
      heading.className = 'grid-project-heading';
      heading.dataset.projectPath = projectPath;
      heading.textContent = projectPath.split('/').filter(Boolean).slice(-2).join('/');
      terminalsEl.appendChild(heading);
    }
    wrapInGridCard(sid);
    sessionIds.push(sid);
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

// initGridObservers is called from app.js after DOM refs are ready
function initGridObservers() {
  new ResizeObserver(updateGridColumns).observe(terminalsEl);
  new MutationObserver(updateGridColumns).observe(terminalsEl, { childList: true });
}

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

// --- Session navigation (Cmd+Shift+[/], Cmd+Arrow) ---

// Returns ordered list of open (non-closed) session IDs matching sidebar order.
function getOrderedOpenSessionIds() {
  const items = sidebarContent.querySelectorAll('.session-item[data-session-id]');
  const ids = [];
  for (const item of items) {
    const sid = item.dataset.sessionId;
    const entry = openSessions.get(sid);
    if (entry && !entry.closed) ids.push(sid);
  }
  return ids;
}

function navigateSession(direction) {
  const ids = getOrderedOpenSessionIds();
  const current = gridViewActive ? gridFocusedSessionId : activeSessionId;
  const idx = ids.indexOf(current);
  let next;
  if (idx === -1) {
    next = ids[0];
  } else {
    next = ids[(idx + direction + ids.length) % ids.length];
  }
  if (ids.length === 0 || !next) return;
  if (gridViewActive) {
    focusGridCard(next);
  } else {
    showSession(next);
  }
}

// Navigate the grid in 2D by visual position using bounding rects.
// Project headings break the simple index math, so we use actual screen positions.
function navigateGrid(direction) {
  if (!gridViewActive) return;
  const cards = [...terminalsEl.querySelectorAll('.grid-card')];
  if (cards.length === 0) return;
  const currentCard = gridCards.get(gridFocusedSessionId || activeSessionId);
  if (!currentCard || !cards.includes(currentCard)) {
    for (const [sid, card] of gridCards) {
      if (card === cards[0]) { focusGridCard(sid); return; }
    }
    return;
  }
  const cur = currentCard.getBoundingClientRect();
  const curCx = cur.left + cur.width / 2;
  const curCy = cur.top + cur.height / 2;
  let best = null;
  let bestDist = Infinity;
  for (const card of cards) {
    if (card === currentCard) continue;
    const r = card.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    // Filter by direction
    const dx = cx - curCx;
    const dy = cy - curCy;
    let valid = false;
    switch (direction) {
      case 'left':  valid = dx < -10; break;
      case 'right': valid = dx > 10; break;
      case 'up':    valid = dy < -10; break;
      case 'down':  valid = dy > 10; break;
    }
    if (!valid) continue;
    // For left/right prefer same row (small dy), for up/down prefer same column (small dx)
    let dist;
    if (direction === 'left' || direction === 'right') {
      dist = Math.abs(dy) * 3 + Math.abs(dx);
    } else {
      dist = Math.abs(dx) * 3 + Math.abs(dy);
    }
    if (dist < bestDist) {
      bestDist = dist;
      best = card;
    }
  }
  if (!best) return;
  for (const [sid, card] of gridCards) {
    if (card === best) { focusGridCard(sid); return; }
  }
}

// Returns true if the key combo is a session nav shortcut (used by xterm to block without acting)
function isSessionNavKey(e) {
  const mod = isMac ? e.metaKey : e.ctrlKey;
  if (!mod || e.altKey) return false;
  if (e.shiftKey && (e.code === 'BracketLeft' || e.code === 'BracketRight')) return true;
  if (!e.shiftKey && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return true;
  return false;
}

function handleSessionNavKey(e) {
  const mod = isMac ? e.metaKey : e.ctrlKey;
  if (!mod || e.altKey) return false;

  // Cmd+Shift+[ or Cmd+Shift+] — prev/next session
  // On macOS, Shift changes e.key to { / }, so check code for reliable matching
  if (e.shiftKey && (e.code === 'BracketLeft' || e.code === 'BracketRight')) {
    e.preventDefault();
    if (e.type === 'keydown') navigateSession(e.code === 'BracketLeft' ? -1 : 1);
    return true;
  }

  // Cmd+Arrow — in grid view: 2D grid navigation; in single view: left/right cycle sessions
  if (!e.shiftKey && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) {
    e.preventDefault();
    if (e.type === 'keydown') {
      if (gridViewActive) {
        const dirMap = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' };
        navigateGrid(dirMap[e.key]);
      } else {
        const dir = (e.key === 'ArrowLeft' || e.key === 'ArrowUp') ? -1 : 1;
        navigateSession(dir);
      }
    }
    return true;
  }

  return false;
}
