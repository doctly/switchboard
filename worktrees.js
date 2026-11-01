// worktrees.js — the Worktrees tab: every git worktree of a project's repositories.
//
// A project attaches folders. Each one is a repository, sits inside one, or
// (like a workspace folder) holds several side by side. This module finds
// those repositories, lists their worktrees with `git worktree list`, and runs
// the tab's actions on them.
//
// Every action re-checks that the path it was handed is a worktree of one of
// the project's repositories, so the renderer can never point git at a folder
// of its own choosing.
//
// The commands run after creating or before removing a worktree come from the
// project's Worktrees settings only, never from a file in a repository:
// opening a repository runs nothing.
//
// Like projects.js this is a singleton initialised with init(ctx) so tests can
// hand it a fake db.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const git = require('./git');
const { buildPtyEnv } = require('./pty-env');

const SETTINGS_PREFIX = 'worktrees:';
const DEFAULT_PATH_TEMPLATE = '$BASE_PATH.worktrees/$REF_NAME';
const START_OPTIONS = new Set(['none', 'claude', 'codex', 'terminal']);
const SORT_ORDERS = new Set(['default', 'nameAsc', 'nameDesc', 'createdDesc', 'createdAsc']);
const CREATE_MODES = new Set(['new', 'existing', 'remote', 'detached']);
const PATTERN_MAX = 50;
const PATTERN_LENGTH_MAX = 200;
const COMMAND_LENGTH_MAX = 2000;
const LOCK_REASON_MAX = 200;

// Looking for repositories inside an attached folder that is not one.
const SCAN_DEPTH = 3;
const SCAN_MAX_DIRS = 3000;
const SCAN_MAX_REPOS = 40;
const SCAN_SKIP = new Set(['node_modules', 'dist', 'build', 'out', 'vendor', 'target', 'venv', '__pycache__']);
// Hidden folders are skipped, except the ones tools keep worktrees in.
const SCAN_HIDDEN = new Set(['.claude', '.codex', '.repos', '.worktrees']);

// Copying files a fresh checkout lacks (.env, local config).
const COPY_SKIP_DIRS = new Set(['.git', 'node_modules', '.venv', 'venv', 'vendor', 'dist', 'build']);
const COPY_MAX_ENTRIES = 50000;

const HOOK_TIMEOUT_MS = 15 * 60 * 1000;
const HOOK_OUTPUT_MAX = 4000;
const STATUS_CONCURRENCY = 6;

let db, log, projects, commandEnv, codexHome;

function init(ctx) {
  db = ctx.db;
  log = ctx.log || console;
  projects = ctx.projects;
  // The environment user commands run in; main strips Electron's own variables.
  commandEnv = ctx.commandEnv || (() => buildPtyEnv(process.env));
  codexHome = ctx.codexHome || (() => process.env.CODEX_HOME || path.join(os.homedir(), '.codex'));
}

// --- Paths ---

function isDirectory(p) {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

function samePath(a, b) {
  return projects.realOrResolved(a) === projects.realOrResolved(b);
}

function expandHome(p) {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || p.startsWith('~' + path.sep)) return path.join(os.homedir(), p.slice(2));
  return p;
}

/** A path the user typed: ~ expanded, relative to base, and absolute. */
function resolveUserPath(value, base) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) return '';
  return path.resolve(base, expandHome(text));
}

// --- Settings ---

function cleanPatterns(value) {
  const list = Array.isArray(value) ? value : String(value || '').split('\n');
  const out = [];
  for (const item of list) {
    const pattern = typeof item === 'string' ? item.trim().replace(/\\/g, '/') : '';
    if (!pattern || pattern.length > PATTERN_LENGTH_MAX) continue;
    // Patterns are relative to the repository and stay inside it.
    if (path.posix.isAbsolute(pattern) || /^[A-Za-z]:/.test(pattern) || pattern.split('/').includes('..')) continue;
    if (!out.includes(pattern)) out.push(pattern);
    if (out.length >= PATTERN_MAX) break;
  }
  return out;
}

function cleanCommand(value) {
  return typeof value === 'string' ? value.trim().slice(0, COMMAND_LENGTH_MAX) : '';
}

