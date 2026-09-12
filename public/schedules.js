// Scheduled tasks in the renderer: the list, the dialog that edits one, the
// dropdown that lists them, and the launch when main says one is due.
//
// A schedule is a saved prompt plus a time (public/schedule-time.js). Main
// ticks once a minute and sends 'schedule-due' with everything resolved; the
// session it starts is an ordinary one (launchNewSession) that carries the
// schedule's id so its row can show a clock chip. A schedule lives in one
// place: with a projectId it is listed in the project view under its track,
// without one it is a folder schedule on the Sessions tab, under `cwd`.
//
// Depends on globals: launchNewSession, resolveDefaultSessionOptions,
// showContextMenu, loadProjects, escapeHtml, ICONS, PICONS, shortProjectPath.

let cachedSchedules = [];

async function loadSchedules() {
  try {
    const list = await window.api.listSchedules();
    cachedSchedules = Array.isArray(list) ? list : [];
  } catch { cachedSchedules = []; }
  return cachedSchedules;
}

function scheduleById(id) {
  return cachedSchedules.find(s => s.id === id) || null;
}

/** Folder schedules of a Sessions-tab folder. */
function schedulesForFolder(projectPath) {
  return cachedSchedules.filter(s => !s.projectId && s.cwd === projectPath);
}

/** A project's schedules, from the tree node when it has them, else the cache. */
function schedulesForProject(project) {
  if (Array.isArray(project?.schedules)) return project.schedules;
  return cachedSchedules.filter(s => s.projectId === project?.id);
}

/**
 * Why a schedule is not firing, in words, or '' when it is. Mirrors
 * projects.js schedulePausedReason so the dropdown and main agree.
 */
function schedulePauseLabel(schedule, project = null) {
  if (!schedule.enabled) return 'off';
  if (project?.status === 'done') return 'paused: project done';
  if (schedule.trackId && project) {
    const track = (project.tracks || []).find(t => t.id === schedule.trackId);
    if (track?.status === 'done') return 'paused: track done';
  }
  return '';
}

function scheduleNextRunLabel(schedule, project = null) {
  const paused = schedulePauseLabel(schedule, project);
  if (paused) return paused;
  const now = Date.now();
  const due = nextDueAt(schedule, now);
  return due === null ? 'never' : describeNextRun(due, now);
}

function scheduleLastRunLabel(schedule) {
  if (!schedule.lastRunAt) return 'never';
  const at = Date.parse(schedule.lastRunAt);
  return Number.isFinite(at) ? formatDate(new Date(at)) : 'never';
}

// --- Launching ---

/** Start the session for a schedule main says is due. Never steals focus. */
async function launchScheduledSession(launch) {
  if (!launch || launch.error || !launch.schedule || !launch.target) return;
  const { schedule, target, runtime } = launch;
  const options = await resolveDefaultSessionOptions(target);
  options.runtime = runtime || 'claude';
  options.initialPrompt = schedule.prompt;
  options.scheduleId = schedule.id;
  await launchNewSession(target, options, { focus: false });
}

async function runScheduleNow(schedule) {
  const launch = await window.api.resolveScheduleLaunch(schedule.id);
  if (launch?.error) { alert(launch.error); return; }
  await launchScheduledSession(launch);
}

async function toggleScheduleEnabled(schedule) {
  const result = await window.api.updateSchedule(schedule.id, { enabled: !schedule.enabled });
  if (result?.error) alert(result.error);
  else await refreshSchedules();
}

async function deleteScheduleFlow(schedule) {
  if (!confirm(`Delete the scheduled task “${schedule.name}”?\n\nSessions it already started are kept.`)) return;
  const result = await window.api.deleteSchedule(schedule.id);
  if (result?.error) alert(result.error);
  else await refreshSchedules();
}

/** Reload the list and whatever is showing it. */
async function refreshSchedules() {
  await loadSchedules();
  loadProjects();
}

// --- The dropdown ---

