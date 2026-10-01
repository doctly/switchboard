const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const read = name => fs.readFileSync(path.join(__dirname, '../public', name), 'utf8');
const grid = read('grid-view.js');
const navSource = grid.slice(grid.indexOf('// The session rows in the order the user sees them.'));
const terminal = read('terminal-manager.js');
const keysStart = terminal.indexOf('function setupTerminalKeyBindings');
const keysSource = terminal.slice(keysStart, terminal.indexOf('\n}\n', keysStart) + 3);
const panel = read('file-panel.js');
const panelSource = panel.slice(panel.indexOf("// Every session's file tab shares fpViewerPanel"), panel.indexOf('async function openFileInPanel'));

const rows = ids => ({ querySelectorAll: () => ids.map(sessionId => ({ dataset: { sessionId } })) });

/** The navigation code against a sidebar and a project list in different orders. */
function navContext({ tab = 'sessions', working = true, grid = false, mac = true } = {}) {
  const shown = [], sent = [];
  const context = vm.createContext({
    isMac: mac,
    activeTab: tab,
    gridViewActive: grid,
    projectsUi: { working },
    sidebarContent: rows(['s9', 's1', 's2', 's3']),
    projectPanes: rows(['s3', 's1', 's2']),
    projectViewer: rows(['s2', 's1']),
    openSessions: new Map(['s1', 's2', 's3', 's9'].map(id => [id, { closed: false }])),
    activeSessionId: 's1',
    gridFocusedSessionId: null,
    showSession: id => shown.push(id),
    focusGridCard: id => shown.push(`grid:${id}`),
    window: { api: { sendInput: (id, data) => sent.push([id, data]) } },
  });
  vm.runInContext(navSource + keysSource, context);
  return { context, shown, sent };
}

const key = (k, extra = {}) => ({ key: k, type: 'keydown', metaKey: true, ctrlKey: false, altKey: false, shiftKey: false, preventDefault() {}, ...extra });

/** The xterm key handler setupTerminalKeyBindings installs. */
function terminalHandler(context) {
  let handler;
  context.setupTerminalKeyBindings({ attachCustomKeyEventHandler: fn => { handler = fn; } }, { querySelector: () => null }, () => 'sess');
  return handler;
}

test('in a project, session navigation follows the project list, not the sidebar', () => {
  const working = navContext({ tab: 'projects' });
  working.context.navigateSession(-1);
  assert.deepEqual(working.shown, ['s3'], 'the session before s1 in the project pane');

  const overview = navContext({ tab: 'projects', working: false });
  overview.context.navigateSession(-1);
  assert.deepEqual(overview.shown, ['s2'], 'the overview uses its track cards');

  const sessions = navContext({ tab: 'sessions' });
  sessions.context.navigateSession(-1);
  assert.deepEqual(sessions.shown, ['s9'], 'the Sessions tab keeps the sidebar order');
});

test('text fields and editors keep Cmd+Left/Right for the cursor', () => {
  const { context } = navContext();
  for (const tagName of ['INPUT', 'TEXTAREA', 'SELECT']) assert.equal(context.isTextEditingTarget({ tagName }), true, tagName);
  assert.equal(context.isTextEditingTarget({ tagName: 'DIV', isContentEditable: true }), true, 'CodeMirror');
  assert.equal(context.isTextEditingTarget({ tagName: 'DIV', isContentEditable: false }), false);
  assert.equal(context.isLineJumpKey(key('ArrowLeft')), true);
  assert.equal(context.isLineJumpKey(key('ArrowUp')), false);
  assert.equal(context.isLineJumpKey(key('ArrowLeft', { shiftKey: true })), false, 'Cmd+Shift+Left selects to the line start');
});

test('in a terminal, Cmd+Left/Right go to the line start and end instead of switching sessions', () => {
  const { context, shown, sent } = navContext();
  const handle = terminalHandler(context);
  assert.equal(handle(key('ArrowLeft')), false);
  assert.equal(handle(key('ArrowRight')), false);
  assert.equal(handle(key('ArrowRight', { type: 'keyup' })), false, 'keyup is swallowed without sending');
  assert.deepEqual(sent, [['sess', '\x01'], ['sess', '\x05']]);
  assert.deepEqual(shown, []);

  handle(key('ArrowDown'));
  assert.deepEqual(shown, ['s2'], 'Cmd+Down still switches sessions');
});

test('the grid keeps Cmd+Arrow for moving between cards', () => {
  const { context, sent } = navContext({ grid: true });
  const moves = [];
  context.navigateGrid = dir => moves.push(dir);
  assert.equal(terminalHandler(context)(key('ArrowLeft')), false);
  assert.deepEqual(moves, ['left']);
  assert.deepEqual(sent, []);
});

test('off the Mac, Ctrl+Left/Right is left to xterm as a word jump', () => {
  const { context, shown, sent } = navContext({ mac: false });
  const event = key('ArrowLeft', { metaKey: false, ctrlKey: true });
  assert.equal(terminalHandler(context)(event), true);
  assert.equal(event._handled, true, 'the document handler does not switch sessions either');
  assert.deepEqual(sent, []);
  assert.deepEqual(shown, []);
});

/** The file panel's shared viewer, with a stand-in editor the test can type into. */
function panelContext() {
  const view = text => {
    const v = { text, head: 0 };
    Object.defineProperty(v, 'state', { get: () => ({ doc: { toString: () => v.text, length: v.text.length }, selection: { main: { head: v.head } } }) });
    v.dispatch = ({ selection }) => { if (selection) v.head = selection.anchor; };
    return v;
  };
  const viewer = {
    filePath: '', editorView: null, opened: 0, destroyed: 0,
    open(_label, filePath, content) { this.opened++; this.filePath = filePath; this.editorView = view(content); },
    getContent() { return this.editorView ? this.editorView.state.doc.toString() : ''; },
    destroy() { this.destroyed++; this.filePath = ''; this.editorView = null; },
  };
  const context = vm.createContext({ fpViewerPanel: viewer });
  vm.runInContext(panelSource, context);
  return { context, viewer };
}

const fileTab = (filePath, content) => ({ type: 'file', label: filePath, filePath, content, preview: {} });

test('unsaved edits and the cursor survive switching to another session and back', () => {
  const { context, viewer } = panelContext();
  const a = fileTab('/a.md', 'hello');
  const b = fileTab('/b.md', 'other');
  context.showFileTab(a);
  viewer.editorView.text = 'hello, typed';
  viewer.editorView.head = 12;

  context.showFileTab(b);
  context.showFileTab(a);
  assert.equal(viewer.getContent(), 'hello, typed');
  assert.equal(viewer.editorView.head, 12);
});

test('repainting the shown file does not reload it', () => {
  const { context, viewer } = panelContext();
  const a = fileTab('/a.md', 'hello');
  context.showFileTab(a);
  viewer.editorView.text = 'typed';
  context.showFileTab(a);
  assert.equal(viewer.opened, 1);
  assert.equal(viewer.getContent(), 'typed');
});

test('replacing a background session\'s file leaves the shown file alone', () => {
  const { context, viewer } = panelContext();
  const a = fileTab('/a.md', 'hello');
  const b = fileTab('/b.md', 'other');
  context.showFileTab(a);
  context.showFileTab(b);
  context.destroyCurrentTab({ currentTab: a });
  assert.equal(viewer.destroyed, 0);
  assert.equal(viewer.filePath, '/b.md');

  context.destroyCurrentTab({ currentTab: b });
  assert.equal(viewer.destroyed, 1, 'the shown file is torn down with its tab');
});
