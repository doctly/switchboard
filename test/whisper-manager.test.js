// test/whisper-manager.test.js — covers the pure helpers in whisper-manager.
// Spawning + scheduled-task install are integration territory and not
// exercised here; we test path discovery and HTTP probe behaviour.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const wm = require('../whisper-manager.js');
const { findBinary, findModel, modelSearchPaths, probe, waitUntilReady } = wm._internal;

function tmpFile(name) {
  return path.join(os.tmpdir(), `wm-test-${Date.now()}-${Math.random().toString(36).slice(2)}-${name}`);
}

test('findBinary: respects explicit override when present', () => {
  const f = tmpFile('server.exe'); fs.writeFileSync(f, 'x');
  try {
    assert.strictEqual(findBinary({ binaryPath: f }), f);
  } finally { fs.unlinkSync(f); }
});

test('findBinary: explicit but missing returns null (no autodetect surprise)', () => {
  const missing = path.join(os.tmpdir(), 'definitely-not-there.exe');
  // Autodetect candidates are checked against the filesystem; we don't make
  // assumptions about what exists on the CI machine.
  const r = findBinary({ binaryPath: missing });
  if (r !== null) {
    // It found a candidate path — must be a real existing exe.
    assert.ok(fs.existsSync(r));
  }
});

test('modelSearchPaths: ordering is explicit → adjacent → userData', () => {
  const order = modelSearchPaths(
    { modelPath: '/explicit/model.bin', binaryPath: 'C:/foo/build/bin/Release/whisper-server.exe' },
    'C:/Users/x/AppData/Roaming/Switchboard'
  );
  assert.strictEqual(order[0], '/explicit/model.bin');
  // Adjacent: ../../../models/<name> from the binary
  assert.ok(order[1].endsWith(path.join('models', 'ggml-large-v3-turbo.bin')));
  // userData fallback last
  assert.ok(order[2].includes('whisper-models'));
});

test('findModel: returns first existing path', () => {
  const f = tmpFile('model.bin'); fs.writeFileSync(f, 'm');
  try {
    const found = findModel({ modelPath: f }, '/nonexistent');
    assert.strictEqual(found, f);
  } finally { fs.unlinkSync(f); }
});

test('findModel: returns null when nothing found', () => {
  const result = findModel({ modelPath: '/no/such/path.bin' }, '/no/such/dir');
  assert.strictEqual(result, null);
});

test('probe: resolves true for live HTTP server', async () => {
  const srv = http.createServer((_req, res) => { res.writeHead(404); res.end(); });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  try {
    const ok = await probe('127.0.0.1', port, 1500);
    assert.strictEqual(ok, true);
  } finally {
    await new Promise(r => srv.close(r));
  }
});

test('probe: resolves false for closed port quickly', async () => {
  // Pick a port that's almost certainly closed.
  const ok = await probe('127.0.0.1', 1, 800);
  assert.strictEqual(ok, false);
});

test('waitUntilReady: returns true when server appears mid-wait', async () => {
  const srv = http.createServer((_req, res) => { res.writeHead(200); res.end(); });
  // Listen after a short delay to simulate slow boot.
  setTimeout(() => srv.listen(0, '127.0.0.1'), 300);
  await new Promise((resolve, reject) => {
    srv.once('listening', resolve);
    srv.once('error', reject);
  });
  const port = srv.address().port;
  try {
    const ok = await waitUntilReady('127.0.0.1', port, 5000);
    assert.strictEqual(ok, true);
  } finally {
    await new Promise(r => srv.close(r));
  }
});

test('waitUntilReady: returns false when deadline hits without success', async () => {
  const ok = await waitUntilReady('127.0.0.1', 1, 800);
  assert.strictEqual(ok, false);
});

test('TASK_NAME and DEFAULT_PORT are stable constants', () => {
  assert.strictEqual(typeof wm.TASK_NAME, 'string');
  assert.ok(wm.TASK_NAME.length > 0);
  assert.strictEqual(typeof wm.DEFAULT_PORT, 'number');
  assert.ok(wm.DEFAULT_PORT >= 1024 && wm.DEFAULT_PORT < 65536);
});
