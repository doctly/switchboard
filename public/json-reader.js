// JSON reader: a collapsible tree for .json and .jsonc files, shown by the
// viewer's Preview button next to the editor.
//
// Parsing is jsonc-parser, VS Code's parser (already used for tasks.json).
// Its tree keeps what JSON.parse loses and a reader should show: key order,
// duplicate keys, and exact numbers, taken from the file's own text because
// the parsed value is rounded. Its errors carry offsets; V8's JSON.parse
// messages often have none. .jsonc allows comments and trailing commas; .json
// stays strict.
//
// Children are built when a node is first opened, so a large file costs only
// what is on screen.
(function (root) {
  const jsonc = typeof module !== 'undefined' && module.exports ? require('jsonc-parser') : root.JsoncParser;
  // jsonc-parser recurses once per level and overflows the stack on very deep
  // input, so deeper than this is reported as an error before it parses.
  const MAX_DEPTH = 512;
  // The top level opens its containers only while there are few of them.
  const AUTO_OPEN_CHILDREN = 20;
  // jsonc-parser's error codes, in words.
  const MESSAGES = {
    InvalidSymbol: 'Unexpected character',
    InvalidNumberFormat: 'Invalid number',
    PropertyNameExpected: 'Expected a property name in double quotes',
    ValueExpected: 'Expected a value',
    ColonExpected: "Expected ':' after the property name",
    CommaExpected: "Expected ','",
    CloseBraceExpected: "Expected '}'",
    CloseBracketExpected: "Expected ']'",
    EndOfFileExpected: 'Unexpected content after the end of the JSON value',
    InvalidCommentToken: 'Comments are not allowed in .json (they are in .jsonc)',
    UnexpectedEndOfComment: 'Unterminated comment',
    UnexpectedEndOfString: 'Unterminated string',
    UnexpectedEndOfNumber: 'Invalid number',
    InvalidUnicode: 'Invalid \\u escape',
    InvalidEscapeCharacter: 'Invalid escape',
    InvalidCharacter: 'Unescaped control character in a string',
  };

  /** Offset where nesting first passes MAX_DEPTH, or -1. The scanner does not recurse. */
  function tooDeepAt(text) {
    const scanner = jsonc.createScanner(text, true);
    const K = jsonc.SyntaxKind;
    let depth = 0;
    for (let token = scanner.scan(); token !== K.EOF; token = scanner.scan()) {
      if (token === K.OpenBraceToken || token === K.OpenBracketToken) {
        if (++depth > MAX_DEPTH) return scanner.getTokenOffset();
      } else if (token === K.CloseBraceToken || token === K.CloseBracketToken) {
        depth--;
      }
    }
    return -1;
  }

  /** jsonc-parser's nodes into the reader's own shape. Only called on a tree without errors. */
  function convert(node, text) {
    switch (node.type) {
      case 'object':
        return { type: 'object', entries: (node.children || []).map(property => ({
          key: property.children[0].value, value: convert(property.children[1], text),
        })) };
      case 'array':
        return { type: 'array', items: (node.children || []).map(child => convert(child, text)) };
      case 'number':
        return { type: 'number', text: text.slice(node.offset, node.offset + node.length) };
      case 'string':
      case 'boolean':
        return { type: node.type, value: node.value };
      default:
        return { type: 'null' };
    }
  }

  /** 1-based line and column of an offset, counted the way the editor counts. */
  function lineColumn(text, offset) {
    let line = 1;
    let lineStart = 0;
    for (let k = 0; k < offset && k < text.length; k++) {
      if (text.charCodeAt(k) === 10) { line++; lineStart = k + 1; }
    }
    return { line, column: offset - lineStart + 1 };
  }

  /**
   * { ok: true, root } or { ok: false, message, offset, line, column }.
   * comments: true reads JSONC (comments and trailing commas allowed).
   */
  function parseJsonForReader(text, { comments = false } = {}) {
    const source = String(text ?? '');
    // A byte order mark is not JSON, but editors write one; read past it and
    // keep reported positions in terms of the file as the editor shows it.
    const skip = source.charCodeAt(0) === 0xfeff ? 1 : 0;
    const body = skip ? source.slice(1) : source;
    const fail = (message, offset) => ({ ok: false, message, offset: offset + skip, ...lineColumn(source, offset + skip) });

    const deep = tooDeepAt(body);
    if (deep >= 0) return fail(`Nested more than ${MAX_DEPTH} levels, too deep to show`, deep);
    const errors = [];
    const tree = jsonc.parseTree(body, errors, { disallowComments: !comments, allowTrailingComma: comments, allowEmptyContent: false });
    if (errors.length) {
      const code = jsonc.printParseErrorCode(errors[0].error);
      return fail(MESSAGES[code] || code, errors[0].offset);
    }
    if (!tree) return fail('Expected a value', 0);
    return { ok: true, root: convert(tree, body) };
  }

  // ── Tree ──────────────────────────────────────────────────────────

  function childCount(node) {
    if (node.type === 'object') return node.entries.length;
    if (node.type === 'array') return node.items.length;
    return 0;
  }

  function scalarText(node) {
    if (node.type === 'string') return JSON.stringify(node.value);
    if (node.type === 'number') return node.text;
    if (node.type === 'boolean') return String(node.value);
    return 'null';
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function appendKey(row, key) {
    if (!key) return;
    const label = el('span', key.index ? 'json-reader-key json-reader-index' : 'json-reader-key',
      key.index ? String(key.name) : JSON.stringify(key.name));
    if (key.duplicate) {
      label.className += ' json-reader-dup';
      label.setAttribute('title', 'Duplicate key. Most JSON readers keep only the last one.');
    }
    row.appendChild(label);
    row.appendChild(el('span', 'json-reader-colon', ': '));
  }

  function buildNode(node, key, path, depth, state, firstRender, siblings) {
    if (node.type !== 'object' && node.type !== 'array') {
      const row = el('div', 'json-reader-row json-reader-leaf');
      appendKey(row, key);
      row.appendChild(el('span', `json-reader-value json-reader-${node.type}`, scalarText(node)));
      return row;
    }
    const [open, close] = node.type === 'object' ? ['{', '}'] : ['[', ']'];
    const count = childCount(node);
    if (!count) {
      const row = el('div', 'json-reader-row json-reader-leaf');
      appendKey(row, key);
      row.appendChild(el('span', 'json-reader-brace', open + close));
      return row;
    }

    const details = el('details', 'json-reader-node');
    const summary = el('summary', 'json-reader-row');
    appendKey(summary, key);
    summary.appendChild(el('span', 'json-reader-brace', `${open}…${close}`));
    const noun = node.type === 'object' ? (count === 1 ? 'key' : 'keys') : (count === 1 ? 'item' : 'items');
    summary.appendChild(el('span', 'json-reader-count', `${count} ${noun}`));
    details.appendChild(summary);
    const body = el('div', 'json-reader-children');
    details.appendChild(body);

    let built = false;
    const buildChildren = () => {
      if (built) return;
      built = true;
      if (node.type === 'array') {
        node.items.forEach((item, index) => {
          body.appendChild(buildNode(item, { name: index, index: true }, `${path}/${index}`, depth + 1, state, firstRender, count));
        });
        return;
      }
      const totals = new Map();
      for (const entry of node.entries) totals.set(entry.key, (totals.get(entry.key) || 0) + 1);
      const seen = new Map();
      for (const entry of node.entries) {
        const nth = seen.get(entry.key) || 0;
        seen.set(entry.key, nth + 1);
        // encodeURIComponent never emits '#', so a duplicate's marker cannot
        // collide with another key's name.
        const childPath = `${path}/${encodeURIComponent(entry.key)}${nth ? `#${nth}` : ''}`;
        body.appendChild(buildNode(entry.value, { name: entry.key, duplicate: totals.get(entry.key) > 1 },
          childPath, depth + 1, state, firstRender, count));
      }
    };

    // First render: the top is open, and its containers too while there are
    // few. After that (a reload, a buffer edit) whatever the user left open.
    const startOpen = firstRender
      ? depth === 0 || (depth === 1 && siblings <= AUTO_OPEN_CHILDREN)
      : state.open.has(path);
    details.open = startOpen;
    if (startOpen) {
      state.open.add(path);
      buildChildren();
    }
    details.addEventListener('toggle', () => {
      if (details.open) {
        state.open.add(path);
        buildChildren();
      } else {
        state.open.delete(path);
      }
    });
    return details;
  }

  /**
   * Render a parsed tree into container. state.open is the set of expanded
   * node paths; pass the same state object back on a re-render to keep them.
   */
  function renderTree(container, tree, state) {
    const firstRender = !state.open;
    if (firstRender) state.open = new Set();
    container.appendChild(buildNode(tree, null, '', 0, state, firstRender, 1));
  }

  const api = { parseJsonForReader, renderTree, lineColumn };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.JsonReader = api;
})(typeof window !== 'undefined' ? window : globalThis);
