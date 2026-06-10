// orchestration-view.js — Agent Teams GUI: run list (sidebar), run detail
// (board / plan / timeline) in the main area, and the new-run dialog.
//
// All state comes from main via window.api.orchestration; this file never
// makes orchestration decisions — even human overrides (approve, retry,
// pause) round-trip through the same file protocol the agents use.
//
// DOM is built with createElement/textContent throughout: task titles,
// plan content and event text are agent-written and must never reach
// innerHTML unsanitised (renderer-innerhtml-lint enforces this).

/* global escapeHtml, safeSetHtml, formatDate, openSession, cachedProjects, activeTab */

let orchState = {};            // projectPath → snapshot from main
let orchSelected = null;       // { projectPath, runId }
let orchDetail = null;         // last orch:get-run payload for the selection
let orchDetailTab = 'board';   // board | plan | timeline
let orchRefreshTimer = null;
let orchInitDone = false;

const ORCH_BOARD_COLUMNS = [
  { key: 'backlog',  label: 'Backlog',     statuses: ['draft'] },
  { key: 'ready',    label: 'Ready',       statuses: ['ready'] },
  { key: 'progress', label: 'In progress', statuses: ['spawning', 'in_progress'] },
  { key: 'review',   label: 'Review',      statuses: ['needs_review', 'reviewing', 'changes_requested'] },
  { key: 'merge',    label: 'Merge',       statuses: ['approved', 'merging'] },
  { key: 'done',     label: 'Done',        statuses: ['done'] },
  { key: 'attention', label: 'Attention',  statuses: ['blocked', 'failed'] },
];

const ORCH_STATUS_LABELS = {
  draft: 'draft', ready: 'ready', spawning: 'spawning', in_progress: 'in progress',
  needs_review: 'needs review', reviewing: 'reviewing', changes_requested: 'changes requested',
  approved: 'approved', merging: 'merging', done: 'done', blocked: 'blocked', failed: 'failed',
};

// Actions a human may take per status (must mirror TASK_ACTIONS in orch-ipc.js).
const ORCH_TASK_ACTIONS = {
  draft: [{ action: 'to-ready', label: 'Mark ready' }],
  needs_review: [{ action: 'approve', label: 'Approve (skip review)' }],
  reviewing: [{ action: 'approve', label: 'Force approve' }, { action: 'request-changes', label: 'Request changes' }],
  approved: [{ action: 'mark-done', label: 'Mark done (skip merge)' }],
  blocked: [{ action: 'retry', label: 'Retry' }],
  failed: [{ action: 'retry', label: 'Retry' }],
};

function initOrchestration() {
  if (orchInitDone || !window.api?.orchestration) return;
  orchInitDone = true;
  window.api.orchestration.onUpdated((state) => {
    orchState = state || {};
    if (typeof activeTab !== 'undefined' && activeTab === 'teams') {
      renderTeamsSidebar();
      scheduleOrchDetailRefresh();
    }
  });
}

async function loadTeams() {
  initOrchestration();
  const projectPaths = (typeof cachedProjects !== 'undefined' ? cachedProjects : [])
    .map(p => p.projectPath).filter(Boolean);
  try {
    const res = await window.api.orchestration.watchProjects(projectPaths);
    if (res?.ok) orchState = res.state || {};
  } catch (err) {
    window.api.log?.error('orch watchProjects failed', { err: String(err) });
  }
  renderTeamsSidebar();
  showOrchViewer();
  if (orchSelected) {
    refreshOrchDetail();
  } else {
    renderOrchPlaceholder();
  }
}

function orchAllRuns() {
  const out = [];
  for (const [projectPath, snap] of Object.entries(orchState)) {
    for (const entry of snap.runs || []) out.push({ projectPath, ...entry });
  }
  out.sort((a, b) => (b.run.createdAt || '').localeCompare(a.run.createdAt || ''));
  return out;
}

function orchProjectLabel(projectPath) {
  const parts = String(projectPath).split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || projectPath;
}

// --- sidebar -------------------------------------------------------------

