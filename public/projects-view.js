// --- Projects tab (v2) ---
// A project is a piece of work with a folder on disk (main: projects.js).
// The Projects tab is not another session tree. The sidebar lists projects,
// nothing else. Selecting one opens its workspace in the main area:
//
//   Overview  — header, then tracks as cards beside the brief, plan, todos
//               and folders. Settings is a second tab of the same page.
//   Working   — opening one of its sessions keeps you in the project: a slim
//               strip on top, then tracks | sessions | terminal side by side.
//
// Right-click works on a project, a track and a session.
//
// Depends on globals from app.js: projectsContent, cachedProjectTree,
// cachedProjectTreeAll, showArchived, searchMatchIds, searchInput,
// activeSessionId, activePtyIds, attentionSessions, responseReadySessions,
// sessionBusyState, sessionMap, pendingSessions, openSessions, activeTab,
// gridViewActive, loadProjects, refreshSidebar, launchNewSession,
// openSession, pollActiveSessions, placeholder, terminalArea, memoryViewer,
// memoryPanel, hideAllViewers, showSession, fitAndScroll,
// resolveDefaultSessionOptions
// Depends on sidebar.js: isSessionRunning
// Depends on task-runner.js: showTaskPopover, tasksByPath, updateTaskButton,
// activeTaskView
// Depends on dialogs.js: showNewSessionDialog, launchTerminalSession,
// launchScheduleCreator, forkSession
// Depends on utils.js / icons.js: escapeHtml, formatDate, cleanDisplayName, ICONS

let openProjectPopover = null;
let openCtxMenu = null;

const projectsUi = {
  selectedProjectId: sessionStorage.getItem('projects.selected') || null,
  // Each project owns its runtime-only navigation state. Nothing here is
  // persisted: projects start on their Overview tab after an app restart.
  navigationByProject: new Map(), // projectId → { tab, mode, sessionId }
  trackByProject: (() => { try { return JSON.parse(sessionStorage.getItem('projects.track') || '{}'); } catch { return {}; } })(),
  groupBy: (() => { try { return JSON.parse(sessionStorage.getItem('projects.groupBy') || '{}'); } catch { return {}; } })(),
  expandedLists: {},
  lastStateKey: '',
  working: false,
  doneOpen: false,
  // 'pane:<projectId>' or 'card:<projectId>:<trackKey>' → true while its archived list is open
  archivedOpen: (() => { try { return JSON.parse(sessionStorage.getItem('projects.archivedOpen') || '{}'); } catch { return {}; } })(),
  files: new Map(), // `${projectId}:${name}` → { content, at }
  git: new Map(), // projectId → { at, byPath } from get-project-git-status
  paneWidth: null, // working-mode session pane width in px; also kept in the global setting projectPaneWidth
};

// Last completed assistant turns are loaded lazily when an overview row is
// hovered. The event clock changes at the end of every turn, so it also makes a
// natural cache key without polling or rereading a transcript on mouse moves.
const sessionHoverPreviewCache = new Map(); // sessionId -> { eventTime, text }
let sessionHoverPreviewEl = null;
let sessionHoverPreviewRow = null;
let sessionHoverPreviewTimer = null;
let sessionHoverPreviewRequest = 0;

function sessionIsBusy(sessionId) {
  return typeof sessionBusyState !== 'undefined' && sessionBusyState.get(sessionId) === true;
}

function ensureSessionHoverPreview() {
  if (sessionHoverPreviewEl) return sessionHoverPreviewEl;
  const el = document.createElement('div');
  el.className = 'session-turn-preview';
  el.setAttribute('role', 'tooltip');
  el.setAttribute('aria-hidden', 'true');
  el.innerHTML = '<div class="session-turn-preview-label">Last AI message</div><div class="session-turn-preview-text"></div>';
  document.body.appendChild(el);
  sessionHoverPreviewEl = el;
  return el;
}

function positionSessionHoverPreview(row) {
  const el = ensureSessionHoverPreview();
  const rowRect = row.getBoundingClientRect();
  const margin = 12;
  const gap = 5;
  const maxWidth = Math.min(620, window.innerWidth - margin * 2);
  const width = Math.min(maxWidth, Math.max(360, rowRect.width + 80));
  el.style.width = width + 'px';

  // Keep the preview visually attached to the row instead of sending the eye
  // across the page to a side-aligned tooltip.
  const left = Math.max(margin, Math.min(rowRect.left, window.innerWidth - width - margin));
  el.style.left = Math.round(left) + 'px';

  const height = el.offsetHeight;
  let top = rowRect.bottom + gap;
  if (top + height > window.innerHeight - margin) top = rowRect.top - height - gap;
  top = Math.max(margin, top);
  el.style.top = Math.round(top) + 'px';
}

function hideSessionHoverPreview(sessionId = null) {
  if (sessionId && sessionHoverPreviewRow?.dataset.sessionId !== sessionId) return;
  if (sessionHoverPreviewTimer) clearTimeout(sessionHoverPreviewTimer);
  sessionHoverPreviewTimer = null;
  sessionHoverPreviewRow = null;
  sessionHoverPreviewRequest++;
  if (!sessionHoverPreviewEl) return;
  sessionHoverPreviewEl.classList.remove('visible');
  sessionHoverPreviewEl.setAttribute('aria-hidden', 'true');
}

async function showSessionHoverPreview(row, session) {
  const id = session.sessionId;
  if (sessionIsBusy(id) || !row.matches(':hover')) return;

  const eventTime = sessionEventTime(session);
  let cached = sessionHoverPreviewCache.get(id);
  const request = ++sessionHoverPreviewRequest;
  if (!cached || cached.eventTime !== eventTime) {
    let result;
    try { result = await window.api.getSessionLastMessage(id); } catch { return; }
    if (request !== sessionHoverPreviewRequest) return;
    if (result?.error) return;
    cached = { eventTime, text: result?.text || '' };
    sessionHoverPreviewCache.set(id, cached);
  }

  if (!cached.text || sessionIsBusy(id) || !row.matches(':hover')) return;
  const el = ensureSessionHoverPreview();
  const textEl = el.querySelector('.session-turn-preview-text');
  textEl.innerHTML = typeof renderJsonlText === 'function'
    ? renderJsonlText(cached.text)
    : escapeHtml(cached.text);
  sessionHoverPreviewRow = row;
  el.classList.add('visible');
  el.setAttribute('aria-hidden', 'false');
  positionSessionHoverPreview(row);
}

function attachSessionHoverPreview(row, session) {
  row.addEventListener('mouseenter', () => {
    hideSessionHoverPreview();
    if (sessionIsBusy(session.sessionId)) return;
    sessionHoverPreviewRow = row;
    sessionHoverPreviewTimer = setTimeout(() => {
      sessionHoverPreviewTimer = null;
      showSessionHoverPreview(row, session);
    }, 350);
  });
  row.addEventListener('mouseleave', () => hideSessionHoverPreview(session.sessionId));
}

function saveProjectsUi() {
  if (projectsUi.selectedProjectId) sessionStorage.setItem('projects.selected', projectsUi.selectedProjectId);
  else sessionStorage.removeItem('projects.selected');
  // Tab selection belongs to each project and intentionally resets on restart.
  sessionStorage.removeItem('projects.tab');
  sessionStorage.setItem('projects.track', JSON.stringify(projectsUi.trackByProject));
  sessionStorage.setItem('projects.groupBy', JSON.stringify(projectsUi.groupBy));
  sessionStorage.setItem('projects.archivedOpen', JSON.stringify(projectsUi.archivedOpen));
}

const PROJECT_WORKSPACE_TABS = new Set(['overview', 'plan', 'files', 'git', 'settings']);

function projectTab(projectOrId = projectsUi.selectedProjectId) {
  const projectId = typeof projectOrId === 'string' ? projectOrId : projectOrId?.id;
  return projectNavigation(projectId).tab;
}

function setProjectTab(projectOrId, tab) {
  const projectId = typeof projectOrId === 'string' ? projectOrId : projectOrId?.id;
  if (!projectId || !PROJECT_WORKSPACE_TABS.has(tab)) return;
  projectNavigation(projectId).tab = tab;
}

function projectNavigation(projectOrId = projectsUi.selectedProjectId) {
  const projectId = typeof projectOrId === 'string' ? projectOrId : projectOrId?.id;
  if (!projectId) return { tab: 'overview', mode: 'overview', sessionId: null };
  if (!projectsUi.navigationByProject.has(projectId)) {
    projectsUi.navigationByProject.set(projectId, { tab: 'overview', mode: 'overview', sessionId: null });
  }
  return projectsUi.navigationByProject.get(projectId);
}

function rememberProjectOverview(projectOrId) {
  const state = projectNavigation(projectOrId);
  state.mode = 'overview';
  state.sessionId = null;
}

function rememberProjectSession(projectOrId, sessionId) {
  if (!sessionId) return;
  const state = projectNavigation(projectOrId);
  state.mode = 'session';
  state.sessionId = sessionId;
}

/** Keep remembered sessions valid when a newly launched/forked CLI gets its real id. */
function rekeyProjectSessionState(oldId, newId) {
  if (!oldId || !newId || oldId === newId) return;
  for (const state of projectsUi.navigationByProject.values()) {
    if (state.sessionId === oldId) state.sessionId = newId;
  }
}

/** A destroyed terminal cannot be restored as a project's selected session. */
function forgetProjectSessionState(sessionId) {
  for (const state of projectsUi.navigationByProject.values()) {
    if (state.sessionId !== sessionId) continue;
    state.mode = 'overview';
    state.sessionId = null;
  }
}

const projectViewer = document.getElementById('project-viewer');
const projectStrip = document.getElementById('project-strip');
const projectPanes = document.getElementById('project-panes');
const mainEl = document.getElementById('main');

// --- Icons (stroke SVG, 24 grid) ---

const PICONS = {
  plus: (s = 14) => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M12 5v14"/><path d="M5 12h14"/></svg>`,
  chevronDown: (s = 11) => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>`,
  chevronRight: (s = 11) => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m9 6 6 6-6 6"/></svg>`,
  back: (s = 13) => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6"/></svg>`,
  dots: (s = 14) => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/></svg>`,
  play: (s = 12) => `<svg width="${s}" height="${s}" viewBox="0 0 16 16" fill="currentColor"><path d="M4 2.8a1 1 0 0 1 1.52-.85l8 5.2a1 1 0 0 1 0 1.7l-8 5.2A1 1 0 0 1 4 13.2V2.8Z"/></svg>`,
  folder: (s = 12) => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/></svg>`,
  file: (s = 12) => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6"/></svg>`,
  branch: (s = 12) => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3v12"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/></svg>`,
  pencil: (s = 14) => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>`,
  check: (s = 14) => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>`,
  trash: (s = 14) => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/></svg>`,
  open: (s = 14) => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/></svg>`,
  fork: (s = 14) => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 3h5v5"/><path d="M8 3H3v5"/><path d="M21 3l-7.5 7.5a5 5 0 0 0-1.5 3.5v7"/><path d="M3 3l7.5 7.5a5 5 0 0 1 1.5 3.5v1"/></svg>`,
  messages: (s = 14) => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 9a2 2 0 0 1-2 2H6l-4 4V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2z"/></svg>`,
  // The app's own archive glyph, so this view matches the Sessions tab.
  archive: (s = 14) => ICONS.archive(s),
  list: (s = 14) => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6h16"/><path d="M4 12h10"/><path d="M4 18h7"/></svg>`,
  clock: (s = 14) => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="13" r="8"/><path d="M12 9v4l2 2"/></svg>`,
  terminal: (s = 14) => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m4 17 6-6-6-6"/><path d="M12 19h8"/></svg>`,
  search: (s = 13) => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>`,
  x: (s = 12) => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>`,
};

function cliIcon(session, size = 14) {
  if (session.type === 'terminal') return ICONS.terminal(size);
  if (session.runtime === 'codex') return ICONS.codex(size);
  return ICONS.claude(size);
}

// --- Tree helpers ---

function currentProjectTree() {
  return (searchMatchIds !== null || showArchived) ? cachedProjectTreeAll : cachedProjectTree;
}

function findTreeProject(id) {
  if (!id) return null;
  for (const tree of [cachedProjectTree, cachedProjectTreeAll]) {
    const found = (tree?.projects || []).find(p => p.id === id);
    if (found) return found;
  }
  return null;
}

function selectedProject() {
  return findTreeProject(projectsUi.selectedProjectId);
}

/**
 * Archived sessions of a project, or of one of its tracks ('general' for
 * none). They come from the full tree, since the working tree leaves them out.
 */
function archivedSessionsOf(project, trackKey = null) {
  const full = (cachedProjectTreeAll?.projects || []).find(p => p.id === project.id) || project;
  let list;
  if (trackKey === null) list = [...(full.sessions || []), ...(full.tracks || []).flatMap(t => t.sessions || [])];
  else if (trackKey === 'general') list = full.sessions || [];
  else list = (full.tracks || []).find(t => t.id === trackKey)?.sessions || [];
  return list.filter(s => s.archived).sort((a, b) => sessionEventTime(b) - sessionEventTime(a));
}

/** The closed-by-default "Archived · N" section: a hairline, a toggle line, and the dimmed rows when open. */
function buildArchivedSection(project, sessions, key, { showTrack, rowClass }) {
  const wrap = document.createElement('div');
  wrap.className = 'archived-sec';
  const open = !!projectsUi.archivedOpen[key];
  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'archived-toggle' + (open ? ' open' : '');
  toggle.innerHTML = `${PICONS.chevronRight(9)}<span>Archived</span><b>${sessions.length}</b>`;
  toggle.onclick = () => {
    if (open) delete projectsUi.archivedOpen[key]; else projectsUi.archivedOpen[key] = true;
    saveProjectsUi();
    refreshProjectViews({ reason: 'sessions' });
  };
  wrap.appendChild(toggle);
  if (open) for (const s of sessions) wrap.appendChild(buildSessionRow(project, s, { showTrack, className: rowClass }));
  return wrap;
}

function projectSessionsAll(project) {
  const all = [...(project.sessions || [])];
  for (const track of project.tracks || []) all.push(...(track.sessions || []));
  return all;
}

function pathBasename(p) {
  const parts = String(p || '').split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || p;
}

function isPathInside(child, root) {
  if (!child || !root) return false;
  if (child === root) return true;
  return child.startsWith(root + '/') || child.startsWith(root + '\\');
}

/**
 * Label for a Folder (Sessions tab) whose path sits under a project's root:
 * "<project name> · <relative path>". Null for every other folder.
 */
function projectRootLabel(projectPath) {
  for (const project of cachedProjectTreeAll?.projects || []) {
    if (!isPathInside(projectPath, project.root)) continue;
    if (projectPath === project.root) return project.name;
    return `${project.name} · ${projectPath.slice(project.root.length + 1)}`;
  }
  return null;
}

/** 'in-place' or 'worktree' for a folder some project attached, else null. */
function projectFolderMode(projectPath) {
  for (const project of cachedProjectTreeAll?.projects || []) {
    const folder = (project.folders || []).find(f => f.path === projectPath);
    if (folder) return folder.mode;
  }
  return null;
}

/** The branch a project's worktrees use, for labels. */
function projectBranchName(project) {
  return project.sharedBranch === false ? null : (project.branchName || project.slug);
}

/** Project a session belongs to: explicit id first, then its folder's location. */
function projectForSession(session) {
  if (!session) return null;
  if (session.projectId) {
    const explicit = findTreeProject(session.projectId);
    if (explicit) return { project: explicit, byCwd: false };
  }
  for (const project of cachedProjectTreeAll?.projects || []) {
    if (isPathInside(session.projectPath, project.root)) return { project, byCwd: true };
  }
  return null;
}

// Both trees must reference the same session objects as the Sessions tab, so
// a pin, rename or exit changes every view at once.
function dedupTree(tree) {
  for (const project of tree?.projects || []) {
    const lists = [project.sessions, ...(project.tracks || []).map(t => t.sessions)];
    for (const list of lists) {
      for (let i = 0; i < list.length; i++) {
        const s = list[i];
        if (sessionMap.has(s.sessionId)) {
          Object.assign(sessionMap.get(s.sessionId), s);
          list[i] = sessionMap.get(s.sessionId);
        } else {
          sessionMap.set(s.sessionId, s);
        }
      }
    }
  }
}

/** A just-launched session has no transcript yet; show it under its project now. */
function injectPendingIntoTree(session) {
  if (!session?.projectId) return;
  for (const tree of [cachedProjectTree, cachedProjectTreeAll]) {
    const project = (tree?.projects || []).find(p => p.id === session.projectId);
    if (!project) continue;
    const track = session.trackId ? (project.tracks || []).find(t => t.id === session.trackId) : null;
    const list = track ? track.sessions : project.sessions;
    if (!list.some(s => s.sessionId === session.sessionId)) list.unshift(session);
  }
}

function removeSessionFromTrees(sessionId) {
  for (const tree of [cachedProjectTree, cachedProjectTreeAll]) {
    for (const project of tree?.projects || []) {
      project.sessions = project.sessions.filter(s => s.sessionId !== sessionId);
      for (const track of project.tracks || []) {
        track.sessions = track.sessions.filter(s => s.sessionId !== sessionId);
      }
    }
  }
}

/** Every path the task runner should know about for the tree's projects. */
function treeTaskPaths(tree) {
  const paths = new Set();
  for (const project of tree?.projects || []) {
    paths.add(project.root);
    for (const folder of project.folders || []) paths.add(folder.path);
  }
  return [...paths];
}

/** The launch target a project's or track's New session button hands to the popover. */
function launchTargetFor(project, track = null) {
  return {
    projectPath: track?.cwd || project.defaultCwd || project.root,
    projectId: project.id,
    trackId: track?.id || null,
    projectName: project.name,
  };
}

/**
 * A stand-in "project" for the task runner that carries every task from every
 * attached folder plus the project root. Each task remembers the folder it
 * came from so start/stop/log target the right one.
 */
function taskPseudoProject(project) {
  const paths = [project.root, ...(project.folders || []).map(f => f.path)];
  const unique = [...new Set(paths)];
  const contributing = unique.filter(p => (tasksByPath.get(p)?.tasks || []).length);
  const multi = contributing.length > 1;
  const tasks = [];
  let taskError = null;
  let hasTaskFile = false;
  for (const p of unique) {
    const entry = tasksByPath.get(p);
    if (!entry) continue;
    if (entry.error && !taskError) taskError = `${pathBasename(p)}: ${entry.error}`;
    if (entry.hasTaskFile) hasTaskFile = true;
    for (const task of entry.tasks || []) {
      tasks.push({ ...task, projectPath: p, groupLabel: multi ? pathBasename(p) : null });
    }
  }
  return { id: project.id, projectPath: project.root, projectPaths: unique, tasks, taskError, hasTaskFile };
}

function runningTasksFor(project) {
  return taskPseudoProject(project).tasks.filter(t => t.run?.running).length;
}

/** A track's +: straight to its CLI when it has one, else the shared Project View menu. */
async function launchFromTrack(project, track, anchor) {
  const target = launchTargetFor(project, track);
  if (track?.cli) {
    const options = await resolveDefaultSessionOptions(target);
    options.runtime = track.cli;
    launchNewSession(target, options);
    return;
  }
  showNewSessionMenu(project, track, anchor);
}

// --- Identity ---

function projectHue(id) {
  let h = 0;
  for (let i = 0; i < String(id).length; i++) h = (h * 31 + String(id).charCodeAt(i)) >>> 0;
  return h % 360;
}

function projectInitials(name) {
  // Only words that start with a letter or digit count, so "Organization & SSO"
  // is OS and not O&. Hyphens and underscores separate words too.
  const words = String(name || '').trim().split(/[\s_-]+/).filter(w => /^[\p{L}\p{N}]/u.test(w));
  if (!words.length) return '?';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}

function markHtml(project, size = 28, extraClass = '') {
  const h = projectHue(project.id);
  const fontSize = Math.round(size * 0.4);
  return `<span class="proj-mark ${extraClass}" style="width:${size}px;height:${size}px;font-size:${fontSize}px;background:hsla(${h},70%,60%,0.18);color:hsl(${h},80%,72%);">${escapeHtml(projectInitials(project.name))}</span>`;
}

/**
 * One color per track, spread around the wheel from the project's own hue so
 * two tracks in a project never share one. General is grey.
 */
function trackColors(project, track) {
  if (!track) return { fg: '#9090a8', bg: 'rgba(255,255,255,0.08)' };
  const index = Math.max(0, (project.tracks || []).findIndex(t => t.id === track.id));
  const h = Math.round((projectHue(project.id) + 40 + index * 137.5) % 360);
  return { fg: `hsl(${h},78%,72%)`, bg: `hsla(${h},70%,60%,0.16)` };
}

