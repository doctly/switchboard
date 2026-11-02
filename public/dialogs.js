// --- Dialogs & session launch helpers ---
// Depends on globals: launchNewSession, cachedProjects, cachedAllProjects, sessionMap,
// pendingSessions, openSessions, activePtyIds, refreshSidebar, pollActiveSessions (app.js)
// Depends on: ICONS (icons.js)//
// Dialog rule: a click on the backdrop does nothing. These hold typed work, and
// a stray click used to throw it away. Escape and Cancel are the ways out.

// --- New session dialog ---
async function resolveDefaultSessionOptions(project) {
  const effective = await window.api.getEffectiveSettings(project.projectPath);
  // All quick-launch callers share the same option registry as the forms.
  // A harness reads only its own fields; explicit false/null/empty defaults
  // remain intact instead of being mistaken for missing settings.
  const keys = new Set(Object.keys(SessionConfig.FIELDS).flatMap(runtime =>
    SessionConfig.fieldsFor(runtime).map(field => field.key)));
  return Object.fromEntries([...keys].filter(key => SessionConfig.own(effective, key))
    .map(key => [key, effective[key]]));
}

async function forkSession(session, project) {
  const options = await resolveDefaultSessionOptions(project);
  options.forkFrom = session.sessionId;
  // A fork runs on the CLI that wrote the session being forked, not whatever
  // the default is — `codex fork` cannot continue a Claude transcript.
  if (session.runtime) options.runtime = session.runtime;
  launchNewSession(project, options);
}

function showNewSessionPopover(project, anchorEl) {
  // Remove any existing popover
  document.querySelectorAll('.new-session-popover').forEach(el => el.remove());

  const popover = document.createElement('div');
  popover.className = 'new-session-popover';

  function addOption(html, className, onClick) {
    const btn = document.createElement('button');
    btn.className = 'popover-option' + (className ? ' ' + className : '');
    btn.innerHTML = html;
    btn.onclick = onClick;
    popover.appendChild(btn);
    return btn;
  }

  // One pair of rows per CLI, built from what main reports rather than
  // hardcoded, so a CLI added later appears without a change here. Switching
  // one off in settings is what takes it out of the list.
  function render(harnesses) {
    popover.replaceChildren();
    for (const h of harnesses) {
      const icon = h.id === 'codex'
        ? ICONS.codex(16, 'popover-option-icon codex-icon')
        : ICONS.claude(16, 'popover-option-icon claude-icon');
      addOption(`${icon} ${escapeHtml(h.label)}`, 'popover-option-' + h.id, async () => {
        popover.remove();
        const options = await resolveDefaultSessionOptions(project);
        options.runtime = h.id;
        launchNewSession(project, options);
      });
      addOption(`${icon} ${escapeHtml(h.label)} (Configure...)`, 'popover-option-' + h.id, () => {
        popover.remove();
        showNewSessionDialog(project, h.id);
      });
    }
    addOption(
      ICONS.terminal(16, 'popover-option-icon terminal-icon') + ' Terminal',
      'popover-option-terminal',
      () => { popover.remove(); launchTerminalSession(project); }
    );
    position();
  }

  function position() {
    const rect = anchorEl.getBoundingClientRect();
    const popoverHeight = popover.offsetHeight;
    if (rect.bottom + 4 + popoverHeight > window.innerHeight) {
      popover.style.top = (rect.top - popoverHeight - 4) + 'px';
    } else {
      popover.style.top = (rect.bottom + 4) + 'px';
    }
    popover.style.left = rect.left + 'px';
  }

  document.body.appendChild(popover);
  // Claude alone until main answers, so the popover never renders empty.
  render([{ id: 'claude', label: 'Claude' }]);
  window.api.getHarnesses()
    .then(list => {
      // Every switched-on CLI is offered. Whether its binary is actually
      // installed is not something the main process can tell — sessions run
      // through a login shell with a different PATH — so launching is what
      // finds out, and the shell's own error lands in the terminal.
      const usable = (list || []).filter(h => h.enabled);
      if (popover.isConnected && usable.length) render(usable);
    })
    .catch(() => {});

  // Close on click outside
  function onClickOutside(e) {
    if (!popover.contains(e.target) && e.target !== anchorEl) {
      popover.remove();
      document.removeEventListener('mousedown', onClickOutside);
    }
  }
  setTimeout(() => document.addEventListener('mousedown', onClickOutside), 0);
}