function renderTeamsSidebar() {
  const pane = document.getElementById('teams-content');
  if (!pane) return;
  pane.replaceChildren();

  const newBtn = document.createElement('button');
  newBtn.id = 'orch-new-run-btn';
  newBtn.textContent = '+ New run';
  newBtn.addEventListener('click', showNewRunDialog);
  pane.appendChild(newBtn);

  const runs = orchAllRuns();
  if (runs.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'plans-empty';
    empty.textContent = 'No Agent Teams runs yet. Start one with "+ New run".';
    pane.appendChild(empty);
    return;
  }

  let lastProject = null;
  for (const entry of runs) {
    if (entry.projectPath !== lastProject) {
      lastProject = entry.projectPath;
      const head = document.createElement('div');
      head.className = 'orch-run-project';
      head.textContent = orchProjectLabel(entry.projectPath);
      head.title = entry.projectPath;
      pane.appendChild(head);
    }
    pane.appendChild(buildRunRow(entry));
  }
}

function buildRunRow({ projectPath, run, summary }) {
  const row = document.createElement('div');
  row.className = 'orch-run-row';
  row.dataset.runId = run.id;
  if (orchSelected && orchSelected.runId === run.id && orchSelected.projectPath === projectPath) {
    row.classList.add('active');
  }

  const title = document.createElement('div');
  title.className = 'orch-run-title';
  title.textContent = run.title;
  row.appendChild(title);

  const meta = document.createElement('div');
  meta.className = 'orch-run-meta';
  const chip = document.createElement('span');
  chip.className = `orch-chip orch-run-status-${run.status}`;
  chip.textContent = run.status;
  meta.appendChild(chip);
  const progress = document.createElement('span');
  progress.className = 'orch-run-progress';
  progress.textContent = summary ? `${summary.leavesDone}/${summary.leaves} tasks` : '';
  meta.appendChild(progress);
  row.appendChild(meta);

  row.addEventListener('click', () => {
    orchSelected = { projectPath, runId: run.id };
    renderTeamsSidebar();
    refreshOrchDetail();
  });
  return row;
}

// --- main viewer ---------------------------------------------------------

function showOrchViewer() {
  const orchViewer = document.getElementById('orch-viewer');
  if (!orchViewer) return;
  placeholder.style.display = 'none';
  terminalArea.style.display = 'none';
  planViewer.style.display = 'none';
  statsViewer.style.display = 'none';
  memoryViewer.style.display = 'none';
  settingsViewer.style.display = 'none';
  jsonlViewer.style.display = 'none';
  orchViewer.style.display = 'flex';
}

function hideOrchViewer() {
  const orchViewer = document.getElementById('orch-viewer');
  if (orchViewer) orchViewer.style.display = 'none';
}

function renderOrchPlaceholder() {
  const body = document.getElementById('orch-viewer-body');
  if (!body) return;
  body.replaceChildren();
  const empty = document.createElement('div');
  empty.className = 'plans-empty';
  empty.textContent = 'Select a run from the sidebar, or create a new one.';
  body.appendChild(empty);
  const header = document.getElementById('orch-viewer-header');
  if (header) header.replaceChildren();
}

function scheduleOrchDetailRefresh() {
  if (!orchSelected || orchRefreshTimer) return;
  orchRefreshTimer = setTimeout(() => {
    orchRefreshTimer = null;
    refreshOrchDetail();
  }, 250);
}

async function refreshOrchDetail() {
  if (!orchSelected) return;
  const { projectPath, runId } = orchSelected;
  let res;
  try {
    res = await window.api.orchestration.getRun(projectPath, runId);
  } catch { return; }
  if (!res?.ok) return;
  orchDetail = res;
  renderOrchDetail();
}

function renderOrchDetail() {
  if (!orchDetail || (typeof activeTab !== 'undefined' && activeTab !== 'teams')) return;
  renderOrchHeader();
  const body = document.getElementById('orch-viewer-body');
  if (!body) return;
  body.replaceChildren();
  if (orchDetailTab === 'board') body.appendChild(buildOrchBoard());
  else if (orchDetailTab === 'plan') body.appendChild(buildOrchPlan());
  else body.appendChild(buildOrchTimeline());
}

