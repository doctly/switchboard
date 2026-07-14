const { test } = require('node:test');
const assert = require('node:assert');

const {
  reverseForwardArgs,
  cancelForwardArgs,
  remoteIdeLockScript,
  remoteLockCleanupArgs,
  remoteCatArgs,
  candidateRemotePort,
} = require('../remote-ide');

const HOST = { source: 'config', alias: 'gpu', id: 'config:gpu' };
const SOCK = '/tmp/swb-abc.sock';

// --- reverseForwardArgs ---

test('reverseForwardArgs builds an `-O forward -R` request over the control socket', () => {
  const a = reverseForwardArgs(HOST, SOCK, 45123, 51000);
  const i = a.indexOf('-R');
  assert.ok(i !== -1, 'has -R');
  assert.strictEqual(a[i + 1], '45123:127.0.0.1:51000', 'remotePort:127.0.0.1:localPort');
  assert.ok(a.includes('-O') && a[a.indexOf('-O') + 1] === 'forward', 'uses -O forward');
  assert.ok(a.includes('ControlPath=' + SOCK), 'targets the shared control socket');
  assert.strictEqual(a[a.length - 1], 'gpu', 'host alias is the target (last arg)');
});

test('cancelForwardArgs mirrors reverseForwardArgs with -O cancel', () => {
  const a = cancelForwardArgs(HOST, SOCK, 45123, 51000);
  assert.ok(a.includes('-O') && a[a.indexOf('-O') + 1] === 'cancel');
  assert.strictEqual(a[a.indexOf('-R') + 1], '45123:127.0.0.1:51000');
  assert.strictEqual(a[a.length - 1], 'gpu');
});

// --- remoteIdeLockScript ---

test('remoteIdeLockScript writes a valid IDE lock and exports the port', () => {
  const s = remoteIdeLockScript(45123, 'tok-EN-123', );
  assert.match(s, /mkdir -p "\$HOME\/\.claude\/ide"/);
  assert.match(s, /\$HOME\/\.claude\/ide\/45123\.lock/);
  assert.match(s, /export CLAUDE_CODE_SSE_PORT=45123/);
  // workspaceFolders derived from the shell $PWD (lock is written after cd)
  assert.match(s, /"\$\$"/);          // pid = shell $$
  assert.match(s, /"\$PWD"/);         // workspace folder = cwd
  // token is single-quoted so it can't break the shell
  assert.match(s, /'tok-EN-123'/);
  // the printf JSON template contains the fixed IDE fields
  assert.match(s, /"ideName":"Switchboard"/);
  assert.match(s, /"transport":"ws"/);
});

test('remoteIdeLockScript single-quotes a token containing a quote safely', () => {
  const s = remoteIdeLockScript(1, "a'b");
  assert.match(s, /'a'\\''b'/);
});

// --- remoteLockCleanupArgs / remoteCatArgs ---

test('remoteLockCleanupArgs removes the remote lock over the control socket', () => {
  const a = remoteLockCleanupArgs(HOST, SOCK, 45123);
  assert.ok(a.includes('BatchMode=yes'));
  assert.ok(a.includes('ControlPath=' + SOCK));
  assert.match(a[a.length - 1], /rm -f "\$HOME\/\.claude\/ide\/45123\.lock"/);
});

test('remoteCatArgs cats a remote path safely (single-quoted)', () => {
  const a = remoteCatArgs(HOST, SOCK, "/srv/app/my file.py");
  assert.match(a[a.length - 1], /^cat -- '\/srv\/app\/my file\.py'$/);
  assert.ok(a.includes('BatchMode=yes'));
});

// --- candidateRemotePort ---

test('candidateRemotePort is deterministic, in range, and varies by attempt', () => {
  const p0 = candidateRemotePort(51000, 0);
  const p1 = candidateRemotePort(51000, 1);
  assert.notStrictEqual(p0, p1);
  for (const p of [p0, p1, candidateRemotePort(49152, 5)]) {
    assert.ok(p >= 20000 && p <= 65000, 'in the high ephemeral range: ' + p);
    assert.strictEqual(p, Math.floor(p), 'integer');
  }
  assert.strictEqual(candidateRemotePort(51000, 0), p0, 'deterministic');
});
