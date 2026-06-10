const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const proto = require('../orch-protocol');
const { OrchWatcher } = require('../orch-watcher');
const { OrchSpawner } = require('../orch-spawner');

const ROLES = {
  master: { profileId: 'anthropic' },
  worker: { profileId: 'deepseek', maxConcurrent: 2 },
  reviewer: { profileId: 'anthropic', maxConcurrent: 1 },
};

function tmpProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sb-spawn-'));
}

// A run that is active with isolation disabled (no git needed in unit tests).
function makeActiveRun(project, policy = {}) {
  const { run } = proto.createRun(project, {
    title: 'demo', roles: ROLES,
    policy: { isolation: 'none', ...policy },
  });
  const active = { ...run, status: 'active', masterSessionId: 'master-1111-2222-3333-444444444444' };
  proto.writeRun(project, active);
  return active;
}

function makeHarness({ failSpawns = 0, busyMaster = false } = {}) {
  const calls = { openTerminal: [], sendInput: [], seeds: [] };
  let failures = failSpawns;
  let counter = 0;
  const activeSessions = new Set(['master-1111-2222-3333-444444444444']);
  const deps = {
    openTerminal: async (sessionId, cwd, isNew, opts) => {
      calls.openTerminal.push({ sessionId, cwd, isNew, opts });
      if (failures > 0) { failures--; return { ok: false, error: 'boom' }; }
      activeSessions.add(sessionId);
      return { ok: true };
    },
    sendInput: (sessionId, text) => { calls.sendInput.push({ sessionId, text }); return true; },
    isSessionActive: (id) => activeSessions.has(id),
    isSessionBusy: () => busyMaster,
    seedSessionJsonl: (args) => { calls.seeds.push(args); return true; },
    ensureTaskWorktree: async () => { throw new Error('not used with isolation none'); },
    rolePrompt: (role) => `system prompt for ${role}`,
    newSessionId: () => `sess-${String(++counter).padStart(4, '0')}-aaaa-bbbb-cccc`,
  };
  return { calls, deps, activeSessions };
}

async function settle(ms = 50) { return new Promise(r => setTimeout(r, ms)); }

test('ready leaf task gets a worker session and moves to in_progress', async () => {
  const project = tmpProject();
  const run = makeActiveRun(project);
  proto.writeTask(project, run.id, { id: 'T-1', title: 'do it', status: 'ready', kind: 'leaf' });

  const watcher = new OrchWatcher();
  const { calls, deps } = makeHarness();
  const spawner = new OrchSpawner({ watcher, deps });
  try {
    watcher.watchProject(project);
    await spawner.reconcile(project);

    assert.equal(calls.openTerminal.length, 1);
    const call = calls.openTerminal[0];
    assert.equal(call.cwd, project); // isolation none
    assert.equal(call.isNew, false); // seeded jsonl → resume
    assert.equal(call.opts.profileId, 'deepseek');
    assert.equal(call.opts.permissionMode, 'acceptEdits');
    assert.equal(call.opts.initialPrompt, `/sb-work ${run.id} T-1`);
    assert.match(call.opts.appendSystemPrompt, /worker/);
    assert.equal(calls.seeds[0].slug, run.id);

    const task = proto.readTask(project, run.id, 'T-1');
    assert.equal(task.status, 'in_progress');
    assert.deepEqual(task.sessionIds, [call.sessionId]);
    assert.equal(task.attempts, 1);
  } finally {
    spawner.stop();
    watcher.dispose();
  }
});

test('concurrency cap and dependency gating are respected', async () => {
  const project = tmpProject();
  const run = makeActiveRun(project);
  proto.writeTask(project, run.id, { id: 'T-1', title: 'a', status: 'ready', kind: 'leaf' });
  proto.writeTask(project, run.id, { id: 'T-2', title: 'b', status: 'ready', kind: 'leaf' });
  proto.writeTask(project, run.id, { id: 'T-3', title: 'c', status: 'ready', kind: 'leaf' });
  proto.writeTask(project, run.id, { id: 'T-4', title: 'd', status: 'ready', kind: 'leaf', dependsOn: ['T-9'] });
  proto.writeTask(project, run.id, { id: 'T-9', title: 'dep', status: 'draft', kind: 'leaf' });

  const watcher = new OrchWatcher();
  const { calls, deps } = makeHarness();
  const spawner = new OrchSpawner({ watcher, deps });
  try {
    watcher.watchProject(project);
    await spawner.reconcile(project);

    // worker cap is 2: T-1 and T-2 spawn, T-3 waits, T-4 dep-gated
    assert.equal(calls.openTerminal.length, 2);
    assert.equal(proto.readTask(project, run.id, 'T-1').status, 'in_progress');
    assert.equal(proto.readTask(project, run.id, 'T-2').status, 'in_progress');
    assert.equal(proto.readTask(project, run.id, 'T-3').status, 'ready');
    assert.equal(proto.readTask(project, run.id, 'T-4').status, 'ready');

    // one worker finishes → next reconcile dispatches T-3 only
    proto.transitionTask(project, run.id, 'T-1', 'in_progress', 'needs_review');
    watcher.refresh(project);
    await spawner.reconcile(project);
    assert.equal(proto.readTask(project, run.id, 'T-3').status, 'in_progress');
    assert.equal(proto.readTask(project, run.id, 'T-4').status, 'ready');
  } finally {
    spawner.stop();
    watcher.dispose();
  }
});

