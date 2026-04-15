// --- Plans & Memory viewers ---
// Depends on globals: cachedPlans, plansContent, planPanel, planViewer,
// memoryContent, memoryPanel, memoryViewer, placeholder, terminalArea,
// statsViewer, settingsViewer, jsonlViewer (app.js)
// Depends on: formatDate (utils.js)

let currentPlanContent = "";
let currentPlanFilePath = "";
let currentPlanFilename = "";
let cachedMemoryData = { global: { files: [] }, projects: [] };
let currentMemoryFilePath = null;
let currentMemoryContent = "";
const memoryCollapsedState = new Map();

// --- Plans ---
async function loadPlans() {
  cachedPlans = await window.api.getPlans();
  renderPlans();
}

function renderPlans(plans) {
  plans = plans || cachedPlans;
  plansContent.innerHTML = '';
  if (plans.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'plans-empty';
    empty.textContent = 'No plans found in ~/.claude/plans/';
    plansContent.appendChild(empty);
    return;
  }
  for (const plan of plans) {
    plansContent.appendChild(buildPlanItem(plan));
  }
}

function buildPlanItem(plan) {
  const item = document.createElement('div');
  item.className = 'session-item plan-item';

  const row = document.createElement('div');
  row.className = 'session-row';

  const info = document.createElement('div');
  info.className = 'session-info';

  const titleEl = document.createElement('div');
  titleEl.className = 'session-summary';
  titleEl.textContent = plan.title;

  const filenameEl = document.createElement('div');
  filenameEl.className = 'session-id';
  filenameEl.textContent = plan.filename;

  const metaEl = document.createElement('div');
  metaEl.className = 'session-meta';
  metaEl.textContent = formatDate(new Date(plan.modified));

  info.appendChild(titleEl);
  info.appendChild(filenameEl);
  info.appendChild(metaEl);
  row.appendChild(info);
  item.appendChild(row);

  item.addEventListener('click', () => openPlan(plan));
  return item;
}

async function openPlan(plan) {
  // Mark active in sidebar
  plansContent.querySelectorAll('.plan-item.active').forEach(el => el.classList.remove('active'));
  const items = plansContent.querySelectorAll('.plan-item');
  items.forEach(el => {
    if (el.querySelector('.session-id')?.textContent === plan.filename) {
      el.classList.add('active');
    }
  });

  const result = await window.api.readPlan(plan.filename);
  currentPlanContent = result.content;
  currentPlanFilePath = result.filePath;
  currentPlanFilename = plan.filename;

  // Hide terminal area and placeholder, show plan viewer
  placeholder.style.display = 'none';
  terminalArea.style.display = 'none';
  statsViewer.style.display = 'none';
  memoryViewer.style.display = 'none';
  settingsViewer.style.display = 'none';
  planViewer.style.display = 'flex';

  planPanel.open(plan.title, currentPlanFilePath, currentPlanContent);
}

function hideAllViewers() {
  planViewer.style.display = 'none';
  statsViewer.style.display = 'none';
  memoryViewer.style.display = 'none';
  settingsViewer.style.display = 'none';
  jsonlViewer.style.display = 'none';
  terminalArea.style.display = '';
}

function hidePlanViewer() {
  hideAllViewers();
}

// --- Memory ---

async function loadMemories() {
  cachedMemoryData = await window.api.getMemories();
  renderMemories();
}

function renderMemories(filterIds) {
  memoryContent.innerHTML = '';
  const data = cachedMemoryData;
  const allFiles = [...data.global.files, ...data.projects.flatMap(p => p.files)];
  if (allFiles.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'plans-empty';
    empty.textContent = 'No memory files found.';
    memoryContent.appendChild(empty);
    return;
  }

  // Global group
  if (data.global.files.length > 0) {
    const globalFiles = filterIds ? data.global.files.filter(f => filterIds.has(f.filePath)) : data.global.files;
    if (globalFiles.length > 0) {
      memoryContent.appendChild(buildMemoryGroup('__global__', 'Global', globalFiles));
    }
  }

  // Per-project groups
  for (const proj of data.projects) {
    const projFiles = filterIds ? proj.files.filter(f => filterIds.has(f.filePath)) : proj.files;
    if (projFiles.length === 0) continue;
    memoryContent.appendChild(buildMemoryGroup(proj.folder, proj.shortName, projFiles));
  }
}

function buildMemoryGroup(key, label, files) {
  const group = document.createElement('div');
  group.className = 'project-group';
  const isCollapsed = memoryCollapsedState.get(key) === true; // default expanded
  if (isCollapsed) group.classList.add('collapsed');

  // Header
  const header = document.createElement('div');
  header.className = 'project-header';

  const arrow = document.createElement('span');
  arrow.className = 'arrow';
  arrow.innerHTML = '&#9660;';
  header.appendChild(arrow);

  const nameSpan = document.createElement('span');
  nameSpan.className = 'project-name';
  nameSpan.textContent = label;
  header.appendChild(nameSpan);

  const countBadge = document.createElement('span');
  countBadge.className = 'memory-file-count';
  countBadge.textContent = files.length;
  header.appendChild(countBadge);

  header.addEventListener('click', () => {
    const nowCollapsed = !group.classList.contains('collapsed');
    group.classList.toggle('collapsed');
    memoryCollapsedState.set(key, nowCollapsed);
  });

  group.appendChild(header);

  // Files list
  const filesList = document.createElement('div');
  filesList.className = 'project-sessions';
  for (const file of files) {
    filesList.appendChild(buildMemoryItem(file));
  }
  group.appendChild(filesList);

  return group;
}

