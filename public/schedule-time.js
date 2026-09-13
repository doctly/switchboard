// Schedule timing: when a scheduled task is due, in words and in minutes.
// Pure functions over a schedule row's timing fields (every, atHour, atMinute,
// weekday, cron). No timers, no I/O. Main ticks once a minute and asks
// `dueThisMinute`; the renderer asks `nextDueAt` and `describeTiming` to show
// "next run" and the preset in words. Shared by main and the renderer the same
// way snooze.js is.
(function (root) {
  const MINUTE_MS = 60 * 1000;
  // How far `nextDueAt` looks before giving up: a weekly schedule is at most
  // seven days out, and a cron with an impossible date never fires.
  const LOOKAHEAD_MINUTES = 8 * 24 * 60;

  /** The choices the dialog offers. `every = 'cron'` is never offered: it only comes from an imported file. */
  const PRESETS = [
    { every: '15m', label: 'Every 15 minutes' },
    { every: '30m', label: 'Every 30 minutes' },
    { every: 'hour', label: 'Every hour' },
    { every: 'day', label: 'Every day' },
    { every: 'weekdays', label: 'Weekdays' },
    { every: 'week', label: 'Every week' },
  ];
  const EVERY_VALUES = new Set([...PRESETS.map(p => p.every), 'cron']);
  const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

  // Check if a cron field matches a value. Supports *, ranges (1-5), lists
  // (1,3,5) and steps (*/5). Kept from the old schedule-runner so imported
  // crons keep firing exactly as they did.
  function cronFieldMatches(field, value) {
    if (field === '*') return true;
    if (field.startsWith('*/')) {
      const step = parseInt(field.slice(2), 10);
      return step > 0 && value % step === 0;
    }
    if (field.includes(',')) return field.split(',').some(f => cronFieldMatches(f.trim(), value));
    if (field.includes('-')) {
      const [lo, hi] = field.split('-').map(Number);
      return value >= lo && value <= hi;
    }
    return parseInt(field, 10) === value;
  }

  /** Whether a 5-field cron expression matches the given local time. */
  function cronMatches(cronExpr, date) {
    const parts = String(cronExpr || '').trim().split(/\s+/);
    if (parts.length !== 5) return false;
    const [minute, hour, dom, month, dow] = parts;
    return cronFieldMatches(minute, date.getMinutes()) &&
      cronFieldMatches(hour, date.getHours()) &&
      cronFieldMatches(dom, date.getDate()) &&
      cronFieldMatches(month, date.getMonth() + 1) &&
      cronFieldMatches(dow, date.getDay());
  }

  function num(v, fallback) {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  }

  /** Does this schedule fire in the minute containing `date` (local time)? */
  function dueThisMinute(schedule, date) {
    if (!schedule) return false;
    const minute = date.getMinutes();
    const hour = date.getHours();
    const day = date.getDay();
    const atMinute = num(schedule.atMinute, 0);
    const atHour = num(schedule.atHour, 9);
    switch (schedule.every) {
      case '15m': return minute % 15 === 0;
      case '30m': return minute % 30 === 0;
      case 'hour': return minute === atMinute;
      case 'day': return hour === atHour && minute === atMinute;
      case 'weekdays': return day >= 1 && day <= 5 && hour === atHour && minute === atMinute;
      case 'week': return day === num(schedule.weekday, 1) && hour === atHour && minute === atMinute;
      case 'cron': return cronMatches(schedule.cron, date);
      default: return false;
    }
  }

  /** Start of the minute after `ms`. */
  function nextMinuteStart(ms) {
    return Math.floor(ms / MINUTE_MS) * MINUTE_MS + MINUTE_MS;
  }

  /**
   * The first due minute strictly after `fromMs`, as ms, or null when none is
   * found within the lookahead. Walks minute by minute so it can never
   * disagree with `dueThisMinute`.
   */
  function nextDueAt(schedule, fromMs) {
    if (!schedule || !EVERY_VALUES.has(schedule.every)) return null;
    let t = nextMinuteStart(fromMs);
    for (let i = 0; i < LOOKAHEAD_MINUTES; i++, t += MINUTE_MS) {
      if (dueThisMinute(schedule, new Date(t))) return t;
    }
    return null;
  }

  /**
   * A run that should have happened while the app was closed: there is a due
   * minute after the last run (or the schedule's creation) and before now.
   */
  function missedRun(schedule, nowMs) {
    if (!schedule || !schedule.catchUp) return false;
    const since = Date.parse(schedule.lastRunAt || schedule.created || '');
    if (!Number.isFinite(since)) return false;
    const due = nextDueAt(schedule, since);
    return due !== null && due <= nowMs;
  }

  function timeOfDay(hour, minute) {
    const d = new Date(2000, 0, 1, hour, minute, 0, 0);
    return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  }

  /** The timing in words: "every 15 minutes", "every day at 9:00 AM", "Mondays at 9:00 AM". */
  function describeTiming(schedule) {
    if (!schedule) return '';
    const atMinute = num(schedule.atMinute, 0);
    const atHour = num(schedule.atHour, 9);
    switch (schedule.every) {
      case '15m': return 'every 15 minutes';
      case '30m': return 'every 30 minutes';
      case 'hour': return atMinute ? `every hour at :${String(atMinute).padStart(2, '0')}` : 'every hour';
      case 'day': return `every day at ${timeOfDay(atHour, atMinute)}`;
      case 'weekdays': return `weekdays at ${timeOfDay(atHour, atMinute)}`;
      case 'week': return `${WEEKDAYS[num(schedule.weekday, 1)] || 'Monday'}s at ${timeOfDay(atHour, atMinute)}`;
      case 'cron': return describeCron(schedule.cron);
      default: return '';
    }
  }

  /** Plain words for the crons an imported file is likely to have; the raw string otherwise. */
  function describeCron(cron) {
    const preset = presetFromCron(cron);
    if (preset) return describeTiming(preset) + ' (from file)';
    const parts = String(cron || '').trim().split(/\s+/);
    if (parts.length === 5 && /^\*\/\d+$/.test(parts[0]) && parts.slice(1).every(p => p === '*')) {
      return `every ${parts[0].slice(2)} minutes (from file)`;
    }
    return `cron ${String(cron || '').trim()} (from file)`;
  }

  /**
   * The preset a cron expression is exactly equivalent to, as timing fields,
   * or null when no preset fits and the cron has to be kept as is.
   */
  function presetFromCron(cron) {
    const parts = String(cron || '').trim().split(/\s+/);
    if (parts.length !== 5) return null;
    const [minute, hour, dom, month, dow] = parts;
    if (dom !== '*' || month !== '*') return null;
    const m = /^\d+$/.test(minute) ? Number(minute) : null;
    const h = /^\d+$/.test(hour) ? Number(hour) : null;
    if (m !== null && (m < 0 || m > 59)) return null;
    if (h !== null && (h < 0 || h > 23)) return null;
    if (hour === '*' && dow === '*') {
      if (minute === '*/15') return { every: '15m' };
      if (minute === '*/30') return { every: '30m' };
      if (m !== null) return { every: 'hour', atMinute: m };
      return null;
    }
    if (m === null || h === null) return null;
    if (dow === '*') return { every: 'day', atHour: h, atMinute: m };
    if (dow === '1-5') return { every: 'weekdays', atHour: h, atMinute: m };
    if (/^[0-6]$/.test(dow)) return { every: 'week', atHour: h, atMinute: m, weekday: Number(dow) };
    return null;
  }

  /** "in 12 min", "in 3 h", "tomorrow 9:00 AM", "Mon 9:00 AM", else "Sep 20, 9:00 AM". */
  function describeNextRun(dueMs, nowMs) {
    if (!Number.isFinite(dueMs)) return '';
    const delta = dueMs - nowMs;
    if (delta < 90 * 1000) return 'in a minute';
    if (delta < 60 * MINUTE_MS) return `in ${Math.round(delta / MINUTE_MS)} min`;
    const due = new Date(dueMs);
    const time = due.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    const startOfToday = new Date(nowMs);
    startOfToday.setHours(0, 0, 0, 0);
    const dayDelta = Math.floor((dueMs - startOfToday.getTime()) / (24 * 60 * MINUTE_MS));
    if (dayDelta === 0) return `today ${time}`;
    if (dayDelta === 1) return `tomorrow ${time}`;
    if (dayDelta > 1 && dayDelta < 7) return `${due.toLocaleDateString(undefined, { weekday: 'short' })} ${time}`;
    return `${due.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}, ${time}`;
  }

  const api = { PRESETS, EVERY_VALUES, WEEKDAYS, cronMatches, dueThisMinute, nextDueAt, missedRun, describeTiming, presetFromCron, describeNextRun, timeOfDay };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else Object.assign(root, api);
})(typeof window !== 'undefined' ? window : globalThis);
