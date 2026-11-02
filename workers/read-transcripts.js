const { parentPort, workerData } = require('worker_threads');
const { getHarness } = require('../harnesses');

// Reads the transcripts a reconcile pass planned, one folder at a time, and
// reports each folder as soon as it is read. The main thread owns the
// database and writes the sessions.
workerData.plans.forEach((plan, index) => {
  try {
    const h = getHarness(plan.harnessId);
    const sessions = [];
    for (const { filePath, prev } of plan.files) {
      const s = h.readSessionFile(filePath, plan.folder, plan.folderProject, prev);
      if (s) sessions.push(s);
    }
    parentPort.postMessage({ type: 'folder', index, sessions });
  } catch (err) {
    parentPort.postMessage({ type: 'folder', index, error: err.message });
  }
});
parentPort.postMessage({ type: 'done' });
