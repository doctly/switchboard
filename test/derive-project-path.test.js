const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { resolveWorktreePath, deriveProjectPath } = require('../derive-project-path');

test('resolveWorktreePath strips known worktree dirs when parent exists', () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-dpp-'));
  for (const sub of ['.claude-worktrees/x', '.claude/worktrees/x', '.worktrees/x', '.switchboard/worktrees/run--T-1']) {
    const cwd = path.join(parent, sub).replace(/\\/g, '/');
    assert.equal(path.resolve(resolveWorktreePath(cwd)), parent, sub);
    // backslash separators (Windows cwd in JSONL)
    const winCwd = path.join(parent, sub);
    assert.equal(path.resolve(resolveWorktreePath(winCwd)), parent, sub + ' (win)');
  }
});

test('resolveWorktreePath leaves non-worktree and missing-parent paths alone', () => {
  assert.equal(resolveWorktreePath('/some/project'), '/some/project');
  const ghost = '/definitely/missing/.switchboard/worktrees/x';
  assert.equal(resolveWorktreePath(ghost), ghost);
});

test('deriveProjectPath maps a worktree session folder back to the parent project', () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-dpp2-'));
  const wtCwd = path.join(parent, '.switchboard', 'worktrees', 'run--T-1');
  const sessionFolder = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-dpp3-'));
  fs.writeFileSync(
    path.join(sessionFolder, 'abc.jsonl'),
    JSON.stringify({ type: 'assistant', cwd: wtCwd }) + '\n'
  );
  assert.equal(deriveProjectPath(sessionFolder), parent);
});
