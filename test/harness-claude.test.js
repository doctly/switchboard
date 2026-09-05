const { test } = require('node:test');
const assert = require('node:assert/strict');

const claude = require('../harnesses/claude');
const { getHarness, DEFAULT_HARNESS, availableHarnesses } = require('../harnesses');

// buildLaunchArgs was lifted out of main.js's open-terminal handler. These pin
// the exact argv it used to build, so the move stays a move.

test('a new session pre-assigns its id', () => {
  assert.deepEqual(
    claude.buildLaunchArgs({ sessionId: 'abc', isNew: true, options: {} }),
    ['--session-id', 'abc']
  );
});

test('an existing session resumes', () => {
  assert.deepEqual(
    claude.buildLaunchArgs({ sessionId: 'abc', isNew: false, options: {} }),
    ['--resume', 'abc']
  );
});

test('forkFrom wins over both, and forks the source not the new id', () => {
  assert.deepEqual(
    claude.buildLaunchArgs({ sessionId: 'new', isNew: true, options: { forkFrom: 'src' } }),
    ['--resume', 'src', '--fork-session']
  );
});

test('dangerouslySkipPermissions suppresses permissionMode', () => {
  // Both set is a real state — the dialog can carry a stale mode alongside the
  // skip toggle — and passing both to claude is an error.
  const args = claude.buildLaunchArgs({
    sessionId: 'a', isNew: true,
    options: { dangerouslySkipPermissions: true, permissionMode: 'plan' },
  });
  assert.ok(args.includes('--dangerously-skip-permissions'));
  assert.ok(!args.includes('--permission-mode'));
});

test('--worktree is dropped on resume, kept on a new session', () => {
  // Resuming must reuse the session's existing directory; spinning up a fresh
  // worktree makes the attach fail.
  const resumed = claude.buildLaunchArgs({
    sessionId: 'a', isNew: false, options: { worktree: true, worktreeName: 'wt' },
  });
  assert.ok(!resumed.includes('--worktree'));

  const fresh = claude.buildLaunchArgs({
    sessionId: 'a', isNew: true, options: { worktree: true, worktreeName: 'wt' },
  });
  assert.deepEqual(fresh, ['--session-id', 'a', '--worktree', 'wt']);
});

test('addDirs splits on commas and trims, skipping empties', () => {
  const args = claude.buildLaunchArgs({
    sessionId: 'a', isNew: true, options: { addDirs: ' /one , , /two ' },
  });
  assert.deepEqual(args, ['--session-id', 'a', '--add-dir', '/one', '--add-dir', '/two']);
});

test('appendSystemPrompt goes last', () => {
  const args = claude.buildLaunchArgs({
    sessionId: 'a', isNew: true, options: { chrome: true, appendSystemPrompt: 'hi' },
  });
  assert.deepEqual(args.slice(-2), ['--append-system-prompt', 'hi']);
});

test('no options at all still produces a launchable argv', () => {
  assert.deepEqual(
    claude.buildLaunchArgs({ sessionId: 'a', isNew: true }),
    ['--session-id', 'a']
  );
});

// --- registry ---

test('an unknown or missing harness id falls back to Claude', () => {
  // Rows written before the harness column existed read back as null/undefined.
  assert.equal(getHarness(undefined).id, 'claude');
  assert.equal(getHarness(null).id, 'claude');
  assert.equal(getHarness('codex-from-the-future').id, 'claude');
  assert.equal(DEFAULT_HARNESS, 'claude');
});

test('transcriptPath prefers a stored sessionFile over reconstructing one', () => {
  // Claude names its files <sessionId>.jsonl, so the reconstruction is exact —
  // but codex does not, which is why the column exists.
  assert.equal(
    claude.transcriptPath({ sessionId: 'a', folder: 'f', sessionFile: '/stored/x.jsonl' }),
    '/stored/x.jsonl'
  );
  assert.ok(
    claude.transcriptPath({ sessionId: 'a', folder: 'f' }).endsWith('/f/a.jsonl')
  );
});

test('every registered harness implements the indexing contract', () => {
  const required = ['id', 'label', 'binary', 'folderPrefix', 'groupsByProject',
    'available', 'sessionsRoot', 'listFolders', 'folderPath', 'folderForProject',
    'listTranscripts', 'sessionIdFromPath', 'transcriptPath',
    'deriveProjectPath', 'readSessionFile'];
  for (const h of require('../harnesses').allHarnesses()) {
    for (const key of required) {
      assert.ok(h[key] !== undefined, `${h.id} is missing ${key}`);
    }
  }
});

