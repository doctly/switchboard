// profile-icons.js — icon catalog for profile badges.
//
// Two flavours:
//   - "monogram" entries: a coloured circle with 1–2 letters. Used for the
//     four built-in provider templates so they're recognisable without us
//     having to ship (and stay in sync with) the providers' real logos.
//     Letters are easier to keep distinct than vector marks.
//   - "glyph" entries: a coloured circle with a generic SVG glyph centred
//     in it. Users pick from these for their own profiles.
//
// `renderProfileIcon(key, size)` returns a freshly-built SVGElement so
// callers don't need to template strings or worry about XSS — this is
// the only place icon SVG markup lives, and every code path that wants
// to show a profile icon goes through this function.

(function () {
  const SVGNS = 'http://www.w3.org/2000/svg';

  // Catalog: each entry has { label, color, kind: 'monogram'|'glyph', initials?, path? }
  // For glyphs, `path` is one or more <path d="…"/> strings (relative to a
  // 24-unit viewBox centred on 12,12) drawn in white over the coloured disc.
  const PROFILE_ICONS = {
    // --- Provider monograms (defaults for the built-in presets) ----------
    anthropic:  { label: 'Anthropic',  color: '#d97757', kind: 'monogram', initials: 'A'  },
    deepseek:   { label: 'DeepSeek',   color: '#4d6bfe', kind: 'monogram', initials: 'DS' },
    glm:        { label: 'GLM',        color: '#22a06b', kind: 'monogram', initials: 'G'  },
    openrouter: { label: 'OpenRouter', color: '#a855f7', kind: 'monogram', initials: 'OR' },

    // --- Generic glyphs --------------------------------------------------
    star: {
      label: 'Star', color: '#fbbf24', kind: 'glyph',
      path: 'M12 5l1.9 4.2 4.6.5-3.5 3.1 1 4.5L12 15l-4 2.3 1-4.5-3.5-3.1 4.6-.5z',
    },
    bolt: {
      label: 'Bolt', color: '#f59e0b', kind: 'glyph',
      path: 'M13 4L6 14h5l-1 6 7-10h-5z',
    },
    flame: {
      label: 'Flame', color: '#ef4444', kind: 'glyph',
      path: 'M12 4c0 4-3 5-3 8a3 3 0 006 0c0-1.5-1-2.5-1-4 2 1 3 3 3 5a5 5 0 01-10 0c0-4 3-5 5-9z',
    },
    brain: {
      label: 'Brain', color: '#ec4899', kind: 'glyph',
      path: 'M9 6a3 3 0 013-1 3 3 0 013 1 3 3 0 012 3v2a3 3 0 01-1 2 3 3 0 01-1 2 3 3 0 01-3 1 3 3 0 01-3-1 3 3 0 01-1-2 3 3 0 01-1-2V9a3 3 0 012-3z',
    },
    rocket: {
      label: 'Rocket', color: '#3b82f6', kind: 'glyph',
      path: 'M14 6c-3 1-5 4-6 8l2 2c4-1 7-3 8-6zM8 14l-2 4 4-2zm6-6a1 1 0 100 2 1 1 0 000-2z',
    },
    gear: {
      label: 'Gear', color: '#64748b', kind: 'glyph',
      path: 'M12 8a4 4 0 100 8 4 4 0 000-8zm0 2a2 2 0 110 4 2 2 0 010-4zm-1-6h2v2h-2zm0 14h2v2h-2zM4 11h2v2H4zm14 0h2v2h-2zM6 6l1.5 1.5-1 1L5 7zm12 0l1 1-1.5 1.5-1-1zM6 18l-1-1 1.5-1.5 1 1zm12 0l-1.5-1.5 1-1L19 17z',
    },
    leaf: {
      label: 'Leaf', color: '#16a34a', kind: 'glyph',
      path: 'M18 6c0 7-4 11-11 12 0-3 1-5 3-7-1 0-2 0-3-1 1-3 4-5 8-5 1 0 2 0 3 1z',
    },
    droplet: {
      label: 'Droplet', color: '#06b6d4', kind: 'glyph',
      path: 'M12 4c-3 4-5 6-5 9a5 5 0 0010 0c0-3-2-5-5-9z',
    },
    diamond: {
      label: 'Diamond', color: '#0ea5e9', kind: 'glyph',
      path: 'M12 4l8 8-8 8-8-8z',
    },
    cube: {
      label: 'Cube', color: '#8b5cf6', kind: 'glyph',
      path: 'M12 4l7 4v8l-7 4-7-4V8zm0 2.3L7 8.5v7l5 2.2 5-2.2v-7zM7 8.5l5 2.2 5-2.2',
    },
    flask: {
      label: 'Flask', color: '#14b8a6', kind: 'glyph',
      path: 'M9 4h6v2l-1 1v4l4 8H6l4-8V7L9 6zm1.5 8h3l-1.5-3z',
    },
    infinity: {
      label: 'Infinity', color: '#a78bfa', kind: 'glyph',
      path: 'M7 9a3 3 0 110 6 3 3 0 010-6zm10 0a3 3 0 110 6 3 3 0 010-6zM10 12a2 2 0 002 0 2 2 0 002 0',
    },
    target: {
      label: 'Target', color: '#dc2626', kind: 'glyph',
      path: 'M12 5a7 7 0 100 14 7 7 0 000-14zm0 3a4 4 0 100 8 4 4 0 000-8zm0 2a2 2 0 100 4 2 2 0 000-4z',
    },
    moon: {
      label: 'Moon', color: '#475569', kind: 'glyph',
      path: 'M14 5a8 8 0 005 12 8 8 0 11-5-12z',
    },
    sun: {
      label: 'Sun', color: '#facc15', kind: 'glyph',
      path: 'M12 8a4 4 0 100 8 4 4 0 000-8zm0-5v3m0 14v-3M3 12h3m12 0h3M5.6 5.6l2 2m8.8 8.8l2 2M5.6 18.4l2-2m8.8-8.8l2-2',
    },
  };

  // Default fallback when a profile doesn't have an icon set.
  const DEFAULT_ICON = 'star';

  function getIconKeys() {
    return Object.keys(PROFILE_ICONS);
  }

  function getIcon(key) {
    return PROFILE_ICONS[key] || PROFILE_ICONS[DEFAULT_ICON];
  }

  // Build an SVG element for the given icon key. Always returns a same-origin
  // SVGElement (no markup interpolation), so callers can append it directly.
  function renderProfileIcon(key, size) {
    const icon = getIcon(key);
    const px = size || 16;
    const svg = document.createElementNS(SVGNS, 'svg');
    svg.setAttribute('width', String(px));
    svg.setAttribute('height', String(px));
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('class', 'profile-icon profile-icon-' + key);
    svg.style.flexShrink = '0';

    const circle = document.createElementNS(SVGNS, 'circle');
    circle.setAttribute('cx', '12');
    circle.setAttribute('cy', '12');
    circle.setAttribute('r', '11');
    circle.setAttribute('fill', icon.color);
    svg.appendChild(circle);

    if (icon.kind === 'monogram') {
      const text = document.createElementNS(SVGNS, 'text');
      text.setAttribute('x', '12');
      text.setAttribute('y', '12');
      text.setAttribute('text-anchor', 'middle');
      text.setAttribute('dominant-baseline', 'central');
      // Two-letter monograms need a slightly smaller font to fit the disc.
      const fontSize = (icon.initials || '').length >= 2 ? 9 : 12;
      text.setAttribute('font-size', String(fontSize));
      text.setAttribute('font-weight', '700');
      text.setAttribute('font-family', 'system-ui, sans-serif');
      text.setAttribute('fill', '#ffffff');
      text.textContent = icon.initials || '?';
      svg.appendChild(text);
    } else if (icon.kind === 'glyph') {
      const path = document.createElementNS(SVGNS, 'path');
      path.setAttribute('d', icon.path);
      path.setAttribute('fill', 'none');
      path.setAttribute('stroke', '#ffffff');
      path.setAttribute('stroke-width', '1.6');
      path.setAttribute('stroke-linecap', 'round');
      path.setAttribute('stroke-linejoin', 'round');
      svg.appendChild(path);
    }

    return svg;
  }

  window.PROFILE_ICONS = PROFILE_ICONS;
  window.renderProfileIcon = renderProfileIcon;
  window.getProfileIconKeys = getIconKeys;
})();
