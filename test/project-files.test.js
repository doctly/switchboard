const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  MAX_PREVIEW_BYTES,
  listProjectDirectory,
  readProjectFile,
  resolveProjectEntry,
} = require('../project-files');

test('project directory listing sorts folders first and marks previewable files', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-project-files-'));
  try {
    fs.mkdirSync(path.join(root, 'src'));
    fs.writeFileSync(path.join(root, 'notes.md'), '# Notes\n');
    fs.writeFileSync(path.join(root, 'image.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    const entries = listProjectDirectory(root);
    assert.deepEqual(entries.map(entry => entry.name), ['src', 'image.png', 'notes.md']);
    assert.equal(entries.find(entry => entry.name === 'notes.md').viewable, true);
    assert.equal(entries.find(entry => entry.name === 'image.png').viewable, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('project file reads are confined to the project and reject binary or oversized files', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-project-files-'));
  try {
    fs.writeFileSync(path.join(root, 'app.js'), 'console.log("ok");\n');
    fs.writeFileSync(path.join(root, 'archive.zip'), 'not really a zip');
    fs.writeFileSync(path.join(root, 'binary-data'), Buffer.from([1, 0, 2, 0]));
    fs.writeFileSync(path.join(root, 'large.txt'), Buffer.alloc(MAX_PREVIEW_BYTES + 1));

    assert.equal(readProjectFile(root, 'app.js').content, 'console.log("ok");\n');
    assert.throws(() => readProjectFile(root, 'archive.zip'), /cannot be previewed/);
    assert.throws(() => readProjectFile(root, 'binary-data'), /cannot be previewed/);
    assert.throws(() => readProjectFile(root, 'large.txt'), /too large/);
    assert.throws(() => resolveProjectEntry(root, '../outside.txt'), /outside/);
    assert.throws(() => resolveProjectEntry(root, path.join(root, 'app.js')), /Invalid/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
