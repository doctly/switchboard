// Renderer-logic tests for the Git Graph tab (public/project-git-graph-view.js
// + public/git-graph-render.js), in the house `node --test` style used by
// test/git.test.js / test/projects.test.js: the modules are dedicated,
// side-effect-free-at-require-time files, so they are `require()`d directly
// (no jsdom/Electron) with the handful of browser globals they read
// (`escapeHtml`, `escapeAttr`, `PICONS`, `window.api`, `showContextMenu`, …)
// provided as plain stubs.
//
// Deliberately does NOT load git-graph-layout.js / git-graph-menus.js (files
// owned elsewhere): every call into them is behind a `typeof x === 'function'`
// guard, and this suite exists partly to prove that guard holds — the tab's
// own logic must not depend on those files being present.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const vm = require('node:vm');
const fs = require('node:fs');

// escapeHtml/escapeAttr run as the *actual* public/utils.js functions, not a
// reimplementation — a security test here must fail the moment the real
// escaping logic regresses, the same way a change to it would break the
// running app. escapeHtml's only environment dependency is
// `document.createElement('div')` (set .textContent, read .innerHTML back);
// this stand-in implements just that one DOM text-serialization rule
// (browsers escape &/</> in a text node, never quotes — quotes don't need it
// outside an attribute) so utils.js's own escapeHtml runs completely unmodified.
function fakeEscapingDiv() {
  let text = '';
  return {
    set textContent(value) { text = String(value); },
    get textContent() { return text; },
    get innerHTML() { return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); },
  };
}
const utilsContext = vm.createContext({ document: { createElement: () => fakeEscapingDiv() }, SessionConfig: {} });
vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/utils.js'), 'utf8'), utilsContext);
global.escapeHtml = utilsContext.escapeHtml;
global.escapeAttr = utilsContext.escapeAttr;
// buildGitChangeTree/gitTreeRows come from #98's public/project-git-view.js;
// a trimmed stand-in is enough here since that file's own tests cover the
// tree builder itself, and this suite only needs a tree shape to flow through.
global.buildGitChangeTree = (changes) => {
  const root = new Map();
  for (const change of changes) {
    const parts = String(change.path || '').split('/').filter(Boolean);
    let level = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i];
      let node = level.get(part);
      if (!node || node.kind !== 'folder') { node = { kind: 'folder', name: part, children: new Map() }; level.set(part, node); }
      level = node.children;
    }
    const fileName = parts[parts.length - 1] || change.path;
    level.set(`\0${fileName}`, { kind: 'file', name: fileName, change });
  }
  const toArray = (map) => [...map.values()].map(node => node.kind === 'folder' ? { ...node, children: toArray(node.children) } : node);
  return toArray(root);
};
global.gitTreeRows = (tree, collapsedSet, keyPrefix, depth = 0) => {
  const rows = [];
  for (const node of tree) {
    const key = keyPrefix ? `${keyPrefix}/${node.name}` : node.name;
    if (node.kind === 'folder') {
      const collapsed = collapsedSet.has(key);
      let count = 0;
      const countFiles = (n) => { for (const c of n) count += c.kind === 'file' ? 1 : countFiles(c.children); };
      countFiles(node.children);
      rows.push({ kind: 'folder', depth, name: node.name, key, count, collapsed });
      if (!collapsed) rows.push(...global.gitTreeRows(node.children, collapsedSet, key, depth + 1));
    } else {
      rows.push({ kind: 'file', depth, name: node.name, key, change: node.change });
    }
  }
  return rows;
};

const render = require(path.join(__dirname, '../public/git-graph-render.js'));
Object.assign(global, render);

const view = require(path.join(__dirname, '../public/project-git-graph-view.js'));
Object.assign(global, view);

// --- Small fake-DOM element, enough for the paint/wire functions under test
// to run to completion without throwing. ---

function fakeElement() {
  const el = {
    style: {}, dataset: {}, className: '', innerHTML: '', textContent: '',
    isConnected: true,
    appendChild(child) { return child; },
    prepend() {},
    remove() {},
    focus() {}, select() {}, scrollIntoView() {},
    closest() { return null; },
    getAttribute() { return null; },
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    querySelector() { return fakeElement(); },
    querySelectorAll: () => [],
  };
  return el;
}

function fakeTargetElement(attrs, href) {
  const dataset = { ...attrs };
  const el = {
    dataset,
    getAttribute(name) { return name === 'href' ? (href || null) : null; },
    href,
    closest(selector) {
      return selector === '[data-gg-kind]' && dataset.ggKind ? el : null;
    },
  };
  return el;
}

// === Pure helpers: git-graph-render.js ===

test('gitGraphFormatDate covers all five date-format variants', () => {
  const iso = '2019-03-24T21:34:00Z';
  assert.match(render.gitGraphFormatDate(iso, 'date-time'), /24 Mar 2019 \d{2}:\d{2}/);
  assert.equal(render.gitGraphFormatDate(iso, 'date-only'), '24 Mar 2019');
  assert.match(render.gitGraphFormatDate(iso, 'iso'), /^2019-03-24 \d{2}:\d{2}$/);
  assert.equal(render.gitGraphFormatDate(iso, 'iso-date-only'), '2019-03-24');
  const relative = render.gitGraphFormatDate(new Date(Date.now() - 5 * 60000).toISOString(), 'relative');
  assert.match(relative, /minute/);
});

