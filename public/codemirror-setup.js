import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection, highlightSpecialChars, ViewPlugin, Decoration } from '@codemirror/view';
import { EditorState, StateField, StateEffect, Compartment } from '@codemirror/state';
import { defaultKeymap, indentWithTab, history, historyKeymap } from '@codemirror/commands';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { languages } from '@codemirror/language-data';
import { syntaxHighlighting, HighlightStyle, indentOnInput, bracketMatching, foldGutter, foldKeymap } from '@codemirror/language';
import { highlightSelectionMatches } from '@codemirror/search';
import { dracula } from '@ddietr/codemirror-themes/theme/dracula';
import { tags } from '@lezer/highlight';
import { MergeView, unifiedMergeView } from '@codemirror/merge';
import { javascript } from '@codemirror/lang-javascript';
import { python } from '@codemirror/lang-python';
import { json } from '@codemirror/lang-json';
import { html } from '@codemirror/lang-html';
import { css } from '@codemirror/lang-css';
import { marked } from 'marked';
import { rust } from '@codemirror/lang-rust';
import { go } from '@codemirror/lang-go';
import { java } from '@codemirror/lang-java';
import { xml } from '@codemirror/lang-xml';
import { yaml } from '@codemirror/lang-yaml';
import { sql } from '@codemirror/lang-sql';
import { cpp } from '@codemirror/lang-cpp';

const markdownExtras = HighlightStyle.define([
  { tag: tags.monospace, color: '#8BE9FD' },
]);

const appThemePatch = EditorView.theme({
  '&': { height: '100%', fontSize: '12.5px' },
  '.cm-content': { padding: '20px 8px' },
  '.cm-scroller': {
    scrollbarWidth: 'thin',
    scrollbarColor: 'rgba(255,255,255,0.08) transparent',
  },
}, { dark: true });

// ── Custom floating search bar (matches xterm search bar style) ──────

const setSearchQuery = StateEffect.define();
const searchQueryField = StateField.define({
  create() { return null; },
  update(val, tr) {
    for (const e of tr.effects) if (e.is(setSearchQuery)) return e.value;
    return val;
  },
});

const searchHighlighter = ViewPlugin.fromClass(class {
  constructor(view) { this.decorations = this._build(view); }
  update(update) {
    if (update.docChanged || update.state.field(searchQueryField) !== update.startState.field(searchQueryField)) {
      this.decorations = this._build(update.view);
    }
  }
  _build(view) {
    const q = view.state.field(searchQueryField);
    if (!q) return Decoration.none;
    const decs = [];
    const doc = view.state.doc.toString();
    const term = q.toLowerCase();
    let pos = 0;
    while ((pos = doc.toLowerCase().indexOf(term, pos)) !== -1) {
      decs.push(Decoration.mark({ class: 'cm-find-match' }).range(pos, pos + term.length));
      pos += term.length;
    }
    return Decoration.set(decs);
  }
}, { decorations: v => v.decorations });

const cmSearchTheme = EditorView.theme({
  '.cm-find-match': { backgroundColor: '#515C6A', borderRadius: '2px' },
  '.cm-find-match-active': { backgroundColor: '#EAA549', borderRadius: '2px' },
});

function cmFloatingSearch() {
  return [searchQueryField, searchHighlighter, cmSearchTheme];
}

