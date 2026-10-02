const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const service = require('../git-graph-service');
const realGit = require('../git');

const haveGit = spawnSync('git', ['--version'], { encoding: 'utf8' }).status === 0;

function gitIn(repo, ...args) {
  const r = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr || `git ${args[0]} failed`);
  return r.stdout.trim();
}

/** A throwaway repository with one commit on main, identity set locally. */
function makeRepo(prefix = 'switchboard-gg-') {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  gitIn(repo, 'init', '-q', '-b', 'main');
  gitIn(repo, 'config', 'user.email', 'test@example.com');
  gitIn(repo, 'config', 'user.name', 'Test');
  fs.writeFileSync(path.join(repo, 'README.md'), '# hello\n');
  gitIn(repo, 'add', 'README.md');
  gitIn(repo, 'commit', '-q', '-m', 'init');
  return repo;
}

function rm(dir) { fs.rmSync(dir, { recursive: true, force: true }); }

function setupService(extra = {}) {
  const events = [];
  service.init({
    log: { info() {}, error() {} },
    send: (channel, ...args) => events.push({ channel, args }),
    git: realGit,
    repoWatchPollMs: 30,
    repoWatchDebounceMs: 20,
    ...extra,
  });
  return { events };
}

test.afterEach(() => {
  service.stopAllRepoWatches();
});

// --- getProjectGitGraph: payload assembly + paging ---

test('getProjectGitGraph merges refs by hash, marks HEAD, and reports hasMore at the boundary', { skip: !haveGit && 'git not installed' }, async () => {
  setupService();
  const repo = makeRepo();
  try {
    fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n');
    gitIn(repo, 'add', 'a.txt');
    gitIn(repo, 'commit', '-q', '-m', 'second');
    gitIn(repo, 'tag', '-a', 'v1', '-m', 'release');
    gitIn(repo, 'branch', 'feature');

    const full = await service.getProjectGitGraph(repo, { limit: 10 });
    assert.equal(full.ok, true);
    assert.equal(full.hasMore, false);
    assert.ok(full.refs);
    const [head, root] = full.commits;
    assert.equal(head.isHead, true);
    assert.ok(head.refs.heads.includes('main'));
    assert.ok(head.refs.tags.includes('v1'));
    assert.ok(head.refs.heads.includes('feature'), 'feature was branched from the current head, not the root');
    assert.equal(root.refs, undefined, 'the root commit has no refs pointing at it');

    const paged = await service.getProjectGitGraph(repo, { limit: 1 });
    assert.equal(paged.hasMore, true);
    assert.equal(paged.commits.length, 1);
  } finally { rm(repo); }
});

test('getProjectGitGraph with showTags:false strips tags from both the ref set and the commits they were attached to', { skip: !haveGit && 'git not installed' }, async () => {
  setupService();
  const repo = makeRepo();
  try {
    gitIn(repo, 'tag', '-a', 'v1', '-m', 'release');

    const shown = await service.getProjectGitGraph(repo, { limit: 10 });
    assert.deepEqual(shown.refs.tags.map(t => t.name), ['v1']);
    assert.ok(shown.commits[0].refs.tags.includes('v1'));

    const hidden = await service.getProjectGitGraph(repo, { limit: 10, showTags: false });
    assert.deepEqual(hidden.refs.tags, []);
    assert.deepEqual(hidden.commits[0].refs.tags, []);
  } finally { rm(repo); }
});

test('getProjectGitGraph omits refs on an unchanged-filter "Load More" call', { skip: !haveGit && 'git not installed' }, async () => {
  setupService();
  const repo = makeRepo();
  try {
    for (let i = 0; i < 3; i += 1) {
      fs.writeFileSync(path.join(repo, `f${i}.txt`), String(i));
      gitIn(repo, 'add', `f${i}.txt`);
      gitIn(repo, 'commit', '-q', '-m', `commit ${i}`);
    }
    const page1 = await service.getProjectGitGraph(repo, { limit: 2 });
    assert.ok(page1.refs);
    assert.equal(page1.hasMore, true);

    const page2 = await service.getProjectGitGraph(repo, { limit: 2, skip: 2, refsUnchanged: true });
    assert.equal(page2.refs, null);
    assert.equal(page2.commits.length, 2);
  } finally { rm(repo); }
});

test('getProjectGitGraph reports stashes and uncommitted changes alongside the commit window, without merging them into it', { skip: !haveGit && 'git not installed' }, async () => {
  setupService();
  const repo = makeRepo();
  try {
    fs.writeFileSync(path.join(repo, 'README.md'), '# stashed change\n');
    gitIn(repo, 'stash', 'push', '-q', '-m', 'wip');
    fs.writeFileSync(path.join(repo, 'untracked.txt'), 'dirty\n');

    const payload = await service.getProjectGitGraph(repo, { limit: 10 });
    assert.equal(payload.stashes.length, 1);
    assert.ok(payload.uncommitted);
    assert.equal(payload.uncommitted.changeCount, 1);
    // The renderer does its own merge of stashes/uncommitted into the row
    // list (gitGraphBuildLayoutInput); if this endpoint merged them in too,
    // every stash and the working-tree row would render twice.
    assert.ok(!payload.commits.some(c => c.kind === 'uncommitted'));
    assert.ok(!payload.commits.some(c => c.kind === 'stash'));
  } finally { rm(repo); }
});

test('getProjectGitGraph degrades gracefully on an empty repo with an unborn HEAD', { skip: !haveGit && 'git not installed' }, async () => {
  setupService();
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-gg-empty-'));
  gitIn(repo, 'init', '-q', '-b', 'main');
  try {
    const payload = await service.getProjectGitGraph(repo, { limit: 10 });
    assert.equal(payload.ok, true);
    assert.deepEqual(payload.commits, []);
    assert.equal(payload.uncommitted, null);
  } finally { rm(repo); }
});