function renderOrchHeader() {
  const header = document.getElementById('orch-viewer-header');
  if (!header) return;
  const { run, summary } = orchDetail;
  header.replaceChildren();

  const titleWrap = document.createElement('div');
  titleWrap.className = 'orch-header-title-wrap';
  const title = document.createElement('span');
  title.id = 'orch-viewer-title';
  title.textContent = run.title;
  titleWrap.appendChild(title);
  const chip = document.createElement('span');
  chip.className = `orch-chip orch-run-status-${run.status}`;
  chip.textContent = run.status;
  titleWrap.appendChild(chip);

  // role → profile badges, e.g. "master: anthropic · worker ×4: deepseek"
  const roles = document.createElement('span');
  roles.className = 'orch-header-roles';
  roles.textContent = Object.entries(run.roles || {})
    .map(([role, cfg]) => `${role}${cfg.maxConcurrent > 1 ? ` ×${cfg.maxConcurrent}` : ''}: ${cfg.profileId || 'default'}`)
    .join(' · ');
  titleWrap.appendChild(roles);
  header.appendChild(titleWrap);

  const controls = document.createElement('div');
  controls.className = 'orch-header-controls';

  const progress = document.createElement('span');
  progress.className = 'orch-run-progress';
  progress.textContent = summary ? `${summary.leavesDone}/${summary.leaves} tasks done` : '';
  controls.appendChild(progress);

  for (const tab of ['board', 'plan', 'timeline']) {
    const btn = document.createElement('button');
    btn.className = 'orch-tab-btn' + (orchDetailTab === tab ? ' active' : '');
    btn.textContent = tab[0].toUpperCase() + tab.slice(1);
    btn.addEventListener('click', () => { orchDetailTab = tab; renderOrchDetail(); });
    controls.appendChild(btn);
  }

  if (run.masterSessionId) {
    const masterBtn = document.createElement('button');
    masterBtn.className = 'orch-action-btn';
    masterBtn.textContent = 'Master session';
    masterBtn.addEventListener('click', () => orchOpenSession(run.masterSessionId, `${run.title} (master)`));
    controls.appendChild(masterBtn);
  }

  if (['active', 'planning'].includes(run.status)) {
    const pauseBtn = document.createElement('button');
    pauseBtn.className = 'orch-action-btn';
    pauseBtn.textContent = 'Pause';
    pauseBtn.addEventListener('click', () => orchRunAction('pause'));
    controls.appendChild(pauseBtn);
  } else if (run.status === 'paused') {
    const resumeBtn = document.createElement('button');
    resumeBtn.className = 'orch-action-btn';
    resumeBtn.textContent = 'Resume';
    resumeBtn.addEventListener('click', () => orchRunAction('resume'));
    controls.appendChild(resumeBtn);
  }

  header.appendChild(controls);
}

async function orchRunAction(action) {
  if (!orchSelected) return;
  await window.api.orchestration.runAction(orchSelected.projectPath, orchSelected.runId, action);
  refreshOrchDetail();
}

async function orchTaskAction(taskId, action) {
  if (!orchSelected) return;
  const res = await window.api.orchestration.taskAction(orchSelected.projectPath, orchSelected.runId, taskId, action);
  if (!res?.ok && res?.error && typeof setStatus === 'function') setStatus(res.error, 'error');
  refreshOrchDetail();
}

function orchOpenSession(sessionId, label) {
  if (!orchSelected || typeof openSession !== 'function') return;
  // Switch to the sessions tab so the terminal area is visible, then open.
  const sessionsTab = document.querySelector('.sidebar-tab[data-tab="sessions"]');
  if (sessionsTab && typeof activeTab !== 'undefined' && activeTab !== 'sessions') sessionsTab.click();
  openSession({ sessionId, projectPath: orchSelected.projectPath, summary: label || sessionId });
}

// --- board ---------------------------------------------------------------

function buildOrchBoard() {
  const board = document.createElement('div');
  board.id = 'orch-board';
  const tasks = orchDetail.tasks.filter(t => (t.kind || 'leaf') === 'leaf');
  for (const col of ORCH_BOARD_COLUMNS) {
    const colEl = document.createElement('div');
    colEl.className = 'orch-board-col';
    colEl.dataset.col = col.key;
    const head = document.createElement('div');
    head.className = 'orch-board-col-head';
    const colTasks = tasks.filter(t => col.statuses.includes(t.status));
    head.textContent = `${col.label} (${colTasks.length})`;
    colEl.appendChild(head);
    for (const task of colTasks) colEl.appendChild(buildOrchCard(task));
    board.appendChild(colEl);
  }
  return board;
}

