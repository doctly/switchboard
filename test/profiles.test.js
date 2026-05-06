// test/profiles.test.js — unit tests for profiles module
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const profiles = require('../profiles.js');

function tmpFile() {
  return path.join(os.tmpdir(), `switchboard-profiles-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
}

test('isValidProfile accepts a well-formed profile', () => {
  assert.strictEqual(profiles.isValidProfile({
    id: 'deepseek',
    name: 'DeepSeek',
    env: { ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic', ANTHROPIC_AUTH_TOKEN: '$DEEPSEEK_API_KEY' },
  }), true);
});

test('isValidProfile rejects bad ids, names, env', () => {
  const base = { id: 'a', name: 'A', env: {} };
  assert.strictEqual(profiles.isValidProfile({ ...base, id: 'has spaces' }), false);
  assert.strictEqual(profiles.isValidProfile({ ...base, id: '' }), false);
  assert.strictEqual(profiles.isValidProfile({ ...base, name: '' }), false);
  assert.strictEqual(profiles.isValidProfile({ ...base, name: '   ' }), false);
  assert.strictEqual(profiles.isValidProfile({ ...base, env: null }), false);
  assert.strictEqual(profiles.isValidProfile({ ...base, env: { '1BAD': 'x' } }), false);
  assert.strictEqual(profiles.isValidProfile({ ...base, env: { 'KEY': 123 } }), false);
  assert.strictEqual(profiles.isValidProfile({ ...base, env: { 'KEY-WITH-DASH': 'x' } }), false);
});

test('isValidProfile rejects oversized env', () => {
  const env = {};
  for (let i = 0; i < 100; i++) env[`K${i}`] = 'v';
  assert.strictEqual(profiles.isValidProfile({ id: 'a', name: 'A', env }), false);
});

test('resolveEnv substitutes $VAR and ${VAR} from process env', () => {
  const out = profiles.resolveEnv({
    LITERAL: 'hello',
    DOLLAR_REF: '$MY_TEST_KEY',
    BRACE_REF: '${MY_TEST_KEY}',
  }, { MY_TEST_KEY: 'secret-value' });
  assert.deepStrictEqual(out, { LITERAL: 'hello', DOLLAR_REF: 'secret-value', BRACE_REF: 'secret-value' });
});

test('resolveEnv DROPS unresolved references (does not pass through literal $VAR)', () => {
  const out = profiles.resolveEnv({
    LITERAL: 'hello',
    MISSING_REF: '$NOT_SET_ANYWHERE_XYZ',
  }, {});
  assert.deepStrictEqual(out, { LITERAL: 'hello' });
});

test('resolveEnv treats values with $ in middle as literals (not refs)', () => {
  const out = profiles.resolveEnv({
    URL: 'https://example.com/$path',
    PRICE: '$5.00',
  }, { path: 'should-not-substitute' });
  assert.deepStrictEqual(out, {
    URL: 'https://example.com/$path',
    PRICE: '$5.00',
  });
});

test('resolveEnv drops empty resolved values', () => {
  const out = profiles.resolveEnv({ KEY: '$EMPTY' }, { EMPTY: '' });
  assert.deepStrictEqual(out, {});
});

test('save/load round-trip', () => {
  const p = tmpFile();
  profiles.setProfilesPathForTesting(p);
  try {
    const state = {
      profiles: [
        { id: 'a', name: 'A', env: { K: 'v' } },
        { id: 'b', name: 'B', env: { K2: '$REF' } },
      ],
      defaultProfileId: 'a',
    };
    profiles.saveProfiles(state);
    const loaded = profiles.loadProfiles();
    assert.deepStrictEqual(loaded, state);
  } finally {
    profiles.setProfilesPathForTesting(null);
    try { fs.unlinkSync(p); } catch {}
  }
});

test('loadProfiles returns empty state for missing file', () => {
  const p = tmpFile();
  profiles.setProfilesPathForTesting(p);
  try {
    const loaded = profiles.loadProfiles();
    assert.deepStrictEqual(loaded, { profiles: [], defaultProfileId: null });
  } finally {
    profiles.setProfilesPathForTesting(null);
  }
});

test('loadProfiles drops invalid entries silently', () => {
  const p = tmpFile();
  profiles.setProfilesPathForTesting(p);
  try {
    fs.writeFileSync(p, JSON.stringify({
      profiles: [
        { id: 'good', name: 'Good', env: {} },
        { id: 'bad spaces', name: 'B', env: {} },
        { id: 'also-good', name: 'Also', env: { K: 'v' } },
      ],
      defaultProfileId: 'good',
    }));
    const loaded = profiles.loadProfiles();
    assert.strictEqual(loaded.profiles.length, 2);
    assert.deepStrictEqual(loaded.profiles.map(x => x.id), ['good', 'also-good']);
    assert.strictEqual(loaded.defaultProfileId, 'good');
  } finally {
    profiles.setProfilesPathForTesting(null);
    try { fs.unlinkSync(p); } catch {}
  }
});

test('loadProfiles drops dangling defaultProfileId', () => {
  const p = tmpFile();
  profiles.setProfilesPathForTesting(p);
  try {
    fs.writeFileSync(p, JSON.stringify({
      profiles: [{ id: 'good', name: 'Good', env: {} }],
      defaultProfileId: 'does-not-exist',
    }));
    const loaded = profiles.loadProfiles();
    assert.strictEqual(loaded.defaultProfileId, null);
  } finally {
    profiles.setProfilesPathForTesting(null);
    try { fs.unlinkSync(p); } catch {}
  }
});

test('loadProfiles handles malformed JSON gracefully', () => {
  const p = tmpFile();
  profiles.setProfilesPathForTesting(p);
  try {
    fs.writeFileSync(p, 'not json{{{');
    const loaded = profiles.loadProfiles();
    assert.deepStrictEqual(loaded, { profiles: [], defaultProfileId: null });
  } finally {
    profiles.setProfilesPathForTesting(null);
    try { fs.unlinkSync(p); } catch {}
  }
});

test('pickProfileForSession: explicit id wins, "none" returns null, undefined uses default', () => {
  const p = tmpFile();
  profiles.setProfilesPathForTesting(p);
  try {
    profiles.saveProfiles({
      profiles: [
        { id: 'ds', name: 'DeepSeek', env: { ANTHROPIC_BASE_URL: 'https://ds' } },
        { id: 'glm', name: 'GLM', env: { ANTHROPIC_BASE_URL: 'https://glm' } },
      ],
      defaultProfileId: 'ds',
    });
    assert.strictEqual(profiles.pickProfileForSession('glm').id, 'glm');
    assert.strictEqual(profiles.pickProfileForSession(undefined).id, 'ds');
    assert.strictEqual(profiles.pickProfileForSession('none'), null);
    assert.strictEqual(profiles.pickProfileForSession('does-not-exist'), null);
  } finally {
    profiles.setProfilesPathForTesting(null);
    try { fs.unlinkSync(p); } catch {}
  }
});

test('ENV_REF_RE matches single $VAR and ${VAR} only', () => {
  assert.match('$FOO', profiles.ENV_REF_RE);
  assert.match('${FOO}', profiles.ENV_REF_RE);
  assert.match('$FOO_BAR_99', profiles.ENV_REF_RE);
  assert.doesNotMatch('foo$BAR', profiles.ENV_REF_RE);
  assert.doesNotMatch('$FOO bar', profiles.ENV_REF_RE);
  assert.doesNotMatch('$', profiles.ENV_REF_RE);
  assert.doesNotMatch('$1FOO', profiles.ENV_REF_RE);
});
