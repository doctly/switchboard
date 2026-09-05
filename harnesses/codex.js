// OpenAI Codex harness.
//
// Codex stores sessions very differently from Claude, and most of this file
// exists to absorb those differences:
//
//   - transcripts live at $CODEX_HOME/sessions/YYYY/MM/DD/rollout-<ts>-<id>.jsonl,
//     so a folder is a DATE, not a project, and one folder holds sessions from
//     many projects. Each transcript carries its own cwd, hence groupsByProject.
//   - the file name is not the session id, hence sessionFile in session_cache.
//   - the transcript is only written on the first turn, so a launched-but-unused
//     session leaves nothing on disk at all.

const fs = require('fs');
const os = require('os');
const path = require('path');

const id = 'codex';
const label = 'Codex';
const binary = 'codex';

// Folder keys are date paths ('2026/08/26') under this prefix. encodeProjectPath
// emits [a-zA-Z0-9-] only, so a key containing '/' can never be a Claude one.
const folderPrefix = 'codex/';

// A codex folder is a date, so its sessions belong to different projects and the
// project has to be read per transcript. Claude's folder IS the project.
const groupsByProject = false;

const ROLLOUT_RE = /^rollout-.*-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

// --- Layout ---

function codexHome() {
  return process.env.CODEX_HOME
    ? path.resolve(process.env.CODEX_HOME)
    : path.join(os.homedir(), '.codex');
}

function sessionsRoot() {
  return path.join(codexHome(), 'sessions');
}

/**
 * Codex keeps thread names outside the rollout transcript. Both its automatic
 * title and a later `/rename` are appended here as { id, thread_name,
 * updated_at } records, with the newest record for an id winning.
 */
function titleIndexPath() {
  return path.join(codexHome(), 'session_index.jsonl');
}

let cachedTitleIndex = null;

function readSessionTitles() {
  const filePath = titleIndexPath();
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch (err) {
    // A missing index is a valid empty state (for example before Codex has
    // named its first thread). Other read errors must not erase cached titles.
    if (err?.code === 'ENOENT') return new Map();
    return null;
  }

  if (cachedTitleIndex
      && cachedTitleIndex.filePath === filePath
      && cachedTitleIndex.mtimeMs === stat.mtimeMs
      && cachedTitleIndex.ctimeMs === stat.ctimeMs
      && cachedTitleIndex.ino === stat.ino
      && cachedTitleIndex.size === stat.size) {
    return cachedTitleIndex.titles;
  }

  let body;
  try { body = fs.readFileSync(filePath, 'utf8'); } catch { return null; }

  const titles = new Map();
  for (const line of body.split('\n')) {
    if (!line.trim()) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    if (typeof entry?.id !== 'string' || typeof entry?.thread_name !== 'string') continue;
    const title = entry.thread_name.trim();
    // Keep an empty newest record too: it means the title was cleared and must
    // supersede any older non-empty entry for the same id.
    titles.set(entry.id, title || null);
  }

  cachedTitleIndex = {
    filePath, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, ino: stat.ino,
    size: stat.size, titles,
  };
  return titles;
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

function subdirs(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name);
  } catch {
    return [];
  }
}

/**
 * Every YYYY/MM/DD folder, as the prefixed keys stored in session_cache.folder.
 *
 * Old date folders never change, so the caller's mtime gate skips them for the
 * cost of one stat each — which is what keeps this cheap as history piles up.
 */
function listFolders() {
  const root = sessionsRoot();
  const folders = [];
  for (const y of subdirs(root)) {
    if (!/^\d{4}$/.test(y)) continue;
    for (const m of subdirs(path.join(root, y))) {
      if (!/^\d{2}$/.test(m)) continue;
      for (const d of subdirs(path.join(root, y, m))) {
        if (!/^\d{2}$/.test(d)) continue;
        // Always '/' — this is a stored key, not a filesystem path.
        folders.push(`${folderPrefix}${y}/${m}/${d}`);
      }
    }
  }
  return folders;
}

/** Takes the key with folderPrefix already stripped, e.g. '2026/08/26'. */
function folderPath(folder) {
  return path.join(sessionsRoot(), ...String(folder).split('/'));
}

