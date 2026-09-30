const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../public/project-git-view.js'), 'utf8');

/** public/project-git-view.js only defines functions and a Map at top level, so it loads whole in a vm context given the same globals the renderer provides. */
function loadContext(localStorageImpl) {
  const context = vm.createContext({
    document: { createElement: () => ({
      dataset: {},
      focus() { context.focused = this; },
      style: { setProperty() {} },
      classList: { add() {}, remove() {}, toggle() {} },
      setAttribute() {},
      appendChild() {},
      querySelectorAll: () => [],
    }) },
    window: { api: {} },
    escapeHtml: (str) => String(str),
    pathBasename: (p) => String(p).split(/[\\/]/).filter(Boolean).pop() || '',
    formatDate: () => 'just now',
    PICONS: {
      branch: () => '<svg data-icon="branch"></svg>',
      list: () => '<svg data-icon="list"></svg>',
      tree: () => '<svg data-icon="tree"></svg>',
      folder: () => '<svg data-icon="folder"></svg>',
      chevronDown: () => '<svg data-icon="chevron-down"></svg>',
      chevronRight: () => '<svg data-icon="chevron-right"></svg>',
    },
    localStorage: localStorageImpl || { getItem() { return null; }, setItem() {} },
  });
  vm.runInContext(source, context);
  return context;
}

function change(p, extra) {
  return Object.assign({ path: p, status: 'modified' }, extra);
}

// Values built inside the vm context are objects of that realm (its own
// Array/Object), so deepStrictEqual against a plain literal here would fail
// on prototype identity alone. A JSON round-trip normalizes to this realm.
function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

test('buildGitChangeTree nests by folder, sorting folders before files, natural + case-insensitive', () => {
  const ctx = loadContext();
  const changes = [
    change('src/b.js'),
    change('src/A.js'),
    change('readme.md'),
    change('src/file10.js'),
    change('src/file2.js'),
    change('assets/logo.png'),
  ];
  const tree = ctx.buildGitChangeTree(changes);

  assert.deepEqual(plain(tree.map(n => [n.kind, n.name])), [
    ['folder', 'assets'],
    ['folder', 'src'],
    ['file', 'readme.md'],
  ]);

  const src = tree.find(n => n.name === 'src');
  assert.deepEqual(plain(src.children.map(n => n.name)), ['A.js', 'b.js', 'file2.js', 'file10.js']);
});

test('root-level files with no folder appear as plain file nodes', () => {
  const ctx = loadContext();
  const tree = ctx.buildGitChangeTree([change('package.json'), change('README.md')]);
  assert.deepEqual(plain(tree.map(n => n.kind)), ['file', 'file']);
  // Case-insensitive natural order: "package.json" vs "README.md" -> p < r.
  assert.deepEqual(plain(tree.map(n => n.name)), ['package.json', 'README.md']);
});

test('compacts a folder chain of single children into one row, but not a folder with files or several subfolders', () => {
  const ctx = loadContext();
  const changes = [
    change('backend/docs/ai-engine/notes.md'),
    change('frontend/src/app.js'),
    change('frontend/test/app.test.js'),
    change('shared/util.js'),
    change('shared/lib/helpers.js'),
  ];
  const tree = ctx.buildGitChangeTree(changes);

  const backend = tree.find(n => n.name.startsWith('backend'));
  assert.equal(backend.name, 'backend/docs/ai-engine');
  assert.equal(backend.children.length, 1);
  assert.equal(backend.children[0].kind, 'file');

  // frontend has two subfolders (src, test) -> not compacted.
  const frontend = tree.find(n => n.name === 'frontend');
  assert.equal(frontend.name, 'frontend');
  assert.deepEqual(plain(frontend.children.map(c => c.name)), ['src', 'test']);

  // shared has a file (util.js) alongside a subfolder (lib/) -> not compacted.
  const shared = tree.find(n => n.name === 'shared');
  assert.equal(shared.name, 'shared');
  assert.deepEqual(plain(shared.children.map(c => [c.kind, c.name])), [['folder', 'lib'], ['file', 'util.js']]);
});

test('renamed files are placed at their new path (change.path), not the old one', () => {
  const ctx = loadContext();
  const tree = ctx.buildGitChangeTree([
    change('new/location/file.js', { status: 'renamed', oldPath: 'old/spot/file.js' }),
  ]);
  assert.equal(tree.length, 1);
  assert.equal(tree[0].name, 'new/location');
  assert.equal(tree[0].children[0].change.path, 'new/location/file.js');
  assert.equal(tree[0].children[0].change.oldPath, 'old/spot/file.js');
});

