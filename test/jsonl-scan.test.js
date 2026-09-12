const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { scanLines, readHead } = require('../jsonl-scan');

function withFile(content, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-jsonl-scan-'));
  const file = path.join(dir, 'session.jsonl');
  try { fs.writeFileSync(file, content); fn(file); }
  finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

test('scanLines preserves UTF-8 across a chunk boundary and exact resume offsets', () => {
  const first = 'x'.repeat(256 * 1024 - 1) + '😀';
  withFile(first + '\n\nsecond\npartial', file => {
    const lines = [];
    const scan = scanLines(file, 0, line => { lines.push(line); });
    assert.deepEqual(lines, [first, 'second']);
    assert.equal(scan.consumed, Buffer.byteLength(first + '\n\nsecond\n'));
    assert.equal(scan.tail, 'partial');
    fs.appendFileSync(file, '-finished\n');
    const appended = [];
    const next = scanLines(file, scan.consumed, line => { appended.push(line); });
    assert.deepEqual(appended, ['partial-finished']);
    assert.equal(next.consumed, fs.statSync(file).size);
  });
});

test('multi-megabyte lines require linear rather than quadratic buffer copying', () => {
  const longLine = 'x'.repeat(3 * 1024 * 1024);
  withFile(longLine + '\n', file => {
    const concat = Buffer.concat;
    let copiedBytes = 0;
    Buffer.concat = function(list, ...args) {
      copiedBytes += list.reduce((n, b) => n + b.length, 0);
      return concat.call(Buffer, list, ...args);
    };
    try {
      const lines = [];
      scanLines(file, 0, line => { lines.push(line); });
      assert.deepEqual(lines, [longLine]);
      assert.ok(copiedBytes <= 2 * longLine.length, `${copiedBytes} bytes copied for ${longLine.length} bytes`);
    } finally { Buffer.concat = concat; }
  });
});

test('early exit and readHead do not read an entire large transcript', () => {
  withFile('first\n' + 'x'.repeat(1024 * 1024), file => {
    const scan = scanLines(file, 0, () => false);
    assert.equal(scan.consumed, 6);
    assert.equal(scan.stopped, true);
    assert.ok(scan.read <= 256 * 1024);
    assert.equal(readHead(file, 5), 'first');
  });
});

test('a scan stops at its initial size even when the callback appends', () => {
  withFile('first\n', file => {
    const lines = [];
    const scan = scanLines(file, 0, line => {
      lines.push(line);
      fs.appendFileSync(file, 'later\n');
    });
    assert.deepEqual(lines, ['first']);
    assert.equal(scan.consumed, 6);
    const later = [];
    scanLines(file, scan.consumed, line => { later.push(line); });
    assert.deepEqual(later, ['later']);
  });
});

test('read errors propagate instead of returning a successful partial scan', () => {
  withFile('first\n' + 'x'.repeat(512 * 1024), file => {
    const read = fs.readSync;
    fs.readSync = function(fd, buf, offset, length, position) {
      if (position >= 256 * 1024) throw new Error('simulated read failure');
      return read(fd, buf, offset, length, position);
    };
    try { assert.throws(() => scanLines(file, 0, () => {}), /simulated read failure/); }
    finally { fs.readSync = read; }
  });
});

test('truncation during a bounded scan fails and leaves a borrowed descriptor open', () => {
  withFile('first\n' + 'x'.repeat(512 * 1024), file => {
    const fd = fs.openSync(file, 'r');
    try {
      assert.throws(() => scanLines(fd, 0, () => { fs.truncateSync(file, 6); }), /truncated/);
      assert.equal(fs.fstatSync(fd).size, 6);
    } finally { fs.closeSync(fd); }
  });
});