/**
 * Menu rows for a list of schedules, each with its own submenu, then a row to
 * add one. `place` says where a new one goes: { projectId, trackId } or { cwd }.
 */
function scheduleMenuItems(schedules, place, project = null) {
  const items = [];
  if (schedules.length) {
    items.push({ head: 'Scheduled tasks' });
    for (const s of schedules) {
      const paused = schedulePauseLabel(s, project);
      items.push({
        label: s.name,
        icon: PICONS.clock(13),
        muted: !!paused,
        hint: paused || scheduleNextRunLabel(s, project),
        submenu: [
          { head: describeTiming(s) },
          { label: 'Edit…', icon: PICONS.pencil(13), onClick: () => showScheduleDialog({ schedule: s, project }) },
          { label: 'Run now', icon: PICONS.play(13), onClick: () => runScheduleNow(s) },
          { label: s.enabled ? 'Turn off' : 'Turn on', icon: PICONS.check(13), onClick: () => toggleScheduleEnabled(s) },
          { sep: true },
          { label: 'Delete…', icon: PICONS.trash(13), danger: true, onClick: () => deleteScheduleFlow(s) },
        ],
      });
    }
    items.push({ sep: true });
  }
  items.push({ label: 'New scheduled task…', icon: PICONS.plus(13), onClick: () => showScheduleDialog({ ...place, project }) });
  return items;
}

/** The Sessions-tab clock: straight to the dialog when the folder has none, else the list. */
function showFolderScheduleMenu(projectPath, anchor) {
  const schedules = schedulesForFolder(projectPath);
  if (!schedules.length) { showScheduleDialog({ cwd: projectPath }); return; }
  showContextMenu(scheduleMenuItems(schedules, { cwd: projectPath }), { anchor });
}

/** The project view's Schedules button: rows grouped by track. */
function showProjectScheduleMenu(project, anchor) {
  const schedules = schedulesForProject(project);
  if (!schedules.length) { showScheduleDialog({ projectId: project.id, trackId: null, project }); return; }
  const items = [];
  const groups = [{ track: null, list: schedules.filter(s => !s.trackId) }];
  for (const t of project.tracks || []) groups.push({ track: t, list: schedules.filter(s => s.trackId === t.id) });
  for (const g of groups) {
    if (!g.list.length) continue;
    const rows = scheduleMenuItems(g.list, { projectId: project.id, trackId: g.track?.id || null }, project);
    // One heading per track, then its rows without the generic one.
    items.push({ head: g.track ? g.track.name : 'General' });
    items.push(...rows.filter(r => !r.head && !(r.label && r.label.startsWith('New scheduled'))).filter(r => !r.sep));
  }
  items.push({ sep: true });
  items.push({ label: 'New scheduled task…', icon: PICONS.plus(13), onClick: () => showScheduleDialog({ projectId: project.id, trackId: null, project }) });
  showContextMenu(items, { anchor });
}

/** Tint and badge for a clock button, from how many schedules it has. */
function decorateScheduleButton(btn, schedules) {
  const live = schedules.filter(s => s.enabled).length;
  btn.classList.toggle('has-schedules', schedules.length > 0);
  btn.classList.toggle('all-off', schedules.length > 0 && live === 0);
  let badge = btn.querySelector('.schedule-count');
  if (schedules.length) {
    if (!badge) { badge = document.createElement('span'); badge.className = 'schedule-count'; btn.appendChild(badge); }
    badge.textContent = String(schedules.length);
    btn.title = schedules.length === 1 ? '1 scheduled task' : `${schedules.length} scheduled tasks`;
  } else {
    if (badge) badge.remove();
    btn.title = 'New scheduled task';
  }
}

// --- The chip on a session row ---

