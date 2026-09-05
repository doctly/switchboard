// Claude Code harness.
//
// Owns everything that is specific to how the `claude` CLI stores sessions on
// disk and how it is launched:
//
//   - transcript layout: ~/.claude/projects/<encoded-project>/<sessionId>.jsonl
//   - transcript format: one JSON object per line
//   - launch flags: --session-id / --resume / --fork-session / …
//
// Nothing outside this file should assume any of that. See harnesses/index.js
// for the shape every harness implements.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { scanLines } = require('../jsonl-scan');
const { encodeProjectPath } = require('../encode-project-path');

const id = 'claude';
const label = 'Claude';
const binary = 'claude';

// Claude owns the unprefixed folder namespace: a key is the encoded project
// path exactly as it sits in ~/.claude/projects. Harnesses added later carry a
// prefix so their keys can never be mistaken for one of these — encodeProjectPath
// emits [a-zA-Z0-9-] only, so any key containing a '/' is unambiguously theirs.
const folderPrefix = null;

// A Claude folder IS a project: every transcript in it shares one cwd, so the
// project is derived once per folder rather than per file.
const groupsByProject = true;

// --- Layout ---

function sessionsRoot() {
  return path.join(os.homedir(), '.claude', 'projects');
}

/**
 * Is there anything to index here?
 *
 * Deliberately NOT a check for the binary on PATH: the packaged app inherits a
 * minimal environment from the Dock, while sessions are launched through a
 * login shell that sources the user's profile — so the main process's PATH is
 * not the PATH a session actually runs under, and probing it reported every CLI
 * as missing. Whether a CLI can be started is left to the launch itself, which
 * surfaces the shell's own error.
 */
function available() {
  return fs.existsSync(sessionsRoot());
}

/** Folder keys under sessionsRoot(). For Claude these are encoded project paths. */
function listFolders() {
  try {
    return fs.readdirSync(sessionsRoot(), { withFileTypes: true })
      .filter(d => d.isDirectory() && d.name !== '.git')
      .map(d => d.name);
  } catch {
    return [];
  }
}

function folderPath(folder) {
  return path.join(sessionsRoot(), folder);
}

/** Which folder a project's sessions live in. */
function folderForProject(projectPath) {
  return encodeProjectPath(projectPath);
}

/** Transcript files inside a folder directory, as absolute paths. */
function listTranscripts(dir) {
  try {
    return fs.readdirSync(dir)
      .filter(f => f.endsWith('.jsonl'))
      .map(f => path.join(dir, f));
  } catch {
    return [];
  }
}

/**
 * Absolute transcript path for a cached row. `sessionFile` is authoritative
 * when present; rows written before that column existed reconstruct the path
 * from folder + sessionId, which is exactly how Claude names its files.
 */
/** Claude names each transcript after its session id. */
function sessionIdFromPath(filePath) {
  return path.basename(filePath, '.jsonl');
}

function transcriptPath({ sessionId, folder, sessionFile }) {
  if (sessionFile) return sessionFile;
  return path.join(folderPath(folder), sessionId + '.jsonl');
}

// --- Project path derivation ---

function extractCwdFromJsonl(filePath) {
  let cwd = null;
  const readCwd = (line) => {
    try {
      const entry = JSON.parse(line);
      if (entry.cwd) { cwd = entry.cwd; return false; }
    } catch {}
  };
  try {
    const { tail } = scanLines(filePath, 0, readCwd);
    if (!cwd && tail) readCwd(tail);
  } catch { return null; }
  return cwd;
}

