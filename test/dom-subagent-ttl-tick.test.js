// see .ai/contexts/subagent-observability.md

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');

function evalInWindow(dom, file) {
  vm.runInContext(fs.readFileSync(file, 'utf8'), dom.getInternalVMContext(), { filename: file });
}

function setupCombinedDom() {
  const dom = new JSDOM(
    '<!DOCTYPE html><html><body><div id="sidebar-content"></div><div id="stats-content"></div>' +
    '<div id="memory-content"></div><div id="placeholder"></div><div id="terminals"></div></body></html>',
    { url: 'http://localhost/', runScripts: 'outside-only', pretendToBeVisual: true }
  );
  const { window } = dom;

  const spawnedCbs = [];
  const completedCbs = [];
  const apiTarget = {
    platform: 'linux',
    onSubagentSpawned: (cb) => { spawnedCbs.push(cb); },
    onSubagentCompleted: (cb) => { completedCbs.push(cb); },
  };
  window.api = new Proxy(apiTarget, {
    get(target, prop) {
      if (prop in target) return target[prop];
      return () => Promise.resolve({ ok: true });
    },
  });

  const stubGlobals = {
    openSessions: new Map(),
    activeSessionId: null,
    sessionMap: new Map(),
    activePtyIds: new Set(),
    sortedOrder: [],
    cachedProjects: [],
    confirmAndStopSession: () => {},
    showSession: () => {},
    sidebarContent: window.document.getElementById('sidebar-content'),
    terminalsEl: window.document.getElementById('terminals'),
    gridViewActive: false,
    isMac: false,
    replayHiddenBuffer: () => {},
    updateRunningIndicators: () => {},
    fitAndScroll: () => {},
    statsContent: window.document.getElementById('stats-content'),
    memoryContent: window.document.getElementById('memory-content'),
    pendingSessions: new Map(),
    lastActivityTime: new Map(),
    searchMatchIds: null,
    searchMatchProjectPaths: null,
    showStarredOnly: false,
    showRunningOnly: false,
    showTodayOnly: false,
    visibleSessionCount: 10,
    sessionMaxAgeDays: 3650,
    attentionSessions: new Set(),
    responseReadySessions: new Set(),
    sessionBusyState: new Map(),
    cachedAllProjects: [],
    pollActiveSessions: () => {},
    showNewSessionPopover: () => {},
    openSettingsViewer: () => {},
    showResumeSessionDialog: () => {},
    showJsonlViewer: () => {},
    forkSession: () => {},
    openSession: () => {},
    loadProjects: () => {},
    launchScheduleCreator: () => {},
    getExpandedSlugs: () => new Set(),
    saveExpandedSlugs: () => {},
  };
  for (const [k, v] of Object.entries(stubGlobals)) {
    Object.defineProperty(window, k, { value: v, writable: true, configurable: true });
  }

  const MORPHDOM_PATH = path.join(__dirname, '..', 'node_modules', 'morphdom', 'dist', 'morphdom-umd.js');
  vm.runInContext(fs.readFileSync(MORPHDOM_PATH, 'utf8'), dom.getInternalVMContext(), { filename: 'morphdom-umd.js' });
  for (const file of ['utils.js', 'icons.js', 'shortcuts.js', 'subagent-timing.js', 'grid-view.js', 'sidebar.js']) {
    evalInWindow(dom, path.join(PUBLIC_DIR, file));
  }

  // Capture scheduled timers instead of letting them run on the wall clock:
  // the tick is driven by its own condition, never by waiting.
  const scheduled = [];
  window.setTimeout = (fn, delay) => { scheduled.push({ fn, delay }); return scheduled.length; };
  window.clearTimeout = () => {};

  // Fully replace Date.now() so production's own real-clock reads (sidebar.js
  // map.set(agentId, Date.now()), scheduleSubagentTtlTick's Date.now()) can
  // never observe wall-clock jitter between statements. See
  // .ai/contexts/subagent-observability.md.
  let fakeNow = Date.parse('2026-05-22T10:00:00.000Z');
  window.Date.now = () => fakeNow;

  return {
    window,
    document: window.document,
    scheduled,
    now() { return fakeNow; },
    setNow(ms) { fakeNow = ms; },
    advanceTime(ms) { fakeNow += ms; },
    runScheduled() {
      const pending = scheduled.splice(0, scheduled.length);
      for (const { fn } of pending) fn();
    },
    emitSubagentSpawned(payload) { for (const cb of spawnedCbs) cb(payload); },
    destroy() { window.close(); },
  };
}

