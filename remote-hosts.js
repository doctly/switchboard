// Remote SSH host model for Switchboard (Phase 1).
//
// Turns ~/.ssh/config entries and user-defined "manual" hosts into SSH shell
// profiles that the terminal spawner (main.js) can hand to node-pty, and
// assembles the command that runs on the remote host. Pure functions here are
// unit-tested; the fs-backed helpers are thin wrappers over them.
const os = require('os');
const path = require('path');
const fs = require('fs');

// Single-quote a string for a POSIX shell, escaping embedded single quotes.
function sshSingleQuote(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'";
}

// Parse an ~/.ssh/config document into host entries.
// Only top-level `Host` blocks are considered; wildcard/negated aliases and
// `Match` blocks are ignored. `Include` is not followed (Phase 1 limitation).
function parseSshConfig(text) {
  const hosts = [];
  const seenAliases = new Set();
  let current = null;
  const flush = () => {
    if (!current) return;
    for (const alias of current.aliases) {
      if (alias.includes('*') || alias.includes('?') || alias.startsWith('!')) continue;
      if (seenAliases.has(alias)) continue; // first occurrence wins (ssh's own semantics)
      seenAliases.add(alias);
      hosts.push({
        id: 'config:' + alias,
        label: alias,
        alias,
        hostName: current.hostName || alias,
        user: current.user,
        port: current.port,
        source: 'config',
      });
    }
    current = null;
  };

  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;
    const m = line.match(/^(\S+)[\s=]+(.+)$/);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const value = m[2].trim();
    if (key === 'host') {
      flush();
      current = { aliases: value.split(/\s+/).filter(Boolean), hostName: undefined, user: undefined, port: undefined };
    } else if (key === 'match') {
      flush(); // ignore Match blocks
    } else if (current) {
      if (key === 'hostname') current.hostName = value;
      else if (key === 'user') current.user = value;
      else if (key === 'port') current.port = parseInt(value, 10);
    }
  }
  flush();
  return hosts;
}

// Quote a remote directory for use in `cd <dir>`, expanding a leading ~ to
// $HOME so the remote shell resolves it (single quotes would suppress it).
function quoteRemoteDir(dir) {
  if (dir === '~') return '$HOME';
  if (dir.startsWith('~/')) return '$HOME/' + sshSingleQuote(dir.slice(2));
  return sshSingleQuote(dir);
}

// Build the command executed on the remote host.
//   mode 'claude': cd <dir> && exec <innerCmd>   (cd failure aborts — don't run in the wrong place)
//   mode 'shell' : cd <dir> 2>/dev/null; exec login-shell   (cd is best-effort)
// A home/empty dir needs no cd (a login shell already starts in $HOME).
function buildRemoteCommand(mode, remoteDir, innerCmd, preExec) {
  const hasDir = remoteDir && remoteDir !== '~' && String(remoteDir).trim() !== '';
  const cd = hasDir ? 'cd ' + quoteRemoteDir(remoteDir) : '';
  if (mode === 'shell') {
    const shellExec = 'exec "${SHELL:-bash}" -l';
    return cd ? cd + ' 2>/dev/null; ' + shellExec : shellExec;
  }
  // Optional preExec runs after cd, before exec (Phase 3 uses it to write the IDE
  // lock file so $PWD is the project dir). Chained with && so a failure aborts.
  const pre = preExec && String(preExec).trim() ? String(preExec).trim() : '';
  const parts = [cd, pre, 'exec ' + innerCmd].filter(Boolean);
  return parts.join(' && ');
}

// The ssh options+target for a host, WITHOUT the -t PTY flag or -o test options.
// Options must precede the target: ssh stops option parsing at the hostname.
// Config hosts resolve everything (key, options, algorithms) from ~/.ssh/config,
// so we only pass the alias. Manual hosts carry their own identity file and extra
// -o options (e.g. legacy HostKeyAlgorithms=+ssh-rsa) inline.
function hostTargetArgs(host) {
  if (host.source === 'config') return [host.alias];
  const args = [];
  for (const opt of (host.options || [])) {
    if (opt && String(opt).trim()) args.push('-o', String(opt).trim());
  }
  if (host.identityFile && String(host.identityFile).trim()) args.push('-i', String(host.identityFile).trim());
  const port = host.port ? Number(host.port) : undefined;
  if (port && port !== 22) args.push('-p', String(port));
  args.push(host.user ? host.user + '@' + host.host : host.host);
  return args;
}

