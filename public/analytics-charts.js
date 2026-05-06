// analytics-charts.js — minimal SVG chart primitives for the analytics
// section of the Stats tab. Hand-rolled to avoid pulling a chart library
// into the bundle. All builders return real DOM SVG elements (no innerHTML
// interpolation) so caller-supplied data can't smuggle markup.
//
// Exposed:
//   window.analyticsCharts.sparkline(values, opts)
//   window.analyticsCharts.lineChart(series, opts)
//   window.analyticsCharts.stackedBarChart(days, backendOrder, opts)

(function () {
  const SVGNS = 'http://www.w3.org/2000/svg';

  function el(tag, attrs) {
    const e = document.createElementNS(SVGNS, tag);
    if (attrs) for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
    return e;
  }

  // ── Sparkline ─────────────────────────────────────────────────────────
  // Tiny inline trend line. `values` is an array of numbers.
  function sparkline(values, opts) {
    const o = Object.assign({ width: 100, height: 28, color: '#8088ff', strokeWidth: 1.5, fill: true }, opts || {});
    const svg = el('svg', { width: o.width, height: o.height, viewBox: `0 0 ${o.width} ${o.height}`, class: 'spark' });
    if (!values || values.length === 0) return svg;
    const max = Math.max(...values, 1);
    const min = Math.min(...values, 0);
    const range = max - min || 1;
    const xStep = values.length > 1 ? o.width / (values.length - 1) : 0;
    const pad = 2;
    const ys = values.map(v => o.height - pad - ((v - min) / range) * (o.height - 2 * pad));
    const points = ys.map((y, i) => `${i * xStep},${y}`).join(' ');
    if (o.fill) {
      const fillPath = `M0,${o.height} L${points.replace(/ /g, ' L')} L${o.width},${o.height} Z`;
      svg.appendChild(el('path', { d: fillPath, fill: o.color, 'fill-opacity': 0.15, stroke: 'none' }));
    }
    svg.appendChild(el('polyline', {
      points, fill: 'none', stroke: o.color, 'stroke-width': o.strokeWidth,
      'stroke-linecap': 'round', 'stroke-linejoin': 'round',
    }));
    return svg;
  }

  // ── Line chart (multi-series) ─────────────────────────────────────────
  // `series` is an array of { name, color, values: number[], label? }.
  // All series must share the same x-axis length.
  function lineChart(series, opts) {
    const o = Object.assign({
      width: 720, height: 220, padLeft: 56, padRight: 16, padTop: 12, padBottom: 28,
      labels: null, // optional array of x-axis labels (same length as values)
      yLabel: '',
    }, opts || {});

    const svg = el('svg', { width: o.width, height: o.height, viewBox: `0 0 ${o.width} ${o.height}`, class: 'analytics-chart' });
    const plotW = o.width - o.padLeft - o.padRight;
    const plotH = o.height - o.padTop - o.padBottom;
    if (!series || series.length === 0 || !series[0].values || series[0].values.length === 0) {
      const txt = el('text', { x: o.width / 2, y: o.height / 2, 'text-anchor': 'middle', fill: '#888', 'font-size': 12 });
      txt.textContent = 'No data';
      svg.appendChild(txt);
      return svg;
    }
    const n = series[0].values.length;
    let max = 0;
    for (const s of series) for (const v of s.values) if (v > max) max = v;
    if (max === 0) max = 1;
    // Round max up to a "nice" number for grid.
    const niceMax = niceCeil(max);

    // Y-axis grid + labels (4 lines)
    for (let i = 0; i <= 4; i++) {
      const y = o.padTop + (plotH * i) / 4;
      const v = niceMax - (niceMax * i) / 4;
      svg.appendChild(el('line', {
        x1: o.padLeft, y1: y, x2: o.width - o.padRight, y2: y,
        stroke: 'rgba(255,255,255,0.06)', 'stroke-width': 1,
      }));
      const t = el('text', {
        x: o.padLeft - 6, y: y + 4, 'text-anchor': 'end', fill: '#888', 'font-size': 11,
      });
      t.textContent = formatNumber(v);
      svg.appendChild(t);
    }
    // Y-axis title
    if (o.yLabel) {
      const tlabel = el('text', {
        x: 4, y: o.padTop - 2, 'text-anchor': 'start', fill: '#aaa', 'font-size': 10,
      });
      tlabel.textContent = o.yLabel;
      svg.appendChild(tlabel);
    }

    // X-axis labels (~6 labels distributed)
    if (o.labels) {
      const labelStride = Math.max(1, Math.ceil(n / 6));
      for (let i = 0; i < n; i += labelStride) {
        const x = o.padLeft + (n > 1 ? (plotW * i) / (n - 1) : plotW / 2);
        const t = el('text', {
          x, y: o.height - o.padBottom + 14, 'text-anchor': 'middle', fill: '#888', 'font-size': 10,
        });
        t.textContent = String(o.labels[i]);
        svg.appendChild(t);
      }
    }

    // Series lines
    for (const s of series) {
      const points = s.values.map((v, i) => {
        const x = o.padLeft + (n > 1 ? (plotW * i) / (n - 1) : plotW / 2);
        const y = o.padTop + plotH - (v / niceMax) * plotH;
        return `${x.toFixed(1)},${y.toFixed(1)}`;
      }).join(' ');
      svg.appendChild(el('polyline', {
        points, fill: 'none', stroke: s.color || '#8088ff', 'stroke-width': 2,
        'stroke-linecap': 'round', 'stroke-linejoin': 'round',
      }));
    }
    return svg;
  }

  // ── Stacked bar (one bar per day, segments per backend) ───────────────
  // `days` = [{ label, segments: [{name, color, value}] }]
  function stackedBarChart(days, opts) {
    const o = Object.assign({
      width: 720, height: 220, padLeft: 56, padRight: 16, padTop: 12, padBottom: 28,
      yLabel: '',
    }, opts || {});

    const svg = el('svg', { width: o.width, height: o.height, viewBox: `0 0 ${o.width} ${o.height}`, class: 'analytics-chart' });
    const plotW = o.width - o.padLeft - o.padRight;
    const plotH = o.height - o.padTop - o.padBottom;
    if (!days || days.length === 0) {
      const txt = el('text', { x: o.width / 2, y: o.height / 2, 'text-anchor': 'middle', fill: '#888', 'font-size': 12 });
      txt.textContent = 'No data';
      svg.appendChild(txt);
      return svg;
    }

    let max = 0;
    for (const d of days) {
      let total = 0;
      for (const seg of d.segments) total += seg.value;
      if (total > max) max = total;
    }
    if (max === 0) max = 1;
    const niceMax = niceCeil(max);

    // Grid
    for (let i = 0; i <= 4; i++) {
      const y = o.padTop + (plotH * i) / 4;
      const v = niceMax - (niceMax * i) / 4;
      svg.appendChild(el('line', {
        x1: o.padLeft, y1: y, x2: o.width - o.padRight, y2: y,
        stroke: 'rgba(255,255,255,0.06)', 'stroke-width': 1,
      }));
      const t = el('text', { x: o.padLeft - 6, y: y + 4, 'text-anchor': 'end', fill: '#888', 'font-size': 11 });
      t.textContent = formatNumber(v);
      svg.appendChild(t);
    }
    if (o.yLabel) {
      const tlabel = el('text', { x: 4, y: o.padTop - 2, fill: '#aaa', 'font-size': 10 });
      tlabel.textContent = o.yLabel;
      svg.appendChild(tlabel);
    }

    // Bars
    const barWidth = Math.max(2, plotW / days.length - 2);
    days.forEach((d, i) => {
      const x = o.padLeft + (plotW * i) / days.length + 1;
      let yCursor = o.padTop + plotH;
      for (const seg of d.segments) {
        const h = (seg.value / niceMax) * plotH;
        if (h > 0) {
          const rect = el('rect', {
            x: x.toFixed(1),
            y: (yCursor - h).toFixed(1),
            width: barWidth.toFixed(1),
            height: h.toFixed(1),
            fill: seg.color || '#8088ff',
          });
          // Tooltip via <title>
          const title = el('title');
          title.textContent = `${d.label} — ${seg.name}: ${formatNumber(seg.value)}`;
          rect.appendChild(title);
          svg.appendChild(rect);
          yCursor -= h;
        }
      }
    });

    // X-axis labels (~6 distributed)
    const stride = Math.max(1, Math.ceil(days.length / 6));
    for (let i = 0; i < days.length; i += stride) {
      const x = o.padLeft + (plotW * i) / days.length + barWidth / 2 + 1;
      const t = el('text', {
        x, y: o.height - o.padBottom + 14, 'text-anchor': 'middle', fill: '#888', 'font-size': 10,
      });
      t.textContent = days[i].label;
      svg.appendChild(t);
    }

    return svg;
  }

  // ── Helpers ───────────────────────────────────────────────────────────
  function niceCeil(n) {
    // round up to a "nice" multiple — useful for axis ranges.
    if (n <= 0) return 1;
    const exp = Math.floor(Math.log10(n));
    const f = n / Math.pow(10, exp);
    const nice = f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10;
    return nice * Math.pow(10, exp);
  }

  function formatNumber(n) {
    if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B';
    if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k';
    return Math.round(n).toString();
  }

  window.analyticsCharts = { sparkline, lineChart, stackedBarChart, formatNumber };
})();