function trackTagHtml(project, track) {
  const c = trackColors(project, track);
  return `<span class="pane-tag" style="color:${c.fg};background:${c.bg}">${escapeHtml(track ? track.name : 'General')}</span>`;
}

function cliLabel(session) {
  if (session.type === 'terminal') return 'Terminal';
  if (session.runtime === 'codex') return 'Codex';
  return 'Claude';
}

function sessionTitle(session) {
  return cleanDisplayName(session.name || session.aiTitle || session.summary) || 'New session';
}

/** Archive or unarchive a session. Archiving a live session stops it first. */
async function toggleArchiveSession(session) {
  const newVal = session.archived ? 0 : 1;
  if (newVal && activePtyIds.has(session.sessionId)) { await window.api.stopSession(session.sessionId); pollActiveSessions(); }
  await window.api.archiveSession(session.sessionId, newVal);
  if (newVal) forgetTerminalHistory(session.sessionId);
  session.archived = newVal;
  loadProjects();
}

/** The J row: title over one meta line (dot, track label, CLI, age, size). */
function buildSessionRow(project, session, { showTrack = true, className = 'pane-session', hoverPreview = false } = {}) {
  const row = document.createElement('div');
  const id = session.sessionId;
  // The same state classes the Sessions tab uses, so the two rows read alike.
  const stateClasses = [
    isSessionRunning(id) ? 'running' : '',
    typeof attentionSessions !== 'undefined' && attentionSessions.has(id) ? 'needs-attention' : '',
    typeof responseReadySessions !== 'undefined' && responseReadySessions.has(id) ? 'response-ready' : '',
    typeof sessionBusyState !== 'undefined' && sessionBusyState.get(id) === true ? 'cli-busy' : '',
  ].filter(Boolean).join(' ');
  row.className = className + (id === activeSessionId ? ' here' : '') + (stateClasses ? ' ' + stateClasses : '');
  row.dataset.sessionId = id;
  const state = sessionState(session);
  const track = session.trackId ? (project.tracks || []).find(t => t.id === session.trackId) : null;
  const parts = [];
  parts.push(`<span class="session-status-dot pane-dot${state === 'running' ? ' running' : ''}${state === 'attention' ? ' needs-attention' : ''}"></span>`);
  if (!track && session.formerTrackName) {
    parts.push(`<span class="pane-tag" title="Previously in a deleted track">Formerly: ${escapeHtml(session.formerTrackName)}</span>`);
  } else if (showTrack) parts.push(trackTagHtml(project, track));
  // The CLI mark, same as the status bar: the logo says which CLI, no word needed.
  parts.push(`<span class="pane-cli-icon${session.runtime === 'codex' ? ' is-codex' : ''}${session.type === 'terminal' ? ' is-terminal' : ''}" title="${escapeHtml(cliLabel(session))}">${cliIcon(session, 12)}</span>`);
  parts.push(`<span>${escapeHtml(formatDate(new Date(sessionEventTime(session))))}</span>`);
  if (session.messageCount) parts.push(`<span class="pane-sep">·</span><span>${session.messageCount} msgs</span>`);
  row.innerHTML = `<span class="pane-title">${escapeHtml(sessionTitle(session))}</span><span class="pane-meta">${parts.join('')}</span>`;
  // A floating button, shown on hover: dismiss a session that never started
  // (nothing to archive), otherwise archive or unarchive.
  const dismissible = typeof isDismissibleSession === 'function' && isDismissibleSession(id);
  if (dismissible || session.type !== 'terminal') {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'pane-row-archive';
    btn.title = dismissible ? 'Dismiss' : (session.archived ? 'Unarchive' : 'Archive');
    btn.innerHTML = dismissible ? PICONS.x(12) : PICONS.archive(12);
    btn.onclick = (e) => { e.stopPropagation(); if (dismissible) dismissSession(id); else toggleArchiveSession(session); };
    row.appendChild(btn);
  }
  row.onclick = () => { if (hoverPreview) hideSessionHoverPreview(id); openSession(session); };
  row.oncontextmenu = (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (hoverPreview) hideSessionHoverPreview(id);
    showContextMenu(sessionMenuItems(session), { x: e.clientX, y: e.clientY });
  };
  if (hoverPreview) attachSessionHoverPreview(row, session);
  return row;
}

// --- Status ---

function sessionState(session) {
  const id = session.sessionId;
  if (attentionSessions.has(id)) return 'attention';
  if (isSessionRunning(id)) return 'running';
  return '';
}

/**
 * What a session is doing, for the roll-up dot: 'running' while the CLI is
 * working, 'ready' when it has finished and nobody has looked, 'attention'
 * when it wants an answer, 'idle' for a live session doing none of those.
 */
function sessionActivity(session) {
  const id = session.sessionId;
  const alive = isSessionRunning(id);
  // Same order as the roll-up: a session that is both unread and waiting on
  // you reports needs-you, so the project above it does too.
  if (attentionSessions.has(id)) return 'attention';
  if (responseReadySessions.has(id)) return 'ready';
  if (alive && sessionBusyState.get(id) === true) return 'running';
  return alive ? 'idle' : '';
}

const GROUP_STATE_ORDER = ['attention', 'ready', 'running', 'idle'];
const GROUP_STATE_LABEL = { running: 'Working', ready: 'Finished, not read yet', attention: 'Needs you', idle: 'Open' };

/** The strongest state among these sessions: needs-you beats finished beats working. */
function groupState(sessions) {
  let best = '';
  for (const s of sessions) {
    const st = sessionActivity(s);
    if (st === 'attention') return 'attention';
    if (st && (!best || GROUP_STATE_ORDER.indexOf(st) < GROUP_STATE_ORDER.indexOf(best))) best = st;
  }
  return best;
}

function stateDot(state, extraClass = '') {
  const label = GROUP_STATE_LABEL[state] || '';
  return `<span class="proj-dot ${state} ${extraClass}"${label ? ` title="${label}"` : ''}></span>`;
}

/** Roll running / attention up onto every project row, card and session row. */
function updateProjectStatusDots() {
  const apply = (el, sessions) => {
    const dot = el.querySelector(':scope > .proj-dot, :scope > .proj-status > .proj-dot, :scope > .tcard-h > .proj-dot');
    if (!dot) return;
    const state = groupState(sessions);
    for (const name of GROUP_STATE_ORDER) dot.classList.toggle(name, state === name);
    if (GROUP_STATE_LABEL[state]) dot.title = GROUP_STATE_LABEL[state]; else dot.removeAttribute('title');
  };
  document.querySelectorAll('.proj-row[data-project-id]').forEach(row => {
    const project = findTreeProject(row.dataset.projectId);
    if (project) apply(row, projectSessionsAll(project));
  });
  document.querySelectorAll('.tcard[data-track-key]').forEach(el => {
    const project = findTreeProject(el.dataset.projectId);
    if (!project) return;
    const key = el.dataset.trackKey;
    const sessions = key === 'general' ? project.sessions : (project.tracks.find(t => t.id === key)?.sessions || []);
    apply(el, sessions);
  });
  document.querySelectorAll('.pane-session[data-session-id], .tcard-session[data-session-id]').forEach(el => {
    const session = sessionMap.get(el.dataset.sessionId);
    const dot = el.querySelector('.session-status-dot');
    if (!session || !dot) return;
    const state = sessionState(session);
    dot.classList.toggle('running', state === 'running');
    dot.classList.toggle('needs-attention', state === 'attention');
  });
  // The Time and State groupings move a session between sections when it
  // starts or stops, so a change in the set re-renders the pane.
  if (projectsUi.working) {
    const project = selectedProject();
    if (project) {
      const key = projectSessionsAll(project).map(s => s.sessionId + ':' + sessionState(s)).join('|');
      if (key !== projectsUi.lastStateKey) {
        projectsUi.lastStateKey = key;
        renderPanes(project);
      }
    }
  }
}

// --- Sidebar: the project list ---

/** A project sorts by the latest event among its sessions; a project with none uses its own activity time. */
function projectSortTime(project) {
  let best = 0;
  for (const s of projectSessionsAll(project)) best = Math.max(best, sessionEventTime(s));
  if (best) return best;
  const t = new Date(project.lastActivity || project.modified || 0).getTime();
  return Number.isFinite(t) ? t : 0;
}

function projectSubline(project) {
  const sessions = projectSessionsAll(project);
  const state = groupState(sessions);
  const trackCount = (project.tracks || []).length;
  const parts = [trackCount ? `${trackCount} track${trackCount === 1 ? '' : 's'}` : 'no tracks'];
  parts.push(`${sessions.length} session${sessions.length === 1 ? '' : 's'}`);
  if (state === 'attention') parts.push('needs input');
  else if (projectSortTime(project)) parts.push(formatDate(new Date(projectSortTime(project))));
  return parts.join(' · ');
}

function buildProjectRow(project) {
  const row = document.createElement('div');
  row.className = 'proj-row' + (project.id === projectsUi.selectedProjectId ? ' selected' : '') + (project.status === 'done' ? ' done' : '');
  row.id = 'proj-' + project.id;
  row.dataset.projectId = project.id;
  row.title = project.root;
  const sessions = projectSessionsAll(project);
  const state = groupState(sessions);
  const runningCount = sessions.filter(s => isSessionRunning(s.sessionId)).length;
  row.innerHTML = markHtml(project, 28) +
    `<span class="proj-text"><span class="proj-name">${escapeHtml(project.name)}</span><span class="proj-sub">${escapeHtml(projectSubline(project))}</span></span>` +
    `<span class="proj-status">${stateDot(state)}${runningCount ? `<span class="proj-count">${runningCount}</span>` : ''}</span>`;
  return row;
}

function renderProjectList() {
  if (!projectsContent) return;
  const tree = currentProjectTree();
  let projects = tree?.projects || [];

  const query = searchMatchIds !== null ? (searchInput.value || '').trim().toLowerCase() : '';
  if (searchMatchIds !== null) {
    projects = projects.filter(p =>
      (query && p.name.toLowerCase().includes(query)) ||
      projectSessionsAll(p).some(s => searchMatchIds.has(s.sessionId)));
  }

  const list = document.createElement('div');

  const toolbar = document.createElement('div');
  toolbar.className = 'proj-toolbar';
  toolbar.id = 'proj-toolbar';
  toolbar.innerHTML = `<button type="button" class="proj-new-btn" id="proj-new-btn">${PICONS.plus(12)}<span>New project</span></button>`;
  list.appendChild(toolbar);

  const byEvent = (a, b) => projectSortTime(b) - projectSortTime(a);
  const active = projects.filter(p => p.status !== 'done').sort(byEvent);
  const done = projects.filter(p => p.status === 'done').sort(byEvent);

  if (!projects.length) {
    const empty = document.createElement('div');
    empty.className = 'projects-empty';
    empty.id = 'projects-empty';
    empty.innerHTML = `<div class="projects-empty-text">${searchMatchIds !== null ? 'No project matches.' : 'No projects yet. A project is a folder that holds a brief, a plan, and the sessions that work on it.'}</div>`;
    list.appendChild(empty);
  }

  if (active.length) {
    const label = document.createElement('div');
    label.className = 'proj-section';
    label.id = 'proj-sec-active';
    label.textContent = 'Active';
    list.appendChild(label);
    for (const project of active) list.appendChild(buildProjectRow(project));
  }

  if (done.length) {
    const label = document.createElement('div');
    label.className = 'proj-section proj-section--toggle' + (projectsUi.doneOpen ? ' open' : '');
    label.id = 'proj-sec-done';
    label.innerHTML = `${PICONS.chevronRight(9)}<span>Done · ${done.length}</span>`;
    list.appendChild(label);
    if (projectsUi.doneOpen) for (const project of done) list.appendChild(buildProjectRow(project));
  }

  morphdom(projectsContent, list, {
    childrenOnly: true,
    getNodeKey(node) { return node.id || undefined; },
  });
  bindProjectList();
}

function bindProjectList() {
  const newBtn = projectsContent.querySelector('#proj-new-btn');
  if (newBtn) newBtn.onclick = () => showNewProjectDialog();
  const doneToggle = projectsContent.querySelector('#proj-sec-done');
  if (doneToggle) doneToggle.onclick = () => { projectsUi.doneOpen = !projectsUi.doneOpen; renderProjectList(); };
  projectsContent.querySelectorAll('.proj-row').forEach(row => {
    const project = findTreeProject(row.dataset.projectId);
    if (!project) return;
    row.onclick = () => selectProject(project.id);
    row.oncontextmenu = (e) => { e.preventDefault(); showContextMenu(projectMenuItems(project), { x: e.clientX, y: e.clientY }); };
  });
}

function selectProject(id, { tab } = {}) {
  // Moving to another project drops the session that was open: it belongs to
  // the project you left, so it must not stay focused in the one you opened.
  const active = activeSessionId ? sessionMap.get(activeSessionId) : null;
  if (active && projectForSession(active)?.project?.id !== id) {
    setActiveSession(null);
    document.querySelectorAll('.terminal-container.visible').forEach(el => el.classList.remove('visible'));
    document.querySelectorAll('.session-item.active, .pane-session.here').forEach(el => el.classList.remove('active', 'here'));
    if (typeof terminalHeader !== 'undefined') terminalHeader.style.display = 'none';
  }
  projectsUi.selectedProjectId = id;
  if (tab) {
    setProjectTab(id, tab);
    rememberProjectOverview(id);
  }
  saveProjectsUi();
  projectsContent.querySelectorAll('.proj-row').forEach(r => r.classList.toggle('selected', r.dataset.projectId === id));
  showRememberedProjectView();
}

// --- Main area: which project view to show ---

/** Hide every piece of project chrome. Called by hideAllViewers and the other openers. */
function hideProjectChrome() {
  if (projectViewer) projectViewer.style.display = 'none';
  leaveWorking();
}

/** Restore this project's own last view without relaunching a closed session. */
function showRememberedProjectView() {
  const project = selectedProject();
  if (project) {
    const state = projectNavigation(project);
    if (state.mode === 'session' && state.sessionId && !gridViewActive) {
      const entry = openSessions.get(state.sessionId);
      const session = sessionMap.get(state.sessionId) || entry?.session;
      const owner = projectForSession(session);
      if (entry && owner?.project?.id === project.id) {
        showSession(state.sessionId);
        return;
      }
    }
    showProjectOverview();
    return;
  }
  hideAllViewers();
  placeholder.style.display = '';
}

/** The main area for the Projects tab: that project's remembered view. */
function showProjectHome() {
  showRememberedProjectView();
}

/** Called when the user leaves the Projects tab. */
function leaveProjectViews() {
  if (projectViewer) projectViewer.style.display = 'none';
  leaveWorking();
}

/**
 * Re-render whatever project view is on screen (after loadProjects).
 *
 * A running session writes its transcript constantly and every write reaches
 * the renderer as projects-changed, so `reason: 'sessions'` means "only the
 * sessions moved". That patches the page in place instead of rebuilding it:
 * a full rebuild throws away the Plan tab, an open Add-todo field and any
 * inline edit several times a minute. A real project change (rename, attach,
 * brief or plan write) still re-renders the page.
 */
function refreshProjectViews({ reason = 'project' } = {}) {
  renderProjectList();
  if (activeTab !== 'projects') return;
  if (projectsUi.working) {
    const session = activeSessionId ? sessionMap.get(activeSessionId) : null;
    const info = projectForSession(session);
    // A stopped or closed session leaves the strip and pane in place, the way
    // the Sessions tab keeps its list. The main area shows whatever that tab
    // would show: the placeholder, or the terminal behind its exit banner.
    const project = info?.project || selectedProject();
    if (project) {
      renderStrip(project);
      renderPanes(project);
      ensureWorkingTerminalVisible(project);
    } else leaveWorking();
  } else if (projectViewer && projectViewer.style.display !== 'none') {
    const project = selectedProject();
    if (!project) { projectViewer.style.display = 'none'; placeholder.style.display = ''; }
    else if (reason === 'sessions' || editingInPage()) applySessionStatus(project);
    else {
      // A save re-renders the page; keep the field the user is in.
      const active = document.activeElement;
      const focusId = active && projectViewer.contains(active) ? active.id : null;
      renderOverview();
      const again = focusId ? projectViewer.querySelector('#' + CSS.escape(focusId)) : null;
      if (again && again !== document.activeElement) again.focus();
    }
  }
  updateProjectStatusDots();
}

/**
 * Project refreshes rebuild the strip and session pane, not the terminal. Keep
 * the live terminal as an explicit invariant anyway: another viewer can leave
 * the terminal area hidden, and a class lost during a surrounding re-render
 * otherwise produces a blank session view until the row is clicked again.
 *
 * This is called by renderPanes itself, rather than only by the outer project
 * refresh. Busy/idle changes, plan-file changes and pane controls all render
 * the pane directly and used to bypass the repair.
 */
function ensureWorkingTerminalVisible(project, { refit = false } = {}) {
  if (!projectsUi.working || gridViewActive || activeTaskView || !activeSessionId) return;
  const entry = openSessions.get(activeSessionId);
  const session = sessionMap.get(activeSessionId) || entry?.session;
  const rememberedHere = projectNavigation(project).mode === 'session' &&
    projectNavigation(project).sessionId === activeSessionId;
  if (!entry || (projectForSession(session)?.project?.id !== project.id && !rememberedHere)) return;

  let repaired = false;
  if (!mainEl.classList.contains('project-working')) {
    mainEl.classList.add('project-working');
    repaired = true;
  }
  if (projectStrip.style.display === 'none') {
    projectStrip.style.display = '';
    repaired = true;
  }
  if (projectPanes.style.display === 'none') {
    projectPanes.style.display = '';
    repaired = true;
  }
  if (terminalArea.style.display === 'none') {
    terminalArea.style.display = '';
    repaired = true;
  }
  if (!entry.element.classList.contains('visible')) {
    document.querySelectorAll('.terminal-container.visible').forEach(el => el.classList.remove('visible'));
    entry.element.classList.add('visible');
    repaired = true;
  }
  placeholder.style.display = 'none';
  const header = document.getElementById('terminal-header');
  if (header && header.style.display === 'none') header.style.display = '';
  // Replacing the pane can change the terminal's available geometry even when
  // none of its visibility classes changed. Refit on that path so xterm's
  // canvas cannot remain sized for the pre-project layout and look blank.
  if (repaired || refit) fitAndScroll(entry);
}

/**
 * True while the user is typing a todo on the page. Neither input carries an
 * id, so the focus restore above cannot bring them back; nothing may rebuild
 * the page under them.
 */
function editingInPage() {
  const active = document.activeElement;
  if (!active || !projectViewer?.contains(active)) return false;
  return active.classList.contains('ws-todo-input') || active.classList.contains('ws-todo-edit');
}

/** The session ids and states a track card is currently showing. */
function cardSessionKey(sessions) {
  return sessions.map(s => s.sessionId + ':' + sessionState(s)).join('|');
}

/**
 * Patch the project page for a session change: the header dot and task badge,
 * and any track card whose sessions moved. Everything else — the tracks
 * section, the side cards, the Plan tab, the Files tab — is left alone, in the
 * same spirit as applyGitStatus. updateProjectStatusDots does the dots
 * themselves right after this.
 */
function applySessionStatus(project) {
  if (!projectViewer) return;
  const sessions = projectSessionsAll(project);

  // The header dot only exists once the project has sessions.
  const state = groupState(sessions);
  const titleLine = projectViewer.querySelector('.ws-title-line');
  if (titleLine) {
    const dot = titleLine.querySelector('.proj-dot--lg');
    if (state && !dot) titleLine.insertAdjacentHTML('beforeend', stateDot(state, 'proj-dot--lg'));
    else if (!state && dot) dot.remove();
  }

  const running = runningTasksFor(project);
  const badge = projectViewer.querySelector('#ws-tasks .project-task-count');
  if (badge) {
    badge.textContent = running || '';
    badge.style.display = running ? '' : 'none';
  }

  // Only the Overview tab shows sessions; the others do not care.
  if (projectTab(project) !== 'overview') return;
  for (const card of projectViewer.querySelectorAll('.tcard[data-track-key]')) {
    const key = card.dataset.trackKey;
    const track = key === 'general' ? null : (project.tracks || []).find(t => t.id === key);
    if (key !== 'general' && !track) continue;
    const next = cardSessionKey(sessionsOfTrack(project, key));
    if (next === card.dataset.sessionKey) continue;
    card.replaceWith(buildTrackCard(project, track));
  }
}

// --- Session hook: keep the project around the terminal ---

