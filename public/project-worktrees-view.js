// Worktrees tab for a project: every git worktree of the project's
// repositories, grouped by repository. The actions follow the VS Code
// extension git-worktree-manager (create, remove, lock, move, repair, prune,
// remove the merged ones) plus Switchboard's own: start a session or a
// terminal in a worktree, attach it to the project. Git runs in main
// (worktrees.js); this file paints and asks.

const projectWorktreesTabState = new Map();

const WT_SORT_ORDERS = [
  ['default', 'Git order'],
  ['nameAsc', 'Name, A to Z'],
  ['nameDesc', 'Name, Z to A'],
  ['createdDesc', 'Newest first'],
  ['createdAsc', 'Oldest first'],
];

const WT_START_OPTIONS = [
  ['none', 'Nothing'],
  ['claude', 'A Claude session'],
  ['codex', 'A Codex session'],
  ['terminal', 'A terminal'],
];

// Badge text for where a worktree came from; the side-by-side default and
// anything else get none.
const WT_KIND_LABELS = { main: 'Main', switchboard: 'Project', claude: 'Claude', codex: 'Codex', classic: '', other: '' };
const WT_KIND_HELP = {
  main: 'The repository\'s main checkout',
  switchboard: 'A worktree of this Switchboard project',
  claude: 'Made by claude --worktree, in .claude/worktrees',
  codex: 'Made by Codex, in its worktrees folder',
  classic: 'Next to the repository, in <repo>.worktrees',
  other: 'A worktree somewhere else',
};

function wtSvg(paths) {
  return (s = 13) => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
}

// Kept here rather than in PICONS, which another tab also extends.
const WT_ICONS = {
  lock: wtSvg('<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>'),
  unlock: wtSvg('<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 7.5-2"/>'),
  copy: wtSvg('<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/>'),
  merge: wtSvg('<circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M6 21V9a9 9 0 0 0 9 9"/>'),
  prune: wtSvg('<circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M20 4 8.1 15.9"/><path d="M14.5 14.5 20 20"/><path d="M8.1 8.1 12 12"/>'),
  move: wtSvg('<path d="M5 12h14"/><path d="m13 6 6 6-6 6"/>'),
  wrench: wtSvg('<path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.5 2.5-2.4-.6-.6-2.4Z"/>'),
  link: wtSvg('<path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/>'),
  unlink: wtSvg('<path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/><path d="m3 3 18 18"/>'),
  sliders: wtSvg('<path d="M4 6h9"/><path d="M17 6h3"/><circle cx="15" cy="6" r="2"/><path d="M4 12h3"/><path d="M11 12h9"/><circle cx="9" cy="12" r="2"/><path d="M4 18h11"/><path d="M19 18h1"/><circle cx="17" cy="18" r="2"/>'),
};

function wtTabState(projectId) {
  if (!projectWorktreesTabState.has(projectId)) {
    projectWorktreesTabState.set(projectId, {
      repositories: null,
      settings: null,
      query: '',
      notice: null,
      rows: new Map(),  // row key → { repo, wt }, rebuilt on every paint
      request: 0,
      dialogOpen: false,
    });
  }
  return projectWorktreesTabState.get(projectId);
}

/** Call a preload method; a missing one or a throw comes back as { error }. */
async function wtApi(name, ...args) {
  const fn = typeof window !== 'undefined' ? window.api?.[name] : null;
  if (typeof fn !== 'function') return { error: 'This version of Switchboard cannot do that.' };
  try {
    return (await fn(...args)) || { error: 'No answer from Switchboard.' };
  } catch (err) {
    return { error: err?.message || String(err) };
  }
}

