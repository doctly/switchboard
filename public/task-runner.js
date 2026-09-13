// Compact .vscode/tasks.json launcher and retained task log terminals.
// Project data is hydrated before sidebar rendering; task processes themselves
// live in the main process so renderer reloads can reattach to their output.

const taskLogViews = new Map();
let activeTaskView = null;
let openTaskPopover = null;
// Every folder's tasks by path, including folders that only a project knows
// about (attached folders and project roots with no sessions of their own).
// The Projects tab builds its combined task menu from this.
const tasksByPath = new Map();

function taskViewKey(projectPath, label) {
  return `${projectPath}\0${label}`;
}

function findProject(projectPath) {
  for (const projects of [cachedProjects, cachedAllProjects]) {
    const project = projects.find(item => item.projectPath === projectPath);
    if (project) return project;
  }
  const entry = tasksByPath.get(projectPath);
  if (entry) return { projectPath, tasks: entry.tasks, taskError: entry.error, hasTaskFile: entry.hasTaskFile };
  return null;
}

async function hydrateProjectTasks(projectLists, extraPaths = []) {
  const projects = projectLists.flat();
  const paths = [...new Set([...projects.map(project => project.projectPath), ...extraPaths])];
  if (!paths.length) return;
  let results;
  try { results = await window.api.listTasksForProjects(paths); } catch { return; }
  for (const p of paths) {
    const result = results[p] || { tasks: [], error: null, hasTaskFile: false };
    tasksByPath.set(p, { tasks: result.tasks || [], error: result.error || null, hasTaskFile: !!result.hasTaskFile });
  }
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
  // A project's button spans several folders; remember them so a change in any
  // one of them refreshes the badge (updateProjectTaskButtons).
  if (Array.isArray(project.projectPaths)) button.dataset.projectPaths = project.projectPaths.join('\n');
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
    if (button.dataset.projectPaths) {
      // Projects tab: the button is a union over several folders.
      if (!button.dataset.projectPaths.split('\n').includes(projectPath)) return;
      if (typeof findTreeProject !== 'function' || typeof taskPseudoProject !== 'function') return;
      const node = findTreeProject(button.dataset.projectId);
      if (node) updateTaskButton(button, taskPseudoProject(node));
      return;
    }
    if (button.dataset.projectPath === projectPath) updateTaskButton(button, project);
  });
  if (typeof updateProjectTaskIndicators === 'function') updateProjectTaskIndicators(projectPath);
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
  // The popover scrolls, and every task state change rebuilds it. Keep the
  // offset so starting a task near the bottom does not jump to the top.
  const scrollTop = popover.scrollTop;
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
      for (const p of project.projectPaths || [project.projectPath]) {
        await window.api.stopAllTasks(p);
      }
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

  let lastGroup = null;
  for (const task of project.tasks || []) {
    // A project's menu combines several folders; each task remembers its own.
    const taskPath = task.projectPath || project.projectPath;
    if (task.groupLabel && task.groupLabel !== lastGroup) {
      const group = document.createElement('div');
      group.className = 'task-popover-group';
      group.textContent = task.groupLabel;
      popover.appendChild(group);
      lastGroup = task.groupLabel;
    }
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
      // Start, restart and stop all keep the menu open: the row's state
      // column is the feedback. The log is a click on the name away.
      if (task.run?.running) {
        await window.api.stopTask(taskPath, task.label);
      } else if (task.run) {
        await restartProjectTask(taskPath, task.label, { showLog: false });
      } else {
        await runProjectTask(taskPath, task.label, { showLog: false });
      }
    });
    row.append(copy, state);
    if (task.run?.running) {
      // A running server gets restart beside stop, the same pair as the log header.
      const restart = document.createElement('button');
      restart.className = 'task-row-action restart';
      restart.title = `Restart ${task.label}`;
      restart.innerHTML = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 11a8.1 8.1 0 1 0 2 5.3"/><path d="M20 4v7h-7"/></svg>';
      restart.addEventListener('click', async event => {
        event.stopPropagation();
        restart.disabled = true;
        await restartProjectTask(taskPath, task.label, { showLog: false });
      });
      row.appendChild(restart);
    }
    row.appendChild(action);

    row.addEventListener('click', async () => {
      if (task.supported === false) return;
      if (task.run) {
        closeTaskPopover();
        await showTaskLog(taskPath, task.label);
      } else {
        await runProjectTask(taskPath, task.label, { showLog: false });
      }
    });
    popover.appendChild(row);
  }
  popover.scrollTop = scrollTop;
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
  openTaskPopover = {
    projectPath: project.projectPath, element: popover, anchor,
    projectPaths: project.projectPaths || null, projectId: project.id || null,
  };
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
  // Inside a project the log opens beside the session pane, not over it.
  hideViewerPanels();
  if (typeof onTaskLogShown === 'function') onTaskLogShown();
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

async function runProjectTask(projectPath, label, { showLog = true } = {}) {
  const run = await window.api.startTask(projectPath, label);
  applyTaskRun(run);
  if (!showLog) return;
  await showTaskLog(projectPath, label);
  if (run.error && !run.running) {
    const entry = taskLogViews.get(taskViewKey(projectPath, label));
    if (entry && !(run.output || '').includes(run.error)) entry.terminal.write(`\r\nTask failed: ${run.error}\r\n`);
  }
}

async function restartProjectTask(projectPath, label, { showLog = true } = {}) {
  const entry = taskLogViews.get(taskViewKey(projectPath, label));
  if (entry) {
    entry.terminal.reset();
    entry.outputMirror = '';
    entry.loading = false;
    entry.queued = [];
  }
  const run = await window.api.restartTask(projectPath, label);
  if (run) applyTaskRun(run);
  if (showLog) await showTaskLog(projectPath, label);
}

function applyTaskRun(run) {
  if (!run?.projectPath || !run.label) return;
  for (const projects of [cachedProjects, cachedAllProjects]) {
    const project = projects.find(item => item.projectPath === run.projectPath);
    const task = project?.tasks?.find(item => item.label === run.label);
    if (task) task.run = run;
  }
  const byPath = tasksByPath.get(run.projectPath)?.tasks?.find(item => item.label === run.label);
  if (byPath) byPath.run = run;
  updateProjectTaskButtons(run.projectPath);
  updateTaskHeader(run);
  if (openTaskPopover?.projectPaths?.includes(run.projectPath)) {
    const node = typeof findTreeProject === 'function' ? findTreeProject(openTaskPopover.projectId) : null;
    if (node && typeof taskPseudoProject === 'function') renderTaskPopover(taskPseudoProject(node), openTaskPopover.element);
  } else if (openTaskPopover?.projectPath === run.projectPath) {
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
  tasksByPath.set(projectPath, { tasks: result.tasks || [], error: result.error || null, hasTaskFile: !!result.hasTaskFile });
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