/** Called at the end of showSession(). Turns working mode on or off. */
function onSessionShown(sessionId) {
  if (activeTab !== 'projects') return;
  if (gridViewActive) { leaveWorking(); return; }
  const session = sessionMap.get(sessionId);
  const info = projectForSession(session);
  if (!info) { leaveWorking(); return; }
  enterWorking(info.project, session);
}

/** Called by showTaskLog. A task log opens beside the pane, not over the whole project. */
function onTaskLogShown() {
  if (activeTab !== 'projects') return;
  const project = selectedProject();
  if (!project) return;
  enterWorking(project, null);
}

function enterWorking(project, session) {
  if (projectsUi.selectedProjectId !== project.id) {
    projectsUi.selectedProjectId = project.id;
    projectsContent.querySelectorAll('.proj-row').forEach(r => r.classList.toggle('selected', r.dataset.projectId === project.id));
  }
  if (session) {
    projectsUi.trackByProject[project.id] = session.trackId || 'general';
    rememberProjectSession(project, session.sessionId);
  }
  saveProjectsUi();
  if (projectViewer) projectViewer.style.display = 'none';
  const wasWorking = projectsUi.working;
  projectsUi.working = true;
  mainEl.classList.add('project-working');
  projectStrip.style.display = '';
  projectPanes.style.display = '';
  applyPaneWidth();
  renderStrip(project);
  renderPanes(project);
  if (!wasWorking) requestAnimationFrame(() => window.dispatchEvent(new Event('resize')));
}

// --- Pane width: drag the handle, remembered per app in the global setting ---
const PANE_MIN = 220;
const PANE_MAX = 560;

function applyPaneWidth() {
  const w = projectsUi.paneWidth;
  if (w) mainEl.style.setProperty('--pane-w', Math.min(PANE_MAX, Math.max(PANE_MIN, w)) + 'px');
  else mainEl.style.removeProperty('--pane-w');
}

{
  const handle = document.getElementById('pane-resize-handle');
  let dragging = false;
  if (handle) {
    handle.addEventListener('mousedown', (e) => {
      e.preventDefault();
      dragging = true;
      handle.classList.add('dragging');
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
    });
    window.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      const left = mainEl.getBoundingClientRect().left;
      projectsUi.paneWidth = Math.min(PANE_MAX, Math.max(PANE_MIN, Math.round(e.clientX - left)));
      applyPaneWidth();
    });
    window.addEventListener('mouseup', () => {
      if (!dragging) return;
      dragging = false;
      handle.classList.remove('dragging');
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      saveProjectsUi();
      window.dispatchEvent(new Event('resize'));
      window.api.getSetting('global').then(g => {
        const global = g || {};
        global.projectPaneWidth = projectsUi.paneWidth;
        window.api.setSetting('global', global);
      }).catch(() => {});
    });
  }
  // The width outlives the session: read it back from the global setting on start.
  if (!projectsUi.paneWidth) {
    window.api.getSetting('global').then(g => {
      if (g?.projectPaneWidth && !projectsUi.paneWidth) { projectsUi.paneWidth = g.projectPaneWidth; if (projectsUi.working) applyPaneWidth(); }
    }).catch(() => {});
  }
}

function leaveWorking() {
  if (!projectsUi.working) return;
  projectsUi.working = false;
  mainEl.classList.remove('project-working');
  projectStrip.style.display = 'none';
  projectPanes.style.display = 'none';
  requestAnimationFrame(() => window.dispatchEvent(new Event('resize')));
}

// --- Overview page ---

function showProjectOverview() {
  const project = selectedProject();
  if (!project) return;
  rememberProjectOverview(project);
  leaveWorking();
  hideAllViewers();
  terminalArea.style.display = 'none';
  placeholder.style.display = 'none';
  document.querySelectorAll('.session-item.active').forEach(el => el.classList.remove('active'));
  projectViewer.style.display = 'flex';
  renderOverview();
}

// --- Folder git state. A worktree's branch is fixed when it is attached; an
// in-place folder is on whatever is checked out right now, so that is read
// live and cached briefly. ---
const GIT_STATUS_TTL_MS = 30000;

function folderGit(project, folder) {
  return projectsUi.git.get(project.id)?.byPath?.[folder.path] || null;
}

function folderBranch(project, folder) {
  if (folder.mode === 'worktree') return folder.branch || '';
  const g = folderGit(project, folder);
  return g?.git ? g.branch : '';
}

function folderChipLabel(project, folder) {
  const branch = folderBranch(project, folder);
  return branch ? `${pathBasename(folder.path)} · ${branch}` : pathBasename(folder.path);
}

/** Folders card: "worktree · main", "in place · main · modified", or "in place". */
function folderModeText(project, folder) {
  const g = folderGit(project, folder);
  const dirty = g?.git && g.dirty ? ' · modified' : '';
  if (folder.mode === 'worktree') return `worktree · ${folder.branch || ''}${dirty}`;
  return g?.git ? `in place · ${g.branch}${dirty}` : 'in place';
}

/** Settings row: branch and dirty marker, then where the folder came from or lives. */
function folderSettingsText(project, folder) {
  const g = folderGit(project, folder);
  const dirty = g?.git && g.dirty ? ' · modified' : '';
  if (folder.mode === 'worktree') return `on ${folder.branch || ''}${dirty} · from ${folder.sourcePath || ''}`;
  return g?.git ? `on ${g.branch}${dirty} · ${folder.path}` : folder.path;
}

function folderChipHtml(project, folder) {
  const isWorktree = folder.mode === 'worktree';
  const icon = isWorktree ? PICONS.branch(12) : PICONS.folder(12);
  return `<span class="ws-chip mono ${isWorktree ? 'ws-chip--worktree' : ''}" data-path="${escapeHtml(folder.path)}" title="${escapeHtml(folder.path)}">${icon}<span class="ws-chip-label">${escapeHtml(folderChipLabel(project, folder))}</span></span>`;
}

/** Fetch git state for the project's folders unless the cache is fresh and covers every folder. Resolves true when something changed. */
async function loadProjectGit(project, { force = false } = {}) {
  const cached = projectsUi.git.get(project.id);
  const covers = !!cached && (project.folders || []).every(f => f.path in (cached.byPath || {}));
  if (!force && covers && Date.now() - cached.at < GIT_STATUS_TTL_MS) return false;
  let result = null;
  try { result = await window.api.getProjectGitStatus(project.id, { force }); } catch {}
  if (!result?.ok) return false;
  const changed = JSON.stringify(cached?.byPath || null) !== JSON.stringify(result.byPath);
  projectsUi.git.set(project.id, { at: Date.now(), byPath: result.byPath });
  return changed;
}

/** Patch the folder chips and rows in place, so a refresh never disturbs a field being edited. */
function applyGitStatus(project) {
  for (const folder of project.folders || []) {
    const sel = `[data-path="${CSS.escape(folder.path)}"]`;
    projectViewer.querySelectorAll(`.ws-chip${sel} .ws-chip-label`).forEach(el => { el.textContent = folderChipLabel(project, folder); });
    projectViewer.querySelectorAll(`.ws-frow${sel}[data-detail="mode"] .ws-card-meta`).forEach(el => { el.textContent = folderModeText(project, folder); });
    projectViewer.querySelectorAll(`.ws-frow${sel}[data-detail="settings"] .ws-frow-detail`).forEach(el => { el.textContent = folderSettingsText(project, folder); });
  }
}

function renderOverview() {
  const project = selectedProject();
  if (!project || !projectViewer) return;
  hideSessionHoverPreview();
  const tabName = projectTab(project);
  const running = runningTasksFor(project);
  const sessions = projectSessionsAll(project);
  const state = groupState(sessions);

  projectViewer.innerHTML = `
    <div class="ws-header">
      <div class="ws-title-row">
        ${markHtml(project, 38, 'proj-mark--lg')}
        <div class="ws-title-text">
          <div class="ws-title-line">
            <span class="ws-title">${escapeHtml(project.name)}</span>
            <span class="ws-chip ws-chip--status ${project.status}">${project.status === 'done' ? 'Done' : 'Active'}</span>
            ${state ? stateDot(state, 'proj-dot--lg') : ''}
          </div>
          <div class="ws-chips">
            ${(project.folders || []).map(f => folderChipHtml(project, f)).join('')}
            <button type="button" class="ws-chip ws-chip--add" id="ws-add-folder">${PICONS.plus(10)}<span>folder</span></button>
          </div>
        </div>
        <div class="ws-actions">
          <button type="button" class="ws-btn project-task-btn" id="ws-tasks" data-project-id="${project.id}" data-project-path="${escapeHtml(project.root)}" data-project-paths="${escapeHtml(taskPseudoProject(project).projectPaths.join('\n'))}">${PICONS.play(12)}<span>Tasks</span><span class="project-task-count ws-badge" ${running ? '' : 'style="display:none"'}>${running || ''}</span></button>
          <button type="button" class="ws-btn ws-btn--primary" id="ws-new">${PICONS.plus(12)}<span>New session</span>${PICONS.chevronDown(11)}</button>
          <button type="button" class="ws-btn ws-btn--icon" id="ws-more" title="More">${PICONS.dots(14)}</button>
        </div>
      </div>
      <div class="ws-tabs">
        <button type="button" class="ws-tab ${tabName === 'overview' ? 'active' : ''}" data-tab="overview">Overview</button>
        <button type="button" class="ws-tab ${tabName === 'plan' ? 'active' : ''}" data-tab="plan" title="Phases from plan-tracker.md and the todos, with the sessions that worked on them">Plan <span class="ws-tab-meta" id="ws-tab-plan-meta"></span></button>
        <button type="button" class="ws-tab ${tabName === 'files' ? 'active' : ''}" data-tab="files" title="The project folder: brief, plan, todos and anything else the project keeps">Files</button>
        <button type="button" class="ws-tab ${tabName === 'git' ? 'active' : ''}" data-tab="git" title="Branches, working changes and recent commits in attached repositories">Git</button>
        <button type="button" class="ws-tab ${tabName === 'settings' ? 'active' : ''}" data-tab="settings">Settings</button>
      </div>
    </div>
    <div class="ws-body" id="ws-body"></div>`;

  const body = projectViewer.querySelector('#ws-body');
  if (tabName === 'settings') renderSettings(project, body);
  else if (tabName === 'files') renderFilesTab(project, body);
  else if (tabName === 'plan') renderPlanTab(project, body);
  else if (tabName === 'git') renderProjectGitTab(project, body);
  else renderOverviewBody(project, body);

  projectViewer.querySelectorAll('.ws-tab:not([disabled])').forEach(tab => {
    tab.onclick = () => { setProjectTab(project, tab.dataset.tab); renderOverview(); };
  });
  projectViewer.querySelector('#ws-new').onclick = (e) => showNewSessionMenu(project, null, e.currentTarget);
  projectViewer.querySelector('#ws-more').onclick = (e) => showContextMenu(projectMenuItems(project, { fromPage: true }), { anchor: e.currentTarget });
  projectViewer.querySelector('#ws-tasks').onclick = (e) => showTaskPopover(taskPseudoProject(project), e.currentTarget);
  projectViewer.querySelector('#ws-add-folder').onclick = () => attachFolderAsk(project);
  loadProjectFiles(project).then(() => { if (selectedProject()?.id === project.id) renderPlanMeta(project); });
  loadProjectGit(project).then(changed => { if (changed && selectedProject()?.id === project.id) applyGitStatus(project); });
}

function renderPlanMeta(project) {
  const meta = projectViewer?.querySelector('#ws-tab-plan-meta');
  const plan = parsePlan(fileContent(project, 'plan-tracker.md'));
  if (meta) meta.textContent = plan.phases.length ? `${plan.done}/${plan.phases.length}` : '';
}

function renderOverviewBody(project, body) {
  const tracks = project.tracks || [];
  body.innerHTML = `
    <div class="ws-grid">
      <div class="ws-main">
        <div class="ws-section-head"><span class="ws-section-title">Tracks</span><span class="ws-flex"></span><button type="button" class="ws-ghost" id="ws-new-track">${PICONS.plus(12)}<span>New track</span></button></div>
        <div class="ws-cards" id="ws-cards"></div>
      </div>
      <div class="ws-side" id="ws-side"></div>
    </div>`;
  const cards = body.querySelector('#ws-cards');
  cards.appendChild(buildTrackCard(project, null));
  for (const track of tracks) cards.appendChild(buildTrackCard(project, track));
  if (!tracks.length && !project.sessions.length) {
    const hint = document.createElement('div');
    hint.className = 'ws-hint';
    hint.textContent = 'Start a session from the header, or add tracks for the lines of work in this project.';
    cards.appendChild(hint);
  }
  body.querySelector('#ws-new-track').onclick = () => promptNewTrack(project);
  renderSideCards(project, body.querySelector('#ws-side'));
  loadProjectFiles(project).then(() => {
    if (selectedProject()?.id !== project.id || projectTab(project) !== 'overview') return;
    if (editingInPage()) return;
    const side = projectViewer.querySelector('#ws-side');
    if (side) renderSideCards(project, side);
  });
}

function sessionsOfTrack(project, trackKey) {
  const list = trackKey === 'general' || !trackKey ? project.sessions : (project.tracks.find(t => t.id === trackKey)?.sessions || []);
  return list.filter(s => !s.archived).sort((a, b) => sessionEventTime(b) - sessionEventTime(a));
}

function buildCardSessionRow(project, session) {
  return buildSessionRow(project, session, { showTrack: false, className: 'pane-session tcard-session', hoverPreview: true });
}

function buildTrackCard(project, track) {
  const key = track ? track.id : 'general';
  const sessions = sessionsOfTrack(project, key);
  const card = document.createElement('div');
  card.className = 'tcard' + (track ? '' : ' tcard--general') + (track?.status === 'done' ? ' tcard--done' : '');
  card.dataset.trackKey = key;
  card.dataset.projectId = project.id;
  // What this card is showing, so a session-only refresh can tell whether it
  // has to be rebuilt at all (applySessionStatus).
  card.dataset.sessionKey = cardSessionKey(sessions);
  const state = groupState(sessions);
  const cwdLabel = track?.cwd ? (isPathInside(track.cwd, project.root) ? (track.cwd === project.root ? 'project folder' : track.cwd.slice(project.root.length + 1)) : pathBasename(track.cwd)) : (project.defaultCwd ? pathBasename(project.defaultCwd) : 'project folder');
  const head = document.createElement('div');
  head.className = 'tcard-h';
  const colors = trackColors(project, track);
  head.innerHTML = stateDot(state) +
    `<span class="tcard-name" style="color:${colors.fg}">${escapeHtml(track ? track.name : 'General')}${track?.status === 'done' ? '<span class="project-done-chip">done</span>' : ''}</span>` +
    `<span class="tcard-meta mono">${track ? escapeHtml(cwdLabel) : 'sessions not in a track'}</span>` +
    `<span class="ws-flex"></span>` +
    (track?.cli ? `<span class="ws-chip ws-chip--cli ${track.cli}" title="${escapeHtml(track.cli === 'codex' ? 'Codex' : 'Claude')}">${track.cli === 'codex' ? ICONS.codex(12) : ICONS.claude(12)}</span>` : '') +
    `<button type="button" class="ws-ghost ws-ghost--sm tcard-new">${PICONS.plus(11)}<span>New session</span></button>` +
    (track ? `<button type="button" class="tcard-more" title="Track menu">${PICONS.dots(13)}</button>` : '');
  card.appendChild(head);

  const shown = sessions.slice(0, 3);
  for (const s of shown) card.appendChild(buildCardSessionRow(project, s));
  if (!sessions.length) {
    const none = document.createElement('div');
    none.className = 'tcard-empty';
    none.textContent = track ? 'No sessions yet.' : 'Nothing here. Sessions started from the header land here.';
    card.appendChild(none);
  }

  const foot = document.createElement('div');
  foot.className = 'tcard-f';
  foot.innerHTML =
    (sessions.length > 3 ? `<button type="button" class="ws-ghost ws-ghost--muted tcard-more-sessions">+ ${sessions.length - 3} more</button>` : '') +
    `<span class="ws-flex"></span>`;
  card.appendChild(foot);
  // Archived sessions of this track sit under the foot, closed until asked for.
  const archived = archivedSessionsOf(project, key);
  if (archived.length) {
    const archKey = `card:${project.id}:${key}`;
    const open = !!projectsUi.archivedOpen[archKey];
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ws-ghost ws-ghost--muted tcard-archived' + (open ? ' open' : '');
    btn.innerHTML = `${PICONS.archive(11)}<span>${archived.length} archived</span>`;
    btn.onclick = () => {
      if (open) delete projectsUi.archivedOpen[archKey]; else projectsUi.archivedOpen[archKey] = true;
      saveProjectsUi();
      // A sessions-only refresh just patches status; the card has to be rebuilt.
      refreshProjectViews();
    };
    foot.appendChild(btn);
    if (open) {
      const list = document.createElement('div');
      list.className = 'tcard-archived-list';
      for (const s of archived) list.appendChild(buildSessionRow(project, s, { showTrack: false, className: 'pane-session tcard-session pane-session--archived', hoverPreview: true }));
      card.appendChild(list);
    }
  }

  // Nothing left to show in the foot once New session moved up to the head.
  if (!foot.querySelector('button')) foot.remove();
  head.querySelector('.tcard-new').onclick = (e) => launchFromTrack(project, track, e.currentTarget);
  const more = foot.querySelector('.tcard-more-sessions');
  if (more) more.onclick = () => openTrackInPanes(project, key);
  const moreBtn = head.querySelector('.tcard-more');
  if (moreBtn) moreBtn.onclick = (e) => { e.stopPropagation(); showContextMenu(trackMenuItems(project, track), { anchor: e.currentTarget }); };
  if (track) card.oncontextmenu = (e) => { e.preventDefault(); showContextMenu(trackMenuItems(project, track), { x: e.clientX, y: e.clientY }); };
  return card;
}

/** Show a track's full session list: open its latest session so the pane opens with that track expanded. */
function openTrackInPanes(project, key) {
  projectsUi.trackByProject[project.id] = key;
  projectsUi.groupBy[project.id] = 'track';
  projectsUi.expandedLists[`${project.id}:track:${key}`] = true;
  saveProjectsUi();
  const sessions = sessionsOfTrack(project, key);
  if (sessions.length) openSession(sessions[0]);
}

// --- Side cards: brief, plan, todos, folders ---

function fileKey(project, name) { return `${project.id}:${name}`; }
function fileContent(project, name) { return projectsUi.files.get(fileKey(project, name))?.content ?? null; }

async function loadProjectFiles(project, { force = false } = {}) {
  const names = ['CLAUDE.md', 'plan.md', 'plan-tracker.md', 'todos.md'];
  await Promise.all(names.map(async name => {
    const key = fileKey(project, name);
    const cached = projectsUi.files.get(key);
    if (!force && cached && Date.now() - cached.at < 5000) return;
    let content = '';
    try { content = await window.api.readMemory(project.root + '/' + name); } catch {}
    projectsUi.files.set(key, { content: typeof content === 'string' ? content : '', at: Date.now() });
  }));
}