test('gitGraphBuildLayoutInput always puts Uncommitted at the top and attaches stashes as single-parent pseudo-commits', () => {
  const commits = [
    { hash: 'c2', parents: ['c1'], authorDate: '2024-01-02T00:00:00Z', isHead: true, refs: { heads: [], remotes: [], tags: [] } },
    { hash: 'c1', parents: [], authorDate: '2024-01-01T00:00:00Z', refs: { heads: [], remotes: [], tags: [] } },
  ];
  const stashes = [{ hash: 's1', index: 0, baseCommitHash: 'c1', message: 'WIP', date: '2024-01-01T12:00:00Z' }];
  const merged = render.gitGraphBuildLayoutInput(commits, stashes, { changeCount: 3 }, 'c2');
  assert.equal(merged[0].kind, 'uncommitted');
  assert.equal(merged[0].hash, '#uncommitted');
  assert.equal(merged[0].parents[0], 'c2');
  assert.ok(merged.some(r => r.kind === 'stash' && r.hash === 's1' && r.parents[0] === 'c1'));
  assert.ok(merged.some(r => r.hash === 'c2' && r.kind === 'commit'));
});

test('gitGraphBuildLayoutInput keeps git order, so a rebased parent with a newer author date never lands above its child', () => {
  const commits = [
    { hash: 'child', parents: ['parent'], authorDate: '2024-01-01T00:00:00Z', commitDate: '2024-01-05T00:00:00Z', refs: { heads: [], remotes: [], tags: [] } },
    { hash: 'parent', parents: [], authorDate: '2024-01-03T00:00:00Z', commitDate: '2024-01-04T00:00:00Z', refs: { heads: [], remotes: [], tags: [] } },
  ];
  const stashes = [{ hash: 's1', index: 0, baseCommitHash: 'parent', message: 'WIP', date: '2024-01-06T00:00:00Z' }];
  const merged = render.gitGraphBuildLayoutInput(commits, stashes, null, 'child');
  const at = hash => merged.findIndex(r => r.hash === hash);
  assert.ok(at('child') < at('parent'));
  assert.ok(at('s1') < at('parent'), 'a stash stays above the commit it was taken from');
});

test('gitGraphBuildLayoutInput holds back a stash until the commit it was taken from is loaded', () => {
  const commits = [{ hash: 'c1', parents: ['c0'], commitDate: '2024-01-02T00:00:00Z', refs: { heads: [], remotes: [], tags: [] } }];
  const stashes = [{ hash: 's-old', index: 0, baseCommitHash: 'not-loaded', message: 'WIP', date: '2024-01-03T00:00:00Z' }];
  const merged = render.gitGraphBuildLayoutInput(commits, stashes, null, 'c1');
  assert.equal(merged.some(r => r.hash === 's-old'), false);
});

test('gitGraphFallbackLayout: a minimal one-lane-no-edges stand-in, used only when the real layout function is not loaded', () => {
  const commits = [
    { hash: 'c', parents: ['b'] }, { hash: 'b', parents: ['a'] }, { hash: 'a', parents: [] },
  ];
  const layout = render.gitGraphFallbackLayout(commits);
  assert.deepEqual(layout.map(r => r.hash), ['c', 'b', 'a']);
  assert.deepEqual(layout.map(r => r.lane), [0, 0, 0]);
  assert.deepEqual(layout.map(r => r.edges), [[], [], []]);
});

test('gitGraphResolveLayoutFn picks the real computeGitGraphLayout when it is loaded, the fallback otherwise', () => {
  assert.equal(render.gitGraphResolveLayoutFn(), render.gitGraphFallbackLayout);
  global.computeGitGraphLayout = () => [];
  try {
    assert.equal(render.gitGraphResolveLayoutFn(), global.computeGitGraphLayout);
  } finally {
    delete global.computeGitGraphLayout;
  }
});

test('gitGraphRenderRefPills: combined local+remote pill carries the two independently-hit-testable regions', () => {
  const commit = {
    hash: 'abc123', isHead: true,
    refs: { heads: ['main'], remotes: [{ remote: 'origin', name: 'main' }], tags: [] },
  };
  const html = render.gitGraphRenderRefPills(commit, { headBranchName: 'main' });
  assert.match(html, /data-gg-kind="branch"[^>]*data-gg-ref-type="local"/);
  assert.match(html, /data-gg-kind="remote-branch"[^>]*data-gg-ref-type="remote"/);
  assert.match(html, /gg-pill-head/); // HEAD emphasis on the matching local pill
});

test('gitGraphRenderRefPills: no HEAD emphasis when the branch name is not the checked-out one', () => {
  const commit = { hash: 'x', isHead: false, refs: { heads: ['feature'], remotes: [], tags: [] } };
  const html = render.gitGraphRenderRefPills(commit, { headBranchName: 'main' });
  assert.equal(html.includes('gg-pill-head'), false);
});

test('gitGraphRenderRefPills: local branch with no same-named remote gets its own single pill, not a combined pair', () => {
  const commit = { hash: 'x', refs: { heads: ['solo'], remotes: [{ remote: 'origin', name: 'other' }], tags: [] } };
  const html = render.gitGraphRenderRefPills(commit, {});
  assert.equal((html.match(/data-gg-kind="branch"/g) || []).length, 1);
  assert.equal((html.match(/data-gg-kind="remote-branch"/g) || []).length, 1);
  assert.equal(html.includes('gg-pill-combined'), false);
});

