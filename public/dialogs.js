// --- Dialogs & session launch helpers ---
// Depends on globals: launchNewSession, cachedProjects, cachedAllProjects, sessionMap,
// pendingSessions, openSessions, activePtyIds, refreshSidebar, pollActiveSessions (app.js)
// Depends on: ICONS (icons.js)

// --- New session dialog ---
async function resolveDefaultSessionOptions(project) {
  const effective = await window.api.getEffectiveSettings(project.projectPath);
  const options = {};
  if (effective.dangerouslySkipPermissions) {
    options.dangerouslySkipPermissions = true;
  } else if (effective.permissionMode) {
    options.permissionMode = effective.permissionMode;
  }
  if (effective.worktree) {
    options.worktree = true;
    if (effective.worktreeName) options.worktreeName = effective.worktreeName;
  }
  if (effective.chrome) options.chrome = true;
  if (effective.preLaunchCmd) options.preLaunchCmd = effective.preLaunchCmd;
  if (effective.addDirs) options.addDirs = effective.addDirs;
  if (effective.mcpEmulation === false) options.mcpEmulation = false;
  return options;
}

async function forkSession(session, project) {
  const options = await resolveDefaultSessionOptions(project);
  options.forkFrom = session.sessionId;
  // Remote sessions fork on the host (claude --resume <id> --fork-session).
  if (session.remote || (project && project.remote)) {
    const host = {
      id: (project && project.hostId) || session.hostId || session.source,
      label: (project && project.hostLabel) || session.remoteLabel,
    };
    launchRemoteSession(host, {
      remoteMode: 'claude',
      remoteDir: (project && project.remotePath) || session.remotePath || '~',
      forkFrom: session.sessionId,
      permissionMode: options.permissionMode,
      dangerouslySkipPermissions: options.dangerouslySkipPermissions,
      addDirs: options.addDirs,
    });
    return;
  }
  launchNewSession(project, options);
}

async function launchScheduleCreator(project) {
  const options = await resolveDefaultSessionOptions(project);
  // Pre-create a JSONL session with the schedule creation prompt, then resume into it
  const result = await window.api.createScheduleSession(project.projectPath);
  if (!result || !result.sessionId) return;

  const session = {
    sessionId: result.sessionId,
    summary: 'Create scheduled task',
    firstPrompt: '',
    projectPath: project.projectPath,
    name: null,
    starred: 0,
    archived: 0,
    messageCount: 1,
    modified: new Date().toISOString(),
    created: new Date().toISOString(),
  };

  // Inject into sidebar
  const folder = encodeProjectPath(project.projectPath);
  pendingSessions.set(result.sessionId, { session, projectPath: project.projectPath, folder });
  sessionMap.set(result.sessionId, session);
  for (const projList of [cachedProjects, cachedAllProjects]) {
    let proj = projList.find(p => p.projectPath === project.projectPath);
    if (!proj) {
      proj = { folder, projectPath: project.projectPath, sessions: [] };
      projList.unshift(proj);
    }
    proj.sessions.unshift(session);
  }
  refreshSidebar();

  const entry = createTerminalEntry(session);
  // Resume the pre-seeded session
  options.appendSystemPrompt = result.systemPrompt;
  const openResult = await window.api.openTerminal(result.sessionId, project.projectPath, false, options);
  if (!openResult.ok) {
    entry.terminal.write(`\r\nError: ${openResult.error}\r\n`);
    entry.closed = true;
    return;
  }
  if (typeof setSessionMcpActive === 'function') setSessionMcpActive(result.sessionId, !!openResult.mcpActive);
  showSession(result.sessionId);
  pollActiveSessions();
}