/** Start or reattach a raw terminal without routing it through a CLI harness. */
async function openRawTerminalSession(session, { show = true } = {}) {
  const { sessionId, projectPath } = session;
  const entry = openSessions.get(sessionId) || createTerminalEntry(session);
  const result = await window.api.openTerminal(sessionId, projectPath, true, {
    type: 'terminal',
    projectId: session.projectId || null,
    trackId: session.trackId || null,
  });
  if (!result.ok) {
    entry.terminal.write(`\r\nError: ${result.error}\r\n`);
    entry.closed = true;
    return result;
  }
  entry.closed = false;
  persistTerminalSession(session);
  if (show) showSession(sessionId);
  return result;
}

async function launchTerminalSession(project) {
  const session = {
    sessionId: crypto.randomUUID(),
    summary: 'Terminal',
    firstPrompt: '',
    projectPath: project.projectPath,
    name: null,
    starred: 0,
    archived: 0,
    messageCount: 0,
    modified: new Date().toISOString(),
    created: new Date().toISOString(),
    type: 'terminal',
  };
  // Started from a project or one of its tracks: the terminal belongs there,
  // so it shows in the project's list and not only in its own window.
  if (project.projectId) {
    session.projectId = project.projectId;
    session.trackId = project.trackId || null;
  }

  // Track as pending
  const { sessionId, projectPath } = session;
  const folder = encodeProjectPath(projectPath);
  pendingSessions.set(sessionId, { session, projectPath, folder });

  // Inject into cached project data
  sessionMap.set(sessionId, session);
  for (const projList of [cachedProjects, cachedAllProjects]) {
    let proj = projList.find(p => p.projectPath === projectPath);
    if (!proj) {
      proj = { folder, projectPath, sessions: [] };
      projList.unshift(proj);
    }
    proj.sessions.unshift(session);
  }
  if (typeof injectPendingIntoTree === 'function') injectPendingIntoTree(session);
  refreshSidebar();

  await openRawTerminalSession(session);
  pollActiveSessions();
}

function runtimeLabel(runtime) {
  return runtime === 'codex' ? 'Codex' : runtime === 'claude' ? 'Claude' : runtime;
}

async function showNewSessionDialog(project, runtime = 'claude') {
  const effective = await window.api.getEffectiveSettings(project.projectPath);
  const overlay = document.createElement('div');
  overlay.className = 'new-session-overlay';
  const dialog = document.createElement('div');
  dialog.className = 'new-session-dialog';
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  dialog.innerHTML = `
    <h3>New ${escapeHtml(runtimeLabel(runtime))} Session — ${escapeHtml(shortProjectPath(project.projectPath))}</h3>
    <div class="session-config-fields"></div>
    <div class="session-config-error" role="alert" hidden></div>
    <div class="new-session-actions">
      <button type="button" class="new-session-cancel-btn">Cancel</button>
      <button type="button" class="new-session-start-btn">Start</button>
    </div>`;
  const form = SessionConfigForm.mount(dialog.querySelector('.session-config-fields'), { runtime, defaults: effective });
  overlay.appendChild(dialog);
  document.body.appendChild(overlay);
  function close() { overlay.remove(); document.removeEventListener('keydown', onKey); }
  function start() {
    let options;
    try { options = form.getOptions(); } catch (err) {
      const error = dialog.querySelector('.session-config-error');
      error.textContent = err.message; error.hidden = false;
      return;
    }
    close();
    launchNewSession(project, { ...options, runtime });
  }
  dialog.querySelector('.new-session-cancel-btn').onclick = close;
  dialog.querySelector('.new-session-start-btn').onclick = start;
  function onKey(e) {
    if (e.key === 'Escape') close();
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) start();
  }
  document.addEventListener('keydown', onKey);
}

