// Read-only Git tab for a project. Repositories are the folders attached to
// the project; all commands run in main and the renderer only receives data.

const projectGitTabState = new Map();

// 'list' or 'tree'; one preference for every project, like DIFF_MODE_KEY.
const GIT_CHANGES_VIEW_KEY = 'gitChangesView';

function gitChangesViewMode() {
  let stored = null;
  try { stored = localStorage.getItem(GIT_CHANGES_VIEW_KEY); } catch {}
  return stored === 'tree' ? 'tree' : 'list';
}

function setGitChangesViewMode(mode) {
  try { localStorage.setItem(GIT_CHANGES_VIEW_KEY, mode); } catch {}
}

function gitTabState(projectId) {
  if (!projectGitTabState.has(projectId)) {
    projectGitTabState.set(projectId, {
      repositories: null,
      selectedRepo: null,
      selectedFiles: new Map(),
      diffs: new Map(),
      collapsedFolders: new Map(), // repo path -> Set of collapsed tree folder keys
      request: 0,
      error: '',
    });
  }
  return projectGitTabState.get(projectId);
}

function gitCollapsedSet(state, repoPath) {
  if (!state.collapsedFolders.has(repoPath)) state.collapsedFolders.set(repoPath, new Set());
  return state.collapsedFolders.get(repoPath);
}

function gitRepoName(repo) {
  return pathBasename(repo.path) || repo.path;
}

function gitRelativeTime(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : formatDate(date);
}

function gitSyncText(repo) {
  if (repo.ahead === null || repo.behind === null) return 'No upstream';
  if (!repo.ahead && !repo.behind) return 'Up to date';
  const parts = [];
  if (repo.ahead) parts.push(`${repo.ahead} ahead`);
  if (repo.behind) parts.push(`${repo.behind} behind`);
  return parts.join(' · ');
}

function gitChangeMeta(change) {
  if (change.status === 'untracked') return 'Untracked';
  if (change.status === 'conflicted') return 'Conflicted';
  const inIndex = change.indexStatus !== ' ' && change.indexStatus !== '?';
  const inWorktree = change.worktreeStatus !== ' ' && change.worktreeStatus !== '?';
  if (inIndex && inWorktree) return 'Staged + unstaged';
  return inIndex ? 'Staged' : 'Unstaged';
}

function gitChangeCode(change) {
  return {
    conflicted: '!',
    untracked: '?',
    added: 'A',
    deleted: 'D',
    renamed: 'R',
    modified: 'M',
  }[change.status] || 'M';
}

function gitWarningHtml(repo) {
  const warnings = [];
  const conflicts = repo.changes.filter(change => change.status === 'conflicted').length;
  if (repo.operation) warnings.push(`${repo.operation[0].toUpperCase()}${repo.operation.slice(1)} in progress`);
  if (conflicts) warnings.push(`${conflicts} conflicted file${conflicts === 1 ? '' : 's'}`);
  if (repo.detached) warnings.push(`Detached at ${repo.head || 'HEAD'}`);
  if (!warnings.length) return '';
  return `<div class="git-alert">${escapeHtml(warnings.join(' · '))}</div>`;
}