/** The project a folder belongs to, read out of any transcript it contains. */
function deriveProjectPath(folderPath) {
  try {
    const entries = fs.readdirSync(folderPath, { withFileTypes: true });
    // Check direct .jsonl files first
    for (const e of entries) {
      if (e.isFile() && e.name.endsWith('.jsonl')) {
        const cwd = extractCwdFromJsonl(path.join(folderPath, e.name));
        if (cwd) return cwd;
      }
    }
    // Check session subdirectories (UUID folders with subagent .jsonl files)
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const subDir = path.join(folderPath, e.name);
      try {
        const subFiles = fs.readdirSync(subDir, { withFileTypes: true });
        for (const sf of subFiles) {
          let jsonlPath;
          if (sf.isFile() && sf.name.endsWith('.jsonl')) {
            jsonlPath = path.join(subDir, sf.name);
          } else if (sf.isDirectory() && sf.name === 'subagents') {
            const agentFiles = fs.readdirSync(path.join(subDir, 'subagents')).filter(f => f.endsWith('.jsonl'));
            if (agentFiles.length > 0) jsonlPath = path.join(subDir, 'subagents', agentFiles[0]);
          }
          if (jsonlPath) {
            const cwd = extractCwdFromJsonl(jsonlPath);
            if (cwd) return cwd;
          }
        }
      } catch {}
    }
  } catch {}
  return null;
}

// --- New-session detection ---
//
// A fresh Claude session is told its id up front (--session-id), so nothing has
// to be detected. A FORK is not: `--fork-session` makes Claude mint its own id,
// so the session is launched under a temporary one and matched to the
// transcript afterwards, exactly as codex sessions are.

/** Only a fork needs its real id discovered; everything else pre-assigns one. */
function needsIdDetection({ options }) {
  return !!options?.forkFrom;
}

/**
 * Read the head of a transcript for the signals that identify a fork.
 *
 * Reads a bounded chunk rather than the file: a fork's first lines can include
 * file-history snapshots tens of kilobytes long, and this runs for every file
 * the watcher reports.
 */
function readLaunchSignals(filePath) {
  let head;
  try {
    const fd = fs.openSync(filePath, 'r');
    try {
      const buf = Buffer.alloc(524288);
      const bytes = fs.readSync(fd, buf, 0, buf.length, 0);
      head = buf.toString('utf8', 0, bytes);
    } finally {
      fs.closeSync(fd);
    }
  } catch { return null; }

  let forkedFrom = null;
  let cwd = null;
  let startedAt = null;
  for (const line of head.split('\n')) {
    if (!line) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; } // a truncated tail line
    if (entry.type === 'file-history-snapshot') continue;
    if (!forkedFrom && entry.forkedFrom?.sessionId) forkedFrom = entry.forkedFrom.sessionId;
    if (!cwd && entry.cwd) cwd = entry.cwd;
    if (!startedAt && entry.timestamp) startedAt = entry.timestamp;
    if (entry.type === 'user' || entry.type === 'assistant') break;
  }

  return {
    sessionId: sessionIdFromPath(filePath),
    originator: null, // Claude has no equivalent of codex's originator tag
    forkedFrom,
    cwd,
    startedAt,
    isSubagent: false, // subagent transcripts live in a subdirectory we never scan
  };
}

// A transcript written slightly before the spawn timestamp is still plausibly
// ours: the two clocks are not the same source.
const SPAWN_SKEW_MS = 5000;

/**
 * Does this transcript belong to the fork we just launched?
 *
 * Matched on the parent id it records, which is unambiguous — unlike a
 * heuristic on file mtime, several forks of one parent stay distinguishable by
 * the spawn time, and a pre-existing fork of the same parent is excluded.
 */
function matchesLaunch(signals, { forkFrom, spawnedAt }) {
  if (!signals || !signals.sessionId || !forkFrom) return false;
  if (signals.forkedFrom !== forkFrom) return false;
  if (!signals.startedAt) return false;
  const started = Date.parse(signals.startedAt);
  return Number.isFinite(started) && started >= spawnedAt - SPAWN_SKEW_MS;
}

// --- Transcript parsing ---

const HEAD_BYTES = 4096;          // guard window for append-only transcripts
const TEXT_CONTENT_CAP = 8000;    // how much body text the search index keeps
const TEXT_LINE_CAP = 500;

