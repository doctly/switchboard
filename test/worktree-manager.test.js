const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const wt = require('../worktree-manager');

function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-wt-'));
  const run = (args) => execFileSync('git', args, { cwd: dir, windowsHide: true });
  run(['init', '-b', 'main']);
  run(['config', 'user.email', 'test@example.com']);
  run(['config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(dir, 'README.md'), 'hello\n');
  run(['add', '.']);
  run(['commit', '-m', 'init']);
  return dir;
}

const RUN_ID = '2026-06-10-demo-abcd';

test('isGitRepo distinguishes repos from plain dirs', async () => {
  const repo = makeRepo();
  assert.equal(await wt.isGitRepo(repo), true);
  const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-plain-'));
  assert.equal(await wt.isGitRepo(plain), false);
});

test('ensureTaskWorktree creates integration branch, task branch and worktree', async () => {
  const repo = makeRepo();
  const r = await wt.ensureTaskWorktree(repo, RUN_ID, 'T-001', 'teams/demo');
  assert.equal(r.ok, true, r.error);
  assert.equal(r.reused, false);
  assert.ok(fs.existsSync(path.join(r.path, 'README.md')));
  assert.equal(r.branch, `task/${RUN_ID}/T-001`);
  assert.equal(await wt.branchExists(repo, 'teams/demo'), true);
  assert.equal(await wt.branchExists(repo, r.branch), true);

  // idempotent: second call reuses
  const again = await wt.ensureTaskWorktree(repo, RUN_ID, 'T-001', 'teams/demo');
  assert.equal(again.ok, true);
  assert.equal(again.reused, true);

  const list = await wt.listWorktrees(repo);
  assert.equal(list.length, 2); // main checkout + task worktree
  assert.ok(list.some(w => w.branch === r.branch));
});

test('parallel worktrees are isolated from each other', async () => {
  const repo = makeRepo();
  const a = await wt.ensureTaskWorktree(repo, RUN_ID, 'T-00A', 'teams/demo');
  const b = await wt.ensureTaskWorktree(repo, RUN_ID, 'T-00B', 'teams/demo');
  assert.equal(a.ok && b.ok, true);
  fs.writeFileSync(path.join(a.path, 'a.txt'), 'from A\n');
  assert.equal(fs.existsSync(path.join(b.path, 'a.txt')), false);
  assert.equal(fs.existsSync(path.join(repo, 'a.txt')), false);
});

test('removeTaskWorktree removes the dir but keeps the branch', async () => {
  const repo = makeRepo();
  const r = await wt.ensureTaskWorktree(repo, RUN_ID, 'T-002', 'teams/demo');
  assert.equal(r.ok, true);
  const rm = await wt.removeTaskWorktree(repo, RUN_ID, 'T-002');
  assert.equal(rm.ok, true, rm.error);
  assert.equal(rm.removed, true);
  assert.equal(fs.existsSync(r.path), false);
  assert.equal(await wt.branchExists(repo, r.branch), true);
  // removing again is a no-op success
  const rm2 = await wt.removeTaskWorktree(repo, RUN_ID, 'T-002');
  assert.equal(rm2.ok, true);
  assert.equal(rm2.removed, false);
});

test('dirty worktree refuses removal unless forced', async () => {
  const repo = makeRepo();
  const r = await wt.ensureTaskWorktree(repo, RUN_ID, 'T-003', 'teams/demo');
  fs.writeFileSync(path.join(r.path, 'wip.txt'), 'uncommitted\n');
  const rm = await wt.removeTaskWorktree(repo, RUN_ID, 'T-003');
  assert.equal(rm.ok, false);
  const forced = await wt.removeTaskWorktree(repo, RUN_ID, 'T-003', { force: true });
  assert.equal(forced.ok, true);
});

test('re-dispatch reuses the existing task branch (commits survive)', async () => {
  const repo = makeRepo();
  const r1 = await wt.ensureTaskWorktree(repo, RUN_ID, 'T-004', 'teams/demo');
  fs.writeFileSync(path.join(r1.path, 'work.txt'), 'attempt 1\n');
  execFileSync('git', ['add', '.'], { cwd: r1.path });
  execFileSync('git', ['commit', '-m', 'attempt 1'], { cwd: r1.path });
  await wt.removeTaskWorktree(repo, RUN_ID, 'T-004');

  const r2 = await wt.ensureTaskWorktree(repo, RUN_ID, 'T-004', 'teams/demo');
  assert.equal(r2.ok, true, r2.error);
  const content = fs.readFileSync(path.join(r2.path, 'work.txt'), 'utf8').replace(/\r\n/g, '\n');
  assert.equal(content, 'attempt 1\n');
});

test('rejects hostile ids and branch names', async () => {
  const repo = makeRepo();
  assert.equal((await wt.ensureTaskWorktree(repo, '../evil', 'T-1', 'teams/x')).ok, false);
  assert.equal((await wt.ensureTaskWorktree(repo, RUN_ID, 'T 1; rm', 'teams/x')).ok, false);
  assert.equal((await wt.ensureTaskWorktree(repo, RUN_ID, 'T-1', '--upload-pack=evil')).ok, false);
  assert.equal(wt.isValidBranch('teams/ok-1.x'), true);
  assert.equal(wt.isValidBranch('a..b'), false);
  assert.equal(wt.isValidBranch('-flag'), false);
});
