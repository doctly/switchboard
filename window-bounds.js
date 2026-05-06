// window-bounds.js — pure logic for computing the BrowserWindow open
// position + size from saved bounds + a snapshot of the displays.
//
// Extracted from createWindow() so it can be tested without booting
// Electron. The function takes plain data (a savedBounds object, an
// array of display objects matching Electron's screen.getAllDisplays()
// shape, and an optional defaults override) and returns a plain
// {bounds, restorePosition} object.
//
// Hard contract — covered by test/window-bounds.test.js:
//
//   1. No savedBounds → use default size, restorePosition = null
//      (BrowserWindow centers on primary by default).
//
//   2. savedBounds present → use saved width/height, capped by:
//        a. ABSOLUTE_MAX_W / ABSOLUTE_MAX_H — even on a 5K monitor we
//           never open larger than this. Power users explicitly
//           resize past it; the open-default stays sane.
//        b. SMALLEST display's 90% work area (multi-monitor only) —
//           so a window saved on the big screen doesn't fill the
//           small one when dragged across.
//        c. The active (target) display's 90% work area.
//
//   3. savedBounds spans multiple monitors (current width + x crosses
//      a display boundary) → after width clamp, snap x so the window
//      is fully contained within ONE display.
//
//   4. savedBounds matches the entire monitor (maximized state leaked
//      into the save before getNormalBounds was used) → reduce to the
//      ABSOLUTE_MAX so the user gets a usable size, not full-screen.
//
//   5. Saved position off-screen entirely → discard position, fall
//      back to centered on primary.
//
//   6. Any negative or non-finite values in savedBounds → discard,
//      use default.
//
// Constants tuned for "comfortably usable on first open" — better to err
// generous and let the user maximise/resize than to ship a cramped default
// that hides the text boxes. 1800×1200 fills a 1920×1080 display nicely
// (display-cap brings it back down to 1728×972), and stays well within a
// 2560×1440 secondary monitor without touching either edge.

const ABSOLUTE_MAX_W = 1800;
const ABSOLUTE_MAX_H = 1200;
const ABSOLUTE_MIN_W = 800;
const ABSOLUTE_MIN_H = 500;
const DEFAULT_W = 1400;
const DEFAULT_H = 900;
const WORK_AREA_PCT = 0.90;  // never use more than 90% of any display's work area

function isPositiveFinite(n) {
  return typeof n === 'number' && Number.isFinite(n) && n > 0;
}

function isFinitePoint(n) {
  return typeof n === 'number' && Number.isFinite(n);
}

function intersects(boundsA, boundsB, tolerancePx = 0) {
  // Whether two rects overlap by at least 1px (with tolerance for "near
  // off-screen" allowance).
  return (
    boundsA.x < boundsB.x + boundsB.width + tolerancePx &&
    boundsA.x + boundsA.width > boundsB.x - tolerancePx &&
    boundsA.y < boundsB.y + boundsB.height + tolerancePx &&
    boundsA.y + boundsA.height > boundsB.y - tolerancePx
  );
}

function isContained(rect, container) {
  return (
    rect.x >= container.x &&
    rect.y >= container.y &&
    rect.x + rect.width <= container.x + container.width &&
    rect.y + rect.height <= container.y + container.height
  );
}

function pickDisplayContaining(point, displays) {
  for (const d of displays) {
    if (
      point.x >= d.bounds.x && point.x < d.bounds.x + d.bounds.width &&
      point.y >= d.bounds.y && point.y < d.bounds.y + d.bounds.height
    ) {
      return d;
    }
  }
  return null;
}

function pickDisplayNearestPoint(point, displays) {
  if (displays.length === 0) return null;
  // Manhattan distance to the centre of each display's bounds — close
  // enough for "which monitor was this point on" purposes.
  let best = displays[0];
  let bestDist = Infinity;
  for (const d of displays) {
    const cx = d.bounds.x + d.bounds.width / 2;
    const cy = d.bounds.y + d.bounds.height / 2;
    const dist = Math.abs(point.x - cx) + Math.abs(point.y - cy);
    if (dist < bestDist) { best = d; bestDist = dist; }
  }
  return best;
}

function pickPrimary(displays) {
  for (const d of displays) if (d.primary) return d;
  return displays[0] || null;
}

function pickSmallestByArea(displays) {
  let best = displays[0];
  let bestArea = best.workAreaSize.width * best.workAreaSize.height;
  for (const d of displays.slice(1)) {
    const a = d.workAreaSize.width * d.workAreaSize.height;
    if (a < bestArea) { best = d; bestArea = a; }
  }
  return best;
}

function clampInt(v, min, max) {
  v = Math.floor(v);
  if (v < min) return min;
  if (v > max) return max;
  return v;
}

// Validate a saved-bounds blob. Anything malformed → null so caller falls
// back to defaults instead of trying to make sense of partial garbage.
function validateSavedBounds(b) {
  if (!b || typeof b !== 'object') return null;
  if (!isPositiveFinite(b.width) || !isPositiveFinite(b.height)) return null;
  // x and y are allowed to be negative (multi-monitor positions left of
  // primary) but must be finite.
  const out = { width: b.width, height: b.height };
  if (isFinitePoint(b.x) && isFinitePoint(b.y)) { out.x = b.x; out.y = b.y; }
  return out;
}

