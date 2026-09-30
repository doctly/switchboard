// git-graph-service.js — assembles Git Graph tab payloads (paging, stashes,
// uncommitted changes), commit/comparison detail, file-at-revision and
// diff-between-revisions, and a debounced watcher on the repo's common git
// dir. Read-only: mutating actions live in a later PR.
//
// This module is a singleton initialised with init(ctx), the same shape as
// projects.js/session-cache.js, so tests can hand it a fake db/git without
// touching the real ones. `git.js` is the only thing this file shells out
// through; it never runs a git subprocess itself.
//
// Boundary note: this module does not check whether folderPath is attached
// to a project — that check happens one layer up, in projects.js, exactly
// like it already does for projectGitDiff.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const EMPTY_TREE_HASH = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'; // git's well-known empty-tree constant
const REFS_WALK_MAX_ENTRIES = 20_000;

// Timing knobs, overridable via init(ctx) so tests can run in milliseconds
// instead of real minutes without touching the mechanism under test.
let REPO_WATCH_POLL_MS = 1500;
let REPO_WATCH_DEBOUNCE_MS = 300;
let REPO_WATCH_IDLE_SWEEP_MS = 5 * 60 * 1000;
let REPO_WATCH_IDLE_MAX_MS = 15 * 60 * 1000;

let db, log, send, git;

/** Wire dependencies. Mirrors projects.js's init(ctx) so tests can inject fakes. */
function init(ctx = {}) {
  db = ctx.db || null;
  log = ctx.log || console;
  send = typeof ctx.send === 'function' ? ctx.send : (() => {});
  git = ctx.git || require('./git');
  if (ctx.repoWatchPollMs) REPO_WATCH_POLL_MS = ctx.repoWatchPollMs;
  if (ctx.repoWatchDebounceMs) REPO_WATCH_DEBOUNCE_MS = ctx.repoWatchDebounceMs;
  if (ctx.repoWatchIdleSweepMs) REPO_WATCH_IDLE_SWEEP_MS = ctx.repoWatchIdleSweepMs;
  if (ctx.repoWatchIdleMaxMs) REPO_WATCH_IDLE_MAX_MS = ctx.repoWatchIdleMaxMs;
}

// --- Positional-argument validation for the read endpoints below ---

