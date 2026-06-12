// Regression coverage for the two sidebar.js render-loop bugs we just
// shipped:
//
//   1. `subagentIndex` was used in renderProjects() but not destructured
//      from processProjectSessions()'s return — empty sidebar, hard error.
//   2. `buildSessionsList(fId, visible, older, subagentIndex)` referenced
//      `project.projectPath` for the orphan-toggle localStorage key, but
//      `project` was out of scope — same blank sidebar.
//
// Both are "undefined identifier" bugs that the new ESLint config flags
// statically. These tests are the runtime backstop: load sidebar.js into
// jsdom, render a real project, and assert the resulting DOM matches
// expectations. If either bug recurs, renderProjects() will throw before
// any .session-item lands in #sidebar-content.

const test = require('node:test');
const assert = require('node:assert/strict');

const { setupSidebarDom, makeSampleProject } = require('./dom-setup');

test('renderProjects: structural completeness — no uncaught error, sessions land in sidebar', () => {
  const ctx = setupSidebarDom();
  try {
    const project = makeSampleProject();
    // Both showArchived=false default — but archived sessions are still in
    // project.sessions and end up in `older`/orphans; renderProjects must
    // not throw regardless.
    assert.doesNotThrow(() => ctx.sidebar.renderProjects([project], true),
      'renderProjects() must not throw — regression for subagentIndex / projectPath');

    const items = ctx.document.querySelectorAll('#sidebar-content .session-item');
    assert.ok(items.length > 0, 'at least one .session-item must render');

    // Top-level session 's-top-1' is rendered with id `si-s-top-1`.
    const top1 = ctx.document.getElementById('si-s-top-1');
    assert.ok(top1, 'top-level session item must be present');
    assert.equal(top1.dataset.sessionId, 's-top-1');
  } finally {
    ctx.destroy();
  }
});

test('renderProjects: starred + archived sessions both rendered, dataset.sessionId set', () => {
  const ctx = setupSidebarDom();
  try {
    ctx.sidebar.renderProjects([makeSampleProject()], true);

    const starred = ctx.document.querySelector('[data-session-id="s-top-1"] .session-pin.pinned');
    assert.ok(starred, 'starred session must have .session-pin.pinned');

    const archived = ctx.document.querySelector('[data-session-id="s-top-2"]');
    assert.ok(archived, 'archived session is still rendered (filtered by showArchived flag elsewhere)');
    assert.ok(archived.classList.contains('archived-item'), 'archived session has .archived-item class');
  } finally {
    ctx.destroy();
  }
});

test('renderProjects: subagent child carets appear under parents', () => {
  const ctx = setupSidebarDom();
  try {
    ctx.sidebar.renderProjects([makeSampleProject()], true);

    // s-top-1 has 2 subagents (s-sub-1, s-sub-2). appendSubagentChildren
    // adds a caret element with id `sub-caret-s-top-1`.
    const caret = ctx.document.getElementById('sub-caret-s-top-1');
    assert.ok(caret, 'subagent caret for s-top-1 must exist');
    assert.match(caret.textContent, /2 subagents/);
  } finally {
    ctx.destroy();
  }
});

test('renderProjects: orphan subagents (no matching parent) trigger orphan group', () => {
  const ctx = setupSidebarDom();
  try {
    ctx.sidebar.renderProjects([makeSampleProject()], true);

    // s-sub-orphan's parent is s-missing-parent → falls in the orphan
    // group. This is exactly the codepath that broke in bug #2 (it reads
    // project.projectPath for the localStorage key).
    const orphanGroup = ctx.document.querySelector('.sidebar-orphan-subagents');
    assert.ok(orphanGroup, 'orphan subagents group must be present when orphans exist');

    const orphanLabel = orphanGroup.querySelector('.sidebar-orphan-label');
    assert.ok(orphanLabel, 'orphan group has its label');
    assert.match(orphanLabel.textContent, /Orphan subagents/);
    const count = orphanGroup.querySelector('.orphan-count');
    assert.equal(count?.textContent, '1', 'one orphan subagent counted');
  } finally {
    ctx.destroy();
  }
});

