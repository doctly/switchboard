const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function setup() {
  const element = () => ({
    style: {}, children: [], textContent: '',
    classList: { add() {}, remove() {}, toggle() {} },
    addEventListener() {}, setAttribute() {},
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
