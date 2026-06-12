// trigger-watcher.js — File-based input injection for harness scripts.
//
// Drop a JSON trigger file into SWITCHBOARD_TRIGGERS_DIR (default
// ~/.switchboard/triggers/<uuid>.json) and this module writes the command into
// the matching PTY session's stdin.  The result is written to
// SWITCHBOARD_TRIGGERS_DIR/processed/<uuid>.result.json; the trigger file is
// then deleted.
//
// Exports: start(ctx) where ctx = { getPtyForSession, isSessionBusy, log }
//
// Security limits (defense-in-depth):
//   - Max trigger file size: 64 KB (C1)
//   - Symlinks rejected via lstat (C2)
//   - Max command length: 4 KB (W2)
//   - Forbidden control chars in command: \r \n \0 \x1b (W3)
//   - Max concurrent in-flight triggers: 8 (W4)
//   - Per-trigger timeout_ms capped at 600 000 ms (W6)
//   - Child-process liveness check before write (W7)
//   - Max chain length: 20 steps (W8)
//   - Chain re-queue on global-deadline expiry (W9): when the global deadline
//     fires with unsent steps remaining, a new trigger file is written with the
//     remaining steps so they can be retried once the session is idle again.
//     Max re-queues: MAX_REQUEUE (2). requeue_count tracks depth.
//
// Platform note: fs.watch is Linux-only reliable (I2). On macOS, inotify
// events may be coalesced or delayed; not blocked but not tested.
'use strict';

const fs     = require('fs');
const path   = require('path');
const os     = require('os');
const crypto = require('crypto');

const DEFAULT_TRIGGERS_DIR   = path.join(os.homedir(), '.switchboard', 'triggers');
// Default idle-wait timeout: 5 minutes.
// Rationale: agentic Claude CLI turns can run 10-20 min between idle states.
// 30 s (the original default) was too short and would time-out healthy long
// turns.  300 000 ms (5 min) is the practical upper bound for a genuine wait;
// anything longer than that without going idle is considered stuck and the
// harness should escalate instead.  The env var and per-trigger timeout_ms
// field both override this default (precedence: timeout_ms > env var > default).
const DEFAULT_IDLE_TIMEOUT   = 300_000; // ms — 5 minutes
const MAX_TRIGGER_TIMEOUT    = 600_000; // ms — hard cap for per-trigger timeout_ms (W6)
const IDLE_POLL_INTERVAL     = 100;   // ms

const MAX_TRIGGER_SIZE  = 64 * 1024;  // 64 KB  (C1)
const MAX_COMMAND_LEN   = 4 * 1024;   // 4 KB   (W2)
const MAX_INFLIGHT      = 8;          // concurrency cap (W4)
const MAX_CHAIN_LENGTH  = 20;         // max steps per chain (W8)
// W9: Maximum number of times a timed-out chain run may be automatically
// re-queued.  Keeps starvation loops bounded — if the session is perpetually
// busy, the chain eventually gives up rather than re-queuing forever.
const MAX_REQUEUE       = 2;
// Max time to wait for busy=true after injecting a command.
// Claude may answer so fast that we never observe the rising edge;
// after BUSY_RISE_TIMEOUT_MS we assume the turn completed instantly and move on.
const BUSY_RISE_TIMEOUT_MS   = 2000; // ms
// Delay (ms) between writing a command's text and the Enter keypress that
// submits it. The Enter MUST arrive as a discrete PTY read — concatenated onto
// the text in a single write, Claude Code (kitty keyboard protocol) absorbs it
// as a literal newline in the composer and the command never submits. xterm.js
// sends every keypress as its own write, which is why the web terminal submits
// correctly; we mirror that. Reproduced 2026-06-02: free-text trigger commands
// landed in the composer but did not submit; only the short menu-driven
// /compact path submitted. Override via SWITCHBOARD_SUBMIT_ENTER_DELAY_MS.
const DEFAULT_SUBMIT_ENTER_DELAY_MS = 50; // ms
// Control chars forbidden in command: CR, LF, NUL, ESC (W3)
const FORBIDDEN_COMMAND_RE = /[\r\n\0\x1b]/;

