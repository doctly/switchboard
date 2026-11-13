// RAM task manager: how much memory each running session and task uses.
//
// Opened from the sidebar's More menu. Each row is one session (or task) and
// counts its whole process tree; rows are sorted by RAM, heaviest first, and
// expand to the processes inside. Stop ends a session the way the sidebar
// does, then ends whatever of its tree outlived that; Force kill SIGKILLs
// the whole tree at once.
//
// Uses globals from app.js and friends at call time: sessionMap,
// pendingSessions, openSessions, activePtyIds, activeSessionId,
// gridViewActive, openSession, showSession, showTaskLog, setActiveSession,
// refreshSidebar, cleanDisplayName, shortProjectPath, escapeHtml, escapeAttr.

(function () {
  const viewer = document.getElementById('process-viewer');
  const body = document.getElementById('process-viewer-body');
  const statusEl = document.getElementById('process-viewer-status');
  const refreshBtn = document.getElementById('process-viewer-refresh');
  const closeBtn = document.getElementById('process-viewer-close');

  const GB = 1024 ** 3;
  const MB = 1024 ** 2;
  const MAX_PROCESS_ROWS = 60;

  let data = null;
  let error = null;
  let timer = null;
  let inFlight = false;
  const expanded = new Set();
  // Owners asked to stop, and processes asked to end, from this window: their
  // buttons turn into "Force kill" if they are still there afterwards.
  const stopAsked = new Set();
  const stopInFlight = new Set();
  const killAsked = new Set();

  const isOpen = () => viewer.style.display !== 'none';
  const intervalMs = () => (data?.platform === 'win32' ? 6000 : 3000);

  function ownerKey(owner) {
    return owner.kind === 'task' ? `task:${owner.projectPath}|${owner.label}` : `session:${owner.id}`;
  }

  function ownerRef(owner) {
    return owner.kind === 'task'
      ? { kind: 'task', projectPath: owner.projectPath, label: owner.label }
      : { kind: 'session', id: owner.id };
  }

  function findOwner(key) {
    return data?.owners.find(owner => ownerKey(owner) === key) || null;
  }

  function sessionFor(id) {
    return sessionMap.get(id) || pendingSessions.get(id)?.session || null;
  }

  function ownerTitle(owner) {
    if (owner.kind === 'task') return owner.label;
    const session = sessionFor(owner.id);
    const name = session ? cleanDisplayName(session.name || session.aiTitle || session.summary) : '';
    if (name) return name;
    if (owner.type === 'terminal') return 'Terminal';
    return `${kindLabel(owner)} session`;
  }

  function kindLabel(owner) {
    if (owner.kind === 'task') return 'Task';
    if (owner.type === 'terminal') return 'Terminal';
    const runtime = owner.runtime || 'claude';
    return runtime.charAt(0).toUpperCase() + runtime.slice(1);
  }

  const TASK_ICON = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="6 4 20 12 6 20 6 4"/></svg>';
  const CHEVRON = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg>';

  function ownerIcon(owner) {
    if (owner.kind === 'task') return TASK_ICON;
    if (owner.type === 'terminal') return ICONS.terminal(14);
    if (owner.runtime === 'codex') return ICONS.codex(14, 'codex-icon');
    if (!owner.runtime || owner.runtime === 'claude') return ICONS.claude(14);
    return ICONS.terminal(14);
  }

  function formatBytes(bytes) {
    if (!bytes) return '0 MB';
    if (bytes >= GB) return (bytes / GB).toFixed(bytes >= 10 * GB ? 1 : 2) + ' GB';
    if (bytes >= MB) return Math.round(bytes / MB) + ' MB';
    return Math.max(1, Math.round(bytes / 1024)) + ' KB';
  }

  function formatCpu(cpu) {
    if (cpu === null || cpu === undefined) return '—';
    return (cpu >= 10 ? Math.round(cpu) : cpu.toFixed(1)) + '%';
  }

  function formatShare(bytes) {
    if (!data?.totalMemBytes) return '';
    const share = (bytes / data.totalMemBytes) * 100;
    return (share >= 10 ? Math.round(share) : share.toFixed(1)) + '% of RAM';
  }

  function formatUptime(startedAt) {
    if (!startedAt) return '—';
    const minutes = Math.max(0, Math.floor((Date.now() - startedAt) / 60000));
    if (minutes < 1) return '<1m';
    if (minutes < 60) return `${minutes}m`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ${String(minutes % 60).padStart(2, '0')}m`;
    return `${Math.floor(hours / 24)}d ${hours % 24}h`;
  }

  function level(bytes) {
    if (bytes >= 2 * GB) return 'high';
    if (bytes >= GB) return 'mid';
    return 'low';
  }

  // --- Rendering ---

  function summaryHtml(owners) {
    const total = owners.reduce((sum, owner) => sum + owner.rssBytes, 0);
    const processes = owners.reduce((sum, owner) => sum + owner.processCount, 0);
    const sessions = owners.filter(owner => owner.kind === 'session').length;
    const tasks = owners.length - sessions;
    const share = data.totalMemBytes ? Math.min(100, (total / data.totalMemBytes) * 100) : 0;
    const running = [`${sessions} session${sessions === 1 ? '' : 's'}`];
    if (tasks) running.push(`${tasks} task${tasks === 1 ? '' : 's'}`);
    return `
      <div class="pm-summary">
        <div class="pm-card pm-card-main">
          <div class="pm-card-label">Sessions &amp; tasks</div>
          <div class="pm-card-value">${formatBytes(total)}</div>
          <div class="pm-meter"><span class="pm-level-${level(total)}" style="width:${share.toFixed(2)}%"></span></div>
          <div class="pm-card-hint">${escapeHtml(formatShare(total))} · ${formatBytes(data.totalMemBytes)} installed</div>
        </div>
        <div class="pm-card">
          <div class="pm-card-label">Switchboard app</div>
          <div class="pm-card-value">${formatBytes(data.app.rssBytes)}</div>
          <div class="pm-card-hint">${data.app.processCount} Electron processes · CPU ${formatCpu(data.app.cpu)}</div>
        </div>
        <div class="pm-card">
          <div class="pm-card-label">Running</div>
          <div class="pm-card-value">${running.join(' · ')}</div>
          <div class="pm-card-hint">${processes} process${processes === 1 ? '' : 'es'} in total</div>
        </div>
      </div>`;
  }

  function processesHtml(owner, key) {
    // A shell busy starting up can briefly hold hundreds; keep the list readable.
    const shown = owner.processes.slice(0, MAX_PROCESS_ROWS);
    const hidden = owner.processes.slice(MAX_PROCESS_ROWS);
    const rows = shown.map(proc => {
      const killKey = `${key}#${proc.pid}`;
      const forcing = killAsked.has(killKey);
      const action = proc.depth === 0
        ? '<span class="pm-proc-root" title="The session\'s own process: use Stop">root</span>'
        : `<button class="pm-btn pm-btn-small ${forcing ? 'pm-btn-danger' : 'pm-btn-ghost'}" data-action="kill" data-key="${escapeAttr(key)}" data-pid="${proc.pid}" title="${forcing ? 'Still running: send SIGKILL' : 'End this process (SIGTERM)'}">${forcing ? 'Force kill' : 'Kill'}</button>`;
      return `
        <div class="pm-proc">
          <span class="pm-proc-name" style="padding-left:${Math.min(proc.depth, 8) * 14}px">${proc.depth ? '<span class="pm-proc-branch">└</span>' : ''}${escapeHtml(proc.label || proc.name || '?')}</span>
          <span class="pm-proc-cmd" title="${escapeAttr(proc.command || '')}">${escapeHtml(proc.command || '')}</span>
          <span class="pm-mono">${proc.pid}</span>
          <span class="pm-num">${formatCpu(proc.cpu)}</span>
          <span class="pm-num">${formatBytes(proc.rssBytes)}</span>
          <span class="pm-proc-action">${action}</span>
        </div>`;
    }).join('');
    const more = hidden.length
      ? `<div class="pm-proc-empty">…and ${hidden.length} more process${hidden.length === 1 ? '' : 'es'}, ${formatBytes(hidden.reduce((sum, proc) => sum + proc.rssBytes, 0))} in all.</div>`
      : '';
    return `
      <div class="pm-procs">
        <div class="pm-proc pm-proc-head"><span>Process</span><span>Command</span><span>PID</span><span class="pm-num">CPU</span><span class="pm-num">RAM</span><span></span></div>
        ${rows || '<div class="pm-proc-empty">No process found for this PID.</div>'}
        ${more}
      </div>`;
  }

  function ownerHtml(owner, maxBytes) {
    const key = ownerKey(owner);
    const open = expanded.has(key);
    const pending = stopInFlight.has(key);
    const stopping = pending || owner.stopRequested || stopAsked.has(key);
    const width = maxBytes ? Math.max(1.5, (owner.rssBytes / maxBytes) * 100) : 0;
    const badges = [];
    if (stopping) badges.push('<span class="pm-badge pm-badge-stop">stopping…</span>');
    else if (owner.busy) badges.push('<span class="pm-badge pm-badge-busy">working</span>');
    if (!owner.found) badges.push('<span class="pm-badge">not measured</span>');
    const sub = [kindLabel(owner)];
    if (owner.projectPath) sub.push(shortProjectPath(owner.projectPath));
    if (owner.pid) sub.push(`PID ${owner.pid}`);
    const stopButton = pending
      ? '<button class="pm-btn pm-btn-stop" disabled title="Ending every process in it">Stopping…</button>'
      : stopping
      ? `<button class="pm-btn pm-btn-danger" data-action="force" data-key="${escapeAttr(key)}" title="Still running: SIGKILL every process in it">Force kill</button>`
      : `<button class="pm-btn pm-btn-stop" data-action="stop" data-key="${escapeAttr(key)}" title="Stop this ${owner.kind === 'task' ? 'task' : 'session'}">Stop</button>`;
    return `
      <div class="pm-owner${open ? ' pm-open' : ''}" data-key="${escapeAttr(key)}">
        <div class="pm-row">
          <button class="pm-expand" data-action="toggle" data-key="${escapeAttr(key)}" title="${open ? 'Hide' : 'Show'} processes" aria-expanded="${open}">${CHEVRON}</button>
          <div class="pm-name" data-action="toggle" data-key="${escapeAttr(key)}">
            <span class="pm-icon">${ownerIcon(owner)}</span>
            <div class="pm-name-text">
              <div class="pm-title"><span class="pm-title-text" title="${escapeAttr(ownerTitle(owner))}">${escapeHtml(ownerTitle(owner))}</span>${badges.join('')}</div>
              <div class="pm-sub">${escapeHtml(sub.join(' · '))}</div>
            </div>
          </div>
          <span class="pm-num" title="Processes in this tree">${owner.processCount}</span>
          <span class="pm-num">${formatCpu(owner.cpu)}</span>
          <div class="pm-ram" title="${escapeAttr(formatShare(owner.rssBytes))}">
            <div class="pm-ram-top"><span class="pm-ram-value">${formatBytes(owner.rssBytes)}</span><span class="pm-ram-share">${escapeHtml(formatShare(owner.rssBytes))}</span></div>
            <div class="pm-bar"><span class="pm-level-${level(owner.rssBytes)}" style="width:${width.toFixed(2)}%"></span></div>
          </div>
          <span class="pm-uptime">${formatUptime(owner.startedAt)}</span>
          <div class="pm-actions">
            <button class="pm-btn pm-btn-ghost" data-action="open" data-key="${escapeAttr(key)}" title="Show this ${owner.kind === 'task' ? 'task\'s output' : 'session'}">Open</button>
            ${stopButton}
          </div>
        </div>
        ${open ? processesHtml(owner, key) : ''}
      </div>`;
  }

  function render() {
    if (error && !data) {
      body.innerHTML = `<div class="pm-wrap"><div class="pm-empty">Could not read the process list: ${escapeHtml(error)}</div></div>`;
      return;
    }
    if (!data) {
      body.innerHTML = '<div class="pm-wrap"><div class="pm-empty">Measuring…</div></div>';
      return;
    }
    const owners = data.owners;
    // Forget what was asked of owners and processes that are gone.
    const live = new Set(owners.map(ownerKey));
    for (const key of [...stopAsked]) if (!live.has(key)) stopAsked.delete(key);
    for (const key of [...expanded]) if (!live.has(key)) expanded.delete(key);
    const livePids = new Set(owners.flatMap(owner => owner.processes.map(proc => `${ownerKey(owner)}#${proc.pid}`)));
    for (const key of [...killAsked]) if (!livePids.has(key)) killAsked.delete(key);

    const maxBytes = owners.reduce((max, owner) => Math.max(max, owner.rssBytes), 0);
    const rows = owners.length
      ? owners.map(owner => ownerHtml(owner, maxBytes)).join('')
      : '<div class="pm-empty">No session or task is running.</div>';
    const notes = ['RAM is the resident memory (RSS) of each session\'s whole process tree: the CLI, its MCP servers and anything it started. Memory shared between processes can be counted more than once.'];
    if (data.platform === 'win32') notes.push('CPU is not measured on Windows, and a WSL session only shows its Windows-side process.');
    const html = `
      <div class="pm-wrap">
        ${summaryHtml(owners)}
        <div class="pm-table">
          <div class="pm-row pm-head">
            <span></span><span>Name</span><span class="pm-num">Procs</span><span class="pm-num">CPU</span><span class="pm-sorted">RAM ↓</span><span>Uptime</span><span></span>
          </div>
          ${rows}
        </div>
        <p class="pm-footnote">${notes.map(escapeHtml).join('<br>')}</p>
      </div>`;
    if (typeof morphdom === 'function' && body.firstElementChild) {
      morphdom(body, `<div>${html}</div>`, { childrenOnly: true });
    } else {
      body.innerHTML = html;
    }
  }

  function setStatus() {
    if (error) {
      statusEl.textContent = 'Refresh failed';
      statusEl.className = 'pm-status pm-status-error';
      return;
    }
    const time = data ? new Date(data.sampledAt).toLocaleTimeString() : '';
    statusEl.textContent = data ? `Live · every ${intervalMs() / 1000}s · ${time}` : '';
    statusEl.className = 'pm-status';
  }

  // --- Refresh loop: only while the viewer is on screen ---

  async function refresh() {
    if (inFlight) return;
    inFlight = true;
    refreshBtn.classList.add('spinning');
    try {
      data = await window.api.getProcessUsage();
      error = null;
    } catch (err) {
      error = err?.message || String(err);
    } finally {
      inFlight = false;
      refreshBtn.classList.remove('spinning');
    }
    if (!isOpen()) return;
    render();
    setStatus();
  }

  function schedule(delay = intervalMs()) {
    clearTimeout(timer);
    timer = setTimeout(tick, delay);
  }

  async function tick() {
    timer = null;
    if (!isOpen()) return;
    if (!document.hidden) await refresh();
    if (isOpen()) schedule();
  }

  /** Soon after an action, to show its effect without waiting a full interval. */
  function refreshSoon() {
    schedule(700);
  }

  // --- Actions ---

  async function stopOwner(owner) {
    const key = ownerKey(owner);
    const what = owner.kind === 'task' ? 'task' : 'session';
    const count = `${owner.processCount} process${owner.processCount === 1 ? '' : 'es'}`;
    if (!confirm(`Stop the ${what} “${ownerTitle(owner)}”?\n\nIt uses ${formatBytes(owner.rssBytes)} across ${count}. All of them are ended, including any started in the background.`)) return;
    stopAsked.add(key);
    stopInFlight.add(key);
    render();
    // Resolves once the stragglers are dealt with, a few seconds at most.
    const stopping = window.api.stopOwner(ownerRef(owner)).finally(() => stopInFlight.delete(key));
    if (owner.kind === 'session') {
      activePtyIds.delete(owner.id);
      // Like the sidebar's Stop; the viewer stays on top until it is closed.
      if (!gridViewActive && activeSessionId === owner.id) setActiveSession(null);
    }
    refreshSoon();
    const result = await stopping;
    if (!result?.ok && result?.error) alert(result.error);
    if (owner.kind === 'session') refreshSidebar();
    if (isOpen()) refresh();
  }

  async function forceStopOwner(owner) {
    if (!confirm(`Force kill “${ownerTitle(owner)}”?\n\nEvery process in it gets SIGKILL right away: anything unsaved in them is lost.`)) return;
    const result = await window.api.forceStopOwner(ownerRef(owner));
    if (!result?.ok && result?.error) alert(result.error);
    if (owner.kind === 'session') {
      activePtyIds.delete(owner.id);
      refreshSidebar();
    }
    refreshSoon();
  }

  async function killProcess(owner, pid) {
    const proc = owner.processes.find(p => p.pid === pid);
    if (!proc) return;
    const killKey = `${ownerKey(owner)}#${pid}`;
    const force = killAsked.has(killKey);
    const name = proc.label || proc.name;
    const prompt = force
      ? `“${name}” (PID ${pid}) is still running. Send SIGKILL?`
      : `End “${name}” (PID ${pid}), ${formatBytes(proc.rssBytes)}?\n\nThe session keeps running; only this process ends.`;
    if (!confirm(prompt)) return;
    const result = await window.api.killOwnedProcess(ownerRef(owner), pid, force);
    if (!result?.ok) {
      if (result?.error) alert(result.error);
      return;
    }
    killAsked.add(killKey);
    refreshSoon();
  }

  function openOwner(owner) {
    if (owner.kind === 'task') {
      showTaskLog(owner.projectPath, owner.label);
      return;
    }
    const session = sessionFor(owner.id);
    if (session) openSession(session);
    else if (openSessions.has(owner.id)) showSession(owner.id);
  }

  body.addEventListener('click', (event) => {
    const target = event.target.closest('[data-action]');
    if (!target || !body.contains(target)) return;
    const owner = findOwner(target.dataset.key);
    if (!owner) return;
    switch (target.dataset.action) {
      case 'toggle': {
        const key = ownerKey(owner);
        if (expanded.has(key)) expanded.delete(key); else expanded.add(key);
        render();
        break;
      }
      case 'open': openOwner(owner); break;
      case 'stop': stopOwner(owner); break;
      case 'force': forceStopOwner(owner); break;
      case 'kill': killProcess(owner, Number(target.dataset.pid)); break;
    }
  });

  refreshBtn.addEventListener('click', () => { refresh(); schedule(); });
  closeBtn.addEventListener('click', () => closeProcessViewer());

  // --- Open / close ---

  function openProcessViewer() {
    if (typeof hideProjectChrome === 'function') hideProjectChrome();
    for (const id of ['placeholder', 'terminal-area', 'plan-viewer', 'stats-viewer', 'memory-viewer', 'jsonl-viewer', 'settings-viewer']) {
      const el = document.getElementById(id);
      if (el) el.style.display = 'none';
    }
    viewer.style.display = 'flex';
    render();
    refresh();
    schedule();
  }

  /** Back to whatever the viewer covered: the active session, the grid, or the placeholder. */
  function closeProcessViewer() {
    clearTimeout(timer);
    timer = null;
    viewer.style.display = 'none';
    const terminalArea = document.getElementById('terminal-area');
    const terminalHeader = document.getElementById('terminal-header');
    if (activeSessionId && openSessions.has(activeSessionId)) {
      terminalArea.style.display = '';
      terminalHeader.style.display = '';
    } else if (gridViewActive) {
      terminalArea.style.display = '';
    } else {
      document.getElementById('placeholder').style.display = '';
    }
  }

  window.openProcessViewer = openProcessViewer;
  window.closeProcessViewer = closeProcessViewer;
})();
