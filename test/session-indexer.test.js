const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

test('one indexing worker commits searchable results, queues changes, and keeps the caller responsive', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-index-worker-'));
  try {
    const result = spawnSync(require('electron'), ['-e', `
      const assert = require('node:assert/strict');
      const fs = require('fs');
      const path = require('path');
      const db = require('./db');
      const { SessionIndexer } = require('./session-indexer');
      const root = path.join(process.env.SWITCHBOARD_DATA_DIR, 'projects');
      const folder = path.join(root, 'project');
      fs.mkdirSync(folder, { recursive: true });
      db.setSetting('global', { disabledHarnesses: ['codex'] });
      const line = content => JSON.stringify({ type: 'user', cwd: '/test/project',
        message: { role: 'user', content } }) + '\\n';
      for (let i = 0; i < 40; i++) fs.writeFileSync(path.join(folder, i + '.jsonl'), line('searchable elephant ' + i + ' abc '.repeat(2000)));
      let changes = 0;
      let changedDuringScan = false;
      const errors = [];
      const indexer = new SessionIndexer({ projectsDir: root,
        onStatus: text => {
          if (!changedDuringScan && text.startsWith('Indexing folders')) {
            changedDuringScan = true;
            fs.appendFileSync(path.join(folder, '0.jsonl'), line('pending zebra'));
            indexer.folder('project');
          }
        },
        onChanged: () => { changes++; }, onError: err => errors.push(String(err)) });
      (async () => {
        let ticks = 0;
        const timer = setInterval(() => ticks++, 5);
        const initial = indexer.populate();
        assert.equal(indexer.populate(), initial, 'repeated startup requests share completion');
        assert.equal(indexer.reconcile(), initial, 'no reconciliation overlaps cold indexing');
        assert.equal(indexer.initialComplete, false);
        const refresh = indexer.folder('project');
        assert.equal(indexer.folder('project'), refresh, 'pending watcher updates are coalesced');
        await initial;
        assert.equal(indexer.initialComplete, true);
        await refresh;
        // A watcher event after the first folder refresh started may have
        // scheduled another pass. Drain it before checking the final content.
        await indexer.folder('project');
        assert.equal(db.getAllCached().length, 40);
        assert.equal(db.searchSessionIds('elephant', ['0', '1']).length, 2);
        assert.deepEqual(db.searchSessionIds('zebra', ['0']), ['0']);
        assert.ok(ticks > 5, 'caller services timers while indexing');
        const notifications = changes;
        await indexer.reconcile();
        assert.equal(changes, notifications, 'a no-op reconcile must not start a renderer refresh loop');
        db.setName('0', 'My custom name');
        fs.appendFileSync(path.join(folder, '0.jsonl'), line('queued giraffe'));
        await indexer.folder('project');
        assert.equal(db.getMeta('0').name, 'My custom name');
        assert.deepEqual(db.searchSessionIds('giraffe', ['0']), ['0']);
        fs.unlinkSync(path.join(folder, '1.jsonl'));
        await indexer.folder('project');
        assert.equal(db.getCachedSession('1'), null);
        assert.deepEqual(db.searchSessionIds('elephant', ['1']), []);
        fs.rmSync(folder, { recursive: true });
        await indexer.folder('project');
        assert.equal(db.getAllCached().length, 0);
        assert.equal(db.isSearchIndexPopulated(), false);
        assert.deepEqual(errors, []);
        // A worker failure settles pending requests; retry uses a new worker,
        // rather than blocking the main thread with an inline fallback.
        const failed = indexer.populate();
        await indexer.worker.terminate();
        assert.ok((await failed).error);
        const retry = await indexer.reconcile();
        assert.equal(retry.error, undefined);
        clearInterval(timer);
        await indexer.close();
        db.closeDb();
      })().catch(err => { console.error(err); process.exit(1); });
    `], { cwd: path.join(__dirname, '..'),
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', SWITCHBOARD_DATA_DIR: dataDir },
      encoding: 'utf8', timeout: 60000 });
    assert.equal(result.status, 0, result.stderr || result.error?.message);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