/** escapeHtml leaves quotes alone; attribute values need them escaped too. */
function wtAttr(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
    .replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function wtPlural(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/** What a row is called: the branch, the short hash when detached, or the folder. */
function wtLabel(wt) {
  if (wt.bare) return 'bare repository';
  if (wt.branch) return wt.branch;
  if (wt.detached && wt.head) return wt.head.slice(0, 8);
  return pathBasename(wt.path);
}

function wtFileManager() {
  const platform = typeof window !== 'undefined' ? window.api?.platform : '';
  return platform === 'darwin' ? 'Finder' : platform === 'win32' ? 'Explorer' : 'File Manager';
}

function wtOpenLabel() {
  return `Open in ${wtFileManager()}`;
}

// --- Order, filter, sessions ---

/** The main worktree stays first; the rest follow the chosen order. Missing times sort last. */
function wtSortWorktrees(worktrees, order) {
  const main = worktrees.filter(wt => wt.isMain);
  const rest = worktrees.filter(wt => !wt.isMain);
  const byName = (a, b) => wtLabel(a).localeCompare(wtLabel(b), undefined, { numeric: true, sensitivity: 'base' });
  const byCreated = (direction) => (a, b) => {
    if (a.created == null && b.created == null) return 0;
    if (a.created == null) return 1;
    if (b.created == null) return -1;
    return direction * (a.created - b.created);
  };
  if (order === 'nameAsc') rest.sort(byName);
  else if (order === 'nameDesc') rest.sort((a, b) => byName(b, a));
  else if (order === 'createdDesc') rest.sort(byCreated(-1));
  else if (order === 'createdAsc') rest.sort(byCreated(1));
  return [...main, ...rest];
}

function wtMatches(wt, query) {
  if (!query) return true;
  const q = query.toLowerCase();
  return [wt.branch, wt.path, wt.head, WT_KIND_LABELS[wt.kind], wt.lockReason, wt.locked ? 'locked' : '', wt.exists ? '' : 'missing']
    .some(value => String(value || '').toLowerCase().includes(q));
}

/**
 * The repositories to paint, each with its worktrees filtered and sorted. A
 * query that names a repository keeps all its worktrees; a repository with
 * nothing left is hidden while filtering.
 */
function wtVisibleRepositories(repositories, query, order) {
  const q = String(query || '').trim().toLowerCase();
  return (repositories || []).map((repo) => {
    const repoMatches = q && (repo.name.toLowerCase().includes(q) || repo.mainPath.toLowerCase().includes(q));
    const worktrees = (repo.worktrees || []).filter(wt => !q || repoMatches || wtMatches(wt, q));
    return { repo, worktrees: wtSortWorktrees(worktrees, order) };
  }).filter(group => !q || group.worktrees.length || group.repo.name.toLowerCase().includes(q));
}

/**
 * Running sessions by worktree path. A session counts for the deepest
 * worktree it runs in, so one in .claude/worktrees/x is not also counted for
 * the main checkout around it.
 */
function wtSessionsByWorktree(repositories) {
  const byPath = new Map();
  if (typeof activePtyIds === 'undefined' || typeof sessionMap === 'undefined') return byPath;
  const paths = [];
  for (const repo of repositories || []) for (const wt of repo.worktrees || []) paths.push(wt.path);
  paths.sort((a, b) => b.length - a.length);
  for (const id of activePtyIds) {
    const session = sessionMap.get(id);
    if (!session?.projectPath) continue;
    const home = paths.find(p => isPathInside(session.projectPath, p));
    if (!home) continue;
    if (!byPath.has(home)) byPath.set(home, []);
    byPath.get(home).push(session);
  }
  return byPath;
}

// --- Painting ---

function wtBadgesHtml(wt) {
  const badges = [];
  const kind = WT_KIND_LABELS[wt.kind];
  if (kind) badges.push(`<span class="wt-badge wt-badge--${wtAttr(wt.kind)}" title="${wtAttr(WT_KIND_HELP[wt.kind])}">${escapeHtml(kind)}</span>`);
  if (wt.attached && wt.kind !== 'switchboard') badges.push('<span class="wt-badge wt-badge--switchboard" title="Attached to this project">In project</span>');
  if (wt.detached) badges.push('<span class="wt-badge" title="No branch checked out">Detached</span>');
  if (wt.locked) badges.push(`<span class="wt-badge wt-badge--locked" title="${wtAttr(wt.lockReason ? `Locked: ${wt.lockReason}` : 'Locked')}">${WT_ICONS.lock(9)}Locked</span>`);
  if (!wt.exists) badges.push(`<span class="wt-badge wt-badge--missing" title="${wtAttr(wt.prunableReason || 'The folder is gone')}">Missing</span>`);
  return badges.join('');
}

function wtStatusHtml(wt, live) {
  const parts = [];
  if (wt.exists && !wt.bare) {
    if (wt.dirty === true) parts.push('<span class="wt-state changed" title="Uncommitted changes">Changes</span>');
    else if (wt.dirty === false) parts.push('<span class="wt-state clean" title="Nothing to commit">Clean</span>');
    if (wt.ahead) parts.push(`<span class="wt-sync" title="${wtAttr(`${wtPlural(wt.ahead, 'commit')} ahead of its upstream`)}">↑${wt.ahead}</span>`);
    if (wt.behind) parts.push(`<span class="wt-sync" title="${wtAttr(`${wtPlural(wt.behind, 'commit')} behind its upstream`)}">↓${wt.behind}</span>`);
    if (wt.lastCommit?.time) {
      const when = new Date(wt.lastCommit.time);
      parts.push(`<span class="wt-last" title="${wtAttr(`${wt.lastCommit.subject}\n${when.toLocaleString()}`)}">${escapeHtml(formatDate(when))}</span>`);
    }
  }
  if (live?.length) {
    parts.push(`<span class="ws-badge wt-live" title="${wtAttr(live.map(s => s.name || s.summary || s.sessionId).join('\n'))}">${live.length} running</span>`);
  }
  return parts.join('');
}

/**
 * Where a worktree sits, short: relative to the folder that holds its
 * repository (app.worktrees/feat, app/.claude/worktrees/fix), else with ~.
 */
function wtRowPath(wt, repo) {
  const base = String(repo?.mainPath || '').replace(/\.git$/i, '');
  const parent = base.split(/[\\/]/).slice(0, -1).join('/');
  if (parent && isPathInside(wt.path, parent) && wt.path !== parent) return wt.path.slice(parent.length + 1);
  return wtShortPath(wt.path);
}

function wtRowHtml(wt, key, live, repo = null) {
  const title = `${wt.path}${wt.locked && wt.lockReason ? `\nLocked: ${wt.lockReason}` : ''}`;
  return `
    <div class="wt-row${wt.exists ? '' : ' missing'}${wt.isMain ? ' main' : ''}" data-wt="${wtAttr(key)}" title="${wtAttr(title)}">
      <span class="wt-row-icon">${wt.isMain ? PICONS.folder(13) : PICONS.branch(13)}</span>
      <div class="wt-row-main">
        <div class="wt-row-line"><span class="wt-row-label${wt.detached ? ' mono' : ''}">${escapeHtml(wtLabel(wt))}</span>${wtBadgesHtml(wt)}</div>
        <div class="wt-row-path mono">${escapeHtml(wtRowPath(wt, repo))}</div>
      </div>
      <div class="wt-row-status">${wtStatusHtml(wt, live)}</div>
      <div class="wt-row-actions">
        ${wt.exists ? `<button type="button" class="ws-btn ws-btn--sm" data-act="session" title="Start a session or a terminal in this worktree">${PICONS.plus(11)}<span>Session</span>${PICONS.chevronDown(10)}</button>
        <button type="button" class="ws-btn ws-btn--sm ws-btn--icon" data-act="open" title="${wtAttr(wtOpenLabel())}">${PICONS.folder(13)}</button>` : ''}
        <button type="button" class="ws-btn ws-btn--sm ws-btn--icon" data-act="more" title="More">${PICONS.dots(13)}</button>
      </div>
    </div>`;
}

// The home folder, from main with the first list (the preload does not have it).
let wtHomeDir = '';

/** A path with the home folder as "~". */
function wtShortPath(p) {
  const text = String(p || '');
  if (wtHomeDir && (text === wtHomeDir || isPathInside(text, wtHomeDir))) return '~' + text.slice(wtHomeDir.length);
  return text;
}

function wtNoticeHtml(notice) {
  if (!notice) return '';
  return `
    <div class="wt-notice wt-notice--${wtAttr(notice.kind)}" role="status">
      ${notice.kind === 'busy' ? '<span class="git-loading-dot"></span>' : ''}
      <span class="wt-notice-text">${escapeHtml(notice.text)}</span>
      ${notice.kind === 'busy' ? '' : `<button type="button" class="wt-notice-close" title="Dismiss" aria-label="Dismiss">${PICONS.x(10)}</button>`}
      ${notice.output ? `<details class="wt-notice-output"><summary>Output</summary><pre class="mono">${escapeHtml(notice.output)}</pre></details>` : ''}
    </div>`;
}

function wtSummaryText(repositories) {
  const repos = (repositories || []).length;
  const count = (repositories || []).reduce((n, repo) => n + (repo.worktrees || []).length, 0);
  return `${repos} ${repos === 1 ? 'repository' : 'repositories'} · ${wtPlural(count, 'worktree')}`;
}

function wtListHtml(project, state) {
  const repositories = state.repositories || [];
  state.rows = new Map();
  if (!repositories.length) {
    return `
      <div class="git-empty-state">
        <div class="git-empty-title">No repositories in this project</div>
        <div>Attach a folder that is a git repository, or holds some, to manage its worktrees here.</div>
        <button type="button" class="ws-btn ws-btn--sm" data-act="attach-folder">${PICONS.plus(11)}<span>Attach folder</span></button>
      </div>`;
  }
  const settings = state.settings || {};
  const collapsed = new Set(settings.collapsedGroups || []);
  const groups = wtVisibleRepositories(repositories, state.query, settings.sortOrder || 'default');
  if (!groups.length) return `<div class="git-empty-state"><div class="git-empty-title">Nothing matches “${escapeHtml(state.query)}”</div></div>`;
  const live = wtSessionsByWorktree(repositories);
  let index = 0;
  return groups.map(({ repo, worktrees }, groupIndex) => {
    const closed = collapsed.has(repo.id) && !state.query;
    const rows = repo.error
      ? `<div class="git-empty-row">${escapeHtml(repo.error)}</div>`
      : worktrees.map((wt) => {
        const key = `w${index++}`;
        state.rows.set(key, { repo, wt });
        return wtRowHtml(wt, key, live.get(wt.path) || [], repo);
      }).join('');
    return `
      <section class="git-section wt-repo" data-repo="${groupIndex}">
        <div class="git-section-heading wt-repo-head">
          <button type="button" class="wt-repo-toggle" data-act="toggle" aria-expanded="${closed ? 'false' : 'true'}" title="${closed ? 'Show' : 'Hide'} its worktrees">${closed ? PICONS.chevronRight(10) : PICONS.chevronDown(10)}<span class="wt-repo-name">${escapeHtml(repo.name)}</span></button>
          <span class="wt-repo-path mono" title="${wtAttr(repo.mainPath)}">${escapeHtml(wtShortPath(repo.mainPath))}</span>
          <span class="git-heading-right">
            <span class="git-section-meta">${wtPlural((repo.worktrees || []).length, 'worktree')}</span>
            ${repo.error ? '' : `<button type="button" class="ws-btn ws-btn--sm ws-btn--icon" data-act="repo-new" title="New worktree in ${wtAttr(repo.name)}">${PICONS.plus(11)}</button>`}
            <button type="button" class="ws-btn ws-btn--sm ws-btn--icon" data-act="repo-more" title="More for ${wtAttr(repo.name)}">${PICONS.dots(13)}</button>
          </span>
        </div>
        ${closed ? '' : `<div class="wt-rows">${rows}</div>`}
      </section>`;
  }).join('');
}

function wtGroups(state) {
  const settings = state.settings || {};
  return wtVisibleRepositories(state.repositories || [], state.query, settings.sortOrder || 'default');
}

function paintWorktreeList(project, state, body) {
  const list = body.querySelector('#wt-list');
  if (!list) return;
  list.innerHTML = wtListHtml(project, state);
  const summary = body.querySelector('#wt-summary');
  if (summary) summary.textContent = wtSummaryText(state.repositories);
  const groups = wtGroups(state);

  list.querySelector('[data-act="attach-folder"]')?.addEventListener('click', () => {
    if (typeof attachFolderAsk === 'function') attachFolderAsk(project);
  });
  list.querySelectorAll('.wt-repo').forEach((section) => {
    const repo = groups[Number(section.dataset.repo)]?.repo;
    if (!repo) return;
    section.querySelector('[data-act="toggle"]').onclick = () => wtToggleGroup(project, repo);
    const add = section.querySelector('[data-act="repo-new"]');
    if (add) add.onclick = () => wtCreateDialog(project, repo);
    section.querySelector('[data-act="repo-more"]').onclick = (e) => showContextMenu(wtRepoMenuItems(project, repo), { anchor: e.currentTarget });
  });
  list.querySelectorAll('.wt-row').forEach((row) => {
    const entry = state.rows.get(row.dataset.wt);
    if (!entry) return;
    const { repo, wt } = entry;
    const session = row.querySelector('[data-act="session"]');
    if (session) session.onclick = (e) => showContextMenu(wtSessionMenuItems(project, wt), { anchor: e.currentTarget });
    const open = row.querySelector('[data-act="open"]');
    if (open) open.onclick = () => wtOpenFolder(project, wt.path);
    row.querySelector('[data-act="more"]').onclick = (e) => showContextMenu(wtRowMenuItems(project, repo, wt), { anchor: e.currentTarget });
    row.oncontextmenu = (e) => { e.preventDefault(); showContextMenu(wtRowMenuItems(project, repo, wt), { x: e.clientX, y: e.clientY }); };
  });
}

function wtBindNotice(project, body) {
  const close = body.querySelector('#wt-notice .wt-notice-close');
  if (close) close.onclick = () => wtSetNotice(project, null);
}

function paintWorktreesTab(project, state, body) {
  const settings = state.settings || {};
  const hasRepos = (state.repositories || []).some(repo => !repo.error);
  body.innerHTML = `
    <div class="git-tab-shell wt-shell">
      <div class="git-tab-top">
        <div><div class="git-tab-title">Worktrees</div><div class="git-tab-path" id="wt-summary">${escapeHtml(wtSummaryText(state.repositories))}</div></div>
        <div class="wt-top-actions">
          <button type="button" class="ws-btn ws-btn--sm ws-btn--primary" id="wt-new" ${hasRepos ? '' : 'disabled'}>${PICONS.plus(11)}<span>New worktree</span></button>
          <button type="button" class="ws-btn ws-btn--sm" id="wt-merged" ${hasRepos ? '' : 'disabled'} title="Remove the worktrees whose branch is already merged">${WT_ICONS.merge(12)}<span>Remove merged</span></button>
          <button type="button" class="ws-btn ws-btn--sm" id="wt-prune" ${hasRepos ? '' : 'disabled'} title="Drop git's records of worktrees whose folder is gone">${WT_ICONS.prune(12)}<span>Prune</span></button>
          <button type="button" class="ws-btn ws-btn--sm ws-btn--icon" id="wt-refresh" title="Refresh">${PICONS.refresh(13)}</button>
          <button type="button" class="ws-btn ws-btn--sm ws-btn--icon" id="wt-settings" title="Worktree settings">${WT_ICONS.sliders(13)}</button>
        </div>
      </div>
      <div class="wt-toolbar">
        <label class="wt-search">${PICONS.search(12)}<input type="search" id="wt-search" placeholder="Filter by branch, folder or kind" autocomplete="off" spellcheck="false" value="${wtAttr(state.query)}"></label>
        <select class="ws-select wt-sort" id="wt-sort" title="Sort worktrees">
          ${WT_SORT_ORDERS.map(([value, label]) => `<option value="${value}" ${value === (settings.sortOrder || 'default') ? 'selected' : ''}>${escapeHtml(label)}</option>`).join('')}
        </select>
      </div>
      <div id="wt-notice">${wtNoticeHtml(state.notice)}</div>
      <div class="wt-list" id="wt-list"></div>
    </div>`;
  paintWorktreeList(project, state, body);
  wtBindNotice(project, body);

  body.querySelector('#wt-new').onclick = () => wtCreateDialog(project, null);
  body.querySelector('#wt-merged').onclick = (e) => wtPickRepository(project, e.currentTarget, repo => wtMergedDialog(project, repo));
  body.querySelector('#wt-prune').onclick = (e) => wtPickRepository(project, e.currentTarget, repo => wtPruneDialog(project, repo));
  body.querySelector('#wt-refresh').onclick = () => wtReload(project, { notice: true });
  body.querySelector('#wt-settings').onclick = () => wtSettingsDialog(project);
  const search = body.querySelector('#wt-search');
  search.oninput = () => {
    state.query = search.value;
    paintWorktreeList(project, state, body);
  };
  body.querySelector('#wt-sort').onchange = (e) => {
    const sortOrder = e.target.value;
    state.settings = { ...(state.settings || {}), sortOrder };
    paintWorktreeList(project, state, body);
    wtApi('setWorktreeSettings', project.id, { sortOrder });
  };
}

/** The tab's body when it is the one on screen for this project, else null. */
function wtActiveBody(project) {
  if (typeof document === 'undefined' || typeof document.getElementById !== 'function') return null;
  const body = document.getElementById('ws-body');
  if (!body || !body.isConnected) return null;
  if (selectedProject()?.id !== project.id || projectTab(project) !== 'worktrees') return null;
  return body;
}

function wtSetNotice(project, notice) {
  const state = wtTabState(project.id);
  state.notice = notice;
  const body = wtActiveBody(project);
  const slot = body?.querySelector('#wt-notice');
  if (!slot) return;
  slot.innerHTML = wtNoticeHtml(notice);
  wtBindNotice(project, body);
}

/** Fetch the worktrees again and repaint the list (or the whole tab the first time). */
async function wtReload(project, { notice = false } = {}) {
  const state = wtTabState(project.id);
  const request = ++state.request;
  if (notice) wtSetNotice(project, { kind: 'busy', text: 'Reading worktrees…' });
  const result = await wtApi('getProjectWorktrees', project.id);
  if (request !== state.request) return;
  const body = wtActiveBody(project);
  if (!result?.ok) {
    const text = result?.error || 'Could not read the worktrees.';
    if (!state.repositories) {
      if (body) body.innerHTML = `<div class="git-empty-state"><div class="git-empty-title">Worktrees unavailable</div><div>${escapeHtml(text)}</div></div>`;
    } else wtSetNotice(project, { kind: 'error', text });
    return;
  }
  const first = !state.repositories;
  state.repositories = result.repositories || [];
  state.settings = result.settings || state.settings;
  if (result.homeDir) wtHomeDir = result.homeDir;
  if (notice && state.notice?.kind === 'busy') state.notice = null;
  if (!body) return;
  if (first || !body.querySelector('#wt-list')) paintWorktreesTab(project, state, body);
  else {
    paintWorktreeList(project, state, body);
    if (notice) wtSetNotice(project, state.notice);
  }
}

function renderProjectWorktreesTab(project, body) {
  const state = wtTabState(project.id);
  body.className = 'ws-body git-tab-body wt-tab-body';
  if (state.repositories) paintWorktreesTab(project, state, body);
  else body.innerHTML = '<div class="git-loading"><span class="git-loading-dot"></span>Reading worktrees…</div>';
  wtReload(project);
}

/** Session counts change without the project changing: repaint just the list. */
function applyWorktreeSessionCounts(project) {
  const state = wtTabState(project.id);
  const body = wtActiveBody(project);
  if (!body || !state.repositories || state.dialogOpen) return;
  paintWorktreeList(project, state, body);
}

// --- Menus ---

function wtLaunchTarget(project, wt) {
  return { ...launchTargetFor(project), projectPath: wt.path, trackId: null };
}

/**
 * Start a session or a terminal in a worktree. It already is a separate
 * checkout, so Claude is never asked for another worktree on top of it.
 */
async function wtStartSession(project, wt, runtime) {
  const target = wtLaunchTarget(project, wt);
  if (runtime === 'terminal') return launchTerminalSession(target);
  const options = await resolveDefaultSessionOptions(target);
  options.runtime = runtime;
  options.worktree = false;
  delete options.worktreeName;
  return launchNewSession(target, options);
}

function wtSessionMenuItems(project, wt) {
  return [
    { label: 'Claude', icon: ICONS.claude(14), onClick: () => wtStartSession(project, wt, 'claude') },
    { label: 'Codex', icon: ICONS.codex(14, 'codex-icon'), onClick: () => wtStartSession(project, wt, 'codex') },
    { label: 'Terminal', icon: ICONS.terminal(14), onClick: () => wtStartSession(project, wt, 'terminal') },
    { sep: true },
    { label: 'Claude, configure…', muted: true, onClick: () => showNewSessionDialog(wtLaunchTarget(project, wt), 'claude') },
    { label: 'Codex, configure…', muted: true, onClick: () => showNewSessionDialog(wtLaunchTarget(project, wt), 'codex') },
  ];
}

function wtFolderFor(project, wt) {
  return (project.folders || []).find(f => f.path === wt.path) || null;
}

function wtRowMenuItems(project, repo, wt) {
  const items = [{ head: wtLabel(wt) }];
  if (wt.exists) {
    items.push({ label: 'New session', icon: PICONS.plus(13), submenu: wtSessionMenuItems(project, wt) });
    items.push({ label: wtOpenLabel(), icon: PICONS.folder(13), onClick: () => wtOpenFolder(project, wt.path) });
  }
  items.push({ label: 'Copy path', icon: WT_ICONS.copy(13), onClick: () => wtCopyPath(project, wt.path) });
  const folder = wtFolderFor(project, wt);
  items.push({
    label: 'Show in the Git tab', icon: PICONS.branch(13), disabled: !folder,
    hint: folder ? '' : 'attach it first', onClick: () => wtOpenInGitTab(project, folder),
  });
  items.push(wt.attached
    ? { label: 'Detach from project', icon: WT_ICONS.unlink(13), hint: 'keeps the folder', onClick: () => wtDetach(project, repo, wt) }
    : { label: 'Attach to project', icon: WT_ICONS.link(13), disabled: !wt.exists, onClick: () => wtAttach(project, wt) });
  if (wt.isMain) return items;
  items.push({ sep: true });
  items.push(wt.locked
    ? { label: 'Unlock', icon: WT_ICONS.unlock(13), onClick: () => wtUnlock(project, wt) }
    : { label: 'Lock…', icon: WT_ICONS.lock(13), onClick: () => wtLockDialog(project, wt) });
  items.push({ label: 'Move…', icon: WT_ICONS.move(13), disabled: wt.locked || !wt.exists, hint: wt.locked ? 'locked' : '', onClick: () => wtMoveDialog(project, wt) });
  items.push({ label: 'Repair', icon: WT_ICONS.wrench(13), onClick: () => wtRepair(project, repo, [wt.path]) });
  items.push({ sep: true });
  items.push({ label: wt.exists ? 'Remove…' : 'Remove record…', icon: PICONS.trash(13), danger: true, onClick: () => wtRemoveDialog(project, repo, wt) });
  return items;
}

function wtRepoMenuItems(project, repo) {
  const items = [{ head: repo.name }];
  if (!repo.error) {
    items.push(
      { label: 'New worktree…', icon: PICONS.plus(13), onClick: () => wtCreateDialog(project, repo) },
      { label: 'Remove merged…', icon: WT_ICONS.merge(13), onClick: () => wtMergedDialog(project, repo) },
      { label: 'Prune…', icon: WT_ICONS.prune(13), onClick: () => wtPruneDialog(project, repo) },
      { label: 'Repair all', icon: WT_ICONS.wrench(13), onClick: () => wtRepair(project, repo, []) },
      { label: 'Repair a moved folder…', icon: WT_ICONS.wrench(13), onClick: () => wtRepairMoved(project, repo) },
      { sep: true },
    );
  }
  items.push(
    { label: wtOpenLabel(), icon: PICONS.folder(13), onClick: () => wtOpenFolder(project, repo.mainPath) },
    { label: 'Copy path', icon: WT_ICONS.copy(13), onClick: () => wtCopyPath(project, repo.mainPath) },
  );
  return items;
}

/** One repository: run fn on it; several: ask which first. */
function wtPickRepository(project, anchor, fn) {
  const repos = (wtTabState(project.id).repositories || []).filter(repo => !repo.error);
  if (repos.length === 1) return fn(repos[0]);
  showContextMenu([
    { head: 'Repository' },
    ...repos.map(repo => ({ label: repo.name, hint: wtShortPath(repo.mainPath), icon: PICONS.folder(13), onClick: () => fn(repo) })),
  ], { anchor });
}

// --- Simple actions ---

function wtToggleGroup(project, repo) {
  const state = wtTabState(project.id);
  const collapsed = new Set(state.settings?.collapsedGroups || []);
  if (collapsed.has(repo.id)) collapsed.delete(repo.id); else collapsed.add(repo.id);
  state.settings = { ...(state.settings || {}), collapsedGroups: [...collapsed] };
  const body = wtActiveBody(project);
  if (body) paintWorktreeList(project, state, body);
  wtApi('setWorktreeSettings', project.id, { collapsedGroups: [...collapsed] });
}

async function wtOpenFolder(project, folderPath) {
  const result = await wtApi('openPath', folderPath);
  if (result?.error) wtSetNotice(project, { kind: 'error', text: result.error });
}

async function wtCopyPath(project, folderPath) {
  await wtApi('writeClipboard', folderPath);
  wtSetNotice(project, { kind: 'ok', text: `Copied ${folderPath}` });
}

function wtOpenInGitTab(project, folder) {
  if (!folder) return;
  if (typeof gitTabState === 'function') gitTabState(project.id).selectedRepo = folder.path;
  setProjectTab(project, 'git');
  renderOverview();
}

/** Run an action, show what happened, refresh. */
async function wtRun(project, busyText, call, okText) {
  wtSetNotice(project, { kind: 'busy', text: busyText });
  const result = await call();
  if (!result?.ok) {
    wtSetNotice(project, { kind: 'error', text: result?.error || 'That did not work.', output: result?.output });
    await wtReload(project);
    return null;
  }
  wtSetNotice(project, { kind: 'ok', text: typeof okText === 'function' ? okText(result) : okText, output: result.output || '' });
  await wtReload(project);
  return result;
}

function wtAttach(project, wt) {
  return wtRun(project, `Attaching ${wtLabel(wt)}…`, () => wtApi('attachWorktreeToProject', project.id, wt.path), `Attached ${wtLabel(wt)} to the project`);
}

async function wtDetach(project, repo, wt) {
  // The repository was found through this folder: once detached it may leave the tab.
  if (wt.isMain && !repo.nested) {
    const ok = await wtFormDialog({
      title: `Detach ${repo.name} from the project?`,
      html: '<div class="add-project-hint">The folder and its worktrees stay on disk. They stop showing here unless another attached folder holds the repository.</div>',
      confirm: 'Detach',
      submit: () => true,
    });
    if (!ok) return null;
  }
  return wtRun(project, `Detaching ${wtLabel(wt)}…`, () => wtApi('detachWorktreeFromProject', project.id, wt.path), `Detached ${wtLabel(wt)}; the folder stays`);
}

function wtUnlock(project, wt) {
  return wtRun(project, `Unlocking ${wtLabel(wt)}…`, () => wtApi('unlockWorktree', project.id, wt.path), `Unlocked ${wtLabel(wt)}`);
}

function wtRepair(project, repo, paths) {
  return wtRun(project, `Repairing ${paths.length ? wtLabel({ path: paths[0], branch: '' }) : repo.name}…`,
    () => wtApi('repairWorktrees', project.id, repo.mainPath, paths),
    result => (result.output ? 'Repaired' : 'Nothing to repair'));
}

async function wtRepairMoved(project, repo) {
  const folder = await wtApi('browseFolder');
  if (!folder || typeof folder !== 'string') return null;
  return wtRun(project, `Repairing ${folder}…`, () => wtApi('repairWorktrees', project.id, repo.mainPath, [folder]),
    result => (result.output ? `Reconnected ${folder}` : 'Nothing to repair'));
}

// --- Dialogs ---

/**
 * A modal form in the style of the other project dialogs: Escape and Cancel
 * close it, a click on the backdrop does nothing. submit(ui) runs on
 * confirm and returns { error } to stay open and show it, false to stay open
 * silently, or anything else to close and resolve with it (true for
 * undefined). Resolves null when cancelled.
 */
function wtFormDialog({ title, html, confirm = 'Save', danger = false, wide = false, onReady, submit }) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'add-project-overlay';
    const dialog = document.createElement('div');
    dialog.className = `add-project-dialog ws-prompt wt-dialog${wide ? ' wt-dialog--wide' : ''}`;
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.innerHTML = `
      <h3>${escapeHtml(title)}</h3>
      <div class="wt-dialog-body">${html}</div>
      <div class="wt-dialog-error" hidden></div>
      <div class="add-project-actions">
        <button class="add-project-cancel-btn" type="button">Cancel</button>
        <button class="add-project-add-btn${danger ? ' wt-danger' : ''}" type="button">${escapeHtml(confirm)}</button>
      </div>`;
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);
    const confirmBtn = dialog.querySelector('.add-project-add-btn');
    const cancelBtn = dialog.querySelector('.add-project-cancel-btn');
    const errorEl = dialog.querySelector('.wt-dialog-error');
    let busy = false;
    const ui = {
      dialog,
      confirmBtn,
      setError(text) { errorEl.textContent = text || ''; errorEl.hidden = !text; },
      setConfirm(label, enabled = true) { if (label) confirmBtn.textContent = label; confirmBtn.disabled = !enabled; },
    };
    const onKey = (e) => { if (e.key === 'Escape' && !busy) { e.stopPropagation(); finish(null); } };
    function finish(value) {
      overlay.remove();
      document.removeEventListener('keydown', onKey, true);
      resolve(value);
    }
    cancelBtn.onclick = () => { if (!busy) finish(null); };
    confirmBtn.onclick = async () => {
      if (busy || confirmBtn.disabled) return;
      ui.setError('');
      busy = true;
      const label = confirmBtn.textContent;
      confirmBtn.disabled = true;
      cancelBtn.disabled = true;
      confirmBtn.textContent = 'Working…';
      let result;
      try { result = await submit(ui); } catch (err) { result = { error: err?.message || String(err) }; }
      busy = false;
      cancelBtn.disabled = false;
      confirmBtn.disabled = false;
      confirmBtn.textContent = label;
      if (result && typeof result === 'object' && result.error) { ui.setError(result.error); return; }
      if (result === false) return;
      finish(result === undefined ? true : result);
    };
    document.addEventListener('keydown', onKey, true);
    onReady?.(ui);
    if (!dialog.contains(document.activeElement)) {
      (dialog.querySelector('input:not([type=hidden]):not([type=radio]):not([type=checkbox]):not([disabled]), select, textarea') || cancelBtn).focus();
    }
  });
}