test('needs_review spawns a reviewer with the reviewer profile', async () => {
  const project = tmpProject();
  const run = makeActiveRun(project);
  proto.writeTask(project, run.id, {
    id: 'T-1', title: 'a', status: 'needs_review', kind: 'leaf',
    sessionIds: ['w-1'], attempts: 1,
  });

  const watcher = new OrchWatcher();
  const { calls, deps } = makeHarness();
  const spawner = new OrchSpawner({ watcher, deps });
  try {
    watcher.watchProject(project);
    await spawner.reconcile(project);
    assert.equal(calls.openTerminal.length, 1);
    assert.equal(calls.openTerminal[0].opts.profileId, 'anthropic');
    assert.equal(calls.openTerminal[0].opts.initialPrompt, `/sb-review ${run.id} T-1`);
    const task = proto.readTask(project, run.id, 'T-1');
    assert.equal(task.status, 'reviewing');
    assert.equal(task.reviewSessionIds.length, 1);
  } finally {
    spawner.stop();
    watcher.dispose();
  }
});

test('spawn failure rolls back to ready; attempts exhaust into blocked', async () => {
  const project = tmpProject();
  const run = makeActiveRun(project, { maxAttempts: 2 });
  proto.writeTask(project, run.id, { id: 'T-1', title: 'a', status: 'ready', kind: 'leaf' });

  const watcher = new OrchWatcher();
  const { deps } = makeHarness({ failSpawns: 99 });
  const spawner = new OrchSpawner({ watcher, deps });
  try {
    watcher.watchProject(project);
    await spawner.reconcile(project);
    let task = proto.readTask(project, run.id, 'T-1');
    assert.equal(task.status, 'ready');
    assert.equal(task.attempts, 1);

    watcher.refresh(project);
    await spawner.reconcile(project);
    task = proto.readTask(project, run.id, 'T-1');
    assert.equal(task.attempts, 2);

    watcher.refresh(project);
    await spawner.reconcile(project);
    task = proto.readTask(project, run.id, 'T-1');
    assert.equal(task.status, 'blocked');

    const events = proto.readEvents(project, run.id);
    assert.ok(events.some(e => e.type === 'spawn-failed'));
  } finally {
    spawner.stop();
    watcher.dispose();
  }
});

test('changes_requested feeds rework into the still-active worker session', async () => {
  const project = tmpProject();
  const run = makeActiveRun(project);

  const watcher = new OrchWatcher();
  const { calls, deps, activeSessions } = makeHarness();
  activeSessions.add('w-original');
  proto.writeTask(project, run.id, {
    id: 'T-1', title: 'a', status: 'changes_requested', kind: 'leaf',
    sessionIds: ['w-original'], attempts: 1,
    reviews: [{ file: 'reviews/T-1-1.md', verdict: 'changes_requested' }],
  });

  const spawner = new OrchSpawner({ watcher, deps });
  try {
    watcher.watchProject(project);
    await spawner.reconcile(project);
    assert.equal(calls.openTerminal.length, 0); // no new terminal
    assert.equal(calls.sendInput.length, 1);
    assert.equal(calls.sendInput[0].sessionId, 'w-original');
    assert.match(calls.sendInput[0].text, new RegExp(`/sb-work ${run.id} T-1`));
    assert.match(calls.sendInput[0].text, /reviews\/T-1-1\.md/);
    assert.equal(proto.readTask(project, run.id, 'T-1').status, 'in_progress');
  } finally {
    spawner.stop();
    watcher.dispose();
  }
});

test('paused or planning runs spawn nothing', async () => {
  const project = tmpProject();
  const { run } = proto.createRun(project, {
    title: 'demo', roles: ROLES, policy: { isolation: 'none' },
  }); // status: planning
  proto.writeTask(project, run.id, { id: 'T-1', title: 'a', status: 'ready', kind: 'leaf' });

  const watcher = new OrchWatcher();
  const { calls, deps } = makeHarness();
  const spawner = new OrchSpawner({ watcher, deps });
  try {
    watcher.watchProject(project);
    await spawner.reconcile(project);
    assert.equal(calls.openTerminal.length, 0);

    proto.writeRun(project, { ...run, status: 'paused' });
    watcher.refresh(project);
    await spawner.reconcile(project);
    assert.equal(calls.openTerminal.length, 0);
    assert.equal(proto.readTask(project, run.id, 'T-1').status, 'ready');
  } finally {
    spawner.stop();
    watcher.dispose();
  }
});

test('approved task nudges the idle master once, batched', async () => {
  const project = tmpProject();
  const run = makeActiveRun(project);
  proto.writeTask(project, run.id, { id: 'T-1', title: 'a', status: 'reviewing', kind: 'leaf' });
  proto.writeTask(project, run.id, { id: 'T-2', title: 'b', status: 'reviewing', kind: 'leaf' });

  const watcher = new OrchWatcher();
  const { calls, deps } = makeHarness();
  const spawner = new OrchSpawner({ watcher, deps });
  try {
    spawner.start();
    watcher.watchProject(project);
    await settle(50);
    proto.transitionTask(project, run.id, 'T-1', 'reviewing', 'approved', null, 'reviewer');
    proto.transitionTask(project, run.id, 'T-2', 'reviewing', 'approved', null, 'reviewer');
    watcher.refresh(project);
    await settle(2600); // debounce window + slack

    const nudges = calls.sendInput.filter(c => c.sessionId === 'master-1111-2222-3333-444444444444');
    assert.equal(nudges.length, 1);
    assert.match(nudges[0].text, /T-1 approved/);
    assert.match(nudges[0].text, /T-2 approved/);
    assert.match(nudges[0].text, /\/sb-orchestrate/);
    const events = proto.readEvents(project, run.id);
    assert.ok(events.some(e => e.type === 'master-nudged'));
  } finally {
    spawner.stop();
    watcher.dispose();
  }
});
