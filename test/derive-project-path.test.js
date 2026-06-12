const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { deriveProjectPath, resolveWorktreePath } = require('../derive-project-path');

function mkTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-dpp-'));
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

test('resolveWorktreePath collapses /<repo>/.claude/worktrees/<name> back to <repo> when parent exists', () => {
  const tmp = mkTmp();
  try {
    const repo = path.join(tmp, 'repo');
    fs.mkdirSync(repo);
    const worktree = path.join(repo, '.claude', 'worktrees', 'agent-abc');
    assert.equal(resolveWorktreePath(worktree), repo);
  } finally {
    cleanup(tmp);
  }
});

test('resolveWorktreePath collapses /<repo>/.claude-worktrees/<name> back to <repo>', () => {
  const tmp = mkTmp();
  try {
    const repo = path.join(tmp, 'repo');
    fs.mkdirSync(repo);
    const worktree = path.join(repo, '.claude-worktrees', 'foo');
    assert.equal(resolveWorktreePath(worktree), repo);
  } finally {
    cleanup(tmp);
  }
});

test('resolveWorktreePath collapses /<repo>/.worktrees/<name> back to <repo>', () => {
  const tmp = mkTmp();
  try {
    const repo = path.join(tmp, 'repo');
    fs.mkdirSync(repo);
    const worktree = path.join(repo, '.worktrees', 'bar');
    assert.equal(resolveWorktreePath(worktree), repo);
  } finally {
    cleanup(tmp);
  }
});

test('resolveWorktreePath handles trailing-slash variant', () => {
  const tmp = mkTmp();
  try {
    const repo = path.join(tmp, 'repo');
    fs.mkdirSync(repo);
    const worktreeWithSlash = path.join(repo, '.worktrees', 'bar') + '/';
    assert.equal(resolveWorktreePath(worktreeWithSlash), repo);
  } finally {
    cleanup(tmp);
  }
});

test('resolveWorktreePath returns input unchanged when the parent dir does not exist on disk', () => {
  // /nonexistent-xyzzy-12345/.claude/worktrees/agent-foo — regex matches, but parent dir absent
  const fake = '/nonexistent-xyzzy-12345/.claude/worktrees/agent-foo';
  assert.equal(resolveWorktreePath(fake), fake);
});

test('resolveWorktreePath returns input unchanged when the path does not match the worktree pattern', () => {
  assert.equal(resolveWorktreePath('/repo/src/foo'), '/repo/src/foo');
  assert.equal(resolveWorktreePath('/repo/.claude/agents/foo'), '/repo/.claude/agents/foo');
  // Worktrees segment but two extra components (nested under worktree) — must not match
  assert.equal(resolveWorktreePath('/repo/.worktrees/foo/bar'), '/repo/.worktrees/foo/bar');
});

test('resolveWorktreePath passes falsy input through unchanged without throwing', () => {
  assert.equal(resolveWorktreePath(null), null);
  assert.equal(resolveWorktreePath(undefined), undefined);
  assert.equal(resolveWorktreePath(''), '');
});

test('deriveProjectPath end-to-end: jsonl with worktree cwd resolves to parent repo', () => {
  const tmp = mkTmp();
  try {
    // Real on-disk repo so existsSync returns true
    const repo = path.join(tmp, 'repo');
    fs.mkdirSync(repo);
    const worktreeCwd = path.join(repo, '.claude', 'worktrees', 'agent-x');
    // worktreeCwd itself doesn't need to exist; only its derived parent does

    // The folder we feed deriveProjectPath is a "projects/foo" style dir
    // containing a single jsonl whose first cwd line points at the worktree.
    const folder = path.join(tmp, 'project-folder');
    fs.mkdirSync(folder);
    fs.writeFileSync(
      path.join(folder, 'session-1.jsonl'),
      JSON.stringify({ type: 'user', cwd: worktreeCwd }) + '\n',
      'utf8'
    );

    assert.equal(deriveProjectPath(folder), repo);
  } finally {
    cleanup(tmp);
  }
});
