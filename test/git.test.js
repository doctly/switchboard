const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { spawnSync } = require('child_process');
const git = require('../git');

const haveGit = spawnSync('git', ['--version'], { encoding: 'utf8' }).status === 0;

// A throwaway repository with one commit, so branches and worktrees have
// something to point at. Identity is set locally so the test does not depend
// on the machine's git config.
async function makeRepo() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-git-'));
  await git.run(['init', '-q', '-b', 'main'], repo);
  await git.run(['config', 'user.email', 'test@example.com'], repo);
  await git.run(['config', 'user.name', 'Test'], repo);
  fs.writeFileSync(path.join(repo, 'README.md'), '# hello\n');
  await git.run(['add', 'README.md'], repo);
  await git.run(['commit', '-q', '-m', 'init'], repo);
  return repo;
}

test('repoRoot and isGitRepo tell a checkout from a plain folder', { skip: !haveGit && 'git not installed' }, async () => {
  const repo = await makeRepo();
  const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-plain-'));
  try {
    assert.equal(await git.isGitRepo(repo), true);
    assert.equal(await git.isGitRepo(plain), false);
    assert.equal(fs.realpathSync(await git.repoRoot(path.join(repo))), fs.realpathSync(repo));
    await assert.rejects(git.repoRoot(plain));
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(plain, { recursive: true, force: true });
  }
});

test('worktreeAdd creates the branch once and reuses it; remove keeps the branch', { skip: !haveGit && 'git not installed' }, async () => {
  const repo = await makeRepo();
  const target = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-wt-')), 'repos', 'app');
  try {
    assert.equal(await git.branchExists(repo, 'feature-x'), false);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    await git.worktreeAdd(repo, target, 'feature-x');
    assert.ok(fs.existsSync(path.join(target, 'README.md')), 'checkout populated');
    assert.equal((await git.status(target)).branch, 'feature-x');
    assert.equal(await git.branchExists(repo, 'feature-x'), true);
    assert.equal(fs.realpathSync(await git.gitCommonDir(target)), fs.realpathSync(path.join(repo, '.git')));

    await git.worktreeRemove(repo, target);
    assert.ok(!fs.existsSync(target), 'worktree directory removed');
    assert.equal(await git.branchExists(repo, 'feature-x'), true, 'branch survives removal');

    // Second attach of the same branch checks out the existing branch.
    await git.worktreeAdd(repo, target, 'feature-x');
    assert.equal((await git.status(target)).branch, 'feature-x');
  } finally {
    try { await git.worktreeRemove(repo, target, { force: true }); } catch {}
    fs.rmSync(path.dirname(path.dirname(target)), { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('a dirty worktree is refused without force and reported as dirty', { skip: !haveGit && 'git not installed' }, async () => {
  const repo = await makeRepo();
  const target = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-wt-')), 'app');
  try {
    await git.worktreeAdd(repo, target, 'wip');
    assert.equal((await git.status(target)).dirty, false);
    fs.writeFileSync(path.join(target, 'notes.txt'), 'unsaved\n');
    assert.equal((await git.status(target)).dirty, true);
    let caught = null;
    try { await git.worktreeRemove(repo, target); } catch (err) { caught = err; }
    assert.ok(caught, 'refused');
    assert.equal(git.isDirtyWorktreeError(caught), true);
    assert.ok(fs.existsSync(target), 'still there');
    await git.worktreeRemove(repo, target, { force: true });
    assert.ok(!fs.existsSync(target));
  } finally {
    try { await git.worktreeRemove(repo, target, { force: true }); } catch {}
    fs.rmSync(path.dirname(target), { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('snapshot reports the branch, working changes, line counts, and recent commits', { skip: !haveGit && 'git not installed' }, async () => {
  const repo = await makeRepo();
  try {
    fs.writeFileSync(path.join(repo, 'README.md'), '# hello\n\nChanged here.\n');
    fs.writeFileSync(path.join(repo, 'notes.txt'), 'one\ntwo\n');

    const info = await git.snapshot(repo);
    assert.equal(info.git, true);
    assert.equal(info.branch, 'main');
    assert.equal(info.detached, false);
    assert.equal(info.dirty, true);
    assert.equal(info.changes.length, 2);
    assert.equal(info.changes.find(change => change.path === 'README.md').status, 'modified');
    assert.equal(info.changes.find(change => change.path === 'notes.txt').status, 'untracked');
    assert.ok(info.stats.insertions >= 4);
    assert.equal(info.commits[0].subject, 'init');
    assert.equal(info.commits[0].author, 'Test');
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('fileDiff reads tracked and untracked changes but refuses unchanged files', { skip: !haveGit && 'git not installed' }, async () => {
  const repo = await makeRepo();
  try {
    fs.writeFileSync(path.join(repo, 'README.md'), '# changed\n');
    fs.writeFileSync(path.join(repo, 'new file.txt'), 'new line\n');

    const tracked = await git.fileDiff(repo, 'README.md');
    assert.match(tracked.diff, /[-]# hello/);
    assert.match(tracked.diff, /[+]# changed/);

    const untracked = await git.fileDiff(repo, 'new file.txt');
    assert.match(untracked.diff, /[+]new line/);

    await assert.rejects(git.fileDiff(repo, 'missing.txt'), /not currently changed/);
    await assert.rejects(git.fileDiff(repo, '../outside.txt'), /outside the repository/);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('snapshot preserves rename paths from porcelain output', { skip: !haveGit && 'git not installed' }, async () => {
  const repo = await makeRepo();
  try {
    await git.run(['mv', 'README.md', 'README-new.md'], repo);
    const info = await git.snapshot(repo);
    assert.equal(info.changes.length, 1);
    assert.equal(info.changes[0].status, 'renamed');
    assert.equal(info.changes[0].path, 'README-new.md');
    assert.equal(info.changes[0].oldPath, 'README.md');
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});
