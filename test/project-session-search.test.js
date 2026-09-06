const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

// Exercise the real search controller with deterministic timers and IPC.
const source = fs.readFileSync(path.join(__dirname, '../public/projects-view.js'), 'utf8');
const controller = source.slice(source.indexOf('function updateProjectSessionSearch('), source.indexOf('function buildSessionPaneList('));

function setup() {
  const project = { id: 'project', sessions: [{ sessionId: 'active' }], tracks: [] };
  const full = { ...project, tracks: [{ sessions: [{ sessionId: 'archived', archived: 1 }] }] };
  const state = { query: 'needle', displayQuery: '', titlesOnly: false, version: 0, ids: new Set() };
  const timers = new Map();
  const calls = [];
  let nextTimer = 0;
  const context = vm.createContext({
    clearTimeout: id => timers.delete(id),
    setTimeout: fn => { timers.set(++nextTimer, fn); return nextTimer; },
    projectsUi: { working: true },
    selectedProject: () => project,
    projectPanes: { querySelector: () => null },
    cachedProjectTreeAll: { projects: [full, { id: 'other', sessions: [{ sessionId: 'outside' }] }] },
    projectSessionsAll: p => [...p.sessions, ...p.tracks.flatMap(t => t.sessions)],
    window: { api: { searchSessionIds: (query, ids) => new Promise(resolve => calls.push({ query, ids, resolve })) } },
  });
  vm.runInContext(controller, context);
  return { project, state, timers, calls, update: () => context.updateProjectSessionSearch(project, state) };
}

test('title-only search is immediate and cancels a queued transcript search', () => {
  const s = setup();
  s.update();
  assert.equal(s.timers.size, 1);
  s.state.titlesOnly = true;
  s.update();
  assert.equal(s.timers.size, 0);
  assert.equal(s.calls.length, 0);
  assert.equal(s.state.pending, false);
  assert.equal(s.state.displayQuery, 'needle');
});

test('typing keeps completed results visible until the refined query finishes', async () => {
  const s = setup();
  s.state.displayQuery = 'need';
  s.state.ids = new Set(['active', 'archived']);
  s.update();
  assert.equal(s.state.pending, true);
  assert.equal(s.state.displayQuery, 'need');
  assert.deepEqual([...s.state.ids], ['active', 'archived']);
  const request = [...s.timers.values()].at(-1)();
  s.calls[0].resolve(['archived']);
  await request;
  assert.equal(s.state.displayQuery, 'needle');
  assert.deepEqual([...s.state.ids], ['archived']);
  s.state.query = '';
  s.update();
  assert.equal(s.state.displayQuery, '');
  assert.equal(s.state.pending, false);
});

test('transcript search uses loaded active/archived IDs and ignores stale replies', async () => {
  const s = setup();
  s.update();
  const first = [...s.timers.values()][0]();
  assert.deepEqual(s.calls[0].ids, ['active', 'archived']);
  s.state.query = '';
  s.update();
  s.calls[0].resolve(['archived']);
  await first;
  assert.equal(s.state.ids.size, 0);
  assert.equal(s.state.pending, false);
  s.state.query = 'fresh';
  s.update();
  const latest = [...s.timers.values()].at(-1)();
  s.calls[1].resolve(['active']);
  await latest;
  assert.deepEqual([...s.state.ids], ['active']);
  assert.equal(s.state.pending, false);
});
