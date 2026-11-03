// The git helpers behind the Worktrees tab, against throwaway repositories.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { spawnSync } = require('child_process');
const git = require('../git');

const haveGit = spawnSync('git', ['--version'], { encoding: 'utf8' }).status === 0;
const skip = !haveGit && 'git not installed';

// A repository with one commit inside its own temp folder, so worktrees can
// sit next to it the way the Worktrees tab places them (<repo>.worktrees/…).
async function makeRepo() {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-wtgit-')));
  const repo = path.join(base, 'app');
  fs.mkdirSync(repo);
  await git.run(['init', '-q', '-b', 'main'], repo);
  await git.run(['config', 'user.email', 'test@example.com'], repo);
  await git.run(['config', 'user.name', 'Test'], repo);
  fs.writeFileSync(path.join(repo, 'README.md'), '# hello\n');
  await git.run(['add', 'README.md'], repo);
  await git.run(['commit', '-q', '-m', 'init'], repo);
  return { base, repo, cleanup: () => fs.rmSync(base, { recursive: true, force: true }) };
}

async function commit(dir, message) {
  fs.writeFileSync(path.join(dir, `${message.replace(/\W+/g, '-')}.txt`), message + '\n');
  await git.run(['add', '-A'], dir);
  await git.run(['commit', '-q', '-m', message], dir);
}

test('parseWorktreeList reads every porcelain field, main worktree first', () => {
  const output = [
    'worktree /repo', 'HEAD 1111111111111111111111111111111111111111', 'branch refs/heads/main', '',
    'worktree /repo.worktrees/feat', 'HEAD 2222222222222222222222222222222222222222', 'branch refs/heads/feat/x', '',
    'worktree /repo.worktrees/det', 'HEAD 3333333333333333333333333333333333333333', 'detached', 'locked on usb stick', '',
    'worktree /gone', 'HEAD 4444444444444444444444444444444444444444', 'branch refs/heads/old', 'locked',
    'prunable gitdir file points to non-existent location', '',
  ].join('\0');
  const list = git.parseWorktreeList(output);
  assert.equal(list.length, 4);
  assert.deepEqual(list.map(item => item.isMain), [true, false, false, false]);
  assert.equal(list[0].branch, 'main');
  assert.equal(list[1].branch, 'feat/x', 'refs/heads/ is dropped, slashes kept');
  assert.equal(list[2].detached, true);
  assert.equal(list[2].branch, '');
  assert.equal(list[2].locked, true);
  assert.equal(list[2].lockReason, 'on usb stick');
  assert.equal(list[3].locked, true);
  assert.equal(list[3].lockReason, '', 'a bare "locked" has no reason');
  assert.equal(list[3].prunable, true);
  assert.match(list[3].prunableReason, /non-existent/);
});

test('parseWorktreeList handles a bare repository and a path with spaces', () => {
  const output = ['worktree /srv/repo.git', 'bare', '', 'worktree /work/my app', 'HEAD abc', 'branch refs/heads/dev', '', ''].join('\0');
  const list = git.parseWorktreeList(output);
  assert.equal(list.length, 2);
  assert.equal(list[0].bare, true);
  assert.equal(list[0].isMain, true);
  assert.equal(list[1].path, '/work/my app');
  assert.deepEqual(git.parseWorktreeList(''), []);
});