function normalizeSettings(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const template = typeof source.pathTemplate === 'string' && source.pathTemplate.trim()
    ? source.pathTemplate.trim().slice(0, 500)
    : DEFAULT_PATH_TEMPLATE;
  return {
    pathTemplate: template,
    copyPatterns: cleanPatterns(source.copyPatterns),
    copyIgnores: cleanPatterns(source.copyIgnores),
    postCreateCmd: cleanCommand(source.postCreateCmd),
    preRemoveCmd: cleanCommand(source.preRemoveCmd),
    startAfterCreate: START_OPTIONS.has(source.startAfterCreate) ? source.startAfterCreate : 'none',
    sortOrder: SORT_ORDERS.has(source.sortOrder) ? source.sortOrder : 'default',
    collapsedGroups: Array.isArray(source.collapsedGroups)
      ? source.collapsedGroups.filter(id => typeof id === 'string' && id.length < 1000).slice(0, 100)
      : [],
  };
}

function requireProject(projectId) {
  const project = db.getProject(projectId);
  if (!project) throw new Error('Project not found');
  return project;
}

function getSettings(projectId) {
  requireProject(projectId);
  return { ok: true, settings: normalizeSettings(db.getSetting(SETTINGS_PREFIX + projectId)), defaults: normalizeSettings({}) };
}

function setSettings(projectId, patch) {
  requireProject(projectId);
  const current = normalizeSettings(db.getSetting(SETTINGS_PREFIX + projectId));
  const next = normalizeSettings({ ...current, ...(patch && typeof patch === 'object' ? patch : {}) });
  db.setSetting(SETTINGS_PREFIX + projectId, next);
  return { ok: true, settings: next };
}

function settingsFor(projectId) {
  return normalizeSettings(db.getSetting(SETTINGS_PREFIX + projectId));
}

// --- Finding the project's repositories ---

function hasGitEntry(dir) {
  try { fs.lstatSync(path.join(dir, '.git')); return true; } catch { return false; }
}

/**
 * Repositories inside a folder that is not one: every directory with a .git
 * entry (a folder for a clone, a file for a worktree), at most SCAN_DEPTH
 * levels down. A repository found is not searched further: its own
 * worktrees come from git.
 */
function findNestedRepos(root) {
  const found = [];
  const queue = [{ dir: root, depth: 0 }];
  let visited = 0;
  while (queue.length && visited < SCAN_MAX_DIRS && found.length < SCAN_MAX_REPOS) {
    const { dir, depth } = queue.shift();
    visited += 1;
    if (depth > 0 && hasGitEntry(dir)) { found.push(dir); continue; }
    if (depth >= SCAN_DEPTH) continue;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      // A symlink's dirent is not a directory, so links are never followed.
      if (!entry.isDirectory() || SCAN_SKIP.has(entry.name)) continue;
      if (entry.name.startsWith('.') && !SCAN_HIDDEN.has(entry.name)) continue;
      queue.push({ dir: path.join(dir, entry.name), depth: depth + 1 });
    }
  }
  return found;
}

/**
 * The project's repositories, one per shared .git directory: an attached
 * worktree and the clone it came from are the same repository.
 * [{ commonDir, dirs, attachedFolders, nested }]
 */
async function discoverRepos(folders) {
  const candidates = [];
  for (const folder of folders) {
    if (!isDirectory(folder.path)) continue;
    if (await git.isGitRepo(folder.path)) candidates.push({ dir: folder.path, folder: folder.path, nested: false });
    else for (const dir of findNestedRepos(folder.path)) candidates.push({ dir, folder: folder.path, nested: true });
  }
  await Promise.all(candidates.map(async (candidate) => {
    try { candidate.commonDir = projects.realOrResolved(await git.gitCommonDir(candidate.dir)); } catch { candidate.commonDir = null; }
  }));
  const groups = new Map();
  for (const candidate of candidates) {
    if (!candidate.commonDir) continue;
    let group = groups.get(candidate.commonDir);
    if (!group) {
      group = { commonDir: candidate.commonDir, dirs: [], attachedFolders: [], nested: true };
      groups.set(candidate.commonDir, group);
    }
    group.dirs.push(candidate.dir);
    if (!group.attachedFolders.includes(candidate.folder)) group.attachedFolders.push(candidate.folder);
    if (!candidate.nested) group.nested = false;
  }
  return [...groups.values()];
}

