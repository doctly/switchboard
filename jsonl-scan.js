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
 */
function scanLines(filePath, startByte, onLine) {
  let fd = null;
  let consumed = startByte;
  let read = 0;
  let tail = '';
  let stopped = false;

  try {
    fd = fs.openSync(filePath, 'r');
    const buf = Buffer.allocUnsafe(CHUNK_BYTES);
    let pending = Buffer.alloc(0);
    let pos = startByte;
    let n;

    while ((n = fs.readSync(fd, buf, 0, CHUNK_BYTES, pos)) > 0) {
      pos += n;
      read += n;
      // `pending` carries the partial line from the previous chunk, so `data`
      // always starts at offset `consumed`. That is what keeps the byte
      // accounting exact across chunk boundaries and multi-byte UTF-8.
      const data = pending.length
        ? Buffer.concat([pending, buf.subarray(0, n)])
        : Buffer.from(buf.subarray(0, n));

      let from = 0;
      let nl;
      while ((nl = data.indexOf(0x0A, from)) !== -1) {
        if (nl > from && onLine(data.toString('utf8', from, nl)) === false) {
          consumed += nl - from + 1;
          stopped = true;
          return { consumed, read, tail: '', stopped };
        }
        consumed += nl - from + 1;
        from = nl + 1;
      }
      pending = data.subarray(from);
    }

    if (pending.length) tail = pending.toString('utf8');
  } catch {
    // Fall through with whatever was gathered — callers treat this as "no data".
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch {}
    }
  }

  return { consumed, read, tail, stopped };
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