test('getProjectGitGraph reports nothing selected as no revisions rather than falling back to HEAD', { skip: !haveGit && 'git not installed' }, async () => {
  setupService();
  const repo = makeRepo();
  try {
    const payload = await service.getProjectGitGraph(repo, { limit: 10, branches: [], showTags: false });
    assert.equal(payload.ok, true);
    assert.deepEqual(payload.commits, []);
  } finally { rm(repo); }
});

// --- Read endpoints: commit/compare/file-at-revision ---

test('getGitGraphCommitDetail returns parents, body, and a files list', { skip: !haveGit && 'git not installed' }, async () => {
  setupService();
  const repo = makeRepo();
  try {
    fs.writeFileSync(path.join(repo, 'README.md'), '# changed\n');
    gitIn(repo, 'commit', '-q', '-am', 'second\n\nBody line');
    const hash = gitIn(repo, 'rev-parse', 'HEAD');
    const { commit, files } = await service.getGitGraphCommitDetail(repo, hash);
    assert.equal(commit.subject, 'second');
    assert.match(commit.body, /Body line/);
    assert.equal(commit.parents.length, 1);
    assert.equal(files.length, 1);
    assert.equal(files[0].path, 'README.md');
    assert.equal(files[0].status, 'modified');
  } finally { rm(repo); }
});

test('getGitGraphCommitDetail rejects a malformed hash before running anything', { skip: !haveGit && 'git not installed' }, async () => {
  setupService();
  const repo = makeRepo();
  try {
    await assert.rejects(service.getGitGraphCommitDetail(repo, '-not-a-hash'), /not a valid|must not start/);
    await assert.rejects(service.getGitGraphCommitDetail(repo, 'zz'), /not a valid/);
  } finally { rm(repo); }
});

test('getGitGraphFileDiffBetween reads a blob from a revision and from the working tree', { skip: !haveGit && 'git not installed' }, async () => {
  setupService();
  const repo = makeRepo();
  try {
    const firstHash = gitIn(repo, 'rev-parse', 'HEAD');
    fs.writeFileSync(path.join(repo, 'README.md'), '# working tree version\n');
    const result = await service.getGitGraphFileDiffBetween(repo, firstHash, null, 'README.md');
    assert.match(result.oldContent, /# hello/);
    assert.match(result.newContent, /working tree version/);
  } finally { rm(repo); }
});

test('getGitGraphCompareDetail against the working tree includes untracked files, not just tracked changes', { skip: !haveGit && 'git not installed' }, async () => {
  setupService();
  const repo = makeRepo();
  try {
    const headHash = gitIn(repo, 'rev-parse', 'HEAD');
    fs.writeFileSync(path.join(repo, 'README.md'), '# changed\n'); // tracked, unstaged change
    fs.writeFileSync(path.join(repo, 'new-file.txt'), 'line one\nline two\n'); // untracked

    const { files } = await service.getGitGraphCompareDetail(repo, headHash, null);
    const untracked = files.find(f => f.path === 'new-file.txt');
    assert.ok(untracked, 'an untracked file must still appear in the Uncommitted Changes file list');
    assert.equal(untracked.status, 'untracked');
    assert.equal(untracked.insertions, 2);
    assert.ok(files.some(f => f.path === 'README.md'), 'the tracked change is still reported alongside it');
  } finally { rm(repo); }
});

test('getGitGraphFileAtRevision refuses a path that escapes the repository', { skip: !haveGit && 'git not installed' }, async () => {
  setupService();
  const repo = makeRepo();
  try {
    const hash = gitIn(repo, 'rev-parse', 'HEAD');
    await assert.rejects(service.getGitGraphFileAtRevision(repo, hash, '../outside.txt'), /outside the repository/);
  } finally { rm(repo); }
});

// --- Repo-change watcher ---

test('ensureRepoWatch fires git-graph-repo-changed after HEAD moves, debounced', { skip: !haveGit && 'git not installed' }, async () => {
  const { events } = setupService({ repoWatchPollMs: 20, repoWatchDebounceMs: 15 });
  const repo = makeRepo();
  try {
    await service.ensureRepoWatch(repo);
    await new Promise(resolve => setTimeout(resolve, 60)); // let the baseline fingerprint settle
    fs.writeFileSync(path.join(repo, 'b.txt'), 'b\n');
    gitIn(repo, 'add', 'b.txt');
    gitIn(repo, 'commit', '-q', '-m', 'moves HEAD');
    await new Promise(resolve => setTimeout(resolve, 150));
    const changed = events.filter(e => e.channel === 'git-graph-repo-changed' && e.args[0] === repo);
    assert.ok(changed.length >= 1, 'expected at least one repo-changed event');
  } finally {
    service.stopRepoWatch(repo);
    rm(repo);
  }
});

test('stopRepoWatch/stopAllRepoWatches actually stop polling (no more events after stop)', { skip: !haveGit && 'git not installed' }, async () => {
  const { events } = setupService({ repoWatchPollMs: 15, repoWatchDebounceMs: 10 });
  const repo = makeRepo();
  try {
    await service.ensureRepoWatch(repo);
    await new Promise(resolve => setTimeout(resolve, 40));
    service.stopRepoWatch(repo);
    const before = events.length;
    fs.writeFileSync(path.join(repo, 'c.txt'), 'c\n');
    gitIn(repo, 'add', 'c.txt');
    gitIn(repo, 'commit', '-q', '-m', 'after stop');
    await new Promise(resolve => setTimeout(resolve, 80));
    assert.equal(events.length, before, 'no new events after the watch was stopped');
  } finally { rm(repo); }
});
