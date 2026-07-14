const path = require('path');

/**
 * Remote session indexing (Phase 2).
 *
 * Pure helpers below are unit-tested without SSH. The impure orchestration
 * (syncRemoteHost) shells out over the existing ControlMaster connection and is
 * exercised manually; it requires child_process lazily so this module stays
 * import-safe for tests.
 */

/**
 * Parse the remote listing command output. One line per remote .jsonl:
 *   <jsonlPath>\t<mtimeEpochSeconds>\t<cwdRaw>
 * where cwdRaw is the raw grep match `"cwd":"..."` (or empty).
 * Returns [{ sessionId, path, folder, mtimeMs, modified, cwd }].
 */
function parseRemoteListing(text) {
  const out = [];
  if (!text) return out;
  for (const rawLine of text.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    if (!line.trim()) continue;
    const firstTab = line.indexOf('\t');
    if (firstTab === -1) continue;
    const secondTab = line.indexOf('\t', firstTab + 1);
    if (secondTab === -1) continue;
    const filePath = line.slice(0, firstTab);
    const mtimeStr = line.slice(firstTab + 1, secondTab);
    const cwdRaw = line.slice(secondTab + 1);
    const mtimeSec = Number(mtimeStr);
    if (!filePath || !Number.isFinite(mtimeSec)) continue;
    const cwdMatch = cwdRaw.match(/"cwd":"([^"]*)"/);
    const cwd = cwdMatch ? cwdMatch[1] : '';
    const mtimeMs = Math.round(mtimeSec * 1000);
    out.push({
      sessionId: path.basename(filePath, '.jsonl'),
      path: filePath,
      folder: path.basename(path.dirname(filePath)),
      mtimeMs,
      modified: new Date(mtimeMs).toISOString(),
      cwd,
    });
  }
  return out;
}

/**
 * Convert an absolute remote cwd into a display path relative to the remote home
 * ("~" or "~/sub"), or leave it absolute when it lives outside home. Used to derive
 * a remote project path per session so a whole host's sessions auto-group by dir.
 */
function cwdToDisplay(cwd, home) {
  if (!cwd) return '~';
  if (home && cwd === home) return '~';
  if (home && cwd.startsWith(home + '/')) return '~' + cwd.slice(home.length);
  return cwd;
}

/**
 * Compare a remote listing against already-cached rows for the same host.
 * cachedRows: [{ sessionId, modified }].
 * Returns { toFetch: [listing entries new or mtime-changed], toDelete: [sessionIds gone] }.
 */
function diffChangedSessions(listing, cachedRows) {
  const cached = new Map();
  for (const r of cachedRows) cached.set(r.sessionId, r.modified);
  const seen = new Set();
  const toFetch = [];
  for (const e of listing) {
    seen.add(e.sessionId);
    if (!cached.has(e.sessionId) || cached.get(e.sessionId) !== e.modified) {
      toFetch.push(e);
    }
  }
  const toDelete = [];
  for (const id of cached.keys()) {
    if (!seen.has(id)) toDelete.push(id);
  }
  return { toFetch, toDelete };
}

/**
 * Decode a length-framed multi-file stream produced by the remote fetch command:
 *   SWBF <byteLength> <path>\n<byteLength bytes>...
 * Framing is length-based, so file content containing the marker is safe.
 * Accepts a Buffer; returns [{ path, content }]. Incomplete trailing frames are dropped.
 */
function decodeFramedFiles(buf) {
  const files = [];
  if (!buf || buf.length === 0) return files;
  let off = 0;
  while (off < buf.length) {
    const nl = buf.indexOf(0x0a, off); // '\n'
    if (nl === -1) break;
    const header = buf.toString('utf8', off, nl);
    const m = header.match(/^SWBF (\d+) (.*)$/);
    if (!m) break;
    const size = parseInt(m[1], 10);
    const filePath = m[2];
    const start = nl + 1;
    const end = start + size;
    if (end > buf.length) break; // incomplete
    files.push({ path: filePath, content: buf.toString('utf8', start, end) });
    off = end;
  }
  return files;
}

// --- SSH command assembly (over the existing ControlMaster socket) ---

const { controlArgs, hostTargetArgs, remoteProjectPath } = require('./remote-hosts');
const { parseSessionContent } = require('./read-session-file');

function shellSingleQuote(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'";
}

// Remote command that lists every session .jsonl with its mtime and cwd, one per
// line: "<path>\t<mtimeEpoch>\t<cwdMatch>". stat -c (GNU) with a -f (BSD) fallback.
const LISTING_SCRIPT =
  'find "$HOME/.claude/projects" -maxdepth 2 -name \'*.jsonl\' -type f 2>/dev/null | ' +
  'while IFS= read -r f; do ' +
  'm=$(stat -c %Y "$f" 2>/dev/null || stat -f %m "$f" 2>/dev/null); ' +
  'c=$(grep -m1 -o \'"cwd":"[^"]*"\' "$f" 2>/dev/null); ' +
  'printf \'%s\\t%s\\t%s\\n\' "$f" "$m" "$c"; done';

// Remote command that streams the given files length-framed (see decodeFramedFiles).
function fetchScript(paths) {
  const list = paths.map(shellSingleQuote).join(' ');
  return `for f in ${list}; do ` +
    's=$(stat -c %s "$f" 2>/dev/null || stat -f %z "$f" 2>/dev/null); ' +
    '[ -n "$s" ] || continue; ' +
    'printf \'SWBF %s %s\\n\' "$s" "$f"; cat "$f"; done';
}

function sshCmdArgs(host, sock, remoteCmd) {
  const opts = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', ...controlArgs(sock)];
  return [...opts, ...hostTargetArgs(host), remoteCmd];
}

