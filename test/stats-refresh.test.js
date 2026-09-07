const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runStatsCommand, refreshStatsCache } = require('../stats-refresh');

function ptyFixture(t, { writeError = false, timeoutMs = 10000 } = {}) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let onData, onExit, killed = 0;
  const writes = [];
  const result = runStatsCommand({
    spawn: () => ({
      write(value) {
        if (writeError) throw new Error('closed');
        writes.push(value);
      },
      kill() { killed++; },
      onData(fn) { onData = fn; return { dispose() {} }; },
      onExit(fn) { onExit = fn; return { dispose() {} }; },
    }),
    shell: '/bin/sh', args: ['-c', 'claude "/stats"'], options: {}, timeoutMs,
  });
  return { result, writes, data: value => onData(value), exit: code => onExit({ exitCode: code }), kills: () => killed };
}

// Includes the absolute-column escape sequences emitted by Claude 2.1.263.
const noSelected = '\x1b[2GAccessing workspace:\r\n/fake-home\r\n'
  + '\x1b[2G❯\x1b[4GNo,\x1b[8Gexit\r\n'
  + '\x1b[4GYes,\x1b[9GI\x1b[11Gtrust\x1b[17Gthis\x1b[22Gfolder\r\n';
const yesSelected = '\x1b[1D\x1b[4B\r\x1b[1C\x1b[4A No, exit\r'
  + '\x1b[1C\x1b[1B\x1b[38;2;153;204;255m❯\x1b[4GYes, I trust this folder\x1b[39m\r\n';

test('moves Down from No and only confirms after a fragmented Yes redraw', async t => {
  const p = ptyFixture(t);
  for (const byte of noSelected) p.data(byte);
  t.mock.timers.tick(1000);
  assert.deepEqual(p.writes, ['\x1b[B']);
  // Old accumulated output or unrelated chunks must not trigger Enter.
  p.data('\x1b[?2026h');
  t.mock.timers.tick(1000);
  assert.deepEqual(p.writes, ['\x1b[B']);
  for (const byte of yesSelected) p.data(byte);
  t.mock.timers.tick(100);
  assert.deepEqual(p.writes, ['\x1b[B', '\r']);
  p.data('Current\x1b[43Gstreak: 2 days');
  assert.deepEqual(await p.result, { error: null });
  t.mock.timers.tick(20000);
  assert.equal(p.kills(), 1);
  assert.equal(p.writes.length, 2);
});

test('preserves older numbered prompts that already highlight Yes', async t => {
  const p = ptyFixture(t);
  p.data('Do you trust this folder?\n❯ 1. Yes, proceed\n  2. No, exit\n');
  t.mock.timers.tick(1000);
  assert.deepEqual(p.writes, ['\r']);
  p.data('Longest streak: 5 days');
  assert.equal((await p.result).error, null);
});

test('an already trusted directory requires no keyboard input', async t => {
  const p = ptyFixture(t);
  p.data('Loading stats...\nCurrent streak: 2 days');
  assert.equal((await p.result).error, null);
  assert.deepEqual(p.writes, []);
});

test('does not accept a trust prompt whose selected option is unknown', async t => {
  const p = ptyFixture(t);
  p.data('Do you trust this folder?\nNo, exit\nYes, I trust this folder\n');
  t.mock.timers.tick(10000);
  assert.match((await p.result).error, /timed out/);
  assert.deepEqual(p.writes, []);
});

test('times out instead of confirming when Down never produces a Yes selection', async t => {
  const p = ptyFixture(t);
  p.data(noSelected);
  t.mock.timers.tick(1000);
  p.data(noSelected);
  t.mock.timers.tick(9000);
  assert.match((await p.result).error, /timed out/);
  assert.deepEqual(p.writes, ['\x1b[B']);
});

for (const exitCode of [0, 1, 127]) {
  test(`exit ${exitCode} before stats output fails and cancels pending trust input`, async t => {
    const p = ptyFixture(t);
    p.data(noSelected);
    p.exit(exitCode);
    assert.match((await p.result).error, /exited/);
    t.mock.timers.tick(20000);
    p.data(yesSelected);
    assert.deepEqual(p.writes, []);
    assert.equal(p.kills(), 1);
  });
}

test('reports a failed PTY write and stops the process', async t => {
  const p = ptyFixture(t, { writeError: true });
  p.data(noSelected);
  t.mock.timers.tick(1000);
  assert.match((await p.result).error, /trust prompt/);
  assert.equal(p.kills(), 1);
});

test('reports a failed spawn', async () => {
  const result = await runStatsCommand({ spawn() { throw new Error('ENOENT'); } });
  assert.match(result.error, /Could not start/);
});

function cacheFixture(t, date = '2026-08-20') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-stats-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'stats-cache.json');
  function write(lastComputedDate) {
    fs.writeFileSync(file, JSON.stringify({ lastComputedDate, totalSessions: 1 }));
  }
  if (date) write(date);
  return { file, write, now: () => new Date('2026-09-07T04:00:00Z') };
}

test('reports a completed command that leaves an old cache unchanged', async t => {
  const c = cacheFixture(t);
  const result = await refreshStatsCache(c.file, async () => ({ error: null }), c.now);
  assert.match(result.statsError, /did not advance/);
  assert.equal(result.stats.lastComputedDate, '2026-08-20');
});

test('accepts a cache date advancing even when the filesystem timestamp is unchanged', async t => {
  const c = cacheFixture(t);
  fs.utimesSync(c.file, 1000, 1000);
  const result = await refreshStatsCache(c.file, async () => {
    c.write('2026-09-06');
    fs.utimesSync(c.file, 1000, 1000);
    return { error: null };
  }, c.now);
  assert.equal(result.statsError, null);
  assert.equal(result.stats.lastComputedDate, '2026-09-06');
});

test('an unchanged cache through yesterday is normal on a repeat refresh', async t => {
  const c = cacheFixture(t, '2026-09-06');
  const result = await refreshStatsCache(c.file, async () => ({ error: null }), c.now);
  assert.equal(result.statsError, null);
});

test('a current cache does not hide a failed command', async t => {
  const c = cacheFixture(t, '2026-09-06');
  const result = await refreshStatsCache(c.file, async () => ({ error: 'Stats refresh timed out.' }), c.now);
  assert.match(result.statsError, /timed out/);
  assert.equal(result.stats.lastComputedDate, '2026-09-06');
});

test('keeps the last readable cache when the refreshed file is invalid', async t => {
  const c = cacheFixture(t);
  const result = await refreshStatsCache(c.file, async () => {
    fs.writeFileSync(c.file, '{');
    return { error: null };
  }, c.now);
  assert.match(result.statsError, /readable cache/);
  assert.equal(result.stats.lastComputedDate, '2026-08-20');
});

test('reports a missing cache for a first-time user without discarding the error', async t => {
  const c = cacheFixture(t, null);
  const result = await refreshStatsCache(c.file, async () => ({ error: 'Claude exited before stats finished.' }), c.now);
  assert.match(result.statsError, /exited/);
  assert.equal(result.stats, null);
});

test('a first successful cache creation succeeds', async t => {
  const c = cacheFixture(t, null);
  const result = await refreshStatsCache(c.file, async () => {
    c.write('2026-09-06');
    return { error: null };
  }, c.now);
  assert.equal(result.statsError, null);
});
