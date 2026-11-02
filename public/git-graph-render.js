// Pure rendering/formatting helpers for the Git Graph tab: SVG lane/edge/node
// markup, reference-label pill markup (including the combined local+remote
// pill's two independently-clickable hit regions), date formatting, and the
// stash/uncommitted pseudo-commit merge used to build the graph's row list.
//
// Nothing here touches window.api or persistent state — project-git-graph-view.js
// owns fetching/state, this file only turns data into markup/geometry so it can
// be unit-tested without a DOM. `escapeHtml`/`escapeAttr` come from utils.js
// (loaded first).

// Lanes 1-4 reuse Switchboard's existing semantic palette (green/blue-violet/
// amber/red, same hues as the read-only Git tab) for visual continuity; lanes
// 5-12 are original additions chosen to stay distinguishable on a dark background.
const GG_DEFAULT_PALETTE = [
  '#74cf86', '#8992dc', '#e0aa63', '#df7180',
  '#5fb3d9', '#c77dd4', '#d9c15f', '#5fd9c0',
  '#d98f5f', '#8fd95f', '#b58fe8', '#e85f8f',
];

const GG_ROW_HEIGHT = 28;
const GG_LANE_WIDTH = 16;
const GG_NODE_RADIUS = 4.5;

function gitGraphPaletteColor(palette, index) {
  const list = (palette && palette.length) ? palette : GG_DEFAULT_PALETTE;
  return list[((index % list.length) + list.length) % list.length];
}

// --- Date formatting ---

function gitGraphPad2(n) { return String(n).padStart(2, '0'); }

