// --- Utility functions (shared across renderer modules) ---

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

// Project avatar: deterministic color + initials from project path (like JetBrains)
const PROJECT_AVATAR_COLORS = [
  '#3B82F6', '#8B5CF6', '#EC4899', '#F59E0B', '#10B981',
  '#F97316', '#06B6D4', '#EF4444', '#84CC16', '#6366F1',
  '#14B8A6', '#F43F5E', '#A855F7', '#0EA5E9', '#22C55E',
];

function getProjectAvatar(projectPath) {
  const name = (projectPath || '').split('/').filter(Boolean).pop() || '';
  const parts = name
    .replace(/[-_.]/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .split(/\s+/).filter(Boolean);
  const initials = parts.length >= 2
    ? (parts[0][0] + parts[1][0]).toUpperCase()
    : name.slice(0, 2).toUpperCase() || '?';
  let h = 5381;
  for (let i = 0; i < name.length; i++) h = ((h << 5) + h) ^ name.charCodeAt(i);
  return { initials, color: PROJECT_AVATAR_COLORS[Math.abs(h) % PROJECT_AVATAR_COLORS.length] };
}

/**
 * Creates a .project-group section — the same collapsible group used in the
 * sessions sidebar. Returns { group, header, list } so callers can append
 * items into `list` and inspect/augment `header`.
 */
function makeGroup(titleText, btnLabel, onBtnClick) {
  const group = document.createElement('div');
  group.className = 'project-group';

  const header = document.createElement('div');
  header.className = 'project-header';

  const name = document.createElement('span');
  name.className = 'project-name';
  name.textContent = titleText;
  header.appendChild(name);

  if (btnLabel) {
    const btn = document.createElement('button');
    btn.className = 'project-new-btn';
    btn.dataset.tooltip = btnLabel;
    btn.innerHTML = '<svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><line x1="6" y1="1" x2="6" y2="11"/><line x1="1" y1="6" x2="11" y2="6"/></svg>';
    btn.addEventListener('click', onBtnClick);
    header.appendChild(btn);
  }

  const list = document.createElement('div');
  list.className = 'project-sessions';

  group.appendChild(header);
  group.appendChild(list);
  return { group, header, list };
}

/**
 * Shared list-item builder — produces the session-item/session-row/session-info
 * DOM structure used consistently across Sessions, Plans, Memory, Projects, Accounts.
 *
 * @param {object} opts
 * @param {string}      opts.title       - Primary text (.session-summary)
 * @param {string}      [opts.subtitle]  - Secondary text (.session-subtitle), omitted if null
 * @param {string}      [opts.meta]      - Tertiary text (.session-meta), omitted if null
 * @param {Element}     [opts.leading]   - Element prepended before .session-info (icon, avatar, dot)
 * @param {Element}     [opts.trailing]  - Element appended after .session-info (action buttons)
 * @param {string[]}    [opts.classes]   - Extra classes on the outer item div
 * @param {Element}     [opts.children]  - Element appended below session-row (usage bar, env info, etc.)
 * @returns {{ item, row, infoEl, titleEl, subtitleEl, metaEl }}
 */
function buildListItem({ title, subtitle, meta, leading, trailing, classes = [], children }) {
  const item = document.createElement('div');
  item.className = ['session-item', ...classes].filter(Boolean).join(' ');

  const row = document.createElement('div');
  row.className = 'session-row';

  if (leading) row.appendChild(leading);

  const infoEl = document.createElement('div');
  infoEl.className = 'session-info';

  const titleEl = document.createElement('div');
  titleEl.className = 'session-summary';
  titleEl.textContent = title ?? '';
  infoEl.appendChild(titleEl);

  let subtitleEl = null;
  if (subtitle != null) {
    subtitleEl = document.createElement('div');
    subtitleEl.className = 'session-subtitle';
    subtitleEl.textContent = subtitle;
    infoEl.appendChild(subtitleEl);
  }

  let metaEl = null;
  if (meta != null) {
    metaEl = document.createElement('div');
    metaEl.className = 'session-meta';
    metaEl.textContent = meta;
    infoEl.appendChild(metaEl);
  }

  row.appendChild(infoEl);
  if (trailing) row.appendChild(trailing);
  if (children) row.appendChild(children);  // inside row → covered by active highlight
  item.appendChild(row);

  return { item, row, infoEl, titleEl, subtitleEl, metaEl };
}

function parseContainerUptime(status) {
  if (!status) return '';
  const m = status.match(/up (.+)/i);
  if (!m) return '';
  return m[1].trim()
    .replace(/About /, '')
    .replace(/(\d+) hours?/, '$1h')
    .replace(/(\d+) minutes?/, '$1m')
    .replace(/(\d+) seconds?/, '$1s')
    .replace(/(\d+) days?/, '$1d')
    .replace(/(\d+) weeks?/, '$1w')
    .replace(/(\d+) months?/, '$1mo');
}
