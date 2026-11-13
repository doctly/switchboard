const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  createProcessMonitor,
  parsePsTable,
  parseWindowsTable,
  parseCommandLines,
  collectTree,
  friendlyName,
  summarizeTree,
  killOrder,
} = require('../process-monitor');

// launchd → zsh (session) → claude → two MCP servers, one of which runs vite.
const PS = [
  '    1     0   1000   0.0 Ss   /sbin/launchd',
  '  100     1  20000   1.5 Ss   /bin/zsh',
  '  101   100 400000  12.3 S+   /Users/me/.local/bin/claude',
  '  102   101  80000   0,5 S    /usr/local/bin/node',
  '  103   101  30000   0.0 S    /usr/bin/python3',
  '  104   102 250000  40.0 R    /Applications/Some App.app/Contents/MacOS/Some App',
  '  105   100      0   0.0 Z    <defunct>',
  '  200     1   5000   0.0 Ss   /bin/bash',
  'garbage line',
  '',
].join('\n');

test('ps output becomes a pid table, rss in bytes, names without their folder', () => {
  const table = parsePsTable(PS);
  assert.equal(table.size, 7);
  assert.equal(table.has(105), false, 'zombies are left out');
  assert.deepEqual(table.get(101), { pid: 101, ppid: 100, rssBytes: 400000 * 1024, cpu: 12.3, name: 'claude' });
  // A decimal comma still reads as a number; a name with spaces stays whole.
  assert.equal(table.get(102).cpu, 0.5);
  assert.equal(table.get(104).name, 'Some App');
});

test('the Windows query output becomes the same table, without CPU', () => {
  const table = parseWindowsTable('4\t0\t1024\tSystem\r\n900\t4\t2048\tclaude.exe\r\nnot a row\r\n');
  assert.deepEqual(table.get(900), { pid: 900, ppid: 4, rssBytes: 2048, cpu: null, name: 'claude.exe' });
  assert.equal(table.size, 2);
});

test('a tree is the root and every descendant, heaviest children first', () => {
  const tree = collectTree(parsePsTable(PS), 100);
  assert.deepEqual(tree.map(p => [p.pid, p.depth]), [[100, 0], [101, 1], [102, 2], [104, 3], [103, 2]]);
  assert.deepEqual(collectTree(parsePsTable(PS), 999), []);
  assert.deepEqual(collectTree(parsePsTable(PS), null), []);
});

test('a loop in the parent links cannot hang the walk', () => {
  const table = new Map([
    [1, { pid: 1, ppid: 2, rssBytes: 1, cpu: 0, name: 'a' }],
    [2, { pid: 2, ppid: 1, rssBytes: 1, cpu: 0, name: 'b' }],
  ]);
  assert.deepEqual(collectTree(table, 1).map(p => p.pid), [1, 2]);
});

test('a session costs the sum of its tree', () => {
  const summary = summarizeTree(collectTree(parsePsTable(PS), 100));
  assert.equal(summary.rssBytes, (20000 + 400000 + 80000 + 30000 + 250000) * 1024);
  assert.equal(summary.cpu, 54.3);
  assert.equal(summary.processCount, 5);
  assert.equal(summarizeTree([{ rssBytes: 5, cpu: null }]).cpu, null);
});

test('an interpreter is named after the script it runs', () => {
  assert.equal(friendlyName('node', 'node --max-old-space-size=4096 /usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js --resume x'), 'node cli.js');
  assert.equal(friendlyName('node.exe', 'C:\\node.exe C:\\tools\\server.js'), 'node server.js');
  assert.equal(friendlyName('python3', 'python3 -m'), 'python3');
  assert.equal(friendlyName('claude', '/bin/claude --ide'), 'claude');
  assert.equal(friendlyName('node', null), 'node');
  assert.equal(friendlyName('node', 'node -e \\012const x = 1'), 'node');
  assert.equal(friendlyName('node', 'node -e const b=Buffer.alloc(300*1024*1024,1);'), 'node');
  assert.equal(friendlyName('python3', 'python3 -c import os; os.getcwd()'), 'python3');
  assert.equal(friendlyName('python3', 'python3 -m http.server 8000'), 'python3 http.server');
});

test('command lines are read per pid', () => {
  const lines = parseCommandLines('  101 /bin/claude --ide\n  102 node /x/server.js --port 3000\n');
  assert.equal(lines.get(102), 'node /x/server.js --port 3000');
});