/** What made a worktree, from where it sits. */
function worktreeKind(worktree, mainPath, project, folder) {
  if (worktree.isMain) return 'main';
  const real = projects.realOrResolved(worktree.path);
  const inside = (dir) => projects.isInside(real, projects.realOrResolved(dir));
  if (folder?.mode === 'worktree' || inside(path.join(project.root, 'repos'))) return 'switchboard';
  if (/[\\/]\.claude[\\/]worktrees[\\/]/.test(real)) return 'claude';
  if (inside(path.join(codexHome(), 'worktrees'))) return 'codex';
  if (inside(mainPath + '.worktrees') || /[\\/]\.(worktrees|repos)[\\/]/.test(real)) return 'classic';
  return 'other';
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/** The folder created first in a worktree: its .git entry. */
function createdAt(worktreePath) {
  try {
    const stat = fs.lstatSync(path.join(worktreePath, '.git'));
    return stat.birthtimeMs || stat.ctimeMs || null;
  } catch {
    return null;
  }
}

async function describeWorktree(project, folders, mainPath, worktree) {
  const exists = isDirectory(worktree.path);
  const folder = folders.find(f => samePath(f.path, worktree.path)) || null;
  const info = {
    ...worktree,
    exists,
    kind: worktreeKind(worktree, mainPath, project, folder),
    attached: !!folder,
    attachedMode: folder?.mode || null,
    dirty: null,
    ahead: null,
    behind: null,
    lastCommit: null,
    created: null,
  };
  if (!exists || worktree.bare) return info;
  const [status, last] = await Promise.all([git.status(worktree.path).catch(() => null), git.lastCommit(worktree.path)]);
  if (status) {
    info.dirty = status.dirty;
    info.ahead = status.ahead;
    info.behind = status.behind;
  }
  info.lastCommit = last;
  info.created = createdAt(worktree.path);
  return info;
}

/** The name a repository goes by: its main checkout's folder, without .git for a bare one. */
function repositoryName(mainPath) {
  return path.basename(mainPath).replace(/\.git$/i, '') || mainPath;
}

async function describeRepository(project, folders, group) {
  let list;
  try {
    list = await git.worktreeList(group.dirs[0]);
  } catch (err) {
    return {
      id: group.commonDir, commonDir: group.commonDir, name: repositoryName(path.dirname(group.commonDir)),
      mainPath: group.dirs[0], bare: false, nested: group.nested, attachedFolders: group.attachedFolders,
      error: err.message, worktrees: [],
    };
  }
  const mainPath = list[0].path;
  const worktrees = await mapLimit(list, STATUS_CONCURRENCY, item => describeWorktree(project, folders, mainPath, item));
  return {
    id: group.commonDir,
    commonDir: group.commonDir,
    name: repositoryName(mainPath),
    mainPath,
    bare: !!list[0].bare,
    nested: group.nested,
    attachedFolders: group.attachedFolders,
    worktrees,
  };
}

/** Every repository of the project with its worktrees and their state. */
async function listProjectWorktrees(projectId) {
  const project = requireProject(projectId);
  const folders = db.listProjectFolders(projectId);
  const groups = await discoverRepos(folders);
  const repositories = await Promise.all(groups.map(group => describeRepository(project, folders, group)));
  repositories.sort((a, b) => a.name.localeCompare(b.name) || a.mainPath.localeCompare(b.mainPath));
  return { ok: true, repositories, settings: settingsFor(projectId) };
}

// --- The boundary every action goes through ---

/**
 * The project's repository that path is a worktree of (any of its worktrees
 * names it). Throws when the path belongs to no repository of the project.
 */
async function requireProjectRepository(projectId, somePath) {
  const project = requireProject(projectId);
  const target = typeof somePath === 'string' && somePath ? path.resolve(somePath) : '';
  if (!target) throw new Error('A worktree path is required');
  const folders = db.listProjectFolders(projectId);
  for (const group of await discoverRepos(folders)) {
    let list;
    try { list = await git.worktreeList(group.dirs[0]); } catch { continue; }
    const worktree = list.find(item => samePath(item.path, target));
    if (worktree) return { project, folders, group, list, mainPath: list[0].path, worktree };
  }
  throw new Error('That folder is not a worktree of this project\'s repositories');
}

/** Like requireProjectRepository, also refusing the main worktree unless allowMain. */
async function requireProjectWorktree(projectId, worktreePath, { allowMain = false } = {}) {
  const context = await requireProjectRepository(projectId, worktreePath);
  if (context.worktree.isMain && !allowMain) throw new Error('The main worktree cannot be changed here');
  const folder = context.folders.find(f => samePath(f.path, context.worktree.path)) || null;
  return { ...context, folder };
}

// --- Create ---

/** A branch name as a folder name: slashes and odd characters become "-". */
function refFolderName(ref) {
  return String(ref || '')
    .replace(/[\\/]+/g, '-')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[-.]+|-+$/g, '')
    .slice(0, 80);
}