function gitOverviewHtml(repo) {
  const latest = repo.commits[0];
  const changed = repo.changes.length;
  const statParts = [];
  if (repo.stats.insertions) statParts.push(`<span class="git-plus">+${repo.stats.insertions}</span>`);
  if (repo.stats.deletions) statParts.push(`<span class="git-minus">−${repo.stats.deletions}</span>`);
  return `
    ${gitWarningHtml(repo)}
    <section class="git-summary">
      <div class="git-summary-top">
        <span class="git-branch">${PICONS.branch(14)}<span>${escapeHtml(repo.detached ? (repo.head || 'Detached HEAD') : (repo.branch || 'Unknown branch'))}</span></span>
        <span class="git-clean-state ${changed ? 'changed' : 'clean'}">${changed ? `${changed} changed file${changed === 1 ? '' : 's'}` : 'Clean'}</span>
      </div>
      <div class="git-summary-meta">
        <span>${escapeHtml(gitSyncText(repo))}</span>
        ${statParts.length ? `<span class="git-stat">${statParts.join(' ')}</span>` : ''}
      </div>
      <div class="git-latest">
        <span class="git-kicker">Latest commit</span>
        ${latest
          ? `<span class="git-latest-subject">${escapeHtml(latest.subject)}</span><span class="git-latest-meta"><span class="mono">${escapeHtml(latest.shortHash)}</span> · ${escapeHtml(latest.author)} · ${escapeHtml(gitRelativeTime(latest.date))}</span>`
          : '<span class="git-empty-inline">No commits yet</span>'}
      </div>
    </section>`;
}

function gitDiffLines(diff) {
  return String(diff || '').split('\n').map((line) => {
    let cls = '';
    if (line.startsWith('@@')) cls = ' hunk';
    else if (line.startsWith('+') && !line.startsWith('+++')) cls = ' add';
    else if (line.startsWith('-') && !line.startsWith('---')) cls = ' remove';
    else if (/^(diff --git|index |--- |\+\+\+ |new file|deleted file|similarity index|rename (from|to))/.test(line)) cls = ' header';
    return `<span class="git-diff-line${cls}">${line ? escapeHtml(line) : ' '}</span>`;
  }).join('');
}

function paintGitDiff(project, state, repo, body, change) {
  const pane = body.querySelector('#git-diff-pane');
  if (!pane) return;
  if (!change) {
    pane.innerHTML = '<div class="git-diff-empty">Select a changed file to view its diff.</div>';
    return;
  }
  const key = `${repo.path}\0${change.path}`;
  const cached = state.diffs.get(key);
  pane.dataset.path = change.path;
  if (!cached) {
    pane.innerHTML = '<div class="git-diff-empty">Loading diff…</div>';
    window.api.getProjectGitDiff(project.id, repo.path, change.path).then((result) => {
      if (result?.ok) state.diffs.set(key, { diff: result.diff || '', truncated: !!result.truncated });
      else state.diffs.set(key, { error: result?.error || 'Could not load this diff.' });
      if (!body.isConnected || state.selectedRepo !== repo.path || state.selectedFiles.get(repo.path) !== change.path) return;
      paintGitDiff(project, state, repo, body, change);
    }).catch((err) => {
      state.diffs.set(key, { error: err?.message || 'Could not load this diff.' });
      if (body.isConnected && state.selectedRepo === repo.path && state.selectedFiles.get(repo.path) === change.path) {
        paintGitDiff(project, state, repo, body, change);
      }
    });
    return;
  }
  if (cached.error) {
    pane.innerHTML = `<div class="git-diff-empty">${escapeHtml(cached.error)}</div>`;
    return;
  }
  pane.innerHTML = cached.diff
    ? `<div class="git-diff-title mono">${escapeHtml(change.path)}</div><pre class="git-diff">${gitDiffLines(cached.diff)}</pre>`
    : `<div class="git-diff-title mono">${escapeHtml(change.path)}</div><div class="git-diff-empty">No textual diff is available.</div>`;
}

function gitNaturalCompare(a, b) {
  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });
}

// Folders before files; a folder whose only child is a folder is merged into
// one row ("src/app"), like VS Code's compact folders.
function gitSortTreeLevel(nodes) {
  const sorted = nodes.map((node) => {
    if (node.kind !== 'folder') return node;
    let name = node.name;
    let children = gitSortTreeLevel(node.children);
    while (children.length === 1 && children[0].kind === 'folder') {
      name = `${name}/${children[0].name}`;
      children = children[0].children;
    }
    return { kind: 'folder', name, children };
  });
  sorted.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'folder' ? -1 : 1;
    return gitNaturalCompare(a.name, b.name);
  });
  return sorted;
}

