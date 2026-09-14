const test = require('node:test');
const assert = require('node:assert/strict');

const { parseJsonForReader } = require('../public/json-reader');

test('keeps key order, exact numbers and duplicate keys that JSON.parse would lose', () => {
  const r = parseJsonForReader('{"b": 1, "2": 2, "a": 12345678901234567890, "a": -0.5e3}');
  assert.equal(r.ok, true);
  assert.deepEqual(r.root.entries.map(e => e.key), ['b', '2', 'a', 'a']);
  assert.equal(r.root.entries[2].value.text, '12345678901234567890');
  assert.equal(r.root.entries[3].value.text, '-0.5e3');
});

test('reads every value type, escapes, and a leading byte order mark', () => {
  const marked = parseJsonForReader('\uFEFF{\n "a": }');
  assert.deepEqual([marked.line, marked.column], [2, 7], 'positions count the mark, as the editor does');
  const r = parseJsonForReader('﻿[true, false, null, "a\\n\\u00e9\\"\\/", {}, [], 0]');
  assert.equal(r.ok, true);
  assert.deepEqual(r.root.items.map(n => n.type), ['boolean', 'boolean', 'null', 'string', 'object', 'array', 'number']);
  assert.equal(r.root.items[3].value, 'a\né"/');
});

test('agrees with JSON.parse on what is valid', () => {
  const samples = ['{}', '[]', '0', '-1.5E+2', '"x"', ' {"a":[1,{"b":null}]} ', '{"a":1,}', '[1,]', '01', '1.', '.5',
    '+1', "{'a':1}", '{"a" 1}', '"\\x"', '"tab\there"', 'tru', 'nul', '[1 2]', '{"a":1}{', '', '   ', '"\\u12G4"',
    'NaN', '[', '-', '1e', '"\\u00e9"', '[-0, 1e-7, 2E3]', '{"":""}'];
  for (const s of samples) {
    let native = true;
    try { JSON.parse(s); } catch { native = false; }
    assert.equal(parseJsonForReader(s).ok, native, `disagrees on ${JSON.stringify(s)}`);
  }
});

test('a broken file reports where it first goes wrong, as line and column', () => {
  const token = parseJsonForReader('{\n  "a": 1,\n  "b": }');
  assert.equal(token.ok, false);
  assert.match(token.message, /Expected a value/);
  assert.deepEqual([token.line, token.column], [3, 8]);

  const trailing = parseJsonForReader('{\n  "a": 1,\n}');
  assert.match(trailing.message, /property name/);
  assert.deepEqual([trailing.line, trailing.column], [3, 1]);

  const cut = parseJsonForReader('[1, 2');
  assert.match(cut.message, /Expected '\]'/);
  assert.deepEqual([cut.line, cut.column], [1, 6]);

  const open = parseJsonForReader('{"a": "never closed');
  assert.match(open.message, /Unterminated string/);
  assert.deepEqual([open.line, open.column], [1, 7]);
});

test('nesting too deep to show is an error, not a stack overflow', () => {
  const r = parseJsonForReader('['.repeat(100000) + ']'.repeat(100000));
  assert.equal(r.ok, false);
  assert.match(r.message, /too deep/);
});

test('.json stays strict about comments and trailing commas; .jsonc allows both', () => {
  const text = '// settings\n{\n  "a": 1, /* note */\n  "b": [2,],\n}';
  const strict = parseJsonForReader(text);
  assert.equal(strict.ok, false);
  assert.match(strict.message, /Comments are not allowed/);
  assert.deepEqual([strict.line, strict.column], [1, 1]);
  const loose = parseJsonForReader(text, { comments: true });
  assert.equal(loose.ok, true);
  assert.deepEqual(loose.root.entries.map(e => e.key), ['a', 'b']);
  assert.equal(loose.root.entries[1].value.items.length, 1);
});
