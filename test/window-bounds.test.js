// test/window-bounds.test.js — locks in the contract for every scenario
// the createWindow path has produced bugs against. If any of these fail,
// the window-open behaviour is broken — which is game-breaking for the
// app. These tests ARE the spec.

const { test } = require('node:test');
const assert = require('node:assert');
const wb = require('../window-bounds.js');

// Display fixture builders for clarity in test bodies.
const display = (x, y, w, h, opts = {}) => ({
  primary: !!opts.primary,
  bounds: { x, y, width: w, height: h },
  // workArea = bounds minus a hypothetical taskbar of 40px on the bottom of
  // the primary, none on others. workAreaSize is the {width,height} only.
  workArea: opts.workArea || (opts.primary
    ? { x, y, width: w, height: h - 40 }
    : { x, y, width: w, height: h }),
  workAreaSize: opts.workAreaSize || (opts.primary
    ? { width: w, height: h - 40 }
    : { width: w, height: h }),
});

// Common single-display setup
const single1080p = [display(0, 0, 1920, 1080, { primary: true })];

// User's reported dual-monitor setup: secondary 2560×1440 to the LEFT of a
// 5120×2880 primary. (Approximation — they had the bounds stretched across
// at least two screens.)
const dualBigPrimary = [
  display(-2560, 0, 2560, 1440),
  display(0, 0, 5120, 2880, { primary: true }),
];

// --- 1. No saved bounds -----------------------------------------------------

test('no savedBounds → returns default size, no restore position', () => {
  const r = wb.computeWindowBounds(null, single1080p);
  // Default is generous (1400×900) but display-cap on 1080p reduces height
  // to 90% of workArea (1040×0.9 = 936).
  assert.strictEqual(r.bounds.width, wb.DEFAULT_W);
  // 1080p with 40px taskbar → workArea height 1040 → 90% = 936.
  // 900 default fits within that, so it stays.
  assert.strictEqual(r.bounds.height, wb.DEFAULT_H);
  assert.strictEqual(r.restorePosition, null);
});

test('garbage savedBounds → fallback to default', () => {
  for (const garbage of [{}, { width: -10, height: 200 }, { width: 'huge', height: 200 }, { width: NaN, height: 1 }, 'not-an-object']) {
    const r = wb.computeWindowBounds(garbage, single1080p);
    assert.strictEqual(r.bounds.width, wb.DEFAULT_W);
    assert.strictEqual(r.bounds.height, wb.DEFAULT_H);
    assert.strictEqual(r.restorePosition, null);
  }
});

// --- 2. Saved bounds within sensible ranges --------------------------------

test('savedBounds within absolute caps and on-screen → returned as-is', () => {
  const r = wb.computeWindowBounds({ x: 100, y: 100, width: 1200, height: 800 }, single1080p);
  assert.strictEqual(r.bounds.width, 1200);
  assert.strictEqual(r.bounds.height, 800);
  assert.deepStrictEqual(r.restorePosition, { x: 100, y: 100 });
});

// --- 3. Absolute caps ------------------------------------------------------

test('width above ABSOLUTE_MAX_W is clamped on a single big display', () => {
  const big = [display(0, 0, 5120, 2880, { primary: true })];
  // No saved position so the maximized-detect path is bypassed.
  const r = wb.computeWindowBounds({ width: 4000, height: 600 }, big);
  assert.strictEqual(r.bounds.width, wb.ABSOLUTE_MAX_W);
  // Height stays as saved (within bounds).
  assert.strictEqual(r.bounds.height, 600);
});

test('height above ABSOLUTE_MAX_H is clamped on a single big display', () => {
  const big = [display(0, 0, 5120, 2880, { primary: true })];
  // Width within absolute max so it's preserved.
  const r = wb.computeWindowBounds({ width: 1300, height: 2000 }, big);
  assert.strictEqual(r.bounds.height, wb.ABSOLUTE_MAX_H);
  assert.strictEqual(r.bounds.width, 1300);
});

// --- 4. Multi-monitor: smallest-display cap --------------------------------

