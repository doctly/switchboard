const test = require('node:test');
const assert = require('node:assert/strict');

const { resolveEffectiveSettings } = require('../resolve-effective-settings');
const claude = require('../harnesses/claude');
const codex = require('../harnesses/codex');

// Mirrors the shape of main.js's SETTING_DEFAULTS for the keys that matter here.
const DEFAULTS = {
  permissionMode: null,
  dangerouslySkipPermissions: false,
  worktree: false,
  visibleSessionCount: 5,
  shellProfile: 'auto',
};

test('returns the defaults when nothing has been saved', () => {
  assert.deepEqual(resolveEffectiveSettings(DEFAULTS, {}, {}), DEFAULTS);
});

test('project scope overrides global, which overrides defaults', () => {
  const effective = resolveEffectiveSettings(
    DEFAULTS,
    { permissionMode: 'plan', visibleSessionCount: 10 },
    { permissionMode: 'acceptEdits' },
  );
  assert.equal(effective.permissionMode, 'acceptEdits', 'project wins over global');
  assert.equal(effective.visibleSessionCount, 10, 'global still applies where project is silent');
  assert.equal(effective.shellProfile, 'auto', 'untouched keys keep their default');
});

test('a project can narrow permissionMode back to Default over a global mode', () => {
  // The settings panel saves the "Default (none)" option as `value || null`, so
  // an explicit null means "pass no --permission-mode flag". Claude's own
  // configuration still applies. It must beat a broader-scope mode.
  const effective = resolveEffectiveSettings(
    DEFAULTS,
    { permissionMode: 'bypassPermissions' },
    { permissionMode: null },
  );
  assert.equal(effective.permissionMode, null,
    'an explicitly saved null must not fall back to the global mode');
});

test('an explicit global null beats a non-null default', () => {
  // With a null default this is invisible, so pin it against a default that is
  // not null — otherwise any future non-null SETTING_DEFAULTS value silently
  // becomes unreachable.
  const effective = resolveEffectiveSettings(
    { permissionMode: 'acceptEdits' },
    { permissionMode: null },
    {},
  );
  assert.equal(effective.permissionMode, null,
    'an explicitly saved null must override a non-null default');
});

test('undefined means "never saved" and falls through', () => {
  const effective = resolveEffectiveSettings(
    DEFAULTS,
    { permissionMode: 'plan' },
    { permissionMode: undefined },
  );
  assert.equal(effective.permissionMode, 'plan',
    'an absent project key must not shadow the global value');
});

test('null and undefined are not conflated', () => {
  const withNull = resolveEffectiveSettings(DEFAULTS, { permissionMode: 'plan' }, { permissionMode: null });
  const withUndefined = resolveEffectiveSettings(DEFAULTS, { permissionMode: 'plan' }, {});
  assert.notEqual(withNull.permissionMode, withUndefined.permissionMode,
    'an explicit null and an absent key must resolve differently');
});

test('other falsy values are preserved', () => {
  const effective = resolveEffectiveSettings(
    { worktree: true, visibleSessionCount: 5, shellProfile: 'auto' },
    {},
    { worktree: false, visibleSessionCount: 0, shellProfile: '' },
  );
  assert.equal(effective.worktree, false, 'false must override a true default');
  assert.equal(effective.visibleSessionCount, 0, '0 must override a non-zero default');
  assert.equal(effective.shellProfile, '', 'an empty string must override a non-empty default');
});

test('keys absent from the defaults are ignored', () => {
  const effective = resolveEffectiveSettings(DEFAULTS, { notADefault: 'x' }, { alsoNot: 'y' });
  assert.equal('notADefault' in effective, false);
  assert.equal('alsoNot' in effective, false);
});

test('the inputs are not mutated', () => {
  const defaults = { permissionMode: null };
  const global = { permissionMode: 'plan' };
  const project = { permissionMode: null };
  resolveEffectiveSettings(defaults, global, project);
  assert.deepEqual(defaults, { permissionMode: null });
  assert.deepEqual(global, { permissionMode: 'plan' });
  assert.deepEqual(project, { permissionMode: null });
});

test('global and project default to empty when omitted', () => {
  assert.deepEqual(resolveEffectiveSettings(DEFAULTS), DEFAULTS);
});

test('project Default removes the inherited Claude permission flag on launch and resume', () => {
  const global = { permissionMode: 'bypassPermissions' };
  for (const isNew of [true, false]) {
    const inherited = claude.buildLaunchArgs({
      sessionId: 'session', isNew,
      options: resolveEffectiveSettings(DEFAULTS, global),
    });
    assert.ok(inherited.includes('--permission-mode'));
    assert.ok(inherited.includes('bypassPermissions'));

    const overridden = claude.buildLaunchArgs({
      sessionId: 'session', isNew,
      options: resolveEffectiveSettings(DEFAULTS, global, { permissionMode: null }),
    });
    assert.ok(!overridden.includes('--permission-mode'));
    assert.ok(!overridden.includes('bypassPermissions'));
    assert.ok(!overridden.includes('--dangerously-skip-permissions'));
  }
});

test('Claude Default preserves independently configured Codex and task shell settings', () => {
  const options = resolveEffectiveSettings(
    { ...DEFAULTS, codexSandbox: '', codexApproval: '', codexModel: '' },
    {
      permissionMode: 'bypassPermissions',
      codexSandbox: 'workspace-write',
      codexApproval: 'never',
      shellProfile: 'custom-shell',
    },
    { permissionMode: null, codexSandbox: 'read-only', codexApproval: 'on-request' },
  );
  const args = codex.buildLaunchArgs({ sessionId: 'session', isNew: true, options });
  assert.equal(options.permissionMode, null);
  assert.equal(options.shellProfile, 'custom-shell');
  assert.ok(args.includes('read-only'));
  assert.ok(args.includes('on-request'));
  assert.ok(!args.includes('workspace-write'));
  assert.ok(!args.includes('never'));
  assert.ok(!args.includes('--permission-mode'));
});