/** "clock Name · 9:00 AM" for a session a schedule started, else ''. */
/** `compact` shows the clock alone; the task's name and time stay in the tooltip. */
function scheduleChipHtml(session, { compact = false } = {}) {
  if (!session?.scheduleId) return '';
  const schedule = scheduleById(session.scheduleId);
  const name = schedule ? schedule.name : 'Scheduled';
  const at = Date.parse(session.scheduledAt || '');
  const when = Number.isFinite(at) ? new Date(at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) : '';
  const title = `Started by the scheduled task “${name}”` + (Number.isFinite(at) ? ` at ${new Date(at).toLocaleString()}` : '');
  if (compact) return `<span class="pane-tag pane-tag--schedule pane-tag--icon" title="${escapeHtml(title)}">${PICONS.clock(11)}</span>`;
  return `<span class="pane-tag pane-tag--schedule" title="${escapeHtml(title)}">${PICONS.clock(9)}${escapeHtml(name)}${when ? ` · ${escapeHtml(when)}` : ''}</span>`;
}

// --- The dialog ---

function pad2(n) { return String(n).padStart(2, '0'); }

/**
 * Create or edit a schedule. `schedule` set means edit; otherwise `place`
 * says where the new one goes: { projectId, trackId } or { cwd }. `project`
 * is the tree node, for the track picker and the pause label.
 */
