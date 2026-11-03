// Run with Electron-as-Node and an isolated SWITCHBOARD_DATA_DIR. The baseline
// loads the committed cache implementation; neither mode changes transcripts.
if (!process.env.SWITCHBOARD_DATA_DIR) throw new Error('Set an isolated SWITCHBOARD_DATA_DIR');
const path = require('path');
const os = require('os');
const { monitorEventLoopDelay, performance } = require('perf_hooks');
const db = require('../db');
const { SessionIndexer } = require('../session-indexer');
const mode = process.argv[2] || 'worker';
const projectsDir = path.join(os.homedir(), '.claude', 'projects');
const delay = monitorEventLoopDelay({ resolution: 10 });
delay.enable();
let heartbeatMaxMs = 0;
let previous = performance.now();
let ticks = 0;
const heartbeat = setInterval(() => {
  const now = performance.now();
  heartbeatMaxMs = Math.max(heartbeatMaxMs, now - previous - 20);
  previous = now;
  ticks++;
}, 20);
let dbWriteMaxMs = 0;
// Optional contention probe: emulate saving a UI preference while the worker
// indexes. Use in a separate run so the primary benchmark remains comparable.
const writeProbe = process.env.SWITCHBOARD_PROFILE_WRITES ? setInterval(() => {
  const started = performance.now();
  db.setSetting('_index_profile_probe', ticks);
  dbWriteMaxMs = Math.max(dbWriteMaxMs, performance.now() - started);
}, 200) : null;

(async () => {
  // Prime the delay monitor before initiating work.
  await new Promise(resolve => setTimeout(resolve, 50));
  const started = performance.now();
  const cpu = process.cpuUsage();
  const utilization = performance.eventLoopUtilization();
  let indexer;
  if (mode === 'baseline') {
    const Module = require('module');
    const { execFileSync } = require('child_process');
    const filename = path.join(__dirname, '..', 'session-cache.js');
    const legacy = new Module(filename, module);
    legacy.filename = filename;
    legacy.paths = Module._nodeModulePaths(path.dirname(filename));
    legacy._compile(execFileSync('git', ['show', 'HEAD:session-cache.js'], {
      cwd: path.dirname(filename), encoding: 'utf8', maxBuffer: 2 * 1024 * 1024,
    }), filename);
    const cache = legacy.exports;
    let populated;
    const complete = new Promise(resolve => { populated = resolve; });
    cache.init({ PROJECTS_DIR: projectsDir, db, activeSessions: new Map(),
      getMainWindow: () => null, log: { info: text => {
        if (text.includes('(done) Indexed')) populated();
      } } });
    cache.populateCacheViaWorker();
    await complete;
    await cache.reconcileCacheFromFilesystem();
  } else {
    indexer = new SessionIndexer({ projectsDir, onError: err => { throw new Error(String(err)); } });
    const result = await (mode === 'warm' ? indexer.reconcile() : indexer.populate());
    if (result.error) throw new Error(result.error);
  }
  const elapsedMs = performance.now() - started;
  // Let the heartbeat record the last synchronous job's delay.
  await new Promise(resolve => setTimeout(resolve, 30));
  const cpuUsed = process.cpuUsage(cpu);
  const elu = performance.eventLoopUtilization(utilization);
  console.log(JSON.stringify({ mode, elapsedMs: Math.round(elapsedMs),
    heartbeatMaxMs: Math.round(heartbeatMaxMs), ticks,
    eventLoopMaxMs: Math.round(delay.max / 1e6),
    eventLoopP99Ms: Math.round(delay.percentile(99) / 1e6),
    mainEventLoopUtilization: +elu.utilization.toFixed(3),
    averageCpuCores: +((cpuUsed.user + cpuUsed.system) / 1000 / elapsedMs).toFixed(2),
    rssMB: Math.round(process.memoryUsage().rss / 1024 / 1024),
    ...(writeProbe ? { dbWriteMaxMs: Math.round(dbWriteMaxMs) } : {}),
    sessions: db.getAllCached().length,
  }));
  clearInterval(heartbeat);
  if (writeProbe) clearInterval(writeProbe);
  delay.disable();
  if (indexer) await indexer.close();
  db.closeDb();
})().catch(err => { console.error(err); process.exit(1); });