/** Codex has no per-project directory, so a project cannot be created here. */
function folderForProject() {
  return null;
}

/** A codex folder spans projects, so there is no folder-level project path. */
function deriveProjectPath() {
  return null;
}

function listTranscripts(dir) {
  try {
    return fs.readdirSync(dir)
      .filter(f => ROLLOUT_RE.test(f))
      .map(f => path.join(dir, f));
  } catch {
    return [];
  }
}

/**
 * The session id is the uuid suffix of the file name.
 *
 * Deliberately NOT session_meta.session_id: that field is the lineage root, and
 * every resume or fork of a conversation repeats it, so six rollout files on
 * disk here share one value. The file name's uuid is unique per rollout, is
 * what `codex resume <id>` accepts (verified), and is what codex's own
 * session_index.jsonl keys on. Reading it costs no file access.
 */
function sessionIdFromPath(filePath) {
  const m = ROLLOUT_RE.exec(path.basename(filePath));
  return m ? m[1] : null;
}

function transcriptPath({ sessionFile }) {
  // Unlike Claude, a codex path cannot be rebuilt from the session id: the file
  // name carries a timestamp and sits in a date directory. sessionFile is the
  // only way back to it, and is written for every codex row.
  return sessionFile || null;
}

// --- Transcript parsing ---

// Codex injects context into the conversation as user-role messages wrapped in
// a tag — <environment_context>, <recommended_plugins>, <turn_aborted>,
// <transcript>. Across every rollout on disk, no genuine user prompt starts
// with one, so this is the line between what the user said and what the CLI
// said on their behalf.
const INJECTED_RE = /^\s*<[a-z_]+>/;

/**
 * Is this rollout a sub-agent thread rather than a conversation the user had?
 *
 * Any one of these is conclusive; they do not all appear together, and older
 * rollouts carry none of them (correctly, since multi-agent postdates them).
 */
function isSubagentMeta(payload) {
  return payload.thread_source === 'subagent'
    || !!payload.parent_thread_id
    || !!payload.agent_path
    || !!payload.agent_nickname;
}

function messageText(payload) {
  const content = payload?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map(c => (c && typeof c.text === 'string' ? c.text : '')).join('');
}

/**
 * Parse one rollout into the same session shape Claude's parser returns.
 *
 * Only `response_item` message records are counted. Older codex versions ALSO
 * emit event_msg user_message/agent_message records carrying the same text, so
 * counting both would double every message; response_item is the one present in
 * every rollout on disk, event_msg is not.
 */
function readSessionFile(filePath, folder) {
  try {
    const stat = fs.statSync(filePath);
    const lines = fs.readFileSync(filePath, 'utf8').split('\n');

    const sessionId = sessionIdFromPath(filePath);
    if (!sessionId) return null;

    let projectPath = null;
    let summary = '';
    let messageCount = 0;
    let textContent = '';
    let firstTimestamp = null;
    let lastTimestamp = null;

    for (const line of lines) {
      if (!line) continue;
      let entry;
      try { entry = JSON.parse(line); } catch { continue; }

      const ts = entry.timestamp;
      if (ts) {
        // ISO-8601 UTC strings — lexicographic comparison is chronological
        if (!firstTimestamp || ts < firstTimestamp) firstTimestamp = ts;
        if (!lastTimestamp || ts > lastTimestamp) lastTimestamp = ts;
      }

      const payload = entry.payload;
      if (!payload) continue;

      if (entry.type === 'session_meta') {
        // Sub-agent threads are recorded as ordinary rollouts, but codex refuses
        // to resume one directly ("cannot resume an unloaded multi-agent v2
        // sub-agent through its parent"). Showing them would mean offering a
        // resume that always fails. Claude's subagent transcripts are already
        // excluded — they live in a subagents/ subdirectory the indexer never
        // scans — so this keeps the two consistent.
        if (isSubagentMeta(payload)) return null;
        projectPath = projectPath || payload.cwd || null;
        continue;
      }

      if (entry.type !== 'response_item' || payload.type !== 'message') continue;

      const role = payload.role;
      if (role !== 'user' && role !== 'assistant') continue; // 'developer' is CLI scaffolding

      const text = messageText(payload);
      if (role === 'user' && INJECTED_RE.test(text)) continue;

      messageCount++;
      if (!summary && role === 'user' && text) summary = text.slice(0, 120);
      if (text && textContent.length < 8000) textContent += text.slice(0, 500) + '\n';
    }

    // No cwd means no project to file it under; no user turn means the session
    // was opened and abandoned. Either way there is nothing to show.
    if (!projectPath) return null;
    if (!summary || messageCount < 1) return null;

    return {
      sessionId, folder, projectPath,
      runtime: id,
      sessionFile: filePath,
      summary, firstPrompt: summary,
      created: firstTimestamp || stat.birthtime.toISOString(),
      modified: lastTimestamp || stat.mtime.toISOString(),
      fileMtime: stat.mtime.toISOString(),
      messageCount, textContent,
      slug: null, customTitle: null, aiTitle: null,
    };
  } catch {
    return null;
  }
}

