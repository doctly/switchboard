// Phase 3: IDE emulation over SSH.
//
// A remote Claude session can't reach Switchboard's local IDE MCP server (a
// loopback WebSocket). We reverse-forward that local port to the remote host
// (`ssh -R`), write an IDE lock file on the remote so the remote `claude --ide`
// discovers it, and route its openDiff/openFile back to the local side panel.
//
// This module holds the pure command builders (unit-tested); the orchestration
// (start server, set up the tunnel with retries, teardown) lives in main.js.

const { controlArgs, hostTargetArgs } = require('./remote-hosts');
const { shellSingleQuote, sshCmdArgs } = require('./remote-index');

const fwdSpec = (remotePort, localPort) => `${remotePort}:127.0.0.1:${localPort}`;

// `ssh -O forward -R <remotePort>:127.0.0.1:<localPort> <host>` over the shared
// control master — sets up the reverse tunnel without a new connection.
function reverseForwardArgs(host, sock, remotePort, localPort) {
  return ['-O', 'forward', '-R', fwdSpec(remotePort, localPort),
    ...controlArgs(sock), ...hostTargetArgs(host)];
}

// Tear the same tunnel down.
function cancelForwardArgs(host, sock, remotePort, localPort) {
  return ['-O', 'cancel', '-R', fwdSpec(remotePort, localPort),
    ...controlArgs(sock), ...hostTargetArgs(host)];
}

// Shell snippet (run AFTER `cd <remoteDir>`, before `exec claude`) that writes the
// IDE discovery lock and exports the port. Uses $PWD as the workspace folder and
// $$ as the pid, so it reflects the real remote session. The authToken is
// single-quoted so it can never break out of the shell.
function remoteIdeLockScript(remotePort, authToken) {
  const port = Number(remotePort);
  const tok = shellSingleQuote(authToken);
  const lock = `"$HOME/.claude/ide/${port}.lock"`;
  return (
    'mkdir -p "$HOME/.claude/ide" && ' +
    'printf \'{"pid":%d,"workspaceFolders":["%s"],"ideName":"Switchboard",' +
    '"transport":"ws","runningInWindows":false,"authToken":"%s"}\' ' +
    `"$$" "$PWD" ${tok} > ${lock} && ` +
    `export CLAUDE_CODE_SSE_PORT=${port}`
  );
}

// Remove the remote lock file (session teardown).
function remoteLockCleanupArgs(host, sock, remotePort) {
  const port = Number(remotePort);
  return sshCmdArgs(host, sock, `rm -f "$HOME/.claude/ide/${port}.lock"`);
}

// Read a remote file's content over the control socket (old side of a diff /
// openFile for a remote session — the file lives on the remote host).
function remoteCatArgs(host, sock, remotePath) {
  return sshCmdArgs(host, sock, 'cat -- ' + shellSingleQuote(remotePath));
}

// Deterministic candidate remote port in the high ephemeral range. main.js tries
// attempt 0,1,2,... until `ssh -O forward` succeeds (remote port not in use).
function candidateRemotePort(localPort, attempt) {
  const BASE = 20000;
  const RANGE = 45000; // 20000..65000
  const n = (Number(localPort) * 2654435761 + Number(attempt) * 40503) >>> 0;
  return BASE + (n % RANGE);
}

module.exports = {
  reverseForwardArgs,
  cancelForwardArgs,
  remoteIdeLockScript,
  remoteLockCleanupArgs,
  remoteCatArgs,
  candidateRemotePort,
};
