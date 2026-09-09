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
  try {
    const lines = fs.readFileSync(filePath, 'utf8').split('\n');
    for (const line of lines) {
      if (!line) continue;
      try {
        const parsed = JSON.parse(line);
        if (parsed.cwd) return parsed.cwd;
      } catch {}
    }
  } catch {}
  return null;
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

/** Parse a single .jsonl file into a session object (or null if invalid) */
function readSessionFile(filePath, folder, projectPath) {
  const sessionId = path.basename(filePath, '.jsonl');
  try {
    const stat = fs.statSync(filePath);
    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.split('\n').filter(Boolean);
    let summary = '';
    let messageCount = 0;
    const textParts = [];
    let slug = null;
    let customTitle = null;
    let aiTitle = null;
    // Real conversation time bounds. Resuming a session appends untimestamped
    // bookkeeping records (last-prompt, mode, ai-title, …) which bump the file's
    // mtime without any actual activity, so mtime can't be the displayed time.
    let firstTimestamp = null;
    let lastTimestamp = null;
    for (const line of lines) {
      const entry = JSON.parse(line);
      if (entry.timestamp) {
        // ISO-8601 UTC strings — lexicographic comparison is chronological
        if (!firstTimestamp || entry.timestamp < firstTimestamp) firstTimestamp = entry.timestamp;
        if (!lastTimestamp || entry.timestamp > lastTimestamp) lastTimestamp = entry.timestamp;
      }
      if (entry.slug && !slug) slug = entry.slug;
      if (entry.type === 'custom-title' && entry.customTitle) {
        customTitle = entry.customTitle;
      }
      if (entry.type === 'ai-title' && entry.aiTitle) {
        aiTitle = entry.aiTitle;
      }
      const isConversationMessage = entry.type === 'user' || entry.type === 'assistant' ||
        (entry.type === 'message' && (entry.role === 'user' || entry.role === 'assistant'));
      if (isConversationMessage) {
        messageCount++;
      }
      const msg = entry.message;
      const text = typeof msg === 'string' ? msg :
        (typeof msg?.content === 'string' ? msg.content :
        (Array.isArray(msg?.content) ? msg.content
          .filter(block => block?.type === 'text' && typeof block.text === 'string')
          .map(block => block.text).join('\n') : ''));
      if (!summary && (entry.type === 'user' || (entry.type === 'message' && entry.role === 'user'))) {
        // Skip local command messages (! prefix) — use the next real user message
        if (text && !/<bash-input>|<bash-stdout>|<local-command-caveat>/.test(text)) {
          // Use scheduled task name if present
          const taskMatch = text.match(/<scheduled-task\s+name="([^"]+)"/);
          summary = taskMatch ? 'Scheduled: ' + taskMatch[1] : text.slice(0, 120);
        }
      }
      // Search the entire conversation, including every text block. Tool
      // inputs/results, thinking and non-message records are not conversation.
      if (isConversationMessage && text) textParts.push(text);
    }
    if (!summary || messageCount < 1) return null;
    return {
      sessionId, folder, projectPath,
      runtime: id,
      sessionFile: filePath,
      summary, firstPrompt: summary,
      // created/modified are display+sort values from message timestamps;
      // fileMtime is the cache-invalidation key (compared against stat.mtime
      // in refreshFolder). Old transcripts without timestamps fall back to stat.
      created: firstTimestamp || stat.birthtime.toISOString(),
      modified: lastTimestamp || stat.mtime.toISOString(),
      fileMtime: stat.mtime.toISOString(),
      messageCount, textContent: textParts.join('\n'), slug, customTitle, aiTitle,
    };
  } catch {
    return null;
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

  // A first prompt, as the positional argument. Only for a brand-new session:
  // a resume continues where it was, and a fork carries its parent's prompt.
  if (isNew && !options?.forkFrom && options?.initialPrompt) {
    args.push(String(options.initialPrompt));
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