function showScheduleDialog({ schedule = null, projectId = null, trackId = null, cwd = null, project = null } = {}) {
  const editing = !!schedule;
  const isProject = editing ? !!schedule.projectId : !!projectId;
  const tracks = (project?.tracks || []).filter(t => t.status !== 'done' || t.id === schedule?.trackId);
  const fromFile = !!schedule?.sourceFile;
  const state = {
    every: schedule?.every || 'day',
    atHour: schedule?.atHour ?? 9,
    atMinute: schedule?.atMinute ?? 0,
    weekday: schedule?.weekday ?? 1,
    cron: schedule?.cron || null,
  };

  const overlay = document.createElement('div');
  overlay.className = 'new-session-overlay';
  const dialog = document.createElement('div');
  dialog.className = 'new-session-dialog schedule-dialog';
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');

  const where = isProject
    ? (project ? project.name : 'this project')
    : shortProjectPath(editing ? schedule.cwd : cwd);

  dialog.innerHTML = `
    <h3>${editing ? 'Edit scheduled task' : 'New scheduled task'} — ${escapeHtml(where)}</h3>
    <div class="settings-field settings-field-wide">
      <div class="settings-field-info"><span class="settings-label">Name</span></div>
      <div class="settings-field-control"><input type="text" class="settings-input" id="sd-name" placeholder="e.g. Morning digest" value="${escapeHtml(schedule?.name || '')}"></div>
    </div>
    ${isProject ? `
    <div class="settings-field">
      <div class="settings-field-info"><span class="settings-label">Track</span><div class="settings-description">Sessions it starts land here and run where the track's sessions start</div></div>
      <div class="settings-field-control">
        <select class="settings-select" id="sd-track">
          <option value="">General</option>
          ${tracks.map(t => `<option value="${escapeHtml(t.id)}" ${(editing ? schedule.trackId : trackId) === t.id ? 'selected' : ''}>${escapeHtml(t.name)}</option>`).join('')}
        </select>
      </div>
    </div>` : ''}
    <div class="settings-field settings-field-wide">
      <div class="settings-field-info"><span class="settings-label">When</span><div class="settings-description" id="sd-when-desc"></div></div>
      <div class="settings-field-control sd-when">
        <div class="sd-presets" id="sd-presets"></div>
        <div class="sd-time-row" id="sd-time-row">
          <label id="sd-weekday-wrap">on <select class="settings-select" id="sd-weekday">${WEEKDAYS.map((d, i) => `<option value="${i}" ${state.weekday === i ? 'selected' : ''}>${d}</option>`).join('')}</select></label>
          <label id="sd-time-wrap">at <input type="time" class="settings-input settings-input-compact sd-time" id="sd-time" value="${pad2(state.atHour)}:${pad2(state.atMinute)}"></label>
          <label id="sd-minute-wrap">at minute <input type="number" min="0" max="59" class="settings-input settings-input-compact" id="sd-minute" value="${state.atMinute}"></label>
        </div>
      </div>
    </div>
    <div class="settings-field settings-field-wide">
      <div class="settings-field-info"><span class="settings-label">Prompt</span><div class="settings-description">${fromFile ? 'Imported from a schedule file. The file stays the source of truth; this prompt only points at it.' : 'Sent as the first message of each session it starts. It runs without any history, so say everything.'}</div></div>
      <div class="settings-field-control"><textarea class="settings-input sd-prompt" id="sd-prompt" rows="6" placeholder="What should the session do?">${escapeHtml(schedule?.prompt || '')}</textarea></div>
    </div>
    <div class="settings-field">
      <div class="settings-field-info"><span class="settings-label">CLI</span></div>
      <div class="settings-field-control">
        <select class="settings-select" id="sd-cli"></select>
      </div>
    </div>
    <div class="settings-field">
      <div class="settings-field-info"><span class="settings-label">On</span><div class="settings-description">Off keeps it here without firing</div></div>
      <div class="settings-field-control"><label class="settings-toggle"><input type="checkbox" id="sd-enabled" ${schedule ? (schedule.enabled ? 'checked' : '') : 'checked'}><span class="settings-toggle-slider"></span></label></div>
    </div>
    <div class="settings-field">
      <div class="settings-field-info"><span class="settings-label">Catch up on missed runs</span><div class="settings-description">If it was due while Switchboard was closed, run once at the next launch</div></div>
      <div class="settings-field-control"><label class="settings-toggle"><input type="checkbox" id="sd-catchup" ${schedule?.catchUp ? 'checked' : ''}><span class="settings-toggle-slider"></span></label></div>
    </div>
    ${editing ? `<div class="sd-runs mono">Last run: ${escapeHtml(scheduleLastRunLabel(schedule))} · Next run: <span id="sd-next"></span></div>` : ''}
    <div class="sd-error" id="sd-error" hidden></div>
    <div class="new-session-actions">
      ${editing ? '<button type="button" class="sd-delete-btn">Delete</button>' : ''}
      <span class="ws-flex"></span>
      <button type="button" class="new-session-cancel-btn">Cancel</button>
      <button type="button" class="new-session-start-btn">${editing ? 'Save' : 'Create'}</button>
    </div>`;

  overlay.appendChild(dialog);
  document.body.appendChild(overlay);

  const presetsEl = dialog.querySelector('#sd-presets');
  const whenDesc = dialog.querySelector('#sd-when-desc');
  const timeInput = dialog.querySelector('#sd-time');
  const minuteInput = dialog.querySelector('#sd-minute');
  const weekdaySel = dialog.querySelector('#sd-weekday');
  const errorEl = dialog.querySelector('#sd-error');

  // The CLI list comes from the harness registry, like the track row's does,
  // so a CLI added later appears here and one switched off in settings does
  // not. A schedule already naming a disabled one keeps it, visibly.
  const cliSel = dialog.querySelector('#sd-cli');
  const renderCli = (harnesses) => {
    const options = [{ id: '', label: isProject ? 'Track default' : `Default (${harnesses[0]?.label || 'Claude'})` }, ...harnesses.map(h => ({ id: h.id, label: h.label }))];
    if (schedule?.cli && !options.some(o => o.id === schedule.cli)) options.push({ id: schedule.cli, label: `${schedule.cli} (off in settings)` });
    cliSel.replaceChildren();
    for (const opt of options) {
      const o = document.createElement('option');
      o.value = opt.id; o.textContent = opt.label; o.selected = (schedule?.cli || '') === opt.id;
      cliSel.appendChild(o);
    }
  };
  renderCli([{ id: 'claude', label: 'Claude' }]);
  window.api.getHarnesses().then(list => { if (dialog.isConnected) renderCli((list || []).filter(h => h.enabled)); }).catch(() => {});

  function currentTiming() {
    const t = { every: state.every, atHour: null, atMinute: null, weekday: null, cron: null };
    if (state.every === 'cron') { t.cron = state.cron; return t; }
    if (state.every === 'hour') t.atMinute = Number(minuteInput.value) || 0;
    if (['day', 'weekdays', 'week'].includes(state.every)) {
      const [h, m] = String(timeInput.value || '09:00').split(':').map(Number);
      t.atHour = Number.isFinite(h) ? h : 9;
      t.atMinute = Number.isFinite(m) ? m : 0;
    }
    if (state.every === 'week') t.weekday = Number(weekdaySel.value) || 0;
    return t;
  }

  function renderPresets() {
    presetsEl.innerHTML = PRESETS.map(p =>
      `<button type="button" class="permission-option sd-preset${state.every === p.every ? ' selected' : ''}" data-every="${p.every}"><span class="perm-name">${escapeHtml(p.label)}</span></button>`
    ).join('') + (state.every === 'cron'
      ? `<div class="sd-cron-note">Keeps the file's timing: <strong>${escapeHtml(describeTiming({ every: 'cron', cron: state.cron }))}</strong>. Pick a preset to replace it — there is no way back.</div>`
      : '');
    presetsEl.querySelectorAll('.sd-preset').forEach(btn => {
      btn.onclick = () => { state.every = btn.dataset.every; renderPresets(); };
    });
    dialog.querySelector('#sd-time-row').hidden = state.every === 'cron' || state.every === '15m' || state.every === '30m';
    dialog.querySelector('#sd-weekday-wrap').hidden = state.every !== 'week';
    dialog.querySelector('#sd-time-wrap').hidden = !['day', 'weekdays', 'week'].includes(state.every);
    dialog.querySelector('#sd-minute-wrap').hidden = state.every !== 'hour';
    updateWhenDesc();
  }

  function updateWhenDesc() {
    const timing = currentTiming();
    whenDesc.textContent = describeTiming(timing);
    const next = dialog.querySelector('#sd-next');
    if (next) {
      const now = Date.now();
      const due = nextDueAt(timing, now);
      next.textContent = due === null ? 'never' : describeNextRun(due, now);
    }
  }
  timeInput.oninput = updateWhenDesc;
  minuteInput.oninput = updateWhenDesc;
  weekdaySel.onchange = updateWhenDesc;
  renderPresets();

  function close() { overlay.remove(); document.removeEventListener('keydown', onKey); }
  function showError(msg) { errorEl.textContent = msg; errorEl.hidden = false; }

  async function save() {
    const timing = currentTiming();
    const patch = {
      name: dialog.querySelector('#sd-name').value,
      prompt: dialog.querySelector('#sd-prompt').value,
      ...timing,
      cli: dialog.querySelector('#sd-cli').value || null,
      enabled: dialog.querySelector('#sd-enabled').checked,
      catchUp: dialog.querySelector('#sd-catchup').checked,
    };
    if (isProject) patch.trackId = dialog.querySelector('#sd-track').value || null;
    let result;
    if (editing) result = await window.api.updateSchedule(schedule.id, patch);
    else result = await window.api.createSchedule(isProject ? { ...patch, projectId } : { ...patch, cwd });
    if (result?.error) { showError(result.error); return; }
    close();
    await refreshSchedules();
  }

  dialog.querySelector('.new-session-cancel-btn').onclick = close;
  dialog.querySelector('.new-session-start-btn').onclick = save;
  const del = dialog.querySelector('.sd-delete-btn');
  if (del) del.onclick = async () => { close(); await deleteScheduleFlow(schedule); };

  function onKey(e) {
    if (e.key === 'Escape') { e.stopPropagation(); close(); }
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) save();
  }
  document.addEventListener('keydown', onKey);
  setTimeout(() => dialog.querySelector('#sd-name').focus(), 0);
}

// --- Wiring ---

if (typeof window !== 'undefined' && window.api?.onScheduleDue) {
  window.api.onScheduleDue((launch) => {
    launchScheduledSession(launch).catch(err => console.error('[schedule] launch failed', err));
  });
}
