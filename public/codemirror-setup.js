import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection, highlightSpecialChars } from '@codemirror/view';
import { EditorState } from '@codemirror/state';
import { defaultKeymap, indentWithTab, history, historyKeymap } from '@codemirror/commands';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { languages } from '@codemirror/language-data';
import { syntaxHighlighting, HighlightStyle, indentOnInput, bracketMatching, foldGutter, foldKeymap } from '@codemirror/language';
import { searchKeymap, highlightSelectionMatches } from '@codemirror/search';
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

function createPlanEditor(parent) {
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
        ...searchKeymap,
      ]),
      markdown({ base: markdownLanguage, codeLanguages: languages }),
      dracula,
      syntaxHighlighting(markdownExtras),
      appThemePatch,
      EditorView.lineWrapping,
    ],
  });

  const view = new EditorView({ state, parent });
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
      keymap.of([...foldKeymap, ...searchKeymap]),
      langExt,
      dracula,
      syntaxHighlighting(markdownExtras),
      appThemePatch,
    ],
  });
  return new EditorView({ state, parent });
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
    keymap.of([...foldKeymap, ...searchKeymap]),
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
      keymap.of([...foldKeymap, ...searchKeymap]),
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

// ── Exports ─────────────────────────────────────────────────────────

window.createPlanEditor = createPlanEditor;
window.createReadOnlyViewer = createReadOnlyViewer;
window.createMergeViewer = createMergeViewer;
window.createUnifiedMergeViewer = createUnifiedMergeViewer;
window.CMEditorView = EditorView;
window.CMEditorState = EditorState;
window.CMMergeView = MergeView;

marked.setOptions({ breaks: true, gfm: true });
window.marked = marked;
