// Tests the Agent Teams IPC surface without Electron: a recorder stands in
// for ipcMain, so every handler runs exactly as it would in production.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const proto = require('../orch-protocol');
const orchIpc = require('../orch-ipc');
const { addAllowedRoot } = require('../path-guard');

const noopLog = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

function fakeIpcMain() {
  const handlers = new Map();
  return {
    handle: (channel, fn) => handlers.set(channel, fn),
    invoke: (channel, ...args) => handlers.get(channel)(null, ...args),
    handlers,
  };
}

function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-ipc-'));
  const run = (args) => execFileSync('git', args, { cwd: dir, windowsHide: true });
  run(['init', '-b', 'main']);
  run(['config', 'user.email', 't@t']);
  run(['config', 'user.name', 't']);
  fs.writeFileSync(path.join(dir, 'a.txt'), 'x\n');
  run(['add', '.']);
  run(['commit', '-m', 'init']);
  addAllowedRoot(dir);
  return dir;
}

function makeModule({ openTerminalResult = { ok: true } } = {}) {
  const ipc = fakeIpcMain();
  const calls = { openTerminal: [] };
  const mod = orchIpc.init(noopLog, {
    ipcMain: ipc,
    openTerminal: async (...args) => { calls.openTerminal.push(args); return openTerminalResult; },
    sendInput: () => true,
    isSessionActive: () => false,
    isSessionBusy: () => false,
    getMainWindow: () => null,
  });
  return { ipc, calls, mod };
}

const ROLES = {
  master: { profileId: 'anthropic' },
  worker: { profileId: 'deepseek', maxConcurrent: 2 },
  reviewer: { profileId: 'anthropic' },
};

test('orch:create-run scaffolds, installs the agent pack and spawns the master', async () => {
  const project = makeRepo();
  const projectsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-ipc-proj-'));
  orchIpc.setProjectsDirForTesting(projectsDir);
  const { ipc, calls, mod } = makeModule();
  try {
    const res = await ipc.invoke('orch:create-run', project, {
      title: 'IPC run', goal: 'test goal', roles: ROLES, policy: {},
    });
    assert.equal(res.ok, true, res.error);
    assert.ok(res.masterSessionId);
    assert.equal(res.run.status, 'planning');

    // agent pack + guidelines + gitignore installed
    assert.ok(fs.existsSync(path.join(project, '.claude', 'commands', 'sb-plan.md')));
    assert.ok(fs.existsSync(path.join(project, '.switchboard', 'guidelines.md')));
    assert.match(fs.readFileSync(path.join(project, '.switchboard', '.gitignore'), 'utf8'), /worktrees/);

    // integration worktree pre-created so master never touches the checkout
    assert.ok(fs.existsSync(path.join(proto.worktreesRoot(project), res.run.id + '--integration')));

    // master session spawned with the master profile and /sb-plan boot prompt
    assert.equal(calls.openTerminal.length, 1);
    const [sessionId, cwd, isNew, opts] = calls.openTerminal[0];
    assert.equal(sessionId, res.masterSessionId);
    assert.equal(cwd, project);
    assert.equal(isNew, false); // seeded JSONL → resume
    assert.equal(opts.profileId, 'anthropic');
    assert.match(opts.initialPrompt, new RegExp(`^/sb-plan ${res.run.id} test goal`));

    // seeded master transcript exists with slug = run id (sidebar grouping)
    const folder = fs.readdirSync(projectsDir)[0];
    const jsonl = fs.readFileSync(path.join(projectsDir, folder, res.masterSessionId + '.jsonl'), 'utf8');
    assert.match(jsonl, new RegExp(`"slug":"${res.run.id}"`));

    // run.json records masterSessionId
    assert.equal(proto.readRun(project, res.run.id).masterSessionId, res.masterSessionId);
  } finally {
    mod.dispose();
  }
});

test('orch:create-run requires a git repo for worktree isolation', async () => {
  const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-ipc-plain-'));
  addAllowedRoot(plain);
  const { ipc, mod } = makeModule();
  try {
    const res = await ipc.invoke('orch:create-run', plain, { title: 'x', goal: 'g', roles: ROLES });
    assert.equal(res.ok, false);
    assert.match(res.error, /not a git repository/);
    // …but isolation: none works on a plain dir
    const res2 = await ipc.invoke('orch:create-run', plain, {
      title: 'x', goal: 'g', roles: ROLES, policy: { isolation: 'none' },
    });
    assert.equal(res2.ok, true, res2.error);
  } finally {
    mod.dispose();
  }
});

test('orch:create-run rejects disallowed project paths', async () => {
  const { ipc, mod } = makeModule();
  try {
    const res = await ipc.invoke('orch:create-run', 'C:\\definitely\\not\\allowed', { title: 'x', goal: 'g', roles: ROLES });
    assert.equal(res.ok, false);
    assert.match(res.error, /not allowed/);
  } finally {
    mod.dispose();
  }
});

