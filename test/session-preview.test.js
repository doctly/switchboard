const test = require('node:test');
const assert = require('node:assert/strict');
const { lastAssistantMessage } = require('../session-preview');

test('returns the final assistant text and ignores later tool-only records', () => {
  const entries = [
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Earlier answer' }] } },
    { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'Next request' }] } },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Final answer' }] } },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Read' }] } },
  ];

  assert.deepEqual(lastAssistantMessage(entries), { text: 'Final answer', truncated: false });
});

test('joins text blocks while excluding thinking and tool calls', () => {
  const entries = [{
    type: 'assistant',
    message: { role: 'assistant', content: [
      { type: 'thinking', thinking: 'private' },
      { type: 'text', text: 'First paragraph' },
      { type: 'tool_use', name: 'Bash' },
      { type: 'text', text: 'Second paragraph' },
    ] },
  }];

  assert.deepEqual(lastAssistantMessage(entries), { text: 'First paragraph\n\nSecond paragraph', truncated: false });
});

test('supports string content, empty input, and bounded previews', () => {
  assert.deepEqual(lastAssistantMessage(null), { text: '', truncated: false });
  assert.deepEqual(lastAssistantMessage([{ type: 'assistant', message: { content: '  hello  ' } }]), { text: 'hello', truncated: false });
  assert.deepEqual(lastAssistantMessage([{ type: 'assistant', message: { content: '123456' } }], 4), { text: '1234', truncated: true });
});