function showNewSessionPopover(project, anchorEl) {
  // Remove any existing popover
  document.querySelectorAll('.new-session-popover').forEach(el => el.remove());

  const popover = document.createElement('div');
  popover.className = 'new-session-popover';

  // Local and remote projects show the IDENTICAL popover (same labels, icons,
  // order) — only the underlying launcher differs. The project row already shows
  // the SSH badge + host:path, so no "(remote)" suffix is needed here.
  const isRemoteProj = !!project.remote;
  const rHost = isRemoteProj ? { id: project.hostId, label: project.hostLabel } : null;

  const claudeBtn = document.createElement('button');
  claudeBtn.className = 'popover-option';
  claudeBtn.innerHTML = '<svg class="popover-option-icon claude-icon" width="16" height="16" viewBox="0 0 1200 1200" fill="#d97757" stroke="none"><path d="M 233.959793 800.214905 L 468.644287 668.536987 L 472.590637 657.100647 L 468.644287 650.738403 L 457.208069 650.738403 L 417.986633 648.322144 L 283.892639 644.69812 L 167.597321 639.865845 L 54.926208 633.825623 L 26.577238 627.785339 L 3.3e-05 592.751709 L 2.73832 575.27533 L 26.577238 559.248352 L 60.724873 562.228149 L 136.187973 567.382629 L 249.422867 575.194763 L 331.570496 580.026978 L 453.261841 592.671082 L 472.590637 592.671082 L 475.328857 584.859009 L 468.724915 580.026978 L 463.570557 575.194763 L 346.389313 495.785217 L 219.543671 411.865906 L 153.100723 363.543762 L 117.181267 339.060425 L 99.060455 316.107361 L 91.248367 266.01355 L 123.865784 230.093994 L 167.677887 233.073853 L 178.872513 236.053772 L 223.248367 270.201477 L 318.040283 343.570496 L 441.825592 434.738342 L 459.946411 449.798706 L 467.194672 444.64447 L 468.080597 441.020203 L 459.946411 427.409485 L 392.617493 305.718323 L 320.778564 181.932983 L 288.80542 130.630859 L 280.348999 99.865845 C 277.369171 87.221436 275.194641 76.590698 275.194641 63.624268 L 312.322174 13.20813 L 332.8591 6.604126 L 382.389313 13.20813 L 403.248352 31.328979 L 434.013519 101.71814 L 483.865753 212.537048 L 561.181274 363.221497 L 583.812134 407.919434 L 595.892639 449.315491 L 600.40271 461.959839 L 608.214783 461.959839 L 608.214783 454.711609 L 614.577271 369.825623 L 626.335632 265.61084 L 637.771851 131.516846 L 641.718201 93.745117 L 660.402832 48.483276 L 697.530334 24.000122 L 726.52356 37.852417 L 750.362549 72 L 747.060486 94.067139 L 732.886047 186.201416 L 705.100708 330.52356 L 686.979919 427.167847 L 697.530334 427.167847 L 709.61084 415.087341 L 758.496704 350.174561 L 840.644348 247.490051 L 876.885925 206.738342 L 919.167847 161.71814 L 946.308838 140.29541 L 997.61084 140.29541 L 1035.38269 196.429626 L 1018.469849 254.416199 L 965.637634 321.422852 L 921.825562 378.201538 L 859.006714 462.765259 L 819.785278 530.41626 L 823.409424 535.812073 L 832.75177 534.92627 L 974.657776 504.724915 L 1051.328979 490.872559 L 1142.818848 475.167786 L 1184.214844 494.496582 L 1188.724854 514.147644 L 1172.456421 554.335693 L 1074.604126 578.496765 L 959.838989 601.449829 L 788.939636 641.879272 L 786.845764 643.409485 L 789.261841 646.389343 L 866.255127 653.637634 L 899.194702 655.409424 L 979.812134 655.409424 L 1129.932861 666.604187 L 1169.154419 692.537109 L 1192.671265 724.268677 L 1188.724854 748.429688 L 1128.322144 779.194641 L 1046.818848 759.865845 L 856.590759 714.604126 L 791.355774 698.335754 L 782.335693 698.335754 L 782.335693 703.731567 L 836.69812 756.885986 L 936.322205 846.845581 L 1061.073975 962.81897 L 1067.436279 991.490112 L 1051.409424 1014.120911 L 1034.496704 1011.704712 L 924.885986 929.234924 L 882.604126 892.107544 L 786.845764 811.48999 L 780.483276 811.48999 L 780.483276 819.946289 L 802.550415 852.241699 L 919.087341 1027.409424 L 925.127625 1081.127686 L 916.671204 1098.604126 L 886.469849 1109.154419 L 853.288696 1103.114136 L 785.073914 1007.355835 L 714.684631 899.516785 L 657.906067 802.872498 L 650.979858 806.81897 L 617.476624 1167.704834 L 601.771851 1186.147705 L 565.530212 1200 L 535.328857 1177.046997 L 519.302124 1139.919556 L 535.328857 1066.550537 L 554.657776 970.792053 L 570.362488 894.68457 L 584.536926 800.134277 L 592.993347 768.724976 L 592.429626 766.630859 L 585.503479 767.516968 L 514.22821 865.369263 L 405.825531 1011.865906 L 320.053711 1103.677979 L 299.516815 1111.812256 L 263.919525 1093.369263 L 267.221497 1060.429688 L 287.114136 1031.114136 L 405.825531 880.107361 L 477.422913 786.52356 L 523.651062 732.483276 L 523.328918 724.671265 L 520.590698 724.671265 L 205.288605 929.395935 L 149.154434 936.644409 L 124.993355 914.01355 L 127.973183 876.885986 L 139.409409 864.80542 L 234.201385 799.570435 L 233.879227 799.8927 Z"/></svg> Claude';
  claudeBtn.onclick = async () => {
    popover.remove();
    const opts = await resolveDefaultSessionOptions(project);
    if (isRemoteProj) launchRemoteSession(rHost, { ...opts, remoteMode: 'claude', remoteDir: project.remotePath });
    else launchNewSession(project, opts);
  };

  const claudeOptsBtn = document.createElement('button');
  claudeOptsBtn.className = 'popover-option';
  claudeOptsBtn.innerHTML = '<svg class="popover-option-icon claude-icon" width="16" height="16" viewBox="0 0 1200 1200" fill="#d97757" stroke="none"><path d="M 233.959793 800.214905 L 468.644287 668.536987 L 472.590637 657.100647 L 468.644287 650.738403 L 457.208069 650.738403 L 417.986633 648.322144 L 283.892639 644.69812 L 167.597321 639.865845 L 54.926208 633.825623 L 26.577238 627.785339 L 3.3e-05 592.751709 L 2.73832 575.27533 L 26.577238 559.248352 L 60.724873 562.228149 L 136.187973 567.382629 L 249.422867 575.194763 L 331.570496 580.026978 L 453.261841 592.671082 L 472.590637 592.671082 L 475.328857 584.859009 L 468.724915 580.026978 L 463.570557 575.194763 L 346.389313 495.785217 L 219.543671 411.865906 L 153.100723 363.543762 L 117.181267 339.060425 L 99.060455 316.107361 L 91.248367 266.01355 L 123.865784 230.093994 L 167.677887 233.073853 L 178.872513 236.053772 L 223.248367 270.201477 L 318.040283 343.570496 L 441.825592 434.738342 L 459.946411 449.798706 L 467.194672 444.64447 L 468.080597 441.020203 L 459.946411 427.409485 L 392.617493 305.718323 L 320.778564 181.932983 L 288.80542 130.630859 L 280.348999 99.865845 C 277.369171 87.221436 275.194641 76.590698 275.194641 63.624268 L 312.322174 13.20813 L 332.8591 6.604126 L 382.389313 13.20813 L 403.248352 31.328979 L 434.013519 101.71814 L 483.865753 212.537048 L 561.181274 363.221497 L 583.812134 407.919434 L 595.892639 449.315491 L 600.40271 461.959839 L 608.214783 461.959839 L 608.214783 454.711609 L 614.577271 369.825623 L 626.335632 265.61084 L 637.771851 131.516846 L 641.718201 93.745117 L 660.402832 48.483276 L 697.530334 24.000122 L 726.52356 37.852417 L 750.362549 72 L 747.060486 94.067139 L 732.886047 186.201416 L 705.100708 330.52356 L 686.979919 427.167847 L 697.530334 427.167847 L 709.61084 415.087341 L 758.496704 350.174561 L 840.644348 247.490051 L 876.885925 206.738342 L 919.167847 161.71814 L 946.308838 140.29541 L 997.61084 140.29541 L 1035.38269 196.429626 L 1018.469849 254.416199 L 965.637634 321.422852 L 921.825562 378.201538 L 859.006714 462.765259 L 819.785278 530.41626 L 823.409424 535.812073 L 832.75177 534.92627 L 974.657776 504.724915 L 1051.328979 490.872559 L 1142.818848 475.167786 L 1184.214844 494.496582 L 1188.724854 514.147644 L 1172.456421 554.335693 L 1074.604126 578.496765 L 959.838989 601.449829 L 788.939636 641.879272 L 786.845764 643.409485 L 789.261841 646.389343 L 866.255127 653.637634 L 899.194702 655.409424 L 979.812134 655.409424 L 1129.932861 666.604187 L 1169.154419 692.537109 L 1192.671265 724.268677 L 1188.724854 748.429688 L 1128.322144 779.194641 L 1046.818848 759.865845 L 856.590759 714.604126 L 791.355774 698.335754 L 782.335693 698.335754 L 782.335693 703.731567 L 836.69812 756.885986 L 936.322205 846.845581 L 1061.073975 962.81897 L 1067.436279 991.490112 L 1051.409424 1014.120911 L 1034.496704 1011.704712 L 924.885986 929.234924 L 882.604126 892.107544 L 786.845764 811.48999 L 780.483276 811.48999 L 780.483276 819.946289 L 802.550415 852.241699 L 919.087341 1027.409424 L 925.127625 1081.127686 L 916.671204 1098.604126 L 886.469849 1109.154419 L 853.288696 1103.114136 L 785.073914 1007.355835 L 714.684631 899.516785 L 657.906067 802.872498 L 650.979858 806.81897 L 617.476624 1167.704834 L 601.771851 1186.147705 L 565.530212 1200 L 535.328857 1177.046997 L 519.302124 1139.919556 L 535.328857 1066.550537 L 554.657776 970.792053 L 570.362488 894.68457 L 584.536926 800.134277 L 592.993347 768.724976 L 592.429626 766.630859 L 585.503479 767.516968 L 514.22821 865.369263 L 405.825531 1011.865906 L 320.053711 1103.677979 L 299.516815 1111.812256 L 263.919525 1093.369263 L 267.221497 1060.429688 L 287.114136 1031.114136 L 405.825531 880.107361 L 477.422913 786.52356 L 523.651062 732.483276 L 523.328918 724.671265 L 520.590698 724.671265 L 205.288605 929.395935 L 149.154434 936.644409 L 124.993355 914.01355 L 127.973183 876.885986 L 139.409409 864.80542 L 234.201385 799.570435 L 233.879227 799.8927 Z"/></svg> Claude (Configure...)';
  claudeOptsBtn.onclick = () => { popover.remove(); showNewSessionDialog(project); };

  const termBtn = document.createElement('button');
  termBtn.className = 'popover-option popover-option-terminal';
  termBtn.innerHTML = '<svg class="popover-option-icon terminal-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"/></svg> Terminal';
  termBtn.onclick = () => {
    popover.remove();
    if (isRemoteProj) launchRemoteSession(rHost, { remoteMode: 'shell', remoteDir: project.remotePath });
    else launchTerminalSession(project);
  };

  popover.appendChild(claudeBtn);
  popover.appendChild(claudeOptsBtn);
  popover.appendChild(termBtn);

  positionAndBindPopover(popover, anchorEl);
}