// ssh args to cat a single remote session transcript (live "View messages").
function remoteJsonlCatArgs(host, sock, folder, sessionId) {
  const p = '"$HOME/.claude/projects/"' + shellSingleQuote(folder) + '/' +
    shellSingleQuote(sessionId) + '.jsonl';
  return sshCmdArgs(host, sock, 'cat ' + p);
}

function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

// Capture a child process's stdout as a string or Buffer, rejecting on failure so
// callers never index against a half-open connection.
function spawnCapture(bin, args, mode) {
  const cp = require('child_process');
  return new Promise((resolve, reject) => {
    let proc;
    try { proc = cp.spawn(bin, args, { env: process.env }); }
    catch (e) { return reject(e); }
    const chunks = [];
    let errStr = '';
    const killer = setTimeout(() => { try { proc.kill(); } catch {} reject(new Error('ssh timed out')); }, 30000);
    proc.stdout.on('data', (d) => chunks.push(d));
    proc.stderr.on('data', (d) => { errStr += d.toString('utf8'); if (errStr.length > 4000) errStr = errStr.slice(-4000); });
    proc.on('error', (e) => { clearTimeout(killer); reject(e); });
    proc.on('close', (code) => {
      clearTimeout(killer);
      const buf = Buffer.concat(chunks);
      if (code !== 0) {
        return reject(Object.assign(new Error(`ssh exited ${code}: ${errStr.trim()}`), { code, stderr: errStr }));
      }
      resolve(mode === 'buffer' ? buf : buf.toString('utf8'));
    });
  });
}

function defaultRunText(host, sock) {
  return (kind) => {
    if (kind !== 'listing') return Promise.reject(new Error('unknown text kind: ' + kind));
    return spawnCapture('ssh', sshCmdArgs(host, sock, LISTING_SCRIPT), 'utf8');
  };
}

function defaultRunRaw(host, sock) {
  return (_kind, paths) => spawnCapture('ssh', sshCmdArgs(host, sock, fetchScript(paths)), 'buffer');
}

/**
 * Sync one connected host: list ALL its sessions → derive a remote project per
 * session from its cwd (so the whole host auto-groups by directory) → fetch
 * new/changed transcripts over SSH (no local copy) → upsert cache + FTS with
 * source=host.id → delete rows whose files vanished.
 * runText/runRaw are injectable for testing; production uses the SSH defaults.
 * Rejects (without touching the DB) if the connection isn't live.
 */
async function syncRemoteHost({ host, sock, db, runText, runRaw, hostLabel }) {
  runText = runText || defaultRunText(host, sock);
  runRaw = runRaw || defaultRunRaw(host, sock);
  const label = hostLabel || host.label || host.alias || host.id;

  const listing = parseRemoteListing(await runText('listing'));
  // Remote $HOME is the path prefix before /.claude/projects/ (same for every entry).
  const home = listing.length ? listing[0].path.split('/.claude/projects/')[0] : '';
  const assigned = listing
    .filter((e) => e.cwd)
    .map((e) => ({ ...e, projectPath: remoteProjectPath(label, cwdToDisplay(e.cwd, home)) }));

  const cached = db.getCachedBySource(host.id);
  const { toFetch, toDelete } = diffChangedSessions(assigned, cached);

  const sessions = [];
  for (const group of chunk(toFetch, 40)) {
    const buf = await runRaw('fetch', group.map((e) => e.path));
    const files = decodeFramedFiles(Buffer.isBuffer(buf) ? buf : Buffer.from(buf));
    for (const file of files) {
      const entry = group.find((e) => e.path === file.path);
      if (!entry) continue;
      const s = parseSessionContent(file.content, {
        sessionId: entry.sessionId, folder: entry.folder,
        projectPath: entry.projectPath, modified: entry.modified,
      });
      if (s) { s.source = host.id; sessions.push(s); }
    }
  }

  if (sessions.length) {
    db.upsertCachedSessions(sessions);
    const entries = sessions.map((s) => {
      const name = (db.getMeta && db.getMeta(s.sessionId)?.name) || s.customTitle || s.aiTitle || '';
      return {
        id: s.sessionId, type: 'session', folder: s.folder, source: host.id,
        title: (name ? name + ' ' : '') + s.summary, body: s.textContent,
      };
    });
    db.upsertSearchEntries(entries);
    if (db.setName) for (const s of sessions) if (s.customTitle) db.setName(s.sessionId, s.customTitle);
  }
  for (const id of toDelete) {
    db.deleteCachedSession(id);
    db.deleteSearchSession(id);
  }
  return { ok: true, indexed: sessions.length, deleted: toDelete.length };
}

/**
 * Live "View messages" for a remote session: cat the transcript over the shared
 * SSH connection (no local copy) and parse it into entries. Rejects if the master
 * is not live so the caller can prompt the user to Connect.
 */
async function fetchRemoteSessionEntries({ host, sock, folder, sessionId, runCat }) {
  const run = runCat || ((args) => spawnCapture('ssh', args, 'utf8'));
  const out = await run(remoteJsonlCatArgs(host, sock, folder, sessionId));
  const entries = [];
  for (const line of String(out).split('\n')) {
    if (!line.trim()) continue;
    try { entries.push(JSON.parse(line)); } catch {}
  }
  return entries;
}

module.exports = {
  parseRemoteListing,
  cwdToDisplay,
  diffChangedSessions,
  decodeFramedFiles,
  syncRemoteHost,
  fetchRemoteSessionEntries,
  // SSH command builders (used by main.js wiring / View messages)
  LISTING_SCRIPT,
  fetchScript,
  sshCmdArgs,
  remoteJsonlCatArgs,
  shellSingleQuote,
};