function createCMSearchBar(parent, view) {
  const bar = document.createElement('div');
  bar.className = 'terminal-search-bar';
  bar.style.display = 'none';
  bar.innerHTML = `
    <input type="text" class="terminal-search-input" placeholder="Find..." />
    <span class="terminal-search-count"></span>
    <button class="terminal-search-prev" title="Previous (Shift+Enter)">&#x25B2;</button>
    <button class="terminal-search-next" title="Next (Enter)">&#x25BC;</button>
    <button class="terminal-search-close" title="Close (Escape)">&times;</button>
  `;
  parent.style.position = 'relative';
  parent.appendChild(bar);

  const input = bar.querySelector('.terminal-search-input');
  const countEl = bar.querySelector('.terminal-search-count');
  let matches = [];
  let activeIdx = -1;

  function findAll() {
    const q = input.value;
    matches = [];
    activeIdx = -1;
    if (!q) {
      view.dispatch({ effects: setSearchQuery.of(null) });
      countEl.textContent = '';
      return;
    }
    view.dispatch({ effects: setSearchQuery.of(q) });
    const doc = view.state.doc.toString();
    const term = q.toLowerCase();
    let pos = 0;
    while ((pos = doc.toLowerCase().indexOf(term, pos)) !== -1) {
      matches.push(pos);
      pos += term.length;
    }
    countEl.textContent = matches.length > 0 ? `${matches.length} found` : 'No results';
  }

  function goTo(idx) {
    if (matches.length === 0) return;
    activeIdx = ((idx % matches.length) + matches.length) % matches.length;
    const pos = matches[activeIdx];
    const q = input.value;
    view.dispatch({
      selection: { anchor: pos, head: pos + q.length },
      scrollIntoView: true,
    });
    countEl.textContent = `${activeIdx + 1} of ${matches.length}`;
  }

  function open() {
    bar.style.display = 'flex';
    input.focus();
    const sel = view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to);
    if (sel) { input.value = sel; findAll(); if (matches.length) goTo(0); }
  }

  function close() {
    bar.style.display = 'none';
    input.value = '';
    matches = [];
    activeIdx = -1;
    view.dispatch({ effects: setSearchQuery.of(null) });
    countEl.textContent = '';
    view.focus();
  }

  const isMacPlatform = /Mac|iPhone|iPad/.test(navigator.platform);
  input.addEventListener('input', () => { findAll(); if (matches.length) goTo(0); });
  input.addEventListener('keydown', (e) => {
    const mod = isMacPlatform ? e.metaKey : e.ctrlKey;
    if (e.key === 'Escape') { close(); e.preventDefault(); }
    else if (e.key === 'g' && mod) { openGotoLine(view); e.preventDefault(); }
    else if (e.key === 's' && mod) { view.dom.dispatchEvent(new CustomEvent('cm-save', { bubbles: true })); e.preventDefault(); }
    else if (e.key === 'Enter' && e.shiftKey) { goTo(activeIdx - 1); e.preventDefault(); }
    else if (e.key === 'Enter') { goTo(activeIdx + 1); e.preventDefault(); }
  });
  bar.querySelector('.terminal-search-next').addEventListener('click', () => goTo(activeIdx + 1));
  bar.querySelector('.terminal-search-prev').addEventListener('click', () => goTo(activeIdx - 1));
  bar.querySelector('.terminal-search-close').addEventListener('click', close);

  return { open, close, bar };
}

const cmFindKeymap = keymap.of([{
  key: 'Mod-f',
  run(view) {
    openCMSearch(view);
    return true;
  },
}]);

function openCMSearch(view) {
  const parent = view.dom.parentElement;
  // Close goto-line if open
  if (parent._cmGotoLine) parent._cmGotoLine.close();
  if (!parent._cmSearchBar) {
    parent._cmSearchBar = createCMSearchBar(parent, view);
  }
  parent._cmSearchBar.open();
}

// DOM-level Cmd/Ctrl+F listener for read-only editors where CM keymaps don't fire
const cmFindDomHandler = ViewPlugin.fromClass(class {
  constructor(view) {
    this._handler = (e) => {
      const mod = /Mac|iPhone|iPad/.test(navigator.platform) ? e.metaKey : e.ctrlKey;
      if (e.key === 'f' && mod && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        openCMSearch(view);
      }
    };
    // Make the wrapper focusable so clicks give it focus
    if (!view.dom.getAttribute('tabindex')) view.dom.setAttribute('tabindex', '0');
    view.dom.addEventListener('keydown', this._handler);
  }
  destroy() {
    // cleanup handled by CM disposing the DOM
  }
});

