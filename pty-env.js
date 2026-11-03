// Environment for PTY children.
//
// Three jobs:
//
// 1. Strip Electron internals that cause nested Electron apps (or node-pty
//    inside them) to malfunction.
//
// 2. Guarantee a UTF-8 character encoding. An app launched from Finder or the
//    Dock on macOS inherits no shell environment, so LANG/LC_* are simply
//    absent — launchd does not set them. Locale-sensitive tools then fall back
//    to the "standard C encoding", which on macOS means Mac OS Roman. `pbcopy`
//    is the one users notice: it reads UTF-8 bytes as Mac OS Roman, so an
//    agent response copied out of a session arrives on the clipboard as
//    "‚Ä¶‚Äî‚Üí" instead of "…—→" (issue #89).
//
//    LC_CTYPE alone is deliberate. It fixes character handling and nothing
//    else — collation, dates, and number formatting stay on the system
//    default rather than being forced to some guessed region.

const LOCALE_VARS = ['LC_ALL', 'LC_CTYPE', 'LANG'];

// 3. Forget the Claude Code session Switchboard itself may have been started
//    from (a terminal inside a session, or a session restarting the app).
//    Claude passes these to every child; a CLI started with them takes itself
//    for a child of that old session: it writes no transcript of its own, so
//    the new session gets no title, no row and nothing to resume. Settings a
//    user puts in env (CLAUDE_CODE_MAX_OUTPUT_TOKENS, …) are kept.
const INHERITED_CLAUDE_SESSION_VARS = new Set([
  'CLAUDECODE',
  'CLAUDE_PID',
  'CLAUDE_EFFORT',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_SESSION_ATTENDED',
  'CLAUDE_CODE_BRIDGE_SESSION_ID',
  'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  // The IDE server of that session; Switchboard sets its own for --ide.
  'CLAUDE_CODE_SSE_PORT',
]);

function buildPtyEnv(sourceEnv) {
  const env = Object.fromEntries(
    Object.entries(sourceEnv).filter(([k]) =>
      !k.startsWith('ELECTRON_') &&
      !k.startsWith('GOOGLE_API_KEY') &&
      k !== 'NODE_OPTIONS' &&
      k !== 'ORIGINAL_XDG_CURRENT_DESKTOP' &&
      k !== 'WT_SESSION' &&
      !INHERITED_CLAUDE_SESSION_VARS.has(k)
    )
  );

  // Only when the parent handed us nothing usable — an inherited locale is the
  // user's own setting and must win. An empty value counts as absent, which is
  // what a GUI launch actually produces.
  if (!LOCALE_VARS.some((k) => env[k])) env.LC_CTYPE = 'UTF-8';

  return env;
}

module.exports = { buildPtyEnv };
