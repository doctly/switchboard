// Tests for the subagent transcript routing and transcript view.
//
// Routing design: sidebar.js discriminates on session.parentSessionId
// at click-handler time (not in the IPC layer) so the UI can branch
// without an extra round-trip. These tests verify:
//
//   1. Clicking a subagent sidebar item calls showSubagentTranscript
//      (never openSession).
//   2. Clicking a top-level session item calls openSession
//      (never showSubagentTranscript).
//   3. showSubagentTranscript renders the escape-hatch banner + message
//      entries from the JSONL payload.
//   4. showSubagentTranscript shows an error notice when the IPC call fails.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const MORPHDOM_PATH = path.join(__dirname, '..', 'node_modules', 'morphdom', 'dist', 'morphdom-umd.js');

// Minimal HTML that sidebar.js and jsonl-viewer.js expect.
const INDEX_HTML = `<!DOCTYPE html>
<html>
  <body>
    <div id="sidebar-content"></div>
    <div id="plans-content"></div>
    <div id="stats-content"></div>
    <div id="memory-content"></div>
    <div id="placeholder"></div>
    <div id="terminals"></div>
    <div id="terminal-area"></div>
    <div id="jsonl-viewer" style="display:none;">
      <div id="jsonl-viewer-header">
        <span id="jsonl-viewer-title"></span>
        <span id="jsonl-viewer-session-id"></span>
      </div>
      <div id="jsonl-viewer-body"></div>
    </div>
  </body>
</html>`;

// Sample JSONL entries: one user turn, one assistant turn.
const SAMPLE_ENTRIES = [
  { type: 'user', message: { content: 'hello from user' }, isSidechain: true },
  { type: 'assistant', message: { content: [{ type: 'text', text: 'hello from assistant' }] } },
];

function evalInWindow(dom, file) {
  const src = fs.readFileSync(file, 'utf8');
  vm.runInContext(src, dom.getInternalVMContext(), { filename: file });
}

