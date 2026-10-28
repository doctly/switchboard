#!/usr/bin/env node
// Generates public/theme-light.generated.css from the dark stylesheets.
//
// The app's CSS is written for a dark UI with hard-coded colors. Rather than
// rewriting it around variables (and conflicting with every upstream change),
// this script re-emits every rule that sets a color, scoped under
// :root[data-theme="light"], with the color mapped to a light-theme
// equivalent. The mapping depends on what the color is used for: a light
// gray is dark text in the light theme, but a dark gray background becomes a
// light surface.
//
// Hand-tuned fixes live in public/theme-light.css, which loads after the
// generated file. Re-run after changing style.css:
//
//   npm run generate:light-theme

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SOURCES = ['public/style.css', 'public/whats-new.css'];
const OUTPUT = 'public/theme-light.generated.css';
const SCOPE = ':root[data-theme="light"]';

// Exact replacements for colors that define the overall look; everything
// else goes through the formulas below. Keyed by usage context.
const PINNED = {
  bg: {
    '#111118': '#f4f4f8', // app background
    '#18181f': '#fafafc',
    '#1a1a2e': '#ffffff', // popovers, toasts
    '#0e0e14': '#ececf2',
    '#1e1e2e': '#f4f4f8',
  },
  text: {
    '#e0e0e0': '#1d1d26',
  },
};

// --- CSS parsing ---------------------------------------------------------

function stripComments(css) {
  let out = '';
  for (let i = 0; i < css.length; i++) {
    const c = css[i];
    if (c === '"' || c === "'") {
      const end = findStringEnd(css, i);
      out += css.slice(i, end + 1);
      i = end;
    } else if (c === '/' && css[i + 1] === '*') {
      const end = css.indexOf('*/', i + 2);
      i = end === -1 ? css.length : end + 1;
    } else {
      out += c;
    }
  }
  return out;
}

function findStringEnd(css, start) {
  const quote = css[start];
  for (let i = start + 1; i < css.length; i++) {
    if (css[i] === '\\') { i++; continue; }
    if (css[i] === quote) return i;
  }
  return css.length - 1;
}

// Parses a block's contents into { type: 'rule' | 'at', prelude, body } nodes.
// Rule bodies stay as raw declaration text; at-rule bodies are parsed again.
function parseBlock(css) {
  const nodes = [];
  let i = 0;
  while (i < css.length) {
    let j = i;
    let prelude = '';
    while (j < css.length && css[j] !== '{' && css[j] !== ';' && css[j] !== '}') {
      if (css[j] === '"' || css[j] === "'") {
        const end = findStringEnd(css, j);
        prelude += css.slice(j, end + 1);
        j = end + 1;
      } else {
        prelude += css[j++];
      }
    }
    if (j >= css.length) break;
    if (css[j] !== '{') { i = j + 1; continue; } // @import; or stray }
    const close = findBlockEnd(css, j);
    const body = css.slice(j + 1, close);
    prelude = prelude.trim();
    if (prelude.startsWith('@')) {
      nodes.push({ type: 'at', prelude, body });
    } else {
      nodes.push({ type: 'rule', prelude, body });
    }
    i = close + 1;
  }
  return nodes;
}

function findBlockEnd(css, open) {
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    const c = css[i];
    if (c === '"' || c === "'") { i = findStringEnd(css, i); continue; }
    if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return i;
  }
  return css.length;
}

function parseDeclarations(body) {
  const decls = [];
  let cur = '';
  let parens = 0;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === '"' || c === "'") {
      const end = findStringEnd(body, i);
      cur += body.slice(i, end + 1);
      i = end;
      continue;
    }
    if (c === '(') parens++;
    if (c === ')') parens--;
    if (c === ';' && parens === 0) { decls.push(cur); cur = ''; continue; }
    cur += c;
  }
  decls.push(cur);
  return decls
    .map(d => {
      const colon = d.indexOf(':');
      if (colon === -1) return null;
      let value = d.slice(colon + 1).trim();
      const important = /!important\s*$/i.test(value);
      if (important) value = value.replace(/\s*!important\s*$/i, '');
      return { prop: d.slice(0, colon).trim().toLowerCase(), value, important };
    })
    .filter(d => d && d.prop && d.value);
}

