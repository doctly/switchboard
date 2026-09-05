// Codex account usage.
//
// Mirrors claude-auth.js: read the CLI's stored OAuth token, ask its account
// endpoint how much quota is left, and hand back rows in the shape the status
// bar gauge and stats view already render.
//
// Endpoint and headers were read out of the codex binary. `/backend-api/wham/usage`
// is the one that answers; the `/api/codex/usage` alias in its strings is
// internal and returns 403 from outside.

const fs = require('fs');
const os = require('os');
const path = require('path');

const USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';

function codexHome() {
  return process.env.CODEX_HOME
    ? path.resolve(process.env.CODEX_HOME)
    : path.join(os.homedir(), '.codex');
}

/** OAuth tokens the codex CLI stores after login. Null if not signed in. */
function getOAuthToken() {
  try {
    const raw = fs.readFileSync(path.join(codexHome(), 'auth.json'), 'utf8');
    const parsed = JSON.parse(raw);
    const accessToken = parsed?.tokens?.access_token;
    if (!accessToken) return null;
    return { accessToken, accountId: parsed.tokens.account_id || null };
  } catch {
    return null;
  }
}

// Same wording as claude-auth.js so both CLIs' resets read identically.
function formatResetTime(value) {
  if (!value) return null;
  let resetDate;
  if (typeof value === 'string') {
    resetDate = new Date(value);
  } else if (value > 1e12) {
    resetDate = new Date(value);
  } else {
    resetDate = new Date(value * 1000);
  }
  if (isNaN(resetDate.getTime())) return null;
  const now = new Date();
  const diffMs = resetDate - now;

  const hours = resetDate.getHours();
  const minutes = resetDate.getMinutes();
  const ampm = hours >= 12 ? 'pm' : 'am';
  const h = hours % 12 || 12;
  const timeStr = minutes === 0 ? `${h}${ampm}` : `${h}:${String(minutes).padStart(2, '0')}${ampm}`;

  const tz = Intl.DateTimeFormat('en', { timeZoneName: 'short' }).formatToParts(resetDate)
    .find(p => p.type === 'timeZoneName')?.value || '';

  if (diffMs < 24 * 60 * 60 * 1000) return `${timeStr} (${tz})`;

  const month = resetDate.toLocaleString('en', { month: 'short' });
  const day = resetDate.getDate();
  return `${month} ${day} at ${timeStr} (${tz})`;
}

/**
 * A window's length, as the short label the status bar has room for.
 *
 * codex reports the window in seconds rather than naming it, so the name is
 * derived — that way a window length we have never seen still gets a sensible
 * label instead of being dropped.
 */
function windowLabel(seconds) {
  if (!seconds) return null;
  const hours = Math.round(seconds / 3600);
  if (hours >= 24 * 28) return `${Math.round(hours / (24 * 30))}mo`;
  if (hours >= 24 * 7) return `${Math.round(hours / (24 * 7))}wk`;
  if (hours >= 24) return `${Math.round(hours / 24)}d`;
  return `${hours}h`;
}

/** codex's { used_percent, limit_window_seconds, reset_at } → a gauge row. */
function windowRow(win, name) {
  if (!win || win.used_percent === null || win.used_percent === undefined) return null;
  const short = windowLabel(win.limit_window_seconds);
  return {
    kind: 'codex',
    runtime: 'codex',
    // The gauge shortens this itself; `short` is what it shows.
    short: short || 'Codex',
    label: name ? `${name} (${short || 'window'})` : `Codex ${short || 'usage'}`,
    model: name || null,
    percent: Math.floor(win.used_percent),
    reset: formatResetTime(win.reset_at || win.reset_after_seconds ? win.reset_at : null),
    severity: win.used_percent >= 90 ? 'high' : 'normal',
  };
}

/**
 * Flatten every limit the account reports into gauge rows.
 *
 * The account-wide limit comes first because it is the one that actually stops
 * work; per-model limits follow. Rows at 0% for a model never used are dropped,
 * or a Pro account would carry a row of empty bars for every model it has.
 */
function transformUsageResponse(raw) {
  if (!raw) return {};
  const limits = [];

  const primary = windowRow(raw.rate_limit?.primary_window, null);
  if (primary) limits.push(primary);
  const secondary = windowRow(raw.rate_limit?.secondary_window, null);
  if (secondary) limits.push(secondary);

  for (const extra of raw.additional_rate_limits || []) {
    const name = extra.limit_name || extra.metered_feature || null;
    for (const key of ['primary_window', 'secondary_window']) {
      const row = windowRow(extra.rate_limit?.[key], name);
      if (row && row.percent > 0) limits.push(row);
    }
  }

  const usage = { runtime: 'codex' };
  if (limits.length) usage.limits = limits;
  if (raw.plan_type) usage.planType = raw.plan_type;
  if (raw.credits) {
    usage.credits = {
      balance: raw.credits.balance ?? null,
      unlimited: !!raw.credits.unlimited,
      hasCredits: !!raw.credits.has_credits,
    };
  }
  if (raw.rate_limit_reset_credits) {
    usage.resetCredits = raw.rate_limit_reset_credits.available_count ?? 0;
  }
  usage.limitReached = !!raw.rate_limit?.limit_reached;
  return usage;
}

async function fetchUsage() {
  const oauth = getOAuthToken();
  if (!oauth?.accessToken) return null;

  const headers = {
    'Authorization': `Bearer ${oauth.accessToken}`,
    'Content-Type': 'application/json',
    'originator': 'codex_cli_rs',
  };
  if (oauth.accountId) headers['chatgpt-account-id'] = oauth.accountId;

  const res = await fetch(USAGE_URL, { headers, signal: AbortSignal.timeout(10000) });

  if (res.status === 429) {
    const retryAfter = parseInt(res.headers.get('retry-after') || '0', 10);
    return { _rateLimited: true, retryAfterSeconds: retryAfter };
  }
  if (!res.ok) {
    console.error('[codex-auth] Usage API error:', res.status, res.statusText);
    return null;
  }
  return await res.json();
}

async function fetchAndTransformUsage() {
  try {
    const raw = await fetchUsage();
    if (raw === null) {
      return { _error: true, message: 'Could not fetch Codex usage (not signed in, or API error)' };
    }
    if (raw?._rateLimited) {
      return { _rateLimited: true, retryAfterSeconds: raw.retryAfterSeconds };
    }
    return transformUsageResponse(raw);
  } catch (err) {
    return { _error: true, message: err.message };
  }
}

module.exports = {
  getOAuthToken, fetchUsage, fetchAndTransformUsage, transformUsageResponse,
  windowLabel, formatResetTime, codexHome, USAGE_URL,
};