test('gitTreeRows flattens with depth and group-seeded keys', () => {
  const ctx = loadContext();
  const tree = ctx.buildGitChangeTree([
    change('a/b/one.js'),
    change('a/b/two.js'),
    change('a/c.js'),
  ]);
  const rows = ctx.gitTreeRows(tree, new Set(), 'modified');
  assert.deepEqual(plain(rows.map(r => [r.kind, r.name, r.depth])), [
    ['folder', 'a', 0],
    ['folder', 'b', 1],
    ['file', 'one.js', 2],
    ['file', 'two.js', 2],
    ['file', 'c.js', 1],
  ]);
  const aRow = rows.find(r => r.name === 'a');
  const bRow = rows.find(r => r.name === 'b');
  assert.equal(aRow.key, 'modified/a');
  assert.equal(bRow.key, 'modified/a/b');
  // a's count must recurse through subfolder b (2 files) plus its own c.js.
  assert.equal(aRow.count, 3);
  assert.equal(bRow.count, 2);
});

test('a collapsed folder hides its descendants but keeps its own row', () => {
  const ctx = loadContext();
  const tree = ctx.buildGitChangeTree([
    change('a/b/one.js'),
    change('a/b/two.js'),
    change('a/c.js'),
  ]);
  const allRows = ctx.gitTreeRows(tree, new Set(), 'modified');
  const bKey = allRows.find(r => r.name === 'b').key;

  const collapsed = new Set([bKey]);
  const rows = ctx.gitTreeRows(tree, collapsed, 'modified');
  assert.deepEqual(plain(rows.map(r => r.name)), ['a', 'b', 'c.js']);
  const bRow = rows.find(r => r.name === 'b');
  assert.equal(bRow.collapsed, true);
  assert.equal(bRow.count, 2);
});

test('gitChangesViewMode reads the stored mode and falls back to "tree" for missing, invalid, or throwing storage', () => {
  assert.equal(loadContext({ getItem() { return null; }, setItem() {} }).gitChangesViewMode(), 'tree');
  assert.equal(loadContext({ getItem() { return 'nonsense'; }, setItem() {} }).gitChangesViewMode(), 'tree');
  assert.equal(loadContext({ getItem() { throw new Error('blocked'); }, setItem() {} }).gitChangesViewMode(), 'tree');
  assert.equal(loadContext({ getItem() { return 'list'; }, setItem() {} }).gitChangesViewMode(), 'list');
});

test('setGitChangesViewMode swallows a throwing localStorage', () => {
  const ctx = loadContext({ getItem() { return null; }, setItem() { throw new Error('blocked'); } });
  assert.doesNotThrow(() => ctx.setGitChangesViewMode('tree'));
});

// --- paintGitChanges: exercises the actual list/tree render dispatch and
// the folder-row click wiring, not just the pure tree helpers above. ---

/** Minimal '#git-file-list' stand-in: just enough for paintGitChanges/createGitFileRow to append rows to and query them back. */
function fakeList() {
  const children = [];
  return {
    children,
    replaceChildren() { children.length = 0; },
    appendChild(el) { children.push(el); },
    querySelectorAll(selector) {
      if (selector !== '.git-file-row') return [];
      return children.filter(el => typeof el.className === 'string' && el.className.split(' ').includes('git-file-row'));
    },
  };
}

/** Minimal 'body' stand-in dispatching the two selectors paintGitChanges/paintGitDiff query for. */
function fakeBody(list, diffPane) {
  return {
    isConnected: true,
    querySelector(selector) {
      if (selector === '#git-file-list') return list;
      if (selector === '#git-diff-pane') return diffPane || null;
      return null;
    },
    querySelectorAll(selector) {
      return selector === '.git-folder-row' ? list.children.filter(el => String(el.className).split(' ').includes('git-folder-row')) : [];
    },
  };
}

test('paintGitChanges renders a flat list in "list" mode and a folder tree in "tree" mode', () => {
  const changes = [change('a/b/one.js'), change('a/b/two.js'), change('a/c.js'), change('readme.md')];
  const repo = { path: '/repo', changes };

  const listCtx = loadContext({ getItem() { return 'list'; }, setItem() {} });
  const list1 = fakeList();
  listCtx.paintGitChanges({ id: 'p' }, listCtx.gitTabState('p'), repo, fakeBody(list1));
  assert.equal(list1.children.some(c => c.className === 'git-folder-row'), false);
  assert.equal(list1.children.filter(c => typeof c.className === 'string' && c.className.includes('git-file-row')).length, 4);

  const treeCtx = loadContext({ getItem() { return 'tree'; }, setItem() {} });
  const list2 = fakeList();
  treeCtx.paintGitChanges({ id: 'p' }, treeCtx.gitTabState('p'), repo, fakeBody(list2));
  assert.equal(list2.children.some(c => c.className === 'git-folder-row'), true);
});