function buildOrchCard(task) {
  const card = document.createElement('div');
  card.className = `orch-card orch-card-${task.status}`;
  card.dataset.taskId = task.id;

  const head = document.createElement('div');
  head.className = 'orch-card-head';
  const id = document.createElement('span');
  id.className = 'orch-card-id';
  id.textContent = task.id;
  head.appendChild(id);
  const status = document.createElement('span');
  status.className = `orch-chip orch-status-${task.status}`;
  status.textContent = ORCH_STATUS_LABELS[task.status] || task.status;
  head.appendChild(status);
  card.appendChild(head);

  const title = document.createElement('div');
  title.className = 'orch-card-title';
  title.textContent = task.title;
  card.appendChild(title);

  const meta = document.createElement('div');
  meta.className = 'orch-card-meta';
  const bits = [];
  if (task.parent) bits.push(task.parent);
  if (task.attempts) bits.push(`attempt ${task.attempts}`);
  if (task.reviews?.length) bits.push(`${task.reviews.length} review${task.reviews.length > 1 ? 's' : ''}`);
  if (task.blockedReason) bits.push(task.blockedReason);
  meta.textContent = bits.join(' · ');
  card.appendChild(meta);

  const actions = document.createElement('div');
  actions.className = 'orch-card-actions';
  const lastWorker = (task.sessionIds || []).slice(-1)[0];
  if (lastWorker) {
    const btn = document.createElement('button');
    btn.textContent = 'Worker';
    btn.title = 'Open the worker session terminal';
    btn.addEventListener('click', () => orchOpenSession(lastWorker, `${task.id} worker`));
    actions.appendChild(btn);
  }
  const lastReviewer = (task.reviewSessionIds || []).slice(-1)[0];
  if (lastReviewer) {
    const btn = document.createElement('button');
    btn.textContent = 'Reviewer';
    btn.title = 'Open the reviewer session terminal';
    btn.addEventListener('click', () => orchOpenSession(lastReviewer, `${task.id} reviewer`));
    actions.appendChild(btn);
  }
  const specBtn = document.createElement('button');
  specBtn.textContent = 'Spec';
  specBtn.addEventListener('click', () => orchShowTaskFile(task.id, 'spec', `${task.id} spec`));
  actions.appendChild(specBtn);
  const lastReview = (task.reviews || []).slice(-1)[0];
  if (lastReview?.file) {
    const btn = document.createElement('button');
    btn.textContent = 'Review';
    btn.addEventListener('click', () => orchShowTaskFile(task.id, lastReview.file, `${task.id} review`));
    actions.appendChild(btn);
  }
  for (const { action, label } of ORCH_TASK_ACTIONS[task.status] || []) {
    const btn = document.createElement('button');
    btn.className = 'orch-card-action-primary';
    btn.textContent = label;
    btn.addEventListener('click', () => orchTaskAction(task.id, action));
    actions.appendChild(btn);
  }
  card.appendChild(actions);
  return card;
}

async function orchShowTaskFile(taskId, which, label) {
  if (!orchSelected) return;
  const res = await window.api.orchestration.readTaskFile(
    orchSelected.projectPath, orchSelected.runId, taskId, which);
  showOrchTextModal(label, res?.ok ? res.content : `(${res?.error || 'not found'})`);
}

function showOrchTextModal(title, text) {
  const overlay = document.createElement('div');
  overlay.className = 'orch-modal-overlay';
  const modal = document.createElement('div');
  modal.className = 'orch-modal';
  const head = document.createElement('div');
  head.className = 'orch-modal-head';
  const titleEl = document.createElement('span');
  titleEl.textContent = title;
  head.appendChild(titleEl);
  const close = document.createElement('button');
  close.textContent = '×';
  close.addEventListener('click', () => overlay.remove());
  head.appendChild(close);
  modal.appendChild(head);
  const body = document.createElement('pre');
  body.className = 'orch-modal-body';
  body.textContent = text;
  modal.appendChild(body);
  overlay.appendChild(modal);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
  document.body.appendChild(overlay);
}

