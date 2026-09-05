const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { findFiles, codesignFile } = require('../scripts/postinstall');

const SPECIAL_NAMES = ['some file.node', 'some"file.node', 'native\\addon.node'];

function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'postinstall-test-'));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

for (const name of SPECIAL_NAMES) {
  test(`findFiles returns the exact, unmangled path for filename: ${name}`, {
    // Quotes are invalid and backslashes are path separators on Windows.
    skip: process.platform === 'win32' && /["\\]/.test(name),
  }, () => {
    withTempDir(dir => {
      const expected = path.join(dir, name);
      fs.writeFileSync(expected, '');
      const results = findFiles(dir, '.node');
      assert.deepEqual(results, [expected]);
      // The regressed behavior stripped \\ and / from the name, breaking the path.
      assert.ok(fs.existsSync(results[0]));
    });
  });
}

test('findFiles descends into directories whose name contains a backslash', {
  skip: process.platform === 'win32',
}, () => {
  withTempDir(dir => {
    const subdir = path.join(dir, 'sub\\dir');
    fs.mkdirSync(subdir);
    const expected = path.join(subdir, 'addon.node');
    fs.writeFileSync(expected, '');
    const results = findFiles(dir, '.node');
    assert.deepEqual(results, [expected]);
  });
});

for (const name of SPECIAL_NAMES) {
  test(`codesignFile passes filename unchanged to the signer for: ${name}`, () => {
    // A stubbed signer only needs a path string, not a real filesystem entry.
    const file = path.join(os.tmpdir(), name);
    const calls = [];
    const stubSign = (...args) => calls.push(args);
    codesignFile(file, stubSign);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], [
      'codesign',
      ['--sign', '-', '--force', file],
      { stdio: 'ignore' },
    ]);
  });
}