/** Text out of codex's {type, text} content arrays, which vary by record. */
function partsText(parts) {
  if (typeof parts === 'string') return parts;
  if (!Array.isArray(parts)) return '';
  return parts.map(p => (p && typeof p.text === 'string' ? p.text : '')).join('');
}

/**
 * A rollout rewritten as the records the JSONL viewer renders.
 *
 * The viewer speaks Claude's transcript format, so rather than teaching it a
 * second one, codex's records are mapped onto it: a tool call becomes a
 * tool_use block, its output a tool_result keyed by the same call id, and a
 * reasoning summary a thinking block.
 *
 * Developer-role messages and tag-wrapped user turns are dropped for the same
 * reason readSessionFile drops them — they are the CLI talking to the model,
 * not conversation.
 */
function toViewerEntries(entries) {
  const out = [];
  for (const entry of entries || []) {
    if (!entry || entry.type !== 'response_item') continue;
    const p = entry.payload;
    if (!p) continue;
    const timestamp = entry.timestamp;

    if (p.type === 'message') {
      const role = p.role;
      if (role !== 'user' && role !== 'assistant') continue;
      const text = partsText(p.content);
      if (!text) continue;
      if (role === 'user' && INJECTED_RE.test(text)) continue;
      out.push({ type: role, timestamp, message: { role, content: [{ type: 'text', text }] } });
      continue;
    }

    if (p.type === 'reasoning') {
      // Usually empty: the real chain of thought is in encrypted_content, which
      // only the API can read. Rendered when a plain summary is present.
      const text = partsText(p.summary);
      if (!text) continue;
      out.push({ type: 'assistant', timestamp,
        message: { role: 'assistant', content: [{ type: 'thinking', thinking: text }] } });
      continue;
    }

    if (p.type === 'custom_tool_call' || p.type === 'function_call') {
      out.push({ type: 'assistant', timestamp, message: { role: 'assistant', content: [{
        type: 'tool_use',
        // The viewer pairs a result to its call through this id.
        id: p.call_id || p.id || null,
        name: p.name || 'tool',
        input: p.input ?? p.arguments ?? '',
      }] } });
      continue;
    }

    if (p.type === 'custom_tool_call_output' || p.type === 'function_call_output') {
      out.push({ type: 'user', timestamp, message: { role: 'user', content: [{
        type: 'tool_result',
        tool_use_id: p.call_id || p.id || null,
        content: partsText(p.output),
      }] } });
    }
  }
  return out;
}

// --- New-session detection ---
//
// codex will not accept a pre-assigned session id, and writes no transcript at
// all until the first turn. So a new session is launched under a temporary id
// and matched to its rollout afterwards.
//
// The handshake is CODEX_INTERNAL_ORIGINATOR_OVERRIDE, which codex copies
// verbatim into session_meta.originator. That gives an exact match even when
// several codex sessions start in the same directory at once.

/**
 * codex never accepts a pre-assigned id, so every new session — fresh or
 * forked — has to be matched to its transcript afterwards.
 */
function needsIdDetection({ isNew }) {
  return !!isNew;
}

/**
 * Env tag identifying a session we launched.
 *
 * Restricted to [a-z0-9_]: the value ends up in an HTTP header, and the binary
 * carries an "ignoring invalid thread originator header value" path. The
 * hyphens of a uuid are stripped rather than risk it.
 */
