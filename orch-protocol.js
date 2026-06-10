// orch-protocol.js — the Agent Teams file protocol.
//
// A "run" is an orchestrated build: a master session plans and decomposes
// work into tasks; worker/reviewer sessions implement and review them. All
// state lives as files under <project>/.switchboard/runs/<runId>/ so any
// party (master agent, workers, Switchboard, the user) can read or write it
// and every party can crash/restart without losing the world:
//
//   .switchboard/
//     guidelines.md              code style + review rubric (shared by runs)
//     runs/<runId>/
//       run.json                 roles→profiles, policy, status
//       plan.md                  master's plan
//       tasks/<taskId>.json      task state (this module owns the schema)
//       tasks/<taskId>.spec.md   self-contained spec for the implementer
//       reviews/<taskId>-<n>.md  reviewer verdicts
//       prompts/<role>.md        role system prompts (generated at run init)
//       events.jsonl             append-only audit log
//
// Concurrency model: every JSON write is atomic (tmp+rename); status
// transitions are optimistic — the writer asserts the status it read is
// still current at write time (best-effort on a filesystem, but combined
// with the single-writer-per-transition convention it keeps races benign).
// events.jsonl is append-only.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ORCH_DIRNAME = '.switchboard';
const RUNS_DIRNAME = 'runs';
const WORKTREES_DIRNAME = 'worktrees';

const RUN_ID_RE = /^[a-z0-9][a-z0-9-]{1,63}$/;
const TASK_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const ROLE_RE = /^[a-z][a-z0-9-]{0,31}$/;

const RUN_STATUSES = new Set(['draft', 'planning', 'active', 'paused', 'done', 'abandoned']);
const TASK_KINDS = new Set(['epic', 'chunk', 'leaf']);

// Task status machine. Keys are "from" statuses; values are the set of
// legal "to" statuses. The conventional owner of each transition is noted —
// not enforceable on a shared filesystem, but Switchboard validates every
// transition it performs and the watcher flags illegal ones it observes.
const TASK_TRANSITIONS = {
  draft:             ['ready', 'blocked'],                       // master
  ready:             ['spawning', 'draft', 'blocked'],           // switchboard | master
  spawning:          ['in_progress', 'ready', 'failed'],         // switchboard
  in_progress:       ['needs_review', 'failed', 'blocked'],      // worker
  needs_review:      ['reviewing', 'approved'],                  // switchboard | human override
  reviewing:         ['approved', 'changes_requested', 'failed', 'needs_review'], // reviewer; needs_review = spawn-failure rollback
  changes_requested: ['spawning', 'ready', 'failed'],            // switchboard (re-dispatch)
  approved:          ['merging', 'done'],                        // master
  merging:           ['done', 'failed'],                         // master
  blocked:           ['ready', 'draft', 'failed'],               // master
  failed:            ['ready', 'draft'],                         // master | human retry
  done:              [],
};
const TASK_STATUSES = new Set(Object.keys(TASK_TRANSITIONS));

// Statuses that count against a role's maxConcurrent budget.
const ACTIVE_WORKER_STATUSES = new Set(['spawning', 'in_progress']);
const ACTIVE_REVIEWER_STATUSES = new Set(['reviewing']);

const DEFAULT_POLICY = Object.freeze({
  autoSpawnWorkers: true,
  autoSpawnReviewers: true,
  autoMerge: true,
  maxAttempts: 3,
  isolation: 'worktree', // 'worktree' | 'none' (shared dir — only safe with maxConcurrent 1 or disjoint files)
});

const DEFAULT_ROLE_LIMITS = Object.freeze({ worker: 4, reviewer: 2 });

function orchDir(projectPath) { return path.join(projectPath, ORCH_DIRNAME); }
function runsRoot(projectPath) { return path.join(orchDir(projectPath), RUNS_DIRNAME); }
function runDir(projectPath, runId) { return path.join(runsRoot(projectPath), runId); }
function tasksDir(rDir) { return path.join(rDir, 'tasks'); }
function worktreesRoot(projectPath) { return path.join(orchDir(projectPath), WORKTREES_DIRNAME); }

function isPlainObject(o) { return o !== null && typeof o === 'object' && !Array.isArray(o); }

