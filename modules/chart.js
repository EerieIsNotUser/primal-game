// ─── Chart generation ───────────────────────────────────────────────────────
// Builds QuickChart.io URLs for line charts showing map round-counts over
// time, styled to match Statbot's dark/smooth/gradient-fill look.

const QUICKCHART_URL = 'https://quickchart.io/chart';
const QUICKCHART_CREATE_URL = 'https://quickchart.io/chart/create';

// A small palette for overlaying multiple maps on one chart.
const PALETTE = ['#5865F2', '#57F287', '#FEE75C', '#EB459E', '#ED4245', '#9B59B6'];

function hexToRgba(hex, alpha) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

/**
 * Build a chart image URL for one or more time-series lines, styled to match
 * Statbot's dark/smooth/gradient-fill look.
 *
 * Uses QuickChart's /chart/create endpoint to get a short URL, since long
 * configs (multiple series, many data points) can exceed Discord's 2048-char
 * embed image URL limit if passed directly as a query string.
 *
 * @param labels  array of x-axis labels (e.g. dates)
 * @param series  array of { label, data, color? } - color defaults from palette
 * @param title   chart title (top-left, like Statbot)
 * @returns Promise<string> - image URL
 */
async function buildLineChartUrl(labels, series, title) {
  const datasets = series.map((s, i) => {
    const color = s.color || PALETTE[i % PALETTE.length];
    // Lower alpha when there are multiple series, to avoid muddy overlap.
    const fillAlpha = series.length > 1 ? 0.12 : 0.35;
    return {
      label: s.label,
      data: s.data,
      fill: true,
      backgroundColor: hexToRgba(color, fillAlpha),
      borderColor: color,
      borderWidth: 3.5,
      tension: 0.35,
      pointRadius: 0,
      pointHoverRadius: 4,
    };
  });

  const config = {
    type: 'line',
    data: { labels, datasets },
    options: {
      plugins: {
        legend: {
          display: series.length > 1,
          position: 'top',
          align: 'start',
          labels: { color: '#e8e9eb', boxWidth: 18, font: { size: 14 } },
        },
        title: title
          ? { display: true, text: title, color: '#e8e9eb', align: 'start', font: { size: 18, weight: 'bold' } }
          : { display: false },
      },
      scales: {
        x: {
          ticks: { color: '#dcddde', font: { size: 13 } },
          grid: { color: 'rgba(255,255,255,0.07)' },
        },
        y: {
          beginAtZero: true,
          ticks: { color: '#dcddde', precision: 0, font: { size: 13 } },
          grid: { color: 'rgba(255,255,255,0.07)' },
        },
      },
    },
  };

  const body = {
    chart: config,
    backgroundColor: '#2b2d31',
    width: 1200,
    height: 600,
    devicePixelRatio: 2,
  };

  try {
    const res = await fetch(QUICKCHART_CREATE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = await res.json();
    if (json?.success && json?.url) {
      return json.url;
    }
    console.error('[chart] QuickChart create failed, falling back to long URL:', JSON.stringify(json));
  } catch (err) {
    console.error('[chart] QuickChart create request failed, falling back to long URL:', err.message);
  }

  // Fallback: long URL (may exceed Discord's limit for large configs, but
  // works for small/single-series charts if the create endpoint is down).
  const params = new URLSearchParams({
    c: JSON.stringify(config),
    backgroundColor: '#2b2d31',
    width: '1200',
    height: '600',
    devicePixelRatio: '2',
  });
  return `${QUICKCHART_URL}?${params.toString()}`;
}

/**
 * Bucket a list of {played_at, map} rows into per-day (or other interval)
 * counts per map. Returns { labels: [...], series: [{label, data}] }.
 *
 * @param rows       array of { map, played_at }
 * @param startDate  Date - start of the range
 * @param endDate    Date - end of the range
 * @param bucketMs   bucket size in ms (default: 1 day)
 */
function bucketRoundsByMap(rows, startDate, endDate, bucketMs = 24 * 60 * 60 * 1000) {
  const startMs = startDate.getTime();
  const endMs = endDate.getTime();
  const numBuckets = Math.max(1, Math.ceil((endMs - startMs) / bucketMs));

  // map -> array of counts per bucket
  const perMap = new Map();

  for (const row of rows) {
    if (!row.map) continue;
    const ts = new Date(row.played_at).getTime();
    if (ts < startMs || ts >= endMs) continue;
    const idx = Math.min(numBuckets - 1, Math.floor((ts - startMs) / bucketMs));
    if (!perMap.has(row.map)) perMap.set(row.map, new Array(numBuckets).fill(0));
    perMap.get(row.map)[idx]++;
  }

  // Build labels - format depends on bucket size.
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

module.exports = { buildLineChartUrl, bucketRoundsByMap, PALETTE };