// Position a popover under its anchor (flip up on overflow) and close on outside click.
function positionAndBindPopover(popover, anchorEl) {
  document.body.appendChild(popover);
  const rect = anchorEl.getBoundingClientRect();
  const popoverHeight = popover.offsetHeight;
  if (rect.bottom + 4 + popoverHeight > window.innerHeight) {
    popover.style.top = (rect.top - popoverHeight - 4) + 'px';
  } else {
    popover.style.top = (rect.bottom + 4) + 'px';
  }
  popover.style.left = rect.left + 'px';

  function onClickOutside(e) {
    if (!popover.contains(e.target) && e.target !== anchorEl) {
      popover.remove();
      document.removeEventListener('mousedown', onClickOutside);
    }
  }
  setTimeout(() => document.addEventListener('mousedown', onClickOutside), 0);
}

async function launchTerminalSession(project) {
  const sessionId = crypto.randomUUID();
  const projectPath = project.projectPath;
  const session = {
    sessionId,
    summary: 'Terminal',
    firstPrompt: '',
    projectPath,
    name: null,
    starred: 0,
    archived: 0,
    messageCount: 0,
    modified: new Date().toISOString(),
    created: new Date().toISOString(),
    type: 'terminal',
  };

  // Track as pending
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
  refreshSidebar();

  const entry = createTerminalEntry(session);

  const result = await window.api.openTerminal(sessionId, projectPath, true, { type: 'terminal' });
  if (!result.ok) {
    entry.terminal.write(`\r\nError: ${result.error}\r\n`);
    entry.closed = true;
    return;
  }

  showSession(sessionId);
  pollActiveSessions();
}

// Launch a session on a remote host over SSH. Modeled on launchTerminalSession:
// remote sessions are live "terminal" entries with a synthetic ssh:// project
// path so they group in the sidebar (no local .jsonl indexing in Phase 1).
async function launchRemoteSession(host, opts) {
  const options = opts || {};
  const remoteDir = options.remoteDir || '~';
  const mode = options.remoteMode === 'shell' ? 'shell' : 'claude';
  const sessionId = crypto.randomUUID();
  const projectPath = `ssh://${host.label}/${remoteDir}`;
  const summary = (mode === 'shell' ? 'Shell @ ' : 'Claude @ ') + host.label;
  const session = {
    sessionId,
    summary,
    firstPrompt: '',
    projectPath,
    name: null,
    starred: 0,
    archived: 0,
    messageCount: 0,
    modified: new Date().toISOString(),
    created: new Date().toISOString(),
    type: 'terminal',
    remote: true,
    remoteLabel: host.label,
    remoteMode: mode,
  };

  const folder = encodeProjectPath(projectPath);
  pendingSessions.set(sessionId, { session, projectPath, folder });

  sessionMap.set(sessionId, session);
  for (const projList of [cachedProjects, cachedAllProjects]) {
    let proj = projList.find(p => p.projectPath === projectPath);
    if (!proj) {
      proj = { folder, projectPath, sessions: [] };
      projList.unshift(proj);
    }
    proj.sessions.unshift(session);
  }
  refreshSidebar();

  const entry = createTerminalEntry(session);

  const result = await window.api.openTerminal(sessionId, projectPath, true, {
    type: 'terminal',
    remoteHostId: host.id,
    remoteMode: mode,
    remoteDir,
    forkFrom: options.forkFrom || null,
    dangerouslySkipPermissions: options.dangerouslySkipPermissions,
    permissionMode: options.permissionMode,
    addDirs: options.addDirs,
    preLaunchCmd: options.preLaunchCmd || null,
  });
  if (!result.ok) {
    entry.terminal.write(`\r\nError: ${result.error}\r\n`);
    entry.closed = true;
    return;
  }

  showSession(sessionId);
  pollActiveSessions();
}

