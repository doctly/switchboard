const { test } = require('node:test');
const assert = require('node:assert');

const { isSshProfile, shellArgs } = require('../shell-profiles');
const {
  parseSshConfig,
  quoteRemoteDir,
  buildRemoteCommand,
  hostTargetArgs,
  sshArgsForHost,
  buildSshProfile,
  testConnectionArgs,
  remoteProjectPath,
  classifyConnResult,
  controlArgs,
  parseLsDirs,
  browseArgs,
  normalizeManualHost,
  buildSshConfigEntry,
} = require('../remote-hosts');

// --- isSshProfile ---

test('isSshProfile recognizes ssh by basename', () => {
  assert.equal(isSshProfile('ssh'), true);
  assert.equal(isSshProfile('/usr/bin/ssh'), true);
  assert.equal(isSshProfile('ssh.exe'), true);
});

test('isSshProfile rejects non-ssh shells', () => {
  assert.equal(isSshProfile('/bin/bash'), false);
  assert.equal(isSshProfile('wsl.exe'), false);
  assert.equal(isSshProfile(''), false);
  assert.equal(isSshProfile(undefined), false);
});

// --- shellArgs SSH branch ---

test('shellArgs wraps a remote command as a single-quoted bash -l -i -c payload', () => {
  const args = shellArgs('ssh', 'exec claude', ['-t', 'myhost']);
  assert.deepEqual(args, ['-t', 'myhost', 'bash', '-l', '-i', '-c', "'exec claude'"]);
});

test('shellArgs without a command opens a remote login shell', () => {
  const args = shellArgs('ssh', undefined, ['-t', 'myhost']);
  assert.deepEqual(args, ['-t', 'myhost', 'bash', '-l', '-i', '-c', `'exec "\${SHELL:-bash}" -l'`]);
});

test('shellArgs single-quotes a remote command containing spaces and quotes', () => {
  const args = shellArgs('ssh', "cd $HOME/'a b' && exec claude", ['-t', 'h']);
  // inner single quotes must be escaped as '\'' so the whole payload survives as one arg
  assert.equal(args[args.length - 1], `'cd $HOME/'\\''a b'\\'' && exec claude'`);
});

// --- parseSshConfig ---

test('parseSshConfig parses hosts and skips wildcards', () => {
  const cfg = [
    'Host prod',
    '    HostName prod.example.com',
    '    User deploy',
    '    Port 2222',
    '',
    'Host *',
    '    ForwardAgent yes',
    '',
    'Host bastion',
    '    HostName 10.0.0.1',
  ].join('\n');
  const hosts = parseSshConfig(cfg);
  assert.equal(hosts.length, 2);
  const prod = hosts.find(h => h.alias === 'prod');
  assert.equal(prod.hostName, 'prod.example.com');
  assert.equal(prod.user, 'deploy');
  assert.equal(prod.port, 2222);
  assert.equal(prod.source, 'config');
  const bastion = hosts.find(h => h.alias === 'bastion');
  assert.equal(bastion.hostName, '10.0.0.1');
  assert.equal(bastion.user, undefined);
});

test('parseSshConfig de-duplicates repeated aliases (first wins)', () => {
  const cfg = [
    'Host dup',
    '  HostName a.example.com',
    'Host other',
    '  HostName o.example.com',
    'Host dup',
    '  HostName b.example.com',
  ].join('\n');
  const hosts = parseSshConfig(cfg);
  assert.equal(hosts.filter(h => h.alias === 'dup').length, 1);
  assert.equal(hosts.find(h => h.alias === 'dup').hostName, 'a.example.com');
  assert.equal(hosts.length, 2);
});

test('parseSshConfig handles key=value and multiple aliases', () => {
  const cfg = [
    'Host web1 web2',
    '  HostName=example.com',
    '  User=root',
  ].join('\n');
  const hosts = parseSshConfig(cfg);
  assert.deepEqual(hosts.map(h => h.alias).sort(), ['web1', 'web2']);
  assert.equal(hosts[0].hostName, 'example.com');
  assert.equal(hosts[0].user, 'root');
});

// --- quoteRemoteDir ---

test('quoteRemoteDir expands leading tilde to $HOME and quotes the rest', () => {
  assert.equal(quoteRemoteDir('~'), '$HOME');
  assert.equal(quoteRemoteDir('~/foo'), "$HOME/'foo'");
  assert.equal(quoteRemoteDir('/a b'), "'/a b'");
  assert.equal(quoteRemoteDir("/x'y"), "'/x'\\''y'");
});

