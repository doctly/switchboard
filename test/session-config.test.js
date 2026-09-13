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
