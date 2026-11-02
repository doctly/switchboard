// The Worktrees tab's pure parts: order, filter, session counts, rows and
// menus. public/project-worktrees-view.js only defines functions and a Map at
// top level, so it loads whole in a vm context given the renderer's globals.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../public/project-worktrees-view.js'), 'utf8');

function loadContext(extra = {}) {
  const icon = name => () => `<svg data-icon="${name}"></svg>`;
  const context = vm.createContext({
    window: { api: { platform: 'darwin' } },
    escapeHtml: (str) => String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
    pathBasename: (p) => String(p).split(/[\\/]/).filter(Boolean).pop() || '',
    isPathInside: (child, root) => child === root || child.startsWith(root + '/'),
    formatDate: () => '2d ago',
    PICONS: new Proxy({}, { get: (_t, name) => icon(name) }),
    ICONS: new Proxy({}, { get: (_t, name) => icon(name) }),
    ...extra,
  });
  vm.runInContext(source, context);
  return context;
}

// Values built in the vm are objects of its realm; a JSON round-trip makes
// them comparable with deepEqual here.
const plain = value => JSON.parse(JSON.stringify(value));

function wt(p, extra = {}) {
  return {
    path: p, head: 'abcdef1234567890', branch: '', detached: false, bare: false,
    locked: false, lockReason: '', prunable: false, prunableReason: '', isMain: false,
    exists: true, kind: 'classic', attached: false, dirty: false, ahead: null, behind: null,
    lastCommit: null, created: null, ...extra,
  };
}

const main = wt('/w/app', { isMain: true, branch: 'main', kind: 'main', created: 1 });
const beta = wt('/w/app.worktrees/beta', { branch: 'beta', created: 30 });
const alpha = wt('/w/app.worktrees/alpha', { branch: 'alpha', created: 20 });
const claude = wt('/w/app/.claude/worktrees/fix', { branch: 'fix', kind: 'claude', created: null });

test('sorting keeps the main worktree first and puts unknown creation times last', () => {
  const ctx = loadContext();
  const list = [beta, main, claude, alpha];
  const order = (o) => plain(ctx.wtSortWorktrees(list, o).map(item => item.branch));
  assert.deepEqual(order('default'), ['main', 'beta', 'fix', 'alpha']);
  assert.deepEqual(order('nameAsc'), ['main', 'alpha', 'beta', 'fix']);
  assert.deepEqual(order('nameDesc'), ['main', 'fix', 'beta', 'alpha']);
  assert.deepEqual(order('createdDesc'), ['main', 'beta', 'alpha', 'fix']);
  assert.deepEqual(order('createdAsc'), ['main', 'alpha', 'beta', 'fix']);
});

test('filtering matches branch, folder, kind and state, and a repository name keeps all its rows', () => {
  const ctx = loadContext();
  const repos = [
    { id: 'a', name: 'app', mainPath: '/w/app', worktrees: [main, beta, claude] },
    { id: 'b', name: 'lib', mainPath: '/w/lib', worktrees: [wt('/w/lib', { isMain: true, branch: 'main', kind: 'main' })] },
  ];
  const visible = (q) => plain(ctx.wtVisibleRepositories(repos, q, 'default').map(g => [g.repo.name, g.worktrees.map(w => w.branch)]));
  assert.deepEqual(visible(''), [['app', ['main', 'beta', 'fix']], ['lib', ['main']]]);
  assert.deepEqual(visible('claude'), [['app', ['fix']]]);
  assert.deepEqual(visible('BETA'), [['app', ['beta']]]);
  assert.deepEqual(visible('lib'), [['lib', ['main']]]);
  assert.deepEqual(visible('nothing-here'), []);
  const locked = { ...beta, locked: true };
  assert.equal(ctx.wtMatches(locked, 'locked'), true);
  assert.equal(ctx.wtMatches({ ...beta, exists: false }, 'missing'), true);
});

