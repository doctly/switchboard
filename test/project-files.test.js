const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  MAX_PREVIEW_BYTES,
  MAX_MEDIA_PREVIEW_BYTES,
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
    assert.equal(entries.find(entry => entry.name === 'image.png').viewable, true);
    assert.equal(entries.find(entry => entry.name === 'image.png').previewType, 'image');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('image and PDF previews preserve bytes and HTML preserves editable source and encoded URLs', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-project-files-'));
  try {
    const media = [
      ['photo.PNG', 'image/png', 'image'], ['photo.jpeg', 'image/jpeg', 'image'],
      ['animated.gif', 'image/gif', 'image'], ['icon.svg', 'image/svg+xml', 'image'],
      ['photo.webp', 'image/webp', 'image'], ['photo.avif', 'image/avif', 'image'],
      ['report.PDF', 'application/pdf', 'pdf'],
    ];
    const bytes = Buffer.from([0, 1, 127, 128, 254, 255]);
    for (const [name, mimeType, type] of media) {
      fs.writeFileSync(path.join(root, name), bytes);
      const result = readProjectFile(root, name);
      assert.equal(result.previewType, type);
      assert.equal(result.mimeType, mimeType);
      assert.deepEqual(Buffer.from(result.base64, 'base64'), bytes);
      assert.equal(result.content, undefined, 'binary files must never enter the text editor');
    }
    const html = '<!doctype html><h1>Hello</h1><img src="photo.PNG">';
    fs.writeFileSync(path.join(root, 'page #1.htm'), html);
    const result = readProjectFile(root, 'page #1.htm');
    assert.equal(result.previewType, 'html');
    assert.equal(result.content, html);
    assert.ok(result.fileUrl.endsWith('/page%20%231.htm'));
    assert.equal(result.base64, undefined);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('media previews have a separate size limit and stay confined to the project', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-project-files-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-outside-files-'));
  try {
    fs.writeFileSync(path.join(root, 'large.pdf'), Buffer.alloc(MAX_PREVIEW_BYTES + 1));
    assert.equal(readProjectFile(root, 'large.pdf').previewType, 'pdf');
    fs.writeFileSync(path.join(root, 'oversized.png'), '');
    fs.truncateSync(path.join(root, 'oversized.png'), MAX_MEDIA_PREVIEW_BYTES + 1);
    assert.throws(() => readProjectFile(root, 'oversized.png'), /too large/);
    assert.equal(listProjectDirectory(root).find(entry => entry.name === 'oversized.png').viewable, false);
    fs.writeFileSync(path.join(outside, 'private.pdf'), '%PDF');
    fs.symlinkSync(path.join(outside, 'private.pdf'), path.join(root, 'escape.pdf'));
    assert.throws(() => readProjectFile(root, 'escape.pdf'), /outside/);
    assert.throws(() => readProjectFile(root, '../private.pdf'), /outside/);
    assert.throws(() => readProjectFile(root, '.'), /cannot be previewed/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
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