test('the deepest processes are killed first', () => {
  const order = killOrder(collectTree(parsePsTable(PS), 100)).map(p => p.pid);
  assert.equal(order[0], 104);
  assert.equal(order[order.length - 1], 100);
});

function fakeMonitor(killed) {
  return createProcessMonitor({
    platform: 'darwin',
    exec: async (file, args) => {
      if (args.includes('pid=,args=')) return '  100 /bin/zsh -c claude\n  101 /bin/claude --ide\n  102 node /x/mcp.js\n';
      return PS;
    },
    kill: (pid, signal) => killed.push([pid, signal]),
  });
}

test('owners are measured over their trees and sorted heaviest first', async () => {
  const monitor = fakeMonitor([]);
  const result = await monitor.measure([
    { id: 'light', pid: 200 },
    { id: 'heavy', pid: 100 },
    { id: 'gone', pid: 999 },
  ]);
  assert.deepEqual(result.map(o => o.id), ['heavy', 'light', 'gone']);
  assert.equal(result[0].processCount, 5);
  assert.equal(result[0].processes[2].label, 'node mcp.js');
  assert.equal(result[2].found, false);
  assert.equal(result[2].rssBytes, 0);
});

test('only a process still inside the session can be killed', async () => {
  const killed = [];
  const monitor = fakeMonitor(killed);
  assert.deepEqual(await monitor.killInTree(100, 104), { ok: true });
  assert.equal((await monitor.killInTree(100, 200)).ok, false);
  assert.equal((await monitor.killInTree(100, 1)).ok, false);
  assert.deepEqual(killed, [[104, 'SIGTERM']]);
});

test('a forced stop kills the whole tree, root last', async () => {
  const killed = [];
  const monitor = fakeMonitor(killed);
  assert.deepEqual(await monitor.killTree(100), { ok: true, killed: 5 });
  assert.deepEqual(killed.map(([pid]) => pid).sort(), [100, 101, 102, 103, 104]);
  assert.ok(killed.every(([, signal]) => signal === 'SIGKILL'));
  assert.deepEqual(killed[killed.length - 1], [100, 'SIGKILL']);
  assert.equal((await monitor.killTree(999)).ok, false);
});

test('stopping leaves no orphan: what ignores the hangup gets SIGTERM, then SIGKILL', async () => {
  // After the stop the shell (100) and claude (101) are gone; node (102) was
  // reparented to launchd and keeps running; python (103) ends on SIGTERM.
  const after = PS.split('\n').filter(l => !/^\s*(100|101) /.test(l)).map(l => l.replace(/^(\s*102\s+)101/, '$1  1')).join('\n');
  const stages = [PS, after, after.split('\n').filter(l => !/^\s*103 /.test(l)).join('\n')];
  let snap = 0;
  const killed = [];
  const steps = [];
  const monitor = createProcessMonitor({
    platform: 'darwin',
    exec: async () => stages[Math.min(snap++, stages.length - 1)],
    kill: (pid, signal) => killed.push([pid, signal]),
    sleep: async (ms) => steps.push(ms),
  });
  let stopped = false;
  const result = await monitor.stopTree(100, () => { stopped = true; }, { graceMs: 10, termMs: 20 });
  assert.equal(stopped, true);
  assert.deepEqual(steps, [10, 20]);
  assert.deepEqual(result, { ok: true, terminated: 3, killed: 2 });
  assert.deepEqual(killed.filter(([, s]) => s === 'SIGTERM').map(([pid]) => pid).sort(), [102, 103, 104]);
  assert.deepEqual(killed.filter(([, s]) => s === 'SIGKILL').map(([pid]) => pid).sort(), [102, 104]);
});

test('a clean stop signals nothing, and a reused pid is never hit', async () => {
  const gone = PS.split('\n').filter(l => !/^\s*10\d /.test(l));
  // pid 102 now belongs to something else entirely.
  gone.push('  102     1   9000   0.0 S    /usr/bin/unrelated');
  const stages = [PS, gone.join('\n')];
  let snap = 0;
  const killed = [];
  const monitor = createProcessMonitor({
    platform: 'darwin',
    exec: async () => stages[Math.min(snap++, stages.length - 1)],
    kill: (pid, signal) => killed.push([pid, signal]),
    sleep: async () => {},
  });
  assert.deepEqual(await monitor.stopTree(100, () => {}), { ok: true, terminated: 0, killed: 0 });
  assert.deepEqual(killed, []);
});
