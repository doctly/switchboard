const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { scanLines } = require('./jsonl-scan');

// Session .jsonl files are append-only and can reach hundreds of MB, while the
// metadata we extract from them is a few KB. Reading one whole file into a JS
// string costs ~2x its size in RAM (V8 stores non-latin1 text as UTF-16), and
// the projects watcher re-triggers that read on every append. So we read in
// fixed-size chunks and, when the caller hands us the previously indexed row,
// resume from where that pass stopped instead of starting over.

const HEAD_BYTES = 4096;          // guard window — detects a file rewritten in place
const TEXT_CONTENT_CAP = 8000;    // how much body text the search index keeps
const TEXT_LINE_CAP = 500;

function hashHead(fd, size) {
  const n = Math.min(HEAD_BYTES, size);
  if (n === 0) return '';
  const buf = Buffer.allocUnsafe(n);
  fs.readSync(fd, buf, 0, n, 0);
  return crypto.createHash('sha1').update(buf).digest('hex');
}

/** Accumulator. Every field is either a first-occurrence or a running total,
 *  which is what makes resuming mid-file valid. */
function emptyState() {
  return { summary: '', messageCount: 0, textContent: '', slug: null, customTitle: null, aiTitle: null };
}

function stateFrom(prev) {
  return {
    summary: prev.summary || '',
    messageCount: prev.messageCount || 0,
    textContent: prev.textContent || '',
    slug: prev.slug || null,
    customTitle: prev.customTitle || null,
    aiTitle: prev.aiTitle || null,
  };
}

function applyLine(line, st) {
  let entry;
  try { entry = JSON.parse(line); } catch { return; }

  if (entry.slug && !st.slug) st.slug = entry.slug;
  if (entry.type === 'custom-title' && entry.customTitle) st.customTitle = entry.customTitle;
  if (entry.type === 'ai-title' && entry.aiTitle) st.aiTitle = entry.aiTitle;

  if (entry.type === 'user' || entry.type === 'assistant' ||
      (entry.type === 'message' && (entry.role === 'user' || entry.role === 'assistant'))) {
    st.messageCount++;
  }

  const msg = entry.message;
  const text = typeof msg === 'string' ? msg :
    (typeof msg?.content === 'string' ? msg.content :
    (msg?.content?.[0]?.text || ''));

  if (!st.summary && (entry.type === 'user' || (entry.type === 'message' && entry.role === 'user'))) {
    // Skip local command messages (! prefix) — use the next real user message
    if (text && !/<bash-input>|<bash-stdout>|<local-command-caveat>/.test(text)) {
      // Use scheduled task name if present
      const taskMatch = text.match(/<scheduled-task\s+name="([^"]+)"/);
      st.summary = taskMatch ? 'Scheduled: ' + taskMatch[1] : text.slice(0, 120);
    }
  }

  if (text && st.textContent.length < TEXT_CONTENT_CAP) {
    st.textContent += text.slice(0, TEXT_LINE_CAP) + '\n';
  }
}

/**
 * Parse a .jsonl session file into a session object (or null if invalid).
 *
 * @param prev  the previously indexed row for this session, if any. When it
 *              carries a matching `headHash` and an `indexedBytes` offset, only
 *              the bytes appended since then are read.
 *
 * Returns `indexedBytes` (resume point for the next pass, 0 when resuming would
 * be unsafe) and `bytesRead` (what this pass actually read off disk).
 */
function readSessionFile(filePath, folder, projectPath, prev = null) {
  const sessionId = path.basename(filePath, '.jsonl');
  let fd = null;
  try {
    const stat = fs.statSync(filePath);
    fd = fs.openSync(filePath, 'r');
    const headHash = hashHead(fd, stat.size);

    // Resume only if this is demonstrably the same file, grown. A rewrite (a
    // compacted session) changes the head; a truncation shrinks it below the
    // offset. Either way we start over rather than emit a corrupt count.
    const canResume = !!prev
      && !!headHash
      && prev.headHash === headHash
      && Number.isFinite(prev.indexedBytes)
      && prev.indexedBytes > 0
      && prev.indexedBytes <= stat.size;

    const st = canResume ? stateFrom(prev) : emptyState();
    const start = canResume ? prev.indexedBytes : 0;

    const { consumed, read, tail } = scanLines(filePath, start, (line) => applyLine(line, st));

    // A trailing line with no newline is either a write caught in flight or a
    // file that simply ends without one. Parse it so a single-message session
    // still appears, but refuse to resume past it — the next pass would
    // otherwise count that line a second time.
    let resumable = true;
    if (tail) {
      applyLine(tail, st);
      resumable = false;
    }

    if (!st.summary || st.messageCount < 1) return null;

    return {
      sessionId, folder, projectPath,
      summary: st.summary, firstPrompt: st.summary,
      created: stat.birthtime.toISOString(),
      modified: stat.mtime.toISOString(),
      messageCount: st.messageCount,
      textContent: st.textContent,
      slug: st.slug,
      customTitle: st.customTitle,
      aiTitle: st.aiTitle,
      headHash,
      indexedBytes: resumable ? consumed : 0,
      bytesRead: read,
    };
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch {}
    }
  }
}

module.exports = { readSessionFile };
