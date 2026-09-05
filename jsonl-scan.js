const fs = require('fs');

// Session .jsonl files routinely reach tens or hundreds of MB. Reading one into
// a JS string costs ~2x its size in RAM (V8 stores non-latin1 text as UTF-16),
// so any code that wants the first line — or one field — must not use
// readFileSync. These two helpers are the supported way to walk such a file.

const CHUNK_BYTES = 256 * 1024;

/**
 * Walk the complete lines of a file from `startByte`, holding at most one chunk
 * (plus the current line) in memory.
 *
 * `onLine(line)` may return false to stop early — useful when the caller only
 * needs the first line carrying some field.
 *
 * Returns:
 *   consumed — offset just past the last complete line (a resume point)
 *   read     — bytes actually pulled off disk
 *   tail     — trailing bytes with no newline; NOT counted in `consumed`,
 *              because a partial line will be re-read on the next pass
 *   stopped  — whether onLine asked to stop
 *
 * Accepts a path or an already-open descriptor. Reads only through endByte
 * (default: the size at entry), so appends cannot make a scan run forever.
 * I/O errors propagate: callers must not persist a partial scan as complete.
 */
function scanLines(filePath, startByte, onLine, endByte) {
  const ownsFd = typeof filePath !== 'number';
  const fd = ownsFd ? fs.openSync(filePath, 'r') : filePath;
  let consumed = startByte;
  let read = 0;
  try {
    if (endByte === undefined) endByte = fs.fstatSync(fd).size;
    let pending = [];
    let pendingBytes = 0;
    let pos = startByte;
    while (pos < endByte) {
      // Each chunk owns its bytes. Pending slices never alias a reused buffer.
      const buf = Buffer.allocUnsafe(Math.min(CHUNK_BYTES, endByte - pos));
      const n = fs.readSync(fd, buf, 0, buf.length, pos);
      if (n === 0) throw new Error('JSONL file truncated during scan');
      read += n;
      let from = 0;
      let nl;
      const data = buf.subarray(0, n);
      while ((nl = data.indexOf(0x0A, from)) !== -1) {
        const piece = data.subarray(from, nl);
        // Concatenate once per line, avoiding quadratic copies of long lines.
        const line = pendingBytes
          ? Buffer.concat([...pending, piece], pendingBytes + piece.length).toString('utf8')
          : piece.toString('utf8');
        pending = [];
        pendingBytes = 0;
        consumed = pos + nl + 1;
        if (line && onLine(line) === false) {
          return { consumed, read, tail: '', stopped: true };
        }
        from = nl + 1;
      }
      if (from < n) {
        pending.push(data.subarray(from));
        pendingBytes += n - from;
      }
      pos += n;
    }
    const tail = pendingBytes ? Buffer.concat(pending, pendingBytes).toString('utf8') : '';
    return { consumed, read, tail, stopped: false };
  } finally {
    if (ownsFd) fs.closeSync(fd);
  }
}

/** Read at most `maxBytes` from the start of a file. Returns '' on failure. */
function readHead(filePath, maxBytes) {
  let fd = null;
  try {
    fd = fs.openSync(filePath, 'r');
    const buf = Buffer.allocUnsafe(maxBytes);
    const n = fs.readSync(fd, buf, 0, maxBytes, 0);
    return buf.toString('utf8', 0, n);
  } catch {
    return '';
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch {}
    }
  }
}

module.exports = { scanLines, readHead };