function hashHead(fd, stat) {
  const n = Math.min(HEAD_BYTES, stat.size);
  if (n === 0) return '';
  const buf = Buffer.allocUnsafe(n);
  if (fs.readSync(fd, buf, 0, n, 0) !== n) throw new Error('JSONL head changed during read');
  // Version the state: pre-harness rows lack raw timestamp accumulators.
  // Include file identity so an atomic replacement with the same prefix resets.
  return 'v2:' + crypto.createHash('sha1')
    .update(`${stat.dev}:${stat.ino}:`).update(buf).digest('hex');
}

/** Accumulator. Every field is either a first-occurrence or a running total,
 *  which is what makes resuming mid-file valid. */
function emptyState() {
  return { summary: '', messageCount: 0, textContent: '', slug: null, customTitle: null, aiTitle: null, firstTimestamp: null, lastTimestamp: null };
}

function stateFrom(prev) {
  return {
    summary: prev.summary || '',
    messageCount: prev.messageCount || 0,
    textContent: prev.textContent || '',
    slug: prev.slug || null,
    customTitle: prev.customTitle || null,
    aiTitle: prev.aiTitle || null,
    firstTimestamp: prev.firstTimestamp || null,
    lastTimestamp: prev.lastTimestamp || null,
  };
}

function applyLine(line, st) {
  let entry;
  try { entry = JSON.parse(line); } catch { return; }

  if (entry.timestamp) {
    if (!st.firstTimestamp || entry.timestamp < st.firstTimestamp) st.firstTimestamp = entry.timestamp;
    if (!st.lastTimestamp || entry.timestamp > st.lastTimestamp) st.lastTimestamp = entry.timestamp;
  }

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
 * Parse metadata in bounded chunks. A cached row lets append-only transcripts
 * resume at the previous newline instead of re-reading their entire history.
 * Head changes, replacement, truncation, or a changed file with no growth reset
 * the accumulator. In-place edits beyond the head while also growing the file
 * are outside this append-only contract; a full re-index is needed for those.
 */
function readSessionFile(filePath, folder, projectPath, prev = null) {
  const sessionId = path.basename(filePath, '.jsonl');
  let fd = null;
  try {
    fd = fs.openSync(filePath, 'r');
    const stat = fs.fstatSync(fd);
    const fileMtime = stat.mtime.toISOString();
    const headHash = hashHead(fd, stat);
    const canResume = !!prev && !!headHash
      && prev.runtime === id && prev.sessionId === sessionId
      && prev.sessionFile === filePath && prev.headHash === headHash
      && Number.isSafeInteger(prev.indexedBytes) && prev.indexedBytes > 0
      && prev.indexedBytes <= stat.size
      && (prev.indexedBytes < stat.size || prev.fileMtime === fileMtime);
    const st = canResume ? stateFrom(prev) : emptyState();
    const start = canResume ? prev.indexedBytes : 0;
    // Hash and scan the same descriptor and only the size captured above.
    // Concurrent appends are left for the next pass; read errors return null
    // rather than saving partial metadata under a supposedly up-to-date mtime.
    const { consumed, read, tail } = scanLines(fd, start, line => applyLine(line, st), stat.size);
    if (tail) applyLine(tail, st);
    const after = fs.fstatSync(fd);
    if (after.size < stat.size || (after.size === stat.size && after.mtimeMs !== stat.mtimeMs)) return null;
    if (!st.summary || st.messageCount < 1) return null;
    return {
      sessionId, folder, projectPath, runtime: id, sessionFile: filePath,
      summary: st.summary, firstPrompt: st.summary,
      created: st.firstTimestamp || stat.birthtime.toISOString(),
      modified: st.lastTimestamp || fileMtime,
      fileMtime,
      messageCount: st.messageCount, textContent: st.textContent,
      slug: st.slug, customTitle: st.customTitle, aiTitle: st.aiTitle,
      firstTimestamp: st.firstTimestamp, lastTimestamp: st.lastTimestamp,
      headHash,
      // A complete JSON value without a newline is displayed but cannot be
      // accumulated safely: re-read it next time instead of double-counting it.
      indexedBytes: tail ? 0 : consumed,
      bytesRead: read + Math.min(HEAD_BYTES, stat.size),
    };
  } catch {
    return null;
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch {} }
  }
}

