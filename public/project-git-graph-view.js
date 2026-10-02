// "Git Graph" project tab: a read-only commit graph for the project's
// attached repositories, sitting immediately after the existing read-only
// "Git" tab (which this file never touches). Layout and painting (this file
// + git-graph-render.js) are self-contained; context menus are built by
// git-graph-menus.js and only ever called through the small set of guarded
// globals below, so this tab still renders and its own tests still pass
// before that file exists.
//
// Mutating actions (checkout, branch/tag management, stash apply, …), the
// settings drawer, avatars and the committed repo config file are a later
// PR — everything here only ever reads.
//
// Depends on globals: escapeHtml, escapeAttr, formatDate, pathBasename
// (utils.js / projects-view.js), PICONS, showContextMenu (projects-view.js),
// createUnifiedMergeViewer, createReadOnlyViewer (codemirror-setup.js),
// selectedProject/projectTab (projects-view.js), buildGitChangeTree,
// gitTreeRows (project-git-view.js), and the render helpers in
// git-graph-render.js.

const GG_INITIAL_LOAD = 300;
const GG_LOAD_MORE = 100;

const gitGraphTabState = new Map();

function gitGraphState(projectId) {
  if (!gitGraphTabState.has(projectId)) {
    gitGraphTabState.set(projectId, {
      repositories: null,
      selectedRepo: null,
      request: 0,
      detailsRequest: 0,
      error: '',
      loading: false,
      loadingMore: false,
      rawCommits: [],
      rows: [],            // merged Commit[]+pseudo-commits, render order
      layout: [],           // parallel lane assignments
      refs: null,
      stashes: [],
      uncommitted: null,
      headHash: null,
      headBranchName: null,
      skip: 0,
      hasMore: false,
      branchSelection: 'all',
      tagSelection: 'all',
      refSort: 'asc',
      showRemoteBranches: true,
      showTags: true,
      showStashesPref: true,
      showUncommittedChangesPref: true,
      columns: { date: true, author: true, commit: true },
      columnWidths: {},
      // Fixed display defaults — no settings drawer to change them from.
      dateFormat: 'date-time',
      dateType: 'author',
      graphStyle: 'rounded',
      uncommittedChangesStyle: 'openAtUncommitted',
      combineLocalAndRemote: true,
      muteMergeCommits: true,
      selectedHash: null,
      compareHash: null,
      detailsData: null,
      detailsLoading: false,
      detailsJustOpened: false,
      fileViewType: 'tree',
      collapsedFolders: new Set(),
      findOpen: false,
      findQuery: '',
      findCaseSensitive: false,
      findAlsoOpenDetails: false,
      findMatches: [],
      findIndex: -1,
      keydownHandler: null,
      branchesMenuOpen: false,
      branchesMenuTab: 'branches',
      branchesFilter: '',
      branchesMenuCleanup: null,
    });
  }
  return gitGraphTabState.get(projectId);
}

// --- window.api wrapper: degrades gracefully if the preload bridge doesn't expose a given call yet ---

function gitGraphApi(name, ...args) {
  if (!window.api || typeof window.api[name] !== 'function') {
    return Promise.resolve({ error: `${name} is not available yet` });
  }
  return window.api[name](...args);
}

// --- Per-viewer UI-state persistence: localStorage only, per PR scope — no
// server-side RepoConfig/GlobalPrefs; a reset on a cleared profile is
// acceptable, matching the existing tab-memory idiom. ---

function gitGraphUiKey(projectId) { return `gitGraph.ui.${projectId}`; }

function gitGraphLoadUiPrefs(projectId) {
  try {
    const raw = localStorage.getItem(gitGraphUiKey(projectId));
    return raw ? JSON.parse(raw) : {};
  } catch { return {}; }
}

function gitGraphSaveUiPrefs(projectId, state) {
  try {
    localStorage.setItem(gitGraphUiKey(projectId), JSON.stringify({
      selectedRepo: state.selectedRepo,
      columns: state.columns,
      columnWidths: state.columnWidths,
      branchSelection: state.branchSelection,
      tagSelection: state.tagSelection,
      refSort: state.refSort,
      showRemoteBranches: state.showRemoteBranches,
      fileViewType: state.fileViewType,
    }));
  } catch { /* private-browsing / disabled storage: ephemeral state only */ }
}

// --- Pure helpers (unit-tested directly; no DOM) ---

/** Case-sensitive/-insensitive substring match across message/date/author/hash/branch/tag. */
function gitGraphFindMatches(rows, query, caseSensitive) {
  if (!query) return [];
  const q = caseSensitive ? query : query.toLowerCase();
  const norm = (v) => (caseSensitive ? String(v || '') : String(v || '').toLowerCase());
  const matches = [];
  const refName = (typeof gitGraphRefName === 'function') ? gitGraphRefName : (entry => (typeof entry === 'string' ? entry : entry && entry.name));
  rows.forEach((row, index) => {
    const refNames = [
      ...(row.refs?.heads || []).map(refName),
      ...(row.refs?.remotes || []).map(r => r.name),
      ...(row.refs?.tags || []).map(refName),
    ];
    const haystacks = [row.subject, row.authorDate, row.commitDate, row.authorName, row.hash, ...refNames];
    if (haystacks.some(h => norm(h).includes(q))) matches.push(index);
  });
  return matches;
}

/**
 * Escape → menu, then details panel, then Find, in that priority order.
 * `hooks` are the closers for whichever of those is actually open; each
 * returns true if it closed something.
 */
function gitGraphHandleEscapePriority(hooks) {
  if (hooks.closeMenu && hooks.closeMenu()) return 'menu';
  if (hooks.closeDetails && hooks.closeDetails()) return 'details';
  if (hooks.closeFind && hooks.closeFind()) return 'find';
  return null;
}

function gitGraphIsEditableTarget(target) {
  if (!target) return false;
  const tag = (target.tagName || '').toLowerCase();
  return tag === 'input' || tag === 'textarea' || target.isContentEditable;
}

/** Builds the file-menu target object git-graph-menus.js's gitGraphBuildFileMenu expects. */
function gitGraphBuildFileCtx(state, filePath) {
  const data = state.detailsData || {};
  const file = (data.files || []).find(f => f.path === filePath) || { path: filePath };
  const repo = (state.repositories || []).find(r => r.path === state.selectedRepo);
  return {
    path: file.path,
    relativePath: file.path,
    absolutePath: repo ? `${repo.path}/${file.path}` : file.path,
  };
}

/** Fills in the one target-specific field (commit/localBranch/remoteBranch/tag/file/columnHeader) git-graph-menus.js's ctx contract expects, from the frozen data-gg-* attributes. */
function gitGraphPopulateTargetField(ctx, state, target) {
  if (!target) return;
  if (target.kind === 'commit') {
    const row = state.rows.find(r => r.hash === target.hash);
    if (row) ctx.commit = { hash: row.hash, shortHash: row.shortHash, subject: row.subject };
  } else if (target.kind === 'branch' && target.refType !== 'remote') {
    ctx.localBranch = { name: target.refName, hash: target.hash };
  } else if (target.kind === 'remote-branch' || (target.kind === 'branch' && target.refType === 'remote')) {
    ctx.remoteBranch = { remote: target.remote, name: target.refName, hash: target.hash };
  } else if (target.kind === 'tag') {
    ctx.tag = { name: target.refName, hash: target.hash };
  } else if (target.kind === 'file') {
    ctx.file = gitGraphBuildFileCtx(state, target.filePath);
  } else if (target.kind === 'column-header') {
    ctx.columnHeader = { columnVisibility: state.columns };
  }
}