/** Mark the tab busy with a dialog so session refreshes do not repaint under it. */
async function wtWithDialog(project, open) {
  const state = wtTabState(project.id);
  state.dialogOpen = true;
  try { return await open(); } finally { state.dialogOpen = false; }
}

function wtCheck(id, label, help = '', checked = false) {
  return `<label class="wt-check"><input type="checkbox" id="${wtAttr(id)}" ${checked ? 'checked' : ''}><span>${label}${help ? `<span class="wt-check-help">${help}</span>` : ''}</span></label>`;
}

/** A branch name as a folder name, the same way main does it. */
function wtRefFolderName(ref) {
  return String(ref || '').replace(/[\\/]+/g, '-').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+|-+$/g, '').slice(0, 80);
}

/** The template filled in for a preview; main adds a number when the folder is taken. */
function wtPreviewTemplate(template, repo, ref, projectRoot) {
  const base = String(repo?.mainPath || '').replace(/\.git$/i, '');
  const parts = base.split(/[\\/]/);
  const vars = {
    BASE_PATH: base,
    BASE_ROOT: parts.slice(0, -1).join('/') || '/',
    BASE_NAME: parts[parts.length - 1] || '',
    REF_NAME: wtRefFolderName(ref) || 'worktree',
    INDEX: '1',
    PROJECT_ROOT: projectRoot || '',
  };
  return String(template || '').replace(/\$(BASE_PATH|BASE_ROOT|BASE_NAME|REF_NAME|INDEX|PROJECT_ROOT)/g, (_m, name) => vars[name] ?? '');
}