async function showNewSessionDialog(project) {
  const effective = await window.api.getEffectiveSettings(project.projectPath);
  const isRemote = !!project.remote; // Model A: the project itself is local or remote

  const overlay = document.createElement('div');
  overlay.className = 'new-session-overlay';

  const dialog = document.createElement('div');
  dialog.className = 'new-session-dialog';

  let selectedMode = effective.permissionMode || null;
  let dangerousSkip = effective.dangerouslySkipPermissions || false;

  const modes = [
    { value: null, label: 'Default', desc: 'Prompt for all actions' },
    { value: 'acceptEdits', label: 'Accept Edits', desc: 'Auto-accept file edits, prompt for others' },
    { value: 'plan', label: 'Plan Mode', desc: 'Read-only exploration, no writes' },
    { value: 'dontAsk', label: "Don't Ask", desc: 'Auto-deny tools not explicitly allowed' },
    { value: 'bypassPermissions', label: 'Bypass', desc: 'Auto-accept all tool calls' },
  ];

  function renderModeGrid() {
    return modes.map(m => {
      const isSelected = !dangerousSkip && selectedMode === m.value;
      return `<button class="permission-option${isSelected ? ' selected' : ''}" data-mode="${m.value}"><span class="perm-name">${m.label}</span><span class="perm-desc">${m.desc}</span></button>`;
    }).join('') +
    `<button class="permission-option dangerous${dangerousSkip ? ' selected' : ''}" data-mode="dangerous-skip"><span class="perm-name">Dangerous Skip</span><span class="perm-desc">Skip all safety prompts (use with caution)</span></button>`;
  }

  const titleText = isRemote
    ? `New Remote Session — ${escapeHtml(project.hostLabel)} : ${escapeHtml(project.remotePath || '~')}`
    : `New Session — ${escapeHtml(project.projectPath.split('/').filter(Boolean).slice(-2).join('/'))}`;

  dialog.innerHTML = `
    <h3>${titleText}</h3>
    <div class="settings-field settings-field-wide" id="nsd-remote-dir-field" style="display:${isRemote ? '' : 'none'}">
      <div class="settings-field-info">
        <span class="settings-label">Remote Directory</span>
        <div class="settings-description">Working directory on the remote host</div>
      </div>
      <div class="settings-field-control folder-input-row">
        <input type="text" class="settings-input" id="nsd-remote-dir" placeholder="~/path/to/project" value="${escapeHtml(project.remotePath || '~')}">
        <button class="add-project-browse-btn" id="nsd-remote-browse" type="button">Browse</button>
      </div>
    </div>
    <div class="settings-field">
      <div class="settings-label">Permission Mode</div>
      <div class="permission-grid" id="nsd-mode-grid">${renderModeGrid()}</div>
    </div>
    <div id="nsd-local-only">
      <div class="settings-field">
        <div class="settings-field-info">
          <span class="settings-label">Worktree</span>
          <div class="settings-description">Run session in an isolated git worktree</div>
        </div>
        <div class="settings-field-control">
          <input type="text" class="settings-input" id="nsd-worktree-name" placeholder="name (optional)" value="${escapeHtml(effective.worktreeName || '')}" style="width:140px">
          <label class="settings-toggle"><input type="checkbox" id="nsd-worktree" ${effective.worktree ? 'checked' : ''}><span class="settings-toggle-slider"></span></label>
        </div>
      </div>
      <div class="settings-field">
        <div class="settings-field-info">
          <span class="settings-label">Chrome</span>
          <div class="settings-description">Enable Chrome browser automation</div>
        </div>
        <div class="settings-field-control">
          <label class="settings-toggle"><input type="checkbox" id="nsd-chrome" ${effective.chrome ? 'checked' : ''}><span class="settings-toggle-slider"></span></label>
        </div>
      </div>
    </div>
    <div class="settings-field settings-field-wide">
      <div class="settings-field-info">
        <span class="settings-label">Pre-launch Command</span>
        <div class="settings-description">Prepended to the claude command</div>
      </div>
      <div class="settings-field-control">
        <input type="text" class="settings-input" id="nsd-pre-launch" placeholder="e.g. aws-vault exec profile --" value="${escapeHtml(effective.preLaunchCmd || '')}">
      </div>
    </div>
    <div class="settings-field settings-field-wide">
      <div class="settings-field-info">
        <span class="settings-label">Additional Directories</span>
        <div class="settings-description">Extra directories to include (comma-separated)</div>
      </div>
      <div class="settings-field-control">
        <input type="text" class="settings-input" id="nsd-add-dirs" placeholder="/path/to/dir1, /path/to/dir2" value="${escapeHtml(effective.addDirs || '')}">
      </div>
    </div>
    <div class="new-session-actions">
      <button class="new-session-cancel-btn">Cancel</button>
      <button class="new-session-start-btn">Start</button>
    </div>
  `;

  overlay.appendChild(dialog);
  document.body.appendChild(overlay);

  // Bind mode grid clicks
  const modeGrid = dialog.querySelector('#nsd-mode-grid');
  modeGrid.addEventListener('click', (e) => {
    const btn = e.target.closest('.permission-option');
    if (!btn) return;
    const mode = btn.dataset.mode;
    if (mode === 'dangerous-skip') {
      dangerousSkip = !dangerousSkip;
      if (dangerousSkip) selectedMode = null;
    } else {
      dangerousSkip = false;
      selectedMode = mode === 'null' ? null : mode;
    }
    modeGrid.innerHTML = renderModeGrid();
  });

  function close() {
    overlay.remove();
  }

  // Model A: local vs remote is fixed by the project. The dialog is identical for
  // both except for justified differences: remote adds a Remote Directory picker,
  // and hides the local-only block (Worktree/Chrome are local-machine features).
  // The button row ("Cancel" / "Start") is the same — a remote shell is launched
  // from the popover's Terminal option, exactly like local.
  const localOnly = dialog.querySelector('#nsd-local-only');
  const startBtn = dialog.querySelector('.new-session-start-btn');
  if (localOnly) localOnly.style.display = isRemote ? 'none' : '';

  if (isRemote) {
    const rbBtn = dialog.querySelector('#nsd-remote-browse');
    if (rbBtn) rbBtn.onclick = async () => {
      const inp = dialog.querySelector('#nsd-remote-dir');
      const picked = await showRemoteDirBrowser({ id: project.hostId, label: project.hostLabel }, inp.value.trim() || '~');
      if (picked) inp.value = picked;
    };
  }

  function permissionOptions() {
    const options = {};
    if (dangerousSkip) options.dangerouslySkipPermissions = true;
    else if (selectedMode) options.permissionMode = selectedMode;
    options.addDirs = dialog.querySelector('#nsd-add-dirs').value.trim();
    return options;
  }

  function remoteDirValue() {
    return dialog.querySelector('#nsd-remote-dir').value.trim() || project.remotePath || '~';
  }

  function start() {
    if (isRemote) {
      const options = { ...permissionOptions(), remoteMode: 'claude', remoteDir: remoteDirValue() };
      const preLaunch = dialog.querySelector('#nsd-pre-launch').value.trim();
      if (preLaunch) options.preLaunchCmd = preLaunch;
      close();
      launchRemoteSession({ id: project.hostId, label: project.hostLabel }, options);
      return;
    }
    const options = permissionOptions();
    if (dialog.querySelector('#nsd-worktree').checked) {
      options.worktree = true;
      options.worktreeName = dialog.querySelector('#nsd-worktree-name').value.trim();
    }
    if (dialog.querySelector('#nsd-chrome').checked) {
      options.chrome = true;
    }
    const preLaunch = dialog.querySelector('#nsd-pre-launch').value.trim();
    if (preLaunch) options.preLaunchCmd = preLaunch;
    if (effective.mcpEmulation === false) options.mcpEmulation = false;
    close();
    launchNewSession(project, options);
  }

  dialog.querySelector('.new-session-cancel-btn').onclick = close;
  startBtn.onclick = start;
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

  // Keyboard support
  function onKey(e) {
    if (e.key === 'Escape') { close(); document.removeEventListener('keydown', onKey); }
    if (e.key === 'Enter' && !e.target.matches('input')) { start(); document.removeEventListener('keydown', onKey); }
  }
  document.addEventListener('keydown', onKey);
}

