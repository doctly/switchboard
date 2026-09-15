// Shared definitions, validation and inheritance for session and schedule settings.
// Add supported fields here once; both configuration forms use this registry.
(function (root) {
  const PERMISSION_MODES = [
    { value: null, label: 'Default', desc: 'Prompt for all actions' },
    { value: 'auto', label: 'Auto', desc: 'Classifier allows routine work, stops for risky actions' },
    { value: 'acceptEdits', label: 'Accept Edits', desc: 'Auto-accept file edits, prompt for others' },
    { value: 'plan', label: 'Plan Mode', desc: 'Read-only exploration, no writes' },
    { value: 'dontAsk', label: "Don't Ask", desc: 'Auto-deny tools not explicitly allowed' },
    { value: 'bypassPermissions', label: 'Bypass', desc: 'Auto-accept all tool calls' },
  ];
  const CODEX_SANDBOX_MODES = [
    { value: '', label: 'Default', desc: "Use codex's own config" },
    { value: 'read-only', label: 'Read Only', desc: 'No writes, no commands that change things' },
    { value: 'workspace-write', label: 'Workspace Write', desc: 'Write inside the project directory' },
    { value: 'danger-full-access', label: 'Full Access', desc: 'No sandbox at all' },
  ];
  const CODEX_APPROVAL_POLICIES = [
    { value: '', label: 'Default', desc: "Use codex's own config" },
    { value: 'on-request', label: 'On Request', desc: 'Codex decides when to ask' },
    { value: 'never', label: 'Never', desc: 'Never ask; failures go back to the model' },
  ];
  // Effort levels. Claude's are the ones `claude --help` lists. Codex's are
  // the union over its model catalog; each model supports a subset, and the
  // form narrows the choice to what the chosen model accepts.
  const CLAUDE_EFFORTS = [
    { value: '', label: 'Default' }, { value: 'low', label: 'Low' }, { value: 'medium', label: 'Medium' },
    { value: 'high', label: 'High' }, { value: 'xhigh', label: 'Extra High' }, { value: 'max', label: 'Max' },
  ];
  const CODEX_EFFORTS = [...CLAUDE_EFFORTS, { value: 'ultra', label: 'Ultra' }];
  const FIELDS = {
    claude: [
      { key: 'permissionMode', label: 'Permission Mode', type: 'permission', default: null, choices: PERMISSION_MODES },
      { key: 'dangerouslySkipPermissions', type: 'boolean', default: false, hidden: true },
      { key: 'model', label: 'Model', type: 'text', default: '', more: true, placeholder: 'default', suggestions: ['fable', 'opus', 'sonnet'], description: "Blank uses Claude's default. An alias or a full model name" },
      { key: 'effort', label: 'Effort', type: 'select', default: '', more: true, choices: CLAUDE_EFFORTS, description: "Default uses Claude's own setting" },
      { key: 'allowedTools', label: 'Allowed Tools', type: 'text', default: '', more: true, wide: true, description: 'Tools allowed without a permission prompt (comma-separated)' },
      { key: 'appendSystemPrompt', label: 'Additional System Prompt', type: 'textarea', default: '', more: true, wide: true, description: 'Instructions appended to Claude’s system prompt' },
      { key: 'worktree', label: 'Worktree', type: 'boolean', default: false, description: 'Run each new session in an isolated git worktree' },
      { key: 'worktreeName', label: 'Worktree Name', type: 'text', default: '', placeholder: 'name (optional)' },
      { key: 'chrome', label: 'Chrome', type: 'boolean', default: false, description: 'Enable Chrome browser automation' },
      { key: 'mcpEmulation', type: 'boolean', default: true, hidden: true },
    ],
    codex: [
      { key: 'codexSandbox', label: 'Sandbox', type: 'select', default: '', choices: CODEX_SANDBOX_MODES, description: 'What Codex is allowed to touch' },
      { key: 'codexApproval', label: 'Approval', type: 'select', default: '', choices: CODEX_APPROVAL_POLICIES, description: 'When Codex asks before running a command' },
      { key: 'codexModel', label: 'Model', type: 'text', default: '', more: true, placeholder: 'default', catalog: 'codex', description: "Blank uses Codex's default" },
      { key: 'codexEffort', label: 'Reasoning Effort', type: 'select', default: '', more: true, choices: CODEX_EFFORTS, modelField: 'codexModel', description: "Default uses Codex's own setting" },
      { key: 'dangerouslySkipPermissions', label: 'Bypass Approvals and Sandbox', type: 'boolean', default: false, description: 'Disables permission prompts and sandbox restrictions' },
    ],
  };
  const COMMON_FIELDS = [
    { key: 'preLaunchCmd', label: 'Pre-launch Command', type: 'text', default: '', more: true, wide: true, placeholder: 'e.g. aws-vault exec profile --', description: 'Prepended to the CLI command' },
    { key: 'addDirs', label: 'Additional Directories', type: 'text', default: '', more: true, wide: true, placeholder: '/path/to/dir1, /path/to/dir2', description: 'Extra directories (comma-separated). Project attachments are included automatically.' },
  ];
  const own = (o, key) => Object.prototype.hasOwnProperty.call(o || {}, key);
  const isObject = value => !!value && typeof value === 'object' && !Array.isArray(value);
  function fieldsFor(runtime) { return [...(FIELDS[runtime] || []), ...COMMON_FIELDS]; }

  /**
   * Keys of the optional fields (more: true) that wait behind "More options":
   * those without a value. A value from saved overrides or folder defaults
   * keeps its field in view, so nothing already set is ever tucked away.
   */
  function fieldsBehindMore(runtime, values = {}) {
    const hasValue = (field, value) => field.type === 'boolean' ? value === true : value !== undefined && value !== null && value !== '';
    return fieldsFor(runtime).filter(f => f.more && !f.hidden && !hasValue(f, values[f.key])).map(f => f.key);
  }

  function normalizeOverrides(runtime, input = {}) {
    if (!isObject(input)) throw new Error('Session settings must be an object');
    const fields = new Map(fieldsFor(runtime).map(f => [f.key, f]));
    const out = {};
    for (const [key, value] of Object.entries(input)) {
      const field = fields.get(key);
      if (!field) throw new Error(`Unsupported ${runtime} setting: ${key}`);
      if (field.type === 'boolean') {
        if (typeof value !== 'boolean') throw new Error(`${key} must be on or off`);
        out[key] = value;
      } else if (field.choices) {
        if (!field.choices.some(c => c.value === value)) throw new Error(`Invalid ${field.label}`);
        out[key] = value;
      } else {
        if (typeof value !== 'string') throw new Error(`${field.label} must be text`);
        if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)) throw new Error(`${field.label} contains unsafe characters`);
        if (field.type !== 'textarea' && /[\r\n]/.test(value)) throw new Error(`${field.label} must be a single line`);
        out[key] = field.type === 'textarea' ? value : value.trim();
      }
    }
    return out;
  }

  function normalizeByCli(input = {}) {
    if (!isObject(input)) throw new Error('Schedule settings must be an object');
    const out = {};
    for (const [runtime, values] of Object.entries(input)) {
      if (!/^[a-z][a-z0-9_-]*$/.test(runtime) || ['constructor', 'prototype', '__proto__'].includes(runtime)) throw new Error('Invalid CLI');
      out[runtime] = normalizeOverrides(runtime, values);
    }
    return out;
  }

  function resolveOptions(runtime, defaults = {}, overrides = {}) {
    const clean = normalizeOverrides(runtime, overrides);
    const out = {};
    for (const field of fieldsFor(runtime)) {
      let value = own(clean, field.key) ? clean[field.key] : defaults?.[field.key];
      // Null means a CLI's own default for selects/text, and off for toggles.
      if (value === undefined) value = field.default;
      if (value === null && field.type !== 'permission') value = field.type === 'boolean' ? false : '';
      out[field.key] = value;
    }
    return normalizeOverrides(runtime, out);
  }

  const api = { PERMISSION_MODES, CODEX_SANDBOX_MODES, CODEX_APPROVAL_POLICIES, CLAUDE_EFFORTS, CODEX_EFFORTS, FIELDS, COMMON_FIELDS,
    fieldsFor, fieldsBehindMore, normalizeOverrides, normalizeByCli, resolveOptions, own };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SessionConfig = api;
})(typeof window !== 'undefined' ? window : globalThis);
