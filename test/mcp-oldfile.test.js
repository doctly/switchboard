const { test } = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

const { readOldContent } = require('../mcp-bridge');

test('readOldContent uses the injected reader when present (remote session)', () => {
  const entry = { readOldFile: (p) => `REMOTE:${p}` };
  assert.strictEqual(readOldContent(entry, '/srv/app/x.py'), 'REMOTE:/srv/app/x.py');
});

test('readOldContent falls back to local fs read when no reader injected', () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'swb-old-')), 'a.txt');
  fs.writeFileSync(f, 'local-contents');
  assert.strictEqual(readOldContent({}, f), 'local-contents');
});

test('readOldContent returns empty string when the (remote) read throws', () => {
  const entry = { readOldFile: () => { throw new Error('ssh failed'); } };
  assert.strictEqual(readOldContent(entry, '/nope'), '');
});

test('readOldContent returns empty string for a missing local file', () => {
  assert.strictEqual(readOldContent({}, '/definitely/not/here-12345'), '');
});

test('readOldContent coerces a null reader result to empty string', () => {
  assert.strictEqual(readOldContent({ readOldFile: () => null }, '/x'), '');
});