function briefSummary(content) {
  if (!content) return { text: '', placeholder: true };
  const lines = content.split(/\r?\n/);
  let i = 0;
  while (i < lines.length && !/^#\s/.test(lines[i])) i++;
  i++;
  const para = [];
  while (i < lines.length) {
    const line = lines[i].trim();
    if (!line) { if (para.length) break; i++; continue; }
    if (/^#/.test(line) || /^Project folder:/.test(line)) break;
    para.push(line);
    i++;
  }
  const text = para.join(' ');
  const placeholder = !text || /^<.*edit me.*>$/i.test(text);
  return { text, placeholder };
}

// parsePlan and parseTodos come from plan-parser.js, shared with main so the
// page, the file watcher and the tests read a tracker the same way. Ticks and
// additions go through main (set-plan-item / append-plan-item), which writes
// one line and tells its watcher the page did it.

function planKindFor(name) {
  return name === 'todos.md' ? 'todos' : 'plan';
}

/**
 * Double-click editing for a checkbox line. The text span becomes an input;
 * Enter saves through edit-plan-item, Escape or leaving the field puts the
 * text back. Only the checkbox ever changes the tick.
 */
function editItemInline(project, kind, item, textEl, afterSave) {
  if (textEl.parentElement?.querySelector('.ws-todo-edit')) return;
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'ws-input ws-todo-edit';
  input.value = item.text;
  input.spellcheck = false;
  let finished = false;
  const restore = () => { if (finished) return; finished = true; input.replaceWith(textEl); };
  input.onkeydown = async (e) => {
    if (e.key === 'Escape') { e.preventDefault(); restore(); return; }
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const text = input.value.trim();
    if (!text || text === item.text) { restore(); return; }
    input.disabled = true;
    const result = await window.api.editPlanItem(project.id, kind, item.line, text);
    if (result?.error) { alert(result.error); input.disabled = false; input.focus(); return; }
    finished = true;
    item.text = text;
    textEl.textContent = text;
    input.replaceWith(textEl);
    afterSave?.();
  };
  input.onblur = () => { if (!input.disabled) restore(); };
  textEl.replaceWith(input);
  input.focus();
  input.select();
}

async function toggleFileLine(project, name, lineNo, done) {
  const result = await window.api.setPlanItem(project.id, planKindFor(name), lineNo, done);
  if (result?.error) { alert(result.error); return false; }
  await loadProjectFiles(project, { force: true });
  return true;
}

async function appendTodo(project, text) {
  const result = await window.api.appendPlanItem(project.id, 'todos', text);
  if (result?.error) { alert(result.error); return false; }
  await loadProjectFiles(project, { force: true });
  return true;
}

/** Open one of the project's own files on the Files tab, in the page's editor. */
function openProjectFileInEditor(project, name) {
  filesState(project).selected = name;
  setProjectTab(project, 'files');
  if (!projectViewer || projectViewer.style.display === 'none') showProjectOverview();
  else renderOverview();
}

// --- Plan tab: phases from plan-tracker.md, the todos, and who worked on what ---
//
// Data comes from main (get-project-plan): the parsed tracker and todos plus
// the plan_links rows that say which session started or ticked an item. A
// phase or a todo can start a session with the item as its first prompt; the
// session is filed in the project (and a chosen track) and linked to the item.

const planTabState = new Map(); // projectId → { data, error, expanded: Set<phase line>, showDone }

function planState(project) {
  let state = planTabState.get(project.id);
  if (!state) {
    state = { data: null, error: null, expanded: new Set(), showDone: false };
    planTabState.set(project.id, state);
  }
  return state;
}

async function loadProjectPlan(project) {
  const state = planState(project);
  let result;
  try { result = await window.api.getProjectPlan(project.id); } catch (err) { result = { error: err.message }; }
  state.data = result?.ok ? result : null;
  state.error = result?.ok ? null : (result?.error || 'Could not read the plan');
  return state;
}

function linksFor(data, kind, text) {
  return (data?.links || []).filter(l => l.file === kind && l.itemText === text);
}

/** Sessions linked to an item that are still known, most recent first. */
function linkedSessions(data, kind, text) {
  const seen = new Set();
  const out = [];
  for (const link of linksFor(data, kind, text).slice().reverse()) {
    if (seen.has(link.sessionId)) continue;
    seen.add(link.sessionId);
    const session = sessionMap.get(link.sessionId);
    if (session) out.push({ session, link });
  }
  return out;
}

function phasePrompt(data, phase) {
  const lines = [`Work on this phase of the plan. The tracker is ${data.trackerPath}` + (data.hasPlan ? ` and the plan itself is ${data.planPath}.` : '.'), '', `Phase: ${phase.title}`];
  const open = phase.items.filter(it => !it.done);
  if (open.length) { lines.push('', 'Open items:'); for (const it of open) lines.push(`- ${it.text}`); }
  lines.push('', 'When an item is finished, tick it in the tracker. Tick the phase heading once the whole phase is done.');
  return lines.join('\n');
}

function todoPrompt(data, item) {
  return `Work on this todo from ${data.todosPath}:\n\n${item.text}\n\nWhen it is done, tick it in todos.md.`;
}

/** Claude / Codex rows that launch with a first prompt, filed under the item. */
function startItemRows(project, track, prompt, planItem) {
  const target = launchTargetFor(project, track);
  const launch = async (runtime) => {
    const options = await resolveDefaultSessionOptions(target);
    options.runtime = runtime;
    options.initialPrompt = prompt;
    options.planItem = planItem;
    launchNewSession(target, options);
  };
  const where = track ? track.name : (project.defaultCwd ? pathBasename(project.defaultCwd) : 'project folder');
  return [
    { label: 'Claude', icon: ICONS.claude(14), hint: `in ${where}`, onClick: () => launch('claude') },
    { label: 'Codex', icon: ICONS.codex(14, 'codex-icon'), onClick: () => launch('codex') },
  ];
}

function showStartItemMenu(project, kind, itemText, prompt, anchor) {
  const planItem = { file: kind, itemText };
  const items = [{ head: 'Start a session on this' }, ...startItemRows(project, null, prompt, planItem)];
  const tracks = (project.tracks || []).filter(t => t.status !== 'done');
  if (tracks.length) {
    items.push({ sep: true }, { head: 'In a track' });
    for (const t of tracks) items.push({ label: t.name, icon: PICONS.list(13), submenu: startItemRows(project, t, prompt, planItem) });
  }
  showContextMenu(items, { anchor });
}

function linkedBadge(project, data, kind, text) {
  const linked = linkedSessions(data, kind, text);
  if (!linked.length) return null;
  const badge = document.createElement('button');
  badge.type = 'button';
  badge.className = 'ws-plan-links';
  badge.title = linked.map(({ session }) => sessionTitle(session)).join('\n');
  badge.textContent = `${linked.length} session${linked.length === 1 ? '' : 's'}`;
  badge.onclick = (e) => {
    e.stopPropagation();
    if (linked.length === 1) { openSession(linked[0].session); return; }
    showContextMenu([{ head: 'Sessions that worked on this' }, ...linked.map(({ session, link }) => ({
      label: sessionTitle(session), icon: cliIcon(session, 13),
      hint: `${link.kind === 'started' ? 'started' : 'ticked'} · ${formatDate(new Date(link.at))}`,
      onClick: () => openSession(session),
    }))], { anchor: e.currentTarget });
  };
  return badge;
}

/** What the Plan tab draws from, so a refetch that changed nothing draws nothing. */
function planSignature(state) {
  const data = state.data;
  if (!data) return 'error:' + (state.error || '');
  return JSON.stringify([
    (data.plan?.phases || []).map(p => [p.line, p.title, p.done, (p.items || []).map(i => [i.line, i.text, i.done])]),
    (data.todos || []).map(t => [t.line, t.text, t.done]),
    (data.links || []).map(l => [l.file, l.itemText, l.sessionId, l.kind]),
  ]);
}

function renderPlanTab(project, body) {
  const state = planState(project);
  // Only the first look at a project has nothing to show. A refresh keeps what
  // is on screen — a running session writes constantly, and blanking the tab
  // each time made the todos flicker away and took any open field with them.
  if (state.data || state.error) renderPlanBody(project, body, state);
  else body.innerHTML = '<div class="ws-plan"><div class="ws-card-text muted">Loading the plan…</div></div>';
  const before = planSignature(state);
  loadProjectPlan(project).then(() => {
    if (selectedProject()?.id !== project.id || projectTab(project) !== 'plan') return;
    if (!projectViewer.contains(body)) return;
    // Redraw only when the plan or the todos actually moved, so a field being
    // typed into survives a refresh that changed nothing. A field that is open
    // holds the redraw off entirely; the next refresh picks it up.
    if (editingInPage()) return;
    if (planSignature(state) !== before || (!state.data && !state.error)) renderPlanBody(project, body, state);
    renderPlanMeta(project);
  });
}

function renderPlanBody(project, body, state) {
  const data = state.data;
  const plan = data?.plan || { phases: [], done: 0, total: 0, next: null };
  const todos = data?.todos || [];
  const open = todos.filter(t => !t.done);
  const doneTodos = todos.filter(t => t.done);
  const pct = plan.total ? Math.round((plan.done / plan.total) * 100) : 0;

  body.innerHTML = `
    <div class="ws-plan">
      <div class="ws-card ws-plan-card">
        <div class="ws-card-h">
          <span class="ws-card-title">Plan</span>
          <span class="ws-card-meta">${plan.total ? `${plan.done} of ${plan.total} phases` : ''}</span>
          <span class="ws-flex"></span>
          <button type="button" class="ws-ghost ws-ghost--sm" id="plan-open-plan" title="The plan as written">plan.md</button>
          <button type="button" class="ws-ghost ws-ghost--sm" id="plan-open-tracker" title="The phases Switchboard reads">plan-tracker.md</button>
        </div>
        ${plan.total ? `<div class="ws-progress"><div class="ws-progress-fill" style="width:${pct}%"></div></div>` : ''}
        <div class="ws-phases" id="ws-phases"></div>
      </div>
      <div class="ws-card ws-plan-card">
        <div class="ws-card-h">
          <span class="ws-card-title">Todos</span>
          <span class="ws-card-meta">${open.length ? `${open.length} open` : ''}${doneTodos.length ? ` · ${doneTodos.length} done` : ''}</span>
          <span class="ws-flex"></span>
          ${doneTodos.length ? `<button type="button" class="ws-ghost ws-ghost--sm ws-ghost--muted" id="plan-todo-done">${state.showDone ? 'Hide done' : `Show ${doneTodos.length} done`}</button>` : ''}
          <button type="button" class="ws-ghost ws-ghost--sm" id="plan-todo-add">${PICONS.plus(11)}<span>Add</span></button>
        </div>
        <div class="ws-todos" id="ws-plan-todos"></div>
      </div>
    </div>`;

  body.querySelector('#plan-open-plan').onclick = () => openProjectFileInEditor(project, 'plan.md');
  body.querySelector('#plan-open-tracker').onclick = () => openProjectFileInEditor(project, 'plan-tracker.md');

  const phasesEl = body.querySelector('#ws-phases');
  if (state.error) {
    phasesEl.innerHTML = `<div class="ws-card-text muted">${escapeHtml(state.error)}</div>`;
  } else if (!plan.total) {
    phasesEl.innerHTML = `<div class="ws-card-text muted">${data?.hasPlan
      ? 'plan.md is written, but plan-tracker.md has no phases yet. Ask a session to keep the tracker up to date, or add phases to it as "## Phase 1: …" headings with "- [ ]" items.'
      : 'No plan yet. Ask a session for one: it writes plan.md and keeps the phases in plan-tracker.md.'}</div>`;
  } else {
    plan.phases.forEach((phase, index) => phasesEl.appendChild(buildPhaseRow(project, state, phase, index)));
  }

  const todosEl = body.querySelector('#ws-plan-todos');
  const shown = state.showDone ? todos : open;
  if (!shown.length) {
    todosEl.innerHTML = `<div class="ws-card-text muted">${todos.length ? 'Everything is done.' : 'Nothing open. Any session can add to todos.md, or add one here.'}</div>`;
  }
  for (const item of shown) todosEl.appendChild(buildTodoRow(project, state, item));

  const toggleDone = body.querySelector('#plan-todo-done');
  if (toggleDone) toggleDone.onclick = () => { state.showDone = !state.showDone; renderPlanBody(project, body, state); };
  body.querySelector('#plan-todo-add').onclick = () => {
    if (todosEl.querySelector('.ws-todo-input')) return;
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'ws-input ws-todo-input';
    input.placeholder = 'What needs doing?';
    input.onkeydown = async (e) => {
      if (e.key === 'Escape') { input.remove(); return; }
      if (e.key !== 'Enter') return;
      const text = input.value.trim();
      if (!text) return;
      input.disabled = true;
      if (await appendTodo(project, text)) { await loadProjectPlan(project); renderPlanBody(project, body, state); }
      else input.disabled = false;
    };
    todosEl.prepend(input);
    input.focus();
  };
}

function buildPhaseRow(project, state, phase, index) {
  const data = state.data;
  const plan = data.plan;
  const isNext = plan.next && plan.next.line === phase.line;
  const hasItems = phase.items.length > 0;
  // The next phase opens by default; the user can still fold it.
  if (!state.collapsed) state.collapsed = new Set();
  const expanded = hasItems && ((isNext && !state.collapsed.has(phase.line)) || state.expanded.has(phase.line));

  const row = document.createElement('div');
  row.className = 'ws-phase' + (phase.done ? ' done' : '') + (isNext ? ' next' : '') + (expanded ? ' expanded' : '');

  const head = document.createElement('div');
  head.className = 'ws-phase-head';
  const box = document.createElement('input');
  box.type = 'checkbox';
  box.className = 'ws-phase-box';
  box.checked = !!phase.done;
  box.title = phase.done ? 'Mark the phase as not done' : 'Mark the whole phase as done';
  box.onclick = (e) => e.stopPropagation();
  box.onchange = async () => {
    box.disabled = true;
    const result = await window.api.setPlanItem(project.id, 'plan', phase.line, box.checked);
    if (result?.error) { alert(result.error); box.disabled = false; box.checked = !box.checked; return; }
    await reloadPlanAndRender(project, state);
  };
  const title = document.createElement('span');
  title.className = 'ws-phase-title';
  title.textContent = phase.title;
  const meta = document.createElement('span');
  meta.className = 'ws-phase-meta';
  meta.textContent = hasItems ? `${phase.ticked}/${phase.items.length}` : (isNext ? 'next' : '');
  head.append(box, title, meta);
  const linked = linkedBadge(project, data, 'plan', phase.title);
  if (linked) head.appendChild(linked);
  head.appendChild(Object.assign(document.createElement('span'), { className: 'ws-flex' }));
  if (!phase.done) {
    const start = document.createElement('button');
    start.type = 'button';
    start.className = 'ws-ghost ws-ghost--sm ws-phase-start';
    start.innerHTML = `${PICONS.play(11)}<span>Start</span>`;
    start.title = `Start a session on "${phase.title}"`;
    start.onclick = (e) => { e.stopPropagation(); showStartItemMenu(project, 'plan', phase.title, phasePrompt(data, phase), e.currentTarget); };
    head.appendChild(start);
  }
  if (hasItems) {
    const chevron = document.createElement('span');
    chevron.className = 'ws-phase-chevron';
    chevron.innerHTML = expanded ? PICONS.chevronDown(11) : PICONS.chevronRight(11);
    head.appendChild(chevron);
    head.onclick = () => {
      const open = !row.classList.contains('expanded');
      row.classList.toggle('expanded', open);
      chevron.innerHTML = open ? PICONS.chevronDown(11) : PICONS.chevronRight(11);
      if (open) { state.expanded.add(phase.line); state.collapsed.delete(phase.line); }
      else { state.expanded.delete(phase.line); state.collapsed.add(phase.line); }
    };
  }
  row.appendChild(head);

  if (hasItems) {
    const list = document.createElement('div');
    list.className = 'ws-phase-items';
    for (const item of phase.items) {
      const line = document.createElement('div');
      line.className = 'ws-todo ws-phase-item' + (item.done ? ' done' : '');
      const itemBox = document.createElement('input');
      itemBox.type = 'checkbox';
      itemBox.checked = item.done;
      itemBox.onchange = async () => {
        itemBox.disabled = true;
        const result = await window.api.setPlanItem(project.id, 'plan', item.line, itemBox.checked);
        if (result?.error) { alert(result.error); itemBox.disabled = false; itemBox.checked = !itemBox.checked; return; }
        await reloadPlanAndRender(project, state);
      };
      const text = document.createElement('span');
      text.className = 'ws-todo-text';
      text.title = 'Double-click to edit';
      text.textContent = item.text;
      text.ondblclick = () => editItemInline(project, 'plan', item, text, () => loadProjectPlan(project));
      line.append(itemBox, text);
      const itemLinked = linkedBadge(project, data, 'plan', item.text);
      if (itemLinked) line.appendChild(itemLinked);
      if (!item.done) {
        const startItem = document.createElement('button');
        startItem.type = 'button';
        startItem.className = 'ws-item-start';
        startItem.title = 'Start a session on this item';
        startItem.innerHTML = PICONS.play(10);
        startItem.onclick = (e) => {
          e.preventDefault();
          e.stopPropagation();
          const prompt = `Work on this item from phase "${phase.title}" of the plan. The tracker is ${data.trackerPath}.\n\n${item.text}\n\nWhen it is done, tick it in the tracker.`;
          showStartItemMenu(project, 'plan', item.text, prompt, e.currentTarget);
        };
        line.appendChild(startItem);
      }
      list.appendChild(line);
    }
    row.appendChild(list);
  }
  return row;
}

function buildTodoRow(project, state, item) {
  const data = state.data;
  const line = document.createElement('div');
  line.className = 'ws-todo' + (item.done ? ' done' : '');
  const box = document.createElement('input');
  box.type = 'checkbox';
  box.checked = item.done;
  box.title = item.done ? 'Mark open' : 'Mark done';
  box.onchange = async () => {
    box.disabled = true;
    const result = await window.api.setPlanItem(project.id, 'todos', item.line, box.checked);
    if (result?.error) { alert(result.error); box.disabled = false; box.checked = !box.checked; return; }
    await loadProjectFiles(project, { force: true });
    await reloadPlanAndRender(project, state);
  };
  const text = document.createElement('span');
  text.className = 'ws-todo-text';
  text.title = 'Double-click to edit';
  text.textContent = item.text;
  text.ondblclick = () => editItemInline(project, 'todos', item, text, () => loadProjectFiles(project, { force: true }));
  line.append(box, text);
  const linked = linkedBadge(project, data, 'todos', item.text);
  if (linked) line.appendChild(linked);
  if (!item.done) {
    const start = document.createElement('button');
    start.type = 'button';
    start.className = 'ws-item-start';
    start.title = 'Start a session on this todo';
    start.innerHTML = PICONS.play(10);
    start.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      showStartItemMenu(project, 'todos', item.text, todoPrompt(data, item), e.currentTarget);
    };
    line.appendChild(start);
  }
  return line;
}

async function reloadPlanAndRender(project, state) {
  await loadProjectPlan(project);
  await loadProjectFiles(project, { force: true });
  const body = projectViewer?.querySelector('#ws-body');
  if (!body || selectedProject()?.id !== project.id || projectTab(project) !== 'plan') return;
  renderPlanBody(project, body, state);
  renderPlanMeta(project);
}

// A session ticked something, or a file changed on disk: refresh what shows it.
window.api.onProjectPlanChanged?.((projectId) => {
  const project = findTreeProject(projectId);
  if (!project) return;
  // The cached plan is kept: renderPlanTab refetches and only redraws when the
  // plan or the todos actually moved, so the tab never blanks.
  loadProjectFiles(project, { force: true }).then(() => {
    if (selectedProject()?.id !== projectId || activeTab !== 'projects') return;
    if (projectsUi.working) { renderPanes(project); return; }
    if (projectViewer && projectViewer.style.display !== 'none') {
      if (editingInPage()) return;
      if (projectTab(project) === 'plan') renderPlanTab(project, projectViewer.querySelector('#ws-body'));
      else renderOverview();
    }
  });
});

// --- Files tab: the project folder with an editor beside it ---
//
// One ViewerPanel serves the whole page. Its DOM moves between renders rather
// than being rebuilt, so an unsaved edit survives the re-render that every
// projects-changed event triggers, and the file is not reloaded underneath
// the cursor. Saving CLAUDE.md or AGENTS.md goes through save-project-brief,
// which writes both files and every worktree's bridge copy.

const FILES_LIST_TTL_MS = 10 * 1000;
// Files the brief names and the agent creates on demand; opening one from a
// card creates it so there is something to edit.
const PROJECT_OWN_FILES = ['plan.md', 'plan-tracker.md', 'todos.md', 'memory.md'];
let projectEditor = null; // { host, panel, projectId, rel }

function filesState(project) {
  if (!projectsUi.filesByProject) projectsUi.filesByProject = {};
  let state = projectsUi.filesByProject[project.id];
  if (!state) {
    state = projectsUi.filesByProject[project.id] = { expanded: new Set(), selected: null, cache: new Map() };
  }
  return state;
}

function ensureProjectEditor() {
  if (projectEditor) return projectEditor;
  const host = document.createElement('div');
  host.className = 'ws-editor-panel';
  const panel = new ViewerPanel(host, {
    copyPath: true, copyContent: true, language: 'auto', storageKey: 'markdownPreviewMode',
    onSave: (filePath, content) => saveProjectEditorFile(filePath, content),
  });
  projectEditor = { host, panel, projectId: null, rel: null };
  return projectEditor;
}

function isBriefFile(rel) {
  return rel === 'CLAUDE.md' || rel === 'AGENTS.md';
}

async function saveProjectEditorFile(filePath, content) {
  const ed = projectEditor;
  const project = ed ? findTreeProject(ed.projectId) : null;
  if (!project) return { ok: false };
  let result;
  if (isBriefFile(ed.rel)) {
    result = await window.api.saveProjectBrief(project.id, content);
  } else {
    result = await window.api.saveFileForPanel(filePath, content);
  }
  if (!result || result.error || result.ok === false) {
    alert(result?.error || 'Could not save the file.');
    return { ok: false };
  }
  // The brief comes back with its folder block restored when the user had
  // removed it; show what is on disk now.
  if (isBriefFile(ed.rel) && typeof result.content === 'string' && result.content !== content) {
    ed.panel.open(`${project.name} · ${ed.rel}`, filePath, result.content);
  }
  const saved = isBriefFile(ed.rel) && typeof result.content === 'string' ? result.content : content;
  if (['CLAUDE.md', 'plan.md', 'plan-tracker.md', 'todos.md'].includes(ed.rel)) {
    projectsUi.files.set(fileKey(project, ed.rel), { content: saved, at: Date.now() });
    renderPlanMeta(project);
  }
  return { ok: true };
}

async function openFileInProjectEditor(project, rel) {
  const state = filesState(project);
  state.selected = rel;
  const host = projectViewer?.querySelector('#ws-editor');
  if (!host) return;
  projectViewer.querySelectorAll('.ws-file-row').forEach(r => r.classList.toggle('selected', r.dataset.rel === rel));
  const ed = ensureProjectEditor();
  const filePath = project.root + '/' + rel;
  // Same file already open: keep the editor and whatever is typed in it.
  if (ed.projectId === project.id && ed.rel === rel && ed.panel.filePath === filePath) {
    host.replaceChildren(ed.host);
    return;
  }
  let result;
  try { result = await window.api.readProjectFile(project.root, rel); } catch (err) { result = { ok: false, error: err.message }; }
  // The project's own files are not made up front; opening one to write it
  // is the moment it comes into being.
  if (!result?.ok && PROJECT_OWN_FILES.includes(rel)) {
    const created = await window.api.createProjectFile(project.id, rel);
    if (created?.ok) {
      try { result = await window.api.readProjectFile(project.root, rel); } catch (err) { result = { ok: false, error: err.message }; }
      filesState(project).cache.clear();
    }
  }
  if (!result?.ok) {
    host.innerHTML = `<div class="ws-editor-empty">${escapeHtml(result?.error || 'Could not open the file.')}</div>`;
    return;
  }
  ed.projectId = project.id;
  ed.rel = rel;
  host.replaceChildren(ed.host);
  ed.panel.open(`${project.name} · ${rel}`, result.filePath || filePath, result.content);
}

async function listProjectDir(project, state, rel) {
  const cached = state.cache.get(rel);
  if (cached && Date.now() - cached.at < FILES_LIST_TTL_MS) return cached.entries;
  let result;
  try { result = await window.api.listProjectDirectory(project.root, rel); } catch (err) { result = { ok: false, error: err.message }; }
  const entries = result?.ok ? result.entries : [];
  state.cache.set(rel, { at: Date.now(), entries, error: result?.ok ? null : (result?.error || 'Could not read the folder') });
  return entries;
}

async function renderFileTree(project, list, state) {
  const rows = [];
  async function walk(rel, depth) {
    const entries = await listProjectDir(project, state, rel);
    for (const entry of entries) {
      // Worktrees live under repos/ and are browsed from their own sessions;
      // listing a whole checkout here would swamp the project's own files.
      if (depth === 0 && entry.type === 'directory' && entry.name === 'repos') continue;
      if (entry.type === 'other') continue;
      rows.push({ entry, depth });
      if (entry.type === 'directory' && state.expanded.has(entry.relativePath)) await walk(entry.relativePath, depth + 1);
    }
  }
  await walk('', 0);
  if (!list.isConnected) return;
  list.replaceChildren();
  const rootError = state.cache.get('')?.error;
  if (rootError) { list.innerHTML = `<div class="ws-card-text muted">${escapeHtml(rootError)}</div>`; return; }
  if (!rows.length) { list.innerHTML = '<div class="ws-card-text muted">The project folder is empty.</div>'; return; }
  for (const { entry, depth } of rows) {
    const isDir = entry.type === 'directory';
    const open = isDir && state.expanded.has(entry.relativePath);
    const row = document.createElement('div');
    row.className = 'ws-file-row' + (isDir ? ' is-dir' : '') + (!isDir && entry.viewable === false ? ' is-binary' : '') +
      (state.selected === entry.relativePath ? ' selected' : '');
    row.dataset.rel = entry.relativePath;
    row.style.paddingLeft = `${10 + depth * 14}px`;
    row.title = !isDir && entry.viewable === false ? `${entry.relativePath} (not a text file)` : entry.relativePath;
    row.innerHTML = `<span class="ws-file-icon">${isDir ? (open ? '&#9662;' : '&#9656;') : ''}</span><span class="ws-file-name">${escapeHtml(entry.name)}</span>`;
    row.onclick = async () => {
      if (isDir) {
        if (open) state.expanded.delete(entry.relativePath); else state.expanded.add(entry.relativePath);
        await renderFileTree(project, list, state);
        return;
      }
      if (entry.viewable === false) return;
      openFileInProjectEditor(project, entry.relativePath);
    };
    list.appendChild(row);
  }
}

async function renderFilesTab(project, body) {
  body.classList.add('ws-body--files');
  body.innerHTML = `
    <div class="ws-files">
      <div class="ws-files-side">
        <div class="ws-files-head"><span class="ws-card-title">Project folder</span><span class="ws-flex"></span><button type="button" class="ws-ghost ws-ghost--sm" id="ws-files-open">${PICONS.open(11)}<span>Open folder</span></button><button type="button" class="ws-ghost ws-ghost--sm" id="ws-files-refresh">Refresh</button></div>
        <div class="ws-files-list" id="ws-files-list"></div>
        <div class="ws-help ws-files-hint">CLAUDE.md is the brief every session reads. The agent creates plan.md, plan-tracker.md, todos.md and memory.md when it needs them. Attached repositories are not listed here.</div>
      </div>
      <div class="ws-editor" id="ws-editor"><div class="ws-editor-empty">Pick a file to read or edit it here.</div></div>
    </div>`;
  const state = filesState(project);
  const list = body.querySelector('#ws-files-list');
  body.querySelector('#ws-files-open').onclick = async () => {
    const result = await window.api.openPath(project.root);
    if (result?.error) alert(result.error);
  };
  body.querySelector('#ws-files-refresh').onclick = async () => {
    state.cache.clear();
    await renderFileTree(project, list, state);
  };
  await renderFileTree(project, list, state);
  if (state.selected && selectedProject()?.id === project.id) await openFileInProjectEditor(project, state.selected);
}

/** True when plan.md holds more than its heading and the template comment. */
function hasPlanText(content) {
  if (!content) return false;
  const stripped = content.replace(/<!--[\s\S]*?-->/g, '').split(/\r?\n/)
    .filter(line => line.trim() && !/^#\s/.test(line.trim()));
  return stripped.length > 0;
}

function bindAddedFilesCard(project, side) {
  const dropZone = side.querySelector('#ws-added-files-drop');
  if (!dropZone) return;
  let dragDepth = 0;
  const setOver = (over) => dropZone.classList.toggle('is-over', over);

  dropZone.addEventListener('dragenter', (event) => {
    event.preventDefault();
    event.stopPropagation();
    dragDepth++;
    setOver(true);
  });
  dropZone.addEventListener('dragover', (event) => {
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = 'copy';
  });
  dropZone.addEventListener('dragleave', (event) => {
    event.preventDefault();
    event.stopPropagation();
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) setOver(false);
  });
  dropZone.addEventListener('drop', async (event) => {
    event.preventDefault();
    event.stopPropagation();
    dragDepth = 0;
    setOver(false);
    const sourcePaths = Array.from(event.dataTransfer.files || []).map(file => {
      try { return window.api.getPathForFile(file); } catch { return ''; }
    }).filter(Boolean);
    if (!sourcePaths.length) return;

    dropZone.classList.add('is-busy');
    const label = dropZone.querySelector('.ws-added-drop-label');
    if (label) label.textContent = `Adding ${sourcePaths.length} file${sourcePaths.length === 1 ? '' : 's'}…`;
    let result;
    try { result = await window.api.addProjectFiles(project.id, sourcePaths); }
    catch (err) { result = { error: err.message }; }
    if (!result?.ok) {
      dropZone.classList.remove('is-busy');
      if (label) label.textContent = 'Drop files here';
      alert(result?.error || 'Could not add the files.');
      return;
    }

    project.addedFiles = result.files || [];
    project.addedFilesPath = result.dirPath || project.addedFilesPath;
    filesState(project).cache.clear();
    renderSideCards(project, side);
    if (result.errors?.length) alert(`Some items could not be added:\n\n${result.errors.join('\n')}`);
  });

  const open = side.querySelector('#ws-added-files-open');
  if (open) open.onclick = async () => {
    const result = await window.api.openPath(project.addedFilesPath);
    if (result?.error) alert(result.error);
  };
}

function renderSideCards(project, side) {
  const brief = briefSummary(fileContent(project, 'CLAUDE.md'));
  const plan = parsePlan(fileContent(project, 'plan-tracker.md'));
  const planWritten = hasPlanText(fileContent(project, 'plan.md'));
  const todos = parseTodos(fileContent(project, 'todos.md'));
  const open = todos.filter(t => !t.done);
  const doneTodos = todos.length - open.length;
  const pct = plan.phases.length ? Math.round((plan.done / plan.phases.length) * 100) : 0;
  const addedFiles = project.addedFiles || [];

  side.innerHTML = `
    <div class="ws-card">
      <div class="ws-card-h"><span class="ws-card-title">Brief</span><span class="ws-flex"></span><button type="button" class="ws-ghost ws-ghost--sm" id="ws-brief-edit">${brief.placeholder ? 'Write it' : 'Edit'}</button></div>
      <div class="ws-card-text ${brief.placeholder ? 'muted' : ''}">${brief.placeholder ? 'One line about the goal goes at the top of CLAUDE.md. Every session in this project reads it.' : escapeHtml(brief.text)}</div>
    </div>
    <div class="ws-card">
      <div class="ws-card-h"><span class="ws-card-title">Plan</span><span class="ws-card-meta">${plan.phases.length ? `${plan.done} of ${plan.phases.length} phases` : ''}</span><span class="ws-flex"></span><button type="button" class="ws-ghost ws-ghost--sm" id="ws-plan-tracker" title="plan-tracker.md: the phases Switchboard reads">Tracker</button><button type="button" class="ws-ghost ws-ghost--sm" id="ws-plan-open" title="plan.md: the plan as written">Open</button></div>
      ${plan.phases.length ? `
        <div class="ws-progress"><div class="ws-progress-fill" style="width:${pct}%"></div></div>
        <div class="ws-card-row">${plan.next ? `${stateDot('', 'proj-dot--next')}<span class="ws-card-strong">Next: ${escapeHtml(plan.next.title)}</span>` : `${stateDot('', 'proj-dot--done')}<span class="ws-card-strong">Every phase is done</span>`}</div>`
        : `<div class="ws-card-text muted">${planWritten ? 'A plan is written, but plan-tracker.md has no phases yet. Ask a session to keep the tracker up to date.' : 'No plan yet. Ask a session for one: it writes plan.md and keeps the phases in plan-tracker.md.'}</div>`}
    </div>
    <div class="ws-card">
      <div class="ws-card-h"><span class="ws-card-title">Todos</span><span class="ws-card-meta">${open.length ? `${open.length} open` : ''}${doneTodos ? ` · ${doneTodos} done` : ''}</span><span class="ws-flex"></span><button type="button" class="ws-ghost ws-ghost--sm" id="ws-todo-add">${PICONS.plus(11)}<span>Add</span></button></div>
      <div id="ws-todos">${open.length ? open.slice(0, 8).map(t => `<div class="ws-todo" data-line="${t.line}"><input type="checkbox" data-line="${t.line}" title="Mark done"><span class="ws-todo-text" title="Double-click to edit">${escapeHtml(t.text)}</span><button type="button" class="ws-item-start" data-line="${t.line}" title="Start a session on this todo">${PICONS.play(10)}</button></div>`).join('') : '<div class="ws-card-text muted">Nothing open. Any session can add to todos.md.</div>'}${open.length > 8 ? `<button type="button" class="ws-ghost ws-ghost--muted" id="ws-todo-more">+ ${open.length - 8} more</button>` : ''}</div>
      <div class="ws-card-hint">Any session can add here. Try "add a todo: …" in a session of this project.</div>
    </div>
    <div class="ws-card">
      <div class="ws-card-h"><span class="ws-card-title">Attached Folders</span><span class="ws-flex"></span><button type="button" class="ws-ghost ws-ghost--sm" id="ws-folders-add">${PICONS.plus(11)}<span>Attach</span></button></div>
      ${(project.folders || []).length ? (project.folders || []).map(f => `
        <div class="ws-frow" data-path="${escapeHtml(f.path)}" data-detail="mode" title="${escapeHtml(f.path)}">
          <span class="ws-frow-icon ${f.mode === 'worktree' ? 'is-worktree' : ''}">${f.mode === 'worktree' ? PICONS.branch(13) : PICONS.folder(13)}</span>
          <span class="ws-frow-name">${escapeHtml(pathBasename(f.path))}</span>
          <span class="ws-card-meta mono">${escapeHtml(folderModeText(project, f))}</span>
        </div>`).join('') : '<div class="ws-card-text muted">No folders attached. Sessions run in the project folder.</div>'}
    </div>
    <div class="ws-card ws-added-files-card">
      <div class="ws-card-h"><span class="ws-card-title">Added Files</span><span class="ws-card-meta">${addedFiles.length ? `${addedFiles.length} file${addedFiles.length === 1 ? '' : 's'}` : ''}</span><span class="ws-flex"></span>${addedFiles.length ? '<button type="button" class="ws-ghost ws-ghost--sm" id="ws-added-files-open">Open</button>' : ''}</div>
      <div class="ws-added-drop" id="ws-added-files-drop">
        <span class="ws-added-drop-icon">${PICONS.plus(14)}</span>
        <span><span class="ws-added-drop-label">Drop files here</span><span class="ws-added-drop-hint">Copied into added-files/ in the project folder</span></span>
      </div>
      ${addedFiles.length ? `<div class="ws-added-list">${addedFiles.map(file => `
        <div class="ws-added-file" title="${escapeHtml(file.relativePath)}">
          <span class="ws-frow-icon">${PICONS.file(13)}</span>
          <span class="ws-added-file-name">${escapeHtml(file.name)}</span>
        </div>`).join('')}</div>` : ''}
    </div>`;

  side.querySelector('#ws-brief-edit').onclick = () => openProjectFileInEditor(project, 'CLAUDE.md');
  side.querySelector('#ws-plan-open').onclick = () => openProjectFileInEditor(project, 'plan.md');
  side.querySelector('#ws-plan-tracker').onclick = () => openProjectFileInEditor(project, 'plan-tracker.md');
  side.querySelector('#ws-folders-add').onclick = () => attachFolderAsk(project);
  bindAddedFilesCard(project, side);
  side.querySelectorAll('.ws-todo input').forEach(box => {
    box.onchange = async () => {
      box.disabled = true;
      if (await toggleFileLine(project, 'todos.md', Number(box.dataset.line), box.checked)) renderSideCards(project, side);
      else box.disabled = false;
    };
  });
  // Double-click the text to edit it in place; a single click does nothing.
  side.querySelectorAll('.ws-todo .ws-todo-text').forEach(span => {
    span.ondblclick = () => {
      const item = open.find(t => t.line === Number(span.parentElement.dataset.line));
      if (item) editItemInline(project, 'todos', item, span, () => loadProjectFiles(project, { force: true }));
    };
  });
  // Same Start as the Plan tab: the todo becomes the session's first prompt.
  side.querySelectorAll('.ws-todo .ws-item-start').forEach(btn => {
    btn.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      const item = open.find(t => t.line === Number(btn.dataset.line));
      if (!item) return;
      const todosPath = project.root + '/todos.md';
      showStartItemMenu(project, 'todos', item.text, todoPrompt({ todosPath }, item), btn);
    };
  });
  const more = side.querySelector('#ws-todo-more');
  if (more) more.onclick = () => openProjectFileInEditor(project, 'todos.md');
  side.querySelector('#ws-todo-add').onclick = () => {
    const list = side.querySelector('#ws-todos');
    if (list.querySelector('.ws-todo-input')) return;
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'ws-input ws-todo-input';
    input.placeholder = 'What needs doing?';
    input.onkeydown = async (e) => {
      if (e.key === 'Escape') { input.remove(); return; }
      if (e.key !== 'Enter') return;
      const text = input.value.trim();
      if (!text) return;
      input.disabled = true;
      if (await appendTodo(project, text)) renderSideCards(project, side);
    };
    list.prepend(input);
    input.focus();
  };
}