// ── Go to line (Cmd/Ctrl+G) ──────────────────────────────────────────

function createGotoLineBar(parent, view) {
  const bar = document.createElement('div');
  bar.className = 'terminal-search-bar';
  bar.style.display = 'none';
  bar.innerHTML = `
    <input type="text" class="terminal-search-input" placeholder="Go to line..." style="width:120px" />
    <span class="terminal-search-count"></span>
    <button class="terminal-search-close" title="Close (Escape)">&times;</button>
  `;
  parent.style.position = 'relative';
  parent.appendChild(bar);

  const input = bar.querySelector('.terminal-search-input');
  const countEl = bar.querySelector('.terminal-search-count');

  function goTo() {
    const lineNum = parseInt(input.value, 10);
    if (!lineNum || lineNum < 1) { countEl.textContent = 'Invalid'; return; }
    const doc = view.state.doc;
    if (lineNum > doc.lines) { countEl.textContent = `Max: ${doc.lines}`; return; }
    const line = doc.line(lineNum);
    view.dispatch({
      selection: { anchor: line.from },
      scrollIntoView: true,
    });
    countEl.textContent = `Line ${lineNum}`;
  }

  function open() {
    bar.style.display = 'flex';
    input.value = '';
    countEl.textContent = `of ${view.state.doc.lines}`;
    input.focus();
  }

  function close() {
    bar.style.display = 'none';
    input.value = '';
    countEl.textContent = '';
    view.focus();
  }

  const isMacPlatform = /Mac|iPhone|iPad/.test(navigator.platform);
  input.addEventListener('keydown', (e) => {
    const mod = isMacPlatform ? e.metaKey : e.ctrlKey;
    if (e.key === 'Escape') { close(); e.preventDefault(); }
    else if (e.key === 'f' && mod) { openCMSearch(view); e.preventDefault(); }
    else if (e.key === 's' && mod) { view.dom.dispatchEvent(new CustomEvent('cm-save', { bubbles: true })); e.preventDefault(); }
    else if (e.key === 'Enter') { goTo(); e.preventDefault(); }
  });
  bar.querySelector('.terminal-search-close').addEventListener('click', close);

  return { open, close };
}

function openGotoLine(view) {
  const parent = view.dom.parentElement;
  // Close search if open
  if (parent._cmSearchBar) parent._cmSearchBar.close();
  if (!parent._cmGotoLine) {
    parent._cmGotoLine = createGotoLineBar(parent, view);
  }
  parent._cmGotoLine.open();
}

const cmGotoLineKeymap = keymap.of([{
  key: 'Mod-g',
  run(view) { openGotoLine(view); return true; },
}]);

// Cmd/Ctrl+S — dispatch custom event so ViewerPanel can handle save
const cmSaveKeymap = keymap.of([{
  key: 'Mod-s',
  run(view) {
    view.dom.dispatchEvent(new CustomEvent('cm-save', { bubbles: true }));
    return true;
  },
}]);

const cmGotoLineDomHandler = ViewPlugin.fromClass(class {
  constructor(view) {
    this._handler = (e) => {
      const mod = /Mac|iPhone|iPad/.test(navigator.platform) ? e.metaKey : e.ctrlKey;
      if (e.key === 'g' && mod && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        openGotoLine(view);
      }
    };
    view.dom.addEventListener('keydown', this._handler);
  }
  destroy() {}
});

// DOM-level Cmd/Ctrl+S for read-only editors
const cmSaveDomHandler = ViewPlugin.fromClass(class {
  constructor(view) {
    this._handler = (e) => {
      const mod = /Mac|iPhone|iPad/.test(navigator.platform) ? e.metaKey : e.ctrlKey;
      if (e.key === 's' && mod && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        view.dom.dispatchEvent(new CustomEvent('cm-save', { bubbles: true }));
      }
    };
    view.dom.addEventListener('keydown', this._handler);
  }
  destroy() {}
});

