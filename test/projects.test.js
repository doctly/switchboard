const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const projects = require('../projects');

const haveGit = spawnSync('git', ['--version'], { encoding: 'utf8' }).status === 0;

// An in-memory stand-in for the project tables in db.js. Same function names,
// same return shapes, no SQLite (db.js needs Electron's ABI to load).
function makeFakeDb({ global = {} } = {}) {
  const rows = { projects: [], folders: [], tracks: [], meta: new Map() };
  const db = {
    rows,
    getSetting: (key) => (key === 'global' ? global : null),
    listProjects: () => rows.projects.map(r => ({ ...r })),
    getProject: (id) => rows.projects.find(r => r.id === id) || null,
    getProjectBySlug: (slug) => rows.projects.find(r => r.slug === slug) || null,
    insertProject: (row) => { rows.projects.push({ ...row, sharedBranch: row.sharedBranch ? 1 : 0 }); },
    updateProject: (id, patch) => {
      const row = rows.projects.find(r => r.id === id);
      if (!row) return 0;
      for (const key of ['name', 'status', 'sharedBranch', 'branchName', 'defaultCwd', 'modified']) {
        if (key in patch) row[key] = key === 'sharedBranch' ? (patch[key] ? 1 : 0) : patch[key];
      }
      return 1;
    },
    deleteProject: (id) => {
      rows.projects = rows.projects.filter(r => r.id !== id);
      rows.folders = rows.folders.filter(f => f.projectId !== id);
      rows.tracks = rows.tracks.filter(t => t.projectId !== id);
      for (const [sid, m] of rows.meta) if (m.projectId === id) rows.meta.set(sid, { projectId: null, trackId: null });
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
    deleteTrack: (id) => {
      rows.tracks = rows.tracks.filter(t => t.id !== id);
      for (const [sid, m] of rows.meta) if (m.trackId === id) rows.meta.set(sid, { ...m, trackId: null });
    },
    setSessionAssignment: (sessionId, projectId, trackId) => { rows.meta.set(sessionId, { projectId, trackId }); },
    insertPlanLink: (row) => { rows.links = rows.links || []; rows.links.push({ ...row }); },
    listPlanLinks: (projectId) => (rows.links || []).filter(l => l.projectId === projectId),
  };
  return db;
}

function session(id, projectPath, extra = {}) {
  return { sessionId: id, projectPath, modified: '2026-09-01T00:00:00.000Z', summary: id, ...extra };
}

function setup({ folders = [], global = {} } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-projects-'));
  const db = makeFakeDb({ global: { projectsRoot: root, ...global } });
  let notified = 0;
  projects.init({
    db,
    log: { info() {}, error() {} },
    buildProjectsFromCache: () => folders,
    notifyRendererProjectsChanged: () => { notified++; },
  });
  return { root, db, notifications: () => notified, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function rm(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function gitIn(repo, ...args) {
  const r = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr || `git ${args[0]} failed`);
  return r.stdout.trim();
}

/** A throwaway repository with one commit. */
function makeRepo(name = 'switchboard-repo-') {
  const repo = tmpDir(name);
  gitIn(repo, 'init', '-q', '-b', 'main');
  gitIn(repo, 'config', 'user.email', 'test@example.com');
  gitIn(repo, 'config', 'user.name', 'Test');
  fs.writeFileSync(path.join(repo, 'README.md'), '# hello\n');
  gitIn(repo, 'add', 'README.md');
  gitIn(repo, 'commit', '-q', '-m', 'init');
  return repo;
}

test('slugify lowercases, collapses punctuation, trims and caps length', () => {
  assert.equal(projects.slugify('Website Redesign Launch'), 'website-redesign-launch');
  assert.equal(projects.slugify('  Search → Filters!! '), 'search-filters');
  assert.equal(projects.slugify('café_au lait'), 'caf-au-lait');
  assert.equal(projects.slugify('!!!'), '');
  const long = projects.slugify('a'.repeat(70) + ' tail');
  assert.equal(long.length, 60);
  assert.ok(!long.endsWith('-'));
});

test('uniqueSlug appends -2, -3 while a project uses the slug', () => {
  const t = setup();
  try {
    t.db.rows.projects.push({ id: 'p1', slug: 'bugs' }, { id: 'p2', slug: 'bugs-2' });
    assert.equal(projects.uniqueSlug('Bugs'), 'bugs-3');
    assert.equal(projects.uniqueSlug('!!!'), 'project');
  } finally { t.cleanup(); }
});

test('createProject writes the four files, the rows, and notifies', async () => {
  const t = setup();
  try {
    const repo = tmpDir('switchboard-repo-');
    try {
      const result = await projects.createProject({ name: 'Website upkeep', folders: [{ path: repo }] });
      assert.equal(result.ok, true);
      assert.deepEqual(result.errors, []);
      const p = result.project;
      assert.equal(p.slug, 'website-upkeep');
      assert.equal(p.root, path.join(t.root, 'website-upkeep'));
      assert.equal(p.status, 'active');
      assert.equal(p.sharedBranch, true);
      assert.deepEqual(p.folders.map(f => [f.path, f.mode]), [[repo, 'in-place']]);
      for (const name of ['CLAUDE.md', 'AGENTS.md']) {
        assert.ok(fs.existsSync(path.join(p.root, name)), name + ' exists');
      }
      for (const name of ['plan.md', 'plan-tracker.md', 'todos.md', 'memory.md']) {
        assert.ok(!fs.existsSync(path.join(p.root, name)), name + ' is left for the agent to create');
      }
      const brief = fs.readFileSync(path.join(p.root, 'CLAUDE.md'), 'utf8');
      assert.match(brief, /^# Website upkeep\n/);
      assert.match(brief, /plan\.md/);
      assert.match(brief, /todos\.md/);
      assert.equal(fs.readFileSync(path.join(p.root, 'AGENTS.md'), 'utf8'), brief);
      assert.equal(t.notifications(), 1);
    } finally { rm(repo); }
  } finally { t.cleanup(); }
});

test('createProject refuses a blank name, a missing folder, an existing root folder, a bad branch', async () => {
  const t = setup();
  try {
    assert.match((await projects.createProject({ name: '   ' })).error, /name/i);
    assert.match((await projects.createProject({ name: 'x', folders: [{ path: '/definitely/not/here' }] })).error, /Not a directory/);
    assert.match((await projects.createProject({ name: 'x', folders: [{ path: 'relative' }] })).error, /absolute/);
    assert.match((await projects.createProject({ name: 'x', folders: [{ path: os.tmpdir(), mode: 'zip' }] })).error, /Unknown folder mode/);
    assert.match((await projects.createProject({ name: 'x', branchName: '-bad' })).error, /Invalid branch name/);
    fs.mkdirSync(path.join(t.root, 'taken'));
    assert.match((await projects.createProject({ name: 'Taken' })).error, /already exists/);
  } finally { t.cleanup(); }
});

test('updateProject, attach/detach, deleteProject keep the folder on disk', async () => {
  const t = setup();
  try {
    const { project } = await projects.createProject({ name: 'Auth refactor' });
    assert.equal(projects.updateProject(project.id, { status: 'bogus' }).error, 'Unknown status: bogus');
    const updated = projects.updateProject(project.id, { name: 'Auth refactor v2', status: 'done', sharedBranch: false, branchName: ' auth ' });
    assert.equal(updated.project.name, 'Auth refactor v2');
    assert.equal(updated.project.status, 'done');
    assert.equal(updated.project.sharedBranch, false);
    assert.equal(updated.project.branchName, 'auth');
    assert.equal(updated.project.slug, 'auth-refactor', 'slug does not follow a rename');
    assert.deepEqual(updated.worktrees, [], 'marking done reports the worktrees to remove');

    const attached = (await projects.attachFolder(project.id, { path: os.tmpdir() })).project;
    assert.equal(attached.folders.length, 1);
    assert.equal((await projects.attachFolder(project.id, { path: os.tmpdir() })).project.folders.length, 1, 'idempotent');
    const detached = await projects.detachFolder(project.id, path.resolve(os.tmpdir()));
    assert.equal(detached.project.folders.length, 0);
    assert.equal(detached.worktreeRemoved, false);

    const removed = projects.deleteProject(project.id);
    assert.equal(removed.ok, true);
    assert.equal(removed.root, project.root);
    assert.ok(fs.existsSync(project.root), 'folder survives removal');
    assert.equal(projects.deleteProject(project.id).error, 'Project not found');
  } finally { t.cleanup(); }
});

test('projectForCwd matches the root and nested paths, not a sibling with a common prefix', async () => {
  const t = setup();
  try {
    const { project } = await projects.createProject({ name: 'foo' });
    fs.mkdirSync(path.join(t.root, 'foobar'));
    assert.equal(projects.projectForCwd(project.root)?.id, project.id);
    assert.equal(projects.projectForCwd(path.join(project.root, 'repos', 'x'))?.id, project.id);
    assert.equal(projects.projectForCwd(path.join(t.root, 'foobar')), null);
    assert.equal(projects.projectForCwd('/somewhere/else'), null);
    assert.equal(projects.projectForCwd(''), null);
  } finally { t.cleanup(); }
});

test('buildProjectTree files by explicit id, then by cwd, and leaves the rest out', async () => {
  const t = setup();
  try {
    const { project: a } = await projects.createProject({ name: 'A' });
    const { project: b } = await projects.createProject({ name: 'B' });
    t.db.rows.tracks.push({ id: 'trk', projectId: a.id, name: 'Build', cwd: null, cli: null, status: 'active', sortOrder: 0, created: '2026-09-01T00:00:00.000Z' });
    const folders = [
      { projectPath: '/repo/one', sessions: [
        session('s-explicit', '/repo/one', { projectId: a.id, modified: '2026-09-03T00:00:00.000Z' }),
        session('s-track', '/repo/one', { projectId: a.id, trackId: 'trk' }),
        session('s-stale-track', '/repo/one', { projectId: a.id, trackId: 'gone' }),
        session('s-none', '/repo/one'),
      ] },
      { projectPath: path.join(b.root, 'repos', 'x'), sessions: [
        session('s-cwd', path.join(b.root, 'repos', 'x'), { modified: '2026-09-02T00:00:00.000Z' }),
        // explicit id wins over the folder it sits in
        session('s-cwd-but-explicit', path.join(b.root, 'repos', 'x'), { projectId: a.id }),
      ] },
      { projectPath: '/repo/one', sessions: [ session('s-stale-project', '/repo/one', { projectId: 'deleted' }) ] },
    ];
    projects.init({ db: t.db, log: { info() {}, error() {} }, buildProjectsFromCache: () => folders, notifyRendererProjectsChanged() {} });

    const tree = projects.buildProjectTree(false);
    const byName = Object.fromEntries(tree.projects.map(p => [p.name, p]));
    assert.deepEqual(byName.A.sessions.map(s => s.sessionId), ['s-explicit', 's-stale-track', 's-cwd-but-explicit']);
    assert.deepEqual(byName.A.tracks[0].sessions.map(s => s.sessionId), ['s-track']);
    assert.deepEqual(byName.B.sessions.map(s => s.sessionId), ['s-cwd']);
    assert.equal(byName.A.sessionCount, 4);
    assert.equal(byName.A.lastActivity, '2026-09-03T00:00:00.000Z');
    assert.deepEqual(tree.projects.map(p => p.name), ['A', 'B'], 'most recent activity first');
  } finally { t.cleanup(); }
});

test('done projects sort after active ones', async () => {
  const t = setup();
  try {
    const { project: old } = await projects.createProject({ name: 'Old' });
    await projects.createProject({ name: 'New' });
    projects.updateProject(old.id, { status: 'done' });
    const tree = projects.buildProjectTree(false);
    assert.deepEqual(tree.projects.map(p => [p.name, p.status]), [['New', 'active'], ['Old', 'done']]);
  } finally { t.cleanup(); }
});

test('assignSession validates the project and the track, and can clear', async () => {
  const t = setup();
  try {
    const { project } = await projects.createProject({ name: 'P' });
    t.db.rows.tracks.push({ id: 'trk', projectId: project.id, name: 'T', created: 'x' });
    t.db.rows.tracks.push({ id: 'other', projectId: 'someone-else', name: 'T', created: 'x' });
    assert.equal(projects.assignSession('s1', 'nope', null).error, 'Project not found');
    assert.match(projects.assignSession('s1', project.id, 'other').error, /Track not found/);
    assert.equal(projects.assignSession('s1', project.id, 'trk').ok, true);
    assert.deepEqual(t.db.rows.meta.get('s1'), { projectId: project.id, trackId: 'trk' });
    assert.equal(projects.assignSession('s1', null, null).ok, true);
    assert.deepEqual(t.db.rows.meta.get('s1'), { projectId: null, trackId: null });
  } finally { t.cleanup(); }
});

test('recordLaunchAssignment ignores unknown projects and mismatched tracks', async () => {
  const t = setup();
  try {
    const { project } = await projects.createProject({ name: 'P' });
    t.db.rows.tracks.push({ id: 'trk', projectId: 'elsewhere', name: 'T', created: 'x' });
    assert.equal(projects.recordLaunchAssignment('s1', { projectId: 'nope' }), null);
    assert.equal(projects.recordLaunchAssignment('s1', {}), null);
    assert.deepEqual(projects.recordLaunchAssignment('s1', { projectId: project.id, trackId: 'trk' }), { projectId: project.id, trackId: null });
    assert.deepEqual(t.db.rows.meta.get('s1'), { projectId: project.id, trackId: null });
  } finally { t.cleanup(); }
});

test('createTrack validates the project, name, folder and CLI', async () => {
  const t = setup();
  try {
    projects.init({
      db: t.db, log: { info() {}, error() {} }, buildProjectsFromCache: () => [],
      notifyRendererProjectsChanged() {}, isHarnessId: (id) => id === 'claude' || id === 'codex',
    });
    const repo = tmpDir('switchboard-repo-');
    try {
      const { project } = await projects.createProject({ name: 'Feature', folders: [{ path: repo }] });
      assert.equal(projects.createTrack('nope', { name: 'Build' }).error, 'Project not found');
      assert.match(projects.createTrack(project.id, { name: '  ' }).error, /name/i);
      assert.match(projects.createTrack(project.id, { name: 'Build', cwd: os.tmpdir() }).error, /inside/);
      assert.match(projects.createTrack(project.id, { name: 'Build', cwd: 'relative' }).error, /absolute/);
      assert.match(projects.createTrack(project.id, { name: 'Build', cli: 'gemini' }).error, /Unknown CLI/);

      const root = projects.createTrack(project.id, { name: 'Plan' });
      assert.equal(root.ok, true);
      assert.equal(root.track.cwd, null, 'no cwd means the project default');
      assert.equal(root.track.cli, null);
      assert.equal(root.track.sortOrder, 0);

      const sub = path.join(repo, 'packages', 'web');
      fs.mkdirSync(sub, { recursive: true });
      const build = projects.createTrack(project.id, { name: 'Build', cwd: sub, cli: 'codex' });
      assert.equal(build.ok, true);
      assert.equal(build.track.cwd, sub, 'inside an attached folder is allowed');
      assert.equal(build.track.cli, 'codex');
      assert.equal(build.track.sortOrder, 1);

      const inRoot = projects.createTrack(project.id, { name: 'Notes', cwd: project.root });
      assert.equal(inRoot.ok, true);
      assert.deepEqual(build.project.tracks.map(x => x.name), ['Plan', 'Build']);
    } finally { rm(repo); }
  } finally { t.cleanup(); }
});

test('updateTrack and deleteTrack; deleting keeps sessions in the project', async () => {
  const t = setup();
  try {
    const { project } = await projects.createProject({ name: 'Feature' });
    const { track } = projects.createTrack(project.id, { name: 'Build' });
    assert.equal(projects.updateTrack('nope', { name: 'x' }).error, 'Track not found');
    assert.match(projects.updateTrack(track.id, { name: ' ' }).error, /name/i);
    assert.match(projects.updateTrack(track.id, { cwd: os.tmpdir() }).error, /inside/);
    assert.equal(projects.updateTrack(track.id, { status: 'later' }).error, 'Unknown status: later');
    const updated = projects.updateTrack(track.id, { name: 'Build v2', status: 'done', cwd: project.root, cli: '' }).track;
    assert.equal(updated.name, 'Build v2');
    assert.equal(updated.status, 'done');
    assert.equal(updated.cwd, project.root);
    assert.equal(updated.cli, null);

    projects.assignSession('s1', project.id, track.id);
    projects.assignSession('s2', project.id, null);
    const removed = projects.deleteTrack(track.id);
    assert.equal(removed.ok, true);
    assert.equal(removed.projectId, project.id);
    assert.deepEqual(t.db.rows.meta.get('s1'), { projectId: project.id, trackId: null }, 'session stays in the project');
    assert.deepEqual(t.db.rows.meta.get('s2'), { projectId: project.id, trackId: null });
    assert.equal(projects.deleteTrack(track.id).error, 'Track not found');
  } finally { t.cleanup(); }
});

test('the brief uses absolute paths and keeps its attached-folder list current', async () => {
  const t = setup();
  try {
    const a = tmpDir('switchboard-repo-a-');
    const b = tmpDir('switchboard-repo-b-');
    try {
      const { project } = await projects.createProject({ name: 'Feature', folders: [{ path: a }] });
      const claudeMd = path.join(project.root, 'CLAUDE.md');
      const agentsMd = path.join(project.root, 'AGENTS.md');
      let brief = fs.readFileSync(claudeMd, 'utf8');
      assert.ok(brief.includes(`Project folder: ${project.root}`));
      assert.ok(brief.includes(path.join(project.root, 'plan.md')), 'plan path is absolute');
      assert.ok(brief.includes(path.join(project.root, 'plan-tracker.md')), 'tracker path is absolute');
      assert.ok(brief.includes(path.join(project.root, 'todos.md')), 'todos path is absolute');
      assert.ok(!brief.includes('./plan.md'), 'no relative paths');
      assert.match(brief, /only when the user refers to the plan/, 'not read every session');
      assert.match(brief, /"## Phase N: title"/, 'tracker format spelled out');
      assert.ok(brief.includes(path.join(project.root, 'memory.md')), 'memory file named');
      assert.match(brief, /does not belong in the todos as well/, 'plan items are not duplicated as todos');
      assert.match(brief, /Create them when you first need them/);
      assert.ok(brief.includes(`- ${path.resolve(a)}`), 'attached folder listed');
      assert.ok(brief.includes('read its own instructions'), 'tells the agent to read the folder\'s own md');
      assert.equal(fs.readFileSync(agentsMd, 'utf8'), brief);

      // The user's own edits outside the managed block survive a resync.
      fs.writeFileSync(claudeMd, '# My own heading\nMy notes.\n\n' + brief, 'utf8');
      await projects.attachFolder(project.id, { path: b });
      brief = fs.readFileSync(claudeMd, 'utf8');
      assert.ok(brief.startsWith('# My own heading\nMy notes.'), 'user text kept');
      assert.ok(brief.includes(`- ${path.resolve(a)}`) && brief.includes(`- ${path.resolve(b)}`), 'both folders listed');
      assert.equal((brief.match(/<!-- switchboard:folders -->/g) || []).length, 1, 'one managed block');

      await projects.detachFolder(project.id, path.resolve(a));
      brief = fs.readFileSync(claudeMd, 'utf8');
      assert.ok(!brief.includes(`- ${path.resolve(a)}`));
      assert.ok(brief.includes(`- ${path.resolve(b)}`));

      // A brief whose block was deleted gets it appended again.
      fs.writeFileSync(agentsMd, '# Rewritten by hand\n', 'utf8');
      await projects.detachFolder(project.id, path.resolve(b));
      const agents = fs.readFileSync(agentsMd, 'utf8');
      assert.ok(agents.startsWith('# Rewritten by hand'));
      assert.ok(agents.includes('No folders are attached yet'));
    } finally { rm(a); rm(b); }
  } finally { t.cleanup(); }
});

test('defaultCwd is validated, and detaching a folder resets cwds that pointed into it', async () => {
  const t = setup();
  try {
    const repo = tmpDir('switchboard-repo-');
    try {
      const { project } = await projects.createProject({ name: 'Feature', folders: [{ path: repo }] });
      assert.equal(project.defaultCwd, null, 'sessions start in the project folder by default');
      assert.match(projects.updateProject(project.id, { defaultCwd: os.tmpdir() }).error, /inside/);
      assert.equal(projects.updateProject(project.id, { defaultCwd: path.resolve(repo) }).project.defaultCwd, path.resolve(repo));
      assert.equal(projects.updateProject(project.id, { defaultCwd: '' }).project.defaultCwd, null);
      projects.updateProject(project.id, { defaultCwd: path.resolve(repo) });
      const { track } = projects.createTrack(project.id, { name: 'Build', cwd: path.resolve(repo) });
      const after = (await projects.detachFolder(project.id, path.resolve(repo))).project;
      assert.equal(after.defaultCwd, null, 'project default falls back to the project folder');
      assert.equal(after.tracks.find(x => x.id === track.id).cwd, null, 'track falls back too');
    } finally { rm(repo); }
  } finally { t.cleanup(); }
});

test('launchContext adds the project folder and every attached folder the cwd is not in', async () => {
  const t = setup();
  try {
    const a = tmpDir('switchboard-repo-a-');
    const b = tmpDir('switchboard-repo-b-');
    try {
      const { project } = await projects.createProject({ name: 'Feature', folders: [{ path: a }, { path: b }] });
      const A = path.resolve(a), B = path.resolve(b), R = project.root;
      assert.deepEqual(projects.launchContext(project.id, R).addDirs, [A, B], 'from the project folder: every repo');
      assert.deepEqual(projects.launchContext(project.id, A).addDirs, [R, B], 'from a repo: the project folder and the other repo');
      assert.deepEqual(projects.launchContext(project.id, path.join(A, 'sub', 'dir')).addDirs, [R, A, B], 'from inside a repo: the repo itself too, so the whole repo is editable');
      assert.deepEqual(projects.launchContext(project.id, '/somewhere/else').addDirs, [R, A, B]);
      assert.deepEqual(projects.launchContext(project.id, R).env, { CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: '1' });
      assert.equal(projects.launchContext(project.id, R).worktree, false);
      assert.equal(projects.launchContext('nope', R), null);

      const { project: bare } = await projects.createProject({ name: 'Bare' });
      assert.deepEqual(projects.launchContext(bare.id, bare.root), { addDirs: [], env: {}, worktree: false });

      assert.equal(projects.mergeAddDirs('', [A]), A);
      assert.equal(projects.mergeAddDirs(' /x , ' + A, [A, B]), `/x,${A},${B}`);
      assert.equal(projects.mergeAddDirs(undefined, []), '');
    } finally { rm(a); rm(b); }
  } finally { t.cleanup(); }
});

test('attaching on a branch makes a worktree under repos/ with the Codex bridge file', { skip: !haveGit && 'git not installed' }, async () => {
  const t = setup();
  const repo = makeRepo();
  const other = makeRepo('switchboard-repo-other-');
  try {
    const plain = tmpDir('switchboard-plain-');
    try {
      assert.match((await projects.createProject({ name: 'Plain', folders: [{ path: plain, mode: 'worktree' }] })).errors[0], /not inside a git repository/);
    } finally { rm(plain); }

    fs.writeFileSync(path.join(repo, 'AGENTS.md'), '# Repo rules\nBe tidy.\n');
    gitIn(repo, 'add', 'AGENTS.md');
    gitIn(repo, 'commit', '-q', '-m', 'agents');

    const created = await projects.createProject({
      name: 'Feature X',
      folders: [{ path: repo, mode: 'worktree' }, { path: other, mode: 'worktree' }],
    });
    assert.equal(created.ok, true);
    assert.deepEqual(created.errors, []);
    const project = created.project;
    assert.equal(project.folders.length, 2);
    const [wt, wt2] = project.folders;
    assert.equal(wt.mode, 'worktree');
    assert.equal(wt.branch, 'feature-x', 'shared branch defaults to the slug');
    assert.equal(wt2.branch, 'feature-x', 'same branch in every repo');
    assert.equal(wt.sourcePath, path.resolve(repo));
    assert.equal(wt.path, path.join(project.root, 'repos', path.basename(repo)));
    assert.ok(fs.existsSync(path.join(wt.path, 'README.md')), 'checkout populated');
    assert.equal(gitIn(wt.path, 'rev-parse', '--abbrev-ref', 'HEAD'), 'feature-x');
    assert.equal(gitIn(repo, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main', 'source repo untouched');

    // The brief lists the worktree path, and the bridge carries brief + repo rules.
    const brief = fs.readFileSync(path.join(project.root, 'CLAUDE.md'), 'utf8');
    assert.ok(brief.includes(`- ${wt.path}`));
    const bridge = fs.readFileSync(path.join(wt.path, projects.CODEX_BRIDGE_FILE), 'utf8');
    assert.ok(bridge.includes('# Feature X'), 'project brief');
    assert.ok(bridge.includes('Be tidy.'), 'repo AGENTS.md appended');
    const exclude = fs.readFileSync(path.join(repo, '.git', 'info', 'exclude'), 'utf8');
    assert.ok(exclude.split('\n').includes(projects.CODEX_BRIDGE_FILE), 'excluded from git');
    assert.equal(gitIn(wt.path, 'status', '--porcelain'), '', 'bridge file does not show as untracked');

    assert.match((await projects.attachFolder(project.id, { path: repo, mode: 'worktree' })).error, /already attached/);

    // A session in the worktree: project folder and the other worktree are added.
    const ctx = projects.launchContext(project.id, wt.path);
    assert.equal(ctx.worktree, true);
    assert.deepEqual(ctx.addDirs, [project.root, wt2.path]);
    assert.equal(projects.worktreeParentFor(wt.path), path.resolve(repo));
    assert.equal(projects.worktreeParentFor(repo), null);

    // Dirty worktree: refused without force, removed with it.
    fs.writeFileSync(path.join(wt.path, 'scratch.txt'), 'wip\n');
    const refused = await projects.detachFolder(project.id, wt.path, { removeWorktree: true });
    assert.equal(refused.dirty, true);
    assert.ok(fs.existsSync(wt.path));
    const forced = await projects.detachFolder(project.id, wt.path, { removeWorktree: true, force: true });
    assert.equal(forced.ok, true);
    assert.equal(forced.worktreeRemoved, true);
    assert.ok(!fs.existsSync(wt.path), 'checkout removed');
    assert.equal(gitIn(repo, 'rev-parse', '--verify', 'refs/heads/feature-x').length, 40, 'branch kept');

    // Marking done reports the remaining worktree; detaching without removal keeps it on disk.
    const done = projects.updateProject(project.id, { status: 'done' });
    assert.deepEqual(done.worktrees, [wt2.path]);
    const kept = await projects.detachFolder(project.id, wt2.path, {});
    assert.equal(kept.worktreeRemoved, false);
    assert.ok(fs.existsSync(wt2.path), 'kept on disk');
    assert.ok(!fs.existsSync(path.join(wt2.path, projects.CODEX_BRIDGE_FILE)), 'bridge file removed');
    gitIn(other, 'worktree', 'remove', '--force', wt2.path);
  } finally {
    t.cleanup();
    rm(repo);
    rm(other);
  }
});

test('per-repo branch names when the shared branch is off', { skip: !haveGit && 'git not installed' }, async () => {
  const t = setup();
  const repo = makeRepo();
  try {
    const { project } = await projects.createProject({ name: 'Split', sharedBranch: false });
    const attached = await projects.attachFolder(project.id, { path: repo, mode: 'worktree', branch: 'my/branch' });
    assert.equal(attached.ok, true, attached.error);
    assert.equal(attached.folder.branch, 'my/branch');
    assert.equal(gitIn(attached.folder.path, 'rev-parse', '--abbrev-ref', 'HEAD'), 'my/branch');
    assert.match((await projects.attachFolder(project.id, { path: repo, mode: 'worktree', branch: '-x' })).error, /Invalid branch name/);
    assert.match((await projects.attachFolder(project.id, { path: repo, mode: 'worktree', branch: 'again' })).error, /already attached/);
    await projects.detachFolder(project.id, attached.folder.path, { removeWorktree: true });
    assert.ok(!fs.existsSync(attached.folder.path));
  } finally {
    t.cleanup();
    rm(repo);
  }
});

test('saveBrief writes CLAUDE.md and AGENTS.md alike and restores the folder block', async () => {
  const t = setup();
  try {
    const repo = tmpDir('switchboard-repo-');
    try {
      const { project } = await projects.createProject({ name: 'Brief', folders: [{ path: repo }] });
      assert.equal((await projects.saveBrief('nope', 'x')).error, 'Project not found');
      assert.match((await projects.saveBrief(project.id, 42)).error, /text/);

      const saved = await projects.saveBrief(project.id, '# Brief\n\nShip the thing.');
      assert.equal(saved.ok, true);
      assert.ok(saved.content.startsWith('# Brief\n\nShip the thing.\n'), 'user text first, newline added');
      assert.ok(saved.content.includes(`- ${path.resolve(repo)}`), 'folder block put back');
      assert.equal(fs.readFileSync(path.join(project.root, 'CLAUDE.md'), 'utf8'), saved.content);
      assert.equal(fs.readFileSync(path.join(project.root, 'AGENTS.md'), 'utf8'), saved.content);
      assert.equal((saved.content.match(/<!-- switchboard:folders -->/g) || []).length, 1);
    } finally { rm(repo); }
  } finally { t.cleanup(); }
});

test('readProjectPlan, setPlanItem, appendPlanItem and links work on the tracker and todos', async () => {
  const t = setup();
  try {
    const { project } = await projects.createProject({ name: 'Tracked' });
    let read = projects.readProjectPlan(project.id);
    assert.equal(read.ok, true);
    assert.deepEqual([read.hasPlan, read.hasTracker, read.hasTodos], [false, false, false], 'nothing exists up front');
    assert.equal(read.plan.total, 0);

    assert.match(projects.setPlanItem(project.id, 'plan', 0, true).error, /does not exist/);
    assert.match(projects.setPlanItem(project.id, 'notes', 0, true).error, /Unknown file/);

    fs.writeFileSync(path.join(project.root, 'plan-tracker.md'), '# Tracker\n\n## Phase 1: Start\n- [ ] one\n- [ ] two\n\n## Phase 2: Finish\n- [ ] three\n');
    read = projects.readProjectPlan(project.id);
    assert.equal(read.plan.total, 2);
    assert.equal(read.plan.next.title, 'Phase 1: Start');

    const ticked = projects.setPlanItem(project.id, 'plan', 3, true);
    assert.equal(ticked.ok, true);
    assert.equal(ticked.text, 'one');
    assert.ok(fs.readFileSync(path.join(project.root, 'plan-tracker.md'), 'utf8').includes('- [x] one'));
    assert.match(projects.setPlanItem(project.id, 'plan', 1, true).error, /not a checkbox/);

    assert.match(projects.appendPlanItem(project.id, 'todos', '   ').error, /Nothing/);
    assert.equal(projects.appendPlanItem(project.id, 'todos', 'Call back').ok, true);
    read = projects.readProjectPlan(project.id);
    assert.equal(read.hasTodos, true, 'todos.md created on first append');
    assert.deepEqual(read.todos.map(x => [x.text, x.done]), [['Call back', false]]);
    assert.ok(fs.readFileSync(path.join(project.root, 'todos.md'), 'utf8').startsWith('# Tracked todos\n'));

    assert.equal(projects.recordPlanLink(project.id, 'plan', 'Phase 1: Start', 'sess-1', 'started'), true);
    assert.equal(projects.recordPlanLink(project.id, 'plan', '', 'sess-1', 'started'), false);
    read = projects.readProjectPlan(project.id);
    assert.deepEqual(read.links.map(l => [l.file, l.itemText, l.sessionId, l.kind]), [['plan', 'Phase 1: Start', 'sess-1', 'started']]);
    assert.equal(projects.readProjectPlan('nope').error, 'Project not found');
  } finally { t.cleanup(); }
});

test('the plan watcher credits a tick to the running project session', async () => {
  const t = setup();
  try {
    const { project } = await projects.createProject({ name: 'Watched' });
    const sent = [];
    const activeSessions = new Map([
      ['s-old', { projectId: project.id, _openedAt: 1, exited: false }],
      ['s-new', { projectId: project.id, _openedAt: 2, exited: false }],
      ['s-other', { projectId: 'someone-else', _openedAt: 3, exited: false }],
      ['s-dead', { projectId: project.id, _openedAt: 4, exited: true }],
    ]);
    projects.initPlanWatch({ activeSessions, send: (channel, id) => sent.push([channel, id]) });
    try {
      const tracker = path.join(project.root, 'plan-tracker.md');
      fs.writeFileSync(tracker, '## Phase 1: A\n- [ ] one\n');
      await new Promise(r => setTimeout(r, 700));
      fs.writeFileSync(tracker, '## Phase 1: A\n- [x] one\n');
      await new Promise(r => setTimeout(r, 700));
      const links = projects.readProjectPlan(project.id).links;
      assert.deepEqual(links.map(l => [l.itemText, l.sessionId, l.kind]), [['one', 's-new', 'ticked']], 'newest running session of the project');
      assert.ok(sent.some(([channel, id]) => channel === 'project-plan-changed' && id === project.id));

      // A tick made through setPlanItem is the page's, not a session's.
      const before = links.length;
      projects.setPlanItem(project.id, 'plan', 0, true);
      await new Promise(r => setTimeout(r, 700));
      assert.equal(projects.readProjectPlan(project.id).links.length, before);
    } finally {
      projects.stopPlanWatchers();
    }
  } finally { t.cleanup(); }
});

test('adoptPlan copies a plan-mode plan into plan.md and refuses to clobber one', async () => {
  const t = setup();
  const plans = tmpDir('switchboard-plans-');
  try {
    projects.init({ db: t.db, log: { info() {}, error() {} }, buildProjectsFromCache: () => [], notifyRendererProjectsChanged() {}, plansDir: plans });
    fs.writeFileSync(path.join(plans, 'big-idea.md'), '# Big idea\n\nDo the thing.\n');
    const { project } = await projects.createProject({ name: 'Adopter' });
    assert.match(projects.adoptPlan(project.id, 'missing.md').error, /no longer exists/);
    assert.equal(projects.adoptPlan(project.id, '../big-idea.md').ok, true, 'basename only');
    assert.equal(fs.readFileSync(path.join(project.root, 'plan.md'), 'utf8'), '# Big idea\n\nDo the thing.\n');
    fs.writeFileSync(path.join(plans, 'other.md'), '# Other\n\nSomething else.\n');
    const refused = projects.adoptPlan(project.id, 'other.md');
    assert.equal(refused.exists, true);
    assert.equal(projects.adoptPlan(project.id, 'other.md', { replace: true }).ok, true);
    assert.ok(fs.readFileSync(path.join(project.root, 'plan.md'), 'utf8').startsWith('# Other'));
  } finally {
    rm(plans);
    t.cleanup();
  }
});

test('templates: listed from the bundled folder, applied with tokens, tracks created, rules appended', async () => {
  const t = setup();
  const bundled = path.join(__dirname, '..', 'templates');
  try {
    projects.init({
      db: t.db, log: { info() {}, error() {} }, buildProjectsFromCache: () => [],
      notifyRendererProjectsChanged() {}, templatesDir: bundled, isHarnessId: (id) => id === 'claude' || id === 'codex',
    });
    const listed = projects.listTemplates();
    assert.equal(listed.dir, bundled);
    assert.deepEqual(listed.templates.map(x => x.kind), ['customer', 'feature', 'research']);
    assert.deepEqual(listed.templates.find(x => x.kind === 'feature').tracks.map(x => x.name), ['Plan', 'Build', 'Review']);

    assert.match((await projects.createProject({ name: 'x', template: 'nope' })).error, /Unknown template/);
    assert.match((await projects.createProject({ name: 'x', template: '../etc' })).error, /Unknown template/);

    const { project } = await projects.createProject({ name: 'Onboarding flow', template: 'customer' });
    assert.deepEqual(project.tracks.map(x => x.name), ['Discovery', 'Proposal', 'Build']);
    assert.deepEqual(project.tracks.map(x => x.cwd), [null, null, null], 'template tracks start in the project folder');
    const brief = fs.readFileSync(path.join(project.root, 'CLAUDE.md'), 'utf8');
    assert.ok(brief.startsWith('# Onboarding flow\n'), 'template heading with the name filled in');
    assert.ok(brief.includes('## How this project works'), 'template text kept');
    assert.ok(brief.includes(`Project folder: ${project.root}`), 'root token filled in');
    assert.ok(!brief.includes('{{'), 'no tokens left');
    assert.ok(brief.includes('## Working rules'), 'rules still appended');
    assert.ok(brief.includes('<!-- switchboard:folders -->'), 'folder block still appended');
    assert.equal(fs.readFileSync(path.join(project.root, 'AGENTS.md'), 'utf8'), brief);
    assert.ok(fs.readFileSync(path.join(project.root, 'contacts.md'), 'utf8').startsWith('# Contacts for Onboarding flow'));
    assert.ok(fs.existsSync(path.join(project.root, 'proposals', 'README.md')));
    assert.ok(!fs.existsSync(path.join(project.root, 'template.json')), 'metadata not copied');
    assert.ok(!fs.existsSync(path.join(project.root, 'plan.md')), 'still no plan until a session writes one');
  } finally { t.cleanup(); }
});

test('templates are seeded once into a missing folder and never overwritten', () => {
  const dir = path.join(tmpDir('switchboard-tpl-'), 'templates');
  try {
    projects.init({ db: makeFakeDb(), log: { info() {}, error() {} }, buildProjectsFromCache: () => [], templatesDir: dir });
    const first = projects.listTemplates();
    assert.equal(first.templates.length, 3, 'seeded from the bundle');
    fs.writeFileSync(path.join(dir, 'feature', 'CLAUDE.md'), '# {{name}}\n\nMine now.\n');
    fs.mkdirSync(path.join(dir, 'mine'));
    fs.writeFileSync(path.join(dir, 'mine', 'template.json'), JSON.stringify({ name: 'Mine', tracks: [{ name: 'Only', cli: 'codex' }] }));
    fs.mkdirSync(path.join(dir, 'broken'));
    fs.writeFileSync(path.join(dir, 'broken', 'template.json'), '{ not json');
    const second = projects.listTemplates();
    assert.deepEqual(second.templates.map(x => x.name), ['Customer', 'Feature', 'Mine', 'Research'], 'user template listed, broken one skipped');
    assert.ok(fs.readFileSync(path.join(dir, 'feature', 'CLAUDE.md'), 'utf8').includes('Mine now.'), 'edit kept');
    assert.deepEqual(second.templates.find(x => x.kind === 'mine').tracks, [{ name: 'Only', cli: 'codex' }]);
  } finally {
    rm(path.dirname(dir));
  }
});

test('projectsRoot expands ~ and falls back to ~/Switchboard', () => {
  const home = os.homedir();
  projects.init({ db: { getSetting: () => ({ projectsRoot: '~/Work/projects' }) }, buildProjectsFromCache: () => [] });
  assert.equal(projects.projectsRoot(), path.join(home, 'Work', 'projects'));
  projects.init({ db: { getSetting: () => ({}) }, buildProjectsFromCache: () => [] });
  assert.equal(projects.projectsRoot(), path.join(home, 'Switchboard'));
  projects.init({ db: { getSetting: () => null }, buildProjectsFromCache: () => [] });
  assert.equal(projects.projectsRoot(), path.join(home, 'Switchboard'));
});

test('folderGitStatus reads the live branch of an in-place repo and skips plain folders', { skip: !haveGit && 'git not installed' }, async () => {
  const t = setup();
  const repo = makeRepo();
  const plain = tmpDir('switchboard-plain-');
  try {
    const created = await projects.createProject({
      name: 'Live branch',
      folders: [{ path: repo, mode: 'in-place' }, { path: plain, mode: 'in-place' }],
    });
    assert.equal(created.ok, true);

    const first = await projects.folderGitStatus(created.project.id);
    assert.equal(first.ok, true);
    assert.equal(first.byPath[repo].git, true);
    assert.equal(first.byPath[repo].branch, 'main');
    assert.equal(first.byPath[repo].dirty, false);
    assert.deepEqual(first.byPath[plain], { git: false });

    // The cache hides a change until it is forced or expires.
    gitIn(repo, 'checkout', '-q', '-b', 'topic');
    fs.writeFileSync(path.join(repo, 'notes.txt'), 'wip\n');
    assert.equal((await projects.folderGitStatus(created.project.id)).byPath[repo].branch, 'main');
    const forced = await projects.folderGitStatus(created.project.id, { force: true });
    assert.equal(forced.byPath[repo].branch, 'topic');
    assert.equal(forced.byPath[repo].dirty, true);

    await assert.rejects(projects.folderGitStatus('missing'), /not found/);
  } finally {
    rm(plain);
    rm(repo);
    t.cleanup();
  }
});

test('projectGitInfo and projectGitDiff expose read-only data for attached repositories only', { skip: !haveGit && 'git not installed' }, async () => {
  const t = setup();
  const repo = makeRepo();
  const other = makeRepo('switchboard-other-repo-');
  try {
    const created = await projects.createProject({
      name: 'Git details',
      folders: [{ path: repo, mode: 'in-place' }],
    });
    fs.writeFileSync(path.join(repo, 'README.md'), '# changed\n');

    const info = await projects.projectGitInfo(created.project.id);
    assert.equal(info.ok, true);
    assert.equal(info.repositories.length, 1);
    assert.equal(info.repositories[0].path, repo);
    assert.equal(info.repositories[0].changes[0].path, 'README.md');

    const diff = await projects.projectGitDiff(created.project.id, repo, 'README.md');
    assert.equal(diff.ok, true);
    assert.match(diff.diff, /[+]# changed/);

    await assert.rejects(projects.projectGitDiff(created.project.id, other, 'README.md'), /not attached/);
  } finally {
    rm(other);
    rm(repo);
    t.cleanup();
  }
});

test('editPlanItem rewrites a checkbox line and keeps its tick', async () => {
  const t = setup();
  try {
    const { project } = await projects.createProject({ name: 'Edited' });
    assert.match(projects.editPlanItem(project.id, 'todos', 0, 'x').error, /does not exist/);
    assert.equal(projects.appendPlanItem(project.id, 'todos', 'Call back').ok, true);
    assert.equal(projects.appendPlanItem(project.id, 'todos', 'Send invoice').ok, true);
    let read = projects.readProjectPlan(project.id);
    const first = read.todos[0];
    assert.equal(projects.setPlanItem(project.id, 'todos', first.line, true).ok, true);

    const edited = projects.editPlanItem(project.id, 'todos', first.line, '  Call the client back ');
    assert.equal(edited.ok, true);
    assert.equal(edited.text, 'Call the client back');
    assert.equal(edited.previous, 'Call back');
    read = projects.readProjectPlan(project.id);
    assert.deepEqual(read.todos.map(x => [x.text, x.done]), [['Call the client back', true], ['Send invoice', false]], 'text changes, tick and order stay');

    assert.match(projects.editPlanItem(project.id, 'todos', first.line, '   ').error, /Nothing/);
    assert.match(projects.editPlanItem(project.id, 'todos', 0, 'Heading').error, /not a checkbox/);
    assert.match(projects.editPlanItem(project.id, 'notes', 0, 'x').error, /Unknown file/);
  } finally {
    t.cleanup();
  }
});

test('listEnvFiles finds .env and .env.*, sorted, samples excluded from the default pick', () => {
  const dir = tmpDir('switchboard-env-');
  try {
    assert.deepEqual(projects.listEnvFiles(dir), [], 'a folder with no .env has none');
    fs.writeFileSync(path.join(dir, '.env'), 'A=1\n');
    fs.writeFileSync(path.join(dir, '.env.local'), 'B=2\n');
    fs.writeFileSync(path.join(dir, '.env.example'), 'A=\n');
    fs.writeFileSync(path.join(dir, 'env'), 'not one\n');
    fs.writeFileSync(path.join(dir, '.environment'), 'not one either\n');
    fs.mkdirSync(path.join(dir, '.env.d'));

    assert.deepEqual(projects.listEnvFiles(dir), ['.env', '.env.example', '.env.local'],
      'files only, sorted, nothing that merely starts with .env');
    assert.deepEqual(projects.defaultEnvSelection(dir), ['.env', '.env.local'],
      'a sample is listed but not ticked');
    assert.deepEqual(projects.listEnvFiles(path.join(dir, 'nope')), [], 'a missing folder has none');
  } finally { rm(dir); }
});

test('copyEnvFiles copies only the named files, never overwrites, ignores names the source lacks', () => {
  const source = tmpDir('switchboard-env-src-');
  const target = tmpDir('switchboard-env-dst-');
  try {
    fs.writeFileSync(path.join(source, '.env'), 'A=1\n');
    fs.writeFileSync(path.join(source, '.env.local'), 'B=2\n');
    fs.writeFileSync(path.join(source, '.env.test'), 'C=3\n');
    fs.writeFileSync(path.join(target, '.env.local'), 'KEEP=me\n');

    const result = projects.copyEnvFiles(source, target, ['.env', '.env.local', '../../secrets', '.env.missing']);
    assert.deepEqual(result.copied, ['.env']);
    assert.deepEqual(result.skipped, ['.env.local', '../../secrets', '.env.missing']);
    assert.equal(fs.readFileSync(path.join(target, '.env'), 'utf8'), 'A=1\n');
    assert.equal(fs.readFileSync(path.join(target, '.env.local'), 'utf8'), 'KEEP=me\n', 'an existing file is left alone');
    assert.equal(fs.existsSync(path.join(target, '.env.test')), false, 'a file that was not asked for is not copied');
    assert.deepEqual(projects.copyEnvFiles(source, target, []), { copied: [], skipped: [] });
  } finally { rm(source); rm(target); }
});

test('a new worktree gets the .env files the caller picked', { skip: !haveGit && 'git not installed' }, async () => {
  const t = setup();
  const repo = makeRepo('switchboard-repo-env-');
  try {
    fs.writeFileSync(path.join(repo, '.env'), 'TOKEN=abc\n');
    fs.writeFileSync(path.join(repo, '.env.local'), 'PORT=3000\n');
    fs.writeFileSync(path.join(repo, '.env.example'), 'TOKEN=\n');

    const created = await projects.createProject({
      name: 'Env Feature',
      folders: [{ path: repo, mode: 'worktree', copyEnv: ['.env', '.env.local'] }],
    });
    assert.equal(created.ok, true);
    assert.deepEqual(created.errors, []);
    const wt = created.project.folders[0];
    assert.equal(fs.readFileSync(path.join(wt.path, '.env'), 'utf8'), 'TOKEN=abc\n');
    assert.equal(fs.readFileSync(path.join(wt.path, '.env.local'), 'utf8'), 'PORT=3000\n');
    assert.equal(fs.existsSync(path.join(wt.path, '.env.example')), false, 'an unticked file stays behind');

    // Attaching a second repo without copyEnv leaves its .env behind.
    const other = makeRepo('switchboard-repo-env2-');
    try {
      fs.writeFileSync(path.join(other, '.env'), 'X=1\n');
      const attached = await projects.attachFolder(created.project.id, { path: other, mode: 'worktree' });
      assert.equal(attached.ok, true);
      const wt2 = attached.project.folders.find(f => f.sourcePath === path.resolve(other));
      assert.equal(fs.existsSync(path.join(wt2.path, '.env')), false, 'nothing is copied unless it was asked for');
      gitIn(other, 'worktree', 'remove', '--force', wt2.path);
    } finally { rm(other); }

    gitIn(repo, 'worktree', 'remove', '--force', wt.path);
  } finally { rm(repo); t.cleanup(); }
});