test('paintGitChanges only repaints the diff pane when repaintDiff is not false', () => {
  const ctx = loadContext();
  const repo = { path: '/repo', changes: [change('a.js')] };
  const state = ctx.gitTabState('p');
  state.selectedFiles.set(repo.path, 'a.js');
  state.diffs.set('/repo\u0000a.js', { diff: '+hello' });
  const diffPane = { dataset: {}, innerHTML: 'UNTOUCHED' };
  const body = fakeBody(fakeList(), diffPane);

  ctx.paintGitChanges({ id: 'p' }, state, repo, body, { repaintDiff: false });
  assert.equal(diffPane.innerHTML, 'UNTOUCHED');

  ctx.paintGitChanges({ id: 'p' }, state, repo, body);
  assert.notEqual(diffPane.innerHTML, 'UNTOUCHED');
});

test("a folder row's onclick toggles its collapsed state and repaints only the list, leaving the diff pane untouched", () => {
  const ctx = loadContext({ getItem() { return 'tree'; }, setItem() {} });
  const repo = { path: '/repo', changes: [change('a/b/one.js'), change('a/b/two.js'), change('a/c.js')] };
  const state = ctx.gitTabState('p');
  state.selectedFiles.set(repo.path, 'a/c.js');
  state.diffs.set('/repo\u0000a/c.js', { diff: '+x' });
  const list = fakeList();
  const diffPane = { dataset: {}, innerHTML: '' };
  const body = fakeBody(list, diffPane);

  ctx.paintGitChanges({ id: 'p' }, state, repo, body);
  const paintedDiff = diffPane.innerHTML;
  assert.notEqual(paintedDiff, '');

  // Folder 'a' (the outermost, first-rendered folder row) collapsed.
  const folderRowA = list.children.find(c => c.className === 'git-folder-row');
  assert.ok(folderRowA);
  folderRowA.onclick();

  assert.equal(diffPane.innerHTML, paintedDiff);
  // The selected file (a/c.js) is now hidden, so its folder is highlighted instead.
  assert.deepEqual(list.children.map(c => c.className), ['git-file-group', 'git-folder-row selected']);
  // The rebuilt row for the same folder gets keyboard focus back.
  assert.notEqual(ctx.focused, folderRowA);
  assert.equal(ctx.focused, list.children[1]);
  assert.equal(ctx.focused.dataset.key, folderRowA.dataset.key);
});

test('tree rows show the tree node name (backslashes included) and keep the staged state visible', () => {
  const ctx = loadContext({ getItem() { return 'tree'; }, setItem() {} });
  const repo = { path: '/repo', changes: [change('docs/a\\b.md', { indexStatus: 'M', worktreeStatus: ' ' }), change('docs/other.md', { indexStatus: ' ', worktreeStatus: 'M' })] };
  const list = fakeList();
  ctx.paintGitChanges({ id: 'p' }, ctx.gitTabState('p'), repo, fakeBody(list));
  const rows = list.children.filter(c => typeof c.className === 'string' && c.className.includes('git-file-row'));
  const backslash = rows.find(r => r.innerHTML.includes('a\\b.md'));
  assert.ok(backslash, 'the full node name is shown, not what follows the backslash');
  assert.match(backslash.innerHTML, /git-file-meta">Staged</);
  assert.ok(rows.some(r => /git-file-meta">Unstaged</.test(r.innerHTML)));
});

test('a collapsed folder that hides the selected file is highlighted in its place', () => {
  const ctx = loadContext({ getItem() { return 'tree'; }, setItem() {} });
  const repo = { path: '/repo', changes: [change('src/a.js'), change('src/b.js'), change('top.js')] };
  const state = ctx.gitTabState('p');
  state.selectedFiles.set(repo.path, 'src/b.js');
  ctx.gitCollapsedSet(state, repo.path).add('modified/src');
  const list = fakeList();
  ctx.paintGitChanges({ id: 'p' }, state, repo, fakeBody(list), { repaintDiff: false });
  const folder = list.children.find(c => typeof c.className === 'string' && c.className.startsWith('git-folder-row'));
  assert.equal(folder.className, 'git-folder-row selected');
});
