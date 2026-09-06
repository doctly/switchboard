'use strict';

/**
 * Is a plain terminal running a command, or sitting at its prompt?
 *
 * Two sources, preferred in this order:
 *
 *   1. OSC 133 prompt marks. The shell says so itself: C when a command
 *      starts, D when it ends, A/B while the prompt is drawn. Exact, instant,
 *      and free for anyone running powerlevel10k, starship, oh-my-posh or
 *      fish 3.4+, all of which emit them already.
 *   2. The PTY's foreground process name, polled. Only for a shell that sends
 *      no marks. `pty.process` is a tcgetpgrp plus a name lookup — ~18us, no
 *      subprocess — so a sweep over 50 terminals costs under a millisecond.
 *
 * A harness session (Claude, codex) is not tracked here; its busy state comes
 * from the OSC 0 title and OSC 9;4 progress that the CLI already sends.
 */

// Marks arrive as ESC ] 133 ; <letter> [; payload] BEL-or-ST. The payload of a
// C mark carries the command line, so it is matched but thrown away.
const MARK_RE = /\x1b\]133;([A-D])(?:;[^\x07\x1b]*)?(?:\x07|\x1b\\)/g;

const DEFAULTS = {
  // How long a command must run before it counts as "working". Below this,
  // `cd` and `ls` would flash a spinner and then mark the terminal unread.
  minBusyMs: 300,
  // How long to wait for a first prompt mark before falling back to polling.
  markGraceMs: 4000,
  // The shell must have stopped writing for this long before its foreground
  // process name can be trusted as the idle baseline — otherwise the name
  // learned is whatever the rc file happens to be running (nvm, pyenv).
  baselineQuietMs: 300,
};

/** Prompt marks in one chunk of PTY output, in the order they appear. */
function parsePromptMarks(data) {
  if (typeof data !== 'string' || !data.includes('\x1b]133;')) return [];
  const marks = [];
  for (const m of data.matchAll(MARK_RE)) marks.push(m[1]);
  return marks;
}

/**
 * Track one terminal.
 *
 * feedData/feedProcess/tick each return the new busy value when it changed,
 * and null when it did not, so the caller only ever sends an IPC message on a
 * real transition.
 *
 * @param {object} opts
 * @param {string} [opts.shellName]  basename of the spawned shell, used only as
 *   a provisional baseline; the name observed on the PTY replaces it.
 * @param {boolean} [opts.canPollProcess]  false where `pty.process` reports
 *   something other than a process name (Windows returns the console title),
 *   which leaves marks as the only source.
 */
function createTerminalActivity(opts = {}) {
  const shellName = opts.shellName || null;
  const canPollProcess = opts.canPollProcess !== false;
  const minBusyMs = opts.minBusyMs ?? DEFAULTS.minBusyMs;
  const markGraceMs = opts.markGraceMs ?? DEFAULTS.markGraceMs;
  const baselineQuietMs = opts.baselineQuietMs ?? DEFAULTS.baselineQuietMs;
  const startedAt = opts.startedAt ?? Date.now();

  // 'unknown' until we learn whether this shell sends marks; then 'marks',
  // 'poll', or 'off' when there is no usable source at all.
  let mode = 'unknown';
  let baseline = null;
  let baselineLearned = false;
  let lastDataAt = startedAt;
  let working = false;      // what the source says right now
  let workingSince = 0;
  let reported = false;     // what the caller has been told

  function setWorking(next, now) {
    if (next === working) return;
    working = next;
    if (next) workingSince = now;
  }

  function settle(now) {
    if (mode === 'unknown') {
      if (now - startedAt < markGraceMs) return null;
      // No marks in the grace window. Fall back to the foreground process
      // name, with the shell's own basename standing in until the PTY goes
      // quiet long enough to learn the real one.
      mode = canPollProcess ? 'poll' : 'off';
      if (!baseline && shellName) baseline = shellName;
    }
    if (mode === 'off') return null;
    if (working && !reported && now - workingSince >= minBusyMs) {
      reported = true;
      return true;
    }
    if (!working && reported) {
      reported = false;
      return false;
    }
    return null;
  }

  return {
    /** Feed a chunk of PTY output. */
    feedData(data, now = Date.now()) {
      lastDataAt = now;
      const marks = parsePromptMarks(data);
      if (marks.length) {
        if (mode !== 'marks') {
          // The shell speaks for itself from here on; anything the poll had
          // concluded is discarded.
          mode = 'marks';
          working = false;
        }
        for (const mark of marks) setWorking(mark === 'C', now);
      }
      return settle(now);
    },

    /** Feed one reading of the PTY's foreground process name. */
    feedProcess(name, now = Date.now()) {
      if (mode === 'marks' || mode === 'off') return null;
      if (!name) return settle(now);
      if (!baselineLearned) {
        // Wait for quiet: during rc-file execution the name is whatever the rc
        // file is running. Learned rather than taken from the shell path
        // because /bin/sh reports "bash" and a wrapper reports its target.
        if (now - lastDataAt < baselineQuietMs) return settle(now);
        baseline = name;
        baselineLearned = true;
      }
      setWorking(name !== baseline, now);
      return settle(now);
    },

    /** Let time pass, so a long-running command can cross minBusyMs. Must be
     *  called on every sweep, marks included: a silent command (`sleep 5`)
     *  produces no output to settle on. */
    tick(now = Date.now()) {
      return settle(now);
    },

    /** False once the shell's own marks are driving this terminal, which is
     *  what keeps the sweep off most sessions. Ticking is still required. */
    needsPoll() {
      if (mode === 'marks' || mode === 'off') return false;
      // 'unknown' polls too, so the baseline is ready the moment the grace
      // window closes.
      return canPollProcess;
    },

    /** For logging and tests. */
    state() {
      return { mode, baseline, busy: reported };
    },
  };
}

module.exports = { parsePromptMarks, createTerminalActivity, DEFAULTS };
