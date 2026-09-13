const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ID = '41a185fe-81fa-459a-9f48-cab9e5ab1e65';
const harnesses = [
  {
    name: 'Claude',
    harness: require('../harnesses/claude'),
    filename: `${ID}.jsonl`,
    prefix: [],
    message: (role, content) => ({ type: role, cwd: '/tmp/project', message: { role, content } }),
    text: text => ({ type: 'text', text }),
    other: [
      { type: 'system', message: 'system_marker' },
      { type: 'file-history-snapshot', snapshot: { text: 'snapshot_marker' } },
    ],
  },
  {
    name: 'Codex',
    harness: require('../harnesses/codex'),
    filename: `rollout-2026-09-08T10-00-00-${ID}.jsonl`,
    prefix: [{ type: 'session_meta', payload: { cwd: '/tmp/project' } }],
    message: (role, content) => ({ type: 'response_item', payload: { type: 'message', role, content } }),
    text: text => ({ type: 'output_text', text }),
    other: [
      { type: 'response_item', payload: { type: 'function_call', name: 'tool_name_marker', arguments: 'tool_input_marker' } },
      { type: 'response_item', payload: { type: 'function_call_output', output: 'tool_output_marker' } },
      { type: 'response_item', payload: { type: 'custom_tool_call', name: 'tool_name_marker', input: 'tool_input_marker' } },
      { type: 'response_item', payload: { type: 'custom_tool_call_output', output: 'tool_output_marker' } },
      { type: 'response_item', payload: { type: 'reasoning', summary: [{ text: 'thinking_marker' }], encrypted_content: 'encrypted_marker' } },
      { type: 'event_msg', payload: { type: 'agent_message', message: 'event_marker' } },
    ],
  },
];

function readFixture(provider, entries) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'conversation-search-'));
  try {
    const file = path.join(dir, provider.filename);
    fs.writeFileSync(file, [...provider.prefix, ...entries].map(e => JSON.stringify(e)).join('\n') + '\n');
    return provider.harness.readSessionFile(file, 'folder', '/tmp/project');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

for (const provider of harnesses) {
  test(`${provider.name} indexes full messages and later turns beyond the old search limits`, () => {
    const first = 'a'.repeat(600) + ' move_fna_lines';
    const middle = 'b'.repeat(600);
    const session = readFixture(provider, [
      provider.message('user', first),
      ...Array.from({ length: 20 }, () => provider.message('assistant', [provider.text(middle)])),
      provider.message('assistant', [provider.text('late_conversation_marker'), provider.text('second_block_marker')]),
      provider.message('user', [{ type: 'input_text', text: 'codex_input_marker' }, { type: 'text', text: 'final_user_marker' }]),
    ]);
    assert.ok(session);
    assert.ok(session.textContent.includes(first), 'the first message must not be cut at 500 characters');
    assert.ok(session.textContent.includes(middle), 'assistant messages must not be cut either');
    assert.ok(session.textContent.includes('late_conversation_marker\nsecond_block_marker'));
    assert.ok(session.textContent.includes('final_user_marker'));
    if (provider.name === 'Codex') assert.ok(session.textContent.includes('codex_input_marker'));
    assert.ok(session.textContent.length > 12000, 'the index must not stop after 8000 characters');
    assert.equal(session.summary, first.slice(0, 120), 'sidebar previews remain short');
  });

  test(`${provider.name} indexes only conversation text, excluding tools and scaffolding`, () => {
    const session = readFixture(provider, [
      provider.message('developer', [provider.text('developer_marker')]),
      provider.message('user', [
        { type: 'image', source: { data: 'image_marker' } },
        { type: 'text', text: 'real_question' },
      ]),
      provider.message('assistant', [
        { type: 'thinking', thinking: 'thinking_marker', text: 'thinking_marker', signature: 'signature_marker' },
        provider.text('first_answer'),
        { type: 'tool_use', name: 'tool_name_marker', input: { command: 'tool_input_marker' } },
        provider.text('second_answer'),
      ]),
      provider.message('user', [{ type: 'tool_result', content: [{ type: 'text', text: 'tool_output_marker' }] }]),
      ...provider.other,
    ]);
    assert.ok(session);
    assert.equal(session.summary, 'real_question', 'text after an image must still supply the summary');
    assert.equal(session.textContent, 'real_question\nfirst_answer\nsecond_answer');
  });
}
