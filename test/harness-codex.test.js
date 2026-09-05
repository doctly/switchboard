const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const codex = require('../harnesses/codex');

// A rollout in the shape codex actually writes. Both event families are present
// because real transcripts carry both: `response_item` messages hold the text,
// and older codex versions ALSO emit `event_msg` copies of the same turns.
function rollout({ id, cwd, turns, meta }) {
  const lines = [
    { timestamp: '2026-08-26T10:00:00.000Z', type: 'session_meta',
      payload: { session_id: 'lineage-root', id: 'lineage-root', cwd, cli_version: '0.149.1', ...meta } },
    { timestamp: '2026-08-26T10:00:00.100Z', type: 'event_msg',
      payload: { type: 'task_started', turn_id: 't1' } },
    { timestamp: '2026-08-26T10:00:01.000Z', type: 'response_item',
      payload: { type: 'message', role: 'developer', content: [{ type: 'text', text: '<skills_instructions>…' }] } },
    { timestamp: '2026-08-26T10:00:01.100Z', type: 'response_item',
      payload: { type: 'message', role: 'user', content: [{ type: 'text', text: '<environment_context>\n  <cwd>' + cwd + '</cwd>\n</environment_context>' }] } },
  ];
  let t = 2;
  for (const [role, text] of turns) {
    lines.push({ timestamp: `2026-08-26T10:00:${String(t++).padStart(2, '0')}.000Z`,
      type: 'response_item', payload: { type: 'message', role, content: [{ type: 'text', text }] } });
    // The duplicate event_msg copy that must NOT be double-counted.
    lines.push({ timestamp: `2026-08-26T10:00:${String(t++).padStart(2, '0')}.000Z`,
      type: 'event_msg',
      payload: { type: role === 'user' ? 'user_message' : 'agent_message', message: text } });
  }
  return lines.map(l => JSON.stringify(l)).join('\n') + '\n';
}

