const test = require('node:test');
const assert = require('node:assert/strict');

const { computeGitGraphLayout } = require('../public/git-graph-layout');

// viaLane (the lane an edge runs down) is covered by its own test below.
const withoutVia = ({ viaLane, ...edge }) => edge;

// Fixtures below list commits newest-first, exactly as `git log` (and so
// `git-graph-service.js`) hands them to the layout function — row 0 is the
// top of the graph.

test('linear history: one lane, one colour, straight same-lane edges down to the root', () => {
  const commits = [
    { hash: 'c4', parents: ['c3'] },
    { hash: 'c3', parents: ['c2'] },
    { hash: 'c2', parents: ['c1'] },
    { hash: 'c1', parents: [] },
  ];
  const rows = computeGitGraphLayout(commits, 'date');
  assert.equal(rows.length, 4);
  for (const row of rows) assert.equal(row.lane, 0);
  assert.equal(rows[0].colorIndex, rows[1].colorIndex);
  assert.equal(rows[1].colorIndex, rows[2].colorIndex);
  assert.deepEqual(rows[0].edges.map(withoutVia), [{ parentHash: 'c3', toLane: 0, style: 'same-lane' }]);
  assert.deepEqual(rows[2].edges.map(withoutVia), [{ parentHash: 'c1', toLane: 0, style: 'same-lane' }]);
  assert.deepEqual(rows[3].edges.map(withoutVia), [], 'root commit has no outgoing edges');
});

test('two branches that never touch get distinct, stable lanes and colours', () => {
  const commits = [
    { hash: 'b2', parents: ['b1'] },
    { hash: 'a2', parents: ['a1'] },
    { hash: 'b1', parents: [] },
    { hash: 'a1', parents: [] },
  ];
  const rows = computeGitGraphLayout(commits);
  const byHash = Object.fromEntries(rows.map(r => [r.hash, r]));
  assert.notEqual(byHash.b2.lane, byHash.a2.lane);
  assert.notEqual(byHash.b2.colorIndex, byHash.a2.colorIndex);
  assert.equal(byHash.b1.lane, byHash.b2.lane);
  assert.equal(byHash.a1.lane, byHash.a2.lane);
  for (const row of rows) {
    for (const edge of row.edges) assert.notEqual(edge.style, 'merge-in', 'independent branches never converge');
  }
});

test('normal 2-parent merge: mainline colour survives; feature branch reconverges on the shared grandparent (step 2c)', () => {
  // main1 and feat1 are each ordinary single-parent commits that happen to
  // share a grandparent ('base') via their OWN first-parent link — a real,
  // common shape (two branches independently forked from `base`, merged by
  // `m`) — so `base` is a genuine multi-lane convergence (step 2c), not the
  // merge-commit-reuse dedup path (step 2e, covered by its own test below).
  const commits = [
    { hash: 'm', parents: ['main1', 'feat1'] },
    { hash: 'main1', parents: ['base'] },
    { hash: 'feat1', parents: ['base'] },
    { hash: 'base', parents: [] },
  ];
  const rows = computeGitGraphLayout(commits, 'topo');
  const byHash = Object.fromEntries(rows.map(r => [r.hash, r]));

  assert.equal(byHash.m.lane, 0);
  assert.deepEqual(byHash.m.edges.map(withoutVia), [
    { parentHash: 'main1', toLane: 0, style: 'same-lane' },
    { parentHash: 'feat1', toLane: 1, style: 'branch-out' },
  ]);
  assert.equal(byHash.main1.lane, 0);
  assert.equal(byHash.main1.colorIndex, byHash.m.colorIndex);
  assert.equal(byHash.feat1.lane, 1);
  assert.notEqual(byHash.feat1.colorIndex, byHash.main1.colorIndex);
  // Both main1 and feat1 independently await `base` via their own
  // first-parent edge; main1's (lower-indexed, and it's the only candidate
  // either way) wins, and feat1's own edge is corrected to merge in.
  assert.equal(byHash.base.lane, 0);
  assert.equal(byHash.base.colorIndex, byHash.main1.colorIndex);
  assert.deepEqual(byHash.feat1.edges.map(withoutVia), [{ parentHash: 'base', toLane: 0, style: 'merge-in' }]);
  const maxLane = Math.max(...rows.map(r => r.lane));
  assert.equal(maxLane, 1, 'no lane beyond the two genuinely concurrent lines was ever allocated');
});