async function showResumeSessionDialog(session) {
  const effective = await window.api.getEffectiveSettings(session.projectPath);

  const overlay = document.createElement('div');
  overlay.className = 'new-session-overlay';

  const dialog = document.createElement('div');
  dialog.className = 'new-session-dialog';

  let selectedMode = effective.permissionMode || null;
  let dangerousSkip = effective.dangerouslySkipPermissions || false;

  const modes = [
    { value: null, label: 'Default', desc: 'Prompt for all actions' },
    { value: 'acceptEdits', label: 'Accept Edits', desc: 'Auto-accept file edits, prompt for others' },
    { value: 'plan', label: 'Plan Mode', desc: 'Read-only exploration, no writes' },
    { value: 'dontAsk', label: "Don't Ask", desc: 'Auto-deny tools not explicitly allowed' },
    { value: 'bypassPermissions', label: 'Bypass', desc: 'Auto-accept all tool calls' },
  ];

  function renderModeGrid() {
    return modes.map(m => {
      const isSelected = !dangerousSkip && selectedMode === m.value;
      return `<button class="permission-option${isSelected ? ' selected' : ''}" data-mode="${m.value}"><span class="perm-name">${m.label}</span><span class="perm-desc">${m.desc}</span></button>`;
    }).join('') +
    `<button class="permission-option dangerous${dangerousSkip ? ' selected' : ''}" data-mode="dangerous-skip"><span class="perm-name">Dangerous Skip</span><span class="perm-desc">Skip all safety prompts (use with caution)</span></button>`;
  }

  const sessionName = session.name || session.aiTitle || session.summary || session.sessionId.slice(0, 8);

  dialog.innerHTML = `
    <h3>Resume Session — ${escapeHtml(sessionName)}</h3>
    <div class="settings-field">
      <div class="settings-label">Permission Mode</div>
      <div class="permission-grid" id="rsd-mode-grid">${renderModeGrid()}</div>
    </div>
    <div class="settings-field">
      <div class="settings-field-info">
        <span class="settings-label">Chrome</span>
        <div class="settings-description">Enable Chrome browser automation</div>
      </div>
      <div class="settings-field-control">
        <label class="settings-toggle"><input type="checkbox" id="rsd-chrome" ${effective.chrome ? 'checked' : ''}><span class="settings-toggle-slider"></span></label>
      </div>
    </div>
    <div class="settings-field settings-field-wide">
      <div class="settings-field-info">
        <span class="settings-label">Pre-launch Command</span>
        <div class="settings-description">Prepended to the claude command</div>
      </div>
      <div class="settings-field-control">
        <input type="text" class="settings-input" id="rsd-pre-launch" placeholder="e.g. aws-vault exec profile --" value="${escapeHtml(effective.preLaunchCmd || '')}">
      </div>
    </div>
    <div class="settings-field settings-field-wide">
      <div class="settings-field-info">
        <span class="settings-label">Additional Directories</span>
        <div class="settings-description">Extra directories to include (comma-separated)</div>
      </div>
      <div class="settings-field-control">
        <input type="text" class="settings-input" id="rsd-add-dirs" placeholder="/path/to/dir1, /path/to/dir2" value="${escapeHtml(effective.addDirs || '')}">
      </div>
    </div>
    <div class="new-session-actions">
      <button class="new-session-cancel-btn">Cancel</button>
      <button class="new-session-start-btn">Resume</button>
    </div>
  `;

  overlay.appendChild(dialog);
  document.body.appendChild(overlay);

  // Bind mode grid clicks
  const modeGrid = dialog.querySelector('#rsd-mode-grid');
  modeGrid.addEventListener('click', (e) => {
    const btn = e.target.closest('.permission-option');
    if (!btn) return;
    const mode = btn.dataset.mode;
    if (mode === 'dangerous-skip') {
      dangerousSkip = !dangerousSkip;
      if (dangerousSkip) selectedMode = null;
    } else {
      dangerousSkip = false;
      selectedMode = mode === 'null' ? null : mode;
    }
    modeGrid.innerHTML = renderModeGrid();
  });

  function close() {
    overlay.remove();
  }

  function resume() {
    const options = {};
    if (dangerousSkip) {
      options.dangerouslySkipPermissions = true;
    } else if (selectedMode) {
      options.permissionMode = selectedMode;
    }
    if (dialog.querySelector('#rsd-chrome').checked) {
      options.chrome = true;
    }
    const preLaunch = dialog.querySelector('#rsd-pre-launch').value.trim();
    if (preLaunch) options.preLaunchCmd = preLaunch;
    options.addDirs = dialog.querySelector('#rsd-add-dirs').value.trim();
    if (effective.mcpEmulation === false) options.mcpEmulation = false;
    close();
    openSession(session, options);
  }

  dialog.querySelector('.new-session-cancel-btn').onclick = close;
  dialog.querySelector('.new-session-start-btn').onclick = resume;
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

  function onKey(e) {
    if (e.key === 'Escape') { close(); document.removeEventListener('keydown', onKey); }
    if (e.key === 'Enter' && !e.target.matches('input')) { resume(); document.removeEventListener('keydown', onKey); }
  }
  document.addEventListener('keydown', onKey);
}

// Settings viewer is in settings-panel.js (openSettingsViewer / closeSettingsViewer)
// Global settings button & add project button bindings are in app.js (need DOM refs)

// Dedicated interactive-connect channel. One connect runs at a time; the module
// listeners route events to the active handler set by connectRemoteHost().
let _rcData = null, _rcExit = null;
if (window.api && window.api.onRemoteConnectData) window.api.onRemoteConnectData((id, data) => { if (_rcData) _rcData(id, data); });
if (window.api && window.api.onRemoteConnectExit) window.api.onRemoteConnectExit((id, code) => { if (_rcExit) _rcExit(id, code); });

// Structured auth prompt. Presents the right UI for what ssh is asking:
//  - hostkey  → fingerprint text + Yes/No
//  - password/passphrase → masked input field
//  - otp/generic → text field
// Resolves to the string to send (for hostkey: 'yes'), or null if cancelled.
function showAuthPrompt(host, p) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'new-session-overlay remote-browser-overlay';
    const d = document.createElement('div');
    d.className = 'new-session-dialog';
    const titles = { password: 'Password', passphrase: 'Key passphrase', otp: 'Verification code', hostkey: 'Verify host key', generic: 'Input required' };
    const title = titles[p.kind] || 'Input required';
    const done = (v) => { overlay.remove(); document.removeEventListener('keydown', onKey); resolve(v); };
    function onKey(e) { if (e.key === 'Escape') done(null); }

    if (p.kind === 'hostkey') {
      d.innerHTML = `
        <h3>${title} — ${escapeHtml(host.label || host.id)}</h3>
        <div class="remote-connect-hint">First time connecting to this host. Confirm the fingerprint to continue.</div>
        <pre class="auth-fingerprint">${escapeHtml(p.text || '')}</pre>
        <div class="new-session-actions">
          <button class="new-session-cancel-btn" id="ap-no">No</button>
          <button class="new-session-start-btn" id="ap-yes">Yes, connect</button>
        </div>`;
      overlay.appendChild(d); document.body.appendChild(overlay);
      document.addEventListener('keydown', onKey);
      overlay.addEventListener('click', (e) => { if (e.target === overlay) done(null); });
      d.querySelector('#ap-yes').onclick = () => done('yes');
      d.querySelector('#ap-no').onclick = () => done(null);
      return;
    }

    const masked = (p.kind === 'password' || p.kind === 'passphrase');
    d.innerHTML = `
      <h3>${title} — ${escapeHtml(host.label || host.id)}</h3>
      <div class="remote-connect-hint">${escapeHtml(p.text || (title + ':'))}</div>
      <div class="settings-field"><div class="settings-field-control">
        <input class="settings-input" id="ap-input" type="${masked ? 'password' : 'text'}" autocomplete="off" spellcheck="false" style="width:100%">
      </div></div>
      <div class="new-session-actions">
        <button class="new-session-cancel-btn" id="ap-cancel">Cancel</button>
        <button class="new-session-start-btn" id="ap-ok">OK</button>
      </div>`;
    overlay.appendChild(d); document.body.appendChild(overlay);
    const inp = d.querySelector('#ap-input');
    inp.focus();
    // Submit sends the value to ssh, then clears it from the field immediately.
    const submit = () => { const v = inp.value; inp.value = ''; done(v); };
    document.addEventListener('keydown', onKey);
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } });
    overlay.addEventListener('click', (e) => { if (e.target === overlay) done(null); });
    d.querySelector('#ap-ok').onclick = submit;
    d.querySelector('#ap-cancel').onclick = () => done(null);
  });
}

