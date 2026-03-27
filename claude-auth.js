// claude-auth.js — Read Claude Code OAuth credentials and fetch usage data
// macOS: Keychain (primary) → ~/.claude/.credentials.json (fallback)
// Linux/Windows: ~/.claude/.credentials.json only

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const log = require('electron-log');

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
    const json = execSync(
      `security find-generic-password -a "${user}" -w -s "${service}"`,
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
    ).trim();
    return JSON.parse(json);
  } catch {
    return null;
  }
}

function readFromFile() {
  try {
    const credPath = path.join(getConfigDir(), '.credentials.json');
    return JSON.parse(fs.readFileSync(credPath, 'utf8'));
  } catch {
    return null;
  }
}

function getOAuthToken() {
  const creds = readFromKeychain() || readFromFile();
  return creds?.claudeAiOauth || null;
}

function formatResetTime(unixTimestamp) {
  if (!unixTimestamp) return null;
  const resetDate = new Date(unixTimestamp * 1000);
  const now = new Date();
  const diffMs = resetDate - now;

  // Format time part
  const hours = resetDate.getHours();
  const minutes = resetDate.getMinutes();
  const ampm = hours >= 12 ? 'pm' : 'am';
  const h = hours % 12 || 12;
  const timeStr = minutes === 0 ? `${h}${ampm}` : `${h}:${String(minutes).padStart(2, '0')}${ampm}`;

  // Get timezone abbreviation
  const tz = Intl.DateTimeFormat('en', { timeZoneName: 'short' }).formatToParts(resetDate)
    .find(p => p.type === 'timeZoneName')?.value || '';

  if (diffMs < 0) return `${timeStr} (${tz})`;
  if (diffMs < 24 * 60 * 60 * 1000) return `${timeStr} (${tz})`;

  // Include date for further out
  const month = resetDate.toLocaleString('en', { month: 'short' });
  const day = resetDate.getDate();
  return `${month} ${day} at ${timeStr} (${tz})`;
}

function transformUsageResponse(apiUsage) {
  if (!apiUsage) return {};
  const usage = {};

  if (apiUsage.five_hour) {
    const u = apiUsage.five_hour;
    if (u.utilization !== null && u.utilization !== undefined) {
      usage.session = Math.floor(u.utilization);
      if (u.resets_at) usage.sessionReset = formatResetTime(u.resets_at);
    }
  }
  if (apiUsage.seven_day) {
    const u = apiUsage.seven_day;
    if (u.utilization !== null && u.utilization !== undefined) {
      usage.weekAll = Math.floor(u.utilization);
      if (u.resets_at) usage.weekAllReset = formatResetTime(u.resets_at);
    }
  }
  if (apiUsage.seven_day_sonnet) {
    const u = apiUsage.seven_day_sonnet;
    if (u.utilization !== null && u.utilization !== undefined) {
      usage.weekSonnet = Math.floor(u.utilization);
      if (u.resets_at) usage.weekSonnetReset = formatResetTime(u.resets_at);
    }
  }
  if (apiUsage.seven_day_opus) {
    const u = apiUsage.seven_day_opus;
    if (u.utilization !== null && u.utilization !== undefined) {
      usage.weekOpus = Math.floor(u.utilization);
      if (u.resets_at) usage.weekOpusReset = formatResetTime(u.resets_at);
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
      'anthropic-beta': 'prompt-caching-2024-07-31',
    },
    signal: AbortSignal.timeout(10000),
  });

  if (res.status === 429) {
    const retryAfter = parseInt(res.headers.get('retry-after') || '0', 10);
    return { _rateLimited: true, retryAfterSeconds: retryAfter };
  }

  if (!res.ok) return null;
  return await res.json();
}

async function fetchAndTransformUsage() {
  const raw = await fetchUsage();
  if (raw?._rateLimited) {
    return { _rateLimited: true, retryAfterSeconds: raw.retryAfterSeconds };
  }
  return transformUsageResponse(raw);
}

module.exports = { getOAuthToken, fetchUsage, fetchAndTransformUsage, getConfigDir };
