// worktrees.js: finding a project's repositories, the path boundary, and the
// Worktrees tab's actions, against real throwaway repositories.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const projects = require('../projects');
const worktrees = require('../worktrees');
const git = require('../git');

const haveGit = spawnSync('git', ['--version'], { encoding: 'utf8' }).status === 0;
const skip = !haveGit && 'git not installed';
const quiet = { info() {}, error() {} };

// The project tables and settings, in memory (db.js needs Electron's ABI).
function makeFakeDb(projectsRoot) {
  const rows = { projects: [], folders: [], tracks: [], settings: new Map() };
  return {
    rows,
    getSetting: (key) => (key === 'global' ? { projectsRoot } : (rows.settings.get(key) ?? null)),
    setSetting: (key, value) => { rows.settings.set(key, value); },
    listProjects: () => rows.projects.map(r => ({ ...r })),
    getProject: (id) => rows.projects.find(r => r.id === id) || null,
    getProjectBySlug: (slug) => rows.projects.find(r => r.slug === slug) || null,
    insertProject: (row) => { rows.projects.push({ ...row, sharedBranch: row.sharedBranch ? 1 : 0 }); },
    updateProject: (id, patch) => {
      const row = rows.projects.find(r => r.id === id);
      if (!row) return 0;
      for (const key of ['name', 'status', 'sharedBranch', 'branchName', 'defaultCwd', 'snoozedUntil', 'snoozedAt', 'modified']) {
        if (key in patch) row[key] = patch[key];
      }
      return 1;
    },
    listProjectFolders: (projectId) => rows.folders.filter(f => f.projectId === projectId).sort((a, b) => a.sortOrder - b.sortOrder),
    listAllProjectFolders: () => rows.folders.slice(),
    upsertProjectFolder: (row) => {
      const i = rows.folders.findIndex(f => f.projectId === row.projectId && f.path === row.path);
      const clean = { mode: 'in-place', sourcePath: null, branch: null, sortOrder: 0, ...row };
      if (i === -1) rows.folders.push(clean); else rows.folders[i] = clean;
    },
    deleteProjectFolder: (projectId, p) => { rows.folders = rows.folders.filter(f => !(f.projectId === projectId && f.path === p)); },
    listTracks: (projectId) => rows.tracks.filter(t => t.projectId === projectId),
    listAllTracks: () => rows.tracks.slice(),
    getTrack: (id) => rows.tracks.find(t => t.id === id) || null,
    insertTrack: (row) => { rows.tracks.push({ ...row }); },
    updateTrack: (id, patch) => {
      const t = rows.tracks.find(r => r.id === id);
      if (!t) return 0;
      for (const key of ['name', 'cwd', 'cli', 'status', 'sortOrder']) if (key in patch) t[key] = patch[key];
      return 1;
    },
    setSessionAssignment() {},
    listPlanLinks: () => [],
    listSchedules: () => [],
    listSchedulesByProject: () => [],
  };
}

function gitIn(dir, ...args) {
  const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr || `git ${args[0]} failed`);
  return r.stdout.trim();
}

function makeRepo(dir) {
  fs.mkdirSync(dir, { recursive: true });
  gitIn(dir, 'init', '-q', '-b', 'main');
  gitIn(dir, 'config', 'user.email', 'test@example.com');
  gitIn(dir, 'config', 'user.name', 'Test');
  fs.writeFileSync(path.join(dir, 'README.md'), '# hello\n');
  gitIn(dir, 'add', 'README.md');
  gitIn(dir, 'commit', '-q', '-m', 'init');
  return dir;
}

function commitIn(dir, file, text) {
  fs.writeFileSync(path.join(dir, file), text);
  gitIn(dir, 'add', file);
  gitIn(dir, 'commit', '-q', '-m', `add ${file}`);
}

// A workspace folder that is not a repository and holds two (the layout of a
// folder with several clones side by side), attached to one project.
async function setup() {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-wts-')));
  const root = path.join(base, 'projects');
  const workspace = path.join(base, 'workspace');
  const app = makeRepo(path.join(workspace, 'app'));
  const lib = makeRepo(path.join(workspace, 'lib'));
  const db = makeFakeDb(root);
  projects.init({ db, log: quiet, buildProjectsFromCache: () => [] });
  worktrees.init({ db, log: quiet, projects, codexHome: () => path.join(base, 'codex-home') });
  const created = await projects.createProject({ name: 'Demo', folders: [{ path: workspace, mode: 'in-place' }] });
  assert.equal(created.ok, true);
  return {
    base, root, workspace, app, lib, db,
    projectId: created.project.id,
    project: created.project,
    cleanup: () => fs.rmSync(base, { recursive: true, force: true }),
  };
}

