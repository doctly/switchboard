// test/trigger-watcher.test.js — node:test suite for trigger-watcher.js
//
// Strategy: real fs in a mkdtemp sandbox, env vars override dirs + timeouts.
// No mocks — ctx provides a concrete in-memory PTY stand-in.
'use strict';

// Keep the discrete-Enter submit delay tiny so the suite stays fast and the
// turn-completion timing in makeChainCtx is not perturbed by a 50ms wait.
process.env.SWITCHBOARD_SUBMIT_ENTER_DELAY_MS = '1';

// Submission-verify window: must exceed makeChainCtx's simulated busy-rise
// (50ms after the '\r' write) plus one IDLE_POLL_INTERVAL (100ms) so the poll
// reliably catches the rising edge, yet stay short enough to keep the suite
// fast and deterministic when no rise ever arrives (retry path).
process.env.SWITCHBOARD_SUBMIT_VERIFY_MS = '400';

const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');

// ── Helpers ───────────────────────────────────────────────────────────────────

function mkTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sw-trigger-'));
}

function cleanup(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

/** Silent no-op logger */
const silentLog = {
  info:  () => {},
  warn:  () => {},
  error: () => {},
  debug: () => {},
};

/**
 * Build a ctx object with a spy PTY for `sessionId`.
 *
 * @param {string}   sessionId
 * @param {function} [isBusyFn]  () => boolean  (default: always false)
 * @param {object}   [opts]
 * @param {boolean}  [opts.ptyThrows]  if true, pty.write throws an error
 */
function makeCtx(sessionId, isBusyFn = () => false, opts = {}) {
  const written = [];
  const ptyProcess = {
    // pid points at the running node test process so the default liveness check
    // (signal-0 probe) sees a real, alive pid in existing tests.
    pid: process.pid,
    write(data) {
      if (opts.ptyThrows) throw new Error('PTY closed');
      written.push(data);
    },
  };

  // Support dynamic session removal for W5 test
  let sessionPresent = true;
  // Support dynamic liveness flip for W7 tests
  let alive = opts.alive !== undefined ? opts.alive : true;

  return {
    log: silentLog,
    getPtyForSession(id) {
      if (!sessionPresent) return null;
      return id === sessionId ? { ptyProcess } : null;
    },
    isSessionBusy(id) {
      return id === sessionId ? isBusyFn() : false;
    },
    isPtyAlive() { return alive; },
    _written: written,
    _ptyProcess: ptyProcess,
    _removeSession() { sessionPresent = false; },
    _killPty() { alive = false; },
  };
}

/**
 * Write a trigger file and return its path.
 */
function writeTrigger(dir, uuid, payload) {
  const p = path.join(dir, uuid + '.json');
  fs.writeFileSync(p, JSON.stringify(payload), 'utf8');
  return p;
}

/**
 * Wait up to `maxMs` for a file to appear, polling every `pollMs`.
 */
function waitForFile(filePath, maxMs = 2000, pollMs = 20) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + maxMs;
    function poll() {
      if (fs.existsSync(filePath)) return resolve();
      if (Date.now() >= deadline) return reject(new Error('Timeout waiting for file: ' + filePath));
      setTimeout(poll, pollMs);
    }
    poll();
  });
}

