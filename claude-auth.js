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

function transformUsageResponse(apiUsage) {
  if (!apiUsage) return {};
  const usage = {};
  mapBucket(apiUsage, 'five_hour', 'session', usage);
  mapBucket(apiUsage, 'seven_day', 'weekAll', usage);
  mapBucket(apiUsage, 'seven_day_sonnet', 'weekSonnet', usage);
  mapBucket(apiUsage, 'seven_day_opus', 'weekOpus', usage);
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
