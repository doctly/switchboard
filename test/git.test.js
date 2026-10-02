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

// --- Git Graph read functions --------------------------------------------

test('logWithParents reports parent hashes and degrades to [] on an unborn HEAD', { skip: !haveGit && 'git not installed' }, async () => {
  const repo = await makeRepo();
  try {
    fs.writeFileSync(path.join(repo, 'b.txt'), 'b\n');
    await git.run(['add', 'b.txt'], repo);
    await git.run(['commit', '-q', '-m', 'second'], repo);

    const commits = await git.logWithParents(repo);
    assert.equal(commits.length, 2);
    assert.equal(commits[0].subject, 'second');
    assert.equal(commits[0].parents.length, 1);
    assert.equal(commits[1].subject, 'init');
    assert.deepEqual(commits[1].parents, []);
    assert.equal(commits[0].parents[0], commits[1].hash);
    assert.match(commits[0].hash, /^[0-9a-f]{40}$/);
    assert.ok(commits[0].authorEmail.includes('@'));

    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-git-empty-'));
    await git.run(['init', '-q', '-b', 'main'], empty);
    try {
      assert.deepEqual(await git.logWithParents(empty), []);
    } finally {
      fs.rmSync(empty, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('logWithParents reports a merge commit\'s two parents and honours skip/limit', { skip: !haveGit && 'git not installed' }, async () => {
  const repo = await makeRepo();
  try {
    await git.run(['checkout', '-q', '-b', 'topic'], repo);
    fs.writeFileSync(path.join(repo, 'topic.txt'), 'x\n');
    await git.run(['add', 'topic.txt'], repo);
    await git.run(['commit', '-q', '-m', 'topic work'], repo);
    await git.run(['checkout', '-q', 'main'], repo);
    fs.writeFileSync(path.join(repo, 'main.txt'), 'y\n');
    await git.run(['add', 'main.txt'], repo);
    await git.run(['commit', '-q', '-m', 'main work'], repo);
    await git.run(['merge', '--no-ff', '-q', '-m', 'merge topic', 'topic'], repo);

    const all = await git.logWithParents(repo, { revspec: ['--all'] });
    const merge = all.find(c => c.subject === 'merge topic');
    assert.equal(merge.parents.length, 2);

    const paged = await git.logWithParents(repo, { revspec: 'main', skip: 1, limit: 1 });
    assert.equal(paged.length, 1);
    assert.equal(paged[0].subject, 'main work');
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

// Two branch tips off the same parent (so neither is the other's ancestor —
// topology alone doesn't force an order) with author date and commit date
// deliberately pulling in opposite directions, so --date-order and
// --author-date-order are pinned against real out-of-order timestamps, not
// just naturally-ordered fixture commits.
test('logWithParents orders by author date vs. commit date against real out-of-order timestamps', { skip: !haveGit && 'git not installed' }, async () => {
  const repo = await makeRepo();
  const commitWithDates = (branch, message, authorDate, committerDate) => new Promise((resolve, reject) => {
    require('child_process').execFile('git', ['commit', '--allow-empty', '-q', '-m', message], {
      cwd: repo,
      env: { ...process.env, GIT_AUTHOR_DATE: authorDate, GIT_COMMITTER_DATE: committerDate },
    }, (err) => (err ? reject(err) : resolve()));
  });
  try {
    await git.run(['checkout', '-q', '-b', 'branch-a'], repo);
    await commitWithDates('branch-a', 'authored early, committed late', '2021-06-01T00:00:00', '2023-01-01T00:00:00');
    await git.run(['checkout', '-q', 'main'], repo);
    await git.run(['checkout', '-q', '-b', 'branch-b'], repo);
    await commitWithDates('branch-b', 'authored late, committed early', '2022-06-01T00:00:00', '2020-01-01T00:00:00');

    const byCommitDate = await git.logWithParents(repo, { revspec: ['branch-a', 'branch-b'], order: 'date' });
    assert.equal(byCommitDate[0].subject, 'authored early, committed late', 'newest commit date wins under --date-order');

    const byAuthorDate = await git.logWithParents(repo, { revspec: ['branch-a', 'branch-b'], order: 'author-date' });
    assert.equal(byAuthorDate[0].subject, 'authored late, committed early', 'newest author date wins under --author-date-order');
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('logWithParents rejects a revspec flag not on the allow-list', { skip: !haveGit && 'git not installed' }, async () => {
  const repo = await makeRepo();
  try {
    await assert.rejects(git.logWithParents(repo, { revspec: ['--upload-pack=/bin/sh'] }), /allowed flag list/);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('forEachRef decodes heads/remotes/tags, marks HEAD, and degrades to empty on a repo with no refs', { skip: !haveGit && 'git not installed' }, async () => {
  const repo = await makeRepo();
  try {
    await git.run(['branch', 'feature'], repo);
    await git.run(['tag', '-a', 'v1', '-m', 'release'], repo);
    await git.run(['tag', 'v1-lightweight'], repo);

    const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-git-bare-'));
    await git.run(['init', '-q', '--bare', bare], repo);
    await git.run(['remote', 'add', 'origin', bare], repo);
    await git.run(['push', '-q', 'origin', 'main', 'feature'], repo);

    const refs = await git.forEachRef(repo);
    const main = refs.heads.find(h => h.name === 'main');
    const feature = refs.heads.find(h => h.name === 'feature');
    assert.equal(main.isHead, true);
    assert.equal(feature.isHead, false);

    assert.ok(refs.remotes.find(r => r.remote === 'origin' && r.name === 'main'));
    assert.ok(!refs.remotes.find(r => r.name === 'HEAD'), 'the remote\'s own default-branch pointer is filtered out');

    const annotated = refs.tags.find(t => t.name === 'v1');
    const lightweight = refs.tags.find(t => t.name === 'v1-lightweight');
    assert.equal(annotated.annotated, true);
    assert.equal(lightweight.annotated, false);
    assert.equal(lightweight.hash, main.hash);

    fs.rmSync(bare, { recursive: true, force: true });

    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-git-empty-'));
    await git.run(['init', '-q', '-b', 'main'], empty);
    try {
      assert.deepEqual(await git.forEachRef(empty), { heads: [], remotes: [], tags: [] });
    } finally {
      fs.rmSync(empty, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('stashList resolves each stash\'s base commit and, when present, its source branch', { skip: !haveGit && 'git not installed' }, async () => {
  const repo = await makeRepo();
  try {
    const head = await git.run(['rev-parse', 'HEAD'], repo);
    fs.writeFileSync(path.join(repo, 'README.md'), '# stashed change\n');
    await git.run(['stash', 'push', '-q', '-m', 'my work'], repo);

    const stashes = await git.stashList(repo);
    assert.equal(stashes.length, 1);
    assert.equal(stashes[0].index, 0);
    assert.equal(stashes[0].branch, 'main');
    assert.equal(stashes[0].baseCommitHash, head);
    assert.match(stashes[0].message, /my work/);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('blobAtRevision reads a file\'s content at a given revision and stays contained to the repo', { skip: !haveGit && 'git not installed' }, async () => {
  const repo = await makeRepo();
  try {
    const first = await git.run(['rev-parse', 'HEAD'], repo);
    fs.writeFileSync(path.join(repo, 'README.md'), '# changed\n');
    await git.run(['commit', '-aq', '-m', 'change'], repo);

    assert.equal(await git.blobAtRevision(repo, first, 'README.md'), '# hello\n');
    assert.equal(await git.blobAtRevision(repo, 'HEAD', 'README.md'), '# changed\n');
    await assert.rejects(git.blobAtRevision(repo, 'HEAD', '../outside.txt'), /outside the repository/);
    await assert.rejects(git.blobAtRevision(repo, '-x', 'README.md'), /Invalid revision/);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('blobAtRevision normalizes a backslash-style relative path to git\'s forward-slash pathspec form', { skip: !haveGit && 'git not installed' }, async () => {
  const repo = await makeRepo();
  try {
    fs.mkdirSync(path.join(repo, 'sub'));
    fs.writeFileSync(path.join(repo, 'sub', 'nested.txt'), 'nested\n');
    await git.run(['add', 'sub/nested.txt'], repo);
    await git.run(['commit', '-q', '-m', 'add nested'], repo);

    // Simulates the shape path.relative() produces on Windows — git itself
    // always wants '/'-separated pathspecs regardless of host OS.
    assert.equal(await git.blobAtRevision(repo, 'HEAD', 'sub\\nested.txt'), 'nested\n');
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('toGitPath converts backslashes to forward slashes regardless of host path.sep', () => {
  assert.equal(git.toGitPath('sub\\nested.txt'), 'sub/nested.txt');
  assert.equal(git.toGitPath('a/b\\c/d'), 'a/b/c/d');
  assert.equal(git.toGitPath('plain.txt'), 'plain.txt');
});
