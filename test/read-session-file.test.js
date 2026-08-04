const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { readSessionFile } = require('../read-session-file');

function makeTmpSession(lines) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-session-'));
  const file = path.join(dir, 'abc123.jsonl');
  fs.writeFileSync(file, lines.map(l => JSON.stringify(l)).join('\n') + '\n', 'utf8');
  return { dir, file };
}

test('parses a minimal valid session', () => {
  const { file, dir } = makeTmpSession([
    { type: 'user', message: 'Hello world', cwd: '/some/project', sessionId: 'abc123' },
    { type: 'assistant', message: 'Hi there' },
  ]);
  try {
    const session = readSessionFile(file, 'some-folder', '/some/project');
    assert.ok(session, 'should return a session object');
    assert.equal(session.sessionId, 'abc123');
    assert.equal(session.summary, 'Hello world');
    assert.equal(session.messageCount, 2);
    assert.equal(session.folder, 'some-folder');
    assert.equal(session.projectPath, '/some/project');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('returns null when no user messages', () => {
  const { file, dir } = makeTmpSession([
    { type: 'assistant', message: 'Only assistant' },
  ]);
  try {
    const session = readSessionFile(file, 'folder', '/path');
    assert.equal(session, null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('extracts slug from first entry that has it', () => {
  const { file, dir } = makeTmpSession([
    { type: 'user', message: 'Start', slug: 'my-task' },
    { type: 'assistant', message: 'Response' },
  ]);
  try {
    const session = readSessionFile(file, 'folder', '/path');
    assert.equal(session.slug, 'my-task');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('extracts aiTitle', () => {
  const { file, dir } = makeTmpSession([
    { type: 'user', message: 'Do something' },
    { type: 'ai-title', aiTitle: 'Generated Title' },
    { type: 'assistant', message: 'Done' },
  ]);
  try {
    const session = readSessionFile(file, 'folder', '/path');
    assert.equal(session.aiTitle, 'Generated Title');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('extracts customTitle', () => {
  const { file, dir } = makeTmpSession([
    { type: 'user', message: 'Do something' },
    { type: 'custom-title', customTitle: 'My Custom Name' },
    { type: 'assistant', message: 'Done' },
  ]);
  try {
    const session = readSessionFile(file, 'folder', '/path');
    assert.equal(session.customTitle, 'My Custom Name');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('skips local command messages for summary', () => {
  const { file, dir } = makeTmpSession([
    { type: 'user', message: '<local-command-caveat>! ls</local-command-caveat>' },
    { type: 'user', message: 'Real first message' },
    { type: 'assistant', message: 'Response' },
  ]);
  try {
    const session = readSessionFile(file, 'folder', '/path');
    assert.equal(session.summary, 'Real first message');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('returns null for empty file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-session-'));
  const file = path.join(dir, 'empty.jsonl');
  fs.writeFileSync(file, '', 'utf8');
  try {
    const session = readSessionFile(file, 'folder', '/path');
    assert.equal(session, null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('returns null for non-existent file', () => {
  const session = readSessionFile('/nonexistent/path/file.jsonl', 'folder', '/path');
  assert.equal(session, null);
});

test('uses scheduled task name in summary', () => {
  const { file, dir } = makeTmpSession([
    { type: 'user', message: '<scheduled-task name="Daily Digest">run the task</scheduled-task>' },
    { type: 'assistant', message: 'Done' },
  ]);
  try {
    const session = readSessionFile(file, 'folder', '/path');
    assert.ok(session.summary.includes('Daily Digest'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