// --- plan tab ------------------------------------------------------------

function buildOrchPlan() {
  const wrap = document.createElement('div');
  wrap.id = 'orch-plan';

  const tree = document.createElement('div');
  tree.id = 'orch-plan-tree';
  const tasks = orchDetail.tasks;
  const byParent = new Map();
  for (const t of tasks) {
    const key = t.parent || '';
    if (!byParent.has(key)) byParent.set(key, []);
    byParent.get(key).push(t);
  }
  const addNodes = (parentKey, depth) => {
    for (const t of byParent.get(parentKey) || []) {
      const node = document.createElement('div');
      node.className = 'orch-tree-node';
      node.style.paddingLeft = `${depth * 18}px`;
      const dot = document.createElement('span');
      dot.className = `orch-tree-dot orch-status-${t.status}`;
      node.appendChild(dot);
      const label = document.createElement('span');
      label.className = 'orch-tree-label';
      label.textContent = `${t.id} — ${t.title}`;
      node.appendChild(label);
      const st = document.createElement('span');
      st.className = 'orch-tree-status';
      st.textContent = ORCH_STATUS_LABELS[t.status] || t.status;
      node.appendChild(st);
      tree.appendChild(node);
      addNodes(t.id, depth + 1);
    }
  };
  addNodes('', 0);
  if (tasks.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'plans-empty';
    empty.textContent = 'No tasks yet — the master is still planning.';
    tree.appendChild(empty);
  }
  wrap.appendChild(tree);

  const planEl = document.createElement('div');
  planEl.id = 'orch-plan-md';
  if (orchDetail.plan) {
    // plan.md is agent-written markdown → sanitize before rendering.
    if (window.marked && window.DOMPurify) {
      safeSetHtml(planEl, window.marked.parse(orchDetail.plan));
    } else {
      const pre = document.createElement('pre');
      pre.textContent = orchDetail.plan;
      planEl.appendChild(pre);
    }
  } else {
    const empty = document.createElement('div');
    empty.className = 'plans-empty';
    empty.textContent = 'plan.md has not been written yet.';
    planEl.appendChild(empty);
  }
  wrap.appendChild(planEl);
  return wrap;
}

// --- timeline ------------------------------------------------------------

function buildOrchTimeline() {
  const wrap = document.createElement('div');
  wrap.id = 'orch-timeline';
  const events = [...(orchDetail.events || [])].reverse();
  if (events.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'plans-empty';
    empty.textContent = 'No events yet.';
    wrap.appendChild(empty);
    return wrap;
  }
  for (const evt of events) {
    const row = document.createElement('div');
    row.className = 'orch-event';
    const ts = document.createElement('span');
    ts.className = 'orch-event-ts';
    ts.textContent = (evt.ts || '').replace('T', ' ').slice(0, 19);
    row.appendChild(ts);
    const type = document.createElement('span');
    type.className = 'orch-event-type';
    type.textContent = evt.type || 'note';
    row.appendChild(type);
    const text = document.createElement('span');
    text.className = 'orch-event-text';
    const bits = [];
    if (evt.task) bits.push(evt.task);
    if (evt.from && evt.to) bits.push(`${evt.from} → ${evt.to}`);
    if (evt.actor) bits.push(`by ${evt.actor}`);
    if (evt.sessionId) bits.push(`session ${String(evt.sessionId).slice(0, 8)}`);
    if (evt.text) bits.push(evt.text);
    if (evt.error) bits.push(evt.error);
    if (evt.lines) bits.push(evt.lines.join('; '));
    text.textContent = bits.join(' · ');
    row.appendChild(text);
    wrap.appendChild(row);
  }
  return wrap;
}

// --- new run dialog -------------------------------------------------------

