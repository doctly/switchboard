const test = require('node:test');
const assert = require('node:assert/strict');
const { parseFrontmatter } = require('../schedule-runner');

test('parses simple key-value frontmatter', () => {
  const content = `---
name: My Task
cron: 0 9 * * 1-5
enabled: true
---

Do the thing.`;
  const { meta, body } = parseFrontmatter(content);
  assert.equal(meta.name, 'My Task');
  assert.equal(meta.cron, '0 9 * * 1-5');
  assert.equal(meta.enabled, 'true');
  assert.equal(body, 'Do the thing.');
});

test('parses nested key block (cli section)', () => {
  const content = `---
name: Test
cron: * * * * *
cli:
  permission-mode: acceptEdits
  allowed-tools: Bash,Read
---
body here`;
  const { meta } = parseFrontmatter(content);
  assert.equal(meta.cli['permission-mode'], 'acceptEdits');
  assert.equal(meta.cli['allowed-tools'], 'Bash,Read');
});

test('returns empty meta and full content when no frontmatter', () => {
  const content = 'Just a plain markdown file.';
  const { meta, body } = parseFrontmatter(content);
  assert.deepEqual(meta, {});
  assert.equal(body, content.trim());
});

test('handles empty body after frontmatter', () => {
  const content = `---
name: Empty
cron: 0 0 * * *
---`;
  const { meta, body } = parseFrontmatter(content);
  assert.equal(meta.name, 'Empty');
  assert.equal(body, '');
});

test('body preserves multiline content', () => {
  const content = `---
name: Multi
cron: 0 0 * * *
---
Line one.
Line two.
Line three.`;
  const { body } = parseFrontmatter(content);
  assert.ok(body.includes('Line one.'));
  assert.ok(body.includes('Line three.'));
});
