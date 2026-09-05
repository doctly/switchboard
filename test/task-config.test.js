const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const { loadTasksFromText, resolveTaskGraph, taskFileForWorkspace } = require('../task-config');

const workspaceFolder = path.resolve('/tmp/example-project');

function load(text, options = {}) {
  return loadTasksFromText(text, {
    workspaceFolder,
    platform: 'darwin',
    env: { NODE_ENV: 'host', HOME: '/Users/tester' },
    userHome: '/Users/tester',
    ...options,
  });
}

test('loads JSONC shell tasks and expands workspace variables', () => {
  const tasks = load(`{
    // Comments and trailing commas are valid in VS Code files.
    "version": "2.0.0",
    "tasks": [{
      "label": "dev server",
      "type": "shell",
      "command": "node",
      "args": ["\${workspaceFolder}/server.js", { "value": "--watch" },],
      "options": { "cwd": "\${workspaceFolder}/packages/web" },
    }],
  }`);

  assert.equal(tasks[0].label, 'dev server');
  assert.equal(tasks[0].executable, 'node');
  assert.deepEqual(tasks[0].args, [`${workspaceFolder}/server.js`, '--watch']);
  assert.equal(tasks[0].cwd, path.join(workspaceFolder, 'packages/web'));
  assert.equal(tasks[0].useShell, true);
});

test('merges macOS task options over root options', () => {
  const tasks = load(JSON.stringify({
    version: '2.0.0',
    options: { env: { ROOT: 'yes', SHARED: 'root' } },
    tasks: [{
      label: 'platform', type: 'process', command: 'node',
      options: { env: { SHARED: 'task' } },
      osx: { command: 'bun', options: { env: { MAC: 'yes' } } },
    }],
  }));

  assert.equal(tasks[0].executable, 'bun');
  assert.deepEqual(tasks[0].env, { ROOT: 'yes', SHARED: 'task', MAC: 'yes' });
});

test('normalizes npm tasks and task arguments', () => {
  const [task] = load(JSON.stringify({
    version: '2.0.0',
    tasks: [{ label: 'web', type: 'npm', script: 'dev', args: ['--port', '3000'] }],
  }));

  assert.equal(task.type, 'npm');
  assert.equal(task.executable, 'npm');
  assert.deepEqual(task.args, ['run', 'dev', '--', '--port', '3000']);
});

test('loads an env file without mutating the host environment', () => {
  const [task] = load(JSON.stringify({
    version: '2.0.0',
    tasks: [{
      label: 'env', type: 'process', command: 'node',
      options: { envFile: '.env.task', env: { URL: '${env:HOST}/api' } },
    }],
  }), {
    env: { HOST: 'https://host.example' },
    readFile: filePath => {
      assert.equal(filePath, path.join(workspaceFolder, '.env.task'));
      return 'TOKEN=secret\nHOST=https://file.example\n';
    },
  });

  assert.deepEqual(task.env, {
    TOKEN: 'secret',
    HOST: 'https://file.example',
    URL: 'https://file.example/api',
  });
  assert.equal(process.env.TOKEN, undefined);
});

test('resolves parallel and sequential compound dependency graphs', () => {
  const tasks = load(JSON.stringify({
    version: '2.0.0',
    tasks: [
      { label: 'api', type: 'shell', command: 'npm', args: ['run', 'api'] },
      { label: 'web', type: 'shell', command: 'npm', args: ['run', 'web'] },
      { label: 'all', dependsOn: ['api', 'web'], dependsOrder: 'parallel' },
    ],
  }));
  const graph = resolveTaskGraph(tasks, 'all');

  assert.equal(graph.task.type, 'compound');
  assert.deepEqual(graph.dependencies.map(node => node.task.label), ['api', 'web']);
  assert.equal(graph.task.dependsOrder, 'parallel');
});

test('reports missing dependencies and cycles', () => {
  const missing = load(JSON.stringify({
    version: '2.0.0', tasks: [{ label: 'all', dependsOn: 'missing' }],
  }));
  assert.throws(() => resolveTaskGraph(missing, 'all'), /was not found/);

  const cyclic = load(JSON.stringify({
    version: '2.0.0', tasks: [
      { label: 'one', dependsOn: 'two' },
      { label: 'two', dependsOn: 'one' },
    ],
  }));
  assert.throws(() => resolveTaskGraph(cyclic, 'one'), /cycle detected/);

});

test('an unlabelled task still fails the whole file', () => {
  assert.throws(() => load(JSON.stringify({
    version: '2.0.0',
    tasks: [{ type: 'shell', command: '${command:pickSomething}' }],
  })), /must have a string label/);
});

test('an unresolvable variable disables only its own task', () => {
  const tasks = load(JSON.stringify({
    version: '2.0.0',
    tasks: [
      { label: 'unit', type: 'shell', command: 'pytest', args: ['tests/unit/'] },
      {
        label: 'current file',
        detail: 'run the focused test',
        type: 'shell',
        command: 'pytest',
        args: ['${relativeFile}'],
      },
    ],
  }));

  assert.deepEqual(tasks.map(task => task.label), ['unit', 'current file']);

  const runnable = tasks[0];
  assert.equal(runnable.supported, true);
  assert.deepEqual(runnable.args, ['tests/unit/']);

  const disabled = tasks[1];
  assert.equal(disabled.supported, false);
  assert.match(disabled.error, /Unsupported task variable \$\{relativeFile\}/);
  assert.equal(disabled.detail, 'run the focused test');
  assert.equal(disabled.cwd, workspaceFolder);
  assert.throws(() => resolveTaskGraph(tasks, 'current file'), /Unsupported task variable/);
});

test('worktrees inherit the parent tasks file when they do not define one', () => {
  const worktree = path.join('/repo', '.claude', 'worktrees', 'feature');
  const parentTasks = path.join('/repo', '.vscode', 'tasks.json');
  const source = taskFileForWorkspace(worktree, filePath => filePath === parentTasks);

  assert.deepEqual(source, {
    filePath: parentTasks,
    inherited: true,
    parentPath: '/repo',
  });
});

test('a worktree tasks file overrides the parent tasks file', () => {
  const worktree = path.join('/repo', '.claude', 'worktrees', 'feature');
  const localTasks = path.join(worktree, '.vscode', 'tasks.json');
  const source = taskFileForWorkspace(worktree, filePath => filePath === localTasks);

  assert.deepEqual(source, { filePath: localTasks, inherited: false });
});
