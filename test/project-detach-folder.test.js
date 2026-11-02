const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../public/projects-view.js'), 'utf8');
const between = (start, end) => source.slice(source.indexOf(start), source.indexOf(end));
const flow = between('async function detachFolderFlow', 'async function deleteTrackFlow');

/**
 * Run detachFolderFlow against stubs. `choice` is what the dialog resolves,
 * `results` what each detach call answers in turn, `retry` the answer to the
 * "remove it anyway" question.
 */
async function detach(folder, { choice = { removeWorktree: false }, results = [{ ok: true }], retry = false } = {}) {
  const project = { id: 'p1', name: 'Auth', folders: [folder] };
  const calls = { dialog: 0, detached: [], confirms: [], alerts: [], loaded: 0 };
  const answers = [...results];
  const context = vm.createContext({
    window: { api: {
      detachProjectFolder: async (id, p, opts) => { calls.detached.push({ id, path: p, ...opts }); return answers.shift() || { ok: true }; },
    } },
    confirmDetachFolder: async (p, f) => { calls.dialog++; calls.asked = { project: p.id, folder: f.path }; return choice; },
    confirm: msg => { calls.confirms.push(msg); return retry; },
    alert: msg => calls.alerts.push(msg),
    loadProjects: () => { calls.loaded++; },
  });
  vm.runInContext(flow, context);
  await context.detachFolderFlow(project, folder);
  // Objects made inside the vm have its prototypes; compare plain copies.
  return JSON.parse(JSON.stringify(calls));
}

const plain = { path: '/src/docs', mode: 'in-place' };
const worktree = { path: '/p/repos/api', mode: 'worktree', branch: 'auth' };

test('cancel detaches nothing', async () => {
  for (const folder of [plain, worktree]) {
    const calls = await detach(folder, { choice: null });
    assert.equal(calls.dialog, 1);
    assert.deepEqual(calls.detached, []);
    assert.equal(calls.loaded, 0);
  }
});

test('the dialog is asked about the folder being detached', async () => {
  const calls = await detach(plain);
  assert.deepEqual(calls.asked, { project: 'p1', folder: '/src/docs' });
});

test('a plain folder is detached with nothing removed from disk', async () => {
  const calls = await detach(plain, { choice: { removeWorktree: true } });
  assert.deepEqual(calls.detached, [{ id: 'p1', path: '/src/docs' }]);
  assert.equal(calls.loaded, 1);
});

test('a worktree keeps its checkout unless the dialog says to delete it', async () => {
  assert.deepEqual((await detach(worktree)).detached, [{ id: 'p1', path: '/p/repos/api', removeWorktree: false }]);
  assert.deepEqual((await detach(worktree, { choice: { removeWorktree: true } })).detached,
    [{ id: 'p1', path: '/p/repos/api', removeWorktree: true }]);
});

test('a dirty checkout is forced only after the user agrees', async () => {
  const dirty = { error: 'Could not remove the worktree: it has changes', dirty: true };
  const kept = await detach(worktree, { choice: { removeWorktree: true }, results: [dirty], retry: false });
  assert.equal(kept.confirms.length, 1);
  assert.equal(kept.detached.length, 1);
  assert.deepEqual(kept.alerts, [dirty.error]);
  assert.equal(kept.loaded, 0);

  const forced = await detach(worktree, { choice: { removeWorktree: true }, results: [dirty, { ok: true }], retry: true });
  assert.deepEqual(forced.detached[1], { id: 'p1', path: '/p/repos/api', removeWorktree: true, force: true });
  assert.deepEqual(forced.alerts, []);
  assert.equal(forced.loaded, 1);
});
