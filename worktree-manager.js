// worktree-manager.js — git worktree isolation for Agent Teams tasks.
//
// Each leaf task gets its own worktree at
//   <project>/.switchboard/worktrees/<runId>--<taskId>
// on branch task/<runId>/<taskId>, branched from the run's integration
// branch. Workers can then edit in parallel without trampling each other;
// review = diff of the branch; merge happens on the integration branch.
//
// All git invocations use execFile (no shell), and every name that reaches
// an argument is validated against a strict allowlist regex first — these
// values normally come from Switchboard itself, but tasks.json is agent-
// written, so treat everything as untrusted.

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const { RUN_ID_RE, TASK_ID_RE, worktreesRoot } = require('./orch-protocol');

const BRANCH_RE = /^[A-Za-z0-9][A-Za-z0-9._\/-]{0,200}$/;

function git(projectPath, args, opts = {}) {
  return new Promise((resolve) => {
    execFile('git', args, { cwd: projectPath, windowsHide: true, timeout: 60_000, ...opts },
      (err, stdout, stderr) => {
        resolve({
          ok: !err,
          code: err ? (err.code ?? 1) : 0,
          stdout: String(stdout || ''),
          stderr: String(stderr || ''),
          error: err ? (String(stderr || '').trim() || err.message) : null,
        });
      });
  });
}

function isValidBranch(name) {
  return typeof name === 'string' && BRANCH_RE.test(name) && !name.includes('..') && !name.endsWith('/');
}

function taskWorktreePath(projectPath, runId, taskId) {
  return path.join(worktreesRoot(projectPath), `${runId}--${taskId}`);
}

function taskBranchName(runId, taskId) {
  return `task/${runId}/${taskId}`;
}

// True only when projectPath is itself the root of a git work tree — being
// *inside* some ancestor repo (e.g. a dotfiles repo at $HOME) doesn't count.
async function isGitRepo(projectPath) {
  const r = await git(projectPath, ['rev-parse', '--show-toplevel']);
  if (!r.ok) return false;
  try {
    let a = path.resolve(r.stdout.trim());
    let b = path.resolve(projectPath);
    if (process.platform === 'win32' || process.platform === 'darwin') {
      a = a.toLowerCase(); b = b.toLowerCase();
    }
    return a === b;
  } catch { return false; }
}

async function branchExists(projectPath, branch) {
  if (!isValidBranch(branch)) return false;
  const r = await git(projectPath, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]);
  return r.ok;
}

// Create the integration branch from current HEAD if it doesn't exist yet.
async function ensureIntegrationBranch(projectPath, branch) {
  if (!isValidBranch(branch)) return { ok: false, error: `invalid branch name: ${branch}` };
  if (await branchExists(projectPath, branch)) return { ok: true, created: false };
  const r = await git(projectPath, ['branch', branch]);
  if (!r.ok) return { ok: false, error: `failed to create integration branch: ${r.error}` };
  return { ok: true, created: true };
}

// Create (or reuse) the task worktree. Returns { ok, path, branch, reused }.
async function ensureTaskWorktree(projectPath, runId, taskId, integrationBranch) {
  if (!RUN_ID_RE.test(runId || '')) return { ok: false, error: 'invalid runId' };
  if (!TASK_ID_RE.test(taskId || '')) return { ok: false, error: 'invalid taskId' };
  if (!isValidBranch(integrationBranch)) return { ok: false, error: 'invalid integration branch' };

  const wtPath = taskWorktreePath(projectPath, runId, taskId);
  const branch = taskBranchName(runId, taskId);

  if (fs.existsSync(path.join(wtPath, '.git'))) {
    return { ok: true, path: wtPath, branch, reused: true };
  }

  const ib = await ensureIntegrationBranch(projectPath, integrationBranch);
  if (!ib.ok) return ib;

  fs.mkdirSync(path.dirname(wtPath), { recursive: true });

  // Re-dispatch after changes_requested reuses the existing task branch so
  // the worker's previous commits survive worktree removal.
  const args = (await branchExists(projectPath, branch))
    ? ['worktree', 'add', wtPath, branch]
    : ['worktree', 'add', '-b', branch, wtPath, integrationBranch];
  const r = await git(projectPath, args);
  if (!r.ok) return { ok: false, error: `git worktree add failed: ${r.error}` };
  return { ok: true, path: wtPath, branch, reused: false };
}

// The master agent performs merges in a dedicated worktree pinned to the
// integration branch so the user's main checkout is never disturbed.
async function ensureIntegrationWorktree(projectPath, runId, integrationBranch) {
  if (!RUN_ID_RE.test(runId || '')) return { ok: false, error: 'invalid runId' };
  if (!isValidBranch(integrationBranch)) return { ok: false, error: 'invalid integration branch' };
  const wtPath = path.join(worktreesRoot(projectPath), `${runId}--integration`);
  if (fs.existsSync(path.join(wtPath, '.git'))) {
    return { ok: true, path: wtPath, branch: integrationBranch, reused: true };
  }
  const ib = await ensureIntegrationBranch(projectPath, integrationBranch);
  if (!ib.ok) return ib;
  fs.mkdirSync(path.dirname(wtPath), { recursive: true });
  const r = await git(projectPath, ['worktree', 'add', wtPath, integrationBranch]);
  if (!r.ok) return { ok: false, error: `git worktree add failed: ${r.error}` };
  return { ok: true, path: wtPath, branch: integrationBranch, reused: false };
}

// Remove a task worktree (keeps the branch — history stays mergeable).
async function removeTaskWorktree(projectPath, runId, taskId, { force = false } = {}) {
  if (!RUN_ID_RE.test(runId || '')) return { ok: false, error: 'invalid runId' };
  if (!TASK_ID_RE.test(taskId || '')) return { ok: false, error: 'invalid taskId' };
  const wtPath = taskWorktreePath(projectPath, runId, taskId);
  if (!fs.existsSync(wtPath)) return { ok: true, removed: false };
  const args = ['worktree', 'remove'];
  if (force) args.push('--force');
  args.push(wtPath);
  const r = await git(projectPath, args);
  if (!r.ok) return { ok: false, error: `git worktree remove failed: ${r.error}` };
  return { ok: true, removed: true };
}

async function listWorktrees(projectPath) {
  const r = await git(projectPath, ['worktree', 'list', '--porcelain']);
  if (!r.ok) return [];
  const out = [];
  let current = null;
  for (const line of r.stdout.split('\n')) {
    if (line.startsWith('worktree ')) {
      if (current) out.push(current);
      current = { path: line.slice('worktree '.length).trim() };
    } else if (line.startsWith('branch ') && current) {
      current.branch = line.slice('branch '.length).replace(/^refs\/heads\//, '').trim();
    } else if (line.startsWith('HEAD ') && current) {
      current.head = line.slice('HEAD '.length).trim();
    }
  }
  if (current) out.push(current);
  return out;
}

module.exports = {
  git,
  isGitRepo,
  isValidBranch,
  branchExists,
  ensureIntegrationBranch,
  ensureIntegrationWorktree,
  ensureTaskWorktree,
  removeTaskWorktree,
  listWorktrees,
  taskWorktreePath,
  taskBranchName,
};
