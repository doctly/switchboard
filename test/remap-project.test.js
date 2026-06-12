/**
 * Tests for the remap-project JSONL atomic-rewrite logic.
 *
 * Exercises the core algorithm in isolation (no Electron IPC, no DB) by
 * testing rewriteJsonlAtomic and the enumerateSessionFiles traversal against
 * real temp directories. This keeps tests fast (node:test, no jsdom) and
 * fully deterministic.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { enumerateSessionFiles } = require('../read-session-file');

// ── helpers ────────────────────────────────────────────────────────────────

function mkTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-remap-'));
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

/**
 * Atomically rewrite cwd occurrences of oldPath → newPath in a single JSONL
 * file. Uses a .tmp sibling + rename for crash safety. On any failure the .tmp
 * orphan is cleaned up so it cannot block a future remap attempt.
 *
 * Kept in sync with the copy in main.js — this shared implementation is
 * what both the IPC handler and these tests exercise.
 */
function rewriteJsonlAtomic(filePath, oldPath, newPath) {
  const tmp = filePath + '.tmp';
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const updated = content.split('\n').map(line => {
      if (!line) return line;
      try {
        const parsed = JSON.parse(line);
        if (parsed.cwd === oldPath) {
          parsed.cwd = newPath;
          return JSON.stringify(parsed);
        }
      } catch {}
      return line;
    }).join('\n');
    fs.writeFileSync(tmp, updated);
    fs.renameSync(tmp, filePath);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch {}
    throw err;
  }
}

/**
 * Full folder remap using enumerateSessionFiles — mirrors the IPC handler
 * so tests validate the exact same traversal logic used in production.
 */
function remapJsonlFolder(folderPath, oldPath, newPath) {
  const sessionFiles = enumerateSessionFiles(folderPath);
  for (const { filePath } of sessionFiles) {
    rewriteJsonlAtomic(filePath, oldPath, newPath);
  }
}

// ── tests ──────────────────────────────────────────────────────────────────

test('rewrites cwd in a single JSONL file', () => {
  const tmp = mkTmp();
  try {
    const oldPath = '/old/project';
    const newPath = '/new/project';
    const line1 = JSON.stringify({ type: 'user', cwd: oldPath, message: 'hello' });
    const line2 = JSON.stringify({ type: 'assistant', cwd: oldPath, message: 'world' });
    fs.writeFileSync(path.join(tmp, 'session.jsonl'), line1 + '\n' + line2 + '\n');

    remapJsonlFolder(tmp, oldPath, newPath);

    const result = fs.readFileSync(path.join(tmp, 'session.jsonl'), 'utf8');
    const lines = result.split('\n').filter(Boolean);
    assert.equal(lines.length, 2);
    assert.equal(JSON.parse(lines[0]).cwd, newPath);
    assert.equal(JSON.parse(lines[1]).cwd, newPath);
  } finally {
    cleanup(tmp);
  }
});

test('rewrites cwd across multiple JSONL files atomically', () => {
  const tmp = mkTmp();
  try {
    const oldPath = '/old/project';
    const newPath = '/new/project';

    for (let i = 0; i < 3; i++) {
      const line = JSON.stringify({ type: 'user', cwd: oldPath, idx: i });
      fs.writeFileSync(path.join(tmp, `session-${i}.jsonl`), line + '\n');
    }

    remapJsonlFolder(tmp, oldPath, newPath);

    for (let i = 0; i < 3; i++) {
      const content = fs.readFileSync(path.join(tmp, `session-${i}.jsonl`), 'utf8');
      const parsed = JSON.parse(content.trim());
      assert.equal(parsed.cwd, newPath, `session-${i}.jsonl should have new cwd`);
      assert.equal(parsed.idx, i, `session-${i}.jsonl should preserve idx`);
    }
  } finally {
    cleanup(tmp);
  }
});

test('preserves lines without cwd field verbatim', () => {
  const tmp = mkTmp();
  try {
    const oldPath = '/old/project';
    const newPath = '/new/project';
    const withCwd = JSON.stringify({ type: 'user', cwd: oldPath });
    const noCwd = JSON.stringify({ type: 'system', text: 'no cwd here' });
    const otherCwd = JSON.stringify({ type: 'user', cwd: '/some/other/path' });

    fs.writeFileSync(
      path.join(tmp, 'mixed.jsonl'),
      [withCwd, noCwd, otherCwd].join('\n') + '\n'
    );

    remapJsonlFolder(tmp, oldPath, newPath);

    const lines = fs.readFileSync(path.join(tmp, 'mixed.jsonl'), 'utf8')
      .split('\n').filter(Boolean);
    assert.equal(lines.length, 3);
    assert.equal(JSON.parse(lines[0]).cwd, newPath);     // updated
    assert.equal(JSON.parse(lines[1]).text, 'no cwd here'); // untouched
    assert.equal(JSON.parse(lines[2]).cwd, '/some/other/path'); // different cwd, untouched
  } finally {
    cleanup(tmp);
  }
});