function splitSelectors(prelude) {
  const parts = [];
  let cur = '';
  let depth = 0;
  for (const c of prelude) {
    if (c === '(' || c === '[') depth++;
    if (c === ')' || c === ']') depth--;
    if (c === ',' && depth === 0) { parts.push(cur.trim()); cur = ''; continue; }
    cur += c;
  }
  parts.push(cur.trim());
  return parts.filter(Boolean);
}

function scopeSelector(sel) {
  if (/^html\b/.test(sel)) return sel.replace(/^html/, `html[data-theme="light"]`);
  if (/^:root\b/.test(sel)) return sel.replace(/^:root/, SCOPE);
  return `${SCOPE} ${sel}`;
}

// Strips state pseudo-classes so `.btn:hover` can find the background `.btn` sets.
function baseSelector(sel) {
  return sel.replace(/:(hover|active|focus|focus-visible|focus-within|disabled|not\([^)]*\))/g, '').trim();
}

// --- Color math ----------------------------------------------------------

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function parseColor(str) {
  str = str.trim().toLowerCase();
  if (str === 'white') return { r: 255, g: 255, b: 255, a: 1 };
  if (str === 'black') return { r: 0, g: 0, b: 0, a: 1 };
  let m = str.match(/^#([0-9a-f]{3,8})$/);
  if (m) {
    let h = m[1];
    if (h.length === 3 || h.length === 4) h = [...h].map(c => c + c).join('');
    if (h.length !== 6 && h.length !== 8) return null;
    return {
      r: parseInt(h.slice(0, 2), 16),
      g: parseInt(h.slice(2, 4), 16),
      b: parseInt(h.slice(4, 6), 16),
      a: h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1,
    };
  }
  m = str.match(/^rgba?\(([^)]*)\)$/);
  if (m) {
    const parts = m[1].split(/[\s,/]+/).filter(Boolean).map(Number);
    if (parts.length < 3 || parts.some(Number.isNaN)) return null;
    return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 };
  }
  return null;
}

function rgbToHsl({ r, g, b }) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l, c: 0 };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return { h: h * 60, s, l, c: d };
}

function hslToRgb({ h, s, l }) {
  const k = n => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = n => l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
  return { r: Math.round(f(0) * 255), g: Math.round(f(8) * 255), b: Math.round(f(4) * 255) };
}

function formatColor({ r, g, b, a }) {
  if (a >= 1) return '#' + [r, g, b].map(v => clamp(Math.round(v), 0, 255).toString(16).padStart(2, '0')).join('');
  return `rgba(${Math.round(r)},${Math.round(g)},${Math.round(b)},${+a.toFixed(3)})`;
}

const isChromatic = hsl => hsl.c >= 0.2;