function createPlanEditor(parent) {
  const wrapCompartment = new Compartment();
  const state = EditorState.create({
    doc: '',
    extensions: [
      lineNumbers(),
      highlightActiveLineGutter(),
      highlightSpecialChars(),
      history(),
      foldGutter(),
      drawSelection(),
      indentOnInput(),
      bracketMatching(),
      highlightActiveLine(),
      highlightSelectionMatches(),
      keymap.of([
        indentWithTab,
        ...defaultKeymap,
        ...historyKeymap,
        ...foldKeymap,
      ]),
      cmFindKeymap,
      cmGotoLineKeymap,
      cmSaveKeymap,
      cmFloatingSearch(),
      markdown({ base: markdownLanguage, codeLanguages: languages }),
      dracula,
      syntaxHighlighting(markdownExtras),
      appThemePatch,
      wrapCompartment.of(EditorView.lineWrapping),
    ],
  });

  const view = new EditorView({ state, parent });
  view._wrapCompartment = wrapCompartment;
  return view;
}

// ── Language Detection ───────────────────────────────────────────────

const LANG_MAP = {
  js: () => javascript(),
  mjs: () => javascript(),
  cjs: () => javascript(),
  jsx: () => javascript({ jsx: true }),
  ts: () => javascript({ typescript: true }),
  tsx: () => javascript({ jsx: true, typescript: true }),
  py: () => python(),
  json: () => json(),
  html: () => html(),
  htm: () => html(),
  css: () => css(),
  rs: () => rust(),
  go: () => go(),
  java: () => java(),
  xml: () => xml(),
  svg: () => xml(),
  yaml: () => yaml(),
  yml: () => yaml(),
  sql: () => sql(),
  c: () => cpp(),
  cpp: () => cpp(),
  cc: () => cpp(),
  h: () => cpp(),
  hpp: () => cpp(),
  md: () => markdown({ base: markdownLanguage, codeLanguages: languages }),
  mdx: () => markdown({ base: markdownLanguage, codeLanguages: languages }),
};

function getLanguageExt(filename) {
  const ext = (filename || '').split('.').pop()?.toLowerCase();
  const factory = LANG_MAP[ext];
  if (factory) return factory();
  return markdown({ base: markdownLanguage, codeLanguages: languages });
}

// ── Read-Only File Viewer ───────────────────────────────────────────

function createReadOnlyViewer(parent, content, filename) {
  const langExt = getLanguageExt(filename);
  const state = EditorState.create({
    doc: content,
    extensions: [
      EditorView.editable.of(false),
      EditorState.readOnly.of(true),
      lineNumbers(),
      highlightSpecialChars(),
      foldGutter(),
      bracketMatching(),
      highlightSelectionMatches(),
      keymap.of([...foldKeymap]),
      cmFindKeymap,
      cmFindDomHandler,
      cmGotoLineDomHandler,
      cmSaveDomHandler,
      cmFloatingSearch(),
      langExt,
      dracula,
      syntaxHighlighting(markdownExtras),
      appThemePatch,
    ],
  });
  return new EditorView({ state, parent });
}

// ── Editable File Viewer (for file panel) ───────────────────────────

function createEditableViewer(parent, content, filename, { wrap = false } = {}) {
  const langExt = getLanguageExt(filename);
  const wrapCompartment = new Compartment();

  const state = EditorState.create({
    doc: content,
    extensions: [
      lineNumbers(),
      highlightActiveLineGutter(),
      highlightSpecialChars(),
      history(),
      foldGutter(),
      drawSelection(),
      indentOnInput(),
      bracketMatching(),
      highlightActiveLine(),
      highlightSelectionMatches(),
      keymap.of([
        indentWithTab,
        ...defaultKeymap,
        ...historyKeymap,
        ...foldKeymap,
      ]),
      cmFindKeymap,
      cmGotoLineKeymap,
      cmSaveKeymap,
      cmFloatingSearch(),
      langExt,
      dracula,
      syntaxHighlighting(markdownExtras),
      appThemePatch,
      wrapCompartment.of(wrap ? EditorView.lineWrapping : []),
    ],
  });

  const view = new EditorView({ state, parent });
  view._wrapCompartment = wrapCompartment;
  return view;
}

