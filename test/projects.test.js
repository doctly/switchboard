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
  const rows = { projects: [], folders: [], tracks: [], schedules: [], scheduleImports: new Set(), settings: new Map(), meta: new Map() };
  const db = {
    rows,
    getSetting: (key) => (key === 'global' ? global : (rows.settings.get(key) ?? null)),
    setSetting: (key, value) => { rows.settings.set(key, value); },
    listSchedules: () => rows.schedules.map(r => ({ ...r })),
    listSchedulesByProject: (projectId) => rows.schedules.filter(r => r.projectId === projectId).map(r => ({ ...r })),
    getSchedule: (id) => { const r = rows.schedules.find(x => x.id === id); return r ? { ...r } : null; },
    insertSchedule: (row) => { rows.schedules.push({ ...row, enabled: row.enabled === false ? 0 : 1, catchUp: row.catchUp ? 1 : 0 }); },
    getImportedScheduleFiles: () => [...rows.scheduleImports],
    importLegacySchedule: (row) => {
      if (rows.scheduleImports.has(row.sourceFile)) return false;
      db.insertSchedule(row);
      rows.scheduleImports.add(row.sourceFile);
      return true;
    },
    updateSchedule: (id, patch) => {
      const r = rows.schedules.find(x => x.id === id);
      if (!r) return 0;
      for (const key of ['name', 'trackId', 'cwd', 'prompt', 'every', 'atHour', 'atMinute', 'weekday', 'cron', 'cli', 'enabled', 'catchUp', 'lastRunAt', 'lastSessionId', 'sessionConfig']) {
        if (key in patch) r[key] = (key === 'enabled' || key === 'catchUp') ? (patch[key] ? 1 : 0) : patch[key];
      }
      return 1;
    },
    deleteSchedule: (id) => { rows.schedules = rows.schedules.filter(x => x.id !== id); },
    recordScheduleRun: (scheduleId, sessionId, at) => {
      const r = rows.schedules.find(x => x.id === scheduleId);
      if (r) { r.lastRunAt = at; r.lastSessionId = sessionId; }
      rows.meta.set(sessionId, { ...(rows.meta.get(sessionId) || {}), scheduleId, scheduledAt: at });
    },
    listProjects: () => rows.projects.map(r => ({ ...r })),
    getProject: (id) => rows.projects.find(r => r.id === id) || null,
    getProjectBySlug: (slug) => rows.projects.find(r => r.slug === slug) || null,
    insertProject: (row) => { rows.projects.push({ ...row, sharedBranch: row.sharedBranch ? 1 : 0 }); },
    updateProject: (id, patch) => {
      const row = rows.projects.find(r => r.id === id);
      if (!row) return 0;
      for (const key of ['name', 'status', 'sharedBranch', 'branchName', 'defaultCwd', 'snoozedUntil', 'snoozedAt', 'modified']) {
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
      for (const r of rows.schedules) if (r.trackId === id) r.trackId = null;
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
      assert.match(brief, /^<!-- switchboard:managed -->\n/, 'the managed block leads');
      assert.match(brief, /\n# Website upkeep\n/, 'title inside the block');
      assert.ok(!brief.includes('Edit me.'), 'no placeholder line');
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

test('snooze: a wake time in the future, kept as an overlay on an active project', async () => {
  const t = setup();
  try {
    const { project } = await projects.createProject({ name: 'Later' });
    assert.equal(project.snoozedUntil, null);
    assert.equal(projects.updateProject(project.id, { snoozedUntil: 'soon' }).error, 'Wake time must be an ISO date');
    assert.equal(projects.updateProject(project.id, { snoozedUntil: new Date(Date.now() - 1000).toISOString() }).error, 'Wake time must be in the future');

    const wake = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const snoozed = projects.updateProject(project.id, { snoozedUntil: wake }).project;
    assert.equal(snoozed.snoozedUntil, wake);
    assert.ok(snoozed.snoozedAt, 'snoozedAt is stamped');
    assert.equal(snoozed.status, 'active', 'snooze does not change the status');

    const again = projects.updateProject(project.id, { snoozedUntil: wake }).project;
    assert.equal(again.snoozedAt, snoozed.snoozedAt, 'the same wake time keeps the original snoozedAt');
    const later = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
    assert.equal(projects.updateProject(project.id, { snoozedUntil: later }).project.snoozedUntil, later);

    const done = projects.updateProject(project.id, { status: 'done' }).project;
    assert.equal(done.snoozedUntil, null, 'finishing a project ends its snooze');
    assert.equal(done.snoozedAt, null);
    assert.equal(projects.updateProject(project.id, { snoozedUntil: wake }).error, 'A finished project cannot be snoozed');

    projects.updateProject(project.id, { status: 'active', snoozedUntil: wake });
    const woken = projects.updateProject(project.id, { snoozedUntil: null }).project;
    assert.equal(woken.snoozedUntil, null);
    assert.equal(woken.snoozedAt, null);
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
      assert.match(brief, /only when the user brings up the plan/, 'not read unprompted');
      assert.match(brief, /not again before each task/, 'not re-read every turn');
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
      assert.equal((brief.match(/<!-- switchboard:managed -->/g) || []).length, 1, 'one managed block');

      await projects.detachFolder(project.id, path.resolve(a));
      brief = fs.readFileSync(claudeMd, 'utf8');
      assert.ok(!brief.includes(`- ${path.resolve(a)}`));
      assert.ok(brief.includes(`- ${path.resolve(b)}`));

      // A brief whose block was deleted gets it back at the top, the user's
      // own text kept below it.
      fs.writeFileSync(agentsMd, '# Rewritten by hand\n', 'utf8');
      await projects.detachFolder(project.id, path.resolve(b));
      const agents = fs.readFileSync(agentsMd, 'utf8');
      assert.ok(agents.startsWith('<!-- switchboard:managed -->'), 'block restored at the top');
      assert.ok(agents.includes('No folders are attached yet'));
      assert.ok(agents.includes('# Rewritten by hand'), 'hand-written text kept');
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

test('project instructions stay in the project root and leave worktree instructions and ignore rules untouched', { skip: !haveGit && 'git not installed' }, async () => {
  const t = setup();
  const repo = makeRepo();
  const other = makeRepo('switchboard-repo-other-');
  try {
    const plain = tmpDir('switchboard-plain-');
    try {
      assert.match((await projects.createProject({ name: 'Plain', folders: [{ path: plain, mode: 'worktree' }] })).errors[0], /not inside a git repository/);
    } finally { rm(plain); }

    fs.writeFileSync(path.join(repo, 'AGENTS.md'), '# Repo rules\nBe tidy.\n');
    const userOverride = '# User override\nKeep these instructions.\n';
    fs.writeFileSync(path.join(repo, 'AGENTS.override.md'), userOverride);
    gitIn(repo, 'add', 'AGENTS.md', 'AGENTS.override.md');
    gitIn(repo, 'commit', '-q', '-m', 'agents');
    const excludeBefore = fs.readFileSync(path.join(repo, '.git', 'info', 'exclude'), 'utf8');

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

    // Only the project root gets the generated brief.
    const brief = fs.readFileSync(path.join(project.root, 'CLAUDE.md'), 'utf8');
    assert.ok(brief.includes(`- ${wt.path}`));
    assert.equal(fs.readFileSync(path.join(project.root, 'AGENTS.md'), 'utf8'), brief);
    assert.equal(fs.readFileSync(path.join(wt.path, 'AGENTS.override.md'), 'utf8'), userOverride);
    assert.ok(!fs.existsSync(path.join(wt2.path, 'AGENTS.override.md')), 'no generated override in a worktree');
    for (const file of ['CLAUDE.md', 'AGENTS.md']) {
      assert.ok(!fs.existsSync(path.join(wt2.path, file)), 'no generated instructions in a worktree');
    }
    await projects.saveBrief(project.id, '# Updated project brief\n');
    await projects.syncAllProjectBriefs();
    assert.equal(fs.readFileSync(path.join(wt.path, 'AGENTS.override.md'), 'utf8'), userOverride, 'saving and startup preserve overrides');
    assert.equal(fs.readFileSync(path.join(wt.path, 'AGENTS.md'), 'utf8'), '# Repo rules\nBe tidy.\n');
    assert.ok(!fs.existsSync(path.join(wt2.path, 'AGENTS.override.md')));
    assert.equal(fs.readFileSync(path.join(repo, '.git', 'info', 'exclude'), 'utf8'), excludeBefore);
    assert.equal(gitIn(wt.path, 'status', '--porcelain'), '', 'the worktree remains clean');
    assert.equal(gitIn(repo, 'status', '--porcelain'), '', 'the source checkout remains clean');

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
    fs.writeFileSync(path.join(wt2.path, 'AGENTS.override.md'), userOverride);
    const kept = await projects.detachFolder(project.id, wt2.path, {});
    assert.equal(kept.worktreeRemoved, false);
    assert.ok(fs.existsSync(wt2.path), 'kept on disk');
    assert.equal(fs.readFileSync(path.join(wt2.path, 'AGENTS.override.md'), 'utf8'), userOverride, 'detaching preserves user files');
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
      assert.ok(saved.content.startsWith('<!-- switchboard:managed -->'), 'managed block leads');
      assert.ok(saved.content.includes('# Brief\n\nShip the thing.\n'), 'user text kept, newline added');
      assert.ok(saved.content.includes(`- ${path.resolve(repo)}`), 'folder block put back');
      assert.equal(fs.readFileSync(path.join(project.root, 'CLAUDE.md'), 'utf8'), saved.content);
      assert.equal(fs.readFileSync(path.join(project.root, 'AGENTS.md'), 'utf8'), saved.content);
      assert.equal((saved.content.match(/<!-- switchboard:managed -->/g) || []).length, 1);
    } finally { rm(repo); }
  } finally { t.cleanup(); }
});

test('addProjectFiles copies dropped files into added-files and preserves duplicate names', async () => {
  const t = setup();
  const sources = tmpDir('switchboard-added-files-');
  try {
    const { project } = await projects.createProject({ name: 'Context' });
    const firstSource = path.join(sources, 'brief.txt');
    const secondDir = path.join(sources, 'other');
    fs.mkdirSync(secondDir);
    const secondSource = path.join(secondDir, 'brief.txt');
    fs.writeFileSync(firstSource, 'first');
    fs.writeFileSync(secondSource, 'second');

    assert.deepEqual(project.addedFiles, []);
    assert.equal(projects.listAddedFiles('missing').error, 'Project not found');
    assert.equal((await projects.addProjectFiles(project.id, [])).error, 'No files were dropped');

    const added = await projects.addProjectFiles(project.id, [firstSource, firstSource, secondSource, sources, path.join(sources, 'missing.txt'), 'relative.txt']);
    assert.equal(added.ok, true);
    assert.deepEqual(added.added, ['brief.txt', 'brief (2).txt']);
    assert.equal(added.errors.length, 3, 'a directory, missing source and relative path are reported');
    assert.equal(fs.readFileSync(path.join(project.root, 'added-files', 'brief.txt'), 'utf8'), 'first');
    assert.equal(fs.readFileSync(path.join(project.root, 'added-files', 'brief (2).txt'), 'utf8'), 'second');
    assert.deepEqual(added.files.map(file => [file.name, file.type]), [
      ['brief (2).txt', 'file'],
      ['brief.txt', 'file'],
    ]);

    const treeProject = projects.buildProjectTree(false).projects[0];
    assert.equal(treeProject.addedFilesPath, path.join(project.root, 'added-files'));
    assert.deepEqual(treeProject.addedFiles.map(file => file.name), ['brief (2).txt', 'brief.txt']);
  } finally {
    rm(sources);
    t.cleanup();
  }
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
    assert.ok(brief.startsWith('<!-- switchboard:managed -->'), 'the managed block leads');
    assert.ok(brief.includes('\n# Onboarding flow\n'), 'title from the project name');
    assert.ok(brief.includes('## How this project works'), 'template text kept');
    assert.ok(brief.includes(`Project folder: ${project.root}`), 'root token filled in');
    assert.ok(!brief.includes('{{'), 'no tokens left');
    assert.ok(brief.includes('## Working rules'), 'rules still appended');
    assert.ok(brief.includes('## Attached folders'), 'folder list still there');
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

test('recursive env discovery and copying preserve paths and skip hidden directories, dependencies and symlinks', () => {
  const t = setup();
  const source = tmpDir('switchboard-env-src-');
  const target = tmpDir('switchboard-env-dst-');
  const outside = tmpDir('switchboard-env-outside-');
  const nested = path.join('apps', 'web', '.env');
  const sample = path.join('apps', 'web', '.env.example');
  try {
    for (const name of [nested, sample, 'node_modules/pkg/.env', 'apps/web/node_modules/pkg/.env', '.git/.env', '.claude/worktrees/feature/backend/.env', 'apps/web/.hidden/.env', 'vendor/pkg/.env', '.venv/.env', 'venv/.env']) {
      fs.mkdirSync(path.dirname(path.join(source, name)), { recursive: true });
      fs.writeFileSync(path.join(source, name), 'A=1\n');
    }
    fs.writeFileSync(path.join(outside, '.env'), 'KEEP=me\n');
    fs.symlinkSync(outside, path.join(source, 'linked'), 'dir');
    fs.symlinkSync(path.join(outside, '.env'), path.join(source, '.env.link'));
    assert.deepEqual(projects.listEnvFiles(source), [nested, sample]);
    assert.deepEqual(projects.defaultEnvSelection(source), [nested]);
    const hiddenEnv = path.join('.claude', 'worktrees', 'feature', 'backend', '.env');
    assert.deepEqual(projects.copyEnvFiles(source, target, [hiddenEnv]), { copied: [], skipped: [hiddenEnv] });
    assert.equal(fs.existsSync(path.join(target, '.claude')), false);
    assert.deepEqual(projects.copyEnvFiles(source, target, [nested]), { copied: [nested], skipped: [] });
    assert.equal(fs.readFileSync(path.join(target, nested), 'utf8'), 'A=1\n');
    assert.equal(fs.existsSync(path.join(target, sample)), false);
    assert.deepEqual(projects.copyEnvFiles(source, target, [nested]), { copied: [], skipped: [nested] });

    fs.rmSync(path.join(target, 'apps'), { recursive: true });
    fs.symlinkSync(outside, path.join(target, 'apps'), 'dir');
    assert.deepEqual(projects.copyEnvFiles(source, target, [nested]), { copied: [], skipped: [nested] });
    assert.equal(fs.existsSync(path.join(outside, 'web')), false);
    assert.equal(fs.readFileSync(path.join(outside, '.env'), 'utf8'), 'KEEP=me\n');
  } finally { rm(source); rm(target); rm(outside); t.cleanup(); }
});

test('a new worktree gets the .env files the caller picked', { skip: !haveGit && 'git not installed' }, async () => {
  const t = setup();
  const repo = makeRepo('switchboard-repo-env-');
  try {
    fs.writeFileSync(path.join(repo, '.env'), 'TOKEN=abc\n');
    fs.writeFileSync(path.join(repo, '.env.local'), 'PORT=3000\n');
    fs.writeFileSync(path.join(repo, '.env.example'), 'TOKEN=\n');
    const nestedEnv = path.join('apps', 'web', '.env');
    fs.mkdirSync(path.dirname(path.join(repo, nestedEnv)), { recursive: true });
    fs.writeFileSync(path.join(repo, nestedEnv), 'NESTED=1\n');

    const created = await projects.createProject({
      name: 'Env Feature',
      folders: [{ path: repo, mode: 'worktree', copyEnv: ['.env', '.env.local', nestedEnv] }],
    });
    assert.equal(created.ok, true);
    assert.deepEqual(created.errors, []);
    const wt = created.project.folders[0];
    assert.equal(fs.readFileSync(path.join(wt.path, '.env'), 'utf8'), 'TOKEN=abc\n');
    assert.equal(fs.readFileSync(path.join(wt.path, '.env.local'), 'utf8'), 'PORT=3000\n');
    assert.equal(fs.readFileSync(path.join(wt.path, nestedEnv), 'utf8'), 'NESTED=1\n');
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

// --- Scheduled tasks ---

test('createSchedule: a project schedule lives under its track, a folder schedule under its cwd', async () => {
  const t = setup();
  try {
    const { project } = await projects.createProject({ name: 'Sched' });
    const { track } = projects.createTrack(project.id, { name: 'Digest' });
    const a = projects.createSchedule({ name: 'Morning', prompt: 'do it', projectId: project.id, trackId: track.id, every: 'day', atHour: 9, atMinute: 0 });
    assert.equal(a.error, undefined);
    assert.equal(a.schedule.trackId, track.id);
    assert.equal(a.schedule.cwd, null, 'project schedules store no cwd');
    assert.equal(a.schedule.enabled, true);
    const b = projects.createSchedule({ name: 'Folder', prompt: 'do it', cwd: t.root, every: '15m' });
    assert.equal(b.error, undefined);
    assert.equal(b.schedule.projectId, null);
    assert.equal(b.schedule.cwd, t.root);
    // Only the project's own schedules ride on its node.
    const node = projects.buildProjectTree(false).projects.find(p => p.id === project.id);
    assert.deepEqual(node.schedules.map(s => s.name), ['Morning']);
    assert.equal(projects.listSchedules().length, 2);
  } finally { t.cleanup(); }
});

test('createSchedule rejects what it cannot run', async () => {
  const t = setup();
  try {
    const { project } = await projects.createProject({ name: 'Sched' });
    assert.match(projects.createSchedule({ prompt: 'x', projectId: project.id, every: 'day' }).error, /name/i);
    assert.match(projects.createSchedule({ name: 'x', projectId: project.id, every: 'day' }).error, /prompt/i);
    assert.match(projects.createSchedule({ name: 'x', prompt: 'x', projectId: project.id, every: 'fortnight' }).error, /when/i);
    assert.match(projects.createSchedule({ name: 'x', prompt: 'x', projectId: project.id, every: 'day', atHour: 25 }).error, /atHour/);
    assert.match(projects.createSchedule({ name: 'x', prompt: 'x', projectId: project.id, trackId: 'nope', every: 'day' }).error, /Track/);
    assert.match(projects.createSchedule({ name: 'x', prompt: 'x', projectId: 'nope', every: 'day' }).error, /Project/);
    assert.match(projects.createSchedule({ name: 'x', prompt: 'x', every: 'day' }).error, /folder/i);
    assert.match(projects.createSchedule({ name: 'x', prompt: 'x', cwd: '/definitely/not/here', every: 'day' }).error, /Not a directory/);
  } finally { t.cleanup(); }
});

test('updateSchedule: timing fields are replaced as a set, a folder schedule has no track, cron is one-way', async () => {
  const t = setup();
  try {
    const { project } = await projects.createProject({ name: 'Sched' });
    const { schedule } = projects.createSchedule({ name: 'Weekly', prompt: 'x', projectId: project.id, every: 'week', atHour: 10, atMinute: 30, weekday: 5 });
    const moved = projects.updateSchedule(schedule.id, { every: '15m' });
    assert.equal(moved.schedule.every, '15m');
    assert.equal(moved.schedule.atHour, null, 'old timing does not linger');
    assert.equal(moved.schedule.weekday, null);
    const folder = projects.createSchedule({ name: 'F', prompt: 'x', cwd: t.root, every: 'hour' });
    assert.match(projects.updateSchedule(folder.schedule.id, { trackId: 'any' }).error, /folder schedule/);
    // An imported cron keeps its string until a preset replaces it.
    t.db.rows.schedules.push({ id: 'legacy', name: 'L', projectId: null, trackId: null, cwd: t.root, prompt: 'x', every: 'cron', cron: '*/5 * * * *', enabled: 1, catchUp: 0, created: '2026-09-01T00:00:00.000Z' });
    assert.equal(projects.updateSchedule('legacy', { name: 'Legacy' }).schedule.cron, '*/5 * * * *');
    const replaced = projects.updateSchedule('legacy', { every: 'hour', atMinute: 5 });
    assert.equal(replaced.schedule.cron, null);
    assert.equal(replaced.schedule.every, 'hour');
    assert.equal(projects.updateSchedule('missing', { name: 'x' }).error, 'Schedule not found');
    const before = t.notifications();
    projects.updateSchedule(schedule.id, {});
    assert.equal(t.notifications(), before, 'an empty patch is a no-op');
  } finally { t.cleanup(); }
});

test('dueSchedules: fires at the minute, skips off, done project, done track, and a run still going', async () => {
  const t = setup();
  try {
    const { project } = await projects.createProject({ name: 'Sched' });
    const { track } = projects.createTrack(project.id, { name: 'T' });
    const mk = (name, extra) => projects.createSchedule({ name, prompt: 'x', projectId: project.id, every: 'day', atHour: 9, atMinute: 0, ...extra }).schedule;
    const general = mk('general');
    const inTrack = mk('in track', { trackId: track.id });
    const off = mk('off', { enabled: false });
    const nine = new Date(2026, 8, 9, 9, 0, 0);
    const names = (ids) => ids.map(id => t.db.getSchedule(id).name).sort();
    assert.deepEqual(names(projects.dueSchedules(nine)), ['general', 'in track']);
    assert.deepEqual(projects.dueSchedules(new Date(2026, 8, 9, 9, 1, 0)), [], 'not at 9:01');
    assert.equal(projects.schedulePausedReason(t.db.getSchedule(off.id)), 'off');
    projects.updateTrack(track.id, { status: 'done' });
    assert.deepEqual(names(projects.dueSchedules(nine)), ['general'], 'a done track pauses its schedule');
    assert.equal(projects.schedulePausedReason(t.db.getSchedule(inTrack.id)), 'track done');
    projects.updateTrack(track.id, { status: 'active' });
    projects.updateProject(project.id, { status: 'done' });
    assert.deepEqual(projects.dueSchedules(nine), [], 'a done project pauses all of them');
    projects.updateProject(project.id, { status: 'active' });
    // Reopening resumed them with nothing stored.
    assert.deepEqual(names(projects.dueSchedules(nine)), ['general', 'in track']);
    projects.recordScheduleRun(general.id, 'sess-1');
    assert.deepEqual(names(projects.dueSchedules(nine, (id) => id === 'sess-1')), ['in track'], 'still working: skipped');
    assert.deepEqual(names(projects.dueSchedules(nine, () => false)), ['general', 'in track'], 'finished: fires again');
    assert.deepEqual(t.db.rows.meta.get('sess-1').scheduleId, general.id, 'the session remembers its schedule');
  } finally { t.cleanup(); }
});

test('resolveScheduleLaunch runs where the track starts, and a folder schedule in its folder', async () => {
  const t = setup();
  try {
    const sub = path.join(t.root, 'sub');
    fs.mkdirSync(sub);
    const { project } = await projects.createProject({ name: 'Sched' });
    const { track } = projects.createTrack(project.id, { name: 'T', cwd: path.join(project.root), cli: 'codex' });
    const s = projects.createSchedule({ name: 'x', prompt: 'go', projectId: project.id, trackId: track.id, every: 'hour' }).schedule;
    const launch = projects.resolveScheduleLaunch(s.id);
    assert.equal(launch.target.projectPath, project.root);
    assert.equal(launch.target.projectId, project.id);
    assert.equal(launch.target.trackId, track.id);
    assert.equal(launch.runtime, 'codex', 'the track CLI unless the schedule names one');
    const own = projects.createSchedule({ name: 'y', prompt: 'go', projectId: project.id, trackId: track.id, every: 'hour', cli: 'claude' }).schedule;
    assert.equal(projects.resolveScheduleLaunch(own.id).runtime, 'claude');
    const f = projects.createSchedule({ name: 'f', prompt: 'go', cwd: sub, every: 'hour' }).schedule;
    const fl = projects.resolveScheduleLaunch(f.id);
    assert.equal(fl.target.projectPath, sub);
    assert.equal(fl.target.projectId, null);
    assert.equal(projects.resolveScheduleLaunch('missing').error, 'Schedule not found');
  } finally { t.cleanup(); }
});

test('schedule configuration stays per CLI while inherited project folders and track CLIs move', async () => {
  const t = setup();
  try {
    const { project } = await projects.createProject({ name: 'Configured schedules' });
    const sub = path.join(project.root, 'working');
    fs.mkdirSync(sub);
    const { track } = projects.createTrack(project.id, { name: 'Run', cli: 'claude' });
    const sessionConfig = { claude: { permissionMode: null, chrome: false }, codex: { codexModel: 'saved-model' } };
    const { schedule } = projects.createSchedule({ name: 'Configured', prompt: 'Do it', every: 'hour', projectId: project.id, trackId: track.id, sessionConfig });
    assert.deepEqual(schedule.sessionConfig, sessionConfig);
    let launch = projects.resolveScheduleLaunch(schedule.id);
    assert.equal(launch.target.projectPath, project.root);
    assert.equal(launch.runtime, 'claude');
    projects.updateProject(project.id, { defaultCwd: sub });
    launch = projects.resolveScheduleLaunch(schedule.id);
    assert.equal(launch.target.projectPath, sub, 'track without a cwd follows the project default');
    projects.updateTrack(track.id, { cwd: project.root, cli: 'codex' });
    launch = projects.resolveScheduleLaunch(schedule.id);
    assert.equal(launch.target.projectPath, project.root);
    assert.equal(launch.runtime, 'codex');
    assert.deepEqual(launch.schedule.sessionConfig, sessionConfig, 'a CLI change preserves both sets of custom settings');
    const preview = projects.resolveScheduleContext({ projectId: project.id, trackId: track.id });
    assert.deepEqual(preview.target, launch.target);
    assert.equal(preview.runtime, launch.runtime);
    const updated = projects.updateSchedule(schedule.id, { sessionConfig: { codex: sessionConfig.codex } });
    assert.deepEqual(updated.schedule.sessionConfig, { codex: sessionConfig.codex }, 'resetting Claude keeps Codex choices');
    assert.match(projects.updateSchedule(schedule.id, { sessionConfig: { codex: { permissionMode: 'plan' } } }).error, /Unsupported codex setting/);
    assert.match(projects.updateSchedule(schedule.id, { sessionConfig: { claude: { chrome: 'false' } } }).error, /on or off/);
    assert.match(projects.updateSchedule(schedule.id, { sessionConfig: { claude: { runtime: 'codex' } } }).error, /Unsupported/);
    assert.deepEqual(projects.updateSchedule(schedule.id, { name: 'Renamed' }).schedule.sessionConfig, { codex: sessionConfig.codex });
  } finally { t.cleanup(); }
});

test('deleting a track moves its schedules to General; deleting the project removes them', async () => {
  const t = setup();
  try {
    const { project } = await projects.createProject({ name: 'Sched' });
    const { track } = projects.createTrack(project.id, { name: 'T' });
    const s = projects.createSchedule({ name: 'x', prompt: 'go', projectId: project.id, trackId: track.id, every: 'hour' }).schedule;
    projects.deleteTrack(track.id);
    assert.equal(t.db.getSchedule(s.id).trackId, null);
    assert.equal(projects.deleteSchedule('missing').error, 'Schedule not found');
    assert.equal(projects.deleteSchedule(s.id).ok, true);
    assert.equal(t.db.getSchedule(s.id), null);
  } finally { t.cleanup(); }
});

test('importLegacySchedules: one folder schedule per file, pointing at the file, once', async () => {
  const t = setup();
  try {
    const scanned = [
      { filePath: path.join(t.root, '.claude/commands/schedule-hn.md'), projectPath: t.root, name: 'HN', cron: '*/5 * * * *', enabled: false },
      { filePath: path.join(t.root, '.claude/commands/schedule-hourly.md'), projectPath: t.root, name: 'Hourly', cron: '0 * * * *', enabled: true },
      { filePath: '/gone/.claude/commands/schedule-x.md', projectPath: '/gone', name: 'Gone', cron: '0 * * * *', enabled: true },
    ];
    assert.equal(projects.importLegacySchedules(scanned), 2, 'a folder that no longer exists is skipped');
    const rows = projects.listSchedules();
    const hn = rows.find(r => r.name === 'HN');
    assert.equal(hn.every, 'cron');
    assert.equal(hn.cron, '*/5 * * * *', 'no preset fits: the cron is kept');
    assert.equal(hn.enabled, false, 'a disabled file imports as off');
    assert.equal(hn.projectId, null);
    assert.equal(hn.cwd, t.root);
    assert.equal(hn.sourceFile, scanned[0].filePath);
    assert.match(hn.prompt, /Read that file/);
    assert.ok(hn.prompt.includes(scanned[0].filePath));
    const hourly = rows.find(r => r.name === 'Hourly');
    assert.equal(hourly.every, 'hour', 'a cron a preset fits becomes that preset');
    assert.equal(hourly.atMinute, 0);
    assert.equal(hourly.cron, null);
    assert.equal(projects.importLegacySchedules(scanned), 0, 'never twice');
    assert.equal(projects.listSchedules().length, 2);
    assert.equal(projects.deleteSchedule(hn.id).ok, true);
    assert.equal(projects.importLegacySchedules(scanned), 0, 'deleted schedules do not return');
    assert.equal(projects.listSchedules().length, 1);
  } finally { t.cleanup(); }
});

test('legacy schedules retry after empty and partial scans without repeating successful imports', () => {
  const t = setup();
  try {
    // A build that used the global flag may have recorded an incomplete scan.
    t.db.setSetting('schedules_imported_from_files', { at: '2026-09-01T00:00:00Z', count: 0 });
    assert.equal(projects.importLegacySchedules([]), 0);
    const offline = path.join(t.root, 'offline');
    const scanned = [
      { filePath: path.join(t.root, 'schedule-ready.md'), projectPath: t.root, cron: '0 * * * *' },
      { filePath: path.join(offline, 'schedule-later.md'), projectPath: offline, cron: '0 9 * * *' },
    ];
    assert.equal(projects.importLegacySchedules([...scanned, scanned[0]]), 1, 'duplicates in one scan import once');
    const ready = projects.listSchedules()[0];
    projects.updateSchedule(ready.id, { name: 'Edited task', enabled: false });
    fs.mkdirSync(offline);
    // The next launch discovers the previously unavailable folder.
    projects.init({ db: t.db, log: { info() {}, error() {} } });
    assert.equal(projects.importLegacySchedules(scanned), 1);
    assert.equal(projects.listSchedules().length, 2);
    assert.equal(t.db.getSchedule(ready.id).name, 'Edited task');
    assert.equal(t.db.getSchedule(ready.id).enabled, 0);
    assert.equal(projects.importLegacySchedules(scanned), 0);
  } finally { t.cleanup(); }
});


test('legacy CLI settings survive import, editing and launch without inheriting folder overrides', () => {
  const t = setup();
  try {
    const config = require('../public/session-config');
    const claude = require('../harnesses/claude');
    const { parseFrontmatter } = require('../schedule-runner');
    const { meta } = parseFrontmatter(`---
cron: 0 * * * *
cli:
  permission-mode: dontAsk
  allowed-tools: Read,Bash(git status:*)
  append-system-prompt: Follow the task instructions exactly.
  add-dirs: /one, /two
  model: old-model
  max-budget-usd: 2.50
---
Do the task.`);
    const source = { filePath: path.join(t.root, 'schedule-custom.md'), projectPath: t.root, ...meta };
    assert.equal(projects.importLegacySchedules([source]), 1);
    const row = projects.listSchedules()[0];
    assert.equal(row.cli, 'claude');
    const saved = row.sessionConfig.claude;
    assert.equal(saved.permissionMode, 'dontAsk');
    assert.equal(saved.allowedTools, 'Read,Bash(git status:*)');
    assert.equal(saved.appendSystemPrompt, meta.cli['append-system-prompt']);
    assert.equal(saved.addDirs, '/one, /two');
    assert.equal(saved.model, undefined, 'model is deliberately omitted');
    assert.equal(saved.maxBudgetUsd, undefined, 'budget is deliberately omitted');
    const options = config.resolveOptions('claude', {
      permissionMode: 'bypassPermissions', dangerouslySkipPermissions: true,
      worktree: true, worktreeName: 'new-default', chrome: true, mcpEmulation: true,
      preLaunchCmd: 'other-prefix', addDirs: '/other',
      allowedTools: 'Bash', appendSystemPrompt: 'other instructions',
    }, saved);
    assert.deepEqual(options, saved, 'all previous launch defaults are explicitly pinned');
    const args = claude.buildLaunchArgs({ sessionId: 'imported', isNew: true, options: { ...options, initialPrompt: row.prompt, scheduleId: row.id } });
    assert.ok(!args.includes('--model'));
    assert.ok(!args.includes('--print'));
    assert.ok(!args.includes('--max-budget-usd'));
    assert.ok(!args.includes('--worktree'));
    assert.ok(!args.includes('--chrome'));
    assert.ok(!args.includes('--dangerously-skip-permissions'));
    assert.equal(args[args.indexOf('--permission-mode') + 1], 'dontAsk');
    assert.equal(args[args.indexOf('--allowedTools') + 1], saved.allowedTools);
    assert.equal(args[args.indexOf('--append-system-prompt') + 1], saved.appendSystemPrompt);
    assert.deepEqual(args.slice(args.indexOf('--add-dir'), args.indexOf('--add-dir') + 4), ['--add-dir', '/one', '--add-dir', '/two']);
    assert.equal(args.at(-1), row.prompt);
    assert.deepEqual(projects.updateSchedule(row.id, { sessionConfig: row.sessionConfig }).schedule.sessionConfig, row.sessionConfig);
    projects.updateSchedule(row.id, { sessionConfig: { claude: { permissionMode: 'plan' } } });
    assert.equal(projects.importLegacySchedules([source]), 0);
    assert.deepEqual(projects.listSchedules()[0].sessionConfig, { claude: { permissionMode: 'plan' } });
  } finally { t.cleanup(); }
});

test('legacy omitted options preserve old defaults and invalid settings retry independently', () => {
  const t = setup();
  try {
    const defaults = { filePath: path.join(t.root, 'schedule-defaults.md'), projectPath: t.root, cron: '0 * * * *' };
    const bad = { ...defaults, filePath: path.join(t.root, 'schedule-bad.md'), cli: { 'permission-mode': 'invalid' } };
    const explicitDefault = { ...defaults, filePath: path.join(t.root, 'schedule-explicit.md'), cli: { 'permission-mode': 'default' } };
    assert.equal(projects.importLegacySchedules([bad, defaults, explicitDefault]), 2);
    const row = projects.listSchedules().find(s => s.sourceFile === defaults.filePath);
    assert.equal(row.sessionConfig.claude.permissionMode, 'acceptEdits');
    assert.equal(row.sessionConfig.claude.allowedTools, 'Bash,Read,Write,Edit,Glob,Grep,WebFetch,WebSearch');
    assert.equal(projects.listSchedules().find(s => s.sourceFile === explicitDefault.filePath).sessionConfig.claude.permissionMode, null);
    assert.ok(!t.db.getImportedScheduleFiles().includes(bad.filePath));
    bad.cli['permission-mode'] = 'plan';
    assert.equal(projects.importLegacySchedules([bad, defaults]), 1, 'fixed files can be retried');
  } finally { t.cleanup(); }
});