// Heuristic: did the saved bounds match (or near-match) an entire display's
// work area? If so the user closed in maximized state on a build before
// getNormalBounds() was used — we should reduce to the absolute max so the
// next open isn't full-screen-locked.
function looksLikeMaximizedSave(saved, displays) {
  for (const d of displays) {
    const w = d.workAreaSize.width;
    const h = d.workAreaSize.height;
    // Allow ±32px slop for Win11's drop-shadow extension and DPI rounding.
    if (Math.abs(saved.width - w) <= 32 && Math.abs(saved.height - h) <= 32) {
      return true;
    }
    // Also catch "overflow" saves where width > work-area-width.
    if (saved.width >= w - 4 && saved.height >= h - 4) {
      return true;
    }
  }
  return false;
}

/**
 * Compute the final BrowserWindow bounds + restore position from a
 * (possibly stale, possibly absent) savedBounds and the current set of
 * displays. Pure function — no electron dependencies.
 *
 * @param {object|null} savedBounds  The previously-persisted bounds, or null.
 * @param {object[]}     displays     Array matching Electron's display shape:
 *   [{ bounds:{x,y,width,height}, workArea:{x,y,width,height},
 *      workAreaSize:{width,height}, primary?:bool }]
 * @param {object}       [overrides]  Optional caps for tests.
 * @returns {{bounds:{width,height}, restorePosition:{x,y}|null}}
 */
function computeWindowBounds(savedBounds, displays, overrides) {
  const o = overrides || {};
  const absMaxW = o.absMaxW || ABSOLUTE_MAX_W;
  const absMaxH = o.absMaxH || ABSOLUTE_MAX_H;
  const minW = o.minW || ABSOLUTE_MIN_W;
  const minH = o.minH || ABSOLUTE_MIN_H;
  const defW = o.defW || DEFAULT_W;
  const defH = o.defH || DEFAULT_H;
  const workPct = o.workPct || WORK_AREA_PCT;

  // No displays passed (defensive). Caller is on its own.
  if (!Array.isArray(displays) || displays.length === 0) {
    return { bounds: { width: defW, height: defH }, restorePosition: null };
  }

  const primary = pickPrimary(displays);
  const validated = validateSavedBounds(savedBounds);

  // Compute the absolute max we'll ever produce — bounded by smallest
  // display's work area in multi-monitor setups, then by the absolute caps.
  const smallest = pickSmallestByArea(displays);
  const smallestMaxW = Math.floor(smallest.workAreaSize.width * workPct);
  const smallestMaxH = Math.floor(smallest.workAreaSize.height * workPct);
  const ceilW = Math.min(absMaxW, displays.length > 1 ? smallestMaxW : Infinity);
  const ceilH = Math.min(absMaxH, displays.length > 1 ? smallestMaxH : Infinity);

  // Starting size: validated saved or default.
  let width = validated ? validated.width : defW;
  let height = validated ? validated.height : defH;

  // Maximized-save guard: if the saved size matches a full display, the
  // user closed maximized on old code that didn't use getNormalBounds.
  // Snap to default rather than carrying that forward.
  if (validated && looksLikeMaximizedSave(validated, displays)) {
    width = defW;
    height = defH;
  }

  // Apply absolute + smallest-display caps.
  width = clampInt(width, minW, ceilW);
  height = clampInt(height, minH, ceilH);

  // Decide on position. Prefer the saved position iff it actually lands
  // on a real display (with reasonable tolerance for window drop-shadow).
  // Otherwise null → BrowserWindow centers on primary.
  let restorePosition = null;

  if (validated && validated.x != null && validated.y != null) {
    // Find the display containing the top-left corner. Allow up to 32px
    // off-screen tolerance because Win11 windows have a drop-shadow that
    // pushes the actual window-frame x slightly negative.
    const onAnyScreen = displays.some(d =>
      validated.x >= d.bounds.x - 32 && validated.x < d.bounds.x + d.bounds.width &&
      validated.y >= d.bounds.y - 32 && validated.y < d.bounds.y + d.bounds.height
    );
    if (onAnyScreen) {
      // Pick the display we'll snap to. Prefer the containing one if any,
      // else the nearest by centre.
      const target =
        pickDisplayContaining({ x: validated.x, y: validated.y }, displays) ||
        pickDisplayNearestPoint({ x: validated.x, y: validated.y }, displays) ||
        primary;
      // Apply target-display work-area cap as a final safety net.
      const targetMaxW = Math.floor(target.workAreaSize.width * workPct);
      const targetMaxH = Math.floor(target.workAreaSize.height * workPct);
      width = Math.min(width, targetMaxW);
      height = Math.min(height, targetMaxH);
      width = Math.max(width, minW);
      height = Math.max(height, minH);

      // Reposition so the window is fully contained within target.workArea.
      let x = clampInt(validated.x, target.workArea.x,
        target.workArea.x + target.workArea.width - width);
      let y = clampInt(validated.y, target.workArea.y,
        target.workArea.y + target.workArea.height - height);

      // After snapping, verify the rect is fully on the target display.
      // If the saved rect was straddling two monitors, the snap-to-edges
      // above already pulls it onto target. Belt-and-braces: if it's
      // somehow still not contained, give up on position and centre.
      if (!isContained({ x, y, width, height }, target.workArea)) {
        restorePosition = null;
      } else {
        restorePosition = { x, y };
      }
    }
    // else: position is off-screen entirely → leave restorePosition null
  }

  return { bounds: { width, height }, restorePosition };
}

module.exports = {
  computeWindowBounds,
  // Exposed for tests
  _internal: {
    validateSavedBounds, looksLikeMaximizedSave, pickPrimary,
    pickSmallestByArea, pickDisplayContaining, pickDisplayNearestPoint,
    isContained, intersects,
  },
  ABSOLUTE_MAX_W, ABSOLUTE_MAX_H, DEFAULT_W, DEFAULT_H, ABSOLUTE_MIN_W, ABSOLUTE_MIN_H, WORK_AREA_PCT,
};
