// Read-only context menu builders for the Git Graph tab.
//
// Every gitGraphBuild*Menu(ctx) function is pure: it reads only the fields on
// `ctx` (built by the caller from the frozen data-gg-* attributes) and
// returns a `showContextMenu`-shaped item array (projects-view.js's existing
// item shape — no new menu infrastructure). Mutating actions (checkout,
// merge, branch/tag management, …) live in a later PR; every menu here only
// ever copies text to the clipboard or opens the existing diff/file viewer.
//
// ctx contract (fields used depend on which menu; unused fields are ignored):
// {
//   onColumnVisibilityChange(column, visible),
//   onViewDiff(file), onViewFileAtRevision(file),
//
//   // target-specific:
//   commit: { hash, shortHash, subject },
//   localBranch: { name, hash },
//   remoteBranch: { remote, name, hash },
//   tag: { name, hash },
//   file: { path, relativePath, absolutePath },
//   columnHeader: { columnVisibility: {date,author,commit} },
// }

function gitGraphCopyText(text) {
  if (typeof window !== 'undefined' && window.api && window.api.writeClipboard) window.api.writeClipboard(text == null ? '' : String(text));
}

function gitGraphMenuIcon(name, size) {
  if (typeof PICONS !== 'undefined' && typeof PICONS[name] === 'function') return PICONS[name](size || 12);
  return '';
}

// --- Commit row ---

function gitGraphBuildCommitMenu(ctx) {
  const commit = ctx.commit || {};
  return [
    { id: 'copyHash', label: 'Copy Commit Hash to Clipboard', onClick: () => gitGraphCopyText(commit.hash) },
    { id: 'copySubject', label: 'Copy Commit Subject to Clipboard', onClick: () => gitGraphCopyText(commit.subject) },
  ];
}

// --- Local branch label ---

function gitGraphBuildLocalBranchMenu(ctx) {
  const branch = ctx.localBranch || {};
  return [{ id: 'copyName', label: 'Copy Branch Name to Clipboard', onClick: () => gitGraphCopyText(branch.name) }];
}

// --- Remote branch label ---

function gitGraphBuildRemoteBranchMenu(ctx) {
  const rb = ctx.remoteBranch || {};
  return [{ id: 'copyName', label: 'Copy Branch Name to Clipboard', onClick: () => gitGraphCopyText(rb.name) }];
}

// --- Tag label ---

function gitGraphBuildTagMenu(ctx) {
  const tag = ctx.tag || {};
  return [{ id: 'copyName', label: 'Copy Tag Name to Clipboard', onClick: () => gitGraphCopyText(tag.name) }];
}

// --- Commit-details file row ---

function gitGraphBuildFileMenu(ctx) {
  const file = ctx.file || {};
  return [
    { id: 'viewDiff', label: 'View Diff', onClick: () => ctx.onViewDiff && ctx.onViewDiff(file) },
    { id: 'viewFileAtRevision', label: 'View File at this Revision', onClick: () => ctx.onViewFileAtRevision && ctx.onViewFileAtRevision(file) },
    { sep: true },
    { id: 'copyAbsolutePath', label: 'Copy Absolute File Path to Clipboard', onClick: () => gitGraphCopyText(file.absolutePath) },
    { id: 'copyRelativePath', label: 'Copy Relative File Path to Clipboard', onClick: () => gitGraphCopyText(file.relativePath || file.path) },
  ];
}

// --- Table column header row ---

function gitGraphBuildColumnHeaderMenu(ctx) {
  const header = ctx.columnHeader || {};
  const visibility = header.columnVisibility || {};
  const checkIcon = (on) => (on ? gitGraphMenuIcon('check', 12) : '');
  // `checked` is an explicit, icon-independent signal (the icon is only the
  // visual rendering of it) so a toggle's active state is testable without
  // depending on a PICONS.check glyph actually being registered yet.
  const toggle = (col, label) => ({ label, icon: checkIcon(!!visibility[col]), checked: !!visibility[col], onClick: () => ctx.onColumnVisibilityChange && ctx.onColumnVisibilityChange(col, !visibility[col]) });
  return [
    toggle('date', 'Date'),
    toggle('author', 'Author'),
    toggle('commit', 'Commit'),
  ];
}

// --- Dispatch: reads the data-gg-* attributes off the clicked element (or
// the nearest ancestor carrying them) and picks the right builder. The
// combined local+remote pill's dual hit-region routing lives here: a click
// on the region carrying data-gg-kind="remote-branch", or on a
// data-gg-kind="branch" region whose own data-gg-ref-type is "remote", both
// route to the remote-branch menu; every other "branch" region routes local. ---

function gitGraphClosestAttr(el, attr) {
  let node = el;
  while (node && typeof node.getAttribute === 'function') {
    const value = node.getAttribute(attr);
    if (value != null) return value;
    node = node.parentElement;
  }
  return null;
}

function gitGraphReadTargetAttrs(el) {
  return {
    kind: gitGraphClosestAttr(el, 'data-gg-kind'),
    hash: gitGraphClosestAttr(el, 'data-gg-hash'),
    refName: gitGraphClosestAttr(el, 'data-gg-ref-name'),
    remote: gitGraphClosestAttr(el, 'data-gg-remote'),
    refType: gitGraphClosestAttr(el, 'data-gg-ref-type'),
    filePath: gitGraphClosestAttr(el, 'data-gg-file-path'),
  };
}

/** Pure: returns the item array for whichever target `el` identifies, or null for an unknown/unmenued kind. */
function gitGraphBuildMenuItems(el, ctx) {
  const target = gitGraphReadTargetAttrs(el);
  switch (target.kind) {
    case 'commit': return gitGraphBuildCommitMenu(ctx);
    case 'branch': return target.refType === 'remote' ? gitGraphBuildRemoteBranchMenu(ctx) : gitGraphBuildLocalBranchMenu(ctx);
    case 'remote-branch': return gitGraphBuildRemoteBranchMenu(ctx);
    case 'tag': return gitGraphBuildTagMenu(ctx);
    case 'file': return gitGraphBuildFileMenu(ctx);
    case 'column-header': return gitGraphBuildColumnHeaderMenu(ctx);
    default: return null;
  }
}

/** Builds the right menu for `el` and opens it via the shared showContextMenu (projects-view.js). */
function gitGraphShowContextMenu(el, ctx, position) {
  const items = gitGraphBuildMenuItems(el, ctx);
  if (items && typeof showContextMenu === 'function') showContextMenu(items, position);
  return items;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    gitGraphCopyText, gitGraphMenuIcon,
    gitGraphBuildCommitMenu, gitGraphBuildLocalBranchMenu,
    gitGraphBuildRemoteBranchMenu, gitGraphBuildTagMenu, gitGraphBuildFileMenu,
    gitGraphBuildColumnHeaderMenu,
    gitGraphClosestAttr, gitGraphReadTargetAttrs, gitGraphBuildMenuItems, gitGraphShowContextMenu,
  };
}