test('worktreeList lists, locks, unlocks, moves and flags a missing worktree as prunable', { skip }, async () => {
  const { base, repo, cleanup } = await makeRepo();
  const feat = path.join(base, 'app.worktrees', 'feat');
  const det = path.join(base, 'app.worktrees', 'det');
  const gone = path.join(base, 'app.worktrees', 'gone');
  try {
    await git.worktreeAdd(repo, feat, 'feat');
    await git.worktreeAdd(repo, det, '', { detach: true });
    await git.worktreeAdd(repo, gone, 'gone');
    await git.worktreeLock(repo, det, 'kept for the demo');
    fs.rmSync(gone, { recursive: true, force: true });

    let list = await git.worktreeList(repo);
    const byPath = new Map(list.map(item => [item.path, item]));
    assert.equal(list[0].path, repo);
    assert.equal(list[0].isMain, true);
    assert.equal(byPath.get(feat).branch, 'feat');
    assert.equal(byPath.get(det).detached, true);
    assert.equal(byPath.get(det).lockReason, 'kept for the demo');
    assert.equal(byPath.get(gone).prunable, true);

    // The same list comes back from inside any worktree.
    assert.deepEqual((await git.worktreeList(feat)).map(item => item.path), list.map(item => item.path));

    // A locked worktree cannot move; once unlocked it can.
    const moved = path.join(base, 'app.worktrees', 'det-moved');
    await assert.rejects(git.worktreeMove(repo, det, moved), /locked/);
    await git.worktreeUnlock(repo, det);
    await git.worktreeMove(repo, det, moved);
    list = await git.worktreeList(repo);
    assert.ok(list.some(item => item.path === moved));
    assert.ok(!list.some(item => item.path === det));
  } finally {
    cleanup();
  }
});

test('worktreePrune previews with dryRun and then drops the missing worktree', { skip }, async () => {
  const { base, repo, cleanup } = await makeRepo();
  const gone = path.join(base, 'app.worktrees', 'gone');
  try {
    await git.worktreeAdd(repo, gone, 'gone');
    fs.rmSync(gone, { recursive: true, force: true });
    const preview = await git.worktreePrune(repo, { dryRun: true });
    assert.deepEqual(preview.map(item => item.name), ['gone']);
    assert.equal((await git.worktreeList(repo)).length, 2, 'dry run changed nothing');
    await git.worktreePrune(repo);
    assert.equal((await git.worktreeList(repo)).length, 1);
    assert.deepEqual(await git.worktreePrune(repo, { dryRun: true }), []);
  } finally {
    cleanup();
  }
});

test('worktreeRepair reconnects a worktree whose folder was moved by hand', { skip }, async () => {
  const { base, repo, cleanup } = await makeRepo();
  const feat = path.join(base, 'app.worktrees', 'feat');
  const elsewhere = path.join(base, 'elsewhere');
  try {
    await git.worktreeAdd(repo, feat, 'feat');
    fs.renameSync(feat, elsewhere);
    assert.equal((await git.worktreeList(repo)).find(item => item.branch === 'feat').prunable, true);
    await git.worktreeRepair(repo, [elsewhere]);
    const repaired = (await git.worktreeList(repo)).find(item => item.branch === 'feat');
    assert.equal(repaired.path, elsewhere);
    assert.equal(repaired.prunable, false);
  } finally {
    cleanup();
  }
});

test('worktreeAdd starts a new branch at a start point without tracking it, or tracks a remote branch', { skip }, async () => {
  const { base, repo, cleanup } = await makeRepo();
  const clone = path.join(base, 'clone');
  try {
    await commit(repo, 'second');
    const first = await git.run(['rev-parse', 'HEAD~1'], repo);
    const fromFirst = path.join(base, 'app.worktrees', 'from-first');
    await git.worktreeAdd(repo, fromFirst, 'from-first', { startPoint: first });
    assert.equal(await git.run(['rev-parse', 'HEAD'], fromFirst), first);
    assert.equal((await git.status(fromFirst)).branch, 'from-first');

    // A clone sees "main" only as origin/main; tracking it makes a local branch.
    await git.run(['clone', '-q', repo, clone], base);
    await git.run(['branch', '-q', 'remote-only'], repo);
    await git.run(['fetch', '-q', 'origin'], clone);
    const tracked = path.join(base, 'clone.worktrees', 'remote-only');
    await git.worktreeAdd(clone, tracked, 'remote-only', { startPoint: 'origin/remote-only', track: true, createBranch: true });
    assert.equal(await git.run(['rev-parse', '--abbrev-ref', '@{upstream}'], tracked), 'origin/remote-only');

    const untracked = path.join(base, 'clone.worktrees', 'feature');
    await git.worktreeAdd(clone, untracked, 'feature', { startPoint: 'origin/main' });
    await assert.rejects(git.run(['rev-parse', '--abbrev-ref', '@{upstream}'], untracked));

    await assert.rejects(git.worktreeAdd(repo, path.join(base, 'x'), '--force'), /cannot start with/);
    await assert.rejects(git.worktreeAdd(repo, path.join(base, 'y'), 'ok', { startPoint: '-q' }), /cannot start with/);
  } finally {
    cleanup();
  }
});

