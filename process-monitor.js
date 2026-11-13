// How much memory each live session (and each running task) costs.
//
// A session is a PTY whose pid is a shell or the CLI itself; what it really
// costs is that process plus everything under it: the CLI, its MCP servers,
// the dev servers and builds it starts. So each owner is measured as the sum
// over its whole process tree, from one process-table snapshot per refresh.

const { execFile } = require('child_process');
const path = require('path');

// Interpreters whose own name says little: "node" is more useful as "node claude".
const SCRIPT_HOSTS = new Set(['node', 'bun', 'deno', 'python', 'python3', 'ruby', 'perl', 'php', 'java']);
// Flags after which an interpreter runs inline code, not a file.
const INLINE_CODE_FLAGS = new Set(['-e', '--eval', '-p', '--print', '-c']);

/**
 * The table `ps -A -o pid=,ppid=,rss=,pcpu=,stat=,comm=` prints, as pid → process.
 * rss is in KiB; the command name is last because it may contain spaces.
 * Zombies (state Z) have already exited and hold no memory, so they are left out.
 */
function parsePsTable(stdout) {
  const table = new Map();
  for (const line of String(stdout || '').split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+([\d.,]+)\s+(\S+)\s+(.+?)\s*$/.exec(line);
    if (!match || match[5].startsWith('Z')) continue;
    const pid = Number(match[1]);
    table.set(pid, {
      pid,
      ppid: Number(match[2]),
      rssBytes: Number(match[3]) * 1024,
      cpu: Number(match[4].replace(',', '.')) || 0,
      name: path.basename(match[6]),
    });
  }
  return table;
}

/** The tab-separated table the Windows query prints: pid, ppid, working set in bytes, name. */
function parseWindowsTable(stdout) {
  const table = new Map();
  for (const line of String(stdout || '').split(/\r?\n/)) {
    const [pid, ppid, rss, ...name] = line.split('\t');
    if (!/^\d+$/.test(pid || '') || !/^\d+$/.test(ppid || '')) continue;
    table.set(Number(pid), {
      pid: Number(pid),
      ppid: Number(ppid),
      rssBytes: Number(rss) || 0,
      cpu: null,
      name: name.join('\t').trim(),
    });
  }
  return table;
}

/** `ps -o pid=,args=` output, as pid → full command line. */
function parseCommandLines(stdout) {
  const lines = new Map();
  for (const line of String(stdout || '').split('\n')) {
    const match = /^\s*(\d+)\s+(.*?)\s*$/.exec(line);
    if (match) lines.set(Number(match[1]), match[2]);
  }
  return lines;
}

/**
 * The process at `rootPid` and every descendant, root first, each with its
 * depth below the root. Empty when the root is gone.
 */
function collectTree(table, rootPid) {
  if (!rootPid || !table.has(rootPid)) return [];
  const children = new Map();
  for (const proc of table.values()) {
    if (proc.pid === proc.ppid) continue;
    if (!children.has(proc.ppid)) children.set(proc.ppid, []);
    children.get(proc.ppid).push(proc);
  }
  const out = [];
  const seen = new Set();
  const visit = (proc, depth) => {
    if (seen.has(proc.pid)) return;
    seen.add(proc.pid);
    out.push({ ...proc, depth });
    const kids = (children.get(proc.pid) || []).slice().sort((a, b) => b.rssBytes - a.rssBytes);
    for (const kid of kids) visit(kid, depth + 1);
  };
  visit(table.get(rootPid), 0);
  return out;
}

/** "node" alone hides which program it runs; name the script too when there is one. */
function friendlyName(name, commandLine) {
  const base = String(name || '').replace(/\.exe$/i, '');
  if (!SCRIPT_HOSTS.has(base.toLowerCase()) || !commandLine) return name || '';
  // The first argument that looks like a file, skipping flags; inline code (-e, -c) has none.
  for (const arg of String(commandLine).split(/\s+/).slice(1)) {
    if (INLINE_CODE_FLAGS.has(arg)) return name;
    if (!arg || arg.startsWith('-')) continue;
    if (/[/.]/.test(arg) || /^[A-Za-z]:\\/.test(arg)) return `${base} ${path.win32.basename(arg)}`;
  }
  return name;
}

/** Total memory, CPU and process count of one tree. */
function summarizeTree(procs) {
  let rssBytes = 0;
  let cpu = 0;
  let hasCpu = false;
  for (const proc of procs) {
    rssBytes += proc.rssBytes || 0;
    if (typeof proc.cpu === 'number') { cpu += proc.cpu; hasCpu = true; }
  }
  return { rssBytes, cpu: hasCpu ? Math.round(cpu * 10) / 10 : null, processCount: procs.length };
}

/** Deepest first, so nothing gets a chance to respawn or be reparented midway. */
function killOrder(procs) {
  return procs.slice().sort((a, b) => b.depth - a.depth);
}

function run(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { maxBuffer: 16 * 1024 * 1024, timeout: 10000, windowsHide: true, ...options }, (err, stdout) => {
      if (err) { err.stdout = stdout; reject(err); } else resolve(stdout);
    });
  });
}