/**
 * Transcript records as the JSONL viewer wants them.
 *
 * Claude's own format IS the viewer's format — the viewer was written against
 * it — so this is identity. It exists so the viewer never has to know which
 * CLI wrote the file it is showing.
 */
function toViewerEntries(entries) {
  return entries;
}

// --- Activity signalling ---

// Claude marks a working session by prefixing its terminal title with a spinner
// frame, and an idle one with U+2733. Versions through 2.1.227 used braille;
// 2.1.228+ use the four rotating half-circle glyphs U+25D0-U+25D3.
const SPINNER_MIN = 0x2800, SPINNER_MAX = 0x28FF;
const HALF_CIRCLE_MIN = 0x25D0, HALF_CIRCLE_MAX = 0x25D3;
const IDLE_MARK = '\u2733'; // ✳

/** What an OSC 0 title says about the session: 'busy', 'idle', or nothing. */
function parseTitleState(title) {
  const first = String(title || '').charAt(0);
  if (!first) return null;
  const code = first.charCodeAt(0);
  if ((code >= SPINNER_MIN && code <= SPINNER_MAX) ||
      (code >= HALF_CIRCLE_MIN && code <= HALF_CIRCLE_MAX)) return 'busy';
  if (first === IDLE_MARK) return 'idle';
  return null;
}

/**
 * What an OSC 9 notification means.
 *
 * 'attention' — the session is blocked on the user
 * 'idle'      — the turn finished and a response is waiting to be read
 */
function classifyNotification(message) {
  const text = String(message || '');
  // "Claude Code needs your attention", "…needs your approval for the plan",
  // "Claude needs your permission to use {tool}", "…wants to enter plan mode"
  if (/attention|approval|permission|needs your|wants to enter/i.test(text)) return 'attention';
  // "Claude is waiting for your input" — a delayed idle notification
  if (/waiting for your input/i.test(text)) return 'idle';
  return null;
}

// --- Launch ---

/**
 * Argv for the claude binary. Returned as an array so the caller can quote it
 * for the target shell rather than building a command string here.
 */
function buildLaunchArgs({ sessionId, isNew, options }) {
  const args = [];
  if (options?.forkFrom) {
    args.push('--resume', String(options.forkFrom), '--fork-session');
  } else if (isNew) {
    args.push('--session-id', String(sessionId));
  } else {
    args.push('--resume', String(sessionId));
  }

  if (options) {
    if (options.dangerouslySkipPermissions) {
      args.push('--dangerously-skip-permissions');
    } else if (options.permissionMode) {
      args.push('--permission-mode', String(options.permissionMode));
    }
    // --worktree only applies when STARTING a session — it creates a fresh
    // isolated git worktree. Resuming (isNew === false) must reuse the
    // session's existing directory, so ignore the worktree option on resume
    // regardless of which call site supplied it (sidebar click, schedule
    // creator, fork, …). Otherwise a resume tries to spin up a new worktree
    // and fails to attach.
    if (isNew && options.worktree) {
      args.push('--worktree');
      if (options.worktreeName) {
        args.push(String(options.worktreeName));
      }
    }
    if (options.chrome) {
      args.push('--chrome');
    }
    if (options.addDirs) {
      const dirs = String(options.addDirs).split(',').map(d => d.trim()).filter(Boolean);
      for (const dir of dirs) {
        args.push('--add-dir', dir);
      }
    }
  }

  if (options?.appendSystemPrompt) {
    args.push('--append-system-prompt', String(options.appendSystemPrompt));
  }

  return args;
}

module.exports = {
  id, label, binary, folderPrefix, groupsByProject,
  available, sessionsRoot, listFolders, folderPath, folderForProject,
  listTranscripts, sessionIdFromPath, transcriptPath,
  deriveProjectPath,
  readSessionFile, toViewerEntries,
  needsIdDetection, readLaunchSignals, matchesLaunch,
  parseTitleState, classifyNotification,
  buildLaunchArgs,
};
