const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../public/projects-view.js'), 'utf8');
const between = (start, end) => source.slice(source.indexOf(start), source.indexOf(end));
const menu = between('function sessionMenuItems(session) {', '// --- Flows (create, rename, attach, detach, done, remove) ---');
const flow = between('/**\n * Rename a session, the same as the Sessions tab', 'async function attachFolderFlow(');

/** Load the session menu and the rename flow against stubs. `answer` is what the dialog resolves. */
function load({ answer = null } = {}) {
  const calls = { prompts: [], renamed: [], loaded: 0 };
  const context = vm.createContext({
    window: { api: {
      renameSession: async (id, name) => { calls.renamed.push({ id, name }); return { name }; },
      writeClipboard: () => {},
    } },
    PICONS: new Proxy({}, { get: () => () => '' }),
    ICONS: new Proxy({}, { get: () => () => '' }),
    sessionMoveItems: () => [],
    isSessionRunning: () => false,
    isDismissibleSession: () => false,
    projectForSession: () => null,
    showPromptDialog: async (opts) => { calls.prompts.push({ ...opts }); return answer; },
    loadProjects: () => { calls.loaded++; },
  });
  vm.runInContext(menu + flow, context);
  return { context, calls };
}

const session = (extra = {}) => ({ sessionId: 's1', summary: 'Fix the login page', aiTitle: null, name: null, ...extra });

test('every project session menu offers Rename, terminals included', () => {
  for (const type of ['claude', 'terminal']) {
    const { context } = load();
    const labels = context.sessionMenuItems(session({ type })).map(item => item.label);
    assert.ok(labels.includes('Rename…'), `${type}: ${labels.join(', ')}`);
    assert.equal(labels.indexOf('Rename…') + 1, labels.indexOf('Copy session ID'));
  }
});

test('the menu item opens the rename dialog with the current name', async () => {
  const { context, calls } = load();
  const item = context.sessionMenuItems(session({ name: 'Login work' })).find(i => i.label === 'Rename…');
  await item.onClick();
  assert.equal(calls.prompts.length, 1);
  assert.equal(calls.prompts[0].title, 'Rename session');
  assert.equal(calls.prompts[0].value, 'Login work');
});

test('a new name is saved and the projects reload', async () => {
  const { context, calls } = load({ answer: 'Login redesign' });
  const s = session();
  await context.renameSessionFlow(s);
  assert.deepEqual(JSON.parse(JSON.stringify(calls.renamed)), [{ id: 's1', name: 'Login redesign' }]);
  assert.equal(s.name, 'Login redesign');
  assert.equal(calls.loaded, 1);
});

test('the dialog starts from the AI title when the session has no name', async () => {
  const { context, calls } = load();
  await context.renameSessionFlow(session({ aiTitle: 'Login page fix' }));
  assert.equal(calls.prompts[0].value, 'Login page fix');
});

test('typing the session title back clears the custom name', async () => {
  const { context, calls } = load({ answer: 'Fix the login page' });
  const s = session({ name: 'Login work' });
  await context.renameSessionFlow(s);
  assert.deepEqual(JSON.parse(JSON.stringify(calls.renamed)), [{ id: 's1', name: null }]);
  assert.equal(s.name, null);
});

test('cancel or an unchanged name saves nothing', async () => {
  for (const answer of [null, 'Login work']) {
    const { context, calls } = load({ answer });
    const s = session({ name: 'Login work' });
    await context.renameSessionFlow(s);
    assert.equal(calls.renamed.length, 0);
    assert.equal(calls.loaded, 0);
    assert.equal(s.name, 'Login work');
  }
});
