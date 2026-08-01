const { test } = require('node:test');
const assert = require('node:assert/strict');

const { shouldSendSpaceDirectly } = require('../public/terminal-manager');

// Build a keydown-like event with sensible defaults (plain Space, no IME).
function kd(overrides = {}) {
  return {
    key: ' ',
    type: 'keydown',
    ctrlKey: false,
    altKey: false,
    metaKey: false,
    shiftKey: false,
    isComposing: false,
    keyCode: 32,
    ...overrides,
  };
}

test('plain Space (no IME) is sent directly to the PTY for push-to-talk key-repeat', () => {
  // The reason the direct-send path exists (#22): xterm's keydown path drops
  // plain Space, breaking Claude Code's "Hold Space to record".
  assert.equal(shouldSendSpaceDirectly(kd()), true);
});

test('Space during IME composition is NOT sent directly (isComposing)', () => {
  // Regression fix: intercepting this Space with preventDefault dropped/mangled
  // the in-progress Hangul syllable. Must defer to xterm's composition helper.
  assert.equal(shouldSendSpaceDirectly(kd({ isComposing: true })), false);
});

test('Space during IME composition is NOT sent directly (keyCode 229 sentinel)', () => {
  // Chromium reports keyCode 229 for keydowns consumed by the IME, and some
  // IMEs do not set isComposing on the committing keystroke.
  assert.equal(shouldSendSpaceDirectly(kd({ keyCode: 229 })), false);
});

test('Space combined with a modifier is not the push-to-talk path', () => {
  assert.equal(shouldSendSpaceDirectly(kd({ ctrlKey: true })), false);
  assert.equal(shouldSendSpaceDirectly(kd({ metaKey: true })), false);
  assert.equal(shouldSendSpaceDirectly(kd({ altKey: true })), false);
  assert.equal(shouldSendSpaceDirectly(kd({ shiftKey: true })), false);
});

test('non-Space keys are never on the direct-send path', () => {
  assert.equal(shouldSendSpaceDirectly(kd({ key: 'a', keyCode: 65 })), false);
});
