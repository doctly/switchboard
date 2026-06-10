// orch-watcher.js — watches .switchboard/runs/ in each registered project
// and turns file changes into in-memory state + events.
//
// Level-triggered by design: consumers (spawner, GUI) receive a full,
// freshly-scanned snapshot per project and reconcile against it, so a missed
// fs event can never wedge the system — the next event (or poll tick) heals
// it. We deliberately watch runs/ only, NOT the whole .switchboard dir:
// task worktrees live under .switchboard/worktrees and generate heavy fs
// traffic (installs, builds) that must not thrash the scanner.
//
// Events emitted:
//   'state'        (projectPath, snapshot)            — after every rescan that changed anything
//   'task-changed' (projectPath, runId, task, prev)   — per-task status delta (prev null = new)
//   'run-changed'  (projectPath, runId, run, prev)    — run.json delta (prev null = new)

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const proto = require('./orch-protocol');

const DEBOUNCE_MS = 150;
const POLL_MS = 2500; // fallback + waiting-for-dir-to-exist cadence

class OrchWatcher extends EventEmitter {
  constructor({ log } = {}) {
    super();
    this.log = log || { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
    // projectPath → { watcher, pollTimer, debounceTimer, snapshot }
    this._projects = new Map();
    this._disposed = false;
  }

  watchedProjects() { return Array.from(this._projects.keys()); }

  watchProject(projectPath) {
    if (this._disposed || !projectPath) return;
    const key = path.resolve(projectPath);
    if (this._projects.has(key)) return;
    const entry = { watcher: null, pollTimer: null, debounceTimer: null, snapshot: null };
    this._projects.set(key, entry);
    this._attach(key, entry);
    this._rescan(key);
  }

  unwatchProject(projectPath) {
    const key = path.resolve(projectPath);
    const entry = this._projects.get(key);
    if (!entry) return;
    this._detach(entry);
    this._projects.delete(key);
  }

  dispose() {
    this._disposed = true;
    for (const entry of this._projects.values()) this._detach(entry);
    this._projects.clear();
    this.removeAllListeners();
  }

  getSnapshot(projectPath) {
    const entry = this._projects.get(path.resolve(projectPath));
    return entry ? entry.snapshot : null;
  }

  getAllSnapshots() {
    const out = {};
    for (const [key, entry] of this._projects) {
      if (entry.snapshot) out[key] = entry.snapshot;
    }
    return out;
  }

  // Force an immediate rescan (used by IPC handlers right after they write).
  refresh(projectPath) {
    const key = path.resolve(projectPath);
    if (this._projects.has(key)) this._rescan(key);
  }

  _detach(entry) {
    if (entry.watcher) { try { entry.watcher.close(); } catch {} entry.watcher = null; }
    if (entry.pollTimer) { clearInterval(entry.pollTimer); entry.pollTimer = null; }
    if (entry.debounceTimer) { clearTimeout(entry.debounceTimer); entry.debounceTimer = null; }
  }

  _attach(key, entry) {
    const runsDir = proto.runsRoot(key);
    if (entry.watcher) return;
    if (fs.existsSync(runsDir)) {
      try {
        entry.watcher = fs.watch(runsDir, { recursive: true }, () => this._scheduleRescan(key));
        entry.watcher.on('error', (err) => {
          this.log.warn(`[orch] watcher error for ${key}: ${err.message}; falling back to polling`);
          try { entry.watcher.close(); } catch {}
          entry.watcher = null;
          this._ensurePolling(key, entry);
        });
        // Watcher attached — polling no longer needed.
        if (entry.pollTimer) { clearInterval(entry.pollTimer); entry.pollTimer = null; }
        return;
      } catch (err) {
        this.log.warn(`[orch] fs.watch failed for ${key}: ${err.message}; polling instead`);
      }
    }
    this._ensurePolling(key, entry);
  }

  _ensurePolling(key, entry) {
    if (entry.pollTimer) return;
    entry.pollTimer = setInterval(() => {
      // Try to upgrade to a real watcher once the runs dir appears.
      this._attach(key, entry);
      this._rescan(key);
    }, POLL_MS);
    if (entry.pollTimer.unref) entry.pollTimer.unref();
  }

  _scheduleRescan(key) {
    const entry = this._projects.get(key);
    if (!entry) return;
    if (entry.debounceTimer) clearTimeout(entry.debounceTimer);
    entry.debounceTimer = setTimeout(() => {
      entry.debounceTimer = null;
      this._rescan(key);
    }, DEBOUNCE_MS);
  }

  _rescan(key) {
    const entry = this._projects.get(key);
    if (!entry) return;
    let snapshot;
    try {
      snapshot = scanProject(key);
    } catch (err) {
      this.log.error(`[orch] rescan failed for ${key}: ${err.message}`);
      return;
    }
    const prev = entry.snapshot;
    entry.snapshot = snapshot;
    if (prev && JSON.stringify(prev) === JSON.stringify(snapshot)) return; // nothing changed

    // Granular deltas for consumers that want them (nudger, logging).
    const prevRuns = new Map((prev?.runs || []).map(r => [r.run.id, r]));
    for (const cur of snapshot.runs) {
      const old = prevRuns.get(cur.run.id);
      if (!old || JSON.stringify(old.run) !== JSON.stringify(cur.run)) {
        this.emit('run-changed', key, cur.run.id, cur.run, old ? old.run : null);
      }
      const oldTasks = new Map((old?.tasks || []).map(t => [t.id, t]));
      for (const task of cur.tasks) {
        const oldTask = oldTasks.get(task.id);
        if (!oldTask || oldTask.status !== task.status) {
          this.emit('task-changed', key, cur.run.id, task, oldTask || null);
        }
      }
    }
    this.emit('state', key, snapshot);
  }
}

function scanProject(projectPath) {
  const runs = [];
  for (const runId of proto.listRunIds(projectPath)) {
    const run = proto.readRun(projectPath, runId);
    if (!run) continue;
    const tasks = proto.readTasks(projectPath, runId);
    runs.push({ run, tasks, summary: proto.summarizeTasks(tasks) });
  }
  runs.sort((a, b) => (b.run.createdAt || '').localeCompare(a.run.createdAt || ''));
  return { projectPath, scannedAt: new Date().toISOString(), runs };
}

module.exports = { OrchWatcher, scanProject, DEBOUNCE_MS, POLL_MS };
