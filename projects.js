// projects.js — Projects: a piece of work with a folder on disk.
//
// A project owns a root folder under the projects root (default ~/Switchboard),
// attaches zero or more folders (the cwds sessions run in), and files sessions
// under itself or under one of its tracks. The folder on disk carries the
// context: CLAUDE.md / AGENTS.md is the brief every session below it reads,
// plan.md holds the plan in whatever form the agent writes it, plan-tracker.md
// is the fixed-format checklist Switchboard reads for progress, and todos.md
// the follow-ups.
//
// Rows live in their own tables (db.js: projects, project_folders, tracks) and
// the session ↔ project link is session_meta.projectId / trackId. Nothing here
// is keyed on the `project:<path>` settings blob, which is deleted when a folder
// is hidden.
//
// Like session-cache.js this is a singleton initialised with init(ctx) so tests
// can hand it a fake db and a fake session list.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const git = require('./git');
const planParser = require('./public/plan-parser');

const DEFAULT_ROOT_NAME = 'Switchboard';
const REPOS_DIR = 'repos';
const ADDED_FILES_DIR = 'added-files';
// Codex reads AGENTS.override.md instead of AGENTS.md at the same level, and
// only from the git root down, so a worktree gets a copy of the project brief
// under that name (excluded from git). Claude needs nothing: it walks up.
const CODEX_BRIDGE_FILE = 'AGENTS.override.md';
const BRANCH_NAME_RE = /^(?!-)[A-Za-z0-9._\/-]+$/;
const SLUG_MAX = 60;
const FOLDER_MODES = new Set(['in-place', 'worktree']);
const PROJECT_STATUSES = new Set(['active', 'done']);
// A .env is a few lines; anything larger under that name is something else.
const ENV_FILE_MAX_BYTES = 1024 * 1024;
const ENV_SKIP_DIRS = new Set(['.git', 'node_modules', 'vendor', '.venv', 'venv']);

let db, log, buildProjectsFromCache, notifyRendererProjectsChanged, isHarnessId, plansDir;

function init(ctx) {
  db = ctx.db;
  log = ctx.log || console;
  buildProjectsFromCache = ctx.buildProjectsFromCache;
  notifyRendererProjectsChanged = ctx.notifyRendererProjectsChanged || (() => {});
  // Which CLI ids a track may name. Main passes the harness registry; tests
  // and callers that do not care accept anything.
  isHarnessId = ctx.isHarnessId || (() => true);
  // Where Claude Code keeps plan-mode plans (~/.claude/plans), for adopting one.
  plansDir = ctx.plansDir || path.join(os.homedir(), '.claude', 'plans');
  // Project templates; tests point this at a temp folder or the bundled one.
  templatesDir = ctx.templatesDir || null;
}

// --- Root and slugs ---

