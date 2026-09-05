const { test } = require('node:test');
const assert = require('node:assert/strict');

const { transformUsageResponse, windowLabel, getOAuthToken } = require('../codex-auth');

// Shape captured from a live GET /backend-api/wham/usage.
function response(over = {}) {
  return {
    plan_type: 'pro',
    rate_limit: {
      allowed: true, limit_reached: false,
      primary_window: { used_percent: 8, limit_window_seconds: 604800, reset_at: 1788275401 },
      secondary_window: null,
    },
    additional_rate_limits: [],
    credits: { has_credits: false, unlimited: false, balance: '0' },
    rate_limit_reset_credits: { available_count: 1 },
    ...over,
  };
}

test('the account window becomes a gauge row', () => {
  const u = transformUsageResponse(response());
  assert.equal(u.runtime, 'codex');
  assert.equal(u.limits.length, 1);
  assert.equal(u.limits[0].percent, 8);
  assert.equal(u.limits[0].short, '1wk');
  assert.equal(u.limits[0].runtime, 'codex');
  assert.ok(u.limits[0].reset, 'a reset time is rendered');
});

test('window names are derived from their length, not a fixed list', () => {
  // codex reports a duration in seconds rather than naming the bucket, so an
  // unfamiliar window still gets a label instead of being dropped.
  assert.equal(windowLabel(18000), '5h');
  assert.equal(windowLabel(604800), '1wk');
  assert.equal(windowLabel(86400), '1d');
  assert.equal(windowLabel(3600), '1h');
  assert.equal(windowLabel(0), null);
  assert.equal(windowLabel(undefined), null);
});

test('per-model limits are included only once they have been used', () => {
  // A Pro account lists a window for every model it has; rendering the unused
  // ones would fill the status bar with empty bars.
  const u = transformUsageResponse(response({
    additional_rate_limits: [
      { limit_name: 'GPT-5.3-Codex-Spark', rate_limit: {
        primary_window: { used_percent: 0, limit_window_seconds: 18000, reset_at: 1787825156 },
        secondary_window: { used_percent: 12, limit_window_seconds: 604800, reset_at: 1788222410 } } },
      { limit_name: 'gpt-reserve', rate_limit: {
        primary_window: { used_percent: 0, limit_window_seconds: 604800, reset_at: 1788411956 },
        secondary_window: null } },
    ],
  }));
  const labels = u.limits.map(l => l.label);
  assert.equal(u.limits.length, 2, labels.join(', '));
  assert.ok(labels.some(l => l.includes('GPT-5.3-Codex-Spark')));
  assert.ok(!labels.some(l => l.includes('gpt-reserve')), 'unused model window dropped');
});

test('a percentage is floored, never rounded up past the real figure', () => {
  const u = transformUsageResponse(response({
    rate_limit: { primary_window: { used_percent: 8.9, limit_window_seconds: 604800, reset_at: 1788275401 } },
  }));
  assert.equal(u.limits[0].percent, 8);
});

test('plan, credits and reset credits are carried through', () => {
  const u = transformUsageResponse(response({
    credits: { has_credits: true, unlimited: false, balance: '12.50' },
    rate_limit_reset_credits: { available_count: 2 },
  }));
  assert.equal(u.planType, 'pro');
  assert.equal(u.credits.balance, '12.50');
  assert.equal(u.resetCredits, 2);
});

test('a window with no percentage is skipped rather than shown as zero', () => {
  const u = transformUsageResponse(response({
    rate_limit: { primary_window: { used_percent: null, limit_window_seconds: 604800 } },
  }));
  assert.equal(u.limits, undefined);
});

test('an empty or missing response yields nothing to render', () => {
  assert.deepEqual(transformUsageResponse(null), {});
  const u = transformUsageResponse({});
  assert.equal(u.limits, undefined);
});

test('a limit that has been hit is flagged', () => {
  const u = transformUsageResponse(response({
    rate_limit: { limit_reached: true,
      primary_window: { used_percent: 100, limit_window_seconds: 604800, reset_at: 1788275401 } },
  }));
  assert.equal(u.limitReached, true);
  assert.equal(u.limits[0].severity, 'high');
});

test('a missing auth.json reads as signed out, not an error', () => {
  const prev = process.env.CODEX_HOME;
  try {
    process.env.CODEX_HOME = '/definitely/not/a/codex/home';
    assert.equal(getOAuthToken(), null);
  } finally {
    if (prev === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = prev;
  }
});