// buildLaunchArgs is not in the list above on purpose: a harness can be indexed
// (its history shows in the sidebar) before it can be launched. Codex joins this
// assertion when resume lands.
test('Claude implements the launch contract', () => {
  assert.equal(typeof claude.buildLaunchArgs, 'function');
});

test('folder prefixes are unique and cannot shadow each other', () => {
  const prefixes = require('../harnesses').allHarnesses()
    .map(h => h.folderPrefix).filter(Boolean);
  assert.equal(new Set(prefixes).size, prefixes.length, 'duplicate folderPrefix');
  for (const a of prefixes) {
    for (const b of prefixes) {
      if (a !== b) assert.ok(!b.startsWith(a), `${b} is shadowed by ${a}`);
    }
  }
});

// --- folder namespacing ---
//
// One `folder` column addresses every harness's on-disk layout, and that only
// works because Claude's keys can never look like a prefixed one. This pins the
// invariant the whole scheme rests on; a change to encodeProjectPath that let a
// '/' through would silently route real Claude folders at another harness.
test('encodeProjectPath never emits a character that could look like a prefix', () => {
  const { encodeProjectPath } = require('../encode-project-path');
  const paths = [
    '/Users/me/proj',
    '/Users/me/proj/.claude/worktrees/wt',
    '/Users/me/a b/c.d_e',
    '/Users/me/' + 'x'.repeat(400),   // the >200 char hash branch
    'C:\\Users\\me\\proj',
  ];
  for (const p of paths) {
    assert.match(encodeProjectPath(p), /^[a-zA-Z0-9-]+$/, p);
  }
});

test('an unprefixed folder key resolves to Claude', () => {
  const { harnessForFolder } = require('../harnesses');
  assert.equal(harnessForFolder('-Users-me-proj').id, 'claude');
  assert.equal(harnessForFolder('').id, 'claude');
});

// --- activity signalling ---

test('Claude reports working with old and new spinner frames and idle with U+2733', () => {
  assert.equal(claude.parseTitleState('⠹ doing a thing'), 'busy');
  for (const frame of ['◐', '◑', '◒', '◓']) {
    assert.equal(claude.parseTitleState(`${frame} doing a thing`), 'busy', frame);
  }
  assert.equal(claude.parseTitleState('✳ idle'), 'idle');
});

test('an ordinary Claude title is not read as idle', () => {
  // Unlike codex, Claude sets plain titles that mean nothing about activity, so
  // treating "not a spinner" as idle would end a busy state early.
  assert.equal(claude.parseTitleState('my-project'), null);
  assert.equal(claude.parseTitleState(''), null);
});

test('Claude notification wording maps to the two states', () => {
  for (const m of [
    'Claude Code needs your attention',
    'Claude Code needs your approval for the plan',
    'Claude needs your permission to use Bash',
    'Claude Code wants to enter plan mode',
  ]) assert.equal(claude.classifyNotification(m), 'attention', m);
  assert.equal(claude.classifyNotification('Claude is waiting for your input'), 'idle');
  assert.equal(claude.classifyNotification('some other message'), null);
});

test('every harness can report activity', () => {
  for (const h of require('../harnesses').allHarnesses()) {
    assert.equal(typeof h.parseTitleState, 'function', h.id);
    assert.equal(typeof h.classifyNotification, 'function', h.id);
  }
});

// --- OSC 9;4 progress ---
//
// Claude emits these when its `terminalProgressBarEnabled` setting is on
// (default). A slash command produces `4;3;` then `4;0;` ~200ms later without
// ever touching the title, so the busy state it raises can only be cleared by
// honouring `4;0` — otherwise the session spins until Claude's "waiting for
// your input" notice a full minute later.

test('progress start marks a session busy', () => {
  const { progressBusyState } = require('../harnesses');
  for (const level of ['1', '2', '3']) {
    assert.equal(progressBusyState({ level, titleBusy: false }), 'busy', level);
  }
});

test('progress end clears busy when the title does not say otherwise', () => {
  const { progressBusyState } = require('../harnesses');
  assert.equal(progressBusyState({ level: '0', titleBusy: false }), 'idle');
});

test('progress end is ignored while the title shows a spinner', () => {
  // Any child process in the PTY can emit 9;4. The title comes from the CLI
  // itself, so a subprocess finishing its progress bar must not report the CLI
  // as idle while it is visibly still working.
  const { progressBusyState } = require('../harnesses');
  assert.equal(progressBusyState({ level: '0', titleBusy: true }), null);
});