function readJsonSafe(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function writeJsonAtomic(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.' + crypto.randomBytes(4).toString('hex') + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, file);
}

// --- validation -----------------------------------------------------------

function validateRun(run) {
  if (!isPlainObject(run)) return 'run.json is not an object';
  if (typeof run.id !== 'string' || !RUN_ID_RE.test(run.id)) return 'invalid run id';
  if (typeof run.title !== 'string' || !run.title.trim()) return 'missing title';
  if (!RUN_STATUSES.has(run.status)) return `invalid run status: ${run.status}`;
  if (!isPlainObject(run.roles)) return 'missing roles';
  for (const [role, cfg] of Object.entries(run.roles)) {
    if (!ROLE_RE.test(role)) return `invalid role name: ${role}`;
    if (!isPlainObject(cfg)) return `invalid role config: ${role}`;
  }
  return null;
}

function validateTask(task) {
  if (!isPlainObject(task)) return 'task is not an object';
  if (typeof task.id !== 'string' || !TASK_ID_RE.test(task.id)) return 'invalid task id';
  if (typeof task.title !== 'string' || !task.title.trim()) return 'missing title';
  if (!TASK_STATUSES.has(task.status)) return `invalid status: ${task.status}`;
  if (task.kind !== undefined && !TASK_KINDS.has(task.kind)) return `invalid kind: ${task.kind}`;
  if (task.dependsOn !== undefined) {
    if (!Array.isArray(task.dependsOn)) return 'dependsOn must be an array';
    for (const d of task.dependsOn) {
      if (typeof d !== 'string' || !TASK_ID_RE.test(d)) return `invalid dependency: ${d}`;
    }
  }
  return null;
}

// --- reading --------------------------------------------------------------

function listRunIds(projectPath) {
  try {
    return fs.readdirSync(runsRoot(projectPath), { withFileTypes: true })
      .filter(e => e.isDirectory() && RUN_ID_RE.test(e.name))
      .map(e => e.name);
  } catch { return []; }
}

function readRun(projectPath, runId) {
  if (!RUN_ID_RE.test(runId || '')) return null;
  const run = readJsonSafe(path.join(runDir(projectPath, runId), 'run.json'));
  if (!run || validateRun(run)) return null;
  return run;
}

function readTasks(projectPath, runId) {
  const dir = tasksDir(runDir(projectPath, runId));
  let names = [];
  try { names = fs.readdirSync(dir).filter(f => f.endsWith('.json')); } catch { return []; }
  const tasks = [];
  for (const name of names) {
    const task = readJsonSafe(path.join(dir, name));
    if (task && !validateTask(task) && name === task.id + '.json') tasks.push(task);
  }
  tasks.sort((a, b) => a.id.localeCompare(b.id));
  return tasks;
}

function readTask(projectPath, runId, taskId) {
  if (!TASK_ID_RE.test(taskId || '')) return null;
  const task = readJsonSafe(path.join(tasksDir(runDir(projectPath, runId)), taskId + '.json'));
  if (!task || validateTask(task)) return null;
  return task;
}

// Read the last `limit` events without loading unbounded history.
function readEvents(projectPath, runId, limit = 200) {
  const file = path.join(runDir(projectPath, runId), 'events.jsonl');
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const lines = raw.split('\n').filter(Boolean);
  const out = [];
  for (const line of lines.slice(-limit)) {
    try { out.push(JSON.parse(line)); } catch {}
  }
  return out;
}

// --- writing --------------------------------------------------------------

function writeRun(projectPath, run) {
  const err = validateRun(run);
  if (err) return { ok: false, error: err };
  writeJsonAtomic(path.join(runDir(projectPath, run.id), 'run.json'), run);
  return { ok: true };
}

function writeTask(projectPath, runId, task) {
  const err = validateTask(task);
  if (err) return { ok: false, error: err };
  writeJsonAtomic(path.join(tasksDir(runDir(projectPath, runId)), task.id + '.json'), task);
  return { ok: true };
}

function appendEvent(projectPath, runId, event) {
  const file = path.join(runDir(projectPath, runId), 'events.jsonl');
  const entry = { ts: new Date().toISOString(), ...event };
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify(entry) + '\n');
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function isTransitionAllowed(from, to) {
  const allowed = TASK_TRANSITIONS[from];
  return Array.isArray(allowed) && allowed.includes(to);
}

// Optimistic status transition: re-reads the task, asserts the status still
// matches `from`, applies `patch`, writes atomically, logs an event.
function transitionTask(projectPath, runId, taskId, from, to, patch, actor) {
  const task = readTask(projectPath, runId, taskId);
  if (!task) return { ok: false, error: `task not found: ${taskId}` };
  if (task.status !== from) {
    return { ok: false, error: `status conflict: expected ${from}, found ${task.status}`, conflict: true };
  }
  if (!isTransitionAllowed(from, to)) {
    return { ok: false, error: `illegal transition: ${from} → ${to}` };
  }
  const next = { ...task, ...(patch || {}), status: to };
  const wrote = writeTask(projectPath, runId, next);
  if (!wrote.ok) return wrote;
  appendEvent(projectPath, runId, {
    type: 'task-transition', task: taskId, from, to,
    actor: actor || 'switchboard',
  });
  return { ok: true, task: next };
}

// --- run scaffolding ------------------------------------------------------

function slugify(text) {
  return String(text).toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'run';
}

function newRunId(title) {
  const date = new Date().toISOString().slice(0, 10);
  const suffix = crypto.randomBytes(2).toString('hex');
  return `${date}-${slugify(title)}-${suffix}`;
}

// Creates the directory skeleton + run.json for a new run. Roles must map
// role name → { profileId, maxConcurrent? }. Returns { ok, run, dir }.
function createRun(projectPath, { title, goal, roles, policy, integrationBranch }) {
  if (typeof title !== 'string' || !title.trim()) return { ok: false, error: 'title required' };
  if (!isPlainObject(roles) || !roles.master || !roles.worker || !roles.reviewer) {
    return { ok: false, error: 'roles must define master, worker and reviewer' };
  }
  const id = newRunId(title);
  const run = {
    id,
    title: title.trim(),
    goal: typeof goal === 'string' ? goal : '',
    status: 'planning',
    createdAt: new Date().toISOString(),
    masterSessionId: null,
    integrationBranch: integrationBranch || `teams/${id}`,
    roles: {},
    policy: { ...DEFAULT_POLICY, ...(isPlainObject(policy) ? policy : {}) },
  };
  for (const [role, cfg] of Object.entries(roles)) {
    if (!ROLE_RE.test(role) || !isPlainObject(cfg)) return { ok: false, error: `invalid role: ${role}` };
    run.roles[role] = {
      profileId: typeof cfg.profileId === 'string' ? cfg.profileId : null,
      maxConcurrent: Number.isInteger(cfg.maxConcurrent) && cfg.maxConcurrent > 0
        ? Math.min(cfg.maxConcurrent, 16)
        : (DEFAULT_ROLE_LIMITS[role] || 1),
    };
  }
  const err = validateRun(run);
  if (err) return { ok: false, error: err };
  const dir = runDir(projectPath, id);
  for (const sub of ['tasks', 'reviews', 'prompts']) {
    fs.mkdirSync(path.join(dir, sub), { recursive: true });
  }
  writeJsonAtomic(path.join(dir, 'run.json'), run);
  appendEvent(projectPath, id, { type: 'run-created', title: run.title, actor: 'switchboard' });
  return { ok: true, run, dir };
}

// Dependencies satisfied = every dependsOn task is done.
function depsSatisfied(task, tasksById) {
  for (const dep of task.dependsOn || []) {
    const d = tasksById.get(dep);
    if (!d || d.status !== 'done') return false;
  }
  return true;
}

// Roll-up used by the GUI and by spawn decisions.
function summarizeTasks(tasks) {
  const byStatus = {};
  for (const s of TASK_STATUSES) byStatus[s] = 0;
  let leaves = 0, leavesDone = 0;
  for (const t of tasks) {
    byStatus[t.status] = (byStatus[t.status] || 0) + 1;
    if ((t.kind || 'leaf') === 'leaf') {
      leaves++;
      if (t.status === 'done') leavesDone++;
    }
  }
  return { total: tasks.length, byStatus, leaves, leavesDone };
}

module.exports = {
  ORCH_DIRNAME, RUNS_DIRNAME, WORKTREES_DIRNAME,
  RUN_ID_RE, TASK_ID_RE,
  TASK_TRANSITIONS, TASK_STATUSES, RUN_STATUSES,
  ACTIVE_WORKER_STATUSES, ACTIVE_REVIEWER_STATUSES,
  DEFAULT_POLICY,
  orchDir, runsRoot, runDir, worktreesRoot,
  readJsonSafe, writeJsonAtomic,
  validateRun, validateTask,
  listRunIds, readRun, readTasks, readTask, readEvents,
  writeRun, writeTask, appendEvent,
  isTransitionAllowed, transitionTask,
  createRun, newRunId, slugify,
  depsSatisfied, summarizeTasks,
};
