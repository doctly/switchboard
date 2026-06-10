// orch-ipc.js — wires the Agent Teams orchestration (watcher + spawner +
// run scaffolding) into Electron IPC. Switchboard's role here is strictly
// "executor + visualizer": every handler either reads protocol files, writes
// a human-initiated transition through the same protocol the agents use, or
// spawns a session. No orchestration decisions live here.

const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

const proto = require('./orch-protocol');
const wt = require('./worktree-manager');
const tpl = require('./orch-templates');
const { OrchWatcher } = require('./orch-watcher');
const { OrchSpawner } = require('./orch-spawner');
const { assertPathAllowed, addAllowedRoot } = require('./path-guard');
const { encodeProjectPath } = require('./encode-project-path');

let PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');
function setProjectsDirForTesting(dir) { PROJECTS_DIR = dir; }
const PUSH_THROTTLE_MS = 300;

// Human-initiated task actions → allowed target status. Every action still
// passes the protocol's transition table, so the GUI can't corrupt state.
const TASK_ACTIONS = {
  'to-ready': 'ready',
  'retry': 'ready',
  'approve': 'approved',
  'request-changes': 'changes_requested',
  'mark-done': 'done',
  'block': 'blocked',
};

const RUN_ACTIONS = {
  pause: 'paused',
  resume: 'active',
  abandon: 'abandoned',
  done: 'done',
};

// Pre-seed a session JSONL (slug = runId) so the sidebar groups team
// sessions under one collapsible row and `claude --resume` finds history.
function seedSessionJsonl({ sessionId, cwd, slug, text }) {
  try {
    const folder = encodeProjectPath(cwd);
    const dir = path.join(PROJECTS_DIR, folder);
    fs.mkdirSync(dir, { recursive: true });
    const msgId = crypto.randomUUID();
    const timestamp = new Date().toISOString();
    const snapshot = JSON.stringify({
      type: 'file-history-snapshot',
      messageId: msgId,
      snapshot: { messageId: msgId, trackedFileBackups: {}, timestamp },
      isSnapshotUpdate: false,
    });
    const assistantMsg = JSON.stringify({
      parentUuid: null, isSidechain: false, userType: 'external',
      cwd, sessionId, version: '1.0.0', slug,
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text }] },
      uuid: msgId, timestamp,
    });
    fs.writeFileSync(path.join(dir, `${sessionId}.jsonl`), snapshot + '\n' + assistantMsg + '\n');
    return true;
  } catch {
    return false;
  }
}

