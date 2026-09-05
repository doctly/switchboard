const test = require('node:test');
const assert = require('node:assert/strict');

const { shouldStartFresh } = require('../session-launch');
const claude = require('../harnesses/claude');

test('a pre-seeded session resumes before the cache indexer sees it', () => {
  const startFresh = shouldStartFresh({
    isNew: false,
    isPlainTerminal: false,
    hasCachedSession: false,
    resumeExisting: true,
  });

  assert.equal(startFresh, false);
  assert.deepEqual(claude.buildLaunchArgs({
    sessionId: '627625e6-a53a-43d8-a0c2-c1b1cf4c9fed',
    isNew: startFresh,
  }), ['--resume', '627625e6-a53a-43d8-a0c2-c1b1cf4c9fed']);
});

test('an uncached ordinary session still starts fresh', () => {
  assert.equal(shouldStartFresh({
    isNew: false,
    isPlainTerminal: false,
    hasCachedSession: false,
    resumeExisting: false,
  }), true);
});

test('new-session requests always start fresh', () => {
  assert.equal(shouldStartFresh({
    isNew: true,
    isPlainTerminal: false,
    hasCachedSession: true,
    resumeExisting: true,
  }), true);
});

test('a cached existing session resumes normally', () => {
  assert.equal(shouldStartFresh({
    isNew: false,
    isPlainTerminal: false,
    hasCachedSession: true,
    resumeExisting: false,
  }), false);
});
