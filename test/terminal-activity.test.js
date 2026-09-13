const { test } = require('node:test');
const assert = require('node:assert/strict');

const { parsePromptMarks, createTerminalActivity } = require('../terminal-activity');

const ESC = '\x1b';
const mark = (letter, payload) => `${ESC}]133;${letter}${payload ? ';' + payload : ''}\x07`;

// Fixed timings, so a test never depends on the wall clock.
const opts = { startedAt: 0, minBusyMs: 300, markGraceMs: 4000, baselineQuietMs: 300 };

test('prompt marks are read out of a chunk in order', () => {
  const chunk = `done${mark('D', '0')}${mark('A')}user@host $ ${mark('B')}`;
  assert.deepEqual(parsePromptMarks(chunk), ['D', 'A', 'B']);
});

test('a C mark carrying the command line is still just a C', () => {
  assert.deepEqual(parsePromptMarks(mark('C', 'npm test --watch')), ['C']);
});

test('a mark terminated by ST counts too', () => {
  assert.deepEqual(parsePromptMarks(`${ESC}]133;A${ESC}\\`), ['A']);
});

test('ordinary output carries no marks', () => {
  assert.deepEqual(parsePromptMarks('total 48\r\ndrwxr-xr-x  home  staff\r\n'), []);
  assert.deepEqual(parsePromptMarks(`${ESC}]0;my title\x07`), []);
});

test('marks drive busy: C starts work, D ends it', () => {
  const a = createTerminalActivity(opts);
  assert.equal(a.feedData(mark('C'), 1000), null, 'not busy until it has run a while');
  assert.equal(a.tick(1400), true);
  assert.equal(a.state().mode, 'marks');
  assert.equal(a.feedData(mark('D', '0'), 3000), false, 'finishing reports immediately');
  assert.equal(a.tick(3500), null);
});

test('a command shorter than the threshold never raises busy', () => {
  // `cd` and `ls` would otherwise flash a spinner and mark the terminal unread.
  const a = createTerminalActivity(opts);
  assert.equal(a.feedData(mark('C'), 1000), null);
  assert.equal(a.feedData(mark('D', '0') + mark('A'), 1100), null);
  assert.equal(a.tick(2000), null);
  assert.equal(a.state().busy, false);
});

test('a shell that sends marks is never polled', () => {
  const a = createTerminalActivity(opts);
  assert.equal(a.needsPoll(), true, 'polled until we know the shell speaks for itself');
  a.feedData(mark('A'), 500);
  assert.equal(a.needsPoll(), false);
  assert.equal(a.feedProcess('npm', 600), null, 'a process name cannot override the marks');
});

test('the poll baseline is learned once the shell goes quiet, not from its rc file', () => {
  const a = createTerminalActivity({ ...opts, shellName: 'zsh' });
  a.feedData('nvm: loading', 100);
  assert.equal(a.feedProcess('nvm', 150), null);
  assert.equal(a.state().baseline, null, 'rc-file noise is not the baseline');

  a.feedData('prompt', 200);
  assert.equal(a.feedProcess('zsh', 600), null);
  assert.equal(a.state().baseline, 'zsh');

  assert.equal(a.feedProcess('npm', 5000), null, 'work starts');
  assert.equal(a.tick(5400), true);
  assert.equal(a.feedProcess('zsh', 6000), false, 'back at the prompt');
});

test('a shell whose real name differs from its path corrects itself', () => {
  // /bin/sh reports "bash" on macOS. The provisional baseline taken from the
  // path must not leave the terminal stuck as permanently working.
  const a = createTerminalActivity({ ...opts, shellName: 'sh' });
  for (let t = 100; t <= 3900; t += 400) a.feedData('startup chatter', t);
  assert.equal(a.tick(4100), null);
  assert.equal(a.state().mode, 'poll');
  assert.equal(a.state().baseline, 'sh', 'the path stands in until a quiet sample arrives');

  assert.equal(a.feedProcess('bash', 4400), null);
  assert.equal(a.state().baseline, 'bash');
  assert.equal(a.tick(5000), null, 'sitting at its prompt, not working');
});

test('nothing is reported while it is still unknown whether marks will come', () => {
  const a = createTerminalActivity({ ...opts, shellName: 'zsh' });
  a.feedProcess('zsh', 400);
  assert.equal(a.feedProcess('npm', 1000), null);
  assert.equal(a.tick(3900), null, 'inside the grace window');
  assert.equal(a.state().mode, 'unknown');
  assert.equal(a.tick(4100), true, 'grace over, the poll takes charge');
});

test('with no usable process name, marks are the only source', () => {
  // Windows: pty.process is the console title, so a name means nothing.
  const a = createTerminalActivity({ ...opts, shellName: 'pwsh', canPollProcess: false });
  assert.equal(a.feedProcess('some window title', 100), null);
  assert.equal(a.tick(5000), null);
  assert.equal(a.state().mode, 'off');
  assert.equal(a.needsPoll(), false);
  assert.equal(a.feedProcess('another title', 6000), null);

  // Marks still work if the shell happens to send them.
  const b = createTerminalActivity({ ...opts, canPollProcess: false });
  b.feedData(mark('C'), 1000);
  assert.equal(b.tick(1400), true);
});