function originatorTag(tempId) {
  return 'switchboard_' + String(tempId).replace(/[^a-zA-Z0-9]/g, '');
}

function launchEnv(tempId) {
  return { CODEX_INTERNAL_ORIGINATOR_OVERRIDE: originatorTag(tempId) };
}

/**
 * Read just enough of a rollout's first line to decide whether it is ours.
 *
 * Cheap on purpose — this runs for every file the watcher reports, including
 * appends to large transcripts.
 */
function readLaunchSignals(filePath) {
  let head;
  try {
    const fd = fs.openSync(filePath, 'r');
    try {
      const buf = Buffer.alloc(65536);
      const bytes = fs.readSync(fd, buf, 0, buf.length, 0);
      head = buf.toString('utf8', 0, bytes);
    } finally {
      fs.closeSync(fd);
    }
  } catch { return null; }

  const newline = head.indexOf('\n');
  if (newline === -1) return null; // line 1 still being written
  let entry;
  try { entry = JSON.parse(head.slice(0, newline)); } catch { return null; }
  if (!entry || entry.type !== 'session_meta') return null;

  const payload = entry.payload || {};
  return {
    sessionId: sessionIdFromPath(filePath),
    originator: payload.originator || null,
    // Set when this rollout is a fork, naming the thread it came from.
    forkedFrom: payload.forked_from_id || null,
    cwd: payload.cwd || null,
    startedAt: payload.timestamp || entry.timestamp || null,
    isSubagent: isSubagentMeta(payload),
  };
}

// A rollout created slightly before the spawn timestamp is still plausibly ours:
// clocks and the two timestamps involved are not the same source.
const SPAWN_SKEW_MS = 5000;

/** Was this rollout written after we spawned, allowing for clock skew? */
function startedAfterSpawn(signals, spawnedAt) {
  if (!signals.startedAt) return false;
  const started = Date.parse(signals.startedAt);
  return Number.isFinite(started) && started >= spawnedAt - SPAWN_SKEW_MS;
}

/**
 * Does this rollout belong to a session we just launched?
 *
 * A fork is matched by forked_from_id, NOT by the originator: `codex fork`
 * copies the originator from the thread it forks, so a fork we started carries
 * the tag of whichever launch created its parent. Matching on the tag there
 * either fails or, worse, claims the wrong session.
 *
 * For a fresh session the originator tag is exact and needs no other evidence.
 * The cwd fallback exists because the override is an internal variable that may
 * stop working. It refuses a rollout tagged for a DIFFERENT switchboard launch,
 * which is the one case two concurrent new sessions could steal each other's
 * transcript — a fork is exempt because its inherited tag says nothing about
 * which launch wrote it.
 */
function matchesLaunch(signals, { tag, forkFrom, projectPath, spawnedAt }) {
  if (!signals || signals.isSubagent || !signals.sessionId) return false;

  if (forkFrom) {
    return signals.forkedFrom === forkFrom && startedAfterSpawn(signals, spawnedAt);
  }

  if (tag && signals.originator === tag) return true;
  if (signals.originator && /^switchboard_/.test(signals.originator)) return false;
  if (!projectPath || signals.cwd !== projectPath) return false;
  return startedAfterSpawn(signals, spawnedAt);
}

// --- Activity signalling ---

// codex builds its terminal title from a configurable list of items
// ([tui].terminal_title). The one that matters is `activity`, documented in the
// binary as "Spinner while working, action-required message while blocked" — a
// braille spinner frame while a turn runs, and "[ ! ] Action Required" or
// "[ . ] Action Required" while it is waiting on the user.
//
// The launch pins that list (see buildLaunchArgs) so the format is ours rather
// than whatever the user configured. Even so, this scans the whole title
// instead of just its first character: the item order is configurable, and a
// title that is merely in an unexpected shape must not silently read as idle
// and leave a blocked session looking finished.
const SPINNER_MIN = 0x2800, SPINNER_MAX = 0x28FF;
const ACTION_REQUIRED_RE = /action required/i;