const GG_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function gitGraphFormatRelative(date, now = new Date()) {
  const diffMs = now.getTime() - date.getTime();
  const abs = Math.abs(diffMs);
  const mins = Math.round(abs / 60000);
  const hours = Math.round(abs / 3600000);
  const days = Math.round(abs / 86400000);
  const suffix = diffMs >= 0 ? 'ago' : 'from now';
  if (abs < 45000) return 'just now';
  if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'} ${suffix}`;
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ${suffix}`;
  if (days < 30) return `${days} day${days === 1 ? '' : 's'} ${suffix}`;
  const months = Math.round(days / 30.4);
  if (months < 12) return `${months} month${months === 1 ? '' : 's'} ${suffix}`;
  const years = Math.round(days / 365);
  return `${years} year${years === 1 ? '' : 's'} ${suffix}`;
}

/** format: 'date-time'|'date-only'|'iso'|'iso-date-only'|'relative'. */
function gitGraphFormatDate(isoValue, format = 'date-time', now = new Date()) {
  const date = new Date(isoValue);
  if (Number.isNaN(date.getTime())) return '';
  if (format === 'relative') return gitGraphFormatRelative(date, now);
  const y = date.getFullYear();
  const mo = GG_MONTHS[date.getMonth()];
  const d = date.getDate();
  const hh = gitGraphPad2(date.getHours());
  const mm = gitGraphPad2(date.getMinutes());
  if (format === 'date-only') return `${d} ${mo} ${y}`;
  if (format === 'iso-date-only') return `${y}-${gitGraphPad2(date.getMonth() + 1)}-${gitGraphPad2(d)}`;
  if (format === 'iso') return `${y}-${gitGraphPad2(date.getMonth() + 1)}-${gitGraphPad2(d)} ${hh}:${mm}`;
  return `${d} ${mo} ${y} ${hh}:${mm}`;
}

/** Full localized string used in the Commit Details panel. */
function gitGraphFormatFullDate(isoValue) {
  const date = new Date(isoValue);
  if (Number.isNaN(date.getTime())) return '';
  return date.toString();
}

// --- Stash / Uncommitted pseudo-commit synthesis ---

/**
 * Merges Stash[] and an optional Uncommitted entry into the ordered Commit[]
 * the layout algorithm consumes: each stash becomes a single-parent
 * pseudo-commit rooted at its own base commit; Uncommitted (when present) is
 * always the top-most row regardless of date. Returns a new array; does not
 * mutate its inputs.
 */
function gitGraphBuildLayoutInput(commits, stashes, uncommitted, headHash) {
  // Keep git's order: it already lists every child before its parents. Re-sorting
  // by date would put a rebased commit (old author date) above its own child.
  const list = (commits || []).map(c => ({ ...c, kind: c.kind || 'commit' }));
  const stashRows = [];
  for (const stash of (stashes || [])) {
    stashRows.push({
      hash: stash.hash,
      shortHash: (stash.hash || '').slice(0, 8),
      parents: stash.baseCommitHash ? [stash.baseCommitHash] : [],
      authorName: '', authorEmail: '', authorDate: stash.date,
      committerName: '', committerEmail: '', commitDate: stash.date,
      subject: stash.message || '',
      isHead: false,
      refs: { heads: [], remotes: [], tags: [] },
      kind: 'stash',
      stashIndex: stash.index,
    });
  }
  // A stash goes where its date falls, but never below the commit it was taken
  // from; one whose base commit isn't loaded yet waits for Load More rather
  // than hanging a line off the bottom of the graph.
  stashRows.sort((a, b) => new Date(a.commitDate || 0) - new Date(b.commitDate || 0));
  for (const stash of stashRows) {
    const base = stash.parents[0] ? list.findIndex(c => c.hash === stash.parents[0]) : -1;
    if (base === -1) continue;
    const time = new Date(stash.commitDate || 0).getTime();
    let at = list.findIndex(c => new Date(c.commitDate || c.authorDate || 0).getTime() < time);
    if (at === -1 || at > base) at = base;
    list.splice(at, 0, stash);
  }
  if (uncommitted) {
    list.unshift({
      hash: '#uncommitted',
      shortHash: '',
      parents: headHash ? [headHash] : [],
      authorName: '*', authorEmail: '', authorDate: new Date().toISOString(),
      committerName: '*', committerEmail: '', commitDate: new Date().toISOString(),
      subject: `Uncommitted Changes (${uncommitted.changeCount || 0})`,
      isHead: false,
      refs: { heads: [], remotes: [], tags: [] },
      kind: 'uncommitted',
      changeCount: uncommitted.changeCount || 0,
    });
  }
  return list;
}

// --- Layout-function resolution ---
//
// git-graph-layout.js's own computeGitGraphLayout is the real lane/edge
// assignment algorithm, and index.html always loads that file before this
// one, so `gitGraphResolveLayoutFn` resolves to it in every real paint. The
// fallback below only matters for a test or tool that loads this file in
// isolation: it places every row in lane 0 with no edges (a flat, un-branched
// column) rather than reimplementing the real algorithm a second time.

function gitGraphFallbackLayout(commits) {
  return (commits || []).map((commit, index) => ({ hash: commit.hash, lane: 0, colorIndex: 0, edges: [], row: index }));
}

/** Picks the real layout function when present, else the fallback above. */
function gitGraphResolveLayoutFn() {
  if (typeof computeGitGraphLayout === 'function') return computeGitGraphLayout;
  return gitGraphFallbackLayout;
}

// --- Graph SVG rendering ---

/**
 * `rows` = the merged Commit[] in render order (index 0 = newest/top).
 * `laneAssignments` = parallel array from the layout function.
 */
function gitGraphRenderGraphSvg(rows, laneAssignments, opts = {}) {
  const style = opts.style === 'angular' ? 'angular' : 'rounded';
  const palette = opts.palette;
  const uncommittedStyle = opts.uncommittedChangesStyle || 'openAtUncommitted';
  const rowHeight = opts.rowHeight || GG_ROW_HEIGHT;
  const laneWidth = opts.laneWidth || GG_LANE_WIDTH;
  const byHash = new Map(rows.map((r, i) => [r.hash, i]));
  const maxLane = laneAssignments.reduce((m, a) => Math.max(m, a.lane), 0);
  const width = (maxLane + 1) * laneWidth + laneWidth;
  // opts.rowY carries each table row's measured centre, so nodes stay on their
  // rows even when rows differ in height or commit details open inline.
  const rowY = Array.isArray(opts.rowY) && opts.rowY.length === rows.length ? opts.rowY : null;
  const yOf = i => (rowY ? rowY[i] : rowHeight / 2 + i * rowHeight);
  const height = rowY && opts.height ? opts.height : rows.length * rowHeight;
  const paths = [];
  const nodes = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const assignment = laneAssignments[i] || { lane: 0, colorIndex: 0, edges: [] };
    const cx = laneWidth / 2 + assignment.lane * laneWidth;
    const cy = yOf(i);
    const color = gitGraphPaletteColor(palette, assignment.colorIndex || 0);

    for (const edge of assignment.edges || []) {
      // An edge bends into its own lane on the first row, runs straight down,
      // and only bends again on the last row if its parent sits in another lane.
      // A parent that isn't loaded yet keeps the lane running off the bottom.
      const via = laneWidth / 2 + (edge.viaLane != null ? edge.viaLane : edge.toLane) * laneWidth;
      const targetRow = byHash.get(edge.parentHash);
      const loaded = targetRow !== undefined;
      const tx = loaded ? laneWidth / 2 + edge.toLane * laneWidth : via;
      const ty = loaded ? yOf(targetRow) : height + rowHeight / 2;
      const endRow = loaded ? targetRow : rows.length;
      const route = endRow - i > 1
        ? { via, top: yOf(i + 1), bottom: loaded ? yOf(targetRow - 1) : height }
        : null;
      paths.push(gitGraphEdgePath(cx, cy, tx, ty, color, style, route));
    }

    let nodeMarkup;
    if (row.kind === 'uncommitted') {
      const hollow = uncommittedStyle === 'openAtUncommitted';
      nodeMarkup = gitGraphNodeCircle(cx, cy, color, { hollow, dashed: false, kind: 'uncommitted' });
    } else if (row.kind === 'stash') {
      nodeMarkup = gitGraphNodeCircle(cx, cy, color, { hollow: false, diamond: true, kind: 'stash' });
    } else if (row.isHead) {
      nodeMarkup = gitGraphNodeCircle(cx, cy, color, { hollow: true, kind: 'head' });
    } else {
      nodeMarkup = gitGraphNodeCircle(cx, cy, color, { hollow: false, kind: (row.parents || []).length > 1 ? 'merge' : 'normal' });
    }
    nodes.push(nodeMarkup);
  }

  return `<svg class="gg-graph-svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" data-gg-lane-width="${laneWidth}" data-gg-row-height="${rowHeight}"><g class="gg-edges">${paths.join('')}</g><g class="gg-nodes">${nodes.join('')}</g></svg>`;
}

function gitGraphEdgePath(x1, y1, x2, y2, color, style, route) {
  if (route) {
    const bend = (xa, ya, xb, yb) => {
      if (xa === xb) return ` L${xb} ${yb}`;
      const midY = (ya + yb) / 2;
      return style === 'angular' ? ` L${xa} ${midY} L${xb} ${midY} L${xb} ${yb}` : ` C${xa} ${midY}, ${xb} ${midY}, ${xb} ${yb}`;
    };
    const { top, bottom } = route;
    const d = `M${x1} ${y1}` + bend(x1, y1, route.via, top) + (bottom > top ? ` L${route.via} ${bottom}` : '') + bend(route.via, bottom, x2, y2);
    return `<path d="${d}" fill="none" stroke="${color}" stroke-width="1.6" class="gg-edge gg-edge-${style}"/>`;
  }
  let d;
  if (x1 === x2) {
    d = `M${x1} ${y1} L${x2} ${y2}`;
  } else if (style === 'angular') {
    const midY = (y1 + y2) / 2;
    d = `M${x1} ${y1} L${x1} ${midY} L${x2} ${midY} L${x2} ${y2}`;
  } else {
    const c1y = y1 + (y2 - y1) * 0.5;
    const c2y = y1 + (y2 - y1) * 0.5;
    d = `M${x1} ${y1} C${x1} ${c1y}, ${x2} ${c2y}, ${x2} ${y2}`;
  }
  return `<path d="${d}" fill="none" stroke="${color}" stroke-width="1.6" class="gg-edge gg-edge-${style}"/>`;
}

function gitGraphNodeCircle(cx, cy, color, opts = {}) {
  const r = GG_NODE_RADIUS;
  const cls = `gg-node gg-node-${opts.kind || 'normal'}`;
  if (opts.diamond) {
    const pts = `${cx},${cy - r} ${cx + r},${cy} ${cx},${cy + r} ${cx - r},${cy}`;
    return `<polygon points="${pts}" fill="${color}" class="${cls}"/>`;
  }
  if (opts.hollow) {
    return `<circle cx="${cx}" cy="${cy}" r="${r}" fill="#14141a" stroke="${color}" stroke-width="2" class="${cls}"/>`;
  }
  return `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${color}" class="${cls}"/>`;
}

