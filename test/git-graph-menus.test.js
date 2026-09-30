const test = require('node:test');
const assert = require('node:assert/strict');

// git-graph-menus.js is a plain browser-global script (no bundler); it reads
// `window`, `PICONS` and the shared `showContextMenu` as bare globals, so
// tests stub those on Node's `global` before requiring it, the same way
// other renderer-logic tests in this repo stub `document`/`window`.
global.PICONS = { check: () => '<svg data-icon="check"></svg>' };
global.showContextMenu = (items, position) => { global.showContextMenu.calls.push({ items, position }); };
global.showContextMenu.calls = [];
global.window = { api: {} };

const menus = require('../public/git-graph-menus');

function resetWindowApi() {
  global.showContextMenu.calls = [];
  global.window.api = { writeClipboard: (text) => { global.window.api.writeClipboard.calls.push(text); } };
  global.window.api.writeClipboard.calls = [];
}

function labels(items) { return items.filter(i => !i.sep).map(i => i.label); }

function fakeEl(attrs, parent = null) {
  return {
    getAttribute(name) { return Object.prototype.hasOwnProperty.call(attrs, name) ? attrs[name] : null; },
    parentElement: parent,
  };
}

// --- Copy-only menus ---

test('commit menu only offers Copy Hash / Copy Subject, no mutating actions', () => {
  resetWindowApi();
  const items = menus.gitGraphBuildCommitMenu({ commit: { hash: 'abc123', shortHash: 'abc123', subject: 'A subject' } });
  assert.deepEqual(labels(items), ['Copy Commit Hash to Clipboard', 'Copy Commit Subject to Clipboard']);
  items[0].onClick();
  items[1].onClick();
  assert.deepEqual(global.window.api.writeClipboard.calls, ['abc123', 'A subject']);
});

test('local/remote branch and tag menus only offer Copy Name', () => {
  resetWindowApi();
  const local = menus.gitGraphBuildLocalBranchMenu({ localBranch: { name: 'main' } });
  assert.deepEqual(labels(local), ['Copy Branch Name to Clipboard']);
  local[0].onClick();

  const remote = menus.gitGraphBuildRemoteBranchMenu({ remoteBranch: { remote: 'origin', name: 'main' } });
  assert.deepEqual(labels(remote), ['Copy Branch Name to Clipboard']);
  remote[0].onClick();

  const tag = menus.gitGraphBuildTagMenu({ tag: { name: 'v1' } });
  assert.deepEqual(labels(tag), ['Copy Tag Name to Clipboard']);
  tag[0].onClick();

  assert.deepEqual(global.window.api.writeClipboard.calls, ['main', 'main', 'v1']);
});

test('file menu offers View Diff, View File at this Revision, and Copy Absolute/Relative Path — nothing mutating', () => {
  resetWindowApi();
  const calls = [];
  const ctx = {
    file: { path: 'a/b.txt', relativePath: 'a/b.txt', absolutePath: '/repo/a/b.txt' },
    onViewDiff: (f) => calls.push(['viewDiff', f.path]),
    onViewFileAtRevision: (f) => calls.push(['viewFileAtRevision', f.path]),
  };
  const items = menus.gitGraphBuildFileMenu(ctx);
  assert.deepEqual(labels(items), [
    'View Diff', 'View File at this Revision',
    'Copy Absolute File Path to Clipboard', 'Copy Relative File Path to Clipboard',
  ]);
  items[0].onClick();
  items[1].onClick();
  items[3].onClick();
  items[4].onClick();
  assert.deepEqual(calls, [['viewDiff', 'a/b.txt'], ['viewFileAtRevision', 'a/b.txt']]);
  assert.deepEqual(global.window.api.writeClipboard.calls, ['/repo/a/b.txt', 'a/b.txt']);
});

