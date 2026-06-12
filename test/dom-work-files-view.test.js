// Smoke tests for the Work Files tab renderer (plans-memory-view.js work-files section).
//
// Strategy: load icons.js + utils.js + plans-memory-view.js into a jsdom window
// that stubs the minimal globals those scripts need (DOM refs, window.api).
// Then call loadWorkFiles / renderWorkFiles / openWorkFile and assert the
// resulting DOM matches expectations.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');

// Minimal HTML that plans-memory-view.js references via globals set in app.js.
const INDEX_HTML = `<!DOCTYPE html>
<html>
  <body>
    <div id="sidebar-content"></div>
    <div id="plans-content"></div>
    <div id="memory-content"></div>
    <div id="work-files-content"></div>
    <div id="placeholder"></div>
    <div id="plan-viewer"></div>
    <div id="memory-viewer"></div>
    <div id="work-files-viewer"></div>
    <div id="stats-viewer"></div>
    <div id="settings-viewer"></div>
    <div id="jsonl-viewer"></div>
    <div id="terminal-area"></div>
  </body>
</html>`;

function evalInWindow(dom, file) {
  const src = fs.readFileSync(file, 'utf8');
  vm.runInContext(src, dom.getInternalVMContext(), { filename: file });
}

// A minimal ViewerPanel stub — plans-memory-view.js calls workFilesPanel.open(...)
function makeViewerPanelStub() {
  return { open: () => {}, close: () => {} };
}