// --- Settings tab ---

function renderSettings(project, body) {
  const shared = project.sharedBranch !== false;
  body.innerHTML = `
    <div class="ws-settings ws-rows">
      <div class="ws-sec">Project</div>
      <div class="ws-card">
        <div class="ws-row">
          <div class="ws-row-k"><b>Name</b></div>
          <div class="ws-row-v"><input type="text" class="ws-input" id="ws-set-name" value="${escapeHtml(project.name)}" spellcheck="false"><span class="ws-saved" id="ws-set-name-saved">${PICONS.check(11)}<span>Saved</span></span></div>
        </div>
        <div class="ws-row">
          <div class="ws-row-k"><b>Project folder</b><span>The brief, plan and todos live here.</span></div>
          <div class="ws-row-v"><span class="mono ws-path ws-path--clip" title="${escapeHtml(project.root)}">${escapeHtml(shortPathLabel(project.root))}</span><button type="button" class="ws-ghost ws-ghost--sm" id="ws-set-open">${PICONS.open(12)}<span>Open</span></button></div>
        </div>
        <div class="ws-row">
          <div class="ws-row-k"><b>Sessions start in</b><span>A track can pick its own.</span></div>
          <div class="ws-row-v" id="ws-set-cwd"></div>
        </div>
      </div>

      <div class="ws-sec"><span>Folders</span><button type="button" class="ws-ghost ws-ghost--sm ws-ghost--accent" id="ws-set-attach">${PICONS.plus(11)}<span>Attach folder…</span></button></div>
      <div class="ws-card">
        <div id="ws-set-folders"></div>
        <div class="ws-row" id="ws-set-branch-row">
          <div class="ws-row-k"><b>Worktree branch</b><span id="ws-set-branch-help"></span></div>
          <div class="ws-row-v">
            <input type="text" class="ws-input mono" id="ws-set-branch" value="${escapeHtml(project.branchName || '')}" placeholder="${escapeHtml(project.slug)}" spellcheck="false" title="Enter or click away to save">
            <span class="ws-saved" id="ws-set-branch-saved">${PICONS.check(11)}<span>Saved</span></span>
            <label class="ws-check ws-check--switch"><input type="checkbox" class="ws-switch-input" id="ws-set-shared" ${shared ? 'checked' : ''}><span class="ws-switch"></span>Same in every repo</label>
          </div>
        </div>
      </div>

      <div class="ws-sec"><span>Tracks</span><button type="button" class="ws-ghost ws-ghost--sm ws-ghost--accent" id="ws-set-new-track">${PICONS.plus(11)}<span>New track</span></button></div>
      <div class="ws-card" id="ws-set-tracks"></div>

      <div class="ws-foot">
        <button type="button" class="ws-btn" id="ws-set-status">${project.status === 'done' ? 'Reopen project' : 'Mark as done'}</button>
        <button type="button" class="ws-link-danger" id="ws-set-remove">Remove project…</button>
        <span class="ws-foot-note">Changes save as you make them.</span>
      </div>
    </div>`;

  const q = (sel) => body.querySelector(sel);

  // Name: saved on Enter or when the field loses focus, with a short "Saved".
  const nameInput = q('#ws-set-name');
  const saveName = async () => {
    const name = nameInput.value.trim();
    if (!name) { nameInput.value = project.name; return; }
    if (name === project.name) return;
    const result = await window.api.updateProject(project.id, { name });
    if (result?.error) { alert(result.error); nameInput.value = project.name; return; }
    project.name = name;
    flashSaved(q('#ws-set-name-saved'));
    loadProjects();
  };
  nameInput.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); nameInput.blur(); } };
  nameInput.onblur = saveName;
  q('#ws-set-open').onclick = () => window.api.openPath(project.root);

  q('#ws-set-cwd').appendChild(buildCwdField(project, project.defaultCwd, `Project folder (${pathBasename(project.root)})`, [], async (defaultCwd) => {
    const result = await window.api.updateProject(project.id, { defaultCwd });
    if (result?.error) { alert(result.error); return; }
    loadProjects();
  }));

  const foldersEl = q('#ws-set-folders');
  if (!(project.folders || []).length) foldersEl.innerHTML = '<div class="ws-item ws-item--empty">None attached. Sessions run in the project folder.</div>';
  for (const folder of project.folders || []) {
    const row = document.createElement('div');
    row.className = 'ws-item ws-frow';
    row.dataset.path = folder.path;
    row.dataset.detail = 'settings';
    const isWorktree = folder.mode === 'worktree';
    row.innerHTML = `<span class="ws-frow-icon ${isWorktree ? 'is-worktree' : ''}">${isWorktree ? PICONS.branch(13) : PICONS.folder(13)}</span>` +
      `<span class="ws-frow-name">${escapeHtml(pathBasename(folder.path))}</span>` +
      `<span class="ws-card-meta mono ws-frow-detail">${escapeHtml(folderSettingsText(project, folder))}</span>` +
      `<button type="button" class="ws-ghost ws-ghost--sm ws-item-open" title="Open in Finder">${PICONS.open(11)}<span>Open</span></button>` +
      `<button type="button" class="ws-ghost ws-ghost--sm ws-item-x" title="Detach">${PICONS.x(12)}</button>`;
    row.querySelector('.ws-item-open').onclick = () => window.api.openPath(folder.path);
    row.querySelector('.ws-item-x').onclick = () => detachFolderFlow(project, folder);
    foldersEl.appendChild(row);
  }
  q('#ws-set-attach').onclick = () => attachFolderAsk(project);

  // Worktree branch: the name saves on Enter or blur, the switch saves at once.
  const sharedBox = q('#ws-set-shared');
  const branchInput = q('#ws-set-branch');
  const branchHelp = q('#ws-set-branch-help');
  const renderBranchState = () => {
    branchInput.style.display = sharedBox.checked ? '' : 'none';
    branchHelp.textContent = sharedBox.checked
      ? 'Every new worktree checks out this branch.'
      : 'Each worktree names its own branch when you attach it.';
  };
  const saveBranch = async () => {
    const branchName = branchInput.value.trim();
    if (sharedBox.checked === shared && branchName === (project.branchName || '')) return;
    const result = await window.api.updateProject(project.id, { sharedBranch: sharedBox.checked, branchName });
    if (result?.error) { alert(result.error); return; }
    project.sharedBranch = sharedBox.checked;
    project.branchName = branchName;
    flashSaved(q('#ws-set-branch-saved'));
    loadProjects();
  };
  branchInput.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); branchInput.blur(); } };
  branchInput.onblur = saveBranch;
  sharedBox.onchange = () => { renderBranchState(); saveBranch(); };
  renderBranchState();

  const tracksEl = q('#ws-set-tracks');
  if (!(project.tracks || []).length) tracksEl.innerHTML = '<div class="ws-item ws-item--empty">No tracks. A track is one line of work with its own sessions, start folder and CLI.</div>';
  for (const track of project.tracks || []) tracksEl.appendChild(buildTrackSettingsRow(project, track));
  q('#ws-set-new-track').onclick = () => promptNewTrack(project);

  q('#ws-set-status').onclick = () => toggleProjectDone(project);
  q('#ws-set-remove').onclick = () => removeProjectFlow(project);

  const flash = projectsUi.savedFlash;
  if (flash && flash.until > Date.now()) {
    const el = flash.id ? q('#' + CSS.escape(flash.id)) : null;
    if (el) showSavedFlash(el, flash.until - Date.now());
  }
}

