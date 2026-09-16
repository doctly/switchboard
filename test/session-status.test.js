const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const app = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
const projects = fs.readFileSync(path.join(__dirname, '../public/projects-view.js'), 'utf8');
const sidebar = fs.readFileSync(path.join(__dirname, '../public/sidebar.js'), 'utf8');

function harness() {
  const rows = new Map();
  const listeners = {};
  const events = [];
  const context = vm.createContext({
    attentionSessions: new Set(), responseReadySessions: new Set(),
    sessionBusyState: new Map(), sessionMap: new Map(),
    activePtyIds: new Set(), pendingSessions: new Map(), sessionEventTimes: new Map(),
    activeSessionId: null, terminalHeaderPtyTitle: null,
    document: { querySelectorAll: selector => rows.get(selector.match(/data-session-id="([^"]+)"/)?.[1]) || [] },
    saveSessionNotices() {}, sessionEventTime: () => 123,
    bumpSessionEvent: id => events.push(id),
    window: { api: {
      onTerminalNotification: callback => { listeners.notice = callback; },
      onCliBusyState: callback => { listeners.busy = callback; },
    } },
  });
  vm.runInContext(sidebar.slice(sidebar.indexOf('function isSessionRunning('), sidebar.indexOf('function slugId(')), context);
  vm.runInContext(projects.slice(projects.indexOf('function sessionState('), projects.indexOf('// --- Sidebar: the project list ---')), context);
  context.updateProjectStatusDots = () => {};
  vm.runInContext(app.slice(app.indexOf('function forEachSessionItem('), app.indexOf('// Terminal themes, utils')), context);
  vm.runInContext(app.slice(app.indexOf('window.api.onTerminalNotification('), app.indexOf('// --- Single entry point for all sidebar renders ---')), context);
  const add = (id, type = 'claude') => {
    const session = { sessionId: id, type };
    context.sessionMap.set(id, session);
    context.activePtyIds.add(id);
    // Both the Sessions tab and Projects pane receive the same update.
    const copies = Array.from({ length: 2 }, () => {
      const classes = new Set();
      return { classList: {
        add: name => classes.add(name), remove: name => classes.delete(name),
        contains: name => classes.has(name),
        toggle: (name, enabled) => enabled ? classes.add(name) : classes.delete(name),
      } };
    });
    rows.set(id, copies);
    return session;
  };
  return { state: context, add, rows, listeners, events };
}

test('marking a working session unread preserves its activity and both spinners', () => {
  const { state, add, rows, listeners } = harness();
  const session = add('working');
  listeners.busy('working', true);
  state.markUnread('working');
  assert.equal(state.sessionBusyState.get('working'), true);
  assert.equal(state.responseReadySessions.has('working'), true);
  assert.equal(state.sessionActivity(session), 'running');
  for (const row of rows.get('working')) {
    assert.equal(row.classList.contains('cli-busy'), true);
    assert.equal(row.classList.contains('response-ready'), true);
  }
  listeners.busy('working', true);
  assert.equal(state.responseReadySessions.has('working'), true, 'duplicate activity preserves the reminder');
});

test('marking a busy session read clears only the reminder', () => {
  const { state, add, listeners, rows } = harness();
  const session = add('working');
  listeners.busy('working', true);
  state.markUnread('working');
  state.clearUnread('working');
  assert.equal(state.sessionActivity(session), 'running');
  for (const row of rows.get('working')) {
    assert.equal(row.classList.contains('response-ready'), false);
    assert.equal(row.classList.contains('cli-busy'), true);
  }
});

test('a manually unread session becomes ready on completion and clears unread on a new turn', () => {
  const { state, add, listeners, rows, events } = harness();
  const session = add('working');
  listeners.busy('working', true);
  state.markUnread('working');
  listeners.busy('working', false);
  assert.equal(state.sessionBusyState.get('working'), false);
  assert.equal(state.sessionActivity(session), 'ready');
  assert.deepEqual(events, ['working']);
  for (const row of rows.get('working')) assert.equal(row.classList.contains('cli-busy'), false);
  listeners.busy('working', false);
  assert.deepEqual(events, ['working'], 'repeated idle signals do not move the session again');
  listeners.busy('working', true);
  assert.equal(state.sessionActivity(session), 'running');
  assert.equal(state.responseReadySessions.has('working'), false);
});

test('completion notifications still end busy activity, including an already unread session', () => {
  for (const unread of [false, true]) {
    const { state, add, listeners } = harness();
    const session = add('working');
    listeners.busy('working', true);
    if (unread) state.markUnread('working');
    listeners.notice('working', 'Finished', 'idle');
    assert.equal(state.sessionBusyState.get('working'), false);
    assert.equal(state.sessionActivity(session), 'ready');
  }
});

test('quick completion without a busy frame is unread only when unfocused', () => {
  for (const focused of [false, true]) {
    const { state, add, listeners } = harness();
    const session = add('quick');
    if (focused) state.activeSessionId = 'quick';
    listeners.notice('quick', 'Finished', 'idle');
    assert.equal(state.sessionActivity(session), focused ? 'idle' : 'ready');
  }
});

test('a terminal working alongside an unread session rolls up as running in either order', () => {
  const { state, add, listeners } = harness();
  const terminal = add('terminal', 'terminal');
  const unread = add('unread');
  state.markUnread('unread');
  listeners.busy('terminal', true);
  assert.equal(state.groupState([terminal, unread]), 'running');
  assert.equal(state.groupState([unread, terminal]), 'running');
  listeners.busy('terminal', false);
  assert.equal(state.groupState([terminal, unread]), 'ready');
});

test('needs-you takes priority over working and unread on sessions and projects', () => {
  const { state, add, listeners } = harness();
  const session = add('working');
  const other = add('other');
  listeners.busy('working', true);
  state.markUnread('working');
  listeners.notice('working', 'Permission requested', 'attention');
  assert.equal(state.sessionActivity(session), 'attention');
  listeners.busy('other', true);
  assert.equal(state.groupState([other, session]), 'attention');
});

test('pending terminals roll up as running before the PTY poll, exited ones do not', () => {
  const { state, add, listeners } = harness();
  const terminal = add('terminal', 'terminal');
  state.activePtyIds.clear();
  state.pendingSessions.set('terminal', { exited: false });
  listeners.busy('terminal', true);
  assert.equal(state.groupState([terminal]), 'running');
  state.pendingSessions.get('terminal').exited = true;
  assert.equal(state.groupState([terminal]), '');
});
