// plan-parser.js — plan-tracker.md and todos.md as data.
//
// One file for both sides: the renderer loads it as a classic script (the
// functions land on window), main requires it (module.exports). Keeping a
// single parser means the page, the file watcher and the tests agree on what
// a phase, an item and a tick are.
//
// A tracker is markdown: every level-2 heading is a phase, the "- [ ]" lines
// under it are its items. A heading may carry its own checkbox
// ("## [x] Phase 1: …"). A phase is done when its heading is ticked, or when
// it has items and all of them are ticked. A tracker with no level-2 headings
// is read as one phase per top-level item. A todo file is just its items.

(function (root) {
  const CHECKBOX_RE = /^(\s*[-*]\s+\[)( |x|X)(\]\s*)(.*)$/;
  const HEADING_RE = /^(#{1,6})(\s+)(?:\[( |x|X)\]\s+)?(.*)$/;

  function splitLines(text) {
    return String(text || '').split(/\r?\n/);
  }

  function itemAt(lines, i) {
    const m = lines[i].match(CHECKBOX_RE);
    return m ? { line: i, text: m[4].trim(), done: m[2] !== ' ' } : null;
  }

  function parsePlan(content) {
    const phases = [];
    if (!content) return { phases, done: 0, total: 0, next: null };
    const lines = splitLines(content);
    let current = null;
    let sawHeading = false;
    for (let i = 0; i < lines.length; i++) {
      const h = lines[i].match(HEADING_RE);
      if (h && h[1].length === 2) {
        sawHeading = true;
        current = { title: h[4].trim(), line: i, headingDone: h[3] ? h[3] !== ' ' : null, items: [] };
        phases.push(current);
        continue;
      }
      const item = itemAt(lines, i);
      if (item && current) current.items.push(item);
    }
    if (!sawHeading) {
      // No phases written yet: each top-level item stands for one.
      for (let i = 0; i < lines.length; i++) {
        const item = itemAt(lines, i);
        if (item && !/^\s/.test(lines[i])) phases.push({ title: item.text, line: i, headingDone: item.done, items: [], single: true });
      }
    }
    for (const p of phases) {
      p.ticked = p.items.filter(it => it.done).length;
      p.done = p.headingDone === true || (p.headingDone === null && p.items.length > 0 && p.items.every(it => it.done));
    }
    const done = phases.filter(p => p.done).length;
    const next = phases.find(p => !p.done) || null;
    return { phases, done, total: phases.length, next };
  }

  function parseTodos(content) {
    const items = [];
    if (!content) return items;
    const lines = splitLines(content);
    for (let i = 0; i < lines.length; i++) {
      const item = itemAt(lines, i);
      if (item) items.push(item);
    }
    return items;
  }

  /**
   * Tick or untick one line: an item, or a heading (a heading without a
   * checkbox gets one). Returns { ok, content, text } and leaves other lines
   * byte-for-byte alone.
   */
  function toggleLine(content, lineNo, done) {
    const lines = splitLines(content);
    const line = lines[lineNo];
    if (line === undefined) return { ok: false, content, text: null };
    const item = line.match(CHECKBOX_RE);
    if (item) {
      lines[lineNo] = `${item[1]}${done ? 'x' : ' '}${item[3]}${item[4]}`;
      return { ok: true, content: lines.join('\n'), text: item[4].trim() };
    }
    const h = line.match(HEADING_RE);
    if (h) {
      lines[lineNo] = `${h[1]}${h[2]}[${done ? 'x' : ' '}] ${h[4]}`;
      return { ok: true, content: lines.join('\n'), text: h[4].trim() };
    }
    return { ok: false, content, text: null };
  }

  /** Replace the text of one checkbox line, keeping its indent, bullet and tick. */
  function setLineText(content, lineNo, text) {
    const lines = splitLines(content);
    const line = lines[lineNo];
    const item = line === undefined ? null : line.match(CHECKBOX_RE);
    const clean = String(text || '').trim();
    if (!item || !clean) return { ok: false, content, text: null };
    lines[lineNo] = `${item[1]}${item[2]}${item[3]}${clean}`;
    return { ok: true, content: lines.join('\n'), text: clean, previous: item[4].trim() };
  }

  /** Append "- [ ] text" at the end, starting the file with a heading when it is empty. */
  function appendItem(content, text, heading) {
    let out = String(content || '');
    if (!out.trim()) out = heading ? `# ${heading}\n\n` : '';
    if (out && !out.endsWith('\n')) out += '\n';
    return out + `- [ ] ${String(text).trim()}\n`;
  }

  /** Item texts that are ticked, for diffing two versions of a file. */
  function tickedTexts(content) {
    const out = new Set();
    for (const it of parseTodos(content)) if (it.done) out.add(it.text);
    for (const p of parsePlan(content).phases) if (p.headingDone === true || p.single && p.headingDone) out.add(p.title);
    return out;
  }

  const api = { CHECKBOX_RE, HEADING_RE, parsePlan, parseTodos, toggleLine, setLineText, appendItem, tickedTexts };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else Object.assign(root, api);
})(typeof window !== 'undefined' ? window : globalThis);
