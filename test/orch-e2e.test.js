// End-to-end orchestration lifecycle against real files, real git worktrees
// and real child processes — `claude` is played by test/fake-claude.js.
//
// Covers the full automated loop the user never has to touch:
//   ready → worker spawn (worktree) → implement+commit → needs_review
//   → reviewer spawn → verdict → approved | changes_requested → rework
//   → approved → master nudge → (master) merge into integration branch → done

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const proto = require('../orch-protocol');
const wt = require('../worktree-manager');
const { OrchWatcher } = require('../orch-watcher');
const { OrchSpawner } = require('../orch-spawner');

const FAKE_CLAUDE = path.join(__dirname, 'fake-claude.js');
const MASTER_ID = 'master-e2e-0000-0000-000000000000';

function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-e2e-'));
  const run = (args) => execFileSync('git', args, { cwd: dir, windowsHide: true });
  run(['init', '-b', 'main']);
  run(['config', 'user.email', 'test@example.com']);
  run(['config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(dir, 'README.md'), 'project under orchestration\n');
  fs.writeFileSync(path.join(dir, '.gitignore'), '.switchboard/\n');
  run(['add', '.']);
  run(['commit', '-m', 'init']);
  return dir;
}

// openTerminal implementation that runs fake-claude as a real child process,
// mirroring how the PTY would run the generated `claude ...` command.
function makeRealHarness(project, { verdicts } = {}) {
  const calls = { openTerminal: [], sendInput: [] };
  const active = new Set([MASTER_ID]);
  const env = {
    ...process.env,
    SB_PROJECT_ROOT: project,
    SB_FAKE_VERDICTS: verdicts || 'approved',
  };
  const deps = {
    openTerminal: async (sessionId, cwd, isNew, opts) => {
      calls.openTerminal.push({ sessionId, cwd, isNew, opts });
      const args = [FAKE_CLAUDE, isNew ? '--session-id' : '--resume', sessionId];
      if (opts?.permissionMode) args.push('--permission-mode', opts.permissionMode);
      if (opts?.initialPrompt) args.push(opts.initialPrompt);
      try {
        const child = spawn(process.execPath, args, { cwd, env, windowsHide: true });
        active.add(sessionId);
        child.on('exit', () => active.delete(sessionId));
        return { ok: true };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    },
    sendInput: (sessionId, text) => { calls.sendInput.push({ sessionId, text }); return true; },
    isSessionActive: (id) => active.has(id),
    isSessionBusy: () => false,
    seedSessionJsonl: () => true,
    ensureTaskWorktree: wt.ensureTaskWorktree,
    rolePrompt: (role) => `fake ${role} prompt`,
  };
  return { calls, deps, active };
}

async function waitUntil(predicate, { timeoutMs = 30_000, label = 'condition' } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return;
    await new Promise(r => setTimeout(r, 150));
  }
  throw new Error(`timeout waiting for ${label}`);
}

test('full lifecycle: implement → review → approve → nudge → merge', { timeout: 120_000 }, async () => {
  const project = makeRepo();
  const created = proto.createRun(project, {
    title: 'e2e demo',
    goal: 'prove the loop',
    roles: {
      master: { profileId: 'anthropic' },
      worker: { profileId: 'deepseek', maxConcurrent: 2 },
      reviewer: { profileId: 'anthropic', maxConcurrent: 2 },
    },
  });
  assert.equal(created.ok, true);
  const run = { ...created.run, status: 'active', masterSessionId: MASTER_ID };
  proto.writeRun(project, run);

  // T-1 approves on first review; T-2 needs a rework round first.
  proto.writeTask(project, run.id, { id: 'T-1', title: 'first thing', status: 'ready', kind: 'leaf' });
  proto.writeTask(project, run.id, { id: 'T-2', title: 'second thing', status: 'ready', kind: 'leaf' });
  // verdict sequence is consumed globally: T-1's review approved, the next
  // (T-2 round 1) changes_requested, then approved.
  const { calls, deps } = makeRealHarness(project, { verdicts: 'approved,changes_requested,approved' });

  const watcher = new OrchWatcher();
  const spawner = new OrchSpawner({ watcher, deps });
  try {
    spawner.start();
    watcher.watchProject(project);

    await waitUntil(() => {
      const t1 = proto.readTask(project, run.id, 'T-1');
      const t2 = proto.readTask(project, run.id, 'T-2');
      return t1?.status === 'approved' && t2?.status === 'approved';
    }, { label: 'both tasks approved' });

    const t1 = proto.readTask(project, run.id, 'T-1');
    const t2 = proto.readTask(project, run.id, 'T-2');

    // Worker ran in a real worktree and committed.
    assert.ok(t1.worktree && fs.existsSync(path.join(t1.worktree, `impl-T-1.txt`)));
    assert.equal(t1.attempts, 1);
    assert.equal(t1.reviews.length, 1);
    assert.equal(t1.reviews[0].verdict, 'approved');

    // T-2 went through the rework loop.
    assert.equal(t2.attempts, 2, 'T-2 should have two attempts');
    assert.equal(t2.reviews.length, 2);
    assert.deepEqual(t2.reviews.map(r => r.verdict), ['changes_requested', 'approved']);
    const reviewFile = path.join(proto.runDir(project, run.id), t2.reviews[0].file);
    assert.match(fs.readFileSync(reviewFile, 'utf8'), /changes_requested/);

    // Master got nudged about the approvals.
    await waitUntil(() => calls.sendInput.some(c => c.sessionId === MASTER_ID && /approved/.test(c.text)),
      { label: 'master nudge', timeoutMs: 15_000 });

    // Now play the master's merge step (what /sb-orchestrate does) for T-1,
    // against the real integration worktree.
    const iw = await wt.ensureIntegrationWorktree(project, run.id, run.integrationBranch);
    assert.equal(iw.ok, true, iw.error);
    assert.equal(proto.transitionTask(project, run.id, 'T-1', 'approved', 'merging').ok, true);
    execFileSync('git', ['-c', 'user.email=m@test', '-c', 'user.name=master',
      'merge', '--no-ff', wt.taskBranchName(run.id, 'T-1')], { cwd: iw.path, windowsHide: true });
    assert.ok(fs.existsSync(path.join(iw.path, 'impl-T-1.txt')), 'merge must land the implementation');
    assert.equal(proto.transitionTask(project, run.id, 'T-1', 'merging', 'done').ok, true);

    // Task worktree can now be removed; branch survives.
    const rm = await wt.removeTaskWorktree(project, run.id, 'T-1');
    assert.equal(rm.ok, true, rm.error);
    assert.equal(await wt.branchExists(project, wt.taskBranchName(run.id, 'T-1')), true);

    // Events tell the whole story.
    const types = proto.readEvents(project, run.id, 500).map(e => e.type);
    for (const expected of ['run-created', 'task-transition', 'worker-spawned', 'reviewer-spawned', 'master-nudged']) {
      assert.ok(types.includes(expected), `events must include ${expected}`);
    }

    // Spawn metadata: workers got the worker profile, reviewers the reviewer's.
    const workerSpawns = calls.openTerminal.filter(c => c.opts.initialPrompt.startsWith('/sb-work'));
    const reviewerSpawns = calls.openTerminal.filter(c => c.opts.initialPrompt.startsWith('/sb-review'));
    assert.ok(workerSpawns.length >= 3, '2 first attempts + 1 rework');
    assert.ok(reviewerSpawns.length >= 3);
    assert.ok(workerSpawns.every(c => c.opts.profileId === 'deepseek'));
    assert.ok(reviewerSpawns.every(c => c.opts.profileId === 'anthropic'));
    // Worktree sessions must get protocol access via addDirs.
    assert.ok(workerSpawns.every(c => String(c.opts.addDirs).includes('.switchboard')));
  } finally {
    spawner.stop();
    watcher.dispose();
  }
});

test('paused run halts the pipeline mid-flight', { timeout: 60_000 }, async () => {
  const project = makeRepo();
  const created = proto.createRun(project, {
    title: 'pause demo', roles: {
      master: { profileId: 'a' }, worker: { profileId: 'b', maxConcurrent: 1 }, reviewer: { profileId: 'a' },
    },
  });
  const run = { ...created.run, status: 'active', masterSessionId: MASTER_ID };
  proto.writeRun(project, run);
  proto.writeTask(project, run.id, { id: 'T-1', title: 'a', status: 'ready', kind: 'leaf' });
  proto.writeTask(project, run.id, { id: 'T-2', title: 'b', status: 'ready', kind: 'leaf', dependsOn: ['T-1'] });

  const { deps } = makeRealHarness(project);
  const watcher = new OrchWatcher();
  const spawner = new OrchSpawner({ watcher, deps });
  try {
    spawner.start();
    watcher.watchProject(project);
    // Let T-1 reach needs_review (worker done), then pause before review spawn
    // can be guaranteed — then assert nothing further progresses for T-2.
    await waitUntil(() => ['needs_review', 'reviewing', 'approved'].includes(
      proto.readTask(project, run.id, 'T-1')?.status), { label: 'T-1 worked' });
    proto.writeRun(project, { ...proto.readRun(project, run.id), status: 'paused' });
    watcher.refresh(project);
    await new Promise(r => setTimeout(r, 1200));
    assert.equal(proto.readTask(project, run.id, 'T-2').status, 'ready', 'paused run must not dispatch T-2');
  } finally {
    spawner.stop();
    watcher.dispose();
  }
});
