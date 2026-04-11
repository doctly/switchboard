const path = require('path');
const fs = require('fs');

// --- Cross-platform shell resolution ---
const isWindows = process.platform === 'win32';

// Discover available shell profiles on this system.
// Returns an array of { id, name, path, args? } objects.
function discoverShellProfiles() {
  const profiles = [];

  if (isWindows) {
    const { execSync } = require('child_process');

    // CMD
    const comspec = process.env.COMSPEC || 'C:\\WINDOWS\\system32\\cmd.exe';
    if (fs.existsSync(comspec)) {
      profiles.push({ id: 'cmd', name: 'Command Prompt', path: comspec });
    }

    // PowerShell 7+ (pwsh)
    const pwshCandidates = [
      path.join(process.env.ProgramFiles || 'C:\\Program Files', 'PowerShell', '7', 'pwsh.exe'),
      path.join(process.env.ProgramFiles || 'C:\\Program Files', 'PowerShell', '7-preview', 'pwsh.exe'),
    ];
    for (const p of pwshCandidates) {
      if (fs.existsSync(p)) {
        profiles.push({ id: 'pwsh', name: 'PowerShell 7', path: p });
        break;
      }
    }

    // Windows PowerShell 5.x
    const ps5 = path.join(process.env.SystemRoot || 'C:\\WINDOWS', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    if (fs.existsSync(ps5)) {
      profiles.push({ id: 'powershell', name: 'Windows PowerShell', path: ps5 });
    }

    // Git Bash
    const gitBashCandidates = [
      path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Git', 'bin', 'bash.exe'),
      path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Git', 'bin', 'bash.exe'),
      path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Git', 'bin', 'bash.exe'),
    ];
    for (const p of gitBashCandidates) {
      if (p && fs.existsSync(p)) {
        profiles.push({ id: 'git-bash', name: 'Git Bash', path: p });
        break;
      }
    }

    // MSYS2
    if (fs.existsSync('C:\\msys64\\usr\\bin\\bash.exe')) {
      profiles.push({ id: 'msys2', name: 'MSYS2', path: 'C:\\msys64\\usr\\bin\\bash.exe' });
    }

    // WSL distributions
    try {
      const raw = execSync('wsl.exe --list --quiet', { timeout: 5000, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
      const distros = raw.replace(/\0/g, '').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
      for (const distro of distros) {
        profiles.push({ id: 'wsl:' + distro, name: 'WSL — ' + distro, path: 'wsl.exe', args: ['-d', distro] });
      }
    } catch {}
  } else {
    // macOS / Linux: read /etc/shells for the canonical list
    const seen = new Set();
    const shellNames = {
      'zsh': 'Zsh', 'bash': 'Bash', 'sh': 'POSIX Shell',
      'fish': 'Fish', 'nu': 'Nushell', 'pwsh': 'PowerShell',
      'dash': 'Dash', 'ksh': 'Korn Shell', 'tcsh': 'tcsh', 'csh': 'C Shell',
    };
    try {
      const lines = fs.readFileSync('/etc/shells', 'utf8').split('\n')
        .map(l => l.trim())
        .filter(l => l && !l.startsWith('#'));
      for (const shellPath of lines) {
        if (!fs.existsSync(shellPath)) continue;
        const base = path.basename(shellPath);
        // Deduplicate by basename (e.g. /bin/bash and /usr/bin/bash)
        if (seen.has(base)) continue;
        seen.add(base);
        const name = shellNames[base] || base;
        profiles.push({ id: base, name, path: shellPath });
      }
    } catch {
      // Fallback if /etc/shells is unreadable
      for (const [id, name, p] of [
        ['zsh', 'Zsh', '/bin/zsh'],
        ['bash', 'Bash', '/bin/bash'],
        ['sh', 'POSIX Shell', '/bin/sh'],
      ]) {
        if (fs.existsSync(p)) {
          profiles.push({ id, name, path: p });
        }
      }
    }
  }

  return profiles;
}

// Cache profiles (discovered once on startup, refreshed via IPC if needed)
let _shellProfiles = null;
function getShellProfiles() {
  if (!_shellProfiles) _shellProfiles = discoverShellProfiles();
  return _shellProfiles;
}

function resolveShell(profileId) {
  // If a profile is selected, use it
  if (profileId && profileId !== 'auto') {
    const profiles = getShellProfiles();
    const profile = profiles.find(p => p.id === profileId);
    if (profile && (profile.path === 'wsl.exe' || fs.existsSync(profile.path))) {
      return profile;
    }
  }

  // Auto: original detection logic
  // 1. Respect explicit SHELL env (set by Git Bash, MSYS2, WSL, etc.)
  if (process.env.SHELL && fs.existsSync(process.env.SHELL)) {
    return { id: 'auto', name: 'Auto', path: process.env.SHELL };
  }

  if (isWindows) {
    // 2. Look for Git Bash in common locations
    const candidates = [
      path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Git', 'bin', 'bash.exe'),
      path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Git', 'bin', 'bash.exe'),
      path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Git', 'bin', 'bash.exe'),
      'C:\\msys64\\usr\\bin\\bash.exe',
    ];
    for (const c of candidates) {
      if (c && fs.existsSync(c)) return { id: 'auto', name: 'Auto', path: c };
    }
    // 3. Fall back to PowerShell / cmd
    return { id: 'auto', name: 'Auto', path: process.env.COMSPEC || 'powershell.exe' };
  }

  // Unix fallback chain
  for (const s of ['/bin/zsh', '/bin/bash', '/bin/sh']) {
    if (fs.existsSync(s)) return { id: 'auto', name: 'Auto', path: s };
  }
  return { id: 'auto', name: 'Auto', path: '/bin/sh' };
}

// Convert a Windows path to a WSL /mnt/ path
function windowsToWslPath(winPath) {
  if (!winPath) return winPath;
  // C:\Users\foo → /mnt/c/Users/foo
  const normalized = winPath.replace(/\\/g, '/');
  const match = normalized.match(/^([A-Za-z]):(\/.*)/);
  if (match) return '/mnt/' + match[1].toLowerCase() + match[2];
  return normalized;
}

function isWslShell(shellPath) {
  const base = path.basename(shellPath).toLowerCase();
  return base === 'wsl.exe' || base === 'wsl';
}

// Returns spawn args appropriate for the resolved shell
function shellArgs(shellPath, cmd, extraArgs) {
  const base = path.basename(shellPath).toLowerCase();
  const isBashLike = base.includes('bash') || base.includes('zsh') || base === 'sh';
  const isFish = base === 'fish';
  const isNushell = base === 'nu';

  // WSL: pass command via -- to the distribution shell
  // cwd is handled separately via --cd in the spawn call
  if (isWslShell(shellPath)) {
    if (cmd) return [...(extraArgs || []), '--', 'bash', '-l', '-i', '-c', cmd];
    return [...(extraArgs || []), '--', 'bash', '-l', '-i'];
  }

  if (cmd) {
    if (isBashLike) return ['-l', '-i', '-c', cmd];
    if (isFish) return ['-l', '-c', cmd];
    if (isNushell) return ['-l', '-c', cmd];
    if (base.includes('powershell') || base.includes('pwsh')) return ['-NoLogo', '-Command', cmd];
    return ['/C', cmd];
  }
  if (isBashLike) return ['-l', '-i'];
  if (isFish) return ['-l', '-i'];
  if (isNushell) return ['-l', '-i'];
  if (base.includes('powershell') || base.includes('pwsh')) return ['-NoLogo', '-NoExit'];
  return [];
}

module.exports = { discoverShellProfiles, getShellProfiles, resolveShell, isWindows, isWslShell, windowsToWslPath, shellArgs };