function renderPathTemplate(template, vars) {
  return template.replace(/\$(BASE_PATH|BASE_ROOT|BASE_NAME|REF_NAME|INDEX|PROJECT_ROOT)/g, (_m, name) => vars[name] ?? '');
}

/**
 * Where a new worktree goes by default: the template filled in, with a
 * number added (or $INDEX counted up) until the folder is free.
 */
function suggestPathFor(template, { mainPath, ref, projectRoot }) {
  const base = mainPath.replace(/\.git$/i, '') || mainPath;
  const vars = {
    BASE_PATH: base,
    BASE_ROOT: path.dirname(base),
    BASE_NAME: path.basename(base),
    REF_NAME: refFolderName(ref) || 'worktree',
    PROJECT_ROOT: projectRoot,
  };
  const counted = template.includes('$INDEX');
  for (let index = 1; index < 1000; index += 1) {
    let candidate = renderPathTemplate(template, { ...vars, INDEX: String(index) });
    if (!counted && index > 1) candidate = `${candidate.replace(/[\\/]+$/, '')}-${index}`;
    candidate = resolveUserPath(candidate, vars.BASE_ROOT);
    if (!fs.existsSync(candidate)) return candidate;
  }
  throw new Error('Could not find a free folder for the worktree');
}

async function suggestWorktreePath(projectId, repoPath, ref) {
  const context = await requireProjectRepository(projectId, repoPath);
  const settings = settingsFor(projectId);
  return { ok: true, path: suggestPathFor(settings.pathTemplate, { mainPath: context.mainPath, ref, projectRoot: context.project.root }) };
}

/** Branches to pick from in the create dialog, and which worktree holds each. */
async function listRepoBranches(projectId, repoPath) {
  const context = await requireProjectRepository(projectId, repoPath);
  const branches = await git.listBranches(context.mainPath);
  const checkedOut = {};
  for (const item of context.list) if (item.branch) checkedOut[item.branch] = item.path;
  return {
    ok: true,
    local: branches.local,
    remote: branches.remote,
    checkedOut,
    defaultBranch: await git.defaultBranch(context.mainPath),
    mainBranch: context.list[0].branch || '',
  };
}

function ensureParentDirs(target, name) {
  let parent = target;
  for (const part of name.split('/').slice(0, -1)) {
    parent = path.join(parent, part);
    try { fs.mkdirSync(parent); } catch (err) { if (err.code !== 'EEXIST') throw err; }
    const stat = fs.lstatSync(parent);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Unsafe destination directory');
  }
}

function matchesAny(relative, patterns) {
  return patterns.some(pattern => path.posix.matchesGlob(relative, pattern.replace(/\/+$/, '')));
}

/**
 * Copy what the patterns match from the main worktree into a new one: files
 * git does not check out (.env, local config). A matching directory is copied
 * whole. Nothing that already exists in the new worktree is overwritten, and
 * links are copied as links, never followed.
 */
