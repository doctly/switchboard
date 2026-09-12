const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { readSessionFile } = require('../harnesses/claude');

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

test('truncation and atomic replacement with an unchanged head reset resume state', () => {
  withTmp(dir => {
    const file = path.join(dir, 'session.jsonl');
    fs.writeFileSync(file, buildSession(40));
    const first = readSessionFile(file, FOLDER, PROJECT);
    fs.writeFileSync(file, buildSession(2));
    const truncated = readSessionFile(file, FOLDER, PROJECT, first);
    assert.equal(truncated.messageCount, 5);

    const replacement = path.join(dir, 'replacement');
    // Keep more than 4 KiB identical but change message counts beyond it.
    const content = buildSession(2) + line({ type: 'assistant', message: 'x'.repeat(200000) });
    fs.writeFileSync(replacement, content);
    fs.renameSync(replacement, file);
    const replaced = readSessionFile(file, FOLDER, PROJECT, first);
    assert.equal(replaced.messageCount, 6);
    assert.equal(replaced.messageCount, readSessionFile(file, FOLDER, PROJECT).messageCount);
  });
});

test('same-size rewrites beyond the head reset when the modification time changes', () => {
  withTmp(dir => {
    const file = path.join(dir, 'session.jsonl');
    const content = buildSession(4) + line({ type: 'ai-title', aiTitle: 'original' });
    fs.writeFileSync(file, content);
    const first = readSessionFile(file, FOLDER, PROJECT);
    fs.writeFileSync(file, content.replace('original', 'replaced'));
    const future = new Date(Date.parse(first.fileMtime) + 1000);
    fs.utimesSync(file, future, future);
    assert.equal(readSessionFile(file, FOLDER, PROJECT, first).aiTitle, 'replaced');
  });
});

test('a partial final message is not counted twice when it is completed', () => {
  withTmp(dir => {
    const file = path.join(dir, 'session.jsonl');
    fs.writeFileSync(file, buildSession(4));
    const first = readSessionFile(file, FOLDER, PROJECT);
    const append = JSON.stringify({ type: 'assistant', message: 'the final answer' });
    fs.appendFileSync(file, append.slice(0, -3));
    const partial = readSessionFile(file, FOLDER, PROJECT, first);
    assert.equal(partial.messageCount, first.messageCount);
    assert.equal(partial.indexedBytes, 0);
    fs.appendFileSync(file, append.slice(-3));
    const noNewline = readSessionFile(file, FOLDER, PROJECT, partial);
    assert.equal(noNewline.messageCount, first.messageCount + 1);
    assert.equal(noNewline.indexedBytes, 0);
    fs.appendFileSync(file, '\n');
    const completed = readSessionFile(file, FOLDER, PROJECT, noNewline);
    assert.equal(completed.messageCount, first.messageCount + 1);
    assert.equal(completed.indexedBytes, fs.statSync(file).size);
  });
});

test('incremental timestamps use message bounds rather than file-time fallbacks', () => {
  withTmp(dir => {
    const file = path.join(dir, 'session.jsonl');
    fs.writeFileSync(file, buildSession(4));
    const first = readSessionFile(file, FOLDER, PROJECT);
    assert.equal(first.firstTimestamp, null);
    fs.appendFileSync(file, line({ type: 'assistant', message: 'dated answer', timestamp: '2025-01-02T00:00:00Z' }));
    const dated = readSessionFile(file, FOLDER, PROJECT, first);
    assert.equal(dated.created, '2025-01-02T00:00:00Z');
    assert.equal(dated.modified, '2025-01-02T00:00:00Z');
    fs.appendFileSync(file, line({ type: 'user', message: 'earlier date', timestamp: '2025-01-01T00:00:00Z' }));
    fs.appendFileSync(file, line({ type: 'ai-title', aiTitle: 'new title without activity' }));
    const after = readSessionFile(file, FOLDER, PROJECT, dated);
    const full = readSessionFile(file, FOLDER, PROJECT);
    for (const field of ['created', 'modified', 'firstTimestamp', 'lastTimestamp', 'fileMtime', 'runtime', 'sessionFile']) {
      assert.equal(after[field], full[field], field);
    }
    assert.equal(after.created, '2025-01-01T00:00:00Z');
    assert.equal(after.modified, '2025-01-02T00:00:00Z');
  });
});