function wtOptionsHtml(items, selected) {
  return items.map(([value, label, disabled]) => `<option value="${wtAttr(value)}" ${value === selected ? 'selected' : ''} ${disabled ? 'disabled' : ''}>${escapeHtml(label)}</option>`).join('');
}

/** Start points for a new branch or a detached checkout: HEAD, local then remote branches. */
function wtStartPointOptions(branches) {
  const head = branches?.mainBranch ? `HEAD of the main worktree (${branches.mainBranch})` : 'HEAD of the main worktree';
  const items = [['', head]];
  for (const branch of branches?.local || []) items.push([branch.name, branch.name]);
  for (const branch of branches?.remote || []) items.push([branch.name, branch.name]);
  return items;
}

function wtCreateDialog(project, repo) {
  const state = wtTabState(project.id);
  const repos = (state.repositories || []).filter(item => !item.error);
  if (!repos.length) return null;
  let current = repo && !repo.error ? repo : repos[0];
  const settings = state.settings || {};
  const html = `
    ${repos.length > 1
      ? `<label class="new-project-label">Repository</label><select class="ws-select wt-field" id="wt-c-repo">${repos.map((item, i) => `<option value="${i}" ${item === current ? 'selected' : ''}>${escapeHtml(`${item.name} · ${wtShortPath(item.mainPath)}`)}</option>`).join('')}</select>`
      : `<div class="add-project-hint">In <b>${escapeHtml(current.name)}</b> · <span class="mono">${escapeHtml(wtShortPath(current.mainPath))}</span></div>`}
    <label class="new-project-label">Check out</label>
    <div class="wt-modes" role="radiogroup">
      <label class="wt-mode"><input type="radio" name="wt-c-mode" value="new" checked><span>New branch</span></label>
      <label class="wt-mode"><input type="radio" name="wt-c-mode" value="existing"><span>Existing branch</span></label>
      <label class="wt-mode"><input type="radio" name="wt-c-mode" value="remote"><span>Remote branch</span></label>
      <label class="wt-mode"><input type="radio" name="wt-c-mode" value="detached"><span>Detached</span></label>
    </div>
    <div class="wt-c-fields" data-for="new">
      <label class="new-project-label">Branch name</label>
      <input type="text" class="ws-input wt-field" id="wt-c-branch" placeholder="feature/my-change" spellcheck="false" autocomplete="off">
      <label class="new-project-label">Start from</label>
      <select class="ws-select wt-field" id="wt-c-start"></select>
    </div>
    <div class="wt-c-fields" data-for="existing" hidden>
      <label class="new-project-label">Branch</label>
      <select class="ws-select wt-field" id="wt-c-existing"></select>
    </div>
    <div class="wt-c-fields" data-for="remote" hidden>
      <label class="new-project-label">Remote branch</label>
      <select class="ws-select wt-field" id="wt-c-remote"></select>
      <label class="new-project-label">Local branch</label>
      <input type="text" class="ws-input wt-field" id="wt-c-local" spellcheck="false" autocomplete="off">
    </div>
    <div class="wt-c-fields" data-for="detached" hidden>
      <label class="new-project-label">At</label>
      <select class="ws-select wt-field" id="wt-c-detach"></select>
    </div>
    <label class="new-project-label">Folder</label>
    <div class="wt-path-row">
      <input type="text" class="ws-input wt-field mono" id="wt-c-path" spellcheck="false" autocomplete="off">
      <button type="button" class="ws-btn ws-btn--sm" id="wt-c-browse" title="Pick the folder to put the worktree in">Choose…</button>
    </div>
    <div class="add-project-hint wt-hint">From the folder template in Worktree settings. Change it freely.</div>
    ${wtCheck('wt-c-attach', 'Attach to the project', 'Listed with the project\'s folders and in the Git tab, and added to new sessions of the project.')}
    <div id="wt-c-env"></div>
    ${settings.copyPatterns?.length ? `<div class="add-project-hint wt-hint">Also copies what matches <span class="mono">${escapeHtml(settings.copyPatterns.join(', '))}</span>.</div>` : ''}
    ${settings.postCreateCmd ? wtCheck('wt-c-post', `Then run <code>${escapeHtml(settings.postCreateCmd)}</code>`, 'In the new worktree, before anything opens there.', true) : ''}
    <label class="new-project-label">Then open</label>
    <select class="ws-select wt-field" id="wt-c-after">${wtOptionsHtml(WT_START_OPTIONS, settings.startAfterCreate || 'none')}</select>`;

  let branches = null;
  let pathEdited = false;
  let suggestTimer = null;
  const $ = (ui, sel) => ui.dialog.querySelector(sel);
  const mode = (ui) => $(ui, 'input[name="wt-c-mode"]:checked')?.value || 'new';
  const refFor = (ui) => {
    const m = mode(ui);
    if (m === 'new') return $(ui, '#wt-c-branch').value.trim();
    if (m === 'existing') return $(ui, '#wt-c-existing').value;
    if (m === 'remote') return $(ui, '#wt-c-local').value.trim() || $(ui, '#wt-c-remote').value;
    return $(ui, '#wt-c-detach').value || branches?.mainBranch || 'detached';
  };
  const suggest = (ui) => {
    if (pathEdited) return;
    clearTimeout(suggestTimer);
    suggestTimer = setTimeout(async () => {
      const result = await wtApi('suggestWorktreePath', project.id, current.mainPath, refFor(ui));
      if (!result?.ok || pathEdited) return;
      const input = $(ui, '#wt-c-path');
      input.value = result.path;
      // The end of the path is the part that changes; keep it in view.
      input.scrollLeft = input.scrollWidth;
    }, 150);
  };
  const fillBranches = async (ui) => {
    branches = null;
    const result = await wtApi('listWorktreeBranches', project.id, current.mainPath);
    if (!result?.ok) { ui.setError(result?.error || 'Could not read the branches.'); return; }
    branches = result;
    const starts = wtStartPointOptions(result);
    $(ui, '#wt-c-start').innerHTML = wtOptionsHtml(starts, '');
    $(ui, '#wt-c-detach').innerHTML = wtOptionsHtml(starts.map(([v, l]) => [v, v ? l : l.replace('HEAD of', 'The HEAD of')]), '');
    const local = result.local.map(b => [b.name, result.checkedOut[b.name] ? `${b.name} (in ${pathBasename(result.checkedOut[b.name])})` : b.name, !!result.checkedOut[b.name]]);
    const free = local.find(item => !item[2]);
    $(ui, '#wt-c-existing').innerHTML = local.length ? wtOptionsHtml(local, free ? free[0] : '') : '<option value="" disabled selected>No local branches</option>';
    const remote = result.remote.map(b => [b.name, b.name]);
    $(ui, '#wt-c-remote').innerHTML = remote.length ? wtOptionsHtml(remote, remote[0][0]) : '<option value="" disabled selected>No remote branches (fetch first)</option>';
    syncRemoteLocal(ui);
    suggest(ui);
  };
  const syncRemoteLocal = (ui) => {
    const remoteName = $(ui, '#wt-c-remote').value;
    const remote = branches?.remote.find(b => b.name === remoteName);
    $(ui, '#wt-c-local').value = remote ? remoteName.slice(remote.remote.length + 1) : '';
  };
  const fillEnv = async (ui) => {
    const slot = $(ui, '#wt-c-env');
    slot.innerHTML = '';
    const result = await wtApi('listEnvFiles', current.mainPath);
    const files = result?.files || [];
    if (!files.length) return;
    const defaults = new Set(result.defaults || []);
    slot.innerHTML = `
      <label class="new-project-label">Local files to copy</label>
      <div class="wt-env-list">${files.map((name, i) => `<label class="wt-check wt-check--inline"><input type="checkbox" data-env="${i}" ${defaults.has(name) ? 'checked' : ''}><span class="mono">${escapeHtml(name)}</span></label>`).join('')}</div>`;
    slot._files = files;
  };

  return wtWithDialog(project, () => wtFormDialog({
    title: 'New worktree',
    html,
    confirm: 'Create worktree',
    wide: true,
    onReady: (ui) => {
      ui.dialog.querySelectorAll('input[name="wt-c-mode"]').forEach((input) => {
        input.onchange = () => {
          ui.dialog.querySelectorAll('.wt-c-fields').forEach((fields) => { fields.hidden = fields.dataset.for !== mode(ui); });
          suggest(ui);
        };
      });
      $(ui, '#wt-c-branch').oninput = () => suggest(ui);
      $(ui, '#wt-c-existing').onchange = () => suggest(ui);
      $(ui, '#wt-c-remote').onchange = () => { syncRemoteLocal(ui); suggest(ui); };
      $(ui, '#wt-c-local').oninput = () => suggest(ui);
      $(ui, '#wt-c-detach').onchange = () => suggest(ui);
      $(ui, '#wt-c-path').oninput = () => { pathEdited = !!$(ui, '#wt-c-path').value.trim(); };
      $(ui, '#wt-c-browse').onclick = async () => {
        const parent = await wtApi('browseFolder');
        if (!parent || typeof parent !== 'string') return;
        const name = wtRefFolderName(refFor(ui)) || pathBasename($(ui, '#wt-c-path').value) || 'worktree';
        $(ui, '#wt-c-path').value = `${parent.replace(/[\\/]+$/, '')}/${name}`;
        pathEdited = true;
      };
      const repoSelect = $(ui, '#wt-c-repo');
      if (repoSelect) {
        repoSelect.onchange = () => {
          current = repos[Number(repoSelect.value)] || current;
          ui.setError('');
          fillBranches(ui);
          fillEnv(ui);
        };
      }
      fillBranches(ui);
      fillEnv(ui);
      $(ui, '#wt-c-branch').focus();
    },
    submit: async (ui) => {
      const m = mode(ui);
      const spec = {
        repoPath: current.mainPath,
        mode: m,
        path: $(ui, '#wt-c-path').value.trim(),
        attach: $(ui, '#wt-c-attach').checked,
      };
      if (m === 'new') {
        spec.branch = $(ui, '#wt-c-branch').value.trim();
        spec.startPoint = $(ui, '#wt-c-start').value;
        if (!spec.branch) return { error: 'Name the new branch.' };
      } else if (m === 'existing') {
        spec.branch = $(ui, '#wt-c-existing').value;
        if (!spec.branch) return { error: 'Pick a branch.' };
      } else if (m === 'remote') {
        spec.remoteBranch = $(ui, '#wt-c-remote').value;
        spec.branch = $(ui, '#wt-c-local').value.trim();
        if (!spec.remoteBranch) return { error: 'Pick a remote branch.' };
      } else {
        spec.startPoint = $(ui, '#wt-c-detach').value;
      }
      const envSlot = $(ui, '#wt-c-env');
      spec.copyEnv = [...envSlot.querySelectorAll('input[data-env]:checked')].map(input => envSlot._files[Number(input.dataset.env)]).filter(Boolean);
      const result = await wtApi('createWorktree', project.id, spec);
      if (!result?.ok) return { error: result?.error || 'Could not create the worktree.' };
      return { result, runPost: !!$(ui, '#wt-c-post')?.checked, after: $(ui, '#wt-c-after').value };
    },
  })).then(async (outcome) => {
    if (!outcome || outcome === true) return null;
    await wtAfterCreate(project, outcome);
    return outcome.result;
  });
}

