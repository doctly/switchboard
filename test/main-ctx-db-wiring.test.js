const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

// Regression guard for a class of silent runtime bug: session-cache.js consumes
// DB functions through `ctx.db.<name>`, but main.js hand-builds the `db: { ... }`
// object passed to sessionCache.init() as an explicit allow-list. When a new DB
// function is wired into session-cache but NOT added to that literal, the call
// site gets `undefined` and throws at runtime — inside the worker's message
// handler, where the throw lands on stderr (not electron-log) and silently
// aborts the cold-start indexing loop. Witnessed 2026-06-02: replaceSessionMetrics
// (and the pre-existing touchCachedModified) were missing → session_metrics never
// populated → the stats screen showed 0 tokens / 0 tool calls. No unit test booted
// main.js's init wiring, so task check stayed green. This static check closes that gap.

const root = path.join(__dirname, '..');

function read(f) {
  return fs.readFileSync(path.join(root, f), 'utf8');
}

// Extract the keys of the `db: { ... }` object literal handed to sessionCache.init.
function mainCtxDbKeys() {
  const src = read('main.js');
  const start = src.indexOf('db: {');
  assert.ok(start !== -1, 'main.js should pass a db: { ... } object to sessionCache.init');
  // Walk to the matching closing brace of the literal.
  const open = src.indexOf('{', start);
  let depth = 0, end = -1;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
  }
  assert.ok(end !== -1, 'db: { ... } literal should be balanced');
  const body = src.slice(open + 1, end);
  // Shorthand keys: bare identifiers separated by commas/newlines (ignore any value parts).
  return new Set(
    body
      .split(',')
      .map(s => s.trim().split(':')[0].trim())
      .filter(Boolean)
      .filter(k => /^[A-Za-z_$][\w$]*$/.test(k))
  );
}

// Every ctx.db.<name> that session-cache.js dereferences.
function sessionCacheDbDeps() {
  const src = read('session-cache.js');
  const deps = new Set();
  const re = /ctx\.db\.([A-Za-z_$][\w$]*)/g;
  let m;
  while ((m = re.exec(src))) deps.add(m[1]);
  return deps;
}

// Pure static analysis only — does NOT require('../db'), because better-sqlite3 is
// compiled against Electron's Node ABI and throws when loaded under plain node:test
// (same constraint db-daily-activity.test.js documents).

test('main.js ctx.db allow-list covers every ctx.db.* session-cache.js reads', () => {
  const provided = mainCtxDbKeys();
  const required = sessionCacheDbDeps();
  const missing = [...required].filter(name => !provided.has(name));
  assert.deepEqual(
    missing,
    [],
    `main.js db: {} is missing functions session-cache.js needs: ${missing.join(', ')}`
  );
});

test('ctx.db forwards the two functions from the 2026-06-02 stats incident', () => {
  const provided = mainCtxDbKeys();
  assert.ok(provided.has('replaceSessionMetrics'), 'ctx.db must forward replaceSessionMetrics');
  assert.ok(provided.has('touchCachedModified'), 'ctx.db must forward touchCachedModified');
});

// db.js must actually export those names too (a name forwarded in main.js but not
// exported by db.js is undefined just the same). Checked by source-grep, not require,
// to stay native-module-free.
test('db.js exports replaceSessionMetrics and touchCachedModified', () => {
  const dbSrc = read('db.js');
  for (const name of ['replaceSessionMetrics', 'touchCachedModified']) {
    assert.ok(
      new RegExp(`(^|[^\\w])${name}([^\\w]|$)`, 'm').test(dbSrc.split('module.exports')[1] || ''),
      `db.js module.exports should include ${name}`
    );
  }
});
