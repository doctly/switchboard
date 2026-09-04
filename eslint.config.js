// ESLint flat config for Switchboard (ESLint 9.x).
//
// Goals:
//   1. Catch dumb "undefined variable" mistakes in renderer code
//      (no-undef). Two recent regressions in public/sidebar.js
//      (subagentIndex undefined; project.projectPath out of scope)
//      would have been caught instantly by this rule.
//   2. Warn about unused vars without blocking the build.
//   3. Keep the existing 24+ node:test suite green.
//
// The renderer (public/*.js) loads as a set of classic <script> tags
// in index.html: every top-level `function`, `const`, `let` becomes a
// global accessible to sibling files. ESLint treats each file in
// isolation, so we declare the cross-file globals (defined in app.js
// per the comment at the top of sidebar.js) as readonly browser globals.
//
// Main-process files (CommonJS) get a separate block with node globals.

const globals = require('globals');

// Cross-file renderer globals: vars defined in one file and consumed by
// another. The list mirrors the dependency comment at the top of
// public/sidebar.js (and equivalents). Kept readonly so reassignment
// from another file gets flagged.
const rendererCrossFileGlobals = {
  // DOM element handles (defined in app.js)
  sidebarContent: 'readonly',
  statsContent: 'readonly',
  memoryContent: 'readonly',
  placeholder: 'readonly',
  terminalsEl: 'readonly',
  terminalArea: 'readonly',
  terminalHeader: 'readonly',
  terminalHeaderName: 'readonly',
  terminalHeaderId: 'readonly',
  terminalHeaderStatus: 'readonly',
  terminalHeaderShell: 'readonly',
  terminalStopBtn: 'readonly',
  archiveToggle: 'readonly',
  starToggle: 'readonly',
  runningToggle: 'readonly',
  todayToggle: 'readonly',
  searchInput: 'readonly',
  searchBar: 'readonly',
  sessionFilters: 'readonly',
  loadingStatus: 'readonly',
  statusBarInfo: 'readonly',
  statusBarActivity: 'readonly',
  memoryViewer: 'readonly',
  memoryPanel: 'readonly',
  workFilesContent: 'readonly',
  workFilesViewer: 'readonly',
  workFilesPanel: 'readonly',
  statsViewer: 'readonly',
  statsViewerBody: 'readonly',
  settingsViewer: 'readonly',
  globalSettingsBtn: 'readonly',
  addProjectBtn: 'readonly',
  resortBtn: 'readonly',
  jsonlViewer: 'readonly',
  jsonlViewerTitle: 'readonly',
  jsonlViewerSessionId: 'readonly',
  jsonlViewerBody: 'readonly',
  gridViewer: 'readonly',
  gridViewerCount: 'readonly',

  // Sidebar/session state (mutable in app.js but readonly from sibling files)
  openSessions: 'readonly',
  activeSessionId: 'writable', // reassigned in setActiveSession
  setActiveSession: 'readonly',
  activePtyIds: 'writable',
  pendingSessions: 'readonly',
  sessionMap: 'writable',
  lastActivityTime: 'readonly',
  sortedOrder: 'writable',
  searchMatchIds: 'writable',
  searchMatchProjectPaths: 'writable',
  showArchived: 'writable',
  showStarredOnly: 'writable',
  showRunningOnly: 'writable',
  showTodayOnly: 'writable',
  visibleSessionCount: 'writable',
  sessionMaxAgeDays: 'writable',
  attentionSessions: 'readonly',
  responseReadySessions: 'readonly',
  sessionBusyState: 'readonly',
  cachedProjects: 'writable',
  cachedAllProjects: 'writable',
  gridCards: 'writable',
  gridViewActive: 'writable',
  activeTab: 'writable',

  // Functions from app.js / dialogs.js / utils.js / icons.js / terminal-manager.js / etc.
  ICONS: 'readonly',
  SCROLLBACK_SINGLE: 'readonly',
  SCROLLBACK_GRID: 'readonly',
  lruTouch: 'readonly',
  suspendTerminalWebgl: 'readonly',
  destroyGridCard: 'readonly',
  restoreTerminalWebgl: 'readonly',
  cleanDisplayName: 'readonly',
  formatDate: 'readonly',
  escapeHtml: 'readonly',
  shellEscape: 'readonly',
  encodeProjectPath: 'readonly',
  // Both defined in public/utils.js (upstream a7698f4 / 94a7ec0). Upstream has
  // no ESLint config, so new cross-file renderer symbols have to be declared
  // here when syncing or no-undef fires across five consumers.
  shortProjectPath: 'readonly',
  formatIndexingBannerText: 'readonly',
  PERMISSION_MODES: 'readonly',
  showSession: 'readonly',
  confirmAndStopSession: 'readonly',
  pollActiveSessions: 'readonly',
  showNewSessionPopover: 'readonly',
  openSettingsViewer: 'readonly',
  wireActivityTraceToggle: 'readonly',
  renderActivityTraceFiles: 'readonly',
  openActivityTraceFile: 'readonly',
  showResumeSessionDialog: 'readonly',
  showJsonlViewer: 'readonly',
  showSubagentTranscript: 'readonly',
  forkSession: 'readonly',
  openSession: 'readonly',
  loadProjects: 'readonly',
  renderProjects: 'readonly',
  buildSubagentIndex: 'readonly',
  buildSubagentItem: 'readonly',
  appendSubagentChildren: 'readonly',
  clearActiveSubagentsFor: 'readonly',
  buildSessionItem: 'readonly',
  buildSlugGroup: 'readonly',
  folderId: 'readonly',
  slugId: 'readonly',
  subagentTypeColor: 'readonly',
  SUBAGENT_LIVE_TTL_MS: 'readonly',
  getExpandedSubagents: 'readonly',
  saveExpandedSubagents: 'readonly',
  getExpandedSlugs: 'readonly',
  saveExpandedSlugs: 'readonly',
  setActivity: 'readonly',
  trackActivity: 'readonly',
  applyActivityClasses: 'readonly',
  rekeyActivityState: 'readonly',
  reconcileBusyState: 'readonly',
  currentActivitySeq: 'readonly',
  forgetActivitySeq: 'readonly',

  // Third-party renderer libs loaded as <script>
  morphdom: 'readonly',
  marked: 'readonly',
  DOMPurify: 'readonly',
  ViewerPanel: 'readonly',

  // Switchboard preload bridge
  switchboardAPI: 'readonly',
  // electronAPI / window.api possibly exposed via preload — leave as readonly
  electronAPI: 'readonly',

  // xterm.js and addons (loaded via <script>, exposed as window.Terminal etc.)
  Terminal: 'readonly',
  FitAddon: 'readonly',
  SearchAddon: 'readonly',
  WebLinksAddon: 'readonly',
  WebglAddon: 'readonly',
  UnicodeGraphemesAddon: 'readonly',

  // Terminal/grid/file-panel/stats/notifications and assorted helpers
  // shared across renderer files (defined somewhere in public/*.js).
  TERMINAL_THEME: 'writable',
  TERMINAL_THEMES: 'readonly',
  getTerminalTheme: 'readonly',
  currentThemeName: 'writable',
  isMac: 'readonly',
  flashButtonText: 'readonly',
  toggleMarkdownPreview: 'readonly',
  refreshSidebar: 'readonly',
  updateRunningIndicators: 'readonly',
  hideAllViewers: 'readonly',
  drainViewerWatches: 'readonly',
  showTerminalHeader: 'readonly',
  switchPanel: 'readonly',
  showAddProjectDialog: 'readonly',
  showGridView: 'readonly',
  toggleGridView: 'readonly',
  focusGridCard: 'readonly',
  wrapInGridCard: 'readonly',
  initGridObservers: 'readonly',
  initFilePanel: 'readonly',
  openFileInPanel: 'readonly',
  rekeyFilePanelState: 'readonly',
  loadStats: 'readonly',
  loadMemories: 'readonly',
  renderMemories: 'readonly',
  loadWorkFiles: 'readonly',
  renderWorkFiles: 'readonly',
  removeWorkFileFromCache: 'readonly',
  openWorkFile: 'readonly',
  clearNotifications: 'readonly',
  clearUnread: 'readonly',
  setSessionMcpActive: 'readonly',
  setSessionSandboxed: 'readonly',
  destroySession: 'readonly',
  launchNewSession: 'readonly',
  launchTerminalSession: 'readonly',
  launchScheduleCreator: 'readonly',
  resolveDefaultSessionOptions: 'readonly',
  handleSessionNavKey: 'readonly',
  isSessionNavKey: 'readonly',
  fitAndScroll: 'readonly',
  safeFit: 'readonly',
  proposeFittedDimensions: 'readonly',
  refitOpenTerminals: 'readonly',
  syncPtySizeAfterOpen: 'readonly',
  ptySizeChanged: 'readonly',
  observeContainerResize: 'readonly',
  flushTerminalBuffer: 'readonly',
  replayHiddenBuffer: 'readonly',
  scheduleFlush: 'readonly',
  handleTerminalData: 'readonly',
  createTerminalEntry: 'readonly',
  terminalWriteBuffers: 'readonly',
  ESC_SYNC_START: 'readonly',
  ESC_SYNC_END: 'readonly',
  SYNC_BUFFER_TIMEOUT: 'readonly',
  updatePtyTitle: 'readonly',
  _shellProfiles: 'writable',

  // Terminal right-click context menu (public/terminal-context-menu.js)
  terminalRightClickMode: 'writable',
  setupTerminalContextMenu: 'readonly',
  showTerminalContextMenu: 'readonly',
  closeTerminalContextMenuForSession: 'readonly',

  // Configurable keyboard shortcuts (public/shortcuts.js + grid-view.js)
  DEFAULT_SHORTCUTS: 'readonly',
  SHORTCUT_DEFS: 'readonly',
  normalizeShortcuts: 'readonly',
  keyFamily: 'readonly',
  matchShortcut: 'readonly',
  isSessionNavShortcut: 'readonly',
  formatBinding: 'readonly',
  captureBinding: 'readonly',
  appShortcuts: 'writable',
  setAppShortcuts: 'readonly',
};

