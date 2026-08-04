const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { deriveProjectPath } = require('../derive-project-path');

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'wp-derive-'));
}

function writeJsonl(filePath, entries) {
  fs.writeFileSync(filePath, entries.map(e => JSON.stringify(e)).join('\n') + '\n', 'utf8');
}

test('derives project path from cwd in a .jsonl file', () => {
  const folder = makeTmpDir();
  const projectPath = makeTmpDir();
  try {
    writeJsonl(path.join(folder, 'session.jsonl'), [
      { type: 'user', message: 'hi', cwd: projectPath },
    ]);
    assert.equal(deriveProjectPath(folder), projectPath);
  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
    fs.rmSync(projectPath, { recursive: true, force: true });
  }
});

test('returns null when folder has no .jsonl files', () => {
  const folder = makeTmpDir();
  try {
    assert.equal(deriveProjectPath(folder), null);
  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

test('returns null when .jsonl has no cwd field', () => {
  const folder = makeTmpDir();
  try {
    writeJsonl(path.join(folder, 'session.jsonl'), [
      { type: 'user', message: 'no cwd here' },
    ]);
    assert.equal(deriveProjectPath(folder), null);
  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

test('derives path from .jsonl inside a UUID subdirectory', () => {
  const folder = makeTmpDir();
  const projectPath = makeTmpDir();
  try {
    const subDir = path.join(folder, 'some-uuid-subdir');
    fs.mkdirSync(subDir);
    writeJsonl(path.join(subDir, 'session.jsonl'), [
      { type: 'user', message: 'nested', cwd: projectPath },
    ]);
    assert.equal(deriveProjectPath(folder), projectPath);
  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
    fs.rmSync(projectPath, { recursive: true, force: true });
  }
});

test('returns null for nonexistent folder', () => {
  assert.equal(deriveProjectPath('/nonexistent/path/that/does/not/exist'), null);
});

test('picks first valid cwd when multiple .jsonl files exist', () => {
  const folder = makeTmpDir();
  const projectPath = makeTmpDir();
  try {
    writeJsonl(path.join(folder, 'session-a.jsonl'), [
      { type: 'user', message: 'first', cwd: projectPath },
    ]);
    writeJsonl(path.join(folder, 'session-b.jsonl'), [
      { type: 'user', message: 'second', cwd: '/some/other/path' },
    ]);
    const result = deriveProjectPath(folder);
    assert.ok(result !== null, 'should return a non-null path');
  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
    fs.rmSync(projectPath, { recursive: true, force: true });
  }
});
