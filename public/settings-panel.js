// Settings panel component
// Manages the global and project settings viewer UI.

(function () {
  const settingsViewer = document.getElementById('settings-viewer');
  const settingsViewerTitle = document.getElementById('settings-viewer-title');
  const settingsViewerBody = document.getElementById('settings-viewer-body');

  function closeSettingsViewer() {
    settingsViewer.style.display = 'none';
    const terminalArea = document.getElementById('terminal-area');
    const terminalHeader = document.getElementById('terminal-header');
    const placeholder = document.getElementById('placeholder');
    const gridViewActive = localStorage.getItem('gridViewActive') === '1';
    const activeSessionId = sessionStorage.getItem('activeSessionId') || null;
    // Check if there's an active session with an open terminal
    if (activeSessionId && window._openSessions && window._openSessions.has(activeSessionId)) {
      terminalArea.style.display = '';
      terminalHeader.style.display = '';
    } else if (gridViewActive) {
      terminalArea.style.display = '';
    } else {
      placeholder.style.display = '';
    }
  }

  async function openSettingsViewer(scope, projectPath) {
    const isProject = scope === 'project';
    const settingsKey = isProject ? 'project:' + projectPath : 'global';
    const current = (await window.api.getSetting(settingsKey)) || {};
    const globalSettings = isProject ? ((await window.api.getSetting('global')) || {}) : {};

    const shortName = isProject
      ? projectPath.split('/').filter(Boolean).slice(-2).join('/')
      : 'Global';

    settingsViewerTitle.textContent = (isProject ? 'Project Settings — ' : 'Global Settings — ') + shortName;

    // Show settings viewer, hide others
    document.getElementById('placeholder').style.display = 'none';
    document.getElementById('terminal-area').style.display = 'none';
    document.getElementById('plan-viewer').style.display = 'none';
    document.getElementById('stats-viewer').style.display = 'none';
    document.getElementById('memory-viewer').style.display = 'none';
    document.getElementById('jsonl-viewer').style.display = 'none';
    settingsViewer.style.display = 'flex';

    function useGlobalCheckbox(fieldName) {
      if (!isProject) return '';
      const useGlobal = current[fieldName] === undefined || current[fieldName] === null;
      return `<label class="settings-use-global"><input type="checkbox" data-field="${fieldName}" class="use-global-cb" ${useGlobal ? 'checked' : ''}> Use global default</label>`;
    }

    function fieldValue(fieldName, fallback) {
      if (isProject && (current[fieldName] === undefined || current[fieldName] === null)) {
        return globalSettings[fieldName] !== undefined ? globalSettings[fieldName] : fallback;
      }
      return current[fieldName] !== undefined ? current[fieldName] : fallback;
    }

    function fieldDisabled(fieldName) {
      if (!isProject) return '';
      return (current[fieldName] === undefined || current[fieldName] === null) ? 'disabled' : '';
    }

    const permModeValue = fieldValue('permissionMode', '');
    const worktreeValue = fieldValue('worktree', false);
    const worktreeNameValue = fieldValue('worktreeName', '');
    const chromeValue = fieldValue('chrome', false);
    const preLaunchValue = fieldValue('preLaunchCmd', '');
    const addDirsValue = fieldValue('addDirs', '');
    const visCountValue = fieldValue('visibleSessionCount', 10);
    const maxAgeValue = fieldValue('sessionMaxAgeDays', 3);
    const themeValue = fieldValue('terminalTheme', 'switchboard');
    const mcpEmulationValue = fieldValue('mcpEmulation', true);
    const remoteIdeValue = fieldValue('remoteIde', false);
    const shellProfileValue = fieldValue('shellProfile', 'auto');

    // Discover available shell profiles
    let shellProfiles = [];
    try { shellProfiles = await window.api.getShellProfiles(); } catch {};

    // Discover remote SSH targets (global settings only)
    let remoteTargets = [];
    if (!isProject) {
      try { remoteTargets = await window.api.getRemoteTargets(); } catch {}
    }

    settingsViewerBody.innerHTML = `
    <div class="settings-form">
      <div class="settings-section">
        <div class="settings-section-title">Claude CLI Options</div>

        <div class="settings-field">
          <div class="settings-field-info">
            <div class="settings-field-header">
              <span class="settings-label">Permission Mode</span>
              ${useGlobalCheckbox('permissionMode')}
            </div>
            <div class="settings-description">Permission mode passed to the <code>claude</code> command</div>
          </div>
          <div class="settings-field-control">
            <select class="settings-select" id="sv-perm-mode" ${fieldDisabled('permissionMode')}>
              <option value="">Default (none)</option>
              <option value="acceptEdits" ${permModeValue === 'acceptEdits' ? 'selected' : ''}>Accept Edits</option>
              <option value="plan" ${permModeValue === 'plan' ? 'selected' : ''}>Plan Mode</option>
              <option value="dontAsk" ${permModeValue === 'dontAsk' ? 'selected' : ''}>Don't Ask</option>
              <option value="bypassPermissions" ${permModeValue === 'bypassPermissions' ? 'selected' : ''}>Bypass</option>
            </select>
          </div>
        </div>

        <div class="settings-field">
          <div class="settings-field-info">
            <div class="settings-field-header">
              <span class="settings-label">Worktree</span>
              ${useGlobalCheckbox('worktree')}
            </div>
            <div class="settings-description">Enable worktree for new sessions</div>
          </div>
          <div class="settings-field-control">
            <label class="settings-toggle"><input type="checkbox" id="sv-worktree" ${worktreeValue ? 'checked' : ''} ${fieldDisabled('worktree')}><span class="settings-toggle-slider"></span></label>
          </div>
        </div>

        <div class="settings-field">
          <div class="settings-field-info">
            <div class="settings-field-header">
              <span class="settings-label">Worktree Name</span>
              ${useGlobalCheckbox('worktreeName')}
            </div>
            <div class="settings-description">Custom name for worktree branches</div>
          </div>
          <div class="settings-field-control">
            <input type="text" class="settings-input" id="sv-worktree-name" placeholder="auto" value="${escapeHtml(worktreeNameValue)}" ${fieldDisabled('worktreeName')} style="width:140px">
          </div>
        </div>

        <div class="settings-field">
          <div class="settings-field-info">
            <div class="settings-field-header">
              <span class="settings-label">Chrome</span>
              ${useGlobalCheckbox('chrome')}
            </div>
            <div class="settings-description">Enable Chrome browser automation</div>
          </div>
          <div class="settings-field-control">
            <label class="settings-toggle"><input type="checkbox" id="sv-chrome" ${chromeValue ? 'checked' : ''} ${fieldDisabled('chrome')}><span class="settings-toggle-slider"></span></label>
          </div>
        </div>

        <div class="settings-field settings-field-wide">
          <div class="settings-field-info">
            <div class="settings-field-header">
              <span class="settings-label">Additional Directories</span>
              ${useGlobalCheckbox('addDirs')}
            </div>
            <div class="settings-description">Extra directories to include in Claude sessions</div>
          </div>
          <div class="settings-field-control">
            <input type="text" class="settings-input" id="sv-add-dirs" placeholder="/path/to/dir1, /path/to/dir2" value="${escapeHtml(addDirsValue)}" ${fieldDisabled('addDirs')}>
          </div>
        </div>
      </div>

      <div class="settings-section">
        <div class="settings-section-title">Session Launch</div>

        <div class="settings-field settings-field-wide">
          <div class="settings-field-info">
            <div class="settings-field-header">
              <span class="settings-label">Pre-launch Command</span>
              ${useGlobalCheckbox('preLaunchCmd')}
            </div>
            <div class="settings-description">Prepended to the claude command (e.g. "aws-vault exec profile --")</div>
          </div>
          <div class="settings-field-control">
            <input type="text" class="settings-input" id="sv-pre-launch" placeholder="e.g. aws-vault exec profile --" value="${escapeHtml(preLaunchValue)}" ${fieldDisabled('preLaunchCmd')}>
          </div>
        </div>
      </div>

      ${!isProject ? `<div class="settings-section">
        <div class="settings-section-title">Application</div>

        <div class="settings-field">
          <div class="settings-field-info">
            <span class="settings-label">Terminal Theme</span>
            <div class="settings-description">Color theme for terminal sessions</div>
          </div>
          <div class="settings-field-control">
            <select class="settings-select" id="sv-terminal-theme">
              ${Object.entries(TERMINAL_THEMES).map(([key, t]) =>
                `<option value="${key}" ${themeValue === key ? 'selected' : ''}>${escapeHtml(t.label)}</option>`
              ).join('')}
            </select>
          </div>
        </div>

        <div class="settings-field">
          <div class="settings-field-info">
            <span class="settings-label">Shell Profile</span>
            <div class="settings-description">Shell used for terminal and Claude sessions. Changes take effect for new sessions only.</div>
          </div>
          <div class="settings-field-control">
            <select class="settings-select" id="sv-shell-profile">
              <option value="auto" ${shellProfileValue === 'auto' ? 'selected' : ''}>Auto (detect)</option>
              ${shellProfiles.map(p =>
                `<option value="${escapeHtml(p.id)}" ${shellProfileValue === p.id ? 'selected' : ''}>${escapeHtml(p.name)}</option>`
              ).join('')}
            </select>
          </div>
        </div>

        <div class="settings-field">
          <div class="settings-field-info">
            <span class="settings-label">Max Visible Sessions</span>
            <div class="settings-description">Show up to this many sessions before collapsing the rest behind "+N older"</div>
          </div>
          <div class="settings-field-control">
            <input type="number" class="settings-input settings-input-compact" id="sv-visible-count" min="1" max="100" value="${visCountValue}">
          </div>
        </div>

        <div class="settings-field">
          <div class="settings-field-info">
            <span class="settings-label">Session Max Age (days)</span>
            <div class="settings-description">Sessions older than this are hidden behind "+N older" even if under the count limit</div>
          </div>
          <div class="settings-field-control">
            <input type="number" class="settings-input settings-input-compact" id="sv-max-age" min="1" max="365" value="${maxAgeValue}">
          </div>
        </div>

        <div class="settings-field">
          <div class="settings-field-info">
            <span class="settings-label">IDE Emulation</span>
            <div class="settings-description">Emulate an IDE so Claude can open files and diffs in a side panel. Disable to use your own IDE instead. Changes take effect for new sessions only.</div>
          </div>
          <div class="settings-field-control">
            <label class="settings-toggle"><input type="checkbox" id="sv-mcp-emulation" ${mcpEmulationValue ? 'checked' : ''}><span class="settings-toggle-slider"></span></label>
          </div>
        </div>

        <div class="settings-field">
          <div class="settings-field-info">
            <span class="settings-label">IDE integration over SSH</span>
            <div class="settings-description">Let <strong>remote</strong> Claude sessions open files and diffs in Switchboard's side panel, like local ones. This reverse-forwards the local IDE port to the remote host (protected by a per-session token) — enable only for hosts you trust. Off by default; applies to new remote sessions.</div>
          </div>
          <div class="settings-field-control">
            <label class="settings-toggle"><input type="checkbox" id="sv-remote-ide" ${remoteIdeValue ? 'checked' : ''}><span class="settings-toggle-slider"></span></label>
          </div>
        </div>
      </div>` : ''}

      ${!isProject ? `<div class="settings-section">
        <div class="settings-section-title">Remote Hosts (SSH)</div>
        <div class="settings-description" style="margin-bottom:10px">Hosts from <code>~/.ssh/config</code> are imported automatically. Add extra hosts below. Authentication uses your SSH agent/keys — passwords are never stored.</div>
        <div id="sv-remote-config-list" class="remote-config-list"></div>
        <div id="sv-remote-manual-list" class="remote-manual-list"></div>
        <div class="remote-hosts-actions">
          <button class="settings-check-updates-btn" id="sv-remote-add-btn" type="button">Add Host</button>
          <button class="settings-save-btn" id="sv-remote-save-btn" type="button">Save Hosts</button>
        </div>
        <div id="sv-remote-status" class="remote-hosts-status"></div>
      </div>` : ''}

      ${!isProject ? `<div class="settings-section">
        <div class="settings-section-title">Updates</div>
        <div class="settings-field">
          <div class="settings-field-info">
            <span class="settings-label">Version</span>
            <div class="settings-description"><span id="sv-current-version"></span> <span id="sv-update-status"></span></div>
          </div>
          <div class="settings-field-control">
            <button class="settings-check-updates-btn" id="sv-check-updates-btn">Check for Updates</button>
          </div>
        </div>
      </div>` : ''}

      <div class="settings-btn-row">
        <button class="settings-cancel-btn" id="sv-cancel-btn">Cancel</button>
        <button class="settings-save-btn" id="sv-save-btn">Save Settings</button>
        ${isProject ? '<button class="settings-remove-btn" id="sv-remove-btn">Hide Project</button>' : ''}
      </div>
    </div>
  `;

    // Use-global checkboxes toggle field disabled state
    settingsViewerBody.querySelectorAll('.use-global-cb').forEach(cb => {
      cb.addEventListener('change', () => {
        const field = cb.dataset.field;
        const fieldMap = {
          permissionMode: 'sv-perm-mode',
          worktree: 'sv-worktree',
          worktreeName: 'sv-worktree-name',
          chrome: 'sv-chrome',
          preLaunchCmd: 'sv-pre-launch',
          addDirs: 'sv-add-dirs',
        };
        const input = settingsViewerBody.querySelector('#' + fieldMap[field]);
        if (input) input.disabled = cb.checked;
      });
    });

    // Save button
    settingsViewerBody.querySelector('#sv-save-btn').addEventListener('click', async () => {
      let settings = {};

      if (isProject) {
        // Only save fields where "use global" is unchecked
        settingsViewerBody.querySelectorAll('.use-global-cb').forEach(cb => {
          if (!cb.checked) {
            const field = cb.dataset.field;
            const fieldMap = {
              permissionMode: () => settingsViewerBody.querySelector('#sv-perm-mode').value || null,
              worktree: () => settingsViewerBody.querySelector('#sv-worktree').checked,
              worktreeName: () => settingsViewerBody.querySelector('#sv-worktree-name').value.trim(),
              chrome: () => settingsViewerBody.querySelector('#sv-chrome').checked,
              preLaunchCmd: () => settingsViewerBody.querySelector('#sv-pre-launch').value.trim(),
              addDirs: () => settingsViewerBody.querySelector('#sv-add-dirs').value.trim(),
            };
            if (fieldMap[field]) settings[field] = fieldMap[field]();
          }
        });
      } else {
        settings.permissionMode = settingsViewerBody.querySelector('#sv-perm-mode').value || null;
        settings.worktree = settingsViewerBody.querySelector('#sv-worktree').checked;
        settings.worktreeName = settingsViewerBody.querySelector('#sv-worktree-name').value.trim();
        settings.chrome = settingsViewerBody.querySelector('#sv-chrome').checked;
        settings.preLaunchCmd = settingsViewerBody.querySelector('#sv-pre-launch').value.trim();
        settings.addDirs = settingsViewerBody.querySelector('#sv-add-dirs').value.trim();
        settings.visibleSessionCount = parseInt(settingsViewerBody.querySelector('#sv-visible-count').value) || 10;
        settings.sessionMaxAgeDays = parseInt(settingsViewerBody.querySelector('#sv-max-age').value) || 3;
        settings.terminalTheme = settingsViewerBody.querySelector('#sv-terminal-theme').value || 'switchboard';
        settings.mcpEmulation = settingsViewerBody.querySelector('#sv-mcp-emulation').checked;
        const remoteIdeCb = settingsViewerBody.querySelector('#sv-remote-ide');
        if (remoteIdeCb) settings.remoteIde = remoteIdeCb.checked;
        settings.shellProfile = settingsViewerBody.querySelector('#sv-shell-profile').value || 'auto';
      }

      // Merge form values into existing settings to preserve keys not managed by the form
      if (!isProject) {
        const existing = (await window.api.getSetting('global')) || {};
        settings = { ...existing, ...settings };
      }

      await window.api.setSetting(settingsKey, settings);

      // Update visibleSessionCount, sessionMaxAgeDays, and theme
      if (!isProject) {
        if (settings.visibleSessionCount && typeof window._setVisibleSessionCount === 'function') {
          window._setVisibleSessionCount(settings.visibleSessionCount);
        }
        if (settings.sessionMaxAgeDays && typeof window._setSessionMaxAge === 'function') {
          window._setSessionMaxAge(settings.sessionMaxAgeDays);
        }
        if (settings.terminalTheme && typeof window._applyTerminalTheme === 'function') {
          window._applyTerminalTheme(settings.terminalTheme);
        }
        if (typeof refreshSidebar === 'function') refreshSidebar();
      }

      // Notify if IDE Emulation changed
      if (!isProject && settings.mcpEmulation !== mcpEmulationValue) {
        const notice = document.createElement('div');
        notice.className = 'settings-notice';
        notice.textContent = 'IDE Emulation setting changed. New sessions will use the updated setting \u2014 running sessions are not affected.';
        const saveBtn = settingsViewerBody.querySelector('#sv-save-btn');
        saveBtn.parentElement.insertBefore(notice, saveBtn);
        setTimeout(() => notice.remove(), 8000);
      }

      const saveBtn = settingsViewerBody.querySelector('#sv-save-btn');
      saveBtn.textContent = '✓ Saved';
      saveBtn.style.background = '#2ea043';
      saveBtn.style.color = '#fff';
      setTimeout(() => closeSettingsViewer(), 600);
    });

    // Cancel button
    settingsViewerBody.querySelector('#sv-cancel-btn').addEventListener('click', () => {
      closeSettingsViewer();
    });

    // Check for updates button + current version + inline status
    const checkUpdatesBtn = settingsViewerBody.querySelector('#sv-check-updates-btn');
    if (checkUpdatesBtn) {
      const updateStatusEl = settingsViewerBody.querySelector('#sv-update-status');
      window.api.getAppVersion().then(v => {
        const el = settingsViewerBody.querySelector('#sv-current-version');
        if (el) el.textContent = `v${v}`;
      });
      const settingsUpdaterHandler = (type, data) => {
        if (!updateStatusEl) return;
        switch (type) {
          case 'checking': updateStatusEl.textContent = '\u2014 checking\u2026'; break;
          case 'update-available': updateStatusEl.textContent = `\u2014 v${data.version} available`; break;
          case 'update-not-available': updateStatusEl.textContent = '\u2014 up to date'; break;
          case 'download-progress': updateStatusEl.textContent = `\u2014 downloading ${Math.round(data.percent)}%`; break;
          case 'update-downloaded': updateStatusEl.textContent = `\u2014 v${data.version} ready, restart to update`; break;
          case 'error': updateStatusEl.textContent = '\u2014 check failed'; break;
        }
      };
      window.api.onUpdaterEvent(settingsUpdaterHandler);
      checkUpdatesBtn.addEventListener('click', () => {
        window.api.updaterCheck();
      });
    }

    // Remote Hosts section (global settings only)
    const remoteManualList = settingsViewerBody.querySelector('#sv-remote-manual-list');
    if (remoteManualList) {
      const configHosts = remoteTargets.filter(h => h.source === 'config');
      const toEditable = (h) => ({
        id: h.id, label: h.label || '', user: h.user || '', host: h.host || '', port: h.port || '',
        identityFile: h.identityFile || '',
        options: Array.isArray(h.options) ? h.options.join(', ') : (h.options || ''),
      });
      let manualHosts = remoteTargets.filter(h => h.source === 'manual').map(toEditable);
      const statusEl = settingsViewerBody.querySelector('#sv-remote-status');
      const configListEl = settingsViewerBody.querySelector('#sv-remote-config-list');

      const setStatus = (msg, kind) => {
        statusEl.textContent = msg || '';
        statusEl.className = 'remote-hosts-status' + (kind ? ' ' + kind : '');
      };

      const renderConfig = () => {
        if (!configHosts.length) { configListEl.innerHTML = ''; return; }
        configListEl.innerHTML = '<div class="remote-config-title">From ~/.ssh/config</div>' +
          configHosts.map(h =>
            `<div class="remote-host-row">
               <span class="remote-host-name">${escapeHtml(h.label)}</span>
               <span class="remote-host-detail">${escapeHtml((h.user ? h.user + '@' : '') + (h.hostName || h.host || ''))}${h.port ? ':' + h.port : ''}</span>
               <button class="remote-connect-btn" type="button" data-id="${escapeHtml(h.id)}" data-label="${escapeHtml(h.label)}">Connect</button>
               <button class="remote-test-btn" type="button" data-id="${escapeHtml(h.id)}">Test</button>
             </div>`).join('');
      };

      const renderManual = () => {
        remoteManualList.innerHTML = manualHosts.map((h, i) =>
          `<div class="remote-host-card" data-i="${i}">
             <div class="remote-host-row">
               <input class="settings-input" data-f="label" placeholder="label" value="${escapeHtml(h.label)}" style="width:100px">
               <input class="settings-input" data-f="user" placeholder="user" value="${escapeHtml(h.user)}" style="width:80px">
               <input class="settings-input" data-f="host" placeholder="host" value="${escapeHtml(h.host)}" style="width:150px">
               <input class="settings-input" data-f="port" placeholder="22" value="${escapeHtml(String(h.port || ''))}" style="width:56px">
             </div>
             <div class="remote-host-row">
               <input class="settings-input" data-f="identityFile" placeholder="identity file (e.g. ~/.ssh/id_ed25519)" value="${escapeHtml(h.identityFile)}" style="flex:1;min-width:180px">
             </div>
             <div class="remote-host-row">
               <input class="settings-input" data-f="options" title="Extra ssh -o options for legacy/special hosts (e.g. HostKeyAlgorithms=+ssh-rsa, PreferredAuthentications=password). Leave blank for most hosts." placeholder="extra options, comma-sep (e.g. HostKeyAlgorithms=+ssh-rsa, PreferredAuthentications=password)" value="${escapeHtml(h.options)}" style="flex:1;min-width:220px">
             </div>
             <div class="remote-host-row remote-host-actions">
               ${h.id ? `<button class="remote-connect-btn" type="button" data-id="${escapeHtml(h.id)}" data-label="${escapeHtml(h.label || h.host)}">Connect</button>
               <button class="remote-test-btn" type="button" data-id="${escapeHtml(h.id)}">Test</button>` : '<span class="remote-host-detail">Save to enable Connect/Test</span>'}
               <button class="remote-writecfg-btn" type="button" data-i="${i}">→ ~/.ssh/config</button>
               <button class="remote-remove-btn" type="button" data-i="${i}" title="Remove">✕</button>
             </div>
           </div>`).join('');
        remoteManualList.querySelectorAll('.remote-host-card').forEach(card => {
          const i = Number(card.dataset.i);
          card.querySelectorAll('input').forEach(inp => {
            inp.addEventListener('input', () => { manualHosts[i][inp.dataset.f] = inp.value; manualHosts[i].id = undefined; });
          });
          const rm = card.querySelector('.remote-remove-btn');
          if (rm) rm.addEventListener('click', () => { manualHosts.splice(i, 1); renderManual(); });
        });
      };

      settingsViewerBody.querySelector('#sv-remote-add-btn').addEventListener('click', () => {
        manualHosts.push({ label: '', user: '', host: '', port: '', identityFile: '', options: '' });
        renderManual();
      });

      settingsViewerBody.querySelector('#sv-remote-save-btn').addEventListener('click', async () => {
        const toSave = manualHosts.filter(h => h.host && String(h.host).trim());
        try {
          const res = await window.api.saveRemoteHosts(toSave);
          if (res && res.ok) {
            setStatus('Saved ' + toSave.length + ' host(s).', 'ok');
            manualHosts = (res.hosts || []).filter(h => h.source === 'manual').map(toEditable);
            renderManual();
          } else {
            setStatus('Failed to save hosts.', 'err');
          }
        } catch (err) { setStatus('Save error: ' + err.message, 'err'); }
      });

      // Delegated handler for Connect / Test / write-config, bound to the freshly
      // rendered form so listeners don't accumulate across re-opens.
      settingsViewerBody.querySelector('.settings-form').addEventListener('click', async (e) => {
        // Interactive Connect: open a real shell to the host (any auth) — warms the
        // shared connection so Browse/sessions work right after.
        const conn = e.target.closest('.remote-connect-btn');
        if (conn) {
          const host = { id: conn.dataset.id, label: conn.dataset.label || conn.dataset.id };
          const orig = conn.textContent;
          conn.disabled = true; conn.textContent = 'Connecting…';
          setStatus('Connecting to ' + host.label + '…');
          let ok = false;
          try { ok = (typeof connectRemoteHost === 'function') ? await connectRemoteHost(host) : false; } catch {}
          conn.disabled = false;
          if (ok) { conn.textContent = '✓ Connected'; conn.classList.add('connected'); setStatus('✓ ' + host.label + ' connected (ready to Browse).', 'ok'); }
          else { conn.textContent = orig; setStatus('', ''); }
          return;
        }
        // Write a manual host into ~/.ssh/config.
        const wcfg = e.target.closest('.remote-writecfg-btn');
        if (wcfg) {
          const h = manualHosts[Number(wcfg.dataset.i)];
          if (!h || !h.host || !String(h.host).trim()) { setStatus('Enter a host first.', 'err'); return; }
          wcfg.disabled = true;
          try {
            const r = await window.api.writeSshConfig(h);
            if (r.ok) setStatus('✓ Wrote "' + r.label + '" to ~/.ssh/config. Reopen settings to see it under imported hosts.', 'ok');
            else setStatus('✗ ' + (r.error || 'failed to write config'), 'err');
          } catch (err) { setStatus('✗ ' + err.message, 'err'); }
          wcfg.disabled = false;
          return;
        }
        // Quick non-interactive reachability probe.
        const btn = e.target.closest('.remote-test-btn');
        if (!btn) return;
        const id = btn.dataset.id;
        const old = btn.textContent;
        btn.disabled = true; btn.textContent = 'Testing…';
        setStatus('Testing ' + id + '…');
        try {
          const r = await window.api.testRemoteHost(id);
          setStatus((r.reachable ? '✓ ' : '✗ ') + id + ': ' + (r.message || (r.ok ? 'reachable' : 'failed')), r.reachable ? 'ok' : 'err');
        } catch (err) { setStatus('✗ test error: ' + err.message, 'err'); }
        btn.disabled = false; btn.textContent = old;
      });

      renderConfig();
      renderManual();
    }

    // Remove project button
    const removeBtn = settingsViewerBody.querySelector('#sv-remove-btn');
    if (removeBtn) {
      removeBtn.addEventListener('click', async () => {
        if (!confirm(`Hide project "${shortName}" from Switchboard?\n\nThis hides the project from the sidebar. Your session files are not deleted.`)) return;
        await window.api.removeProject(projectPath);
        settingsViewer.style.display = 'none';
        document.getElementById('placeholder').style.display = 'flex';
        if (typeof loadProjects === 'function') loadProjects();
      });
    }
  }

  // Expose globally
  window.openSettingsViewer = openSettingsViewer;
  window.closeSettingsViewer = closeSettingsViewer;
})();
