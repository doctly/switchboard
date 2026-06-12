const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { getFolderIndexMtimeMs } = require('../folder-index-state');

test('folder index timestamp advances when an existing session file is appended', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-folder-index-'));

  try {
    const sessionPath = path.join(tmpDir, 'session.jsonl');
    fs.writeFileSync(sessionPath, '{"type":"user","message":"first"}\n', 'utf8');

    const before = getFolderIndexMtimeMs(tmpDir);

    await new Promise(resolve => setTimeout(resolve, 1100));

    fs.appendFileSync(sessionPath, '{"type":"assistant","message":"second"}\n', 'utf8');

    const after = getFolderIndexMtimeMs(tmpDir);

    assert.ok(after > before, `expected index mtime to increase (${before} -> ${after})`);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('folder index timestamp advances when ONLY a subagent transcript changes', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-folder-index-sub-'));

  try {
    // Top-level session, untouched after creation.
    fs.writeFileSync(path.join(tmpDir, 'parent.jsonl'), '{"type":"user","message":"hi"}\n', 'utf8');
    // Subagent transcript: <folder>/<parentSessionId>/subagents/agent-<id>.jsonl
    const subagentsDir = path.join(tmpDir, 'parent', 'subagents');
    fs.mkdirSync(subagentsDir, { recursive: true });
    const agentPath = path.join(subagentsDir, 'agent-1.jsonl');
    fs.writeFileSync(agentPath, '{"type":"user","message":"first"}\n', 'utf8');

    const before = getFolderIndexMtimeMs(tmpDir);

    await new Promise(resolve => setTimeout(resolve, 1100));

    // Append ONLY to the subagent transcript — the top-level files and the
    // folder dir itself are untouched. A top-level-only stat would miss this.
    fs.appendFileSync(agentPath, '{"type":"assistant","message":"second"}\n', 'utf8');

    const after = getFolderIndexMtimeMs(tmpDir);

    assert.ok(after > before, `expected index mtime to increase from a subagent-only change (${before} -> ${after})`);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
