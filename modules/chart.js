// ─── Custom Chart Renderer (sharp-based, no node-canvas) ──────────────────
// Replaces QuickChart entirely. Builds charts as hand-crafted SVG strings,
// then rasterizes to PNG via sharp (libvips). Chosen over node-canvas
// specifically because sharp ships true prebuilt binaries for Railway's
// Linux x64 target — no Cairo/Pango, no Dockerfile, no native compilation
// risk. Verified end-to-end before adoption (see KKG handoff doc — past
// canvas dependency issues on Railway were a known recurring pain point).
//
// FONT SETUP — REQUIRED: Railway containers ship with zero fonts installed
// by default, which causes all SVG <text> to render as empty tofu boxes
// (confirmed in production). Fixed by bundling DejaVu Sans (Bitstream Vera
// license — freely redistributable) directly in the repo and pointing
// librsvg/fontconfig at it via FONTCONFIG_PATH, set BEFORE sharp is first
// required anywhere in the process. This must stay in sync with the actual
// font files living in modules/fonts/ — do not remove that directory.

const path = require('path');

// Must be set before sharp's first require triggers libvips/fontconfig
// initialization. Safe to set even if chart.js is required multiple times.
process.env.FONTCONFIG_PATH = path.join(__dirname, 'fonts');

const sharp = require('sharp');

const WIDTH = 1200;
const HEIGHT = 600;
const PADDING = { top: 50, right: 40, bottom: 50, left: 60 };
const PLOT_W = WIDTH - PADDING.left - PADDING.right;
const PLOT_H = HEIGHT - PADDING.top - PADDING.bottom;

const PALETTE = ['#5865F2', '#57F287', '#FEE75C', '#EB459E', '#ED4245', '#9B59B6'];

function hexToRgb(hex) {
  return {
    r: parseInt(hex.slice(1, 3), 16),
    g: parseInt(hex.slice(3, 5), 16),
    b: parseInt(hex.slice(5, 7), 16),
  };
}

function escapeXml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Catmull-Rom to cubic Bezier conversion for smooth curves through all points
function smoothPath(points) {
  if (points.length < 2) return '';
  if (points.length === 2) {
    return `M ${points[0].x} ${points[0].y} L ${points[1].x} ${points[1].y}`;
  }
  let d = `M ${points[0].x} ${points[0].y}`;
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[i === 0 ? i : i - 1];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[i + 2 < points.length ? i + 2 : i + 1];
    const cp1x = p1.x + (p2.x - p0.x) / 6;
    const cp1y = p1.y + (p2.y - p0.y) / 6;
    const cp2x = p2.x - (p3.x - p1.x) / 6;
    const cp2y = p2.y - (p3.y - p1.y) / 6;
    d += ` C ${cp1x.toFixed(2)} ${cp1y.toFixed(2)}, ${cp2x.toFixed(2)} ${cp2y.toFixed(2)}, ${p2.x.toFixed(2)} ${p2.y.toFixed(2)}`;
  }
  return d;
}

/**
 * Build a multi-series line chart as a PNG buffer.
 * @param labels  array of x-axis labels
 * @param series  array of { label, data, color? }
 * @param title   chart title (top-left, bold)
 * @returns Promise<Buffer> PNG image buffer
 */