/** After the dialog: say what was made, run the post-create command, open what was asked. */
async function wtAfterCreate(project, { result, runPost, after }) {
  const made = result.worktree;
  const label = made.branch || pathBasename(made.path);
  const details = [];
  if (result.copied?.length) details.push(`copied ${result.copied.join(', ')}`);
  if (result.attached) details.push('attached to the project');
  const createdText = `Created ${label}${details.length ? ` (${details.join('; ')})` : ''}`;
  wtSetNotice(project, { kind: result.warnings?.length ? 'error' : 'ok', text: [createdText, ...(result.warnings || [])].join('. ') });
  await wtReload(project);
  if (runPost && result.postCreateCmd) {
    wtSetNotice(project, { kind: 'busy', text: `${createdText}. Running the post-create command…` });
    const ran = await wtApi('runWorktreePostCreate', project.id, made.path);
    if (ran?.ok) wtSetNotice(project, { kind: 'ok', text: `${createdText}. The post-create command finished.`, output: ran.output || '' });
    else wtSetNotice(project, { kind: 'error', text: `${createdText}, but ${ran?.error || 'the post-create command failed'}. The worktree is there.`, output: ran?.output || '' });
    await wtReload(project);
  }
  if (after && after !== 'none') await wtStartSession(project, { path: made.path }, after);
}