test('multi-monitor: window saved larger than smallest display gets capped', () => {
  // smallest = secondary 2560×1440 (workArea = 2560×1440 since no taskbar)
  // 90% = 2304×1296
  const r = wb.computeWindowBounds({ x: -2500, y: 100, width: 2400, height: 1300 }, dualBigPrimary);
  // Capped to smaller of (smallest 90%, ABSOLUTE_MAX) = ABSOLUTE_MAX.
  assert.strictEqual(r.bounds.width, wb.ABSOLUTE_MAX_W);
  assert.strictEqual(r.bounds.height, wb.ABSOLUTE_MAX_H);
});

// --- 5. The user's actual reported case ------------------------------------

test('REPORTED: huge saved bounds spanning across two monitors → recovers gracefully', () => {
  // Saved bounds the user reported: x=-2567 (just past secondary's left edge),
  // width 2576 (extends from secondary onto primary), height 1415 — basically
  // the full secondary monitor maximized.
  const saved = { x: -2567, y: 10, width: 2576, height: 1415 };
  const r = wb.computeWindowBounds(saved, dualBigPrimary);

  // Width MUST be reduced — anything bigger than ABSOLUTE_MAX_W is unusable.
  assert.ok(r.bounds.width <= wb.ABSOLUTE_MAX_W,
    `expected width <= ${wb.ABSOLUTE_MAX_W}, got ${r.bounds.width}`);
  assert.ok(r.bounds.height <= wb.ABSOLUTE_MAX_H,
    `expected height <= ${wb.ABSOLUTE_MAX_H}, got ${r.bounds.height}`);

  // Position MUST result in the rect being fully on ONE display.
  if (r.restorePosition) {
    const rect = { x: r.restorePosition.x, y: r.restorePosition.y, ...r.bounds };
    const displayContains = dualBigPrimary.some(d =>
      rect.x >= d.workArea.x &&
      rect.y >= d.workArea.y &&
      rect.x + rect.width <= d.workArea.x + d.workArea.width &&
      rect.y + rect.height <= d.workArea.y + d.workArea.height
    );
    assert.ok(displayContains, 'computed window must fit entirely on one display');
  }
});

// --- 6. Maximized-state save heuristic -------------------------------------

test('saved bounds matching full display → snapped to default (was maximized)', () => {
  // Pre-getNormalBounds save while maximized: bounds equal display size.
  const display1080 = [display(0, 0, 1920, 1080, { primary: true })];
  // 1920×1040 = primary's workArea. Within 32px slop.
  const r = wb.computeWindowBounds({ x: 0, y: 0, width: 1920, height: 1040 }, display1080);
  assert.strictEqual(r.bounds.width, wb.DEFAULT_W);
  assert.strictEqual(r.bounds.height, wb.DEFAULT_H);
});

test('saved bounds within slop of a full display → still treated as maximized', () => {
  const display1080 = [display(0, 0, 1920, 1080, { primary: true })];
  // 1920+30 width — Win11 drop-shadow extension.
  const r = wb.computeWindowBounds({ x: -15, y: 0, width: 1950, height: 1060 }, display1080);
  assert.strictEqual(r.bounds.width, wb.DEFAULT_W);
  assert.strictEqual(r.bounds.height, wb.DEFAULT_H);
});

test('saved bounds well below display size → preserved (NOT treated as maximized)', () => {
  const display1080 = [display(0, 0, 1920, 1080, { primary: true })];
  const r = wb.computeWindowBounds({ x: 100, y: 100, width: 1300, height: 800 }, display1080);
  assert.strictEqual(r.bounds.width, 1300);
  assert.strictEqual(r.bounds.height, 800);
});

// --- 7. Off-screen position ------------------------------------------------

test('saved position fully off-screen → discard position, fall back to centred', () => {
  // Saved position on a monitor that no longer exists (user unplugged it).
  const r = wb.computeWindowBounds({ x: -9999, y: -9999, width: 1300, height: 800 }, single1080p);
  assert.strictEqual(r.restorePosition, null);
  // Size still preserved (it's a sane size).
  assert.strictEqual(r.bounds.width, 1300);
  assert.strictEqual(r.bounds.height, 800);
});