async function buildLineChartImage(labels, series, title) {
  const isMulti = series.length > 1;
  const topPadding = isMulti ? (title ? 90 : 60) : 50;
  const padding = { ...PADDING, top: topPadding };
  const plotH = HEIGHT - padding.top - padding.bottom;

  // Determine y-axis max — round up to a clean increment
  const allValues = series.flatMap(s => s.data);
  const rawMax = Math.max(1, ...allValues);
  const yMax = Math.ceil(rawMax / 10) * 10 || 10;

  function xFor(i) {
    return padding.left + (labels.length > 1 ? (i / (labels.length - 1)) * PLOT_W : PLOT_W / 2);
  }
  function yFor(v) {
    return padding.top + plotH - (v / yMax) * plotH;
  }

  // Gridlines + y-axis labels (horizontal only, no vertical gridlines)
  const gridStep = yMax / 5;
  let gridlinesSvg = '';
  for (let v = 0; v <= yMax; v += gridStep) {
    const y = yFor(v);
    gridlinesSvg += `<line x1="${PADDING.left}" y1="${y.toFixed(2)}" x2="${WIDTH - PADDING.right}" y2="${y.toFixed(2)}" stroke="rgba(255,255,255,0.06)" stroke-width="1"/>`;
    gridlinesSvg += `<text x="${PADDING.left - 10}" y="${(y + 4).toFixed(2)}" fill="#dcddde" font-size="13" font-family="DejaVu Sans" text-anchor="end">${Math.round(v)}</text>`;
  }

  // X-axis labels — thin out if too many to avoid overlap
  const maxLabels = 14;
  const labelStep = Math.max(1, Math.ceil(labels.length / maxLabels));
  let xLabelsSvg = '';
  labels.forEach((label, i) => {
    if (i % labelStep !== 0 && i !== labels.length - 1) return;
    xLabelsSvg += `<text x="${xFor(i).toFixed(2)}" y="${HEIGHT - 15}" fill="#dcddde" font-size="13" font-family="DejaVu Sans" text-anchor="middle">${escapeXml(label)}</text>`;
  });

  // Build each series: gradient def, fill path, line path
  let defsSvg = '';
  let fillsSvg = '';
  let linesSvg = '';

  series.forEach((s, idx) => {
    const color = s.color || PALETTE[idx % PALETTE.length];
    const rgb = hexToRgb(color);
    const gradId = `grad${idx}`;
    const topAlpha = isMulti ? 0.28 : 0.5;

    defsSvg += `
      <linearGradient id="${gradId}" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="rgb(${rgb.r},${rgb.g},${rgb.b})" stop-opacity="${topAlpha}"/>
        <stop offset="100%" stop-color="rgb(${rgb.r},${rgb.g},${rgb.b})" stop-opacity="0"/>
      </linearGradient>`;

    const points = s.data.map((v, i) => ({ x: xFor(i), y: yFor(v) }));
    const linePath = smoothPath(points);
    const fillPath = `${linePath} L ${xFor(s.data.length - 1).toFixed(2)} ${(padding.top + plotH).toFixed(2)} L ${xFor(0).toFixed(2)} ${(padding.top + plotH).toFixed(2)} Z`;

    fillsSvg += `<path d="${fillPath}" fill="url(#${gradId})"/>`;
    linesSvg += `<path d="${linePath}" fill="none" stroke="${color}" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"/>`;
  });

  // Legend — only shown for multi-series, positioned below the title
  let legendSvg = '';
  if (isMulti) {
    let legendX = PADDING.left;
    const legendY = title ? 56 : 24;
    series.forEach((s, idx) => {
      const color = s.color || PALETTE[idx % PALETTE.length];
      const labelText = escapeXml(s.label);
      const swatchW = 22;
      const textW = labelText.length * 7.5 + 28; // rough estimate for spacing
      legendSvg += `
        <rect x="${legendX}" y="${legendY - 10}" width="${swatchW}" height="12" rx="3" fill="none" stroke="${color}" stroke-width="2.5"/>
        <text x="${legendX + swatchW + 8}" y="${legendY}" fill="#dcddde" font-size="14" font-family="DejaVu Sans">${labelText}</text>`;
      legendX += swatchW + 8 + textW;
    });
  }

  const titleSvg = title
    ? `<text x="30" y="32" fill="#e8e9eb" font-size="18" font-weight="bold" font-family="DejaVu Sans">${escapeXml(title)}</text>`
    : '';

  const svg = `
<svg width="${WIDTH}" height="${HEIGHT}" xmlns="http://www.w3.org/2000/svg">
  <defs>${defsSvg}</defs>
  <rect width="${WIDTH}" height="${HEIGHT}" fill="#2b2d31"/>
  ${gridlinesSvg}
  ${fillsSvg}
  ${linesSvg}
  ${xLabelsSvg}
  ${titleSvg}
  ${legendSvg}
</svg>`;

  return sharp(Buffer.from(svg))
    .png()
    .toBuffer();
}

// Bucket round_logs rows into per-day counts per map.
// Unchanged from the QuickChart-era version — schema-compatible.
function bucketRoundsByMap(rows, startDate, endDate, bucketMs = 24 * 60 * 60 * 1000) {
  const startMs = startDate.getTime();
  const endMs = endDate.getTime();
  const numBuckets = Math.max(1, Math.ceil((endMs - startMs) / bucketMs));

  const perMap = new Map();

  for (const row of rows) {
    if (!row.map) continue;
    const ts = new Date(row.played_at).getTime();
    if (ts < startMs || ts >= endMs) continue;
    const idx = Math.min(numBuckets - 1, Math.floor((ts - startMs) / bucketMs));
    if (!perMap.has(row.map)) perMap.set(row.map, new Array(numBuckets).fill(0));
    perMap.get(row.map)[idx]++;
  }

  const labels = [];
  for (let i = 0; i < numBuckets; i++) {
    const bucketStart = new Date(startMs + i * bucketMs);
    if (bucketMs >= 24 * 60 * 60 * 1000) {
      labels.push(`${bucketStart.getMonth() + 1}/${bucketStart.getDate()}`);
    } else {
      labels.push(bucketStart.toLocaleTimeString('en-US', { hour: 'numeric' }));
    }
  }

  const series = [...perMap.entries()].map(([map, data]) => ({ label: map, data }));
  return { labels, series };
}

module.exports = { buildLineChartImage, bucketRoundsByMap, PALETTE };