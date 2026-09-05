// Compact .vscode/tasks.json launcher and retained task log terminals.
// Project data is hydrated before sidebar rendering; task processes themselves
// live in the main process so renderer reloads can reattach to their output.

const taskLogViews = new Map();
let activeTaskView = null;
let openTaskPopover = null;

function taskViewKey(projectPath, label) {
  return `${projectPath}\0${label}`;
}

function findProject(projectPath) {
  for (const projects of [cachedProjects, cachedAllProjects]) {
    const project = projects.find(item => item.projectPath === projectPath);
    if (project) return project;
  }
  return null;
}

async function hydrateProjectTasks(projectLists) {
  const projects = projectLists.flat();
  const paths = [...new Set(projects.map(project => project.projectPath))];
  if (!paths.length) return;
  let results;
  try { results = await window.api.listTasksForProjects(paths); } catch { return; }
  for (const project of projects) {
    const result = results[project.projectPath] || { tasks: [], error: null, hasTaskFile: false };
    project.tasks = result.tasks || [];
    project.taskError = result.error || null;
    project.hasTaskFile = !!result.hasTaskFile;
  }
}

function runningTaskCount(project) {
  return (project?.tasks || []).filter(task => task.run?.running).length;
}

function createProjectTaskButton(project, worktree = false) {
  const button = document.createElement('button');
  button.className = `project-task-btn${worktree ? ' worktree-task-btn' : ''}`;
  button.dataset.projectPath = project.projectPath;
  button.title = project.taskError ? 'Task file has an error' : 'Run project task';
  button.innerHTML = `
    <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M4 2.8a1 1 0 0 1 1.52-.85l8 5.2a1 1 0 0 1 0 1.7l-8 5.2A1 1 0 0 1 4 13.2V2.8Z"/></svg>
    <span class="project-task-count"></span>`;
  updateTaskButton(button, project);
  return button;
}

function updateTaskButton(button, project) {
  const count = runningTaskCount(project);
  button.classList.toggle('running', count > 0);
  button.classList.toggle('error', !!project?.taskError);
  const badge = button.querySelector('.project-task-count');
  if (badge) {
    badge.textContent = count ? String(count) : '';
    badge.style.display = count ? '' : 'none';
  }
  button.title = project?.taskError
    ? project.taskError
    : (count
      ? `${count} task${count === 1 ? '' : 's'} running`
      : (project?.hasTaskFile ? 'Run project task' : 'Set up project tasks'));
}

function updateProjectTaskButtons(projectPath) {
  const project = findProject(projectPath);
  document.querySelectorAll('.project-task-btn').forEach(button => {
    if (button.dataset.projectPath === projectPath) updateTaskButton(button, project);
  });
}

function closeTaskPopover() {
  openTaskPopover?.element.remove();
  openTaskPopover = null;
}

function taskStateText(run) {
  if (!run) return '';
  if (run.state === 'running') return 'Running';
  if (run.state === 'failed') return run.exitCode == null ? 'Failed' : `Failed (${run.exitCode})`;
  if (run.state === 'exited') return run.exitCode == null ? 'Finished' : `Exited ${run.exitCode}`;
  if (run.state === 'stopped') return 'Stopped';
  return '';
}

