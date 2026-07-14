const { test } = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

const sessionCache = require('../session-cache');

// Empty local projects dir → only remote/injected groups appear.
const tmpProjects = fs.mkdtempSync(path.join(os.tmpdir(), 'swb-bp-'));

function initWith({ cached, global }) {
  sessionCache.init({
    PROJECTS_DIR: tmpProjects,
    activeSessions: new Map(),
    getMainWindow: () => null,
    log: { info() {}, error() {} },
    db: {
      deleteCachedFolder() {}, getCachedByFolder() { return []; }, upsertCachedSessions() {}, deleteCachedSession() {},
      deleteSearchFolder() {}, deleteSearchSession() {}, upsertSearchEntries() {},
      setFolderMeta() {}, getAllFolderMeta() { return new Map(); },
      getAllMeta: () => new Map(),
      getAllCached: () => cached,
      getSetting: (k) => (k === 'global' ? global : null),
      getMeta: () => null,
      setName() {},
    },
  });
}

const REMOTE_ROW = {
  sessionId: 'R1', folder: '-home-u-proj', projectPath: 'ssh://gpu/~/proj',
  summary: 'remote question', firstPrompt: 'remote question', created: 'C', modified: 'M',
  messageCount: 2, slug: null, aiTitle: null, source: 'h1',
};
const REMOTE_PROJECT = { projectPath: 'ssh://gpu/~/proj', hostId: 'h1', hostLabel: 'gpu', remotePath: '~/proj' };

test('cached remote rows group under the injected remote project (decorated as remote)', () => {
  initWith({ cached: [REMOTE_ROW], global: { remoteProjects: [REMOTE_PROJECT] } });
  const projects = sessionCache.buildProjectsFromCache(false);
  const remote = projects.find((p) => p.projectPath === 'ssh://gpu/~/proj');
  assert.ok(remote, 'remote project present');
  assert.strictEqual(remote.remote, true, 'group flagged remote (not rendered as local)');
  assert.strictEqual(remote.hostId, 'h1');
  assert.strictEqual(remote.hostLabel, 'gpu');
  assert.strictEqual(remote.remotePath, '~/proj');
  assert.strictEqual(remote.sessions.length, 1, 'past remote session grouped here');
});

test('auto-discovered remote rows (no registered project) still group as remote', () => {
  // No remoteProjects entry — the group must still be decorated from the ssh:// path.
  const row = { ...REMOTE_ROW, sessionId: 'R9', projectPath: 'ssh://gpu/~/discovered' };
  initWith({ cached: [row], global: { remoteProjects: [] } });
  const projects = sessionCache.buildProjectsFromCache(false);
  const g = projects.find((p) => p.projectPath === 'ssh://gpu/~/discovered');
  assert.ok(g, 'auto-discovered group present');
  assert.strictEqual(g.remote, true);
  assert.strictEqual(g.hostId, 'h1');
  assert.strictEqual(g.hostLabel, 'gpu');
  assert.strictEqual(g.remotePath, '~/discovered');
  assert.strictEqual(g.sessions[0].remoteLabel, 'gpu');
});

test('past remote sessions carry source/remote/remoteLabel for sidebar rendering', () => {
  initWith({ cached: [REMOTE_ROW], global: { remoteProjects: [REMOTE_PROJECT] } });
  const projects = sessionCache.buildProjectsFromCache(false);
  const s = projects.find((p) => p.projectPath === 'ssh://gpu/~/proj').sessions[0];
  assert.strictEqual(s.sessionId, 'R1');
  assert.strictEqual(s.source, 'h1');
  assert.strictEqual(s.remote, true);
  assert.strictEqual(s.remoteLabel, 'gpu');
  assert.notStrictEqual(s.remoteMode, 'shell'); // treated as a Claude session (SSH badge + Claude logo)
});