const PARENT = 'parent-1';
const AGENT = 'agent-1';
const AGENT2 = 'agent-2';
const TTL_MS = 60000;
// sidebar.js/grid-view.js compute delay as `oldest + TTL_MS + 1 - now()`: the
// +1 keeps the re-arm strictly after the deadline (see the boundary test).
const ARM_GRACE_MS = 1;

/**
 * Every armed timer must be due at the entry's deadline, not on a poll.
 * The clock is fully injected (setupCombinedDom), so `delay` is deterministic
 * integer arithmetic, not a wall-clock sample — callers pass the exact
 * expected value, with no slack for OS scheduling jitter.
 */
function assertArmedAt(ctx, expected, what) {
  assert.ok(ctx.scheduled.length > 0, `expected an armed timer (${what})`);
  for (const { delay } of ctx.scheduled) {
    assert.ok(Number.isFinite(delay) && delay >= 1,
      `${what}: a tick must never be armed at ${delay} — a non-positive delay spins on setTimeout(0)`);
    assert.equal(delay, expected,
      `${what}: expected a wakeup exactly ${expected}ms away (the entry's deadline), got ${delay}ms`);
  }
}

function sampleProject() {
  return {
    projectPath: '/home/dev/proj',
    sessions: [
      {
        sessionId: PARENT,
        name: 'parent session',
        summary: 'parent session',
        modified: '2026-05-22T10:00:00.000Z',
        archived: 0,
      },
      {
        sessionId: 'sub:' + PARENT + ':' + AGENT,
        parentSessionId: PARENT,
        agentId: AGENT,
        subagentType: 'explore',
        description: 'explore subagent',
        modified: '2026-05-22T10:00:00.000Z',
      },
    ],
  };
}

test('sidebar: a stale subagent is evicted by the TTL tick with no render in between', () => {
  const ctx = setupCombinedDom();
  try {
    ctx.window.renderProjects([sampleProject()], true);
    ctx.emitSubagentSpawned({ parentSessionId: PARENT, agentId: AGENT, subagentType: 'explore' });

    const row = ctx.document.getElementById('si-sub:' + PARENT + ':' + AGENT);
    assert.ok(row, 'the subagent row must be in the DOM');
    assert.ok(row.classList.contains('running'), 'the spawn lights the row');
    assert.equal(ctx.scheduled.length, 2, 'each view arms its own TTL timer on the spawn');
    assertArmedAt(ctx, TTL_MS + ARM_GRACE_MS, 'fresh spawn');

    // The subagent goes silent: no completion event, no heartbeat, and — the
    // point of the test — no render to piggyback the prune on.
    ctx.advanceTime(61000);
    ctx.runScheduled();

    assert.equal(row.classList.contains('running'), false,
      'the TTL tick must clear the row without waiting for a render');
    const caret = ctx.document.getElementById('sub-caret-' + PARENT);
    assert.equal(caret.classList.contains('has-running-child'), false,
      'the caret badge must follow');
    assert.equal(ctx.document.getElementById('si-' + PARENT).classList.contains('has-busy-agents'), false,
      'the parent indicator must follow');
  } finally {
    ctx.destroy();
  }
});

test('grid: a stale subagent pill is removed by the TTL tick with no card rebuild', () => {
  const ctx = setupCombinedDom();
  try {
    const element = ctx.document.createElement('div');
    ctx.window.openSessions.set(PARENT, { closed: false, element, terminal: { focus: () => {} } });
    ctx.window.sessionMap.set(PARENT, {
      sessionId: PARENT, name: 'parent session', projectPath: '/home/dev/proj',
      modified: '2026-05-22T10:00:00.000Z',
    });
    ctx.window.wrapInGridCard(PARENT);
    ctx.emitSubagentSpawned({ parentSessionId: PARENT, agentId: AGENT, subagentType: 'explore' });

    const card = ctx.document.querySelector('.grid-card[data-session-id="' + PARENT + '"]');
    assert.equal(card.querySelectorAll('.grid-subagent-pill').length, 1, 'the pill renders on spawn');
    assert.equal(ctx.scheduled.length, 2, 'each view arms its own TTL timer on the spawn');
    assertArmedAt(ctx, TTL_MS + ARM_GRACE_MS, 'fresh spawn');

    ctx.advanceTime(61000);
    ctx.runScheduled();

    assert.equal(card.querySelectorAll('.grid-subagent-pill').length, 0,
      'the TTL tick must clear the pill without waiting for wrapInGridCard');
  } finally {
    ctx.destroy();
  }
});