function withFixture(files, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-fixture-'));
  try {
    for (const [name, body] of Object.entries(files)) {
      fs.writeFileSync(path.join(dir, name), body, 'utf8');
    }
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const ID = '01a03f6c-fdf9-7c83-86e3-c388f81d765c';
const NAME = `rollout-2026-08-26T11-55-02-${ID}.jsonl`;

test('parses a rollout into the shape the cache expects', () => {
  withFixture({ [NAME]: rollout({
    cwd: '/Users/me/proj',
    turns: [['user', 'fix the parser'], ['assistant', 'done'], ['user', 'thanks']],
  }) }, (dir) => {
    const s = codex.readSessionFile(path.join(dir, NAME), 'codex/2026/08/26');
    assert.equal(s.sessionId, ID);
    assert.equal(s.projectPath, '/Users/me/proj');
    assert.equal(s.runtime, 'codex');
    assert.equal(s.summary, 'fix the parser');
    assert.equal(s.sessionFile, path.join(dir, NAME));
    assert.equal(s.folder, 'codex/2026/08/26');
    // 3 real turns. The developer message and the <environment_context> user
    // message are scaffolding, and the event_msg copies are duplicates.
    assert.equal(s.messageCount, 3);
    assert.ok(s.textContent.includes('fix the parser'));
    assert.ok(!s.textContent.includes('skills_instructions'));
  });
});

test('the session id comes from the file name, not session_meta', () => {
  // session_meta.session_id is the lineage root and is repeated across every
  // resume of a conversation — using it would collide on the primary key.
  withFixture({ [NAME]: rollout({ cwd: '/p', turns: [['user', 'hi']] }) }, (dir) => {
    const s = codex.readSessionFile(path.join(dir, NAME), 'f');
    assert.equal(s.sessionId, ID);
    assert.notEqual(s.sessionId, 'lineage-root');
  });
});

test('injected user turns never become the summary', () => {
  for (const tag of ['environment_context', 'recommended_plugins', 'turn_aborted', 'transcript']) {
    withFixture({ [NAME]: rollout({ cwd: '/p', turns: [
      ['user', `<${tag}>\nnoise\n</${tag}>`], ['user', 'the real question'],
    ] }) }, (dir) => {
      const s = codex.readSessionFile(path.join(dir, NAME), 'f');
      assert.equal(s.summary, 'the real question', tag);
      assert.equal(s.messageCount, 1, tag);
    });
  }
});

test('a session with no user turn is skipped', () => {
  // Launched, then abandoned before saying anything — nothing to show.
  withFixture({ [NAME]: rollout({ cwd: '/p', turns: [] }) }, (dir) => {
    assert.equal(codex.readSessionFile(path.join(dir, NAME), 'f'), null);
  });
});

test('a rollout with no cwd is skipped — there is no project to file it under', () => {
  const body = JSON.stringify({ timestamp: '2026-08-26T10:00:00Z', type: 'session_meta', payload: { session_id: 'x' } }) + '\n'
    + JSON.stringify({ timestamp: '2026-08-26T10:00:01Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'text', text: 'hi' }] } }) + '\n';
  withFixture({ [NAME]: body }, (dir) => {
    assert.equal(codex.readSessionFile(path.join(dir, NAME), 'f'), null);
  });
});

test('a truncated or corrupt line does not lose the rest of the session', () => {
  const good = rollout({ cwd: '/p', turns: [['user', 'first'], ['assistant', 'ok']] });
  const body = good.trimEnd() + '\n{"type":"response_item","payload":{"type":"mess\n';
  withFixture({ [NAME]: body }, (dir) => {
    const s = codex.readSessionFile(path.join(dir, NAME), 'f');
    assert.equal(s.summary, 'first');
    assert.equal(s.messageCount, 2);
  });
});

test('created and modified come from the transcript, not the file', () => {
  withFixture({ [NAME]: rollout({ cwd: '/p', turns: [['user', 'a'], ['assistant', 'b']] }) }, (dir) => {
    const s = codex.readSessionFile(path.join(dir, NAME), 'f');
    assert.equal(s.created, '2026-08-26T10:00:00.000Z');
    assert.ok(s.modified > s.created);
    assert.ok(s.fileMtime, 'fileMtime is the cache invalidation key and must be set');
  });
});

test('only rollout files are listed, and ids are read without opening them', () => {
  withFixture({
    [NAME]: 'ignored',
    'notes.jsonl': 'ignored',
    'rollout-broken.jsonl': 'ignored',
  }, (dir) => {
    const found = codex.listTranscripts(dir);
    assert.deepEqual(found.map(f => path.basename(f)), [NAME]);
    assert.equal(codex.sessionIdFromPath(found[0]), ID);
    assert.equal(codex.sessionIdFromPath('/x/notes.jsonl'), null);
  });
});

test('a codex transcript can only be found through sessionFile', () => {
  // The path carries a timestamp and a date directory, so unlike Claude it
  // cannot be rebuilt from the session id.
  assert.equal(codex.transcriptPath({ sessionId: ID, sessionFile: '/a/b.jsonl' }), '/a/b.jsonl');
  assert.equal(codex.transcriptPath({ sessionId: ID }), null);
});

test('folder keys are date paths under the codex prefix', () => {
  assert.equal(codex.folderPrefix, 'codex/');
  assert.equal(codex.groupsByProject, false);
  assert.equal(codex.deriveProjectPath('/anything'), null);
  assert.ok(codex.folderPath('2026/08/26').endsWith(path.join('sessions', '2026', '08', '26')));
});

test('CODEX_HOME relocates the sessions root', () => {
  const prev = process.env.CODEX_HOME;
  try {
    process.env.CODEX_HOME = '/tmp/elsewhere';
    assert.equal(codex.sessionsRoot(), path.join('/tmp/elsewhere', 'sessions'));
  } finally {
    if (prev === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = prev;
  }
});

// --- launch ---

// Every launch carries the forced [tui] overrides that make activity visible
// (see the activity tests below). They are asserted once, there; stripping them
// here keeps these assertions exact about the part each test is describing.
const FORCED_CONFIG = /^tui\.(notifications|notification_method|notification_condition|terminal_title)=/;

function argsWithoutForcedConfig(over) {
  const args = codex.buildLaunchArgs(over);
  const out = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-c' && FORCED_CONFIG.test(args[i + 1] || '')) { i++; continue; }
    out.push(args[i]);
  }
  return out;
}

test('resuming names the session id as a subcommand argument', () => {
  assert.deepEqual(argsWithoutForcedConfig({ sessionId: ID, isNew: false, options: {} }), ['resume', ID]);
});

test('forking uses the fork subcommand against the source session', () => {
  assert.deepEqual(argsWithoutForcedConfig({ sessionId: 'new', isNew: true, options: { forkFrom: ID } }), ['fork', ID]);
});

test('a new session passes no id — codex will not accept a pre-assigned one', () => {
  assert.deepEqual(argsWithoutForcedConfig({ sessionId: ID, isNew: true, options: {} }), []);
});

test("Claude-only options are ignored, not translated", () => {
  // These reach every harness because the renderer sends one options bag. codex
  // has no equivalent flags, and an unknown flag would fail the launch outright.
  const args = argsWithoutForcedConfig({
    sessionId: ID, isNew: false,
    options: { permissionMode: 'plan', worktree: true, worktreeName: 'wt', chrome: true,
      appendSystemPrompt: 'hi', mcpEmulation: true },
  });
  assert.deepEqual(args, ['resume', ID]);
});

test('enumerated options are validated against what the CLI accepts', () => {
  // Stored settings outlive the codex version that understood them, and they
  // reach a shell command line — neither a stale nor a hostile value may pass.
  for (const bad of ['--dangerously-bypass-approvals-and-sandbox', 'full-access', '', null, 'x; rm -rf /']) {
    assert.deepEqual(
      argsWithoutForcedConfig({ sessionId: ID, isNew: false, options: { codexSandbox: bad, codexApproval: bad } }),
      ['resume', ID], String(bad)
    );
  }
  assert.deepEqual(
    argsWithoutForcedConfig({ sessionId: ID, isNew: false,
      options: { codexSandbox: 'workspace-write', codexApproval: 'never' } }),
    ['resume', ID, '--sandbox', 'workspace-write', '--ask-for-approval', 'never']
  );
});

test('skipping permissions replaces the sandbox and approval flags', () => {
  // Passing both a bypass and a sandbox policy is contradictory.
  const args = argsWithoutForcedConfig({
    sessionId: ID, isNew: false,
    options: { dangerouslySkipPermissions: true, codexSandbox: 'read-only', codexApproval: 'never' },
  });
  assert.deepEqual(args, ['resume', ID, '--dangerously-bypass-approvals-and-sandbox']);
});

test('addDirs splits and trims the same way Claude does', () => {
  assert.deepEqual(
    argsWithoutForcedConfig({ sessionId: ID, isNew: false, options: { addDirs: ' /one , , /two ' } }),
    ['resume', ID, '--add-dir', '/one', '--add-dir', '/two']
  );
});

test('every flag codex is launched with is one the CLI declares', () => {
  // Guards against a flag being invented here that codex does not have.
  const KNOWN = new Set(['--sandbox', '--ask-for-approval', '--model', '--add-dir',
    '--dangerously-bypass-approvals-and-sandbox']);
  // -c is codex's own config-override flag, verified against `codex resume --help`.
  const args = codex.buildLaunchArgs({
    sessionId: ID, isNew: false,
    options: { codexSandbox: 'read-only', codexApproval: 'on-request', codexModel: 'gpt-5', addDirs: '/x' },
  });
  for (const a of args) {
    if (a.startsWith('--')) assert.ok(KNOWN.has(a), `unknown flag ${a}`);
  }
});

// --- sub-agent threads ---
//
// codex records sub-agent threads as ordinary rollouts, but refuses to resume
// one: "cannot resume an unloaded multi-agent v2 sub-agent through its parent".
// Indexing them would put rows in the sidebar whose only action always fails.

test('a sub-agent rollout is not indexed, however it is marked', () => {
  const markers = [
    { thread_source: 'subagent' },
    { parent_thread_id: '01a03d4c-b489-7181-b611-9e3f161866a0' },
    { agent_path: '/root/researcher' },
    { agent_nickname: 'Feynman' },
  ];
  for (const meta of markers) {
    withFixture({ [NAME]: rollout({ cwd: '/p', turns: [['user', 'hi']], meta }) }, (dir) => {
      assert.equal(codex.readSessionFile(path.join(dir, NAME), 'f'), null, JSON.stringify(meta));
    });
  }
});

test('a top-level session is still indexed when the markers are absent', () => {
  // thread_source is missing entirely on older rollouts, and 'user' on new ones.
  for (const meta of [{}, { thread_source: 'user' }]) {
    withFixture({ [NAME]: rollout({ cwd: '/p', turns: [['user', 'hi']], meta }) }, (dir) => {
      const s = codex.readSessionFile(path.join(dir, NAME), 'f');
      assert.ok(s, JSON.stringify(meta));
      assert.equal(s.sessionId, ID);
    });
  }
});

test('a fork is a real session — forked_from_id alone is not a sub-agent marker', () => {
  withFixture({ [NAME]: rollout({
    cwd: '/p', turns: [['user', 'hi']], meta: { forked_from_id: 'some-parent' },
  }) }, (dir) => {
    assert.ok(codex.readSessionFile(path.join(dir, NAME), 'f'));
  });
});

// --- new-session detection ---
//
// codex refuses a pre-assigned session id and writes nothing until the first
// turn, so a new session is launched under a temporary uuid and matched to its
// transcript afterwards.

const TAG = codex.originatorTag('3f0c8a1e-1111-4222-8333-444455556666');

test('the originator tag is safe to put in an HTTP header', () => {
  // codex forwards this value as a header and drops it if it is malformed.
  assert.match(TAG, /^switchboard_[a-z0-9]+$/);
  assert.equal(codex.launchEnv('a-b-c').CODEX_INTERNAL_ORIGINATOR_OVERRIDE, 'switchboard_abc');
});

function signals(over = {}) {
  return {
    sessionId: ID, originator: TAG, cwd: '/Users/me/proj',
    startedAt: '2026-08-26T10:00:00.000Z', isSubagent: false, ...over,
  };
}
const AT = Date.parse('2026-08-26T10:00:00.000Z');

test('an exact originator match needs no other evidence', () => {
  // Different directory, launched later — the tag alone settles it.
  assert.equal(codex.matchesLaunch(signals(), { tag: TAG, projectPath: '/elsewhere', spawnedAt: AT + 60000 }), true);
});

test('a transcript tagged for a different launch is never stolen', () => {
  // Two new codex sessions starting in one directory at the same moment is the
  // only case the cwd fallback could get wrong, so it refuses outright.
  assert.equal(codex.matchesLaunch(
    signals({ originator: 'switchboard_someoneelse' }),
    { tag: TAG, projectPath: '/Users/me/proj', spawnedAt: AT }
  ), false);
});

test('without the tag, a same-directory transcript started after the spawn matches', () => {
  // The fallback for if CODEX_INTERNAL_ORIGINATOR_OVERRIDE ever stops working.
  assert.equal(codex.matchesLaunch(
    signals({ originator: 'codex_cli_rs' }),
    { tag: TAG, projectPath: '/Users/me/proj', spawnedAt: AT }
  ), true);
});

test('the fallback rejects another directory, or a transcript predating the launch', () => {
  const base = { tag: TAG, projectPath: '/Users/me/proj', spawnedAt: AT };
  assert.equal(codex.matchesLaunch(signals({ originator: 'x', cwd: '/other' }), base), false);
  assert.equal(codex.matchesLaunch(
    signals({ originator: 'x', startedAt: '2026-08-26T09:00:00.000Z' }), base), false);
});

test('a small clock skew does not lose the match', () => {
  assert.equal(codex.matchesLaunch(
    signals({ originator: 'x', startedAt: '2026-08-26T09:59:58.000Z' }),
    { tag: TAG, projectPath: '/Users/me/proj', spawnedAt: AT }
  ), true);
});

test('a sub-agent transcript is never adopted as a launch', () => {
  assert.equal(codex.matchesLaunch(signals({ isSubagent: true }), { tag: TAG, projectPath: '/p', spawnedAt: AT }), false);
});

test('unusable signals never match', () => {
  const c = { tag: TAG, projectPath: '/Users/me/proj', spawnedAt: AT };
  assert.equal(codex.matchesLaunch(null, c), false);
  assert.equal(codex.matchesLaunch(signals({ sessionId: null }), c), false);
  assert.equal(codex.matchesLaunch(signals({ originator: 'x', startedAt: null }), c), false);
});

test('readLaunchSignals reads a real rollout head', () => {
  withFixture({ [NAME]: rollout({
    cwd: '/Users/me/proj', turns: [['user', 'hi']],
    meta: { originator: TAG, timestamp: '2026-08-26T10:00:00.000Z' },
  }) }, (dir) => {
    const s = codex.readLaunchSignals(path.join(dir, NAME));
    assert.equal(s.sessionId, ID);
    assert.equal(s.originator, TAG);
    assert.equal(s.cwd, '/Users/me/proj');
    assert.equal(s.isSubagent, false);
  });
});

test('a half-written first line yields nothing rather than a wrong match', () => {
  // The watcher fires the moment the file is created; codex may still be
  // writing session_meta. Returning null means "try again on the next event".
  withFixture({ [NAME]: '{"type":"session_meta","payload":{"cwd":"/Users' }, (dir) => {
    assert.equal(codex.readLaunchSignals(path.join(dir, NAME)), null);
  });
  withFixture({ [NAME]: '' }, (dir) => {
    assert.equal(codex.readLaunchSignals(path.join(dir, NAME)), null);
  });
  assert.equal(codex.readLaunchSignals('/definitely/not/here.jsonl'), null);
});

test('a file whose first line is not session_meta is not a launch', () => {
  withFixture({ [NAME]: '{"type":"event_msg","payload":{"type":"task_started"}}\n' }, (dir) => {
    assert.equal(codex.readLaunchSignals(path.join(dir, NAME)), null);
  });
});

// --- activity signalling ---
//
// Switchboard shows a session as working, idle-with-a-response, or blocked on
// the user. codex reports the first through its terminal title and the other
// two through OSC 9, with different wording from Claude.

test('a braille spinner in the title means the session is working', () => {
  for (const frame of ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']) {
    assert.equal(codex.parseTitleState(frame + ' myproject'), 'busy', frame);
  }
});

test('"Action Required" in the title means the session is blocked on the user', () => {
  // The signal the user sees. It must not depend on OSC 9, which only fires
  // when the CLI's notifications are on — a session started before Switchboard
  // began forcing them has none.
  assert.equal(codex.parseTitleState('[ . ] Action Required | MyClaude'), 'attention');
  assert.equal(codex.parseTitleState('[ ! ] Action Required | Open link'), 'attention');
  assert.equal(codex.parseTitleState('[ ! ] action required'), 'attention');
});

test('the title is scanned whole, since its item order is configurable', () => {
  // [tui].terminal_title is a user-configured list of items, so the spinner is
  // not necessarily first. Reading only charAt(0) would call a working session
  // idle for anyone who reordered it.
  assert.equal(codex.parseTitleState('myproject ⠹'), 'busy');
  assert.equal(codex.parseTitleState('main | myproject | [ . ] Action Required'), 'attention');
});

test('blocked beats working when a title somehow carries both', () => {
  assert.equal(codex.parseTitleState('⠹ [ . ] Action Required'), 'attention');
});

test('a title without a spinner means idle — codex has no idle glyph', () => {
  // Claude marks idle with ✳; codex just drops the prefix, so the absence of a
  // spinner is the only signal. Reading it as "no information" would leave the
  // session spinning in the sidebar forever.
  assert.equal(codex.parseTitleState('myproject'), 'idle');
  assert.equal(codex.parseTitleState('~/dev/api-service'), 'idle');
});

test('an empty title says nothing either way', () => {
  assert.equal(codex.parseTitleState(''), null);
  assert.equal(codex.parseTitleState(null), null);
  assert.equal(codex.parseTitleState(undefined), null);
});

test('an approval request is what blocks a session on the user', () => {
  assert.equal(codex.classifyNotification('Approval requested: /bin/zsh -lc "rm -rf x"'), 'attention');
  assert.equal(codex.classifyNotification('approval requested: something'), 'attention');
});

test('any other notification is a finished turn', () => {
  // codex sends the agent's final message when a turn completes, so the text is
  // arbitrary — anything that is not an approval request means "come read this".
  assert.equal(codex.classifyNotification('beta'), 'idle');
  assert.equal(codex.classifyNotification('I fixed the parser and ran the tests.'), 'idle');
  assert.equal(codex.classifyNotification(''), null);
  assert.equal(codex.classifyNotification(null), null);
});

test('launching always turns codex notifications on', () => {
  // No OSC 9 without them, and 'unfocused' would suppress exactly the case that
  // matters — the user looking at a different session.
  for (const opts of [{}, { forkFrom: 'x' }, { codexSandbox: 'read-only' }]) {
    const args = codex.buildLaunchArgs({ sessionId: ID, isNew: false, options: opts });
    const joined = args.join(' ');
    assert.ok(joined.includes('tui.notifications=true'), joined);
    assert.ok(joined.includes('tui.notification_method="osc9"'), joined);
    assert.ok(joined.includes('tui.notification_condition="always"'), joined);
    // Without pinning the item list, a user whose title omits `activity` would
    // give Switchboard no way to see the session working or blocked.
    assert.ok(joined.includes('tui.terminal_title=["activity","project-name"]'), joined);
  }
});

test('the subcommand stays first, ahead of the config overrides', () => {
  // `codex -c ... resume <id>` is not valid; the subcommand has to lead.
  assert.equal(codex.buildLaunchArgs({ sessionId: ID, isNew: false, options: {} })[0], 'resume');
  assert.equal(codex.buildLaunchArgs({ sessionId: ID, isNew: false, options: {} })[1], ID);
  assert.equal(codex.buildLaunchArgs({ sessionId: 'n', isNew: true, options: { forkFrom: ID } })[0], 'fork');
  assert.equal(codex.buildLaunchArgs({ sessionId: ID, isNew: true, options: {} })[0], '-c');
});

// --- viewer normalisation ---
//
// The JSONL viewer speaks Claude's transcript format, so a rollout is mapped
// onto it rather than the viewer learning a second one.

function responseItem(payload, timestamp = '2026-08-26T10:00:00Z') {
  return { timestamp, type: 'response_item', payload };
}

test('user and assistant text become viewer messages', () => {
  const out = codex.toViewerEntries([
    responseItem({ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] }),
    responseItem({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'hi back' }] }),
  ]);
  assert.equal(out.length, 2);
  assert.equal(out[0].type, 'user');
  assert.equal(out[0].message.content[0].type, 'text');
  assert.equal(out[0].message.content[0].text, 'hello');
  assert.equal(out[1].message.role, 'assistant');
  assert.equal(out[1].message.content[0].text, 'hi back');
});

test('CLI scaffolding is left out of the viewer too', () => {
  const out = codex.toViewerEntries([
    responseItem({ type: 'message', role: 'developer', content: [{ type: 'input_text', text: '<skills_instructions>…' }] }),
    responseItem({ type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>\n x\n</environment_context>' }] }),
    responseItem({ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'the real question' }] }),
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].message.content[0].text, 'the real question');
});

test('a tool call and its output are paired by call id', () => {
  // The viewer nests a result inside its call by matching tool_use.id against
  // tool_result.tool_use_id, so both have to carry codex's call_id.
  const out = codex.toViewerEntries([
    responseItem({ type: 'custom_tool_call', id: 'ctc_1', call_id: 'call_abc', name: 'exec', input: 'ls -la' }),
    responseItem({ type: 'custom_tool_call_output', id: 'ctco_1', call_id: 'call_abc',
      output: [{ type: 'input_text', text: 'total 0\n' }, { type: 'input_text', text: 'a.txt\n' }] }),
  ]);
  const call = out[0].message.content[0];
  const result = out[1].message.content[0];
  assert.equal(call.type, 'tool_use');
  assert.equal(call.id, 'call_abc');
  assert.equal(call.name, 'exec');
  assert.equal(call.input, 'ls -la');
  assert.equal(result.type, 'tool_result');
  assert.equal(result.tool_use_id, 'call_abc', 'must match the call, or the result renders detached');
  assert.equal(result.content, 'total 0\na.txt\n', 'output parts are joined');
});

test('the older function_call shape maps the same way', () => {
  const out = codex.toViewerEntries([
    responseItem({ type: 'function_call', call_id: 'c1', name: 'shell', arguments: '{"cmd":"ls"}' }),
    responseItem({ type: 'function_call_output', call_id: 'c1', output: 'ok' }),
  ]);
  assert.equal(out[0].message.content[0].name, 'shell');
  assert.equal(out[0].message.content[0].input, '{"cmd":"ls"}');
  assert.equal(out[1].message.content[0].content, 'ok');
});

test('reasoning renders only when a readable summary exists', () => {
  // The real chain of thought sits in encrypted_content, which only the API can
  // read, and summary is empty in most rollouts.
  const empty = codex.toViewerEntries([
    responseItem({ type: 'reasoning', summary: [], encrypted_content: 'gAAAA…' }),
  ]);
  assert.equal(empty.length, 0);

  const withSummary = codex.toViewerEntries([
    responseItem({ type: 'reasoning', summary: [{ type: 'summary_text', text: 'Checking the parser' }] }),
  ]);
  assert.equal(withSummary[0].message.content[0].type, 'thinking');
  assert.equal(withSummary[0].message.content[0].thinking, 'Checking the parser');
});

test('non-conversation records are skipped, and junk does not throw', () => {
  const out = codex.toViewerEntries([
    { timestamp: 't', type: 'session_meta', payload: { cwd: '/p' } },
    { timestamp: 't', type: 'event_msg', payload: { type: 'token_count' } },
    { type: 'response_item' },
    null,
    responseItem({ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'kept' }] }),
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].message.content[0].text, 'kept');
  assert.deepEqual(codex.toViewerEntries(null), []);
  assert.deepEqual(codex.toViewerEntries([]), []);
});