function hasSpinnerFrame(text) {
  for (const ch of text) {
    const code = ch.codePointAt(0);
    if (code >= SPINNER_MIN && code <= SPINNER_MAX) return true;
  }
  return false;
}

/**
 * What an OSC 0 title says about the session.
 *
 * 'busy' | 'attention' | 'idle' | null. Unlike Claude there is no idle glyph —
 * an idle title is just the project name — so anything that is neither working
 * nor blocked is idle.
 */
function parseTitleState(title) {
  const text = String(title || '');
  if (!text) return null;
  if (ACTION_REQUIRED_RE.test(text)) return 'attention';
  if (hasSpinnerFrame(text)) return 'busy';
  return 'idle';
}

/**
 * What an OSC 9 notification means.
 *
 * codex sends exactly two kinds: "Approval requested: <command>" when it is
 * blocked on the user, and the agent's final message when a turn completes.
 */
function classifyNotification(message) {
  const text = String(message || '').trim();
  if (!text) return null;
  if (/^approval requested\b/i.test(text)) return 'attention';
  return 'idle';
}

// --- Launch ---

const SANDBOX_MODES = new Set(['read-only', 'workspace-write', 'danger-full-access']);
const APPROVAL_POLICIES = new Set(['on-request', 'never']);

/**
 * Argv for the codex binary.
 *
 * `codex resume <id>` accepts the same flags as a fresh launch, so the option
 * mapping is shared. Claude-only keys in the options bag (permissionMode,
 * worktree, chrome, appendSystemPrompt) are ignored rather than translated —
 * codex has no equivalent, and passing an unknown flag fails the launch.
 *
 * Enumerated values are checked against what the CLI accepts instead of being
 * interpolated blind: these come from stored settings, which can outlive the
 * codex version that understood them.
 */
function buildLaunchArgs({ sessionId, isNew, options }) {
  // Switchboard needs OSC 9 to know when a session finishes a turn or blocks on
  // the user, and codex only emits it when notifications are on. Forced for the
  // same reason main.js forces TERM_PROGRAM=iTerm.app for Claude: the signal is
  // what drives the sidebar, and 'unfocused' would suppress it. Passed as -c
  // overrides so the user's own config.toml is untouched.
  const args = [
    '-c', 'tui.notifications=true',
    '-c', 'tui.notification_method="osc9"',
    '-c', 'tui.notification_condition="always"',
    // Pin the title to [activity, project-name]. `activity` is the item that
    // carries the spinner and the "Action Required" message, and the list is
    // otherwise whatever the user configured — a title without it would leave
    // Switchboard unable to see a session working or blocked at all.
    '-c', 'tui.terminal_title=["activity","project-name"]',
  ];
  if (options?.forkFrom) {
    args.unshift('fork', String(options.forkFrom));
  } else if (!isNew) {
    args.unshift('resume', String(sessionId));
  }
  // A new session takes no subcommand — and no id, because codex will not let
  // one be pre-assigned. See harnesses/codex.js header and the detection step.

  if (options) {
    if (options.dangerouslySkipPermissions) {
      args.push('--dangerously-bypass-approvals-and-sandbox');
    } else {
      if (SANDBOX_MODES.has(options.codexSandbox)) {
        args.push('--sandbox', options.codexSandbox);
      }
      if (APPROVAL_POLICIES.has(options.codexApproval)) {
        args.push('--ask-for-approval', options.codexApproval);
      }
    }
    if (options.codexModel) {
      args.push('--model', String(options.codexModel));
    }
    if (options.addDirs) {
      const dirs = String(options.addDirs).split(',').map(d => d.trim()).filter(Boolean);
      for (const dir of dirs) {
        args.push('--add-dir', dir);
      }
    }
  }

  return args;
}

module.exports = {
  id, label, binary, folderPrefix, groupsByProject,
  titleIndexPath, readSessionTitles,
  parseTitleState, classifyNotification,
  buildLaunchArgs, launchEnv, originatorTag, readLaunchSignals, matchesLaunch, needsIdDetection,
  available, codexHome, sessionsRoot, listFolders, folderPath, folderForProject,
  listTranscripts, sessionIdFromPath, transcriptPath, isSubagentMeta,
  deriveProjectPath,
  readSessionFile, toViewerEntries,
};
