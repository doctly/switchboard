const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const SessionConfig = require('../public/session-config');

test('quick-launch defaults pick up newly defined settings without another option-copying list', async () => {
  const field = { key: 'futureOption', label: 'Future option', type: 'text', default: '' };
  SessionConfig.FIELDS.claude.push(field);
  try {
    const context = vm.createContext({ SessionConfig, window: { api: {
      getEffectiveSettings: async () => ({ permissionMode: null, chrome: false, addDirs: '',
        codexModel: 'model', futureOption: 'future value', hiddenProjects: ['/not-a-launch-option'] }),
    } } });
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/dialogs.js'), 'utf8'), context);
    const options = await context.resolveDefaultSessionOptions({ projectPath: '/project' });
    assert.equal(options.futureOption, 'future value');
    assert.equal(options.permissionMode, null);
    assert.equal(options.chrome, false);
    assert.equal(options.addDirs, '');
    assert.equal(options.codexModel, 'model');
    assert.equal(options.hiddenProjects, undefined);
  } finally { SessionConfig.FIELDS.claude.pop(); }
});

test('custom false, null and empty values beat folder defaults; untouched fields follow changes', () => {
  const overrides = { permissionMode: null, dangerouslySkipPermissions: false, chrome: false, addDirs: '' };
  const defaults = { permissionMode: 'bypassPermissions', dangerouslySkipPermissions: true, chrome: true,
    addDirs: '/inherited', preLaunchCmd: 'old-prefix', codexModel: 'unrelated' };
  const options = SessionConfig.resolveOptions('claude', defaults, overrides);
  for (const [key, value] of Object.entries(overrides)) assert.equal(options[key], value);
  assert.equal(options.preLaunchCmd, 'old-prefix');
  assert.equal(options.codexModel, undefined);
  assert.equal(SessionConfig.resolveOptions('claude', { ...defaults, preLaunchCmd: 'new-prefix' }, overrides).preLaunchCmd, 'new-prefix');
  assert.equal(SessionConfig.resolveOptions('claude', defaults, {}).chrome, true, 'reset to inheritance');
});

test('configuration rejects cross-CLI fields, internal launch flags and invalid values', () => {
  for (const input of [{ permissionMode: 'plan' }, { worktree: true }, { forkFrom: 'id' }, { scheduleId: 'id' }]) {
    assert.throws(() => SessionConfig.normalizeOverrides('codex', input), /Unsupported/);
  }
  assert.throws(() => SessionConfig.normalizeOverrides('claude', { chrome: 'false' }), /on or off/);
  assert.throws(() => SessionConfig.normalizeOverrides('codex', { codexSandbox: 'unknown' }), /Invalid Sandbox/);
  assert.throws(() => SessionConfig.normalizeOverrides('claude', { preLaunchCmd: 'one\ntwo' }), /single line/);
  assert.throws(() => SessionConfig.normalizeByCli(JSON.parse('{"__proto__":{}}')), /Invalid CLI/);
  assert.deepEqual(SessionConfig.normalizeByCli({ claude: {}, codex: { codexModel: ' model ' } }), { claude: {}, codex: { codexModel: 'model' } });
});

test('scheduled launches use current folder defaults with only the selected CLI overrides', async () => {
  let defaults = { permissionMode: 'plan', chrome: true, codexSandbox: 'workspace-write', codexModel: 'folder-model' };
  const launches = [];
  const folders = [];
  const context = vm.createContext({ SessionConfig, window: { api: {
    getEffectiveSettings: async folder => { folders.push(folder); return defaults; },
  } }, launchNewSession: async (target, options, behavior) => { launches.push({ target, options, behavior }); } });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/schedules.js'), 'utf8'), context);
  const schedule = { id: 'schedule', prompt: 'Do it', sessionConfig: {
    claude: { permissionMode: null, chrome: false }, codex: { codexModel: 'custom-model' },
  } };
  await context.launchScheduledSession({ schedule, target: { projectPath: '/first', projectId: 'project', trackId: 'track' }, runtime: 'claude' });
  assert.equal(launches[0].options.permissionMode, null);
  assert.equal(launches[0].options.chrome, false);
  assert.equal(launches[0].options.codexModel, undefined);
  assert.equal(launches[0].options.initialPrompt, 'Do it');
  assert.equal(launches[0].options.scheduleId, 'schedule');
  assert.equal(launches[0].behavior.focus, false);
  defaults = { ...defaults, codexSandbox: 'read-only' };
  await context.launchScheduledSession({ schedule, target: { projectPath: '/moved' }, runtime: 'codex' });
  assert.equal(launches[1].options.codexSandbox, 'read-only');
  assert.equal(launches[1].options.codexModel, 'custom-model');
  assert.equal(launches[1].options.permissionMode, undefined);
  assert.deepEqual(folders, ['/first', '/moved']);
});

