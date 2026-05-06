// profiles-panel.js — modal UI to manage Claude session profiles.
// Each profile is a named bundle of env vars (literal values or "$VAR" /
// "${VAR}" references resolved against the host's process env at spawn).

(function () {
  function uid() {
    // base36, 10 chars, fits ID_RE in profiles.js (alnum + - _, len ≤ 64)
    return Math.random().toString(36).slice(2, 12);
  }

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function isEnvRef(v) {
    return /^\$(?:\{[A-Za-z_][A-Za-z0-9_]*\}|[A-Za-z_][A-Za-z0-9_]*)$/.test(v || '');
  }

  // --- Editor for a single profile ---------------------------------------
  // When `profile` is null and `preset` is provided, the form pre-fills from
  // the preset (name + env vars). The user still has to click Create to save.
  function renderEditor(profile, onSave, onCancel, onDelete, preset) {
    const overlay = el('div', 'new-session-overlay');
    const dialog = el('div', 'new-session-dialog profiles-dialog');

    const isNew = !profile;
    let state;
    if (profile) {
      state = { id: profile.id, name: profile.name, env: { ...profile.env }, icon: profile.icon || '' };
    } else if (preset) {
      state = { id: uid(), name: preset.name, env: { ...preset.env }, icon: preset.icon || '' };
    } else {
      state = { id: uid(), name: '', env: {}, icon: '' };
    }

    const titleText = isNew
      ? (preset ? `New Profile — from ${preset.name} template` : 'New Profile')
      : `Edit Profile — ${state.name || state.id}`;
    const title = el('h3', null, titleText);
    dialog.appendChild(title);

    if (isNew && preset) {
      const presetNote = el('div', 'profile-hint');
      presetNote.innerHTML =
        `<strong>Template:</strong> ${preset.summary || ''} ` +
        `Make sure <code>${preset.tokenEnvHint || ''}</code> is set in your system environment ` +
        `(setx on Windows, ~/.zshrc on mac/linux), or change the <code>ANTHROPIC_AUTH_TOKEN</code> reference below.`;
      dialog.appendChild(presetNote);
    }

    // Name field
    const nameField = el('div', 'settings-field settings-field-wide');
    nameField.innerHTML = `
      <div class="settings-field-info">
        <span class="settings-label">Name</span>
        <div class="settings-description">Display name (e.g. "DeepSeek", "GLM", "Anthropic Default")</div>
      </div>
      <div class="settings-field-control">
        <input type="text" class="settings-input profile-name-input" placeholder="DeepSeek" maxlength="100">
      </div>`;
    const nameInput = nameField.querySelector('.profile-name-input');
    nameInput.value = state.name;
    dialog.appendChild(nameField);

    // Icon picker — controls the badge shown on sidebar sessions launched
    // with this profile. Pre-selects the preset's default for new-from-template.
    const iconField = el('div', 'settings-field settings-field-wide profile-icon-field');
    const iconLabel = el('div', 'settings-field-info');
    iconLabel.innerHTML =
      '<span class="settings-label">Icon</span>' +
      '<div class="settings-description">Shown on sidebar sessions launched with this profile (default profile sessions stay unbadged).</div>';
    iconField.appendChild(iconLabel);
    const iconGrid = el('div', 'profile-icon-grid');
    const iconKeys = (typeof window.getProfileIconKeys === 'function') ? window.getProfileIconKeys() : [];
    function renderIconGrid() {
      iconGrid.innerHTML = '';
      for (const key of iconKeys) {
        const cell = el('button', 'profile-icon-cell' + (state.icon === key ? ' selected' : ''));
        cell.type = 'button';
        cell.title = (window.PROFILE_ICONS && window.PROFILE_ICONS[key] && window.PROFILE_ICONS[key].label) || key;
        cell.dataset.iconKey = key;
        cell.appendChild(window.renderProfileIcon(key, 24));
        cell.onclick = () => {
          state.icon = (state.icon === key) ? '' : key;  // click again to clear
          renderIconGrid();
        };
        iconGrid.appendChild(cell);
      }
    }
    renderIconGrid();
    iconField.appendChild(iconGrid);
    dialog.appendChild(iconField);

    // Env vars section
    const envSection = el('div', 'settings-field settings-field-wide profile-env-section');
    envSection.innerHTML = `
      <div class="settings-field-info">
        <span class="settings-label">Environment Variables</span>
        <div class="settings-description">
          Literal value, or <code>$VAR</code> / <code>\${VAR}</code> to reference a system env var
          (recommended for secrets like API keys). Unresolved refs are dropped at spawn time.
        </div>
      </div>
      <div class="profile-env-rows"></div>
      <button type="button" class="profile-env-add">+ Add variable</button>`;
    const rowsEl = envSection.querySelector('.profile-env-rows');
    dialog.appendChild(envSection);

    function addRow(key, value) {
      const row = el('div', 'profile-env-row');
      row.innerHTML = `
        <input type="text" class="settings-input profile-env-key" placeholder="ANTHROPIC_BASE_URL" pattern="[A-Za-z_][A-Za-z0-9_]*">
        <input type="text" class="settings-input profile-env-val" placeholder="https://... or $MY_API_KEY">
        <span class="profile-env-status"></span>
        <button type="button" class="profile-env-remove" title="Remove">×</button>`;
      const keyInput = row.querySelector('.profile-env-key');
      const valInput = row.querySelector('.profile-env-val');
      const status = row.querySelector('.profile-env-status');
      keyInput.value = key || '';
      valInput.value = value || '';
      function refreshStatus() {
        status.className = 'profile-env-status';
        status.textContent = '';
        if (isEnvRef(valInput.value)) {
          status.textContent = 'env ref';
          status.classList.add('is-ref');
        } else if (valInput.value) {
          status.textContent = 'literal';
          status.classList.add('is-literal');
        }
      }
      valInput.addEventListener('input', refreshStatus);
      refreshStatus();
      row.querySelector('.profile-env-remove').onclick = () => row.remove();
      rowsEl.appendChild(row);
    }

    Object.entries(state.env).forEach(([k, v]) => addRow(k, v));
    if (Object.keys(state.env).length === 0) {
      addRow('ANTHROPIC_BASE_URL', '');
      addRow('ANTHROPIC_AUTH_TOKEN', '');
    }
    envSection.querySelector('.profile-env-add').onclick = () => addRow('', '');

    // Hint suggesting the common pattern
    const hint = el('div', 'profile-hint');
    hint.innerHTML = `
      <strong>Tip:</strong> store secrets as system env vars (e.g.
      <code>setx DEEPSEEK_API_KEY ...</code>) and reference them here as
      <code>$DEEPSEEK_API_KEY</code>. Profile values are saved in plain text;
      references keep secrets out of this file.`;
    dialog.appendChild(hint);

    // Actions
    const actions = el('div', 'new-session-actions');
    const cancelBtn = el('button', 'new-session-cancel-btn', 'Cancel');
    const saveBtn = el('button', 'new-session-start-btn', isNew ? 'Create' : 'Save');
    let deleteBtn = null;
    if (!isNew) {
      deleteBtn = el('button', 'new-session-cancel-btn profile-delete-btn', 'Delete');
      deleteBtn.style.marginRight = 'auto';
      actions.appendChild(deleteBtn);
    }
    actions.appendChild(cancelBtn);
    actions.appendChild(saveBtn);
    dialog.appendChild(actions);

    overlay.appendChild(dialog);
    document.body.appendChild(overlay);
    nameInput.focus();

    function close() { overlay.remove(); document.removeEventListener('keydown', onKey); }
    function onKey(e) { if (e.key === 'Escape') { close(); onCancel && onCancel(); } }
    document.addEventListener('keydown', onKey);

    cancelBtn.onclick = () => { close(); onCancel && onCancel(); };
    overlay.addEventListener('click', (e) => { if (e.target === overlay) { close(); onCancel && onCancel(); } });

    if (deleteBtn) {
      deleteBtn.onclick = async () => {
        if (!confirm(`Delete profile "${state.name || state.id}"?`)) return;
        await window.api.profiles.delete(state.id);
        if (typeof window.refreshProfileCaches === 'function') {
          await window.refreshProfileCaches();
          if (typeof refreshSidebar === 'function') refreshSidebar();
        }
        close();
        onDelete && onDelete();
      };
    }

    saveBtn.onclick = async () => {
      const name = nameInput.value.trim();
      if (!name) { nameInput.focus(); return; }
      const env = {};
      let invalid = null;
      for (const row of rowsEl.querySelectorAll('.profile-env-row')) {
        const k = row.querySelector('.profile-env-key').value.trim();
        const v = row.querySelector('.profile-env-val').value;
        if (!k && !v) continue;
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) { invalid = `Invalid env name: "${k}"`; break; }
        if (k in env) { invalid = `Duplicate env name: "${k}"`; break; }
        env[k] = v;
      }
      if (invalid) { alert(invalid); return; }

      const payload = { id: state.id, name, env };
      if (state.icon) payload.icon = state.icon;
      const result = await window.api.profiles.save(payload);
      if (!result.ok) { alert(`Save failed: ${result.error}`); return; }
      if (typeof window.refreshProfileCaches === 'function') {
        await window.refreshProfileCaches();
        if (typeof refreshSidebar === 'function') refreshSidebar();
      }
      close();
      onSave && onSave();
    };
  }

  // --- List view: pick / edit / create profiles --------------------------
  async function showProfilesManager() {
    const data = await window.api.profiles.list();

    const overlay = el('div', 'new-session-overlay');
    const dialog = el('div', 'new-session-dialog profiles-dialog');
    dialog.appendChild(el('h3', null, 'Claude Profiles'));

    const desc = el('div', 'settings-description profiles-help');
    desc.innerHTML = `
      Profiles are named bundles of environment variables applied when launching a Claude session.
      Use them to switch backends — e.g. point <code>ANTHROPIC_BASE_URL</code> at DeepSeek or GLM
      and reference your API keys as <code>$DEEPSEEK_API_KEY</code> / <code>$GLM_API_KEY</code>.
      One profile can be marked as the global default.`;
    dialog.appendChild(desc);

    const list = el('div', 'profiles-list');
    if (data.profiles.length === 0) {
      const empty = el('div', 'profiles-empty', 'No profiles yet. Pick a template below or click + New to create one from scratch.');
      list.appendChild(empty);
    }
    for (const p of data.profiles) {
      const isDefault = p.id === data.defaultProfileId;
      const row = el('div', 'profile-row');
      // Lead with the profile's icon so the row matches the sidebar badge.
      if (p.icon && typeof window.renderProfileIcon === 'function') {
        const icoWrap = el('div', 'profile-row-icon');
        icoWrap.appendChild(window.renderProfileIcon(p.icon, 28));
        row.appendChild(icoWrap);
      }
      const meta = el('div', 'profile-row-meta');
      const nm = el('div', 'profile-row-name', p.name);
      if (isDefault) {
        const badge = el('span', 'profile-default-badge', 'default');
        nm.appendChild(badge);
      }
      const sub = el('div', 'profile-row-sub', `${Object.keys(p.env).length} env var(s)`);
      meta.appendChild(nm);
      meta.appendChild(sub);
      row.appendChild(meta);

      const actions = el('div', 'profile-row-actions');
      const setDefaultBtn = el('button', 'profile-row-btn');
      setDefaultBtn.textContent = isDefault ? 'Default ✓' : 'Set default';
      setDefaultBtn.onclick = async () => {
        await window.api.profiles.setDefault(isDefault ? null : p.id);
        if (typeof window.refreshProfileCaches === 'function') {
          await window.refreshProfileCaches();
          if (typeof refreshSidebar === 'function') refreshSidebar();
        }
        overlay.remove();
        showProfilesManager();
      };
      const editBtn = el('button', 'profile-row-btn', 'Edit');
      editBtn.onclick = () => {
        overlay.remove();
        renderEditor(p, () => showProfilesManager(), () => showProfilesManager(), () => showProfilesManager());
      };
      actions.appendChild(setDefaultBtn);
      actions.appendChild(editBtn);
      row.appendChild(actions);
      list.appendChild(row);
    }
    dialog.appendChild(list);

    // --- Templates section: built-in presets for common backends ---------
    const presets = (window.PROFILE_PRESETS || []);
    if (presets.length > 0) {
      const tplHeader = el('div', 'profiles-section-header', 'Add from template');
      dialog.appendChild(tplHeader);
      const tplDesc = el('div', 'settings-description profiles-help');
      tplDesc.innerHTML =
        'Pre-configured for common backends. Set the named API-key env var on your system (e.g. ' +
        '<code>setx DEEPSEEK_API_KEY ...</code> on Windows), then pick a template — it opens the editor pre-filled.';
      dialog.appendChild(tplDesc);

      const tplList = el('div', 'profile-presets-list');
      for (const preset of presets) {
        const row = el('div', 'profile-preset-row');
        if (preset.icon && typeof window.renderProfileIcon === 'function') {
          const icoWrap = el('div', 'profile-row-icon');
          icoWrap.appendChild(window.renderProfileIcon(preset.icon, 28));
          row.appendChild(icoWrap);
        }
        const meta = el('div', 'profile-row-meta');
        const nm = el('div', 'profile-row-name', preset.name);
        const sub = el('div', 'profile-row-sub', preset.summary || '');
        meta.appendChild(nm);
        meta.appendChild(sub);
        row.appendChild(meta);

        const useBtn = el('button', 'profile-row-btn profile-preset-use', 'Use template');
        useBtn.onclick = () => {
          overlay.remove();
          renderEditor(null, () => showProfilesManager(), () => showProfilesManager(), null, preset);
        };
        row.appendChild(useBtn);
        tplList.appendChild(row);
      }
      dialog.appendChild(tplList);
    }

    const newBtn = el('button', 'new-session-start-btn profile-new-btn', '+ New (blank)');
    newBtn.onclick = () => {
      overlay.remove();
      renderEditor(null, () => showProfilesManager(), () => showProfilesManager());
    };

    const closeBtn = el('button', 'new-session-cancel-btn', 'Close');
    closeBtn.onclick = () => overlay.remove();

    const actions = el('div', 'new-session-actions');
    actions.appendChild(newBtn);
    actions.appendChild(closeBtn);
    dialog.appendChild(actions);

    overlay.appendChild(dialog);
    document.body.appendChild(overlay);

    function onKey(e) { if (e.key === 'Escape') { overlay.remove(); document.removeEventListener('keydown', onKey); } }
    document.addEventListener('keydown', onKey);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
  }

  // Export
  window.showProfilesManager = showProfilesManager;
  window.profilesPanel = { showProfilesManager };
})();
