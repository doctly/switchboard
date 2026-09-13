const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { pathToFileURL } = require('node:url');
const { parseTerminalFileReference, resolveTerminalFiles } = require('../terminal-file-links');

test('absolute paths and home paths preserve location suffixes without a session cwd', () => {
  for (const platform of ['darwin', 'linux']) {
    const parse = text => parseTerminalFileReference(text, { platform, home: '/home/me' });
    assert.equal(parse('/work/project/plan.md')[0].filePath, '/work/project/plan.md');
    assert.equal(parse('~/notes.md')[0].filePath, '/home/me/notes.md');
    assert.deepEqual(parse('/work/app.js:12:3').at(-1), { filePath: '/work/app.js', line: 12, column: 3 });
    assert.deepEqual(parse('/work/README:12').at(-1), { filePath: '/work/README', line: 12, column: 1 });
    assert.deepEqual(parse('/work/app.js#L12C3-L20C5').at(-1), { filePath: '/work/app.js', line: 12, column: 3 });
    assert.equal(parse('/work/report%20literal.md')[0].filePath, '/work/report%20literal.md');
    for (const relative of ['plan.md', 'plan.txt', './plan.md', '../plan.md', 'src/app.js:12', 'README:3', '~other/plan.md']) {
      assert.deepEqual(parse(relative), [], relative);
    }
  }
});

test('known editor URIs and encoded file URLs resolve locally with their locations', () => {
  const options = { platform: 'darwin' };
  for (const scheme of ['vscode', 'vscode-insiders', 'cursor', 'windsurf']) {
    assert.deepEqual(parseTerminalFileReference(`${scheme}://file/Users/me/My%20Project/app.js:9:2`, options).at(-1),
      { filePath: '/Users/me/My Project/app.js', line: 9, column: 2 });
  }
  assert.deepEqual(parseTerminalFileReference('file:///Users/me/My%20Project/report%231.md#L8', options),
    [{ filePath: '/Users/me/My Project/report#1.md', line: 8, column: 1 }]);
});

test('Windows drive paths, home paths and editor URIs retain the drive and separators', () => {
  const parse = text => parseTerminalFileReference(text, { platform: 'win32', home: 'C:\\Users\\me' });
  assert.deepEqual(parse('C:\\work\\app.js:4:6').at(-1), { filePath: 'C:\\work\\app.js', line: 4, column: 6 });
  assert.equal(parse('C:/work/app.js')[0].filePath, 'C:\\work\\app.js');
  assert.equal(parse('~/notes.md')[0].filePath, 'C:\\Users\\me\\notes.md');
  assert.equal(parse('~\\notes.md')[0].filePath, 'C:\\Users\\me\\notes.md');
  assert.deepEqual(parse('vscode://file/C:/My%20Project/app.js:4:6').at(-1), { filePath: 'C:\\My Project\\app.js', line: 4, column: 6 });
  assert.equal(parse('file:///C:/My%20Project/app.js')[0].filePath, 'C:\\My Project\\app.js');
  for (const relative of ['src\\app.js', 'C:plan.md', '\\work\\plan.md', '/work/plan.md']) assert.deepEqual(parse(relative), [], relative);
});

test('unsupported schemes, relative file URIs, malformed URLs and network paths are rejected', () => {
  for (const reference of ['https://example.com/app.js', 'javascript:alert(1)', 'command:workbench.action.openSettings',
    'vscode://settings/foo', 'vscode://user:password@file/tmp/a.js', 'file://server/share/a.js', 'file:plan.md', 'file:/plan.md',
    'file:///tmp/a%00.js', 'vscode://file/tmp/%ZZ.js', '\\\\server\\share\\a.js', 'a\0.js', 'a\n.js']) {
    assert.deepEqual(parseTerminalFileReference(reference), [], reference);
  }
});

test('only existing absolute files become links; literal filenames precede location suffixes', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-terminal-link-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'daily-runs'));
  fs.writeFileSync(path.join(root, 'daily-runs', '2026-09-09.md'), '# Daily run');
  fs.writeFileSync(path.join(root, 'app.js'), 'line one\nline two');
  fs.writeFileSync(path.join(root, 'report#L10'), 'literal name');
  const names = ['daily-runs/2026-09-09.md', 'app.js:2:3', 'missing.md', 'daily-runs', 'report#L10'];
  const found = await resolveTerminalFiles([...names.map(name => path.join(root, name)), pathToFileURL(path.join(root, 'app.js')).href]);
  assert.equal(found[0].filePath, path.join(root, 'daily-runs', '2026-09-09.md'));
  assert.deepEqual(found[1], { filePath: path.join(root, 'app.js'), line: 2, column: 3 });
  assert.equal(found[2], null);
  assert.equal(found[3], null);
  assert.deepEqual(found[4], { filePath: path.join(root, 'report#L10') });
  assert.equal(found[5].filePath, path.join(root, 'app.js'));
  assert.deepEqual(await resolveTerminalFiles([null, 123, {}]), [null, null, null]);
  assert.deepEqual(await resolveTerminalFiles(Array(33).fill('app.js')), []);
});

test('bare plan filenames cannot open an unrelated plan in the process directory', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-plan-link-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const initialCwd = process.cwd();
  fs.writeFileSync(path.join(root, 'plan.md'), 'Unrelated plan');
  try {
    process.chdir(root);
    assert.deepEqual(await resolveTerminalFiles(['plan.md', './plan.md', 'file:plan.md']), [null, null, null]);
  } finally { process.chdir(initialCwd); }
});