test('old parser state and read errors cannot produce a seemingly complete incremental result', () => {
  withTmp(dir => {
    const file = path.join(dir, 'session.jsonl');
    fs.writeFileSync(file, buildSession(100));
    const first = readSessionFile(file, FOLDER, PROJECT);
    const legacy = { ...first, headHash: first.headHash.slice(3), messageCount: 999 };
    assert.equal(readSessionFile(file, FOLDER, PROJECT, legacy).messageCount, first.messageCount);
    const read = fs.readSync;
    fs.readSync = function(fd, buf, offset, length, position) {
      if (position >= 256 * 1024) throw new Error('simulated read failure');
      return read(fd, buf, offset, length, position);
    };
    try { assert.equal(readSessionFile(file, FOLDER, PROJECT), null); }
    finally { fs.readSync = read; }
  });
});

test('cwd derivation supports an unterminated first record without reading the rest of a large file', () => {
  const { deriveProjectPath } = require('../harnesses/claude');
  withTmp(dir => {
    const file = path.join(dir, 'session.jsonl');
    const record = JSON.stringify({ type: 'user', cwd: PROJECT, message: 'hello' });
    fs.writeFileSync(file, record);
    assert.equal(deriveProjectPath(dir), PROJECT);
    fs.appendFileSync(file, '\n' + 'x'.repeat(1024 * 1024));
    const read = fs.readSync;
    let bytes = 0;
    fs.readSync = function(...args) { const n = read(...args); bytes += n; return n; };
    try {
      assert.equal(deriveProjectPath(dir), PROJECT);
      assert.ok(bytes <= 256 * 1024);
    } finally { fs.readSync = read; }
  });
});

test('capped parser state upgrades once, then appends full conversation text incrementally', () => {
  withTmp(dir => {
    const file = path.join(dir, 'session.jsonl');
    fs.writeFileSync(file, buildSession(40));
    const first = readSessionFile(file, FOLDER, PROJECT);
    const legacy = { ...first, headHash: 'v2:' + first.headHash.slice(3),
      textContent: first.textContent.slice(0, 8000) + '\ntool_output_marker' };
    fs.appendFileSync(file, line({ type: 'assistant', message: 'upgrade reply' }));

    const upgraded = readSessionFile(file, FOLDER, PROJECT, legacy);
    assert.equal(upgraded.textContent, readSessionFile(file, FOLDER, PROJECT).textContent);
    assert.ok(upgraded.textContent.length > 8000);
    assert.ok(upgraded.bytesRead >= fs.statSync(file).size, 'legacy state needs one full read');

    const answer = 'a'.repeat(600) + ' move_fna_lines';
    fs.appendFileSync(file, line({ type: 'assistant', message: { content: [
      { type: 'thinking', text: 'thinking_marker' },
      { type: 'text', text: answer },
      { type: 'tool_use', input: { command: 'tool_input_marker' } },
      { type: 'text', text: 'second_block_marker' },
    ] } }));
    fs.appendFileSync(file, line({ type: 'user', message: { content: [
      { type: 'tool_result', content: [{ type: 'text', text: 'tool_output_marker' }] },
    ] } }));
    fs.appendFileSync(file, line({ type: 'system', message: 'system_marker' }));

    const incremental = readSessionFile(file, FOLDER, PROJECT, upgraded);
    assert.equal(incremental.textContent, upgraded.textContent + '\n' + answer + '\nsecond_block_marker');
    assert.equal(incremental.textContent, readSessionFile(file, FOLDER, PROJECT).textContent);
    assert.ok(incremental.bytesRead < upgraded.indexedBytes / 10, 'later changes must resume incrementally');
  });
});
