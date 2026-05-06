// test/session-profiles.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const sp = require('../session-profiles.js');

function tmpFile() {
  return path.join(os.tmpdir(), `switchboard-sp-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
}

function setup() {
  const p = tmpFile();
  sp.setStorePathForTesting(p);
  return {
    path: p,
    cleanup() {
      sp.setStorePathForTesting(null);
      try { fs.unlinkSync(p); } catch {}
    },
  };
}

test('record + flush + reload round-trip', () => {
  const ctx = setup();
  try {
    sp.recordSessionProfile('aaa-111', 'deepseek');
    sp.recordSessionProfile('bbb-222', 'glm');
    sp.flushSync();

    sp.setStorePathForTesting(ctx.path);  // force reload
    const map = sp.getAllMappings();
    assert.deepStrictEqual(map, { 'aaa-111': 'deepseek', 'bbb-222': 'glm' });
  } finally { ctx.cleanup(); }
});

test('null/empty profileId removes the mapping', () => {
  const ctx = setup();
  try {
    sp.recordSessionProfile('xxx', 'glm');
    sp.recordSessionProfile('xxx', null);
    sp.flushSync();
    assert.strictEqual(sp.getProfileForSession('xxx'), null);
  } finally { ctx.cleanup(); }
});

test('rekeySession copies and removes', () => {
  const ctx = setup();
  try {
    sp.recordSessionProfile('temp-id', 'openrouter');
    sp.rekeySession('temp-id', 'real-id');
    assert.strictEqual(sp.getProfileForSession('temp-id'), null);
    assert.strictEqual(sp.getProfileForSession('real-id'), 'openrouter');
  } finally { ctx.cleanup(); }
});

test('rekeySession is idempotent / no-op for unknown ids', () => {
  const ctx = setup();
  try {
    sp.rekeySession('not-recorded', 'new-id');
    assert.strictEqual(sp.getProfileForSession('new-id'), null);
  } finally { ctx.cleanup(); }
});

test('load drops malformed entries', () => {
  const ctx = setup();
  try {
    fs.writeFileSync(ctx.path, JSON.stringify({
      sessions: {
        'good-1': 'profileX',
        'good-2': 'profileY',
        'bad-numeric': 12345,        // value not string
        ['x'.repeat(200)]: 'fine',   // key too long
      },
    }));
    sp.setStorePathForTesting(ctx.path);
    const map = sp.getAllMappings();
    assert.deepStrictEqual(Object.keys(map).sort(), ['good-1', 'good-2']);
  } finally { ctx.cleanup(); }
});

test('load handles malformed JSON gracefully', () => {
  const ctx = setup();
  try {
    fs.writeFileSync(ctx.path, '{ broken json');
    sp.setStorePathForTesting(ctx.path);
    assert.deepStrictEqual(sp.getAllMappings(), {});
  } finally { ctx.cleanup(); }
});

test('non-string ids are ignored silently', () => {
  const ctx = setup();
  try {
    sp.recordSessionProfile(undefined, 'x');
    sp.recordSessionProfile(null, 'x');
    sp.recordSessionProfile(123, 'x');
    sp.flushSync();
    assert.deepStrictEqual(sp.getAllMappings(), {});
  } finally { ctx.cleanup(); }
});
