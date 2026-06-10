const path = require('path');

const UUID_RE = /^[0-9a-fA-F-]{8,64}$/;
const WORKTREE_RE = /^[A-Za-z0-9_.\-\/]{1,128}$/;
const PERMISSION_MODES = new Set(['plan', 'acceptEdits', 'default', 'bypassPermissions']);

// POSIX single-quote escape: safe for bash / zsh / sh / git-bash.
function shq(s) {
  return `'` + String(s).replace(/'/g, `'\\''`) + `'`;
}

// Build the `claude ...` shell command, validating & escaping all
// user-derived values. Returns { ok: true, cmd } or { ok: false, error }.
//
// `tmpPromptPath` is optional — when `appendSystemPrompt` is set, the caller
// writes it to disk and passes the path here; we $(cat)-substitute it to avoid
// interpolating prompt contents into the command line at all.
function buildClaudeCmd({ sessionId, isNew, sessionOptions, tmpPromptPath }) {
  if (!UUID_RE.test(sessionId || '')) return { ok: false, error: 'invalid sessionId' };

  let cmd;
  if (sessionOptions?.forkFrom) {
    if (!UUID_RE.test(sessionOptions.forkFrom)) return { ok: false, error: 'invalid forkFrom id' };
    cmd = `claude --resume ${shq(sessionOptions.forkFrom)} --fork-session`;
  } else if (isNew) {
    cmd = `claude --session-id ${shq(sessionId)}`;
  } else {
    cmd = `claude --resume ${shq(sessionId)}`;
  }

  if (sessionOptions) {
    if (sessionOptions.dangerouslySkipPermissions) {
      cmd += ' --dangerously-skip-permissions';
    } else if (sessionOptions.permissionMode) {
      if (!PERMISSION_MODES.has(sessionOptions.permissionMode)) {
        return { ok: false, error: 'invalid permissionMode' };
      }
      cmd += ` --permission-mode ${shq(sessionOptions.permissionMode)}`;
    }
    if (sessionOptions.worktree) {
      cmd += ' --worktree';
      if (sessionOptions.worktreeName) {
        if (!WORKTREE_RE.test(sessionOptions.worktreeName)) {
          return { ok: false, error: 'invalid worktreeName' };
        }
        cmd += ` ${shq(sessionOptions.worktreeName)}`;
      }
    }
    if (sessionOptions.chrome) cmd += ' --chrome';
    if (sessionOptions.addDirs) {
      const dirs = String(sessionOptions.addDirs).split(',').map(d => d.trim()).filter(Boolean);
      for (const dir of dirs) {
        const resolved = path.resolve(dir);
        if (!path.isAbsolute(resolved)) return { ok: false, error: `invalid addDir: ${dir}` };
        cmd += ` --add-dir ${shq(resolved)}`;
      }
    }
  }

  if (sessionOptions?.appendSystemPrompt && tmpPromptPath) {
    cmd += ` --append-system-prompt "$(cat ${shq(tmpPromptPath)})"`;
  }

  // Initial prompt typed for the user at session start (Agent Teams uses
  // this to boot workers with `/sb-work <task>`). Positional arg, so it must
  // come last. Single-quote escaping handles arbitrary content; cap length
  // to keep the command line sane.
  if (sessionOptions?.initialPrompt) {
    const prompt = String(sessionOptions.initialPrompt);
    if (prompt.length > 8192) return { ok: false, error: 'initialPrompt too long' };
    if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(prompt)) {
      return { ok: false, error: 'initialPrompt contains control characters' };
    }
    cmd += ` ${shq(prompt)}`;
  }

  if (sessionOptions?.preLaunchCmd) {
    // Intentionally unescaped: user-authored shell fragment.
    cmd = sessionOptions.preLaunchCmd + ' ' + cmd;
  }

  return { ok: true, cmd };
}

module.exports = { buildClaudeCmd, shq, UUID_RE, WORKTREE_RE, PERMISSION_MODES };