/** Assembles the ctx object git-graph-menus.js's gitGraphBuild*Menu functions read. */
function gitGraphBuildMenuCtx(project, state, body, repo, target) {
  const ctx = {
    onColumnVisibilityChange: (col, visible) => {
      state.columns[col] = visible;
      gitGraphSaveUiPrefs(project.id, state);
      gitGraphPaint(project, state, body);
    },
    onViewDiff: (file) => gitGraphOpenFileDiff(project, state, body, repo, file.path),
    onViewFileAtRevision: (file) => gitGraphViewFileAtRevision(project, state, body, repo, file),
  };
  gitGraphPopulateTargetField(ctx, state, target);
  return ctx;
}

/** One call site for every right-click: builds ctx and opens the matching menu via git-graph-menus.js. */
function gitGraphOpenContextMenu(project, state, body, el, position) {
  const repo = (state.repositories || []).find(r => r.path === state.selectedRepo);
  if (!repo || typeof gitGraphReadTargetAttrs !== 'function') return;
  const target = gitGraphReadTargetAttrs(el);
  if (!target || !target.kind) return;
  const ctx = gitGraphBuildMenuCtx(project, state, body, repo, target);
  if (typeof gitGraphShowContextMenu === 'function') gitGraphShowContextMenu(el, ctx, position);
}

// --- Layout / row assembly ---

function gitGraphMergedRows(state) {
  return gitGraphBuildLayoutInput(state.rawCommits || [], state.stashes || [], state.uncommitted, state.headHash);
}

function gitGraphRecomputeLayout(state) {
  state.rows = gitGraphMergedRows(state);
  const layoutFn = gitGraphResolveLayoutFn();
  state.layout = layoutFn(state.rows, 'date', {});
}

// --- Data loading ---

function gitGraphRepoList(project) {
  const seen = new Set();
  const list = [];
  for (const path of [project.root, ...((project.folders || []).map(f => f.path))]) {
    if (path && !seen.has(path)) { seen.add(path); list.push({ path }); }
  }
  return list;
}

function gitGraphLoadRepositories(project, state) {
  return gitGraphApi('getProjectGitInfo', project.id).then((result) => {
    const list = (result && result.ok && result.repositories) ? result.repositories : gitGraphRepoList(project);
    state.repositories = list.filter(r => r.git !== false);
    if (!state.repositories.length) state.repositories = list;
    return state.repositories;
  });
}

function gitGraphLoadGraph(project, state, body, opts = {}) {
  const repo = (state.repositories || []).find(r => r.path === state.selectedRepo) || (state.repositories || [])[0];
  if (!repo) return Promise.resolve();
  state.selectedRepo = repo.path;
  const reset = opts.reset !== false;
  if (reset) { state.skip = 0; state.rawCommits = []; }
  const limit = reset ? GG_INITIAL_LOAD : GG_LOAD_MORE;
  const request = ++state.request;
  if (reset) { state.loading = true; state.error = ''; } else { state.loadingMore = true; }
  // This interim repaint (setting the loading-more flag before the fetch
  // even resolves) must preserve scroll too — Load More is triggered by
  // scrolling near the bottom, so a bare gitGraphPaint() here would already
  // reset the table to the top before any new rows arrive.
  gitGraphPaint(project, state, body, { preserveScroll: !reset });

  return gitGraphApi('getProjectGitGraph', project.id, repo.path, {
    branches: state.branchSelection,
    tags: state.tagSelection,
    order: 'date',
    limit,
    skip: state.skip,
    showRemote: state.showRemoteBranches,
    showTags: state.showTags,
    showStashes: state.showStashesPref,
    showUncommittedChanges: state.showUncommittedChangesPref,
    refsUnchanged: !reset,
  }).then((result) => {
    if (request !== state.request) return;
    state.loading = false;
    state.loadingMore = false;
    if (!result || !result.ok) {
      state.error = (result && result.error) || 'Could not load the commit graph.';
      gitGraphPaint(project, state, body);
      return;
    }
    const incoming = result.commits || [];
    state.rawCommits = reset ? incoming : [...(state.rawCommits || []), ...incoming];
    if (result.refs) state.refs = result.refs;
    state.stashes = result.stashes || [];
    state.uncommitted = state.showUncommittedChangesPref !== false ? (result.uncommitted || null) : null;
    state.headHash = (state.rawCommits.find(c => c.isHead) || {}).hash || state.headHash;
    state.headBranchName = ((state.refs && state.refs.heads || []).find(h => h.isHead) || {}).name || null;
    state.hasMore = !!result.hasMore;
    state.skip = state.rawCommits.length;
    gitGraphRecomputeLayout(state);
    // Load More only appends rows and must never disturb the table's scroll
    // position; a fresh load (repo/filter change) naturally lands at the top
    // of a different row set, so only the former asks gitGraphPaint to
    // preserve it.
    gitGraphPaint(project, state, body, { preserveScroll: !reset });
  }).catch((err) => {
    if (request !== state.request) return;
    state.loading = false;
    state.loadingMore = false;
    state.error = err?.message || 'Could not load the commit graph.';
    gitGraphPaint(project, state, body);
  });
}

function gitGraphStillActive(project) {
  return typeof selectedProject === 'function' && selectedProject()?.id === project.id &&
    typeof projectTab === 'function' && projectTab(project) === 'gitgraph';
}

// --- Entry point ---

function renderProjectGitGraphTab(project, body) {
  const state = gitGraphState(project.id);
  const prefs = gitGraphLoadUiPrefs(project.id);
  Object.assign(state, {
    selectedRepo: state.selectedRepo || prefs.selectedRepo || null,
    columns: prefs.columns || state.columns,
    columnWidths: prefs.columnWidths || state.columnWidths,
    branchSelection: prefs.branchSelection || state.branchSelection,
    tagSelection: prefs.tagSelection || state.tagSelection,
    refSort: prefs.refSort || state.refSort,
    showRemoteBranches: prefs.showRemoteBranches !== undefined ? prefs.showRemoteBranches : state.showRemoteBranches,
    fileViewType: prefs.fileViewType || state.fileViewType,
  });
  body.className = 'ws-body gg-tab-body';
  gitGraphBindKeyboard(project, state, body);
  gitGraphEnsureWatcherBound();

  // project.folders can change while this tab isn't the one being painted
  // (e.g. Attach Folder… from the Settings tab) — state.repositories is
  // cached per project id across tab switches, so without this check a
  // newly-attached folder would never appear here until the app restarts.
  const freshPaths = gitGraphRepoList(project).map(r => r.path);
  const cachedPaths = (state.repositories || []).map(r => r.path);
  const repositoriesStale = !!state.repositories && !gitGraphSameStringSet(cachedPaths, freshPaths);

  if (state.repositories && !repositoriesStale) { gitGraphPaint(project, state, body); return; }
  const firstLoad = !state.repositories;
  if (firstLoad) body.innerHTML = '<div class="gg-loading"><span class="gg-loading-dot"></span>Reading repository…</div>';
  gitGraphLoadRepositories(project, state).then(() => {
    if (!body.isConnected || !gitGraphStillActive(project)) return;
    if (!state.repositories.length) { gitGraphPaint(project, state, body); return; }
    if (!firstLoad) {
      // Only the repo list itself was stale — the currently selected repo's
      // own loaded graph is still valid, so just refresh the picker rather
      // than losing the user's place.
      gitGraphPaint(project, state, body);
      return;
    }
    gitGraphLoadGraph(project, state, body, { reset: true });
  });
}

function gitGraphSameStringSet(a, b) {
  if (a.length !== b.length) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  return sa.every((v, i) => v === sb[i]);
}

// --- Painting ---