// deps: { openTerminal, sendInput, isSessionActive, isSessionBusy, getMainWindow }
// deps.ipcMain is injectable so the whole IPC surface is testable without
// Electron (tests pass a recorder; production falls back to the real one).
function init(log, deps) {
  const ipcMain = deps.ipcMain || require('electron').ipcMain;
  const watcher = new OrchWatcher({ log });
  const spawner = new OrchSpawner({
    watcher,
    log,
    deps: {
      openTerminal: deps.openTerminal,
      sendInput: deps.sendInput,
      isSessionActive: deps.isSessionActive,
      isSessionBusy: deps.isSessionBusy,
      seedSessionJsonl,
      ensureTaskWorktree: wt.ensureTaskWorktree,
      rolePrompt: tpl.rolePrompt,
    },
  });
  spawner.start();

  // Push state to the renderer, throttled — bursts of task updates collapse
  // into one IPC message carrying all watched projects' snapshots.
  let pushTimer = null;
  watcher.on('state', () => {
    if (pushTimer) return;
    pushTimer = setTimeout(() => {
      pushTimer = null;
      const win = deps.getMainWindow();
      if (win && !win.isDestroyed()) {
        win.webContents.send('orchestration-updated', watcher.getAllSnapshots());
      }
    }, PUSH_THROTTLE_MS);
    if (pushTimer.unref) pushTimer.unref();
  });

  function checkedProject(projectPath, mode = 'read') {
    const check = assertPathAllowed(projectPath, mode);
    if (!check.ok) return null;
    return check.resolved;
  }

  ipcMain.handle('orch:watch-projects', (_e, projectPaths) => {
    if (!Array.isArray(projectPaths)) return { ok: false, error: 'projectPaths must be an array' };
    for (const p of projectPaths.slice(0, 64)) {
      const resolved = checkedProject(p);
      if (resolved && fs.existsSync(resolved)) watcher.watchProject(resolved);
    }
    return { ok: true, state: watcher.getAllSnapshots() };
  });

  ipcMain.handle('orch:get-state', () => watcher.getAllSnapshots());

  ipcMain.handle('orch:get-run', (_e, projectPath, runId) => {
    const resolved = checkedProject(projectPath);
    if (!resolved) return { ok: false, error: 'project not allowed' };
    const run = proto.readRun(resolved, runId);
    if (!run) return { ok: false, error: 'run not found' };
    const tasks = proto.readTasks(resolved, runId);
    const events = proto.readEvents(resolved, runId, 200);
    let plan = null;
    try { plan = fs.readFileSync(path.join(proto.runDir(resolved, runId), 'plan.md'), 'utf8'); } catch {}
    return { ok: true, run, tasks, events, plan, summary: proto.summarizeTasks(tasks) };
  });

  ipcMain.handle('orch:read-task-file', (_e, projectPath, runId, taskId, which) => {
    const resolved = checkedProject(projectPath);
    if (!resolved) return { ok: false, error: 'project not allowed' };
    if (!proto.RUN_ID_RE.test(runId || '') || !proto.TASK_ID_RE.test(taskId || '')) {
      return { ok: false, error: 'invalid id' };
    }
    const rDir = proto.runDir(resolved, runId);
    let file;
    if (which === 'spec') file = path.join(rDir, 'tasks', `${taskId}.spec.md`);
    else if (typeof which === 'string' && /^reviews\/[A-Za-z0-9._-]+\.md$/.test(which)) {
      file = path.join(rDir, which);
    } else return { ok: false, error: 'invalid file selector' };
    try {
      return { ok: true, content: fs.readFileSync(file, 'utf8'), path: file };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('orch:create-run', async (_e, projectPath, opts) => {
    const resolved = checkedProject(projectPath, 'write');
    if (!resolved) return { ok: false, error: 'project not allowed' };
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
      return { ok: false, error: 'project directory does not exist' };
    }
    const policy = opts?.policy || {};
    const isolation = policy.isolation || 'worktree';
    if (isolation === 'worktree' && !(await wt.isGitRepo(resolved))) {
      return { ok: false, error: 'project is not a git repository (required for worktree isolation)' };
    }

    const created = proto.createRun(resolved, {
      title: opts?.title, goal: opts?.goal, roles: opts?.roles, policy,
    });
    if (!created.ok) return created;
    const { run } = created;

    try {
      tpl.ensureGuidelines(resolved);
      tpl.ensureOrchGitignore(resolved);
      tpl.installCommands(resolved);
      if (isolation === 'worktree') {
        const iw = await wt.ensureIntegrationWorktree(resolved, run.id, run.integrationBranch);
        if (!iw.ok) {
          proto.appendEvent(resolved, run.id, { type: 'note', actor: 'switchboard', text: `integration worktree failed: ${iw.error}` });
        }
      }
    } catch (err) {
      log.error(`[orch] run scaffolding failed: ${err.message}`);
    }

    // Spawn the master session — the only interactive role.
    const masterSessionId = crypto.randomUUID();
    const seeded = seedSessionJsonl({
      sessionId: masterSessionId, cwd: resolved, slug: run.id, text: tpl.masterWelcome(run),
    });
    run.masterSessionId = masterSessionId;
    proto.writeRun(resolved, run);

    const masterCfg = run.roles.master || {};
    const res = await deps.openTerminal(masterSessionId, resolved, !seeded, {
      profileId: masterCfg.profileId || undefined,
      permissionMode: masterCfg.permissionMode || 'acceptEdits',
      initialPrompt: tpl.masterBootPrompt(run),
      appendSystemPrompt: tpl.rolePrompt('master', run, resolved, null),
    });
    if (!res || !res.ok) {
      proto.appendEvent(resolved, run.id, { type: 'note', actor: 'switchboard', text: `master spawn failed: ${res?.error}` });
      return { ok: false, error: `run created but master session failed to start: ${res?.error}`, run };
    }
    proto.appendEvent(resolved, run.id, { type: 'master-spawned', sessionId: masterSessionId });

    addAllowedRoot(resolved);
    watcher.watchProject(resolved);
    watcher.refresh(resolved);
    log.info(`[orch] run ${run.id} created in ${resolved}; master ${masterSessionId}`);
    return { ok: true, run, masterSessionId };
  });

  ipcMain.handle('orch:run-action', (_e, projectPath, runId, action) => {
    const resolved = checkedProject(projectPath, 'write');
    if (!resolved) return { ok: false, error: 'project not allowed' };
    const target = RUN_ACTIONS[action];
    if (!target) return { ok: false, error: `unknown action: ${action}` };
    const run = proto.readRun(resolved, runId);
    if (!run) return { ok: false, error: 'run not found' };
    if (run.status === target) return { ok: true, run };
    const wrote = proto.writeRun(resolved, { ...run, status: target });
    if (!wrote.ok) return wrote;
    proto.appendEvent(resolved, runId, { type: 'run-status', from: run.status, to: target, actor: 'user' });
    watcher.refresh(resolved);
    return { ok: true, run: { ...run, status: target } };
  });

  ipcMain.handle('orch:task-action', (_e, projectPath, runId, taskId, action) => {
    const resolved = checkedProject(projectPath, 'write');
    if (!resolved) return { ok: false, error: 'project not allowed' };
    const target = TASK_ACTIONS[action];
    if (!target) return { ok: false, error: `unknown action: ${action}` };
    const task = proto.readTask(resolved, runId, taskId);
    if (!task) return { ok: false, error: 'task not found' };
    if (!proto.isTransitionAllowed(task.status, target)) {
      return { ok: false, error: `cannot ${action} a task in status ${task.status}` };
    }
    const r = proto.transitionTask(resolved, runId, taskId, task.status, target,
      action === 'retry' ? { attempts: 0 } : {}, 'user');
    watcher.refresh(resolved);
    return r;
  });

  return {
    watcher,
    spawner,
    dispose() {
      spawner.stop();
      watcher.dispose();
    },
  };
}

module.exports = { init, seedSessionJsonl, setProjectsDirForTesting, TASK_ACTIONS, RUN_ACTIONS };
