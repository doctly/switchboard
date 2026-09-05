const { test } = require('node:test');
const assert = require('node:assert/strict');

const { buildPtyEnv } = require('../pty-env');

test('strips Electron internals that break nested Electron / node-pty', () => {
  const env = buildPtyEnv({
    ELECTRON_RUN_AS_NODE: '1',
    GOOGLE_API_KEY: 'secret',
    NODE_OPTIONS: '--inspect',
    ORIGINAL_XDG_CURRENT_DESKTOP: 'GNOME',
    WT_SESSION: 'abc',
    PATH: '/usr/bin',
  });
  assert.deepEqual(Object.keys(env).sort(), ['LC_CTYPE', 'PATH']);
});

test('sets a UTF-8 LC_CTYPE when the parent env has no locale at all', () => {
  // The macOS Finder/Dock launch case: launchd sets no LANG, so pbcopy would
  // fall back to Mac OS Roman and mangle UTF-8 on the way to the clipboard.
  assert.equal(buildPtyEnv({ PATH: '/usr/bin' }).LC_CTYPE, 'UTF-8');
});

test('an inherited locale wins — we do not override the user', () => {
  for (const inherited of [{ LANG: 'de_DE.UTF-8' }, { LC_ALL: 'ja_JP.UTF-8' }, { LC_CTYPE: 'fr_FR.ISO8859-1' }]) {
    const env = buildPtyEnv({ ...inherited });
    assert.deepEqual(env, inherited);
  }
});

test('an empty locale value counts as absent', () => {
  // launchctl reports LANG as empty rather than unset on some macOS setups;
  // an empty string gives pbcopy nothing to work with either.
  assert.equal(buildPtyEnv({ LANG: '' }).LC_CTYPE, 'UTF-8');
});