// --- Reference-label pills ---

/**
 * Builds the pill markup for one commit's local/remote/tag/HEAD refs. Local +
 * remote branches on the same commit render as one *combined* pill pair with
 * two independently hit-testable regions (data-gg-ref-type='local'|'remote').
 */
function gitGraphIcon(name, size) {
  if (typeof PICONS !== 'undefined' && typeof PICONS[name] === 'function') return PICONS[name](size);
  return GG_FALLBACK_ICONS[name] || '';
}

// Same viewBox/stroke conventions as PICONS (stroke-width 2, round caps/joins) —
// only reached when this file is loaded without projects-view.js, e.g. in isolation
// by a test; the real app always has PICONS.branch/.tag by the time this runs.
const GG_FALLBACK_ICONS = {
  branch: '<svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3v12"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/></svg>',
  tag: '<svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12.586 2.586A2 2 0 0 0 11.172 2H4a2 2 0 0 0-2 2v7.172a2 2 0 0 0 .586 1.414l8.704 8.704a2.426 2.426 0 0 0 3.42 0l6.58-6.58a2.426 2.426 0 0 0 0-3.42Z"/><circle cx="7.5" cy="7.5" r="1.5"/></svg>',
};

function gitGraphRefName(entry) {
  return typeof entry === 'string' ? entry : (entry && entry.name);
}