test('an unknown progress level changes nothing', () => {
  const { progressBusyState } = require('../harnesses');
  for (const level of ['9', '', undefined]) {
    assert.equal(progressBusyState({ level, titleBusy: false }), null, String(level));
  }
});

test('Claude transcripts reach the viewer untouched', () => {
  // The viewer was written against Claude's format, so its normalisation is
  // identity — it exists so the viewer never has to know which CLI wrote a file.
  const entries = [{ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } }];
  assert.equal(claude.toViewerEntries(entries), entries);
});

test('every harness can feed the viewer', () => {
  for (const h of require('../harnesses').allHarnesses()) {
    assert.equal(typeof h.toViewerEntries, 'function', h.id);
  }
});

// --- fork id detection ---
//
// A fresh Claude session is told its id with --session-id, but --fork-session
// makes Claude mint its own. So a fork is launched under a temporary id and
// matched to its transcript afterwards, exactly as codex sessions are.

test('only a fork needs its real id discovered', () => {
  assert.equal(claude.needsIdDetection({ isNew: true, options: {} }), false);
  assert.equal(claude.needsIdDetection({ isNew: false, options: {} }), false);
  assert.equal(claude.needsIdDetection({ isNew: true, options: { forkFrom: 'p' } }), true);
});

const AT = Date.parse('2026-08-28T07:00:00Z');
function forkSignals(over = {}) {
  return { sessionId: 'new-id', forkedFrom: 'parent-id',
    startedAt: '2026-08-28T07:00:01Z', cwd: '/p', isSubagent: false, ...over };
}

test('a fork is claimed by the parent it records', () => {
  assert.equal(claude.matchesLaunch(forkSignals(), { forkFrom: 'parent-id', spawnedAt: AT }), true);
  assert.equal(claude.matchesLaunch(forkSignals(), { forkFrom: 'other', spawnedAt: AT }), false);
});

test('an older fork of the same parent is not claimed', () => {
  // Forking the same session twice must not hand the second launch the first
  // one's transcript.
  assert.equal(claude.matchesLaunch(
    forkSignals({ startedAt: '2026-08-01T00:00:00Z' }), { forkFrom: 'parent-id', spawnedAt: AT }), false);
});

test('a small clock skew still matches', () => {
  assert.equal(claude.matchesLaunch(
    forkSignals({ startedAt: '2026-08-28T06:59:58Z' }), { forkFrom: 'parent-id', spawnedAt: AT }), true);
});

test('a transcript that is not a fork is never claimed', () => {
  assert.equal(claude.matchesLaunch(forkSignals({ forkedFrom: null }), { forkFrom: 'parent-id', spawnedAt: AT }), false);
  assert.equal(claude.matchesLaunch(null, { forkFrom: 'parent-id', spawnedAt: AT }), false);
  // No fork in flight: nothing should match, whatever the transcript says.
  assert.equal(claude.matchesLaunch(forkSignals(), { forkFrom: null, spawnedAt: AT }), false);
});

test('readLaunchSignals survives a truncated final line', () => {
  const fs2 = require('fs'), os2 = require('os'), path2 = require('path');
  const dir = fs2.mkdtempSync(path2.join(os2.tmpdir(), 'claude-fork-'));
  try {
    const file = path2.join(dir, 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl');
    fs2.writeFileSync(file, [
      // A snapshot line first, which is what the head of a real fork looks like.
      JSON.stringify({ type: 'file-history-snapshot', snapshot: 'x'.repeat(400) }),
      JSON.stringify({ type: 'user', cwd: '/proj', timestamp: '2026-08-28T07:00:01Z',
        forkedFrom: { sessionId: 'parent-id' }, message: { role: 'user', content: 'hi' } }),
      '{"type":"assistant","mess',   // torn write, still being appended
    ].join('\n') + '\n');
    const sig = claude.readLaunchSignals(file);
    assert.equal(sig.forkedFrom, 'parent-id');
    assert.equal(sig.cwd, '/proj');
    assert.equal(sig.sessionId, 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
  } finally {
    fs2.rmSync(dir, { recursive: true, force: true });
  }
});

test('a missing file yields nothing rather than throwing', () => {
  assert.equal(claude.readLaunchSignals('/definitely/not/here.jsonl'), null);
});
