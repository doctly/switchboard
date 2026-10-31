const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function createToolbar(platform, opts) {
  const element = () => ({
    style: {}, children: [], className: '', title: '',
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    setAttribute(name, value) { this[name] = value; },
    appendChild(child) { this.children.push(child); },
  });
  const window = { api: { platform } };
  const context = vm.createContext({
    window, navigator: { platform: '' },
    document: { createElement: element, addEventListener() {} },
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/viewer-toolbar.js'), 'utf8'), context);
  return window.createViewerToolbar(opts);
}

test('the reveal button sits right before the close button and names the platform file manager', () => {
  const toolbar = createToolbar('darwin', { preview: true, wrap: true, save: true, reveal: true, close: true });
  const controls = toolbar.el.children[1].children;
  assert.equal(controls.at(-2), toolbar.revealBtn);
  assert.equal(controls.at(-1), toolbar.closeBtn);
  assert.equal(toolbar.revealBtn.title, 'Reveal in Finder');
  assert.equal(toolbar.revealBtn['aria-label'], 'Reveal in Finder');
  assert.equal(createToolbar('win32', { reveal: true }).revealBtn.title, 'Reveal in Explorer');
  assert.equal(createToolbar('linux', { reveal: true }).revealBtn.title, 'Reveal in File Manager');
  assert.equal(createToolbar('darwin', { close: true }).revealBtn, null);
});
