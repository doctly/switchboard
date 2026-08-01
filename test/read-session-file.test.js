const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { readSessionFile } = require('../read-session-file');

const FOLDER = 'test-folder';
const PROJECT = 'C:/test/project';

function line(obj) {
  return JSON.stringify(obj) + '\n';
}

/** A session file with `n` user/assistant pairs, padded so it is worth measuring. */
function buildSession(n, pad = 2000) {
  let out = line({ type: 'user', slug: 'my-slug', message: 'first question' });
  for (let i = 0; i < n; i++) {
    out += line({ type: 'assistant', message: { content: 'answer ' + i + ' ' + 'x'.repeat(pad) } });
    out += line({ type: 'user', message: 'question ' + i + ' ' + 'y'.repeat(pad) });
  }
  return out;
}

function withTmp(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-read-session-'));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('an appended session is re-indexed by reading only the appended bytes', () => {
  withTmp((dir) => {
    const file = path.join(dir, 'session.jsonl');
    fs.writeFileSync(file, buildSession(40), 'utf8');
    const sizeBefore = fs.statSync(file).size;

    const first = readSessionFile(file, FOLDER, PROJECT);
    assert.ok(first, 'first pass should return a session');
    assert.ok(first.indexedBytes > 0, 'first pass must report how far it indexed');

    const appended = line({ type: 'assistant', message: { content: 'a late answer' } });
    fs.appendFileSync(file, appended, 'utf8');

    const incremental = readSessionFile(file, FOLDER, PROJECT, first);

    // The whole point: the second pass must not re-read the file from the start.
    assert.ok(
      incremental.bytesRead < sizeBefore / 10,
      `incremental pass read ${incremental.bytesRead} bytes of a ${sizeBefore}-byte file — ` +
      'it re-read the whole file instead of only the tail'
    );
  });
});

test('incremental indexing yields the same session as a full re-read', () => {
  withTmp((dir) => {
    const file = path.join(dir, 'session.jsonl');
    fs.writeFileSync(file, buildSession(12), 'utf8');

    const first = readSessionFile(file, FOLDER, PROJECT);

    fs.appendFileSync(file, line({ type: 'assistant', message: { content: 'tail answer' } }), 'utf8');
    fs.appendFileSync(file, line({ type: 'ai-title', aiTitle: 'A Generated Title' }), 'utf8');
    fs.appendFileSync(file, line({ type: 'custom-title', customTitle: 'My Rename' }), 'utf8');

    const incremental = readSessionFile(file, FOLDER, PROJECT, first);
    const full = readSessionFile(file, FOLDER, PROJECT);

    for (const field of ['summary', 'messageCount', 'slug', 'customTitle', 'aiTitle', 'textContent']) {
      assert.deepEqual(incremental[field], full[field], `field "${field}" diverged from a full re-read`);
    }
  });
});

test('a rewritten file falls back to a full re-read instead of resuming', () => {
  withTmp((dir) => {
    const file = path.join(dir, 'session.jsonl');
    fs.writeFileSync(file, buildSession(10), 'utf8');
    const first = readSessionFile(file, FOLDER, PROJECT);

    // Same path, different content (e.g. Claude Code compacted the session).
    // Resuming from the old offset here would produce a corrupt message count.
    fs.writeFileSync(file, buildSession(10).replace('first question', 'a different opening'), 'utf8');

    const after = readSessionFile(file, FOLDER, PROJECT, first);
    const full = readSessionFile(file, FOLDER, PROJECT);

    assert.equal(after.summary, full.summary, 'stale head was not detected — resumed on a rewritten file');
    assert.equal(after.messageCount, full.messageCount);
  });
});

test('a single-message file with no trailing newline is still indexed', () => {
  withTmp((dir) => {
    const file = path.join(dir, 'session.jsonl');
    fs.writeFileSync(file, JSON.stringify({ type: 'user', message: 'only message' }), 'utf8');

    const s = readSessionFile(file, FOLDER, PROJECT);
    assert.ok(s, 'a file whose last line lacks a newline must not vanish from the sidebar');
    assert.equal(s.messageCount, 1);
  });
});
