const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function createToolbar(opts) {
  const element = () => ({
    style: {}, children: [], className: '', title: '',
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    setAttribute(name, value) { this[name] = value; },
    appendChild(child) { this.children.push(child); },
  });
  const window = { api: {} };
  const context = vm.createContext({
    window, navigator: { platform: '' },
    document: { createElement: element, addEventListener() {} },
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/viewer-toolbar.js'), 'utf8'), context);
  return window.createViewerToolbar(opts);
}

test('the share button sits right after Save and before Open in default app', () => {
  const toolbar = createToolbar({ preview: true, wrap: true, save: true, share: true, openExternal: true, close: true });
  const controls = toolbar.el.children[1].children;
  const at = button => controls.indexOf(button);
  assert.equal(at(toolbar.shareBtn), at(toolbar.saveBtn) + 1);
  assert.equal(at(toolbar.openExternalBtn), at(toolbar.shareBtn) + 1);
  assert.equal(toolbar.shareBtn.title, 'Share');
  assert.equal(toolbar.shareBtn['aria-label'], 'Share');
  assert.equal(createToolbar({ save: true, close: true }).shareBtn, null);
});