// --- 8. Saved position within drop-shadow slop -----------------------------

test('position slightly off-screen (drop-shadow) → snapped onto display work area', () => {
  // -10px x — Win11 drop-shadow makes saved x slightly negative even though
  // the visible window starts at 0.
  const r = wb.computeWindowBounds({ x: -10, y: 0, width: 1300, height: 800 }, single1080p);
  assert.ok(r.restorePosition, 'should not discard a near-edge position');
  // Snapped to work area's x (0 here).
  assert.strictEqual(r.restorePosition.x, 0);
});

// --- 9. Min-size floor -----------------------------------------------------

test('saved bounds below MIN are bumped up to min', () => {
  const r = wb.computeWindowBounds({ x: 0, y: 0, width: 200, height: 100 }, single1080p);
  assert.strictEqual(r.bounds.width, wb.ABSOLUTE_MIN_W);
  assert.strictEqual(r.bounds.height, wb.ABSOLUTE_MIN_H);
});

// --- 10. Position spanning two displays ------------------------------------

test('position straddling two displays → snapped fully onto chosen display', () => {
  // x=-100 width=1300 spans from secondary (x<0) into primary (x>=0).
  // After clamp, must fit fully on one of them.
  const r = wb.computeWindowBounds({ x: -100, y: 50, width: 1300, height: 800 }, dualBigPrimary);
  assert.ok(r.restorePosition, 'expected position');
  const rect = { x: r.restorePosition.x, y: r.restorePosition.y, ...r.bounds };
  const fits = dualBigPrimary.some(d =>
    rect.x >= d.workArea.x &&
    rect.x + rect.width <= d.workArea.x + d.workArea.width &&
    rect.y >= d.workArea.y &&
    rect.y + rect.height <= d.workArea.y + d.workArea.height
  );
  assert.ok(fits, `rect ${JSON.stringify(rect)} must fit on one display`);
});

// --- 11. Empty displays array (defensive) ---------------------------------

test('no displays passed → return default, no position', () => {
  const r = wb.computeWindowBounds({ x: 100, y: 100, width: 1300, height: 800 }, []);
  assert.deepStrictEqual(r.bounds, { width: wb.DEFAULT_W, height: wb.DEFAULT_H });
  assert.strictEqual(r.restorePosition, null);
});

// --- 12. Internal helpers --------------------------------------------------

test('looksLikeMaximizedSave: matches full-display saves with slop tolerance', () => {
  const d = [display(0, 0, 1920, 1080, { primary: true })];
  // Exact match.
  assert.strictEqual(wb._internal.looksLikeMaximizedSave({ width: 1920, height: 1040 }, d), true);
  // Within 32px slop.
  assert.strictEqual(wb._internal.looksLikeMaximizedSave({ width: 1900, height: 1020 }, d), true);
  // Overflow (saved bigger than display).
  assert.strictEqual(wb._internal.looksLikeMaximizedSave({ width: 2000, height: 1100 }, d), true);
  // Comfortably below.
  assert.strictEqual(wb._internal.looksLikeMaximizedSave({ width: 1300, height: 800 }, d), false);
});

test('validateSavedBounds: accepts well-formed, rejects malformed', () => {
  const v = wb._internal.validateSavedBounds;
  assert.deepStrictEqual(v({ x: 0, y: 0, width: 100, height: 100 }), { x: 0, y: 0, width: 100, height: 100 });
  // Negative x/y allowed (multi-monitor).
  assert.deepStrictEqual(v({ x: -1000, y: 50, width: 100, height: 100 }), { x: -1000, y: 50, width: 100, height: 100 });
  // x/y omitted → returned as undefined keys.
  const out = v({ width: 100, height: 100 });
  assert.strictEqual(out.width, 100);
  assert.strictEqual(out.x, undefined);
  // Garbage rejected.
  assert.strictEqual(v(null), null);
  assert.strictEqual(v({}), null);
  assert.strictEqual(v({ width: -1, height: 100 }), null);
  assert.strictEqual(v({ width: NaN, height: 100 }), null);
});