/** Show a "Saved" mark for a moment. Remembered by id, since a save re-renders the tab. */
function flashSaved(el) {
  if (!el) return;
  projectsUi.savedFlash = { id: el.id, until: Date.now() + 1600 };
  showSavedFlash(el, 1600);
}

function showSavedFlash(el, ms) {
  el.classList.add('on');
  clearTimeout(el._savedTimer);
  el._savedTimer = setTimeout(() => el.classList.remove('on'), ms);
}

/** A path with the home folder as "~". */
function shortPathLabel(p) {
  return typeof shortProjectPath === 'function' ? shortProjectPath(p) : p;
}

function buildTrackSettingsRow(project, track) {
  const row = document.createElement('div');
  row.className = 'ws-item ws-trow' + (track.status === 'done' ? ' done' : '');
  const colors = trackColors(project, track);
  row.innerHTML = `
    <span class="ws-trow-dot" style="background:${colors.fg}"></span>
    <input type="text" class="ws-input ws-trow-name" value="${escapeHtml(track.name)}" spellcheck="false" title="Rename (Enter or click away to save)">
    <span class="ws-trow-cwd"></span>
    <select class="ws-select ws-trow-cli" title="CLI for new sessions"></select>
    <button type="button" class="ws-ghost ws-ghost--sm ws-trow-status">${track.status === 'done' ? 'Reopen' : 'Done'}</button>
    <button type="button" class="ws-ghost ws-ghost--sm ws-trow-delete" title="Delete track">${PICONS.trash(13)}</button>`;
  const patch = async (fields) => {
    const result = await window.api.updateTrack(track.id, fields);
    if (result?.error) { alert(result.error); return false; }
    loadProjects();
    return true;
  };
  const nameInput = row.querySelector('.ws-trow-name');
  nameInput.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); nameInput.blur(); } };
  nameInput.onblur = () => { const name = nameInput.value.trim(); if (name && name !== track.name) patch({ name }); else nameInput.value = track.name; };

  const inherited = project.defaultCwd || project.root;
  const cwdField = buildCwdField(project, track.cwd, `Project default (${pathBasename(inherited)})`,
    project.defaultCwd ? [{ value: project.root, label: `Project folder (${pathBasename(project.root)})` }] : [],
    (cwd) => patch({ cwd }));
  cwdField.classList.add('ws-trow-field');
  row.querySelector('.ws-trow-cwd').replaceWith(cwdField);

  const cli = row.querySelector('.ws-trow-cli');
  const renderCli = (harnesses) => {
    cli.replaceChildren();
    const options = [{ id: '', label: 'Ask each time' }, ...harnesses.map(h => ({ id: h.id, label: h.label }))];
    if (track.cli && !options.some(o => o.id === track.cli)) options.push({ id: track.cli, label: track.cli });
    for (const opt of options) {
      const o = document.createElement('option');
      o.value = opt.id; o.textContent = opt.label; o.selected = (track.cli || '') === opt.id;
      cli.appendChild(o);
    }
  };
  renderCli([{ id: 'claude', label: 'Claude' }]);
  window.api.getHarnesses().then(list => { if (row.isConnected) renderCli((list || []).filter(h => h.enabled)); }).catch(() => {});
  cli.onchange = () => patch({ cli: cli.value || null });

  row.querySelector('.ws-trow-status').onclick = () => patch({ status: track.status === 'done' ? 'active' : 'done' });
  row.querySelector('.ws-trow-delete').onclick = () => deleteTrackFlow(project, track);
  return row;
}

// --- Working mode: strip + panes ---

function renderStrip(project) {
  const running = runningTasksFor(project);
  const branch = (project.folders || []).find(f => f.mode === 'worktree')?.branch;
  projectStrip.innerHTML = `
    <button type="button" class="ws-btn ws-btn--sm" id="strip-back">${PICONS.back(13)}<span>Overview</span></button>
    ${markHtml(project, 22, 'proj-mark--sm')}
    <span class="strip-name">${escapeHtml(project.name)}</span>
    ${branch ? `<span class="strip-branch mono">${PICONS.branch(11)}<span>${escapeHtml(branch)}</span></span>` : ''}
    <span class="ws-flex"></span>
    <button type="button" class="ws-btn ws-btn--sm project-task-btn" id="strip-tasks" data-project-id="${project.id}" data-project-path="${escapeHtml(project.root)}" data-project-paths="${escapeHtml(taskPseudoProject(project).projectPaths.join('\n'))}">${PICONS.play(11)}<span>Tasks</span><span class="project-task-count ws-badge" ${running ? '' : 'style="display:none"'}>${running || ''}</span></button>
    <button type="button" class="ws-btn ws-btn--sm ws-btn--primary" id="strip-new">${PICONS.plus(11)}<span>New session</span>${PICONS.chevronDown(10)}</button>
    <button type="button" class="ws-btn ws-btn--sm ws-btn--icon" id="strip-more" title="More">${PICONS.dots(13)}</button>`;
  projectStrip.querySelector('#strip-back').onclick = () => { setProjectTab(project, 'overview'); showProjectOverview(); };
  projectStrip.querySelector('#strip-tasks').onclick = (e) => showTaskPopover(taskPseudoProject(project), e.currentTarget);
  projectStrip.querySelector('#strip-new').onclick = (e) => showNewSessionMenu(project, currentTrack(project), e.currentTarget);
  projectStrip.querySelector('#strip-more').onclick = (e) => showContextMenu(projectMenuItems(project, { fromPage: true }), { anchor: e.currentTarget });
}

function currentTrackKey(project) {
  const key = projectsUi.trackByProject[project.id];
  if (key && key !== 'general' && !(project.tracks || []).some(t => t.id === key)) return 'general';
  return key || ((project.tracks || [])[0]?.id) || 'general';
}

function currentTrack(project) {
  const key = currentTrackKey(project);
  return key === 'general' ? null : (project.tracks || []).find(t => t.id === key) || null;
}

function trackCwdLabel(project, track) {
  if (!track?.cwd) return '';
  if (!isPathInside(track.cwd, project.root)) return pathBasename(track.cwd);
  return track.cwd === project.root ? 'project folder' : track.cwd.slice(project.root.length + 1);
}

const PANE_GROUP_LIMIT = 8;
const GROUP_MODES = [['time', 'Time'], ['track', 'Track'], ['state', 'State']];

function paneGroupMode(project) {
  const mode = projectsUi.groupBy[project.id];
  return GROUP_MODES.some(([m]) => m === mode) ? mode : 'time';
}

function startOfDay(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Time buckets: what is live now, then today, yesterday, this week, this month, older. */
function timeBucket(session, now) {
  const t = sessionEventTime(session);
  const today = startOfDay(now);
  if (t >= today) return 'today';
  if (t >= today - 86400000) return 'yesterday';
  if (t >= today - 6 * 86400000) return 'week';
  if (t >= today - 29 * 86400000) return 'month';
  return 'older';
}

/**
 * The same rows, grouped three ways. Each group: { key, title, color, sessions,
 * track (Track view), plus (Track view) }.
 */
function groupSessions(project, mode) {
  // One rule everywhere: the session with the latest event comes first.
  const byEvent = (list) => list.filter(s => !s.archived).sort((a, b) => sessionEventTime(b) - sessionEventTime(a));
  const all = byEvent(projectSessionsAll(project));
  const byRunningFirst = byEvent;

  if (mode === 'track') {
    const groups = (project.tracks || []).map(track => ({
      key: track.id, title: track.name, color: trackColors(project, track).fg, track,
      sessions: byRunningFirst(track.sessions || []), plus: true, done: track.status === 'done',
    }));
    if (project.sessions.length || !groups.length) {
      groups.push({ key: 'general', title: 'General', color: trackColors(project, null).fg, track: null, sessions: byRunningFirst(project.sessions), plus: true });
    }
    return groups;
  }

  if (mode === 'state') {
    const attention = all.filter(s => sessionState(s) === 'attention');
    const running = all.filter(s => sessionState(s) === 'running');
    const idle = all.filter(s => !sessionState(s));
    return [
      { key: 'attention', title: 'Needs input', color: '#f0b060', sessions: attention },
      { key: 'running', title: 'Running', color: '#59d46d', sessions: running },
      { key: 'idle', title: 'Idle', sessions: idle },
    ].filter(g => g.sessions.length);
  }

  const now = Date.now();
  const live = all.filter(s => sessionState(s));
  const rest = all.filter(s => !sessionState(s));
  const buckets = { today: [], yesterday: [], week: [], month: [], older: [] };
  for (const s of rest) buckets[timeBucket(s, now)].push(s);
  return [
    { key: 'now', title: 'Now', sessions: live, unlimited: true },
    { key: 'today', title: 'Today', sessions: buckets.today },
    { key: 'yesterday', title: 'Yesterday', sessions: buckets.yesterday },
    { key: 'week', title: 'Earlier this week', sessions: buckets.week },
    { key: 'month', title: 'Earlier this month', sessions: buckets.month },
    { key: 'older', title: 'Older', sessions: buckets.older },
  ].filter(g => g.sessions.length);
}

/**
 * The middle pane in working mode: the project's sessions as one list,
 * grouped by time, track or state, with plan progress and open todos at the
 * foot.
 */
function renderPanes(project) {
  const mode = paneGroupMode(project);
  const plan = parsePlan(fileContent(project, 'plan-tracker.md'));
  const todos = parseTodos(fileContent(project, 'todos.md'));
  const open = todos.filter(t => !t.done).length;
  const pct = plan.phases.length ? Math.round((plan.done / plan.phases.length) * 100) : 0;
  const expanded = projectsUi.expandedLists;

  const pane = document.createElement('div');
  pane.className = 'pane';
  pane.innerHTML = `<div class="pane-label"><span>Sessions</span><span class="ws-flex"></span>` +
    `<span class="pane-seg">${GROUP_MODES.map(([m, label]) => `<button type="button" class="pane-seg-btn${m === mode ? ' on' : ''}" data-mode="${m}">${label}</button>`).join('')}</span>` +
    `<button type="button" class="pane-icon-btn pane-icon-btn--primary" id="pane-new-session" title="New session in the project">${PICONS.plus(12)}</button></div>`;
  pane.querySelectorAll('.pane-seg-btn').forEach(btn => {
    btn.onclick = () => { projectsUi.groupBy[project.id] = btn.dataset.mode; saveProjectsUi(); renderPanes(project); };
  });
  pane.querySelector('#pane-new-session').onclick = (e) => showNewSessionMenu(project, currentTrack(project), e.currentTarget);

  const scroll = document.createElement('div');
  scroll.className = 'pane-scroll';
  const groups = groupSessions(project, mode);
  if (!groups.length) {
    const none = document.createElement('div');
    none.className = 'pane-empty';
    none.textContent = 'No sessions yet. Start one from the + above.';
    scroll.appendChild(none);
  }
  for (const group of groups) {
    const head = document.createElement('div');
    head.className = 'pane-sec' + (group.done ? ' done' : '');
    if (group.color) head.style.color = group.color;
    head.innerHTML = `<span class="pane-sec-title">${escapeHtml(group.title)}</span><span class="pane-sec-count">${group.sessions.length}</span>` +
      (group.plus ? `<span class="ws-flex"></span><button type="button" class="pane-icon-btn pane-sec-plus" title="${group.track ? `New session in ${escapeHtml(group.track.name)}` : 'New session in the project'}">${PICONS.plus(11)}</button>` : '');
    if (group.plus) {
      head.querySelector('.pane-sec-plus').onclick = (e) => { e.stopPropagation(); launchFromTrack(project, group.track, e.currentTarget); };
      if (group.track) head.oncontextmenu = (e) => { e.preventDefault(); showContextMenu(trackMenuItems(project, group.track), { x: e.clientX, y: e.clientY }); };
    }
    scroll.appendChild(head);

    const id = `${project.id}:${mode}:${group.key}`;
    const limit = group.unlimited || expanded[id] ? Infinity : PANE_GROUP_LIMIT;
    for (const s of group.sessions.slice(0, limit)) scroll.appendChild(buildSessionRow(project, s, { showTrack: mode !== 'track' }));
    if (!group.sessions.length) {
      const none = document.createElement('div');
      none.className = 'pane-empty';
      none.textContent = 'No sessions yet.';
      scroll.appendChild(none);
    }
    if (group.sessions.length > limit) {
      const more = document.createElement('button');
      more.type = 'button';
      more.className = 'pane-more';
      more.textContent = `+ ${group.sessions.length - limit} ${mode === 'time' ? 'older' : 'more'}`;
      more.onclick = () => { expanded[id] = true; renderPanes(project); };
      scroll.appendChild(more);
    }
  }
  const archived = archivedSessionsOf(project);
  if (archived.length) scroll.appendChild(buildArchivedSection(project, archived, `pane:${project.id}`, { showTrack: mode !== 'track', rowClass: 'pane-session pane-session--archived' }));
  pane.appendChild(scroll);

  const foot = document.createElement('div');
  foot.className = 'pane-foot';
  foot.innerHTML = `
    <div class="pane-foot-row" id="pane-plan" title="Open plan-tracker.md"><span>Plan</span><div class="ws-progress ws-progress--sm"><div class="ws-progress-fill" style="width:${pct}%"></div></div><span>${plan.phases.length ? `${plan.done}/${plan.phases.length}` : '—'}</span></div>
    <div class="pane-foot-row" id="pane-todos" title="Open todos.md"><span>Todos</span><span class="ws-flex"></span><span><b>${open}</b> open</span></div>`;
  foot.querySelector('#pane-plan').onclick = () => openProjectFileInEditor(project, 'plan-tracker.md');
  foot.querySelector('#pane-todos').onclick = () => openProjectFileInEditor(project, 'todos.md');
  pane.appendChild(foot);

  projectPanes.replaceChildren(pane);
  projectsUi.lastStateKey = projectSessionsAll(project).map(s => s.sessionId + ':' + sessionState(s)).join('|');
  const active = pane.querySelector('.pane-session.here');
  if (active) active.scrollIntoView({ block: 'nearest' });
  // renderPanes has several direct callers (most notably the first busy signal
  // from a newly started CLI). They do not pass through refreshProjectViews,
  // so reassert the terminal invariant here after every pane replacement.
  ensureWorkingTerminalVisible(project, { refit: true });

  loadProjectFiles(project).then(() => {
    if (!projectsUi.working || selectedProject()?.id !== project.id) return;
    const p = parsePlan(fileContent(project, 'plan-tracker.md'));
    const t = parseTodos(fileContent(project, 'todos.md')).filter(x => !x.done).length;
    const planRow = projectPanes.querySelector('#pane-plan');
    const todoRow = projectPanes.querySelector('#pane-todos');
    if (planRow) {
      planRow.querySelector('.ws-progress-fill').style.width = `${p.phases.length ? Math.round((p.done / p.phases.length) * 100) : 0}%`;
      planRow.lastElementChild.textContent = p.phases.length ? `${p.done}/${p.phases.length}` : '—';
    }
    if (todoRow) todoRow.querySelector('b').textContent = String(t);
  });
}


// --- Menus ---

function closeContextMenu() {
  if (!openCtxMenu) return;
  openCtxMenu.remove();
  openCtxMenu = null;
  document.removeEventListener('pointerdown', onCtxPointerDown, true);
  document.removeEventListener('keydown', onCtxKey, true);
}

function onCtxPointerDown(e) {
  if (openCtxMenu && !openCtxMenu.contains(e.target)) closeContextMenu();
}

function onCtxKey(e) {
  if (e.key === 'Escape') { e.stopPropagation(); closeContextMenu(); }
}

function placeMenu(menu, { x, y, anchor }) {
  const w = menu.offsetWidth;
  const h = menu.offsetHeight;
  let left = x;
  let top = y;
  if (anchor) {
    const rect = anchor.getBoundingClientRect();
    left = rect.left;
    top = rect.bottom + 4;
    if (top + h > window.innerHeight - 8) top = Math.max(8, rect.top - h - 4);
  }
  if (left + w > window.innerWidth - 8) left = Math.max(8, window.innerWidth - w - 8);
  if (top + h > window.innerHeight - 8) top = Math.max(8, window.innerHeight - h - 8);
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
}

function buildMenu(items, depth = 0) {
  const menu = document.createElement('div');
  menu.className = 'ctx-menu';
  for (const item of items) {
    if (!item) continue;
    if (item.sep) { const sep = document.createElement('div'); sep.className = 'ctx-sep'; menu.appendChild(sep); continue; }
    if (item.head) { const head = document.createElement('div'); head.className = 'ctx-head'; head.textContent = item.head; menu.appendChild(head); continue; }
    const row = document.createElement('div');
    row.className = 'ctx-item' + (item.danger ? ' danger' : '') + (item.disabled ? ' disabled' : '') + (item.muted ? ' muted' : '');
    row.innerHTML = `<span class="ctx-icon">${item.icon || ''}</span><span class="ctx-label">${escapeHtml(item.label)}</span>` +
      (item.hint ? `<span class="ctx-hint">${escapeHtml(item.hint)}</span>` : '') +
      (item.submenu ? `<span class="ctx-arrow">${PICONS.chevronRight(10)}</span>` : '');
    if (item.submenu) {
      let sub = null;
      const openSub = () => {
        if (sub) return;
        menu.querySelectorAll('.ctx-item.open').forEach(o => { if (o !== row) { o.classList.remove('open'); o._closeSub?.(); } });
        sub = buildMenu(item.submenu, depth + 1);
        sub.classList.add('ctx-submenu');
        document.body.appendChild(sub);
        const rect = row.getBoundingClientRect();
        let left = rect.right + 2;
        if (left + sub.offsetWidth > window.innerWidth - 8) left = rect.left - sub.offsetWidth - 2;
        let top = rect.top - 5;
        if (top + sub.offsetHeight > window.innerHeight - 8) top = Math.max(8, window.innerHeight - sub.offsetHeight - 8);
        sub.style.left = `${left}px`;
        sub.style.top = `${top}px`;
        row.classList.add('open');
        openCtxMenu._subs.push(sub);
      };
      row._closeSub = () => { if (sub) { sub.remove(); openCtxMenu._subs = openCtxMenu._subs.filter(s => s !== sub); sub = null; row.classList.remove('open'); } };
      row.onmouseenter = openSub;
      row.onclick = (e) => { e.stopPropagation(); openSub(); };
    } else if (!item.disabled) {
      row.onmouseenter = () => menu.querySelectorAll('.ctx-item.open').forEach(o => { o.classList.remove('open'); o._closeSub?.(); });
      row.onclick = (e) => { e.stopPropagation(); closeContextMenu(); item.onClick?.(); };
    }
    menu.appendChild(row);
  }
  return menu;
}

/** One menu style for every right-click and every "…" button. */
function showContextMenu(items, position) {
  closeContextMenu();
  if (typeof closeProjectPopover === 'function') closeProjectPopover();
  if (typeof closeTaskPopover === 'function') closeTaskPopover();
  const menu = buildMenu(items);
  menu._subs = [];
  const remove = menu.remove.bind(menu);
  menu.remove = () => { for (const s of menu._subs) s.remove(); remove(); };
  document.body.appendChild(menu);
  openCtxMenu = menu;
  placeMenu(menu, position || { x: 20, y: 20 });
  setTimeout(() => {
    document.addEventListener('pointerdown', onCtxPointerDown, true);
    document.addEventListener('keydown', onCtxKey, true);
  }, 0);
  return menu;
}

/**
 * Every folder a terminal can open in from a project launch menu. Keep the
 * current project/track cwd first so the first Terminal row preserves the old
 * single-row behavior, then offer the project folder and every attached
 * folder. A track cwd may point inside one of those roots, so include it even
 * when it is not itself an attached-folder row.
 */
function terminalLaunchItems(project, target) {
  const paths = [target.projectPath, project.root, ...(project.folders || []).map(f => f.path)]
    .filter((path, index, all) => path && all.indexOf(path) === index);

  return paths.map(projectPath => {
    let where = 'project folder';
    if (projectPath !== project.root) {
      const attached = (project.folders || []).find(f => f.path === projectPath);
      where = attached ? shortProjectPath(attached.path) : shortProjectPath(projectPath);
    }
    return {
      label: 'Terminal',
      icon: ICONS.terminal(14),
      hint: `in ${where}`,
      onClick: () => launchTerminalSession({ ...target, projectPath }),
    };
  });
}

function newSessionItems(project, track) {
  const target = launchTargetFor(project, track);
  const where = track ? track.name : (project.defaultCwd ? pathBasename(project.defaultCwd) : 'project folder');
  return [
    { label: 'Claude', icon: ICONS.claude(14), hint: `in ${where}`, onClick: async () => { const o = await resolveDefaultSessionOptions(target); o.runtime = 'claude'; launchNewSession(target, o); } },
    { label: 'Codex', icon: ICONS.codex(14, 'codex-icon'), onClick: async () => { const o = await resolveDefaultSessionOptions(target); o.runtime = 'codex'; launchNewSession(target, o); } },
    ...terminalLaunchItems(project, target),
    { sep: true },
    { label: 'Claude, configure…', muted: true, onClick: () => showNewSessionDialog(target, 'claude') },
    { label: 'Codex, configure…', muted: true, onClick: () => showNewSessionDialog(target, 'codex') },
  ];
}

function showNewSessionMenu(project, track, anchor) {
  const items = [...newSessionItems(project, track)];
  const tracks = (project.tracks || []).filter(t => t.status !== 'done');
  if (tracks.length) {
    items.push({ sep: true }, { head: 'In a track' });
    for (const t of tracks) items.push({ label: t.name, icon: PICONS.list(13), submenu: newSessionItems(project, t) });
  }
  showContextMenu(items, { anchor });
}

/** One Attach: a plain folder attaches as it is; a repository asks how the project should work in it. */
async function attachFolderAsk(project) {
  const folder = await window.api.browseFolder();
  if (!folder) return;
  let info = { git: false };
  try { info = await window.api.getFolderGitStatus(folder); } catch {}
  const mode = info?.git ? await askRepoMode(folder, info) : 'in-place';
  if (!mode) return;
  await attachFolderFlow(project, mode, folder);
}

/** The repository question as a small dialog. Resolves 'in-place', 'worktree' or null. */
function askRepoMode(folderPath, info) {
  return new Promise(resolve => {
    const overlay = document.createElement('div');
    overlay.className = 'add-project-overlay';
    const dialog = document.createElement('div');
    dialog.className = 'add-project-dialog ws-prompt np-ask-dialog';
    dialog.innerHTML = `
      <h3>${escapeHtml(pathBasename(folderPath))}</h3>
      <div class="add-project-hint">This is a git repository${info?.branch ? `, on ${escapeHtml(info.branch)}` : ''}. How should the project work in it?</div>
      <div class="np-ask-opts">
        <div class="np-ask-opt"><button type="button" class="ws-btn np-ask-btn" data-mode="in-place">As it is</button><div class="np-help">Sessions work in the folder, on whatever is checked out.</div></div>
        <div class="np-ask-opt"><button type="button" class="ws-btn np-ask-btn np-ask-btn--wt" data-mode="worktree">New worktree</button><div class="np-help">A worktree under the project on its branch. Your checkout is untouched.</div></div>
      </div>
      <div class="add-project-actions"><button class="add-project-cancel-btn" type="button">Cancel</button></div>`;
    const done = (value) => { overlay.remove(); document.removeEventListener('keydown', onKey); resolve(value); };
    function onKey(e) { if (e.key === 'Escape') done(null); }
    dialog.querySelectorAll('.np-ask-btn').forEach(btn => { btn.onclick = () => done(btn.dataset.mode); });
    dialog.querySelector('.add-project-cancel-btn').onclick = () => done(null);
    document.addEventListener('keydown', onKey);
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);
  });
}