test('gitGraphRenderRefPills: a ref name with a quote or angle bracket never breaks out of its attribute', () => {
  const commit = { hash: 'x', refs: { heads: ['a"onmouseover=alert(1)//<b'], remotes: [], tags: [] } };
  const html = render.gitGraphRenderRefPills(commit, {});
  // The hostile text may still appear as inert, already-escaped text content
  // (safe); what must never happen is the quote closing the attribute early
  // and opening a live one — which would show up as a *space* right before it.
  assert.doesNotMatch(html, /ref-name="[^"]*" onmouseover=/);
  assert.match(html, /data-gg-ref-name="a&quot;onmouseover=alert\(1\)\/\/&lt;b"/);
});

// A single payload exercising every character that matters in HTML (", ', <, >, &),
// through all three ref kinds pills render (local branch, remote branch, tag) —
// not just the local-branch case above.
const GG_HOSTILE_REF = `it"'s <b>&"onmouseover=alert(1)</b>`;
const GG_HOSTILE_REF_ESCAPED_ATTR = 'it&quot;&#39;s &lt;b&gt;&amp;&quot;onmouseover=alert(1)&lt;/b&gt;';

test('gitGraphRenderRefPills: a remote branch name with \', ", <, >, & never breaks out of its attributes', () => {
  const commit = { hash: 'x', refs: { heads: [], remotes: [{ remote: 'origin', name: GG_HOSTILE_REF }], tags: [] } };
  const html = render.gitGraphRenderRefPills(commit, {});
  assert.doesNotMatch(html, /data-gg-ref-name="[^"]*" onmouseover=/);
  assert.doesNotMatch(html, /<b>/);
  assert.match(html, new RegExp(`data-gg-ref-name="${GG_HOSTILE_REF_ESCAPED_ATTR.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`));
});

test('gitGraphRenderRefPills: a tag name with \', ", <, >, & never breaks out of its attributes', () => {
  const commit = { hash: 'x', refs: { heads: [], remotes: [], tags: [GG_HOSTILE_REF] } };
  const html = render.gitGraphRenderRefPills(commit, {});
  assert.doesNotMatch(html, /data-gg-ref-name="[^"]*" onmouseover=/);
  assert.doesNotMatch(html, /<b>/);
  assert.match(html, new RegExp(`data-gg-kind="tag"[^>]*data-gg-ref-name="${GG_HOSTILE_REF_ESCAPED_ATTR.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`));
});

