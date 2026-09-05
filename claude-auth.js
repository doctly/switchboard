// claude-auth.js — Read Claude Code OAuth credentials and fetch usage data
// macOS: Keychain (primary) → ~/.claude/.credentials.json (fallback)
// Linux/Windows: ~/.claude/.credentials.json only

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

function getConfigDir() {
  return (process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'));
}

function getKeychainServiceName() {
  const suffix = '-credentials';
  if (process.env.CLAUDE_CONFIG_DIR) {
    const crypto = require('crypto');
    const hash = crypto.createHash('sha256').update(getConfigDir()).digest('hex').substring(0, 8);
    return `Claude Code${suffix}-${hash}`;
  }
  return `Claude Code${suffix}`;
}

function readFromKeychain() {
  if (process.platform !== 'darwin') return null;
  try {
    const service = getKeychainServiceName();
    const user = process.env.USER || os.userInfo().username;
    // execFileSync (no shell) so $USER can't be interpolated into a command string
    const json = execFileSync(
      'security',
      ['find-generic-password', '-a', user, '-w', '-s', service],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
    ).trim();
    return JSON.parse(json);
  } catch (err) {
    console.error('[claude-auth] Keychain read error:', err.message);
    return null;
  }
}

function readFromFile() {
  try {
    const credPath = path.join(getConfigDir(), '.credentials.json');
    return JSON.parse(fs.readFileSync(credPath, 'utf8'));
  } catch (err) {
    console.error('[claude-auth] Credentials file read error:', err.message);
    return null;
  }
}

function getOAuthToken() {
  const creds = readFromKeychain() || readFromFile();
  return creds?.claudeAiOauth || null;
}

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

  if (diffMs < 0) return `${timeStr} (${tz})`;
  if (diffMs < 24 * 60 * 60 * 1000) return `${timeStr} (${tz})`;

  const month = resetDate.toLocaleString('en', { month: 'short' });
  const day = resetDate.getDate();
  return `${month} ${day} at ${timeStr} (${tz})`;
}

function mapBucket(apiUsage, apiKey, usageKey, usage) {
  try {
    const u = apiUsage[apiKey];
    if (!u || u.utilization === null || u.utilization === undefined) return;
    usage[usageKey] = Math.floor(u.utilization);
    if (u.resets_at) usage[usageKey + 'Reset'] = formatResetTime(u.resets_at);
  } catch (err) {
    console.error('[claude-auth] Error mapping bucket', apiKey, err.message);
  }
}

/**
 * Map the API's `limits` array into a renderable list.
 *
 * The per-model top-level buckets this file used to read — seven_day_sonnet,
 * seven_day_opus, and a set of codenamed ones — now come back `null`. The live
 * data moved into `limits`, which is self-describing: each row carries its own
 * `kind`, `percent`, `resets_at`, and, for model-scoped windows, the model's
 * display name. Reading that means new models show up on their own instead of
 * needing a new key added here every time one ships.
 */
function mapLimits(apiUsage, usage) {
  const rows = Array.isArray(apiUsage.limits) ? apiUsage.limits : [];
  const out = [];
  for (const l of rows) {
    if (!l || l.percent === null || l.percent === undefined) continue;
    const model = l.scope?.model?.display_name || null;
    const label = l.kind === 'session' ? 'Current session'
      : l.kind === 'weekly_all' ? 'Week (all models)'
      : model ? `Week (${model})`
      : 'Week';
    out.push({
      kind: l.kind || null,
      label,
      model,
      percent: Math.floor(l.percent),
      reset: l.resets_at ? formatResetTime(l.resets_at) : null,
      severity: l.severity || 'normal',
    });
  }
  if (out.length) usage.limits = out;
}

function transformUsageResponse(apiUsage) {
  if (!apiUsage) return {};
  const usage = {};
  // Legacy flat keys — kept because existing callers read usage.session /
  // usage.weekAll directly. five_hour and seven_day are still populated by the
  // API; the two model-specific ones are not, and are left in only so an older
  // response shape still maps.
  mapBucket(apiUsage, 'five_hour', 'session', usage);
  mapBucket(apiUsage, 'seven_day', 'weekAll', usage);
  mapBucket(apiUsage, 'seven_day_sonnet', 'weekSonnet', usage);
  mapBucket(apiUsage, 'seven_day_opus', 'weekOpus', usage);

  mapLimits(apiUsage, usage);

  // Backfill the legacy keys from `limits` if the flat buckets ever go null too,
  // so the status bar and any other flat-key reader keep working.
  for (const l of usage.limits || []) {
    if (l.kind === 'session' && usage.session === undefined) {
      usage.session = l.percent;
      if (l.reset) usage.sessionReset = l.reset;
    }
    if (l.kind === 'weekly_all' && usage.weekAll === undefined) {
      usage.weekAll = l.percent;
      if (l.reset) usage.weekAllReset = l.reset;
    }
  }
  return usage;
}

async function fetchUsage() {
  const oauth = getOAuthToken();
  if (!oauth?.accessToken) return null;

  const res = await fetch('https://api.anthropic.com/api/oauth/usage', {
    headers: {
      'Authorization': `Bearer ${oauth.accessToken}`,
      'Content-Type': 'application/json',
      'User-Agent': 'claude-code/2.1.74',
      'anthropic-beta': 'oauth-2025-04-20',
    },
    signal: AbortSignal.timeout(10000),
  });

  if (res.status === 429) {
    const retryAfter = parseInt(res.headers.get('retry-after') || '0', 10);
    return { _rateLimited: true, retryAfterSeconds: retryAfter };
  }

  if (!res.ok) {
    console.error('[claude-auth] Usage API error:', res.status, res.statusText);
    return null;
  }
  return await res.json();
}

async function fetchAndTransformUsage() {
  try {
    const raw = await fetchUsage();
    if (raw === null) {
      return { _error: true, message: 'Could not fetch usage (no token or API error)' };
    }
    if (raw?._rateLimited) {
      return { _rateLimited: true, retryAfterSeconds: raw.retryAfterSeconds };
    }
    return transformUsageResponse(raw);
  } catch (err) {
    return { _error: true, message: err.message };
  }
}

module.exports = { getOAuthToken, fetchUsage, fetchAndTransformUsage, getConfigDir };