test('a running session counts for the deepest worktree it runs in', () => {
  const sessions = new Map([
    ['s1', { sessionId: 's1', projectPath: '/w/app/.claude/worktrees/fix' }],
    ['s2', { sessionId: 's2', projectPath: '/w/app/src' }],
    ['s3', { sessionId: 's3', projectPath: '/elsewhere' }],
    ['s4', { sessionId: 's4', projectPath: '/w/app.worktrees/beta' }],
  ]);
  const ctx = loadContext({ activePtyIds: new Set(['s1', 's2', 's3']), sessionMap: sessions });
  const byPath = ctx.wtSessionsByWorktree([{ worktrees: [main, beta, claude] }]);
  assert.deepEqual(plain([...byPath.keys()].sort()), ['/w/app', '/w/app/.claude/worktrees/fix']);
  assert.equal(byPath.get('/w/app').length, 1);
  assert.equal(byPath.get('/w/app/.claude/worktrees/fix')[0].sessionId, 's1');
  assert.equal(byPath.has('/w/app.worktrees/beta'), false, 's4 is not running');
  // Without the app's session globals (a test, an early render) nothing counts.
  assert.equal(loadContext().wtSessionsByWorktree([{ worktrees: [main] }]).size, 0);
});

test('a row shows the label, badges, state and the full path in its tooltip, escaped', () => {
  const ctx = loadContext();
  const row = ctx.wtRowHtml(wt('/w/app.worktrees/"odd"', {
    branch: 'feat/<x>', kind: 'claude', locked: true, lockReason: 'on "usb"', dirty: true, ahead: 2,
    lastCommit: { subject: 'Fix it', time: Date.now() },
  }), 'w0', [{ name: 'Session one' }]);
  assert.match(row, /feat\/&lt;x&gt;/);
  assert.match(row, /title="\/w\/app\.worktrees\/&quot;odd&quot;/, 'the tooltip holds the full path');
  assert.match(row, />Claude</);
  assert.match(row, /Locked: on &quot;usb&quot;/);
  assert.match(row, /Changes/);
  assert.match(row, /↑2/);
  assert.match(row, /1 running/);
  assert.match(row, /data-act="session"/);
  assert.match(row, /title="Open in Finder"/);

  const missing = ctx.wtRowHtml(wt('/w/gone', { branch: 'gone', exists: false, prunable: true, prunableReason: 'gitdir file points to non-existent location' }), 'w1', []);
  assert.match(missing, /class="wt-row missing"/);
  assert.match(missing, />Missing</);
  assert.doesNotMatch(missing, /data-act="session"/, 'no session in a folder that is gone');

  const detached = ctx.wtRowHtml(wt('/w/d', { detached: true, head: '0123456789abcdef' }), 'w2', []);
  assert.match(detached, />01234567</);
  assert.match(detached, />Detached</);
});

test('a row names its folder relative to the one that holds the repository', () => {
  const ctx = loadContext();
  const repo = { mainPath: '/w/app' };
  assert.equal(ctx.wtRowPath(beta, repo), 'app.worktrees/beta');
  assert.equal(ctx.wtRowPath(claude, repo), 'app/.claude/worktrees/fix');
  assert.equal(ctx.wtRowPath(main, repo), 'app');
  assert.equal(ctx.wtRowPath(wt('/other/place'), repo), '/other/place');
  assert.match(ctx.wtRowHtml(beta, 'w0', [], repo), />app\.worktrees\/beta</);
});

test('the row menu offers what fits: no remove or lock for the main worktree, unlock when locked', () => {
  const ctx = loadContext();
  const project = { id: 'p', folders: [{ path: '/w/app.worktrees/beta' }] };
  const repo = { id: 'r', name: 'app', mainPath: '/w/app' };
  const labels = items => plain(items.filter(i => i.label).map(i => i.label));
  const mainItems = labels(ctx.wtRowMenuItems(project, repo, main));
  assert.ok(mainItems.includes('Attach to project'));
  assert.ok(!mainItems.includes('Remove…'));
  assert.ok(!mainItems.includes('Lock…'));

  const attached = ctx.wtRowMenuItems(project, repo, { ...beta, attached: true });
  assert.ok(labels(attached).includes('Detach from project'));
  assert.equal(attached.find(i => i.label === 'Show in the Git tab').disabled, false);
  assert.ok(labels(attached).includes('Remove…'));

  const locked = ctx.wtRowMenuItems(project, repo, { ...alpha, locked: true });
  assert.ok(labels(locked).includes('Unlock'));
  assert.equal(locked.find(i => i.label === 'Move…').disabled, true);
  assert.equal(locked.find(i => i.label === 'Show in the Git tab').disabled, true, 'not attached');

  const gone = labels(ctx.wtRowMenuItems(project, repo, { ...alpha, exists: false }));
  assert.ok(gone.includes('Remove record…'));
  assert.ok(!gone.includes('New session'));
});

test('the settings preview fills the template like main does', () => {
  const ctx = loadContext();
  const repo = { mainPath: '/w/app' };
  assert.equal(ctx.wtPreviewTemplate('$BASE_PATH.worktrees/$REF_NAME', repo, 'feature/example', '/p'), '/w/app.worktrees/feature-example');
  assert.equal(ctx.wtPreviewTemplate('$BASE_ROOT/trees/$BASE_NAME$INDEX', repo, 'x', '/p'), '/w/trees/app1');
  assert.equal(ctx.wtPreviewTemplate('$PROJECT_ROOT/.repos/$REF_NAME-$BASE_NAME', repo, 'a b', '/p'), '/p/.repos/a-b-app');
  assert.equal(ctx.wtRefFolderName('--feat//x?'), 'feat-x');
});

test('start points list HEAD first, then local and remote branches', () => {
  const ctx = loadContext();
  const items = plain(ctx.wtStartPointOptions({ mainBranch: 'main', local: [{ name: 'main' }, { name: 'dev' }], remote: [{ name: 'origin/main' }] }));
  assert.deepEqual(items.map(i => i[0]), ['', 'main', 'dev', 'origin/main']);
  assert.match(items[0][1], /HEAD of the main worktree \(main\)/);
});

test('the list says how to start when the project has no repository', () => {
  const ctx = loadContext();
  const state = { repositories: [], settings: {}, query: '', rows: new Map() };
  assert.match(ctx.wtListHtml({ id: 'p' }, state), /No repositories in this project/);
  const withRepo = { repositories: [{ id: 'r', name: 'app', mainPath: '/w/app', worktrees: [main, beta] }], settings: { collapsedGroups: ['r'] }, query: '', rows: new Map() };
  const html = ctx.wtListHtml({ id: 'p' }, withRepo);
  assert.match(html, /aria-expanded="false"/, 'a closed group stays closed');
  assert.doesNotMatch(html, /wt-row/);
  withRepo.query = 'beta';
  assert.match(ctx.wtListHtml({ id: 'p' }, withRepo), /wt-row/, 'filtering opens closed groups');
});

test('the merged list ticks what can go, but not a worktree with sessions running in it', () => {
  const ctx = loadContext();
  const result = { base: 'main', worktrees: [
    { path: '/w/app.worktrees/done', branch: 'done', eligible: true, reason: '' },
    { path: '/w/app.worktrees/busy', branch: 'busy', eligible: true, reason: '' },
    { path: '/w/app.worktrees/dirty', branch: 'dirty', eligible: false, reason: 'Uncommitted changes' },
  ] };
  const live = new Map([['/w/app.worktrees/busy', [{ sessionId: 's' }]]]);
  const html = ctx.wtMergedListHtml(result, { mainPath: '/w/app' }, live);
  const boxes = html.match(/<input[^>]*>/g);
  assert.match(boxes[0], /checked/);
  assert.doesNotMatch(boxes[1], /checked/, 'running: left for the user to tick');
  assert.doesNotMatch(boxes[1], /disabled/);
  assert.match(boxes[2], /disabled/);
  assert.match(html, /app\.worktrees\/busy · 1 running/);
  assert.match(html, /Uncommitted changes/);
  assert.match(ctx.wtMergedListHtml({ base: 'main', worktrees: [] }, {}), /No worktree has a branch merged/);
});

test('a worktree attached through a symlink still matches its project folder and its sessions', () => {
  const linked = { ...beta, attached: true, attachedPath: '/links/beta' };
  const ctx = loadContext({
    activePtyIds: new Set(['s1']),
    sessionMap: new Map([['s1', { sessionId: 's1', projectPath: '/links/beta/src' }]]),
  });
  const byPath = ctx.wtSessionsByWorktree([{ worktrees: [main, linked] }]);
  assert.equal(byPath.get(beta.path).length, 1, 'counted under git\'s path');
  const items = ctx.wtRowMenuItems({ id: 'p', folders: [{ path: '/links/beta' }] }, { mainPath: '/w/app' }, linked);
  assert.equal(items.find(i => i.label === 'Show in the Git tab').disabled, false);
});

test('a merged worktree with no commits of its own is offered but not ticked', () => {
  const ctx = loadContext();
  const html = ctx.wtMergedListHtml({ base: 'main', worktrees: [
    { path: '/w/app.worktrees/new', branch: 'new', eligible: true, reason: '', fresh: true },
  ] }, { mainPath: '/w/app' });
  assert.doesNotMatch(html.match(/<input[^>]*>/)[0], /checked/);
  assert.match(html, /no commits of its own yet/);
});

// The real escapeHtml from utils.js, over a document stub that serializes text
// the way the DOM does (only &, <, > and no-break spaces are escaped).
function realEscapeHtml() {
  const utils = fs.readFileSync(path.join(__dirname, '../public/utils.js'), 'utf8');
  const fn = utils.match(/function escapeHtml\(str\) \{[\s\S]*?\n\}/)[0];
  const document = {
    createElement: () => {
      let text = '';
      return {
        set textContent(v) { text = v == null ? '' : String(v); },
        get innerHTML() { return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\u00a0/g, '&nbsp;'); },
      };
    },
  };
  return new Function('document', `${fn}; return escapeHtml;`)(document);
}