function wtRemoveDialog(project, repo, wt) {
  const state = wtTabState(project.id);
  const live = wtSessionsByWorktree(state.repositories).get(wt.path) || [];
  const settings = state.settings || {};
  const html = `
    <div class="add-project-hint mono wt-dialog-path" title="${wtAttr(wt.path)}">${escapeHtml(wtShortPath(wt.path))}</div>
    ${live.length ? `<div class="done-choice-warn">${escapeHtml(`${wtPlural(live.length, 'running session')} here will lose ${live.length === 1 ? 'its' : 'their'} folder.`)}</div>${dialogListHtml(live.map(s => s.name || s.summary || s.sessionId))}` : ''}
    ${!wt.exists ? '<div class="add-project-hint">The folder is already gone: this drops git\'s record of it.</div>' : ''}
    ${wt.locked ? wtCheck('wt-r-unlock', 'Unlock it first', escapeHtml(wt.lockReason ? `Locked: ${wt.lockReason}` : 'It is locked.')) : ''}
    ${wt.exists ? wtCheck('wt-r-force', 'Discard its uncommitted changes', wt.dirty ? 'It has some. They are lost: git cannot bring them back.' : 'Only needed if it has any.') : ''}
    ${wt.branch ? wtCheck('wt-r-branch', `Also delete the branch <span class="mono">${escapeHtml(wt.branch)}</span>`, 'If it is not merged you are asked again.') : ''}
    ${settings.preRemoveCmd && wt.exists ? `<div class="add-project-hint wt-hint">Runs <code>${escapeHtml(settings.preRemoveCmd)}</code> first. If it fails, the worktree stays.</div>` : ''}
    ${wt.attached ? '<div class="add-project-hint wt-hint">It is detached from the project too.</div>' : ''}`;
  const readiness = (ui) => {
    const unlock = ui.dialog.querySelector('#wt-r-unlock');
    const force = ui.dialog.querySelector('#wt-r-force');
    const ready = (!unlock || unlock.checked) && (!wt.dirty || force?.checked);
    ui.setConfirm(force?.checked ? 'Remove and discard changes' : 'Remove worktree', ready);
  };
  return wtWithDialog(project, () => wtFormDialog({
    title: `Remove the worktree ${wtLabel(wt)}?`,
    html,
    confirm: 'Remove worktree',
    danger: true,
    onReady: (ui) => {
      ui.dialog.querySelectorAll('input[type="checkbox"]').forEach((input) => { input.onchange = () => readiness(ui); });
      readiness(ui);
    },
    submit: async (ui) => {
      const opts = {
        unlock: !!ui.dialog.querySelector('#wt-r-unlock')?.checked,
        force: !!ui.dialog.querySelector('#wt-r-force')?.checked,
        deleteBranch: !!ui.dialog.querySelector('#wt-r-branch')?.checked,
      };
      const result = await wtApi('removeWorktree', project.id, wt.path, opts);
      if (result?.dirty) return { error: 'It has uncommitted changes. Tick "Discard its uncommitted changes" to remove it anyway.' };
      if (!result?.ok) return { error: [result?.error || 'Could not remove the worktree.', result?.output].filter(Boolean).join('\n\n') };
      return result;
    },
  })).then(async (result) => {
    if (!result || result === true) return null;
    let text = `Removed ${wtLabel(wt)}`;
    if (result.branchDeleted) text += ` and the branch ${result.branch}`;
    wtSetNotice(project, { kind: 'ok', text });
    await wtReload(project);
    if (result.unmerged) await wtForceDeleteBranchDialog(project, repo, result.branch, result.branchError);
    else if (result.branchError) wtSetNotice(project, { kind: 'error', text: `${text}, but the branch stays: ${result.branchError}` });
    return result;
  });
}

