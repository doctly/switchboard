// git-graph-layout.js — pure DAG lane assignment for the Git Graph tab.
//
// Turns an ordered Commit[] (already sorted by whichever commit order the
// caller asked git for — date / author-date / topo — and already carrying
// any stash/Uncommitted pseudo-commits already merged in) into one
// lane/colour/edge assignment per commit. No DOM, no window, no git: this
// file only ever looks at `hash`/`parents`, so it loads unchanged in a
// <script> tag or in plain node for tests. The one global it installs is
// `computeGitGraphLayout` — the exact name `git-graph-render.js`'s own
// fallback layout already probes for (`typeof computeGitGraphLayout ===
// 'function'`), so this file simply "arrives" once loaded, no wiring needed.
//
// Algorithm (one top-to-bottom pass, newest row first — exactly the order
// `git log` already returns):
//   - a lane "awaits" the hash of the commit it expects to reach further
//     down; a commit nothing awaits is a new tip (allocate the lowest free
//     lane index and the next palette colour);
//   - a commit awaited by exactly one lane continues in that lane, same
//     colour — this is what keeps one line of history one consistent colour;
//   - a commit awaited by several lanes at once (independent lines
//     reconverging) keeps the first-parent-descending lane's colour and
//     frees the others, rewriting their already-recorded edges to merge into
//     the winner instead of letting mainline colour jump to whichever lane
//     happened to have the lower index;
//   - a merge commit's non-first parents either draw straight into whatever
//     lane already awaits that parent (no new column — the common
//     trunk-based-workflow case) or open a fresh 'branch-out' lane when
//     nothing does yet.
// Every edge object stays live inside the row that owns it; a later
// convergence corrects that exact object's `toLane`/`style` in place, never
// a copy. That is also what makes "Load More" cheap and exactly equivalent
// to laying out the combined window from scratch: the previous page's rows
// are never rebuilt, only (rarely) mutated in place, when a convergence that
// started on the previous page finally resolves on the new one.