function copyMatchingFiles(source, target, patterns, ignores = []) {
  const copied = [];
  const skipped = [];
  if (!patterns.length || !isDirectory(source)) return { copied, skipped };
  const pending = [''];
  let seen = 0;
  while (pending.length && seen < COPY_MAX_ENTRIES) {
    const relativeDir = pending.pop();
    let entries;
    try { entries = fs.readdirSync(path.join(source, relativeDir), { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      seen += 1;
      if (entry.name === '.git') continue;
      const relative = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
      if (matchesAny(relative, ignores)) continue;
      const isDir = entry.isDirectory();
      if (matchesAny(relative, patterns) && (isDir || entry.isFile())) {
        const from = path.join(source, ...relative.split('/'));
        const to = path.join(target, ...relative.split('/'));
        if (fs.existsSync(to)) { skipped.push(relative); continue; }
        try {
          ensureParentDirs(target, relative);
          if (isDir) fs.cpSync(from, to, { recursive: true, force: false, errorOnExist: false, verbatimSymlinks: true });
          else {
            fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL);
            fs.chmodSync(to, fs.statSync(from).mode & 0o777);
          }
          copied.push(relative);
        } catch (err) {
          log.error?.(`[worktrees] could not copy ${relative} into ${target}`, err);
          skipped.push(relative);
        }
        continue;
      }
      if (isDir && !COPY_SKIP_DIRS.has(entry.name)) pending.push(relative);
    }
  }
  copied.sort();
  return { copied, skipped };
}

/**
 * Create a worktree. spec: { repoPath, mode: new|existing|remote|detached,
 * branch, startPoint, remoteBranch, path, attach, copyEnv: [names] }.
 * The post-create command is not run here: the renderer runs it next with
 * runPostCreate, so it can show that step on its own.
 */
async function createWorktree(projectId, spec = {}) {
  const context = await requireProjectRepository(projectId, spec.repoPath);
  const { mainPath, project } = context;
  const mode = spec.mode;
  if (!CREATE_MODES.has(mode)) return { error: 'Pick what the worktree checks out' };
  let branch = typeof spec.branch === 'string' ? spec.branch.trim() : '';
  const startPoint = typeof spec.startPoint === 'string' ? spec.startPoint.trim() : '';
  let options;
  if (mode === 'new') {
    if (!await git.isValidBranchName(mainPath, branch)) return { error: `Not a valid branch name: ${branch || '(empty)'}` };
    if (await git.branchExists(mainPath, branch)) return { error: `A branch named ${branch} already exists: pick it under Existing branch` };
    options = { createBranch: true, startPoint };
  } else if (mode === 'existing') {
    if (!branch || !await git.branchExists(mainPath, branch)) return { error: `No local branch named ${branch || '(empty)'}` };
    const holder = context.list.find(item => item.branch === branch);
    if (holder) return { error: `${branch} is already checked out in ${holder.path}` };
    options = { createBranch: false };
  } else if (mode === 'remote') {
    const remoteBranch = typeof spec.remoteBranch === 'string' ? spec.remoteBranch.trim() : '';
    const remote = (await git.listBranches(mainPath)).remote.find(item => item.name === remoteBranch);
    if (!remote) return { error: `No remote branch named ${remoteBranch || '(empty)'}` };
    if (!branch) branch = remoteBranch.slice(remote.remote.length + 1);
    if (!await git.isValidBranchName(mainPath, branch)) return { error: `Not a valid branch name: ${branch || '(empty)'}` };
    if (await git.branchExists(mainPath, branch)) return { error: `A local branch named ${branch} already exists: pick it under Existing branch` };
    options = { createBranch: true, startPoint: remoteBranch, track: true };
  } else {
    branch = '';
    options = { detach: true, startPoint: startPoint || 'HEAD' };
  }

  const settings = settingsFor(projectId);
  const base = path.dirname(mainPath);
  const target = spec.path
    ? resolveUserPath(spec.path, base)
    : suggestPathFor(settings.pathTemplate, { mainPath, ref: branch || startPoint || 'detached', projectRoot: project.root });
  if (fs.existsSync(target) && !(isDirectory(target) && fs.readdirSync(target).length === 0)) {
    return { error: `${target} already exists` };
  }
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    await git.worktreeAdd(mainPath, target, branch, options);
  } catch (err) {
    return { error: err.message };
  }
  log.info?.(`[worktrees] created ${target} (${branch || 'detached'}) from ${mainPath}`);

  // A checkout has tracked files only: bring across what the settings name
  // and the .env files the user ticked.
  const fromPatterns = copyMatchingFiles(mainPath, target, settings.copyPatterns, settings.copyIgnores);
  const env = projects.copyEnvFiles(mainPath, target, Array.isArray(spec.copyEnv) ? spec.copyEnv : []);
  const copied = [...new Set([...fromPatterns.copied, ...env.copied.map(name => name.split(path.sep).join('/'))])].sort();

  const warnings = [];
  let attached = false;
  if (spec.attach) {
    const result = await projects.registerWorktreeFolder(projectId, { path: target, sourcePath: mainPath, branch });
    if (result.error) warnings.push(`Not attached to the project: ${result.error}`);
    else attached = true;
  }
  return {
    ok: true,
    worktree: { path: target, branch, mainPath },
    attached,
    copied,
    warnings,
    postCreateCmd: settings.postCreateCmd,
  };
}

// --- User commands ---

