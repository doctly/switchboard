const test = require('node:test');
const assert = require('node:assert/strict');

const {
  MAX_TIMEOUT_MS, projectSnoozed, projectWokeAt, nextWakeDelayMs, resolveSnoozePresets, snoozeWakeDescription, toLocalInputValue,
} = require('../public/snooze');

const NOW = Date.parse('2026-09-08T12:00:00.000Z');
const FUTURE = '2026-09-09T09:00:00.000Z';
const PAST = '2026-09-08T10:00:00.000Z';

test('projectSnoozed is a comparison against the clock, nothing else', () => {
  assert.equal(projectSnoozed({ snoozedUntil: FUTURE }, NOW), true);
  assert.equal(projectSnoozed({ snoozedUntil: PAST }, NOW), false, 'a past wake time no longer counts, with no writer');
  assert.equal(projectSnoozed({ snoozedUntil: null }, NOW), false);
  assert.equal(projectSnoozed({}, NOW), false);
  assert.equal(projectSnoozed({ snoozedUntil: 'not a date' }, NOW), false, 'bad data never hides a row');
  assert.equal(projectSnoozed({ snoozedUntil: FUTURE, status: 'done' }, NOW), false, 'done is not snoozed');
});

test('a project that needs input raises its hand and is not hidden', () => {
  assert.equal(projectSnoozed({ snoozedUntil: FUTURE }, NOW, true), false);
  assert.equal(projectSnoozed({ snoozedUntil: FUTURE }, NOW, false), true);
});

test('projectWokeAt reports a run-out snooze until it is cleared', () => {
  assert.equal(projectWokeAt({ snoozedUntil: PAST }, NOW), PAST);
  assert.equal(projectWokeAt({ snoozedUntil: FUTURE }, NOW), null);
  assert.equal(projectWokeAt({ snoozedUntil: null }, NOW), null);
  assert.equal(projectWokeAt({ snoozedUntil: PAST, status: 'done' }, NOW), null);
});

test('nextWakeDelayMs picks the earliest future wake and clamps to a valid timeout', () => {
  assert.equal(nextWakeDelayMs([], NOW), null, 'nothing snoozed, no timer');
  assert.equal(nextWakeDelayMs([{ snoozedUntil: PAST }], NOW), null, 'already woke, no timer');
  assert.equal(nextWakeDelayMs([{ snoozedUntil: FUTURE, status: 'done' }], NOW), null);
  const soon = new Date(NOW + 5 * 60 * 1000).toISOString();
  const delay = nextWakeDelayMs([{ snoozedUntil: FUTURE }, { snoozedUntil: soon }, { snoozedUntil: PAST }], NOW);
  assert.ok(delay > 5 * 60 * 1000 && delay < 5 * 60 * 1000 + 1000, `fires just after the earliest wake, got ${delay}`);
  const farOff = new Date(NOW + 60 * 24 * 60 * 60 * 1000).toISOString();
  assert.equal(nextWakeDelayMs([{ snoozedUntil: farOff }], NOW), MAX_TIMEOUT_MS, 'a two-month snooze must not overflow setTimeout');
});

test('presets: evening only while it is more than an hour away', () => {
  const morning = new Date(2026, 8, 9, 9, 0, 0); // Wed
  const ids = resolveSnoozePresets(morning).map(p => p.id);
  assert.deepEqual(ids, ['hour', 'three-hours', 'evening', 'tomorrow', 'next-week']);
  const lateAfternoon = new Date(2026, 8, 9, 17, 30, 0);
  assert.deepEqual(resolveSnoozePresets(lateAfternoon).map(p => p.id), ['hour', 'three-hours', 'tomorrow', 'next-week']);
});

test('presets: tomorrow and next week land at 9:00 on the right calendar days', () => {
  const wed = new Date(2026, 8, 9, 9, 0, 0);
  const byId = Object.fromEntries(resolveSnoozePresets(wed).map(p => [p.id, new Date(p.snoozedUntil)]));
  assert.deepEqual([byId.tomorrow.getDate(), byId.tomorrow.getHours(), byId.tomorrow.getMinutes()], [10, 9, 0]);
  assert.deepEqual([byId['next-week'].getDay(), byId['next-week'].getDate(), byId['next-week'].getHours()], [1, 14, 9]);
});

test('presets: on a Sunday "Tomorrow" and "Next week" are the same Monday, so only one is offered', () => {
  const sunday = new Date(2026, 8, 13, 9, 0, 0);
  assert.equal(sunday.getDay(), 0);
  const ids = resolveSnoozePresets(sunday).map(p => p.id);
  assert.ok(ids.includes('tomorrow'));
  assert.ok(!ids.includes('next-week'));
});

test('presets: every wake time is ahead of now', () => {
  for (const hour of [0, 8, 12, 17, 18, 23]) {
    const now = new Date(2026, 8, 12, hour, 45, 0);
    for (const p of resolveSnoozePresets(now)) assert.ok(Date.parse(p.snoozedUntil) > now.getTime(), `${p.id} at ${hour}:45`);
  }
});

test('snoozeWakeDescription reads as a person would say it', () => {
  const now = new Date(2026, 8, 9, 12, 0, 0); // Wed noon
  const at = (d, h) => new Date(2026, 8, d, h, 0, 0).toISOString();
  assert.match(snoozeWakeDescription(at(9, 18), now), /^6:00/);
  assert.match(snoozeWakeDescription(at(10, 9), now), /^tomorrow 9:00/);
  assert.match(snoozeWakeDescription(at(14, 9), now), /^Mon 9:00/);
  assert.match(snoozeWakeDescription(at(20, 9), now), /^Sep 20, 9:00/);
  assert.equal(snoozeWakeDescription('junk', now), '');
});

test('toLocalInputValue formats for a datetime-local input', () => {
  assert.equal(toLocalInputValue(new Date(2026, 0, 5, 7, 3, 0)), '2026-01-05T07:03');
});