function renderTaskPopover(project, popover) {
  popover.replaceChildren();
  const header = document.createElement('div');
  header.className = 'task-popover-header';
  const headerLabel = document.createElement('span');
  headerLabel.textContent = project.taskError ? 'Task configuration error' : 'Project tasks';
  header.appendChild(headerLabel);
  const runningCount = runningTaskCount(project);
  if (!project.taskError && runningCount > 0) {
    const stopAllButton = document.createElement('button');
    stopAllButton.className = 'task-popover-stop-all';
    stopAllButton.title = `Stop all ${runningCount} running task${runningCount === 1 ? '' : 's'}`;
    stopAllButton.innerHTML = '<svg width="9" height="9" viewBox="0 0 12 12" fill="currentColor"><rect x="2" y="2" width="8" height="8" rx="1"/></svg><span>Stop all</span>';
    stopAllButton.addEventListener('click', async event => {
      event.stopPropagation();
      stopAllButton.disabled = true;
      await window.api.stopAllTasks(project.projectPath);
    });
    header.appendChild(stopAllButton);
  }
  popover.appendChild(header);

  if (project.taskError) {
    const error = document.createElement('div');
    error.className = 'task-popover-error';
    error.textContent = project.taskError;
    popover.appendChild(error);
    return;
  }

  if (!(project.tasks || []).length) {
    const empty = document.createElement('div');
    empty.className = 'task-popover-empty';
    empty.textContent = project.hasTaskFile
      ? 'No tasks are configured in .vscode/tasks.json.'
      : 'Create a .vscode/tasks.json to get started.';
    popover.appendChild(empty);
    return;
  }

  for (const task of project.tasks || []) {
    const row = document.createElement('div');
    row.className = 'task-popover-row';
    row.classList.toggle('unsupported', task.supported === false);
    row.setAttribute('role', 'button');
    row.tabIndex = task.supported === false ? -1 : 0;
    row.dataset.taskLabel = task.label;

    const copy = document.createElement('span');
    copy.className = 'task-row-copy';
    const name = document.createElement('span');
    name.className = 'task-row-name';
    name.textContent = task.label;
    const detail = document.createElement('span');
    detail.className = 'task-row-detail';
    detail.textContent = task.error || task.detail || (task.type === 'compound' ? 'Compound task' : task.type);
    copy.append(name, detail);

    const state = document.createElement('span');
    state.className = `task-row-state ${task.run?.state || ''}`;
    state.textContent = taskStateText(task.run);
    const action = document.createElement('button');
    action.className = `task-row-action${task.run?.running ? ' stop' : ''}`;
    action.title = task.run?.running ? `Stop ${task.label}` : `Run ${task.label}`;
    action.innerHTML = task.run?.running
      ? '<svg width="10" height="10" viewBox="0 0 12 12" fill="currentColor"><rect x="2" y="2" width="8" height="8" rx="1"/></svg>'
      : '<svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor"><path d="M4 2.8a1 1 0 0 1 1.52-.85l8 5.2a1 1 0 0 1 0 1.7l-8 5.2A1 1 0 0 1 4 13.2V2.8Z"/></svg>';
    action.disabled = task.supported === false;
    action.addEventListener('click', async event => {
      event.stopPropagation();
      if (task.run?.running) {
        await window.api.stopTask(project.projectPath, task.label);
      } else if (task.run) {
        await restartProjectTask(project.projectPath, task.label);
        closeTaskPopover();
      } else {
        await runProjectTask(project.projectPath, task.label);
        closeTaskPopover();
      }
    });
    row.append(copy, state, action);

    row.addEventListener('click', async () => {
      if (task.supported === false) return;
      if (task.run) {
        closeTaskPopover();
        await showTaskLog(project.projectPath, task.label);
      } else {
        await runProjectTask(project.projectPath, task.label);
        closeTaskPopover();
      }
    });
    popover.appendChild(row);
  }
}

function showTaskPopover(project, anchor) {
  closeTaskPopover();
  const popover = document.createElement('div');
  popover.className = 'task-popover';
  document.body.appendChild(popover);
  renderTaskPopover(project, popover);

  const rect = anchor.getBoundingClientRect();
  const width = Math.min(320, window.innerWidth - 16);
  popover.style.width = `${width}px`;
  const left = Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8));
  let top = rect.bottom + 6;
  if (top + popover.offsetHeight > window.innerHeight - 8) top = Math.max(8, rect.top - popover.offsetHeight - 6);
  popover.style.left = `${left}px`;
  popover.style.top = `${top}px`;
  openTaskPopover = { projectPath: project.projectPath, element: popover, anchor };
  setTimeout(() => document.addEventListener('pointerdown', dismissTaskPopover, { once: true }), 0);
}

function dismissTaskPopover(event) {
  if (openTaskPopover?.element.contains(event.target) || openTaskPopover?.anchor.contains(event.target)) {
    document.addEventListener('pointerdown', dismissTaskPopover, { once: true });
    return;
  }
  closeTaskPopover();
}