/**
 * `commit.refs.heads`/`.tags` come back from git-graph-service.js as plain
 * name strings (only `.remotes` entries are `{remote, name}` objects) — this
 * function accepts either shape defensively, but the real payload is strings.
 * `opts.headBranchName` (the checked-out branch's name, from the top-level
 * RefSet's `heads[].isHead`, not carried per-commit) is what decides which
 * local-branch pill on a HEAD commit gets the HEAD emphasis.
 */
function gitGraphRenderRefPills(commit, opts = {}) {
  const combine = opts.combineLocalAndRemote !== false;
  const refs = commit.refs || { heads: [], remotes: [], tags: [] };
  const pills = [];
  const usedRemotes = new Set();
  const eh = (typeof escapeAttr === 'function') ? escapeAttr : (s => String(s == null ? '' : s));

  for (const headEntry of refs.heads || []) {
    const name = gitGraphRefName(headEntry);
    if (!name) continue;
    const isHead = !!commit.isHead && (opts.headBranchName ? name === opts.headBranchName : true);
    const matchingRemote = combine ? (refs.remotes || []).find(r => r.name === name && !usedRemotes.has(`${r.remote}/${r.name}`)) : null;
    let html = `<span class="gg-pill gg-pill-local${isHead ? ' gg-pill-head' : ''}" data-gg-kind="branch" data-gg-ref-name="${eh(name)}" data-gg-hash="${eh(commit.hash)}"${matchingRemote ? ` data-gg-ref-type="local"` : ''} title="${eh(name)}">${gitGraphIcon('branch', 9)}<span>${eh(name)}</span></span>`;
    if (matchingRemote) {
      usedRemotes.add(`${matchingRemote.remote}/${matchingRemote.name}`);
      html += `<span class="gg-pill gg-pill-remote gg-pill-combined" data-gg-kind="remote-branch" data-gg-ref-name="${eh(matchingRemote.name)}" data-gg-remote="${eh(matchingRemote.remote)}" data-gg-ref-type="remote" data-gg-hash="${eh(commit.hash)}" title="${eh(matchingRemote.remote)}/${eh(matchingRemote.name)}"><span>${eh(matchingRemote.remote)}</span></span>`;
    }
    pills.push(html);
  }

  for (const remote of refs.remotes || []) {
    const key = `${remote.remote}/${remote.name}`;
    if (usedRemotes.has(key)) continue;
    pills.push(`<span class="gg-pill gg-pill-remote" data-gg-kind="remote-branch" data-gg-ref-name="${eh(remote.name)}" data-gg-remote="${eh(remote.remote)}" data-gg-hash="${eh(commit.hash)}" title="${eh(remote.remote)}/${eh(remote.name)}"><span>${eh(remote.remote)}/${eh(remote.name)}</span></span>`);
  }

  for (const tagEntry of refs.tags || []) {
    const name = gitGraphRefName(tagEntry);
    if (!name) continue;
    pills.push(`<span class="gg-pill gg-pill-tag" data-gg-kind="tag" data-gg-ref-name="${eh(name)}" data-gg-hash="${eh(commit.hash)}" title="${eh(name)}">${gitGraphIcon('tag', 9)}<span>${eh(name)}</span></span>`);
  }

  return pills.join('');
}

