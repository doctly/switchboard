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
  const FIELDS = {
    claude: [
      { key: 'permissionMode', label: 'Permission Mode', type: 'permission', default: null, choices: PERMISSION_MODES },
      { key: 'dangerouslySkipPermissions', type: 'boolean', default: false, hidden: true },
      { key: 'allowedTools', label: 'Allowed Tools', type: 'text', default: '', wide: true, description: 'Tools allowed without a permission prompt (comma-separated)' },
      { key: 'appendSystemPrompt', label: 'Additional System Prompt', type: 'textarea', default: '', wide: true, description: 'Instructions appended to Claude’s system prompt' },
      { key: 'worktree', label: 'Worktree', type: 'boolean', default: false, description: 'Run each new session in an isolated git worktree' },
      { key: 'worktreeName', label: 'Worktree Name', type: 'text', default: '', placeholder: 'name (optional)' },
      { key: 'chrome', label: 'Chrome', type: 'boolean', default: false, description: 'Enable Chrome browser automation' },
      { key: 'mcpEmulation', type: 'boolean', default: true, hidden: true },
    ],
    codex: [
      { key: 'codexSandbox', label: 'Sandbox', type: 'select', default: '', choices: CODEX_SANDBOX_MODES, description: 'What Codex is allowed to touch' },
      { key: 'codexApproval', label: 'Approval', type: 'select', default: '', choices: CODEX_APPROVAL_POLICIES, description: 'When Codex asks before running a command' },
      { key: 'codexModel', label: 'Model', type: 'text', default: '', placeholder: 'default', description: "Blank uses Codex's default" },
      { key: 'dangerouslySkipPermissions', label: 'Bypass Approvals and Sandbox', type: 'boolean', default: false, description: 'Disables permission prompts and sandbox restrictions' },
    ],
  };
  const COMMON_FIELDS = [
    { key: 'preLaunchCmd', label: 'Pre-launch Command', type: 'text', default: '', wide: true, placeholder: 'e.g. aws-vault exec profile --', description: 'Prepended to the CLI command' },
    { key: 'addDirs', label: 'Additional Directories', type: 'text', default: '', wide: true, placeholder: '/path/to/dir1, /path/to/dir2', description: 'Extra directories (comma-separated). Project attachments are included automatically.' },
  ];
  const own = (o, key) => Object.prototype.hasOwnProperty.call(o || {}, key);
  const isObject = value => !!value && typeof value === 'object' && !Array.isArray(value);
  function fieldsFor(runtime) { return [...(FIELDS[runtime] || []), ...COMMON_FIELDS]; }

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

  const api = { PERMISSION_MODES, CODEX_SANDBOX_MODES, CODEX_APPROVAL_POLICIES, FIELDS, COMMON_FIELDS,
    fieldsFor, normalizeOverrides, normalizeByCli, resolveOptions, own };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SessionConfig = api;
})(typeof window !== 'undefined' ? window : globalThis);