// Git reports paths with '/' on every platform; renames sit at their new path.
function buildGitChangeTree(changes) {
  const root = new Map();
  for (const change of changes) {
    const parts = String(change.path || '').split('/').filter(Boolean);
    let level = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i];
      let node = level.get(part);
      if (!node || node.kind !== 'folder') {
        node = { kind: 'folder', name: part, children: new Map() };
        level.set(part, node);
      }
      level = node.children;
    }
    const fileName = parts[parts.length - 1] || change.path;
    level.set(`\0${fileName}`, { kind: 'file', name: fileName, change });
  }
  const toArray = (map) => [...map.values()].map(node => node.kind === 'folder' ? { ...node, children: toArray(node.children) } : node);
  return gitSortTreeLevel(toArray(root));
}

function gitTreeFileCount(node) {
  let count = 0;
  for (const child of node.children) count += child.kind === 'file' ? 1 : gitTreeFileCount(child);
  return count;
}

// Visible rows in display order; collapsed folders keep their own row only.
function gitTreeRows(tree, collapsedSet, keyPrefix, depth = 0) {
  const rows = [];
  for (const node of tree) {
    const key = keyPrefix ? `${keyPrefix}/${node.name}` : node.name;
    if (node.kind === 'folder') {
      const collapsed = collapsedSet.has(key);
      rows.push({ kind: 'folder', depth, name: node.name, key, count: gitTreeFileCount(node), collapsed });
      if (!collapsed) rows.push(...gitTreeRows(node.children, collapsedSet, key, depth + 1));
    } else {
      rows.push({ kind: 'file', depth, name: node.name, key, change: node.change });
    }
  }
  return rows;
}

function createGitFileRow(project, state, repo, body, list, change, isSelected, opts) {
  const tree = !!(opts && opts.tree);
  const row = document.createElement('button');
  row.type = 'button';
  row.className = 'git-file-row' + (tree ? ' tree' : '') + (isSelected ? ' selected' : '');
  if (tree) row.style.setProperty('--depth', String(opts.depth || 0));
  const renamed = change.oldPath ? `${change.oldPath} → ${change.path}` : change.path;
  row.title = tree ? `${renamed}\n${gitChangeMeta(change)}` : renamed;
  row.innerHTML = tree
    ? `<span class="git-file-code ${escapeHtml(change.status)}">${gitChangeCode(change)}</span><span class="git-file-path mono">${escapeHtml(pathBasename(change.path) || change.path)}</span>`
    : `<span class="git-file-code ${escapeHtml(change.status)}">${gitChangeCode(change)}</span>
        <span class="git-file-text"><span class="git-file-path mono">${escapeHtml(change.path)}</span><span class="git-file-meta">${escapeHtml(gitChangeMeta(change))}</span></span>`;
  row.onclick = () => {
    state.selectedFiles.set(repo.path, change.path);
    list.querySelectorAll('.git-file-row').forEach(el => el.classList.toggle('selected', el === row));
    paintGitDiff(project, state, repo, body, change);
  };
  return row;
}

function createGitFolderRow(project, state, repo, body, collapsedSet, row) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'git-folder-row';
  button.dataset.key = row.key;
  button.style.setProperty('--depth', String(row.depth));
  button.setAttribute('aria-expanded', row.collapsed ? 'false' : 'true');
  button.innerHTML = `
    <span class="git-folder-chevron">${row.collapsed ? PICONS.chevronRight(11) : PICONS.chevronDown(11)}</span>
    <span class="git-folder-icon">${PICONS.folder(13)}</span>
    <span class="git-folder-name mono">${escapeHtml(row.name)}</span>
    ${row.count ? `<span class="git-folder-count">${row.count}</span>` : ''}`;
  button.onclick = () => {
    if (collapsedSet.has(row.key)) collapsedSet.delete(row.key); else collapsedSet.add(row.key);
    paintGitChanges(project, state, repo, body, { repaintDiff: false });
    // The list was rebuilt, so put keyboard focus back on the new copy of this row.
    [...body.querySelectorAll('.git-folder-row')].find(el => el.dataset.key === row.key)?.focus();
  };
  return button;
}