function wtForceDeleteBranchDialog(project, repo, branch, why) {
  return wtWithDialog(project, () => wtFormDialog({
    title: `Delete ${branch} anyway?`,
    html: `<div class="add-project-hint">The worktree is gone, but the branch has commits that are not merged. Deleting it loses them unless another branch or tag points at them.</div>${why ? `<div class="add-project-hint mono wt-hint">${escapeHtml(why.split('\n')[0])}</div>` : ''}`,
    confirm: 'Delete the branch',
    danger: true,
    submit: async () => {
      const result = await wtApi('deleteWorktreeBranch', project.id, repo.mainPath, branch, { force: true });
      return result?.ok ? true : { error: result?.error || 'Could not delete the branch.' };
    },
  })).then(async (done) => {
    if (done) {
      wtSetNotice(project, { kind: 'ok', text: `Deleted the branch ${branch}` });
      await wtReload(project);
    }
    return done;
  });
}

function wtLockDialog(project, wt) {
  return wtWithDialog(project, () => wtFormDialog({
    title: `Lock ${wtLabel(wt)}`,
    html: `
      <div class="add-project-hint">A locked worktree is not pruned, moved or removed until you unlock it. Useful for one on a removable drive or a network share.</div>
      <label class="new-project-label">Reason (optional)</label>
      <input type="text" class="ws-input wt-field" id="wt-l-reason" maxlength="200" placeholder="on the USB drive" autocomplete="off">`,
    confirm: 'Lock',
    submit: async (ui) => {
      const result = await wtApi('lockWorktree', project.id, wt.path, ui.dialog.querySelector('#wt-l-reason').value.trim());
      return result?.ok ? true : { error: result?.error || 'Could not lock the worktree.' };
    },
  })).then(async (done) => {
    if (done) {
      wtSetNotice(project, { kind: 'ok', text: `Locked ${wtLabel(wt)}` });
      await wtReload(project);
    }
    return done;
  });
}

function wtMoveDialog(project, wt) {
  return wtWithDialog(project, () => wtFormDialog({
    title: `Move ${wtLabel(wt)}`,
    html: `
      <label class="new-project-label">New folder</label>
      <div class="wt-path-row">
        <input type="text" class="ws-input wt-field mono" id="wt-m-path" value="${wtAttr(wt.path)}" spellcheck="false" autocomplete="off">
        <button type="button" class="ws-btn ws-btn--sm" id="wt-m-browse" title="Pick the folder to move it into">Choose…</button>
      </div>
      <div class="add-project-hint wt-hint">Git moves the folder and keeps track of it.${wt.attached ? ' The project\'s folder, default folder and track folders follow.' : ''} Past sessions keep the old folder, so they will not resume there.</div>`,
    confirm: 'Move',
    wide: true,
    onReady: (ui) => {
      const input = ui.dialog.querySelector('#wt-m-path');
      input.focus();
      input.setSelectionRange?.(input.value.length, input.value.length);
      ui.dialog.querySelector('#wt-m-browse').onclick = async () => {
        const parent = await wtApi('browseFolder');
        if (parent && typeof parent === 'string') input.value = `${parent.replace(/[\\/]+$/, '')}/${pathBasename(wt.path)}`;
      };
    },
    submit: async (ui) => {
      const target = ui.dialog.querySelector('#wt-m-path').value.trim();
      if (!target || target === wt.path) return { error: 'Choose a different folder.' };
      const result = await wtApi('moveWorktree', project.id, wt.path, target);
      return result?.ok ? result : { error: result?.error || 'Could not move the worktree.' };
    },
  })).then(async (result) => {
    if (result && result !== true) {
      wtSetNotice(project, { kind: 'ok', text: `Moved ${wtLabel(wt)} to ${wtShortPath(result.path)}` });
      await wtReload(project);
    }
    return result;
  });
}

async function wtPruneDialog(project, repo) {
  const preview = await wtApi('previewWorktreePrune', project.id, repo.mainPath);
  if (!preview?.ok) { wtSetNotice(project, { kind: 'error', text: preview?.error || 'Could not check what to prune.' }); return null; }
  const stale = preview.staleFolders || [];
  if (!preview.worktrees.length && !stale.length) {
    wtSetNotice(project, { kind: 'ok', text: `Nothing to prune in ${repo.name}` });
    return null;
  }
  const lines = preview.worktrees.map(item => `${wtShortPath(item.path)}${item.branch ? ` · ${item.branch}` : ''}${item.reason ? ` · ${item.reason}` : ''}`);
  return wtWithDialog(project, () => wtFormDialog({
    title: `Prune ${repo.name}?`,
    html: `
      ${lines.length ? `<div class="add-project-hint">Git still has a record of ${lines.length === 1 ? 'this worktree' : 'these worktrees'}, but the folder is gone. Pruning drops the record; branches stay.</div>${dialogListHtml(lines)}` : '<div class="add-project-hint">Git has nothing to prune.</div>'}
      ${stale.length ? wtCheck('wt-p-detach', `Also detach ${wtPlural(stale.length, 'project folder')} that no longer ${stale.length === 1 ? 'exists' : 'exist'}`, escapeHtml(stale.map(f => wtShortPath(f.path)).join(', ')), true) : ''}`,
    confirm: 'Prune',
    submit: async (ui) => {
      const result = await wtApi('pruneWorktrees', project.id, repo.mainPath, { detachStale: !!ui.dialog.querySelector('#wt-p-detach')?.checked });
      return result?.ok ? result : { error: result?.error || 'Could not prune.' };
    },
  })).then(async (result) => {
    if (result && result !== true) {
      const parts = [`Pruned ${wtPlural(result.pruned, 'worktree record')}`];
      if (result.detached) parts.push(`detached ${wtPlural(result.detached, 'folder')}`);
      wtSetNotice(project, { kind: 'ok', text: parts.join(', ') });
      await wtReload(project);
    }
    return result;
  });
}

/**
 * The merged worktrees as checkboxes. One that cannot go is disabled with the
 * reason; one with running sessions can go but is not ticked for you.
 */
function wtMergedListHtml(result, repo, live = new Map()) {
  if (!result.worktrees.length) return `<div class="add-project-hint">No worktree has a branch merged into <span class="mono">${escapeHtml(result.base)}</span>.</div>`;
  return `<div class="wt-merged-list">${result.worktrees.map((item, i) => {
    const running = (live.get(item.path) || []).length;
    const notes = [wtRowPath(item, repo), item.reason, running ? `${running} running` : ''].filter(Boolean);
    return `
    <label class="wt-check${item.eligible ? '' : ' disabled'}" title="${wtAttr(item.path)}">
      <input type="checkbox" data-merged="${i}" ${item.eligible && !running ? 'checked' : ''} ${item.eligible ? '' : 'disabled'}>
      <span><span class="mono">${escapeHtml(item.branch)}</span><span class="wt-check-help">${escapeHtml(notes.join(' · '))}</span></span>
    </label>`;
  }).join('')}</div>`;
}

