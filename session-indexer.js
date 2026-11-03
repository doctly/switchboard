const path = require('path');
const { Worker } = require('worker_threads');

// One worker and one serialized queue for startup, reconciliation, title changes,
// and filesystem events. Completion means the writes are committed, not merely
// that the first cache row exists. Only status/counts travel over this channel.
class SessionIndexer {
  constructor({ projectsDir, onStatus = () => {}, onChanged = () => {}, onError = console.error }) {
    this.options = { projectsDir };
    this.onStatus = onStatus;
    this.onChanged = onChanged;
    this.onError = onError;
    this.pending = new Map();
    this.current = null;
    this.worker = null;
    this.initialComplete = false;
  }

  populate() {
    if (this.current?.key === 'populate') return this.current.promise;
    return this.enqueue('populate', { force: true });
  }
  reconcile() {
    // A full pass already covers this request. Watcher events still queue a
    // follow-up folder refresh, including changes to folders already scanned.
    if (this.current?.key === 'populate' || this.current?.key === 'reconcile') return this.current.promise;
    if (this.pending.has('populate')) return this.pending.get('populate').promise;
    return this.enqueue('reconcile', {});
  }
  folder(folder) { return this.enqueue(`folder:${folder}`, { folders: [folder] }); }
  titles(harnessId) { return this.enqueue(`titles:${harnessId}`, { harnessId }); }

  enqueue(key, args) {
    if (this.pending.has(key)) return this.pending.get(key).promise;
    let resolve;
    const promise = new Promise(r => { resolve = r; });
    this.pending.set(key, { key, args, resolve, promise });
    this.start();
    return promise;
  }

  start() {
    if (this.current || !this.pending.size) return;
    this.current = this.pending.values().next().value;
    this.pending.delete(this.current.key);
    if (!this.worker) {
      this.worker = new Worker(path.join(__dirname, 'workers', 'index-sessions.js'), {
        workerData: this.options,
      });
      const worker = this.worker;
      this.worker.on('message', msg => {
        if (this.worker !== worker) return;
        if (msg.type === 'progress') {
          if (this.current) this.current.reportedProgress = true;
          this.onStatus(msg.text, 'active');
          return;
        }
        if (msg.type !== 'done' || !this.current) return;
        const job = this.current;
        this.current = null;
        if (!msg.error && (job.key === 'populate' || job.key === 'reconcile')) this.initialComplete = true;
        if (msg.error) this.onError(msg.error);
        else if (msg.changed) this.onChanged();
        if (msg.error || msg.changed || job.reportedProgress || job.key === 'populate') {
          this.onStatus(msg.error ? `Indexing failed: ${msg.error}`
            : msg.count ? `Indexed ${msg.count} sessions` : 'Sessions up to date', msg.error ? 'error' : 'done');
        }
        job.resolve(msg);
        this.start();
      });
      this.worker.on('error', err => { if (this.worker === worker) this.fail(err); });
      this.worker.on('exit', code => {
        if (this.worker === worker) this.fail(new Error(`Indexing worker exited (${code})`));
      });
      this.worker.unref();
    }
    if (this.current.key === 'populate') this.onStatus('Indexing sessions…', 'active');
    this.worker.postMessage(this.current.args);
  }

  fail(err) {
    this.worker = null;
    this.onError(err);
    this.onStatus(`Indexing failed: ${err.message}`, 'error');
    // Never fall back to synchronous transcript parsing on the UI thread.
    for (const job of [this.current, ...this.pending.values()]) job?.resolve({ error: err.message });
    this.current = null;
    this.pending.clear();
  }

  async close() {
    const worker = this.worker;
    this.worker = null;
    for (const job of [this.current, ...this.pending.values()]) job?.resolve({ error: 'Indexer closed' });
    this.current = null;
    this.pending.clear();
    if (worker) await worker.terminate();
  }
}

module.exports = { SessionIndexer };
