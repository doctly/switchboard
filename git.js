// git.js — the few git commands Switchboard runs itself, for project worktrees.
//
// Every call goes through execFile with an argv array and no shell, so a path
// or branch name can never be read as shell syntax. Errors carry git's stderr
// as their message. Nothing here is used unless a project attaches a folder
// "on a branch".

const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

const MAX_BUFFER = 4 * 1024 * 1024;
const MAX_DIFF_LENGTH = 256 * 1024;
const MAX_UNTRACKED_STAT_BYTES = 2 * 1024 * 1024;

function run(args, cwd) {
  return new Promise((resolve, reject) => {
    execFile('git', args, {
      cwd,
      maxBuffer: MAX_BUFFER,
      // Never hang on a credential prompt; a worktree add has no reason to ask.
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    }, (err, stdout, stderr) => {
      if (err) {
        const error = new Error(String(stderr || err.message).trim() || `git ${args[0]} failed`);
        error.code = err.code;
        error.stderr = String(stderr || '');
        reject(error);
        return;
      }
      resolve(String(stdout).trim());
    });
  });
}

/** Run git without trimming its output. Some machine-readable formats use NULs. */
function runRaw(args, cwd, { allowExitCodes = [] } = {}) {
  return new Promise((resolve, reject) => {
    execFile('git', args, {
      cwd,
      maxBuffer: MAX_BUFFER,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    }, (err, stdout, stderr) => {
      if (!err || allowExitCodes.includes(err.code)) {
        resolve(String(stdout));
        return;
      }
      const error = new Error(String(stderr || err.message).trim() || `git ${args[0]} failed`);
      error.code = err.code;
      error.stderr = String(stderr || '');
      error.stdout = String(stdout || '');
      reject(error);
    });
  });
}

async function runOr(args, cwd, fallback = '') {
  try { return await runRaw(args, cwd); } catch { return fallback; }
}

async function version() {
  try { return await run(['--version']); } catch { return null; }
}

async function isGitRepo(dir) {
  try { return (await run(['rev-parse', '--is-inside-work-tree'], dir)) === 'true'; } catch { return false; }
}

/** Top-level directory of the checkout that contains dir. Rejects outside a repo. */
async function repoRoot(dir) {
  return run(['rev-parse', '--show-toplevel'], dir);
}

async function branchExists(repo, name) {
  try {
    await run(['rev-parse', '--verify', '--quiet', `refs/heads/${name}`], repo);
    return true;
  } catch {
    return false;
  }
}

/** Check the branch out at targetPath, creating the branch from HEAD if needed. */
async function worktreeAdd(repo, targetPath, branch) {
  if (await branchExists(repo, branch)) {
    await run(['worktree', 'add', targetPath, branch], repo);
  } else {
    await run(['worktree', 'add', '-b', branch, targetPath], repo);
  }
}

/** Remove a worktree. Refuses a dirty one unless force; the branch always stays. */
async function worktreeRemove(repo, targetPath, { force = false } = {}) {
  const args = ['worktree', 'remove'];
  if (force) args.push('--force');
  args.push(targetPath);
  await run(args, repo);
  try { await run(['worktree', 'prune'], repo); } catch {}
}

/** True when git refused to remove a worktree because it has local changes. */
function isDirtyWorktreeError(err) {
  return /modified or untracked|use --force|uncommitted|contains modified/i.test(String(err?.message || ''));
}

/** The repository's shared .git directory, absolute, from any of its worktrees. */
async function gitCommonDir(dir) {
  const out = await run(['rev-parse', '--git-common-dir'], dir);
  return path.resolve(dir, out);
}

/** Branch, whether anything is modified or untracked, and ahead/behind upstream. */
async function status(dir) {
  const branch = await run(['rev-parse', '--abbrev-ref', 'HEAD'], dir);
  const porcelain = await run(['status', '--porcelain'], dir);
  let ahead = null;
  let behind = null;
  try {
    const counts = await run(['rev-list', '--left-right', '--count', '@{upstream}...HEAD'], dir);
    const [b, a] = counts.split(/\s+/).map(Number);
    if (Number.isFinite(a) && Number.isFinite(b)) { ahead = a; behind = b; }
  } catch {}
  return { branch, dirty: porcelain.length > 0, ahead, behind };
}

const CONFLICT_CODES = new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU']);

/** Parse `git status --porcelain=v1 -z` without losing unusual filenames. */
function parsePorcelain(output) {
  const records = String(output || '').split('\0');
  const changes = [];
  for (let i = 0; i < records.length; i += 1) {
    const record = records[i];
    if (!record || record.length < 3) continue;
    const code = record.slice(0, 2);
    const indexStatus = code[0];
    const worktreeStatus = code[1];
    const filePath = record.slice(3);
    let oldPath = null;
    // With -z, a rename/copy is the destination followed by a second,
    // NUL-terminated source pathname.
    if (/[RC]/.test(code) && i + 1 < records.length) oldPath = records[++i] || null;

    let statusName = 'modified';
    if (CONFLICT_CODES.has(code)) statusName = 'conflicted';
    else if (code === '??') statusName = 'untracked';
    else if (/[RC]/.test(code)) statusName = 'renamed';
    else if (code.includes('D')) statusName = 'deleted';
    else if (code.includes('A')) statusName = 'added';

    changes.push({
      path: filePath,
      oldPath,
      code,
      status: statusName,
      indexStatus,
      worktreeStatus,
      staged: indexStatus !== ' ' && indexStatus !== '?',
    });
  }
  return changes;
}