test('optional settings wait behind More options until they hold a value', () => {
  const empty = SessionConfig.resolveOptions('claude', {}, {});
  assert.deepEqual(SessionConfig.fieldsBehindMore('claude', empty), ['model', 'effort', 'allowedTools', 'appendSystemPrompt', 'preLaunchCmd', 'addDirs']);
  const filled = SessionConfig.resolveOptions('claude', { preLaunchCmd: 'aws-vault exec prod --' }, { model: 'opus' });
  assert.deepEqual(SessionConfig.fieldsBehindMore('claude', filled), ['effort', 'allowedTools', 'appendSystemPrompt', 'addDirs'],
    'a saved model and a folder pre-launch command stay in view');
  assert.deepEqual(SessionConfig.fieldsBehindMore('codex', SessionConfig.resolveOptions('codex', {}, {})), ['codexModel', 'codexEffort', 'preLaunchCmd', 'addDirs']);
  assert.ok(!SessionConfig.fieldsBehindMore('claude', empty).includes('permissionMode'), 'the main settings are never tucked away');
});

test('model and effort are per-CLI settings that default to unset', () => {
  const claude = SessionConfig.resolveOptions('claude', {}, {});
  assert.equal(claude.model, '');
  assert.equal(claude.effort, '');
  assert.equal(SessionConfig.resolveOptions('codex', {}, {}).codexEffort, '');
  assert.deepEqual(SessionConfig.normalizeOverrides('claude', { model: ' opus ', effort: 'max' }), { model: 'opus', effort: 'max' });
  assert.throws(() => SessionConfig.normalizeOverrides('claude', { effort: 'ultra' }), /Invalid Effort/);
  assert.equal(SessionConfig.normalizeOverrides('codex', { codexEffort: 'ultra' }).codexEffort, 'ultra');
  assert.throws(() => SessionConfig.normalizeOverrides('codex', { effort: 'high' }), /Unsupported/);
  assert.throws(() => SessionConfig.normalizeOverrides('claude', { codexEffort: 'high' }), /Unsupported/);
});

test("a schedule's model and effort reach the argv of the CLI it runs on", async () => {
  const launches = [];
  const context = vm.createContext({ SessionConfig, window: { api: {
    getEffectiveSettings: async () => ({ model: 'folder-model', effort: 'low', codexModel: '', codexEffort: 'low' }),
  } }, launchNewSession: async (target, options) => { launches.push(options); } });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/schedules.js'), 'utf8'), context);
  const schedule = { id: 'schedule', prompt: 'Do it', sessionConfig: {
    claude: { model: 'opus', effort: 'high' }, codex: { codexModel: 'gpt-5.5', codexEffort: 'xhigh' },
  } };
  await context.launchScheduledSession({ schedule, target: { projectPath: '/p' }, runtime: 'claude' });
  await context.launchScheduledSession({ schedule, target: { projectPath: '/p' }, runtime: 'codex' });
  const claudeArgs = require('../harnesses/claude').buildLaunchArgs({ sessionId: 's', isNew: true, options: launches[0] });
  assert.equal(claudeArgs[claudeArgs.indexOf('--model') + 1], 'opus');
  assert.equal(claudeArgs[claudeArgs.indexOf('--effort') + 1], 'high');
  const codexArgs = require('../harnesses/codex').buildLaunchArgs({ sessionId: 's', isNew: true, options: launches[1] });
  assert.equal(codexArgs[codexArgs.indexOf('--model') + 1], 'gpt-5.5');
  assert.ok(codexArgs.includes('model_reasoning_effort="xhigh"'));
  assert.ok(!codexArgs.includes('--effort'), 'the Claude flag never reaches codex');
  // Nothing set anywhere: no flag, so each CLI keeps its own default.
  await context.launchScheduledSession({ schedule: { ...schedule, sessionConfig: { claude: { model: '', effort: '' } } }, target: { projectPath: '/p' }, runtime: 'claude' });
  const bare = require('../harnesses/claude').buildLaunchArgs({ sessionId: 's', isNew: true, options: launches[2] });
  assert.ok(!bare.includes('--model') && !bare.includes('--effort'));
});

test('additional Claude instructions preserve multiline text through settings and launch', () => {
  const appendSystemPrompt = 'First line.\n  Indented instructions.\n';
  const options = SessionConfig.resolveOptions('claude', {}, { appendSystemPrompt, allowedTools: 'Read,Write' });
  assert.equal(options.appendSystemPrompt, appendSystemPrompt);
  const args = require('../harnesses/claude').buildLaunchArgs({ sessionId: 'test', isNew: true, options });
  assert.equal(args[args.indexOf('--append-system-prompt') + 1], appendSystemPrompt);
  assert.equal(args[args.indexOf('--allowedTools') + 1], 'Read,Write');
  assert.throws(() => SessionConfig.normalizeOverrides('claude', { appendSystemPrompt: 'bad\x00prompt' }), /unsafe characters/);
  assert.throws(() => SessionConfig.normalizeOverrides('codex', { allowedTools: 'Read' }), /Unsupported/);
});