test('deleteBranch refuses an unmerged branch without force; mergedBranches and defaultBranch', { skip }, async () => {
  const { base, repo, cleanup } = await makeRepo();
  try {
    await git.run(['branch', 'merged-one'], repo);
    const wip = path.join(base, 'app.worktrees', 'wip');
    await git.worktreeAdd(repo, wip, 'wip');
    await commit(wip, 'work in progress');
    await git.worktreeRemove(repo, wip);

    assert.deepEqual((await git.mergedBranches(repo, 'main')).sort(), ['main', 'merged-one']);
    assert.equal(await git.defaultBranch(repo), 'main');

    let caught = null;
    try { await git.deleteBranch(repo, 'wip'); } catch (err) { caught = err; }
    assert.ok(caught);
    assert.equal(git.isUnmergedBranchError(caught), true);
    await git.deleteBranch(repo, 'wip', { force: true });
    await git.deleteBranch(repo, 'merged-one');
    assert.equal(await git.branchExists(repo, 'wip'), false);
    assert.equal(await git.branchExists(repo, 'merged-one'), false);
  } finally {
    cleanup();
  }
});

test('listBranches separates local and remote branches and skips origin/HEAD', { skip }, async () => {
  const { base, repo, cleanup } = await makeRepo();
  const clone = path.join(base, 'clone');
  try {
    await git.run(['branch', 'topic'], repo);
    await git.run(['clone', '-q', repo, clone], base);
    const branches = await git.listBranches(clone);
    assert.deepEqual(branches.local.map(item => item.name), ['main']);
    assert.equal(branches.local[0].upstream, 'origin/main');
    assert.deepEqual(branches.remote.map(item => item.name).sort(), ['origin/main', 'origin/topic']);
    assert.equal(branches.remote[0].remote, 'origin');
    assert.equal(await git.defaultBranch(clone), 'origin/main');
  } finally {
    cleanup();
  }
});

test('isValidBranchName and lastCommit', { skip }, async () => {
  const { repo, cleanup } = await makeRepo();
  try {
    assert.equal(await git.isValidBranchName(repo, 'feat/new-thing'), true);
    assert.equal(await git.isValidBranchName(repo, 'bad name'), false);
    assert.equal(await git.isValidBranchName(repo, '-x'), false);
    assert.equal(await git.isValidBranchName(repo, 'a..b'), false);
    const last = await git.lastCommit(repo);
    assert.equal(last.subject, 'init');
    assert.match(last.hash, /^[0-9a-f]{40}$/);
    assert.ok(Math.abs(Date.now() - last.time) < 60 * 1000);
  } finally {
    cleanup();
  }
});

test('listBranches splits a remote whose name holds a slash', { skip }, async () => {
  const { base, repo, cleanup } = await makeRepo();
  const clone = path.join(base, 'clone');
  try {
    await git.run(['clone', '-q', '--origin', 'team/fork', repo, clone], base);
    const branches = await git.listBranches(clone);
    const main = branches.remote.find(item => item.name === 'team/fork/main');
    assert.ok(main, 'listed');
    assert.equal(main.remote, 'team/fork');
  } finally {
    cleanup();
  }
});

test('worktreeRemove with prune: false leaves other missing worktrees alone', { skip }, async () => {
  const { base, repo, cleanup } = await makeRepo();
  try {
    const keep = path.join(base, 'app.worktrees', 'keep');
    const drop = path.join(base, 'app.worktrees', 'drop');
    await git.worktreeAdd(repo, keep, 'keep');
    await git.worktreeAdd(repo, drop, 'drop');
    fs.rmSync(keep, { recursive: true, force: true });
    await git.worktreeRemove(repo, drop, { prune: false });
    assert.deepEqual((await git.worktreeList(repo)).map(item => item.path), [repo, keep]);
  } finally {
    cleanup();
  }
});