function hookEnv(context, worktree) {
  return {
    SWITCHBOARD_WORKTREE: worktree.path,
    SWITCHBOARD_MAIN_WORKTREE: context.mainPath,
    SWITCHBOARD_BRANCH: worktree.branch || '',
  };
}

/**
 * Run a command the user set, in a login shell so their PATH (npm, pnpm…) is
 * there even when the app was opened from the Dock. Resolves with
 * { ok, code, timedOut, output } where output is the last few thousand
 * characters of stdout and stderr together.
 */
function runUserCommand(command, cwd, extraEnv = {}, { timeoutMs = HOOK_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    const isWindows = process.platform === 'win32';
    const file = isWindows ? (process.env.ComSpec || 'cmd.exe') : (process.env.SHELL || '/bin/sh');
    const args = isWindows ? ['/d', '/s', '/c', command] : ['-lc', command];
    let output = '';
    let timedOut = false;
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ...result, timedOut, output: output.trim() });
    };
    let child;
    try {
      child = spawn(file, args, {
        cwd,
        env: { ...commandEnv(), ...extraEnv },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsVerbatimArguments: isWindows,
        // Its own process group, so a timeout stops what the shell started too.
        detached: !isWindows,
      });
    } catch (err) {
      resolve({ ok: false, code: null, timedOut: false, output: err.message });
      return;
    }
    const keep = (chunk) => { output = (output + chunk.toString()).slice(-HOOK_OUTPUT_MAX); };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    const timer = setTimeout(() => {
      timedOut = true;
      try { if (isWindows) child.kill(); else process.kill(-child.pid, 'SIGTERM'); } catch {}
    }, timeoutMs);
    child.on('error', (err) => { output += `\n${err.message}`; finish({ ok: false, code: null }); });
    child.on('close', (code) => finish({ ok: code === 0 && !timedOut, code }));
  });
}

function hookFailure(label, result) {
  const why = result.timedOut ? 'timed out' : (result.code === null ? 'could not start' : `exited with code ${result.code}`);
  return `The ${label} command ${why}`;
}

/** Run the post-create command in a worktree the tab just made. */
async function runPostCreate(projectId, worktreePath) {
  const context = await requireProjectWorktree(projectId, worktreePath);
  const command = settingsFor(projectId).postCreateCmd;
  if (!command) return { ok: true, skipped: true };
  const result = await runUserCommand(command, context.worktree.path, hookEnv(context, context.worktree));
  if (!result.ok) return { error: hookFailure('post-create', result), output: result.output };
  return { ok: true, output: result.output };
}

// --- Remove ---

/**
 * Remove a worktree. Options: force (lose local changes), unlock (a locked
 * one), deleteBranch / forceDeleteBranch. A dirty worktree is refused with
 * dirty: true before anything runs, so the caller can ask. The pre-remove
 * command runs next and a failure keeps the worktree.
 */
async function removeWorktree(projectId, worktreePath, opts = {}) {
  const context = await requireProjectWorktree(projectId, worktreePath);
  const { worktree, mainPath, folder } = context;
  if (worktree.locked && !opts.unlock) {
    return { error: `The worktree is locked${worktree.lockReason ? `: ${worktree.lockReason}` : ''}`, locked: true };
  }
  const exists = isDirectory(worktree.path);
  if (exists && !opts.force) {
    const status = await git.status(worktree.path).catch(() => null);
    if (status?.dirty) return { error: 'The worktree has uncommitted changes', dirty: true };
  }
  const command = settingsFor(projectId).preRemoveCmd;
  if (exists && command && !opts.skipPreRemove) {
    const result = await runUserCommand(command, worktree.path, hookEnv(context, worktree));
    if (!result.ok) {
      return { error: `${hookFailure('pre-remove', result)}: the worktree was kept`, hookFailed: true, output: result.output };
    }
  }
  if (worktree.locked) await git.worktreeUnlock(mainPath, worktree.path);
  try {
    if (exists) await git.worktreeRemove(mainPath, worktree.path, { force: !!opts.force });
    else await git.worktreePrune(mainPath);
  } catch (err) {
    if (worktree.locked) await git.worktreeLock(mainPath, worktree.path, worktree.lockReason).catch(() => {});
    return { error: err.message, dirty: git.isDirtyWorktreeError(err) };
  }
  log.info?.(`[worktrees] removed ${worktree.path}`);
  // The project row goes too, with any cwd that pointed into it.
  if (folder) await projects.detachFolder(projectId, folder.path);

  const result = { ok: true, branch: worktree.branch, branchDeleted: false, branchError: null, unmerged: false };
  if (opts.deleteBranch && worktree.branch) {
    try {
      await git.deleteBranch(mainPath, worktree.branch, { force: !!opts.forceDeleteBranch });
      result.branchDeleted = true;
    } catch (err) {
      result.branchError = err.message;
      result.unmerged = git.isUnmergedBranchError(err);
    }
  }
  return result;
}