test('a stash message with \', ", <, >, & is escaped as inert text, both in the row list and once its base-commit HTML entities pass back through it', () => {
  const project = { id: 'proj-stash-xss' };
  const state = view.gitGraphState(project.id);
  state.repositories = [{ path: '/repo', git: true }];
  state.selectedRepo = '/repo';
  state.rawCommits = [];
  state.stashes = [];
  state.uncommitted = null;
  state.rows = [{
    hash: 's0', shortHash: 's0', kind: 'stash', stashIndex: 0, parents: [],
    authorName: '', authorDate: '2024-01-01T00:00:00Z', commitDate: '2024-01-01T00:00:00Z',
    subject: GG_HOSTILE_REF, refs: { heads: [], remotes: [], tags: [] },
  }];
  state.layout = [{ lane: 0, colorIndex: 0, edges: [] }];
  const body = fakeElement();
  view.gitGraphPaint(project, state, body);
  // escapeHtml (text content) leaves quotes alone — only & < > need escaping
  // outside an attribute — so the quotes may reappear literally; what must
  // never reappear is a live '<b>' tag.
  assert.doesNotMatch(body.innerHTML, /<b>/);
  assert.match(body.innerHTML, /gg-subject">it"'s &lt;b&gt;&amp;"onmouseover=alert\(1\)&lt;\/b&gt;</);
});

test('gitGraphRowClasses: merge commits are muted by default, stashes/uncommitted never are', () => {
  const merge = render.gitGraphRowClasses({ kind: 'commit', parents: ['a', 'b'] }, { muteMergeCommits: true });
  assert.ok(merge.includes('gg-muted'));
  const stash = render.gitGraphRowClasses({ kind: 'stash', parents: ['a', 'b'] }, { muteMergeCommits: true });
  assert.equal(stash.includes('gg-muted'), false);
  const off = render.gitGraphRowClasses({ kind: 'commit', parents: ['a', 'b'] }, { muteMergeCommits: false });
  assert.equal(off.includes('gg-muted'), false);
});

test('gitGraphDiffStatHtml / gitGraphStatusBadge', () => {
  assert.match(render.gitGraphDiffStatHtml({ insertions: 3, deletions: 1 }), /\+3/);
  assert.match(render.gitGraphDiffStatHtml({ insertions: 3, deletions: 1 }), /-1/);
  assert.equal(render.gitGraphDiffStatHtml({ insertions: 0, deletions: 0 }), '');
  assert.equal(render.gitGraphStatusBadge('renamed'), 'R');
  assert.equal(render.gitGraphStatusBadge('untracked'), 'U');
});

// === Pure helpers: project-git-graph-view.js ===

test('gitGraphFindMatches: matches message/date/author/hash/branch/tag substrings', () => {
  const rows = [
    { hash: 'aa11', subject: 'Fix login bug', authorName: 'Ada', authorDate: '2024-05-01T00:00:00Z', refs: { heads: [], remotes: [], tags: [] } },
    { hash: 'bb22', subject: 'Unrelated', authorName: 'Grace', authorDate: '2024-05-02T00:00:00Z', refs: { heads: ['release-login'], remotes: [], tags: [] } },
    { hash: 'cc33', subject: 'Nothing matches here', authorName: 'Bob', authorDate: '2024-05-03T00:00:00Z', refs: { heads: [], remotes: [], tags: ['login-tag'] } },
  ];
  assert.deepEqual(view.gitGraphFindMatches(rows, 'login', false), [0, 1, 2]);
  assert.deepEqual(view.gitGraphFindMatches(rows, 'ada', false), [0]);
  assert.deepEqual(view.gitGraphFindMatches(rows, 'Ada', true), [0]);
  assert.deepEqual(view.gitGraphFindMatches(rows, 'ada', true), []);
  assert.deepEqual(view.gitGraphFindMatches(rows, '', false), []);
});

test('gitGraphHandleEscapePriority closes the menu, then details, then Find, in that order', () => {
  const order = [];
  view.gitGraphHandleEscapePriority({
    closeMenu: () => { order.push('menu'); return true; },
    closeDetails: () => { order.push('details'); return true; },
    closeFind: () => { order.push('find'); return true; },
  });
  assert.deepEqual(order, ['menu']);

  order.length = 0;
  const result = view.gitGraphHandleEscapePriority({
    closeMenu: () => false,
    closeDetails: () => { order.push('details'); return true; },
    closeFind: () => { order.push('find'); return true; },
  });
  assert.deepEqual(order, ['details']);
  assert.equal(result, 'details');

  order.length = 0;
  const findResult = view.gitGraphHandleEscapePriority({
    closeMenu: () => false,
    closeDetails: () => false,
    closeFind: () => { order.push('find'); return true; },
  });
  assert.deepEqual(order, ['find']);
  assert.equal(findResult, 'find');
});

test('gitGraphSameStringSet compares two path lists regardless of order', () => {
  assert.equal(view.gitGraphSameStringSet(['a', 'b'], ['b', 'a']), true);
  assert.equal(view.gitGraphSameStringSet(['a'], ['a', 'b']), false);
});

test('renderProjectGitGraphTab notices a folder attached elsewhere and refreshes the repo list without losing the loaded graph', async () => {
  const project = { id: 'proj-attach-1', root: '/repo-a', folders: [] };
  const body = fakeElement();
  const calls = [];
  global.document = { addEventListener() {}, removeEventListener() {}, getElementById: () => null };
  global.selectedProject = () => project;
  global.projectTab = () => 'gitgraph';
  global.pathBasename = (p) => String(p || '').split('/').filter(Boolean).pop() || '';
  global.window = {
    api: {
      getProjectGitInfo: (id) => {
        calls.push(id);
        const repos = [{ path: '/repo-a', git: true }, ...project.folders.map(f => ({ path: f.path, git: true }))];
        return Promise.resolve({ ok: true, repositories: repos });
      },
    },
  };

  // First render populates the cache with just the root repo.
  view.renderProjectGitGraphTab(project, body);
  await new Promise(resolve => setImmediate(resolve));
  const state = view.gitGraphState(project.id);
  assert.deepEqual(state.repositories.map(r => r.path), ['/repo-a']);
  assert.equal(calls.length, 1);

  // A folder gets attached elsewhere (e.g. from the Settings tab) while this
  // tab isn't the one being painted — project.folders changes, nothing else
  // tells this tab about it.
  project.folders = [{ path: '/repo-b' }];
  state.rows = [{ hash: 'kept' }]; // stands in for an already-loaded graph that must survive the refresh
  view.renderProjectGitGraphTab(project, body);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(state.repositories.map(r => r.path).sort(), ['/repo-a', '/repo-b']);
  assert.equal(calls.length, 2);
  assert.deepEqual(state.rows, [{ hash: 'kept' }], 'the already-loaded graph for the still-selected repo is not thrown away');
});

// === Commit Details arrow-key navigation ===

test('gitGraphSameBranchNeighbor follows the row\'s own same-lane edge for a parent, and the earlier row pointing back at it for a child', () => {
  const state = {
    rows: [{ hash: 'c3' }, { hash: 'c2' }, { hash: 'c1' }],
    layout: [
      { edges: [{ parentHash: 'c2', style: 'same-lane' }] },
      { edges: [{ parentHash: 'c1', style: 'same-lane' }] },
      { edges: [] },
    ],
  };
  assert.equal(view.gitGraphSameBranchNeighbor(state, 'c3', 1), 'c2', 'Down from c3 reaches its parent c2');
  assert.equal(view.gitGraphSameBranchNeighbor(state, 'c1', -1), 'c2', 'Up from c1 reaches its child c2');
  assert.equal(view.gitGraphSameBranchNeighbor(state, 'c1', 1), null, 'the root commit has no parent to follow');
});

test('gitGraphAlternateBranchNeighbor follows a branch-out/merge-in edge instead of the same-lane one', () => {
  const state = {
    rows: [{ hash: 'merge' }, { hash: 'main1' }, { hash: 'feat1' }, { hash: 'base' }],
    layout: [
      { edges: [{ parentHash: 'main1', style: 'same-lane' }, { parentHash: 'feat1', style: 'branch-out' }] },
      { edges: [{ parentHash: 'base', style: 'same-lane' }] },
      { edges: [{ parentHash: 'base', style: 'merge-in' }] },
      { edges: [] },
    ],
  };
  assert.equal(view.gitGraphAlternateBranchNeighbor(state, 'merge', 1), 'feat1', 'the alternate parent at the merge is the other side, not main1');
  assert.equal(view.gitGraphAlternateBranchNeighbor(state, 'base', -1), 'feat1', 'the alternate child of base is the merge-in side, not main1');
});

test('gitGraphMoveDetailsFocus (mode "sameBranch") steps along the loaded window\'s own same-lane edges', () => {
  const state = view.gitGraphState('proj-nav-1');
  state.repositories = [{ path: '/repo', git: true }];
  state.selectedRepo = '/repo';
  state.rows = [{ hash: 'a', parents: ['b'] }, { hash: 'b', parents: ['c'] }, { hash: 'c', parents: [] }];
  state.layout = [
    { edges: [{ parentHash: 'b', style: 'same-lane' }] },
    { edges: [{ parentHash: 'c', style: 'same-lane' }] },
    { edges: [] },
  ];
  state.selectedHash = 'b';
  const project = { id: 'proj-nav-1' };
  const body = fakeElement();
  global.window = { api: { getGitGraphCommitDetail: () => Promise.resolve({ ok: true, commit: {}, files: [] }) } };

  view.gitGraphMoveDetailsFocus(project, state, body, 1, 'sameBranch');
  assert.equal(state.selectedHash, 'c');
  view.gitGraphMoveDetailsFocus(project, state, body, -1, 'sameBranch');
  assert.equal(state.selectedHash, 'b');
  view.gitGraphMoveDetailsFocus(project, state, body, 1, 'sameBranch');
  view.gitGraphMoveDetailsFocus(project, state, body, 1, 'sameBranch');
  assert.equal(state.selectedHash, 'c', 'stepping past the root is a no-op');
});

test('Escape closes the Find widget when it is the only thing open', () => {
  const state = view.gitGraphState('proj-find-esc-1');
  state.repositories = [{ path: '/repo', git: true }];
  state.selectedRepo = '/repo';
  state.rows = [];
  state.findOpen = true;
  const project = { id: 'proj-find-esc-1' };
  const body = fakeElement();
  global.window = { api: {} };
  global.document = { addEventListener: (type, fn) => { if (type === 'keydown') global.document._handler = fn; }, removeEventListener() {}, getElementById: () => null };
  global.selectedProject = () => project;
  global.projectTab = () => 'gitgraph';

  view.gitGraphBindKeyboard(project, state, body);
  global.document._handler({ key: 'Escape', target: {}, preventDefault() {} });
  assert.equal(state.findOpen, false);
});

test('the keydown handler never fires once the tab is no longer the active one', () => {
  const state = view.gitGraphState('proj-inactive-1');
  state.findOpen = true;
  const project = { id: 'proj-inactive-1' };
  const body = fakeElement();
  global.document = { addEventListener: (type, fn) => { if (type === 'keydown') global.document._handler = fn; }, removeEventListener() {}, getElementById: () => null };
  global.selectedProject = () => project;
  global.projectTab = () => 'files'; // the project view moved to a different tab; #ws-body was never removed from the DOM
  view.gitGraphBindKeyboard(project, state, body);
  global.document._handler({ key: 'Escape', target: {}, preventDefault() {} });
  assert.equal(state.findOpen, true, 'a handler bound while this tab was active must still no-op once the tab changes');
});

test('Ctrl/Cmd+ArrowDown is left alone (never preventDefault-ed) so the app\'s own session-switch shortcut still fires', () => {
  const state = view.gitGraphState('proj-modarrow-1');
  state.rows = [{ hash: 'a' }, { hash: 'b' }];
  state.selectedHash = 'a';
  state.detailsData = { mode: 'single', hash: 'a' };
  const project = { id: 'proj-modarrow-1' };
  const body = fakeElement();
  global.document = { addEventListener: (type, fn) => { if (type === 'keydown') global.document._handler = fn; }, removeEventListener() {}, getElementById: () => null };
  global.selectedProject = () => project;
  global.projectTab = () => 'gitgraph';
  global.window = { api: {} };
  view.gitGraphBindKeyboard(project, state, body);
  let prevented = false;
  global.document._handler({ key: 'ArrowDown', metaKey: true, target: {}, preventDefault() { prevented = true; } });
  assert.equal(prevented, false);
  assert.equal(state.selectedHash, 'a', 'a Cmd-held arrow must not move the details focus either');
});

test('gitGraphReadTargetAttrs (git-graph-menus.js) is used by gitGraphPopulateTargetField for every kept target kind', () => {
  const state = {
    rows: [{ hash: 'c1', shortHash: 'c1', subject: 'Do a thing' }],
    detailsData: { mode: 'single', hash: 'c1', kind: 'commit', files: [{ path: 'a/b.txt', status: 'modified' }] },
    repositories: [{ path: '/repo' }],
    selectedRepo: '/repo',
  };

  const commitCtx = {}; view.gitGraphPopulateTargetField(commitCtx, state, { kind: 'commit', hash: 'c1' });
  assert.equal(commitCtx.commit.subject, 'Do a thing');

  const localCtx = {}; view.gitGraphPopulateTargetField(localCtx, state, { kind: 'branch', refType: 'local', refName: 'main', hash: 'h' });
  assert.deepEqual(localCtx.localBranch, { name: 'main', hash: 'h' });
  assert.equal(localCtx.remoteBranch, undefined);

  // The combined pill's *remote* hit-region (data-gg-kind="branch" data-gg-ref-type="remote") must
  // populate remoteBranch, not localBranch — this is the dual-hit-region contract.
  const combinedRemoteCtx = {}; view.gitGraphPopulateTargetField(combinedRemoteCtx, state, { kind: 'branch', refType: 'remote', refName: 'main', remote: 'origin', hash: 'h' });
  assert.deepEqual(combinedRemoteCtx.remoteBranch, { remote: 'origin', name: 'main', hash: 'h' });
  assert.equal(combinedRemoteCtx.localBranch, undefined);

  const tagCtx = {}; view.gitGraphPopulateTargetField(tagCtx, state, { kind: 'tag', refName: 'v1', hash: 'c1' });
  assert.equal(tagCtx.tag.name, 'v1');

  const fileCtx = {}; view.gitGraphPopulateTargetField(fileCtx, state, { kind: 'file', filePath: 'a/b.txt' });
  assert.equal(fileCtx.file.relativePath, 'a/b.txt');
  assert.equal(fileCtx.file.absolutePath, '/repo/a/b.txt');

  const colCtx = {}; view.gitGraphPopulateTargetField(colCtx, state, { kind: 'column-header' });
  assert.ok(colCtx.columnHeader);
});

test('gitGraphOpenContextMenu wires ctx.onColumnVisibilityChange/onViewDiff/onViewFileAtRevision through to git-graph-menus.js', () => {
  const state = view.gitGraphState('proj-menu-ctx-1');
  state.repositories = [{ path: '/repo', git: true }];
  state.selectedRepo = '/repo';
  state.rows = [{ hash: 'c1', shortHash: 'c1', subject: 's' }];
  state.columns = { date: true, author: false, commit: true };
  const project = { id: 'proj-menu-ctx-1' };
  const body = fakeElement();

  let shownItems = null;
  global.showContextMenu = (items) => { shownItems = items; };
  global.gitGraphReadTargetAttrs = (el) => ({ kind: el.dataset.ggKind, hash: el.dataset.ggHash, refName: null, remote: null, refType: null, filePath: null });
  global.gitGraphShowContextMenu = (el, ctx) => {
    const items = ctx.columnHeader ? [{ id: 'date', checked: !!ctx.columnHeader.columnVisibility.date, onClick: () => ctx.onColumnVisibilityChange('date', !ctx.columnHeader.columnVisibility.date) }] : [];
    shownItems = items;
    return items;
  };
  try {
    const header = fakeTargetElement({ ggKind: 'column-header' });
    view.gitGraphOpenContextMenu(project, state, body, header, { x: 0, y: 0 });
    assert.ok(shownItems);
    assert.equal(shownItems[0].checked, true);
    shownItems[0].onClick();
    assert.equal(state.columns.date, false, 'the real onColumnVisibilityChange callback ran and flipped state');
  } finally {
    delete global.gitGraphReadTargetAttrs;
    delete global.gitGraphShowContextMenu;
    delete global.showContextMenu;
  }
});

// === A light integration-shaped test: staleness guard on the main graph load ===

test('gitGraphLoadGraph discards an older reply once a newer load has started, regardless of resolution order', async () => {
  const state = view.gitGraphState('proj-stale-1');
  state.repositories = [{ path: '/repo', git: true }];
  state.selectedRepo = '/repo';
  const project = { id: 'proj-stale-1' };
  const body = fakeElement();

  const resolvers = [];
  global.window = {
    api: {
      getProjectGitGraph: () => new Promise((resolve) => resolvers.push(resolve)),
    },
  };

  const p1 = view.gitGraphLoadGraph(project, state, body, { reset: true });
  const p2 = view.gitGraphLoadGraph(project, state, body, { reset: true });

  assert.equal(resolvers.length, 2);
  // Resolve the *second* (current) request first, then the stale first one late.
  resolvers[1]({ ok: true, commits: [{ hash: 'winner', parents: [], authorDate: '2024-02-01T00:00:00Z', refs: { heads: [], remotes: [], tags: [] } }], refs: { heads: [], remotes: [], tags: [] }, hasMore: false });
  await p2;
  resolvers[0]({ ok: true, commits: [{ hash: 'stale', parents: [], authorDate: '2024-01-01T00:00:00Z', refs: { heads: [], remotes: [], tags: [] } }], refs: { heads: [], remotes: [], tags: [] }, hasMore: false });
  await p1;

  assert.equal(state.rawCommits.length, 1);
  assert.equal(state.rawCommits[0].hash, 'winner');
});

test('gitGraphLoadGraph in Load-More mode (reset:false) appends to the existing window and advances skip', async () => {
  const state = view.gitGraphState('proj-loadmore-1');
  state.repositories = [{ path: '/repo', git: true }];
  state.selectedRepo = '/repo';
  state.rawCommits = [{ hash: 'existing', parents: [], authorDate: '2024-01-01T00:00:00Z', refs: { heads: [], remotes: [], tags: [] } }];
  state.skip = 1;
  const project = { id: 'proj-loadmore-1' };
  const body = fakeElement();

  global.window = {
    api: {
      getProjectGitGraph: (_id, _folder, opts) => {
        assert.equal(opts.skip, 1);
        assert.equal(opts.refsUnchanged, true);
        return Promise.resolve({ ok: true, commits: [{ hash: 'more', parents: [], authorDate: '2023-12-31T00:00:00Z', refs: { heads: [], remotes: [], tags: [] } }], refs: null, hasMore: false });
      },
    },
  };

  await view.gitGraphLoadGraph(project, state, body, { reset: false });
  assert.deepEqual(state.rawCommits.map(c => c.hash), ['existing', 'more']);
  assert.equal(state.skip, 2);
});

test('gitGraphLoadGraph surfaces a {error} reply as state.error rather than throwing', async () => {
  const state = view.gitGraphState('proj-error-1');
  state.repositories = [{ path: '/repo', git: true }];
  state.selectedRepo = '/repo';
  const project = { id: 'proj-error-1' };
  const body = fakeElement();
  global.window = { api: { getProjectGitGraph: () => Promise.resolve({ error: 'git not found' }) } };
  await view.gitGraphLoadGraph(project, state, body, { reset: true });
  assert.equal(state.error, 'git not found');
  assert.equal(state.loading, false);
});

// === Load More must never jump the table back to the top ===

/** A body stub whose `.gg-table-wrap` survives an innerHTML replace with a
 * fresh (scrollTop: 0) node each time — the same thing a real DOM does —
 * so gitGraphPaint's own preserveScroll copy-forward is what's under test,
 * not an artifact of the stub remembering the old node. */
function fakeScrollBody() {
  let wrap = { scrollTop: 0, querySelectorAll: () => [], addEventListener() {} };
  const body = {
    isConnected: true, className: '', dataset: {},
    get innerHTML() { return this._html || ''; },
    set innerHTML(v) { this._html = v; wrap = { scrollTop: 0, querySelectorAll: () => [], addEventListener() {} }; },
    querySelector(sel) {
      if (sel === '.gg-table-wrap') return wrap;
      return fakeElement();
    },
    querySelectorAll: () => [],
  };
  return body;
}

test('Load More preserves the table\'s scroll position; a fresh (reset) load does not', async () => {
  const state = view.gitGraphState('proj-scroll-1');
  state.repositories = [{ path: '/repo', git: true }];
  state.selectedRepo = '/repo';
  state.rawCommits = [{ hash: 'existing', parents: [], authorDate: '2024-01-01T00:00:00Z', refs: { heads: [], remotes: [], tags: [] } }];
  state.skip = 1;
  const project = { id: 'proj-scroll-1' };
  const body = fakeScrollBody();
  body.querySelector('.gg-table-wrap').scrollTop = 400;

  global.window = { api: { getProjectGitGraph: () => Promise.resolve({ ok: true, commits: [{ hash: 'more', parents: [], authorDate: '2023-12-31T00:00:00Z', refs: { heads: [], remotes: [], tags: [] } }], refs: null, hasMore: false }) } };

  await view.gitGraphLoadGraph(project, state, body, { reset: false });
  assert.equal(body.querySelector('.gg-table-wrap').scrollTop, 400, 'Load More must not reset scroll to the top');

  body.querySelector('.gg-table-wrap').scrollTop = 777;
  global.window = { api: { getProjectGitGraph: () => Promise.resolve({ ok: true, commits: [], refs: { heads: [], remotes: [], tags: [] }, hasMore: false }) } };
  await view.gitGraphLoadGraph(project, state, body, { reset: true });
  assert.equal(body.querySelector('.gg-table-wrap').scrollTop, 0, 'a fresh load lands on a new row set at the top');
});

// === Avatars, signature status, markdown, issue linking, code review and the
// docked-details option are out of scope for this read-only PR — nothing
// here references them; see git-graph-menus.js for the read-only menus. ===

// === Commit Comparison is order-independent (ancestor always "from") ===

test('gitGraphIsAncestor walks parent links through the loaded window', () => {
  const rows = [
    { hash: 'c3', parents: ['c2'] },
    { hash: 'c2', parents: ['c1'] },
    { hash: 'c1', parents: [] },
  ];
  assert.equal(view.gitGraphIsAncestor(rows, 'c1', 'c3'), true);
  assert.equal(view.gitGraphIsAncestor(rows, 'c3', 'c1'), false);
  assert.equal(view.gitGraphIsAncestor(rows, 'c1', 'c1'), false, 'a commit is not its own ancestor');
});

test('Ctrl-clicking an older ancestor after a newer commit still compares from the ancestor, regardless of click order', () => {
  const state = view.gitGraphState('proj-cmp-1');
  state.repositories = [{ path: '/repo', git: true }];
  state.selectedRepo = '/repo';
  state.rows = [
    { hash: 'newer', parents: ['older'] },
    { hash: 'older', parents: [] },
  ];
  state.selectedHash = 'newer'; // clicked first
  const project = { id: 'proj-cmp-1' };
  const body = fakeElement();
  const calls = [];
  global.window = { api: { getGitGraphCompareDetail: (...args) => { calls.push(args); return Promise.resolve({ ok: true, files: [] }); } } };

  const el = { dataset: { ggHash: 'older' } }; // ctrl-clicked second
  view.gitGraphHandleRowClick(project, state, body, el, { ctrlKey: true });

  assert.equal(state.detailsData.fromHash, 'older');
  assert.equal(state.detailsData.toHash, 'newer');
  assert.deepEqual(calls[0].slice(2), ['older', 'newer']);
});

// === Commit-details file list reuses #98's tree builder ===

test('gitGraphFileListHtml (tree mode) builds folder rows via buildGitChangeTree/gitTreeRows and leaf rows carry the security-fixed escapeAttr path attribute', () => {
  const files = [
    { path: 'src/app/a.js', status: 'modified', insertions: 1, deletions: 0 },
    { path: 'src/app/b"onload=alert(1)//.js', status: 'added', insertions: 2, deletions: 0 },
  ];
  const html = view.gitGraphFileListHtml(files, { fileViewType: 'tree', collapsedFolders: new Set() });
  assert.match(html, /gg-tree-folder/);
  // The hostile text may still appear as inert, already-escaped text content
  // (safe); what must never happen is the quote closing an attribute early.
  assert.doesNotMatch(html, /file-path="[^"]*" onload=/);
  assert.match(html, /data-gg-file-path="src\/app\/b&quot;onload=alert\(1\)\/\/\.js"/);
});

test('gitGraphFileListHtml (list mode) shows the full relative path, not just the basename', () => {
  const files = [{ path: 'src/app/a.js', status: 'modified' }];
  const html = view.gitGraphFileListHtml(files, { fileViewType: 'list', collapsedFolders: new Set() });
  assert.match(html, />src\/app\/a\.js</);
});

// === Commit body: URL auto-linking never lets a quote break out of the href ===

test('gitGraphLinkifyBody auto-links a bare URL and escapes the rest', () => {
  const html = view.gitGraphLinkifyBody('see https://example.com for details');
  assert.match(html, /<a class="gg-link"[^>]*href="https:\/\/example\.com"[^>]*>https:\/\/example\.com<\/a>/);
});

test('gitGraphLinkifyBody never lets a quote character in the commit body break out of the href attribute', () => {
  const hostile = 'see https://x" onmouseover="fetch(\'https://evil/\')';
  const html = view.gitGraphLinkifyBody(hostile);
  const firstTag = /<a\b[^>]*>/.exec(html);
  assert.ok(firstTag, 'expected the first https:// match to still be linkified');
  assert.doesNotMatch(firstTag[0], /onmouseover/, 'the quote must end the href, not open a live attribute inside the <a> tag');
  assert.match(firstTag[0], /^<a class="gg-link" data-gg-kind="link" href="https:\/\/x" target="_blank" rel="noopener">$/);
});

test('gitGraphSingleCommitHeaderHtml escapes a hostile subject/author rather than trusting repo content as markup', () => {
  const commit = {
    hash: 'abc', parents: [], subject: '<img src=x onerror=alert(1)>', authorName: '<b>Eve</b>', authorEmail: 'eve@example.com',
    authorDate: '2024-01-01T00:00:00Z', commitDate: '2024-01-01T00:00:00Z', committerName: 'Eve', body: '',
  };
  const html = view.gitGraphSingleCommitHeaderHtml(commit, 'commit');
  assert.doesNotMatch(html, /<img/);
  assert.doesNotMatch(html, /<b>Eve/);
});

// === Auto-refresh watcher: bound once, resolves the current body fresh ===
//
// gitGraphEnsureWatcherBound is a module-load singleton (see its own comment
// in project-git-graph-view.js) — it only ever runs its registration body
// once per process. To exercise that "once" behavior in isolation, this test
// loads a fresh copy of the module (dropping it from require's cache first)
// rather than relying on whichever earlier test in this file happened to
// trigger the real registration first.

test('gitGraphEnsureWatcherBound binds the repo-change listener once and repaints into the CURRENT #ws-body, not whichever body was live when it first bound', async () => {
  const modulePath = path.join(__dirname, '../public/project-git-graph-view.js');
  delete require.cache[modulePath];

  let bindCount = 0;
  let watcherCallback = null;
  const bodyFromFirstRender = fakeElement();
  const bodyAfterTabSwitch = fakeElement();
  let currentBody = bodyFromFirstRender;

  global.document = {
    addEventListener() {}, removeEventListener() {},
    getElementById: (id) => (id === 'ws-body' ? currentBody : null),
  };
  global.window = {
    api: {
      onGitGraphRepoChanged: (cb) => { watcherCallback = cb; bindCount++; },
      getProjectGitGraph: () => Promise.resolve({ ok: true, commits: [], refs: { heads: [], remotes: [], tags: [] }, hasMore: false }),
    },
  };
  const project = { id: 'proj-watcher-rebind' };
  global.selectedProject = () => project;
  global.projectTab = () => 'gitgraph';

  const freshView = require(modulePath);
  try {
    const state = freshView.gitGraphState(project.id);
    state.repositories = [{ path: '/repo', git: true }];
    state.selectedRepo = '/repo';

    // Simulating the tab being opened, then left and reopened (renderProjectGitGraphTab
    // calls this on every render): only the FIRST call may actually register.
    freshView.gitGraphEnsureWatcherBound();
    freshView.gitGraphEnsureWatcherBound();
    freshView.gitGraphEnsureWatcherBound();
    assert.equal(bindCount, 1, 'a second/third render must not add a second listener');
    assert.equal(typeof watcherCallback, 'function');

    // The tab's own #ws-body element gets recreated on a tab switch (it is
    // never removed, per gitGraphStillActive's own reasoning) — simulate
    // that by pointing document.getElementById('ws-body') at a new element,
    // the way the real DOM would after the user left and came back.
    bodyFromFirstRender.innerHTML = 'untouched-by-a-later-event';
    currentBody = bodyAfterTabSwitch;

    watcherCallback('/repo');
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(bodyFromFirstRender.innerHTML, 'untouched-by-a-later-event', 'the stale first-render body must never be repainted into');
    assert.match(bodyAfterTabSwitch.innerHTML, /gg-tab-shell/, 'the watcher must resolve and repaint into the CURRENT #ws-body');
  } finally {
    delete require.cache[modulePath];
  }
});