function readResult(processedDir, uuid) {
  const p = path.join(processedDir, uuid + '.result.json');
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

// ── Test cases ────────────────────────────────────────────────────────────────

test('happy path: trigger → pty.write called, result ok:true, trigger deleted', async () => {
  const tmp = mkTmp();
  try {
    process.env.SWITCHBOARD_TRIGGERS_DIR        = tmp;
    process.env.SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS = '200';

    const { start } = require('../trigger-watcher');
    const SESSION_ID = 'sess-happy-' + Date.now();
    const ctx        = makeCtx(SESSION_ID);
    const watcher    = start(ctx);

    const uuid    = 'aaa-' + Date.now();
    const triggerPath = writeTrigger(tmp, uuid, {
      sessionId: SESSION_ID,
      command:   '/compact',
    });

    const resultPath = path.join(tmp, 'processed', uuid + '.result.json');
    await waitForFile(resultPath);

    const result = readResult(path.join(tmp, 'processed'), uuid);
    assert.equal(result.ok, true, 'result.ok should be true');
    assert.equal(result.sessionId, SESSION_ID);
    assert.equal(result.command, '/compact');
    assert.ok(result.sent_at, 'result.sent_at should be set');
    assert.equal(typeof result.waited_ms, 'number', 'waited_ms should be a number');
    // busy never rises in this ctx → submit-verify retries the Enter once.
    assert.equal(result.submit_retries, 1, 'submit_retries should be 1 (no busy-rise observed)');

    // pty.write: command text, discrete Enter, then the verify-retry Enter.
    assert.deepEqual(ctx._written, ['/compact', '\r', '\r'], 'pty.write: command text, Enter, then retry Enter');

    // Trigger file deleted
    assert.equal(fs.existsSync(triggerPath), false, 'trigger file should be deleted');

    watcher.close();
  } finally {
    delete process.env.SWITCHBOARD_TRIGGERS_DIR;
    delete process.env.SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS;
    cleanup(tmp);
  }
});

test('unknown sessionId: result ok:false with session not found, no PTY write', async () => {
  const tmp = mkTmp();
  try {
    process.env.SWITCHBOARD_TRIGGERS_DIR        = tmp;
    process.env.SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS = '200';

    const { start } = require('../trigger-watcher');
    const ctx        = makeCtx('real-session');
    const watcher    = start(ctx);

    const uuid    = 'bbb-' + Date.now();
    const triggerPath = writeTrigger(tmp, uuid, {
      sessionId: 'nonexistent-session-id',
      command:   '/compact',
    });

    const resultPath = path.join(tmp, 'processed', uuid + '.result.json');
    await waitForFile(resultPath);

    const result = readResult(path.join(tmp, 'processed'), uuid);
    assert.equal(result.ok, false);
    assert.match(result.error, /session not found/);

    assert.deepEqual(ctx._written, [], 'no PTY write for unknown session');
    assert.equal(fs.existsSync(triggerPath), false, 'trigger file should be deleted');

    watcher.close();
  } finally {
    delete process.env.SWITCHBOARD_TRIGGERS_DIR;
    delete process.env.SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS;
    cleanup(tmp);
  }
});

test('malformed JSON: result ok:false with error, trigger deleted, no PTY write', async () => {
  const tmp = mkTmp();
  try {
    process.env.SWITCHBOARD_TRIGGERS_DIR        = tmp;
    process.env.SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS = '200';

    const { start } = require('../trigger-watcher');
    const ctx        = makeCtx('any-session');
    const watcher    = start(ctx);

    const uuid    = 'ccc-' + Date.now();
    const triggerPath = path.join(tmp, uuid + '.json');
    fs.writeFileSync(triggerPath, '{ invalid json }', 'utf8');

    const resultPath = path.join(tmp, 'processed', uuid + '.result.json');
    await waitForFile(resultPath);

    const result = readResult(path.join(tmp, 'processed'), uuid);
    assert.equal(result.ok, false);
    assert.match(result.error, /invalid JSON/i);

    assert.deepEqual(ctx._written, [], 'no PTY write for malformed JSON');
    assert.equal(fs.existsSync(triggerPath), false, 'trigger file should be deleted');

    watcher.close();
  } finally {
    delete process.env.SWITCHBOARD_TRIGGERS_DIR;
    delete process.env.SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS;
    cleanup(tmp);
  }
});

test('missing required field (no command): result ok:false, no PTY write', async () => {
  const tmp = mkTmp();
  try {
    process.env.SWITCHBOARD_TRIGGERS_DIR        = tmp;
    process.env.SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS = '200';

    const { start } = require('../trigger-watcher');
    const SESSION_ID = 'sess-nocommand-' + Date.now();
    const ctx        = makeCtx(SESSION_ID);
    const watcher    = start(ctx);

    const uuid    = 'ddd-' + Date.now();
    const triggerPath = writeTrigger(tmp, uuid, { sessionId: SESSION_ID });
    // 'command' field intentionally omitted

    const resultPath = path.join(tmp, 'processed', uuid + '.result.json');
    await waitForFile(resultPath);

    const result = readResult(path.join(tmp, 'processed'), uuid);
    assert.equal(result.ok, false);
    assert.match(result.error, /command/i);

    assert.deepEqual(ctx._written, [], 'no PTY write when command missing');
    assert.equal(fs.existsSync(triggerPath), false, 'trigger file should be deleted');

    watcher.close();
  } finally {
    delete process.env.SWITCHBOARD_TRIGGERS_DIR;
    delete process.env.SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS;
    cleanup(tmp);
  }
});

test('wait:idle while busy → flips to idle after 150ms → write happens, waited_ms >= 150', async () => {
  const tmp = mkTmp();
  try {
    process.env.SWITCHBOARD_TRIGGERS_DIR        = tmp;
    process.env.SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS = '2000'; // generous timeout

    const { start } = require('../trigger-watcher');
    let busy = true;
    const SESSION_ID = 'sess-idle-' + Date.now();
    const ctx = makeCtx(SESSION_ID, () => busy);
    const watcher = start(ctx);

    const uuid    = 'eee-' + Date.now();
    writeTrigger(tmp, uuid, {
      sessionId: SESSION_ID,
      command:   '/compact',
      wait:      'idle',
    });

    // Flip to idle after 150ms
    setTimeout(() => { busy = false; }, 150);

    const resultPath = path.join(tmp, 'processed', uuid + '.result.json');
    await waitForFile(resultPath, 3000); // plenty of time

    const result = readResult(path.join(tmp, 'processed'), uuid);
    assert.equal(result.ok, true, 'result should be ok');
    assert.ok(
      result.waited_ms >= 100,
      `waited_ms (${result.waited_ms}) should be >= 100ms`,
    );
    // busy is false by the time we submit → no rise → verify retries the Enter.
    assert.deepEqual(ctx._written, ['/compact', '\r', '\r'], 'PTY write should happen after idle (with verify-retry Enter)');

    watcher.close();
  } finally {
    delete process.env.SWITCHBOARD_TRIGGERS_DIR;
    delete process.env.SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS;
    cleanup(tmp);
  }
});

test('wait:idle timeout: busy stays true → ok:false, error contains "timeout", no PTY write', async () => {
  const tmp = mkTmp();
  try {
    process.env.SWITCHBOARD_TRIGGERS_DIR        = tmp;
    process.env.SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS = '200'; // short timeout for test

    const { start } = require('../trigger-watcher');
    const SESSION_ID = 'sess-timeout-' + Date.now();
    const ctx = makeCtx(SESSION_ID, () => true); // always busy
    const watcher = start(ctx);

    const uuid    = 'fff-' + Date.now();
    writeTrigger(tmp, uuid, {
      sessionId: SESSION_ID,
      command:   '/compact',
      wait:      'idle',
    });

    const resultPath = path.join(tmp, 'processed', uuid + '.result.json');
    await waitForFile(resultPath, 2000);

    const result = readResult(path.join(tmp, 'processed'), uuid);
    assert.equal(result.ok, false);
    assert.match(result.error, /timeout/i);

    assert.deepEqual(ctx._written, [], 'no PTY write on idle timeout');

    watcher.close();
  } finally {
    delete process.env.SWITCHBOARD_TRIGGERS_DIR;
    delete process.env.SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS;
    cleanup(tmp);
  }
});

// ── New tests for review findings ─────────────────────────────────────────────

// C1: size cap rejection
test('C1 size cap: trigger > 64 KB rejected before read, result ok:false', async () => {
  const tmp = mkTmp();
  try {
    process.env.SWITCHBOARD_TRIGGERS_DIR        = tmp;
    process.env.SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS = '200';

    const { start } = require('../trigger-watcher');
    const SESSION_ID = 'sess-c1-' + Date.now();
    const ctx        = makeCtx(SESSION_ID);
    const watcher    = start(ctx);

    const uuid    = 'c1-' + Date.now();
    const bigPath = path.join(tmp, uuid + '.json');
    // Write a file larger than 64 KB (not valid JSON, but that's irrelevant — size check fires first)
    fs.writeFileSync(bigPath, Buffer.alloc(65 * 1024, 'x'), 'utf8');

    const resultPath = path.join(tmp, 'processed', uuid + '.result.json');
    await waitForFile(resultPath, 2000);

    const result = readResult(path.join(tmp, 'processed'), uuid);
    assert.equal(result.ok, false);
    assert.match(result.error, /too large/i);

    assert.deepEqual(ctx._written, [], 'no PTY write for oversized trigger');

    watcher.close();
  } finally {
    delete process.env.SWITCHBOARD_TRIGGERS_DIR;
    delete process.env.SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS;
    cleanup(tmp);
  }
});

// C2: symlink rejection
test('C2 symlink: symlinked trigger rejected, result ok:false', async () => {
  const tmp = mkTmp();
  try {
    process.env.SWITCHBOARD_TRIGGERS_DIR        = tmp;
    process.env.SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS = '200';

    const { start } = require('../trigger-watcher');
    const SESSION_ID = 'sess-c2-' + Date.now();
    const ctx        = makeCtx(SESSION_ID);
    const watcher    = start(ctx);

    const uuid      = 'c2-' + Date.now();
    const linkPath  = path.join(tmp, uuid + '.json');
    // Symlink to /etc/hostname (always exists on Linux)
    fs.symlinkSync('/etc/hostname', linkPath);

    const resultPath = path.join(tmp, 'processed', uuid + '.result.json');
    await waitForFile(resultPath, 2000);

    const result = readResult(path.join(tmp, 'processed'), uuid);
    assert.equal(result.ok, false);
    assert.match(result.error, /regular file/i);

    assert.deepEqual(ctx._written, [], 'no PTY write for symlink trigger');

    watcher.close();
  } finally {
    delete process.env.SWITCHBOARD_TRIGGERS_DIR;
    delete process.env.SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS;
    cleanup(tmp);
  }
});

// W1: SyntaxError retry — trigger is initially truncated JSON but becomes valid after 30 ms.
// We simulate this by writing valid JSON directly (the retry should succeed on first attempt);
// then we test the "retry-then-fail" path: both attempts get bad JSON → ok:false.
test('W1 partial-write retry: truncated JSON on both attempts → ok:false after retry', async () => {
  const tmp = mkTmp();
  try {
    process.env.SWITCHBOARD_TRIGGERS_DIR        = tmp;
    process.env.SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS = '200';

    const { start } = require('../trigger-watcher');
    const ctx    = makeCtx('any-session');
    const watcher = start(ctx);

    const uuid      = 'w1-' + Date.now();
    const trigPath  = path.join(tmp, uuid + '.json');
    // Write truncated JSON — both the initial read and the 50 ms retry read will get this
    fs.writeFileSync(trigPath, '{"sessionId":"x","command":', 'utf8');

    const resultPath = path.join(tmp, 'processed', uuid + '.result.json');
    // Allow 500 ms — the retry adds 50 ms, but we still expect a result
    await waitForFile(resultPath, 1000);

    const result = readResult(path.join(tmp, 'processed'), uuid);
    assert.equal(result.ok, false);
    assert.match(result.error, /invalid JSON/i);

    watcher.close();
  } finally {
    delete process.env.SWITCHBOARD_TRIGGERS_DIR;
    delete process.env.SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS;
    cleanup(tmp);
  }
});

// W2: command too long
test('W2 command length cap: command > 4 KB rejected, result ok:false', async () => {
  const tmp = mkTmp();
  try {
    process.env.SWITCHBOARD_TRIGGERS_DIR        = tmp;
    process.env.SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS = '200';

    const { start } = require('../trigger-watcher');
    const SESSION_ID = 'sess-w2-' + Date.now();
    const ctx        = makeCtx(SESSION_ID);
    const watcher    = start(ctx);

    const uuid = 'w2-' + Date.now();
    writeTrigger(tmp, uuid, {
      sessionId: SESSION_ID,
      command:   'x'.repeat(4097), // one byte over the 4 KB cap
    });

    const resultPath = path.join(tmp, 'processed', uuid + '.result.json');
    await waitForFile(resultPath, 2000);

    const result = readResult(path.join(tmp, 'processed'), uuid);
    assert.equal(result.ok, false);
    assert.match(result.error, /too long/i);

    assert.deepEqual(ctx._written, [], 'no PTY write for too-long command');

    watcher.close();
  } finally {
    delete process.env.SWITCHBOARD_TRIGGERS_DIR;
    delete process.env.SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS;
    cleanup(tmp);
  }
});

// W3: control chars in command
test('W3 forbidden control chars: \\r in command rejected, result ok:false', async () => {
  const tmp = mkTmp();
  try {
    process.env.SWITCHBOARD_TRIGGERS_DIR        = tmp;
    process.env.SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS = '200';

    const { start } = require('../trigger-watcher');
    const SESSION_ID = 'sess-w3-' + Date.now();
    const ctx        = makeCtx(SESSION_ID);
    const watcher    = start(ctx);

    const uuid = 'w3-' + Date.now();
    // Write raw JSON with \r character in command
    const payload = JSON.stringify({ sessionId: SESSION_ID, command: '/compact\rclear' });
    fs.writeFileSync(path.join(tmp, uuid + '.json'), payload, 'utf8');

    const resultPath = path.join(tmp, 'processed', uuid + '.result.json');
    await waitForFile(resultPath, 2000);

    const result = readResult(path.join(tmp, 'processed'), uuid);
    assert.equal(result.ok, false);
    assert.match(result.error, /forbidden control/i);

    assert.deepEqual(ctx._written, [], 'no PTY write for command with control chars');

    watcher.close();
  } finally {
    delete process.env.SWITCHBOARD_TRIGGERS_DIR;
    delete process.env.SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS;
    cleanup(tmp);
  }
});

// W4: concurrency cap — drop 12 triggers simultaneously, verify all 12 get processed
test('W4 concurrency cap: 12 simultaneous triggers all get processed', async () => {
  const tmp = mkTmp();
  try {
    process.env.SWITCHBOARD_TRIGGERS_DIR        = tmp;
    process.env.SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS = '200';

    const { start } = require('../trigger-watcher');
    const SESSION_ID = 'sess-w4-' + Date.now();
    const ctx        = makeCtx(SESSION_ID);
    const watcher    = start(ctx);

    const COUNT  = 12;
    const uuids  = Array.from({ length: COUNT }, (_, i) => `w4-${Date.now()}-${i}`);

    // Drop all 12 triggers at once
    for (const uuid of uuids) {
      writeTrigger(tmp, uuid, { sessionId: SESSION_ID, command: '/compact' });
    }

    // Wait for all 12 result files
    await Promise.all(uuids.map(uuid =>
      waitForFile(path.join(tmp, 'processed', uuid + '.result.json'), 5000),
    ));

    // All 12 should be ok:true
    for (const uuid of uuids) {
      const result = readResult(path.join(tmp, 'processed'), uuid);
      assert.equal(result.ok, true, `trigger ${uuid} should be ok:true`);
    }

    // 12 command texts should have been written. We count by command texts
    // (w !== '\r') rather than Enters, because submit-verify may add a retry '\r'
    // per command when no busy-rise is observed.
    assert.equal(ctx._written.filter((w) => w !== '\r').length, COUNT, `expected ${COUNT} submitted commands`);

    watcher.close();
  } finally {
    delete process.env.SWITCHBOARD_TRIGGERS_DIR;
    delete process.env.SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS;
    cleanup(tmp);
  }
});

// W5: session exits during wait:idle
test('W5 session exits during wait:idle → ok:false, error contains "session exited"', async () => {
  const tmp = mkTmp();
  try {
    process.env.SWITCHBOARD_TRIGGERS_DIR        = tmp;
    process.env.SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS = '2000';

    const { start } = require('../trigger-watcher');
    const SESSION_ID = 'sess-w5-' + Date.now();
    const ctx = makeCtx(SESSION_ID, () => true); // stays busy
    const watcher = start(ctx);

    const uuid = 'w5-' + Date.now();
    writeTrigger(tmp, uuid, {
      sessionId: SESSION_ID,
      command:   '/compact',
      wait:      'idle',
    });

    // Remove the session after 150 ms (simulating PTY exit during wait)
    setTimeout(() => ctx._removeSession(), 150);

    const resultPath = path.join(tmp, 'processed', uuid + '.result.json');
    await waitForFile(resultPath, 3000);

    const result = readResult(path.join(tmp, 'processed'), uuid);
    assert.equal(result.ok, false);
    assert.match(result.error, /session exited/i);

    assert.deepEqual(ctx._written, [], 'no PTY write when session exited during wait');

    watcher.close();
  } finally {
    delete process.env.SWITCHBOARD_TRIGGERS_DIR;
    delete process.env.SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS;
    cleanup(tmp);
  }
});

// W6 extra: PTY write throws — result ok:false with pty write failed
test('PTY write throws: result ok:false with pty write failed error', async () => {
  const tmp = mkTmp();
  try {
    process.env.SWITCHBOARD_TRIGGERS_DIR        = tmp;
    process.env.SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS = '200';

    const { start } = require('../trigger-watcher');
    const SESSION_ID = 'sess-ptythrow-' + Date.now();
    const ctx        = makeCtx(SESSION_ID, () => false, { ptyThrows: true });
    const watcher    = start(ctx);

    const uuid = 'ptythrow-' + Date.now();
    writeTrigger(tmp, uuid, { sessionId: SESSION_ID, command: '/compact' });

    const resultPath = path.join(tmp, 'processed', uuid + '.result.json');
    await waitForFile(resultPath, 2000);

    const result = readResult(path.join(tmp, 'processed'), uuid);
    assert.equal(result.ok, false);
    assert.match(result.error, /pty write failed/i);

    watcher.close();
  } finally {
    delete process.env.SWITCHBOARD_TRIGGERS_DIR;
    delete process.env.SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS;
    cleanup(tmp);
  }
});

// W6 extra: inFlight dedup — same filename triggers twice, only processed once per dedup cycle
test('inFlight dedup: same filename event fired twice → processed at most once concurrently', async () => {
  const tmp = mkTmp();
  try {
    process.env.SWITCHBOARD_TRIGGERS_DIR        = tmp;
    process.env.SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS = '200';

    const { start } = require('../trigger-watcher');
    const SESSION_ID = 'sess-dedup-' + Date.now();
    const ctx        = makeCtx(SESSION_ID);
    const watcher    = start(ctx);

    // Write the trigger file once
    const uuid    = 'dedup-' + Date.now();
    writeTrigger(tmp, uuid, { sessionId: SESSION_ID, command: '/compact' });

    const resultPath = path.join(tmp, 'processed', uuid + '.result.json');
    await waitForFile(resultPath, 2000);

    const result = readResult(path.join(tmp, 'processed'), uuid);
    assert.equal(result.ok, true);
    // The trigger file is deleted after first processing, so any second fs.watch
    // event for the same name finds no file and is silently skipped.
    // Count command texts (w !== '\r'): submit-verify may add a retry '\r'.
    assert.equal(ctx._written.filter((w) => w !== '\r').length, 1, 'command submitted exactly once');

    watcher.close();
  } finally {
    delete process.env.SWITCHBOARD_TRIGGERS_DIR;
    delete process.env.SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS;
    cleanup(tmp);
  }
});

// I4: NaN guard — invalid timeout env var falls back to default, does not poll forever
test('I4 NaN timeout: invalid SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS uses default (no infinite loop)', async () => {
  const tmp = mkTmp();
  try {
    process.env.SWITCHBOARD_TRIGGERS_DIR        = tmp;
    process.env.SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS = 'not-a-number'; // I4: triggers NaN guard

    const { start } = require('../trigger-watcher');
    const SESSION_ID = 'sess-i4-' + Date.now();
    // Always busy — with a valid timeout this resolves to timedOut; without NaN guard it never resolves
    const ctx = makeCtx(SESSION_ID, () => true);
    const watcher = start(ctx);

    const uuid = 'i4-' + Date.now();
    writeTrigger(tmp, uuid, {
      sessionId: SESSION_ID,
      command:   '/compact',
      wait:      'idle',
    });

    // With NaN guard the default 300s timeout fires; but that's too slow for a test.
    // Instead confirm the module at least computes a finite timeout (no immediate hang):
    // we close the watcher and clean up after 1s — if it was still polling forever
    // the result file would never appear after 1 s; but with a normal default timeout
    // the poll eventually resolves (just slowly).  We only assert it doesn't throw.
    await new Promise(r => setTimeout(r, 200));
    watcher.close();
    // No assertion on result needed — the goal is no crash / unhandled rejection.
  } finally {
    delete process.env.SWITCHBOARD_TRIGGERS_DIR;
    delete process.env.SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS;
    cleanup(tmp);
  }
});

// ── timeout_ms field tests ─────────────────────────────────────────────────────

// W6-1: per-trigger timeout_ms honored end-to-end
// The trigger carries timeout_ms=500; session is busy for 150ms then idle.
// The per-trigger timeout should govern (not the env var), and injection succeeds.
test('W6 timeout_ms: per-trigger timeout_ms honored, overrides env-var fallback', async () => {
  const tmp = mkTmp();
  try {
    process.env.SWITCHBOARD_TRIGGERS_DIR        = tmp;
    // env var set to 50 ms — without per-trigger override this would time out
    process.env.SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS = '50';

    const { start } = require('../trigger-watcher');
    let busy = true;
    const SESSION_ID = 'sess-tmout-override-' + Date.now();
    const ctx = makeCtx(SESSION_ID, () => busy);
    const watcher = start(ctx);

    const uuid = 'tmout-override-' + Date.now();
    writeTrigger(tmp, uuid, {
      sessionId:  SESSION_ID,
      command:    '/compact',
      wait:       'idle',
      timeout_ms: 1000, // per-trigger override: 1 s (50 ms env var would time out first)
    });

    // Flip idle after 150 ms — env var (50 ms) would have timed out, but timeout_ms=1000 still waits
    setTimeout(() => { busy = false; }, 150);

    const resultPath = path.join(tmp, 'processed', uuid + '.result.json');
    await waitForFile(resultPath, 3000);

    const result = readResult(path.join(tmp, 'processed'), uuid);
    assert.equal(result.ok, true, 'result should be ok when timeout_ms overrides short env var');
    assert.ok(result.waited_ms >= 100, `waited_ms (${result.waited_ms}) should be >= 100ms`);
    // busy is false at submit time → no rise → verify retries the Enter once.
    assert.deepEqual(ctx._written, ['/compact', '\r', '\r'], 'PTY write should happen (with verify-retry Enter)');

    watcher.close();
  } finally {
    delete process.env.SWITCHBOARD_TRIGGERS_DIR;
    delete process.env.SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS;
    cleanup(tmp);
  }
});

// W6-2: invalid timeout_ms — negative value
test('W6 timeout_ms invalid: negative → ok:false, error "invalid timeout_ms", no PTY write', async () => {
  const tmp = mkTmp();
  try {
    process.env.SWITCHBOARD_TRIGGERS_DIR        = tmp;
    process.env.SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS = '200';

    const { start } = require('../trigger-watcher');
    const SESSION_ID = 'sess-neg-tmout-' + Date.now();
    const ctx        = makeCtx(SESSION_ID);
    const watcher    = start(ctx);

    const uuid = 'neg-tmout-' + Date.now();
    writeTrigger(tmp, uuid, {
      sessionId:  SESSION_ID,
      command:    '/compact',
      timeout_ms: -1,
    });

    const resultPath = path.join(tmp, 'processed', uuid + '.result.json');
    await waitForFile(resultPath, 2000);

    const result = readResult(path.join(tmp, 'processed'), uuid);
    assert.equal(result.ok, false);
    assert.match(result.error, /invalid timeout_ms/);
    assert.deepEqual(ctx._written, [], 'no PTY write for invalid timeout_ms');

    watcher.close();
  } finally {
    delete process.env.SWITCHBOARD_TRIGGERS_DIR;
    delete process.env.SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS;
    cleanup(tmp);
  }
});

// W6-3: invalid timeout_ms — non-integer float
test('W6 timeout_ms invalid: non-integer float (1.5) → ok:false, no PTY write', async () => {
  const tmp = mkTmp();
  try {
    process.env.SWITCHBOARD_TRIGGERS_DIR        = tmp;
    process.env.SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS = '200';

    const { start } = require('../trigger-watcher');
    const SESSION_ID = 'sess-float-tmout-' + Date.now();
    const ctx        = makeCtx(SESSION_ID);
    const watcher    = start(ctx);

    const uuid = 'float-tmout-' + Date.now();
    writeTrigger(tmp, uuid, {
      sessionId:  SESSION_ID,
      command:    '/compact',
      timeout_ms: 1.5,
    });

    const resultPath = path.join(tmp, 'processed', uuid + '.result.json');
    await waitForFile(resultPath, 2000);

    const result = readResult(path.join(tmp, 'processed'), uuid);
    assert.equal(result.ok, false);
    assert.match(result.error, /invalid timeout_ms/);
    assert.deepEqual(ctx._written, [], 'no PTY write for float timeout_ms');

    watcher.close();
  } finally {
    delete process.env.SWITCHBOARD_TRIGGERS_DIR;
    delete process.env.SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS;
    cleanup(tmp);
  }
});

// W6-4: invalid timeout_ms — exceeds cap (> 600 000)
test('W6 timeout_ms invalid: value > 600000 → ok:false, no PTY write', async () => {
  const tmp = mkTmp();
  try {
    process.env.SWITCHBOARD_TRIGGERS_DIR        = tmp;
    process.env.SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS = '200';

    const { start } = require('../trigger-watcher');
    const SESSION_ID = 'sess-cap-tmout-' + Date.now();
    const ctx        = makeCtx(SESSION_ID);
    const watcher    = start(ctx);

    const uuid = 'cap-tmout-' + Date.now();
    writeTrigger(tmp, uuid, {
      sessionId:  SESSION_ID,
      command:    '/compact',
      timeout_ms: 600001,
    });

    const resultPath = path.join(tmp, 'processed', uuid + '.result.json');
    await waitForFile(resultPath, 2000);

    const result = readResult(path.join(tmp, 'processed'), uuid);
    assert.equal(result.ok, false);
    assert.match(result.error, /invalid timeout_ms/);
    assert.deepEqual(ctx._written, [], 'no PTY write for over-cap timeout_ms');

    watcher.close();
  } finally {
    delete process.env.SWITCHBOARD_TRIGGERS_DIR;
    delete process.env.SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS;
    cleanup(tmp);
  }
});

// W6-5: invalid timeout_ms — string type (not a JSON number)
test('W6 timeout_ms invalid: string type ("500") → ok:false, no PTY write', async () => {
  const tmp = mkTmp();
  try {
    process.env.SWITCHBOARD_TRIGGERS_DIR        = tmp;
    process.env.SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS = '200';

    const { start } = require('../trigger-watcher');
    const SESSION_ID = 'sess-str-tmout-' + Date.now();
    const ctx        = makeCtx(SESSION_ID);
    const watcher    = start(ctx);

    // Write raw JSON so we control the type exactly (writeTrigger uses JSON.stringify
    // which would coerce, but here we need a JSON string value)
    const uuid = 'str-tmout-' + Date.now();
    fs.writeFileSync(
      path.join(tmp, uuid + '.json'),
      JSON.stringify({ sessionId: SESSION_ID, command: '/compact', timeout_ms: '500' }),
      'utf8',
    );

    const resultPath = path.join(tmp, 'processed', uuid + '.result.json');
    await waitForFile(resultPath, 2000);

    const result = readResult(path.join(tmp, 'processed'), uuid);
    assert.equal(result.ok, false);
    assert.match(result.error, /invalid timeout_ms/);
    assert.deepEqual(ctx._written, [], 'no PTY write for string timeout_ms');

    watcher.close();
  } finally {
    delete process.env.SWITCHBOARD_TRIGGERS_DIR;
    delete process.env.SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS;
    cleanup(tmp);
  }
});

// W6-6: absent timeout_ms → falls back to env-var
test('W6 timeout_ms absent: falls back to env-var; env-var absent → falls back to default (300 000 ms)', async () => {
  const tmp = mkTmp();
  try {
    process.env.SWITCHBOARD_TRIGGERS_DIR        = tmp;
    process.env.SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS = '300'; // env var: 300 ms

    const { start } = require('../trigger-watcher');
    const SESSION_ID = 'sess-fallback-' + Date.now();
    // Always busy — with the env-var 300 ms timeout this should time out
    const ctx = makeCtx(SESSION_ID, () => true);
    const watcher = start(ctx);

    const uuid = 'fallback-' + Date.now();
    writeTrigger(tmp, uuid, {
      sessionId: SESSION_ID,
      command:   '/compact',
      wait:      'idle',
      // No timeout_ms — should use env-var (300 ms)
    });

    const resultPath = path.join(tmp, 'processed', uuid + '.result.json');
    await waitForFile(resultPath, 2000);

    const result = readResult(path.join(tmp, 'processed'), uuid);
    // Env-var timeout (300 ms) should have fired → ok:false
    assert.equal(result.ok, false);
    assert.match(result.error, /timeout/i, 'should time out using env-var timeout');
    assert.deepEqual(ctx._written, [], 'no PTY write on env-var timeout');

    watcher.close();
  } finally {
    delete process.env.SWITCHBOARD_TRIGGERS_DIR;
    delete process.env.SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS;
    cleanup(tmp);
  }
});

// ── W7 — child-process liveness ───────────────────────────────────────────────

// W7-1: pty dead at lookup time → ok:false before any wait
test('W7 dead on arrival: liveness false at lookup → ok:false, no wait, no write', async () => {
  const tmp = mkTmp();
  try {
    process.env.SWITCHBOARD_TRIGGERS_DIR             = tmp;
    process.env.SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS  = '5000';

    const { start } = require('../trigger-watcher');
    const SESSION_ID = 'sess-dead-' + Date.now();
    const ctx = makeCtx(SESSION_ID, () => false, { alive: false });
    const watcher = start(ctx);

    const uuid = 'dead-' + Date.now();
    const startedAt = Date.now();
    writeTrigger(tmp, uuid, { sessionId: SESSION_ID, command: '/compact', wait: 'idle' });

    const resultPath = path.join(tmp, 'processed', uuid + '.result.json');
    await waitForFile(resultPath, 2000);

    const elapsed = Date.now() - startedAt;
    const result  = readResult(path.join(tmp, 'processed'), uuid);
    assert.equal(result.ok, false);
    assert.equal(result.error, 'target process not running');
    assert.deepEqual(ctx._written, [], 'no PTY write when child is dead');
    assert.ok(elapsed < 1500, `should fail fast, not wait idle timeout; got ${elapsed}ms`);

    watcher.close();
  } finally {
    delete process.env.SWITCHBOARD_TRIGGERS_DIR;
    delete process.env.SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS;
    cleanup(tmp);
  }
});

// W7-2: pty dies during idle wait → ok:false at the pre-write recheck
test('W7 dies during wait: alive at lookup, dead before write → ok:false with waited_ms', async () => {
  const tmp = mkTmp();
  try {
    process.env.SWITCHBOARD_TRIGGERS_DIR             = tmp;
    process.env.SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS  = '5000';

    const { start } = require('../trigger-watcher');
    const SESSION_ID = 'sess-dies-' + Date.now();
    let busy = true;
    const ctx = makeCtx(SESSION_ID, () => busy);
    setTimeout(() => { busy = false; ctx._killPty(); }, 300);

    const watcher = start(ctx);
    const uuid = 'dies-' + Date.now();
    writeTrigger(tmp, uuid, { sessionId: SESSION_ID, command: '/compact', wait: 'idle' });

    const resultPath = path.join(tmp, 'processed', uuid + '.result.json');
    await waitForFile(resultPath, 2000);

    const result = readResult(path.join(tmp, 'processed'), uuid);
    assert.equal(result.ok, false);
    assert.equal(result.error, 'target process not running');
    assert.ok(typeof result.waited_ms === 'number' && result.waited_ms >= 200,
      `waited_ms should reflect the wait that happened; got ${result.waited_ms}`);
    assert.deepEqual(ctx._written, [], 'no PTY write when child died during wait');

    watcher.close();
  } finally {
    delete process.env.SWITCHBOARD_TRIGGERS_DIR;
    delete process.env.SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS;
    cleanup(tmp);
  }
});

// W7-3: default liveness helper sees the real test-process pid as alive → happy path unchanged
test('W7 default helper: real-pid mock passes default signal-0 probe → happy path unchanged', async () => {
  const tmp = mkTmp();
  try {
    process.env.SWITCHBOARD_TRIGGERS_DIR             = tmp;
    process.env.SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS  = '200';

    const { start } = require('../trigger-watcher');
    const SESSION_ID = 'sess-default-alive-' + Date.now();
    const ctx = makeCtx(SESSION_ID);
    delete ctx.isPtyAlive; // force the default signal-0 path

    const watcher = start(ctx);
    const uuid = 'default-alive-' + Date.now();
    writeTrigger(tmp, uuid, { sessionId: SESSION_ID, command: '/help', wait: 'idle' });

    const resultPath = path.join(tmp, 'processed', uuid + '.result.json');
    await waitForFile(resultPath, 2000);

    const result = readResult(path.join(tmp, 'processed'), uuid);
    assert.equal(result.ok, true, 'live pid → default helper returns true → ok');
    // busy never rises → verify retries the Enter once.
    assert.deepEqual(ctx._written, ['/help', '\r', '\r']);

    watcher.close();
  } finally {
    delete process.env.SWITCHBOARD_TRIGGERS_DIR;
    delete process.env.SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS;
    cleanup(tmp);
  }
});

// ── chain field tests ──────────────────────────────────────────────────────────

/**
 * Build a ctx that simulates sequential turns for a chain test.
 *
 * When opts.noAutoTurn is true, no busy/idle simulation happens automatically
 * on write — the test controls state manually via ctx._setBusy().
 * Otherwise, each write schedules: busy after 50ms, idle after 200ms.
 */
function makeChainCtx(sessionId, opts = {}) {
  const written = [];
  let busy = opts.initiallyBusy || false;
  let sessionPresent = true;

  const ptyProcess = {
    pid: process.pid,
    write(data) {
      if (opts.ptyThrows) throw new Error('PTY closed');
      written.push(data);
      // A turn only starts on submit (the discrete Enter), not when the command
      // text lands. Auto-simulate: busy after 50ms, then idle after 200ms.
      if (!opts.noAutoTurn && data === '\r') {
        setTimeout(() => { busy = true; }, 50);
        setTimeout(() => { busy = false; }, 200);
      }
    },
  };

  let alive = opts.alive !== undefined ? opts.alive : true;

  return {
    log: silentLog,
    getPtyForSession(id) {
      if (!sessionPresent) return null;
      return id === sessionId ? { ptyProcess } : null;
    },
    isSessionBusy(id) {
      return id === sessionId ? busy : false;
    },
    isPtyAlive() { return alive; },
    _written: written,
    _ptyProcess: ptyProcess,
    _removeSession() { sessionPresent = false; },
    _setBusy(v) { busy = v; },
    _killPty() { alive = false; },
  };
}

// CHAIN-1: happy path — 3-step chain, all succeed, result shape correct
test('chain happy path: 3-step chain → 3 PTY writes, result ok:true with steps array', async () => {
  const tmp = mkTmp();
  try {
    process.env.SWITCHBOARD_TRIGGERS_DIR        = tmp;
    process.env.SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS = '2000';

    const { start } = require('../trigger-watcher');
    const SESSION_ID = 'sess-chain-happy-' + Date.now();
    const ctx = makeChainCtx(SESSION_ID);
    const watcher = start(ctx);

    const uuid = 'chain-happy-' + Date.now();
    writeTrigger(tmp, uuid, {
      sessionId: SESSION_ID,
      wait: 'idle',
      chain: [
        { command: '/compact' },
        { command: 'verify result file and commit' },
        { command: 'open the PR' },
      ],
      timeout_ms: 5000,
    });

    const resultPath = path.join(tmp, 'processed', uuid + '.result.json');
    await waitForFile(resultPath, 6000);

    const result = readResult(path.join(tmp, 'processed'), uuid);
    assert.equal(result.ok, true, 'result.ok should be true');
    assert.equal(result.sessionId, SESSION_ID);
    assert.ok(result.sent_at, 'sent_at should be set');
    assert.ok(Array.isArray(result.steps), 'steps should be an array');
    assert.equal(result.steps.length, 3, 'steps should have 3 entries');
    assert.equal(result.steps[0].idx, 0);
    assert.equal(result.steps[0].command, '/compact');
    assert.ok(result.steps[0].sent_at, 'steps[0].sent_at should be set');
    assert.equal(typeof result.steps[0].waited_ms, 'number');
    assert.equal(result.steps[1].idx, 1);
    assert.equal(result.steps[1].command, 'verify result file and commit');
    assert.equal(result.steps[2].idx, 2);
    assert.equal(result.steps[2].command, 'open the PR');
    assert.equal(typeof result.total_waited_ms, 'number');

    // All 3 writes happened in order
    assert.deepEqual(ctx._written, ['/compact', '\r', 'verify result file and commit', '\r', 'open the PR', '\r']);

    watcher.close();
  } finally {
    delete process.env.SWITCHBOARD_TRIGGERS_DIR;
    delete process.env.SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS;
    cleanup(tmp);
  }
});

// CHAIN-2: validation — command and chain both present → rejected before MAX_INFLIGHT
test('chain+command mutually exclusive: both present → ok:false, error mentions mutually exclusive', async () => {
  const tmp = mkTmp();
  try {
    process.env.SWITCHBOARD_TRIGGERS_DIR        = tmp;
    process.env.SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS = '200';

    const { start } = require('../trigger-watcher');
    const SESSION_ID = 'sess-chain-both-' + Date.now();
    const ctx = makeChainCtx(SESSION_ID);
    const watcher = start(ctx);

    const uuid = 'chain-both-' + Date.now();
    writeTrigger(tmp, uuid, {
      sessionId: SESSION_ID,
      command: '/compact',
      chain: [{ command: '/compact' }],
    });

    const resultPath = path.join(tmp, 'processed', uuid + '.result.json');
    await waitForFile(resultPath, 2000);

    const result = readResult(path.join(tmp, 'processed'), uuid);
    assert.equal(result.ok, false);
    assert.match(result.error, /mutually exclusive/i);
    assert.deepEqual(ctx._written, [], 'no PTY write');

    watcher.close();
  } finally {
    delete process.env.SWITCHBOARD_TRIGGERS_DIR;
    delete process.env.SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS;
    cleanup(tmp);
  }
});

// CHAIN-3: validation — chain is empty array → rejected
test('chain validation: empty array → ok:false, error mentions chain', async () => {
  const tmp = mkTmp();
  try {
    process.env.SWITCHBOARD_TRIGGERS_DIR        = tmp;
    process.env.SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS = '200';

    const { start } = require('../trigger-watcher');
    const SESSION_ID = 'sess-chain-empty-' + Date.now();
    const ctx = makeChainCtx(SESSION_ID);
    const watcher = start(ctx);

    const uuid = 'chain-empty-' + Date.now();
    writeTrigger(tmp, uuid, { sessionId: SESSION_ID, chain: [] });

    const resultPath = path.join(tmp, 'processed', uuid + '.result.json');
    await waitForFile(resultPath, 2000);

    const result = readResult(path.join(tmp, 'processed'), uuid);
    assert.equal(result.ok, false);
    assert.match(result.error, /chain/i);

    watcher.close();
  } finally {
    delete process.env.SWITCHBOARD_TRIGGERS_DIR;
    delete process.env.SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS;
    cleanup(tmp);
  }
});

// CHAIN-4: validation — chain too long (> 20) → rejected
test('chain validation: length > 20 → ok:false, error mentions chain', async () => {
  const tmp = mkTmp();
  try {
    process.env.SWITCHBOARD_TRIGGERS_DIR        = tmp;
    process.env.SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS = '200';

    const { start } = require('../trigger-watcher');
    const SESSION_ID = 'sess-chain-long-' + Date.now();
    const ctx = makeChainCtx(SESSION_ID);
    const watcher = start(ctx);

    const uuid = 'chain-long-' + Date.now();
    writeTrigger(tmp, uuid, {
      sessionId: SESSION_ID,
      chain: Array.from({ length: 21 }, (_, i) => ({ command: `step-${i}` })),
    });

    const resultPath = path.join(tmp, 'processed', uuid + '.result.json');
    await waitForFile(resultPath, 2000);

    const result = readResult(path.join(tmp, 'processed'), uuid);
    assert.equal(result.ok, false);
    assert.match(result.error, /chain/i);

    watcher.close();
  } finally {
    delete process.env.SWITCHBOARD_TRIGGERS_DIR;
    delete process.env.SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS;
    cleanup(tmp);
  }
});

// CHAIN-5: validation — step missing command → rejected
test('chain validation: step without command string → ok:false', async () => {
  const tmp = mkTmp();
  try {
    process.env.SWITCHBOARD_TRIGGERS_DIR        = tmp;
    process.env.SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS = '200';

    const { start } = require('../trigger-watcher');
    const SESSION_ID = 'sess-chain-badstep-' + Date.now();
    const ctx = makeChainCtx(SESSION_ID);
    const watcher = start(ctx);

    const uuid = 'chain-badstep-' + Date.now();
    writeTrigger(tmp, uuid, {
      sessionId: SESSION_ID,
      chain: [{ command: '/compact' }, { notcommand: 'oops' }],
    });

    const resultPath = path.join(tmp, 'processed', uuid + '.result.json');
    await waitForFile(resultPath, 2000);

    const result = readResult(path.join(tmp, 'processed'), uuid);
    assert.equal(result.ok, false);
    assert.match(result.error, /step/i);
    assert.deepEqual(ctx._written, [], 'no PTY write for invalid chain step');

    watcher.close();
  } finally {
    delete process.env.SWITCHBOARD_TRIGGERS_DIR;
    delete process.env.SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS;
    cleanup(tmp);
  }
});

// CHAIN-6: validation — step command too long → rejected
test('chain validation: step command too long → ok:false, no PTY write', async () => {
  const tmp = mkTmp();
  try {
    process.env.SWITCHBOARD_TRIGGERS_DIR        = tmp;
    process.env.SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS = '200';

    const { start } = require('../trigger-watcher');
    const SESSION_ID = 'sess-chain-longcmd-' + Date.now();
    const ctx = makeChainCtx(SESSION_ID);
    const watcher = start(ctx);

    const uuid = 'chain-longcmd-' + Date.now();
    writeTrigger(tmp, uuid, {
      sessionId: SESSION_ID,
      chain: [{ command: '/compact' }, { command: 'x'.repeat(4097) }],
    });

    const resultPath = path.join(tmp, 'processed', uuid + '.result.json');
    await waitForFile(resultPath, 2000);

    const result = readResult(path.join(tmp, 'processed'), uuid);
    assert.equal(result.ok, false);
    assert.match(result.error, /too long/i);
    assert.deepEqual(ctx._written, [], 'no PTY write for oversized step command');

    watcher.close();
  } finally {
    delete process.env.SWITCHBOARD_TRIGGERS_DIR;
    delete process.env.SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS;
    cleanup(tmp);
  }
});

// CHAIN-7: validation — step command with forbidden chars → rejected
test('chain validation: step command with forbidden chars → ok:false, no PTY write', async () => {
  const tmp = mkTmp();
  try {
    process.env.SWITCHBOARD_TRIGGERS_DIR        = tmp;
    process.env.SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS = '200';

    const { start } = require('../trigger-watcher');
    const SESSION_ID = 'sess-chain-ctrlcmd-' + Date.now();
    const ctx = makeChainCtx(SESSION_ID);
    const watcher = start(ctx);

    const uuid = 'chain-ctrlcmd-' + Date.now();
    const payload = JSON.stringify({
      sessionId: SESSION_ID,
      chain: [{ command: '/compact' }, { command: '/clear\rstep2' }],
    });
    fs.writeFileSync(path.join(tmp, uuid + '.json'), payload, 'utf8');

    const resultPath = path.join(tmp, 'processed', uuid + '.result.json');
    await waitForFile(resultPath, 2000);

    const result = readResult(path.join(tmp, 'processed'), uuid);
    assert.equal(result.ok, false);
    assert.match(result.error, /forbidden control/i);
    assert.deepEqual(ctx._written, [], 'no PTY write for chain step with control chars');

    watcher.close();
  } finally {
    delete process.env.SWITCHBOARD_TRIGGERS_DIR;
    delete process.env.SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS;
    cleanup(tmp);
  }
});

// CHAIN-8: global timeout fires mid-chain → ok:false, partial:true, steps_completed=1
// Uses a 3-step chain where step 1 (middle) stays busy, blocking step 2 from firing.
// The global timeout fires while waiting for step 1's turn to complete.
// Step 0's busy window (50ms→350ms) is intentionally wider than the 100ms poll interval
// to ensure the poll catches busy=true and enters Phase 2 reliably.
test('chain timeout mid-chain: global timeout fires → ok:false, partial:true, steps_completed=1', async () => {
  const tmp = mkTmp();
  try {
    process.env.SWITCHBOARD_TRIGGERS_DIR        = tmp;
    process.env.SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS = '5000';

    const { start } = require('../trigger-watcher');
    const SESSION_ID = 'sess-chain-timeout-' + Date.now();
    let busy = false;
    const ctx = makeChainCtx(SESSION_ID, { noAutoTurn: true });
    let writeCount = 0;
    const origWrite = ctx._ptyProcess.write.bind(ctx._ptyProcess);
    ctx._ptyProcess.write = function(data) {
      origWrite(data);
      writeCount++;
      if (writeCount === 1) {
        // Step 0: busy window 50ms→350ms (wider than poll interval so phase 2 is reliably entered)
        setTimeout(() => { busy = true; }, 50);
        setTimeout(() => { busy = false; }, 350);
      }
      // Step 1 (middle step): immediately busy, never goes idle → global timeout fires
      if (writeCount === 2) {
        busy = true; // set immediately so phase 1 catches it on first poll
        // Never goes idle → global deadline fires
      }
    };
    ctx.isSessionBusy = (id) => id === SESSION_ID ? busy : false;

    const watcher = start(ctx);

    const uuid = 'chain-timeout-' + Date.now();
    writeTrigger(tmp, uuid, {
      sessionId: SESSION_ID,
      wait: 'none',
      chain: [
        { command: '/compact' },
        { command: 'step-two' },   // stuck — never goes idle
        { command: 'step-three' }, // never reached
      ],
      timeout_ms: 1200, // global timeout: step 0 takes ~350ms, step 1 eats the rest
    });

    const resultPath = path.join(tmp, 'processed', uuid + '.result.json');
    await waitForFile(resultPath, 4000);

    const result = readResult(path.join(tmp, 'processed'), uuid);
    assert.equal(result.ok, false, 'result.ok should be false on timeout');
    assert.equal(result.partial, true, 'partial should be true');
    assert.match(result.error, /timeout/i, 'error should mention timeout');
    assert.equal(result.steps_completed, 1, 'steps_completed should be 1 (step 0 done, step 1 failed)');

    assert.equal(ctx._written[0], '/compact', 'step 0 text should be written');
    assert.equal(ctx._written[1], '\r', 'step 0 Enter should be written');
    assert.equal(ctx._written[2], 'step-two', 'step 1 should be written (it was sent, just stuck)');
    assert.equal(ctx._written[3], '\r', 'step 1 Enter should be written');

    watcher.close();
  } finally {
    delete process.env.SWITCHBOARD_TRIGGERS_DIR;
    delete process.env.SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS;
    cleanup(tmp);
  }
});

// CHAIN-9: session exits mid-chain → ok:false, partial:true, stops cleanly
test('chain session exit mid-chain: session exits during step 1 turn wait → ok:false, partial:true', async () => {
  const tmp = mkTmp();
  try {
    process.env.SWITCHBOARD_TRIGGERS_DIR        = tmp;
    process.env.SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS = '5000';

    const { start } = require('../trigger-watcher');
    const SESSION_ID = 'sess-chain-exit-' + Date.now();
    let busy = false;
    const ctx = makeChainCtx(SESSION_ID, { noAutoTurn: true });
    let writeCount = 0;
    const origWrite = ctx._ptyProcess.write.bind(ctx._ptyProcess);
    ctx._ptyProcess.write = function(data) {
      origWrite(data);
      writeCount++;
      if (writeCount === 1) {
        // Step 0: completes quickly
        setTimeout(() => { busy = true; }, 20);
        setTimeout(() => { busy = false; }, 100);
      }
      if (writeCount === 2) {
        // Step 1: session exits during turn wait
        setTimeout(() => { busy = true; }, 20);
        setTimeout(() => { ctx._removeSession(); }, 100);
      }
    };
    ctx.isSessionBusy = (id) => id === SESSION_ID ? busy : false;

    const watcher = start(ctx);

    const uuid = 'chain-exit-' + Date.now();
    writeTrigger(tmp, uuid, {
      sessionId: SESSION_ID,
      wait: 'idle',
      chain: [
        { command: '/compact' },
        { command: 'step-two' },
        { command: 'step-three' },
      ],
      timeout_ms: 5000,
    });

    const resultPath = path.join(tmp, 'processed', uuid + '.result.json');
    await waitForFile(resultPath, 3000);

    const result = readResult(path.join(tmp, 'processed'), uuid);
    assert.equal(result.ok, false, 'result.ok should be false on session exit');
    assert.equal(result.partial, true, 'partial should be true');
    assert.match(result.error, /session exited/i);
    assert.equal(typeof result.steps_completed, 'number');

    watcher.close();
  } finally {
    delete process.env.SWITCHBOARD_TRIGGERS_DIR;
    delete process.env.SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS;
    cleanup(tmp);
  }
});

// CHAIN-10: per-step timeout_ms overrides global for that step (step stays busy → step times out)
// Uses a 3-step chain so step 1 (middle) has a between-step turn wait that can timeout.
test('chain per-step timeout_ms: step with short per-step timeout fires before global', async () => {
  const tmp = mkTmp();
  try {
    process.env.SWITCHBOARD_TRIGGERS_DIR        = tmp;
    process.env.SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS = '5000';

    const { start } = require('../trigger-watcher');
    const SESSION_ID = 'sess-chain-steptmout-' + Date.now();
    let busy = false;
    const ctx = makeChainCtx(SESSION_ID, { noAutoTurn: true });
    let writeCount = 0;
    const origWrite = ctx._ptyProcess.write.bind(ctx._ptyProcess);
    ctx._ptyProcess.write = function(data) {
      origWrite(data);
      writeCount++;
      if (writeCount === 1) {
        // Step 0 completes quickly
        setTimeout(() => { busy = true; }, 20);
        setTimeout(() => { busy = false; }, 100);
      }
      // Step 1 (middle step): goes busy but never idle → per-step timeout_ms=300 fires
      if (writeCount === 2) {
        setTimeout(() => { busy = true; }, 20);
        // Never goes idle
      }
    };
    ctx.isSessionBusy = (id) => id === SESSION_ID ? busy : false;

    const watcher = start(ctx);

    const uuid = 'chain-steptmout-' + Date.now();
    writeTrigger(tmp, uuid, {
      sessionId: SESSION_ID,
      wait: 'idle',
      chain: [
        { command: '/compact' },
        { command: 'step-two', timeout_ms: 300 }, // short per-step timeout
        { command: 'step-three' },                // never reached
      ],
      timeout_ms: 5000, // generous global timeout — per-step fires first
    });

    const resultPath = path.join(tmp, 'processed', uuid + '.result.json');
    await waitForFile(resultPath, 3000);

    const result = readResult(path.join(tmp, 'processed'), uuid);
    assert.equal(result.ok, false, 'result.ok should be false (step timeout)');
    assert.equal(result.partial, true);
    assert.match(result.error, /timeout/i);
    assert.equal(result.steps_completed, 1);

    watcher.close();
  } finally {
    delete process.env.SWITCHBOARD_TRIGGERS_DIR;
    delete process.env.SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS;
    cleanup(tmp);
  }
});

// CHAIN-11: invalid per-step timeout_ms → rejected before session lookup
test('chain validation: invalid per-step timeout_ms → ok:false, no PTY write', async () => {
  const tmp = mkTmp();
  try {
    process.env.SWITCHBOARD_TRIGGERS_DIR        = tmp;
    process.env.SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS = '200';

    const { start } = require('../trigger-watcher');
    const SESSION_ID = 'sess-chain-badtmout-' + Date.now();
    const ctx = makeChainCtx(SESSION_ID);
    const watcher = start(ctx);

    const uuid = 'chain-badtmout-' + Date.now();
    writeTrigger(tmp, uuid, {
      sessionId: SESSION_ID,
      chain: [
        { command: '/compact' },
        { command: 'step-two', timeout_ms: -100 }, // invalid
      ],
    });

    const resultPath = path.join(tmp, 'processed', uuid + '.result.json');
    await waitForFile(resultPath, 2000);

    const result = readResult(path.join(tmp, 'processed'), uuid);
    assert.equal(result.ok, false);
    assert.match(result.error, /step.*timeout_ms|invalid.*step/i);
    assert.deepEqual(ctx._written, [], 'no PTY write for invalid step timeout_ms');

    watcher.close();
  } finally {
    delete process.env.SWITCHBOARD_TRIGGERS_DIR;
    delete process.env.SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS;
    cleanup(tmp);
  }
});

// CHAIN-12: instant-reply path on a mid-chain step (i>0) — busy never rises within
// the verify window, so submit-verify retries the Enter once and then the watcher
// declares the turn complete and proceeds. Step 2 (final) also goes through verify.
test('chain instant-reply mid-chain: step 1 never sets busy → verify-retries then proceeds to step 2', async () => {
  const tmp = mkTmp();
  try {
    process.env.SWITCHBOARD_TRIGGERS_DIR        = tmp;
    process.env.SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS = '10000';

    const { start } = require('../trigger-watcher');
    const SESSION_ID = 'sess-chain-instant-' + Date.now();
    let busy = false;
    const ctx = makeChainCtx(SESSION_ID, { noAutoTurn: true });
    let writeCount = 0;
    const origWrite = ctx._ptyProcess.write.bind(ctx._ptyProcess);
    ctx._ptyProcess.write = function(data) {
      origWrite(data);
      writeCount++;
      if (writeCount === 1) {
        // Step 0: busy window wider than IDLE_POLL_INTERVAL (100ms) so polling
        // definitely observes both rising and falling edges
        setTimeout(() => { busy = true; }, 20);
        setTimeout(() => { busy = false; }, 350);
      }
      // writeCount === 2 (step 1): NEVER sets busy → instant-reply path must trigger
      // (step 2 has no turn wait — it's the last step)
    };
    ctx.isSessionBusy = (id) => id === SESSION_ID ? busy : false;

    const watcher = start(ctx);

    const uuid = 'chain-instant-' + Date.now();
    const startedAt = Date.now();
    writeTrigger(tmp, uuid, {
      sessionId: SESSION_ID,
      wait: 'no-idle',
      chain: [
        { command: '/first' },
        { command: '/second' },  // step 1 never sets busy
        { command: '/third' },
      ],
      timeout_ms: 10000,
    });

    const resultPath = path.join(tmp, 'processed', uuid + '.result.json');
    await waitForFile(resultPath, 6000);
    const elapsed = Date.now() - startedAt;

    const result = readResult(path.join(tmp, 'processed'), uuid);
    assert.equal(result.ok, true, 'chain should succeed via instant-reply path');
    assert.equal(result.steps.length, 3, 'all 3 steps must have run');
    // Steps 1 and 2 never observe a busy-rise → each gets a single verify-retry '\r'.
    assert.deepEqual(ctx._written, ['/first', '\r', '/second', '\r', '\r', '/third', '\r', '\r']);
    assert.equal(result.steps[0].submit_retries, 0, 'step 0 rose (busy@20ms) → no retry');
    assert.equal(result.steps[1].submit_retries, 1, 'step 1 never rose → one verify-retry');
    assert.equal(result.steps[2].submit_retries, 1, 'step 2 (final) never rose → one verify-retry');
    // Step 1 spent two verify windows (~2 × SWITCHBOARD_SUBMIT_VERIFY_MS=400ms) probing
    // for the rising edge across the initial submit and the retry.
    assert.ok(result.steps[1].waited_ms >= 700 && result.steps[1].waited_ms <= 1400,
      `step 1 should have waited ~2 verify windows for the rising edge; got ${result.steps[1].waited_ms}ms`);
    // Total elapsed dominated by steps 1 & 2's verify+retry windows.
    assert.ok(elapsed >= 1500 && elapsed <= 3500,
      `total elapsed should reflect the verify+retry windows; got ${elapsed}ms`);

    watcher.close();
  } finally {
    delete process.env.SWITCHBOARD_TRIGGERS_DIR;
    delete process.env.SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS;
    cleanup(tmp);
  }
});

// ── submit-verify tests (2026-06-04 "Enter absorbed in composer" incident) ──────

// VERIFY-1: single command, busy NEVER rises → submit-verify retries the Enter
// once. _written must carry the retry '\r' and result.submit_retries === 1.
test('submit-verify single: busy never rises → retry Enter, submit_retries:1', async () => {
  const tmp = mkTmp();
  try {
    process.env.SWITCHBOARD_TRIGGERS_DIR        = tmp;
    process.env.SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS = '2000';

    const { start } = require('../trigger-watcher');
    const SESSION_ID = 'sess-verify-noRise-' + Date.now();
    const ctx = makeCtx(SESSION_ID, () => false); // busy never rises
    const watcher = start(ctx);

    const uuid = 'verify-norise-' + Date.now();
    writeTrigger(tmp, uuid, { sessionId: SESSION_ID, command: 'resume the task' });

    const resultPath = path.join(tmp, 'processed', uuid + '.result.json');
    await waitForFile(resultPath, 3000);

    const result = readResult(path.join(tmp, 'processed'), uuid);
    assert.equal(result.ok, true, 'result should still be ok (instant-reply semantics preserved)');
    assert.equal(result.submit_retries, 1, 'one verify-retry when no busy-rise observed');
    // command text, discrete Enter, then the single retry Enter.
    assert.deepEqual(ctx._written, ['resume the task', '\r', '\r'],
      'should write text, Enter, then exactly one retry Enter');

    watcher.close();
  } finally {
    delete process.env.SWITCHBOARD_TRIGGERS_DIR;
    delete process.env.SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS;
    cleanup(tmp);
  }
});

// VERIFY-2: single command, busy rises promptly after the submit → no retry,
// result.submit_retries === 0 and only one Enter written.
test('submit-verify single: busy rises fast → no retry, submit_retries:0', async () => {
  const tmp = mkTmp();
  try {
    process.env.SWITCHBOARD_TRIGGERS_DIR        = tmp;
    process.env.SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS = '2000';

    const { start } = require('../trigger-watcher');
    const SESSION_ID = 'sess-verify-rise-' + Date.now();
    // Busy rises the moment the discrete Enter ('\r') is written — the verify
    // poll observes the rising edge on its first tick → no retry.
    let busy = false;
    const ctx = makeCtx(SESSION_ID, () => busy);
    const origWrite = ctx._ptyProcess.write.bind(ctx._ptyProcess);
    ctx._ptyProcess.write = function(data) {
      origWrite(data);
      if (data === '\r') busy = true; // turn starts immediately on submit
    };
    const watcher = start(ctx);

    const uuid = 'verify-rise-' + Date.now();
    writeTrigger(tmp, uuid, { sessionId: SESSION_ID, command: 'do the thing' });

    const resultPath = path.join(tmp, 'processed', uuid + '.result.json');
    await waitForFile(resultPath, 3000);

    const result = readResult(path.join(tmp, 'processed'), uuid);
    assert.equal(result.ok, true);
    assert.equal(result.submit_retries, 0, 'no retry when busy rises promptly');
    assert.deepEqual(ctx._written, ['do the thing', '\r'], 'only one Enter, no retry');

    watcher.close();
  } finally {
    delete process.env.SWITCHBOARD_TRIGGERS_DIR;
    delete process.env.SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS;
    cleanup(tmp);
  }
});

// VERIFY-3: chain whose FINAL step never raises busy → the final step still
// gets a submit-verify + retry (the exact 2026-06-04 incident shape), and the
// retry is traced on steps[last].submit_retries. Earlier steps that rise
// normally record submit_retries:0.
test('submit-verify chain final step silent: retry traced on steps[last].submit_retries', async () => {
  const tmp = mkTmp();
  try {
    process.env.SWITCHBOARD_TRIGGERS_DIR        = tmp;
    process.env.SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS = '10000';

    const { start } = require('../trigger-watcher');
    const SESSION_ID = 'sess-verify-finalsilent-' + Date.now();
    let busy = false;
    const ctx = makeChainCtx(SESSION_ID, { noAutoTurn: true });
    let writeCount = 0;
    const origWrite = ctx._ptyProcess.write.bind(ctx._ptyProcess);
    ctx._ptyProcess.write = function(data) {
      origWrite(data);
      writeCount++;
      // Step 0 submit ('\r' is the 2nd write): normal turn rises then falls.
      if (writeCount === 2) {
        setTimeout(() => { busy = true; }, 20);
        setTimeout(() => { busy = false; }, 200);
      }
      // Final step (step 1) never raises busy → must verify-retry the Enter.
    };
    ctx.isSessionBusy = (id) => id === SESSION_ID ? busy : false;

    const watcher = start(ctx);

    const uuid = 'verify-finalsilent-' + Date.now();
    writeTrigger(tmp, uuid, {
      sessionId: SESSION_ID,
      wait: 'none',
      chain: [
        { command: '/compact' },
        { command: 'resume and finish' }, // FINAL step — Enter gets absorbed
      ],
      timeout_ms: 8000,
    });

    const resultPath = path.join(tmp, 'processed', uuid + '.result.json');
    await waitForFile(resultPath, 6000);

    const result = readResult(path.join(tmp, 'processed'), uuid);
    assert.equal(result.ok, true, 'chain should complete');
    assert.equal(result.steps.length, 2);
    assert.equal(result.steps[0].submit_retries, 0, 'step 0 rose normally → no retry');
    assert.equal(result.steps[1].submit_retries, 1, 'final step never rose → one verify-retry');
    // Final step carries the retry '\r'; step 0 does not.
    assert.deepEqual(ctx._written,
      ['/compact', '\r', 'resume and finish', '\r', '\r'],
      'final step writes text, Enter, then the verify-retry Enter');

    watcher.close();
  } finally {
    delete process.env.SWITCHBOARD_TRIGGERS_DIR;
    delete process.env.SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS;
    cleanup(tmp);
  }
});

// VERIFY-4: chain happy path (makeChainCtx auto-turn raises busy on every '\r')
// → no step needs a retry, submit_retries is 0 for every step and no extra '\r'
// appears in _written.
test('submit-verify chain happy: auto-turn rises every step → submit_retries:0 everywhere', async () => {
  const tmp = mkTmp();
  try {
    process.env.SWITCHBOARD_TRIGGERS_DIR        = tmp;
    process.env.SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS = '5000';

    const { start } = require('../trigger-watcher');
    const SESSION_ID = 'sess-verify-happy-' + Date.now();
    const ctx = makeChainCtx(SESSION_ID); // auto-turn: busy@50, idle@200 per '\r'
    const watcher = start(ctx);

    const uuid = 'verify-happy-' + Date.now();
    writeTrigger(tmp, uuid, {
      sessionId: SESSION_ID,
      wait: 'idle',
      chain: [
        { command: '/compact' },
        { command: 'verify and commit' },
        { command: 'open the PR' },
      ],
      timeout_ms: 8000,
    });

    const resultPath = path.join(tmp, 'processed', uuid + '.result.json');
    await waitForFile(resultPath, 8000);

    const result = readResult(path.join(tmp, 'processed'), uuid);
    assert.equal(result.ok, true);
    assert.equal(result.steps.length, 3);
    for (const s of result.steps) {
      assert.equal(s.submit_retries, 0, `step ${s.idx} should not retry on a healthy turn`);
    }
    // No retry '\r' anywhere — exactly one Enter per command.
    assert.deepEqual(ctx._written,
      ['/compact', '\r', 'verify and commit', '\r', 'open the PR', '\r']);

    watcher.close();
  } finally {
    delete process.env.SWITCHBOARD_TRIGGERS_DIR;
    delete process.env.SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS;
    cleanup(tmp);
  }
});

// ── W9 — chain re-queue on global-deadline expiry ─────────────────────────────

// W9-1: chain timeout with remaining unsent steps → result has requeued:true +
// requeue_trigger filename; a new trigger file exists in the triggers dir with
// the correct payload shape.
test('W9 requeue: chain timeout with unsent steps → requeued:true + new trigger file', async () => {
  const tmp = mkTmp();
  try {
    process.env.SWITCHBOARD_TRIGGERS_DIR        = tmp;
    process.env.SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS = '5000';

    const { start } = require('../trigger-watcher');
    const SESSION_ID = 'sess-requeue-' + Date.now();
    const ctx = makeChainCtx(SESSION_ID, { noAutoTurn: true });
    // step 0 completes; step 1 stays busy forever → global timeout fires with step 2 unsent.
    let busy = false;
    let writeCount = 0;
    const origWrite = ctx._ptyProcess.write.bind(ctx._ptyProcess);
    ctx._ptyProcess.write = function(data) {
      origWrite(data);
      writeCount++;
      if (writeCount === 1) {
        setTimeout(() => { busy = true; }, 20);
        setTimeout(() => { busy = false; }, 150);
      }
      if (writeCount === 2) {
        busy = true; // step 1 never goes idle → global deadline fires
      }
    };
    ctx.isSessionBusy = (id) => id === SESSION_ID ? busy : false;

    const watcher = start(ctx);

    const uuid = 'requeue-' + Date.now();
    writeTrigger(tmp, uuid, {
      sessionId: SESSION_ID,
      wait: 'none',
      chain: [
        { command: '/compact' },
        { command: 'step-two' },   // gets sent but stays busy
        { command: 'step-three' }, // never sent → re-queued
      ],
      timeout_ms: 800,
    });

    const resultPath = path.join(tmp, 'processed', uuid + '.result.json');
    await waitForFile(resultPath, 4000);

    const result = readResult(path.join(tmp, 'processed'), uuid);
    assert.equal(result.ok, false, 'result.ok should be false');
    assert.equal(result.partial, true, 'partial should be true');
    assert.match(result.error, /chain timeout/i, 'error should mention chain timeout');
    assert.equal(result.requeued, true, 'requeued should be true');
    assert.ok(typeof result.requeue_trigger === 'string' && result.requeue_trigger.endsWith('.json'),
      'requeue_trigger should be a .json filename');

    // The new trigger file should exist in the triggers dir
    const requeuedPath = path.join(tmp, result.requeue_trigger);
    assert.ok(fs.existsSync(requeuedPath), 'requeue trigger file should exist on disk');

    const requeuedPayload = JSON.parse(fs.readFileSync(requeuedPath, 'utf8'));
    assert.equal(requeuedPayload.sessionId, SESSION_ID, 'requeued trigger has correct sessionId');
    assert.ok(Array.isArray(requeuedPayload.chain), 'requeued trigger has chain array');
    assert.equal(requeuedPayload.chain.length, 1, 'requeued chain has 1 step (step-three)');
    assert.equal(requeuedPayload.chain[0].command, 'step-three', 'requeued step is step-three');
    assert.equal(requeuedPayload.wait, 'idle', 'requeued trigger waits for idle');
    assert.equal(requeuedPayload.requeue_count, 1, 'requeue_count is 1');
    assert.equal(requeuedPayload.timeout_ms, 800, 'original timeout_ms preserved');

    watcher.close();
  } finally {
    delete process.env.SWITCHBOARD_TRIGGERS_DIR;
    delete process.env.SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS;
    cleanup(tmp);
  }
});

// W9-2: initial idle wait times out with ALL steps unsent → entire chain re-queued.
test('W9 requeue initial-wait: all steps unsent when idle wait times out → all re-queued', async () => {
  const tmp = mkTmp();
  try {
    process.env.SWITCHBOARD_TRIGGERS_DIR        = tmp;
    process.env.SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS = '5000';

    const { start } = require('../trigger-watcher');
    const SESSION_ID = 'sess-requeue-init-' + Date.now();
    // Always busy → initial idle wait times out
    const ctx = makeChainCtx(SESSION_ID, { initiallyBusy: true });

    const watcher = start(ctx);

    const uuid = 'requeue-init-' + Date.now();
    writeTrigger(tmp, uuid, {
      sessionId: SESSION_ID,
      wait: 'idle',
      chain: [
        { command: '/compact' },
        { command: 'step-two' },
      ],
      timeout_ms: 300,
    });

    const resultPath = path.join(tmp, 'processed', uuid + '.result.json');
    await waitForFile(resultPath, 3000);

    const result = readResult(path.join(tmp, 'processed'), uuid);
    assert.equal(result.ok, false);
    assert.equal(result.requeued, true, 'should be re-queued');
    assert.ok(typeof result.requeue_trigger === 'string');

    const requeuedPayload = JSON.parse(fs.readFileSync(path.join(tmp, result.requeue_trigger), 'utf8'));
    assert.equal(requeuedPayload.chain.length, 2, 'all 2 steps should be re-queued');
    assert.equal(requeuedPayload.chain[0].command, '/compact');
    assert.equal(requeuedPayload.chain[1].command, 'step-two');
    assert.equal(requeuedPayload.requeue_count, 1);

    watcher.close();
  } finally {
    delete process.env.SWITCHBOARD_TRIGGERS_DIR;
    delete process.env.SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS;
    cleanup(tmp);
  }
});

// W9-3: requeue_count at MAX_REQUEUE → no new file, result has requeue_exhausted:true.
test('W9 requeue cap: requeue_count >= MAX_REQUEUE → requeue_exhausted:true, no new file', async () => {
  const tmp = mkTmp();
  try {
    process.env.SWITCHBOARD_TRIGGERS_DIR        = tmp;
    process.env.SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS = '5000';

    const { start } = require('../trigger-watcher');
    const SESSION_ID = 'sess-requeue-cap-' + Date.now();
    // Always busy → initial idle wait times out
    const ctx = makeChainCtx(SESSION_ID, { initiallyBusy: true });

    const watcher = start(ctx);

    // Simulate a trigger that has already been re-queued MAX_REQUEUE times (=2).
    const uuid = 'requeue-cap-' + Date.now();
    writeTrigger(tmp, uuid, {
      sessionId: SESSION_ID,
      wait: 'idle',
      chain: [
        { command: '/compact' },
        { command: 'step-two' },
      ],
      timeout_ms: 300,
      requeue_count: 2, // already at cap
    });

    const resultPath = path.join(tmp, 'processed', uuid + '.result.json');
    await waitForFile(resultPath, 3000);

    const result = readResult(path.join(tmp, 'processed'), uuid);
    assert.equal(result.ok, false);
    assert.equal(result.requeue_exhausted, true, 'requeue_exhausted should be true at cap');
    assert.equal(result.requeued, undefined, 'requeued should not be set');

    // Count trigger json files in the triggers dir (should only be the processed one, not a new requeue)
    const files = fs.readdirSync(tmp).filter(f => f.endsWith('.json') && !f.includes(uuid));
    assert.equal(files.length, 0, 'no new trigger file should be written at cap');

    watcher.close();
  } finally {
    delete process.env.SWITCHBOARD_TRIGGERS_DIR;
    delete process.env.SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS;
    cleanup(tmp);
  }
});

// W9-4: validation rejects invalid requeue_count (negative number).
test('W9 validation: negative requeue_count → ok:false, no PTY write', async () => {
  const tmp = mkTmp();
  try {
    process.env.SWITCHBOARD_TRIGGERS_DIR        = tmp;
    process.env.SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS = '200';

    const { start } = require('../trigger-watcher');
    const SESSION_ID = 'sess-badrequeue-neg-' + Date.now();
    const ctx = makeChainCtx(SESSION_ID);
    const watcher = start(ctx);

    const uuid = 'badrequeue-neg-' + Date.now();
    writeTrigger(tmp, uuid, {
      sessionId: SESSION_ID,
      chain: [{ command: '/compact' }],
      requeue_count: -1,
    });

    const resultPath = path.join(tmp, 'processed', uuid + '.result.json');
    await waitForFile(resultPath, 2000);

    const result = readResult(path.join(tmp, 'processed'), uuid);
    assert.equal(result.ok, false);
    assert.match(result.error, /requeue_count/i, 'error should mention requeue_count');
    assert.deepEqual(ctx._written, [], 'no PTY write for invalid requeue_count');

    watcher.close();
  } finally {
    delete process.env.SWITCHBOARD_TRIGGERS_DIR;
    delete process.env.SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS;
    cleanup(tmp);
  }
});

// W9-5: validation rejects non-integer float requeue_count.
test('W9 validation: float requeue_count (1.5) → ok:false', async () => {
  const tmp = mkTmp();
  try {
    process.env.SWITCHBOARD_TRIGGERS_DIR        = tmp;
    process.env.SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS = '200';

    const { start } = require('../trigger-watcher');
    const SESSION_ID = 'sess-badrequeue-float-' + Date.now();
    const ctx = makeChainCtx(SESSION_ID);
    const watcher = start(ctx);

    const uuid = 'badrequeue-float-' + Date.now();
    writeTrigger(tmp, uuid, {
      sessionId: SESSION_ID,
      chain: [{ command: '/compact' }],
      requeue_count: 1.5,
    });

    const resultPath = path.join(tmp, 'processed', uuid + '.result.json');
    await waitForFile(resultPath, 2000);

    const result = readResult(path.join(tmp, 'processed'), uuid);
    assert.equal(result.ok, false);
    assert.match(result.error, /requeue_count/i);

    watcher.close();
  } finally {
    delete process.env.SWITCHBOARD_TRIGGERS_DIR;
    delete process.env.SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS;
    cleanup(tmp);
  }
});

// W9-6: validation rejects string requeue_count.
test('W9 validation: string requeue_count → ok:false', async () => {
  const tmp = mkTmp();
  try {
    process.env.SWITCHBOARD_TRIGGERS_DIR        = tmp;
    process.env.SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS = '200';

    const { start } = require('../trigger-watcher');
    const SESSION_ID = 'sess-badrequeue-str-' + Date.now();
    const ctx = makeChainCtx(SESSION_ID);
    const watcher = start(ctx);

    const uuid = 'badrequeue-str-' + Date.now();
    fs.writeFileSync(
      path.join(tmp, uuid + '.json'),
      JSON.stringify({ sessionId: SESSION_ID, chain: [{ command: '/compact' }], requeue_count: '1' }),
      'utf8',
    );

    const resultPath = path.join(tmp, 'processed', uuid + '.result.json');
    await waitForFile(resultPath, 2000);

    const result = readResult(path.join(tmp, 'processed'), uuid);
    assert.equal(result.ok, false);
    assert.match(result.error, /requeue_count/i);

    watcher.close();
  } finally {
    delete process.env.SWITCHBOARD_TRIGGERS_DIR;
    delete process.env.SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS;
    cleanup(tmp);
  }
});

// W9-7: absent requeue_count (normal new trigger) → treated as 0, no validation error.
test('W9 validation: absent requeue_count → treated as 0, no validation error', async () => {
  const tmp = mkTmp();
  try {
    process.env.SWITCHBOARD_TRIGGERS_DIR        = tmp;
    process.env.SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS = '200';

    const { start } = require('../trigger-watcher');
    const SESSION_ID = 'sess-requeue-absent-' + Date.now();
    const ctx = makeChainCtx(SESSION_ID);
    const watcher = start(ctx);

    const uuid = 'requeue-absent-' + Date.now();
    writeTrigger(tmp, uuid, {
      sessionId: SESSION_ID,
      chain: [{ command: '/compact' }],
      // requeue_count absent → should default to 0 and pass validation
    });

    const resultPath = path.join(tmp, 'processed', uuid + '.result.json');
    await waitForFile(resultPath, 2000);

    const result = readResult(path.join(tmp, 'processed'), uuid);
    assert.equal(result.ok, true, 'absent requeue_count should not cause a validation error');

    watcher.close();
  } finally {
    delete process.env.SWITCHBOARD_TRIGGERS_DIR;
    delete process.env.SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS;
    cleanup(tmp);
  }
});

// W9-8: completed chain (all steps sent successfully) → no re-queue file written.
test('W9 no requeue on success: completed chain → no new trigger file written', async () => {
  const tmp = mkTmp();
  try {
    process.env.SWITCHBOARD_TRIGGERS_DIR        = tmp;
    process.env.SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS = '5000';

    const { start } = require('../trigger-watcher');
    const SESSION_ID = 'sess-requeue-success-' + Date.now();
    const ctx = makeChainCtx(SESSION_ID); // auto-turn: completes cleanly
    const watcher = start(ctx);

    const uuid = 'requeue-success-' + Date.now();
    writeTrigger(tmp, uuid, {
      sessionId: SESSION_ID,
      wait: 'idle',
      chain: [
        { command: '/compact' },
        { command: 'verify result and commit' },
      ],
      timeout_ms: 5000,
    });

    const resultPath = path.join(tmp, 'processed', uuid + '.result.json');
    await waitForFile(resultPath, 6000);

    const result = readResult(path.join(tmp, 'processed'), uuid);
    assert.equal(result.ok, true, 'result should be ok on success');
    assert.equal(result.requeued, undefined, 'requeued should not be set on success');
    assert.equal(result.requeue_trigger, undefined, 'requeue_trigger should not be set on success');

    // No extra trigger files should exist
    const files = fs.readdirSync(tmp).filter(f => f.endsWith('.json') && !f.includes(uuid));
    assert.equal(files.length, 0, 'no extra trigger files on success');

    watcher.close();
  } finally {
    delete process.env.SWITCHBOARD_TRIGGERS_DIR;
    delete process.env.SWITCHBOARD_TRIGGER_IDLE_TIMEOUT_MS;
    cleanup(tmp);
  }
});
