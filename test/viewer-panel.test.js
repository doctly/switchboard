const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function setup() {
  const element = () => ({
    style: {}, children: [], textContent: '',
    classList: { add() {}, remove() {}, toggle() {} },
    addEventListener(type, callback) { this[type] = callback; },
    setAttribute(name, value) { this[name] = value; },
    appendChild(child) { this.children.push(child); },
    insertBefore(child) { this.children.unshift(child); },
    replaceChildren(...children) { this.children = children; },
  });
  const toolbar = { setTitle(title) { this.titleEl.textContent = title; }, setPath() {}, setWrapMode() {}, setPreviewMode() {} };
  for (const key of ['el', 'titleEl', 'previewBtn', 'wrapBtn', 'saveBtn', 'gotoLineBtn', 'copyContentBtn']) toolbar[key] = element();
  const revoked = [];
  let nextUrl = 0;
  let saved = 0;
  const api = { watchFile() {}, unwatchFile() {} };
  const context = vm.createContext({
    document: { createElement: element }, localStorage: { getItem() { return null; } },
    Uint8Array, Blob, atob, setTimeout,
    URL: { createObjectURL: () => `blob:${++nextUrl}`, revokeObjectURL: url => revoked.push(url) },
    window: { api, createViewerToolbar: () => toolbar, createEditableViewer: (_el, content) => ({
      state: { doc: { toString: () => content, length: content.length } },
      dispatch({ changes }) { if (changes) { content = changes.insert; this.state.doc.length = content.length; } },
      destroy() { this.destroyed = true; },
    }) },
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/viewer-panel.js'), 'utf8'), context);
  const panel = new context.window.ViewerPanel(element(), { language: 'auto', onSave: async () => { saved++; return { ok: true }; } });
  const media = { previewType: 'image', mimeType: 'image/png', base64: 'AAEC' };
  return { panel, toolbar, revoked, api, media, saved: () => saved };
}

test('media previews cannot save binary files and switching files restores editing', async () => {
  const { panel, toolbar, media, revoked, saved } = setup();
  panel.open('Code', '/app.js', 'const original = true;');
  const oldEditor = panel.editorView;
  panel.open('Image', '/image.png', undefined, media);
  assert.equal(oldEditor.destroyed, true);
  assert.equal(panel.editorView, null);
  assert.equal(toolbar.saveBtn.style.display, 'none');
  assert.equal(toolbar.copyContentBtn.style.display, 'none');
  await panel._save();
  assert.equal(saved(), 0);
  assert.equal(panel.previewEl.children[0].src, 'blob:1');
  panel.open('Text', '/notes.txt', 'New content');
  assert.equal(panel.getContent(), 'New content');
  assert.equal(toolbar.saveBtn.style.display, '');
  assert.equal(panel.editorEl.style.display, '');
  assert.deepEqual(revoked, ['blob:1']);
});

test('media reloads replace and release object URLs; destroy releases the last preview', async () => {
  const { panel, media, api, revoked } = setup();
  panel.open('Image', '/image.png', undefined, media);
  api.readFileForPanel = async () => ({ ok: true, ...media, base64: 'AwQF' });
  await panel._reloadFromDisk();
  assert.equal(panel.previewEl.children[0].src, 'blob:2');
  assert.deepEqual(revoked, ['blob:1']);
  panel.destroy();
  assert.deepEqual(revoked, ['blob:1', 'blob:2']);
  assert.equal(panel.filePath, '');
});

test('a delayed reload cannot replace a newly selected file or revive a destroyed preview', async () => {
  const { panel, api, media } = setup();
  let resolve;
  api.readFileForPanel = () => new Promise(done => { resolve = done; });
  panel.open('Image', '/image.png', undefined, media);
  const pending = panel._reloadFromDisk();
  panel.open('Code', '/app.js', 'keep this');
  resolve({ ok: true, ...media });
  await pending;
  assert.equal(panel.filePath, '/app.js');
  assert.equal(panel.getContent(), 'keep this');
  const second = panel._reloadFromDisk();
  panel.destroy();
  resolve({ ok: true, content: 'stale' });
  await second;
  assert.equal(panel.editorView, null);
  assert.equal(panel.filePath, '');
});


test('renaming an open file preserves edits, updates saves and ignores a stale reload', async () => {
  const { panel, api, saved } = setup();
  panel.open('Draft', '/notes.md', 'unsaved edits');
  const requests = [];
  api.readFileForPanel = () => new Promise(resolve => requests.push(resolve));
  const stale = panel._reloadFromDisk();
  const rename = panel.relocate('Renamed', '/renamed.md');
  requests[0]({ ok: true, content: 'stale disk content' });
  await stale;
  requests[1]({ ok: true, content: 'disk content' });
  await rename;
  assert.equal(panel.filePath, '/renamed.md');
  assert.equal(panel.getContent(), 'unsaved edits');
  assert.equal(panel._watchedPath, '/renamed.md');
  panel.toolbar.flashSave = () => {};
  await panel._save();
  assert.equal(saved(), 1);
});


test('renaming to a media extension cannot discard an editable buffer', async () => {
  const { panel, api, media } = setup();
  panel.open('Text', '/notes.txt', 'unsaved text');
  api.readFileForPanel = async () => ({ ok: true, ...media });
  await panel.relocate('Image', '/notes.png');
  assert.equal(panel.filePath, '/notes.png');
  assert.equal(panel.getContent(), 'unsaved text');
  assert.equal(panel.previewType, 'text');
});

test('a rename reply cannot revive a closed editor', async () => {
  const { panel, api } = setup();
  panel.open('Text', '/notes.txt', 'text');
  let resolve;
  api.readFileForPanel = () => new Promise(done => { resolve = done; });
  const rename = panel.relocate('Renamed', '/renamed.txt');
  panel.destroy();
  resolve({ ok: true, content: 'late reply' });
  await rename;
  assert.equal(panel.filePath, '');
  assert.equal(panel.editorView, null);
});

test('PowerPoint is read-only and transfers bytes only to an isolated preview frame', async () => {
  const { panel, toolbar, saved, revoked } = setup();
  panel.open('Deck', '/slides.pptx', undefined, { previewType: 'pptx', previewUrl: 'switchboard-preview://test/pptx-preview.html', base64: 'AAEC' });
  const frame = panel.previewEl.children[0];
  assert.equal(frame.src, 'switchboard-preview://test/pptx-preview.html');
  assert.equal(frame.sandbox, 'allow-scripts');
  assert.equal(frame.title, 'PowerPoint preview: slides.pptx');
  assert.equal(panel.editorView, null);
  assert.equal(toolbar.saveBtn.style.display, 'none');
  await panel._save();
  assert.equal(saved(), 0);
  const messages = [];
  frame.contentWindow = { postMessage: (...args) => messages.push(args) };
  frame.load();
  assert.equal(messages[0][0].type, 'switchboard-pptx');
  assert.deepEqual([...new Uint8Array(messages[0][0].buffer)], [0, 1, 2]);
  assert.equal(messages[0][2][0], messages[0][0].buffer);
  panel.open('Text', '/notes.txt', 'Editable');
  assert.equal(panel.getContent(), 'Editable');
  assert.equal(toolbar.saveBtn.style.display, '');
  assert.equal(panel.previewEl.children.length, 0);
  assert.deepEqual(revoked, [], 'PPTX frames own their media URLs');
});

test('PowerPoint reload and rename replace the frame, and stale reloads cannot revive it', async () => {
  const { panel, api } = setup();
  const deck = { ok: true, previewType: 'pptx', previewUrl: 'switchboard-preview://test/pptx-preview.html', base64: 'AAEC' };
  panel.open('Deck', '/slides.pptx', undefined, deck);
  const original = panel.previewEl.children[0];
  api.readFileForPanel = async () => deck;
  await panel._reloadFromDisk();
  assert.notEqual(panel.previewEl.children[0], original);
  await panel.relocate('Renamed', '/renamed.pptx');
  assert.equal(panel.previewEl.children[0].title, 'PowerPoint preview: renamed.pptx');
  let resolve;
  api.readFileForPanel = () => new Promise(done => { resolve = done; });
  const pending = panel._reloadFromDisk();
  panel.destroy();
  resolve(deck);
  await pending;
  assert.equal(panel.previewEl.children.length, 0);
  assert.equal(panel._presentationBytes, null);
});

test('a delayed PowerPoint frame load is ignored after switching files', () => {
  const { panel } = setup();
  panel.open('Deck', '/slides.pptx', undefined, { previewType: 'pptx', previewUrl: 'switchboard-preview://test/pptx-preview.html', base64: 'AAEC' });
  const frame = panel.previewEl.children[0];
  frame.contentWindow = { postMessage() { assert.fail('Stale preview must not receive data'); } };
  panel.open('Text', '/notes.txt', 'Keep this');
  frame.load();
  assert.equal(panel.getContent(), 'Keep this');
});
