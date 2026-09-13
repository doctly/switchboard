// The same settings form is mounted by New Session and Create/Edit Schedule.
(function (root) {
  function mount(container, { runtime, defaults = {}, overrides = {}, inherit = false, onChange = () => {} }) {
    let saved = SessionConfig.normalizeOverrides(runtime, overrides);
    let values = SessionConfig.resolveOptions(runtime, defaults, saved);
    const fields = SessionConfig.fieldsFor(runtime).filter(f => !f.hidden);
    const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const keys = field => field.type === 'permission' ? [field.key, 'dangerouslySkipPermissions'] : [field.key];
    function permissionButtons(field) {
      return field.choices.map(c => `<button type="button" class="permission-option${!values.dangerouslySkipPermissions && values[field.key] === c.value ? ' selected' : ''}" data-permission="${esc(c.value ?? '')}"><span class="perm-name">${esc(c.label)}</span><span class="perm-desc">${esc(c.desc)}</span></button>`).join('') +
        `<button type="button" class="permission-option dangerous${values.dangerouslySkipPermissions ? ' selected' : ''}" data-permission="dangerous-skip"><span class="perm-name">Dangerous Skip</span><span class="perm-desc">Skip all permission prompts</span></button>`;
    }
    function control(field) {
      const value = values[field.key];
      if (field.type === 'permission') return `<div class="permission-grid">${permissionButtons(field)}</div>`;
      if (field.type === 'boolean') return `<label class="settings-toggle"><input type="checkbox" data-config-input ${value ? 'checked' : ''} aria-label="${esc(field.label)}"><span class="settings-toggle-slider"></span></label>`;
      if (field.type === 'select') return `<select class="settings-select" data-config-input aria-label="${esc(field.label)}">${field.choices.map(c => `<option value="${esc(c.value)}" ${c.value === value ? 'selected' : ''}>${esc(c.label)}</option>`).join('')}</select>`;
      if (field.type === 'textarea') return `<textarea class="settings-input" rows="3" data-config-input aria-label="${esc(field.label)}">${esc(value)}</textarea>`;
      return `<input type="text" class="settings-input" data-config-input aria-label="${esc(field.label)}" placeholder="${esc(field.placeholder || '')}" value="${esc(value)}">`;
    }
    container.innerHTML = fields.map(field => `<div class="settings-field${field.wide || field.type === 'permission' ? ' settings-field-wide' : ''}" data-config-field="${field.key}">
      <div class="settings-field-info"><span class="settings-label">${esc(field.label)}</span>${field.description ? `<div class="settings-description">${esc(field.description)}</div>` : ''}${inherit ? '<div class="session-config-inheritance"></div>' : ''}</div>
      <div class="settings-field-control">${control(field)}</div></div>`).join('');
    function inheritance(row, field) {
      if (!inherit) return;
      const custom = keys(field).some(key => SessionConfig.own(saved, key));
      row.querySelector('.session-config-inheritance').innerHTML = custom
        ? '<button type="button" class="session-config-reset">Use folder default</button>' : '<span>Folder default</span>';
    }
    for (const field of fields) {
      const row = container.querySelector(`[data-config-field="${field.key}"]`);
      inheritance(row, field);
      const changed = () => { inheritance(row, field); onChange({ ...saved }); };
      row.addEventListener('click', e => {
        if (e.target.closest('.session-config-reset')) {
          for (const key of keys(field)) delete saved[key];
          values = SessionConfig.resolveOptions(runtime, defaults, saved);
          const input = row.querySelector('[data-config-input]');
          if (field.type === 'permission') row.querySelector('.permission-grid').innerHTML = permissionButtons(field);
          else if (field.type === 'boolean') input.checked = values[field.key];
          else input.value = values[field.key];
          changed();
          return;
        }
        const button = e.target.closest('[data-permission]');
        if (!button) return;
        const mode = button.dataset.permission;
        saved.dangerouslySkipPermissions = mode === 'dangerous-skip' && !values.dangerouslySkipPermissions;
        saved.permissionMode = mode === 'dangerous-skip' ? null : mode || null;
        values = SessionConfig.resolveOptions(runtime, defaults, saved);
        row.querySelector('.permission-grid').innerHTML = permissionButtons(field);
        changed();
      });
      const input = row.querySelector('[data-config-input]');
      if (input) input.addEventListener('input', () => {
        saved[field.key] = field.type === 'boolean' ? input.checked : input.value;
        values[field.key] = saved[field.key];
        changed();
      });
    }
    return {
      getOverrides: () => SessionConfig.normalizeOverrides(runtime, saved),
      getOptions: () => SessionConfig.resolveOptions(runtime, defaults, saved),
    };
  }
  root.SessionConfigForm = { mount };
})(window);