test('additional-parent lane dedup (step 2e): a merge\'s second parent already awaited by another lane gets no new lane', () => {
  // z opens its own line toward `y`. By the time merge commit `m` is
  // processed, z's lane is already awaiting `y` — so m's second parent
  // must draw straight into that existing lane, not open a third one, and
  // must NOT trigger any merge-in demotion at all (there is no ambiguity
  // left to resolve once the edge already agrees on the target lane).
  const commits = [
    { hash: 'z', parents: ['y'] },
    { hash: 'm', parents: ['x', 'y'] },
    { hash: 'x', parents: [] },
    { hash: 'y', parents: [] },
  ];
  const rows = computeGitGraphLayout(commits);
  const byHash = Object.fromEntries(rows.map(r => [r.hash, r]));

  assert.deepEqual(byHash.z.edges.map(withoutVia), [{ parentHash: 'y', toLane: 0, style: 'same-lane' }], 'never demoted');
  assert.deepEqual(byHash.m.edges.map(withoutVia), [
    { parentHash: 'x', toLane: 1, style: 'same-lane' },
    { parentHash: 'y', toLane: 0, style: 'branch-out' },
  ]);
  assert.equal(byHash.y.lane, 0);
  assert.equal(byHash.x.lane, 1);
  const maxLane = Math.max(...rows.map(r => r.lane));
  assert.equal(maxLane, 1, 'the reused lane means only two lanes were ever needed');
});

test('octopus merge: every extra parent gets its own branch-out lane and edge', () => {
  const commits = [
    { hash: 'm', parents: ['a', 'b', 'c'] },
    { hash: 'a', parents: [] },
    { hash: 'b', parents: [] },
    { hash: 'c', parents: [] },
  ];
  const rows = computeGitGraphLayout(commits);
  const byHash = Object.fromEntries(rows.map(r => [r.hash, r]));
  assert.deepEqual(byHash.m.edges.map(e => e.style), ['same-lane', 'branch-out', 'branch-out']);
  const lanes = byHash.m.edges.map(e => e.toLane);
  assert.deepEqual(new Set(lanes).size, 3, 'three distinct parents get three distinct lanes');
  assert.equal(byHash.a.lane, byHash.m.edges[0].toLane);
  assert.equal(byHash.b.lane, byHash.m.edges[1].toLane);
  assert.equal(byHash.c.lane, byHash.m.edges[2].toLane);
});

test('root commit reached mid-window frees its lane for reuse; a shallow-clone boundary is the identical case', () => {
  const commits = [
    { hash: 'x2', parents: ['x1'] },
    { hash: 'x1', parents: [] }, // root (or a shallow-clone boundary — same zero-parent shape)
    { hash: 'y1', parents: [] }, // a later, unrelated tip
  ];
  const rows = computeGitGraphLayout(commits);
  const byHash = Object.fromEntries(rows.map(r => [r.hash, r]));
  assert.equal(byHash.x1.edges.length, 0);
  // The freed lane (0) is reused for the next new tip...
  assert.equal(byHash.y1.lane, 0);
  // ...but colour is not forced to follow the lane: two unrelated branches
  // never share both a column and a colour back to back.
  assert.notEqual(byHash.y1.colorIndex, byHash.x2.colorIndex);
});

test('lane-reuse keeps column count minimal across many sequential open/close cycles', () => {
  const commits = [];
  for (let i = 0; i < 20; i++) commits.push({ hash: `t${i}`, parents: [] });
  const rows = computeGitGraphLayout(commits);
  const maxLane = Math.max(...rows.map(r => r.lane));
  assert.equal(maxLane, 0, 'sequential, non-overlapping tips must all reuse lane 0, never grow monotonically');
  // Colour still advances every allocation, cycling through the palette.
  assert.deepEqual(rows.map(r => r.colorIndex), Array.from({ length: 20 }, (_, i) => i % 12));
});

