const DEFAULT_MAX_LENGTH = 4000;

/**
 * Return the text from the final assistant message in a normalized transcript.
 * Tool calls and thinking blocks are deliberately ignored: the overview hover
 * is a preview of what the assistant ultimately said to the user.
 */
function lastAssistantMessage(entries, maxLength = DEFAULT_MAX_LENGTH) {
  if (!Array.isArray(entries)) return '';

  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (!entry || (entry.type !== 'assistant' && entry.message?.role !== 'assistant')) continue;

    const content = entry.message?.content;
    let text = '';
    if (typeof content === 'string') {
      text = content;
    } else if (Array.isArray(content)) {
      text = content
        .filter(block => block && block.type === 'text' && typeof block.text === 'string')
        .map(block => block.text)
        .join('\n\n');
    }

    text = text.replace(/\r\n?/g, '\n').trim();
    if (!text) continue;
    if (!Number.isFinite(maxLength) || maxLength < 1 || text.length <= maxLength) return text;
    return text.slice(0, maxLength).trimEnd() + '\u2026';
  }

  return '';
}

module.exports = { DEFAULT_MAX_LENGTH, lastAssistantMessage };