test('timestamps are carried through for the viewer to show', () => {
  const out = codex.toViewerEntries([
    responseItem({ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'x' }] }, '2026-08-26T12:34:56Z'),
  ]);
  assert.equal(out[0].timestamp, '2026-08-26T12:34:56Z');
});


test('a codex fork is matched by its parent, not the inherited tag', () => {
  // `codex fork` copies the originator from the thread it forks, so a fork we
  // launched carries the tag of whichever launch created its PARENT. Matching
  // on the tag there fails outright — this is the bug that left a forked
  // session showing twice in the sidebar.
  const parentsTag = codex.originatorTag('6cbe58fa-835d-4b02-8a9c-80cb425995bf');
  const ourTag = codex.originatorTag('d1d86b61-17a7-404e-9633-d1b9feb032be');
  const at = Date.parse('2026-08-28T07:44:57Z');
  const sig = {
    sessionId: '01a048d4-c2c6-74d1-af73-000000000000',
    originator: parentsTag,
    forkedFrom: '01a04413-6dfd-7a21-a862-2af7d8b02f33',
    cwd: '/p', startedAt: '2026-08-28T07:44:58Z', isSubagent: false,
  };
  assert.notEqual(sig.originator, ourTag, 'the fork does not carry our tag');
  assert.equal(codex.matchesLaunch(sig, { tag: ourTag, forkFrom: sig.forkedFrom, projectPath: '/p', spawnedAt: at }), true);
  assert.equal(codex.matchesLaunch(sig, { tag: ourTag, forkFrom: 'a-different-parent', projectPath: '/p', spawnedAt: at }), false);
  // And an existing fork of the same parent, from before this launch, is not taken.
  assert.equal(codex.matchesLaunch({ ...sig, startedAt: '2026-08-01T00:00:00Z' },
    { tag: ourTag, forkFrom: sig.forkedFrom, projectPath: '/p', spawnedAt: at }), false);
});