// --- buildRemoteCommand ---

test('buildRemoteCommand (claude) skips cd for home and cds otherwise', () => {
  assert.equal(buildRemoteCommand('claude', '~', 'claude'), 'exec claude');
  assert.equal(
    buildRemoteCommand('claude', '/proj', 'claude --dangerously-skip-permissions'),
    "cd '/proj' && exec claude --dangerously-skip-permissions"
  );
  assert.equal(buildRemoteCommand('claude', '~/work', 'claude'), "cd $HOME/'work' && exec claude");
});

test('buildRemoteCommand (claude) injects a preExec snippet between cd and exec', () => {
  assert.equal(
    buildRemoteCommand('claude', '/proj', 'claude --ide', 'export X=1'),
    "cd '/proj' && export X=1 && exec claude --ide"
  );
  // home dir: no cd, but preExec still runs before exec
  assert.equal(
    buildRemoteCommand('claude', '~', 'claude --ide', 'export X=1'),
    'export X=1 && exec claude --ide'
  );
});

test('buildRemoteCommand (shell) execs the login shell, tolerating a failed cd', () => {
  assert.equal(buildRemoteCommand('shell', '~', null), 'exec "${SHELL:-bash}" -l');
  assert.equal(
    buildRemoteCommand('shell', '/proj', null),
    `cd '/proj' 2>/dev/null; exec "\${SHELL:-bash}" -l`
  );
});

// --- host -> ssh args ---

test('hostTargetArgs uses the alias for config hosts', () => {
  assert.deepEqual(hostTargetArgs({ source: 'config', alias: 'prod' }), ['prod']);
});

test('hostTargetArgs builds user@host and passes a non-default port before the target', () => {
  assert.deepEqual(
    hostTargetArgs({ source: 'manual', host: '1.2.3.4', user: 'bob', port: 22 }),
    ['bob@1.2.3.4']
  );
  assert.deepEqual(
    hostTargetArgs({ source: 'manual', host: '1.2.3.4', user: 'bob', port: 2222 }),
    ['-p', '2222', 'bob@1.2.3.4']
  );
  assert.deepEqual(hostTargetArgs({ source: 'manual', host: '1.2.3.4' }), ['1.2.3.4']);
});

test('hostTargetArgs injects identity file and extra -o options (manual), options before target', () => {
  const host = {
    source: 'manual', host: 'h', user: 'u', port: 2222,
    identityFile: '/keys/id_rsa',
    options: ['HostKeyAlgorithms=+ssh-rsa', 'PreferredAuthentications=password'],
  };
  assert.deepEqual(hostTargetArgs(host), [
    '-o', 'HostKeyAlgorithms=+ssh-rsa',
    '-o', 'PreferredAuthentications=password',
    '-i', '/keys/id_rsa',
    '-p', '2222',
    'u@h',
  ]);
  // target is last
  assert.equal(hostTargetArgs(host).slice(-1)[0], 'u@h');
});

test('normalizeManualHost parses options from a string and trims identity file', () => {
  const h = normalizeManualHost({ host: 'h', user: 'u', identityFile: ' ~/.ssh/k ', options: 'HostKeyAlgorithms=+ssh-rsa\nPreferredAuthentications=password , Ciphers=aes128-ctr' });
  assert.equal(h.identityFile, '~/.ssh/k');
  assert.deepEqual(h.options, ['HostKeyAlgorithms=+ssh-rsa', 'PreferredAuthentications=password', 'Ciphers=aes128-ctr']);
  // already-array options pass through
  assert.deepEqual(normalizeManualHost({ host: 'h', options: ['A=1'] }).options, ['A=1']);
});

test('buildSshConfigEntry emits a valid Host block (Key Value, not Key=Value)', () => {
  const entry = buildSshConfigEntry({ label: 'prod', host: 'prod.example.com', user: 'deploy', port: 2222, identityFile: '~/.ssh/id', options: ['HostKeyAlgorithms=+ssh-rsa'] });
  assert.match(entry, /^Host prod$/m);
  assert.match(entry, /^\s+HostName prod\.example\.com$/m);
  assert.match(entry, /^\s+User deploy$/m);
  assert.match(entry, /^\s+Port 2222$/m);
  assert.match(entry, /^\s+IdentityFile ~\/\.ssh\/id$/m);
  assert.match(entry, /^\s+HostKeyAlgorithms \+ssh-rsa$/m);
  assert.doesNotMatch(entry, /=/); // config uses space-separated, never Key=Value
});