(function (root) {
  const DEFAULT_PALETTE_SIZE = 12;

  function toHash(value) {
    return value == null ? '' : String(value);
  }

  // Reverse index: which lanes currently await a given hash. Kept as its own
  // tiny object (not inlined) so the incremental-append snapshot/restore below
  // has one obvious place to copy from/into.
  function makeAwaitedIndex() {
    const byHash = new Map();
    return {
      add(hash, lane) {
        let lanes = byHash.get(hash);
        if (!lanes) { lanes = new Set(); byHash.set(hash, lanes); }
        lanes.add(lane);
      },
      lanesFor(hash) {
        const lanes = byHash.get(hash);
        return lanes ? Array.from(lanes) : [];
      },
      clear(hash) { byHash.delete(hash); },
      snapshot() {
        const copy = new Map();
        for (const [hash, lanes] of byHash) copy.set(hash, new Set(lanes));
        return copy;
      },
      restore(snapshot) {
        byHash.clear();
        for (const [hash, lanes] of snapshot) byHash.set(hash, new Set(lanes));
      },
    };
  }

  // Prefer a first-parent-descending lane among those awaiting the same hash
  // (mainline colour continuity through a convergence); only when none of
  // them are first-parent does the lowest lane index win. A tie within
  // either pool also falls back to the lowest index, so the result never
  // depends on Set/array insertion order.
  function chooseConvergenceWinner(lanes, activeLanes) {
    let pool = lanes.filter(lane => activeLanes.get(lane).kind === 'first-parent');
    if (!pool.length) pool = lanes;
    let winner = pool[0];
    for (let i = 1; i < pool.length; i++) if (pool[i] < winner) winner = pool[i];
    return winner;
  }

  function lowestOf(lanes) {
    let best = lanes[0];
    for (let i = 1; i < lanes.length; i++) if (lanes[i] < best) best = lanes[i];
    return best;
  }

  /**
   * (commits, order, options?) -> laneAssignments
   *
   * `order` is accepted to match the frozen call shape but never
   * inspected here — commits arrive pre-sorted by whichever order the caller
   * asked git for ('date' | 'author-date' | 'topo'); this algorithm just
   * walks them top to bottom, whatever that order is.
   *
   * `options` (all optional):
   *   firstParentOnly — when true, every parent after the first is ignored
   *     entirely (no lane, no edge) for a repo's "Only Follow First Parent"
   *     view, instead of leaving dangling branch-out lanes that this loaded
   *     window's --first-parent history can never resolve.
   *   paletteSize — colours cycle mod this size (default 12, matching the
   *     default 12-lane palette). Purely a modulus for `colorIndex`;
   *     this file never touches an actual colour value.
   *   priorState — the `.state` a previous call returned, to lay out a
   *     "Load More" page's new commits only, continuing exactly where the
   *     previous call left off.
   *
   * Returns a plain Array, one entry per input commit, same order:
   *   { hash, lane, colorIndex, edges, row }
   * where `edges` are that commit's own outgoing edges toward its parents:
   *   { parentHash, toLane, viaLane, style: 'same-lane' | 'branch-out' | 'merge-in' }
   * `viaLane` is the lane the edge runs down; `toLane` is where the parent
   * ends up (they differ once a convergence merges that lane into another).
   * The array also carries a non-enumerable `.state` for the next
   * incremental call — plain iteration, `.length`, `JSON.stringify`, etc. of
   * the array are unaffected by it.
   */
  function computeGitGraphLayout(commits, order, options) {
    const opts = options || {};
    const firstParentOnly = !!opts.firstParentOnly;
    const paletteSize = opts.paletteSize > 0 ? opts.paletteSize : DEFAULT_PALETTE_SIZE;
    const prior = opts.priorState || null;

    const activeLanes = new Map(); // lane -> { kind: 'first-parent'|'branch-out', color, pendingEdges: Edge[] }
    const awaited = makeAwaitedIndex();
    // Free-lane pool stays a small unsorted array: concurrent lane counts are
    // "rarely more than a few dozen even in busy repos", so a
    // linear min-scan on allocate is simpler than a heap and negligible next
    // to the O(N) main pass.
    let freeLanes = [];
    let nextNewLane = 0;
    let colorCounter = 0;

    if (prior) {
      for (const [lane, info] of prior.activeLanes) {
        activeLanes.set(lane, { kind: info.kind, color: info.color, pendingEdges: info.pendingEdges.slice() });
      }
      awaited.restore(prior.awaited);
      freeLanes = prior.freeLanes.slice();
      nextNewLane = prior.nextNewLane;
      colorCounter = prior.colorCounter;
    }

    function allocateLane() {
      if (freeLanes.length) {
        let best = 0;
        for (let i = 1; i < freeLanes.length; i++) if (freeLanes[i] < freeLanes[best]) best = i;
        return freeLanes.splice(best, 1)[0];
      }
      const lane = nextNewLane;
      nextNewLane += 1;
      return lane;
    }
    function freeLane(lane) {
      activeLanes.delete(lane);
      freeLanes.push(lane);
    }
    function nextColorIndex() {
      const value = colorCounter % paletteSize;
      colorCounter += 1;
      return value;
    }

    const list = Array.isArray(commits) ? commits : [];
    const rows = [];

    for (let i = 0; i < list.length; i++) {
      const commit = list[i] || {};
      const hash = toHash(commit.hash);
      const parents = Array.isArray(commit.parents) ? commit.parents.map(toHash) : [];
      const awaiting = awaited.lanesFor(hash);
      let lane, colorIndex;

      if (awaiting.length === 0) {
        // A brand-new tip (a branch head, or simply the top of the loaded
        // window) — starts life tagged 'first-parent': it has no
        // merge-derived origin yet, so a later convergence should not treat
        // it as the "lesser" side.
        lane = allocateLane();
        colorIndex = nextColorIndex();
      } else {
        lane = chooseConvergenceWinner(awaiting, activeLanes);
        colorIndex = activeLanes.get(lane).color;
        for (const loser of awaiting) {
          if (loser === lane) continue;
          const info = activeLanes.get(loser);
          for (const edge of info.pendingEdges) {
            edge.toLane = lane;
            edge.style = 'merge-in';
          }
          freeLane(loser);
        }
        awaited.clear(hash);
      }

      const edges = [];
      if (parents.length === 0) {
        // Root commit reached within the loaded window, or a shallow-clone
        // boundary commit — the two are structurally identical
        // here, deliberately: this lane simply has nowhere further to go.
        freeLane(lane);
      } else {
        const firstEdge = { parentHash: parents[0], toLane: lane, viaLane: lane, style: 'same-lane' };
        edges.push(firstEdge);
        activeLanes.set(lane, { kind: 'first-parent', color: colorIndex, pendingEdges: [firstEdge] });
        awaited.add(parents[0], lane);

        if (!firstParentOnly) {
          for (let p = 1; p < parents.length; p++) {
            const parentHash = parents[p];
            const already = awaited.lanesFor(parentHash);
            if (already.length) {
              // Some other lane already awaits this parent (the common
              // trunk-based-workflow case) — draw straight into it, no new
              // column, `activeLanes` otherwise unchanged. This edge is
              // still recorded in that lane's `pendingEdges` so a later
              // convergence that demotes the lane also corrects this edge.
              const reuseLane = lowestOf(already);
              const edge = { parentHash, toLane: reuseLane, viaLane: reuseLane, style: 'branch-out' };
              edges.push(edge);
              activeLanes.get(reuseLane).pendingEdges.push(edge);
            } else {
              const newLane = allocateLane();
              const edge = { parentHash, toLane: newLane, viaLane: newLane, style: 'branch-out' };
              edges.push(edge);
              activeLanes.set(newLane, { kind: 'branch-out', color: nextColorIndex(), pendingEdges: [edge] });
              awaited.add(parentHash, newLane);
            }
          }
        }
      }

      rows.push({ hash, lane, colorIndex, edges, row: i });
    }

    const state = {
      activeLanes: new Map(Array.from(activeLanes, ([lane, info]) =>
        [lane, { kind: info.kind, color: info.color, pendingEdges: info.pendingEdges.slice() }])),
      awaited: awaited.snapshot(),
      freeLanes: freeLanes.slice(),
      nextNewLane,
      colorCounter,
    };
    Object.defineProperty(rows, 'state', { value: state, enumerable: false, configurable: true });
    return rows;
  }

  const api = { computeGitGraphLayout };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else Object.assign(root, api);
})(typeof window !== 'undefined' ? window : globalThis);