function buildMemoryItem(file) {
  const item = document.createElement('div');
  item.className = 'session-item memory-item';
  item.dataset.filepath = file.filePath;

  const row = document.createElement('div');
  row.className = 'session-row';

  // Icon: schedule clock for schedule-*.md files, brain for everything else
  const isSchedule = file.filename.startsWith('schedule-');
  const icon = document.createElement('span');
  icon.className = isSchedule ? 'memory-schedule-icon' : 'memory-brain-icon';
  icon.innerHTML = isSchedule
    ? ICONS.schedule(15)
    : '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z"/><path d="M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z"/><path d="M15 13a4.5 4.5 0 0 1-3-4 4.5 4.5 0 0 1-3 4"/><path d="M17.599 6.5a3 3 0 0 0 .399-1.375"/><path d="M6.003 5.125A3 3 0 0 0 6.401 6.5"/><path d="M3.477 10.896a4 4 0 0 1 .585-.396"/><path d="M19.938 10.5a4 4 0 0 1 .585.396"/><path d="M6 18a4 4 0 0 1-1.967-.516"/><path d="M19.967 17.484A4 4 0 0 1 18 18"/></svg>';
  row.appendChild(icon);

  const info = document.createElement('div');
  info.className = 'session-info';

  const titleEl = document.createElement('div');
  titleEl.className = 'session-summary';
  titleEl.textContent = file.filename;

  const pathEl = document.createElement('div');
  pathEl.className = 'session-id';
  pathEl.textContent = file.displayPath;

  const metaEl = document.createElement('div');
  metaEl.className = 'session-meta';
  metaEl.textContent = formatDate(new Date(file.modified));

  info.appendChild(titleEl);
  info.appendChild(pathEl);
  info.appendChild(metaEl);
  row.appendChild(info);

  // Play button for schedule files
  if (isSchedule) {
    const playBtn = document.createElement('button');
    playBtn.className = 'schedule-play-btn';
    playBtn.title = 'Run now';
    playBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 384 512" fill="currentColor" stroke="currentColor" stroke-width="0"><path d="M73 39c-14.8-9.1-33.4-9.4-48.5-.9S0 62.6 0 80L0 432c0 17.4 9.4 33.4 24.5 41.9s33.7 8.1 48.5-.9L361 297c14.3-8.7 23-24.2 23-41s-8.7-32.2-23-41L73 39z"></path></svg>';
    const playIcon = '<svg width="12" height="12" viewBox="0 0 384 512" fill="currentColor" stroke="currentColor" stroke-width="0"><path d="M73 39c-14.8-9.1-33.4-9.4-48.5-.9S0 62.6 0 80L0 432c0 17.4 9.4 33.4 24.5 41.9s33.7 8.1 48.5-.9L361 297c14.3-8.7 23-24.2 23-41s-8.7-32.2-23-41L73 39z"></path></svg>';
    const spinnerIcon = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/></svg>';
    const checkIcon = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';
    playBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      playBtn.classList.add('running');
      playBtn.innerHTML = spinnerIcon;
      playBtn.title = 'Running...';
      const result = await window.api.runScheduleNow(file.filePath);
      playBtn.classList.remove('running');
      playBtn.classList.add('done');
      playBtn.innerHTML = checkIcon;
      playBtn.title = 'Launched!';
      setTimeout(() => {
        playBtn.classList.remove('done');
        playBtn.innerHTML = playIcon;
        playBtn.title = 'Run now';
      }, 2000);
      if (result && !result.ok) {
        console.error('Schedule run failed:', result.error);
      }
    });
    row.appendChild(playBtn);
  }

  item.appendChild(row);

  item.addEventListener('click', () => openMemory(file));
  return item;
}

async function openMemory(file) {
  // Mark active in sidebar
  memoryContent.querySelectorAll('.memory-item.active').forEach(el => el.classList.remove('active'));
  const target = memoryContent.querySelector(`.memory-item[data-filepath="${CSS.escape(file.filePath)}"]`);
  if (target) target.classList.add('active');

  const content = await window.api.readMemory(file.filePath);
  currentMemoryFilePath = file.filePath;
  currentMemoryContent = content;

  // Show memory viewer in main area
  placeholder.style.display = 'none';
  terminalArea.style.display = 'none';
  planViewer.style.display = 'none';
  statsViewer.style.display = 'none';
  settingsViewer.style.display = 'none';
  memoryViewer.style.display = 'flex';

  memoryPanel.open(file.filename, file.filePath, content);
}
