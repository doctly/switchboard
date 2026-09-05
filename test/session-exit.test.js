const { test } = require('node:test');
const assert = require('node:assert/strict');

const { wasIntentionalExit } = require('../public/terminal-manager');

// The exit banner (#58) keeps a dead session's terminal mounted so the user can
// read the error it printed. It must NOT fire for exits the user asked for —
// those tear the session down, or a stopped session lingers in the sidebar
// looking as though it died on its own.

test('the UI stop button is an intentional exit even though the kill looks like a crash', () => {
  // node-pty reports a signal kill as exitCode 0 + signal, so without the
  // stop-session flag from main this is indistinguishable from being killed.
  assert.equal(wasIntentionalExit({ exitCode: 0, signal: 1, userStopped: true }), true);
});

test('`/exit` or ctrl-D is an intentional exit', () => {
  assert.equal(wasIntentionalExit({ exitCode: 0, signal: 0, userStopped: false }), true);
});

test('a Windows stop is intentional (conpty reports no signal, non-zero code)', () => {
  assert.equal(wasIntentionalExit({ exitCode: 1, signal: undefined, userStopped: true }), true);
});

test('a fast-failing pre-launch command is not intentional — keep the banner', () => {
  // The case #58 was written for: devbox/shell exits non-zero before claude
  // ever starts, and tearing the terminal down hides the error.
  assert.equal(wasIntentionalExit({ exitCode: 127, signal: 0, userStopped: false }), false);
});

test('a signal we did not send is not intentional (crash, OOM kill)', () => {
  assert.equal(wasIntentionalExit({ exitCode: 0, signal: 9, userStopped: false }), false);
});