function parseShortStat(output) {
  const text = String(output || '');
  const insertions = Number(text.match(/(\d+) insertion/)?.[1] || 0);
  const deletions = Number(text.match(/(\d+) deletion/)?.[1] || 0);
  return { insertions, deletions };
}

function countUntrackedInsertions(dir, changes) {
  let insertions = 0;
  for (const change of changes) {
    if (change.status !== 'untracked') continue;
    const absolute = path.resolve(dir, change.path);
    const relative = path.relative(dir, absolute);
    if (relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) continue;
    try {
      const stat = fs.statSync(absolute);
      if (!stat.isFile() || stat.size > MAX_UNTRACKED_STAT_BYTES) continue;
      const content = fs.readFileSync(absolute);
      if (content.includes(0)) continue;
      if (content.length) insertions += content.toString('utf8').split('\n').length - (content.at(-1) === 10 ? 1 : 0);
    } catch {}
  }
  return insertions;
}

function parseCommits(output) {
  return String(output || '')
    .split('\x1e')
    .map(record => record.replace(/^\n+|\n+$/g, ''))
    .filter(Boolean)
    .map((record) => {
      const [hash, shortHash, author, date, subject] = record.split('\0');
      return { hash, shortHash, author, date, subject };
    });
}

function gitOperation(gitDir) {
  const exists = (name) => fs.existsSync(path.join(gitDir, name));
  if (exists('rebase-merge') || exists('rebase-apply')) return 'rebase';
  if (exists('MERGE_HEAD')) return 'merge';
  if (exists('CHERRY_PICK_HEAD')) return 'cherry-pick';
  if (exists('REVERT_HEAD')) return 'revert';
  if (exists('BISECT_LOG')) return 'bisect';
  return null;
}

/** Read-only state used by the project Git tab. */
async function snapshot(dir, { commitLimit = 20 } = {}) {
  if (!await isGitRepo(dir)) return { git: false };

  const [branchName, head, porcelain, counts, logOutput, statOutput, gitDirOutput] = await Promise.all([
    runOr(['rev-parse', '--abbrev-ref', 'HEAD'], dir),
    runOr(['rev-parse', '--short', 'HEAD'], dir),
    runRaw(['status', '--porcelain=v1', '-z', '--untracked-files=all'], dir),
    runOr(['rev-list', '--left-right', '--count', '@{upstream}...HEAD'], dir, ''),
    runOr(['log', `-${Math.max(1, Math.min(100, Number(commitLimit) || 20))}`, '--date=iso-strict', '--pretty=format:%H%x00%h%x00%an%x00%aI%x00%s%x1e'], dir, ''),
    runOr(['diff', '--shortstat', 'HEAD', '--'], dir, ''),
    runOr(['rev-parse', '--git-dir'], dir, ''),
  ]);

  const changes = parsePorcelain(porcelain);
  const [behindRaw, aheadRaw] = counts.trim().split(/\s+/);
  const ahead = counts ? Number(aheadRaw) : null;
  const behind = counts ? Number(behindRaw) : null;
  const stats = parseShortStat(statOutput);
  stats.insertions += countUntrackedInsertions(dir, changes);
  const gitDir = gitDirOutput ? path.resolve(dir, gitDirOutput.trim()) : null;
  const detached = branchName.trim() === 'HEAD';

  return {
    git: true,
    branch: detached ? '' : branchName.trim(),
    detached,
    head: head.trim(),
    dirty: changes.length > 0,
    ahead: Number.isFinite(ahead) ? ahead : null,
    behind: Number.isFinite(behind) ? behind : null,
    operation: gitDir ? gitOperation(gitDir) : null,
    changes,
    stats,
    commits: parseCommits(logOutput),
  };
}

function safeRelativePath(dir, filePath) {
  if (typeof filePath !== 'string' || !filePath) throw new Error('File path is required');
  const absolute = path.resolve(dir, filePath);
  const relative = path.relative(dir, absolute);
  if (!relative || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
    throw new Error('File is outside the repository');
  }
  return { absolute, relative };
}

/** Return a read-only unified diff for one currently changed file. */
async function fileDiff(dir, filePath) {
  const { absolute, relative } = safeRelativePath(dir, filePath);
  const changes = parsePorcelain(await runRaw(['status', '--porcelain=v1', '-z', '--untracked-files=all'], dir));
  const change = changes.find(item => item.path === relative || item.path === filePath);
  if (!change) throw new Error('File is not currently changed');

  let diff = '';
  if (change.status === 'untracked') {
    const nullPath = process.platform === 'win32' ? 'NUL' : '/dev/null';
    diff = await runRaw(['diff', '--no-index', '--no-ext-diff', '--unified=3', '--', nullPath, absolute], dir, { allowExitCodes: [1] });
  } else {
    try {
      diff = await runRaw(['diff', '--no-ext-diff', '--unified=3', 'HEAD', '--', relative], dir);
    } catch {
      const [staged, unstaged] = await Promise.all([
        runOr(['diff', '--cached', '--no-ext-diff', '--unified=3', '--', relative], dir, ''),
        runOr(['diff', '--no-ext-diff', '--unified=3', '--', relative], dir, ''),
      ]);
      diff = [staged, unstaged].filter(Boolean).join('\n');
    }
  }

  const truncated = diff.length > MAX_DIFF_LENGTH;
  if (truncated) diff = diff.slice(0, MAX_DIFF_LENGTH) + '\n\n… diff truncated by Switchboard …\n';
  return { path: relative, diff, truncated };
}

module.exports = {
  run, version, isGitRepo, repoRoot, branchExists,
  worktreeAdd, worktreeRemove, isDirtyWorktreeError, gitCommonDir, status,
  parsePorcelain, snapshot, fileDiff,
};