test('orch:run-action and orch:task-action round-trip through the protocol', async () => {
  const project = makeRepo();
  const { run } = proto.createRun(project, { title: 'actions', roles: ROLES, policy: { isolation: 'none' } });
  proto.writeRun(project, { ...run, status: 'active' });
  proto.writeTask(project, run.id, { id: 'T-1', title: 'a', status: 'draft', kind: 'leaf' });
  proto.writeTask(project, run.id, { id: 'T-2', title: 'b', status: 'needs_review', kind: 'leaf' });
  proto.writeTask(project, run.id, { id: 'T-3', title: 'c', status: 'failed', kind: 'leaf', attempts: 3 });

  const { ipc, mod } = makeModule();
  try {
    // pause / resume
    let res = await ipc.invoke('orch:run-action', project, run.id, 'pause');
    assert.equal(res.ok, true);
    assert.equal(proto.readRun(project, run.id).status, 'paused');
    res = await ipc.invoke('orch:run-action', project, run.id, 'resume');
    assert.equal(proto.readRun(project, run.id).status, 'active');
    res = await ipc.invoke('orch:run-action', project, run.id, 'self-destruct');
    assert.equal(res.ok, false);

    // human task overrides
    res = await ipc.invoke('orch:task-action', project, run.id, 'T-1', 'to-ready');
    assert.equal(res.ok, true);
    assert.equal(proto.readTask(project, run.id, 'T-1').status, 'ready');

    res = await ipc.invoke('orch:task-action', project, run.id, 'T-2', 'approve');
    assert.equal(proto.readTask(project, run.id, 'T-2').status, 'approved');

    res = await ipc.invoke('orch:task-action', project, run.id, 'T-3', 'retry');
    const t3 = proto.readTask(project, run.id, 'T-3');
    assert.equal(t3.status, 'ready');
    assert.equal(t3.attempts, 0, 'retry resets the attempt counter');

    // illegal transition is refused, file untouched
    res = await ipc.invoke('orch:task-action', project, run.id, 'T-2', 'retry');
    assert.equal(res.ok, false);
    assert.equal(proto.readTask(project, run.id, 'T-2').status, 'approved');

    // events carry actor: user
    const events = proto.readEvents(project, run.id);
    assert.ok(events.some(e => e.type === 'task-transition' && e.actor === 'user'));
    assert.ok(events.some(e => e.type === 'run-status' && e.actor === 'user'));
  } finally {
    mod.dispose();
  }
});

test('orch:get-run returns run, tasks, events, summary and plan', async () => {
  const project = makeRepo();
  const { run } = proto.createRun(project, { title: 'detail', roles: ROLES });
  proto.writeTask(project, run.id, { id: 'T-1', title: 'a', status: 'done', kind: 'leaf' });
  fs.writeFileSync(path.join(proto.runDir(project, run.id), 'plan.md'), '# The Plan\n');

  const { ipc, mod } = makeModule();
  try {
    const res = await ipc.invoke('orch:get-run', project, run.id);
    assert.equal(res.ok, true);
    assert.equal(res.run.title, 'detail');
    assert.equal(res.tasks.length, 1);
    assert.equal(res.summary.leavesDone, 1);
    assert.match(res.plan, /The Plan/);
    assert.ok(res.events.length >= 1);

    const missing = await ipc.invoke('orch:get-run', project, 'no-such-run');
    assert.equal(missing.ok, false);
  } finally {
    mod.dispose();
  }
});

test('orch:read-task-file serves specs and reviews, rejects traversal', async () => {
  const project = makeRepo();
  const { run } = proto.createRun(project, { title: 'files', roles: ROLES });
  proto.writeTask(project, run.id, { id: 'T-1', title: 'a', status: 'draft', kind: 'leaf' });
  fs.writeFileSync(path.join(proto.runDir(project, run.id), 'tasks', 'T-1.spec.md'), 'SPEC CONTENT');
  fs.mkdirSync(path.join(proto.runDir(project, run.id), 'reviews'), { recursive: true });
  fs.writeFileSync(path.join(proto.runDir(project, run.id), 'reviews', 'T-1-1.md'), 'REVIEW CONTENT');

  const { ipc, mod } = makeModule();
  try {
    let res = await ipc.invoke('orch:read-task-file', project, run.id, 'T-1', 'spec');
    assert.match(res.content, /SPEC CONTENT/);
    res = await ipc.invoke('orch:read-task-file', project, run.id, 'T-1', 'reviews/T-1-1.md');
    assert.match(res.content, /REVIEW CONTENT/);
    res = await ipc.invoke('orch:read-task-file', project, run.id, 'T-1', '../../../../etc/passwd');
    assert.equal(res.ok, false);
    res = await ipc.invoke('orch:read-task-file', project, run.id, 'T-1', 'reviews/..%2f..%2fsecrets.md');
    assert.equal(res.ok, false);
  } finally {
    mod.dispose();
  }
});

test('orch:watch-projects validates paths and returns state', async () => {
  const project = makeRepo();
  proto.createRun(project, { title: 'watched', roles: ROLES });
  const { ipc, mod } = makeModule();
  try {
    const res = await ipc.invoke('orch:watch-projects', [project, 'C:\\nope']);
    assert.equal(res.ok, true);
    const snap = res.state[path.resolve(project)];
    assert.ok(snap, 'allowed project must be watched');
    assert.equal(snap.runs.length, 1);
    assert.equal(Object.keys(res.state).some(k => k.toLowerCase().includes('nope')), false);

    const bad = await ipc.invoke('orch:watch-projects', 'not-an-array');
    assert.equal(bad.ok, false);
  } finally {
    mod.dispose();
  }
});

test('seedSessionJsonl writes a resumable transcript with slug', () => {
  const projectsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-seed-'));
  orchIpc.setProjectsDirForTesting(projectsDir);
  const ok = orchIpc.seedSessionJsonl({
    sessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    cwd: 'D:\\some\\project',
    slug: 'my-run-id',
    text: 'welcome **worker**',
  });
  assert.equal(ok, true);
  const folder = fs.readdirSync(projectsDir)[0];
  const file = path.join(projectsDir, folder, 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl');
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.equal(lines.length, 2);
  assert.equal(lines[0].type, 'file-history-snapshot');
  assert.equal(lines[1].slug, 'my-run-id');
  assert.equal(lines[1].message.role, 'assistant');
});
