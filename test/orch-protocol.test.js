const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const proto = require('../orch-protocol');

function tmpProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sb-orch-'));
}

const ROLES = {
  master: { profileId: 'anthropic' },
  worker: { profileId: 'deepseek', maxConcurrent: 3 },
  reviewer: { profileId: 'anthropic' },
};

test('createRun scaffolds directories and a valid run.json', () => {
  const project = tmpProject();
  const r = proto.createRun(project, { title: 'Auth Refactor!', goal: 'do it', roles: ROLES });
  assert.equal(r.ok, true);
  assert.match(r.run.id, /^\d{4}-\d{2}-\d{2}-auth-refactor-[0-9a-f]{4}$/);
  assert.equal(r.run.status, 'planning');
  assert.equal(r.run.policy.autoMerge, true);
  assert.equal(r.run.roles.worker.maxConcurrent, 3);
  assert.equal(r.run.roles.reviewer.maxConcurrent, 2); // default
  for (const sub of ['tasks', 'reviews', 'prompts']) {
    assert.ok(fs.existsSync(path.join(r.dir, sub)), sub + ' dir missing');
  }
  const runs = proto.listRunIds(project);
  assert.deepEqual(runs, [r.run.id]);
  const readBack = proto.readRun(project, r.run.id);
  assert.equal(readBack.title, 'Auth Refactor!');
  const events = proto.readEvents(project, r.run.id);
  assert.equal(events[0].type, 'run-created');
});

test('createRun rejects missing roles', () => {
  const r = proto.createRun(tmpProject(), { title: 'x', roles: { master: { profileId: 'a' } } });
  assert.equal(r.ok, false);
});

test('task write/read round-trip and validation', () => {
  const project = tmpProject();
  const { run } = proto.createRun(project, { title: 'r', roles: ROLES });
  const bad = proto.writeTask(project, run.id, { id: '../evil', title: 'x', status: 'draft' });
  assert.equal(bad.ok, false);
  const good = proto.writeTask(project, run.id, {
    id: 'T-001', title: 'First task', status: 'draft', kind: 'leaf', dependsOn: [],
  });
  assert.equal(good.ok, true);
  const task = proto.readTask(project, run.id, 'T-001');
  assert.equal(task.title, 'First task');
  // file named differently from its id is ignored on directory reads
  fs.writeFileSync(
    path.join(proto.runDir(project, run.id), 'tasks', 'T-999.json'),
    JSON.stringify({ id: 'T-100', title: 'mismatch', status: 'draft' })
  );
  const tasks = proto.readTasks(project, run.id);
  assert.deepEqual(tasks.map(t => t.id), ['T-001']);
});

test('transitionTask enforces the status machine', () => {
  const project = tmpProject();
  const { run } = proto.createRun(project, { title: 'r', roles: ROLES });
  proto.writeTask(project, run.id, { id: 'T-1', title: 't', status: 'draft' });

  // draft → in_progress is illegal
  const illegal = proto.transitionTask(project, run.id, 'T-1', 'draft', 'in_progress');
  assert.equal(illegal.ok, false);
  assert.match(illegal.error, /illegal transition/);

  // draft → ready is legal
  const ok = proto.transitionTask(project, run.id, 'T-1', 'draft', 'ready', { attempts: 0 }, 'master');
  assert.equal(ok.ok, true);
  assert.equal(proto.readTask(project, run.id, 'T-1').status, 'ready');

  // stale "from" is a conflict, not a crash
  const conflict = proto.transitionTask(project, run.id, 'T-1', 'draft', 'ready');
  assert.equal(conflict.ok, false);
  assert.equal(conflict.conflict, true);

  const events = proto.readEvents(project, run.id);
  const transitions = events.filter(e => e.type === 'task-transition');
  assert.equal(transitions.length, 1);
  assert.equal(transitions[0].actor, 'master');
});

test('full lifecycle walk through the status machine', () => {
  const project = tmpProject();
  const { run } = proto.createRun(project, { title: 'r', roles: ROLES });
  proto.writeTask(project, run.id, { id: 'T-1', title: 't', status: 'draft' });
  const hops = [
    ['draft', 'ready'], ['ready', 'spawning'], ['spawning', 'in_progress'],
    ['in_progress', 'needs_review'], ['needs_review', 'reviewing'],
    ['reviewing', 'changes_requested'], ['changes_requested', 'spawning'],
    ['spawning', 'in_progress'], ['in_progress', 'needs_review'],
    ['needs_review', 'reviewing'], ['reviewing', 'approved'],
    ['approved', 'merging'], ['merging', 'done'],
  ];
  for (const [from, to] of hops) {
    const r = proto.transitionTask(project, run.id, 'T-1', from, to);
    assert.equal(r.ok, true, `${from} → ${to}: ${r.error || ''}`);
  }
  assert.equal(proto.readTask(project, run.id, 'T-1').status, 'done');
  // done is terminal
  assert.equal(proto.isTransitionAllowed('done', 'ready'), false);
});

test('depsSatisfied and summarizeTasks', () => {
  const tasks = [
    { id: 'A', title: 'a', status: 'done', kind: 'leaf' },
    { id: 'B', title: 'b', status: 'ready', kind: 'leaf', dependsOn: ['A'] },
    { id: 'C', title: 'c', status: 'ready', kind: 'leaf', dependsOn: ['B'] },
    { id: 'E', title: 'e', status: 'in_progress', kind: 'chunk' },
  ];
  const byId = new Map(tasks.map(t => [t.id, t]));
  assert.equal(proto.depsSatisfied(byId.get('B'), byId), true);
  assert.equal(proto.depsSatisfied(byId.get('C'), byId), false);
  // missing dependency counts as unsatisfied
  assert.equal(proto.depsSatisfied({ dependsOn: ['ZZZ'] }, byId), false);

  const s = proto.summarizeTasks(tasks);
  assert.equal(s.total, 4);
  assert.equal(s.leaves, 3);
  assert.equal(s.leavesDone, 1);
  assert.equal(s.byStatus.ready, 2);
});

test('readRun/readTask reject hostile ids', () => {
  const project = tmpProject();
  assert.equal(proto.readRun(project, '../../etc'), null);
  assert.equal(proto.readTask(project, 'whatever', '..\\..\\foo'), null);
});

test('writeJsonAtomic survives concurrent-ish writers (last write wins, never torn)', () => {
  const project = tmpProject();
  const file = path.join(project, 'x.json');
  for (let i = 0; i < 50; i++) proto.writeJsonAtomic(file, { i, pad: 'x'.repeat(2048) });
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(parsed.i, 49);
  // no stray tmp files left behind
  assert.deepEqual(fs.readdirSync(project).filter(f => f.includes('.tmp')), []);
});
