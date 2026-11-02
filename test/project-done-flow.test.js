const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../public/projects-view.js'), 'utf8');
const between = (start, end) => source.slice(source.indexOf(start), source.indexOf(end));
const flow = between("/** A project's worktrees, each marked dirty", '/**\n * What is still alive in a project')
  + between('/**\n * Reopening is one click.', '/** Stop every running session and task in a project, after confirming. */');

/** Run toggleProjectDone against stubs. `choice` is what the dialog resolves. */
async function markDone(project, { choice = { deleteWorktrees: false }, dirty = {}, running = false, schedules = [], detach = () => ({ ok: true }) } = {}) {
  const calls = { dialog: 0, updates: [], detached: [], alerts: [], stopped: 0, loaded: 0 };
  const context = vm.createContext({
    window: { api: {
      getProjectGitStatus: async () => ({ ok: true, byPath: Object.fromEntries((project.folders || []).map(f => [f.path, { git: true, dirty: !!dirty[f.path] }])) }),
      updateProject: async (id, patch) => { calls.updates.push({ ...patch }); return { ok: true }; },
      detachProjectFolder: async (id, p, opts) => { calls.detached.push({ path: p, ...opts }); return detach(p, opts); },
    } },
    runningWorkInProject: () => ({ sessions: running ? [{}] : [], tasks: [], busy: [] }),
    anyRunningWork: r => r.sessions.length > 0,
    schedulesForProject: () => schedules,
    confirmMarkDone: async (_p, info) => { calls.dialog++; calls.info = info; return choice; },
    stopRunningWork: async () => { calls.stopped++; },
    alert: msg => calls.alerts.push(msg),
    loadProjects: () => { calls.loaded++; },
  });
  vm.runInContext(flow, context);
  await context.toggleProjectDone(project);
  // Objects made inside the vm have its prototypes; compare plain copies.
  return JSON.parse(JSON.stringify(calls));
}

const withWorktrees = {
  id: 'p1', name: 'Auth', status: 'active',
  folders: [
    { path: '/p/repos/api', mode: 'worktree', branch: 'auth' },
    { path: '/p/repos/web', mode: 'worktree', branch: 'auth' },
    { path: '/src/docs', mode: 'in-place' },
  ],
};

test('a project with nothing to ask about is marked done without a dialog', async () => {
  const calls = await markDone({ id: 'p0', name: 'Plain', status: 'active', folders: [{ path: '/src/docs', mode: 'in-place' }] });
  assert.equal(calls.dialog, 0);
  assert.deepEqual(calls.updates, [{ status: 'done' }]);
  assert.equal(calls.detached.length, 0);
});

test('cancel changes nothing: no stop, no status change, no deletion', async () => {
  const calls = await markDone(withWorktrees, { choice: null, running: true });
  assert.equal(calls.dialog, 1);
  assert.equal(calls.stopped, 0);
  assert.deepEqual(calls.updates, []);
  assert.deepEqual(calls.detached, []);
});

test('keep marks the project done and leaves every worktree attached', async () => {
  const calls = await markDone(withWorktrees, { running: true });
  assert.equal(calls.stopped, 1);
  assert.deepEqual(calls.updates, [{ status: 'done' }]);
  assert.deepEqual(calls.detached, []);
  assert.deepEqual(calls.alerts, []);
});

test('the dialog is told which worktrees have uncommitted changes', async () => {
  const calls = await markDone(withWorktrees, { dirty: { '/p/repos/web': true } });
  assert.deepEqual(calls.info.worktrees, [
    { path: '/p/repos/api', branch: 'auth', dirty: false },
    { path: '/p/repos/web', branch: 'auth', dirty: true },
  ]);
});

test('delete removes every worktree, forcing only the ones shown as dirty', async () => {
  const calls = await markDone(withWorktrees, { choice: { deleteWorktrees: true }, dirty: { '/p/repos/web': true } });
  assert.deepEqual(calls.updates, [{ status: 'done' }]);
  assert.deepEqual(calls.detached, [
    { path: '/p/repos/api', removeWorktree: true, force: false },
    { path: '/p/repos/web', removeWorktree: true, force: true },
  ]);
  assert.deepEqual(calls.alerts, []);
});

test('worktrees that could not be deleted are reported once, together', async () => {
  const calls = await markDone(withWorktrees, {
    choice: { deleteWorktrees: true },
    detach: () => ({ error: 'Could not remove the worktree: dirty', dirty: true }),
  });
  assert.equal(calls.detached.length, 2, 'no retry with force behind the user\'s back');
  assert.equal(calls.alerts.length, 1);
  assert.match(calls.alerts[0], /2 worktrees were not deleted/);
});

test('reopening is one click', async () => {
  const calls = await markDone({ ...withWorktrees, status: 'done' });
  assert.equal(calls.dialog, 0);
  assert.deepEqual(calls.updates, [{ status: 'active' }]);
});