async function wtMergedDialog(project, repo) {
  let result = await wtApi('getMergedWorktrees', project.id, repo.mainPath, '');
  if (!result?.ok) { wtSetNotice(project, { kind: 'error', text: result?.error || 'Could not find the merged worktrees.' }); return null; }
  const branches = await wtApi('listWorktreeBranches', project.id, repo.mainPath);
  const bases = [...(branches?.local || []), ...(branches?.remote || [])].map(b => [b.name, b.name]);
  if (!bases.some(([name]) => name === result.base)) bases.unshift([result.base, result.base]);
  const live = wtSessionsByWorktree(wtTabState(project.id).repositories);
  const refreshList = (ui) => {
    ui.dialog.querySelector('#wt-x-list').innerHTML = wtMergedListHtml(result, repo, live);
    ui.setConfirm(null, !!ui.dialog.querySelector('input[data-merged]:checked'));
    ui.dialog.querySelectorAll('input[data-merged]').forEach((input) => {
      input.onchange = () => ui.setConfirm(null, !!ui.dialog.querySelector('input[data-merged]:checked'));
    });
  };
  return wtWithDialog(project, () => wtFormDialog({
    title: `Remove merged worktrees in ${repo.name}`,
    html: `
      <label class="new-project-label">Merged into</label>
      <select class="ws-select wt-field" id="wt-x-base">${wtOptionsHtml(bases, result.base)}</select>
      <div id="wt-x-list"></div>
      ${wtCheck('wt-x-branches', 'Also delete their branches', 'Safe: every commit on them is in the base branch.', true)}`,
    confirm: 'Remove selected',
    danger: true,
    wide: true,
    onReady: (ui) => {
      refreshList(ui);
      ui.dialog.querySelector('#wt-x-base').onchange = async (e) => {
        const next = await wtApi('getMergedWorktrees', project.id, repo.mainPath, e.target.value);
        if (!next?.ok) { ui.setError(next?.error || 'Could not check that branch.'); return; }
        ui.setError('');
        result = next;
        refreshList(ui);
      };
    },
    submit: async (ui) => {
      const chosen = [...ui.dialog.querySelectorAll('input[data-merged]:checked')].map(input => result.worktrees[Number(input.dataset.merged)]).filter(Boolean);
      if (!chosen.length) return { error: 'Tick at least one worktree.' };
      const deleteBranch = ui.dialog.querySelector('#wt-x-branches').checked;
      const failures = [];
      let removed = 0;
      for (const item of chosen) {
        ui.setConfirm(`Removing ${item.branch}…`, false);
        const done = await wtApi('removeWorktree', project.id, item.path, { deleteBranch });
        if (done?.ok) removed += 1;
        else failures.push(`${item.branch}: ${done?.error || 'failed'}`);
      }
      return { removed, failures };
    },
  })).then(async (outcome) => {
    if (outcome && outcome !== true) {
      const text = `Removed ${wtPlural(outcome.removed, 'merged worktree')}`;
      wtSetNotice(project, outcome.failures.length
        ? { kind: 'error', text: `${text}; ${outcome.failures.length} could not go`, output: outcome.failures.join('\n') }
        : { kind: 'ok', text });
      await wtReload(project);
    }
    return outcome;
  });
}

function wtPatternsText(list) {
  return (list || []).join('\n');
}

function wtSettingsDialog(project) {
  const state = wtTabState(project.id);
  const settings = state.settings || {};
  const sample = (state.repositories || []).find(repo => !repo.error) || null;
  const html = `
    <label class="new-project-label">New worktree folder</label>
    <input type="text" class="ws-input wt-field mono" id="wt-s-template" value="${wtAttr(settings.pathTemplate || '')}" spellcheck="false" autocomplete="off">
    <div class="add-project-hint wt-hint">
      <span class="mono">$BASE_PATH</span> the repository, <span class="mono">$BASE_ROOT</span> its parent folder, <span class="mono">$BASE_NAME</span> its name,
      <span class="mono">$REF_NAME</span> the branch, <span class="mono">$INDEX</span> a number, <span class="mono">$PROJECT_ROOT</span> this project's folder.
      ${sample ? `<br>For <b>${escapeHtml(sample.name)}</b>: <span class="mono" id="wt-s-preview"></span>` : ''}
    </div>
    <label class="new-project-label">Copy into new worktrees</label>
    <textarea class="ws-input wt-field wt-textarea mono" id="wt-s-copy" rows="3" spellcheck="false" placeholder=".env*&#10;config/local.json">${escapeHtml(wtPatternsText(settings.copyPatterns))}</textarea>
    <div class="add-project-hint wt-hint">One pattern per line, relative to the repository (<span class="mono">*</span>, <span class="mono">**</span>, <span class="mono">?</span>). Files git does not check out, like .env or local config. A matching folder is copied whole.</div>
    <label class="new-project-label">But not</label>
    <textarea class="ws-input wt-field wt-textarea mono" id="wt-s-ignore" rows="2" spellcheck="false" placeholder=".env.example">${escapeHtml(wtPatternsText(settings.copyIgnores))}</textarea>
    <label class="new-project-label">After creating, run</label>
    <input type="text" class="ws-input wt-field mono" id="wt-s-post" value="${wtAttr(settings.postCreateCmd || '')}" placeholder="npm install" spellcheck="false" autocomplete="off">
    <label class="new-project-label">Before removing, run</label>
    <input type="text" class="ws-input wt-field mono" id="wt-s-pre" value="${wtAttr(settings.preRemoveCmd || '')}" placeholder="npm run teardown" spellcheck="false" autocomplete="off">
    <div class="add-project-hint wt-hint">Both run in the worktree, in your login shell, with SWITCHBOARD_WORKTREE, SWITCHBOARD_MAIN_WORKTREE and SWITCHBOARD_BRANCH set. If the one before removing fails, the worktree stays.</div>
    <label class="new-project-label">After creating, open</label>
    <select class="ws-select wt-field" id="wt-s-after">${wtOptionsHtml(WT_START_OPTIONS, settings.startAfterCreate || 'none')}</select>`;
  return wtWithDialog(project, () => wtFormDialog({
    title: 'Worktree settings',
    html,
    confirm: 'Save',
    wide: true,
    onReady: (ui) => {
      const input = ui.dialog.querySelector('#wt-s-template');
      const preview = ui.dialog.querySelector('#wt-s-preview');
      const update = () => { if (preview) preview.textContent = wtPreviewTemplate(input.value || '$BASE_PATH.worktrees/$REF_NAME', sample, 'feature/example', project.root); };
      input.oninput = update;
      update();
    },
    submit: async (ui) => {
      const value = (sel) => ui.dialog.querySelector(sel).value;
      const result = await wtApi('setWorktreeSettings', project.id, {
        pathTemplate: value('#wt-s-template').trim(),
        copyPatterns: value('#wt-s-copy'),
        copyIgnores: value('#wt-s-ignore'),
        postCreateCmd: value('#wt-s-post'),
        preRemoveCmd: value('#wt-s-pre'),
        startAfterCreate: value('#wt-s-after'),
      });
      return result?.ok ? result : { error: result?.error || 'Could not save the settings.' };
    },
  })).then((result) => {
    if (result && result !== true) {
      state.settings = result.settings;
      wtSetNotice(project, { kind: 'ok', text: 'Saved the worktree settings' });
    }
    return result;
  });
}

// A worktree made outside the app (a terminal, Claude, Codex) shows up when
// the window comes back.
if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener('focus', () => {
    const project = typeof selectedProject === 'function' ? selectedProject() : null;
    if (!project || !wtActiveBody(project) || wtTabState(project.id).dialogOpen) return;
    wtReload(project);
  });
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    wtLabel, wtSortWorktrees, wtMatches, wtVisibleRepositories, wtSessionsByWorktree,
    wtRowHtml, wtRowPath, wtBadgesHtml, wtStatusHtml, wtListHtml, wtRowMenuItems, wtRepoMenuItems,
    wtMergedListHtml, wtPreviewTemplate, wtRefFolderName, wtStartPointOptions, wtAttr,
  };
}
