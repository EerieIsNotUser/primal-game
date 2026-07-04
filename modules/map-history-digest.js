// ─── Map History Digest ───────────────────────────────────────────────────────
// Posts a map distribution pie card + map popularity line chart to #map-history
// every Sunday at midnight US Eastern time.
//
// Tier priority — highest due tier wins, lower tiers are skipped that week:
//   Yearly    ≥ 365 days since last yearly post  (~52 weeks)
//   Quarterly ≥ 91  days since last quarterly    (~13 weeks)
//   Monthly   ≥ 28  days since last monthly      (~4  weeks)
//   Weekly    always (fallback)
//
// NOTE: Monthly, quarterly, and yearly digests can also be triggered manually
// via a planned /maphistory [period] command. Lower tiers skipped this week
// are NOT lost — they're simply superseded by the higher tier's broader view.

const { AttachmentBuilder } = require('discord.js');
const {
  buildPieCard,
  buildLineChartImage,
  buildChartCard,
  bucketRoundsByMap,
  MAP_COLORS,
} = require('./chart');

const CHANNEL_ID = '1515750144618795208';

const TIERS = [
  { key: 'yearly',    label: 'Yearly',    minDays: 365 },
  { key: 'quarterly', label: 'Quarterly', minDays: 91  },
  { key: 'monthly',   label: 'Monthly',   minDays: 28  },
  { key: 'weekly',    label: 'Weekly',    minDays: 0   },
];

// ── Scheduler ─────────────────────────────────────────────────────────────────
// Returns ms until next Sunday midnight in America/New_York (DST-aware).
function getMsUntilNextSundayMidnightNY() {
  const now = new Date();

  for (let i = 1; i <= 8; i++) {
    const candidate = new Date(now.getTime() + i * 24 * 60 * 60 * 1000);
    const dayInNY = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      weekday: 'short',
    }).format(candidate);

    if (dayInNY !== 'Sun') continue;

    // Detect UTC offset for that date by checking what NY hour noon-UTC maps to
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(candidate);

    const yr  = parts.find(p => p.type === 'year').value;
    const mo  = parts.find(p => p.type === 'month').value;
    const dy  = parts.find(p => p.type === 'day').value;

    const noonUTC   = new Date(`${yr}-${mo}-${dy}T12:00:00Z`);
    const noonNYHr  = parseInt(new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York', hour: 'numeric', hour12: false,
    }).format(noonUTC));
    const offsetHrs = 12 - noonNYHr; // e.g. 4 for EDT, 5 for EST

    const midnightUTC = new Date(`${yr}-${mo}-${dy}T${String(offsetHrs).padStart(2, '0')}:00:00Z`);
    const ms = midnightUTC.getTime() - now.getTime();
    if (ms > 0) return ms;
  }

  return 7 * 24 * 60 * 60 * 1000; // fallback
}

// ── Tier determination ────────────────────────────────────────────────────────
async function determineTier(supabase) {
  const now = Date.now();

  for (const tier of TIERS) {
    if (tier.minDays === 0) return tier; // weekly always qualifies

    const { data } = await supabase
      .from('primalgame_state')
      .select('value')
      .eq('key', `maphistory_${tier.key}_at`)
      .single();

    const lastAt  = data?.value ? new Date(data.value).getTime() : 0;
    const daysSince = (now - lastAt) / (24 * 60 * 60 * 1000);

    if (daysSince >= tier.minDays) return tier;
  }

  return TIERS[TIERS.length - 1]; // weekly fallback
}

// ── Data fetching ─────────────────────────────────────────────────────────────
async function fetchRoundsForPeriod(supabase, days) {
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const { data, error } = await supabase
    .from('round_logs')
    .select('map, round_result, played_at')
    .gte('played_at', cutoff.toISOString())
    .order('played_at', { ascending: true })
    .limit(100000);

  if (error || !data) return null;
  return data;
}

// ── Chart builders ────────────────────────────────────────────────────────────
async function buildDistributionCard(rows, tierLabel, days) {
  const mapCounts = new Map();
  for (const r of rows) {
    if (!r.map) continue;
    mapCounts.set(r.map, (mapCounts.get(r.map) || 0) + 1);
  }

  const segments = [...mapCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([label, value]) => ({ label, value, color: MAP_COLORS[label] }));

  const totalRounds = rows.length;

  const buf = await buildPieCard({
    title:       'Map Distribution',
    subtitle:    `Primal Pursuit · ${tierLabel} Overview`,
    stats: [
      { label: 'Total Rounds', value: totalRounds.toLocaleString(), color: '#5865F2' },
      { label: 'Maps',         value: segments.length.toString(),   color: '#57F287' },
    ],
    lookback:    `Past ${days} Days`,
    segments,
    centerLabel: `${totalRounds.toLocaleString()}\nrounds`,
  });

  return new AttachmentBuilder(buf, { name: 'map-distribution.png' });
}

