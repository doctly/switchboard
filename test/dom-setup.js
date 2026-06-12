// Shared jsdom bootstrap for renderer tests.
//
// public/*.js loads as classic <script> tags in Electron. To exercise it
// from node:test we set up a jsdom Window, then evaluate the renderer
// source inside that window's VM context. This mirrors what the browser
// does: every top-level `function`/`const`/`let` lands on the window.
//
// The helper hands back a `ctx` with:
//   - window / document — the jsdom window
//   - sidebar — the public/sidebar.js module evaluated in window's context
//   - destroy() — tear down jsdom and prevent global leaks between tests
//
// Cross-test isolation: each call to setupSidebarDom() returns a fresh
// window. Nothing is shared on the host's global object.

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const MORPHDOM_PATH = path.join(__dirname, '..', 'node_modules', 'morphdom', 'dist', 'morphdom-umd.js');

// Minimal DOM stub that index.html sets up. sidebar.js looks up several
// of these by id via document.getElementById — we just need them present.
const INDEX_HTML = `<!DOCTYPE html>
<html>
  <body>
    <div id="sidebar-content"></div>
    <div id="plans-content"></div>
    <div id="stats-content"></div>
    <div id="memory-content"></div>
    <div id="placeholder"></div>
    <div id="terminals"></div>
  </body>
</html>`;

function setupSidebarDom() {
  const dom = new JSDOM(INDEX_HTML, {
    url: 'http://localhost/',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  const { window } = dom;

  // Stub Electron preload bridge — every IPC call resolves to a sensible
  // default so user-event handlers don't throw when invoked.
  window.api = new Proxy({}, {
    get(_t, _prop) {
      return () => Promise.resolve({ ok: true });
    },
  });

  // Stubs for cross-file renderer globals consumed by sidebar.js.
  // We intentionally use writable globals where sidebar.js mutates them.
  const stubGlobals = {
    // DOM handles normally set up by app.js
    sidebarContent: window.document.getElementById('sidebar-content'),
    plansContent: window.document.getElementById('plans-content'),
    statsContent: window.document.getElementById('stats-content'),
    memoryContent: window.document.getElementById('memory-content'),

    // State maps / sets used by sidebar.js — defaults are empty.
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
    sessionMaxAgeDays: 3650, // generous so fixtures aren't filtered out by age
    attentionSessions: new Set(),
    responseReadySessions: new Set(),
    sessionBusyState: new Map(),
    cachedProjects: [],
    cachedAllProjects: [],

    // Functions normally defined in other renderer files. Tests don't
    // exercise these click paths but rebindSidebarEvents wires the
    // handlers, so they must at least exist.
    showSession: () => {},
    confirmAndStopSession: () => {},
    pollActiveSessions: () => {},
    showNewSessionPopover: () => {},
    openSettingsViewer: () => {},
    showResumeSessionDialog: () => {},
    showJsonlViewer: () => {},
    forkSession: () => {},
    openSession: () => {},
    loadProjects: () => {},
    launchScheduleCreator: () => {},
  };

  for (const [k, v] of Object.entries(stubGlobals)) {
    Object.defineProperty(window, k, { value: v, writable: true, configurable: true });
  }

  // morphdom: load the UMD build into the window so sidebar.js sees `morphdom` global.
  const morphdomSrc = fs.readFileSync(MORPHDOM_PATH, 'utf8');
  vm.runInContext(morphdomSrc, dom.getInternalVMContext(), { filename: 'morphdom-umd.js' });

  // Real utils.js and icons.js — small and dependency-free.
  evalInWindow(dom, path.join(PUBLIC_DIR, 'utils.js'));
  evalInWindow(dom, path.join(PUBLIC_DIR, 'icons.js'));

  // Finally, sidebar.js.
  evalInWindow(dom, path.join(PUBLIC_DIR, 'sidebar.js'));

  return {
    window,
    document: window.document,
    sidebar: {
      renderProjects: window.renderProjects,
      buildSessionItem: window.buildSessionItem,
      buildSubagentItem: window.buildSubagentItem,
      folderId: window.folderId,
    },
    destroy() {
      window.close();
    },
  };
}

function evalInWindow(dom, file) {
  const src = fs.readFileSync(file, 'utf8');
  vm.runInContext(src, dom.getInternalVMContext(), { filename: file });
}

// Build a deterministic sample project fixture.
function makeSampleProject(overrides = {}) {
  const projectPath = overrides.projectPath || '/home/dev/myproj';
  const baseTime = Date.parse('2026-05-22T10:00:00Z');
  const t = (offset) => new Date(baseTime + offset).toISOString();

  // 2 top-level sessions, 3 subagents (one orphan — parent missing),
  // 1 starred, 1 archived.
  const sessions = [
    {
      sessionId: 's-top-1',
      name: 'main session',
      summary: 'top level 1',
      modified: t(0),
      starred: true,
      archived: 0,
      messageCount: 12,
    },
    {
      sessionId: 's-top-2',
      name: 'second session',
      summary: 'top level 2',
      modified: t(-1000),
      starred: false,
      archived: 1, // archived
      messageCount: 4,
    },
    {
      sessionId: 's-sub-1',
      parentSessionId: 's-top-1',
      subagentType: 'explore',
      description: 'explore subagent',
      modified: t(-2000),
      messageCount: 3,
    },
    {
      sessionId: 's-sub-2',
      parentSessionId: 's-top-1',
      subagentType: 'plan',
      description: 'plan subagent',
      modified: t(-3000),
      messageCount: 5,
    },
    {
      sessionId: 's-sub-orphan',
      parentSessionId: 's-missing-parent',
      subagentType: 'review',
      description: 'orphan subagent',
      modified: t(-4000),
      messageCount: 2,
    },
  ];

  return {
    projectPath,
    sessions,
    ...overrides,
  };
}

module.exports = { setupSidebarDom, makeSampleProject };
