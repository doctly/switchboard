const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  readSessionFile,
  subagentSessionId,
  resolveJsonlPath,
  readSubagentMeta,
  enumerateSessionFiles,
} = require('../read-session-file');

function mkTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-rsf-'));
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

test('subagentSessionId formats parent and agent ids into the expected colon-delimited string', () => {
  assert.equal(subagentSessionId('parent', 'agent'), 'sub:parent:agent');
  const parent = '11111111-2222-3333-4444-555555555555';
  const agent = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  assert.equal(subagentSessionId(parent, agent), `sub:${parent}:${agent}`);
  // Round-trip the prefix structure.
  const id = subagentSessionId(parent, agent);
  const parts = id.split(':');
  assert.equal(parts[0], 'sub');
  assert.equal(parts[1], parent);
  assert.equal(parts[2], agent);
});

test('subagentSessionId throws TypeError when agentId or parentSessionId contains a colon', () => {
  assert.throws(() => subagentSessionId('parent:bad', 'agent'), TypeError);
  assert.throws(() => subagentSessionId('parent', 'agent:bad'), TypeError);
  assert.throws(() => subagentSessionId('par:ent', 'age:nt'), TypeError);
});

test('resolveJsonlPath returns top-level path when row has no parent/agent', () => {
  const projectsDir = '/projects';
  const row = { folder: 'foo', sessionId: 'session-1' };
  assert.equal(resolveJsonlPath(projectsDir, row), path.join('/projects', 'foo', 'session-1.jsonl'));
});

test('resolveJsonlPath returns subagent path when parentSessionId and agentId are set', () => {
  const projectsDir = '/projects';
  const row = {
    folder: 'foo',
    sessionId: 'sub:parent-uuid:agent-1',
    parentSessionId: 'parent-uuid',
    agentId: 'agent-1',
  };
  assert.equal(
    resolveJsonlPath(projectsDir, row),
    path.join('/projects', 'foo', 'parent-uuid', 'subagents', 'agent-agent-1.jsonl')
  );
});

test('readSubagentMeta reads sibling .meta.json when present and returns null when missing', () => {
  const tmp = mkTmp();
  try {
    const jsonlPath = path.join(tmp, 'agent-x.jsonl');
    const metaPath = path.join(tmp, 'agent-x.meta.json');
    fs.writeFileSync(metaPath, JSON.stringify({ agentType: 'Explore', description: 'find things' }), 'utf8');
    const meta = readSubagentMeta(jsonlPath);
    assert.deepEqual(meta, { agentType: 'Explore', description: 'find things' });

    const missing = readSubagentMeta(path.join(tmp, 'does-not-exist.jsonl'));
    assert.equal(missing, null);
  } finally {
    cleanup(tmp);
  }
});

test('enumerateSessionFiles discovers top-level sessions plus subagents and ignores junk', () => {
  const tmp = mkTmp();
  try {
    // Top-level session
    fs.writeFileSync(path.join(tmp, 'aaa.jsonl'), '', 'utf8');
    // Subagents under preferred layout
    const bbbSubagents = path.join(tmp, 'bbb', 'subagents');
    fs.mkdirSync(bbbSubagents, { recursive: true });
    fs.writeFileSync(path.join(bbbSubagents, 'agent-1.jsonl'), '', 'utf8');
    fs.writeFileSync(path.join(bbbSubagents, 'agent-2.jsonl'), '', 'utf8');
    // Fallback layout: jsonl directly in uuid dir
    const cccDir = path.join(tmp, 'ccc');
    fs.mkdirSync(cccDir);
    fs.writeFileSync(path.join(cccDir, 'legacy.jsonl'), '', 'utf8');
    // Junk that must be ignored
    fs.writeFileSync(path.join(tmp, 'not-a-jsonl.txt'), 'noise', 'utf8');
    fs.writeFileSync(path.join(tmp, 'bbb', 'random-file'), 'noise', 'utf8');

    const entries = enumerateSessionFiles(tmp);
    assert.equal(entries.length, 4, `expected 4 entries, got ${entries.length}: ${JSON.stringify(entries)}`);

    const byId = new Map(entries.map(e => [e.sessionId, e]));

    const top = byId.get('aaa');
    assert.ok(top, 'expected aaa top-level entry');
    assert.equal(top.parentSessionId, null);
    assert.equal(top.filePath, path.join(tmp, 'aaa.jsonl'));

    const a1 = byId.get('agent-1');
    assert.ok(a1, 'expected agent-1 subagent entry');
    assert.equal(a1.parentSessionId, 'bbb');
    assert.equal(a1.filePath, path.join(bbbSubagents, 'agent-1.jsonl'));

    const a2 = byId.get('agent-2');
    assert.ok(a2, 'expected agent-2 subagent entry');
    assert.equal(a2.parentSessionId, 'bbb');

    const legacy = byId.get('legacy');
    assert.ok(legacy, 'expected legacy fallback entry');
    assert.equal(legacy.parentSessionId, 'ccc');
    assert.equal(legacy.filePath, path.join(cccDir, 'legacy.jsonl'));
  } finally {
    cleanup(tmp);
  }
});

