const { test } = require('node:test');
const assert = require('node:assert/strict');

const { decodeOsc52Payload } = require('../public/terminal-manager');

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');

test('decodes a normal OSC 52 write into clipboard text', () => {
  // "c" = clipboard selection; this is the path Claude Code's copy takes.
  assert.equal(decodeOsc52Payload(`c;${b64('hello world')}`), 'hello world');
});

test('decodes multi-byte UTF-8 rather than mangling it', () => {
  assert.equal(decodeOsc52Payload(`c;${b64('안녕하세요 — café 🎉')}`), '안녕하세요 — café 🎉');
});

test('a read-back query is REFUSED, not answered', () => {
  // Security property, not an unimplemented case: answering "?" would write the
  // user's clipboard back into the terminal, letting any program in the session
  // exfiltrate whatever they last copied. null means "consume and stay silent".
  //
  // If you are here because you are implementing the query response: don't.
  assert.equal(decodeOsc52Payload('c;?'), null);
  assert.equal(decodeOsc52Payload('p;?'), null);
  assert.equal(decodeOsc52Payload('?'), null);
});

test('empty payloads write nothing', () => {
  assert.equal(decodeOsc52Payload(''), null);
  assert.equal(decodeOsc52Payload('c;'), null);
});

test('a payload with no selection separator is treated as base64', () => {
  assert.equal(decodeOsc52Payload(b64('bare')), 'bare');
});

test('malformed base64 throws so the caller can report the sequence unhandled', () => {
  assert.throws(() => decodeOsc52Payload('c;@@@not base64@@@'));
});