function paintGitChanges(project, state, repo, body, { repaintDiff = true } = {}) {
  const list = body.querySelector('#git-file-list');
  if (!list) return;
  const groupOrder = ['conflicted', 'modified', 'added', 'deleted', 'renamed', 'untracked'];
  const groupLabels = {
    conflicted: 'Conflicted', modified: 'Modified', added: 'Added',
    deleted: 'Deleted', renamed: 'Renamed', untracked: 'Untracked',
  };
  const selectedPath = state.selectedFiles.get(repo.path);
  let selected = repo.changes.find(change => change.path === selectedPath) || repo.changes[0] || null;
  if (selected) state.selectedFiles.set(repo.path, selected.path);

  const tree = gitChangesViewMode() === 'tree';
  const collapsedSet = gitCollapsedSet(state, repo.path);

  list.replaceChildren();
  for (const kind of groupOrder) {
    const changes = repo.changes.filter(change => change.status === kind);
    if (!changes.length) continue;
    const label = document.createElement('div');
    label.className = 'git-file-group';
    label.textContent = groupLabels[kind];
    list.appendChild(label);

    if (!tree) {
      for (const change of changes) {
        list.appendChild(createGitFileRow(project, state, repo, body, list, change, selected?.path === change.path, { tree: false }));
      }
      continue;
    }
    for (const row of gitTreeRows(buildGitChangeTree(changes), collapsedSet, kind)) {
      if (row.kind === 'folder') list.appendChild(createGitFolderRow(project, state, repo, body, collapsedSet, row));
      else list.appendChild(createGitFileRow(project, state, repo, body, list, row.change, selected?.path === row.change.path, { tree: true, depth: row.depth }));
    }
  }
  if (repaintDiff) paintGitDiff(project, state, repo, body, selected);
}

function gitViewToggleHtml(mode) {
  const btn = (view, label, icon) => `<button type="button" class="git-view-btn${mode === view ? ' on' : ''}" data-view="${view}" title="${label}" aria-label="${label}" aria-pressed="${mode === view}">${icon}</button>`;
  return `<span class="git-view-toggle" role="group" aria-label="Changes view">
    ${btn('list', 'View as list', PICONS.list(13))}
    ${btn('tree', 'View as tree', PICONS.tree(13))}
  </span>`;
}

function gitCommitsHtml(repo) {
  if (!repo.commits.length) return '<div class="git-empty-row">No commits yet.</div>';
  return repo.commits.map(commit => `
    <div class="git-commit-row">
      <span class="git-commit-hash mono">${escapeHtml(commit.shortHash)}</span>
      <span class="git-commit-text"><span class="git-commit-subject">${escapeHtml(commit.subject)}</span><span class="git-commit-meta">${escapeHtml(commit.author)} · ${escapeHtml(gitRelativeTime(commit.date))}</span></span>
    </div>`).join('');
}