/**
 * @param {object} [options]
 * @param {string} [options.platform]  process.platform by default
 * @param {Function} [options.exec]    (file, args, options) → Promise<stdout>, for tests
 * @param {Function} [options.kill]    (pid, signal) → void, for tests
 * @param {Function} [options.sleep]   ms → Promise, for tests
 */
function createProcessMonitor(options = {}) {
  const platform = options.platform || process.platform;
  const exec = options.exec || run;
  const kill = options.kill || ((pid, signal) => process.kill(pid, signal));
  const sleep = options.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)));
  // Numbers printed the C way, whatever the user's locale.
  const env = { ...process.env, LC_ALL: 'C' };

  async function snapshot() {
    if (platform === 'win32') {
      const script = 'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId)`t$($_.ParentProcessId)`t$($_.WorkingSetSize)`t$($_.Name)" }';
      return parseWindowsTable(await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script]));
    }
    return parsePsTable(await exec('ps', ['-A', '-o', 'pid=,ppid=,rss=,pcpu=,stat=,comm='], { env }));
  }

  /** Full command lines, only for the processes on screen. Best effort. */
  async function commandLines(pids) {
    if (!pids.length) return new Map();
    if (platform === 'win32') {
      const filter = pids.map(pid => `ProcessId=${Number(pid)}`).join(' OR ');
      const script = `Get-CimInstance Win32_Process -Filter "${filter}" | ForEach-Object { "$($_.ProcessId) $($_.CommandLine)" }`;
      try { return parseCommandLines(await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script])); } catch { return new Map(); }
    }
    try {
      return parseCommandLines(await exec('ps', ['-o', 'pid=,args=', '-p', pids.map(Number).join(',')], { env }));
    } catch (err) {
      // ps exits 1 when one of the pids ended in between, but still prints the rest.
      return parseCommandLines(err?.stdout || '');
    }
  }

  /**
   * Measure each owner ({ pid, ...anything }) as the sum over its process tree.
   * Owners come back with rssBytes, cpu, processCount and their processes,
   * heaviest first. An owner whose pid is unknown or gone measures zero.
   */
  async function measure(owners) {
    const table = await snapshot();
    const measured = owners.map(owner => {
      const procs = collectTree(table, owner.pid);
      return { ...owner, ...summarizeTree(procs), processes: procs, found: procs.length > 0 };
    });
    const pids = measured.flatMap(owner => owner.processes.map(proc => proc.pid));
    const lines = await commandLines(pids);
    for (const owner of measured) {
      for (const proc of owner.processes) {
        proc.command = lines.get(proc.pid) || null;
        proc.label = friendlyName(proc.name, proc.command);
      }
    }
    return measured.sort((a, b) => b.rssBytes - a.rssBytes);
  }

  /**
   * Signal one process, but only one that is still under `rootPid` right now:
   * a pid from an older snapshot may since have been reused by anything.
   */
  async function killInTree(rootPid, pid, signal = 'SIGTERM') {
    const tree = collectTree(await snapshot(), rootPid);
    if (!tree.some(proc => proc.pid === pid)) return { ok: false, error: 'That process is no longer part of this session' };
    try {
      kill(pid, signal);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  /** SIGKILL the whole tree under `rootPid`, root included. */
  async function killTree(rootPid) {
    const tree = collectTree(await snapshot(), rootPid);
    if (!tree.length) return { ok: false, error: 'The process has already ended' };
    let killed = 0;
    for (const proc of killOrder(tree)) {
      try { kill(proc.pid, 'SIGKILL'); killed++; } catch {}
    }
    return { ok: true, killed };
  }

  /**
   * Stop an owner and make sure nothing of it is left behind. `stop` is its
   * own way out (the PTY hangup, the task stop); a child that ignores the
   * hangup, or runs in the background, would otherwise outlive the session as
   * an orphan nobody sees. So whatever of the tree taken before the stop is
   * still there after `graceMs` gets SIGTERM, and after `termMs` more SIGKILL.
   * A survivor must still carry its name, so a reused pid is never hit.
   */
  async function stopTree(rootPid, stop, { graceMs = 2500, termMs = 1500 } = {}) {
    const tree = collectTree(await snapshot(), rootPid);
    await stop();
    if (!tree.length) return { ok: true, terminated: 0, killed: 0 };
    const survivors = async () => {
      const now = await snapshot();
      return tree.filter(proc => now.get(proc.pid)?.name === proc.name);
    };
    await sleep(graceMs);
    let left = await survivors();
    for (const proc of killOrder(left)) { try { kill(proc.pid, 'SIGTERM'); } catch {} }
    const terminated = left.length;
    if (!left.length) return { ok: true, terminated: 0, killed: 0 };
    await sleep(termMs);
    left = await survivors();
    for (const proc of killOrder(left)) { try { kill(proc.pid, 'SIGKILL'); } catch {} }
    return { ok: true, terminated, killed: left.length };
  }

  return { snapshot, measure, killInTree, killTree, stopTree };
}

module.exports = {
  createProcessMonitor,
  parsePsTable,
  parseWindowsTable,
  parseCommandLines,
  collectTree,
  friendlyName,
  summarizeTree,
  killOrder,
};