function createTaskLogView(projectPath, label) {
  const key = taskViewKey(projectPath, label);
  if (taskLogViews.has(key)) return taskLogViews.get(key);

  const container = document.createElement('div');
  container.className = 'terminal-container task-log-container';
  terminalsEl.appendChild(container);
  const terminal = new Terminal({
    fontSize: 12,
    fontFamily: "'SF Mono', 'Fira Code', 'Cascadia Code', Menlo, monospace",
    theme: TERMINAL_THEME,
    cursorBlink: false,
    scrollback: 10000,
    convertEol: true,
    allowProposedApi: true,
    macOptionClickForcesSelection: true,
  });
  const fitAddon = new FitAddon.FitAddon();
  terminal.loadAddon(fitAddon);
  terminal.loadAddon(new WebLinksAddon.WebLinksAddon((_event, url) => window.api.openExternal(url)));
  terminal.loadAddon(new UnicodeGraphemesAddon.UnicodeGraphemesAddon());
  terminal.unicode.activeVersion = '15';
  terminal.open(container);
  container.style.backgroundColor = TERMINAL_THEME.background;
  try {
    const webglAddon = new WebglAddon.WebglAddon();
    webglAddon.onContextLoss(() => webglAddon.dispose());
    terminal.loadAddon(webglAddon);
  } catch {}

  terminal.onData(data => window.api.sendTaskInput(projectPath, label, data));
  terminal.onResize(({ cols, rows }) => window.api.resizeTask(projectPath, label, cols, rows));
  const entry = {
    key, projectPath, label, terminal, fitAddon, element: container,
    loading: false, outputMirror: '', queued: [],
  };
  taskLogViews.set(key, entry);
  return entry;
}

function fitTaskLog(entry) {
  requestAnimationFrame(() => {
    try {
      const dimensions = entry.fitAddon.proposeDimensions();
      if (dimensions?.rows > 1) entry.terminal.resize(dimensions.cols, dimensions.rows);
      else entry.fitAddon.fit();
      entry.terminal.scrollToBottom();
    } catch {}
  });
}

function updateTaskHeader(run) {
  if (!activeTaskView || !run) return;
  if (run.projectPath !== activeTaskView.projectPath || run.label !== activeTaskView.label) return;
  terminalHeaderStatus.className = run.running ? 'running' : (run.state === 'failed' ? 'failed' : 'stopped');
  terminalHeaderStatus.textContent = taskStateText(run) || 'Ready';
  terminalStopBtn.style.display = run.running ? '' : 'none';
  const restartButton = document.getElementById('terminal-restart-task-btn');
  if (restartButton) restartButton.style.display = '';
}

async function showTaskLog(projectPath, label) {
  const entry = createTaskLogView(projectPath, label);
  activeTaskView = { projectPath, label };
  sessionStorage.setItem('activeTaskView', JSON.stringify(activeTaskView));
  setActiveSession(null);
  document.querySelectorAll('.session-item.active').forEach(item => item.classList.remove('active'));
  document.querySelectorAll('.terminal-container').forEach(element => element.classList.remove('visible'));
  hideAllViewers();
  placeholder.style.display = 'none';
  gridViewer.style.display = 'none';
  terminalHeader.style.display = '';
  terminalHeaderName.textContent = label;
  terminalHeaderId.textContent = shortProjectPath(projectPath);
  terminalHeaderShell.textContent = 'Task';
  terminalHeaderShell.style.display = '';
  const ptyTitle = document.getElementById('terminal-header-pty-title');
  if (ptyTitle) ptyTitle.style.display = 'none';
  entry.element.classList.add('visible');
  entry.terminal.focus();
  fitTaskLog(entry);

  entry.loading = true;
  entry.queued = [];
  let run = null;
  try {
    run = await window.api.getTaskRun(projectPath, label);
  } catch (error) {
    run = {
      projectPath, label, state: 'failed', running: false,
      output: `\r\n[Could not load retained task output: ${error.message}]\r\n`,
    };
  }
  if (run) {
    const queued = entry.queued.join('');
    let retainedOutput = run.output || '';
    if (queued && !retainedOutput.endsWith(queued)) retainedOutput += queued;
    if (entry.outputMirror !== retainedOutput) {
      entry.terminal.reset();
      entry.terminal.write(retainedOutput);
      entry.outputMirror = retainedOutput;
    }
  }
  entry.queued = [];
  entry.loading = false;
  updateTaskHeader(run || { projectPath, label, state: 'idle', running: false });
}