function setupWorkFilesDom() {
  const dom = new JSDOM(INDEX_HTML, {
    url: 'http://localhost/',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  const { window } = dom;

  // jsdom doesn't expose CSS.escape — polyfill it.
  // plans-memory-view.js uses CSS.escape() in openMemory / openWorkFile.
  if (!window.CSS) {
    Object.defineProperty(window, 'CSS', {
      value: {
        escape: (str) => str.replace(/([^\w-])/g, '\\$1'),
      },
      writable: true,
      configurable: true,
    });
  }

  // Stub window.api — default: getWorkFiles returns empty, readWorkFile returns ''
  window.api = {
    getWorkFiles: () => Promise.resolve({ projects: [] }),
    readWorkFile: () => Promise.resolve(''),
    readMemory: () => Promise.resolve(''),
    runScheduleNow: () => Promise.resolve({ ok: true }),
  };

  // DOM handles that plans-memory-view.js reads as globals (set by app.js normally)
  const stubGlobals = {
    plansContent:      window.document.getElementById('plans-content'),
    memoryContent:     window.document.getElementById('memory-content'),
    workFilesContent:  window.document.getElementById('work-files-content'),
    placeholder:       window.document.getElementById('placeholder'),
    planViewer:        window.document.getElementById('plan-viewer'),
    memoryViewer:      window.document.getElementById('memory-viewer'),
    workFilesViewer:   window.document.getElementById('work-files-viewer'),
    statsViewer:       window.document.getElementById('stats-viewer'),
    settingsViewer:    window.document.getElementById('settings-viewer'),
    jsonlViewer:       window.document.getElementById('jsonl-viewer'),
    terminalArea:      window.document.getElementById('terminal-area'),
    // ViewerPanel stubs
    planPanel:         makeViewerPanelStub(),
    memoryPanel:       makeViewerPanelStub(),
    workFilesPanel:    makeViewerPanelStub(),
    // State stubs
    cachedPlans:       [],
    cachedMemoryData:  { global: { files: [] }, projects: [] },
  };

  for (const [k, v] of Object.entries(stubGlobals)) {
    Object.defineProperty(window, k, { value: v, writable: true, configurable: true });
  }

  // Load dependencies
  evalInWindow(dom, path.join(PUBLIC_DIR, 'utils.js'));
  evalInWindow(dom, path.join(PUBLIC_DIR, 'icons.js'));
  evalInWindow(dom, path.join(PUBLIC_DIR, 'plans-memory-view.js'));

  return {
    window,
    document: window.document,
    /** Load work files using a given data fixture (replaces window.api.getWorkFiles). */
    async loadWith(data) {
      window.api.getWorkFiles = () => Promise.resolve(data);
      await window.loadWorkFiles();
    },
    destroy() { window.close(); },
  };
}

function makeSampleWorkFilesData() {
  const baseTime = Date.parse('2026-05-22T10:00:00Z');
  const t = (offset) => new Date(baseTime + offset).toISOString();
  return {
    projects: [
      {
        projectPath: '/home/dev/tagpay',
        shortName: 'workspace/tagpay',
        totalCount: 3,
        files: [
          { filename: 'plan.md', filePath: '/home/dev/tagpay/.work-files/plan.md', relativePath: 'plan.md', modified: t(0), size: 512 },
          { filename: 'state.json', filePath: '/home/dev/tagpay/.work-files/citadel/state.json', relativePath: 'citadel/state.json', modified: t(-1000), size: 256 },
          { filename: 'notes.md', filePath: '/home/dev/tagpay/.work-files/notes.md', relativePath: 'notes.md', modified: t(-2000), size: 128 },
        ],
      },
      {
        projectPath: '/home/dev/switchboard',
        shortName: 'workspace/switchboard',
        totalCount: 1,
        files: [
          { filename: 'todo.md', filePath: '/home/dev/switchboard/.work-files/todo.md', relativePath: 'todo.md', modified: t(-5000), size: 64 },
        ],
      },
    ],
  };
}

// ---- tests ----

test('renderWorkFiles: empty state shows correct message', async () => {
  const ctx = setupWorkFilesDom();
  try {
    await ctx.loadWith({ projects: [] });
    const empty = ctx.document.querySelector('#work-files-content .plans-empty');
    assert.ok(empty, '.plans-empty element must be present for empty state');
    assert.match(empty.textContent, /\.work-files/);
  } finally {
    ctx.destroy();
  }
});

test('renderWorkFiles: projects and files render into sidebar', async () => {
  const ctx = setupWorkFilesDom();
  try {
    await ctx.loadWith(makeSampleWorkFilesData());

    const groups = ctx.document.querySelectorAll('#work-files-content .project-group');
    assert.equal(groups.length, 2, 'two project groups must render');

    // First group header shows shortName
    const firstHeader = groups[0].querySelector('.project-name');
    assert.ok(firstHeader, 'project header must have .project-name');
    assert.equal(firstHeader.textContent, 'workspace/tagpay');

    // File items render
    const items = ctx.document.querySelectorAll('#work-files-content .work-file-item');
    assert.equal(items.length, 4, 'four total .work-file-item elements must render');
  } finally {
    ctx.destroy();
  }
});

test('renderWorkFiles: file item has data-filepath attribute', async () => {
  const ctx = setupWorkFilesDom();
  try {
    await ctx.loadWith(makeSampleWorkFilesData());

    const item = ctx.document.querySelector('.work-file-item');
    assert.ok(item, 'at least one work-file-item must exist');
    assert.ok(item.dataset.filepath, 'data-filepath must be set');
    assert.ok(item.dataset.filepath.includes('.work-files'), 'filepath must contain .work-files');
  } finally {
    ctx.destroy();
  }
});

test('renderWorkFiles: file item shows filename, relativePath, and date', async () => {
  const ctx = setupWorkFilesDom();
  try {
    await ctx.loadWith(makeSampleWorkFilesData());

    const first = ctx.document.querySelector('.work-file-item');
    assert.ok(first, 'first item must exist');

    const title = first.querySelector('.session-summary');
    assert.ok(title, '.session-summary must exist');
    assert.equal(title.textContent, 'plan.md');

    const pathEl = first.querySelector('.session-id');
    assert.ok(pathEl, '.session-id must exist');
    assert.equal(pathEl.textContent, 'plan.md');

    const meta = first.querySelector('.session-meta');
    assert.ok(meta, '.session-meta must exist');
    assert.ok(meta.textContent.length > 0, 'date text must not be empty');
  } finally {
    ctx.destroy();
  }
});

test('renderWorkFiles: count badge shows N/totalCount when capped', async () => {
  const ctx = setupWorkFilesDom();
  try {
    // Simulate a project where totalCount > shown files
    const bigData = {
      projects: [
        {
          projectPath: '/home/dev/big',
          shortName: 'home/big',
          totalCount: 500,
          files: Array.from({ length: 200 }, (_, i) => ({
            filename: `file-${i}.md`,
            filePath: `/home/dev/big/.work-files/file-${i}.md`,
            relativePath: `file-${i}.md`,
            modified: new Date(Date.now() - i * 1000).toISOString(),
            size: 100,
          })),
        },
      ],
    };
    await ctx.loadWith(bigData);

    const badge = ctx.document.querySelector('#work-files-content .memory-file-count');
    assert.ok(badge, 'count badge must exist');
    assert.match(badge.textContent, /200\/500/, 'badge must show capped/total when truncated');
  } finally {
    ctx.destroy();
  }
});

test('renderWorkFiles: filterIds hides non-matching files', async () => {
  const ctx = setupWorkFilesDom();
  try {
    await ctx.loadWith(makeSampleWorkFilesData());

    // Re-render with a filter: only show plan.md from tagpay
    const filterIds = new Set(['/home/dev/tagpay/.work-files/plan.md']);
    ctx.window.renderWorkFiles(filterIds);

    const items = ctx.document.querySelectorAll('#work-files-content .work-file-item');
    assert.equal(items.length, 1, 'only one item should pass the filter');
    assert.equal(items[0].dataset.filepath, '/home/dev/tagpay/.work-files/plan.md');
  } finally {
    ctx.destroy();
  }
});

test('openWorkFile: marks item active and shows viewer', async () => {
  const ctx = setupWorkFilesDom();
  try {
    const fileContent = '# My plan\n\nsome content';
    ctx.window.api.readWorkFile = () => Promise.resolve(fileContent);

    const file = {
      filename: 'plan.md',
      filePath: '/home/dev/tagpay/.work-files/plan.md',
      relativePath: 'plan.md',
      modified: new Date().toISOString(),
      size: 512,
    };

    await ctx.loadWith({
      projects: [{
        projectPath: '/home/dev/tagpay',
        shortName: 'workspace/tagpay',
        totalCount: 1,
        files: [file],
      }],
    });

    await ctx.window.openWorkFile(file);

    const active = ctx.document.querySelector('.work-file-item.active');
    assert.ok(active, '.work-file-item.active must exist after openWorkFile');
    assert.equal(active.dataset.filepath, file.filePath);

    // Viewer should be flex, terminal-area hidden
    const viewer = ctx.document.getElementById('work-files-viewer');
    assert.equal(viewer.style.display, 'flex', 'work-files-viewer must be flex');

    const terminal = ctx.document.getElementById('terminal-area');
    assert.equal(terminal.style.display, 'none', 'terminal-area must be hidden');
  } finally {
    ctx.destroy();
  }
});

test('ICONS.workFiles: returns SVG string with correct dimensions', () => {
  const ctx = setupWorkFilesDom();
  try {
    const svg = ctx.window.ICONS.workFiles(18);
    assert.ok(typeof svg === 'string', 'ICONS.workFiles must return a string');
    assert.ok(svg.includes('width="18"'), 'SVG must have width=18');
    assert.ok(svg.includes('height="18"'), 'SVG must have height=18');
    assert.ok(svg.startsWith('<svg'), 'must start with <svg');
  } finally {
    ctx.destroy();
  }
});