// ── Diff / Merge Viewer ─────────────────────────────────────────────

function createMergeViewer(parent, originalContent, modifiedContent, filename) {
  const langExt = getLanguageExt(filename);
  const sharedExts = [
    lineNumbers(),
    highlightSpecialChars(),
    foldGutter(),
    bracketMatching(),
    highlightSelectionMatches(),
    keymap.of([...foldKeymap]),
    cmFindKeymap,
    cmFindDomHandler,
    cmFloatingSearch(),
    langExt,
    dracula,
    syntaxHighlighting(markdownExtras),
    appThemePatch,
  ];

  return new MergeView({
    parent,
    a: {
      doc: originalContent,
      extensions: [
        ...sharedExts,
        EditorView.editable.of(false),
        EditorState.readOnly.of(true),
      ],
    },
    b: {
      doc: modifiedContent,
      extensions: [...sharedExts],
    },
    gutter: true,
    highlightChanges: true,
    collapseUnchanged: { margin: 3, minSize: 4 },
  });
}

function createUnifiedMergeViewer(parent, originalContent, modifiedContent, filename) {
  const langExt = getLanguageExt(filename);
  const state = EditorState.create({
    doc: modifiedContent,
    extensions: [
      lineNumbers(),
      highlightSpecialChars(),
      foldGutter(),
      bracketMatching(),
      highlightSelectionMatches(),
      keymap.of([...foldKeymap]),
      cmFindKeymap,
      cmFindDomHandler,
      cmGotoLineDomHandler,
      cmSaveDomHandler,
      cmFloatingSearch(),
      langExt,
      dracula,
      syntaxHighlighting(markdownExtras),
      appThemePatch,
      unifiedMergeView({
        original: originalContent,
        gutter: true,
        highlightChanges: true,
        syntaxHighlightDeletions: true,
        collapseUnchanged: { margin: 3, minSize: 4 },
      }),
    ],
  });
  return new EditorView({ state, parent });
}

function createReadOnlyMergeViewer(parent, originalContent, modifiedContent, filename) {
  const langExt = getLanguageExt(filename);
  const sharedExts = [
    lineNumbers(),
    highlightSpecialChars(),
    foldGutter(),
    bracketMatching(),
    highlightSelectionMatches(),
    keymap.of([...foldKeymap]),
    cmFindKeymap,
    cmFindDomHandler,
    cmFloatingSearch(),
    langExt,
    dracula,
    syntaxHighlighting(markdownExtras),
    appThemePatch,
    EditorView.editable.of(false),
    EditorState.readOnly.of(true),
  ];

  return new MergeView({
    parent,
    a: { doc: originalContent, extensions: sharedExts },
    b: { doc: modifiedContent, extensions: sharedExts },
    gutter: true,
    highlightChanges: true,
    collapseUnchanged: { margin: 3, minSize: 4 },
  });
}

// ── Exports ─────────────────────────────────────────────────────────

window.createPlanEditor = createPlanEditor;
window.createReadOnlyViewer = createReadOnlyViewer;
window.createEditableViewer = createEditableViewer;
window.createMergeViewer = createMergeViewer;
window.createUnifiedMergeViewer = createUnifiedMergeViewer;
window.createReadOnlyMergeViewer = createReadOnlyMergeViewer;
window.CMEditorView = EditorView;
window.CMEditorState = EditorState;
window.CMMergeView = MergeView;
window.cmOpenGotoLine = openGotoLine;

marked.setOptions({ breaks: true, gfm: true });
window.marked = marked;