function leaveTaskLogView() {
  activeTaskView = null;
  sessionStorage.removeItem('activeTaskView');
  const restartButton = document.getElementById('terminal-restart-task-btn');
  if (restartButton) restartButton.style.display = 'none';
}

async function runProjectTask(projectPath, label) {
  const run = await window.api.startTask(projectPath, label);
  applyTaskRun(run);
  await showTaskLog(projectPath, label);
  if (run.error && !run.running) {
    const entry = taskLogViews.get(taskViewKey(projectPath, label));
    if (entry && !(run.output || '').includes(run.error)) entry.terminal.write(`\r\nTask failed: ${run.error}\r\n`);
  }
}

async function restartProjectTask(projectPath, label) {
  const entry = taskLogViews.get(taskViewKey(projectPath, label));
  if (entry) {
    entry.terminal.reset();
    entry.outputMirror = '';
    entry.loading = false;
    entry.queued = [];
  }
  await window.api.restartTask(projectPath, label);
  await showTaskLog(projectPath, label);
}

function applyTaskRun(run) {
  if (!run?.projectPath || !run.label) return;
  for (const projects of [cachedProjects, cachedAllProjects]) {
    const project = projects.find(item => item.projectPath === run.projectPath);
    const task = project?.tasks?.find(item => item.label === run.label);
    if (task) task.run = run;
  }
  updateProjectTaskButtons(run.projectPath);
  updateTaskHeader(run);
  if (openTaskPopover?.projectPath === run.projectPath) {
    const project = findProject(run.projectPath);
    if (project) renderTaskPopover(project, openTaskPopover.element);
  }
}

async function restoreActiveTaskView() {
  if (activeSessionId) return;
  let saved;
  try { saved = JSON.parse(sessionStorage.getItem('activeTaskView') || 'null'); } catch {}
  if (!saved?.projectPath || !saved.label) return;
  const project = findProject(saved.projectPath);
  if (project?.tasks?.some(task => task.label === saved.label)) {
    await showTaskLog(saved.projectPath, saved.label);
  }
}

window.api.onTaskOutput((projectPath, label, data) => {
  const entry = taskLogViews.get(taskViewKey(projectPath, label));
  if (!entry) return;
  if (entry.loading) entry.queued.push(data);
  else {
    entry.outputMirror += data;
    entry.terminal.write(data);
  }
});

window.api.onTaskStateChanged(run => applyTaskRun(run));

window.api.onProjectTasksChanged(async projectPath => {
  let result;
  try { result = await window.api.listProjectTasks(projectPath); } catch { return; }
  for (const projects of [cachedProjects, cachedAllProjects]) {
    const project = projects.find(item => item.projectPath === projectPath);
    if (!project) continue;
    project.tasks = result.tasks || [];
    project.taskError = result.error || null;
    project.hasTaskFile = !!result.hasTaskFile;
  }
  closeTaskPopover();
  refreshSidebar();
});

document.getElementById('terminal-stop-btn').addEventListener('click', async () => {
  if (!activeTaskView) return;
  const { projectPath, label } = activeTaskView;
  const result = await window.api.stopTask(projectPath, label);
  if (result.ok) {
    const run = await window.api.getTaskRun(projectPath, label);
    applyTaskRun(run);
  }
});

document.getElementById('terminal-restart-task-btn').addEventListener('click', async () => {
  if (!activeTaskView) return;
  const { projectPath, label } = activeTaskView;
  await restartProjectTask(projectPath, label);
});

window.addEventListener('resize', () => {
  if (!activeTaskView) return;
  const entry = taskLogViews.get(taskViewKey(activeTaskView.projectPath, activeTaskView.label));
  if (entry) fitTaskLog(entry);
});
