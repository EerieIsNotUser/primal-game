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
  'Primal Park': '#7ED957',   // lighter green
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
    const linePath = smoothPath(points);
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

    const panelIcon = panel.title.toLowerCase().includes('won') ? '▲'
      : panel.title.toLowerCase().includes('lost') ? '▼'
      : panel.title.toLowerCase().includes('map') ? '◎'
      : panel.title.toLowerCase().includes('dino') ? '◈'
      : null;

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
      // Split "Name (Nx)" into name + count sub-line if pattern matches
      const heroMatch = panel.lines[0].match(/^(.+?)\s+\((\d+.+?)\)$/);
      if (heroMatch) {
        const heroName  = heroMatch[1];
        const heroCount = `(${heroMatch[2]})`;
        const centerY   = py + Math.floor(PANEL_H / 2);
        panelsSvg += `
          <text x="${textStartX}" y="${centerY + 4}"
                fill="#e8e9eb" font-size="24" font-weight="bold"
                font-family="DejaVu Sans">${escapeXml(heroName)}</text>
          <text x="${textStartX}" y="${centerY + 24}"
                fill="#72767d" font-size="14"
                font-family="DejaVu Sans">${escapeXml(heroCount)}</text>`;
      } else {
        panelsSvg += `
          <text x="${textStartX}" y="${py + Math.floor(PANEL_H / 2) + 16}"
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

module.exports = { buildLineChartImage, buildDualAxisChartImage, buildChartCard, buildStatCard, buildPieCard, bucketRoundsByMap, PALETTE, MAP_COLORS };