// W7 — child-process liveness check.
// node-pty's ptyProcess.write() is silent on a dead child: the bytes land in
// the kernel PTY buffer and are never consumed.  Without this check the watcher
// would happily report ok:true on writes nobody will ever read.  We use
// signal 0 (POSIX no-op probe) — throws ESRCH if the process is gone,
// throws EPERM if it exists but we can't signal it (still alive, treat as alive).
function defaultIsPtyAlive(ptyProcess) {
  if (!ptyProcess || typeof ptyProcess.pid !== 'number') return false;
  try {
    process.kill(ptyProcess.pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Submit a command to a PTY the way a human terminal does: write the text,
// then send Enter as a SEPARATE write so it is read as a discrete "submit"
// keypress rather than a trailing newline. See DEFAULT_SUBMIT_ENTER_DELAY_MS.
async function submitToPty(ptyProcess, command) {
  ptyProcess.write(command);
  const envMs = Number(process.env.SWITCHBOARD_SUBMIT_ENTER_DELAY_MS);
  const ms = Number.isFinite(envMs) && envMs >= 0 ? envMs : DEFAULT_SUBMIT_ENTER_DELAY_MS;
  await delay(ms);
  ptyProcess.write('\r');
}

// Window (ms) to wait for the busy rising edge when verifying a submission.
// Defaults to BUSY_RISE_TIMEOUT_MS; override via SWITCHBOARD_SUBMIT_VERIFY_MS.
function getSubmitVerifyMs() {
  const v = Number(process.env.SWITCHBOARD_SUBMIT_VERIFY_MS);
  return Number.isFinite(v) && v >= 0 ? v : BUSY_RISE_TIMEOUT_MS;
}

/**
 * Poll ctx.isSessionBusy(sessionId) for a rising edge (busy=true) up to
 * `windowMs`, bounded by the absolute `deadlineMs`. Stops early if the PTY
 * disappears.
 *
 * Returns { rose, timedOut, sessionExited, waited_ms }.
 *   - rose:         busy=true was observed
 *   - timedOut:     global deadline fired before any rise
 *   - sessionExited: PTY vanished during the poll
 */
function pollForBusyRise(sessionId, ctx, windowMs, deadlineMs) {
  return new Promise((resolve) => {
    const start = Date.now();
    const windowEnd = start + windowMs;

    function check() {
      const now = Date.now();

      if (now >= deadlineMs) {
        return resolve({ rose: false, timedOut: true, sessionExited: false, waited_ms: now - start });
      }
      if (!ctx.getPtyForSession(sessionId)) {
        return resolve({ rose: false, timedOut: false, sessionExited: true, waited_ms: now - start });
      }
      if (ctx.isSessionBusy(sessionId)) {
        return resolve({ rose: true, timedOut: false, sessionExited: false, waited_ms: now - start });
      }
      if (now >= windowEnd) {
        // Verify window elapsed without a rise — caller decides what to do.
        return resolve({ rose: false, timedOut: false, sessionExited: false, waited_ms: now - start });
      }
      setTimeout(check, IDLE_POLL_INTERVAL);
    }

    check();
  });
}

/**
 * Submit a command and verify it actually started a turn.
 *
 * 1. submitToPty(text + discrete Enter)
 * 2. Poll for busy-rise within SWITCHBOARD_SUBMIT_VERIFY_MS.
 * 3. Rise observed → done (submit_retries: 0).
 * 4. No rise → write a SINGLE bare '\r' (a no-op on an empty composer, so it is
 *    harmless if the first submit actually worked; if the text is still sitting
 *    in the composer because the first Enter was absorbed, this submits it) and
 *    poll the same window again (submit_retries: 1).
 *
 * The observed rise IS the equivalent of waitForTurnComplete's Phase 1; callers
 * MUST NOT then wait for the rise again — they proceed straight to busy-fall.
 *
 * Returns { submit_retries, rose, sessionExited, timedOut, waited_ms }.
 *   - waited_ms is the total time spent polling (both windows + retry).
 *
 * If sessionExited/timedOut fire, the caller short-circuits with the usual
 * error result. If neither rise nor retry produces a rise (and no deadline),
 * the caller keeps the legacy instant-reply semantics — submit_retries traces
 * that the verification could not confirm a turn started.
 */
async function submitWithVerify(ptyProcess, sessionId, command, ctx, deadlineMs) {
  await submitToPty(ptyProcess, command);

  const windowMs = getSubmitVerifyMs();
  // No explicit (global) deadline → the verify window alone governs; the retry
  // must fire on window expiry, so the deadline must NOT coincide with it.
  const effectiveDeadline = (deadlineMs !== undefined) ? deadlineMs : Infinity;

  const first = await pollForBusyRise(sessionId, ctx, windowMs, effectiveDeadline);
  if (first.rose || first.sessionExited || first.timedOut) {
    return {
      submit_retries: 0,
      rose: first.rose,
      sessionExited: first.sessionExited,
      timedOut: first.timedOut,
      waited_ms: first.waited_ms,
    };
  }

  // No rise within the window — retry the Enter ONCE (bare '\r', never the text).
  try {
    ptyProcess.write('\r');
  } catch (err) {
    // Surface as a sessionExited-like failure; caller maps to an error result.
    return {
      submit_retries: 1,
      rose: false,
      sessionExited: false,
      timedOut: false,
      writeError: err,
      waited_ms: first.waited_ms,
    };
  }

  const second = await pollForBusyRise(sessionId, ctx, windowMs, effectiveDeadline);
  return {
    submit_retries: 1,
    rose: second.rose,
    sessionExited: second.sessionExited,
    timedOut: second.timedOut,
    waited_ms: first.waited_ms + second.waited_ms,
  };
}

/**
 * Wait only for the busy FALLING edge (busy → false), i.e. the turn finishing.
 * Used after submitWithVerify has already confirmed (or assumed) the rise.
 *
 * Returns { timedOut, sessionExited, waited_ms }.
 */
function waitForBusyFall(sessionId, ctx, deadlineMs) {
  return new Promise((resolve) => {
    const start = Date.now();

    function check() {
      const now = Date.now();
      if (now >= deadlineMs) {
        return resolve({ timedOut: true, sessionExited: false, waited_ms: now - start });
      }
      if (!ctx.getPtyForSession(sessionId)) {
        return resolve({ timedOut: false, sessionExited: true, waited_ms: now - start });
      }
      if (!ctx.isSessionBusy(sessionId)) {
        return resolve({ timedOut: false, sessionExited: false, waited_ms: now - start });
      }
      setTimeout(check, IDLE_POLL_INTERVAL);
    }

    check();
  });
}

function getTriggersDir() {
  return process.env.SWITCHBOARD_TRIGGERS_DIR || DEFAULT_TRIGGERS_DIR;
}

function getIdleTimeout() {
  const v = process.env.SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS;
  if (v !== undefined) {
    const parsed = parseInt(v, 10);
    return Number.isFinite(parsed) ? parsed : DEFAULT_IDLE_TIMEOUT; // I4: NaN guard
  }
  return DEFAULT_IDLE_TIMEOUT;
}

/**
 * Poll until isSessionBusy(sessionId) returns false, or the timeout expires,
 * or the session exits (PTY no longer available).
 *
 * @param {string} sessionId
 * @param {object} ctx
 * @param {number} [timeoutMs]  explicit timeout in ms; falls back to
 *                              getIdleTimeout() (env var → default) when absent.
 * Returns { timedOut: boolean, sessionExited: boolean, waited_ms: number }.
 */
function waitForIdle(sessionId, ctx, timeoutMs) {
  return new Promise((resolve) => {
    const timeout  = (timeoutMs !== undefined) ? timeoutMs : getIdleTimeout();
    const start    = Date.now();

    function check() {
      const waited_ms = Date.now() - start;

      // W5: detect PTY closure during wait
      if (!ctx.getPtyForSession(sessionId)) {
        return resolve({ timedOut: false, sessionExited: true, waited_ms });
      }

      if (!ctx.isSessionBusy(sessionId)) {
        return resolve({ timedOut: false, sessionExited: false, waited_ms });
      }
      if (waited_ms >= timeout) {
        return resolve({ timedOut: true, sessionExited: false, waited_ms });
      }
      setTimeout(check, IDLE_POLL_INTERVAL);
    }

    check();
  });
}

// NOTE: the previous combined-phase waiter (waitForTurnComplete: busy-rise then
// busy-fall) was split into submitWithVerify (Phase 1, busy-rise + Enter retry)
// and waitForBusyFall (Phase 2, busy-fall) so the chain path can verify each
// submission and retry the Enter once if the turn never starts (2026-06-04
// "text stuck in composer" incident). The instant-reply semantics are preserved:
// when no rise is confirmed, submitWithVerify still returns and waitForBusyFall
// returns immediately on an already-idle session.

/**
 * W9 — Write a new trigger file for the unsent remaining chain steps.
 *
 * @param {string}   sessionId
 * @param {Array}    remainingSteps   The chain steps not yet sent.
 * @param {number}   newRequeueCount  requeueCount + 1.
 * @param {number|undefined} originalTimeoutMs  Top-level timeout_ms from the original trigger (if any).
 * @param {string}   triggersDir
 * @param {object}   log
 * @returns {string|null}  The new trigger filename (e.g. "abc123.json") or null on failure.
 */
function writeRequeueTrigger(sessionId, remainingSteps, newRequeueCount, originalTimeoutMs, triggersDir, log) {
  const hex      = crypto.randomBytes(16).toString('hex');
  const filename = hex + '.json';
  const filePath = path.join(triggersDir, filename);
  const tmpPath  = filePath + '.tmp';

  const payload = {
    sessionId,
    chain:         remainingSteps,
    wait:          'idle',
    requeue_count: newRequeueCount,
  };
  if (originalTimeoutMs !== undefined) {
    payload.timeout_ms = originalTimeoutMs;
  }

  try {
    fs.writeFileSync(tmpPath, JSON.stringify(payload) + '\n', 'utf8');
    fs.renameSync(tmpPath, filePath);
    return filename;
  } catch (err) {
    log.error('[trigger-watcher] Failed to write re-queue trigger:', err.message);
    try { fs.unlinkSync(tmpPath); } catch {}
    return null;
  }
}

/**
 * Validate a single timeout_ms value (for top-level or per-step).
 * Returns null if valid, or an error string if invalid.
 */
function validateTimeoutMs(value) {
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value <= 0 ||
    value > MAX_TRIGGER_TIMEOUT
  ) {
    return 'invalid timeout_ms';
  }
  return null;
}

/**
 * Process a single trigger file (by basename, e.g. "abc-123.json").
 * Never throws — all errors land in the result file.
 */
async function processTriggerFile(name, ctx, triggersDir, processedDir) {
  // Only handle *.json files, ignore the processed/ subdir itself and
  // any stray files.
  if (!name.endsWith('.json')) return;

  const triggerPath = path.join(triggersDir, name);
  const uuid        = name.slice(0, -5); // strip ".json"
  const resultPath  = path.join(processedDir, uuid + '.result.json');
  const resultTmp   = resultPath + '.tmp'; // I1: atomic write temp path

  // I1: atomic result write — write to .tmp then rename so pollers never
  // observe a partial JSON file.
  async function writeResult(result) {
    try {
      fs.writeFileSync(resultTmp, JSON.stringify(result) + '\n', 'utf8');
      fs.renameSync(resultTmp, resultPath);
    } catch (err) {
      ctx.log.error('[trigger-watcher] Failed to write result file:', err.message);
    }
    try {
      fs.unlinkSync(triggerPath);
    } catch {
      // Trigger may already be gone (race between two watcher events for the
      // same file). Silently ignore.
    }
  }

  // ── 1. lstat + size guard (C1 + C2) ──────────────────────────────────────
  let stat;
  try {
    stat = fs.lstatSync(triggerPath); // C2: lstat does NOT follow symlinks
  } catch {
    // File gone between access check and here — skip silently
    return;
  }

  if (!stat.isFile()) {
    // C2: reject symlinks, directories, device nodes, etc.
    ctx.log.warn('[trigger-watcher] Non-regular-file trigger rejected:', name);
    await writeResult({ ok: false, error: 'trigger must be a regular file' });
    return;
  }

  if (stat.size > MAX_TRIGGER_SIZE) {
    // C1: reject oversized files before reading
    ctx.log.warn('[trigger-watcher] Oversized trigger rejected:', name, stat.size);
    await writeResult({ ok: false, error: 'trigger too large (max 64 KB)' });
    return;
  }

  // ── 2. Read + parse (with SyntaxError retry for W1 partial-write race) ───
  let trigger;
  let lastParseErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    // W1: on second attempt, wait 50 ms (partial-write window) then retry
    if (attempt === 1) {
      await new Promise(r => setTimeout(r, 50));
    }
    try {
      const raw = fs.readFileSync(triggerPath, 'utf8');
      trigger   = JSON.parse(raw);
      lastParseErr = null;
      break; // success
    } catch (err) {
      lastParseErr = err;
      if (!(err instanceof SyntaxError)) {
        // ENOENT or other I/O error — no retry useful
        break;
      }
      // SyntaxError on attempt 0: retry once after 50 ms (W1)
    }
  }

  if (lastParseErr) {
    ctx.log.warn('[trigger-watcher] Unreadable/unparseable trigger:', name, lastParseErr.message);
    await writeResult({ ok: false, error: 'invalid JSON: ' + lastParseErr.message });
    return;
  }

  // ── 3. Validate shape ─────────────────────────────────────────────────────
  const { sessionId, command, chain, wait = 'none', timeout_ms } = trigger;

  if (typeof sessionId !== 'string' || !sessionId) {
    await writeResult({ ok: false, error: 'missing required field: sessionId', sessionId: sessionId || null });
    return;
  }

  // W9: validate requeue_count — absent → 0; must be a non-negative integer
  const rawRequeueCount = trigger.requeue_count;
  let requeueCount;
  if (rawRequeueCount === undefined || rawRequeueCount === null) {
    requeueCount = 0;
  } else if (
    typeof rawRequeueCount !== 'number' ||
    !Number.isInteger(rawRequeueCount) ||
    rawRequeueCount < 0
  ) {
    await writeResult({ ok: false, error: 'invalid requeue_count: must be a non-negative integer', sessionId });
    return;
  } else {
    requeueCount = rawRequeueCount;
  }

  // Mutual exclusion: command and chain cannot both be present
  if (command !== undefined && chain !== undefined) {
    await writeResult({ ok: false, error: 'command and chain are mutually exclusive', sessionId });
    return;
  }

  // Must have either command or chain
  if (command === undefined && chain === undefined) {
    await writeResult({ ok: false, error: 'missing required field: command or chain', sessionId });
    return;
  }

  // ── 3a. Validate single-command path ─────────────────────────────────────
  if (command !== undefined) {
    if (typeof command !== 'string' || !command) {
      await writeResult({ ok: false, error: 'missing required field: command', sessionId });
      return;
    }

    // W2: command length cap
    if (command.length > MAX_COMMAND_LEN) {
      await writeResult({ ok: false, error: 'command too long (max 4 KB)', sessionId });
      return;
    }

    // W3: reject forbidden control characters
    if (FORBIDDEN_COMMAND_RE.test(command)) {
      await writeResult({ ok: false, error: 'command contains forbidden control characters (\\r \\n \\0 \\x1b)', sessionId });
      return;
    }
  }

  // ── 3b. Validate chain path ───────────────────────────────────────────────
  if (chain !== undefined) {
    // W8: chain must be a non-empty array, length ≤ MAX_CHAIN_LENGTH
    if (!Array.isArray(chain) || chain.length === 0) {
      await writeResult({ ok: false, error: 'chain must be a non-empty array', sessionId });
      return;
    }
    if (chain.length > MAX_CHAIN_LENGTH) {
      await writeResult({ ok: false, error: `chain too long (max ${MAX_CHAIN_LENGTH} steps)`, sessionId });
      return;
    }

    // Validate each step
    for (let i = 0; i < chain.length; i++) {
      const step = chain[i];

      if (typeof step.command !== 'string' || !step.command) {
        await writeResult({ ok: false, error: `step[${i}]: missing required command string`, sessionId });
        return;
      }

      // W2: step command length cap
      if (step.command.length > MAX_COMMAND_LEN) {
        await writeResult({ ok: false, error: `step[${i}]: command too long (max 4 KB)`, sessionId });
        return;
      }

      // W3: reject forbidden control characters in step command
      if (FORBIDDEN_COMMAND_RE.test(step.command)) {
        await writeResult({ ok: false, error: `step[${i}]: command contains forbidden control characters (\\r \\n \\0 \\x1b)`, sessionId });
        return;
      }

      // W6: validate optional per-step timeout_ms
      if (step.timeout_ms !== undefined) {
        const err = validateTimeoutMs(step.timeout_ms);
        if (err) {
          await writeResult({ ok: false, error: `step[${i}]: invalid step timeout_ms`, sessionId });
          return;
        }
      }
    }
  }

  // W6: validate optional top-level timeout_ms
  let resolvedTimeoutMs;
  if (timeout_ms !== undefined) {
    const err = validateTimeoutMs(timeout_ms);
    if (err) {
      await writeResult({ ok: false, error: 'invalid timeout_ms', sessionId });
      return;
    }
    resolvedTimeoutMs = timeout_ms;
  }
  // When timeout_ms is absent, resolvedTimeoutMs stays undefined and waitForIdle
  // falls back to getIdleTimeout() (env var → compiled default).

  // ── 4. Look up session ────────────────────────────────────────────────────
  const sessionEntry = ctx.getPtyForSession(sessionId);
  if (!sessionEntry) {
    ctx.log.warn('[trigger-watcher] Session not found:', sessionId);
    await writeResult({ ok: false, error: 'session not found', sessionId });
    return;
  }

  const { ptyProcess } = sessionEntry;
  const isPtyAlive = ctx.isPtyAlive || defaultIsPtyAlive;

  // W7 — pre-flight liveness check.  main.js may keep a stale entry in its
  // activeSessions map after a Claude process exited "cleanly" (Ctrl+D, /exit)
  // without the Switchboard window closing.  Without this guard we'd wait the
  // full idle-timeout for a busy flag that will never flip, then write into a
  // dead PTY and report ok:true.
  if (!isPtyAlive(ptyProcess)) {
    ctx.log.warn('[trigger-watcher] Target process not running:', sessionId);
    await writeResult({ ok: false, error: 'target process not running', sessionId });
    return;
  }

  // ── 5. Single-command path ────────────────────────────────────────────────
  if (command !== undefined) {
    let waited_ms = 0;
    if (wait === 'idle') {
      const result = await waitForIdle(sessionId, ctx, resolvedTimeoutMs);
      waited_ms    = result.waited_ms;

      // W5: session exited during wait
      if (result.sessionExited) {
        ctx.log.warn('[trigger-watcher] Session exited during wait:', sessionId);
        await writeResult({ ok: false, error: 'session exited during wait', sessionId, waited_ms });
        return;
      }

      if (result.timedOut) {
        ctx.log.warn('[trigger-watcher] Idle timeout for session:', sessionId);
        await writeResult({ ok: false, error: 'timeout waiting for idle', sessionId, waited_ms });
        return;
      }
    }

    // W7 — re-check liveness right before writing.  The idle wait can be up to
    // 10 min (MAX_TRIGGER_TIMEOUT); the child may have exited during that
    // window while busy-was-true never flipped.  Without this re-check we'd
    // write into a dead PTY and claim ok:true.
    if (!isPtyAlive(ptyProcess)) {
      ctx.log.warn('[trigger-watcher] Target process exited during wait:', sessionId);
      await writeResult({ ok: false, error: 'target process not running', sessionId, waited_ms });
      return;
    }

    // Write to PTY: text, then Enter as a discrete keypress (see submitToPty),
    // then verify the submission actually started a turn — retrying the Enter
    // once if the busy rising edge never arrives (the 2026-06-04 "text stuck in
    // composer, Enter absorbed" incident).
    let submitRetries = 0;
    try {
      const v = await submitWithVerify(ptyProcess, sessionId, command, ctx);
      submitRetries = v.submit_retries;
      if (v.writeError) throw v.writeError;
    } catch (err) {
      ctx.log.error('[trigger-watcher] PTY write failed:', err.message);
      await writeResult({ ok: false, error: 'pty write failed: ' + err.message, sessionId });
      return;
    }

    ctx.log.info(`[trigger-watcher] Sent command to ${sessionId}: ${command}` +
      (submitRetries ? ` (submit retried ${submitRetries}x)` : ''));

    await writeResult({
      ok:             true,
      sessionId,
      command,
      sent_at:        new Date().toISOString(),
      waited_ms,
      submit_retries: submitRetries,
    });
    return;
  }

  // ── 6. Chain path ─────────────────────────────────────────────────────────
  // Global deadline for the whole chain
  const globalTimeout = (resolvedTimeoutMs !== undefined) ? resolvedTimeoutMs : getIdleTimeout();
  const globalDeadline = Date.now() + globalTimeout;

  const steps = [];
  let totalWaitedMs = 0;
  let step0SentAt = null;

  // W9 — helper: attempt to re-queue remaining chain steps starting at `firstUnsent`.
  // Returns the writeResult payload extras: requeued, requeue_trigger (on success)
  // or requeue_exhausted (at cap).
  function tryRequeue(firstUnsent) {
    const remaining = chain.slice(firstUnsent);
    if (remaining.length === 0) return {}; // nothing left to re-queue

    const newRequeueCount = requeueCount + 1;
    if (requeueCount >= MAX_REQUEUE) {
      ctx.log.warn(`[trigger-watcher] Chain requeue limit reached (${MAX_REQUEUE}), giving up:`, sessionId);
      return { requeue_exhausted: true };
    }

    const filename = writeRequeueTrigger(
      sessionId, remaining, newRequeueCount, timeout_ms, triggersDir, ctx.log,
    );
    if (!filename) {
      // writeRequeueTrigger already logged the error
      return { requeue_exhausted: true };
    }
    ctx.log.info(`[trigger-watcher] Chain re-queued (${newRequeueCount}/${MAX_REQUEUE}) → ${filename}:`, sessionId);
    return { requeued: true, requeue_trigger: filename };
  }

  // Step 0: initial wait (respects `wait` field)
  if (wait === 'idle') {
    const remainingMs = globalDeadline - Date.now();
    const result = await waitForIdle(sessionId, ctx, remainingMs);
    totalWaitedMs += result.waited_ms;

    if (result.sessionExited) {
      ctx.log.warn('[trigger-watcher] Session exited during chain initial wait:', sessionId);
      await writeResult({ ok: false, error: 'session exited during wait', partial: true, steps_completed: 0, sessionId, sent_at: step0SentAt, steps, total_waited_ms: totalWaitedMs });
      return;
    }

    if (result.timedOut || Date.now() >= globalDeadline) {
      ctx.log.warn('[trigger-watcher] Chain timeout during initial idle wait:', sessionId);
      // All steps are unsent — re-queue from step 0.
      const requeueExtras = tryRequeue(0);
      await writeResult({ ok: false, error: 'chain timeout', partial: true, steps_completed: 0, sessionId, sent_at: step0SentAt, steps, total_waited_ms: totalWaitedMs, ...requeueExtras });
      return;
    }
  }

  for (let i = 0; i < chain.length; i++) {
    const step = chain[i];

    // Check deadline before each step
    if (Date.now() >= globalDeadline) {
      ctx.log.warn(`[trigger-watcher] Chain global timeout before step ${i}:`, sessionId);
      // Steps 0..i-1 already sent; re-queue steps i..end.
      const requeueExtras = tryRequeue(i);
      await writeResult({ ok: false, error: 'chain timeout', partial: true, steps_completed: i, sessionId, sent_at: step0SentAt, steps, total_waited_ms: totalWaitedMs, ...requeueExtras });
      return;
    }

    // Re-check session still present
    const entry = ctx.getPtyForSession(sessionId);
    if (!entry) {
      ctx.log.warn(`[trigger-watcher] Session exited before chain step ${i}:`, sessionId);
      await writeResult({ ok: false, error: 'session exited during wait', partial: true, steps_completed: i, sessionId, sent_at: step0SentAt, steps, total_waited_ms: totalWaitedMs });
      return;
    }

    // W7 — liveness check before each step's write.  The previous step's turn
    // wait may have spanned several minutes; the child could have exited while
    // main.js still has a stale activeSessions entry.  See also the
    // liveness→write TOCTOU window: an exit between this probe and
    // `entry.ptyProcess.write()` below is bounded by the try/catch on write.
    if (!isPtyAlive(entry.ptyProcess)) {
      ctx.log.warn(`[trigger-watcher] Target process not running at chain step ${i}:`, sessionId);
      await writeResult({ ok: false, error: 'target process not running', partial: true, steps_completed: i, sessionId, sent_at: step0SentAt, steps, total_waited_ms: totalWaitedMs });
      return;
    }

    // Inject the step command
    const stepSentAt = new Date().toISOString();
    if (i === 0) step0SentAt = stepSentAt;

    // Per-step timeout_ms (if set) bounds THIS whole step (verify + retry + the
    // busy-fall wait for non-final steps), capped by the remaining global
    // deadline — mirroring the old combined waitForTurnComplete deadline.
    let stepTimeoutMs;
    if (step.timeout_ms !== undefined) {
      stepTimeoutMs = Math.min(step.timeout_ms, globalDeadline - Date.now());
    } else {
      stepTimeoutMs = globalDeadline - Date.now();
    }
    const stepDeadline = Date.now() + stepTimeoutMs;

    // Submit the step and verify the turn actually started (busy rising edge).
    // The verify poll IS this step's Phase 1 (busy-rise) — for non-final steps
    // we proceed straight to the busy-FALL wait, never re-observing the rise.
    // The verify window is bounded by this step's deadline; if no rise arrives
    // we retry the bare Enter once (harmless no-op if already submitted).
    let submitRetries = 0;
    let stepWaitedMs = 0;
    let verify;
    try {
      verify = await submitWithVerify(entry.ptyProcess, sessionId, step.command, ctx, stepDeadline);
    } catch (err) {
      ctx.log.error(`[trigger-watcher] PTY write failed at chain step ${i}:`, err.message);
      await writeResult({ ok: false, error: 'pty write failed: ' + err.message, partial: true, steps_completed: i, sessionId, sent_at: step0SentAt, steps, total_waited_ms: totalWaitedMs });
      return;
    }
    if (verify.writeError) {
      ctx.log.error(`[trigger-watcher] PTY write failed at chain step ${i}:`, verify.writeError.message);
      await writeResult({ ok: false, error: 'pty write failed: ' + verify.writeError.message, partial: true, steps_completed: i, sessionId, sent_at: step0SentAt, steps, total_waited_ms: totalWaitedMs });
      return;
    }
    submitRetries = verify.submit_retries;
    stepWaitedMs += verify.waited_ms;
    totalWaitedMs += verify.waited_ms;

    ctx.log.info(`[trigger-watcher] Chain step ${i} sent to ${sessionId}: ${step.command}` +
      (submitRetries ? ` (submit retried ${submitRetries}x)` : ''));

    // Session exited / global timeout observed during verify.
    if (verify.sessionExited) {
      ctx.log.warn(`[trigger-watcher] Session exited during chain step ${i} submit verify:`, sessionId);
      steps.push({ idx: i, command: step.command, sent_at: stepSentAt, waited_ms: stepWaitedMs, submit_retries: submitRetries });
      await writeResult({ ok: false, error: 'session exited during wait', partial: true, steps_completed: i, sessionId, sent_at: step0SentAt, steps, total_waited_ms: totalWaitedMs });
      return;
    }
    if (verify.timedOut) {
      ctx.log.warn(`[trigger-watcher] Chain timeout during step ${i} submit verify:`, sessionId);
      steps.push({ idx: i, command: step.command, sent_at: stepSentAt, waited_ms: stepWaitedMs, submit_retries: submitRetries });
      // Step i was submitted but verify timed out; step i is "in-flight" — re-queue i+1..end.
      const requeueExtras = tryRequeue(i + 1);
      await writeResult({ ok: false, error: 'chain timeout', partial: true, steps_completed: i, sessionId, sent_at: step0SentAt, steps, total_waited_ms: totalWaitedMs, ...requeueExtras });
      return;
    }

    // For non-final steps, wait for the turn to FINISH (busy falling edge).
    // submitWithVerify already consumed the rising edge. If the rise was never
    // observed (instant-reply / unconfirmed submit), busy is already false and
    // this returns immediately — preserving the legacy instant-reply behaviour
    // while submit_retries records that verification could not confirm a turn.
    if (i < chain.length - 1) {
      // Same per-step deadline as the verify above — bounds the busy-fall wait.
      const result = await waitForBusyFall(sessionId, ctx, stepDeadline);
      stepWaitedMs += result.waited_ms;
      totalWaitedMs += result.waited_ms;

      if (result.sessionExited) {
        ctx.log.warn(`[trigger-watcher] Session exited during chain step ${i} turn wait:`, sessionId);
        steps.push({ idx: i, command: step.command, sent_at: stepSentAt, waited_ms: stepWaitedMs, submit_retries: submitRetries });
        await writeResult({ ok: false, error: 'session exited during wait', partial: true, steps_completed: i, sessionId, sent_at: step0SentAt, steps, total_waited_ms: totalWaitedMs });
        return;
      }

      if (result.timedOut) {
        ctx.log.warn(`[trigger-watcher] Chain timeout at step ${i}:`, sessionId);
        steps.push({ idx: i, command: step.command, sent_at: stepSentAt, waited_ms: stepWaitedMs, submit_retries: submitRetries });
        // Step i completed (rise observed, send done); re-queue steps i+1..end.
        const requeueExtras = tryRequeue(i + 1);
        await writeResult({ ok: false, error: 'chain timeout', partial: true, steps_completed: i, sessionId, sent_at: step0SentAt, steps, total_waited_ms: totalWaitedMs, ...requeueExtras });
        return;
      }
    }

    steps.push({ idx: i, command: step.command, sent_at: stepSentAt, waited_ms: stepWaitedMs, submit_retries: submitRetries });
  }

  await writeResult({
    ok:               true,
    sessionId,
    sent_at:          step0SentAt,
    steps,
    total_waited_ms:  totalWaitedMs,
  });
}

/**
 * Start the trigger watcher.
 *
 * @param {object} ctx
 * @param {function} ctx.getPtyForSession  (sessionId: string) => { ptyProcess } | null
 * @param {function} ctx.isSessionBusy     (sessionId: string) => boolean
 * @param {function} [ctx.isPtyAlive]      (ptyProcess) => boolean (default: signal 0 probe)
 * @param {object}   ctx.log               electron-log compatible logger
 * @returns {{ close(): void }}
 */
function start(ctx) {
  const triggersDir  = getTriggersDir();
  const processedDir = path.join(triggersDir, 'processed');

  // Ensure directories exist
  try {
    fs.mkdirSync(triggersDir,  { recursive: true });
    fs.mkdirSync(processedDir, { recursive: true });
  } catch (err) {
    ctx.log.error('[trigger-watcher] Failed to create trigger directories:', err.message);
    return { close() {} };
  }

  ctx.log.info('[trigger-watcher] Watching:', triggersDir);

  // Track in-flight processing to avoid double-processing on noisy fs events.
  // W4: also enforces the MAX_INFLIGHT concurrency cap.
  const inFlight = new Set();
  // W4: queue of filenames awaiting an in-flight slot
  const waitQueue = [];

  function scheduleNext() {
    while (waitQueue.length > 0 && inFlight.size < MAX_INFLIGHT) {
      const filename = waitQueue.shift();
      // Dedup: may have been enqueued twice before a slot opened
      if (inFlight.has(filename)) continue;
      dispatch(filename);
    }
  }

  function dispatch(filename) {
    inFlight.add(filename);
    processTriggerFile(filename, ctx, triggersDir, processedDir).finally(() => {
      inFlight.delete(filename);
      scheduleNext();
    });
  }

  let watcher;
  try {
    watcher = fs.watch(triggersDir, { persistent: true }, (eventType, filename) => {
      if (eventType !== 'rename') return;
      if (!filename || !filename.endsWith('.json')) return;
      // Ignore files inside subdirectories (e.g. processed/) — fs.watch on
      // Linux only reports the basename for non-recursive watches, but be
      // defensive: skip anything that looks like a path separator.
      if (filename.includes('/') || filename.includes(path.sep)) return;
      if (inFlight.has(filename)) return;

      // Confirm the file still exists (the rename event fires on delete too)
      const filePath = path.join(triggersDir, filename);
      try {
        fs.accessSync(filePath, fs.constants.R_OK);
      } catch {
        return; // File gone or not readable yet — skip
      }

      if (inFlight.size >= MAX_INFLIGHT) {
        // W4: backpressure — queue for later
        waitQueue.push(filename);
        return;
      }
      dispatch(filename);
    });

    watcher.on('error', (err) => {
      ctx.log.error('[trigger-watcher] Watcher error:', err.message);
    });
  } catch (err) {
    ctx.log.error('[trigger-watcher] Failed to start watcher:', err.message);
    return { close() {} };
  }

  return {
    close() {
      try { watcher.close(); } catch {}
    },
  };
}

module.exports = { start };