function projectMenuItems(project, { fromPage = false } = {}) {
  const isDone = project.status === 'done';
  return [
    !fromPage && { label: 'Open overview', icon: PICONS.open(14), onClick: () => selectProject(project.id, { tab: 'overview' }) },
    { label: 'New session', icon: PICONS.plus(14), submenu: newSessionItems(project, null) },
    { label: 'New track…', icon: PICONS.list(14), onClick: () => promptNewTrack(project) },
    { sep: true },
    { label: 'Rename…', icon: PICONS.pencil(14), onClick: () => renameProjectFlow(project) },
    { label: 'Attach folder…', icon: PICONS.folder(14), onClick: () => attachFolderAsk(project) },
    { label: 'Create scheduled task', icon: PICONS.clock(14), onClick: () => launchScheduleCreator({ projectPath: project.root }) },
    { label: 'Settings', icon: ICONS.gear(14), onClick: () => selectProject(project.id, { tab: 'settings' }) },
    { label: 'Open project folder', icon: PICONS.open(14), onClick: () => window.api.openPath(project.root) },
    { sep: true },
    { label: isDone ? 'Reopen project' : 'Mark as done', icon: PICONS.check(14), onClick: () => toggleProjectDone(project) },
    { label: 'Remove project…', icon: PICONS.trash(14), danger: true, onClick: () => removeProjectFlow(project) },
  ].filter(Boolean);
}

function trackMenuItems(project, track) {
  const sessions = sessionsOfTrack(project, track.id);
  const inherited = project.defaultCwd || project.root;
  const cwdOptions = [{ value: null, label: `Project default (${pathBasename(inherited)})` }];
  if (project.defaultCwd) cwdOptions.push({ value: project.root, label: `Project folder (${pathBasename(project.root)})` });
  for (const f of project.folders || []) cwdOptions.push({ value: f.path, label: pathBasename(f.path) });
  const patch = async (fields) => { const r = await window.api.updateTrack(track.id, fields); if (r?.error) alert(r.error); else loadProjects(); };
  return [
    sessions.length ? { label: 'Resume latest', icon: PICONS.play(13), onClick: () => openSession(sessions[0]) } : null,
    { label: 'New session', icon: PICONS.plus(14), submenu: newSessionItems(project, track) },
    { label: 'Show all sessions', icon: PICONS.list(14), onClick: () => openTrackInPanes(project, track.id) },
    { sep: true },
    { label: 'Rename…', icon: PICONS.pencil(14), onClick: () => renameTrackFlow(project, track) },
    { label: 'Sessions start in', icon: PICONS.folder(14), hint: track.cwd ? pathBasename(track.cwd) : 'default',
      submenu: cwdOptions.map(o => ({ label: o.label, muted: (track.cwd || null) === o.value, hint: (track.cwd || null) === o.value ? 'current' : '', onClick: () => patch({ cwd: o.value }) })) },
    { label: 'CLI', icon: PICONS.terminal(14), hint: track.cli ? (track.cli === 'codex' ? 'Codex' : 'Claude') : 'ask',
      submenu: [
        { label: 'Ask each time', muted: !track.cli, onClick: () => patch({ cli: null }) },
        { label: 'Claude', icon: ICONS.claude(14), muted: track.cli === 'claude', onClick: () => patch({ cli: 'claude' }) },
        { label: 'Codex', icon: ICONS.codex(14, 'codex-icon'), muted: track.cli === 'codex', onClick: () => patch({ cli: 'codex' }) },
      ] },
    { sep: true },
    { label: track.status === 'done' ? 'Reopen track' : 'Mark as done', icon: PICONS.check(14), onClick: () => patch({ status: track.status === 'done' ? 'active' : 'done' }) },
    { label: 'Delete track…', icon: PICONS.trash(14), danger: true, onClick: () => deleteTrackFlow(project, track) },
  ].filter(Boolean);
}

/** The "Move to…" section of a session menu: tracks of its project, other projects, or no project. */
function sessionMoveItems(session) {
  const info = projectForSession(session);
  const project = info?.project || null;
  const move = async (projectId, trackId) => {
    const result = await window.api.setSessionAssignment(session.sessionId, projectId, trackId);
    if (result?.error) { alert(result.error); return; }
    session.projectId = projectId;
    session.trackId = trackId;
    if (session.type === 'terminal') persistTerminalSession(session);
    loadProjects();
  };
  const moveItems = [];
  if (project) {
    moveItems.push({ head: `Move within ${project.name}` });
    for (const t of (project.tracks || []).filter(t => t.status !== 'done')) {
      const current = session.trackId === t.id;
      moveItems.push({ label: t.name, muted: current, hint: current ? 'current' : '', onClick: current ? null : () => move(project.id, t.id) });
    }
    const inGeneral = !session.trackId;
    moveItems.push({ label: 'General', muted: inGeneral, hint: inGeneral ? 'current' : '', onClick: inGeneral ? null : () => move(project.id, null) });
    moveItems.push({ label: 'New track from here…', onClick: async () => {
      const name = await showPromptDialog({ title: 'New track', label: 'Name', placeholder: 'Build' });
      if (!name) return;
      const created = await window.api.createTrack(project.id, { name, cwd: null });
      if (created?.error) { alert(created.error); return; }
      move(project.id, created.track.id);
    } });
  }
  const others = (cachedProjectTreeAll?.projects || []).filter(p => p.status !== 'done' && p.id !== project?.id);
  if (others.length) {
    const projectRows = others.map(p => {
      const tracks = (p.tracks || []).filter(t => t.status !== 'done');
      return tracks.length
        ? { label: p.name, submenu: [{ label: 'General', onClick: () => move(p.id, null) }, ...tracks.map(t => ({ label: t.name, onClick: () => move(p.id, t.id) }))] }
        : { label: p.name, onClick: () => move(p.id, null) };
    });
    // Inside a project the other projects sit behind one row, so the menu
    // reads as an action. From the Sessions tab they are the whole menu.
    if (project) moveItems.push({ sep: true }, { label: 'Move to another project', icon: PICONS.folder(14), submenu: projectRows });
    else moveItems.push({ sep: true }, { head: 'Move to project' }, ...projectRows);
  }
  if (session.projectId) moveItems.push({ sep: true }, { label: `Remove from ${project ? project.name : 'project'}`, icon: PICONS.x(13), hint: 'stays in the Sessions tab', onClick: () => move(null, null) });
  else if (info?.byCwd) moveItems.push({ sep: true }, { label: 'Filed by its folder', disabled: true });
  return moveItems;
}

function sessionMenuItems(session) {
  const moveItems = sessionMoveItems(session);
  const running = isSessionRunning(session.sessionId);
  const unread = typeof responseReadySessions !== 'undefined' && responseReadySessions.has(session.sessionId);
  const folder = { projectPath: session.projectPath };
  // A fork runs in the source's folder and is filed where the source is, so
  // the pane shows it straight away.
  const info = projectForSession(session);
  const forkTarget = info
    ? { ...launchTargetFor(info.project, (info.project.tracks || []).find(t => t.id === session.trackId) || null), projectPath: session.projectPath }
    : folder;
  const sessionActions = [
    session.type !== 'terminal' ? { label: 'Fork', icon: PICONS.fork(14), onClick: () => forkSession(session, forkTarget) } : null,
    session.type !== 'terminal' ? { label: unread ? 'Mark as read' : 'Mark as unread', icon: unread ? ICONS.markRead(14) : ICONS.markUnread(14), onClick: () => { if (unread) clearUnread(session.sessionId); else markUnread(session.sessionId); refreshSidebar(); } } : null,
    session.type !== 'terminal' ? { label: 'View messages', icon: PICONS.messages(14), onClick: () => showJsonlViewer(session) } : null,
    session.type !== 'terminal' && !running ? { label: 'Resume with config…', icon: ICONS.launchConfig(14), onClick: () => showResumeSessionDialog(session) } : null,
  ].filter(Boolean);
  const stateActions = [
    running ? { label: 'Stop', icon: '<svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor"><rect x="2" y="2" width="8" height="8" rx="1"/></svg>', onClick: () => confirmAndStopSession(session.sessionId) } : null,
    isDismissibleSession(session.sessionId) ? { label: 'Dismiss', icon: PICONS.x(14), hint: 'never started', onClick: () => dismissSession(session.sessionId) } : null,
    session.type !== 'terminal' ? { label: session.archived ? 'Unarchive' : 'Archive', icon: PICONS.archive(14), onClick: () => toggleArchiveSession(session) } : null,
  ].filter(Boolean);
  return [
    ...sessionActions,
    sessionActions.length && moveItems.length ? { sep: true } : null,
    ...moveItems,
    moveItems.length && stateActions.length ? { sep: true } : null,
    ...stateActions,
  ].filter(Boolean);
}

// --- Flows (create, rename, attach, detach, done, remove) ---
//
// Dialog rule: a click on the backdrop does nothing. These hold typed work, and
// a stray click used to throw it away. Escape and Cancel are the ways out.

/** A small modal with one text field. Resolves the trimmed value, or null on cancel. */
function showPromptDialog({ title, label, value = '', placeholder = '', confirm = 'Save', help = '' }) {
  return new Promise(resolve => {
    const overlay = document.createElement('div');
    overlay.className = 'add-project-overlay';
    const dialog = document.createElement('div');
    dialog.className = 'add-project-dialog ws-prompt';
    dialog.innerHTML = `
      <h3>${escapeHtml(title)}</h3>
      ${label ? `<label class="new-project-label">${escapeHtml(label)}</label>` : ''}
      <div class="folder-input-row"><input type="text" id="ws-prompt-input" autocomplete="off" spellcheck="false" placeholder="${escapeHtml(placeholder)}" value="${escapeHtml(value)}"></div>
      ${help ? `<div class="add-project-hint" style="margin-top:8px;">${escapeHtml(help)}</div>` : ''}
      <div class="add-project-actions">
        <button class="add-project-cancel-btn" type="button">Cancel</button>
        <button class="add-project-add-btn" type="button">${escapeHtml(confirm)}</button>
      </div>`;
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);
    const input = dialog.querySelector('#ws-prompt-input');
    const finish = (result) => { overlay.remove(); document.removeEventListener('keydown', onKey); resolve(result); };
    const onKey = (e) => { if (e.key === 'Escape') finish(null); if (e.key === 'Enter') finish(input.value.trim() || null); };
    document.addEventListener('keydown', onKey);
    dialog.querySelector('.add-project-cancel-btn').onclick = () => finish(null);
    dialog.querySelector('.add-project-add-btn').onclick = () => finish(input.value.trim() || null);
    input.focus();
    input.select();
  });
}

async function promptNewTrack(project) {
  const name = await showPromptDialog({ title: 'New track', label: 'Name', placeholder: 'Build', confirm: 'Create', help: 'A track is one line of work inside the project, with its own sessions. It starts in the project folder unless you change it.' });
  if (!name) return;
  const result = await window.api.createTrack(project.id, { name, cwd: null });
  if (result?.error) { alert(result.error); return; }
  loadProjects();
}

async function renameProjectFlow(project) {
  const name = await showPromptDialog({ title: 'Rename project', label: 'Name', value: project.name, confirm: 'Rename', help: 'The folder on disk keeps its name.' });
  if (!name || name === project.name) return;
  const result = await window.api.updateProject(project.id, { name });
  if (result?.error) { alert(result.error); return; }
  loadProjects();
}

async function renameTrackFlow(project, track) {
  const name = await showPromptDialog({ title: 'Rename track', label: 'Name', value: track.name, confirm: 'Rename' });
  if (!name || name === track.name) return;
  const result = await window.api.updateTrack(track.id, { name });
  if (result?.error) { alert(result.error); return; }
  loadProjects();
}

async function attachFolderFlow(project, mode, folderPath = null) {
  const folder = folderPath || await window.api.browseFolder();
  if (!folder) return;
  let branch = null;
  if (mode === 'worktree' && !projectBranchName(project)) {
    branch = await showPromptDialog({ title: `Branch for ${pathBasename(folder)}`, label: 'Branch name', placeholder: project.slug, confirm: 'Attach' });
    if (!branch) return;
  }
  const result = await window.api.attachProjectFolder(project.id, { path: folder, mode, branch });
  if (result?.error) { alert(result.error); return; }
  loadProjects();
}

async function detachFolderFlow(project, folder) {
  let opts = {};
  if (folder.mode === 'worktree') {
    opts = { removeWorktree: confirm(`Detach ${pathBasename(folder.path)}.\n\nAlso remove the checkout at ${folder.path}?\nOK removes it (the branch "${folder.branch}" stays). Cancel keeps it on disk.`) };
  } else if (!confirm(`Detach ${pathBasename(folder.path)} from ${project.name}?\n\nNothing on disk changes.`)) {
    return;
  }
  let result = await window.api.detachProjectFolder(project.id, folder.path, opts);
  if (result?.dirty && confirm(`The worktree has uncommitted changes.\n\n${result.error}\n\nRemove it anyway and lose those changes?`)) {
    result = await window.api.detachProjectFolder(project.id, folder.path, { removeWorktree: true, force: true });
  }
  if (result?.error) { alert(result.error); return; }
  loadProjects();
}

async function deleteTrackFlow(project, track) {
  const choice = await new Promise(resolve => {
    const overlay = document.createElement('div');
    overlay.className = 'add-project-overlay';
    const dialog = document.createElement('div');
    dialog.className = 'add-project-dialog ws-prompt';
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-labelledby', 'delete-track-title');
    dialog.innerHTML = `
      <h3 id="delete-track-title">Delete track ${escapeHtml(track.name)}?</h3>
      <div class="add-project-hint">Sessions stay in ${escapeHtml(project.name)} and retain their former track name.</div>
      <label class="new-project-label"><input type="checkbox" class="delete-track-archive"> Also archive all sessions in this track</label>
      <div class="add-project-hint">If selected, running sessions will stop and raw terminals will close.</div>
      <div class="add-project-actions">
        <button class="add-project-cancel-btn" type="button">Cancel</button>
        <button class="add-project-add-btn" type="button">Delete track</button>
      </div>`;
    const finish = value => { overlay.remove(); document.removeEventListener('keydown', onKey); resolve(value); };
    const onKey = e => { if (e.key === 'Escape') { e.stopPropagation(); finish(null); } };
    dialog.querySelector('.add-project-cancel-btn').onclick = () => finish(null);
    dialog.querySelector('.add-project-add-btn').onclick = () => finish({ archiveSessions: dialog.querySelector('input').checked });
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);
    document.addEventListener('keydown', onKey);
    dialog.querySelector('.add-project-cancel-btn').focus();
  });
  if (!choice) return;
  const result = await window.api.deleteTrack(track.id, choice);
  if (result?.error) { alert(result.error); return; }
  for (const session of sessionMap.values()) {
    if (session.trackId !== track.id && !result.sessionIds?.includes(session.sessionId)) continue;
    session.trackId = null;
    session.formerTrackName = result.formerTrackName;
    if (choice.archiveSessions) {
      session.archived = 1;
      forgetTerminalHistory(session.sessionId);
      if (session.type === 'terminal') forgetPersistedTerminalSession(session.sessionId);
    } else if (session.type === 'terminal') persistTerminalSession(session);
  }
  if (projectsUi.trackByProject[project.id] === track.id) delete projectsUi.trackByProject[project.id];
  await loadProjects();
}

