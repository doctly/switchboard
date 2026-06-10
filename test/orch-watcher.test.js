const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const proto = require('../orch-protocol');
const { OrchWatcher, scanProject } = require('../orch-watcher');

const ROLES = {
  master: { profileId: 'a' }, worker: { profileId: 'b' }, reviewer: { profileId: 'a' },
};

function tmpProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sb-watch-'));
}

function waitFor(emitter, event, predicate, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      emitter.removeListener(event, handler);
      reject(new Error(`timeout waiting for ${event}`));
    }, timeoutMs);
    function handler(...args) {
      if (!predicate || predicate(...args)) {
        clearTimeout(timer);
        emitter.removeListener(event, handler);
        resolve(args);
      }
    }
    emitter.on(event, handler);
  });
}

test('scanProject builds a snapshot of runs, tasks and summary', () => {
  const project = tmpProject();
  const { run } = proto.createRun(project, { title: 'demo', roles: ROLES });
  proto.writeTask(project, run.id, { id: 'T-1', title: 'a', status: 'ready', kind: 'leaf' });
  proto.writeTask(project, run.id, { id: 'T-2', title: 'b', status: 'done', kind: 'leaf' });
  const snap = scanProject(project);
  assert.equal(snap.runs.length, 1);
  assert.equal(snap.runs[0].tasks.length, 2);
  assert.equal(snap.runs[0].summary.leavesDone, 1);
});

test('scanProject of a project with no .switchboard dir is empty, not an error', () => {
  const snap = scanProject(tmpProject());
  assert.deepEqual(snap.runs, []);
});

test('watcher emits state + task-changed when a task file changes', async () => {
  const project = tmpProject();
  const { run } = proto.createRun(project, { title: 'demo', roles: ROLES });
  proto.writeTask(project, run.id, { id: 'T-1', title: 'a', status: 'draft', kind: 'leaf' });

  const w = new OrchWatcher();
  try {
    w.watchProject(project);
    // initial scan already happened synchronously
    const initial = w.getSnapshot(project);
    assert.equal(initial.runs[0].tasks[0].status, 'draft');

    const changed = waitFor(w, 'task-changed', (_p, _runId, task) => task.status === 'ready');
    proto.transitionTask(project, run.id, 'T-1', 'draft', 'ready', null, 'master');
    const [, runId, task, prevTask] = await changed;
    assert.equal(runId, run.id);
    assert.equal(task.status, 'ready');
    assert.equal(prevTask.status, 'draft');

    const snap = w.getSnapshot(project);
    assert.equal(snap.runs[0].tasks[0].status, 'ready');
  } finally {
    w.dispose();
  }
});

test('watcher emits run-changed when run.json changes', async () => {
  const project = tmpProject();
  const { run } = proto.createRun(project, { title: 'demo', roles: ROLES });
  const w = new OrchWatcher();
  try {
    w.watchProject(project);
    const changed = waitFor(w, 'run-changed', (_p, _id, r) => r.status === 'paused');
    proto.writeRun(project, { ...run, status: 'paused' });
    const [, , newRun, prevRun] = await changed;
    assert.equal(newRun.status, 'paused');
    assert.equal(prevRun.status, 'planning');
  } finally {
    w.dispose();
  }
});

test('watcher picks up runs created after watching started (no .switchboard yet)', async () => {
  const project = tmpProject();
  const w = new OrchWatcher();
  try {
    w.watchProject(project);
    assert.deepEqual(w.getSnapshot(project).runs, []);
    const seen = waitFor(w, 'run-changed', null, 8000);
    proto.createRun(project, { title: 'late', roles: ROLES });
    const [, runId] = await seen;
    assert.match(runId, /late/);
  } finally {
    w.dispose();
  }
});

test('unwatch stops events; refresh forces immediate rescan', async () => {
  const project = tmpProject();
  const { run } = proto.createRun(project, { title: 'demo', roles: ROLES });
  const w = new OrchWatcher();
  try {
    w.watchProject(project);
    let events = 0;
    w.on('state', () => { events++; });
    proto.writeTask(project, run.id, { id: 'T-9', title: 'x', status: 'draft' });
    w.refresh(project);
    assert.ok(events >= 1);
    const after = events;
    w.unwatchProject(project);
    proto.writeTask(project, run.id, { id: 'T-10', title: 'y', status: 'draft' });
    await new Promise(r => setTimeout(r, 400));
    assert.equal(events, after);
    assert.equal(w.getSnapshot(project), null);
  } finally {
    w.dispose();
  }
});
