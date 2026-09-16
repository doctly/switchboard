const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createTaskManager } = require('../task-manager');

const nextTurn = () => new Promise(resolve => setImmediate(resolve));
const leaf = (label, cwd = process.cwd()) => ({ label, type: 'process', executable: 'node', args: [], cwd, env: {}, dependsOn: [], supported: true });

function setup(t, tasks, overrides = {}) {
  const spawns = [], events = [];
  const manager = createTaskManager({
    pty: { spawn(executable, args, options) {
      const process = {
        onData(fn) { this.output = fn; }, onExit(fn) { this.exit = fn; },
        kill() { this.exit?.({ exitCode: 0, signal: 15 }); },
      };
      spawns.push({ executable, args, options, process });
      return process;
    } },
    loadProjectTasks: () => tasks,
    getShellProfile: () => ({ path: '/bin/sh', args: [] }),
    baseEnv: {}, log: { info() {}, warn() {}, debug() {} },
    send: (...args) => events.push(args),
    ...overrides,
  });
  t.after(() => manager.shutdown());
  return { manager, spawns, events };
}

test('a task shown through worktree inheritance launches from the same definition', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-task-inherit-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const parent = path.join(root, 'source');
  const worktree = path.join(root, 'redesign', 'repos', 'parser');
  fs.mkdirSync(path.join(parent, '.vscode'), { recursive: true });
  fs.mkdirSync(worktree, { recursive: true });
  fs.writeFileSync(path.join(parent, '.vscode', 'tasks.json'), JSON.stringify({ version: '2.0.0', tasks: [
    { label: 'Parser', type: 'process', command: 'node', args: ['inherited.js'] },
  ] }));
  const { manager, spawns } = setup(t, null, {
    loadProjectTasks: require('../task-config').loadProjectTasks,
    resolveWorktreeParent: folder => folder === worktree ? parent : null,
  });
  assert.equal(manager.listTasks(worktree).tasks[0].label, 'Parser');
  manager.startTask(worktree, 'Parser');
  await nextTurn();
  assert.equal(spawns.length, 1);
  assert.equal(spawns[0].options.cwd, worktree);
  assert.match(spawns[0].args.at(-1), /inherited.js/);
  manager.stopTask(worktree, 'Parser');
  fs.mkdirSync(path.join(worktree, '.vscode'));
  fs.writeFileSync(path.join(worktree, '.vscode', 'tasks.json'), JSON.stringify({ version: '2.0.0', tasks: [
    { label: 'Parser', type: 'process', command: 'node', args: ['local.js'] },
  ] }));
  manager.restartTask(worktree, 'Parser');
  await nextTurn();
  assert.match(spawns[1].args.at(-1), /local.js/, 'a newly copied local definition takes precedence');
});

test('configuration failures before spawning retain an error, log, and failed event', t => {
  const { manager, spawns, events } = setup(t, [], { loadProjectTasks: () => { throw Error('Could not read task env file /project/.env'); } });
  const result = manager.startTask('/project', 'Parser');
  assert.equal(result.state, 'failed');
  assert.deepEqual(manager.getRun('/project', 'Parser'), result);
  assert.match(result.output, /Could not read task env file/);
  assert.equal(spawns.length, 0);
  assert.equal(events.filter(event => event[0] === 'task-state-changed').at(-1)[1].error, result.error);
});

test('missing tasks and invalid dependencies remain inspectable in retained logs', t => {
  const { manager } = setup(t, [{ label: 'Stack', type: 'compound', supported: true, dependsOn: ['missing'] }]);
  for (const label of ['Unknown', 'Stack']) {
    const result = manager.startTask('/project', label);
    assert.equal(result.state, 'failed');
    assert.match(manager.getRun('/project', label).output, /was not found/);
  }
});

test('a missing working directory fails both the dependency and its compound task', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-task-missing-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const missing = path.join(root, 'missing');
  const { manager, spawns } = setup(t, [leaf('Parser', missing), { label: 'Stack', type: 'compound', dependsOn: ['Parser'], supported: true }]);
  manager.startTask('/project', 'Stack');
  await nextTurn();
  assert.equal(spawns.length, 0);
  for (const label of ['Parser', 'Stack']) {
    const run = manager.getRun('/project', label);
    assert.equal(run.state, 'failed');
    assert.equal(run.running, false);
    assert.match(run.error, /working directory does not exist/);
    assert.ok(run.output.includes(missing));
  }
});

test('a PTY spawn failure is retained once and retry clears it', async t => {
  let fail = true;
  const { manager } = setup(t, [leaf('Parser')], {
    pty: { spawn() {
      if (fail) throw Error('Unable to start selected shell');
      return { onData() {}, onExit() {}, kill() {} };
    } },
  });
  manager.startTask('/project', 'Parser');
  await nextTurn();
  const failed = manager.getRun('/project', 'Parser');
  assert.equal(failed.state, 'failed');
  assert.equal(failed.error, 'Unable to start selected shell');
  assert.equal(failed.output.match(/Unable to start selected shell/g).length, 1);
  fail = false;
  manager.restartTask('/project', 'Parser');
  await nextTurn();
  const retried = manager.getRun('/project', 'Parser');
  assert.equal(retried.running, true);
  assert.equal(retried.error, null);
  assert.equal(retried.output, '');
});

test('process errors preserve stderr and exit code for View log', async t => {
  const { manager, spawns } = setup(t, [leaf('Parser')]);
  manager.startTask('/project', 'Parser');
  await nextTurn();
  spawns[0].process.output('parser: command not found\r\n');
  spawns[0].process.exit({ exitCode: 127, signal: 0 });
  const run = manager.getRun('/project', 'Parser');
  assert.equal(run.state, 'failed');
  assert.equal(run.exitCode, 127);
  assert.match(run.output, /parser: command not found/);
});

test('a new configuration error does not overwrite a task that is already running', async t => {
  let invalid = false;
  const { manager, spawns } = setup(t, [], { loadProjectTasks: () => { if (invalid) throw Error('Invalid tasks.json'); return [leaf('Parser')]; } });
  manager.startTask('/project', 'Parser');
  await nextTurn();
  invalid = true;
  assert.equal(manager.startTask('/project', 'Parser').running, true);
  assert.equal(manager.getRun('/project', 'Parser').running, true);
  assert.equal(spawns.length, 1);
});