function expandHome(p) {
  if (p === '~') return os.homedir();
  if (p.startsWith('~' + path.sep) || p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

/** Where new projects are created. A global-only setting, like hiddenProjects. */
function projectsRoot() {
  const global = (db.getSetting && db.getSetting('global')) || {};
  const configured = typeof global.projectsRoot === 'string' ? global.projectsRoot.trim() : '';
  return configured ? path.resolve(expandHome(configured)) : path.join(os.homedir(), DEFAULT_ROOT_NAME);
}

/** Lowercase, runs of non [a-z0-9] become "-", trimmed, at most SLUG_MAX chars. */
function slugify(name) {
  let slug = String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (slug.length > SLUG_MAX) slug = slug.slice(0, SLUG_MAX).replace(/-+$/g, '');
  return slug;
}

/** slugify(name), with -2, -3, … appended while a project already uses it. */
function uniqueSlug(name) {
  const base = slugify(name) || 'project';
  if (!db.getProjectBySlug(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`;
    if (!db.getProjectBySlug(candidate)) return candidate;
  }
}

// --- Files written into a new project folder ---
//
// The brief uses absolute paths throughout, because a session may start in an
// attached folder rather than the project folder and "./plan.md" would then
// point at the wrong place.
//
// Everything Switchboard owns — the title, the project folder, the working
// rules and the attached-folder list — sits in one block between markers. It
// is rewritten whole on every sync, so a change to any of it reaches projects
// that already exist. Anything outside the markers is the user's and is never
// touched.

const MANAGED_START = '<!-- switchboard:managed -->';
const MANAGED_END = '<!-- /switchboard:managed -->';
const MANAGED_NOTE = '<!-- Managed by Switchboard: this block is replaced on update. Put your own notes outside it. -->';
const BRIEF_FILES = ['CLAUDE.md', 'AGENTS.md'];

function foldersSection(folderPaths) {
  const lines = ['## Attached folders'];
  if (!folderPaths.length) {
    lines.push('No folders are attached yet. Attach the repos this project works in from the project settings in Switchboard.');
  } else {
    lines.push("These attached folders are part of the project's working context. Unless the user specifies otherwise, interpret their requests—including questions, explanations, investigations, reviews, planning, and changes—in the context of these folders. Inspect the relevant attached folders to understand the request and ground your response in their contents. The project folder holds shared plans, notes, drafts, and context; it is not the full scope of the work. The first time you work in an attached folder in a session, read its own instructions (CLAUDE.md or AGENTS.md at its root) and follow them there. Once read, they hold for the rest of the session; do not re-read them before each task.");
    for (const p of folderPaths) lines.push(`- ${p}`);
  }
  return lines.join('\n') + '\n';
}

// The plan itself is the agent's to shape (plan.md). What Switchboard reads is
// the tracker (plan-tracker.md), whose format is fixed so progress can be
// parsed. Neither is read at the start of a session; the rules say to open
// them only when the user brings the plan or the todos up. None of these
// files is created up front: the agent makes them when it first needs them.
const PROJECT_FILES = ['plan.md', 'plan-tracker.md', 'todos.md', 'memory.md'];

/** The one block Switchboard owns: title, folder, rules, attached folders. */
function managedBlock(name, root, folderPaths = []) {
  return `${MANAGED_START}
${MANAGED_NOTE}
# ${name}
Project folder: ${root}

${briefRules(root)}
${foldersSection(folderPaths)}${MANAGED_END}
`;
}

/**
 * A new brief: the managed block, then whatever the template adds below it as
 * the user's own text. Without a template the managed block is the whole file.
 */
function defaultBrief(name, root, folderPaths = [], header = null) {
  const block = managedBlock(name, root, folderPaths);
  return header ? `${block}\n${header}` : block;
}

function briefRules(root) {
  const plan = path.join(root, 'plan.md');
  const tracker = path.join(root, 'plan-tracker.md');
  const todos = path.join(root, 'todos.md');
  const memory = path.join(root, 'memory.md');
  return `## Working rules
- This folder is the project. Keep plans, notes and drafts here, not in the attached folders.
- When the user asks for a plan, write it to ${plan} in whatever form fits the work.
- Whenever you write or change a plan, also keep ${tracker} up to date: one
  "## Phase N: title" heading per phase, each with "- [ ]" checkbox items under it.
  Tick an item when it is finished and the heading's own checkbox when the whole
  phase is done. Switchboard reads this file to show progress.
- Keep follow-ups and ideas in ${todos} as "- [ ]" checkbox lines. When asked to
  add a todo, append it there. Tick a todo when it is done. Work that is already
  a phase or an item in the tracker does not belong in the todos as well.
- Anything you want to remember across sessions goes in ${memory}.
- Read ${plan}, ${tracker} or ${todos} only when the user brings up the plan or
  the todos. Not at the start of a session, and not again before each task.
  What you have already read stays current until you change it.
- These files may not exist yet. Create them when you first need them.
`;
}

function writeIfMissing(filePath, content) {
  if (fs.existsSync(filePath)) return false;
  fs.writeFileSync(filePath, content, 'utf8');
  return true;
}

/** Only the brief is written up front; plan, tracker, todos and memory are the agent's to create. */
function writeProjectFiles(root, name, folderPaths, header = null) {
  const brief = defaultBrief(name, root, folderPaths, header);
  for (const file of BRIEF_FILES) writeIfMissing(path.join(root, file), brief);
}

// --- Templates ---
//
// A template is a folder under <data dir>/templates/<kind>/ with a
// template.json ({ name, description, tracks }) and the files a new project
// starts with. Three are seeded from the app's own templates/ folder the
// first time the folder is missing; after that they are the user's to edit,
// and a new folder there is a new template with no code change. A template's
// CLAUDE.md is the top of the brief; the working rules and the folder block
// are still appended, so every project keeps the same contract.

const BUNDLED_TEMPLATES_DIR = path.join(__dirname, 'templates');
const TEMPLATE_META = 'template.json';
const TEMPLATE_KIND_RE = /^[a-z0-9][a-z0-9-]*$/;
let templatesDir = null;

function dataDir() {
  return process.env.SWITCHBOARD_DATA_DIR ? path.resolve(process.env.SWITCHBOARD_DATA_DIR) : path.join(os.homedir(), '.switchboard');
}

function templatesRoot() {
  return templatesDir || path.join(dataDir(), 'templates');
}

/** Copy the bundled templates in when the folder does not exist yet. Never overwrites. */
function seedTemplates() {
  const dir = templatesRoot();
  if (fs.existsSync(dir)) return false;
  if (!fs.existsSync(BUNDLED_TEMPLATES_DIR)) return false;
  try {
    fs.cpSync(BUNDLED_TEMPLATES_DIR, dir, { recursive: true });
    return true;
  } catch (err) {
    log.error?.(`[projects] could not seed templates into ${dir}`, err);
    return false;
  }
}

function readTemplate(kind) {
  if (typeof kind !== 'string' || !TEMPLATE_KIND_RE.test(kind)) return null;
  const dir = path.join(templatesRoot(), kind);
  const metaPath = path.join(dir, TEMPLATE_META);
  if (!fs.existsSync(metaPath)) return null;
  let meta;
  try { meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')); } catch { return null; }
  const tracks = (Array.isArray(meta.tracks) ? meta.tracks : [])
    .map(t => (typeof t === 'string' ? { name: t } : t))
    .filter(t => t && typeof t.name === 'string' && t.name.trim())
    .map(t => ({ name: t.name.trim(), cli: typeof t.cli === 'string' && t.cli ? t.cli : null }));
  return { kind, dir, name: typeof meta.name === 'string' && meta.name.trim() ? meta.name.trim() : kind, description: typeof meta.description === 'string' ? meta.description : '', tracks };
}

function listTemplates() {
  seedTemplates();
  const dir = templatesRoot();
  const templates = [];
  if (fs.existsSync(dir)) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const template = readTemplate(entry.name);
      if (template) templates.push({ kind: template.kind, name: template.name, description: template.description, tracks: template.tracks });
    }
  }
  templates.sort((a, b) => a.name.localeCompare(b.name));
  return { dir, templates };
}

function renderTemplateText(text, vars) {
  return String(text).replace(/\{\{\s*(name|slug|root)\s*\}\}/g, (_m, key) => vars[key] ?? '');
}

/**
 * Copy a template's files into a new project folder. Markdown files have
 * {{name}}, {{slug}} and {{root}} filled in; template.json and the brief
 * files are skipped (the brief is composed separately). Returns the brief
 * header from the template's CLAUDE.md, or null.
 */
function applyTemplate(template, root, vars) {
  let header = null;
  const walk = (from, rel) => {
    for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
      const childRel = rel ? path.join(rel, entry.name) : entry.name;
      const source = path.join(from, entry.name);
      if (entry.isDirectory()) {
        fs.mkdirSync(path.join(root, childRel), { recursive: true });
        walk(source, childRel);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!rel && entry.name === TEMPLATE_META) continue;
      if (!rel && BRIEF_FILES.includes(entry.name)) {
        if (entry.name === 'CLAUDE.md' || (entry.name === 'AGENTS.md' && !header)) {
          header = renderTemplateText(fs.readFileSync(source, 'utf8'), vars).trimEnd() + '\n';
        }
        continue;
      }
      const dest = path.join(root, childRel);
      if (fs.existsSync(dest)) continue;
      if (/\.md$/i.test(entry.name)) fs.writeFileSync(dest, renderTemplateText(fs.readFileSync(source, 'utf8'), vars), 'utf8');
      else fs.copyFileSync(source, dest);
    }
  };
  walk(template.dir, '');
  return header;
}

/**
 * Create one of the agent-owned files when the user opens it from the page
 * before any session has. Only the four known names, only when missing.
 */
function createProjectFile(projectId, name, content) {
  const project = db.getProject(projectId);
  if (!project) return { error: 'Project not found' };
  if (!PROJECT_FILES.includes(name)) return { error: `Not a project file: ${name}` };
  const filePath = path.join(project.root, name);
  if (fs.existsSync(filePath)) return { ok: true, filePath, created: false };
  const label = name.replace(/\.md$/, '').replace(/-/g, ' ');
  const text = typeof content === 'string' ? content : `# ${project.name} ${label}\n\n`;
  try { fs.writeFileSync(filePath, text, 'utf8'); } catch (err) { return { error: err.message }; }
  return { ok: true, filePath, created: true };
}

/** Files the user has dropped into this project's durable context folder. */
function addedFilesAtRoot(root) {
  const dirPath = path.join(root, ADDED_FILES_DIR);
  let entries;
  try {
    if (!fs.lstatSync(dirPath).isDirectory()) return { dirPath, files: [] };
    entries = fs.readdirSync(dirPath, { withFileTypes: true });
  } catch { entries = []; }
  const files = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const filePath = path.join(dirPath, entry.name);
    let stat;
    try { stat = fs.lstatSync(filePath); } catch { continue; }
    files.push({
      name: entry.name,
      relativePath: path.join(ADDED_FILES_DIR, entry.name),
      type: 'file',
      size: stat.size,
      modified: stat.mtime.toISOString(),
    });
  }
  files.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
  return { dirPath, files };
}

function listAddedFiles(projectId) {
  const project = db.getProject(projectId);
  if (!project) return { error: 'Project not found' };
  return { ok: true, ...addedFilesAtRoot(project.root) };
}

/** Pick a non-destructive destination such as "brief (2).pdf" on collisions. */
function uniqueAddedFilePath(dirPath, name) {
  const first = path.join(dirPath, name);
  if (!fs.existsSync(first)) return first;
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  for (let n = 2; ; n++) {
    const candidate = path.join(dirPath, `${stem} (${n})${ext}`);
    if (!fs.existsSync(candidate)) return candidate;
  }
}

/**
 * Copy dropped files into <project>/added-files without overwriting anything.
 * Source paths come from Electron's webUtils.getPathForFile; main still
 * validates every one before touching the project folder.
 */
async function addProjectFiles(projectId, sourcePaths) {
  const project = db.getProject(projectId);
  if (!project) return { error: 'Project not found' };
  if (!Array.isArray(sourcePaths) || !sourcePaths.length) return { error: 'No files were dropped' };

  const dirPath = path.join(project.root, ADDED_FILES_DIR);
  const added = [];
  const errors = [];
  const seen = new Set();
  for (const raw of sourcePaths) {
    const source = typeof raw === 'string' && path.isAbsolute(raw) ? path.resolve(raw) : '';
    if (!source) {
      errors.push(`${path.basename(String(raw || 'File')) || 'File'}: Source path must be absolute`);
      continue;
    }
    if (seen.has(source)) continue;
    seen.add(source);
    const label = path.basename(source) || String(raw || 'File');
    try {
      const stat = await fs.promises.lstat(source);
      if (!stat.isFile()) throw new Error('Only files can be added');
      await fs.promises.mkdir(dirPath, { recursive: true });
      const dirStat = await fs.promises.lstat(dirPath);
      if (!dirStat.isDirectory()) throw new Error(`${ADDED_FILES_DIR} must be a regular folder`);
      const [rootReal, dirReal] = await Promise.all([
        fs.promises.realpath(project.root),
        fs.promises.realpath(dirPath),
      ]);
      if (path.dirname(dirReal) !== rootReal) throw new Error(`${ADDED_FILES_DIR} must be inside the project folder`);
      const destination = uniqueAddedFilePath(dirPath, label);
      await fs.promises.copyFile(source, destination, fs.constants.COPYFILE_EXCL);
      added.push(path.basename(destination));
    } catch (err) {
      errors.push(`${label}: ${err.message}`);
    }
  }
  if (added.length) notifyRendererProjectsChanged();
  return { ok: true, ...addedFilesAtRoot(project.root), added, errors };
}

/**
 * Replace the managed block in one brief file. When the markers are missing —
 * the user deleted them — the block goes back at the top, where a new brief
 * puts it, and the user's own text stays below.
 */
function syncBriefFile(filePath, block) {
  if (!fs.existsSync(filePath)) return false;
  const text = fs.readFileSync(filePath, 'utf8');
  const start = text.indexOf(MANAGED_START);
  const end = text.indexOf(MANAGED_END);
  const next = start !== -1 && end !== -1 && end > start
    ? text.slice(0, start) + block.trimEnd() + '\n' + text.slice(end + MANAGED_END.length).replace(/^\n+/, '')
    : block.trimEnd() + '\n\n' + text.trimStart();
  if (next !== text) fs.writeFileSync(filePath, next, 'utf8');
  return true;
}

/**
 * Keep the managed block in CLAUDE.md and AGENTS.md current — the title, the
 * project folder, the working rules and the attached-folder list — and refresh
 * the Codex bridge file in every worktree folder, since it carries a copy of
 * AGENTS.md.
 */
async function syncProjectBrief(projectId) {
  const project = db.getProject(projectId);
  if (!project) return;
  const folders = db.listProjectFolders(projectId);
  const block = managedBlock(project.name, project.root, folders.map(f => f.path));
  for (const file of BRIEF_FILES) {
    try { syncBriefFile(path.join(project.root, file), block); } catch (err) {
      log.error?.(`[projects] could not update ${file} in ${project.root}`, err);
    }
  }
  for (const folder of folders) {
    if (folder.mode !== 'worktree') continue;
    try { await writeCodexBridge(project, folder.path); } catch (err) {
      log.error?.(`[projects] could not write ${CODEX_BRIDGE_FILE} in ${folder.path}`, err);
    }
  }
}

/**
 * Bring every project's brief up to date at startup, so a Switchboard upgrade
 * that changes the working rules reaches projects that already exist. Each
 * file is only written when its text actually changed, so this is normally a
 * no-op.
 */
async function syncAllProjectBriefs() {
  let projectList = [];
  try { projectList = db.listProjects() || []; } catch (err) {
    log.error?.('[projects] could not list projects to sync briefs', err);
    return;
  }
  for (const project of projectList) {
    try { await syncProjectBrief(project.id); } catch (err) {
      log.error?.(`[projects] could not sync the brief for ${project.name}`, err);
    }
  }
}

// --- Codex bridge file ---

/** Add a pattern to the repository's shared info/exclude, once. */
async function excludeFromGit(worktree, pattern) {
  const common = await git.gitCommonDir(worktree);
  const excludePath = path.join(common, 'info', 'exclude');
  fs.mkdirSync(path.dirname(excludePath), { recursive: true });
  const existing = fs.existsSync(excludePath) ? fs.readFileSync(excludePath, 'utf8') : '';
  if (existing.split(/\r?\n/).some(line => line.trim() === pattern)) return false;
  const prefix = existing.trim() ? existing.trimEnd() + '\n' : '';
  fs.writeFileSync(excludePath, prefix + pattern + '\n', 'utf8');
  return true;
}

/**
 * Write <worktree>/AGENTS.override.md: the project's AGENTS.md followed by the
 * repo's own AGENTS.md when it has one, so the override loses nothing. The
 * file is excluded from git through the repo's info/exclude, never a commit.
 */
async function writeCodexBridge(project, worktree) {
  const briefPath = path.join(project.root, 'AGENTS.md');
  if (!fs.existsSync(briefPath) || !isDirectory(worktree)) return false;
  let content = fs.readFileSync(briefPath, 'utf8').trimEnd() + '\n';
  const repoAgents = path.join(worktree, 'AGENTS.md');
  if (fs.existsSync(repoAgents)) {
    content += `\n---\n\n<!-- The repository's own AGENTS.md follows. -->\n\n` + fs.readFileSync(repoAgents, 'utf8').trimEnd() + '\n';
  }
  const header = `<!-- Written by Switchboard for the project "${project.name}" (${project.root}).\n` +
    `     Codex reads this file instead of AGENTS.md in this worktree. It is excluded from git and rewritten when the project brief changes. -->\n\n`;
  const filePath = path.join(worktree, CODEX_BRIDGE_FILE);
  const next = header + content;
  const current = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : null;
  if (current !== next) fs.writeFileSync(filePath, next, 'utf8');
  await excludeFromGit(worktree, CODEX_BRIDGE_FILE);
  return true;
}

function removeCodexBridge(worktree) {
  try { fs.rmSync(path.join(worktree, CODEX_BRIDGE_FILE), { force: true }); } catch {}
}

/**
 * Save the brief from the project page. CLAUDE.md and AGENTS.md always carry
 * the same text, and every worktree's bridge file is a copy of AGENTS.md, so
 * one save writes all of them. The managed folder block is re-synced, which
 * puts it back if the user deleted it. Returns the text as written.
 */
async function saveBrief(projectId, content) {
  const project = db.getProject(projectId);
  if (!project) return { error: 'Project not found' };
  if (typeof content !== 'string') return { error: 'Brief must be text' };
  const text = content.endsWith('\n') || content === '' ? content : content + '\n';
  try {
    for (const file of BRIEF_FILES) fs.writeFileSync(path.join(project.root, file), text, 'utf8');
  } catch (err) {
    return { error: `Could not write the brief: ${err.message}` };
  }
  await syncProjectBrief(projectId);
  const saved = fs.readFileSync(path.join(project.root, 'CLAUDE.md'), 'utf8');
  return { ok: true, content: saved };
}

// --- Validation helpers ---

function isDirectory(p) {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

function normalizeFolderSpec(spec) {
  if (!spec || typeof spec !== 'object') return { error: 'Folder must be an object' };
  const folderPath = typeof spec.path === 'string' ? spec.path.trim() : '';
  if (!folderPath || !path.isAbsolute(folderPath)) return { error: 'Folder path must be absolute' };
  if (!isDirectory(folderPath)) return { error: `Not a directory: ${folderPath}` };
  const mode = spec.mode || 'in-place';
  if (!FOLDER_MODES.has(mode)) return { error: `Unknown folder mode: ${mode}` };
  // Only a worktree needs .env copied; an in-place folder already has its own.
  const copyEnv = mode === 'worktree' && Array.isArray(spec.copyEnv)
    ? spec.copyEnv.filter(name => typeof name === 'string')
    : [];
  return { path: path.resolve(folderPath), mode, branch: typeof spec.branch === 'string' ? spec.branch.trim() : '', copyEnv };
}

// realpath of the longest existing ancestor, with the rest joined back on.
// A session cwd may be a directory that no longer exists (a removed worktree),
// and on macOS /var is a symlink to /private/var, so comparing a resolved
// path against a realpath'd root would miss.
function realOrResolved(p) {
  const resolved = path.resolve(p);
  let current = resolved;
  const tail = [];
  for (;;) {
    try { return path.join(fs.realpathSync(current), ...tail); } catch {}
    const parent = path.dirname(current);
    if (parent === current) return resolved;
    tail.unshift(path.basename(current));
    current = parent;
  }
}

function isInside(child, parent) {
  if (child === parent) return true;
  return child.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep);
}

// --- Tree node shape handed to the renderer ---

function trackNode(row) {
  return {
    id: row.id, projectId: row.projectId, name: row.name,
    cwd: row.cwd || null, cli: row.cli || null, status: row.status || 'active',
    sortOrder: row.sortOrder || 0, created: row.created,
    sessions: [],
  };
}

function projectNode(row, folderRows = [], trackRows = []) {
  const added = addedFilesAtRoot(row.root);
  return {
    id: row.id, name: row.name, slug: row.slug, root: row.root,
    status: row.status || 'active',
    sharedBranch: row.sharedBranch === undefined ? true : !!row.sharedBranch,
    branchName: row.branchName || null,
    defaultCwd: row.defaultCwd || null,
    created: row.created, modified: row.modified,
    lastActivity: null, sessionCount: 0,
    addedFilesPath: added.dirPath,
    addedFiles: added.files,
    folders: folderRows.map(f => ({
      path: f.path, mode: f.mode || 'in-place', sourcePath: f.sourcePath || null,
      branch: f.branch || null, sortOrder: f.sortOrder || 0,
    })),
    tracks: trackRows.map(trackNode),
    sessions: [],
  };
}

function loadProjectNode(id) {
  const row = db.getProject(id);
  if (!row) return null;
  return projectNode(row, db.listProjectFolders(id), db.listTracks(id));
}

// --- Create / update / delete ---

async function createProject(spec) {
  const name = typeof spec?.name === 'string' ? spec.name.trim() : '';
  if (!name) return { error: 'Project name is required' };

  const folders = [];
  for (const raw of (Array.isArray(spec.folders) ? spec.folders : [])) {
    const normalized = normalizeFolderSpec(raw);
    if (normalized.error) return { error: normalized.error };
    if (folders.some(f => f.path === normalized.path)) continue;
    folders.push(normalized);
  }
  const branchName = typeof spec.branchName === 'string' && spec.branchName.trim() ? spec.branchName.trim() : null;
  if (branchName && !BRANCH_NAME_RE.test(branchName)) return { error: `Invalid branch name: ${branchName}` };
  let template = null;
  if (spec.template) {
    template = readTemplate(spec.template);
    if (!template) return { error: `Unknown template: ${spec.template}` };
  }

  const slug = uniqueSlug(name);
  const rootDir = projectsRoot();
  const root = path.join(rootDir, slug);
  if (fs.existsSync(root)) {
    return { error: `A folder named "${slug}" already exists in ${rootDir}` };
  }

  // In-place folders are listed in the brief right away; worktree folders
  // are added after the row exists, since their path is only known once the
  // checkout is made.
  const inPlace = folders.filter(f => f.mode === 'in-place');
  try {
    fs.mkdirSync(root, { recursive: true });
    const header = template ? applyTemplate(template, root, { name, slug, root }) : null;
    writeProjectFiles(root, name, inPlace.map(f => f.path), header);
  } catch (err) {
    return { error: `Could not create ${root}: ${err.message}` };
  }

  const now = new Date().toISOString();
  const row = {
    id: crypto.randomUUID(), name, slug, root,
    status: 'active',
    sharedBranch: spec.sharedBranch === undefined ? true : !!spec.sharedBranch,
    branchName,
    created: now, modified: now,
  };
  db.insertProject(row);
  inPlace.forEach((f, i) => db.upsertProjectFolder({ projectId: row.id, path: f.path, mode: 'in-place', sortOrder: i }));
  // A template's tracks start in the project folder and inherit the default CLI
  // unless the template names one.
  if (template) {
    template.tracks.forEach((t, i) => db.insertTrack({
      id: crypto.randomUUID(), projectId: row.id, name: t.name, cwd: null,
      cli: t.cli && isHarnessId(t.cli) ? t.cli : null, status: 'active', sortOrder: i, created: now,
    }));
  }

  const errors = [];
  for (const f of folders.filter(f => f.mode === 'worktree')) {
    const result = await attachWorktree(db.getProject(row.id), { path: f.path, branch: f.branch, copyEnv: f.copyEnv }, { notify: false });
    if (result.error) errors.push(`${f.path}: ${result.error}`);
  }

  log.info?.(`[projects] created "${name}" at ${root}`);
  refreshPlanWatchers();
  notifyRendererProjectsChanged();
  return { ok: true, project: loadProjectNode(row.id), errors };
}

function updateProject(id, patch) {
  const row = db.getProject(id);
  if (!row) return { error: 'Project not found' };
  const clean = {};
  if (typeof patch?.name === 'string') {
    const name = patch.name.trim();
    if (!name) return { error: 'Project name is required' };
    clean.name = name;
  }
  if (patch?.status !== undefined) {
    if (!PROJECT_STATUSES.has(patch.status)) return { error: `Unknown status: ${patch.status}` };
    clean.status = patch.status;
  }
  if (patch?.sharedBranch !== undefined) clean.sharedBranch = !!patch.sharedBranch;
  if (patch?.branchName !== undefined) {
    clean.branchName = typeof patch.branchName === 'string' && patch.branchName.trim() ? patch.branchName.trim() : null;
  }
  if (patch?.defaultCwd !== undefined) {
    const cwd = normalizeCwdWithinProject(row, patch.defaultCwd);
    if (cwd.error) return { error: cwd.error };
    clean.defaultCwd = cwd.cwd;
  }
  if (!Object.keys(clean).length) return { ok: true, project: loadProjectNode(id) };
  clean.modified = new Date().toISOString();
  db.updateProject(id, clean);
  // The brief's title comes from the project name, so a rename rewrites it.
  if (clean.name) syncProjectBrief(id).catch(err => log.error?.('[projects] could not retitle the brief', err));
  notifyRendererProjectsChanged();
  const result = { ok: true, project: loadProjectNode(id) };
  // Finishing a project is the moment to offer removing its worktrees; the
  // renderer asks, then detaches each one with removeWorktree.
  if (clean.status === 'done') {
    result.worktrees = db.listProjectFolders(id).filter(f => f.mode === 'worktree').map(f => f.path);
  }
  return result;
}

/** Rows only. The folder on disk and every session stay. */
function deleteProject(id) {
  const row = db.getProject(id);
  if (!row) return { error: 'Project not found' };
  db.deleteProject(id);
  log.info?.(`[projects] removed "${row.name}" (folder kept at ${row.root})`);
  refreshPlanWatchers();
  notifyRendererProjectsChanged();
  return { ok: true, root: row.root };
}

async function attachFolder(id, spec) {
  const row = db.getProject(id);
  if (!row) return { error: 'Project not found' };
  const normalized = normalizeFolderSpec(spec);
  if (normalized.error) return { error: normalized.error };
  if (normalized.mode === 'worktree') return attachWorktree(row, normalized);
  const existing = db.listProjectFolders(id);
  if (existing.some(f => f.path === normalized.path)) return { ok: true, project: loadProjectNode(id) };
  const sortOrder = existing.reduce((max, f) => Math.max(max, f.sortOrder || 0), -1) + 1;
  db.upsertProjectFolder({ projectId: id, path: normalized.path, mode: 'in-place', sortOrder });
  db.updateProject(id, { modified: new Date().toISOString() });
  await syncProjectBrief(id);
  notifyRendererProjectsChanged();
  return { ok: true, project: loadProjectNode(id) };
}

// --- .env files ---
//
// git worktree add checks out tracked files only, so a repository's .env stays
// behind in the source checkout and the new worktree cannot run the app. The
// new project dialog lists what it found and the user picks; nothing is copied
// unless a name was asked for.

/** A sample file is listed but never picked by default: it is usually tracked already. */
function isEnvSample(name) {
  return /^\.env\.(example|sample|template|dist)$/i.test(path.basename(name));
}

/**
 * The .env files recursively within a folder: `.env` and `.env.*`, sorted, files
 * only, as relative paths. Hidden directories, dependency folders and symlinks are skipped.
 * Big files are left out — a .env is a few lines, and anything large
 * under that name is something else.
 */
function listEnvFiles(dir) {
  const root = typeof dir === 'string' ? path.resolve(dir.trim()) : '';
  if (!root || !isDirectory(root)) return [];
  const names = [];
  const pending = [''];
  while (pending.length) {
    const relativeDir = pending.pop();
    let entries;
    try { entries = fs.readdirSync(path.join(root, relativeDir), { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const relativePath = path.join(relativeDir, entry.name);
      if (entry.isDirectory()) {
        if (!entry.name.startsWith('.') && !ENV_SKIP_DIRS.has(entry.name)) pending.push(relativePath);
        continue;
      }
      // Do not follow symlinks, including links to directories outside the repo.
      if (!entry.isFile()) continue;
      if (entry.name !== '.env' && !entry.name.startsWith('.env.')) continue;
      try { if (fs.statSync(path.join(root, relativePath)).size > ENV_FILE_MAX_BYTES) continue; } catch { continue; }
      names.push(relativePath);
    }
  }
  names.sort();
  return names;
}

/** The names the dialog ticks for the user: everything but the samples. */
function defaultEnvSelection(dir) {
  return listEnvFiles(dir).filter(name => !isEnvSample(name));
}

/**
 * Copy the named .env files from one folder to another. A name the source
 * does not actually have is ignored, so the renderer can never name a path of
 * its own, and an existing destination is never overwritten.
 */
function copyEnvFiles(source, target, names) {
  const wanted = Array.isArray(names) ? names : [];
  if (!wanted.length) return { copied: [], skipped: [] };
  const available = new Set(listEnvFiles(source));
  const copied = [];
  const skipped = [];
  for (const name of wanted) {
    if (!available.has(name)) { skipped.push(name); continue; }
    const dest = path.join(target, name);
    if (fs.existsSync(dest)) { skipped.push(name); continue; }
    try {
      // Create missing parents, but never copy through a destination symlink.
      let parent = target;
      for (const part of name.split(path.sep).slice(0, -1)) {
        parent = path.join(parent, part);
        try { fs.mkdirSync(parent); } catch (err) { if (err.code !== 'EEXIST') throw err; }
        const stat = fs.lstatSync(parent);
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Unsafe destination directory');
      }
      fs.copyFileSync(path.join(source, name), dest, fs.constants.COPYFILE_EXCL);
      fs.chmodSync(dest, fs.statSync(path.join(source, name)).mode & 0o777);
      copied.push(name);
    } catch (err) {
      log.error?.(`[projects] could not copy ${name} into ${target}`, err);
      skipped.push(name);
    }
  }
  return { copied, skipped };
}

/** The branch a project's worktrees use: one shared name, or per folder. */
function worktreeBranchFor(project, requested) {
  if (project.sharedBranch === undefined || project.sharedBranch) return project.branchName || project.slug;
  return (typeof requested === 'string' && requested.trim()) ? requested.trim() : project.slug;
}

/**
 * Check a repository out under <project>/repos/<name> on the project's branch
 * and attach that checkout. The source repo itself is left alone apart from
 * the new branch and one line in its info/exclude.
 */
async function attachWorktree(project, spec, { notify = true } = {}) {
  const source = typeof spec?.path === 'string' ? path.resolve(spec.path.trim()) : '';
  if (!source || !isDirectory(source)) return { error: `Not a directory: ${source || spec?.path}` };
  let top;
  try { top = await git.repoRoot(source); } catch { return { error: `${source} is not inside a git repository` }; }
  if (realOrResolved(top) !== realOrResolved(source)) {
    return { error: `${source} is not the root of a git repository (${top} is)` };
  }
  const branch = worktreeBranchFor(project, spec.branch);
  if (!BRANCH_NAME_RE.test(branch)) return { error: `Invalid branch name: ${branch}` };

  const existing = db.listProjectFolders(project.id);
  if (existing.some(f => f.sourcePath === source)) return { error: 'That repository is already attached on a branch' };
  const target = path.join(project.root, REPOS_DIR, path.basename(source));
  if (fs.existsSync(target)) return { error: `${target} already exists` };
  if (existing.some(f => f.path === target)) return { error: 'That folder is already attached' };

  try {
    fs.mkdirSync(path.join(project.root, REPOS_DIR), { recursive: true });
    await git.worktreeAdd(source, target, branch);
  } catch (err) {
    return { error: `git worktree add failed: ${err.message}` };
  }

  // The checkout has tracked files only. Bring the .env files the user picked
  // across so a session in the worktree can run the app. Never fatal: the
  // worktree is attached either way.
  const env = copyEnvFiles(source, target, spec.copyEnv);
  if (env.copied.length) log.info?.(`[projects] copied ${env.copied.join(', ')} into ${target}`);

  const sortOrder = existing.reduce((max, f) => Math.max(max, f.sortOrder || 0), -1) + 1;
  db.upsertProjectFolder({ projectId: project.id, path: target, mode: 'worktree', sourcePath: source, branch, sortOrder });
  db.updateProject(project.id, { modified: new Date().toISOString() });
  await syncProjectBrief(project.id);
  log.info?.(`[projects] worktree ${target} on ${branch} from ${source}`);
  if (notify) notifyRendererProjectsChanged();
  return { ok: true, project: loadProjectNode(project.id), folder: { path: target, mode: 'worktree', sourcePath: source, branch }, copiedEnv: env.copied };
}

/**
 * Detach a folder. For a worktree folder, removeWorktree also deletes the
 * checkout (never the branch); a dirty checkout is refused with dirty: true
 * unless force is set, so the caller can ask before losing changes.
 */
async function detachFolder(id, folderPath, opts = {}) {
  const row = db.getProject(id);
  if (!row) return { error: 'Project not found' };
  const folder = db.listProjectFolders(id).find(f => f.path === folderPath) || null;
  let worktreeRemoved = false;
  if (folder?.mode === 'worktree') {
    removeCodexBridge(folder.path);
    if (opts.removeWorktree && fs.existsSync(folder.path)) {
      try {
        await git.worktreeRemove(folder.sourcePath, folder.path, { force: !!opts.force });
        worktreeRemoved = true;
      } catch (err) {
        return { error: `Could not remove the worktree: ${err.message}`, dirty: git.isDirtyWorktreeError(err) };
      }
    }
  }
  db.deleteProjectFolder(id, folderPath);
  // A default or track cwd that pointed into the detached folder falls back
  // to the project folder rather than a place the project no longer works in.
  if (row.defaultCwd && isInside(realOrResolved(row.defaultCwd), realOrResolved(folderPath))) {
    db.updateProject(id, { defaultCwd: null });
  }
  for (const track of db.listTracks(id)) {
    if (track.cwd && isInside(realOrResolved(track.cwd), realOrResolved(folderPath))) db.updateTrack(track.id, { cwd: null });
  }
  db.updateProject(id, { modified: new Date().toISOString() });
  await syncProjectBrief(id);
  notifyRendererProjectsChanged();
  return { ok: true, project: loadProjectNode(id), worktreeRemoved };
}

/** Source repository of a project worktree folder, for task inheritance. */
function worktreeParentFor(folderPath) {
  if (!folderPath) return null;
  const folder = db.listAllProjectFolders().find(f => f.mode === 'worktree' && f.path === folderPath);
  return folder?.sourcePath || null;
}

// --- Launch context ---

/**
 * Extra directories for a session that belongs to a project: the project
 * folder and every attached folder, except the cwd itself and anything
 * already under it. A parent of the cwd (the project folder above a worktree,
 * a repo above a track that starts in one of its subfolders) is added too:
 * the CLI only edits under the cwd unless told otherwise, and the plan and
 * todos live in the project folder. Claude loads CLAUDE.md from added
 * directories when CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD is set, so a
 * session started in a repo still gets the brief and a session started in the
 * project folder sees each repo's instructions.
 */
function launchContext(projectId, cwd) {
  const project = db.getProject(projectId);
  if (!project) return null;
  const real = realOrResolved(cwd || project.root);
  const folders = db.listProjectFolders(projectId);
  const candidates = [project.root, ...folders.map(f => f.path)];
  const addDirs = [];
  for (const p of candidates) {
    const realP = realOrResolved(p);
    if (realP === real || isInside(realP, real)) continue;
    if (!addDirs.includes(p)) addDirs.push(p);
  }
  // Starting inside a project worktree: the caller must not ask the CLI for
  // another worktree on top of it.
  const worktree = folders.some(f => f.mode === 'worktree' && isInside(real, realOrResolved(f.path)));
  return {
    addDirs,
    env: addDirs.length ? { CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: '1' } : {},
    worktree,
  };
}

/** addDirs travels as a comma-separated string (see harnesses buildLaunchArgs). */
function mergeAddDirs(existing, extra) {
  const list = String(existing || '').split(',').map(s => s.trim()).filter(Boolean);
  for (const dir of extra || []) if (!list.includes(dir)) list.push(dir);
  return list.join(',');
}

// --- Tracks ---

/**
 * Where sessions start, for a project's default or a track. It has to be the
 * project folder, an attached folder, or somewhere inside one of them; null
 * means "not set" (the project folder, or for a track the project's default).
 * Returns { cwd } or { error }.
 */
function normalizeCwdWithinProject(project, cwd) {
  if (cwd === undefined || cwd === null || cwd === '') return { cwd: null };
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) return { error: 'Folder must be an absolute path' };
  const resolved = path.resolve(cwd);
  if (!isDirectory(resolved)) return { error: `Not a directory: ${resolved}` };
  const real = realOrResolved(resolved);
  const allowed = [project.root, ...db.listProjectFolders(project.id).map(f => f.path)];
  if (!allowed.some(p => isInside(real, realOrResolved(p)))) {
    return { error: 'Folder must be the project folder, an attached folder, or inside one of them' };
  }
  return { cwd: resolved };
}
const normalizeTrackCwd = normalizeCwdWithinProject;

function normalizeTrackCli(cli) {
  if (cli === undefined || cli === null || cli === '') return { cli: null };
  if (typeof cli !== 'string' || !isHarnessId(cli)) return { error: `Unknown CLI: ${cli}` };
  return { cli };
}

function createTrack(projectId, spec) {
  const project = db.getProject(projectId);
  if (!project) return { error: 'Project not found' };
  const name = typeof spec?.name === 'string' ? spec.name.trim() : '';
  if (!name) return { error: 'Track name is required' };
  const cwd = normalizeTrackCwd(project, spec.cwd);
  if (cwd.error) return { error: cwd.error };
  const cli = normalizeTrackCli(spec.cli);
  if (cli.error) return { error: cli.error };
  const existing = db.listTracks(projectId);
  const sortOrder = existing.reduce((max, t) => Math.max(max, t.sortOrder || 0), -1) + 1;
  const row = {
    id: crypto.randomUUID(), projectId, name, cwd: cwd.cwd, cli: cli.cli,
    status: 'active', sortOrder, created: new Date().toISOString(),
  };
  db.insertTrack(row);
  db.updateProject(projectId, { modified: row.created });
  notifyRendererProjectsChanged();
  return { ok: true, track: trackNode(row), project: loadProjectNode(projectId) };
}

function updateTrack(id, patch) {
  const track = db.getTrack(id);
  if (!track) return { error: 'Track not found' };
  const project = db.getProject(track.projectId);
  if (!project) return { error: 'Project not found' };
  const clean = {};
  if (typeof patch?.name === 'string') {
    const name = patch.name.trim();
    if (!name) return { error: 'Track name is required' };
    clean.name = name;
  }
  if (patch?.cwd !== undefined) {
    const cwd = normalizeTrackCwd(project, patch.cwd);
    if (cwd.error) return { error: cwd.error };
    clean.cwd = cwd.cwd;
  }
  if (patch?.cli !== undefined) {
    const cli = normalizeTrackCli(patch.cli);
    if (cli.error) return { error: cli.error };
    clean.cli = cli.cli;
  }
  if (patch?.status !== undefined) {
    if (!PROJECT_STATUSES.has(patch.status)) return { error: `Unknown status: ${patch.status}` };
    clean.status = patch.status;
  }
  if (patch?.sortOrder !== undefined) clean.sortOrder = Number(patch.sortOrder) || 0;
  if (!Object.keys(clean).length) return { ok: true, track: trackNode(track) };
  db.updateTrack(id, clean);
  db.updateProject(track.projectId, { modified: new Date().toISOString() });
  notifyRendererProjectsChanged();
  return { ok: true, track: trackNode(db.getTrack(id)) };
}

/** Sessions keep their project and a snapshot of the deleted track's name. */
function deleteTrack(id, { archiveSessions = false } = {}) {
  const track = db.getTrack(id);
  if (!track) return { error: 'Track not found' };
  const sessionIds = db.deleteTrack(id, { archiveSessions }) || [];
  db.updateProject(track.projectId, { modified: new Date().toISOString() });
  notifyRendererProjectsChanged();
  return { ok: true, projectId: track.projectId, formerTrackName: track.name, sessionIds };
}

// --- Session assignment ---

/** Explicitly file a session. projectId null clears both ids. */
function assignSession(sessionId, projectId, trackId) {
  if (!sessionId) return { error: 'Session id is required' };
  if (!projectId) {
    db.setSessionAssignment(sessionId, null, null);
    notifyRendererProjectsChanged();
    return { ok: true };
  }
  if (!db.getProject(projectId)) return { error: 'Project not found' };
  let cleanTrack = null;
  if (trackId) {
    const track = db.getTrack(trackId);
    if (!track || track.projectId !== projectId) return { error: 'Track not found in that project' };
    cleanTrack = trackId;
  }
  db.setSessionAssignment(sessionId, projectId, cleanTrack);
  notifyRendererProjectsChanged();
  return { ok: true };
}

/**
 * Called from open-terminal for a brand-new session whose launch options carry
 * a projectId. Returns the assignment that was recorded, or null.
 */
function recordLaunchAssignment(sessionId, options) {
  const projectId = options?.projectId;
  if (!projectId || !db.getProject(projectId)) return null;
  let trackId = options?.trackId || null;
  if (trackId) {
    const track = db.getTrack(trackId);
    if (!track || track.projectId !== projectId) trackId = null;
  }
  db.setSessionAssignment(sessionId, projectId, trackId);
  return { projectId, trackId };
}

// --- The tree ---

/** The project whose root contains cwd, or null. Explicit filing beats this. */
function projectForCwd(cwd, projectRows) {
  if (!cwd) return null;
  const real = realOrResolved(cwd);
  const rows = projectRows || db.listProjects();
  for (const row of rows) {
    if (isInside(real, realOrResolved(row.root))) return row;
  }
  return null;
}

/**
 * Every project with its folders, tracks and sessions. Sessions come from the
 * same buildProjectsFromCache() the Sessions tab uses, so a row here is the
 * exact object the sidebar already knows how to render.
 */
function buildProjectTree(showArchived) {
  const projectRows = db.listProjects();
  if (!projectRows.length) return { projects: [] };

  const folderRows = db.listAllProjectFolders();
  const trackRows = db.listAllTracks();
  const byId = new Map();
  for (const row of projectRows) {
    byId.set(row.id, projectNode(
      row,
      folderRows.filter(f => f.projectId === row.id),
      trackRows.filter(t => t.projectId === row.id)
    ));
  }
  const rootsById = new Map(projectRows.map(r => [r.id, realOrResolved(r.root)]));
  const cwdCache = new Map();
  const projectIdForCwd = (cwd) => {
    if (!cwd) return null;
    if (cwdCache.has(cwd)) return cwdCache.get(cwd);
    const real = realOrResolved(cwd);
    let found = null;
    for (const [id, root] of rootsById) {
      if (isInside(real, root)) { found = id; break; }
    }
    cwdCache.set(cwd, found);
    return found;
  };

  const folders = buildProjectsFromCache(showArchived) || [];
  for (const folder of folders) {
    for (const session of folder.sessions || []) {
      let pid = session.projectId && byId.has(session.projectId) ? session.projectId : null;
      if (!pid) pid = projectIdForCwd(session.projectPath);
      if (!pid) continue;
      const node = byId.get(pid);
      const track = session.trackId ? node.tracks.find(t => t.id === session.trackId) : null;
      (track ? track.sessions : node.sessions).push(session);
    }
  }

  const byModified = (a, b) => new Date(b.modified || 0) - new Date(a.modified || 0);
  const projects = [];
  for (const node of byId.values()) {
    node.sessions.sort(byModified);
    let latest = null;
    let count = node.sessions.length;
    for (const s of node.sessions) if (!latest || s.modified > latest) latest = s.modified;
    for (const track of node.tracks) {
      track.sessions.sort(byModified);
      count += track.sessions.length;
      for (const s of track.sessions) if (!latest || s.modified > latest) latest = s.modified;
    }
    node.lastActivity = latest;
    node.sessionCount = count;
    projects.push(node);
  }

  projects.sort((a, b) => {
    if (a.status !== b.status) return a.status === 'active' ? -1 : 1;
    const aKey = a.status === 'active' ? (a.lastActivity || a.modified) : a.modified;
    const bKey = b.status === 'active' ? (b.lastActivity || b.modified) : b.modified;
    return new Date(bKey || 0) - new Date(aKey || 0);
  });

  return { projects };
}

// --- Plan tracker and todos ---
//
// plan-tracker.md and todos.md are parsed with public/plan-parser.js, the same
// code the page uses. Ticks are written line by line so the rest of the file
// stays as the agent wrote it. A watcher on each project folder notices ticks
// made by a session and records which session did them (plan_links), which is
// how a phase shows the sessions that worked on it.

const TRACKER_FILE = 'plan-tracker.md';
const TODOS_FILE = 'todos.md';
const PLAN_FILE_BY_KIND = { plan: TRACKER_FILE, todos: TODOS_FILE };

function readTextOrEmpty(filePath) {
  try { return fs.readFileSync(filePath, 'utf8'); } catch { return ''; }
}

function hasBody(content) {
  return String(content || '').replace(/<!--[\s\S]*?-->/g, '').split(/\r?\n/)
    .some(line => line.trim() && !/^#\s/.test(line.trim()));
}

/** Everything the Plan tab shows: parsed tracker and todos, which files exist, and the session links. */
function readProjectPlan(projectId) {
  const project = db.getProject(projectId);
  if (!project) return { error: 'Project not found' };
  const planPath = path.join(project.root, 'plan.md');
  const trackerPath = path.join(project.root, TRACKER_FILE);
  const todosPath = path.join(project.root, TODOS_FILE);
  const trackerText = readTextOrEmpty(trackerPath);
  const todosText = readTextOrEmpty(todosPath);
  return {
    ok: true,
    plan: planParser.parsePlan(trackerText),
    todos: planParser.parseTodos(todosText),
    links: db.listPlanLinks(projectId),
    planPath, trackerPath, todosPath,
    hasPlan: hasBody(readTextOrEmpty(planPath)),
    hasTracker: fs.existsSync(trackerPath),
    hasTodos: fs.existsSync(todosPath),
  };
}

/** Tick or untick one line of the tracker ('plan') or the todos ('todos'). */
function setPlanItem(projectId, kind, lineNo, done) {
  const project = db.getProject(projectId);
  if (!project) return { error: 'Project not found' };
  const name = PLAN_FILE_BY_KIND[kind];
  if (!name) return { error: `Unknown file: ${kind}` };
  const filePath = path.join(project.root, name);
  if (!fs.existsSync(filePath)) return { error: `${name} does not exist yet` };
  const result = planParser.toggleLine(fs.readFileSync(filePath, 'utf8'), Number(lineNo), !!done);
  if (!result.ok) return { error: 'That line is not a checkbox' };
  fs.writeFileSync(filePath, result.content, 'utf8');
  // The page did this, not a session: the watcher must not link it.
  planWatchers.get(projectId)?.snapshots.set(name, result.content);
  return { ok: true, text: result.text };
}

/** Rewrite the text of one checkbox line of the tracker ('plan') or the todos ('todos'). */
function editPlanItem(projectId, kind, lineNo, text) {
  const project = db.getProject(projectId);
  if (!project) return { error: 'Project not found' };
  const name = PLAN_FILE_BY_KIND[kind];
  if (!name) return { error: `Unknown file: ${kind}` };
  const filePath = path.join(project.root, name);
  if (!fs.existsSync(filePath)) return { error: `${name} does not exist yet` };
  if (!String(text || '').trim()) return { error: 'Nothing to save' };
  const result = planParser.setLineText(fs.readFileSync(filePath, 'utf8'), Number(lineNo), text);
  if (!result.ok) return { error: 'That line is not a checkbox' };
  fs.writeFileSync(filePath, result.content, 'utf8');
  planWatchers.get(projectId)?.snapshots.set(name, result.content);
  return { ok: true, text: result.text, previous: result.previous };
}

/** Append "- [ ] text" to the todos (or the tracker), creating the file when missing. */
function appendPlanItem(projectId, kind, text) {
  const project = db.getProject(projectId);
  if (!project) return { error: 'Project not found' };
  const name = PLAN_FILE_BY_KIND[kind];
  if (!name) return { error: `Unknown file: ${kind}` };
  const clean = String(text || '').trim();
  if (!clean) return { error: 'Nothing to add' };
  const filePath = path.join(project.root, name);
  const heading = `${project.name} ${kind === 'plan' ? 'plan tracker' : 'todos'}`;
  const content = planParser.appendItem(readTextOrEmpty(filePath), clean, heading);
  fs.writeFileSync(filePath, content, 'utf8');
  planWatchers.get(projectId)?.snapshots.set(name, content);
  return { ok: true };
}

/** Remember which session started or finished an item. */
function recordPlanLink(projectId, kind, itemText, sessionId, linkKind) {
  if (!db.getProject(projectId) || !itemText || !sessionId) return false;
  db.insertPlanLink({ projectId, file: kind === 'todos' ? 'todos' : 'plan', itemText: String(itemText), sessionId, kind: linkKind, at: new Date().toISOString() });
  return true;
}

/**
 * Copy a plan-mode plan from ~/.claude/plans into the project as plan.md.
 * The tracker is left for a session to derive; the page says so.
 */
function adoptPlan(projectId, filename, { replace = false } = {}) {
  const project = db.getProject(projectId);
  if (!project) return { error: 'Project not found' };
  const source = path.join(plansDir, path.basename(String(filename || '')));
  if (!fs.existsSync(source)) return { error: 'That plan file no longer exists' };
  const target = path.join(project.root, 'plan.md');
  if (!replace && hasBody(readTextOrEmpty(target))) {
    return { error: 'plan.md already has content', exists: true };
  }
  try { fs.copyFileSync(source, target); } catch (err) { return { error: err.message }; }
  notifyRendererProjectsChanged();
  return { ok: true, planPath: target };
}

// The watcher: one fs.watch per project folder, looking only at the two
// checklist files. When a tick appears that the page did not make, the most
// recently started running session of that project gets the credit.
const planWatchers = new Map(); // projectId → { watcher, snapshots: Map<name, content> }
let planCtx = null;             // { activeSessions, send }

function initPlanWatch(ctx) {
  planCtx = ctx;
  refreshPlanWatchers();
}

function refreshPlanWatchers() {
  if (!planCtx) return;
  const rows = db.listProjects();
  const live = new Set(rows.map(r => r.id));
  for (const [id, entry] of planWatchers) {
    if (live.has(id)) continue;
    try { entry.watcher.close(); } catch {}
    planWatchers.delete(id);
  }
  for (const row of rows) {
    if (planWatchers.has(row.id) || !isDirectory(row.root)) continue;
    startPlanWatcher(row);
  }
}

function startPlanWatcher(row) {
  const snapshots = new Map();
  for (const name of [TRACKER_FILE, TODOS_FILE]) snapshots.set(name, readTextOrEmpty(path.join(row.root, name)));
  const pending = new Set();
  let timer = null;
  let watcher;
  try {
    watcher = fs.watch(row.root, (_event, filename) => {
      const name = String(filename || '');
      if (name !== TRACKER_FILE && name !== TODOS_FILE) return;
      pending.add(name);
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        const names = [...pending];
        pending.clear();
        for (const n of names) {
          try { onPlanFileChanged(row.id, n); } catch (err) { log.error?.('[projects] plan watch failed', err); }
        }
      }, 300);
    });
  } catch (err) {
    log.error?.(`[projects] could not watch ${row.root}`, err);
    return;
  }
  watcher.on('error', (err) => log.error?.(`[projects] watcher error for ${row.root}`, err));
  planWatchers.set(row.id, { watcher, snapshots });
}

/** The running session of a project that most recently started, or null. */
function runningProjectSession(projectId) {
  let best = null;
  for (const [id, session] of planCtx.activeSessions || []) {
    if (session.exited || session.isPlainTerminal || session.projectId !== projectId) continue;
    const at = session._openedAt || 0;
    if (!best || at > best.at) best = { id: session.realSessionId || id, at };
  }
  return best ? best.id : null;
}

function onPlanFileChanged(projectId, name) {
  const project = db.getProject(projectId);
  const entry = planWatchers.get(projectId);
  if (!project || !entry) return;
  const next = readTextOrEmpty(path.join(project.root, name));
  const prev = entry.snapshots.get(name) || '';
  entry.snapshots.set(name, next);
  if (next === prev) return;
  const before = planParser.tickedTexts(prev);
  const newly = [...planParser.tickedTexts(next)].filter(text => !before.has(text));
  if (newly.length) {
    const sessionId = runningProjectSession(projectId);
    if (sessionId) {
      for (const text of newly) recordPlanLink(projectId, name === TRACKER_FILE ? 'plan' : 'todos', text, sessionId, 'ticked');
    }
  }
  planCtx.send?.('project-plan-changed', projectId);
}

function stopPlanWatchers() {
  for (const entry of planWatchers.values()) { try { entry.watcher.close(); } catch {} }
  planWatchers.clear();
  // Until initPlanWatch is called again, creating a project starts no watcher
  // (a stray fs.watch keeps a process alive).
  planCtx = null;
}

// --- Live git state of attached folders ---
// A worktree's branch is stored when it is attached, but an in-place folder is
// on whatever its owner has checked out right now, so the renderer asks for
// this and shows it beside the folder. Cached per path so a page that
// re-renders often does not shell out to git each time.
const GIT_STATUS_TTL_MS = 30 * 1000;
const gitStatusCache = new Map(); // folder path → { at, status }

/** { git: false } | { git: true, branch, dirty, ahead, behind } for one folder, cached briefly. */
async function folderGitInfo(folderPath, { force = false } = {}) {
  const cached = gitStatusCache.get(folderPath);
  if (!force && cached && Date.now() - cached.at < GIT_STATUS_TTL_MS) return cached.status;
  let status = { git: false };
  try {
    if (await git.isGitRepo(folderPath)) status = { git: true, ...(await git.status(folderPath)) };
  } catch (err) {
    log.info('[projects] git status failed for', folderPath, err.message);
  }
  gitStatusCache.set(folderPath, { at: Date.now(), status });
  return status;
}

/** { ok, byPath: { [folderPath]: folderGitInfo(folderPath) } } for every folder of a project. */
async function folderGitStatus(projectId, { force = false } = {}) {
  if (!db.getProject(projectId)) throw new Error('Project not found');
  const byPath = {};
  await Promise.all(db.listProjectFolders(projectId).map(async (folder) => {
    byPath[folder.path] = await folderGitInfo(folder.path, { force });
  }));
  return { ok: true, byPath };
}

/** Detailed, read-only Git information for the repositories attached to a project. */
async function projectGitInfo(projectId) {
  if (!db.getProject(projectId)) throw new Error('Project not found');
  const folders = db.listProjectFolders(projectId);
  const repositories = await Promise.all(folders.map(async (folder) => ({
    path: folder.path,
    mode: folder.mode || 'in-place',
    sourcePath: folder.sourcePath || null,
    ...(await git.snapshot(folder.path)),
  })));
  return { ok: true, repositories };
}

/** Diff one changed file, restricted to a folder already attached to the project. */
async function projectGitDiff(projectId, folderPath, filePath) {
  if (!db.getProject(projectId)) throw new Error('Project not found');
  const folder = db.listProjectFolders(projectId).find(item => item.path === folderPath);
  if (!folder) throw new Error('Repository is not attached to this project');
  return { ok: true, ...(await git.fileDiff(folder.path, filePath)) };
}

module.exports = {
  init,
  projectsRoot, slugify, uniqueSlug, defaultBrief,
  createProject, updateProject, deleteProject, attachFolder, detachFolder,
  folderGitStatus, folderGitInfo, projectGitInfo, projectGitDiff,
  syncProjectBrief, syncAllProjectBriefs, saveBrief, createProjectFile, addProjectFiles, listAddedFiles,
  launchContext, mergeAddDirs, worktreeParentFor,
  CODEX_BRIDGE_FILE, PROJECT_FILES, ADDED_FILES_DIR,
  readProjectPlan, setPlanItem, appendPlanItem, recordPlanLink, adoptPlan,
  initPlanWatch, refreshPlanWatchers, stopPlanWatchers,
  listTemplates, templatesRoot, renderTemplateText, editPlanItem,
  listEnvFiles, defaultEnvSelection, copyEnvFiles,
  createTrack, updateTrack, deleteTrack,
  assignSession, recordLaunchAssignment,
  projectForCwd, buildProjectTree,
};