async function buildPopularityCard(rows, tierLabel, days) {
  const endDate   = new Date();
  const startDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  // Use hourly buckets for weekly, daily for longer periods
  const bucketMs = days <= 7
    ? 60 * 60 * 1000
    : days <= 31
      ? 24 * 60 * 60 * 1000
      : 7 * 24 * 60 * 60 * 1000; // weekly buckets for quarterly/yearly

  const { labels, series } = bucketRoundsByMap(rows, startDate, endDate, bucketMs);
  if (!series.length) return null;

  const coloredSeries = series.map(s => ({ ...s, color: MAP_COLORS[s.label] ?? s.color }));
  const chartBuf = await buildLineChartImage(labels, coloredSeries, null);

  const buf = await buildChartCard(chartBuf, {
    title:    'Map Popularity',
    subtitle: `Primal Pursuit · ${tierLabel} Overview`,
    stats: [
      { label: 'Total Rounds', value: rows.length.toLocaleString(), color: '#5865F2' },
      { label: 'Maps',         value: series.length.toString(),     color: '#57F287' },
    ],
    lookback: `Past ${days} Days`,
  });

  return new AttachmentBuilder(buf, { name: 'map-popularity.png' });
}

// ── Post digest ───────────────────────────────────────────────────────────────
async function postDigest(client, supabase) {
  const tier = await determineTier(supabase);
  const days = tier.minDays || 7;

  const rows = await fetchRoundsForPeriod(supabase, days);
  if (!rows || rows.length === 0) {
    console.log(`[map-history] No rounds found for ${tier.label} digest — skipping.`);
    return;
  }

  const ch = client.channels.cache.get(CHANNEL_ID)
    ?? await client.channels.fetch(CHANNEL_ID).catch(() => null);
  if (!ch) { console.error('[map-history] Could not find channel'); return; }

  const dinoWins     = rows.filter(r => r.round_result === 'DinoWin').length;
  const survivorWins = rows.length - dinoWins;
  const dinoWinPct   = Math.round((dinoWins / rows.length) * 100);

  const startStr = new Date(Date.now() - days * 24 * 60 * 60 * 1000)
    .toLocaleDateString('en-US', { month: 'long', day: 'numeric' });
  const endStr   = new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });

  const header = `**${tier.label} Map History** — ${startStr} to ${endStr}\n` +
    `\`${rows.length} rounds · Dino ${dinoWinPct}% / Survivor ${100 - dinoWinPct}%\``;

  const files = [];

  const pieAttachment = await buildDistributionCard(rows, tier.label, days).catch(() => null);
  if (pieAttachment) files.push(pieAttachment);

  const lineAttachment = await buildPopularityCard(rows, tier.label, days).catch(() => null);
  if (lineAttachment) files.push(lineAttachment);

  await ch.send({ content: header, files }).catch(err =>
    console.error('[map-history] Failed to post:', err.message)
  );

  // Update state for this tier (and weekly, since it's always superseded)
  const toUpdate = ['weekly'];
  if (tier.key !== 'weekly') toUpdate.push(tier.key);

  for (const key of toUpdate) {
    await supabase.from('primalgame_state')
      .upsert({ key: `maphistory_${key}_at`, value: new Date().toISOString() });
  }

  console.log(`[map-history] Posted ${tier.label} digest — ${rows.length} rounds.`);
}

// ── Setup ─────────────────────────────────────────────────────────────────────
module.exports = function setupMapHistory(client, { supabase }) {
  async function scheduleNext() {
    const ms = getMsUntilNextSundayMidnightNY();
    const hrs = Math.round(ms / (60 * 60 * 1000));
    console.log(`[map-history] Next post in ${hrs}h (Sunday midnight ET).`);

    setTimeout(async () => {
      await postDigest(client, supabase);
      scheduleNext();
    }, ms);
  }

  scheduleNext();
};

// Expose for manual trigger via planned /maphistory command
module.exports.postDigest = postDigest;