// --- Row muting / selection classes ---

function gitGraphRowClasses(row, opts = {}) {
  const classes = ['gg-row'];
  const isMerge = (row.parents || []).length > 1;
  if (opts.muteMergeCommits !== false && isMerge && row.kind !== 'stash' && row.kind !== 'uncommitted') classes.push('gg-muted');
  if (row.kind === 'stash') classes.push('gg-row-stash');
  if (row.kind === 'uncommitted') classes.push('gg-row-uncommitted');
  if (row.selected) classes.push('gg-row-selected');
  if (row.compareSelected) classes.push('gg-row-compare-selected');
  return classes.join(' ');
}

// --- Commit-details file list ---

function gitGraphDiffStatHtml(file) {
  const parts = [];
  if (file.insertions) parts.push(`<span class="gg-diffstat-add">+${file.insertions}</span>`);
  if (file.deletions) parts.push(`<span class="gg-diffstat-del">-${file.deletions}</span>`);
  return parts.length ? `<span class="gg-diffstat">${parts.join(' ')}</span>` : '';
}

const GG_STATUS_BADGE = { added: 'A', modified: 'M', deleted: 'D', renamed: 'R', untracked: 'U', conflicted: '!' };

function gitGraphStatusBadge(status) {
  return GG_STATUS_BADGE[status] || 'M';
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    GG_DEFAULT_PALETTE, GG_ROW_HEIGHT, GG_LANE_WIDTH,
    gitGraphPaletteColor, gitGraphFormatDate, gitGraphFormatRelative, gitGraphFormatFullDate,
    gitGraphBuildLayoutInput, gitGraphFallbackLayout, gitGraphResolveLayoutFn,
    gitGraphRenderGraphSvg, gitGraphRenderRefPills, gitGraphRowClasses, gitGraphIcon, gitGraphRefName,
    gitGraphDiffStatHtml, gitGraphStatusBadge,
  };
}