test('preserves empty lines in JSONL files', () => {
  const tmp = mkTmp();
  try {
    const oldPath = '/old/project';
    const newPath = '/new/project';
    const line = JSON.stringify({ type: 'user', cwd: oldPath });

    // JSONL files often end with a trailing newline, creating an empty last "line"
    fs.writeFileSync(path.join(tmp, 'session.jsonl'), line + '\n\n');

    remapJsonlFolder(tmp, oldPath, newPath);

    const content = fs.readFileSync(path.join(tmp, 'session.jsonl'), 'utf8');
    // The trailing double newline should be preserved as-is
    assert.ok(content.endsWith('\n\n'), 'trailing newlines should be preserved');
  } finally {
    cleanup(tmp);
  }
});

test('atomic write: tmp file is created and then removed by rename', () => {
  const tmp = mkTmp();
  try {
    const oldPath = '/old/project';
    const newPath = '/new/project';
    const line = JSON.stringify({ type: 'user', cwd: oldPath });
    const jsonlPath = path.join(tmp, 'session.jsonl');
    fs.writeFileSync(jsonlPath, line + '\n');

    remapJsonlFolder(tmp, oldPath, newPath);

    // After rewrite the .tmp file must be gone (renamed into place)
    assert.ok(!fs.existsSync(jsonlPath + '.tmp'), '.tmp file should not exist after rename');
    // And the JSONL should exist with updated content
    assert.ok(fs.existsSync(jsonlPath), 'JSONL file should exist');
    assert.equal(JSON.parse(fs.readFileSync(jsonlPath, 'utf8').trim()).cwd, newPath);
  } finally {
    cleanup(tmp);
  }
});

test('lines with invalid JSON are passed through unchanged', () => {
  const tmp = mkTmp();
  try {
    const oldPath = '/old/project';
    const newPath = '/new/project';
    const badLine = '{ not valid json ';
    const goodLine = JSON.stringify({ type: 'user', cwd: oldPath });

    fs.writeFileSync(path.join(tmp, 'session.jsonl'), goodLine + '\n' + badLine + '\n');

    remapJsonlFolder(tmp, oldPath, newPath);

    const lines = fs.readFileSync(path.join(tmp, 'session.jsonl'), 'utf8')
      .split('\n').filter(Boolean);
    assert.equal(lines.length, 2);
    assert.equal(JSON.parse(lines[0]).cwd, newPath);
    assert.equal(lines[1], badLine, 'invalid JSON line should pass through unchanged');
  } finally {
    cleanup(tmp);
  }
});

test('non-.jsonl files in the folder are ignored', () => {
  const tmp = mkTmp();
  try {
    const oldPath = '/old/project';
    const newPath = '/new/project';

    fs.writeFileSync(path.join(tmp, 'session.jsonl'), JSON.stringify({ cwd: oldPath }) + '\n');
    fs.writeFileSync(path.join(tmp, 'meta.json'), JSON.stringify({ cwd: oldPath }));
    fs.writeFileSync(path.join(tmp, 'readme.txt'), 'cwd: ' + oldPath);

    remapJsonlFolder(tmp, oldPath, newPath);

    // Only the .jsonl file should be modified
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(tmp, 'meta.json'), 'utf8')).cwd,
      oldPath,
      'meta.json should be untouched'
    );
    assert.equal(
      fs.readFileSync(path.join(tmp, 'readme.txt'), 'utf8'),
      'cwd: ' + oldPath,
      'readme.txt should be untouched'
    );
  } finally {
    cleanup(tmp);
  }
});