async function showResumeSessionDialog(session) {
  const effective = await window.api.getEffectiveSettings(session.projectPath);
  // Same form as New Session, for the CLI that wrote this session, so a codex
  // session shows and passes codex settings rather than Claude's.
  const runtime = session.runtime || 'claude';
  const sessionName = session.name || session.aiTitle || session.summary || session.sessionId.slice(0, 8);
  const overlay = document.createElement('div');
  overlay.className = 'new-session-overlay';
  const dialog = document.createElement('div');
  dialog.className = 'new-session-dialog';
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  dialog.innerHTML = `
    <h3>Resume ${escapeHtml(runtimeLabel(runtime))} Session — ${escapeHtml(sessionName)}</h3>
    <div class="session-config-fields"></div>
    <div class="session-config-error" role="alert" hidden></div>
    <div class="new-session-actions">
      <button type="button" class="new-session-cancel-btn">Cancel</button>
      <button type="button" class="new-session-start-btn">Resume</button>
    </div>`;
  const form = SessionConfigForm.mount(dialog.querySelector('.session-config-fields'), { runtime, defaults: effective, resume: true });
  overlay.appendChild(dialog);
  document.body.appendChild(overlay);
  function close() { overlay.remove(); document.removeEventListener('keydown', onKey); }
  function resume() {
    let options;
    try { options = form.getOptions(); } catch (err) {
      const error = dialog.querySelector('.session-config-error');
      error.textContent = err.message; error.hidden = false;
      return;
    }
    close();
    openSession(session, options);
  }
  dialog.querySelector('.new-session-cancel-btn').onclick = close;
  dialog.querySelector('.new-session-start-btn').onclick = resume;
  function onKey(e) {
    if (e.key === 'Escape') close();
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey || !e.target.matches('input, textarea, select'))) resume();
  }
  document.addEventListener('keydown', onKey);
}

// Settings viewer is in settings-panel.js (openSettingsViewer / closeSettingsViewer)
// Global settings button & add project button bindings are in app.js (need DOM refs)

function showAddProjectDialog() {
  const overlay = document.createElement('div');
  overlay.className = 'add-project-overlay';

  const dialog = document.createElement('div');
  dialog.className = 'add-project-dialog';

  dialog.innerHTML = `
    <h3>Add Folder</h3>
    <div class="add-project-hint">Select a folder. Its sessions appear in the Sessions tab. To start a session in a folder that is already listed, use the + on its header.</div>
    <div class="folder-input-row">
      <input type="text" id="add-project-path" placeholder="/path/to/folder" autocomplete="off" spellcheck="false">
      <button class="add-project-browse-btn">Browse</button>
    </div>
    <div class="add-project-error" id="add-project-error"></div>
    <div class="add-project-actions">
      <button class="add-project-cancel-btn">Cancel</button>
      <button class="add-project-add-btn">Add</button>
    </div>
  `;

  overlay.appendChild(dialog);
  document.body.appendChild(overlay);

  const pathInput = dialog.querySelector('#add-project-path');
  const errorEl = dialog.querySelector('#add-project-error');
  pathInput.focus();

  function close() {
    overlay.remove();
    document.removeEventListener('keydown', onKey);
  }

  async function addProject() {
    const projectPath = pathInput.value.trim();
    if (!projectPath) {
      errorEl.textContent = 'Please enter a folder path.';
      errorEl.style.display = 'block';
      return;
    }
    errorEl.style.display = 'none';
    const result = await window.api.addProject(projectPath);
    if (result.error) {
      errorEl.textContent = result.error;
      errorEl.style.display = 'block';
      return;
    }
    close();

    await loadProjects();
  }

  dialog.querySelector('.add-project-browse-btn').onclick = async () => {
    const folder = await window.api.browseFolder();
    if (folder) pathInput.value = folder;
  };

  dialog.querySelector('.add-project-cancel-btn').onclick = close;
  dialog.querySelector('.add-project-add-btn').onclick = addProject;

  function onKey(e) {
    if (e.key === 'Escape') close();
    if (e.key === 'Enter') addProject();
  }
  document.addEventListener('keydown', onKey);
}