function gitGraphPaint(project, state, body, opts = {}) {
  const prevWrap = opts.preserveScroll ? body.querySelector('.gg-table-wrap') : null;
  const prevScrollTop = prevWrap ? prevWrap.scrollTop : null;

  const repos = state.repositories || [];
  if (!repos.length) {
    body.innerHTML = '<div class="gg-empty-state"><div class="gg-empty-title">No folders attached</div><div>Attach a repository to this project to see its history here.</div></div>';
    return;
  }
  const repo = repos.find(r => r.path === state.selectedRepo) || repos[0];
  state.selectedRepo = repo.path;

  if (repo.git === false) {
    body.innerHTML = `<div class="gg-tab-shell">${gitGraphRepoPickerHtml(repos, repo)}<div class="gg-empty-state"><div class="gg-empty-title">Not a Git repository</div><div>${escapeHtml(repo.path)}</div></div></div>`;
    gitGraphWireRepoPicker(project, state, body);
    return;
  }

  if (state.error) {
    body.innerHTML = `<div class="gg-tab-shell">${gitGraphRepoPickerHtml(repos, repo)}<div class="gg-error-state"><div class="gg-empty-title">Git Graph could not load this repository</div><div>${escapeHtml(state.error)}</div><button type="button" class="ws-btn" id="gg-retry">Retry</button></div></div>`;
    body.querySelector('#gg-retry').onclick = () => gitGraphLoadGraph(project, state, body, { reset: true });
    gitGraphWireRepoPicker(project, state, body);
    return;
  }

  if (state.loading && !state.rows.length) {
    body.innerHTML = `<div class="gg-tab-shell">${gitGraphRepoPickerHtml(repos, repo)}<div class="gg-loading"><span class="gg-loading-dot"></span>Loading commits…</div></div>`;
    gitGraphWireRepoPicker(project, state, body);
    return;
  }

  body.innerHTML = `
    <div class="gg-tab-shell">
      ${gitGraphRepoPickerHtml(repos, repo)}
      ${gitGraphControlBarHtml(state)}
      ${gitGraphFindWidgetHtml(state)}
      <div class="gg-table-wrap">
        ${gitGraphHeaderHtml(state)}
        <div class="gg-tbody" id="gg-tbody">${gitGraphRowsHtml(state)}</div>
        ${state.hasMore ? '<button type="button" class="gg-load-more" id="gg-load-more">Load More Commits</button>' : ''}
      </div>
    </div>`;

  gitGraphWireRepoPicker(project, state, body);
  gitGraphWireControlBar(project, state, body);
  gitGraphWireFindWidget(project, state, body);
  gitGraphWireHeader(project, state, body);
  gitGraphWireRows(project, state, body);
  if (state.detailsData) {
    // The inline details markup already came back inside #gg-tbody's own
    // innerHTML (gitGraphRowsHtml/gitGraphInlineDetailsHtml), so only the
    // event wiring — not a second render — is needed here.
    const inline = body.querySelector('#gg-details-inline');
    if (inline) { gitGraphWireDetailsPanel(project, state, body, inline); gitGraphMaybeAutoCenterDetails(state, inline); }
  }

  if (prevScrollTop != null) {
    const newWrap = body.querySelector('.gg-table-wrap');
    if (newWrap) newWrap.scrollTop = prevScrollTop;
  }
}

function gitGraphRepoPickerHtml(repos, active) {
  if (repos.length <= 1) return '';
  return `<div class="gg-repo-picker" role="tablist" aria-label="Repositories">${repos.map((r, i) => `<button type="button" class="gg-repo-option ${r.path === active.path ? 'active' : ''}" data-index="${i}" title="${escapeAttr(r.path)}">${escapeHtml(pathBasename(r.path) || r.path)}</button>`).join('')}</div>`;
}

function gitGraphWireRepoPicker(project, state, body) {
  body.querySelectorAll('.gg-repo-option').forEach((btn) => {
    const repo = (state.repositories || [])[Number(btn.dataset.index)];
    if (!repo) return;
    btn.onclick = () => {
      state.selectedRepo = repo.path;
      state.selectedHash = null;
      state.detailsData = null;
      gitGraphSaveUiPrefs(project.id, state);
      gitGraphLoadGraph(project, state, body, { reset: true });
    };
  });
}

// --- Control bar ---

function gitGraphControlBarHtml(state) {
  const branchLabel = !Array.isArray(state.branchSelection) ? 'Show All'
    : state.branchSelection.length
      ? `${state.branchSelection.length} branch${state.branchSelection.length === 1 ? '' : 'es'}`
      : 'None';
  const tagCount = Array.isArray(state.tagSelection) ? state.tagSelection.length : null;
  const tagLabel = tagCount === null ? '' : ` · ${tagCount} tag${tagCount === 1 ? '' : 's'}`;
  return `
    <div class="gg-toolbar">
      <div class="gg-toolbar-left">
        <div class="gg-branches-dropdown">
          <button type="button" class="gg-toolbar-btn" id="gg-branches-btn">${gitGraphIcon('branch', 13)}<span>Branches: ${escapeHtml(branchLabel + tagLabel)}</span>${gitGraphIcon('chevronDown', 10)}</button>
        </div>
        <label class="gg-checkbox"><input type="checkbox" id="gg-show-remote" ${state.showRemoteBranches ? 'checked' : ''}> Show Remote</label>
      </div>
      <div class="gg-toolbar-right">
        <button type="button" class="gg-icon-btn" id="gg-find-btn" title="Find">${gitGraphIcon('search', 14)}</button>
        <button type="button" class="gg-icon-btn ${state.loading ? 'gg-spin' : ''}" id="gg-refresh-btn" title="Refresh">${gitGraphIcon('refresh', 14)}</button>
      </div>
    </div>
    <div class="gg-branches-menu" id="gg-branches-menu" style="display:none"></div>`;
}

function gitGraphWireControlBar(project, state, body) {
  body.querySelector('#gg-show-remote').onchange = (e) => {
    state.showRemoteBranches = e.target.checked;
    gitGraphSaveUiPrefs(project.id, state);
    gitGraphLoadGraph(project, state, body, { reset: true });
  };
  body.querySelector('#gg-find-btn').onclick = () => { state.findOpen = !state.findOpen; gitGraphPaint(project, state, body); };
  body.querySelector('#gg-refresh-btn').onclick = () => gitGraphLoadGraph(project, state, body, { reset: true });
  const branchesBtn = body.querySelector('#gg-branches-btn');
  if (branchesBtn) {
    branchesBtn.onclick = () => gitGraphToggleBranchesMenu(project, state, body, branchesBtn);
    // Picking a branch reloads (and repaints) the graph; keep the menu open across that.
    if (state.branchesMenuOpen) gitGraphOpenBranchesMenu(project, state, body, branchesBtn);
  }
}

function gitGraphCloseBranchesMenu(state) {
  state.branchesMenuOpen = false;
  if (state.branchesMenuCleanup) state.branchesMenuCleanup();
  state.branchesMenuCleanup = null;
}

function gitGraphToggleBranchesMenu(project, state, body, anchor) {
  if (state.branchesMenuOpen) {
    gitGraphCloseBranchesMenu(state);
    const menu = body.querySelector('#gg-branches-menu');
    if (menu) menu.style.display = 'none';
    return;
  }
  gitGraphOpenBranchesMenu(project, state, body, anchor);
}