// Verify/authenticate a host inline (no sidebar session). Resolves true once the
// connection is established (and warmed via ControlMaster). ssh's prompts are
// surfaced as structured popups (password field / Yes-No fingerprint) — never a
// raw terminal. Key/agent hosts connect silently with no popup.
function connectRemoteHost(host) {
  return new Promise((resolve) => {
    let connectId = null, buffer = '', settled = false, promptOpen = false, errModal = null;

    function finish(val) {
      if (settled) return;
      settled = true; _rcData = null; _rcExit = null;
      if (errModal) { errModal.remove(); errModal = null; }
      resolve(val);
    }

    // Detect what ssh is waiting for. Only when the buffer ends WITHOUT a newline
    // (cursor parked at a prompt), which avoids matching normal banner lines.
    function detectPrompt(buf) {
      const tail = buf.slice(-1000);
      if (/\n[ \t]*$/.test(tail)) return null; // ends with newline → not a waiting prompt
      if (/(authenticity of host|continue connecting \(yes\/no)/i.test(tail) && /\?[ \t]*$/.test(tail)) {
        const m = tail.match(/The authenticity of host[\s\S]*\?[ \t]*$/i);
        return { kind: 'hostkey', text: (m ? m[0] : tail).trim() };
      }
      if (/enter passphrase for key[^\n]*:[ \t]*$/i.test(tail)) return { kind: 'passphrase', text: tail.split('\n').pop().trim() };
      if (/password:[ \t]*$/i.test(tail)) return { kind: 'password', text: tail.split('\n').pop().trim() };
      if (/(verification code|one-time|two-factor|token|otp)[^\n]*:[ \t]*$/i.test(tail)) return { kind: 'otp', text: tail.split('\n').pop().trim() };
      if (/[:?][ \t]*$/.test(tail)) {
        const line = tail.split('\n').pop().trim();
        if (line.length > 1 && line.length < 200) return { kind: 'generic', text: line };
      }
      return null;
    }

    async function handlePrompt(p) {
      promptOpen = true;
      const ans = await showAuthPrompt(host, p);
      promptOpen = false;
      if (ans === null) { if (connectId != null) window.api.remoteConnectCancel(connectId); finish(false); return; }
      buffer = '';
      if (connectId != null) window.api.remoteConnectInput(connectId, ans + '\n');
    }

    function showError(msg) {
      if (settled) return;
      if (errModal) errModal.remove();
      errModal = document.createElement('div');
      errModal.className = 'new-session-overlay remote-browser-overlay';
      const d = document.createElement('div');
      d.className = 'new-session-dialog';
      d.innerHTML = `
        <h3>Connect — ${escapeHtml(host.label || host.id)}</h3>
        <div class="remote-connect-msg err" style="margin-bottom:12px">${escapeHtml(msg)}</div>
        <div class="new-session-actions">
          <button class="new-session-cancel-btn" id="ce-cancel">Cancel</button>
          <button class="new-session-start-btn" id="ce-retry">Retry</button>
        </div>`;
      errModal.appendChild(d); document.body.appendChild(errModal);
      d.querySelector('#ce-cancel').onclick = () => finish(false);
      d.querySelector('#ce-retry').onclick = () => { errModal.remove(); errModal = null; start(); };
    }

    async function start() {
      buffer = '';
      const res = await window.api.remoteConnectStart(host.id);
      if (!res || res.error) { showError((res && res.error) || 'Could not start ssh.'); return; }
      connectId = res.connectId;
      _rcData = (id, data) => {
        if (id !== connectId) return;
        buffer += data; if (buffer.length > 8000) buffer = buffer.slice(-8000);
        if (promptOpen) return;
        const p = detectPrompt(buffer);
        if (p) handlePrompt(p);
      };
      _rcExit = (id, code) => {
        if (id !== connectId) return;
        _rcData = null; _rcExit = null;
        if (code === 0) {
          // Master is now live — index this host's past remote sessions (Phase 2).
          if (window.api.syncRemoteHost) window.api.syncRemoteHost(host.id).catch(() => {});
          finish(true);
        } else {
          const lastLine = buffer.split('\n').map(s => s.trim()).filter(Boolean).slice(-1)[0] || '';
          showError('Connection failed' + (lastLine ? ': ' + lastLine : ' (exit ' + code + ').'));
        }
      };
    }

    start();
  });
}

// Remote directory browser: navigate the remote filesystem over SSH and pick a
// directory (like the local folder Browse). Resolves to the chosen path or null.
function showRemoteDirBrowser(host, startPath) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'new-session-overlay remote-browser-overlay';
    const dialog = document.createElement('div');
    dialog.className = 'new-session-dialog remote-browser-dialog';
    dialog.innerHTML = `
      <h3>Browse — ${escapeHtml(host.label || host.id)}</h3>
      <div class="folder-input-row">
        <input type="text" class="settings-input" id="rb-path" value="${escapeHtml(startPath || '~')}" autocomplete="off" spellcheck="false">
        <button class="add-project-browse-btn" id="rb-go">Go</button>
      </div>
      <div class="remote-browser-list" id="rb-list"></div>
      <div class="remote-browser-msg" id="rb-msg"></div>
      <div class="new-session-actions">
        <button class="new-session-cancel-btn" id="rb-cancel">Cancel</button>
        <button class="new-session-start-btn" id="rb-select">Select this directory</button>
      </div>`;
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);

    const pathInput = dialog.querySelector('#rb-path');
    const listEl = dialog.querySelector('#rb-list');
    const msgEl = dialog.querySelector('#rb-msg');
    let current = startPath || '~';

    function close(val) { overlay.remove(); document.removeEventListener('keydown', onKey); resolve(val); }
    function onKey(e) { if (e.key === 'Escape') close(null); }
    document.addEventListener('keydown', onKey);

    function joinPath(base, name) { return base === '~' ? '~/' + name : base.replace(/\/+$/, '') + '/' + name; }
    function parentPath(p) {
      if (p === '~' || p === '/') return p;
      const t = p.replace(/\/+$/, '');
      const i = t.lastIndexOf('/');
      if (i <= 0) return p.startsWith('/') ? '/' : '~';
      const par = t.slice(0, i);
      return par === '~' ? '~' : (par || '/');
    }

    async function load(path) {
      current = path;
      pathInput.value = path;
      msgEl.textContent = '';
      listEl.innerHTML = '<div class="remote-browser-status">Loading…</div>';
      let res;
      try { res = await window.api.remoteBrowse({ hostId: host.id, path }); }
      catch (e) { listEl.innerHTML = ''; msgEl.textContent = 'Error: ' + e.message; return; }
      listEl.innerHTML = '';
      if (!res.ok) {
        if (res.needsAuth) {
          msgEl.textContent = 'This host needs interactive login. Open a session to it once to authenticate, then try Browse again — or just type the path.';
        } else {
          msgEl.textContent = res.message || res.error || 'Could not list this directory.';
        }
        return;
      }
      const up = document.createElement('div');
      up.className = 'remote-browser-item remote-browser-up';
      up.textContent = '📂 ..';
      up.onclick = () => load(parentPath(current));
      listEl.appendChild(up);
      for (const d of res.dirs) {
        const it = document.createElement('div');
        it.className = 'remote-browser-item';
        it.textContent = '📁 ' + d;
        it.onclick = () => load(joinPath(current, d));
        listEl.appendChild(it);
      }
      if (!res.dirs.length) {
        const e = document.createElement('div');
        e.className = 'remote-browser-status';
        e.textContent = '(no subdirectories)';
        listEl.appendChild(e);
      }
    }

    dialog.querySelector('#rb-go').onclick = () => load(pathInput.value.trim() || '~');
    pathInput.addEventListener('keydown', e => { if (e.key === 'Enter') { e.stopPropagation(); load(pathInput.value.trim() || '~'); } });
    dialog.querySelector('#rb-cancel').onclick = () => close(null);
    dialog.querySelector('#rb-select').onclick = () => close(pathInput.value.trim() || current);
    overlay.addEventListener('click', e => { if (e.target === overlay) close(null); });

    load(current);
  });
}