test('merge-convergence colour continuity: the first-parent-descending lane wins even against a lower lane index', () => {
  // m merges mainline (-> a) and a branch-out (-> w); p is a second,
  // independent first-parent line that also happens to land on w. w is
  // awaited by lane1 (branch-out, allocated first, lower index) AND lane2
  // (first-parent, allocated second, higher index) — the algorithm must
  // pick lane2 anyway, and correct m's now-stale branch-out edge in place.
  const commits = [
    { hash: 'm', parents: ['a', 'w'] },
    { hash: 'p', parents: ['w'] },
    { hash: 'a', parents: [] },
    { hash: 'w', parents: ['base'] },
    { hash: 'base', parents: [] },
  ];
  const rows = computeGitGraphLayout(commits);
  const byHash = Object.fromEntries(rows.map(r => [r.hash, r]));

  // p is allocated only after m's own two lanes (0 for m itself, 1 for its
  // branch-out toward w) already exist, so p's lane is the higher index —
  // exactly the case that would lose under a plain "lowest index" rule.
  assert.equal(byHash.p.lane, 2);

  assert.equal(byHash.w.lane, 2, 'the higher-indexed first-parent lane wins the convergence, not lane 1');
  assert.equal(byHash.w.colorIndex, byHash.p.colorIndex, 'w keeps the winning lane\'s colour');
  assert.notEqual(byHash.w.colorIndex, byHash.m.colorIndex, 'w does NOT inherit m\'s own lane colour');

  // The losing lane's edge, recorded back when `m` was processed, is
  // corrected in place — not replaced, not left stale — once the
  // convergence at `w` resolves later in the same pass.
  assert.deepEqual(withoutVia(byHash.m.edges[1]), { parentHash: 'w', toLane: 2, style: 'merge-in' });

  assert.equal(byHash.base.lane, 2);
  assert.equal(byHash.base.colorIndex, byHash.w.colorIndex);
});

test('stash and Uncommitted pseudo-commits lay out with zero special-casing, including converging on a shared parent', () => {
  const commits = [
    { hash: '#uncommitted', parents: ['head'], kind: 'uncommitted' },
    { hash: 'stash1', parents: ['head'], kind: 'stash' },
    { hash: 'head', parents: ['base'] },
    { hash: 'base', parents: [] },
  ];
  const rows = computeGitGraphLayout(commits);
  const byHash = Object.fromEntries(rows.map(r => [r.hash, r]));

  assert.equal(byHash['#uncommitted'].lane, 0);
  assert.equal(byHash.stash1.lane, 1);
  // Both pseudo-commits list `head` as their own first parent, so they
  // independently converge on it exactly like two ordinary sibling commits
  // would; the lower-indexed lane (Uncommitted's) wins the tie between two
  // equally first-parent-tagged lanes, and stash1's edge is corrected.
  assert.equal(byHash.head.lane, 0);
  assert.deepEqual(withoutVia(byHash.stash1.edges[0]), { parentHash: 'head', toLane: 0, style: 'merge-in' });
  assert.deepEqual(byHash.head.edges.map(withoutVia), [{ parentHash: 'base', toLane: 0, style: 'same-lane' }]);
  assert.equal(byHash.base.lane, 0);
});

test('a single stash cleanly attaches to its base commit\'s row when nothing else contends for it', () => {
  const commits = [
    { hash: 'stash1', parents: ['base'], kind: 'stash' },
    { hash: 'head', parents: ['base'] },
    { hash: 'base', parents: [] },
  ];
  const rows = computeGitGraphLayout(commits);
  const byHash = Object.fromEntries(rows.map(r => [r.hash, r]));
  assert.equal(byHash.stash1.lane, 0);
  assert.deepEqual(byHash.stash1.edges.map(withoutVia), [{ parentHash: 'base', toLane: 0, style: 'same-lane' }]);
  // head, a second independent tip, gets its own lane and later converges
  // on base too, exercising the same general mechanism once more.
  assert.notEqual(byHash.head.lane, byHash.stash1.lane);
  assert.equal(byHash.base.lane === byHash.stash1.lane || byHash.base.lane === byHash.head.lane, true);
});