test('sshArgsForHost forces a PTY with -t before the target', () => {
  assert.deepEqual(sshArgsForHost({ source: 'config', alias: 'prod' }), ['-t', 'prod']);
  assert.deepEqual(
    sshArgsForHost({ source: 'manual', host: 'h', user: 'u', port: 2200 }),
    ['-t', '-p', '2200', 'u@h']
  );
});

test('buildSshProfile produces an ssh shell profile', () => {
  const host = { id: 'config:prod', label: 'prod', source: 'config', alias: 'prod' };
  const p = buildSshProfile(host);
  assert.equal(p.id, 'ssh:config:prod');
  assert.equal(p.path, 'ssh');
  assert.equal(p.remote, true);
  assert.deepEqual(p.args, ['-t', 'prod']);
  assert.equal(p.remoteHost, host);
  assert.match(p.name, /prod/);
});

test('remoteProjectPath builds a stable synthetic path per host+dir', () => {
  assert.equal(remoteProjectPath('mi300-7', '~/proj'), 'ssh://mi300-7/~/proj');
  assert.equal(remoteProjectPath('ce-master', '~'), 'ssh://ce-master/~');
  // default dir when omitted
  assert.equal(remoteProjectPath('h', ''), 'ssh://h/~');
});

test('classifyConnResult distinguishes reachable/auth/hostkey/unreachable', () => {
  assert.equal(classifyConnResult(0, '').status, 'ok');
  assert.equal(classifyConnResult(255, 'user@h: Permission denied (publickey,password).').status, 'auth');
  assert.equal(classifyConnResult(255, 'Host key verification failed.').status, 'hostkey');
  assert.equal(classifyConnResult(255, 'ssh: connect to host h port 22: Connection refused').status, 'unreachable');
  assert.equal(classifyConnResult(255, 'ssh: Could not resolve hostname h: nodename nor servname provided').status, 'unreachable');
  assert.equal(classifyConnResult(255, 'Operation timed out').status, 'unreachable');
  // reachable statuses mean the host answered; unreachable means it did not
  assert.equal(classifyConnResult(255, 'Permission denied (publickey,password).').reachable, true);
  assert.equal(classifyConnResult(255, 'Connection refused').reachable, false);
});

test('controlArgs enables connection multiplexing on a socket path', () => {
  assert.deepEqual(controlArgs('/tmp/swb-ab12.sock'), [
    '-o', 'ControlMaster=auto', '-o', 'ControlPath=/tmp/swb-ab12.sock', '-o', 'ControlPersist=600',
  ]);
});

test('parseLsDirs keeps only directories (ls -1Ap trailing slash), stripped and sorted', () => {
  const out = 'file.txt\nprojects/\n.config/\nreadme.md\nsrc/\n';
  assert.deepEqual(parseLsDirs(out), ['.config', 'projects', 'src']);
  assert.deepEqual(parseLsDirs(''), []);
  assert.deepEqual(parseLsDirs('onlyfile.txt\n'), []);
});

test('browseArgs lists a remote dir over the control socket, options before target', () => {
  const args = browseArgs({ source: 'config', alias: 'prod' }, '/tmp/swb-x.sock', '~/work');
  // all -o options and the target precede the remote ls command (last element)
  assert.equal(args[args.length - 1], "ls -1Ap -- $HOME/'work'");
  assert.ok(args.includes('prod'));
  assert.ok(args.includes('BatchMode=yes'));
  assert.ok(args.includes('ControlPath=/tmp/swb-x.sock'));
  // target must come before the command
  assert.ok(args.indexOf('prod') < args.length - 1);
});

test('testConnectionArgs uses BatchMode and a short timeout, no PTY', () => {
  assert.deepEqual(testConnectionArgs({ source: 'config', alias: 'prod' }), [
    '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', 'prod', 'true',
  ]);
  assert.deepEqual(testConnectionArgs({ source: 'manual', host: 'h', user: 'u', port: 2200 }), [
    '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', '-p', '2200', 'u@h', 'true',
  ]);
});