/** Delete a branch no worktree has checked out (after "not fully merged"). */
async function deleteBranch(projectId, repoPath, branch, { force = false } = {}) {
  const context = await requireProjectRepository(projectId, repoPath);
  const name = typeof branch === 'string' ? branch.trim() : '';
  if (!name || !await git.branchExists(context.mainPath, name)) return { error: `No local branch named ${name || '(empty)'}` };
  const holder = context.list.find(item => item.branch === name);
  if (holder) return { error: `${name} is checked out in ${holder.path}` };
  try {
    await git.deleteBranch(context.mainPath, name, { force: !!force });
  } catch (err) {
    return { error: err.message, unmerged: git.isUnmergedBranchError(err) };
  }
  return { ok: true };
}

/**
 * Worktrees whose branch is already merged into base (default: the
 * repository's default branch). Each says whether it can go now: it must
 * exist, be clean and not be locked.
 */
async function mergedWorktrees(projectId, repoPath, base) {
  const context = await requireProjectRepository(projectId, repoPath);
  const baseRef = (typeof base === 'string' && base.trim()) || await git.defaultBranch(context.mainPath);
  if (!baseRef) return { error: 'This repository has no main or master branch: pick a base branch' };
  let merged;
  try { merged = new Set(await git.mergedBranches(context.mainPath, baseRef)); } catch (err) { return { error: err.message }; }
  const remotes = (await git.listBranches(context.mainPath)).remote;
  const remote = remotes.find(item => item.name === baseRef);
  const baseLocal = remote ? baseRef.slice(remote.remote.length + 1) : baseRef;
  const candidates = context.list.filter(item => !item.isMain && item.branch && merged.has(item.branch) && item.branch !== baseLocal);
  const worktrees = await mapLimit(candidates, STATUS_CONCURRENCY, async (item) => {
    const exists = isDirectory(item.path);
    const status = exists ? await git.status(item.path).catch(() => null) : null;
    const dirty = !!status?.dirty;
    let reason = '';
    if (!exists) reason = 'Folder missing: prune it instead';
    else if (item.locked) reason = 'Locked';
    else if (dirty) reason = 'Uncommitted changes';
    return { path: item.path, branch: item.branch, exists, dirty, locked: item.locked, eligible: !reason, reason };
  });
  return { ok: true, base: baseRef, worktrees };
}

// --- Maintenance ---

async function lockWorktree(projectId, worktreePath, reason = '') {
  const context = await requireProjectWorktree(projectId, worktreePath);
  if (context.worktree.locked) return { ok: true };
  await git.worktreeLock(context.mainPath, context.worktree.path, String(reason || '').trim().slice(0, LOCK_REASON_MAX));
  return { ok: true };
}

async function unlockWorktree(projectId, worktreePath) {
  const context = await requireProjectWorktree(projectId, worktreePath);
  if (!context.worktree.locked) return { ok: true };
  await git.worktreeUnlock(context.mainPath, context.worktree.path);
  return { ok: true };
}

/** Move a worktree, carrying the project's row and cwds along. */
async function moveWorktree(projectId, worktreePath, newPath) {
  const context = await requireProjectWorktree(projectId, worktreePath);
  const { worktree, mainPath, folder } = context;
  if (worktree.locked) return { error: 'Unlock the worktree before moving it', locked: true };
  if (!isDirectory(worktree.path)) return { error: 'The worktree folder is missing: repair or prune it instead' };
  const target = resolveUserPath(newPath, path.dirname(worktree.path));
  if (!target) return { error: 'Choose where to move the worktree' };
  if (samePath(target, worktree.path)) return { ok: true, path: worktree.path };
  if (fs.existsSync(target)) return { error: `${target} already exists` };
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    await git.worktreeMove(mainPath, worktree.path, target);
  } catch (err) {
    return { error: err.message };
  }
  log.info?.(`[worktrees] moved ${worktree.path} to ${target}`);
  await projects.moveFolderPath(projectId, folder ? folder.path : worktree.path, target);
  return { ok: true, path: target };
}