test('output is stable and deterministic given the same input twice', () => {
  const commits = [
    { hash: 'm', parents: ['a', 'w'] },
    { hash: 'p', parents: ['w'] },
    { hash: 'a', parents: [] },
    { hash: 'w', parents: ['base'] },
    { hash: 'base', parents: [] },
  ];
  const first = computeGitGraphLayout(commits, 'date');
  const second = computeGitGraphLayout(commits, 'date');
  assert.deepStrictEqual(first, second);
});

test('the order argument is accepted for the frozen call shape but never changes the result', () => {
  const commits = [
    { hash: 'm', parents: ['main1', 'feat1'] },
    { hash: 'main1', parents: ['base'] },
    { hash: 'feat1', parents: ['base'] },
    { hash: 'base', parents: [] },
  ];
  const byDate = computeGitGraphLayout(commits, 'date');
  const byAuthorDate = computeGitGraphLayout(commits, 'author-date');
  const byTopo = computeGitGraphLayout(commits, 'topo');
  const noOrder = computeGitGraphLayout(commits);
  assert.deepStrictEqual(byDate, byAuthorDate);
  assert.deepStrictEqual(byDate, byTopo);
  assert.deepStrictEqual(byDate, noOrder);
});

test('firstParentOnly suppresses every non-first parent\'s lane and edge entirely', () => {
  const commits = [
    { hash: 'm', parents: ['a', 'b', 'c'] },
    { hash: 'a', parents: [] },
    { hash: 'b', parents: [] },
    { hash: 'c', parents: [] },
  ];
  const rows = computeGitGraphLayout(commits, 'date', { firstParentOnly: true });
  const byHash = Object.fromEntries(rows.map(r => [r.hash, r]));
  assert.deepEqual(byHash.m.edges.map(withoutVia), [{ parentHash: 'a', toLane: 0, style: 'same-lane' }]);
  // b and c are never awaited at all now: nothing in the whole output points
  // at them (contrast the plain octopus test above, where m.edges lists
  // both). They still surface as rows (the caller decided what's in the
  // window, not this function) but purely as independent, unconnected tips.
  const referenced = new Set();
  for (const row of rows) for (const edge of row.edges) referenced.add(edge.parentHash);
  assert.equal(referenced.has('b'), false);
  assert.equal(referenced.has('c'), false);
  assert.equal(referenced.has('a'), true);
});

test('incremental re-layout ("Load More") matches laying out the combined window from scratch, including a cross-page convergence fix-up', () => {
  const all = [
    { hash: 'm', parents: ['a', 'w'] },
    { hash: 'p', parents: ['w'] },
    { hash: 'a', parents: [] },
    { hash: 'w', parents: ['base'] },
    { hash: 'base', parents: [] },
  ];
  const fresh = computeGitGraphLayout(all, 'date');

  const firstPage = all.slice(0, 2); // m, p
  const secondPage = all.slice(2); // a, w, base
  const firstResult = computeGitGraphLayout(firstPage, 'date');
  const secondResult = computeGitGraphLayout(secondPage, 'date', { priorState: firstResult.state });

  // `row` is local to each call (always the index within that call's own
  // array) and is expected to differ between the fresh and incremental
  // runs; compare everything else.
  const strip = rows => rows.map(({ row, ...rest }) => rest);
  assert.deepStrictEqual(strip(secondResult), strip(fresh.slice(2)));

  // The convergence at `w` started on the first page (m's branch-out edge)
  // but only resolves on the second page — proving the first page's
  // already-returned row was corrected in place, not left stale.
  assert.deepStrictEqual(firstResult[0].edges[1], fresh[0].edges[1]);
  assert.deepEqual(withoutVia(firstResult[0].edges[1]), { parentHash: 'w', toLane: 2, style: 'merge-in' });
});

test('incremental re-layout also matches from-scratch on a purely linear split (no cross-page convergence)', () => {
  const all = [];
  for (let i = 9; i >= 0; i--) all.push({ hash: `c${i}`, parents: i > 0 ? [`c${i - 1}`] : [] });
  const fresh = computeGitGraphLayout(all);
  const firstResult = computeGitGraphLayout(all.slice(0, 4), null);
  const secondResult = computeGitGraphLayout(all.slice(4), null, { priorState: firstResult.state });
  const strip = rows => rows.map(({ row, ...rest }) => rest);
  assert.deepStrictEqual(strip(firstResult), strip(fresh.slice(0, 4)));
  assert.deepStrictEqual(strip(secondResult), strip(fresh.slice(4)));
});