function setupDom({ readSubagentJsonlResult = { entries: SAMPLE_ENTRIES }, readSubagentJsonlError = null, installSpies = true } = {}) {
  const dom = new JSDOM(INDEX_HTML, {
    url: 'http://localhost/',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  const { window } = dom;

  // Preload bridge stub (must be set before JS files are eval'd)
  window.api = {
    readSubagentJsonl: (_parentId, _agentId) => {
      if (readSubagentJsonlError) return Promise.resolve({ error: readSubagentJsonlError });
      return Promise.resolve(readSubagentJsonlResult);
    },
    readSessionJsonl: () => Promise.resolve({ entries: [] }),
    listSubagents: () => Promise.resolve([]),
    startSubagentWatch: () => Promise.resolve({}),
    stopSubagentWatch: () => Promise.resolve(),
    onSubagentSpawned: () => {},
    onSubagentCompleted: () => {},
    onSubagentWatchEvent: () => {},
  };

  const doc = window.document;

  // DOM element and state stubs (set before sidebar.js is eval'd so it can
  // find them as globals; these don't clash with function names)
  const stubValues = {
    sidebarContent: doc.getElementById('sidebar-content'),
    plansContent: doc.getElementById('plans-content'),
    statsContent: doc.getElementById('stats-content'),
    memoryContent: doc.getElementById('memory-content'),
    placeholder: doc.getElementById('placeholder'),
    terminalArea: doc.getElementById('terminal-area'),
    jsonlViewer: doc.getElementById('jsonl-viewer'),
    jsonlViewerTitle: doc.getElementById('jsonl-viewer-title'),
    jsonlViewerSessionId: doc.getElementById('jsonl-viewer-session-id'),
    jsonlViewerBody: doc.getElementById('jsonl-viewer-body'),

    // Viewer references (hideAllViewers touches these)
    planViewer: doc.createElement('div'),
    statsViewer: doc.createElement('div'),
    memoryViewer: doc.createElement('div'),
    settingsViewer: doc.createElement('div'),

    // State
    openSessions: new Map(),
    activeSessionId: null,
    activePtyIds: new Set(),
    pendingSessions: new Map(),
    sessionMap: new Map(),
    lastActivityTime: new Map(),
    sortedOrder: [],
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
    cachedProjects: [],
    cachedAllProjects: [],

    // No-op function stubs (sidebar.js wires these in rebindSidebarEvents;
    // the real spies for openSession / showSubagentTranscript are installed
    // AFTER eval'ing sidebar.js + jsonl-viewer.js so the JS files don't
    // overwrite them)
    confirmAndStopSession: () => {},
    pollActiveSessions: () => {},
    showNewSessionPopover: () => {},
    openSettingsViewer: () => {},
    showResumeSessionDialog: () => {},
    showJsonlViewer: () => {},
    forkSession: () => {},
    loadProjects: () => {},
    launchScheduleCreator: () => {},
    setActiveSession: () => {},
    // hideAllViewers is defined in plans-memory-view.js in the real app; stub it here.
    hideAllViewers: () => {},
    // openSession is stubbed after eval; we pre-stub it so it's present during eval
    openSession: () => {},
  };

  for (const [k, v] of Object.entries(stubValues)) {
    Object.defineProperty(window, k, { value: v, writable: true, configurable: true });
  }

  const morphdomSrc = fs.readFileSync(MORPHDOM_PATH, 'utf8');
  vm.runInContext(morphdomSrc, dom.getInternalVMContext(), { filename: 'morphdom-umd.js' });

  evalInWindow(dom, path.join(PUBLIC_DIR, 'utils.js'));
  evalInWindow(dom, path.join(PUBLIC_DIR, 'icons.js'));
  evalInWindow(dom, path.join(PUBLIC_DIR, 'sidebar.js'));
  // jsonl-viewer.js defines showSubagentTranscript — eval'd here so the real
  // implementation is available when tests exercise it directly. For routing
  // tests (tests 1-2) we install spies AFTER this eval to override.
  evalInWindow(dom, path.join(PUBLIC_DIR, 'jsonl-viewer.js'));

  // Spy captures — installed after JS eval so they override any function
  // declarations that landed on window during the eval phase.
  // sidebar.js resolves these as free vars from the window context at
  // call time, so overriding here is safe.
  //
  // NOTE: installSpies=true overrides showSubagentTranscript with a spy,
  // which is what the routing tests need. Set installSpies=false when the
  // test needs to call the real showSubagentTranscript renderer.
  const calls = {
    openSession: [],
    showSubagentTranscript: [],
  };
  window.openSession = (session) => calls.openSession.push(session);
  if (installSpies) {
    window.showSubagentTranscript = (session) => calls.showSubagentTranscript.push(session);
  }

  return { window, document: doc, calls, dom };
}

// Build a minimal project fixture for renderProjects.
function makeProject() {
  const t = new Date().toISOString();
  return {
    projectPath: '/home/dev/proj',
    sessions: [
      {
        sessionId: 'top-1',
        summary: 'top level session',
        modified: t,
        starred: false,
        archived: 0,
        messageCount: 2,
        subagentType: null,
        parentSessionId: null,
        agentId: null,
      },
      {
        sessionId: 'sub:top-1:agent-abc',
        summary: 'subagent task',
        modified: t,
        starred: false,
        archived: 0,
        messageCount: 5,
        subagentType: 'implement',
        parentSessionId: 'top-1',
        agentId: 'agent-abc',
      },
    ],
  };
}

test('sidebar: clicking a top-level session calls openSession, not showSubagentTranscript', () => {
  const { window, document, calls } = setupDom();
  try {
    const project = makeProject();
    // Pre-populate sessionMap so rebindSidebarEvents can look up sessions by id.
    for (const s of project.sessions) window.sessionMap.set(s.sessionId, s);
    window.renderProjects([project], true);

    const topItem = document.querySelector('[data-session-id="top-1"]');
    assert.ok(topItem, 'top-1 session item must be rendered');
    assert.ok(!topItem.dataset.subagent, 'top-level item must not have data-subagent');

    topItem.click();

    assert.equal(calls.openSession.length, 1, 'openSession must be called once');
    assert.equal(calls.openSession[0].sessionId, 'top-1');
    assert.equal(calls.showSubagentTranscript.length, 0, 'showSubagentTranscript must NOT be called for top-level session');
  } finally {
    window.close();
  }
});

test('sidebar: clicking a subagent item calls showSubagentTranscript, not openSession', () => {
  const { window, document, calls } = setupDom();
  try {
    const project = makeProject();
    // Pre-populate sessionMap so rebindSidebarEvents can look up sessions by id.
    for (const s of project.sessions) window.sessionMap.set(s.sessionId, s);
    window.renderProjects([project], true);

    // Expand the subagent caret so child items are in DOM
    const caret = document.getElementById('sub-caret-top-1');
    assert.ok(caret, 'subagent caret for top-1 must exist');
    caret.click();

    const subItem = document.querySelector('[data-session-id="sub:top-1:agent-abc"]');
    assert.ok(subItem, 'subagent item must be in DOM after caret expand');
    assert.equal(subItem.dataset.subagent, '1', 'subagent item must have data-subagent=1');

    subItem.click();

    assert.equal(calls.showSubagentTranscript.length, 1, 'showSubagentTranscript must be called once');
    assert.equal(calls.showSubagentTranscript[0].sessionId, 'sub:top-1:agent-abc');
    assert.equal(calls.openSession.length, 0, 'openSession must NOT be called for subagent item');
  } finally {
    window.close();
  }
});

test('showSubagentTranscript: renders escape banner and message entries', async () => {
  const { window, document } = setupDom({
    readSubagentJsonlResult: { entries: SAMPLE_ENTRIES },
    installSpies: false,
  });
  try {
    const session = {
      sessionId: 'sub:top-1:agent-abc',
      parentSessionId: 'top-1',
      agentId: 'agent-abc',
      subagentType: 'implement',
      description: 'do the work',
    };

    await window.showSubagentTranscript(session);

    // Escape hatch banner must be present
    const banner = document.querySelector('.jsonl-subagent-escape-banner');
    assert.ok(banner, 'escape banner must be rendered');

    const resumeBtn = banner.querySelector('.jsonl-subagent-resume-btn');
    assert.ok(resumeBtn, 'resume button must be present in banner');
    assert.match(resumeBtn.textContent, /Resume in terminal/);

    // Title must reflect subagent type + description
    const title = document.getElementById('jsonl-viewer-title');
    assert.match(title.textContent, /implement/i);
    assert.match(title.textContent, /do the work/);

    // At least one user entry and one assistant entry
    const userEntries = document.querySelectorAll('.jsonl-user');
    const assistantEntries = document.querySelectorAll('.jsonl-assistant');
    assert.ok(userEntries.length >= 1, 'at least one user entry must render');
    assert.ok(assistantEntries.length >= 1, 'at least one assistant entry must render');
  } finally {
    window.close();
  }
});

test('showSubagentTranscript: shows error when IPC call fails', async () => {
  const { window, document } = setupDom({
    readSubagentJsonlError: 'Subagent session not found in cache',
    installSpies: false,
  });
  try {
    const session = {
      sessionId: 'sub:top-1:agent-missing',
      parentSessionId: 'top-1',
      agentId: 'agent-missing',
      subagentType: 'explore',
      description: 'gone',
    };

    await window.showSubagentTranscript(session);

    const body = document.getElementById('jsonl-viewer-body');
    assert.match(body.textContent, /Error loading transcript/);
    assert.match(body.textContent, /Subagent session not found/);
  } finally {
    window.close();
  }
});