test('the TTL tick re-arms while an agent is live and stops once the map is empty', () => {
  const ctx = setupCombinedDom();
  try {
    ctx.window.renderProjects([sampleProject()], true);
    ctx.emitSubagentSpawned({ parentSessionId: PARENT, agentId: AGENT, subagentType: 'explore' });
    assert.equal(ctx.scheduled.length, 2);
    assertArmedAt(ctx, TTL_MS + ARM_GRACE_MS, 'fresh spawn');

    // Fires while the agent is still within its TTL: nothing to prune, but the
    // timer must re-arm so the eviction still happens later.
    ctx.runScheduled();
    const row = ctx.document.getElementById('si-sub:' + PARENT + ':' + AGENT);
    assert.ok(row.classList.contains('running'), 'a fresh agent must survive the tick');
    assert.equal(ctx.scheduled.length, 2, 'the tick must re-arm while an agent is tracked');
    assertArmedAt(ctx, TTL_MS + ARM_GRACE_MS, 're-arm for an agent still inside its TTL');

    ctx.advanceTime(61000);
    ctx.runScheduled();
    assert.equal(row.classList.contains('running'), false);
    assert.equal(ctx.scheduled.length, 0, 'an empty map must leave no timer running');
  } finally {
    ctx.destroy();
  }
});

test('two agents share one timer per view, re-armed at the survivor\'s own deadline', () => {
  // Covers the `if (subagentTtlTimer) return;` guard — a second spawn must not
  // arm a second timer — and proves the re-arm is deadline-driven: after the
  // older agent is pruned the next wakeup is the *younger* one's remaining TTL,
  // not a fixed interval.
  const ctx = setupCombinedDom();
  try {
    ctx.window.renderProjects([sampleProject()], true);
    const t0 = ctx.now();

    ctx.emitSubagentSpawned({ parentSessionId: PARENT, agentId: AGENT, subagentType: 'explore' });
    assert.equal(ctx.scheduled.length, 2, 'one timer per view');

    ctx.setNow(t0 + 30000);
    ctx.emitSubagentSpawned({ parentSessionId: PARENT, agentId: AGENT2, subagentType: 'plan' });
    assert.equal(ctx.scheduled.length, 2, 'a second agent must not arm a second timer per view');
    assertArmedAt(ctx, TTL_MS + ARM_GRACE_MS, 'still armed on the older agent');

    // The older agent's deadline: it is pruned, the younger one survives.
    ctx.setNow(t0 + TTL_MS + 1000);
    ctx.runScheduled();

    assert.equal(ctx.document.getElementById('si-sub:' + PARENT + ':' + AGENT).classList.contains('running'),
      false, 'the older agent is evicted');
    assertArmedAt(ctx, 30000 - 1000 + ARM_GRACE_MS, "re-armed at the survivor's remaining TTL");
  } finally {
    ctx.destroy();
  }
});

test('a tick that fires exactly on the deadline still makes progress', () => {
  // The prune uses a strict `<`, so an entry sitting exactly on the cutoff
  // survives. The re-arm must still be at least 1ms away: a 0ms delay would
  // re-fire against an unchanged clock and spin.
  const ctx = setupCombinedDom();
  try {
    ctx.window.renderProjects([sampleProject()], true);
    const t0 = ctx.now();
    ctx.emitSubagentSpawned({ parentSessionId: PARENT, agentId: AGENT, subagentType: 'explore' });

    ctx.setNow(t0 + TTL_MS); // exactly on the cutoff
    ctx.runScheduled();

    assert.ok(ctx.document.getElementById('si-sub:' + PARENT + ':' + AGENT).classList.contains('running'),
      'an entry exactly on the cutoff is not stale yet');
    assertArmedAt(ctx, ARM_GRACE_MS, 'boundary re-arm');
  } finally {
    ctx.destroy();
  }
});