test('empty and single-commit inputs degrade gracefully', () => {
  assert.deepEqual(computeGitGraphLayout([]), []);
  assert.deepEqual(computeGitGraphLayout(null), []);
  const one = computeGitGraphLayout([{ hash: 'only', parents: [] }]);
  assert.equal(one.length, 1);
  assert.equal(one[0].lane, 0);
  assert.deepEqual(one[0].edges.map(withoutVia), []);
});

// --- G.1 performance smoke test: a large synthetic history, generated once,
// standing in for the plan's 10k-commit/2k-ref fixture. This module has no
// concept of "refs" (that is `git-graph-service.js`'s job) so the synthetic
// history instead drives roughly 2,000 fork events over 10,000 commits,
// bounding concurrent open lines the way a real repo's branch churn does,
// to give the O(N+E) claim something non-trivial to run against. ---

function makeRng(seed) {
  let state = seed >>> 0;
  return function rng() {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function buildSyntheticHistory(commitCount, targetForkCount) {
  const rng = makeRng(0x9e3779b9);
  const commits = [{ hash: 'g0', parents: [] }]; // chronological (oldest-first) while building
  let tips = ['g0'];
  let forkCount = 0;
  const maxConcurrentTips = 64;

  while (commits.length < commitCount) {
    const roll = rng();
    if (tips.length > 1 && (roll < 0.15 || tips.length >= maxConcurrentTips)) {
      // Merge two open tips back together.
      const i = Math.floor(rng() * tips.length);
      let j = Math.floor(rng() * tips.length);
      if (j === i) j = (j + 1) % tips.length;
      const hash = `g${commits.length}`;
      commits.push({ hash, parents: [tips[i], tips[j]] });
      tips[i] = hash;
      tips.splice(j, 1);
    } else if (forkCount < targetForkCount && roll < 0.35 && tips.length < maxConcurrentTips) {
      // Fork a new line off an existing tip (both continue from here on).
      const i = Math.floor(rng() * tips.length);
      tips.push(tips[i]);
      forkCount += 1;
    } else {
      // Plain linear continuation of a random open tip.
      const i = Math.floor(rng() * tips.length);
      const hash = `g${commits.length}`;
      commits.push({ hash, parents: [tips[i]] });
      tips[i] = hash;
    }
  }
  commits.reverse(); // newest-first, matching `git log`'s own order
  return { commits, forkCount };
}

test('performance smoke test: ~10k commits / ~2k fork events lay out well within budget', () => {
  const { commits, forkCount } = buildSyntheticHistory(10000, 2000);
  assert.equal(commits.length, 10000);
  assert.ok(forkCount >= 500, `expected substantial forking activity, got ${forkCount} forks`);

  const startedAt = Date.now();
  const rows = computeGitGraphLayout(commits, 'topo');
  const elapsedMs = Date.now() - startedAt;

  assert.equal(rows.length, 10000);
  for (const row of rows) {
    assert.ok(Number.isInteger(row.lane) && row.lane >= 0);
    assert.ok(Number.isInteger(row.colorIndex) && row.colorIndex >= 0);
  }
  const maxLane = Math.max(...rows.map(r => r.lane));
  assert.ok(maxLane < 200, `lane count should stay well bounded by reuse, got ${maxLane + 1} lanes`);
  assert.ok(elapsedMs < 3000, `expected a linear-time layout well under 3s, took ${elapsedMs}ms`);
});

test('an edge keeps the lane it runs down (viaLane) when a convergence moves its parent into another lane', () => {
  // m merges feat (lane 1); feat's line later converges into base on lane 0.
  const rows = computeGitGraphLayout([
    { hash: 'm', parents: ['main1', 'feat1'] },
    { hash: 'main1', parents: ['base'] },
    { hash: 'feat1', parents: ['base'] },
    { hash: 'base', parents: [] },
  ], 'date');
  const feat = rows.find(r => r.hash === 'feat1');
  assert.equal(feat.edges[0].toLane, 0);
  assert.equal(feat.edges[0].viaLane, feat.lane);
  assert.notEqual(feat.edges[0].viaLane, feat.edges[0].toLane);
});
