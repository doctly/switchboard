// Visual / functional UI test: boots the REAL Electron app against a
// sandboxed fake home directory, drives it over the Chrome DevTools
// Protocol, and verifies the Agent Teams view renders live orchestration
// state and that human actions round-trip through the file protocol.
//
// Sandbox: USERPROFILE/APPDATA/LOCALAPPDATA point at a temp dir, so the app
// sees a fake ~/.claude with one seeded session and never touches the real
// user's data. No real `claude` is ever spawned (the run has no active
// sessions; spawn paths are covered by orch-e2e.test.js).
//
// A screenshot of the board is written to test/artifacts/ for human eyes.
//
// Set SB_SKIP_UI_E2E=1 to skip (e.g. on headless CI without a display).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const http = require('http');
const proto = require('../orch-protocol');

const APP_DIR = path.join(__dirname, '..');
const SKIP = process.env.SB_SKIP_UI_E2E === '1';

let WebSocket = null;
let electronPath = null;
try {
  WebSocket = require('ws');
  electronPath = require('electron'); // returns the binary path under plain node
} catch {}

function makeSandbox() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-ui-home-'));
  for (const sub of ['AppData/Roaming', 'AppData/Local', '.claude/projects']) {
    fs.mkdirSync(path.join(home, sub), { recursive: true });
  }

  // The orchestrated project: a real git repo with a run mid-flight.
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-ui-proj-'));
  const git = (args) => execFileSync('git', args, { cwd: project, windowsHide: true });
  git(['init', '-b', 'main']);
  git(['config', 'user.email', 't@t']);
  git(['config', 'user.name', 't']);
  fs.writeFileSync(path.join(project, 'README.md'), 'ui e2e project\n');
  git(['add', '.']);
  git(['commit', '-m', 'init']);

  // Seed one session JSONL so the app discovers the project (and allows it).
  const folder = project.replace(/[^a-zA-Z0-9]/g, '-');
  const projDir = path.join(home, '.claude', 'projects', folder);
  fs.mkdirSync(projDir, { recursive: true });
  const seedSession = 'aaaaaaaa-1111-2222-3333-444444444444';
  const ts = new Date().toISOString();
  fs.writeFileSync(path.join(projDir, seedSession + '.jsonl'), [
    JSON.stringify({ type: 'user', cwd: project, sessionId: seedSession, message: { role: 'user', content: 'seed session' }, uuid: 'u1', timestamp: ts }),
    JSON.stringify({ type: 'assistant', cwd: project, sessionId: seedSession, message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] }, uuid: 'a1', timestamp: ts }),
  ].join('\n') + '\n');

  // A run mid-flight with tasks across the board columns.
  const created = proto.createRun(project, {
    title: 'UI demo run',
    goal: 'render everything',
    roles: {
      master: { profileId: 'anthropic' },
      worker: { profileId: 'deepseek', maxConcurrent: 3 },
      reviewer: { profileId: 'anthropic' },
    },
    // Deterministic fixture: the app's live spawner must not dispatch real
    // `claude` sessions during the UI test (the spawn pipeline is covered by
    // orch-e2e.test.js with fake-claude).
    policy: { autoSpawnWorkers: false, autoSpawnReviewers: false },
  });
  const run = { ...created.run, status: 'active' };
  proto.writeRun(project, run);
  fs.writeFileSync(path.join(created.dir, 'plan.md'), '# UI demo plan\n\nLayered delivery.\n');
  proto.writeTask(project, run.id, { id: 'C-01', title: 'Chunk one', status: 'in_progress', kind: 'chunk' });
  proto.writeTask(project, run.id, { id: 'T-1', title: 'Draft task', status: 'draft', kind: 'leaf', parent: 'C-01' });
  proto.writeTask(project, run.id, { id: 'T-2', title: 'Working task', status: 'in_progress', kind: 'leaf', parent: 'C-01', attempts: 1, sessionIds: ['bbbbbbbb-1111-2222-3333-444444444444'] });
  proto.writeTask(project, run.id, { id: 'T-3', title: 'Reviewed task', status: 'needs_review', kind: 'leaf', parent: 'C-01', attempts: 1 });
  proto.writeTask(project, run.id, { id: 'T-4', title: 'Finished task', status: 'done', kind: 'leaf', parent: 'C-01', attempts: 1 });

  return { home, project, run };
}

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP timeout: ${method}`));
        }
      }, 15_000);
    });
  }
  // Evaluate an expression in the page; returns the JSON value.
  async eval(expression) {
    const res = await this.send('Runtime.evaluate', {
      expression, returnByValue: true, awaitPromise: true,
    });
    if (res.exceptionDetails) {
      throw new Error('page eval failed: ' + (res.exceptionDetails.exception?.description || res.exceptionDetails.text));
    }
    return res.result?.value;
  }
}

function httpGetJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

async function waitUntil(fn, { timeoutMs = 30_000, label = 'condition', intervalMs = 250 } = {}) {
  const start = Date.now();
  let lastErr;
  while (Date.now() - start < timeoutMs) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (err) { lastErr = err; }
    await new Promise(r => setTimeout(r, intervalMs));
  }
  throw new Error(`timeout waiting for ${label}${lastErr ? ` (last error: ${lastErr.message})` : ''}`);
}

test('Electron UI renders the Agent Teams board and applies a human action',
  { timeout: 180_000, skip: SKIP || !electronPath || !WebSocket ? 'electron/ws unavailable or SB_SKIP_UI_E2E=1' : false },
  async () => {
    const { home, project, run } = makeSandbox();
    const env = {
      ...process.env,
      USERPROFILE: home,
      HOME: home,
      APPDATA: path.join(home, 'AppData', 'Roaming'),
      LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
      SB_UI_E2E: '1',
    };
    const child = spawn(electronPath, [APP_DIR, '--remote-debugging-port=0'], {
      cwd: APP_DIR, env, windowsHide: true,
    });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    let cdp = null;
    try {
      // Find the debugger endpoint from electron's stderr banner.
      const port = await waitUntil(() => {
        const m = stderr.match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//);
        return m ? Number(m[1]) : null;
      }, { label: 'remote debugging port', timeoutMs: 40_000 });

      // Find the app window target (not devtools, not service workers).
      const target = await waitUntil(async () => {
        const targets = await httpGetJson(`http://127.0.0.1:${port}/json/list`);
        return targets.find(t => t.type === 'page' && /index\.html/.test(t.url));
      }, { label: 'page target' });

      const ws = new WebSocket(target.webSocketDebuggerUrl, { maxPayload: 64 * 1024 * 1024 });
      await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
      cdp = new Cdp(ws);
      await cdp.send('Runtime.enable');
      await cdp.send('Page.enable');

      // App booted: api bridge + teams tab present, project discovered.
      await waitUntil(() => cdp.eval(`!!(window.api && document.querySelector('.sidebar-tab[data-tab="teams"]'))`),
        { label: 'app boot' });
      await waitUntil(() => cdp.eval(`typeof cachedProjects !== 'undefined' && cachedProjects.length > 0`),
        { label: 'project discovery', timeoutMs: 40_000 });

      // Open the Teams tab → run appears in the sidebar.
      await cdp.eval(`document.querySelector('.sidebar-tab[data-tab="teams"]').click()`);
      await waitUntil(() => cdp.eval(`document.querySelectorAll('.orch-run-row').length`),
        { label: 'run row in sidebar' });
      const runTitle = await cdp.eval(`document.querySelector('.orch-run-title').textContent`);
      assert.equal(runTitle, 'UI demo run');

      // Select the run → board renders with tasks in the right columns.
      await cdp.eval(`document.querySelector('.orch-run-row').click()`);
      await waitUntil(() => cdp.eval(`document.querySelectorAll('#orch-board .orch-card').length >= 4`),
        { label: 'board cards' });
      const board = await cdp.eval(`(() => {
        const out = {};
        for (const col of document.querySelectorAll('.orch-board-col')) {
          out[col.dataset.col] = [...col.querySelectorAll('.orch-card')].map(c => c.dataset.taskId);
        }
        return out;
      })()`);
      assert.deepEqual(board.backlog, ['T-1']);
      assert.deepEqual(board.progress, ['T-2']);
      assert.deepEqual(board.review, ['T-3']);
      assert.deepEqual(board.done, ['T-4']);

      // Header shows title, status and role→profile badges.
      const headerText = await cdp.eval(`document.getElementById('orch-viewer-header').textContent`);
      assert.match(headerText, /UI demo run/);
      assert.match(headerText, /active/);
      assert.match(headerText, /worker ×3: deepseek/);
      assert.match(headerText, /1\/4 tasks done/); // leaves done / leaves

      // Human action: "Mark ready" on the draft card → file protocol →
      // watcher → push → board re-render, all the way through the real app.
      await cdp.eval(`(() => {
        const card = document.querySelector('.orch-card[data-task-id="T-1"]');
        [...card.querySelectorAll('button')].find(b => b.textContent === 'Mark ready').click();
      })()`);
      await waitUntil(() => proto.readTask(project, run.id, 'T-1')?.status === 'ready',
        { label: 'task file transitioned by GUI' });
      await waitUntil(() => cdp.eval(
        `[...document.querySelectorAll('.orch-board-col[data-col="ready"] .orch-card')].some(c => c.dataset.taskId === 'T-1')`),
        { label: 'card moved to Ready column' });

      // The GUI action went through the protocol with actor: user.
      const events = proto.readEvents(project, run.id);
      assert.ok(events.some(e => e.type === 'task-transition' && e.task === 'T-1' && e.actor === 'user'));

      // Timeline tab renders events.
      await cdp.eval(`[...document.querySelectorAll('.orch-tab-btn')].find(b => b.textContent === 'Timeline').click()`);
      await waitUntil(() => cdp.eval(`document.querySelectorAll('.orch-event').length`),
        { label: 'timeline events' });

      // Plan tab renders plan.md + tree.
      await cdp.eval(`[...document.querySelectorAll('.orch-tab-btn')].find(b => b.textContent === 'Plan').click()`);
      await waitUntil(() => cdp.eval(`document.querySelectorAll('.orch-tree-node').length >= 5`),
        { label: 'plan tree' });
      const planText = await cdp.eval(`document.getElementById('orch-plan-md').textContent`);
      assert.match(planText, /UI demo plan/);

      // Visual artifact for humans: screenshot of the board.
      await cdp.eval(`[...document.querySelectorAll('.orch-tab-btn')].find(b => b.textContent === 'Board').click()`);
      await new Promise(r => setTimeout(r, 400));
      const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
      const artifacts = path.join(__dirname, 'artifacts');
      fs.mkdirSync(artifacts, { recursive: true });
      fs.writeFileSync(path.join(artifacts, 'agent-teams-board.png'), Buffer.from(shot.data, 'base64'));
    } catch (err) {
      err.message += `\n--- electron stderr (tail) ---\n${stderr.slice(-2000)}`;
      throw err;
    } finally {
      if (cdp) { try { cdp.ws.close(); } catch {} }
      try { child.kill(); } catch {}
      // Give the process a moment to die so temp cleanup doesn't race.
      await new Promise(r => setTimeout(r, 500));
    }
  });
