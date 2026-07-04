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

// Canonical map colors — used across all chart and pie commands
const MAP_COLORS = {
  'Jungle':      '#2EA84A',   // darker green
  'Primal Park': '#C45FD4',   // purple pink
  'Canyon':      '#F07830',   // orange
  'Cavern':      '#4A8FE8',   // blue
};

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
function smoothPath(points, maxY = Infinity) {
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
    const cp1y = Math.min(maxY, p1.y + (p2.y - p0.y) / 6);
    const cp2x = p2.x - (p3.x - p1.x) / 6;
    const cp2y = Math.min(maxY, p2.y - (p3.y - p1.y) / 6);
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
    const linePath = smoothPath(points, padding.top + plotH);
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

/**
 * Build a dual-axis composite chart: grey bars (left axis, e.g. total
 * rounds played) in the background, one or more smoothed gradient lines
 * (right axis, e.g. map popularity) drawn on top. Matches Statbot's
 * Members/Messages chart pattern (bars = raw volume, lines = derived/
 * smoothed metrics). Supports multiple lines sharing the right axis.
 *
 * @param labels     array of x-axis labels
 * @param barData    array of numbers for the background bar chart (left axis)
 * @param barLabel   legend label for the bar series
 * @param lineSeries array of { label, data, color? } — one or more lines,
 *                   all sharing the right axis. Colors default to PALETTE.
 * @param title      chart title
 * @returns Promise<Buffer> PNG image buffer
 */
async function buildDualAxisChartImage(labels, barData, barLabel, lineSeries, title) {
  const topPadding = 90;
  const padding = { top: topPadding, right: 60, bottom: 50, left: 60 };
  const plotW = WIDTH - padding.left - padding.right;
  const plotH = HEIGHT - padding.top - padding.bottom;

  const leftMax = Math.ceil(Math.max(1, ...barData) / 10) * 10 || 10;
  const allLineValues = lineSeries.flatMap(s => s.data);
  const rightMax = Math.ceil(Math.max(1, ...allLineValues) / 10) * 10 || 10;

  function xFor(i) {
    return padding.left + (labels.length > 1 ? (i / (labels.length - 1)) * plotW : plotW / 2);
  }
  function yForLeft(v) { return padding.top + plotH - (v / leftMax) * plotH; }
  function yForRight(v) { return padding.top + plotH - (v / rightMax) * plotH; }

  // Background bars (total volume, left axis)
  const barWidth = (plotW / labels.length) * 0.6;
  let barsSvg = '';
  barData.forEach((v, i) => {
    const x = xFor(i) - barWidth / 2;
    const y = yForLeft(v);
    const h = (padding.top + plotH) - y;
    barsSvg += `<rect x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${barWidth.toFixed(2)}" height="${h.toFixed(2)}" fill="rgba(255,255,255,0.12)" rx="2"/>`;
  });

  // Foreground line(s) — right axis, each with its own gradient fill.
  // Lower fill opacity when multiple lines to avoid muddy overlap.
  const isMultiLine = lineSeries.length > 1;
  let defsSvg = '';
  let fillsSvg = '';
  let linesSvg = '';

  lineSeries.forEach((s, idx) => {
    const color = s.color || PALETTE[idx % PALETTE.length];
    const rgb = hexToRgb(color);
    const gradId = `dualGrad${idx}`;
    const topAlpha = isMultiLine ? 0.25 : 0.5;

    defsSvg += `
      <linearGradient id="${gradId}" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="rgb(${rgb.r},${rgb.g},${rgb.b})" stop-opacity="${topAlpha}"/>
        <stop offset="100%" stop-color="rgb(${rgb.r},${rgb.g},${rgb.b})" stop-opacity="0"/>
      </linearGradient>`;

    const points = s.data.map((v, i) => ({ x: xFor(i), y: yForRight(v) }));
    const linePath = smoothPath(points, padding.top + plotH);
    const fillPath = `${linePath} L ${xFor(s.data.length - 1).toFixed(2)} ${(padding.top + plotH).toFixed(2)} L ${xFor(0).toFixed(2)} ${(padding.top + plotH).toFixed(2)} Z`;

    fillsSvg += `<path d="${fillPath}" fill="url(#${gradId})"/>`;
    linesSvg += `<path d="${linePath}" fill="none" stroke="${color}" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"/>`;
  });

  // Gridlines referenced to the right (line) axis, Statbot-style
  const gridStep = rightMax / 5;
  let gridSvg = '';
  for (let v = 0; v <= rightMax; v += gridStep) {
    const y = yForRight(v);
    gridSvg += `<line x1="${padding.left}" y1="${y.toFixed(2)}" x2="${WIDTH - padding.right}" y2="${y.toFixed(2)}" stroke="rgba(255,255,255,0.06)" stroke-width="1"/>`;
  }

  // Left axis labels (grey, matches bar color)
  const leftStep = leftMax / 5;
  let leftAxisSvg = '';
  for (let v = 0; v <= leftMax; v += leftStep) {
    const y = yForLeft(v);
    leftAxisSvg += `<text x="${padding.left - 10}" y="${(y + 4).toFixed(2)}" fill="#999999" font-size="12" font-family="DejaVu Sans" text-anchor="end">${Math.round(v)}</text>`;
  }
  // Right axis labels — neutral color when multi-line (no single color to match)
  const rightAxisColor = isMultiLine ? '#dcddde' : (lineSeries[0]?.color || PALETTE[0]);
  let rightAxisSvg = '';
  for (let v = 0; v <= rightMax; v += gridStep) {
    const y = yForRight(v);
    rightAxisSvg += `<text x="${WIDTH - padding.right + 10}" y="${(y + 4).toFixed(2)}" fill="${rightAxisColor}" font-size="12" font-family="DejaVu Sans" text-anchor="start">${Math.round(v)}</text>`;
  }

  // X-axis labels — thin out if too many
  const maxLabels = 14;
  const labelStep = Math.max(1, Math.ceil(labels.length / maxLabels));
  let xLabelsSvg = '';
  labels.forEach((label, i) => {
    if (i % labelStep !== 0 && i !== labels.length - 1) return;
    xLabelsSvg += `<text x="${xFor(i).toFixed(2)}" y="${HEIGHT - 15}" fill="#dcddde" font-size="13" font-family="DejaVu Sans" text-anchor="middle">${escapeXml(label)}</text>`;
  });

  const titleSvg = title
    ? `<text x="30" y="32" fill="#e8e9eb" font-size="18" font-weight="bold" font-family="DejaVu Sans">${escapeXml(title)}</text>`
    : '';

  // Legend below title: grey dot for bars, one colored swatch per line series
  const legendY = title ? 56 : 24;
  const barLabelText = escapeXml(barLabel);
  let legendX = 48 + barLabelText.length * 7.5 + 30;
  let legendSvg = `
    <circle cx="35" cy="${legendY - 5}" r="5" fill="rgba(255,255,255,0.4)"/>
    <text x="48" y="${legendY}" fill="#dcddde" font-size="14" font-family="DejaVu Sans">${barLabelText}</text>`;

  lineSeries.forEach((s, idx) => {
    const color = s.color || PALETTE[idx % PALETTE.length];
    const labelText = escapeXml(s.label);
    legendSvg += `
      <rect x="${legendX}" y="${legendY - 10}" width="22" height="12" rx="3" fill="none" stroke="${color}" stroke-width="2.5"/>
      <text x="${legendX + 30}" y="${legendY}" fill="#dcddde" font-size="14" font-family="DejaVu Sans">${labelText}</text>`;
    legendX += 30 + labelText.length * 7.5 + 28;
  });

  const svg = `
<svg width="${WIDTH}" height="${HEIGHT}" xmlns="http://www.w3.org/2000/svg">
  <defs>${defsSvg}</defs>
  <rect width="${WIDTH}" height="${HEIGHT}" fill="#2b2d31"/>
  ${gridSvg}
  ${barsSvg}
  ${fillsSvg}
  ${linesSvg}
  ${leftAxisSvg}
  ${rightAxisSvg}
  ${xLabelsSvg}
  ${titleSvg}
  ${legendSvg}
</svg>`;

  return sharp(Buffer.from(svg)).png().toBuffer();
}

/**
 * Wrap a chart PNG buffer in a Statbot-style branded card.
 *
 * Card anatomy  (top → bottom):
 *   Header  90px — game icon + title/subtitle + stat callout boxes
 *   Chart  auto  — chartBuffer composited here (typically 600px)
 *   Footer  40px — lookback period (left)  +  PrimalGame branding (right)
 *
 * Icon loaded from modules/assets/icon.png — text-only header if missing.
 *
 * @param {Buffer} chartBuffer  PNG from buildLineChartImage / buildDualAxisChartImage
 * @param {object} opts
 *   title    {string}  bold header title
 *   subtitle {string}  smaller subheading  e.g. "Primal Pursuit · Maps"
 *   stats    {Array}   up to 3 × { label, value, color? } callout boxes
 *   lookback {string}  footer left text  e.g. "Past 14 Days"
 * @returns {Promise<Buffer>} RGBA PNG with rounded corners
 */
async function buildChartCard(chartBuffer, {
  title    = '',
  subtitle = '',
  stats    = [],
  lookback = '',
} = {}) {
  const CARD_W   = 1200;
  const HEADER_H = 90;
  const FOOTER_H = 40;
  const CORNER_R = 14;
  const ICON_SZ  = 64;
  const ICON_X   = 14;
  const ICON_Y   = 13;

  const { height: CHART_H } = await sharp(chartBuffer).metadata();
  const CARD_H   = HEADER_H + CHART_H + FOOTER_H;
  const FOOTER_Y = HEADER_H + CHART_H;

  // ── Icon: load → resize → round corners ─────────────────────────────────
  let iconBuffer = null;
  try {
    const raw = await sharp(path.join(__dirname, 'assets', 'icon.png'))
      .resize(ICON_SZ, ICON_SZ, { fit: 'cover' })
      .png()
      .toBuffer();
    const iconMask = await sharp(Buffer.from(
      `<svg width="${ICON_SZ}" height="${ICON_SZ}" xmlns="http://www.w3.org/2000/svg">` +
      `<rect width="${ICON_SZ}" height="${ICON_SZ}" rx="10" fill="white"/></svg>`
    )).png().toBuffer();
    iconBuffer = await sharp(raw)
      .composite([{ input: iconMask, blend: 'dest-in' }])
      .png()
      .toBuffer();
  } catch (_) { /* icon.png missing — text-only header */ }

  // ── Stat callout boxes (right side of header) ────────────────────────────
  const BOX_W   = 160;
  const BOX_H   = 62;
  const BOX_GAP = 10;
  const BOX_Y   = Math.round((HEADER_H - BOX_H) / 2);
  const capped  = stats.slice(0, 3);
  const totalBW = capped.length * BOX_W + Math.max(0, capped.length - 1) * BOX_GAP;
  let statBoxesSvg = '';
  capped.forEach((s, i) => {
    const bx  = CARD_W - 14 - totalBW + i * (BOX_W + BOX_GAP);
    const col = s.color || '#5865F2';
    statBoxesSvg += `
      <rect x="${bx}" y="${BOX_Y}" width="${BOX_W}" height="${BOX_H}" rx="6" fill="#111214"/>
      <circle cx="${bx + 16}" cy="${BOX_Y + 20}" r="4.5" fill="${col}"/>
      <text x="${bx + 28}" y="${BOX_Y + 24}"
            fill="#b5b9bf" font-size="13" font-family="DejaVu Sans">${escapeXml(s.label)}</text>
      <text x="${bx + 14}" y="${BOX_Y + 50}"
            fill="#e8e9eb" font-size="20" font-weight="bold"
            font-family="DejaVu Sans">${escapeXml(String(s.value))}</text>`;
  });

  // ── Header text ──────────────────────────────────────────────────────────
  const textX      = iconBuffer ? ICON_X + ICON_SZ + 14 : 20;
  const titleEl    = title
    ? `<text x="${textX}" y="42" fill="#e8e9eb" font-size="20" font-weight="bold"
             font-family="DejaVu Sans">${escapeXml(title)}</text>`
    : '';
  const subtitleEl = subtitle
    ? `<text x="${textX}" y="63" fill="#b5b9bf" font-size="14"
             font-family="DejaVu Sans">${escapeXml(subtitle)}</text>`
    : '';

  // ── Footer ───────────────────────────────────────────────────────────────
  const ftY        = FOOTER_Y + 26;
  const footerLeft = lookback
    ? `<text x="20" y="${ftY}" fill="#72767d" font-size="13"
             font-family="DejaVu Sans">Lookback: ${escapeXml(lookback)} — UTC</text>`
    : '';
  const footerRight = `
    <circle cx="${CARD_W - 98}" cy="${FOOTER_Y + 20}" r="5" fill="#5865F2"/>
    <text x="${CARD_W - 88}" y="${ftY}" fill="#72767d" font-size="13"
          font-family="DejaVu Sans">PrimalGame</text>`;

  // ── Card SVG skeleton ────────────────────────────────────────────────────
  const cardSvg = `
<svg width="${CARD_W}" height="${CARD_H}" xmlns="http://www.w3.org/2000/svg">
  <rect width="${CARD_W}" height="${HEADER_H}" fill="#232428"/>
  <rect y="${HEADER_H}" width="${CARD_W}" height="${CHART_H}" fill="#2b2d31"/>
  <rect y="${FOOTER_Y}" width="${CARD_W}" height="${FOOTER_H}" fill="#1e1f22"/>
  <line x1="0" y1="${HEADER_H}" x2="${CARD_W}" y2="${HEADER_H}"
        stroke="rgba(255,255,255,0.07)" stroke-width="1"/>
  <line x1="0" y1="${FOOTER_Y}" x2="${CARD_W}" y2="${FOOTER_Y}"
        stroke="rgba(255,255,255,0.07)" stroke-width="1"/>
  ${statBoxesSvg}
  ${titleEl}
  ${subtitleEl}
  ${footerLeft}
  ${footerRight}
</svg>`;

  // ── Composite skeleton + chart + icon ────────────────────────────────────
  const composites = [{ input: chartBuffer, top: HEADER_H, left: 0 }];
  if (iconBuffer) composites.push({ input: iconBuffer, top: ICON_Y, left: ICON_X });

  const flat = await sharp(Buffer.from(cardSvg))
    .composite(composites)
    .png()
    .toBuffer();

  // ── Rounded corners via dest-in mask ─────────────────────────────────────
  const maskBuffer = await sharp(Buffer.from(`
<svg width="${CARD_W}" height="${CARD_H}" xmlns="http://www.w3.org/2000/svg">
  <rect width="${CARD_W}" height="${CARD_H}" rx="${CORNER_R}" ry="${CORNER_R}" fill="white"/>
</svg>`)).png().toBuffer();

  return sharp(flat)
    .composite([{ input: maskBuffer, blend: 'dest-in' }])
    .png()
    .toBuffer();
}

/**
 * Render a branded data panel card (no chart — pure stats grid).
 *
 * Same header/footer structure as buildChartCard. The body is a
 * grid of dark rounded panels, auto-sized to content.
 *
 * @param {object} opts
 *   title    {string}   header title (item name)
 *   subtitle {string}   header subtitle (category · server)
 *   stats    {Array}    up to 3 × { label, value, color? } — header callout boxes
 *   lookback {string}   footer left text
 *   panels   {Array}    body panels × { title, lines: string[], color?: hex }
 *                       color adds a left accent bar (e.g. green=won, red=lost)
 *   note     {string}   optional muted note below panels (significance, caveats)
 * @returns {Promise<Buffer>} RGBA PNG with rounded corners
 */
async function buildStatCard({
  title    = '',
  subtitle = '',
  stats    = [],
  lookback = '',
  panels   = [],
  note     = '',
} = {}) {
  const CARD_W        = 900;
  const HEADER_H      = 90;
  const FOOTER_H      = 40;
  const CORNER_R      = 14;
  const ICON_SZ       = 48;
  const ICON_X        = 14;
  const ICON_Y        = 21;
  const BODY_PAD      = 32;
  const PANEL_GAP     = 16;
  const PANELS_PER_ROW = 2;

  // Panel height auto-sizes to tallest content in any panel
  const maxLines = panels.length > 0 ? Math.max(...panels.map(p => p.lines.length)) : 1;
  const PANEL_H  = 48 + maxLines * 30;        // 1-line=78px, 2=108px, 3=138px
  const PANEL_W  = Math.floor(
    (CARD_W - 2 * BODY_PAD - (PANELS_PER_ROW - 1) * PANEL_GAP) / PANELS_PER_ROW
  );                                           // ≈ 373px

  const numRows       = Math.ceil(panels.length / PANELS_PER_ROW);
  const panelsBlockH  = numRows * PANEL_H + Math.max(0, numRows - 1) * PANEL_GAP;
  const noteBlockH    = note ? PANEL_GAP + Math.max(1, Math.ceil(note.length / Math.floor((CARD_W - 2 * BODY_PAD) / 7.2))) * 20 : 0;
  const BODY_H        = BODY_PAD + panelsBlockH + noteBlockH + BODY_PAD;

  const CARD_H   = HEADER_H + BODY_H + FOOTER_H;
  const FOOTER_Y = HEADER_H + BODY_H;

  // ── Icon ─────────────────────────────────────────────────────────────
  let iconBuffer = null;
  try {
    const raw = await sharp(path.join(__dirname, 'assets', 'icon.png'))
      .resize(ICON_SZ, ICON_SZ, { fit: 'cover' })
      .png()
      .toBuffer();
    const iconMask = await sharp(Buffer.from(
      `<svg width="${ICON_SZ}" height="${ICON_SZ}" xmlns="http://www.w3.org/2000/svg">` +
      `<rect width="${ICON_SZ}" height="${ICON_SZ}" rx="10" fill="white"/></svg>`
    )).png().toBuffer();
    iconBuffer = await sharp(raw)
      .composite([{ input: iconMask, blend: 'dest-in' }])
      .png()
      .toBuffer();
  } catch (_) {}

  // ── Header stat boxes ────────────────────────────────────────────────
  const BOX_W   = 160;
  const BOX_H   = 62;
  const BOX_GAP = 10;
  const BOX_Y   = Math.round((HEADER_H - BOX_H) / 2);
  const capped  = stats.slice(0, 3);
  const totalBW = capped.length * BOX_W + Math.max(0, capped.length - 1) * BOX_GAP;
  let statBoxesSvg = '';
  capped.forEach((s, i) => {
    const bx  = CARD_W - 14 - totalBW + i * (BOX_W + BOX_GAP);
    const col = s.color || '#5865F2';
    statBoxesSvg += `
      <rect x="${bx}" y="${BOX_Y}" width="${BOX_W}" height="${BOX_H}" rx="6" fill="#111214"/>
      <circle cx="${bx + 16}" cy="${BOX_Y + 20}" r="4.5" fill="${col}"/>
      <text x="${bx + 28}" y="${BOX_Y + 24}"
            fill="#b5b9bf" font-size="13" font-family="DejaVu Sans">${escapeXml(s.label)}</text>
      <text x="${bx + 14}" y="${BOX_Y + 55}"
            fill="${col}" font-size="28" font-weight="bold"
            font-family="DejaVu Sans">${escapeXml(String(s.value))}</text>`;
  });

  // ── Header text ──────────────────────────────────────────────────────
  const textX      = iconBuffer ? ICON_X + ICON_SZ + 14 : 20;
  const titleEl    = title
    ? `<text x="${textX}" y="42" fill="#e8e9eb" font-size="20" font-weight="bold"
             font-family="DejaVu Sans">${escapeXml(title)}</text>`
    : '';
  const subtitleEl = subtitle
    ? `<text x="${textX}" y="63" fill="#b5b9bf" font-size="14"
             font-family="DejaVu Sans">${escapeXml(subtitle)}</text>`
    : '';

  // ── Body panels ──────────────────────────────────────────────────────
  const bodyStartY = HEADER_H + BODY_PAD;
  let panelsSvg    = '';

  panels.forEach((panel, i) => {
    const row        = Math.floor(i / PANELS_PER_ROW);
    const col        = i % PANELS_PER_ROW;
    const isOrphan   = panels.length % PANELS_PER_ROW !== 0 && i === panels.length - 1;
    const panelWidth = isOrphan ? CARD_W - 2 * BODY_PAD : PANEL_W;
    const px         = BODY_PAD + col * (PANEL_W + PANEL_GAP);
    const py         = bodyStartY + row * (PANEL_H + PANEL_GAP);
    const accent     = panel.color || null;

    panelsSvg += `<rect x="${px}" y="${py}" width="${panelWidth}" height="${PANEL_H}" rx="8" fill="#2b2d31" stroke="rgba(255,255,255,0.07)" stroke-width="1"/>`;

    if (accent) {
      panelsSvg += `<rect x="${px}" y="${py}" width="6" height="${PANEL_H}" rx="2" fill="${accent}"/>`;
    }

    const textStartX = px + (accent ? 20 : 16);

    const panelIcon = null;

    panelsSvg += `
      <text x="${textStartX}" y="${py + 26}"
            fill="#e8e9eb" font-size="18" font-weight="bold" font-family="DejaVu Sans">${escapeXml(panel.title)}</text>`;

    if (panel.subtitle) {
      panelsSvg += `
        <text x="${textStartX + 8 + panel.title.length * 10.5}" y="${py + 26}"
              fill="#72767d" font-size="13" font-family="DejaVu Sans">${escapeXml(panel.subtitle)}</text>`;
    }

    if (panelIcon) {
      panelsSvg += `
        <text x="${px + panelWidth - 16}" y="${py + 26}"
              fill="#72767d" font-size="14" font-family="DejaVu Sans"
              text-anchor="end">${escapeXml(panelIcon)}</text>`;
    }

    const isHero = panel.lines.length === 1 && !panel.lines[0].includes(': ');
    if (isHero) {
      // Center hero content in the space BELOW the title (title takes ~32px)
      const TITLE_H = 32;
      const availH  = PANEL_H - TITLE_H;
      const centerY = py + TITLE_H + Math.floor(availH / 2);

      const heroMatch = panel.lines[0].match(/^(.+?)\s+\((\d+.+?)\)$/);
      if (heroMatch) {
        const heroName  = heroMatch[1];
        const heroCount = `(${heroMatch[2]})`;
        panelsSvg += `
          <text x="${textStartX}" y="${centerY + 4}"
                fill="#e8e9eb" font-size="22" font-weight="bold"
                font-family="DejaVu Sans">${escapeXml(heroName)}</text>
          <text x="${textStartX}" y="${centerY + 22}"
                fill="#72767d" font-size="13"
                font-family="DejaVu Sans">${escapeXml(heroCount)}</text>`;
      } else {
        panelsSvg += `
          <text x="${textStartX}" y="${centerY + 8}"
                fill="#e8e9eb" font-size="22" font-weight="bold"
                font-family="DejaVu Sans">${escapeXml(panel.lines[0])}</text>`;
      }
    } else {
      panel.lines.forEach((line, li) => {
        const rowY = py + 38 + li * 30;
        const rowH = 26;
        panelsSvg += `<rect x="${px + 8}" y="${rowY}" width="${panelWidth - 16}" height="${rowH}" rx="5" fill="#111214"/>`;
        if (line.includes(': ')) {
          const colonIdx = line.indexOf(': ');
          const key      = line.slice(0, colonIdx);
          const val      = line.slice(colonIdx + 2);
          panelsSvg += `
            <text x="${textStartX + 4}" y="${rowY + 18}"
                  fill="#9b9ea4" font-size="13" font-family="DejaVu Sans">${escapeXml(key)}</text>
            <text x="${px + panelWidth - 16}" y="${rowY + 18}"
                  fill="#e8e9eb" font-size="15" font-weight="bold" font-family="DejaVu Sans"
                  text-anchor="end">${escapeXml(val)}</text>`;
        } else {
          panelsSvg += `
            <text x="${textStartX + 4}" y="${rowY + 18}"
                  fill="#e8e9eb" font-size="15" font-family="DejaVu Sans">${escapeXml(line)}</text>`;
        }
      });
    }
  });

  // ── Note line (word-wrapped) ───────────────────────────────────────────
  let noteSvg = '';
  if (note) {
    const avgCharW   = 7.2;
    const maxChars   = Math.floor((CARD_W - 2 * BODY_PAD) / avgCharW);
    const words      = note.split(' ');
    const noteLines  = [];
    let   current    = '';
    for (const word of words) {
      const test = current ? `${current} ${word}` : word;
      if (test.length <= maxChars) { current = test; }
      else { if (current) noteLines.push(current); current = word; }
    }
    if (current) noteLines.push(current);

    noteLines.forEach((line, i) => {
      noteSvg += `
        <text x="${BODY_PAD}" y="${bodyStartY + panelsBlockH + PANEL_GAP + 16 + i * 20}"
              fill="#72767d" font-size="13" font-family="DejaVu Sans">${escapeXml(line)}</text>`;
    });
  }

  // ── Footer ────────────────────────────────────────────────────────────
  const ftY        = FOOTER_Y + 26;
  const footerLeft = lookback
    ? `<text x="20" y="${ftY}" fill="#72767d" font-size="13"
             font-family="DejaVu Sans">Lookback: ${escapeXml(lookback)} — UTC</text>`
    : '';
  const footerRight = `
    <rect x="${CARD_W - 118}" y="${FOOTER_Y + 10}" width="28" height="20" rx="5" fill="#5865F2"/>
    <text x="${CARD_W - 104}" y="${FOOTER_Y + 24}" fill="white" font-size="11" font-weight="bold"
          font-family="DejaVu Sans" text-anchor="middle">PG</text>
    <text x="${CARD_W - 84}" y="${ftY}" fill="#72767d" font-size="13"
          font-family="DejaVu Sans">PrimalGame</text>`;

  // ── Card SVG ──────────────────────────────────────────────────────────
  const cardSvg = `
<svg width="${CARD_W}" height="${CARD_H}" xmlns="http://www.w3.org/2000/svg">
  <rect width="${CARD_W}" height="${HEADER_H}" fill="#1e2024"/>
  <rect y="${HEADER_H}" width="${CARD_W}" height="${BODY_H}" fill="#15171a"/>
  <rect y="${FOOTER_Y}" width="${CARD_W}" height="${FOOTER_H}" fill="#0e0f11"/>
  <line x1="0" y1="${HEADER_H}" x2="${CARD_W}" y2="${HEADER_H}"
        stroke="rgba(255,255,255,0.07)" stroke-width="1"/>
  <line x1="0" y1="${FOOTER_Y}" x2="${CARD_W}" y2="${FOOTER_Y}"
        stroke="rgba(255,255,255,0.07)" stroke-width="1"/>
  ${statBoxesSvg}
  ${titleEl}
  ${subtitleEl}
  ${panelsSvg}
  ${noteSvg}
  ${footerLeft}
  ${footerRight}
</svg>`;

  // ── Composite + rounded corners ───────────────────────────────────────
  const composites = [];
  if (iconBuffer) composites.push({ input: iconBuffer, top: ICON_Y, left: ICON_X });

  const flat = composites.length > 0
    ? await sharp(Buffer.from(cardSvg)).composite(composites).png().toBuffer()
    : await sharp(Buffer.from(cardSvg)).png().toBuffer();

  const maskBuffer = await sharp(Buffer.from(`
<svg width="${CARD_W}" height="${CARD_H}" xmlns="http://www.w3.org/2000/svg">
  <rect width="${CARD_W}" height="${CARD_H}" rx="${CORNER_R}" ry="${CORNER_R}" fill="white"/>
</svg>`)).png().toBuffer();

  return sharp(flat)
    .composite([{ input: maskBuffer, blend: 'dest-in' }])
    .png()
    .toBuffer();
}

// ── Donut chart helpers ───────────────────────────────────────────────────────
function polarToCartesian(cx, cy, r, angleDeg) {
  const rad = (angleDeg - 90) * Math.PI / 180;
  return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
}

function donutSegmentPath(cx, cy, outerR, innerR, startDeg, endDeg) {
  const o1   = polarToCartesian(cx, cy, outerR, startDeg);
  const o2   = polarToCartesian(cx, cy, outerR, endDeg);
  const i1   = polarToCartesian(cx, cy, innerR, endDeg);
  const i2   = polarToCartesian(cx, cy, innerR, startDeg);
  const large = (endDeg - startDeg) > 180 ? 1 : 0;
  return [
    `M ${o1.x.toFixed(2)} ${o1.y.toFixed(2)}`,
    `A ${outerR} ${outerR} 0 ${large} 1 ${o2.x.toFixed(2)} ${o2.y.toFixed(2)}`,
    `L ${i1.x.toFixed(2)} ${i1.y.toFixed(2)}`,
    `A ${innerR} ${innerR} 0 ${large} 0 ${i2.x.toFixed(2)} ${i2.y.toFixed(2)}`,
    'Z',
  ].join(' ');
}

/**
 * Branded donut chart card.
 * Left panel: ranked list. Right panel: donut + legend.
 *
 * @param {object} opts
 *   title       {string}  header title
 *   subtitle    {string}  header subtitle
 *   stats       {Array}   up to 3 × { label, value, color? } callout boxes
 *   lookback    {string}  footer left text
 *   segments    {Array}   [{ label, value, color? }] sorted descending
 *   centerLabel {string}  text in donut hole — use \n to split two lines
 * @returns {Promise<Buffer>} RGBA PNG with rounded corners
 */
async function buildPieCard({
  title       = '',
  subtitle    = '',
  stats       = [],
  lookback    = '',
  segments    = [],
  centerLabel = '',
} = {}) {
  const CARD_W   = 1200;
  const HEADER_H = 90;
  const FOOTER_H = 40;
  const BODY_H   = 400;
  const CORNER_R = 14;
  const ICON_SZ  = 48;
  const ICON_X   = 14;
  const ICON_Y   = 21;
  const CARD_H   = HEADER_H + BODY_H + FOOTER_H;
  const FOOTER_Y = HEADER_H + BODY_H;

  const LIST_PAD = 24;
  const LIST_W   = 350;
  const ROW_H    = 30;
  const ROW_GAP  = 5;

  const OUTER_R   = 155;
  const INNER_R   = 93;
  const DIVIDER_X = LIST_PAD + LIST_W + 12;          // 386
  const CX        = DIVIDER_X + 12 + 20 + OUTER_R;  // 573
  const CY        = HEADER_H + Math.floor(BODY_H / 2); // 290
  const LEGEND_X  = CX + OUTER_R + 28;               // 756

  // ── Icon ─────────────────────────────────────────────────────────────
  let iconBuffer = null;
  try {
    const raw = await sharp(path.join(__dirname, 'assets', 'icon.png'))
      .resize(ICON_SZ, ICON_SZ, { fit: 'cover' }).png().toBuffer();
    const iconMask = await sharp(Buffer.from(
      `<svg width="${ICON_SZ}" height="${ICON_SZ}" xmlns="http://www.w3.org/2000/svg">` +
      `<rect width="${ICON_SZ}" height="${ICON_SZ}" rx="10" fill="white"/></svg>`
    )).png().toBuffer();
    iconBuffer = await sharp(raw)
      .composite([{ input: iconMask, blend: 'dest-in' }]).png().toBuffer();
  } catch (_) {}

  // ── Header stat boxes ────────────────────────────────────────────────
  const BOX_W   = 160;
  const BOX_H   = 62;
  const BOX_GAP = 10;
  const BOX_Y   = Math.round((HEADER_H - BOX_H) / 2);
  const capped  = stats.slice(0, 3);
  const totalBW = capped.length * BOX_W + Math.max(0, capped.length - 1) * BOX_GAP;
  let statBoxesSvg = '';
  capped.forEach((s, i) => {
    const bx  = CARD_W - 14 - totalBW + i * (BOX_W + BOX_GAP);
    const col = s.color || '#5865F2';
    statBoxesSvg += `
      <rect x="${bx}" y="${BOX_Y}" width="${BOX_W}" height="${BOX_H}" rx="6" fill="#111214"/>
      <circle cx="${bx + 16}" cy="${BOX_Y + 20}" r="4.5" fill="${col}"/>
      <text x="${bx + 28}" y="${BOX_Y + 24}" fill="#b5b9bf" font-size="13" font-family="DejaVu Sans">${escapeXml(s.label)}</text>
      <text x="${bx + 14}" y="${BOX_Y + 55}" fill="${col}" font-size="28" font-weight="bold" font-family="DejaVu Sans">${escapeXml(String(s.value))}</text>`;
  });

  // ── Header text ──────────────────────────────────────────────────────
  const textX      = iconBuffer ? ICON_X + ICON_SZ + 14 : 20;
  const titleEl    = title    ? `<text x="${textX}" y="42" fill="#e8e9eb" font-size="20" font-weight="bold" font-family="DejaVu Sans">${escapeXml(title)}</text>`    : '';
  const subtitleEl = subtitle ? `<text x="${textX}" y="63" fill="#b5b9bf" font-size="14" font-family="DejaVu Sans">${escapeXml(subtitle)}</text>` : '';

  // ── Assign colours + compute total ───────────────────────────────────
  const total = segments.reduce((s, r) => s + r.value, 0) || 1;
  const segs  = segments.map((s, i) => ({ ...s, color: s.color || PALETTE[i % PALETTE.length] }));

  // ── Donut segments ────────────────────────────────────────────────────
  let donutSvg  = '';
  const GAP_DEG = segs.length > 1 ? 2 : 0;
  let currentDeg = 0;
  segs.forEach(s => {
    const spanDeg = (s.value / total) * 360;
    if (spanDeg <= GAP_DEG) { currentDeg += spanDeg; return; }
    const startDeg = currentDeg + GAP_DEG / 2;
    const endDeg   = currentDeg + spanDeg - GAP_DEG / 2;
    donutSvg += `<path d="${donutSegmentPath(CX, CY, OUTER_R, INNER_R, startDeg, endDeg)}" fill="${s.color}"/>`;
    currentDeg += spanDeg;
  });

  // Center label
  if (centerLabel) {
    const parts = centerLabel.includes('\n') ? centerLabel.split('\n') : [centerLabel, ''];
    donutSvg += `
      <text x="${CX}" y="${CY - 6}" fill="#e8e9eb" font-size="24" font-weight="bold"
            font-family="DejaVu Sans" text-anchor="middle">${escapeXml(parts[0])}</text>`;
    if (parts[1]) {
      donutSvg += `
        <text x="${CX}" y="${CY + 18}" fill="#72767d" font-size="14"
              font-family="DejaVu Sans" text-anchor="middle">${escapeXml(parts[1])}</text>`;
    }
  }

  // ── Legend ────────────────────────────────────────────────────────────
  const legendItems  = segs.slice(0, 10);
  const legendStartY = CY - Math.floor((legendItems.length * 24) / 2);
  let legendSvg = '';
  legendItems.forEach((s, i) => {
    const pct       = ((s.value / total) * 100).toFixed(1);
    const ly        = legendStartY + i * 24;
    const labelText = escapeXml(s.label.length > 18 ? s.label.slice(0, 17) + '…' : s.label);
    legendSvg += `
      <circle cx="${LEGEND_X + 6}" cy="${ly + 6}" r="5" fill="${s.color}"/>
      <text x="${LEGEND_X + 18}" y="${ly + 11}" fill="#b5b9bf" font-size="13"
            font-family="DejaVu Sans">${labelText}  ${pct}%</text>`;
  });

  // ── Ranked list ───────────────────────────────────────────────────────
  const visibleRows  = Math.min(segs.length, 10);
  const listStartY   = HEADER_H + Math.floor((BODY_H - visibleRows * (ROW_H + ROW_GAP)) / 2);
  let listSvg = '';
  segs.slice(0, 10).forEach((s, i) => {
    const pct   = ((s.value / total) * 100).toFixed(1);
    const rowY  = listStartY + i * (ROW_H + ROW_GAP);
    const label = escapeXml(s.label.length > 20 ? s.label.slice(0, 19) + '…' : s.label);
    listSvg += `
      <rect x="${LIST_PAD}" y="${rowY}" width="${LIST_W}" height="${ROW_H}" rx="5"
            fill="#2b2d31" stroke="rgba(255,255,255,0.07)" stroke-width="1"/>
      <text x="${LIST_PAD + 22}" y="${rowY + 20}" fill="${s.color}" font-size="14" font-weight="bold"
            font-family="DejaVu Sans" text-anchor="middle">${i + 1}</text>
      <text x="${LIST_PAD + 38}" y="${rowY + 20}" fill="#e8e9eb" font-size="14"
            font-family="DejaVu Sans">${label}</text>
      <text x="${LIST_PAD + LIST_W - 8}" y="${rowY + 20}" fill="#72767d" font-size="13"
            font-family="DejaVu Sans" text-anchor="end">${pct}%</text>`;
  });

  // Divider
  const dividerSvg = `<line x1="${DIVIDER_X}" y1="${HEADER_H + 20}" x2="${DIVIDER_X}" y2="${FOOTER_Y - 20}" stroke="rgba(255,255,255,0.07)" stroke-width="1"/>`;

  // ── Footer ────────────────────────────────────────────────────────────
  const ftY        = FOOTER_Y + 26;
  const footerLeft = lookback
    ? `<text x="20" y="${ftY}" fill="#72767d" font-size="13" font-family="DejaVu Sans">Lookback: ${escapeXml(lookback)} — UTC</text>`
    : '';
  const footerRight = `
    <rect x="${CARD_W - 118}" y="${FOOTER_Y + 10}" width="28" height="20" rx="5" fill="#5865F2"/>
    <text x="${CARD_W - 104}" y="${FOOTER_Y + 24}" fill="white" font-size="11" font-weight="bold"
          font-family="DejaVu Sans" text-anchor="middle">PG</text>
    <text x="${CARD_W - 84}" y="${ftY}" fill="#72767d" font-size="13"
          font-family="DejaVu Sans">PrimalGame</text>`;

  // ── Card SVG ──────────────────────────────────────────────────────────
  const cardSvg = `
<svg width="${CARD_W}" height="${CARD_H}" xmlns="http://www.w3.org/2000/svg">
  <rect width="${CARD_W}" height="${HEADER_H}" fill="#1e2024"/>
  <rect y="${HEADER_H}" width="${CARD_W}" height="${BODY_H}" fill="#15171a"/>
  <rect y="${FOOTER_Y}" width="${CARD_W}" height="${FOOTER_H}" fill="#0e0f11"/>
  <line x1="0" y1="${HEADER_H}" x2="${CARD_W}" y2="${HEADER_H}" stroke="rgba(255,255,255,0.07)" stroke-width="1"/>
  <line x1="0" y1="${FOOTER_Y}" x2="${CARD_W}" y2="${FOOTER_Y}" stroke="rgba(255,255,255,0.07)" stroke-width="1"/>
  ${statBoxesSvg}
  ${titleEl}
  ${subtitleEl}
  ${listSvg}
  ${dividerSvg}
  ${donutSvg}
  ${legendSvg}
  ${footerLeft}
  ${footerRight}
</svg>`;

  // ── Composite + rounded corners ───────────────────────────────────────
  const composites = [];
  if (iconBuffer) composites.push({ input: iconBuffer, top: ICON_Y, left: ICON_X });

  const flat = composites.length > 0
    ? await sharp(Buffer.from(cardSvg)).composite(composites).png().toBuffer()
    : await sharp(Buffer.from(cardSvg)).png().toBuffer();

  const maskBuffer = await sharp(Buffer.from(`
<svg width="${CARD_W}" height="${CARD_H}" xmlns="http://www.w3.org/2000/svg">
  <rect width="${CARD_W}" height="${CARD_H}" rx="${CORNER_R}" ry="${CORNER_R}" fill="white"/>
</svg>`)).png().toBuffer();

  return sharp(flat)
    .composite([{ input: maskBuffer, blend: 'dest-in' }])
    .png()
    .toBuffer();
}

/**
 * Ranked tier list card — 10 items with rank badges, bars, and counts.
 *
 * @param {object} opts
 *   title       {string}  header title
 *   subtitle    {string}  header subtitle
 *   stats       {Array}   up to 3 × { label, value, color? } callout boxes
 *   lookback    {string}  footer left text
 *   items       {Array}   [{ name, count }] sorted descending, max 10
 *   accentColor {string}  bar fill color (default #5865F2)
 * @returns {Promise<Buffer>} RGBA PNG with rounded corners
 */
async function buildTierListCard({
  title       = '',
  subtitle    = '',
  stats       = [],
  lookback    = '',
  items       = [],
  accentColor = '#5865F2',
  category    = null,
} = {}) {
  const CARD_W   = 900;
  const HEADER_H = 90;
  const FOOTER_H = 40;
  const CORNER_R = 14;
  const ICON_SZ  = 48;
  const ICON_X   = 14;
  const ICON_Y   = 21;
  const PAD      = 16;
  const P_GAP    = 10;

  const INNER_W  = CARD_W - 2 * PAD;
  const W1       = Math.floor(INNER_W * 0.36);
  const W2       = Math.floor(INNER_W * 0.33);
  const W3       = INNER_W - W1 - W2 - 2 * P_GAP;
  const H1       = 265;
  const H2       = 225;
  const H3       = 205;

  const PODIUM_BOTTOM = HEADER_H + PAD + H1;
  const X2 = PAD;
  const X1 = X2 + W2 + P_GAP;
  const X3 = X1 + W1 + P_GAP;
  const Y1 = HEADER_H + PAD;
  const Y2 = PODIUM_BOTTOM - H2;
  const Y3 = PODIUM_BOTTOM - H3;

  const capped      = items.slice(0, 10);
  const podiumItems = capped.slice(0, 3);
  const listItems   = capped.slice(3);
  const maxCount    = capped.length > 0 ? capped[0].count : 1;

  const ROW_H        = 32;
  const ROW_GAP      = 4;
  const LIST_START_Y = PODIUM_BOTTOM + 14;
  const LIST_H       = listItems.length > 0
    ? listItems.length * (ROW_H + ROW_GAP) - ROW_GAP
    : 0;
  const FOOTER_Y = LIST_START_Y + LIST_H + (listItems.length > 0 ? 14 : 0);
  const CARD_H   = FOOTER_Y + FOOTER_H;

  const MEDALS = [
    { color: '#FFD700', label: '1' },
    { color: '#C0C0C0', label: '2' },
    { color: '#CD7F32', label: '3' },
  ];
  const PODIUM_CFGS = [
    { x: X1, y: Y1, w: W1, h: H1, medal: MEDALS[0], bg: '#161820' },
    { x: X2, y: Y2, w: W2, h: H2, medal: MEDALS[1], bg: '#111214' },
    { x: X3, y: Y3, w: W3, h: H3, medal: MEDALS[2], bg: '#111214' },
  ];

  // ── Icon ──────────────────────────────────────────────────────────────
  let iconBuffer = null;
  try {
    const raw = await sharp(path.join(__dirname, 'assets', 'icon.png'))
      .resize(ICON_SZ, ICON_SZ, { fit: 'cover' }).png().toBuffer();
    const mask = await sharp(Buffer.from(
      `<svg width="${ICON_SZ}" height="${ICON_SZ}" xmlns="http://www.w3.org/2000/svg">` +
      `<rect width="${ICON_SZ}" height="${ICON_SZ}" rx="10" fill="white"/></svg>`
    )).png().toBuffer();
    iconBuffer = await sharp(raw).composite([{ input: mask, blend: 'dest-in' }]).png().toBuffer();
  } catch (_) {}

  // ── Header stat boxes — only non-total stats ──────────────────────────
  const BOX_W = 160, BOX_H = 62, BOX_GAP = 10;
  const BOX_Y = Math.round((HEADER_H - BOX_H) / 2);
  const filteredStats = stats.filter(s => s.label !== 'MVP Rounds' && s.label !== 'Total Pickups' && s.label !== 'Total');
  const cappedS = filteredStats.slice(0, 2);
  const totalBW = cappedS.length * BOX_W + Math.max(0, cappedS.length - 1) * BOX_GAP;
  let statBoxesSvg = '';
  cappedS.forEach((s, i) => {
    const bx  = CARD_W - 14 - totalBW + i * (BOX_W + BOX_GAP);
    const col = s.color || '#5865F2';
    statBoxesSvg += `
      <rect x="${bx}" y="${BOX_Y}" width="${BOX_W}" height="${BOX_H}" rx="6" fill="#111214"/>
      <circle cx="${bx + 16}" cy="${BOX_Y + 20}" r="4.5" fill="${col}"/>
      <text x="${bx + 28}" y="${BOX_Y + 24}" fill="#b5b9bf" font-size="13" font-family="DejaVu Sans">${escapeXml(s.label)}</text>
      <text x="${bx + 14}" y="${BOX_Y + 55}" fill="${col}" font-size="28" font-weight="bold" font-family="DejaVu Sans">${escapeXml(String(s.value))}</text>`;
  });

  // ── Header text ───────────────────────────────────────────────────────
  const textX      = iconBuffer ? ICON_X + ICON_SZ + 14 : 20;
  const titleEl    = title    ? `<text x="${textX}" y="42" fill="#e8e9eb" font-size="20" font-weight="bold" font-family="DejaVu Sans">${escapeXml(title)}</text>` : '';
  const subtitleEl = subtitle ? `<text x="${textX}" y="63" fill="#b5b9bf" font-size="14" font-family="DejaVu Sans">${escapeXml(subtitle)}</text>` : '';

  // ── Podium panels ─────────────────────────────────────────────────────
  const composites = [];
  if (iconBuffer) composites.push({ input: iconBuffer, top: ICON_Y, left: ICON_X });

  let podiumSvg = '';
  for (let i = 0; i < Math.min(podiumItems.length, 3); i++) {
    const item    = podiumItems[i];
    const cfg     = PODIUM_CFGS[i];
    const medal   = cfg.medal;

    // image area: top 55% of panel below rank label
    const RANK_H  = 32;
    const NAME_H  = 48;
    const imgX    = cfg.x + 12;
    const imgY    = cfg.y + RANK_H;
    const imgW    = cfg.w - 24;
    const imgH    = Math.floor((cfg.h - RANK_H - NAME_H) * 0.92);
    const nameY   = cfg.y + cfg.h - 28;
    const countY  = cfg.y + cfg.h - 10;
    const nameStr = item.name.length > 18 ? item.name.slice(0, 17) + '…' : item.name;

    // watermark rank number
    const wmarkX  = cfg.x + cfg.w - 14;
    const wmarkY  = cfg.y + cfg.h - 8;

    podiumSvg += `
      <rect x="${cfg.x}" y="${cfg.y}" width="${cfg.w}" height="${cfg.h}" rx="8"
            fill="${cfg.bg}" stroke="rgba(255,255,255,0.07)" stroke-width="1"/>

      <!-- watermark rank -->
      <text x="${wmarkX}" y="${wmarkY}"
            fill="${medal.color}" font-size="72" font-weight="bold"
            font-family="DejaVu Sans" text-anchor="end"
            opacity="0.06">${medal.label}</text>

      <!-- rank label -->
      <text x="${cfg.x + 14}" y="${cfg.y + 22}"
            fill="${medal.color}" font-size="12" font-weight="bold"
            font-family="DejaVu Sans">#${medal.label}</text>

      <!-- image area -->
      <rect x="${imgX}" y="${imgY}" width="${imgW}" height="${imgH}" rx="6"
            fill="rgba(255,255,255,0.02)"
            stroke="rgba(255,255,255,0.06)" stroke-width="1" stroke-dasharray="5 4"/>
      <text x="${imgX + imgW / 2}" y="${imgY + imgH / 2 - 4}"
            fill="rgba(255,255,255,0.08)" font-size="11"
            font-family="DejaVu Sans" text-anchor="middle">Image</text>
      <text x="${imgX + imgW / 2}" y="${imgY + imgH / 2 + 12}"
            fill="rgba(255,255,255,0.04)" font-size="10"
            font-family="DejaVu Sans" text-anchor="middle">Coming Soon</text>

      <!-- name + count -->
      <line x1="${cfg.x + 10}" y1="${nameY - 12}"
            x2="${cfg.x + cfg.w - 10}" y2="${nameY - 12}"
            stroke="rgba(255,255,255,0.05)" stroke-width="1"/>
      <text x="${cfg.x + cfg.w / 2}" y="${nameY}"
            fill="#e8e9eb" font-size="15" font-weight="bold"
            font-family="DejaVu Sans" text-anchor="middle">${escapeXml(nameStr)}</text>
      <text x="${cfg.x + cfg.w / 2}" y="${countY}"
            fill="${medal.color}" font-size="12"
            font-family="DejaVu Sans" text-anchor="middle">${escapeXml(String(item.count))}×</text>`;

    if (category) {
      const imgPath = path.join(__dirname, 'assets', 'items', category, `${item.name}.png`);
      try {
        const raw = await sharp(imgPath)
          .resize(imgW - 4, imgH - 4, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
          .png().toBuffer();
        composites.push({ input: raw, top: imgY + 2, left: imgX + 2 });
      } catch (_) {}
    }
  }

  // ── List rows (4–10) ──────────────────────────────────────────────────
  let listSvg = '';
  if (listItems.length > 0) {
    listSvg += `<line x1="${PAD}" y1="${LIST_START_Y - 7}" x2="${CARD_W - PAD}" y2="${LIST_START_Y - 7}"
                      stroke="rgba(255,255,255,0.05)" stroke-width="1"/>`;
  }

  listItems.forEach((item, i) => {
    const rank     = i + 4;
    const rowY     = LIST_START_Y + i * (ROW_H + ROW_GAP);
    const fillW    = Math.round((item.count / maxCount) * (CARD_W - 2 * PAD));
    const opacity  = (0.03 + (item.count / maxCount) * 0.10).toFixed(3);
    const nameSafe = item.name.length > 32 ? item.name.slice(0, 31) + '…' : item.name;

    listSvg += `
      <rect x="${PAD}" y="${rowY}" width="${CARD_W - 2 * PAD}" height="${ROW_H}" rx="5"
            fill="rgba(255,255,255,0.03)" stroke="rgba(255,255,255,0.05)" stroke-width="1"/>
      <rect x="${PAD}" y="${rowY}" width="${fillW}" height="${ROW_H}" rx="5"
            fill="${accentColor}" opacity="${opacity}"/>
      <text x="${PAD + 16}" y="${rowY + 21}"
            fill="#4a4d5e" font-size="11" font-family="DejaVu Sans"
            text-anchor="middle">${rank}</text>
      <text x="${PAD + 30}" y="${rowY + 21}"
            fill="#c8cad0" font-size="13" font-family="DejaVu Sans">${escapeXml(nameSafe)}</text>
      <text x="${CARD_W - PAD - 8}" y="${rowY + 21}"
            fill="#6b6e7a" font-size="12" font-family="DejaVu Sans"
            text-anchor="end">${escapeXml(String(item.count))}×</text>`;
  });

  // ── Footer ────────────────────────────────────────────────────────────
  const ftY         = FOOTER_Y + 26;
  const footerLeft  = lookback
    ? `<text x="20" y="${ftY}" fill="#72767d" font-size="13" font-family="DejaVu Sans">Lookback: ${escapeXml(lookback)} — UTC</text>`
    : '';
  const footerRight = `
    <rect x="${CARD_W - 118}" y="${FOOTER_Y + 10}" width="28" height="20" rx="5" fill="#5865F2"/>
    <text x="${CARD_W - 104}" y="${FOOTER_Y + 24}" fill="white" font-size="11" font-weight="bold"
          font-family="DejaVu Sans" text-anchor="middle">PG</text>
    <text x="${CARD_W - 84}" y="${ftY}" fill="#72767d" font-size="13"
          font-family="DejaVu Sans">PrimalGame</text>`;

  // ── Card SVG ──────────────────────────────────────────────────────────
  const cardSvg = `
<svg width="${CARD_W}" height="${CARD_H}" xmlns="http://www.w3.org/2000/svg">
  <rect width="${CARD_W}" height="${HEADER_H}" fill="#1e2024"/>
  <rect y="${HEADER_H}" width="${CARD_W}" height="${CARD_H - HEADER_H - FOOTER_H}" fill="#15171a"/>
  <rect y="${FOOTER_Y}" width="${CARD_W}" height="${FOOTER_H}" fill="#0e0f11"/>
  <line x1="0" y1="${HEADER_H}" x2="${CARD_W}" y2="${HEADER_H}" stroke="rgba(255,255,255,0.07)" stroke-width="1"/>
  <line x1="0" y1="${FOOTER_Y}" x2="${CARD_W}" y2="${FOOTER_Y}" stroke="rgba(255,255,255,0.07)" stroke-width="1"/>
  ${statBoxesSvg}
  ${titleEl}
  ${subtitleEl}
  ${podiumSvg}
  ${listSvg}
  ${footerLeft}
  ${footerRight}
</svg>`;

  const flat = composites.length > 0
    ? await sharp(Buffer.from(cardSvg)).composite(composites).png().toBuffer()
    : await sharp(Buffer.from(cardSvg)).png().toBuffer();

  const maskBuffer = await sharp(Buffer.from(`
<svg width="${CARD_W}" height="${CARD_H}" xmlns="http://www.w3.org/2000/svg">
  <rect width="${CARD_W}" height="${CARD_H}" rx="${CORNER_R}" ry="${CORNER_R}" fill="white"/>
</svg>`)).png().toBuffer();

  return sharp(flat).composite([{ input: maskBuffer, blend: 'dest-in' }]).png().toBuffer();
}

/**
 * Single wide dashboard showing win rates for all four maps in a 2×2 grid.
 * Replaces the four separate stat cards in the win-rate channel.
 *
 * @param {object} opts
 *   title    {string}  header title
 *   subtitle {string}  header subtitle
 *   stats    {Array}   up to 3 × { label, value, color? } callout boxes
 *   lookback {string}  footer left text
 *   maps     {Array}   [{ name, rounds, dinoWins, survivorWins }]
 * @returns {Promise<Buffer>} RGBA PNG with rounded corners
 */
async function buildWinRateDashboard({
  title    = 'Win Rate by Map',
  subtitle = '',
  stats    = [],
  lookback = '',
  maps     = [],
} = {}) {
  const CARD_W   = 1200;
  const HEADER_H = 90;
  const FOOTER_H = 40;
  const BODY_H   = 520;
  const CORNER_R = 14;
  const ICON_SZ  = 48;
  const ICON_X   = 14;
  const ICON_Y   = 21;
  const BODY_PAD = 24;
  const MAP_GAP  = 16;

  const CARD_H   = HEADER_H + BODY_H + FOOTER_H;
  const FOOTER_Y = HEADER_H + BODY_H;
  const PANEL_W  = Math.floor((CARD_W - 2 * BODY_PAD - MAP_GAP) / 2);
  const PANEL_H  = Math.floor((BODY_H - 2 * BODY_PAD - MAP_GAP) / 2);

  const POSITIONS = [
    { x: BODY_PAD,                  y: HEADER_H + BODY_PAD                  },
    { x: BODY_PAD + PANEL_W + MAP_GAP, y: HEADER_H + BODY_PAD               },
    { x: BODY_PAD,                  y: HEADER_H + BODY_PAD + PANEL_H + MAP_GAP },
    { x: BODY_PAD + PANEL_W + MAP_GAP, y: HEADER_H + BODY_PAD + PANEL_H + MAP_GAP },
  ];

  // ── Icon ──────────────────────────────────────────────────────────────
  let iconBuffer = null;
  try {
    const raw = await sharp(path.join(__dirname, 'assets', 'icon.png'))
      .resize(ICON_SZ, ICON_SZ, { fit: 'cover' }).png().toBuffer();
    const iconMask = await sharp(Buffer.from(
      `<svg width="${ICON_SZ}" height="${ICON_SZ}" xmlns="http://www.w3.org/2000/svg">` +
      `<rect width="${ICON_SZ}" height="${ICON_SZ}" rx="10" fill="white"/></svg>`
    )).png().toBuffer();
    iconBuffer = await sharp(raw).composite([{ input: iconMask, blend: 'dest-in' }]).png().toBuffer();
  } catch (_) {}

  // ── Header stat boxes ─────────────────────────────────────────────────
  const BOX_W   = 160;
  const BOX_H   = 62;
  const BOX_GAP = 10;
  const BOX_Y   = Math.round((HEADER_H - BOX_H) / 2);
  const cappedS = stats.slice(0, 3);
  const totalBW = cappedS.length * BOX_W + Math.max(0, cappedS.length - 1) * BOX_GAP;
  let statBoxesSvg = '';
  cappedS.forEach((s, i) => {
    const bx  = CARD_W - 14 - totalBW + i * (BOX_W + BOX_GAP);
    const col = s.color || '#5865F2';
    statBoxesSvg += `
      <rect x="${bx}" y="${BOX_Y}" width="${BOX_W}" height="${BOX_H}" rx="6" fill="#111214"/>
      <circle cx="${bx + 16}" cy="${BOX_Y + 20}" r="4.5" fill="${col}"/>
      <text x="${bx + 28}" y="${BOX_Y + 24}" fill="#b5b9bf" font-size="13" font-family="DejaVu Sans">${escapeXml(s.label)}</text>
      <text x="${bx + 14}" y="${BOX_Y + 55}" fill="${col}" font-size="28" font-weight="bold" font-family="DejaVu Sans">${escapeXml(String(s.value))}</text>`;
  });

  // ── Header text ───────────────────────────────────────────────────────
  const textX      = iconBuffer ? ICON_X + ICON_SZ + 14 : 20;
  const titleEl    = title    ? `<text x="${textX}" y="42" fill="#e8e9eb" font-size="20" font-weight="bold" font-family="DejaVu Sans">${escapeXml(title)}</text>` : '';
  const subtitleEl = subtitle ? `<text x="${textX}" y="63" fill="#b5b9bf" font-size="14" font-family="DejaVu Sans">${escapeXml(subtitle)}</text>` : '';

  // ── Map panels ────────────────────────────────────────────────────────
  let panelsSvg = '';
  const BAR_H   = 18;
  const BAR_PAD = 20;
  const BAR_W   = PANEL_W - BAR_PAD * 2;
  const BAR_Y   = PANEL_H - 44;
  const HALF_W  = Math.floor(PANEL_W / 2);

  maps.slice(0, 4).forEach((map, i) => {
    const { x: px, y: py } = POSITIONS[i];
    const mapColor      = MAP_COLORS[map.name] ?? '#5865F2';
    const total         = map.rounds || 1;
    const dinoWinPct    = Math.round((map.dinoWins / total) * 100);
    const survivorWinPct = 100 - dinoWinPct;
    const dinoBarW      = Math.round((map.dinoWins / total) * BAR_W);
    const survivorBarW  = BAR_W - dinoBarW;

    panelsSvg += `
      <rect x="${px}" y="${py}" width="${PANEL_W}" height="${PANEL_H}"
            rx="8" fill="#111214" stroke="rgba(255,255,255,0.07)" stroke-width="1"/>
      <rect x="${px}" y="${py}" width="6" height="${PANEL_H}" rx="2" fill="${mapColor}"/>

      <text x="${px + 22}" y="${py + 30}"
            fill="${mapColor}" font-size="20" font-weight="bold"
            font-family="DejaVu Sans">${escapeXml(map.name)}</text>
      <text x="${px + 22}" y="${py + 50}"
            fill="#72767d" font-size="13"
            font-family="DejaVu Sans">${map.rounds.toLocaleString()} rounds</text>
      <line x1="${px + 16}" y1="${py + 62}" x2="${px + PANEL_W - 16}" y2="${py + 62}"
            stroke="rgba(255,255,255,0.07)" stroke-width="1"/>

      <text x="${px + 22}" y="${py + 84}"
            fill="#9b9ea4" font-size="13" font-family="DejaVu Sans">Dino Win</text>
      <text x="${px + HALF_W + 8}" y="${py + 84}"
            fill="#9b9ea4" font-size="13" font-family="DejaVu Sans">Survivor Win</text>

      <text x="${px + 22}" y="${py + 148}"
            fill="#ED4245" font-size="56" font-weight="bold"
            font-family="DejaVu Sans">${dinoWinPct}%</text>
      <text x="${px + HALF_W + 8}" y="${py + 148}"
            fill="#57F287" font-size="56" font-weight="bold"
            font-family="DejaVu Sans">${survivorWinPct}%</text>

      <rect x="${px + BAR_PAD}" y="${py + BAR_Y}" width="${BAR_W}" height="${BAR_H}"
            rx="5" fill="rgba(255,255,255,0.06)"/>
      <rect x="${px + BAR_PAD}" y="${py + BAR_Y}" width="${dinoBarW}" height="${BAR_H}"
            rx="5" fill="#ED4245" opacity="0.8"/>
      <rect x="${px + BAR_PAD + dinoBarW}" y="${py + BAR_Y}" width="${survivorBarW}" height="${BAR_H}"
            rx="5" fill="#57F287" opacity="0.8"/>`;
  });

  // ── Footer ────────────────────────────────────────────────────────────
  const ftY        = FOOTER_Y + 26;
  const footerLeft = lookback
    ? `<text x="20" y="${ftY}" fill="#72767d" font-size="13" font-family="DejaVu Sans">Lookback: ${escapeXml(lookback)} — UTC</text>`
    : '';
  const footerRight = `
    <rect x="${CARD_W - 118}" y="${FOOTER_Y + 10}" width="28" height="20" rx="5" fill="#5865F2"/>
    <text x="${CARD_W - 104}" y="${FOOTER_Y + 24}" fill="white" font-size="11" font-weight="bold"
          font-family="DejaVu Sans" text-anchor="middle">PG</text>
    <text x="${CARD_W - 84}" y="${ftY}" fill="#72767d" font-size="13"
          font-family="DejaVu Sans">PrimalGame</text>`;

  // ── Card SVG ──────────────────────────────────────────────────────────
  const cardSvg = `
<svg width="${CARD_W}" height="${CARD_H}" xmlns="http://www.w3.org/2000/svg">
  <rect width="${CARD_W}" height="${HEADER_H}" fill="#1e2024"/>
  <rect y="${HEADER_H}" width="${CARD_W}" height="${BODY_H}" fill="#15171a"/>
  <rect y="${FOOTER_Y}" width="${CARD_W}" height="${FOOTER_H}" fill="#0e0f11"/>
  <line x1="0" y1="${HEADER_H}" x2="${CARD_W}" y2="${HEADER_H}" stroke="rgba(255,255,255,0.07)" stroke-width="1"/>
  <line x1="0" y1="${FOOTER_Y}" x2="${CARD_W}" y2="${FOOTER_Y}" stroke="rgba(255,255,255,0.07)" stroke-width="1"/>
  ${statBoxesSvg}
  ${titleEl}
  ${subtitleEl}
  ${panelsSvg}
  ${footerLeft}
  ${footerRight}
</svg>`;

  // ── Composite + rounded corners ───────────────────────────────────────
  const composites = [];
  if (iconBuffer) composites.push({ input: iconBuffer, top: ICON_Y, left: ICON_X });

  const flat = composites.length > 0
    ? await sharp(Buffer.from(cardSvg)).composite(composites).png().toBuffer()
    : await sharp(Buffer.from(cardSvg)).png().toBuffer();

  const maskBuffer = await sharp(Buffer.from(`
<svg width="${CARD_W}" height="${CARD_H}" xmlns="http://www.w3.org/2000/svg">
  <rect width="${CARD_W}" height="${CARD_H}" rx="${CORNER_R}" ry="${CORNER_R}" fill="white"/>
</svg>`)).png().toBuffer();

  return sharp(flat).composite([{ input: maskBuffer, blend: 'dest-in' }]).png().toBuffer();
}

/**
 * Win rate card — item image left, stats right.
 * Large survivor/dino split bar as visual centerpiece, level brackets below.
 */
async function buildWinRateCard({
  itemName      = '',
  category      = '',
  lookback      = '',
  rounds        = 0,
  survivorWins  = 0,
  dinoWins      = 0,
  bestMap       = null,
  coItem        = null,
  baseline      = null,
  levelBrackets = [],
  itemImagePath = null,
} = {}) {
  const CARD_W   = 1100;
  const CARD_H   = 500;
  const FOOTER_H = 40;
  const FOOTER_Y = CARD_H - FOOTER_H;
  const CORNER_R = 14;
  const LEFT_W   = 300;
  const RIGHT_X  = LEFT_W;
  const RP       = 28; // right padding
  const RCX      = RIGHT_X + RP;
  const RCR      = CARD_W - RP;
  const RCW      = RCR - RCX;

  const survivorPct = rounds > 0 ? Math.round((survivorWins / rounds) * 100) : 0;
  const dinoPct     = 100 - survivorPct;
  const catLabel    = category === 'vehicle' ? 'VEHICLE' : 'WEAPON';
  const catColor    = category === 'vehicle' ? '#5865F2' : '#ED4245';
  const coLabel     = category === 'vehicle' ? 'TOP CO-GUN' : 'TOP CO-CAR';

  // ── Left panel ─────────────────────────────────────────────────────────
  const PH_W = 200, PH_H = 200;
  const PH_X = Math.floor((LEFT_W - PH_W) / 2);
  const PH_Y = 140; // centered between header line (115) and category pill (358)

  let leftContent = '';
  let imgComposite = null;

  if (itemImagePath) {
    try {
      const raw = await sharp(itemImagePath)
        .resize(PH_W, PH_H, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
        .png().toBuffer();
      imgComposite = { input: raw, top: PH_Y, left: PH_X };
    } catch (_) { itemImagePath = null; }
  }

  if (!itemImagePath) {
    leftContent += `
      <rect x="${PH_X}" y="${PH_Y}" width="${PH_W}" height="${PH_H}" rx="8"
            fill="none" stroke="rgba(255,255,255,0.08)" stroke-width="1" stroke-dasharray="6 4"/>
      <text x="${Math.floor(LEFT_W / 2)}" y="${PH_Y + PH_H / 2}"
            fill="rgba(255,255,255,0.12)" font-size="12" font-family="DejaVu Sans"
            text-anchor="middle">Item Image</text>
      <text x="${Math.floor(LEFT_W / 2)}" y="${PH_Y + PH_H / 2 + 18}"
            fill="rgba(255,255,255,0.07)" font-size="11" font-family="DejaVu Sans"
            text-anchor="middle">Coming Soon</text>`;
  }

  // category tag + round count on left panel (name removed — shown in right header)
  leftContent += `
    <line x1="20" y1="115" x2="${LEFT_W - 20}" y2="115" stroke="rgba(255,255,255,0.06)" stroke-width="1"/>
    <rect x="${Math.floor((LEFT_W - 110) / 2)}" y="358" width="110" height="24" rx="5"
          fill="${catColor}" opacity="0.12"/>
    <text x="${Math.floor(LEFT_W / 2)}" y="375"
          fill="${catColor}" font-size="11" font-weight="bold" font-family="DejaVu Sans"
          letter-spacing="1" text-anchor="middle">${escapeXml(catLabel)}</text>
    <text x="${Math.floor(LEFT_W / 2)}" y="398"
          fill="#4a4d5e" font-size="11" font-family="DejaVu Sans"
          text-anchor="middle">${escapeXml(rounds.toLocaleString())} rounds</text>`;

  // ── Split bar ─────────────────────────────────────────────────────────
  const BAR_Y  = 208;
  const BAR_H  = 14;
  const sBarW  = Math.round((survivorPct / 100) * RCW);
  const dBarW  = RCW - sBarW;

  // ── Info row ──────────────────────────────────────────────────────────
  const INFO_LABEL_Y = 252;
  const INFO_VAL_Y   = 278;
  const INFO_SUB_Y   = 294;
  const COL_W        = Math.floor(RCW / 3);

  const bestMapStr = bestMap ? bestMap.name : '—';
  const bestMapLow = bestMap && bestMap.rounds < 20 ? ' ⚠' : '';
  const bestMapSub = bestMap ? `${bestMap.survivorWinPct}% surv · ${bestMap.rounds}r${bestMapLow}` : '';
  const coItemStr  = coItem  ? (coItem.name.length > 13 ? coItem.name.slice(0, 12) + '…' : coItem.name) : '—';
  const coItemSub  = coItem  ? `${coItem.count}x MVP rounds` : '';
  const baseStr    = baseline ? `${Math.round(baseline.rate * 100)}%` : '—';
  const baseSub    = baseline ? `${baseline.rounds.toLocaleString()} rounds` : 'not enough data';

  // ── Level brackets ────────────────────────────────────────────────────
  const BR_Y       = 318;
  const BR_H       = 22;
  const BR_GAP     = 5;
  const BR_BAR_W   = Math.floor(RCW * 0.42);
  const BR_LABEL_W = 52;
  const BR_BAR_X   = RCX + BR_LABEL_W;

  const BR_LABEL_COL = 58; // fixed label column width for alignment
  const BR_BAR_X2    = RCX + BR_LABEL_COL;
  const BR_BAR_W2    = Math.floor(RCW * 0.42);
  const BR_ROW_H     = 18;
  const BR_ROW_GAP   = 3;

  let bracketsSvg = '';
  if (levelBrackets.length > 0) {
    bracketsSvg += `
      <line x1="${RCX}" y1="${BR_Y - 10}" x2="${RCR}" y2="${BR_Y - 10}"
            stroke="rgba(255,255,255,0.06)" stroke-width="1"/>
      <text x="${RCX}" y="${BR_Y + 3}"
            fill="#4a4d5e" font-size="10" font-family="DejaVu Sans"
            letter-spacing="1">LEVEL BRACKETS</text>`;

    levelBrackets.forEach((br, i) => {
      const rowY     = BR_Y + 14 + i * (BR_ROW_H + BR_ROW_GAP);
      const fill     = Math.round((br.survivorPct / 100) * BR_BAR_W2);
      const pctColor = br.survivorPct >= 55 ? '#57F287' : br.survivorPct <= 45 ? '#ED4245' : '#FEE75C';
      const lowSample = br.total < 20 ? ' ⚠' : '';

      bracketsSvg += `
        <text x="${RCX}" y="${rowY + 13}"
              fill="#8b8fa8" font-size="11" font-family="DejaVu Sans">${escapeXml(br.label)}</text>
        <rect x="${BR_BAR_X2}" y="${rowY + 4}" width="${BR_BAR_W2}" height="7" rx="3"
              fill="rgba(255,255,255,0.06)"/>
        <rect x="${BR_BAR_X2}" y="${rowY + 4}" width="${fill}" height="7" rx="3"
              fill="${pctColor}" opacity="0.75"/>
        <text x="${BR_BAR_X2 + BR_BAR_W2 + 10}" y="${rowY + 13}"
              fill="${pctColor}" font-size="12" font-weight="bold"
              font-family="DejaVu Sans">${br.survivorPct}%</text>
        <text x="${RCR}" y="${rowY + 13}"
              fill="#4a4d5e" font-size="10" font-family="DejaVu Sans"
              text-anchor="end">${br.total}r${lowSample}</text>`;
    });
  }

  // ── Footer ────────────────────────────────────────────────────────────
  const ftY = FOOTER_Y + 26;
  const footerLeft = lookback
    ? `<text x="${RCX}" y="${ftY}" fill="#72767d" font-size="13" font-family="DejaVu Sans">Lookback: ${escapeXml(lookback)} — UTC</text>`
    : '';
  const footerRight = `
    <rect x="${CARD_W - 118}" y="${FOOTER_Y + 10}" width="28" height="20" rx="5" fill="#5865F2"/>
    <text x="${CARD_W - 104}" y="${FOOTER_Y + 24}" fill="white" font-size="11" font-weight="bold"
          font-family="DejaVu Sans" text-anchor="middle">PG</text>
    <text x="${CARD_W - 84}" y="${ftY}" fill="#72767d" font-size="13"
          font-family="DejaVu Sans">PrimalGame</text>`;

  // ── SVG ───────────────────────────────────────────────────────────────
  const cardSvg = `
<svg width="${CARD_W}" height="${CARD_H}" xmlns="http://www.w3.org/2000/svg">
  <rect width="${LEFT_W}" height="${FOOTER_Y}" fill="#111214"/>
  <line x1="${LEFT_W}" y1="0" x2="${LEFT_W}" y2="${FOOTER_Y}"
        stroke="rgba(255,255,255,0.06)" stroke-width="1"/>
  <rect x="${RIGHT_X}" width="${RCW + RP * 2}" height="${FOOTER_Y}" fill="#15171a"/>
  <rect y="${FOOTER_Y}" width="${CARD_W}" height="${FOOTER_H}" fill="#0e0f11"/>
  <line x1="0" y1="${FOOTER_Y}" x2="${CARD_W}" y2="${FOOTER_Y}"
        stroke="rgba(255,255,255,0.07)" stroke-width="1"/>

  ${leftContent}

  <!-- Header -->
  <text x="${RCX}" y="30" fill="#4a4d5e" font-size="10" font-family="DejaVu Sans"
        letter-spacing="1">${escapeXml(catLabel)} WIN RATE</text>
  <text x="${RCX}" y="64" fill="#e8e9eb" font-size="26" font-weight="bold"
        font-family="DejaVu Sans">${escapeXml(itemName)}</text>
  <text x="${RCX}" y="86" fill="#72767d" font-size="13"
        font-family="DejaVu Sans">${escapeXml(rounds.toLocaleString())} rounds · ${escapeXml(lookback)}</text>
  <line x1="${RCX}" y1="98" x2="${RCR}" y2="98"
        stroke="rgba(255,255,255,0.07)" stroke-width="1"/>

  <!-- Big win rate numbers -->
  <text x="${RCX}" y="148" fill="#57F287" font-size="10" font-family="DejaVu Sans"
        letter-spacing="1">SURVIVOR WIN</text>
  <text x="${RCX}" y="198" fill="#57F287" font-size="52" font-weight="bold"
        font-family="DejaVu Sans">${survivorPct}%</text>

  <text x="${RCR}" y="148" fill="#ED4245" font-size="10" font-family="DejaVu Sans"
        letter-spacing="1" text-anchor="end">DINO WIN</text>
  <text x="${RCR}" y="198" fill="#ED4245" font-size="52" font-weight="bold"
        font-family="DejaVu Sans" text-anchor="end">${dinoPct}%</text>

  <!-- Split bar -->
  <rect x="${RCX}" y="${BAR_Y}" width="${RCW}" height="${BAR_H}" rx="6"
        fill="rgba(255,255,255,0.06)"/>
  ${sBarW > 0 ? `<rect x="${RCX}" y="${BAR_Y}" width="${sBarW}" height="${BAR_H}" rx="6" fill="#57F287" opacity="0.8"/>` : ''}
  ${dBarW > 0 ? `<rect x="${RCX + sBarW}" y="${BAR_Y}" width="${dBarW}" height="${BAR_H}" rx="6" fill="#ED4245" opacity="0.8"/>` : ''}

  <!-- Info row -->
  <line x1="${RCX}" y1="${INFO_LABEL_Y - 12}" x2="${RCR}" y2="${INFO_LABEL_Y - 12}"
        stroke="rgba(255,255,255,0.06)" stroke-width="1"/>

  <text x="${RCX}" y="${INFO_LABEL_Y}" fill="#4a4d5e" font-size="10"
        font-family="DejaVu Sans" letter-spacing="1">BEST MAP</text>
  <text x="${RCX}" y="${INFO_VAL_Y}" fill="#e8e9eb" font-size="18" font-weight="bold"
        font-family="DejaVu Sans">${escapeXml(bestMapStr)}</text>
  <text x="${RCX}" y="${INFO_SUB_Y}" fill="#72767d" font-size="11"
        font-family="DejaVu Sans">${escapeXml(bestMapSub)}</text>

  <line x1="${RCX + COL_W - 14}" y1="${INFO_LABEL_Y - 6}" x2="${RCX + COL_W - 14}" y2="${INFO_SUB_Y}"
        stroke="rgba(255,255,255,0.06)" stroke-width="1"/>

  <text x="${RCX + COL_W}" y="${INFO_LABEL_Y}" fill="#4a4d5e" font-size="10"
        font-family="DejaVu Sans" letter-spacing="1">${escapeXml(coLabel)}</text>
  <text x="${RCX + COL_W}" y="${INFO_VAL_Y}" fill="#e8e9eb" font-size="18" font-weight="bold"
        font-family="DejaVu Sans">${escapeXml(coItemStr)}</text>
  <text x="${RCX + COL_W}" y="${INFO_SUB_Y}" fill="#72767d" font-size="11"
        font-family="DejaVu Sans">${escapeXml(coItemSub)}</text>

  <line x1="${RCX + COL_W * 2 - 14}" y1="${INFO_LABEL_Y - 6}" x2="${RCX + COL_W * 2 - 14}" y2="${INFO_SUB_Y}"
        stroke="rgba(255,255,255,0.06)" stroke-width="1"/>

  <text x="${RCX + COL_W * 2}" y="${INFO_LABEL_Y}" fill="#4a4d5e" font-size="10"
        font-family="DejaVu Sans" letter-spacing="1">ALL-TIME BASELINE</text>
  <text x="${RCX + COL_W * 2}" y="${INFO_VAL_Y}" fill="#e8e9eb" font-size="18" font-weight="bold"
        font-family="DejaVu Sans">${escapeXml(baseStr)}</text>
  <text x="${RCX + COL_W * 2}" y="${INFO_SUB_Y}" fill="#72767d" font-size="11"
        font-family="DejaVu Sans">${escapeXml(baseSub)}</text>

  ${bracketsSvg}
  ${footerLeft}
  ${footerRight}
</svg>`;

  const composites = [];
  if (imgComposite) composites.push(imgComposite);

  const flat = composites.length > 0
    ? await sharp(Buffer.from(cardSvg)).composite(composites).png().toBuffer()
    : await sharp(Buffer.from(cardSvg)).png().toBuffer();

  const maskBuffer = await sharp(Buffer.from(`
<svg width="${CARD_W}" height="${CARD_H}" xmlns="http://www.w3.org/2000/svg">
  <rect width="${CARD_W}" height="${CARD_H}" rx="${CORNER_R}" ry="${CORNER_R}" fill="white"/>
</svg>`)).png().toBuffer();

  return sharp(flat).composite([{ input: maskBuffer, blend: 'dest-in' }]).png().toBuffer();
}

module.exports = { buildLineChartImage, buildDualAxisChartImage, buildChartCard, buildStatCard, buildPieCard, buildTierListCard, buildWinRateDashboard, buildWinRateCard, bucketRoundsByMap, PALETTE, MAP_COLORS };