// WCAG relative luminance.
function luminance({ r, g, b }) {
  const lin = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

// Darkest-first search for the HSL lightness whose luminance is just below target.
function lightnessForLuminance(hsl, target) {
  let lo = 0, hi = hsl.l;
  for (let i = 0; i < 20; i++) {
    const mid = (lo + hi) / 2;
    if (luminance(hslToRgb({ ...hsl, l: mid })) > target) hi = mid; else lo = mid;
  }
  return lo;
}

// --- Mapping -------------------------------------------------------------

function contextFor(prop) {
  if (prop === 'color' || prop === 'caret-color' || prop === 'fill' || prop === 'stroke' ||
      prop === '-webkit-text-fill-color' || prop.startsWith('text-decoration') || prop === 'accent-color') return 'text';
  if (prop.startsWith('background')) return 'bg';
  if (prop.startsWith('border') || prop.startsWith('outline') || prop === 'column-rule' || prop === 'scrollbar-color') return 'border';
  if (prop === 'box-shadow' || prop === 'text-shadow' || prop === 'filter') return 'shadow';
  return null;
}

// opts.onAccent: the rule paints a saturated background, so light text on it stays light.
function mapColor(color, ctx, opts = {}) {
  const hsl = rgbToHsl(color);
  const a = color.a;
  const translucent = a < 1;
  const withL = (l, s = hsl.s) => ({ ...hslToRgb({ h: hsl.h, s, l: clamp(l, 0, 1) }), a });

  if (isChromatic(hsl)) {
    if (ctx === 'text') {
      if (opts.onAccent) return color;
      // Readable on white (contrast ~4.5+); brighter colors get slightly
      // darker so hover states keep a visible difference.
      const target = 0.2 * (1 - 0.4 * luminance(color));
      if (luminance(color) <= target) return color;
      const s = Math.min(hsl.s, 0.75);
      return withL(lightnessForLuminance({ ...hsl, s }, target), s);
    }
    if (ctx === 'bg') {
      if (!translucent && hsl.l < 0.25) return withL(1 - hsl.l * 0.55);
      return color; // buttons and tints keep their hue
    }
    if (ctx === 'shadow') return { ...color, a: a * 0.7 };
    if (ctx === 'border' && hsl.l > 0.7) {
      const s = Math.min(hsl.s, 0.75);
      return withL(0.25 + (hsl.l - 0.25) * 0.7, s);
    }
    return color;
  }

  // Neutral (gray, possibly slightly tinted)
  if (translucent) {
    const light = hsl.l > 0.5;
    if (ctx === 'shadow') return light ? { r: 0, g: 0, b: 0, a: a * 0.6 } : { ...color, a: a * 0.45 };
    if (light) {
      // White veils used for hover/borders on dark become dark veils.
      if (ctx === 'text' && opts.onAccent) return color;
      // Light themes need slightly stronger lines to read the same.
      return { r: 20, g: 20, b: 40, a: clamp(ctx === 'border' ? a * 1.4 : a, 0, 1) };
    }
    // Dark veils: dense ones are surfaces, faint ones are wells/backdrops.
    if (a >= 0.6) return withL(1 - hsl.l * 0.55, hsl.s * 0.6);
    return { ...color, a: a * 0.45 };
  }

  if (ctx === 'text') {
    if (opts.onAccent && hsl.l > 0.8) return color;
    return withL(clamp(0.08 + (0.97 - hsl.l) * 0.85, 0.08, 0.62));
  }
  if (ctx === 'bg') {
    if (hsl.l > 0.6) return color; // knobs, previews, white chips
    return withL(1 - hsl.l * 0.55, hsl.s * 0.6);
  }
  if (ctx === 'border') {
    if (hsl.l < 0.5) return withL(1 - hsl.l * 0.9, hsl.s * 0.6);
    return withL(clamp(0.08 + (0.97 - hsl.l) * 0.85, 0.08, 0.62));
  }
  if (ctx === 'shadow') return color.r + color.g + color.b < 100 ? { ...color, a: a * 0.45 } : color;
  return color;
}

const COLOR_RE = /#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)|\b(?:white|black)\b/g;
const URL_HEX_RE = /%23([0-9a-fA-F]{6}|[0-9a-fA-F]{3})\b/g;

function mapValue(value, ctx, opts) {
  const replace = (match, forcedCtx) => {
    const key = match.toLowerCase();
    const c = forcedCtx || ctx;
    if (PINNED[c] && PINNED[c][key]) return PINNED[c][key];
    const parsed = parseColor(match);
    return parsed ? formatColor(mapColor(parsed, c, opts)) : match;
  };
  // Process url() separately: only %23-escaped hex inside SVG data URIs.
  return value.replace(/url\((?:[^()"']|"[^"]*"|'[^']*')*\)/g, '\0$&\0')
    .split('\0')
    .map(part => part.startsWith('url(')
      ? part.replace(URL_HEX_RE, (_, hex) => replace('#' + hex, 'text').replace('#', '%23'))
      : part.replace(COLOR_RE, m => replace(m)))
    .join('');
}

// --- Emit ----------------------------------------------------------------

// First pass: which selectors paint a saturated opaque background?
function collectAccentSelectors(nodes, set = new Set()) {
  for (const node of nodes) {
    if (node.type === 'at') {
      if (!/^@keyframes/i.test(node.prelude)) collectAccentSelectors(parseBlock(node.body), set);
      continue;
    }
    for (const d of parseDeclarations(node.body)) {
      if (d.prop !== 'background' && d.prop !== 'background-color') continue;
      const colors = d.value.match(COLOR_RE) || [];
      if (colors.some(c => {
        const p = parseColor(c);
        if (!p || p.a < 0.85) return false;
        const hsl = rgbToHsl(p);
        return isChromatic(hsl) && hsl.l >= 0.3;
      })) {
        for (const sel of splitSelectors(node.prelude)) set.add(baseSelector(sel));
      }
    }
  }
  return set;
}

// Scoping raises specificity, so a mapped `.a { background: … }` would beat
// an unscoped `.b .a { background: none }`. Every declaration of a property
// that gets mapped somewhere is therefore re-emitted, changed or not, which
// keeps the original cascade between them intact.
function collectMappedProps(nodes, accentSelectors, props = new Set()) {
  for (const node of nodes) {
    if (node.type === 'at') {
      if (!/^@keyframes/i.test(node.prelude)) collectMappedProps(parseBlock(node.body), accentSelectors, props);
      continue;
    }
    const onAccent = splitSelectors(node.prelude).some(s => accentSelectors.has(baseSelector(s)));
    for (const d of parseDeclarations(node.body)) {
      const ctx = contextFor(d.prop);
      if (ctx && mapValue(d.value, ctx, { onAccent }) !== d.value) props.add(propFamily(d.prop));
    }
  }
  return props;
}

// Shorthands reset their longhands (`background` resets background-repeat),
// so a family is re-emitted as a whole: every background-* declaration, not
// only the ones with colors.
function propFamily(prop) {
  const m = prop.match(/^(background|border|outline|text-decoration)\b/);
  return m ? m[1] : prop;
}

function emit(nodes, accentSelectors, mappedProps, indent = '') {
  let out = '';
  for (const node of nodes) {
    if (node.type === 'at') {
      if (/^@keyframes/i.test(node.prelude)) continue; // none of them set colors
      const inner = emit(parseBlock(node.body), accentSelectors, mappedProps, indent + '  ');
      if (inner) out += `${indent}${node.prelude} {\n${inner}${indent}}\n`;
      continue;
    }
    const selectors = splitSelectors(node.prelude);
    const onAccent = selectors.some(s => accentSelectors.has(baseSelector(s)));
    const changed = [];
    for (const d of parseDeclarations(node.body)) {
      if (!mappedProps.has(propFamily(d.prop))) continue;
      const ctx = contextFor(d.prop);
      const mapped = ctx ? mapValue(d.value, ctx, { onAccent }) : d.value;
      changed.push(`${d.prop}: ${mapped}${d.important ? ' !important' : ''}`);
    }
    if (changed.length) {
      out += `${indent}${selectors.map(scopeSelector).join(',\n' + indent)} {\n`;
      out += changed.map(c => `${indent}  ${c};\n`).join('');
      out += `${indent}}\n`;
    }
  }
  return out;
}

let output = `/* GENERATED by scripts/generate-light-theme.js from ${SOURCES.join(', ')}.\n` +
  ` * Do not edit; put hand-tuned fixes in public/theme-light.css. */\n`;
for (const src of SOURCES) {
  const css = stripComments(fs.readFileSync(path.join(ROOT, src), 'utf8'));
  const nodes = parseBlock(css);
  const accentSelectors = collectAccentSelectors(nodes);
  output += `\n/* --- ${src} --- */\n` + emit(nodes, accentSelectors, collectMappedProps(nodes, accentSelectors));
}
fs.writeFileSync(path.join(ROOT, OUTPUT), output);
console.log(`Wrote ${OUTPUT} (${output.split('\n').length} lines)`);
