const test = require('node:test');
const assert = require('node:assert/strict');
const { Terminal } = require('@xterm/xterm');
const { findFileReferences, createFileLinkProvider, createLinkHandler } = require('../public/terminal-links');

test('detection supports full Linux/macOS and Windows paths, home paths, quoting and locations', () => {
  const text = 'Saved to /work/daily.md. See (/work/app.js:12:3), `~/My Report.md` and [notes](</work/My Notes.md>).';
  const matches = findFileReferences(text);
  assert.deepEqual(matches.map(m => m.reference), ['/work/daily.md', '/work/app.js:12:3', '~/My Report.md', '/work/My Notes.md']);
  for (const match of matches) assert.equal(text.slice(match.start, match.end), match.reference);
  assert.deepEqual(findFileReferences('Open C:\\work\\file.ts:2 or ~\\notes.md or /work/a(b).js.').map(m => m.reference), ['C:\\work\\file.ts:2', '~\\notes.md', '/work/a(b).js']);
});

test('relative references are detected but web URLs, emails and unsupported schemes are excluded', () => {
  assert.deepEqual(findFileReferences('plan.md plan.txt ./plan.md ../plan.md src/app.js README:3 [plan](plan.md)').map(m => m.reference),
    ['plan.md', 'plan.txt', './plan.md', '../plan.md', 'src/app.js', 'README:3', 'plan.md']);
  assert.deepEqual(findFileReferences('https://example.com/path/file.md user@example.com javascript:alert(1) --config=/work/file.md ordinary prose'), []);
  assert.deepEqual(findFileReferences('vscode://file/tmp/app.js:2 file:///tmp/app.js').map(m => m.reference), ['vscode://file/tmp/app.js:2', 'file:///tmp/app.js']);
});

function setup(t, cols = 80) {
  const terminal = new Terminal({ cols, rows: 8, allowProposedApi: true });
  const session = { sessionId: 'session-one', projectPath: '/wrong/project' };
  const calls = [], opened = [], tooltips = [];
  const dependencies = { getSession: () => session,
    resolve: async references => { calls.push(references); return references.map(reference => reference.includes('missing') ? null : { filePath: reference }); },
    openFile: (...args) => opened.push(args),
    showTooltip: (_event, text) => tooltips.push(text), hideTooltip: () => tooltips.push(null),
  };
  const provider = createFileLinkProvider(terminal, dependencies);
  t.after(() => { provider.dispose(); terminal.dispose(); });
  return { terminal, session, calls, opened, tooltips, dependencies, provider,
    write: text => new Promise(resolve => terminal.write(text, resolve)),
    links: y => new Promise(resolve => provider.provideLinks(y, resolve)),
  };
}

test('wrapped absolute paths have one range and display the exact destination on hover', async t => {
  const s = setup(t, 18);
  await s.write('Saved to /work/daily-runs/2026-09-09.md.');
  const [link] = await s.links(1);
  assert.equal(link.text, '/work/daily-runs/2026-09-09.md');
  assert.deepEqual(link.range, { start: { x: 10, y: 1 }, end: { x: 3, y: 3 } });
  assert.deepEqual((await s.links(2))[0].range, link.range);
  assert.equal(s.calls.length, 1);
  link.hover({});
  assert.equal(s.tooltips.at(-1), '/work/daily-runs/2026-09-09.md');
  s.session.sessionId = 'real-codex-id';
  s.session.projectPath = '/another/folder';
  link.activate();
  assert.deepEqual(s.opened[0], ['real-codex-id', '/work/daily-runs/2026-09-09.md', { filePath: '/work/daily-runs/2026-09-09.md' }]);
  assert.equal(s.tooltips.at(-1), null);
});

test('link ranges use display cells for wide and combining characters', async t => {
  const s = setup(t);
  await s.write('測 e\u0301 /src/app.js');
  assert.deepEqual((await s.links(1))[0].range, { start: { x: 6, y: 1 }, end: { x: 16, y: 1 } });
  const wrapped = setup(t, 10);
  await wrapped.write('prefix: /測/file.md');
  const [link] = await wrapped.links(2);
  assert.equal(link.text, '/測/file.md');
  assert.deepEqual(link.range, { start: { x: 9, y: 1 }, end: { x: 10, y: 2 } });
});

test('relative files are checked on hover and missing full paths are not linked', async t => {
  const s = setup(t);
  await s.write('plan.md plan.txt ./plan.md');
  assert.equal(s.calls.length, 0, 'writing terminal output does not resolve files');
  assert.equal((await s.links(1)).length, 3);
  assert.equal(s.calls.length, 1);
  await s.write('\r\n/missing.md\r\n/work/notes.md');
  assert.deepEqual(await s.links(2), []);
  assert.equal((await s.links(3))[0].text, '/work/notes.md');
});