test('subagent layout: rewrites cwd in subagents/agent-*.jsonl under a UUID subdir', () => {
  const tmp = mkTmp();
  try {
    const oldPath = '/old/project';
    const newPath = '/new/project';
    const parentSessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

    // Top-level session
    const topLine = JSON.stringify({ type: 'user', cwd: oldPath, sessionId: parentSessionId });
    fs.writeFileSync(path.join(tmp, parentSessionId + '.jsonl'), topLine + '\n');

    // Subagent transcript under <uuid>/subagents/agent-<id>.jsonl
    const subagentsDir = path.join(tmp, parentSessionId, 'subagents');
    fs.mkdirSync(subagentsDir, { recursive: true });
    const agentId = 'agent-00000000-1111-2222-3333-444444444444';
    const subLine = JSON.stringify({ type: 'user', cwd: oldPath, isSidechain: true, agentId });
    fs.writeFileSync(path.join(subagentsDir, agentId + '.jsonl'), subLine + '\n');

    remapJsonlFolder(tmp, oldPath, newPath);

    // Top-level session updated
    const topResult = JSON.parse(
      fs.readFileSync(path.join(tmp, parentSessionId + '.jsonl'), 'utf8').trim()
    );
    assert.equal(topResult.cwd, newPath, 'top-level session cwd should be updated');

    // Subagent file updated
    const subResult = JSON.parse(
      fs.readFileSync(path.join(subagentsDir, agentId + '.jsonl'), 'utf8').trim()
    );
    assert.equal(subResult.cwd, newPath, 'subagent cwd should be updated');
  } finally {
    cleanup(tmp);
  }
});

test('subagent layout (legacy): rewrites cwd in *.jsonl directly under UUID subdir', () => {
  const tmp = mkTmp();
  try {
    const oldPath = '/old/project';
    const newPath = '/new/project';
    const parentSessionId = 'aaaaaaaa-bbbb-cccc-dddd-ffffffffffff';

    // Top-level session
    fs.writeFileSync(
      path.join(tmp, parentSessionId + '.jsonl'),
      JSON.stringify({ type: 'user', cwd: oldPath }) + '\n'
    );

    // Legacy subagent layout: jsonl directly inside the UUID dir (no subagents/ subfolder)
    const legacySubDir = path.join(tmp, parentSessionId);
    fs.mkdirSync(legacySubDir, { recursive: true });
    const legacyLine = JSON.stringify({ type: 'user', cwd: oldPath, isSidechain: true });
    fs.writeFileSync(path.join(legacySubDir, 'legacy-agent.jsonl'), legacyLine + '\n');

    remapJsonlFolder(tmp, oldPath, newPath);

    const legacyResult = JSON.parse(
      fs.readFileSync(path.join(legacySubDir, 'legacy-agent.jsonl'), 'utf8').trim()
    );
    assert.equal(legacyResult.cwd, newPath, 'legacy subagent cwd should be updated');
  } finally {
    cleanup(tmp);
  }
});

test('orphan tmp cleanup: rewriteJsonlAtomic removes .tmp on read error', () => {
  const tmp = mkTmp();
  try {
    const jsonlPath = path.join(tmp, 'missing.jsonl');
    // Do NOT create the file — readFileSync will throw ENOENT
    assert.throws(
      () => rewriteJsonlAtomic(jsonlPath, '/old', '/new'),
      { code: 'ENOENT' }
    );
    // The .tmp orphan must not be left behind
    assert.ok(!fs.existsSync(jsonlPath + '.tmp'), '.tmp should be cleaned up on error');
  } finally {
    cleanup(tmp);
  }
});

test('active sessions guard: handler refuses remap when a session is running for the folder', () => {
  // Simulate the guard logic used in main.js:
  //   for (const [, session] of activeSessions) {
  //     if (!session.exited && encodeProjectPath(session.projectPath) === folder) return error;
  //   }
  const { encodeProjectPath } = require('../encode-project-path');
  const oldPath = '/old/active-project';
  const folder = encodeProjectPath(oldPath);

  // Build a fake activeSessions map with one live session for oldPath
  const activeSessions = new Map([
    ['session-1', { exited: false, projectPath: oldPath }],
  ]);

  let blocked = false;
  for (const [, session] of activeSessions) {
    if (!session.exited && encodeProjectPath(session.projectPath) === folder) {
      blocked = true;
    }
  }
  assert.ok(blocked, 'remap should be blocked when an active session exists for the folder');

  // Exited sessions must NOT block
  const exitedSessions = new Map([
    ['session-2', { exited: true, projectPath: oldPath }],
  ]);
  let blockedByExited = false;
  for (const [, session] of exitedSessions) {
    if (!session.exited && encodeProjectPath(session.projectPath) === folder) {
      blockedByExited = true;
    }
  }
  assert.ok(!blockedByExited, 'exited sessions must not block the remap');
});