// Inline "add SSH host" form. Persists the new host into settings (merged with
// existing manual hosts) and resolves to the saved host ({id,label,…}) or null.
function showAddHostDialog() {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'new-session-overlay remote-browser-overlay';
    const d = document.createElement('div');
    d.className = 'new-session-dialog';
    d.innerHTML = `
      <h3>Add SSH Host</h3>
      <div class="settings-field"><div class="settings-field-info"><span class="settings-label">Label</span></div><div class="settings-field-control"><input class="settings-input" id="ah-label" placeholder="my-server (optional)"></div></div>
      <div class="settings-field"><div class="settings-field-info"><span class="settings-label">User</span></div><div class="settings-field-control"><input class="settings-input" id="ah-user" placeholder="user (optional)"></div></div>
      <div class="settings-field"><div class="settings-field-info"><span class="settings-label">Host</span></div><div class="settings-field-control"><input class="settings-input" id="ah-host" placeholder="hostname or IP"></div></div>
      <div class="settings-field"><div class="settings-field-info"><span class="settings-label">Port</span></div><div class="settings-field-control"><input class="settings-input" id="ah-port" placeholder="22"></div></div>
      <div class="settings-field"><div class="settings-field-info"><span class="settings-label">Identity file</span></div><div class="settings-field-control"><input class="settings-input" id="ah-identity" placeholder="~/.ssh/id_ed25519 (optional)"></div></div>
      <div class="settings-field">
        <div class="settings-field-info">
          <span class="settings-label">Extra options</span>
          <div class="settings-description">Extra <code>ssh -o</code> options for legacy/special hosts — leave blank for most. Click to add:</div>
          <div class="ah-opt-chips">
            <button type="button" class="ah-chip" data-opt="HostKeyAlgorithms=+ssh-rsa">HostKeyAlgorithms=+ssh-rsa</button>
            <button type="button" class="ah-chip" data-opt="PubkeyAcceptedKeyTypes=+ssh-rsa">PubkeyAcceptedKeyTypes=+ssh-rsa</button>
            <button type="button" class="ah-chip" data-opt="PreferredAuthentications=password">PreferredAuthentications=password</button>
            <button type="button" class="ah-chip" data-opt="ProxyJump=bastion">ProxyJump=bastion</button>
            <button type="button" class="ah-chip" data-opt="ServerAliveInterval=30">ServerAliveInterval=30</button>
          </div>
        </div>
        <div class="settings-field-control"><input class="settings-input" id="ah-options" placeholder="comma-separated Key=Value (optional)"></div>
      </div>
      <div class="remote-connect-msg" id="ah-err"></div>
      <div class="new-session-actions">
        <button class="new-session-cancel-btn" id="ah-cancel">Cancel</button>
        <button class="new-session-start-btn" id="ah-save">Save host</button>
      </div>`;
    overlay.appendChild(d);
    document.body.appendChild(overlay);
    d.querySelector('#ah-host').focus();

    function close(v) { overlay.remove(); document.removeEventListener('keydown', onKey); resolve(v); }
    function onKey(e) { if (e.key === 'Escape') close(null); }
    document.addEventListener('keydown', onKey);
    const setErr = (m) => { const e = d.querySelector('#ah-err'); e.textContent = m; e.className = 'remote-connect-msg err'; };

    d.querySelector('#ah-cancel').onclick = () => close(null);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(null); });
    // Example-option chips: click to append (deduped) into the options field.
    d.querySelectorAll('.ah-chip').forEach(chip => {
      chip.onclick = () => {
        const inp = d.querySelector('#ah-options');
        const parts = inp.value.split(',').map(s => s.trim()).filter(Boolean);
        if (!parts.includes(chip.dataset.opt)) parts.push(chip.dataset.opt);
        inp.value = parts.join(', ');
      };
    });
    d.querySelector('#ah-save').onclick = async () => {
      const host = d.querySelector('#ah-host').value.trim();
      if (!host) { setErr('Host is required.'); return; }
      const newHost = {
        label: d.querySelector('#ah-label').value.trim(),
        user: d.querySelector('#ah-user').value.trim(),
        host,
        port: d.querySelector('#ah-port').value.trim(),
        identityFile: d.querySelector('#ah-identity').value.trim(),
        options: d.querySelector('#ah-options').value.trim(),
      };
      let existing = [];
      try { existing = (await window.api.getRemoteTargets()).filter(h => h.source === 'manual'); } catch {}
      const res = await window.api.saveRemoteHosts([...existing, newHost]);
      if (!res || !res.ok) { setErr('Failed to save host.'); return; }
      const saved = (res.hosts || []).find(h => h.source === 'manual' && h.host === host && (h.user || '') === (newHost.user || '')) || null;
      close(saved);
    };
  });
}