test('readSessionFile returns a top-level row when called without opts', () => {
  const tmp = mkTmp();
  try {
    const sessionId = 'plain-session';
    const filePath = path.join(tmp, `${sessionId}.jsonl`);
    fs.writeFileSync(
      filePath,
      JSON.stringify({ type: 'user', message: 'hello world' }) + '\n',
      'utf8'
    );

    const row = readSessionFile(filePath, 'folder-x', '/some/project');
    assert.ok(row, 'expected a row');
    assert.equal(row.sessionId, sessionId);
    assert.equal(row.folder, 'folder-x');
    assert.equal(row.projectPath, '/some/project');
    assert.equal(row.summary, 'hello world');
    assert.equal(row.messageCount, 1);
    assert.equal(row.parentSessionId, undefined);
    assert.equal(row.agentId, undefined);
  } finally {
    cleanup(tmp);
  }
});

test('readSessionFile (subagent) returns synthetic id plus parent/agent metadata when sidechain present', () => {
  const tmp = mkTmp();
  try {
    const parentSessionId = 'parent-uuid-abc';
    const agentId = 'abc123';
    const subagentsDir = path.join(tmp, parentSessionId, 'subagents');
    fs.mkdirSync(subagentsDir, { recursive: true });
    const filePath = path.join(subagentsDir, `agent-${agentId}.jsonl`);
    const metaPath = path.join(subagentsDir, `agent-${agentId}.meta.json`);

    fs.writeFileSync(
      filePath,
      JSON.stringify({
        type: 'user',
        message: 'first prompt to subagent',
        isSidechain: true,
        agentId,
      }) + '\n',
      'utf8'
    );
    fs.writeFileSync(
      metaPath,
      JSON.stringify({ agentType: 'Explore', description: 'do a thing' }),
      'utf8'
    );

    const row = readSessionFile(filePath, 'folder-x', '/some/project', { parentSessionId });
    assert.ok(row, 'expected a subagent row');
    assert.equal(row.sessionId, `sub:${parentSessionId}:${agentId}`);
    assert.equal(row.parentSessionId, parentSessionId);
    assert.equal(row.agentId, agentId);
    assert.equal(row.subagentType, 'Explore');
    assert.equal(row.description, 'do a thing');
    // summary prefers description when meta provides one
    assert.equal(row.summary, 'do a thing');
    // firstPrompt holds the actual first user text
    assert.equal(row.firstPrompt, 'first prompt to subagent');
  } finally {
    cleanup(tmp);
  }
});

test('readSessionFile (subagent) returns null when the file is not actually a sidechain', () => {
  const tmp = mkTmp();
  try {
    const filePath = path.join(tmp, 'agent-foo.jsonl');
    fs.writeFileSync(
      filePath,
      JSON.stringify({ type: 'user', message: 'looks normal', agentId: 'foo' }) + '\n',
      'utf8'
    );

    const row = readSessionFile(filePath, 'folder-x', '/p', { parentSessionId: 'parent' });
    assert.equal(row, null);
  } finally {
    cleanup(tmp);
  }
});

test('readSessionFile (subagent) falls back to filename when agentId is absent in jsonl entries', () => {
  const tmp = mkTmp();
  try {
    const filePath = path.join(tmp, 'agent-fallback.jsonl');
    fs.writeFileSync(
      filePath,
      JSON.stringify({ type: 'user', message: 'prompt', isSidechain: true }) + '\n',
      'utf8'
    );

    const row = readSessionFile(filePath, 'folder-x', '/p', { parentSessionId: 'parent-1' });
    assert.ok(row, 'expected a row even without inline agentId');
    assert.equal(row.agentId, 'fallback');
    assert.equal(row.sessionId, 'sub:parent-1:fallback');
  } finally {
    cleanup(tmp);
  }
});