module.exports = [
  // Ignore generated/vendored bundles and binaries
  {
    ignores: [
      'node_modules/**',
      'dist/**',
      'build/**',
      'public/codemirror-bundle.js',
      'scripts/**', // ad-hoc build helpers; out of lint scope for now
      '.work-files/**',
      '.claude/**', // agent worktrees (nested checkouts) and command config; not lint scope
    ],
  },

  // Renderer process: classic <script> globals, browser context
  {
    files: ['public/**/*.js'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'script',
      globals: {
        ...globals.browser,
        ...rendererCrossFileGlobals,
      },
    },
    rules: {
      'no-undef': 'error',
      'no-unused-vars': ['warn', { args: 'none', varsIgnorePattern: '^_' }],
      'no-implicit-globals': 'off', // renderer relies on script-scope globals by design
      'no-empty': ['warn', { allowEmptyCatch: true }],
      'no-unreachable': 'warn',
      'no-redeclare': 'warn',
    },
  },

  // Dual-mode helper: classic <script> in the renderer AND require()-d in tests.
  // Same browser globals as the rest of public/, plus `module` for the CJS footer.
  {
    files: ['public/shortcuts.js', 'public/terminal-context-menu.js', 'public/terminal-manager.js'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'script',
      globals: {
        ...globals.browser,
        ...rendererCrossFileGlobals,
        module: 'writable',
      },
    },
    rules: {
      'no-undef': 'error',
      'no-unused-vars': ['warn', { args: 'none', varsIgnorePattern: '^_' }],
      'no-redeclare': 'warn',
    },
  },

  // Producer of a cross-file renderer global: classic <script> in the renderer,
  // require()-d by the main process and tests. It declares SUBAGENT_LIVE_TTL_MS
  // rather than consuming it, so the global is switched off here — otherwise
  // no-redeclare flags the one definition the other two files depend on.
  {
    files: ['public/subagent-timing.js'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'script',
      globals: {
        ...globals.browser,
        module: 'writable',
        SUBAGENT_LIVE_TTL_MS: 'off',
      },
    },
    rules: {
      'no-undef': 'error',
      'no-unused-vars': ['warn', { args: 'none', varsIgnorePattern: '^_' }],
      'no-redeclare': 'warn',
    },
  },

  // CodeMirror setup file uses ESM-style imports/closure that don't lint well
  // as a classic script — keep no-undef on but be permissive about unused.
  {
    files: ['public/codemirror-setup.js'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: { ...globals.browser },
    },
    rules: {
      'no-undef': 'error',
      'no-unused-vars': 'off',
    },
  },

  // Main process: CommonJS, Node + Electron
  {
    files: [
      'main.js',
      'preload.js',
      'activity-trace.js',
      'db.js',
      'session-cache.js',
      'session-transitions.js',
      'read-session-file.js',
      'derive-project-path.js',
      'encode-project-path.js',
      'folder-index-state.js',
      'pty-size.js',
      'claude-auth.js',
      'mcp-bridge.js',
      'schedule-ipc.js',
      'schedule-runner.js',
      'shell-profiles.js',
      'terminal-input.js',
      'trigger-context.js',
      'workers/**/*.js',
    ],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'commonjs',
      globals: {
        ...globals.node,
      },
    },
    rules: {
      'no-undef': 'error',
      'no-unused-vars': ['warn', { args: 'none', varsIgnorePattern: '^_' }],
      'no-empty': ['warn', { allowEmptyCatch: true }],
      'no-unreachable': 'warn',
      'no-redeclare': 'warn',
    },
  },

  // Tests: node:test, Node globals
  {
    files: ['test/**/*.js', 'test/**/*.test.js'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'commonjs',
      globals: {
        ...globals.node,
      },
    },
    rules: {
      'no-undef': 'error',
      'no-unused-vars': ['warn', { args: 'none', varsIgnorePattern: '^_' }],
    },
  },

  // ESLint config self-check
  {
    files: ['eslint.config.js'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'commonjs',
      globals: { ...globals.node },
    },
  },
];