// Full ssh args for an interactive session (forces a PTY with -t).
function sshArgsForHost(host) {
  return ['-t', ...hostTargetArgs(host)];
}

// A shell profile (as produced by shell-profiles.js) that spawns ssh.
function buildSshProfile(host) {
  const label = host.label || host.alias || host.host;
  return {
    id: 'ssh:' + host.id,
    name: 'SSH — ' + label,
    path: 'ssh',
    args: sshArgsForHost(host),
    remote: true,
    remoteHost: host,
  };
}

// ssh args for a non-interactive connectivity probe. BatchMode=yes ensures we
// never block on a password prompt (key/agent auth only), and a short timeout
// surfaces unreachable hosts quickly.
function testConnectionArgs(host) {
  return ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', ...hostTargetArgs(host), 'true'];
}

// Stable synthetic project path for a remote project / session, so a persisted
// remote project and the live sessions launched into it group together in the
// sidebar. Must be produced identically wherever a remote path is formed.
function remoteProjectPath(hostLabel, remotePath) {
  return 'ssh://' + hostLabel + '/' + (remotePath && String(remotePath).trim() ? remotePath : '~');
}

// Inverse of remoteProjectPath: parse "ssh://<label>/<remotePath>" back into its
// parts. Returns null for non-remote paths.
function parseRemoteProjectPath(projectPath) {
  if (typeof projectPath !== 'string' || !projectPath.startsWith('ssh://')) return null;
  const rest = projectPath.slice('ssh://'.length);
  const i = rest.indexOf('/');
  if (i === -1) return { hostLabel: rest, remotePath: '~' };
  return { hostLabel: rest.slice(0, i), remotePath: rest.slice(i + 1) || '~' };
}

// Classify a non-interactive ssh probe (see testConnectionArgs). BatchMode never
// prompts, so a password-auth host "fails" — but its failure text tells us the
// host is actually reachable and simply needs interactive auth on connect.
function classifyConnResult(exitCode, output) {
  const out = String(output || '');
  if (exitCode === 0) return { status: 'ok', reachable: true, message: 'Reachable (passwordless key/agent auth works).' };
  if (/permission denied|password:|publickey|authentication failed|too many authentication/i.test(out)) {
    return { status: 'auth', reachable: true, message: 'Reachable — will prompt for password/key auth on connect.' };
  }
  if (/host key verification failed|authenticity of host|fingerprint|known_hosts/i.test(out)) {
    return { status: 'hostkey', reachable: true, message: 'Reachable — first connection needs host-key confirmation (accept it when you launch a session).' };
  }
  if (/connection refused|could not resolve|name or service not known|no route to host|network is unreachable|operation timed out|connection timed out|timed out|connection closed/i.test(out)) {
    return { status: 'unreachable', reachable: false, message: 'Unreachable: ' + (out.split('\n').filter(Boolean).slice(-1)[0] || 'no response') };
  }
  return { status: 'unknown', reachable: false, message: out.split('\n').filter(Boolean).slice(-1)[0] || 'Unknown result' };
}

// SSH connection-multiplexing options. A shared control socket per host lets the
// directory browser (and repeated ops) reuse one authenticated connection, so you
// only authenticate once per host and subsequent listings are instant.
function controlArgs(socketPath) {
  return ['-o', 'ControlMaster=auto', '-o', 'ControlPath=' + socketPath, '-o', 'ControlPersist=600'];
}

// Short, stable, length-bounded control-socket path for a host (unix socket paths
// are capped ~104 bytes, so we hash the id rather than embed it).
function controlSocketPath(baseDir, hostId) {
  let h = 5381;
  const s = String(hostId);
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return baseDir.replace(/\/$/, '') + '/swb-' + Math.abs(h).toString(36) + '.sock';
}

