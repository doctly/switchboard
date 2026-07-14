const { test } = require('node:test');
const assert = require('node:assert');

const { parseSessionContent } = require('../read-session-file');

const userMsg = (text, ts) =>
  JSON.stringify({ type: 'user', timestamp: ts, message: { role: 'user', content: text } });
const asstMsg = (text, ts) =>
  JSON.stringify({ type: 'assistant', timestamp: ts, message: { role: 'assistant', content: [{ type: 'text', text }] } });

const META = { sessionId: 's1', folder: 'f', projectPath: '/p' };

test('parses summary, messageCount, textContent from basic content', () => {
  const content = [
    userMsg('Fix the login bug', '2026-07-10T10:00:00Z'),
    asstMsg('Sure, let me look', '2026-07-10T10:00:05Z'),
  ].join('\n');
  const r = parseSessionContent(content, { ...META, created: 'C', modified: 'M' });
  assert.strictEqual(r.summary, 'Fix the login bug');
  assert.strictEqual(r.firstPrompt, 'Fix the login bug');
  assert.strictEqual(r.messageCount, 2);
  assert.strictEqual(r.created, 'C');
  assert.strictEqual(r.modified, 'M');
  assert.strictEqual(r.sessionId, 's1');
  assert.strictEqual(r.folder, 'f');
  assert.strictEqual(r.projectPath, '/p');
  assert.ok(r.textContent.includes('Fix the login bug'));
  assert.ok(r.textContent.includes('Sure, let me look'));
});

test('skips local-command messages when choosing the summary', () => {
  const content = [
    userMsg('<bash-input>ls</bash-input>', '2026-07-10T10:00:00Z'),
    userMsg('Real first question', '2026-07-10T10:00:01Z'),
    asstMsg('ok', '2026-07-10T10:00:02Z'),
  ].join('\n');
  const r = parseSessionContent(content, { ...META, created: 'C', modified: 'M' });
  assert.strictEqual(r.summary, 'Real first question');
  assert.strictEqual(r.messageCount, 3);
});

test('extracts slug, customTitle, and aiTitle', () => {
  const content = [
    JSON.stringify({ type: 'user', slug: 'my-slug', message: { role: 'user', content: 'hi' } }),
    JSON.stringify({ type: 'custom-title', customTitle: 'My Title' }),
    JSON.stringify({ type: 'ai-title', aiTitle: 'AI Title' }),
    asstMsg('response', '2026-07-10T10:00:02Z'),
  ].join('\n');
  const r = parseSessionContent(content, { ...META, created: 'C', modified: 'M' });
  assert.strictEqual(r.slug, 'my-slug');
  assert.strictEqual(r.customTitle, 'My Title');
  assert.strictEqual(r.aiTitle, 'AI Title');
  assert.strictEqual(r.messageCount, 2);
  assert.strictEqual(r.summary, 'hi');
});

test('derives created/modified from entry timestamps when meta omits them', () => {
  const content = [
    userMsg('Q', '2026-01-01T00:00:00Z'),
    asstMsg('A', '2026-01-02T00:00:00Z'),
  ].join('\n');
  const r = parseSessionContent(content, { ...META });
  assert.strictEqual(r.created, '2026-01-01T00:00:00Z');
  assert.strictEqual(r.modified, '2026-01-02T00:00:00Z');
});

test('meta created/modified take precedence over entry timestamps', () => {
  const content = [
    userMsg('Q', '2026-01-01T00:00:00Z'),
    asstMsg('A', '2026-01-02T00:00:00Z'),
  ].join('\n');
  const r = parseSessionContent(content, { ...META, created: 'EXPLICIT_C', modified: 'EXPLICIT_M' });
  assert.strictEqual(r.created, 'EXPLICIT_C');
  assert.strictEqual(r.modified, 'EXPLICIT_M');
});

test('returns null when there is no usable summary or no messages', () => {
  assert.strictEqual(parseSessionContent('', { ...META }), null);
  const onlyTitle = JSON.stringify({ type: 'custom-title', customTitle: 'x' });
  assert.strictEqual(parseSessionContent(onlyTitle, { ...META }), null);
});

test('uses scheduled-task name as summary when present', () => {
  const content = [
    userMsg('<scheduled-task name="nightly backup">run it</scheduled-task>', '2026-01-01T00:00:00Z'),
    asstMsg('done', '2026-01-01T00:01:00Z'),
  ].join('\n');
  const r = parseSessionContent(content, { ...META, created: 'C', modified: 'M' });
  assert.strictEqual(r.summary, 'Scheduled: nightly backup');
});