async function showAddProjectDialog() {
  const overlay = document.createElement('div');
  overlay.className = 'add-project-overlay';

  const dialog = document.createElement('div');
  dialog.className = 'add-project-dialog';

  // Load remote SSH targets for the Remote tab.
  let remoteTargets = [];
  try { remoteTargets = await window.api.getRemoteTargets(); } catch {}
  const buildHostOptions = (targets) =>
    (targets.length ? '' : '<option value="" disabled selected>(no hosts yet)</option>') +
    targets.map(h => `<option value="${escapeHtml(h.id)}">${escapeHtml(h.label)}${h.source === 'config' ? ' (ssh config)' : ''}</option>`).join('') +
    '<option value="__add__">+ Add new host…</option>';
  const hostOptions = buildHostOptions(remoteTargets);

  dialog.innerHTML = `
    <h3>Add Project</h3>
    <div class="add-project-tabs">
      <button class="add-project-tab selected" data-tab="local">Local folder</button>
      <button class="add-project-tab" data-tab="remote">Remote (SSH)</button>
    </div>
    <div id="add-project-local">
      <div class="add-project-hint">Select a folder to create a new project. To start a session in an existing project, use the + on its project header.</div>
      <div class="folder-input-row">
        <input type="text" id="add-project-path" placeholder="/path/to/project" autocomplete="off" spellcheck="false">
        <button class="add-project-browse-btn">Browse</button>
      </div>
    </div>
    <div id="add-project-remote" style="display:none">
      <div class="add-project-hint">Choose an SSH host and a remote directory — or pick <strong>+ Add new host…</strong> to define one here. If the host needs a password, click <strong>Connect</strong> to log in once, then Browse.</div>
      <div class="settings-field">
        <div class="settings-field-info"><span class="settings-label">Host</span></div>
        <div class="settings-field-control folder-input-row">
          <select class="settings-select" id="add-remote-host">${hostOptions}</select>
          <button class="add-project-browse-btn" id="add-remote-connect" type="button" title="Log in / verify the connection">Connect</button>
        </div>
      </div>
      <div class="settings-field">
        <div class="settings-field-info"><span class="settings-label">Remote directory</span></div>
        <div class="settings-field-control folder-input-row">
          <input type="text" class="settings-input" id="add-remote-path" placeholder="~/path/to/project" value="~">
          <button class="add-project-browse-btn" id="add-remote-browse" type="button">Browse</button>
        </div>
      </div>
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
  const localPane = dialog.querySelector('#add-project-local');
  const remotePane = dialog.querySelector('#add-project-remote');
  let tab = 'local';
  pathInput.focus();

  dialog.querySelectorAll('.add-project-tab').forEach(btn => {
    btn.onclick = () => {
      tab = btn.dataset.tab;
      dialog.querySelectorAll('.add-project-tab').forEach(b => b.classList.toggle('selected', b === btn));
      localPane.style.display = tab === 'local' ? '' : 'none';
      remotePane.style.display = tab === 'remote' ? '' : 'none';
      errorEl.style.display = 'none';
    };
  });

  function close() {
    overlay.remove();
    document.removeEventListener('keydown', onKey);
  }

  function showError(msg) { errorEl.textContent = msg; errorEl.style.display = 'block'; }

  async function addProject() {
    errorEl.style.display = 'none';
    if (tab === 'remote') {
      const hostSel = dialog.querySelector('#add-remote-host');
      if (!hostSel) { showError('No SSH hosts configured. Add them in Settings → Remote Hosts.'); return; }
      const hostId = hostSel.value;
      if (!hostId || hostId === '__add__') { showError('Select or add a host.'); return; }
      const remotePath = dialog.querySelector('#add-remote-path').value.trim() || '~';
      const result = await window.api.addRemoteProject({ hostId, remotePath });
      if (result.error) { showError(result.error); return; }
      close();
      await loadProjects();
      // Index this project's past sessions now (connect happened before it was
      // registered, so the connect-time sync saw no projects for this host).
      if (window.api.syncRemoteHost) window.api.syncRemoteHost(hostId).catch(() => {});
      return;
    }
    const projectPath = pathInput.value.trim();
    if (!projectPath) { showError('Please enter a folder path.'); return; }
    const result = await window.api.addProject(projectPath);
    if (result.error) { showError(result.error); return; }
    close();
    await loadProjects();
  }

  dialog.querySelector('.add-project-browse-btn').onclick = async () => {
    const folder = await window.api.browseFolder();
    if (folder) pathInput.value = folder;
  };

  // "+ Add new host…" in the host dropdown opens an inline add-host form.
  const hostSelEl = dialog.querySelector('#add-remote-host');
  if (hostSelEl) {
    let prevValue = hostSelEl.value;
    hostSelEl.addEventListener('change', async () => {
      if (hostSelEl.value !== '__add__') { prevValue = hostSelEl.value; return; }
      const saved = await showAddHostDialog();
      if (saved) {
        try { remoteTargets = await window.api.getRemoteTargets(); } catch {}
        hostSelEl.innerHTML = buildHostOptions(remoteTargets);
        hostSelEl.value = saved.id;
        prevValue = hostSelEl.value;
      } else {
        hostSelEl.value = prevValue;
      }
    });
  }

  const isRealHost = () => { const v = hostSelEl && hostSelEl.value; return v && v !== '__add__'; };

  // Remote directory Browse
  const remoteBrowseBtn = dialog.querySelector('#add-remote-browse');
  if (remoteBrowseBtn) {
    remoteBrowseBtn.onclick = async () => {
      if (!isRealHost()) { showError('Select or add a host first.'); return; }
      const hostSel = dialog.querySelector('#add-remote-host');
      const remotePathInput = dialog.querySelector('#add-remote-path');
      const t = remoteTargets.find(h => h.id === hostSel.value);
      const host = { id: hostSel.value, label: (t && t.label) || hostSel.value };
      const picked = await showRemoteDirBrowser(host, remotePathInput.value.trim() || '~');
      if (picked) remotePathInput.value = picked;
    };
  }

  // Interactive Connect: open a real shell to the selected host to authenticate
  // (password/pubkey/legacy). Closes this dialog and warms the connection so a
  // subsequent Add → Browse works. The host label carries the ssh-config suffix,
  // so strip it back to the pickable label for the session.
  const remoteConnectBtn = dialog.querySelector('#add-remote-connect');
  if (remoteConnectBtn) {
    remoteConnectBtn.onclick = async () => {
      if (!isRealHost()) { showError('Select or add a host first.'); return; }
      const hostSel = dialog.querySelector('#add-remote-host');
      const t = remoteTargets.find(h => h.id === hostSel.value);
      const host = { id: hostSel.value, label: (t && t.label) || hostSel.value };
      const orig = remoteConnectBtn.textContent;
      remoteConnectBtn.disabled = true;
      remoteConnectBtn.textContent = 'Connecting…';
      remoteConnectBtn.classList.remove('connected');
      const ok = await connectRemoteHost(host);
      remoteConnectBtn.disabled = false;
      if (ok) { remoteConnectBtn.textContent = '✓ Connected'; remoteConnectBtn.classList.add('connected'); }
      else { remoteConnectBtn.textContent = orig; }
    };
  }

  dialog.querySelector('.add-project-cancel-btn').onclick = close;
  dialog.querySelector('.add-project-add-btn').onclick = addProject;
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

  function onKey(e) {
    if (e.key === 'Escape') close();
    if (e.key === 'Enter') addProject();
  }
  document.addEventListener('keydown', onKey);
}
