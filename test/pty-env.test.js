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

test('a Claude Code session Switchboard was started from is not passed on', () => {
  // Restarting the app from inside a session leaves these in its environment;
  // a CLI that inherits them takes itself for a child and writes no transcript.
  const env = buildPtyEnv({
    PATH: '/usr/bin', LANG: 'en_US.UTF-8',
    CLAUDECODE: '1', CLAUDE_PID: '42', CLAUDE_EFFORT: 'high',
    CLAUDE_CODE_ENTRYPOINT: 'cli', CLAUDE_CODE_EXECPATH: '/x/claude',
    CLAUDE_CODE_SESSION_ID: 'parent', CLAUDE_CODE_CHILD_SESSION: '1', CLAUDE_CODE_SESSION_ATTENDED: '1',
    CLAUDE_CODE_BRIDGE_SESSION_ID: 'b', CLAUDE_CODE_MESSAGING_TOKEN: 't', CLAUDE_CODE_MESSAGING_SOCKET: '/tmp/s',
    CLAUDE_CODE_SSE_PORT: '1234',
    // What the user configured stays.
    CLAUDE_CODE_MAX_OUTPUT_TOKENS: '64000', CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1', CLAUDE_CONFIG_DIR: '/cfg',
  });
  assert.deepEqual(Object.keys(env).sort(), ['CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS', 'CLAUDE_CODE_MAX_OUTPUT_TOKENS', 'CLAUDE_CONFIG_DIR', 'LANG', 'PATH']);
});
