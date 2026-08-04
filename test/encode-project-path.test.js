const test = require('node:test');
const assert = require('node:assert/strict');
const { encodeProjectPath } = require('../encode-project-path');

test('replaces slashes and special chars with dashes', () => {
  assert.equal(encodeProjectPath('/home/user/my-project'), '-home-user-my-project');
});

test('keeps alphanumerics and dashes unchanged', () => {
  assert.equal(encodeProjectPath('abc-123'), 'abc-123');
});

test('short path returned as-is (under 200 chars)', () => {
  const p = '/Users/zakhar/Projects/switchboard';
  const result = encodeProjectPath(p);
  assert.ok(result.length <= 200);
  assert.ok(!result.includes('/'));
});

test('long path is truncated to 200 chars + dash + hash', () => {
  const p = '/Users/zakhar/' + 'a'.repeat(300);
  const result = encodeProjectPath(p);
  // Format: <200 chars>-<base36 hash>
  assert.ok(result.length > 200);
  const parts = result.split('-');
  const hash = parts[parts.length - 1];
  assert.ok(/^[0-9a-z]+$/.test(hash), 'hash should be base36');
  assert.equal(result.slice(0, 200), p.replace(/[^a-zA-Z0-9]/g, '-').slice(0, 200));
});

test('same path always produces same result (deterministic)', () => {
  const p = '/Users/zakhar/Projects/some-project';
  assert.equal(encodeProjectPath(p), encodeProjectPath(p));
});

test('different paths produce different results', () => {
  assert.notEqual(
    encodeProjectPath('/home/user/project-a'),
    encodeProjectPath('/home/user/project-b')
  );
});
