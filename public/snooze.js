// Snooze: hide a project from the list until a wake time, without touching its
// sessions. Nothing runs at wake time. The row keeps two timestamps
// (snoozedUntil, snoozedAt) and the list decides from the clock at render:
// a past snoozedUntil no longer counts. This is what keeps it cheap. There is
// no schedule to maintain, and with nothing snoozed there is no timer at all.
(function (root) {
  const MINUTE_MS = 60 * 1000;
  const HOUR_MS = 60 * MINUTE_MS;
  const DAY_MS = 24 * HOUR_MS;
  const EVENING_HOUR = 18;
  const MORNING_HOUR = 9;
  // setTimeout treats a delay above this as 0 and fires at once, which would
  // re-render in a loop for any snooze longer than ~24.8 days.
  const MAX_TIMEOUT_MS = 2 ** 31 - 1;
  // Fire a moment after the wake time so the comparison is not on the edge.
  const WAKE_SLACK_MS = 250;

  function wakeTime(project) {
    if (!project || !project.snoozedUntil) return null;
    const t = Date.parse(project.snoozedUntil);
    return Number.isFinite(t) ? t : null; // malformed data never hides a row
  }

  /**
   * Hidden while the wake time is ahead and nothing in the project needs the
   * user. `attention` is the caller's answer to "does a session need input":
   * a snoozed project raises its hand for that, and only that. Finished turns
   * are ordinary background activity and stay quiet.
   */
  function projectSnoozed(project, nowMs, attention = false) {
    if (!project || project.status === 'done') return false;
    const wake = wakeTime(project);
    if (wake === null || wake <= nowMs) return false;
    return !attention;
  }

  /** The wake time of a project whose snooze has run out and not been cleared yet, else null. */
  function projectWokeAt(project, nowMs) {
    if (!project || project.status === 'done') return null;
    const wake = wakeTime(project);
    return wake !== null && wake <= nowMs ? project.snoozedUntil : null;
  }

  /**
   * How long until the earliest wake among these projects, clamped so the
   * timer is valid. Null when nothing is due: no timer needs to exist.
   */
  function nextWakeDelayMs(projects, nowMs) {
    let earliest = null;
    for (const p of projects || []) {
      if (p.status === 'done') continue;
      const wake = wakeTime(p);
      if (wake === null || wake <= nowMs) continue;
      if (earliest === null || wake < earliest) earliest = wake;
    }
    if (earliest === null) return null;
    return Math.min(earliest - nowMs + WAKE_SLACK_MS, MAX_TIMEOUT_MS);
  }

  function timeOfDay(date) {
    return date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  }

  function atHour(base, hour) {
    const d = new Date(base);
    d.setHours(hour, 0, 0, 0);
    return d;
  }

  // Calendar days, not DAY_MS: a spring-forward day is 23 hours, so 23:30 plus
  // 24h lands two days out.
  function addDays(base, days) {
    const d = new Date(base);
    d.setDate(d.getDate() + days);
    return d;
  }

  function weekday(date) {
    return date.toLocaleDateString(undefined, { weekday: 'short' });
  }

  /**
   * The menu's choices. "This evening" appears only while it is more than an
   * hour away. On a Sunday "Tomorrow" and "Next week" are the same Monday
   * morning, so only "Tomorrow" is offered.
   */
  function resolveSnoozePresets(now = new Date()) {
    const inAnHour = new Date(now.getTime() + HOUR_MS);
    const inThreeHours = new Date(now.getTime() + 3 * HOUR_MS);
    const presets = [
      { id: 'hour', label: 'In 1 hour', whenLabel: timeOfDay(inAnHour), snoozedUntil: inAnHour.toISOString() },
      { id: 'three-hours', label: 'In 3 hours', whenLabel: timeOfDay(inThreeHours), snoozedUntil: inThreeHours.toISOString() },
    ];
    const evening = atHour(now, EVENING_HOUR);
    if (evening.getTime() - now.getTime() > HOUR_MS) {
      presets.push({ id: 'evening', label: 'This evening', whenLabel: timeOfDay(evening), snoozedUntil: evening.toISOString() });
    }
    const tomorrow = atHour(addDays(now, 1), MORNING_HOUR);
    presets.push({ id: 'tomorrow', label: 'Tomorrow', whenLabel: timeOfDay(tomorrow), snoozedUntil: tomorrow.toISOString() });
    const daysUntilMonday = (1 - now.getDay() + 7) % 7 || 7;
    const nextWeek = atHour(addDays(now, daysUntilMonday), MORNING_HOUR);
    if (nextWeek.getTime() !== tomorrow.getTime()) {
      presets.push({ id: 'next-week', label: 'Next week', whenLabel: `${weekday(nextWeek)} ${timeOfDay(nextWeek)}`, snoozedUntil: nextWeek.toISOString() });
    }
    return presets;
  }

  /** "6:00 PM" today, "tomorrow 9:00 AM", "Mon 9:00 AM" this week, else "Sep 20, 9:00 AM". */
  function snoozeWakeDescription(snoozedUntil, now = new Date()) {
    const wakeMs = Date.parse(snoozedUntil);
    if (!Number.isFinite(wakeMs)) return '';
    const wake = new Date(wakeMs);
    const startOfToday = new Date(now);
    startOfToday.setHours(0, 0, 0, 0);
    const dayDelta = Math.floor((wakeMs - startOfToday.getTime()) / DAY_MS);
    const time = timeOfDay(wake);
    if (dayDelta === 0) return time;
    if (dayDelta === 1) return `tomorrow ${time}`;
    if (dayDelta > 1 && dayDelta < 7) return `${weekday(wake)} ${time}`;
    return `${wake.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}, ${time}`;
  }

  /** Value for an <input type="datetime-local">: local time, minute precision. */
  function toLocalInputValue(date) {
    const pad = (n) => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }

  const api = { MAX_TIMEOUT_MS, projectSnoozed, projectWokeAt, nextWakeDelayMs, resolveSnoozePresets, snoozeWakeDescription, toLocalInputValue };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else Object.assign(root, api);
})(typeof window !== 'undefined' ? window : globalThis);