const HASH_RE = /^[0-9a-f]{4,40}$/i;
const REF_BASELINE_INVALID_RE = /[\x00-\x1f\x7f]|\.\.|@\{|(^\/)|(\/$)|(\.lock$)/;

function assertSafePositionalArg(value, kind) {
  const label = kind || 'value';
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${label}: a value is required`);
  if (value.includes('\0')) throw new Error(`${label}: must not contain a NUL byte`);
  if (value.startsWith('-')) throw new Error(`${label}: must not start with '-'`);
  if (kind === 'hash') {
    if (!HASH_RE.test(value)) throw new Error(`${label}: '${value}' is not a valid commit hash`);
  } else if (REF_BASELINE_INVALID_RE.test(value)) {
    throw new Error(`${label}: '${value}' is not a valid reference name`);
  }
  return value;
}

function assertRev(value, label = 'revision') {
  return assertSafePositionalArg(value, label);
}

function assertHash(value, label = 'hash') {
  return assertSafePositionalArg(value, 'hash');
}

/** Path-traversal containment for a repo-relative file path touching the real worktree. */
function safeRelative(dir, relPath, label = 'path') {
  if (typeof relPath !== 'string' || !relPath) throw new Error(`${label} is required`);
  const normalized = relPath.replace(/\\/g, '/');
  const absolute = path.resolve(dir, normalized);
  const relative = path.relative(dir, absolute);
  if (!relative || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
    throw new Error(`${label} is outside the repository`);
  }
  return { absolute, relative: relative.split(path.sep).join('/') };
}

function buildRevspec(opts = {}) {
  const args = [];
  const { branches, tags } = opts;
  const allBranches = !Array.isArray(branches);
  // An explicit branch list restricts the graph to those branches (plus any
  // explicitly picked tags); remote branches and all tags only join when every
  // branch is selected, or all tags when no branch is.
  if (allBranches) {
    args.push('--branches');
    if (opts.showRemote) args.push('--remotes');
  } else {
    for (const name of branches) args.push(assertRev(name, 'branch'));
  }
  if (Array.isArray(tags)) {
    for (const name of tags) args.push(`refs/tags/${assertRev(name, 'tag')}`);
  } else if ((allBranches || !branches.length) && opts.showTags !== false) {
    args.push('--tags');
  }
  // Nothing selected: git would fall back to HEAD, so report no revisions instead.
  if (!args.length) return null;
  return args;
}

// --- Uncommitted changes (built from git.js's already-exported primitives —
// no new frozen git.js function needed for this) ---

const UNTRACKED_STAT_MAX_BYTES = 2 * 1024 * 1024;

function countFileLines(absolutePath) {
  try {
    const stat = fs.statSync(absolutePath);
    if (!stat.isFile() || stat.size > UNTRACKED_STAT_MAX_BYTES) return 0;
    const content = fs.readFileSync(absolutePath);
    if (content.includes(0)) return 0; // binary
    if (!content.length) return 0;
    return content.toString('utf8').split('\n').length - (content.at(-1) === 10 ? 1 : 0);
  } catch { return 0; }
}

function parseNumstat(output) {
  const byPath = new Map();
  for (const line of String(output || '').split('\n')) {
    if (!line) continue;
    const [ins, del, ...rest] = line.split('\t');
    const filePath = rest.join('\t');
    if (!filePath) continue;
    const arrow = filePath.split(' => ');
    const finalPath = arrow.length > 1 ? arrow[1].replace(/[{}]/g, '').trim() : filePath;
    byPath.set(finalPath, {
      insertions: ins === '-' ? 0 : Number(ins) || 0,
      deletions: del === '-' ? 0 : Number(del) || 0,
    });
  }
  return byPath;
}

async function buildUncommitted(dir) {
  const raw = await git.run(['-c', 'core.quotepath=false', '--no-optional-locks', 'status', '--porcelain=v1', '-z', '--untracked-files=all'], dir);
  const changes = git.parsePorcelain(raw);
  if (!changes.length) return null;

  let numstat = new Map();
  try {
    const out = await git.run(['-c', 'core.quotepath=false', '--no-optional-locks', 'diff', '--no-color', '--no-ext-diff', '--no-textconv', '--numstat', 'HEAD'], dir);
    numstat = parseNumstat(out);
  } catch { /* unborn HEAD or nothing staged against HEAD yet */ }

  const files = changes.map((change) => {
    const stat = numstat.get(change.path) || null;
    let insertions = stat ? stat.insertions : 0;
    const deletions = stat ? stat.deletions : 0;
    if (change.status === 'untracked' && !stat) {
      insertions = countFileLines(path.resolve(dir, change.path));
    }
    return {
      path: change.path,
      oldPath: change.oldPath,
      status: change.status,
      insertions,
      deletions,
    };
  });

  return { changeCount: files.length, changes: files };
}

// --- Read endpoints ---

/** Current HEAD commit hash, or null on an unborn HEAD. Works whether HEAD is attached or detached. */
async function currentHeadHash(dir) {
  try { return await git.run(['--no-optional-locks', 'rev-parse', 'HEAD'], dir); } catch { return null; }
}

/** getProjectGitGraph — assembles commits+refs+stashes+uncommitted, paged. */
async function getProjectGitGraph(dir, opts = {}) {
  const limit = Math.max(1, Math.min(5000, Number(opts.limit) || 300));
  const skip = Math.max(0, Number(opts.skip) || 0);
  const order = opts.order === 'author-date' || opts.order === 'topo' ? opts.order : 'date';

  const revspec = buildRevspec(opts);
  const [raw, headHash] = await Promise.all([
    revspec ? git.logWithParents(dir, { revspec, order, skip, limit: limit + 1 }) : [],
    currentHeadHash(dir),
  ]);
  const hasMore = raw.length > limit;
  const commits = raw.slice(0, limit);

  let refs = null;
  if (!opts.refsUnchanged) {
    refs = await git.forEachRef(dir);
    // showTags only gated the log traversal above (whether a tag-only commit
    // is reachable at all); the ref set itself always comes back with every
    // tag, so "Show Tags" off must also strip them here or every tag pill
    // stays visible regardless of the toggle.
    if (opts.showTags === false) refs.tags = [];
    applyRefsToCommits(commits, refs, headHash);
  } else {
    markHead(commits, headHash);
  }

  let stashes = [];
  if (opts.showStashes !== false) {
    try { stashes = await git.stashList(dir); } catch (err) { log.info?.('[git-graph] stashList failed', err.message); }
  }

  let uncommitted = null;
  if (opts.showUncommittedChanges !== false) {
    try { uncommitted = await buildUncommitted(dir); } catch (err) { log.info?.('[git-graph] uncommitted diff failed', err.message); }
  }

  // `commits` here is real commits only — the renderer merges in the
  // stash/uncommitted pseudo-commits itself (gitGraphBuildLayoutInput),
  // since its own paging already knows which base commits are loaded.
  return { ok: true, commits, refs, stashes, uncommitted, hasMore };
}

function markHead(commits, headHash) {
  if (!headHash) return;
  const c = commits.find(item => item.hash === headHash);
  if (c) c.isHead = true;
}

// forEachRef (git.js) reports `isHead` per local-branch entry, but that
// only tells us *which branch* is checked out, not the commit HEAD actually
// points at while detached — so commit-level isHead is always derived from
// the separately rev-parsed headHash, never from refs.heads[].isHead.
function applyRefsToCommits(commits, refs, headHash) {
  if (!refs) return;
  const byHash = new Map(commits.map(c => [c.hash, c]));
  for (const head of refs.heads || []) {
    const c = byHash.get(head.hash);
    if (c) {
      c.refs = c.refs || { heads: [], remotes: [], tags: [] };
      c.refs.heads.push(head.name);
    }
  }
  for (const remote of refs.remotes || []) {
    const c = byHash.get(remote.hash);
    if (c) {
      c.refs = c.refs || { heads: [], remotes: [], tags: [] };
      c.refs.remotes.push({ remote: remote.remote, name: remote.name });
    }
  }
  for (const tag of refs.tags || []) {
    const c = byHash.get(tag.hash);
    if (c) {
      c.refs = c.refs || { heads: [], remotes: [], tags: [] };
      c.refs.tags.push(tag.name);
    }
  }
  markHead(commits, headHash);
}

async function diffNameStatusAndStat(dir, fromRev, toRevOrNull) {
  assertRev(fromRev, 'fromRev');
  const uncommitted = toRevOrNull === null || toRevOrNull === '#uncommitted' || toRevOrNull === undefined;
  const toArgs = uncommitted ? [] : [assertRev(toRevOrNull, 'toRev')];

  // `git diff` never reports a file it has no tracked blob for on either
  // side, so a plain diff against the working tree always omits untracked
  // files — listed here separately and merged in below, the same way
  // buildUncommitted() already does for the Uncommitted Changes row's own
  // file count.
  const [nameStatusRaw, numstatRaw, untrackedRaw] = await Promise.all([
    git.run(['-c', 'core.quotepath=false', '--no-optional-locks', 'diff', '--no-color', '--no-ext-diff', '--no-textconv', '-M', '--name-status', '-z', fromRev, ...toArgs], dir),
    git.run(['-c', 'core.quotepath=false', '--no-optional-locks', 'diff', '--no-color', '--no-ext-diff', '--no-textconv', '-M', '--numstat', '-z', fromRev, ...toArgs], dir),
    uncommitted
      ? git.run(['-c', 'core.quotepath=false', '--no-optional-locks', 'ls-files', '--others', '--exclude-standard', '-z'], dir)
      : Promise.resolve(''),
  ]);

  const statusByPath = new Map();
  const nsFields = nameStatusRaw.split('\0').filter(Boolean);
  for (let i = 0; i < nsFields.length; i += 1) {
    const code = nsFields[i];
    if (!/^[AMDRCU]/.test(code)) continue;
    let filePath = nsFields[++i];
    let oldPath = null;
    if (/^[RC]/.test(code)) { oldPath = filePath; filePath = nsFields[++i]; }
    const kind = code[0] === 'A' ? 'added' : code[0] === 'D' ? 'deleted'
      : code[0] === 'R' ? 'renamed' : code[0] === 'C' ? 'renamed'
      : code[0] === 'U' ? 'conflicted' : 'modified';
    statusByPath.set(filePath, { path: filePath, oldPath, status: kind, insertions: 0, deletions: 0 });
  }

  const nsNum = numstatRaw.split('\0').filter(Boolean);
  for (let i = 0; i < nsNum.length; i += 1) {
    const insRaw = nsNum[i];
    const parts = insRaw.split('\t');
    let ins = parts[0], del = parts[1], filePath = parts[2];
    if (filePath === undefined) { filePath = nsNum[++i]; }
    let oldPath = null;
    if (filePath === '' || filePath === undefined) { oldPath = nsNum[++i]; filePath = nsNum[++i]; }
    const entry = statusByPath.get(filePath) || statusByPath.get(oldPath);
    if (entry) {
      entry.insertions = ins === '-' ? 0 : Number(ins) || 0;
      entry.deletions = del === '-' ? 0 : Number(del) || 0;
    }
  }

  if (uncommitted) {
    for (const filePath of untrackedRaw.split('\0').filter(Boolean)) {
      if (statusByPath.has(filePath)) continue;
      statusByPath.set(filePath, {
        path: filePath, oldPath: null, status: 'untracked',
        insertions: countFileLines(path.resolve(dir, filePath)), deletions: 0,
      });
    }
  }

  return [...statusByPath.values()];
}

async function getGitGraphCommitDetail(dir, hash) {
  assertHash(hash, 'hash');
  const fields = ['%H', '%h', '%P', '%an', '%ae', '%aI', '%cn', '%ce', '%cI', '%s'].join('%x00');
  const raw = await git.run(['--no-optional-locks', 'log', '-1', '--no-color', '--no-show-signature', `--pretty=format:${fields}%x00%b`, hash], dir);
  const parts = raw.split('\0');
  const [rawHash, shortHash, parentsRaw, authorName, authorEmail, authorDate, committerName, committerEmail, commitDate, subject] = parts;
  const body = parts.slice(10).join('\0');
  const parents = parentsRaw ? parentsRaw.split(' ').filter(Boolean) : [];
  const fromRev = parents[0] || EMPTY_TREE_HASH;
  const files = await diffNameStatusAndStat(dir, fromRev, rawHash);
  return {
    ok: true,
    commit: {
      hash: rawHash, shortHash, parents,
      authorName, authorEmail, authorDate,
      committerName, committerEmail, commitDate,
      subject, body,
      isHead: false,
      refs: { heads: [], remotes: [], tags: [] },
    },
    files,
  };
}

async function getGitGraphCompareDetail(dir, fromHash, toHash) {
  assertHash(fromHash, 'fromHash');
  if (toHash !== null && toHash !== undefined) assertHash(toHash, 'toHash');
  const files = await diffNameStatusAndStat(dir, fromHash, toHash ?? null);
  return { ok: true, files };
}

async function getGitGraphFileAtRevision(dir, rev, relPath) {
  assertRev(rev, 'rev');
  const { relative } = safeRelative(dir, relPath, 'path');
  const content = await git.blobAtRevision(dir, rev, relative);
  return { ok: true, content };
}

async function getGitGraphFileDiffBetween(dir, fromRev, toRevOrNull, relPath) {
  assertRev(fromRev, 'fromRev');
  const { relative, absolute } = safeRelative(dir, relPath, 'path');
  let oldContent = '';
  try { oldContent = await git.blobAtRevision(dir, fromRev, relative); } catch { oldContent = ''; }

  let newContent = '';
  if (toRevOrNull === null || toRevOrNull === undefined) {
    try { newContent = fs.readFileSync(absolute, 'utf8'); } catch { newContent = ''; }
  } else {
    assertRev(toRevOrNull, 'toRev');
    try { newContent = await git.blobAtRevision(dir, toRevOrNull, relative); } catch { newContent = ''; }
  }
  return { ok: true, oldContent, newContent };
}

// --- Repo-change watcher: polls the common git dir's HEAD/packed-refs/index
// mtimes plus a walk of refs/ for per-ref mtimes, debounced, and sends
// 'git-graph-repo-changed' on any change. Deliberately not relying on
// fs.watch's inconsistent recursive support. ---

const watches = new Map(); // folderPath -> { commonDir, fingerprint, timer, debounceTimer, lastAccess, primed }
let idleSweepTimer = null;

function statMtime(file) {
  try { return fs.statSync(file).mtimeMs; } catch { return 0; }
}

function computeFingerprint(commonDir) {
  const parts = [statMtime(path.join(commonDir, 'HEAD')), statMtime(path.join(commonDir, 'packed-refs')), statMtime(path.join(commonDir, 'index'))];
  const refsRoot = path.join(commonDir, 'refs');
  let count = 0;
  const stack = [refsRoot];
  while (stack.length && count < REFS_WALK_MAX_ENTRIES) {
    const current = stack.pop();
    let entries;
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (count >= REFS_WALK_MAX_ENTRIES) break;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) { stack.push(full); continue; }
      parts.push(`${full}:${statMtime(full)}`);
      count += 1;
    }
  }
  return crypto.createHash('sha1').update(parts.join('|')).digest('hex');
}

function pollOnce(folderPath) {
  const state = watches.get(folderPath);
  if (!state) return;
  const fp = computeFingerprint(state.commonDir);
  if (!state.primed) { state.fingerprint = fp; state.primed = true; return; }
  if (fp === state.fingerprint) return;
  state.fingerprint = fp;
  clearTimeout(state.debounceTimer);
  state.debounceTimer = setTimeout(() => { try { send('git-graph-repo-changed', folderPath); } catch {} }, REPO_WATCH_DEBOUNCE_MS);
}

function sweepIdleWatches() {
  const now = Date.now();
  for (const [folderPath, state] of watches) {
    if (now - state.lastAccess > REPO_WATCH_IDLE_MAX_MS) stopRepoWatch(folderPath);
  }
}

async function ensureRepoWatch(dir) {
  const existing = watches.get(dir);
  if (existing) { existing.lastAccess = Date.now(); return; }
  let commonDir;
  try { commonDir = await git.gitCommonDir(dir); } catch { return; }
  const state = { commonDir, fingerprint: null, primed: false, debounceTimer: null, lastAccess: Date.now() };
  state.timer = setInterval(() => pollOnce(dir), REPO_WATCH_POLL_MS);
  if (typeof state.timer.unref === 'function') state.timer.unref();
  watches.set(dir, state);
  pollOnce(dir); // establish the baseline fingerprint without firing a spurious change

  if (!idleSweepTimer) {
    idleSweepTimer = setInterval(sweepIdleWatches, REPO_WATCH_IDLE_SWEEP_MS);
    if (typeof idleSweepTimer.unref === 'function') idleSweepTimer.unref();
  }
}

function stopRepoWatch(dir) {
  const state = watches.get(dir);
  if (!state) return;
  clearInterval(state.timer);
  clearTimeout(state.debounceTimer);
  watches.delete(dir);
}

function stopAllRepoWatches() {
  for (const folderPath of [...watches.keys()]) stopRepoWatch(folderPath);
  if (idleSweepTimer) { clearInterval(idleSweepTimer); idleSweepTimer = null; }
}

module.exports = {
  init,
  getProjectGitGraph,
  getGitGraphCommitDetail,
  getGitGraphCompareDetail,
  getGitGraphFileAtRevision,
  getGitGraphFileDiffBetween,
  ensureRepoWatch,
  stopRepoWatch,
  stopAllRepoWatches,
};
