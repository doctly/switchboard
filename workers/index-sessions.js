const { parentPort, workerData } = require('worker_threads');
const db = require('../db');
const cache = require('../session-cache');
const { getHarness } = require('../harnesses');

cache.init({ PROJECTS_DIR: workerData.projectsDir, activeSessions: new Map(),
  getMainWindow: () => null, log: console, db });

parentPort.on('message', async args => {
  try {
    let result;
    if (args.harnessId) {
      result = { count: 0, changed: !!cache.refreshHarnessTitles(getHarness(args.harnessId)) };
    } else {
      let lastProgress = 0;
      result = await cache.indexFoldersInWorker({ ...args, progress: ({ text }) => {
        if (Date.now() - lastProgress < 250) return;
        lastProgress = Date.now();
        parentPort.postMessage({ type: 'progress', text });
      } });
    }
    parentPort.postMessage({ type: 'done', ...result });
  } catch (err) {
    parentPort.postMessage({ type: 'done', error: err.stack || err.message });
  }
});