test('hostile repository, branch, path and lock names render as text and stay inside their attributes', () => {
  const ctx = loadContext({ escapeHtml: realEscapeHtml() });
  const evil = `x"><img src=x onerror=alert(1)>'&`;
  const repo = { id: 'r', name: `repo${evil}`, mainPath: `/w/${evil}`, worktrees: [
    wt(`/w/${evil}`, { isMain: true, branch: `main${evil}`, kind: 'main' }),
    wt(`/w/${evil}.worktrees/b`, { branch: `feat/${evil}`, locked: true, lockReason: evil,
      lastCommit: { subject: evil, time: Date.now() } }),
  ] };
  const html = [
    ctx.wtListHtml({ id: 'p' }, { repositories: [repo], query: '', settings: {} }),
    ctx.wtMergedListHtml({ base: `main${evil}`, worktrees: [{ path: `/w/${evil}.worktrees/b`, branch: evil, eligible: false, reason: evil }] }, repo),
  ].join('\n');
  assert.doesNotMatch(html, /<img/, 'no element comes out of a name');
  // Every quoted attribute value is closed by its own quote: nothing a name
  // holds can end it early and start a new attribute.
  const tags = html.match(/<[a-z][^>]*>/gi) || [];
  for (const tag of tags) {
    const rest = tag.replace(/\s[a-z-]+="[^"]*"/gi, '').replace(/\s[a-z-]+(?=[\s>])/gi, '');
    assert.match(rest, /^<[a-z0-9-]+\s*\/?>$/i, `unexpected markup in ${tag}`);
  }
});