async function showNewRunDialog() {
  const overlay = document.createElement('div');
  overlay.className = 'orch-modal-overlay';
  const modal = document.createElement('div');
  modal.className = 'orch-modal orch-new-run-modal';

  const head = document.createElement('div');
  head.className = 'orch-modal-head';
  const titleEl = document.createElement('span');
  titleEl.textContent = 'New Agent Teams run';
  head.appendChild(titleEl);
  const close = document.createElement('button');
  close.textContent = '×';
  close.addEventListener('click', () => overlay.remove());
  head.appendChild(close);
  modal.appendChild(head);

  const form = document.createElement('div');
  form.className = 'orch-modal-body orch-form';

  const field = (labelText, input) => {
    const wrap = document.createElement('label');
    wrap.className = 'orch-field';
    const lab = document.createElement('span');
    lab.textContent = labelText;
    wrap.appendChild(lab);
    wrap.appendChild(input);
    form.appendChild(wrap);
    return input;
  };

  const projectSel = document.createElement('select');
  const projects = (typeof cachedProjects !== 'undefined' ? cachedProjects : []);
  for (const p of projects) {
    const opt = document.createElement('option');
    opt.value = p.projectPath;
    opt.textContent = p.projectPath;
    projectSel.appendChild(opt);
  }
  field('Project', projectSel);

  const titleInput = document.createElement('input');
  titleInput.type = 'text';
  titleInput.placeholder = 'e.g. Auth refactor';
  field('Run title', titleInput);

  const goalInput = document.createElement('textarea');
  goalInput.rows = 5;
  goalInput.placeholder = 'What should be built? The master agent starts from this.';
  field('Goal', goalInput);

  let profiles = [];
  try { profiles = (await window.api.profiles.list())?.profiles || []; } catch {}
  const profileSelect = (defaultHint) => {
    const sel = document.createElement('select');
    const none = document.createElement('option');
    none.value = '';
    none.textContent = 'Default profile';
    sel.appendChild(none);
    for (const p of profiles) {
      const opt = document.createElement('option');
      opt.value = p.id;
      opt.textContent = p.name;
      if (defaultHint && p.name.toLowerCase().includes(defaultHint)) opt.selected = true;
      sel.appendChild(opt);
    }
    return sel;
  };
  const masterSel = field('Master profile (planner/orchestrator — strongest model)', profileSelect());
  const workerSel = field('Worker profile (implementers — fast/cheap model)', profileSelect());
  const reviewerSel = field('Reviewer profile (adversarial review)', profileSelect());

  const workerCount = document.createElement('input');
  workerCount.type = 'number';
  workerCount.min = '1'; workerCount.max = '16'; workerCount.value = '4';
  field('Max parallel workers', workerCount);

  const isolationSel = document.createElement('select');
  for (const [v, label] of [['worktree', 'Git worktree per task (recommended)'], ['none', 'Shared working dir (no isolation)']]) {
    const opt = document.createElement('option');
    opt.value = v;
    opt.textContent = label;
    isolationSel.appendChild(opt);
  }
  field('Isolation', isolationSel);

  const error = document.createElement('div');
  error.className = 'orch-form-error';
  form.appendChild(error);

  const submit = document.createElement('button');
  submit.className = 'orch-card-action-primary orch-form-submit';
  submit.textContent = 'Create run & start master';
  submit.addEventListener('click', async () => {
    error.textContent = '';
    if (!titleInput.value.trim()) { error.textContent = 'Title is required.'; return; }
    if (!goalInput.value.trim()) { error.textContent = 'Goal is required.'; return; }
    submit.disabled = true;
    submit.textContent = 'Creating…';
    const res = await window.api.orchestration.createRun(projectSel.value, {
      title: titleInput.value.trim(),
      goal: goalInput.value.trim(),
      roles: {
        master: { profileId: masterSel.value || null },
        worker: { profileId: workerSel.value || null, maxConcurrent: parseInt(workerCount.value, 10) || 4 },
        reviewer: { profileId: reviewerSel.value || null },
      },
      policy: { isolation: isolationSel.value },
    });
    if (!res?.ok) {
      submit.disabled = false;
      submit.textContent = 'Create run & start master';
      error.textContent = res?.error || 'Failed to create run.';
      return;
    }
    overlay.remove();
    orchSelected = { projectPath: projectSel.value, runId: res.run.id };
    await loadTeams();
    // Drop the user straight into the master session terminal.
    orchOpenSession(res.masterSessionId, `${res.run.title} (master)`);
  });
  form.appendChild(submit);

  modal.appendChild(form);
  overlay.appendChild(modal);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
  document.body.appendChild(overlay);
  titleInput.focus();
}
