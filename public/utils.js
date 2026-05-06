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

// Defence-in-depth: any innerHTML assignment whose source is session data
// from disk (JSONL bodies, project paths, settings values, MCP tool params)
// MUST go through this helper. It runs DOMPurify with the html profile,
// stripping <script>, event handlers, javascript: URLs, SVG <script>, etc.
//
// Static strings authored in this codebase don't need it, but routing them
// through is harmless. When in doubt, use this rather than raw innerHTML.
function safeSetHtml(el, html) {
  if (!el) return;
  const src = String(html ?? '');
  if (window.DOMPurify) {
    el.innerHTML = window.DOMPurify.sanitize(src, { USE_PROFILES: { html: true } });
  } else {
    // DOMPurify is bundled with codemirror-bundle.js; if for some reason it
    // hasn't loaded, fall back to a fully-escaped textContent so we never
    // accidentally render unsanitized HTML.
    el.textContent = src;
  }
}