test('column header menu only toggles Date/Author/Commit visibility, no order radios', () => {
  resetWindowApi();
  const calls = [];
  const ctx = { columnHeader: { columnVisibility: { date: true, author: false, commit: true } }, onColumnVisibilityChange: (col, visible) => calls.push([col, visible]) };
  const items = menus.gitGraphBuildColumnHeaderMenu(ctx);
  assert.deepEqual(labels(items), ['Date', 'Author', 'Commit']);
  assert.equal(items[0].checked, true);
  assert.equal(items[1].checked, false);
  items[1].onClick();
  assert.deepEqual(calls, [['author', true]]);
});

// --- Combined local+remote pill dual hit-region routing ---

test('a click on the local-name region of a combined pill opens the local-branch menu', () => {
  resetWindowApi();
  const row = fakeEl({ 'data-gg-kind': 'commit', 'data-gg-hash': 'h' });
  const localRegion = fakeEl({ 'data-gg-kind': 'branch', 'data-gg-ref-name': 'main', 'data-gg-ref-type': 'local' }, row);
  const ctx = { localBranch: { name: 'main', hash: 'h' } };
  const items = menus.gitGraphBuildMenuItems(localRegion, ctx);
  assert.deepEqual(labels(items), ['Copy Branch Name to Clipboard']);
});

test('a click on the remote-qualified region of a combined pill opens the remote-branch menu, never the local one', () => {
  resetWindowApi();
  const row = fakeEl({ 'data-gg-kind': 'commit', 'data-gg-hash': 'h' });
  const remoteRegion = fakeEl({ 'data-gg-kind': 'remote-branch', 'data-gg-ref-name': 'main', 'data-gg-remote': 'origin', 'data-gg-ref-type': 'remote' }, row);
  const ctx = { remoteBranch: { remote: 'origin', name: 'main', hash: 'h' } };
  const items = menus.gitGraphBuildMenuItems(remoteRegion, ctx);
  assert.deepEqual(labels(items), ['Copy Branch Name to Clipboard']);
});

test('a plain (non-combined) branch region with no ref-type still opens the local-branch menu', () => {
  resetWindowApi();
  const el = fakeEl({ 'data-gg-kind': 'branch', 'data-gg-ref-name': 'main' });
  const ctx = { localBranch: { name: 'main', hash: 'h' } };
  const items = menus.gitGraphBuildMenuItems(el, ctx);
  assert.deepEqual(labels(items), ['Copy Branch Name to Clipboard']);
});

test('gitGraphReadTargetAttrs walks up to the nearest ancestor carrying data-gg-kind', () => {
  const row = fakeEl({ 'data-gg-kind': 'commit', 'data-gg-hash': 'deadbeef' });
  const inner = fakeEl({}, row); // e.g. a click landing on the <span> text inside the row
  const attrs = menus.gitGraphReadTargetAttrs(inner);
  assert.equal(attrs.kind, 'commit');
  assert.equal(attrs.hash, 'deadbeef');
});

test('gitGraphShowContextMenu opens the resolved item list via the shared showContextMenu', () => {
  resetWindowApi();
  const el = fakeEl({ 'data-gg-kind': 'tag', 'data-gg-ref-name': 'v1' });
  const items = menus.gitGraphShowContextMenu(el, { tag: { name: 'v1' } }, { x: 1, y: 2 });
  assert.equal(global.showContextMenu.calls.length, 1);
  assert.deepEqual(global.showContextMenu.calls[0].items, items);
  assert.deepEqual(global.showContextMenu.calls[0].position, { x: 1, y: 2 });
});

test('an unknown or unmenued data-gg-kind (e.g. stash, uncommitted) resolves to no menu and calls showContextMenu zero times', () => {
  resetWindowApi();
  for (const kind of ['something-new', 'stash', 'uncommitted', 'link']) {
    const el = fakeEl({ 'data-gg-kind': kind });
    const items = menus.gitGraphShowContextMenu(el, {}, { x: 0, y: 0 });
    assert.equal(items, null, `expected no menu for kind=${kind}`);
  }
  assert.equal(global.showContextMenu.calls.length, 0);
});