// Parse `ls -1Ap` output into the list of subdirectory names (lines the shell
// marked with a trailing slash), stripped and sorted.
function parseLsDirs(output) {
  const dirs = [];
  for (const raw of String(output || '').split(/\r?\n/)) {
    const line = raw.replace(/\r$/, '');
    if (line.endsWith('/')) {
      const name = line.slice(0, -1);
      if (name && name !== '.' && name !== '..') dirs.push(name);
    }
  }
  return dirs.sort();
}

// ssh args to list directories at `path` on a host over the control socket.
// BatchMode: never blocks on a prompt — if the connection isn't already
// authenticated (no live master, no key auth) it fails fast and the caller
// reports "needs auth" instead of hanging.
function browseArgs(host, socketPath, path) {
  const opts = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', ...controlArgs(socketPath)];
  const cmd = 'ls -1Ap -- ' + quoteRemoteDir(path);
  return [...opts, ...hostTargetArgs(host), cmd];
}

// --- fs-backed helpers (main process) ---

function defaultSshConfigPath() {
  return path.join(os.homedir(), '.ssh', 'config');
}

function readSshConfigHosts(configPath) {
  try {
    const p = configPath || defaultSshConfigPath();
    if (!fs.existsSync(p)) return [];
    return parseSshConfig(fs.readFileSync(p, 'utf8'));
  } catch {
    return [];
  }
}

function normalizeManualHost(h) {
  const host = (h.host || '').trim();
  const port = h.port ? Number(h.port) : undefined;
  const user = (h.user || '').trim() || undefined;
  const identityFile = (h.identityFile || '').trim() || undefined;
  // options may arrive as an array or a free-form string (newline/comma separated)
  let options = [];
  if (Array.isArray(h.options)) {
    options = h.options.map(o => String(o).trim()).filter(Boolean);
  } else if (typeof h.options === 'string') {
    options = h.options.split(/[\n,]+/).map(o => o.trim()).filter(Boolean);
  }
  const id = h.id || ('manual:' + (user ? user + '@' : '') + host + (port ? ':' + port : ''));
  return { id, label: (h.label || '').trim() || host || id, host, user, port, identityFile, options, source: 'manual' };
}

// Render a host as an ~/.ssh/config `Host` block. ssh config uses "Key Value"
// (space-separated), so options given as "Key=Value" are converted.
function buildSshConfigEntry(host) {
  const lines = ['Host ' + (host.label || host.alias || host.host)];
  if (host.host) lines.push('    HostName ' + host.host);
  if (host.user) lines.push('    User ' + host.user);
  const port = host.port ? Number(host.port) : undefined;
  if (port && port !== 22) lines.push('    Port ' + port);
  if (host.identityFile) lines.push('    IdentityFile ' + host.identityFile);
  for (const opt of (host.options || [])) {
    const s = String(opt).trim();
    if (!s) continue;
    const eq = s.indexOf('=');
    lines.push('    ' + (eq >= 0 ? s.slice(0, eq) + ' ' + s.slice(eq + 1) : s));
  }
  return lines.join('\n');
}

// Merge config-derived hosts with user-defined manual hosts (from settings).
function loadRemoteHosts(manualHosts, configPath) {
  const config = readSshConfigHosts(configPath);
  const manual = (manualHosts || []).filter(h => h && h.host).map(normalizeManualHost);
  return [...config, ...manual];
}

function findRemoteHost(id, manualHosts, configPath) {
  return loadRemoteHosts(manualHosts, configPath).find(h => h.id === id) || null;
}

module.exports = {
  parseSshConfig,
  quoteRemoteDir,
  buildRemoteCommand,
  hostTargetArgs,
  sshArgsForHost,
  buildSshProfile,
  testConnectionArgs,
  remoteProjectPath,
  parseRemoteProjectPath,
  classifyConnResult,
  controlArgs,
  controlSocketPath,
  parseLsDirs,
  browseArgs,
  buildSshConfigEntry,
  readSshConfigHosts,
  normalizeManualHost,
  loadRemoteHosts,
  findRemoteHost,
  defaultSshConfigPath,
};
