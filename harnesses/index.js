// Harness registry.
//
// A "harness" is a CLI that drives a model and records its sessions on disk —
// `claude`, and (next) `codex`. Each one owns its transcript layout, its
// transcript format, and its launch flags; the rest of the app addresses them
// only through the shape below.
//
// Note the name: `agent` already means a Claude *subagent* elsewhere in this
// codebase (session_cache.agentId, subagentType), so a harness is deliberately
// not called an agent.
//
// Every harness module exports:
//
//   id              string, matches session_cache.runtime
//   label           display name
//   binary          the executable name
//   folderPrefix    namespace for its folder keys, or null for the default one
//   groupsByProject is one folder exactly one project (Claude) or many (Codex)
//   available()     is this harness usable on this machine
//   sessionsRoot()  directory holding all its transcripts
//   listFolders()   folder keys under that root
//   folderPath(f)   folder key → absolute directory
//   listTranscripts(dir)       absolute transcript paths in a folder directory
//   sessionIdFromPath(file)    transcript path → session id, without reading it
//   transcriptPath(row)        cached row → absolute transcript path
//   readSessionFile(file, folder, projectPath, prev?) → session row, or null
//     prev is optional cached parser state; harnesses may ignore it.
//   titleIndexPath()           optional external title-index path
//   readSessionTitles()        optional Map<sessionId, title> from that index
//   buildLaunchArgs({ sessionId, isNew, options }) → argv after the binary

const claude = require('./claude');
const codex = require('./codex');

const HARNESSES = { [claude.id]: claude, [codex.id]: codex };

const DEFAULT_HARNESS = claude.id;

/** Look up a harness by id, falling back to Claude for rows written before
 *  the harness column existed (and for any unknown value). */
function getHarness(harnessId) {
  return HARNESSES[harnessId] || HARNESSES[DEFAULT_HARNESS];
}

/** Every registered harness, whether or not it is usable here. */
function allHarnesses() {
  return Object.values(HARNESSES);
}

/** Harnesses that can actually be used on this machine. */
function availableHarnesses() {
  return allHarnesses().filter(h => h.available());
}

/**
 * Which harness a session_cache.folder key belongs to.
 *
 * Keys are namespaced by prefix so one column can address every harness's
 * layout. Claude's keys are unprefixed (encoded project paths), so it is the
 * fallback — which also makes rows written before this existed resolve
 * correctly without a backfill.
 */
function harnessForFolder(folder) {
  for (const h of allHarnesses()) {
    if (h.folderPrefix && String(folder).startsWith(h.folderPrefix)) return h;
  }
  return getHarness(DEFAULT_HARNESS);
}

/** Absolute transcript path for a cached session row. */
function transcriptPath(row) {
  return getHarness(row.runtime).transcriptPath(row);
}

/**
 * What an OSC 9;4 progress report means for a session's busy state.
 *
 * `4;1/2/3` start or update progress, `4;0` ends it. The catch is that `4;0`
 * also arrives when nothing was running, and any child process in the PTY can
 * emit these — so it only clears a busy state the terminal title does not
 * currently contradict. The title comes from the CLI itself and is the more
 * trustworthy signal; a subprocess's progress bar must never be able to report
 * the CLI as idle while it is visibly working.
 */
function progressBusyState({ level, titleBusy }) {
  if (level === '0') return titleBusy ? null : 'idle';
  if (level === '1' || level === '2' || level === '3') return 'busy';
  return null;
}

module.exports = {
  HARNESSES, DEFAULT_HARNESS, progressBusyState,
  getHarness, allHarnesses, availableHarnesses,
  harnessForFolder, transcriptPath,
};