/** True when dir is a worktree of commonDir that git lost track of (moved by hand). */
function pointsAtRepository(dir, commonDir) {
  try {
    const text = fs.readFileSync(path.join(dir, '.git'), 'utf8');
    const gitdir = text.match(/^gitdir:\s*(.+)\s*$/m)?.[1];
    if (!gitdir) return false;
    const admin = path.resolve(dir, gitdir);
    return samePath(path.dirname(path.dirname(admin)), commonDir) && path.basename(path.dirname(admin)) === 'worktrees';
  } catch {
    return false;
  }
}

/**
 * Repair worktree links. With no paths, every worktree of the repository;
 * otherwise each path must be one of its worktrees, or a folder whose .git
 * file still points into this repository (a worktree moved by hand).
 */
async function repairWorktrees(projectId, repoPath, paths = []) {
  const context = await requireProjectRepository(projectId, repoPath);
  const wanted = Array.isArray(paths) ? paths.filter(p => typeof p === 'string' && p) : [];
  for (const candidate of wanted) {
    const known = context.list.some(item => samePath(item.path, candidate));
    if (!known && !pointsAtRepository(candidate, context.group.commonDir)) {
      return { error: `${candidate} is not a worktree of ${repositoryName(context.mainPath)}` };
    }
  }
  const output = await git.worktreeRepair(context.mainPath, wanted.map(p => path.resolve(p)));
  return { ok: true, output };
}

/**
 * What a prune would drop: the worktrees git marks prunable, and the
 * project's worktree folders of this repository whose folder is gone.
 */
async function prunePreview(projectId, repoPath) {
  const context = await requireProjectRepository(projectId, repoPath);
  const worktrees = context.list.filter(item => item.prunable)
    .map(item => ({ path: item.path, branch: item.branch, reason: item.prunableReason }));
  const repoPaths = context.list.map(item => item.path);
  const staleFolders = context.folders
    .filter(f => f.mode === 'worktree' && !isDirectory(f.path) && repoPaths.some(p => samePath(p, f.sourcePath || '') || samePath(p, f.path)))
    .map(f => ({ path: f.path, branch: f.branch || '' }));
  return { ok: true, worktrees, staleFolders };
}

async function pruneWorktrees(projectId, repoPath, { detachStale = false } = {}) {
  const preview = await prunePreview(projectId, repoPath);
  const context = await requireProjectRepository(projectId, repoPath);
  const pruned = await git.worktreePrune(context.mainPath);
  let detached = 0;
  if (detachStale) {
    for (const folder of preview.staleFolders) {
      const result = await projects.detachFolder(projectId, folder.path);
      if (!result.error) detached += 1;
    }
  }
  return { ok: true, pruned: pruned.length, detached };
}

// --- The project's folders ---

/** Attach a worktree to the project: the main one as it is, any other as a worktree folder. */
async function attachToProject(projectId, worktreePath) {
  const context = await requireProjectWorktree(projectId, worktreePath, { allowMain: true });
  if (context.folder) return { ok: true, alreadyAttached: true };
  if (context.worktree.isMain) return projects.attachFolder(projectId, { path: context.worktree.path, mode: 'in-place' });
  return projects.registerWorktreeFolder(projectId, {
    path: context.worktree.path, sourcePath: context.mainPath, branch: context.worktree.branch,
  });
}

/** Detach a worktree from the project. The folder and the git worktree stay. */
async function detachFromProject(projectId, worktreePath) {
  const context = await requireProjectWorktree(projectId, worktreePath, { allowMain: true });
  if (!context.folder) return { ok: true };
  return projects.detachFolder(projectId, context.folder.path);
}

module.exports = {
  init,
  DEFAULT_PATH_TEMPLATE,
  normalizeSettings, getSettings, setSettings,
  findNestedRepos, worktreeKind, refFolderName, renderPathTemplate, suggestPathFor, copyMatchingFiles, runUserCommand,
  listProjectWorktrees, requireProjectRepository, requireProjectWorktree,
  suggestWorktreePath, listRepoBranches, createWorktree, runPostCreate,
  removeWorktree, deleteBranch, mergedWorktrees,
  lockWorktree, unlockWorktree, moveWorktree, repairWorktrees, prunePreview, pruneWorktrees,
  attachToProject, detachFromProject,
};