const byName = (result) => new Map(result.repositories.map(repo => [repo.name, repo]));

test('findNestedRepos finds clones and worktrees but skips dependencies, hidden folders and deep ones', () => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-scan-')));
  try {
    const mark = (rel, asFile = false) => {
      const dir = path.join(base, rel);
      fs.mkdirSync(dir, { recursive: true });
      if (asFile) fs.writeFileSync(path.join(dir, '.git'), 'gitdir: elsewhere\n');
      else fs.mkdirSync(path.join(dir, '.git'));
    };
    mark('one');
    mark('group/two');
    mark('group/two/inner'); // inside a repository: not searched
    mark('.claude/worktrees/three', true);
    mark('node_modules/pkg');
    mark('.cache/four');
    mark('a/b/c/too-deep');
    const found = worktrees.findNestedRepos(base).map(dir => path.relative(base, dir)).sort();
    assert.deepEqual(found, [path.join('.claude', 'worktrees', 'three'), path.join('group', 'two'), 'one']);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('the tab lists every repository of a workspace folder with its worktrees and their kind', { skip }, async () => {
  const t = await setup();
  try {
    const created = await worktrees.createWorktree(t.projectId, { repoPath: t.app, mode: 'new', branch: 'feat/login' });
    assert.equal(created.ok, true, created.error);
    assert.equal(created.worktree.path, path.join(t.workspace, 'app.worktrees', 'feat-login'), 'next to the repository');
    const claude = path.join(t.app, '.claude', 'worktrees', 'quick-fix');
    gitIn(t.app, 'worktree', 'add', '-q', '-b', 'quick-fix', claude);
    const codex = path.join(t.base, 'codex-home', 'worktrees', 'abc', 'app');
    gitIn(t.app, 'worktree', 'add', '-q', '--detach', codex);
    const other = path.join(t.base, 'somewhere');
    gitIn(t.app, 'worktree', 'add', '-q', '-b', 'other', other);
    fs.writeFileSync(path.join(other, 'scratch.txt'), 'wip\n');

    const result = await worktrees.listProjectWorktrees(t.projectId);
    assert.equal(result.ok, true);
    const repos = byName(result);
    assert.deepEqual([...repos.keys()], ['app', 'lib']);
    const app = repos.get('app');
    assert.equal(app.mainPath, t.app);
    assert.equal(app.nested, true, 'found inside the attached folder');
    assert.deepEqual(app.attachedFolders, [t.workspace]);
    const kinds = Object.fromEntries(app.worktrees.map(item => [item.path, item.kind]));
    assert.deepEqual(kinds, {
      [t.app]: 'main',
      [created.worktree.path]: 'classic',
      [claude]: 'claude',
      [codex]: 'codex',
      [other]: 'other',
    });
    const otherRow = app.worktrees.find(item => item.path === other);
    assert.equal(otherRow.dirty, true);
    assert.equal(otherRow.branch, 'other');
    assert.equal(otherRow.lastCommit.subject, 'init');
    assert.ok(otherRow.created > 0);
    assert.equal(app.worktrees.find(item => item.path === codex).detached, true);
    assert.equal(repos.get('lib').worktrees.length, 1);
    assert.equal(result.settings.pathTemplate, worktrees.DEFAULT_PATH_TEMPLATE);
  } finally {
    t.cleanup();
  }
});

test('actions refuse paths outside the project and the main worktree', { skip }, async () => {
  const t = await setup();
  const stranger = makeRepo(path.join(t.base, 'stranger'));
  try {
    const foreign = path.join(t.base, 'stranger.worktrees', 'x');
    gitIn(stranger, 'worktree', 'add', '-q', '-b', 'x', foreign);
    await assert.rejects(worktrees.lockWorktree(t.projectId, foreign, 'no'), /not a worktree of this project/);
    await assert.rejects(worktrees.removeWorktree(t.projectId, foreign, { force: true }), /not a worktree of this project/);
    await assert.rejects(worktrees.createWorktree(t.projectId, { repoPath: stranger, mode: 'new', branch: 'y' }), /not a worktree of this project/);
    await assert.rejects(worktrees.lockWorktree(t.projectId, t.app, 'no'), /main worktree/);
    await assert.rejects(worktrees.removeWorktree(t.projectId, t.app), /main worktree/);
    await assert.rejects(worktrees.listProjectWorktrees('missing'), /Project not found/);
    assert.ok(fs.existsSync(foreign), 'untouched');
  } finally {
    t.cleanup();
  }
});

test('create checks out new, existing, remote and detached heads, numbers busy folders, and copies local files', { skip }, async () => {
  const t = await setup();
  try {
    fs.writeFileSync(path.join(t.app, '.env'), 'SECRET=1\n');
    fs.writeFileSync(path.join(t.app, '.env.example'), 'SECRET=\n');
    fs.mkdirSync(path.join(t.app, 'config'));
    fs.writeFileSync(path.join(t.app, 'config', 'local.json'), '{}\n');
    fs.mkdirSync(path.join(t.app, 'node_modules', 'dep'), { recursive: true });
    fs.writeFileSync(path.join(t.app, 'node_modules', 'dep', '.env'), 'no\n');
    worktrees.setSettings(t.projectId, { copyPatterns: ['.env*', 'config/*.json', '**/.env'], copyIgnores: ['.env.example'] });

    const first = await worktrees.createWorktree(t.projectId, { repoPath: t.app, mode: 'new', branch: 'topic' });
    assert.equal(first.ok, true, first.error);
    assert.deepEqual(first.copied, ['.env', 'config/local.json']);
    assert.equal(fs.readFileSync(path.join(first.worktree.path, '.env'), 'utf8'), 'SECRET=1\n');
    assert.ok(!fs.existsSync(path.join(first.worktree.path, 'node_modules')), 'dependencies are not searched');

    // The same ref name again gets a numbered folder.
    const suggested = await worktrees.suggestWorktreePath(t.projectId, t.app, 'topic');
    assert.equal(suggested.path, path.join(t.workspace, 'app.worktrees', 'topic-2'));

    assert.match((await worktrees.createWorktree(t.projectId, { repoPath: t.app, mode: 'new', branch: 'topic' })).error, /already exists/);
    assert.match((await worktrees.createWorktree(t.projectId, { repoPath: t.app, mode: 'new', branch: 'bad name' })).error, /Not a valid branch name/);
    assert.match((await worktrees.createWorktree(t.projectId, { repoPath: t.app, mode: 'existing', branch: 'main' })).error, /already checked out/);

    gitIn(t.app, 'branch', 'later');
    const existing = await worktrees.createWorktree(t.projectId, {
      repoPath: t.app, mode: 'existing', branch: 'later', path: path.join(t.base, 'custom', 'later'), attach: true,
    });
    assert.equal(existing.ok, true, existing.error);
    assert.equal(existing.attached, true);
    const folder = t.db.listProjectFolders(t.projectId).find(f => f.path === existing.worktree.path);
    assert.deepEqual({ mode: folder.mode, sourcePath: folder.sourcePath, branch: folder.branch }, { mode: 'worktree', sourcePath: t.app, branch: 'later' });

    const head = gitIn(t.app, 'rev-parse', 'HEAD');
    const detached = await worktrees.createWorktree(t.projectId, { repoPath: t.app, mode: 'detached', startPoint: 'main' });
    assert.equal(detached.ok, true, detached.error);
    assert.equal(gitIn(detached.worktree.path, 'rev-parse', 'HEAD'), head);
    assert.equal(path.basename(detached.worktree.path), 'main');

    // A remote branch becomes a local branch that tracks it.
    const clone = path.join(t.workspace, 'lib-clone');
    gitIn(t.lib, 'branch', 'shared');
    gitIn(t.workspace, 'clone', '-q', t.lib, clone);
    const branches = await worktrees.listRepoBranches(t.projectId, clone);
    assert.ok(branches.remote.some(item => item.name === 'origin/shared'));
    assert.equal(branches.checkedOut.main, clone);
    const remote = await worktrees.createWorktree(t.projectId, { repoPath: clone, mode: 'remote', remoteBranch: 'origin/shared' });
    assert.equal(remote.ok, true, remote.error);
    assert.equal(remote.worktree.branch, 'shared');
    assert.equal(gitIn(remote.worktree.path, 'rev-parse', '--abbrev-ref', '@{upstream}'), 'origin/shared');
  } finally {
    t.cleanup();
  }
});

test('remove asks first for local changes, runs the pre-remove command, and can delete the branch', { skip }, async () => {
  const t = await setup();
  const marker = path.join(t.base, 'pre-remove.log');
  try {
    const made = await worktrees.createWorktree(t.projectId, { repoPath: t.app, mode: 'new', branch: 'wip', attach: true });
    const wt = made.worktree.path;
    commitIn(wt, 'work.txt', 'work\n');
    fs.writeFileSync(path.join(wt, 'unsaved.txt'), 'unsaved\n');
    worktrees.setSettings(t.projectId, { preRemoveCmd: `echo "$SWITCHBOARD_BRANCH" >> "${marker}"` });

    const refused = await worktrees.removeWorktree(t.projectId, wt);
    assert.equal(refused.dirty, true);
    assert.ok(!fs.existsSync(marker), 'nothing ran before asking');

    worktrees.setSettings(t.projectId, { preRemoveCmd: 'echo teardown failed >&2; exit 3' });
    const failed = await worktrees.removeWorktree(t.projectId, wt, { force: true });
    assert.equal(failed.hookFailed, true);
    assert.match(failed.error, /exited with code 3/);
    assert.match(failed.output, /teardown failed/);
    assert.ok(fs.existsSync(wt), 'kept when the command fails');

    worktrees.setSettings(t.projectId, { preRemoveCmd: `echo "$SWITCHBOARD_BRANCH" >> "${marker}"` });
    const removed = await worktrees.removeWorktree(t.projectId, wt, { force: true, deleteBranch: true });
    assert.equal(removed.ok, true, removed.error);
    assert.equal(fs.readFileSync(marker, 'utf8').trim(), 'wip');
    assert.ok(!fs.existsSync(wt));
    assert.equal(t.db.listProjectFolders(t.projectId).some(f => f.path === wt), false, 'detached from the project');
    assert.equal(removed.branchDeleted, false);
    assert.equal(removed.unmerged, true, 'the branch has a commit main does not');

    const forced = await worktrees.deleteBranch(t.projectId, t.app, 'wip', { force: true });
    assert.equal(forced.ok, true, forced.error);
    assert.equal(gitIn(t.app, 'branch', '--list', 'wip'), '');
  } finally {
    t.cleanup();
  }
});

test('lock, unlock, move and repair', { skip }, async () => {
  const t = await setup();
  try {
    const made = await worktrees.createWorktree(t.projectId, { repoPath: t.app, mode: 'new', branch: 'mover', attach: true });
    const wt = made.worktree.path;
    const track = { id: 'track-1', projectId: t.projectId, name: 'Track', cwd: path.join(wt, 'src') };
    t.db.insertTrack(track);
    t.db.updateProject(t.projectId, { defaultCwd: wt });

    assert.equal((await worktrees.lockWorktree(t.projectId, wt, 'demo')).ok, true);
    const listed = byName(await worktrees.listProjectWorktrees(t.projectId)).get('app').worktrees.find(item => item.path === wt);
    assert.equal(listed.lockReason, 'demo');
    assert.equal((await worktrees.removeWorktree(t.projectId, wt)).locked, true);
    assert.equal((await worktrees.moveWorktree(t.projectId, wt, path.join(t.base, 'moved'))).locked, true);
    assert.equal((await worktrees.unlockWorktree(t.projectId, wt)).ok, true);

    const target = path.join(t.base, 'moved', 'mover');
    const moved = await worktrees.moveWorktree(t.projectId, wt, target);
    assert.equal(moved.ok, true, moved.error);
    assert.ok(fs.existsSync(path.join(target, 'README.md')));
    const folders = t.db.listProjectFolders(t.projectId);
    assert.ok(folders.some(f => f.path === target && f.mode === 'worktree' && f.branch === 'mover'), 'row follows');
    assert.ok(!folders.some(f => f.path === wt));
    assert.equal(t.db.getProject(t.projectId).defaultCwd, target);
    assert.equal(t.db.getTrack('track-1').cwd, path.join(target, 'src'));

    // Moved by hand: git loses it until repaired from the new place.
    const byHand = path.join(t.base, 'by-hand');
    fs.renameSync(target, byHand);
    assert.match((await worktrees.repairWorktrees(t.projectId, t.app, [path.join(t.base, 'nowhere')])).error, /not a worktree/);
    const repaired = await worktrees.repairWorktrees(t.projectId, t.app, [byHand]);
    assert.equal(repaired.ok, true);
    const after = byName(await worktrees.listProjectWorktrees(t.projectId)).get('app').worktrees;
    assert.ok(after.some(item => item.path === byHand && item.branch === 'mover' && !item.prunable));
  } finally {
    t.cleanup();
  }
});

test('prune previews missing worktrees and detaches the project rows left behind', { skip }, async () => {
  const t = await setup();
  try {
    const made = await worktrees.createWorktree(t.projectId, { repoPath: t.app, mode: 'new', branch: 'gone', attach: true });
    fs.rmSync(made.worktree.path, { recursive: true, force: true });
    const preview = await worktrees.prunePreview(t.projectId, t.app);
    assert.deepEqual(preview.worktrees.map(item => item.branch), ['gone']);
    assert.deepEqual(preview.staleFolders.map(item => item.path), [made.worktree.path]);
    const pruned = await worktrees.pruneWorktrees(t.projectId, t.app, { detachStale: true });
    assert.deepEqual({ pruned: pruned.pruned, detached: pruned.detached }, { pruned: 1, detached: 1 });
    assert.equal((await worktrees.prunePreview(t.projectId, t.app)).worktrees.length, 0);
    assert.equal(t.db.listProjectFolders(t.projectId).length, 1, 'only the workspace folder is left');
  } finally {
    t.cleanup();
  }
});

test('merged worktrees: only clean, unlocked ones whose branch is in the base can go', { skip }, async () => {
  const t = await setup();
  try {
    const done = (await worktrees.createWorktree(t.projectId, { repoPath: t.app, mode: 'new', branch: 'done' })).worktree.path;
    const dirty = (await worktrees.createWorktree(t.projectId, { repoPath: t.app, mode: 'new', branch: 'dirty' })).worktree.path;
    const ahead = (await worktrees.createWorktree(t.projectId, { repoPath: t.app, mode: 'new', branch: 'ahead' })).worktree.path;
    fs.writeFileSync(path.join(dirty, 'x.txt'), 'x\n');
    commitIn(ahead, 'new.txt', 'new\n');
    const result = await worktrees.mergedWorktrees(t.projectId, t.app);
    assert.equal(result.base, 'main');
    const rows = Object.fromEntries(result.worktrees.map(item => [item.branch, item]));
    assert.deepEqual(Object.keys(rows).sort(), ['dirty', 'done']);
    assert.equal(rows.done.eligible, true);
    assert.equal(rows.done.path, done);
    assert.equal(rows.done.fresh, true, 'no commits of its own: not ticked for the user');
    assert.equal(rows.dirty.eligible, false);
    assert.equal(rows.dirty.reason, 'Uncommitted changes');
  } finally {
    t.cleanup();
  }
});

test('attach and detach a worktree, including the main one, without touching the folder', { skip }, async () => {
  const t = await setup();
  try {
    const claude = path.join(t.app, '.claude', 'worktrees', 'c1');
    gitIn(t.app, 'worktree', 'add', '-q', '-b', 'c1', claude);
    const attached = await worktrees.attachToProject(t.projectId, claude);
    assert.equal(attached.ok, true, attached.error);
    let rows = t.db.listProjectFolders(t.projectId);
    assert.ok(rows.some(f => f.path === claude && f.mode === 'worktree' && f.sourcePath === t.app && f.branch === 'c1'));
    const listed = byName(await worktrees.listProjectWorktrees(t.projectId)).get('app').worktrees.find(item => item.path === claude);
    assert.equal(listed.kind, 'switchboard', 'an attached worktree is the project\'s');
    assert.equal(listed.attached, true);

    assert.equal((await worktrees.attachToProject(t.projectId, t.app)).ok, true);
    rows = t.db.listProjectFolders(t.projectId);
    assert.ok(rows.some(f => f.path === t.app && f.mode === 'in-place'));

    assert.equal((await worktrees.detachFromProject(t.projectId, claude)).ok, true);
    assert.ok(fs.existsSync(claude), 'the folder stays');
    assert.ok(!t.db.listProjectFolders(t.projectId).some(f => f.path === claude));
  } finally {
    t.cleanup();
  }
});

test('runPostCreate runs the command in the worktree with its branch in the environment', { skip }, async () => {
  const t = await setup();
  try {
    const made = await worktrees.createWorktree(t.projectId, { repoPath: t.app, mode: 'new', branch: 'setup' });
    assert.equal((await worktrees.runPostCreate(t.projectId, made.worktree.path)).skipped, true);
    worktrees.setSettings(t.projectId, { postCreateCmd: 'printf "%s" "$SWITCHBOARD_BRANCH" > .setup && echo ready' });
    const ran = await worktrees.runPostCreate(t.projectId, made.worktree.path);
    assert.equal(ran.ok, true, ran.error);
    assert.equal(ran.output, 'ready');
    assert.equal(fs.readFileSync(path.join(made.worktree.path, '.setup'), 'utf8'), 'setup');
    worktrees.setSettings(t.projectId, { postCreateCmd: 'exit 7' });
    assert.match((await worktrees.runPostCreate(t.projectId, made.worktree.path)).error, /exited with code 7/);
  } finally {
    t.cleanup();
  }
});

test('runUserCommand stops a command that runs too long', { skip: process.platform === 'win32' && 'POSIX shell' }, async () => {
  const started = Date.now();
  const result = await worktrees.runUserCommand('sleep 5', os.tmpdir(), {}, { timeoutMs: 200 });
  assert.equal(result.ok, false);
  assert.equal(result.timedOut, true);
  assert.ok(Date.now() - started < 4000);
});

test('settings keep patterns inside the repository and fall back to the defaults', () => {
  const settings = worktrees.normalizeSettings({
    pathTemplate: '  ',
    copyPatterns: ['.env*', '/etc/passwd', '../secrets', 'C:/x', 'config\\local.json', '.env*'],
    copyIgnores: 'a\n\nb',
    postCreateCmd: '  npm install  ',
    startAfterCreate: 'rocket',
    sortOrder: 'nameDesc',
    collapsedGroups: ['x', 3],
  });
  assert.equal(settings.pathTemplate, worktrees.DEFAULT_PATH_TEMPLATE);
  assert.deepEqual(settings.copyPatterns, ['.env*', 'config/local.json']);
  assert.deepEqual(settings.copyIgnores, ['a', 'b']);
  assert.equal(settings.postCreateCmd, 'npm install');
  assert.equal(settings.startAfterCreate, 'none');
  assert.equal(settings.sortOrder, 'nameDesc');
  assert.deepEqual(settings.collapsedGroups, ['x']);
});

test('path templates use the extension\'s variables', () => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-tpl-')));
  try {
    const mainPath = path.join(base, 'repo');
    const opts = { mainPath, ref: 'feat/a b', projectRoot: path.join(base, 'proj') };
    assert.equal(worktrees.refFolderName('feat/a b'), 'feat-a-b');
    assert.equal(worktrees.suggestPathFor(worktrees.DEFAULT_PATH_TEMPLATE, opts), path.join(base, 'repo.worktrees', 'feat-a-b'));
    assert.equal(worktrees.suggestPathFor('$BASE_ROOT/wt/$BASE_NAME$INDEX', opts), path.join(base, 'wt', 'repo1'));
    fs.mkdirSync(path.join(base, 'wt', 'repo1'), { recursive: true });
    assert.equal(worktrees.suggestPathFor('$BASE_ROOT/wt/$BASE_NAME$INDEX', opts), path.join(base, 'wt', 'repo2'));
    assert.equal(worktrees.suggestPathFor('$PROJECT_ROOT/.repos/$REF_NAME-$BASE_NAME', opts), path.join(base, 'proj', '.repos', 'feat-a-b-repo'));
    assert.equal(worktrees.suggestPathFor('trees/$REF_NAME', opts), path.join(base, 'trees', 'feat-a-b'), 'relative to the repository\'s parent');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('merged worktrees: a branch merged after real work is not taken for a fresh one', { skip }, async () => {
  const t = await setup();
  try {
    const landed = (await worktrees.createWorktree(t.projectId, { repoPath: t.app, mode: 'new', branch: 'landed' })).worktree.path;
    commitIn(landed, 'feature.txt', 'feature\n');
    gitIn(t.app, 'merge', '-q', '--ff-only', 'landed');
    const result = await worktrees.mergedWorktrees(t.projectId, t.app, 'main');
    const row = result.worktrees.find(item => item.branch === 'landed');
    assert.equal(row.eligible, true);
    assert.equal(row.fresh, false, 'at the tip of main, but with a commit of its own');
  } finally {
    t.cleanup();
  }
});

test('removing a missing worktree keeps the records of other missing ones', { skip }, async () => {
  const t = await setup();
  try {
    const a = (await worktrees.createWorktree(t.projectId, { repoPath: t.app, mode: 'new', branch: 'gone-a' })).worktree.path;
    const b = (await worktrees.createWorktree(t.projectId, { repoPath: t.app, mode: 'new', branch: 'away-b' })).worktree.path;
    fs.rmSync(a, { recursive: true, force: true });
    const away = path.join(t.base, 'unplugged-drive');
    fs.renameSync(b, away); // moved by hand: git cannot see it until repaired
    const removed = await worktrees.removeWorktree(t.projectId, a);
    assert.equal(removed.ok, true, removed.error);
    const paths = (await git.worktreeList(t.app)).map(item => item.path);
    assert.ok(!paths.includes(a), 'its record is gone');
    assert.ok(paths.includes(b), 'the other missing worktree keeps its record');
    assert.equal((await worktrees.repairWorktrees(t.projectId, t.app, [away])).ok, true, 'and can still be repaired');
  } finally {
    t.cleanup();
  }
});

test('a symlinked attached folder is matched to git\'s real path', { skip: (skip || (process.platform === 'win32' && 'symlinks')) }, async () => {
  const t = await setup();
  try {
    const link = path.join(t.base, 'app-link');
    fs.symlinkSync(t.app, link);
    const other = await projects.createProject({ name: 'Linked', folders: [{ path: link, mode: 'in-place' }] });
    const listed = await worktrees.listProjectWorktrees(other.project.id);
    const main = listed.repositories[0].worktrees[0];
    assert.equal(main.path, t.app);
    assert.equal(main.attached, true);
    assert.equal(main.attachedPath, link);
    assert.equal((await worktrees.listProjectWorktrees(t.projectId)).repositories[0].worktrees[0].attachedPath, null);
  } finally {
    t.cleanup();
  }
});

test('copying: ignores apply inside a folder copied whole, and links are copied as links', () => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-copy-')));
  try {
    const source = path.join(base, 'src');
    const target = path.join(base, 'dst');
    fs.mkdirSync(path.join(source, 'config'), { recursive: true });
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(source, 'config', 'app.json'), '{}');
    fs.writeFileSync(path.join(source, 'config', 'secret.key'), 'no');
    fs.writeFileSync(path.join(base, 'shared.env'), 'X=1');
    fs.symlinkSync(path.join(base, 'shared.env'), path.join(source, '.env'));
    const result = worktrees.copyMatchingFiles(source, target, ['config', '.env'], ['config/secret.key']);
    assert.deepEqual(result.copied, ['.env', 'config']);
    assert.ok(fs.existsSync(path.join(target, 'config', 'app.json')));
    assert.ok(!fs.existsSync(path.join(target, 'config', 'secret.key')), 'ignored inside the copied folder');
    assert.equal(fs.readlinkSync(path.join(target, '.env')), path.join(base, 'shared.env'), 'the link itself, not its target');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('runUserCommand answers even when a command ignores SIGTERM or leaves a process behind', { skip: process.platform === 'win32' && 'POSIX shell' }, async () => {
  let started = Date.now();
  const stubborn = await worktrees.runUserCommand("trap '' TERM; sleep 30", os.tmpdir(), {}, { timeoutMs: 200 });
  assert.equal(stubborn.ok, false);
  assert.equal(stubborn.timedOut, true);
  assert.ok(Date.now() - started < 8000, 'killed after the grace period');

  started = Date.now();
  const background = await worktrees.runUserCommand('(sleep 5 &); echo started', os.tmpdir(), {}, { timeoutMs: 20000 });
  assert.equal(background.ok, true);
  assert.equal(background.output, 'started');
  assert.ok(Date.now() - started < 3000, 'does not wait for the background process');
});
