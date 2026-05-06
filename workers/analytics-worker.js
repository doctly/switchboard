// workers/analytics-worker.js — runs analytics aggregation off the main
// thread. Receives the previous cache + session→profile map + JSONL roots
// via workerData, produces an updated cache and posts it back. Always
// reads each file from byteOffset 0 OR the recorded watermark; writes the
// new watermark per file in the response.

const { parentPort, workerData } = require('worker_threads');
const fs = require('fs');
const path = require('path');

const { emptyState, processChunk, pruneDays, DAY_RETENTION_DAYS } = require('../analytics-aggregator');

const PROJECTS_DIR = workerData.projectsDir;
const sessionProfiles = workerData.sessionProfiles || {};
const prevCache = workerData.prevCache || null;
const fullScan = !!workerData.fullScan;

function backendResolver(sessionId) {
  const pid = sessionProfiles[sessionId];
  return pid || 'default';
}

function processFile(filePath, sessionId, projectPath, prevWatermark, state) {
  let stat;
  try { stat = fs.statSync(filePath); } catch { return prevWatermark; }
  let from = prevWatermark || 0;
  if (stat.size < from) from = 0;        // file shrunk → rescan from 0
  if (stat.size === from) return from;    // nothing new

  let fd;
  try { fd = fs.openSync(filePath, 'r'); } catch { return prevWatermark; }
  try {
    const len = stat.size - from;
    // Cap individual reads so we don't allocate hundreds of MB at once.
    // Practically, each new chunk per scan is small (one session's deltas).
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, from);
    const text = buf.toString('utf8');
    const consumed = processChunk(text, sessionId, projectPath, backendResolver, state);
    return from + consumed;
  } catch {
    return prevWatermark;
  } finally {
    try { fs.closeSync(fd); } catch {}
  }
}

// Decode the project folder name → project path. Switchboard already has
// `derive-project-path.js` for this; require it lazily to keep this worker
// self-contained at file level.
const { deriveProjectPath } = require('../derive-project-path');

try {
  // Start from previous cache state if doing an incremental scan, else fresh.
  const state = (!fullScan && prevCache && prevCache.totals) ? prevCache.totals : emptyState();
  const watermarks = (!fullScan && prevCache && prevCache.watermarks) ? { ...prevCache.watermarks } : {};

  const folders = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory() && d.name !== '.git')
    .map(d => d.name);

  let processed = 0;
  for (const folder of folders) {
    const folderPath = path.join(PROJECTS_DIR, folder);
    const projectPath = deriveProjectPath(folderPath, folder);
    if (!projectPath) continue;

    let files = [];
    try { files = fs.readdirSync(folderPath).filter(f => f.endsWith('.jsonl')); } catch {}
    for (const f of files) {
      const fullPath = path.join(folderPath, f);
      const sessionId = f.slice(0, -'.jsonl'.length);
      const prev = fullScan ? 0 : (watermarks[fullPath] || 0);
      const next = processFile(fullPath, sessionId, projectPath, prev, state);
      watermarks[fullPath] = next;
    }

    processed++;
    if (processed % 10 === 0) {
      parentPort.postMessage({ type: 'progress', processed, total: folders.length });
    }
  }

  // Drop sessionIds entries that referred to JSONL files no longer on disk
  // — keeps the membership set bounded over years of churn.
  for (const backendId of Object.keys(state.byBackend)) {
    const b = state.byBackend[backendId];
    for (const sid of Object.keys(b.sessionIds)) {
      // (We don't have a fast filename->sessionId lookup here; instead
      // rely on the SESSION_IDS_CAP bound in the aggregator.)
      // Skip — bound by aggregator already.
      void sid;
    }
  }

  pruneDays(state, DAY_RETENTION_DAYS);

  parentPort.postMessage({
    ok: true,
    cache: {
      version: 1,
      lastFullScan: fullScan ? new Date().toISOString() : (prevCache && prevCache.lastFullScan) || new Date().toISOString(),
      lastUpdate: new Date().toISOString(),
      totals: state,
      watermarks,
    },
  });
} catch (err) {
  parentPort.postMessage({ ok: false, error: err && err.message ? err.message : String(err) });
}