function paintGitRepository(project, state, body) {
  const repositories = state.repositories || [];
  if (!repositories.length) {
    body.innerHTML = '<div class="git-empty-state"><div class="git-empty-title">No folders attached</div><div>Git information will appear here when this project has an attached repository.</div></div>';
    return;
  }

  let repo = repositories.find(item => item.path === state.selectedRepo);
  if (!repo) repo = repositories.find(item => item.git) || repositories[0];
  state.selectedRepo = repo.path;

  const picker = repositories.length > 1 ? `
    <div class="git-repo-picker" role="tablist" aria-label="Repositories">
      ${repositories.map((item, index) => `<button type="button" class="git-repo-option ${item.path === repo.path ? 'active' : ''}" data-index="${index}">${escapeHtml(gitRepoName(item))}</button>`).join('')}
    </div>` : '';

  if (!repo.git) {
    body.innerHTML = `
      <div class="git-tab-shell">
        <div class="git-tab-top"><div><div class="git-tab-title">Git</div><div class="git-tab-path mono">${escapeHtml(repo.path)}</div></div><span class="git-readonly">Read only</span></div>
        ${picker}
        <div class="git-empty-state"><div class="git-empty-title">Not a Git repository</div><div>${escapeHtml(repo.path)}</div></div>
      </div>`;
  } else {
    const changed = repo.changes.length;
    body.innerHTML = `
      <div class="git-tab-shell">
        <div class="git-tab-top"><div><div class="git-tab-title">${escapeHtml(gitRepoName(repo))}</div><div class="git-tab-path mono">${escapeHtml(repo.path)}</div></div><span class="git-readonly">Read only</span></div>
        ${picker}
        ${gitOverviewHtml(repo)}
        <section class="git-section">
          <div class="git-section-heading"><span>Changes</span><span class="git-heading-right">${changed ? gitViewToggleHtml(gitChangesViewMode()) : ''}<span class="git-section-meta">${changed ? `${changed} file${changed === 1 ? '' : 's'}` : 'Working tree clean'}</span></span></div>
          ${changed ? '<div class="git-changes"><div class="git-file-list" id="git-file-list"></div><div class="git-diff-pane" id="git-diff-pane"></div></div>' : '<div class="git-empty-row">There are no staged, unstaged, or untracked files.</div>'}
        </section>
        <section class="git-section">
          <div class="git-section-heading"><span>Recent commits</span><span class="git-section-meta">${repo.commits.length ? `Latest ${Math.min(20, repo.commits.length)}` : 'No history'}</span></div>
          <div class="git-commits">${gitCommitsHtml(repo)}</div>
        </section>
      </div>`;
    if (changed) paintGitChanges(project, state, repo, body);
  }

  body.querySelectorAll('.git-repo-option').forEach(button => {
    const item = repositories[Number(button.dataset.index)];
    if (!item) return;
    button.title = item.path;
    button.onclick = () => {
      state.selectedRepo = item.path;
      paintGitRepository(project, state, body);
    };
  });

  body.querySelectorAll('.git-view-btn').forEach(button => {
    button.onclick = () => {
      setGitChangesViewMode(button.dataset.view);
      // Read back what was stored so the buttons match what gets rendered.
      const effective = gitChangesViewMode();
      body.querySelectorAll('.git-view-btn').forEach(btn => {
        const on = btn.dataset.view === effective;
        btn.classList.toggle('on', on);
        btn.setAttribute('aria-pressed', String(on));
      });
      paintGitChanges(project, state, repo, body, { repaintDiff: false });
    };
  });
}

function renderProjectGitTab(project, body) {
  const state = gitTabState(project.id);
  body.className = 'ws-body git-tab-body';
  if (state.repositories) paintGitRepository(project, state, body);
  else body.innerHTML = '<div class="git-loading"><span class="git-loading-dot"></span>Reading repository…</div>';

  const request = ++state.request;
  state.error = '';
  window.api.getProjectGitInfo(project.id).then((result) => {
    if (request !== state.request) return;
    if (!result?.ok) throw new Error(result?.error || 'Could not read Git information.');
    state.diffs.clear();
    state.repositories = result.repositories || [];
    if (body.isConnected && selectedProject()?.id === project.id && projectTab(project) === 'git') {
      paintGitRepository(project, state, body);
    }
  }).catch((err) => {
    if (request !== state.request) return;
    state.error = err?.message || 'Could not read Git information.';
    if (body.isConnected) body.innerHTML = `<div class="git-empty-state"><div class="git-empty-title">Git information unavailable</div><div>${escapeHtml(state.error)}</div></div>`;
  });
}
