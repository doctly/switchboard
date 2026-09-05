// --- Utility functions (shared across renderer modules) ---

/**
 * Shorten a project path for display: its last two segments.
 *
 * Splits on both separators. projectPath comes from a session's `cwd`, which on
 * Windows is backslash-separated — splitting on '/' alone finds no separator, so
 * every "short" label rendered the entire path.
 */
function shortProjectPath(projectPath) {
  if (!projectPath) return '';
  return projectPath.split(/[\\/]/).filter(Boolean).slice(-2).join('/');
}

/**
 * Permission modes offered for a session, in the order they're shown.
 *
 * `value` is passed verbatim to `claude --permission-mode`, so each one must
 * stay a member of that flag's choice list (as of CLI 2.1.220: acceptEdits,
 * auto, bypassPermissions, manual, dontAsk, plan). A `null` value means we omit
 * the flag entirely and let the CLI apply the user's own configured default.
 *
 * Shared by both session dialogs and the settings panel — the list used to be
 * copy-pasted in all three, so a new mode reached only whichever copy someone
 * remembered to edit.
 */
const PERMISSION_MODES = [
  { value: null, label: 'Default', desc: 'Prompt for all actions' },
  { value: 'auto', label: 'Auto', desc: 'Classifier allows routine work, stops for risky actions' },
  { value: 'acceptEdits', label: 'Accept Edits', desc: 'Auto-accept file edits, prompt for others' },
  { value: 'plan', label: 'Plan Mode', desc: 'Read-only exploration, no writes' },
  { value: 'dontAsk', label: "Don't Ask", desc: 'Auto-deny tools not explicitly allowed' },
  { value: 'bypassPermissions', label: 'Bypass', desc: 'Auto-accept all tool calls' },
];

// Codex's equivalents. Deliberately a separate list rather than a translation
// of PERMISSION_MODES: codex has a sandbox policy and an approval policy where
// Claude has one permission mode, and the values are passed to the CLI verbatim.
// Must stay in sync with the sets buildLaunchArgs validates against.
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

// Mirror Claude CLI's project-folder naming. Must stay in sync with
// encode-project-path.js (main process). Reverse-engineered from claude CLI 2.1.126.
function encodeProjectPath(projectPath) {
  const sanitized = projectPath.replace(/[^a-zA-Z0-9]/g, '-');
  if (sanitized.length <= 200) return sanitized;
  let h = 0;
  for (let i = 0; i < projectPath.length; i++) {
    h = (h << 5) - h + projectPath.charCodeAt(i) | 0;
  }
  return sanitized.slice(0, 200) + '-' + Math.abs(h).toString(36);
}

function cleanDisplayName(name) {
  if (!name) return name;
  const prefix = 'Implement the following plan:';
  if (name.startsWith(prefix)) name = name.slice(prefix.length).trim();
  // Strip XML/HTML-like tags (e.g. <command>, </message>, <system-reminder>)
  name = name.replace(/<\/?[a-zA-Z][a-zA-Z0-9_-]*(?:\s[^>]*)?\/?>/g, ' ');
  // Collapse multiple spaces and trim
  name = name.replace(/\s+/g, ' ').trim();
  return name;
}

function formatDate(date) {
  const now = new Date();
  const diff = now - date;
  const mins = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);

  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  if (hours < 24) return `${hours}h ago`;
  if (days < 7) return `${days}d ago`;
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function shellEscape(path) {
  return "'" + path.replace(/'/g, "'\\''") + "'";
}