test('renderProjects: orphan toggle uses projectPath in localStorage key (bug #2 regression)', () => {
  const ctx = setupSidebarDom();
  const projectPath = '/home/dev/myproj';
  try {
    ctx.sidebar.renderProjects([makeSampleProject({ projectPath })], true);

    const orphanLabel = ctx.document.querySelector('.sidebar-orphan-label');
    assert.ok(orphanLabel, 'orphan label present');

    // Clicking the label toggles the collapsed state and writes the key.
    // If `projectPath` were out of scope (bug #2), this would have thrown
    // during render — but we also verify the write here for completeness.
    orphanLabel.click();
    const key = `orphanExpanded:${projectPath}`;
    const value = ctx.window.localStorage.getItem(key);
    assert.ok(value === '0' || value === '1', 'orphanExpanded localStorage key must be set after toggle');
  } finally {
    ctx.destroy();
  }
});

test('renderProjects: empty project does not crash, sidebar stays empty', () => {
  const ctx = setupSidebarDom();
  try {
    const empty = { projectPath: '/tmp/empty', sessions: [] };
    assert.doesNotThrow(() => ctx.sidebar.renderProjects([empty], true));
    const items = ctx.document.querySelectorAll('#sidebar-content .session-item');
    assert.equal(items.length, 0);
  } finally {
    ctx.destroy();
  }
});

test('renderProjects: orphan group has stable id for morphdom reconciliation', () => {
  // Fix 3: orphanGroup.id = 'orphan-' + fId prevents morphdom from rebuilding
  // the element on every render (which caused minor flicker).
  const ctx = setupSidebarDom();
  const projectPath = '/home/dev/myproj';
  try {
    ctx.sidebar.renderProjects([makeSampleProject({ projectPath })], true);

    const orphanGroup = ctx.document.querySelector('.sidebar-orphan-subagents');
    assert.ok(orphanGroup, 'orphan group must exist');
    assert.ok(orphanGroup.id, 'orphan group must have an id for morphdom keying');
    assert.match(orphanGroup.id, /^orphan-/, 'id must start with orphan-');

    // Re-render should reuse the same DOM element (morphdom won't recreate it).
    const idBefore = orphanGroup.id;
    ctx.sidebar.renderProjects([makeSampleProject({ projectPath })], false);
    const orphanGroupAfter = ctx.document.querySelector('.sidebar-orphan-subagents');
    assert.equal(orphanGroupAfter.id, idBefore, 'orphan group id must be stable across re-renders');
  } finally {
    ctx.destroy();
  }
});

test('getExpandedSubagents: one-time GC prunes stale session ids from localStorage', () => {
  // Fix 4: on first call to getExpandedSubagents(), stale session ids (not in
  // sessionMap) are removed from the stored set. This prevents unbounded growth
  // of the key across long-lived instances.
  const ctx = setupSidebarDom();
  try {
    // Populate sessionMap with one known session.
    ctx.window.sessionMap.set('live-session', {});

    // Seed localStorage with two entries: one stale, one live.
    ctx.window.localStorage.setItem('expandedSubagents', JSON.stringify(['stale-id', 'live-session']));

    // Trigger GC by calling getExpandedSubagents (via a render).
    ctx.sidebar.renderProjects([makeSampleProject()], true);

    // After GC, stale-id must have been removed.
    const stored = JSON.parse(ctx.window.localStorage.getItem('expandedSubagents') || '[]');
    assert.ok(!stored.includes('stale-id'), 'stale-id must be pruned by GC');
    assert.ok(stored.includes('live-session'), 'live-session must survive GC');
  } finally {
    ctx.destroy();
  }
});

test('renderProjects: result destructure is complete — re-render works (no stale closures)', () => {
  // This test would have caught bug #1 directly: if renderProjects's
  // destructure of processProjectSessions() result is incomplete and the
  // missing var is then used downstream, the first call would throw
  // ReferenceError. We render twice and check both yield a populated
  // sidebar.
  const ctx = setupSidebarDom();
  try {
    const project = makeSampleProject();
    ctx.sidebar.renderProjects([project], true);
    const first = ctx.document.querySelectorAll('#sidebar-content .session-item').length;
    ctx.sidebar.renderProjects([project], false); // re-render preserving order
    const second = ctx.document.querySelectorAll('#sidebar-content .session-item').length;
    assert.ok(first > 0 && second > 0, 'both renders must populate the sidebar');
    assert.equal(first, second, 'item count stable across re-renders');
  } finally {
    ctx.destroy();
  }
});
