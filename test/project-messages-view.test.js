const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('message search handles platform find shortcuts only while the viewer is visible', () => {
  const source = fs.readFileSync(path.join(__dirname, '../public/jsonl-viewer.js'), 'utf8');
  const searchSetup = source.slice(source.indexOf('let jsonlSearch ='), source.indexOf('let jsonlViewRequest ='));
  for (const platform of ['MacIntel', 'Win32', 'Linux x86_64']) {
    let listener, opened = 0, visible = true, prevented = 0;
    const context = vm.createContext({
      document: { addEventListener: (_name, fn) => { listener = fn; } },
      navigator: { platform },
      jsonlViewer: { getClientRects: () => visible ? [{}] : [] },
      jsonlViewerBody: {},
      createMessageSearch: () => ({ open: () => opened++ }),
    });
    vm.runInContext(searchSetup, context);
    const event = { key: 'f', metaKey: platform === 'MacIntel', ctrlKey: platform !== 'MacIntel',
      preventDefault: () => prevented++, stopImmediatePropagation() {} };
    listener(event);
    assert.equal(opened, 1, platform);
    assert.equal(prevented, 1);
    listener({ ...event, altKey: true });
    listener({ ...event, metaKey: false, ctrlKey: false });
    visible = false;
    listener(event);
    assert.equal(opened, 1, 'other shortcuts and hidden viewers are ignored');
  }
});

test('messages open beside the project list before loading and ignore replies after navigation', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../public/jsonl-viewer.js'), 'utf8');
  const projects = fs.readFileSync(path.join(__dirname, '../public/projects-view.js'), 'utf8');
  const entered = [];
  const requests = [];
  const element = () => ({ style: {}, textContent: '', innerHTML: '' });
  const context = vm.createContext({
    document: { querySelectorAll: () => [], querySelector: () => null },
    activeTab: 'projects', activeSessionId: null,
    jsonlSearch: null,
    placeholder: element(), terminalArea: element(), jsonlViewer: element(),
    jsonlViewerTitle: element(), jsonlViewerSessionId: element(), jsonlViewerBody: element(),
    hideAllViewers() {},
    setActiveSession(id) { context.activeSessionId = id; },
    projectForSession: () => ({ project: { id: 'project-1' } }),
    enterWorking: (project, session) => entered.push([project.id, session.sessionId]),
    window: { api: { readSessionJsonl: () => new Promise(resolve => requests.push(resolve)) } },
    escapeHtml: text => text,
  });
  vm.runInContext(projects.slice(projects.indexOf('function onMessagesShown('), projects.indexOf('/** Called by showTaskLog.')), context);
  vm.runInContext(source.slice(source.indexOf('let jsonlViewRequest =')), context);
  const first = context.showJsonlViewer({ sessionId: 'first' });
  assert.deepEqual(entered, [['project-1', 'first']]);
  assert.equal(context.jsonlViewer.style.display, 'flex');
  assert.equal(context.terminalArea.style.display, 'none');
  const second = context.showJsonlViewer({ sessionId: 'second' });
  requests[0]({ error: 'stale reply' });
  await first;
  assert.equal(context.jsonlViewerBody.innerHTML.includes('stale reply'), false);
  context.jsonlViewer.style.display = 'none';
  context.activeSessionId = 'terminal';
  requests[1]({ error: 'reply after leaving' });
  await second;
  assert.equal(context.jsonlViewer.style.display, 'none');
  assert.equal(context.jsonlViewerBody.innerHTML.includes('reply after leaving'), false);
});
