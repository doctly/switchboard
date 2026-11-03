// git.js — the few git commands Switchboard runs itself, for project worktrees.
//
// Every call goes through execFile with an argv array and no shell, so a path
// or branch name can never be read as shell syntax. Errors carry git's stderr
// as their message. Nothing here is used unless a project attaches a folder
// "on a branch", opens the Git tab, or manages worktrees in the Worktrees tab.

const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

const MAX_BUFFER = 4 * 1024 * 1024;

// Every git call: never hang on a credential prompt, never take the index
// lock just to refresh stat data (a status here must not collide with the
// user's own git add), and messages in English, since some errors are
// recognised by their text.
function gitEnv() {
  return { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' };
}
const MAX_DIFF_LENGTH = 256 * 1024;
const MAX_UNTRACKED_STAT_BYTES = 2 * 1024 * 1024;

function run(args, cwd) {
  return new Promise((resolve, reject) => {
    execFile('git', args, {
      cwd,
      maxBuffer: MAX_BUFFER,
      env: gitEnv(),
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
      env: gitEnv(),
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

/** Run git and keep both streams: a few commands report on stderr even when they succeed. */
function runCapture(args, cwd) {
  return new Promise((resolve, reject) => {
    execFile('git', args, {
      cwd,
      maxBuffer: MAX_BUFFER,
      env: gitEnv(),
    }, (err, stdout, stderr) => {
      if (err) {
        const error = new Error(String(stderr || err.message).trim() || `git ${args[0]} failed`);
        error.code = err.code;
        error.stderr = String(stderr || '');
        reject(error);
        return;
      }
      resolve({ stdout: String(stdout), stderr: String(stderr) });
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

/**
 * Check the branch out at targetPath, creating the branch from HEAD if needed.
 *
 * Options, all optional, for the Worktrees tab:
 * - startPoint: the commit a new branch (or a detached checkout) starts from;
 * - createBranch: true or false to skip the "does the branch exist" check;
 * - track: the new branch tracks startPoint (a remote branch). Without it a new
 *   branch made from a start point does not track it, so a feature branch cut
 *   from origin/main does not push to main;
 * - detach: check startPoint out with no branch at all.
 */
async function worktreeAdd(repo, targetPath, branch, options = {}) {
  const { startPoint = '', createBranch, track = false, detach = false } = options;
  refuseOptionLike(startPoint, 'Start point');
  if (detach) {
    await run(['worktree', 'add', '--detach', targetPath, startPoint || 'HEAD'], repo);
    return;
  }
  refuseOptionLike(branch, 'Branch');
  const create = typeof createBranch === 'boolean' ? createBranch : !(await branchExists(repo, branch));
  if (!create) {
    await run(['worktree', 'add', targetPath, branch], repo);
    return;
  }
  const args = ['worktree', 'add'];
  if (track) args.push('--track');
  else if (startPoint) args.push('--no-track');
  args.push('-b', branch, targetPath);
  if (startPoint) args.push(startPoint);
  await run(args, repo);
}

// A value that git would read as an option instead of a name.
function refuseOptionLike(value, label) {
  if (typeof value === 'string' && value.startsWith('-')) throw new Error(`${label} cannot start with "-"`);
}

/**
 * Remove a worktree. Refuses a dirty one unless force; the branch always stays.
 * prune: false keeps the records of other worktrees whose folder is missing
 * (moved by hand, on a drive that is not mounted) instead of dropping them too.
 */
async function worktreeRemove(repo, targetPath, { force = false, prune = true } = {}) {
  const args = ['worktree', 'remove'];
  if (force) args.push('--force');
  args.push(targetPath);
  await run(args, repo);
  if (prune) try { await run(['worktree', 'prune'], repo); } catch {}
}

/** True when git refused to remove a worktree because it has local changes. */
function isDirtyWorktreeError(err) {
  return /modified or untracked|use --force|uncommitted|contains modified/i.test(String(err?.message || ''));
}

/**
 * Parse `git worktree list --porcelain -z`: one record per worktree, the
 * fields NUL-terminated and the records separated by an empty field. The first
 * record is always the main worktree (or the bare repository).
 */
function parseWorktreeList(output) {
  const worktrees = [];
  let current = null;
  for (const field of String(output || '').split('\0')) {
    if (!field) {
      if (current) worktrees.push(current);
      current = null;
      continue;
    }
    const space = field.indexOf(' ');
    const key = space === -1 ? field : field.slice(0, space);
    const value = space === -1 ? '' : field.slice(space + 1);
    if (key === 'worktree') {
      if (current) worktrees.push(current);
      current = {
        path: value, head: '', branch: '', detached: false, bare: false,
        locked: false, lockReason: '', prunable: false, prunableReason: '',
      };
      continue;
    }
    if (!current) continue;
    if (key === 'HEAD') current.head = value;
    else if (key === 'branch') current.branch = value.replace(/^refs\/heads\//, '');
    else if (key === 'detached') current.detached = true;
    else if (key === 'bare') current.bare = true;
    else if (key === 'locked') { current.locked = true; current.lockReason = value; }
    else if (key === 'prunable') { current.prunable = true; current.prunableReason = value; }
  }
  if (current) worktrees.push(current);
  worktrees.forEach((worktree, index) => { worktree.isMain = index === 0; });
  return worktrees;
}

/** Every worktree of the repository that contains dir, main worktree first. */
async function worktreeList(dir) {
  let output;
  try {
    output = await runRaw(['worktree', 'list', '--porcelain', '-z'], dir);
  } catch (err) {
    // -z arrived in git 2.36; older versions answer with their usage text.
    if (/unknown switch|usage: git worktree/i.test(err.message)) {
      throw new Error('Listing worktrees needs git 2.36 or newer');
    }
    throw err;
  }
  return parseWorktreeList(output).map(worktree => ({ ...worktree, path: path.resolve(worktree.path) }));
}

async function worktreeLock(repo, targetPath, reason = '') {
  const args = ['worktree', 'lock'];
  if (reason) args.push('--reason', String(reason));
  args.push(targetPath);
  await run(args, repo);
}

async function worktreeUnlock(repo, targetPath) {
  await run(['worktree', 'unlock', targetPath], repo);
}

/** Move a worktree. Git refuses a locked one and the main worktree. */
async function worktreeMove(repo, fromPath, toPath, { force = false } = {}) {
  const args = ['worktree', 'move'];
  if (force) args.push('--force');
  args.push(fromPath, toPath);
  await run(args, repo);
}

/**
 * Drop the records of worktrees whose folder is gone. With dryRun nothing
 * changes. Returns what git reported: [{ name, reason }], where name is the
 * worktree's entry under .git/worktrees. Git writes that report to stderr.
 */
async function worktreePrune(repo, { dryRun = false } = {}) {
  const args = ['worktree', 'prune', '--verbose'];
  if (dryRun) args.push('--dry-run');
  const { stderr } = await runCapture(args, repo);
  return stderr.split('\n').map(line => line.match(/^Removing worktrees\/(.+?): (.*)$/))
    .filter(Boolean)
    .map(match => ({ name: match[1], reason: match[2].trim() }));
}

/** Fix the links between the repository and its worktrees, e.g. after a manual move. */
async function worktreeRepair(repo, paths = []) {
  const { stdout, stderr } = await runCapture(['worktree', 'repair', ...paths], repo);
  return [stdout, stderr].map(text => text.trim()).filter(Boolean).join('\n');
}

/** Delete a local branch. Without force git refuses one that is not merged. */
async function deleteBranch(repo, name, { force = false } = {}) {
  refuseOptionLike(name, 'Branch');
  await run(['branch', force ? '-D' : '-d', name], repo);
}

/** True when git refused to delete a branch because it is not merged. */
function isUnmergedBranchError(err) {
  return /not fully merged/i.test(String(err?.message || ''));
}

/** True when git accepts name as a new branch name. */
async function isValidBranchName(repo, name) {
  if (typeof name !== 'string' || !name || name.startsWith('-')) return false;
  try {
    await run(['check-ref-format', '--branch', name], repo);
    return true;
  } catch {
    return false;
  }
}

/**
 * Local and remote-tracking branches, for picking what a new worktree checks
 * out or starts from: { local: [{ name, head, upstream }], remote: [{ name, remote, head }] }.
 */
async function listBranches(repo) {
  const [output, remoteNames] = await Promise.all([
    runRaw([
      'for-each-ref', '--format=%(refname)%00%(objectname:short)%00%(upstream:short)%00%(symref)',
      'refs/heads', 'refs/remotes',
    ], repo),
    runOr(['remote'], repo, ''),
  ]);
  // A remote's name can hold a slash (team/fork), so match the longest one.
  const remotes = remoteNames.split('\n').map(name => name.trim()).filter(Boolean).sort((a, b) => b.length - a.length);
  const local = [];
  const remote = [];
  for (const line of output.split('\n')) {
    if (!line) continue;
    const [ref, head, upstream, symref] = line.split('\0');
    if (symref) continue; // origin/HEAD only points at another branch
    if (ref.startsWith('refs/heads/')) local.push({ name: ref.slice('refs/heads/'.length), head, upstream: upstream || '' });
    else if (ref.startsWith('refs/remotes/')) {
      const name = ref.slice('refs/remotes/'.length);
      remote.push({ name, remote: remotes.find(r => name.startsWith(r + '/')) || name.split('/')[0], head });
    }
  }
  return { local, remote };
}

/** Local branches whose tip is already contained in base. */
async function mergedBranches(repo, base) {
  refuseOptionLike(base, 'Base branch');
  const output = await run(['for-each-ref', '--format=%(refname:short)', '--merged', base, 'refs/heads'], repo);
  return output ? output.split('\n').filter(Boolean) : [];
}

/** The branch work is merged into: origin's default branch, else main or master. */
async function defaultBranch(repo) {
  try {
    const remoteHead = await run(['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'], repo);
    if (remoteHead) return remoteHead;
  } catch {}
  for (const name of ['main', 'master']) {
    if (await branchExists(repo, name)) return name;
  }
  return '';
}

/** { hash, time (ms), subject } of the commit checked out in dir, or null. */
async function lastCommit(dir) {
  try {
    const out = await run(['log', '-1', '--format=%H%x00%ct%x00%s'], dir);
    if (!out) return null;
    const [hash, seconds, subject] = out.split('\0');
    return { hash, time: Number(seconds) * 1000, subject: subject || '' };
  } catch {
    return null;
  }
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

// --- Git Graph read functions ---------------------------------------------
// Everything below is read-only. Every call adds --no-optional-locks (never
// contend with a write in flight elsewhere) and, for anything that formats
// human-readable output, --no-color/--no-show-signature, so a user's own
// color.ui=always can never leak into text this code goes on to parse.
// Multi-field records use NUL between fields and, for git-log output, \x1e
// between records, the same convention parseCommits() already uses above.

/** Normalize a path for use inside a git argv element (git wants '/' even on Windows). */
function toGitPath(relPath) {
  return String(relPath).split(path.sep).join('/').split('\\').join('/');
}

// Node's execFile refuses any argv string containing an actual NUL byte
// ("must be a string without null bytes") — so the *format strings* below
// use git's own textual escape for one (`%x00` for git-log's pretty-format
// engine, `%00` for for-each-ref's own, different, format language), and
// only the *parsed output* (which genuinely does contain raw NUL/RS bytes,
// written by git itself, safe for Node to read back) is split on the real
// characters.
const GG_FIELD_SEP = '\x00';
const GG_RECORD_SEP = '\x1e';
const LOG_FIELD_ESCAPE = '%x00';
const LOG_RECORD_ESCAPE = '%x1e';
const FOR_EACH_REF_FIELD_ESCAPE = '%00';

const LOG_ORDER_FLAGS = { date: '--date-order', 'author-date': '--author-date-order', topo: '--topo-order' };

// A revspec entry starting with '-' is only ever accepted from this fixed
// list (or one of the prefixes below) — anything else risks being read as
// a flag rather than a ref/branch-glob.
const REVSPEC_FLAGS = new Set(['--all', '--branches', '--tags', '--remotes', '--first-parent', '--reflog']);
const REVSPEC_FLAG_PREFIXES = ['--glob=', '--branches=', '--tags=', '--remotes=', '--exclude='];

function assertSafeRevspecEntry(entry) {
  if (typeof entry !== 'string' || !entry || entry.includes('\0')) throw new Error('Invalid revision specifier');
  if (!entry.startsWith('-')) return entry;
  if (REVSPEC_FLAGS.has(entry) || REVSPEC_FLAG_PREFIXES.some(prefix => entry.startsWith(prefix))) return entry;
  throw new Error(`Revision specifier '${entry}' is not on the allowed flag list`);
}

function logPrettyFormat() {
  return ['%H', '%h', '%P', '%an', '%ae', '%aI', '%cn', '%ce', '%cI', '%s'].join(LOG_FIELD_ESCAPE) + LOG_RECORD_ESCAPE;
}

function parseLogWithParents(output) {
  return String(output || '')
    .split(GG_RECORD_SEP)
    .map(record => record.replace(/^\n+|\n+$/g, ''))
    .filter(Boolean)
    .map((record) => {
      const [hash, shortHash, parentField, authorName, authorEmail, authorDate,
        committerName, committerEmail, commitDate, subject] = record.split(GG_FIELD_SEP);
      return {
        hash, shortHash,
        parents: parentField ? parentField.split(' ').filter(Boolean) : [],
        authorName, authorEmail, authorDate,
        committerName, committerEmail, commitDate,
        subject: subject || '',
      };
    });
}

/**
 * Commit list with parent hashes, for graph layout. `order` selects
 * `--date-order` (default) / `--author-date-order` / `--topo-order`.
 * `revspec` is a ref/hash or array of them (default `['HEAD']`); a leading
 * '-' entry must be on the fixed allow-list above. Degrades to `[]` on an
 * unborn HEAD rather than throwing.
 */
async function logWithParents(dir, { revspec, order = 'date', skip, limit } = {}) {
  const orderFlag = LOG_ORDER_FLAGS[order] || LOG_ORDER_FLAGS.date;
  const revArgs = [].concat(revspec == null ? ['HEAD'] : revspec).map(assertSafeRevspecEntry);
  const args = ['--no-optional-locks', 'log', '--no-color', '--no-show-signature', orderFlag];
  if (Number(skip) > 0) args.push(`--skip=${Math.floor(Number(skip))}`);
  if (Number(limit) > 0) args.push(`--max-count=${Math.floor(Number(limit))}`);
  args.push(`--pretty=format:${logPrettyFormat()}`, ...revArgs);
  return parseLogWithParents(await runOr(args, dir, ''));
}

const FOR_EACH_REF_FORMAT = ['%(HEAD)', '%(refname)', '%(objectname)', '%(*objectname)', '%(objecttype)', '%(upstream)'].join(FOR_EACH_REF_FIELD_ESCAPE);

/**
 * Local branches, remote-tracking branches, and tags, via `for-each-ref`.
 * Each head carries `isHead` (which head is HEAD — not the same as which
 * commit HEAD points at while detached). Degrades to empty arrays on a
 * repo with no refs at all rather than throwing.
 */
async function forEachRef(dir) {
  const output = await runOr(['--no-optional-locks', 'for-each-ref', '--no-color', `--format=${FOR_EACH_REF_FORMAT}`,
    'refs/heads', 'refs/remotes', 'refs/tags'], dir, '');
  const heads = [];
  const remotes = [];
  const tags = [];
  for (const line of String(output).split('\n')) {
    if (!line) continue;
    const [headMarker, refname, objectName, peeledObjectName, objectType, upstream] = line.split(GG_FIELD_SEP);
    if (refname.startsWith('refs/heads/')) {
      heads.push({
        name: refname.slice('refs/heads/'.length),
        hash: objectName,
        isHead: headMarker === '*',
        upstream: upstream ? upstream.replace(/^refs\/remotes\//, '') : null,
      });
    } else if (refname.startsWith('refs/remotes/')) {
      const rest = refname.slice('refs/remotes/'.length);
      const slash = rest.indexOf('/');
      if (slash === -1) continue;
      const name = rest.slice(slash + 1);
      if (name === 'HEAD') continue; // the remote's own default-branch pointer, not a real branch
      remotes.push({ remote: rest.slice(0, slash), name, hash: objectName });
    } else if (refname.startsWith('refs/tags/')) {
      const annotated = objectType === 'tag';
      tags.push({ name: refname.slice('refs/tags/'.length), hash: annotated ? (peeledObjectName || objectName) : objectName, annotated });
    }
  }
  return { heads, remotes, tags };
}

const STASH_FORMAT = ['%H', '%gd', '%gs', '%aI'].join(LOG_FIELD_ESCAPE);
const STASH_MESSAGE_BRANCH_RE = /^(?:WIP on|On) (.+):/;

/**
 * Stashes, each with `baseCommitHash` — the commit it was taken from,
 * resolved as `<stashHash>^1` (its own first parent) so a stash can be laid
 * into the graph as a pseudo-commit attached to that commit.
 */
async function stashList(dir) {
  const output = await runOr(['--no-optional-locks', 'stash', 'list', '--no-color', `--format=${STASH_FORMAT}`], dir, '');
  const entries = String(output).split('\n').filter(Boolean).map((line) => {
    const [hash, gd, message, date] = line.split(GG_FIELD_SEP);
    const indexMatch = /stash@\{(\d+)\}/.exec(gd || '');
    const branchMatch = STASH_MESSAGE_BRANCH_RE.exec(message || '');
    return { hash, index: indexMatch ? Number(indexMatch[1]) : null, branch: branchMatch ? branchMatch[1] : null, message: message || '', date };
  });
  const bases = await Promise.all(entries.map(entry => runOr(['--no-optional-locks', 'rev-parse', `${entry.hash}^1`], dir, '')));
  return entries.map((entry, i) => ({ ...entry, baseCommitHash: bases[i].trim() || null }));
}

/**
 * File content at a revision (a blob, via `git show <rev>:<path>`), for the
 * diff viewer. `--no-textconv` so a repo's own .gitattributes filter can't
 * substitute different bytes than what's actually stored. `relPath` goes
 * through the same containment check as fileDiff(), then is normalized to
 * '/'-separated (git's pathspec syntax wants that even on Windows).
 */
async function blobAtRevision(dir, rev, relPath) {
  if (typeof rev !== 'string' || !rev || rev.includes('\0') || rev.startsWith('-')) throw new Error('Invalid revision');
  const { relative } = safeRelativePath(dir, relPath);
  return runRaw(['--no-optional-locks', 'show', '--no-color', '--no-textconv', `${rev}:${toGitPath(relative)}`], dir);
}

module.exports = {
  run, version, isGitRepo, repoRoot, branchExists,
  parseWorktreeList, worktreeList, worktreeLock, worktreeUnlock, worktreeMove, worktreePrune, worktreeRepair,
  deleteBranch, isUnmergedBranchError, isValidBranchName, listBranches, mergedBranches, defaultBranch, lastCommit,
  worktreeAdd, worktreeRemove, isDirtyWorktreeError, gitCommonDir, status,
  parsePorcelain, snapshot, fileDiff,
  toGitPath, safeRelativePath,
  logWithParents, forEachRef, stashList, blobAtRevision,
};