function gitGraphOpenBranchesMenu(project, state, body, anchor) {
  const menu = body.querySelector('#gg-branches-menu');
  if (!menu) return;
  if (state.branchesMenuCleanup) state.branchesMenuCleanup();
  state.branchesMenuOpen = true;
  const tab = state.branchesMenuTab === 'tags' ? 'tags' : 'branches';
  const selKey = tab === 'tags' ? 'tagSelection' : 'branchSelection';
  let allNames;
  if (tab === 'tags') {
    allNames = (state.refs?.tags || []).map(t => t.name);
  } else {
    const heads = state.refs?.heads || [];
    const remotes = state.showRemoteBranches ? (state.refs?.remotes || []) : [];
    allNames = [...heads.map(h => h.name), ...remotes.map(r => `${r.remote}/${r.name}`)];
  }
  // Natural order, so v1.10 sorts after v1.9.
  const sortDir = state.refSort === 'desc' ? -1 : 1;
  allNames.sort((a, b) => sortDir * a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
  const selection = state[selKey] || 'all';
  const selected = selection === 'all' ? new Set(allNames) : new Set(selection);
  menu.innerHTML = `
    <div class="gg-branches-tabs">
      <button type="button" class="gg-branches-tab ${tab === 'branches' ? 'active' : ''}" data-tab="branches">Branches</button>
      <button type="button" class="gg-branches-tab ${tab === 'tags' ? 'active' : ''}" data-tab="tags">Tags</button>
      <button type="button" class="gg-branches-sort" id="gg-branches-sort" title="${sortDir === 1 ? 'Sorted A to Z — click for Z to A' : 'Sorted Z to A — click for A to Z'}">${sortDir === 1 ? 'A→Z' : 'Z→A'}</button>
    </div>
    <div class="gg-branches-search"><input type="text" id="gg-branches-filter" placeholder="Filter ${tab}…"></div>
    <div class="gg-branches-actions">
      <button type="button" data-act="all">Select All</button>
      <button type="button" data-act="none">Deselect All</button>
      <button type="button" data-act="invert">Invert Selection</button>
    </div>
    <div class="gg-branches-list">${allNames.length ? allNames.map(name => `<label class="gg-branches-row" data-name="${escapeAttr(name)}"><input type="checkbox" data-name="${escapeAttr(name)}" ${selected.has(name) ? 'checked' : ''}> ${escapeHtml(name)}</label>`).join('') : `<div class="gg-empty-row">No ${tab}.</div>`}</div>`;
  menu.style.display = 'block';
  // Fixed to the button so it floats above the graph instead of sitting in the page flow.
  const rect = anchor.getBoundingClientRect();
  menu.style.top = `${rect.bottom + 4}px`;
  menu.style.left = `${rect.left}px`;
  menu.style.maxHeight = `${Math.max(200, window.innerHeight - rect.bottom - 24)}px`;
  const dismiss = (e) => {
    if (e.type === 'keydown' ? e.key !== 'Escape' : (menu.contains(e.target) || anchor.contains(e.target))) return;
    gitGraphCloseBranchesMenu(state);
    menu.style.display = 'none';
  };
  document.addEventListener('pointerdown', dismiss, true);
  document.addEventListener('keydown', dismiss, true);
  state.branchesMenuCleanup = () => {
    document.removeEventListener('pointerdown', dismiss, true);
    document.removeEventListener('keydown', dismiss, true);
  };
  menu.querySelectorAll('.gg-branches-tab').forEach((btn) => {
    btn.onclick = () => { state.branchesMenuTab = btn.dataset.tab; state.branchesFilter = ''; gitGraphOpenBranchesMenu(project, state, body, anchor); };
  });
  menu.querySelector('#gg-branches-sort').onclick = () => {
    state.refSort = sortDir === 1 ? 'desc' : 'asc';
    gitGraphSaveUiPrefs(project.id, state);
    gitGraphOpenBranchesMenu(project, state, body, anchor);
  };
  const filter = menu.querySelector('#gg-branches-filter');
  filter.value = state.branchesFilter || '';
  const applyFilter = () => {
    const q = filter.value.toLowerCase();
    menu.querySelectorAll('.gg-branches-list .gg-branches-row').forEach((row) => {
      row.style.display = row.dataset.name.toLowerCase().includes(q) ? '' : 'none';
    });
  };
  applyFilter();
  const commit = (next) => {
    state[selKey] = next;
    gitGraphSaveUiPrefs(project.id, state);
    gitGraphLoadGraph(project, state, body, { reset: true });
  };
  menu.querySelectorAll('.gg-branches-actions button').forEach((btn) => {
    btn.onclick = () => {
      if (btn.dataset.act === 'all') return commit('all');
      if (btn.dataset.act === 'none') return commit([]);
      const current = state[selKey] === 'all' ? new Set(allNames) : new Set(state[selKey]);
      commit(allNames.filter(name => !current.has(name)));
    };
  });
  menu.querySelectorAll('.gg-branches-list input[type="checkbox"]').forEach((cb) => {
    cb.onchange = () => {
      const current = state[selKey] === 'all' ? new Set(allNames) : new Set(state[selKey]);
      if (cb.checked) current.add(cb.dataset.name); else current.delete(cb.dataset.name);
      commit([...current]);
    };
  });
  filter.oninput = () => { state.branchesFilter = filter.value; applyFilter(); };
}

// --- Table header ---

const GG_COLUMNS = [
  { key: 'graph', label: 'Graph', hideable: false },
  { key: 'description', label: 'Description', hideable: false },
  { key: 'date', label: 'Date', hideable: true },
  { key: 'author', label: 'Author', hideable: true },
  { key: 'commit', label: 'Commit', hideable: true },
];

function gitGraphHeaderHtml(state) {
  const cells = GG_COLUMNS.filter(col => !col.hideable || state.columns[col.key]).map((col) => {
    const width = state.columnWidths[col.key] ? ` style="width:${state.columnWidths[col.key]}px"` : '';
    return `<div class="gg-th" data-col="${col.key}"${width}>${escapeHtml(col.label)}<span class="gg-col-resizer" data-col="${col.key}"></span></div>`;
  }).join('');
  return `<div class="gg-thead" id="gg-thead" data-gg-kind="column-header">${cells}</div>`;
}

function gitGraphWireHeader(project, state, body) {
  const thead = body.querySelector('#gg-thead');
  if (!thead) return;
  thead.oncontextmenu = (e) => {
    e.preventDefault();
    gitGraphOpenContextMenu(project, state, body, thead, { x: e.clientX, y: e.clientY });
  };
  thead.querySelectorAll('.gg-col-resizer').forEach((handle) => {
    handle.onpointerdown = (e) => {
      e.preventDefault();
      const col = handle.dataset.col;
      const cell = handle.closest('.gg-th');
      const startX = e.clientX;
      const startWidth = cell.getBoundingClientRect().width;
      const onMove = (moveEvent) => {
        const next = Math.max(30, startWidth + (moveEvent.clientX - startX));
        cell.style.width = `${next}px`;
        state.columnWidths[col] = next;
        if (col === 'graph') thead.closest('.gg-table-wrap')?.style.setProperty('--gg-graph-width', `${next}px`);
      };
      const onUp = () => {
        document.removeEventListener('pointermove', onMove);
        document.removeEventListener('pointerup', onUp);
        gitGraphSaveUiPrefs(project.id, state);
      };
      document.addEventListener('pointermove', onMove);
      document.addEventListener('pointerup', onUp);
    };
  });
}

// --- Rows ---

function gitGraphRowsHtml(state) {
  if (!state.rows.length) return '<div class="gg-empty-row">No commits yet.</div>';
  const showCols = { date: state.columns.date, author: state.columns.author, commit: state.columns.commit };
  return state.rows.map((row, index) => gitGraphRowHtml(row, state, showCols, index)).join('') +
    (state.detailsData ? gitGraphInlineDetailsHtml(state) : '');
}

function gitGraphRowHtml(row, state, showCols, index) {
  const kind = row.kind === 'uncommitted' ? 'uncommitted' : (row.kind === 'stash' ? 'stash' : 'commit');
  const selected = row.hash === state.selectedHash || row.hash === state.compareHash;
  const classes = gitGraphRowClasses({ ...row, selected }, state);
  const dateValue = state.dateType === 'commit' ? row.commitDate : row.authorDate;
  const dateText = kind === 'uncommitted' ? gitGraphFormatDate(new Date().toISOString(), state.dateFormat) : gitGraphFormatDate(dateValue, state.dateFormat);
  const authorText = kind === 'uncommitted' ? '*' : escapeHtml(row.authorName || '');
  const commitText = kind === 'uncommitted' ? '*' : escapeHtml(row.shortHash || (row.hash || '').slice(0, 8));
  const pills = kind === 'commit' || kind === 'stash' ? gitGraphRenderRefPills(row, { combineLocalAndRemote: state.combineLocalAndRemote, headBranchName: state.headBranchName }) : '';
  const stashBadge = kind === 'stash' ? `<span class="gg-stash-badge" data-gg-kind="stash" title="Stash">stash@{${row.stashIndex}}</span>` : '';
  return `
    <div class="${classes}" data-gg-kind="${kind}" data-gg-hash="${escapeAttr(row.hash)}" data-row-index="${index}">
      <div class="gg-cell gg-cell-graph"></div>
      <div class="gg-cell gg-cell-description">${pills}${stashBadge}<span class="gg-subject">${escapeHtml(row.subject || '')}</span></div>
      ${showCols.date ? `<div class="gg-cell gg-cell-date">${escapeHtml(dateText)}</div>` : ''}
      ${showCols.author ? `<div class="gg-cell gg-cell-author">${authorText}</div>` : ''}
      ${showCols.commit ? `<div class="gg-cell gg-cell-commit mono">${commitText}</div>` : ''}
    </div>`;
}

function gitGraphWireRows(project, state, body) {
  const tbody = body.querySelector('#gg-tbody');
  if (!tbody) return;
  const graphColumns = tbody.querySelectorAll('.gg-cell-graph');
  if (graphColumns.length) {
    // One <svg> for the whole loaded window, absolutely positioned over
    // .gg-tbody (already `position: relative`) so it lines up with every
    // row's graph cell at once — each individual .gg-cell-graph stays an
    // empty placeholder that only reserves the column's width. Building a
    // second, separately-clipped copy of the full svg's markup per row
    // (every row repeating every other row's paths/circles) was O(rows²)
    // DOM nodes; this is O(rows).
    const rowY = [];
    tbody.querySelectorAll('.gg-row[data-row-index]').forEach((el) => {
      rowY[Number(el.dataset.rowIndex)] = el.offsetTop + el.offsetHeight / 2;
    });
    const measured = rowY.length === state.rows.length && rowY.some(y => y > 0);
    const svg = gitGraphRenderGraphSvg(state.rows, state.layout, {
      style: state.graphStyle, uncommittedChangesStyle: state.uncommittedChangesStyle,
      rowY: measured ? rowY : null, height: measured ? tbody.scrollHeight : null,
    });
    const clip = document.createElement('div');
    clip.className = 'gg-graph-clip'; // decorative only — clicks/right-clicks fall through to the row underneath
    clip.innerHTML = svg;
    const svgEl = clip.firstChild;
    clip.style.height = `${svgEl.getAttribute('height')}px`;
    // The column fits the graph unless the user has resized it; either way the
    // clip keeps the lanes from ever drawing over the description text.
    const graphWidth = state.columnWidths.graph || Math.max(60, Number(svgEl.getAttribute('width')) + 6);
    body.querySelector('.gg-table-wrap')?.style.setProperty('--gg-graph-width', `${graphWidth}px`);
    tbody.insertBefore(clip, tbody.firstChild);
  }

  tbody.querySelectorAll('[data-gg-kind]').forEach((el) => {
    // Every ref pill/stash badge nested inside a row also carries its own
    // data-gg-kind, so this same querySelectorAll matches both a pill and
    // its enclosing row. Without stopPropagation, a click/right-click on the
    // pill would fire its own handler and then bubble to the row's.
    el.onclick = (e) => { e.stopPropagation(); gitGraphHandleRowClick(project, state, body, el, e); };
    el.oncontextmenu = (e) => {
      e.preventDefault();
      e.stopPropagation();
      gitGraphOpenContextMenu(project, state, body, el, { x: e.clientX, y: e.clientY });
    };
    el.onmouseenter = () => gitGraphShowTooltip(el, state);
  });

  const loadMoreBtn = body.querySelector('#gg-load-more');
  if (loadMoreBtn) loadMoreBtn.onclick = () => gitGraphLoadGraph(project, state, body, { reset: false });
  gitGraphBindScrollAutoLoad(project, state, body);
}

function gitGraphBindScrollAutoLoad(project, state, body) {
  const wrap = body.querySelector('.gg-table-wrap');
  if (!wrap) return;
  wrap.onscroll = () => {
    if (state.loadingMore || !state.hasMore) return;
    if (wrap.scrollTop + wrap.clientHeight >= wrap.scrollHeight - 80) {
      gitGraphLoadGraph(project, state, body, { reset: false });
    }
  };
}

/**
 * Whether `ancestorHash` is a (possibly indirect) parent of `descendantHash`,
 * walking `.parents` through whichever commits are currently loaded — the
 * only history available client-side. A pseudo-row (Uncommitted, a stash)
 * has its own single-parent link into the real graph, so it walks the same
 * way as any real commit.
 */
function gitGraphIsAncestor(rows, ancestorHash, descendantHash) {
  const byHash = new Map((rows || []).map(r => [r.hash, r]));
  const seen = new Set();
  const stack = [descendantHash];
  while (stack.length) {
    const current = stack.pop();
    if (seen.has(current)) continue;
    seen.add(current);
    const row = byHash.get(current);
    if (!row) continue;
    for (const parentHash of row.parents || []) {
      if (parentHash === ancestorHash) return true;
      stack.push(parentHash);
    }
  }
  return false;
}

function gitGraphHandleRowClick(project, state, body, el, event) {
  const hash = el.dataset.ggHash;
  if (!hash) return;
  const row = state.rows.find(r => r.hash === hash);
  if (event.ctrlKey || event.metaKey) {
    if (state.selectedHash && state.selectedHash !== hash) {
      const first = state.selectedHash, second = hash;
      // Order-independent: the comparison always reads from whichever side
      // is actually the ancestor toward the descendant. Click order only
      // decides it when neither is reachable from the other within the
      // loaded window (e.g. unrelated histories) — the default below.
      let fromHash = first, toHash = second;
      if (gitGraphIsAncestor(state.rows, second, first)) { fromHash = second; toHash = first; }
      state.compareHash = hash;
      gitGraphOpenComparison(project, state, body, fromHash, toHash);
      return;
    }
  }
  state.selectedHash = hash;
  state.compareHash = null;
  gitGraphOpenDetails(project, state, body, row);
}

function gitGraphShowTooltip(el, state) {
  const hash = el.dataset.ggHash;
  const row = state.rows.find(r => r.hash === hash);
  if (!row) return;
  el.title = row.isHead ? 'HEAD — the currently checked-out commit' : (row.subject || '');
}

// --- Commit Details / Comparison ---

function gitGraphOpenDetails(project, state, body, row) {
  if (!row) return;
  const repo = (state.repositories || []).find(r => r.path === state.selectedRepo);
  const request = ++state.detailsRequest;
  state.detailsLoading = true;
  state.detailsData = { mode: 'single', hash: row.hash, kind: row.kind };
  state.detailsJustOpened = true;
  gitGraphPaint(project, state, body);
  const fetch = row.kind === 'uncommitted'
    ? gitGraphApi('getGitGraphCompareDetail', project.id, repo.path, state.headHash, null)
    : gitGraphApi('getGitGraphCommitDetail', project.id, repo.path, row.hash);
  fetch.then((result) => {
    if (request !== state.detailsRequest) return;
    state.detailsLoading = false;
    if (result && result.ok) {
      state.detailsData = { mode: 'single', hash: row.hash, kind: row.kind, commit: result.commit, files: result.files || [] };
    } else {
      state.detailsData = { mode: 'single', hash: row.hash, kind: row.kind, error: (result && result.error) || 'Could not load commit details.' };
    }
    gitGraphPaint(project, state, body);
  });
}

function gitGraphOpenComparison(project, state, body, fromHash, toHash) {
  const repo = (state.repositories || []).find(r => r.path === state.selectedRepo);
  const request = ++state.detailsRequest;
  state.detailsLoading = true;
  state.detailsData = { mode: 'compare', fromHash, toHash };
  state.detailsJustOpened = true;
  gitGraphPaint(project, state, body);
  const toArg = toHash === '#uncommitted' ? null : toHash;
  gitGraphApi('getGitGraphCompareDetail', project.id, repo.path, fromHash === '#uncommitted' ? toHash : fromHash, fromHash === '#uncommitted' ? null : toArg)
    .then((result) => {
      if (request !== state.detailsRequest) return;
      state.detailsLoading = false;
      if (result && result.ok) state.detailsData = { mode: 'compare', fromHash, toHash, files: result.files || [] };
      else state.detailsData = { mode: 'compare', fromHash, toHash, error: (result && result.error) || 'Could not load comparison.' };
      gitGraphPaint(project, state, body);
    });
}

function gitGraphInlineDetailsHtml(state) {
  return `<div class="gg-details gg-details-inline" id="gg-details-inline">${gitGraphDetailsBodyHtml(state)}</div>`;
}

function gitGraphRenderDetailsPanel(project, state, body) {
  const container = body.querySelector('#gg-details-inline');
  if (!container) return;
  container.innerHTML = gitGraphDetailsBodyHtml(state);
  gitGraphWireDetailsPanel(project, state, body, container);
}

/** Scrolls the panel into view exactly once per open — the moment it opens,
 * not on every subsequent repaint of an already-open panel.
 * `state.detailsJustOpened` is set by gitGraphOpenDetails/OpenComparison and
 * cleared the first time this runs *with the real content loaded*. The
 * request's first paint (still `detailsLoading`) shows only the tiny
 * "Loading…" placeholder, so centering on it would land short of where the
 * eventual, much taller panel actually ends up — wait for the repaint that
 * carries the real commit/diff content before centering and clearing it. */
function gitGraphMaybeAutoCenterDetails(state, container) {
  if (!state.detailsJustOpened || state.detailsLoading) return;
  state.detailsJustOpened = false;
  if (container && typeof container.scrollIntoView === 'function') container.scrollIntoView({ block: 'center' });
}

function gitGraphDetailsBodyHtml(state) {
  const data = state.detailsData;
  if (!data) return '';
  if (state.detailsLoading) return '<div class="gg-loading"><span class="gg-loading-dot"></span>Loading…</div>';
  if (data.error) return `<div class="gg-error-state">${escapeHtml(data.error)}</div>`;
  const header = data.mode === 'compare'
    ? `<div class="gg-details-header">Displaying all changes from <span class="mono">${escapeHtml((data.fromHash || '').replace('#uncommitted', 'the working tree'))}</span> to <span class="mono">${escapeHtml((data.toHash || '').replace('#uncommitted', 'the working tree'))}</span>.</div>`
    : gitGraphSingleCommitHeaderHtml(data.commit, data.kind);
  const files = data.files || [];
  return `
    <button type="button" class="gg-details-close" id="gg-details-close">×</button>
    <div class="gg-details-grid">
      <div class="gg-details-text">${header}</div>
      <div class="gg-details-files">
        <div class="pane-seg gg-file-view-toggle" role="group" aria-label="File view">
          <button type="button" class="pane-seg-btn${state.fileViewType !== 'list' ? ' on' : ''}" data-view="tree" aria-pressed="${state.fileViewType !== 'list'}">Tree</button>
          <button type="button" class="pane-seg-btn${state.fileViewType === 'list' ? ' on' : ''}" data-view="list" aria-pressed="${state.fileViewType === 'list'}">List</button>
        </div>
        ${gitGraphFileListHtml(files, { fileViewType: state.fileViewType, collapsedFolders: state.collapsedFolders })}
      </div>
    </div>`;
}

function gitGraphSingleCommitHeaderHtml(commit, kind) {
  if (kind === 'uncommitted' || !commit) return '<div class="gg-details-header">Working tree changes</div>';
  const parentsHtml = (commit.parents || []).map(p => `<a class="gg-link mono" data-gg-kind="link" data-gg-hash="${escapeAttr(p)}" href="#">${escapeHtml(p)}</a>`).join(', ') || 'none (root commit)';
  const authorDate = gitGraphFormatFullDate(commit.authorDate);
  const commitDate = gitGraphFormatFullDate(commit.commitDate);
  const bothDates = commit.authorDate !== commit.commitDate;
  return `
    <div class="gg-detail-field"><span class="gg-detail-label">Commit:</span> <span class="mono">${escapeHtml(commit.hash)}</span></div>
    <div class="gg-detail-field"><span class="gg-detail-label">Subject:</span> ${escapeHtml(commit.subject || '')}</div>
    <div class="gg-detail-field"><span class="gg-detail-label">Parents:</span> ${parentsHtml}</div>
    <div class="gg-detail-field"><span class="gg-detail-label">Author:</span> ${escapeHtml(commit.authorName)} &lt;<a class="gg-link" href="mailto:${escapeAttr(commit.authorEmail)}">${escapeHtml(commit.authorEmail)}</a>&gt;</div>
    <div class="gg-detail-field"><span class="gg-detail-label">Date:</span> ${escapeHtml(authorDate)}${bothDates ? ` <span class="gg-detail-secondary">(committed ${escapeHtml(commitDate)})</span>` : ''}</div>
    <div class="gg-detail-field"><span class="gg-detail-label">Committer:</span> ${escapeHtml(commit.committerName)}</div>
    <div class="gg-detail-body">${gitGraphLinkifyBody(commit.body || '')}</div>`;
}

function gitGraphLinkifyBody(body) {
  const escaped = escapeHtml(body);
  return escaped
    .replace(/\n/g, '<br>')
    // Excludes '"'/"'" from the match itself (on top of the '<' escapeHtml
    // already turned into an entity): a commit body is attacker-controlled
    // text, and without this a quote character could close the href
    // attribute early and start a new, live one right where the match ends.
    // The matched text has already been through escapeHtml above, so once
    // quotes can't appear in it, it's already fully safe to drop straight
    // into this attribute.
    .replace(/https?:\/\/[^\s<>"']+/g, (url) => `<a class="gg-link" data-gg-kind="link" href="${url}" target="_blank" rel="noopener">${url}</a>`);
}

// --- Commit-details file list: reuses #98's tree builder (buildGitChangeTree/
// gitTreeRows from project-git-view.js) instead of a second tree implementation. ---

function gitGraphFileListHtml(files, opts) {
  if (!files.length) return '<div class="gg-empty-row">No files changed.</div>';
  if (opts.fileViewType === 'list') {
    return `<div class="gg-file-flat-list">${files.map(f => gitGraphFileRowHtml(f, { name: f.path })).join('')}</div>`;
  }
  const tree = buildGitChangeTree(files);
  const rows = gitTreeRows(tree, opts.collapsedFolders, '');
  return `<div class="gg-file-tree">${rows.map(row => row.kind === 'folder'
    ? gitGraphFolderRowHtml(row)
    : gitGraphFileRowHtml(row.change, { name: row.name, depth: row.depth })).join('')}</div>`;
}

function gitGraphFolderRowHtml(row) {
  return `
    <button type="button" class="gg-tree-folder" data-gg-folder-key="${escapeAttr(row.key)}" style="--depth:${row.depth}">
      <span class="gg-tree-folder-chevron">${gitGraphIcon(row.collapsed ? 'chevronRight' : 'chevronDown', 11)}</span>
      ${gitGraphIcon('folder', 12)}
      <span class="gg-tree-folder-name mono">${escapeHtml(row.name)}</span>
      ${row.count ? `<span class="gg-tree-folder-count">${row.count}</span>` : ''}
    </button>`;
}

function gitGraphFileRowHtml(file, opts = {}) {
  const depth = opts.depth || 0;
  return `
    <div class="gg-file-row" data-gg-kind="file" data-gg-file-path="${escapeAttr(file.path)}" style="--depth:${depth}">
      <span class="gg-file-status gg-file-status-${escapeAttr(file.status)}">${escapeHtml(gitGraphStatusBadge(file.status))}</span>
      <span class="gg-file-name mono">${escapeHtml(opts.name || file.path)}</span>
      ${gitGraphDiffStatHtml(file)}
    </div>`;
}

function gitGraphWireDetailsPanel(project, state, body, container) {
  const closeBtn = container.querySelector('#gg-details-close');
  if (closeBtn) closeBtn.onclick = () => gitGraphCloseDetails(project, state, body);
  container.querySelectorAll('[data-view]').forEach((btn) => {
    btn.onclick = () => {
      state.fileViewType = btn.dataset.view;
      gitGraphSaveUiPrefs(project.id, state);
      gitGraphRenderDetailsPanel(project, state, body);
    };
  });
  container.querySelectorAll('.gg-tree-folder').forEach((btn) => {
    btn.onclick = () => {
      const key = btn.dataset.ggFolderKey;
      if (state.collapsedFolders.has(key)) state.collapsedFolders.delete(key); else state.collapsedFolders.add(key);
      gitGraphRenderDetailsPanel(project, state, body);
    };
  });
  const repo = (state.repositories || []).find(r => r.path === state.selectedRepo);
  container.querySelectorAll('[data-gg-kind="file"]').forEach((row) => {
    row.onclick = () => gitGraphOpenFileDiff(project, state, body, repo, row.dataset.ggFilePath);
    row.oncontextmenu = (e) => {
      e.preventDefault();
      gitGraphOpenContextMenu(project, state, body, row, { x: e.clientX, y: e.clientY });
    };
  });
  container.querySelectorAll('[data-gg-kind="link"][data-gg-hash]').forEach((link) => {
    link.onclick = (e) => {
      e.preventDefault();
      const target = state.rows.find(r => r.hash === link.dataset.ggHash);
      if (target) { state.selectedHash = target.hash; gitGraphOpenDetails(project, state, body, target); }
    };
  });
}

function gitGraphCloseDetails(project, state, body) {
  state.detailsData = null;
  state.selectedHash = null;
  state.compareHash = null;
  gitGraphPaint(project, state, body);
}

function gitGraphOpenFileDiff(project, state, body, repo, filePath, opts = {}) {
  if (!repo || !filePath || typeof createUnifiedMergeViewer !== 'function') return;
  const data = state.detailsData;
  const fromRev = data.mode === 'compare' ? (data.fromHash === '#uncommitted' ? null : data.fromHash) : `${data.hash}^`;
  const toRev = opts.forceWorkingTree ? null : (data.mode === 'compare' ? (data.toHash === '#uncommitted' ? null : data.toHash) : (data.kind === 'uncommitted' ? null : data.hash));
  gitGraphApi('getGitGraphFileDiffBetween', project.id, repo.path, fromRev, toRev, filePath).then((result) => {
    if (!result || !result.ok) return;
    const host = gitGraphEnsureDiffHost();
    host.innerHTML = '';
    createUnifiedMergeViewer(host, result.oldContent || '', result.newContent || '', filePath, { readOnly: true });
  });
}

/** "View File at this Revision" (file-menu item) — read-only single-pane view of the blob. */
function gitGraphViewFileAtRevision(project, state, body, repo, file) {
  const data = state.detailsData || {};
  const rev = data.mode === 'single' ? data.hash : data.toHash;
  if (!repo || !rev || rev === '#uncommitted') return;
  gitGraphApi('getGitGraphFileAtRevision', project.id, repo.path, rev, file.path).then((result) => {
    if (!result || !result.ok) return;
    const host = gitGraphEnsureDiffHost();
    host.innerHTML = '';
    if (typeof createReadOnlyViewer === 'function') createReadOnlyViewer(host, result.content || '', file.path);
    else if (typeof createUnifiedMergeViewer === 'function') createUnifiedMergeViewer(host, result.content || '', result.content || '', file.path, { readOnly: true });
  });
}

/** Returns the *content* element for the diff/file overlay — the close
 * button lives on its permanent sibling, so callers are free to reset this
 * div's innerHTML on every open without wiping the close affordance out. */
function gitGraphEnsureDiffHost() {
  let host = document.getElementById('gg-diff-host');
  if (!host) {
    host = document.createElement('div');
    host.id = 'gg-diff-host';
    host.className = 'gg-diff-host';
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'gg-details-close';
    close.textContent = '×';
    close.onclick = () => gitGraphCloseDiffHost();
    const content = document.createElement('div');
    content.className = 'gg-diff-host-content';
    host.appendChild(close);
    host.appendChild(content);
    document.body.appendChild(host);
  }
  return host.querySelector('.gg-diff-host-content');
}

function gitGraphCloseDiffHost() {
  const host = document.getElementById('gg-diff-host');
  if (host) host.remove();
}

// --- Find widget ---

function gitGraphFindWidgetHtml(state) {
  if (!state.findOpen) return '';
  return `
    <div class="gg-find-widget">
      <input type="text" id="gg-find-input" placeholder="Find in loaded commits…" value="${escapeAttr(state.findQuery)}">
      <span class="gg-find-count">${state.findMatches.length ? `${state.findIndex + 1}/${state.findMatches.length}` : '0/0'}</span>
      <button type="button" id="gg-find-prev">‹</button>
      <button type="button" id="gg-find-next">›</button>
      <label class="gg-checkbox"><input type="checkbox" id="gg-find-case" ${state.findCaseSensitive ? 'checked' : ''}>Case</label>
      <label class="gg-checkbox"><input type="checkbox" id="gg-find-open-details" ${state.findAlsoOpenDetails ? 'checked' : ''}>Also open details</label>
      <button type="button" id="gg-find-close">×</button>
    </div>`;
}

function gitGraphWireFindWidget(project, state, body) {
  const input = body.querySelector('#gg-find-input');
  if (!input) return;
  const run = () => {
    state.findMatches = gitGraphFindMatches(state.rows, input.value, state.findCaseSensitive);
    state.findIndex = state.findMatches.length ? 0 : -1;
    state.findQuery = input.value;
    gitGraphApplyFindHighlight(project, state, body);
  };
  input.oninput = run;
  input.focus();
  body.querySelector('#gg-find-case').onchange = (e) => { state.findCaseSensitive = e.target.checked; run(); };
  body.querySelector('#gg-find-open-details').onchange = (e) => { state.findAlsoOpenDetails = e.target.checked; };
  body.querySelector('#gg-find-next').onclick = () => gitGraphFindStep(project, state, body, 1);
  body.querySelector('#gg-find-prev').onclick = () => gitGraphFindStep(project, state, body, -1);
  body.querySelector('#gg-find-close').onclick = () => { state.findOpen = false; gitGraphPaint(project, state, body); };
  input.onkeydown = (e) => {
    if (e.key === 'Enter') { e.preventDefault(); gitGraphFindStep(project, state, body, e.shiftKey ? -1 : 1); }
  };
}

function gitGraphFindStep(project, state, body, dir) {
  if (!state.findMatches.length) return;
  state.findIndex = (state.findIndex + dir + state.findMatches.length) % state.findMatches.length;
  gitGraphApplyFindHighlight(project, state, body);
}

function gitGraphApplyFindHighlight(project, state, body) {
  const countEl = body.querySelector('.gg-find-count');
  if (countEl) countEl.textContent = state.findMatches.length ? `${state.findIndex + 1}/${state.findMatches.length}` : '0/0';
  body.querySelectorAll('.gg-tbody [data-gg-kind]').forEach(el => el.classList.remove('gg-find-match', 'gg-find-current'));
  state.findMatches.forEach((rowIndex, i) => {
    const el = body.querySelector(`.gg-tbody [data-row-index="${rowIndex}"]`);
    if (!el) return;
    el.classList.add('gg-find-match');
    if (i === state.findIndex) {
      el.classList.add('gg-find-current');
      el.scrollIntoView({ block: 'nearest' });
      if (state.findAlsoOpenDetails) {
        const row = state.rows[rowIndex];
        state.selectedHash = row.hash;
        gitGraphOpenDetails(project, state, body, row);
      }
    }
  });
}

// --- Keyboard shortcuts ---
//
// Deliberately avoids Cmd/Ctrl+Up/Down (already the app's shortcut for
// switching sessions) and Cmd/Ctrl+R (taken by the app for reload, so the
// Refresh button carries no shortcut hint) — plain Up/Down instead moves
// between commits when the details panel is open, Shift+Up/Down crosses to
// the other side of a fork/merge.

function gitGraphBindKeyboard(project, state, body) {
  if (state.keydownHandler) document.removeEventListener('keydown', state.keydownHandler);
  const handler = (e) => {
    if (!gitGraphStillActive(project) || !body.isConnected) return;
    if (gitGraphIsEditableTarget(e.target) && e.key !== 'Escape') return;
    const mod = e.ctrlKey || e.metaKey;
    if (e.key === 'Escape') {
      if (document.getElementById('gg-diff-host')) { gitGraphCloseDiffHost(); e.preventDefault(); return; }
      const closed = gitGraphHandleEscapePriority({
        closeMenu: () => (state.branchesMenuOpen ? (gitGraphCloseBranchesMenu(state), gitGraphPaint(project, state, body), true) : false),
        closeDetails: () => { if (state.detailsData) { gitGraphCloseDetails(project, state, body); return true; } return false; },
        closeFind: () => { if (state.findOpen) { state.findOpen = false; gitGraphPaint(project, state, body); return true; } return false; },
      });
      if (closed) e.preventDefault();
      return;
    }
    if (mod && (e.key === 'f' || e.key === 'F')) { e.preventDefault(); state.findOpen = true; gitGraphPaint(project, state, body); }
    else if (!mod && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      const dir = e.key === 'ArrowDown' ? 1 : -1; // Down toward parents/older, Up toward children/newer
      if (!state.detailsData) {
        const wrap = body.querySelector('.gg-table-wrap');
        if (wrap) wrap.scrollTop += dir * GG_ROW_HEIGHT;
        return;
      }
      e.preventDefault();
      gitGraphMoveDetailsFocus(project, state, body, dir, e.shiftKey ? 'alternate' : 'sameBranch');
    }
  };
  state.keydownHandler = handler;
  document.addEventListener('keydown', handler);
}

/**
 * Same-branch parent/child of `hash`, via the loaded graph's own layout
 * edges rather than a fresh git query — `dir > 0` walks toward the parent
 * (the row's own 'same-lane' outgoing edge), `dir < 0` toward the child (an
 * earlier row whose 'same-lane' edge points back at this hash). Returns null
 * at a fork/merge with no plain same-lane edge in that direction, or when
 * `hash` isn't in the currently loaded window.
 */
function gitGraphSameBranchNeighbor(state, hash, dir) {
  const index = state.rows.findIndex(r => r.hash === hash);
  if (index < 0) return null;
  if (dir > 0) {
    const edge = (state.layout[index] && state.layout[index].edges || []).find(e => e.style === 'same-lane');
    return edge ? edge.parentHash : null;
  }
  for (let i = index - 1; i >= 0; i--) {
    const hasEdge = (state.layout[i] && state.layout[i].edges || []).some(e => e.style === 'same-lane' && e.parentHash === hash);
    if (hasEdge) return state.rows[i].hash;
  }
  return null;
}

/**
 * The *other* branch at a fork/merge touching `hash` — a 'branch-out' or
 * 'merge-in' edge instead of the plain 'same-lane' one gitGraphSameBranchNeighbor
 * follows. Same direction convention: `dir > 0` toward a parent, `dir < 0`
 * toward a child.
 */
function gitGraphAlternateBranchNeighbor(state, hash, dir) {
  const index = state.rows.findIndex(r => r.hash === hash);
  if (index < 0) return null;
  if (dir > 0) {
    const edge = (state.layout[index] && state.layout[index].edges || []).find(e => e.style !== 'same-lane');
    return edge ? edge.parentHash : null;
  }
  for (let i = index - 1; i >= 0; i--) {
    const hasEdge = (state.layout[i] && state.layout[i].edges || []).some(e => e.style !== 'same-lane' && e.parentHash === hash);
    if (hasEdge) return state.rows[i].hash;
  }
  return null;
}

/**
 * Moves the Commit Details/Comparison focus in response to an arrow key.
 * `sameBranch` follows gitGraphSameBranchNeighbor; `alternate` follows
 * gitGraphAlternateBranchNeighbor (the fork/merge's other side). Silently
 * does nothing when there's no current row or no neighbor in that direction.
 */
function gitGraphMoveDetailsFocus(project, state, body, dir, mode) {
  if (!state.selectedHash) return;
  const targetHash = mode === 'alternate'
    ? gitGraphAlternateBranchNeighbor(state, state.selectedHash, dir)
    : gitGraphSameBranchNeighbor(state, state.selectedHash, dir);
  if (!targetHash) return;
  const row = state.rows.find(r => r.hash === targetHash);
  if (!row) return;
  state.selectedHash = targetHash;
  state.compareHash = null;
  gitGraphOpenDetails(project, state, body, row);
}

// --- Auto-refresh on repo change ---
//
// Bound exactly once at module load (not per render, not per project): the
// #ws-body element this tab paints into is recreated by renderOverview() on
// every tab switch, so a handler that closed over a particular `body`/
// `project` would silently stop firing the moment the user left and came
// back to this tab. Resolving the active project/state/body fresh, at event
// time, means one listener stays correct across the whole session.

let gitGraphWatcherBound = false;

function gitGraphEnsureWatcherBound() {
  if (gitGraphWatcherBound) return;
  gitGraphWatcherBound = true;
  if (typeof window === 'undefined' || typeof window.api?.onGitGraphRepoChanged !== 'function') return;
  window.api.onGitGraphRepoChanged((folderPath) => {
    const project = typeof selectedProject === 'function' ? selectedProject() : null;
    if (!project || !gitGraphStillActive(project)) return;
    const state = gitGraphTabState.get(project.id);
    if (!state || state.selectedRepo !== folderPath) return;
    const body = typeof document !== 'undefined' ? document.getElementById('ws-body') : null;
    if (!body) return;
    gitGraphLoadGraph(project, state, body, { reset: true });
  });
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    gitGraphState, gitGraphFindMatches, gitGraphHandleEscapePriority,
    gitGraphBuildFileCtx, gitGraphPopulateTargetField, gitGraphBuildMenuCtx, gitGraphOpenContextMenu,
    gitGraphLoadGraph, gitGraphLoadRepositories, gitGraphPaint, gitGraphApi, renderProjectGitGraphTab,
    gitGraphSingleCommitHeaderHtml, gitGraphLinkifyBody, gitGraphFileRowHtml, gitGraphFileListHtml,
    gitGraphOpenDetails, gitGraphOpenComparison, gitGraphCloseDetails,
    gitGraphMaybeAutoCenterDetails, gitGraphIsAncestor, gitGraphHandleRowClick, gitGraphBindKeyboard,
    gitGraphSameBranchNeighbor, gitGraphAlternateBranchNeighbor, gitGraphMoveDetailsFocus,
    gitGraphSameStringSet, gitGraphRepoList, gitGraphEnsureWatcherBound,
  };
}
