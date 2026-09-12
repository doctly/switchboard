const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fileURLToPath } = require('node:url');

const EDITOR_SCHEMES = new Set(['vscode:', 'vscode-insiders:', 'cursor:', 'windsurf:']);

function splitFileLocation(value) {
  const match = value.match(/(?::(\d+)(?::(\d+))?|#L(\d+)(?:C(\d+))?(?:-L?\d+(?:C\d+)?)?)$/i);
  if (!match) return { path: value };
  const line = Number(match[1] || match[3]);
  const column = Number(match[2] || match[4] || 1);
  if (!Number.isSafeInteger(line) || !Number.isSafeInteger(column) || line < 1 || column < 1) return { path: value };
  return { path: value.slice(0, match.index), line, column };
}

/** Parse only local files and known editor URIs; never send a URI to a shell. */
function parseTerminalFileReference(reference, { platform = process.platform, home = os.homedir() } = {}) {
  if (typeof reference !== 'string' || !reference || reference.length > 4096 || /[\x00-\x1f\x7f]/.test(reference)) return [];
  const paths = platform === 'win32' ? path.win32 : path.posix;
  let value = reference;
  let uriLocation = {};
  const scheme = value.match(/^([a-z][a-z\d+.-]*:)/i)?.[1].toLowerCase();
  // A drive letter is a path, not a URI scheme.
  if (scheme && !/^[a-z]:[/\\]/i.test(value)) {
    if (scheme !== 'file:' && !EDITOR_SCHEMES.has(scheme)) return [];
    let url;
    try { url = new URL(value); } catch { return []; }
    if (url.username || url.password || url.port) return [];
    uriLocation = splitFileLocation(url.hash).line ? splitFileLocation(url.hash) : {};
    if (url.search) return [];
    url.hash = '';
    try {
      if (scheme === 'file:') {
        if (!/^file:\/\/(?:localhost)?\//i.test(reference)) return [];
        if (url.hostname && url.hostname !== 'localhost') return [];
        value = fileURLToPath(url, { windows: platform === 'win32' });
      } else {
        if (url.hostname !== 'file') return [];
        value = decodeURIComponent(url.pathname);
        if (platform === 'win32') value = value.replace(/^\/([a-z]:[/\\])/i, '$1');
      }
    } catch { return []; }
  }
  if (/[\x00-\x1f\x7f]/.test(value) || /^[/\\]{2}/.test(value)) return [];
  if (value.startsWith('~/') || (platform === 'win32' && value.startsWith('~\\'))) value = paths.join(home, value.slice(2));
  const location = splitFileLocation(value);
  // Prefer an existing literal filename, e.g. "notes#L10", over interpreting
  // its suffix as a location. The second candidate handles actual citations.
  const candidates = [{ path: value }, ...(location.path !== value ? [location] : [])];
  return candidates.flatMap(candidate => {
    if (!candidate.path) return [];
    if (platform !== 'win32' && /^[a-z]:[/\\]/i.test(candidate.path)) return [];
    if (platform === 'win32' && /^[a-z]:[^/\\]/i.test(candidate.path)) return [];
    // A session's launch folder is not necessarily its current directory.
    // Require a full target; never guess where a relative filename belongs.
    if (!paths.isAbsolute(candidate.path)) return [];
    if (platform === 'win32' && !/^[a-z]:[/\\]/i.test(candidate.path)) return [];
    const filePath = paths.normalize(candidate.path);
    if (/^[/\\]{2}/.test(filePath)) return [];
    return [{ filePath, ...(candidate.line ? { line: candidate.line, column: candidate.column } : {}),
      ...(uriLocation.line ? { line: uriLocation.line, column: uriLocation.column } : {}) }];
  });
}

async function resolveTerminalFiles(references) {
  if (!Array.isArray(references) || references.length > 32) return [];
  return Promise.all(references.map(async reference => {
    for (const candidate of parseTerminalFileReference(reference)) {
      try {
        if ((await fs.promises.stat(candidate.filePath)).isFile()) return candidate;
      } catch {}
    }
    return null;
  }));
}

module.exports = { splitFileLocation, parseTerminalFileReference, resolveTerminalFiles };