/** After marking a project done: offer to remove its worktrees, one confirm each for dirty ones. */
async function offerWorktreeRemoval(project, worktrees) {
  const n = worktrees.length;
  if (!confirm(`Remove ${n} worktree${n === 1 ? '' : 's'} for ${project.name}?\n\n${worktrees.join('\n')}\n\nThe branches stay. Cancel keeps the checkouts on disk.`)) return;
  for (const p of worktrees) {
    let result = await window.api.detachProjectFolder(project.id, p, { removeWorktree: true });
    if (result?.dirty && confirm(`${p} has uncommitted changes.\n\n${result.error}\n\nRemove it anyway and lose them?`)) {
      result = await window.api.detachProjectFolder(project.id, p, { removeWorktree: true, force: true });
    }
    if (result?.error) alert(result.error);
  }
}

async function toggleProjectDone(project) {
  const isDone = project.status === 'done';
  const result = await window.api.updateProject(project.id, { status: isDone ? 'active' : 'done' });
  if (result?.error) { alert(result.error); return; }
  if (!isDone && result.worktrees?.length) await offerWorktreeRemoval(project, result.worktrees);
  loadProjects();
}

async function removeProjectFlow(project) {
  if (!confirm(`Remove ${project.name} from Switchboard?\n\nThe folder ${project.root} and all sessions stay on disk.`)) return;
  const result = await window.api.deleteProject(project.id);
  if (result?.error) { alert(result.error); return; }
  projectsUi.navigationByProject.delete(project.id);
  if (projectsUi.selectedProjectId === project.id) { projectsUi.selectedProjectId = null; saveProjectsUi(); leaveProjectViews(); placeholder.style.display = ''; }
  loadProjects();
}

// --- "Sessions start in" select (shared by settings rows) ---

function buildCwdField(project, current, firstOptionLabel, extraOptions, onChange) {
  const field = document.createElement('div');
  field.className = 'ws-cwd';
  const label = document.createElement('label');
  label.className = 'ws-label';
  label.textContent = 'Sessions start in';
  const select = document.createElement('select');
  select.className = 'ws-select';
  const options = [{ value: '', label: firstOptionLabel }, ...(extraOptions || [])];
  for (const folder of project.folders || []) {
    if (!options.some(o => o.value === folder.path)) options.push({ value: folder.path, label: pathBasename(folder.path) });
  }
  if (current && !options.some(o => o.value === current)) options.push({ value: current, label: current });
  for (const opt of options) {
    const o = document.createElement('option');
    o.value = opt.value;
    o.textContent = opt.label;
    o.selected = (current || '') === opt.value;
    select.appendChild(o);
  }
  select.onchange = () => onChange(select.value || null);
  field.append(label, select);
  return field;
}

// --- Popovers kept for the Sessions tab's Move button ---

function closeProjectPopover() {
  if (openProjectPopover) {
    openProjectPopover.element.remove();
    document.removeEventListener('pointerdown', dismissProjectPopover);
    openProjectPopover = null;
  }
}

function dismissProjectPopover(event) {
  if (!openProjectPopover) return;
  if (openProjectPopover.element.contains(event.target) || openProjectPopover.anchor.contains(event.target)) return;
  closeProjectPopover();
}

/** The Sessions tab's Move button: the same menu the Projects tab uses. */
function showMovePopover(session, anchor) {
  const items = sessionMoveItems(session);
  if (!items.length) items.push({ label: 'No projects yet. Create one from the Projects tab.', disabled: true });
  showContextMenu(items, { anchor });
}

// --- New project dialog ---

function slugifyClient(name) {
  let slug = String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (slug.length > 60) slug = slug.slice(0, 60).replace(/-+$/g, '');
  return slug || 'project';
}

/**
 * New project: a form on the left, and on the right what Create will make:
 * the project folder and its files, each worktree on its branch, folders
 * used in place, and the tracks the template adds. Pass `folders` to open
 * with folders already attached (a "new project from this folder" flow).
 */
async function showNewProjectDialog({ name: initialName = '', folders: initialFolders = [] } = {}) {
  const overlay = document.createElement('div');
  overlay.className = 'add-project-overlay np-overlay';

  const dialog = document.createElement('div');
  dialog.className = 'add-project-dialog np-dialog';
  dialog.innerHTML = `
    <div class="np-form">
      <h3>New project</h3>
      <label class="new-project-label" for="np-name">Name</label>
      <div class="folder-input-row">
        <input type="text" id="np-name" placeholder="Website redesign" autocomplete="off" spellcheck="false" value="${escapeHtml(initialName)}">
      </div>
      <label class="new-project-label">Start from</label>
      <div class="np-chips" id="np-templates"></div>
      <div class="np-help" id="np-template-hint"></div>
      <div class="np-row-head">
        <label class="new-project-label">Works in</label>
        <button type="button" class="np-link" id="np-add-folder">${PICONS.plus(11)}<span>Add folder</span></button>
      </div>
      <div class="np-folders" id="np-folders"></div>
      <div class="np-branch-line" id="np-branch-line" style="display:none;"></div>
      <div class="np-branch" id="np-branch" style="display:none;">
        <label class="new-project-label" for="np-branch-name">Worktree branch</label>
        <div class="np-inline">
          <input type="text" id="np-branch-name" class="np-input mono" spellcheck="false" title="One branch name for every worktree">
          <label class="ws-check"><input type="checkbox" id="np-shared-branch" checked> Same branch in every repo</label>
        </div>
        <div class="np-help" id="np-branch-help"></div>
      </div>
      <div class="add-project-error" id="np-error"></div>
      <div class="add-project-actions">
        <button class="add-project-cancel-btn" type="button">Cancel</button>
        <button class="add-project-add-btn" type="button">Create project</button>
      </div>
    </div>
    <div class="np-preview" id="np-preview"></div>
  `;
  overlay.appendChild(dialog);
  document.body.appendChild(overlay);

  const q = (sel) => dialog.querySelector(sel);
  const nameInput = q('#np-name');
  const templatesEl = q('#np-templates');
  const templateHint = q('#np-template-hint');
  const foldersEl = q('#np-folders');
  const branchSection = q('#np-branch');
  const branchLine = q('#np-branch-line');
  const branchInput = q('#np-branch-name');
  const sharedBox = q('#np-shared-branch');
  const branchHelp = q('#np-branch-help');
  const errorEl = q('#np-error');
  const previewEl = q('#np-preview');
  const createBtn = q('.add-project-add-btn');

  // mode is null until the folder is known: a plain folder becomes in-place on
  // its own, a repository asks. A caller may decide up front with f.mode.
  const folders = initialFolders.map(f => ({ path: f.path, mode: f.mode || null, branch: '', git: null, envFiles: [], copyEnv: new Set() }));
  let templateKind = '';
  let root = '~/Switchboard';
  try { root = (await window.api.getProjectsRoot()) || root; } catch {}
  let templates = [];
  try { templates = (await window.api.listTemplates())?.templates || []; } catch {}
  const shortPath = (p) => (typeof shortProjectPath === 'function' ? shortProjectPath(p) : p);
  const slug = () => slugifyClient(nameInput.value);
  const branchName = () => (sharedBox.checked && branchInput.value.trim()) || slug();
  // With one shared name every worktree uses it; otherwise each repo names its own, defaulting to the slug.
  const branchFor = (folder) => (sharedBox.checked ? branchName() : (folder.branch.trim() || slug()));
  const template = () => templates.find(t => t.kind === templateKind) || null;
  const hasWorktree = () => folders.some(f => f.mode === 'worktree');

  function renderTemplates() {
    templatesEl.replaceChildren();
    const chips = [{ kind: '', name: 'Blank' }, ...templates];
    for (const t of chips) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'np-chip' + (t.kind === templateKind ? ' on' : '');
      chip.dataset.kind = t.kind;
      chip.textContent = t.name;
      chip.onclick = () => { templateKind = t.kind; renderTemplates(); renderPreview(); };
      templatesEl.appendChild(chip);
    }
    const t = template();
    templateHint.textContent = t ? t.description : 'The brief, and nothing else until a session needs it.';
  }

  function renderBranchLine() {
    const any = hasWorktree();
    branchLine.style.display = any ? '' : 'none';
    if (!any) branchSection.style.display = 'none';
    branchLine.innerHTML = sharedBox.checked
      ? `Worktrees check out on <b class="mono">${escapeHtml(branchName())}</b> · <button type="button" class="np-link" id="np-branch-change">Change</button>`
      : `Each worktree names its own branch · <button type="button" class="np-link" id="np-branch-change">Change</button>`;
    branchLine.querySelector('#np-branch-change').onclick = () => {
      const open = branchSection.style.display === 'none';
      branchSection.style.display = open ? '' : 'none';
      if (open && sharedBox.checked) branchInput.focus();
    };
    branchInput.placeholder = slug();
    branchInput.style.display = sharedBox.checked ? '' : 'none';
    branchHelp.textContent = sharedBox.checked
      ? 'One branch name, checked out in every worktree.'
      : 'Each worktree gets its own branch. Name them on the rows above; empty means the project name.';
  }

  function renderFolders() {
    foldersEl.replaceChildren();
    if (!folders.length) {
      const none = document.createElement('div');
      none.className = 'np-folder-none';
      none.textContent = 'None yet. A project can work in its own folder alone.';
      foldersEl.appendChild(none);
    }
    for (const folder of folders) {
      const isRepo = folder.git?.git === true;
      const asking = folder.mode === null && isRepo;
      const row = document.createElement('div');
      row.className = 'np-folder' + (asking ? ' np-folder--ask' : '');
      row.dataset.path = folder.path;
      let detail;
      if (folder.git === null) detail = shortPath(folder.path) + ' · checking…';
      else if (folder.mode === 'worktree') detail = `worktree · repos/${pathBasename(folder.path)} · ${branchFor(folder)}`;
      else if (isRepo) detail = `${asking ? '' : 'in place · '}on ${folder.git.branch} · ${shortPath(folder.path)}`;
      else detail = `in place · ${shortPath(folder.path)}`;
      row.innerHTML = `<span class="np-folder-icon${folder.mode === 'worktree' ? ' is-worktree' : ''}">${folder.mode === 'worktree' ? PICONS.branch(13) : PICONS.folder(13)}</span>` +
        `<span class="np-folder-name">${escapeHtml(pathBasename(folder.path))}</span>` +
        `<span class="np-folder-path mono" title="${escapeHtml(folder.path)}">${escapeHtml(detail)}</span>`;
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'np-x';
      remove.title = 'Remove';
      remove.innerHTML = '&times;';
      remove.onclick = () => { folders.splice(folders.indexOf(folder), 1); renderFolders(); renderPreview(); };
      row.appendChild(remove);
      if (asking) {
        // The one decision a repository needs, asked once, where it matters.
        const ask = document.createElement('div');
        ask.className = 'np-ask';
        ask.innerHTML = `<div class="np-ask-q">This is a git repository. How should the project work in it?</div>
          <div class="np-ask-opts">
            <div class="np-ask-opt"><button type="button" class="ws-btn np-ask-btn" data-mode="in-place">As it is</button><div class="np-help">Sessions work in the folder, on whatever is checked out.</div></div>
            <div class="np-ask-opt"><button type="button" class="ws-btn np-ask-btn np-ask-btn--wt" data-mode="worktree">New worktree</button><div class="np-help">A worktree under the project on its branch. Your checkout is untouched.</div></div>
          </div>`;
        ask.querySelectorAll('.np-ask-btn').forEach(btn => { btn.onclick = () => { folder.mode = btn.dataset.mode; renderFolders(); renderPreview(); }; });
        row.appendChild(ask);
      }
      // git worktree add checks out tracked files only, so the repository's
      // .env stays behind. Offer the ones it has; an in-place folder keeps its
      // own and needs nothing.
      if (folder.mode === 'worktree' && folder.envFiles.length) {
        const env = document.createElement('div');
        env.className = 'np-folder-env';
        const head = document.createElement('div');
        head.className = 'np-help';
        head.textContent = 'The worktree starts with tracked files only. Copy these across:';
        env.appendChild(head);
        const boxes = document.createElement('div');
        boxes.className = 'np-env-files';
        for (const name of folder.envFiles) {
          const label = document.createElement('label');
          label.className = 'ws-check np-env-file';
          const box = document.createElement('input');
          box.type = 'checkbox';
          box.checked = folder.copyEnv.has(name);
          box.onchange = () => {
            if (box.checked) folder.copyEnv.add(name); else folder.copyEnv.delete(name);
            renderPreview();
          };
          label.appendChild(box);
          label.appendChild(Object.assign(document.createElement('span'), { className: 'mono', textContent: name }));
          boxes.appendChild(label);
        }
        env.appendChild(boxes);
        row.appendChild(env);
      }
      if (folder.mode === 'worktree' && !sharedBox.checked) {
        const line = document.createElement('div');
        line.className = 'np-folder-branch';
        line.innerHTML = `${PICONS.branch(11)}<span>branch</span>`;
        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'np-input mono';
        input.spellcheck = false;
        input.placeholder = slug();
        input.value = folder.branch;
        input.oninput = () => { folder.branch = input.value; renderPreview(); };
        line.appendChild(input);
        row.appendChild(line);
      }
      foldersEl.appendChild(row);
    }
    renderBranchLine();
    const undecided = folders.some(f => f.mode === null && f.git?.git === true);
    createBtn.disabled = undecided;
    createBtn.title = undecided ? 'Choose how to work in each repository first.' : '';
  }

  function renderPreview() {
    const s = slug();
    const t = template();
    const worktrees = folders.filter(f => f.mode === 'worktree');
    // A repository still being asked about is left out until it is decided.
    const inPlace = folders.filter(f => f.mode === 'in-place' || (f.mode === null && f.git?.git !== true));
    const tree = [
      `<span class="np-tree-root">${escapeHtml(shortPath(root))}/${escapeHtml(s)}/</span>`,
      `<span class="np-tree-item">CLAUDE.md <em>· the brief, read by every session</em></span>`,
      `<span class="np-tree-item">AGENTS.md <em>· the same brief, for Codex</em></span>`,
      `<span class="np-tree-item">plan.md <em>· todos.md · when a session needs them</em></span>`,
    ];
    if (worktrees.length) {
      tree.push(`<span class="np-tree-item np-tree-dir">repos/</span>`);
      for (const f of worktrees) {
        tree.push(`<span class="np-tree-sub">${PICONS.branch(11)}${escapeHtml(pathBasename(f.path))} <em>· branch ${escapeHtml(branchFor(f))}</em></span>`);
        const env = f.envFiles.filter(name => f.copyEnv.has(name));
        if (env.length) tree.push(`<span class="np-tree-sub np-tree-env"><em>copied in: ${escapeHtml(env.join(', '))}</em></span>`);
      }
    }
    const hue = projectHue(s);
    const tracks = (t?.tracks || []).map((track, i) => {
      const h = Math.round((hue + 40 + i * 137.5) % 360);
      return `<span class="pane-tag" style="color:hsl(${h},78%,72%);background:hsla(${h},70%,60%,0.16)">${escapeHtml(track.name)}</span>`;
    });
    previewEl.innerHTML = `
      <div class="np-preview-title">What you get</div>
      <div class="np-tree mono">${tree.join('')}</div>
      ${inPlace.length ? `<div class="np-preview-sec"><span class="np-preview-label">Also works in place</span>${inPlace.map(f => `<span class="np-preview-row mono" title="${escapeHtml(f.path)}">${PICONS.folder(11)}<span>${escapeHtml(shortPath(f.path))}</span></span>`).join('')}</div>` : ''}
      ${tracks.length ? `<div class="np-preview-sec"><span class="np-preview-label">Tracks</span><div class="np-tags">${tracks.join('')}</div></div>` : ''}
      <div class="np-preview-foot">Sessions start in the project folder and can read every folder listed here.</div>`;
  }

  function showError(text) {
    errorEl.textContent = text;
    errorEl.style.display = text ? 'block' : 'none';
  }

  function close() {
    overlay.remove();
    document.removeEventListener('keydown', onKey);
  }

  async function addFolder(folderPath) {
    if (!folderPath || folders.some(f => f.path === folderPath)) return;
    const folder = { path: folderPath, mode: null, branch: '', git: null, envFiles: [], copyEnv: new Set() };
    folders.push(folder);
    renderFolders();
    renderPreview();
    // A worktree only gets the repository's tracked files, so ask the folder
    // what .env files it has at the same time as its git state.
    const [git, env] = await Promise.all([
      window.api.getFolderGitStatus(folderPath).catch(() => ({ git: false })),
      window.api.listEnvFiles(folderPath).catch(() => null),
    ]);
    folder.git = git || { git: false };
    folder.envFiles = env?.files || [];
    folder.copyEnv = new Set(env?.defaults || []);
    if (!folder.git?.git && folder.mode === null) folder.mode = 'in-place';
    if (folders.includes(folder)) { renderFolders(); renderPreview(); }
  }

  async function create() {
    const name = nameInput.value.trim();
    if (!name) { showError('Give the project a name.'); nameInput.focus(); return; }
    showError('');
    createBtn.disabled = true;
    createBtn.textContent = hasWorktree() ? 'Creating worktrees…' : 'Creating…';
    let result;
    try {
      result = await window.api.createProject({
        name,
        folders: folders.map(f => ({
          path: f.path,
          mode: f.mode || 'in-place',
          branch: f.mode === 'worktree' && !sharedBox.checked ? f.branch.trim() : '',
          copyEnv: f.mode === 'worktree' ? f.envFiles.filter(name => f.copyEnv.has(name)) : [],
        })),
        sharedBranch: sharedBox.checked,
        branchName: branchInput.value.trim(),
        template: templateKind || undefined,
      });
    } catch (err) {
      result = { error: err.message };
    }
    createBtn.disabled = false;
    createBtn.textContent = 'Create project';
    if (!result || result.error) { showError(result?.error || 'Could not create the project.'); return; }
    close();
    projectsUi.selectedProjectId = result.project?.id || null;
    setProjectTab(projectsUi.selectedProjectId, 'overview');
    saveProjectsUi();
    await loadProjects();
    const tab = document.querySelector('.sidebar-tab[data-tab="projects"]');
    if (tab && activeTab !== 'projects') tab.click();
    else showProjectOverview();
    if (result.errors?.length) {
      alert(`Project created, but some worktrees could not be made:\n\n${result.errors.join('\n')}\n\nAttach them again from the project settings.`);
    }
  }

  q('#np-add-folder').onclick = async () => addFolder(await window.api.browseFolder());
  q('.add-project-cancel-btn').onclick = close;
  createBtn.onclick = create;
  nameInput.addEventListener('input', () => { branchInput.placeholder = slug(); renderPreview(); });
  branchInput.addEventListener('input', () => { renderPreview(); const b = branchLine.querySelector('b'); if (b) b.textContent = branchName(); });
  sharedBox.addEventListener('change', () => { renderFolders(); renderPreview(); });

  function onKey(e) {
    if (e.key === 'Escape') close();
    if (e.key === 'Enter' && (document.activeElement === nameInput || document.activeElement === branchInput)) create();
  }
  document.addEventListener('keydown', onKey);

  renderTemplates();
  renderFolders();
  renderPreview();
  for (const folder of folders) {
    Promise.all([
      window.api.getFolderGitStatus(folder.path).catch(() => ({ git: false })),
      window.api.listEnvFiles(folder.path).catch(() => null),
    ]).then(([git, env]) => {
      folder.git = git || { git: false };
      folder.envFiles = env?.files || [];
      folder.copyEnv = new Set(env?.defaults || []);
      if (!folder.git?.git && folder.mode === null) folder.mode = 'in-place';
      renderFolders(); renderPreview();
    }).catch(() => {});
  }
  nameInput.focus();
}
