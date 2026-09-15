// The same settings form is mounted by New Session and Create/Edit Schedule.
(function (root) {
  let mounts = 0;
  function mount(container, { runtime, defaults = {}, overrides = {}, inherit = false, onChange = () => {} }) {
    const uid = ++mounts;
    let saved = SessionConfig.normalizeOverrides(runtime, overrides);
    let values = SessionConfig.resolveOptions(runtime, defaults, saved);
    const fields = SessionConfig.fieldsFor(runtime).filter(f => !f.hidden);
    const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const listId = field => `session-config-${uid}-${field.key}`;
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
      // Suggestions offer known names without limiting the field to them.
      const suggest = field.suggestions || field.catalog;
      return `<input type="text" class="settings-input" data-config-input aria-label="${esc(field.label)}" placeholder="${esc(field.placeholder || '')}" value="${esc(value)}"${suggest ? ` list="${listId(field)}"` : ''}>` +
        (suggest ? `<datalist id="${listId(field)}">${(field.suggestions || []).map(name => `<option value="${esc(name)}"></option>`).join('')}</datalist>` : '');
    }
    const fieldRow = field => `<div class="settings-field${field.wide || field.type === 'permission' ? ' settings-field-wide' : ''}" data-config-field="${field.key}">
      <div class="settings-field-info"><span class="settings-label">${esc(field.label)}</span>${field.description ? `<div class="settings-description">${esc(field.description)}</div>` : ''}${inherit ? '<div class="session-config-inheritance"></div>' : ''}${field.modelField ? '<div class="session-config-note" hidden></div>' : ''}</div>
      <div class="settings-field-control">${control(field)}</div></div>`;
    // Optional settings without a value wait behind "More options". Revealing
    // them is one-way, so a field typed into can never be tucked away again.
    const behindMore = new Set(SessionConfig.fieldsBehindMore(runtime, values));
    const tucked = fields.filter(f => behindMore.has(f.key));
    container.innerHTML = fields.filter(f => !behindMore.has(f.key)).map(fieldRow).join('') + (tucked.length
      ? `<button type="button" class="session-config-more-toggle"><span class="session-config-more-label">More options</span><span class="session-config-more-names">${esc(tucked.map(f => f.label).join(', '))}</span></button>` +
        `<div class="session-config-more" hidden>${tucked.map(fieldRow).join('')}</div>`
      : '');
    const moreToggle = container.querySelector('.session-config-more-toggle');
    if (moreToggle) moreToggle.onclick = () => {
      container.querySelector('.session-config-more').hidden = false;
      moreToggle.remove();
    };
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
    // Codex's reasoning efforts depend on the model, and a scheduled run starts
    // with nobody watching. So levels the chosen model does not support are
    // disabled, and a selection it does not support goes back to Default with a
    // note saying why. Without the catalog (codex never fetched it), or for a
    // model it does not list, every level stays available.
    const catalogField = fields.find(f => f.catalog === 'codex');
    const effortFields = fields.filter(f => f.modelField);
    if (catalogField && effortFields.length && root.api?.getCodexModels) {
      root.api.getCodexModels().then(models => {
        if (!container.isConnected || !Array.isArray(models) || !models.length) return;
        const byModel = new Map(models.map(m => [m.slug, m]));
        const datalist = container.querySelector(`#${CSS.escape(listId(catalogField))}`);
        if (datalist) datalist.innerHTML = models.filter(m => m.visible)
          .map(m => `<option value="${esc(m.slug)}">${esc(m.label)}</option>`).join('');
        const restrict = () => {
          for (const field of effortFields) {
            const row = container.querySelector(`[data-config-field="${field.key}"]`);
            const select = row?.querySelector('select');
            if (!select) continue;
            const note = row.querySelector('.session-config-note');
            note.hidden = true;
            const model = byModel.get(values[field.modelField]);
            const supported = model?.efforts?.length ? new Set(model.efforts) : null;
            for (const option of select.options) option.disabled = !!supported && option.value !== '' && !supported.has(option.value);
            if (!supported || !values[field.key] || supported.has(values[field.key])) continue;
            const label = select.selectedOptions[0]?.textContent || values[field.key];
            saved[field.key] = '';
            values[field.key] = '';
            select.value = '';
            inheritance(row, field);
            onChange({ ...saved });
            note.textContent = `${model.slug} does not support ${label}, so this is back to Default`;
            note.hidden = false;
          }
        };
        const modelRow = container.querySelector(`[data-config-field="${catalogField.key}"]`);
        modelRow?.querySelector('[data-config-input]')?.addEventListener('input', restrict);
        // "Use folder default" changes the model without an input event.
        modelRow?.addEventListener('click', restrict);
        for (const field of effortFields) {
          container.querySelector(`[data-config-field="${field.key}"] select`)?.addEventListener('input', restrict);
        }
        restrict();
      }).catch(() => {});
    }
    return {
      getOverrides: () => SessionConfig.normalizeOverrides(runtime, saved),
      getOptions: () => SessionConfig.resolveOptions(runtime, defaults, saved),
    };
  }
  root.SessionConfigForm = { mount };
})(window);
