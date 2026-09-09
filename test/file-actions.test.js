const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function setup(platform = 'darwin') {
  const calls = [];
  const context = vm.createContext({
    window: { api: { platform,
      writeClipboard: value => calls.push(['copy', value]),
      manageProjectEntry: async (...args) => { calls.push(['manage', ...args]); return { ok: true, cancelled: true }; },
    } },
    PICONS: new Proxy({}, { get: () => () => '' }),
    showPromptDialog: async () => null,
    applyProjectFileAction: () => calls.push(['refresh-project']),
    applyBrowserFileAction: () => calls.push(['refresh-browser']),
    alert: message => calls.push(['error', message]),
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/file-actions.js'), 'utf8'), context);
  return { context, calls };
}

test('menus use platform names and offer management for files without previews', () => {
  for (const [platform, manager, trash] of [['darwin', 'Finder', 'Trash'], ['win32', 'Explorer', 'Recycle Bin'], ['linux', 'File Manager', 'Trash']]) {
    const { context } = setup(platform);
    const items = context.fileEntryMenuItems('/project', { name: 'large.zip', relativePath: 'large.zip', type: 'file', viewable: false });
    assert.ok(items.some(item => item.label === 'Reveal in ' + manager));
    assert.ok(items.some(item => item.label === 'Move to ' + trash + '…' && !item.disabled));
    assert.equal(items.find(item => item.label === 'Open in editor / preview').disabled, true);
  }
});

test('cancellation and errors preserve the current views; successful changes refresh both', async () => {
  const { context, calls } = setup();
  const items = context.fileEntryMenuItems('/project', { name: 'notes.md', relativePath: 'notes.md', type: 'file', viewable: true });
  await items.find(item => item.label === 'Rename…').onClick();
  assert.deepEqual(calls, []);
  const trash = items.find(item => item.danger);
  await trash.onClick();
  assert.deepEqual(calls.map(call => call[0]), ['manage']);
  context.window.api.manageProjectEntry = async () => ({ ok: false, error: 'Cannot trash' });
  await trash.onClick();
  assert.deepEqual(calls.at(-1), ['error', 'Cannot trash']);
  context.window.api.manageProjectEntry = async () => ({ ok: true, action: 'trash' });
  await trash.onClick();
  assert.deepEqual(calls.slice(-2), [['refresh-project'], ['refresh-browser']]);
});

test('folder changes remap descendants but preserve similarly named siblings and Windows paths', () => {
  const { context } = setup();
  const change = { projectPath: '/project', relativePath: 'src', filePath: '/project/src', newRelativePath: 'lib', newFilePath: '/project/lib' };
  assert.equal(context.remapFileActionRelative('/project', 'src/app.js', change), 'lib/app.js');
  assert.equal(context.remapFileActionPath('/project/src-other/app.js', change), '/project/src-other/app.js');
  delete change.newRelativePath;
  delete change.newFilePath;
  assert.equal(context.remapFileActionPath('/project/src/app.js', change), null);
  const windows = setup('win32').context;
  assert.equal(windows.projectEntryPath('C:\\project', 'src\\app.js'), 'C:\\project\\src\\app.js');
  const winChange = { projectPath: 'C:\\project', relativePath: 'src', filePath: 'C:\\project\\src', newRelativePath: 'lib', newFilePath: 'C:\\project\\lib' };
  assert.equal(windows.remapFileActionRelative('C:\\project', 'SRC\\app.js', winChange), 'lib\\app.js');
});


test('an unresolved diff blocks file mutations without invoking the backend', async () => {
  const { context, calls } = setup();
  context.canManageBrowserEntry = () => false;
  const items = context.fileEntryMenuItems('/project', { name: 'notes.md', relativePath: 'notes.md', type: 'file', viewable: true });
  await items.find(item => item.danger).onClick();
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'error');
});

test('a directory reply from before a file mutation cannot repopulate the cache', async () => {
  let resolve;
  const context = vm.createContext({
    FILES_LIST_TTL_MS: 10000,
    window: { api: { listProjectDirectory: () => new Promise(done => { resolve = done; }) } },
  });
  const source = fs.readFileSync(path.join(__dirname, '../public/projects-view.js'), 'utf8');
  vm.runInContext(source.slice(source.indexOf('async function listProjectDir('), source.indexOf('async function applyProjectFileAction(')), context);
  const state = { cache: new Map() };
  const request = context.listProjectDir({ root: '/project' }, state, '');
  state.cacheGeneration = 1;
  resolve({ ok: true, entries: [{ name: 'deleted.txt' }] });
  await request;
  assert.equal(state.cache.size, 0);
});