test('ambiguous relative links open a labeled chooser without opening either file first', async t => {
  const s = setup(t);
  const choices = [
    { filePath: '/session/plan.md', label: 'Session working directory', line: 3, column: 1 },
    { filePath: '/project/plan.md', label: 'Project folder', line: 3, column: 1 },
  ];
  let choose;
  let context = { cwd: '/session' };
  let calls = 0;
  const dependencies = { ...s.dependencies, getContext: () => context,
    resolve: async () => { calls++; return [{ choices }]; },
    chooseFile: (_event, found, open) => { assert.deepEqual(found, choices); choose = open; },
  };
  const provider = createFileLinkProvider(s.terminal, dependencies);
  t.after(() => provider.dispose());
  await s.write('plan.md:3');
  const links = () => new Promise(resolve => provider.provideLinks(1, resolve));
  const [link] = await links();
  await links();
  assert.equal(calls, 1, 'hover checks are cached');
  link.hover({});
  assert.match(s.tooltips.at(-1), /Session working directory: \/session\/plan.md:3:1/);
  link.activate({ clientX: 10, clientY: 20 });
  assert.equal(s.opened.length, 0);
  choose(choices[1]);
  assert.deepEqual(s.opened[0], ['session-one', '/project/plan.md', choices[1]]);
  context = { cwd: '/changed' };
  await links();
  assert.equal(calls, 2, 'a directory change bypasses cached resolutions');
  const handler = createLinkHandler(dependencies);
  await handler.activate({}, 'plan.md:3');
  assert.equal(s.opened.length, 1);
  choose(choices[0]);
  assert.equal(s.opened[1][1], '/session/plan.md');
  handler.dispose();
});

test('late validation cannot link replaced output or revive a disposed provider', async t => {
  const s = setup(t);
  let finish;
  s.dependencies.resolve = () => new Promise(resolve => { finish = resolve; });
  const provider = createFileLinkProvider(s.terminal, s.dependencies);
  t.after(() => provider.dispose());
  await s.write('/work/notes.md');
  const pending = new Promise(resolve => provider.provideLinks(1, resolve));
  await new Promise(resolve => setImmediate(resolve));
  await s.write('\r\x1b[2K/work/changed.txt');
  finish([{ filePath: '/work/notes.md' }]);
  assert.deepEqual(await pending, []);
  const closing = new Promise(resolve => provider.provideLinks(1, resolve));
  await new Promise(resolve => setImmediate(resolve));
  provider.dispose();
  finish([{ filePath: '/work/changed.txt' }]);
  assert.deepEqual(await closing, []);
});

test('OSC file links share the resolved hover target with clicks and web links stay external', async () => {
  const calls = [], tooltips = [];
  const session = { sessionId: 'claude', projectPath: '/wrong/folder' };
  const handler = createLinkHandler({
    getSession: () => session,
    resolve: async references => { calls.push(['resolve', references]); return [{ filePath: '/project/plan.md', line: 12, column: 3 }]; },
    openFile: (...args) => calls.push(['file', ...args]),
    openExternal: uri => calls.push(['web', uri]),
    showTooltip: (_event, text) => tooltips.push(text), hideTooltip() {},
  });
  const uri = 'vscode://file/project/plan.md:12:3';
  await handler.hover({}, uri);
  assert.equal(tooltips.at(-1), '/project/plan.md:12:3');
  session.sessionId = 'rekeyed';
  await handler.activate({}, uri);
  assert.deepEqual(calls.at(-1), ['file', 'rekeyed', '/project/plan.md', { filePath: '/project/plan.md', line: 12, column: 3 }]);
  assert.equal(calls.filter(c => c[0] === 'resolve').length, 1);
  await handler.hover({}, 'https://example.com');
  assert.equal(tooltips.at(-1), 'https://example.com');
  await handler.activate({}, 'https://example.com');
  assert.deepEqual(calls.at(-1), ['web', 'https://example.com']);
  await handler.activate({}, 'plan.md');
  assert.equal(calls.at(-1)[0], 'file', 'relative OSC targets use the same resolver');
  const before = calls.length;
  await handler.activate({}, 'command:do-something');
  assert.equal(calls.length, before);
  handler.dispose();
});

test('asynchronous OSC hover cannot leave a tooltip after leaving, clicking or disposal', async () => {
  const shown = [];
  let finish;
  const handler = createLinkHandler({
    getSession: () => ({ sessionId: 'one' }),
    resolve: () => new Promise(resolve => { finish = resolve; }),
    openFile() {}, openExternal() {}, hideTooltip() {},
    showTooltip: (_event, text) => shown.push(text),
  });
  const hover = handler.hover({}, 'file:///project/plan.md');
  await new Promise(resolve => setImmediate(resolve));
  handler.leave();
  finish([{ filePath: '/project/plan.md' }]);
  await hover;
  assert.deepEqual(shown, []);
  const next = handler.hover({}, 'file:///project/other.md');
  await new Promise(resolve => setImmediate(resolve));
  handler.dispose();
  finish([{ filePath: '/project/other.md' }]);
  await next;
  assert.deepEqual(shown, []);
});

test('unavailable OSC file targets have a tooltip but do not open a guessed path', async () => {
  let shown;
  const handler = createLinkHandler({
    getSession: () => ({ sessionId: 'one' }), resolve: async () => [null],
    openFile() { assert.fail('Must not open an unavailable target'); }, openExternal() {}, hideTooltip() {},
    showTooltip: (_event, text) => { shown = text; },
  });
  await handler.hover({}, 'file:///missing/plan.md');
  assert.equal(shown, 'File unavailable: file:///missing/plan.md');
  await handler.activate({}, 'file:///missing/plan.md');
  handler.dispose();
});

test('apostrophes in prose do not swallow full paths, and scoped package paths work', () => {
  assert.deepEqual(findFileReferences("It's saved in /work/app.js, isn't it?").map(m => m.reference), ['/work/app.js']);
  assert.deepEqual(findFileReferences('See /work/node_modules/@scope/pkg/index.js.').map(m => m.reference), ['/work/node_modules/@scope/pkg/index.js']);
});
