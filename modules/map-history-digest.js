// ─── Weekly map-history digest ─────────────────────────────────────────────
// Posts a short, natural-language summary of map popularity to #map-history
// once a week, followed by a per-map item breakdown embed.
// Schedule persists across restarts via the scheduled_posts table.

const { EmbedBuilder } = require('discord.js');
const { buildLineChartUrl, bucketRoundsByMap } = require('./chart');

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const POST_ID = 'map-history-weekly';
const CHANNEL_ID = process.env.MAP_HISTORY_CHANNEL_ID;

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

// Build the per-map round counts for the past week, non-pro servers,
// same logic as /mapvotes with period=week, server_type defaulting to non-pro.
async function getWeeklyMapCounts(supabase) {
  const cutoff = new Date(Date.now() - WEEK_MS);

  const { data, error } = await supabase
    .from('round_logs')
    .select('map')
    .gte('played_at', cutoff.toISOString())
    .neq('server_type', 'pro');

  if (error || !data) return null;

  const counts = new Map();
  for (const row of data) {
    if (!row.map) continue;
    counts.set(row.map, (counts.get(row.map) || 0) + 1);
  }

  const total = data.length;
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  return { ranked, total };
}

// Get last week's counts too, so we can talk about movement.
async function getPriorWeekMapCounts(supabase) {
  const now = Date.now();
  const start = new Date(now - 2 * WEEK_MS);
  const end = new Date(now - WEEK_MS);

  const { data, error } = await supabase
    .from('round_logs')
    .select('map')
    .gte('played_at', start.toISOString())
    .lt('played_at', end.toISOString())
    .neq('server_type', 'pro');

  if (error || !data) return null;

  const counts = new Map();
  for (const row of data) {
    if (!row.map) continue;
    counts.set(row.map, (counts.get(row.map) || 0) + 1);
  }
  return counts;
}

// Overall most-used items across all maps for the past week, non-pro servers.
// Returns { dino: Map, weapon: Map, vehicle: Map, pickup: Map } - counts
// aggregated across every map, not broken down per-map.
async function getOverallItemCounts(supabase) {
  const cutoff = new Date(Date.now() - WEEK_MS);

  const { data, error } = await supabase
    .from('round_players')
    .select('dino, weapon, vehicle, pickups, round_logs!inner(played_at, server_type)')
    .gte('round_logs.played_at', cutoff.toISOString())
    .neq('round_logs.server_type', 'pro');

  if (error || !data) return null;

  const overall = { dino: new Map(), weapon: new Map(), vehicle: new Map(), pickup: new Map() };
  for (const row of data) {
    for (const [field, val] of [['dino', row.dino], ['weapon', row.weapon], ['vehicle', row.vehicle]]) {
      if (!val) continue;
      overall[field].set(val, (overall[field].get(val) || 0) + 1);
    }
    if (Array.isArray(row.pickups)) {
      for (const item of row.pickups) {
        if (!item) continue;
        overall.pickup.set(item, (overall.pickup.get(item) || 0) + 1);
      }
    }
  }

  return overall;
}

const BAR_LENGTH = 14; // characters wide

function topN(countMap, n = 3) {
  return [...countMap.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);
}

function makeBar(value, max) {
  const filled = max > 0 ? Math.round((value / max) * BAR_LENGTH) : 0;
  return '█'.repeat(Math.max(0, filled)) + '░'.repeat(BAR_LENGTH - Math.max(0, filled));
}

const CATEGORY_META = [
  { key: 'dino', emoji: '🦖', label: 'Dinos' },
  { key: 'vehicle', emoji: '🚗', label: 'Vehicles' },
  { key: 'weapon', emoji: '🔫', label: 'Weapons' },
  { key: 'pickup', emoji: '📦', label: 'Pickups' },
];

// Build a single embed with a top-3 bar chart per category, across all maps.
function buildOverallBarsEmbed(overall, EmbedBuilder) {
  const embed = new EmbedBuilder()
    .setColor(0x5865F2)
    .setTitle('📈 This Week Across Primal Pursuit')
    .setFooter({ text: 'PrimalGame · non-pro servers · top 3 per category' })
    .setTimestamp();

  let hasAnyData = false;

  for (const { key, emoji, label } of CATEGORY_META) {
    const counts = overall[key];
    const top = topN(counts, 3);
    if (top.length === 0) {
      embed.addFields({ name: `${emoji} ${label}`, value: 'No data this week.', inline: false });
      continue;
    }
    hasAnyData = true;
    const max = top[0][1];
    const lines = top.map(([name, count]) => `\`${makeBar(count, max)}\` ${name} (${count.toLocaleString('en-US')})`);
    embed.addFields({ name: `${emoji} ${label}`, value: lines.join('\n'), inline: false });
  }

  if (!hasAnyData) {
    embed.setDescription('No item data logged this week.');
  }

  return embed;
}

function writeDigest(current, prior) {
  const { ranked, total } = current;

  if (ranked.length === 0) {
    return "Not much to report this week — no rounds logged on non-pro servers, so map history is quiet.";
  }

  const [topMap, topCount] = ranked[0];
  const topPct = ((topCount / total) * 100).toFixed(0);

  const lines = [];

  // Opening: lead with the top map, vary the phrasing.
  const openers = [
    `${topMap} was the map of choice this week`,
    `${topMap} took the top spot this week`,
    `${topMap} saw the most action this week`,
  ];
  lines.push(`${pick(openers)}, showing up in ${topCount} of ${total} rounds (about ${topPct}%).`);

  // Second place, if there is one and it's reasonably close.
  if (ranked.length > 1) {
    const [secondMap, secondCount] = ranked[1];
    if (topCount - secondCount <= Math.max(2, topCount * 0.15)) {
      lines.push(`${secondMap} wasn't far behind with ${secondCount}.`);
    } else {
      lines.push(`${secondMap} came in second with ${secondCount}, a fair bit back.`);
    }
  }

  // Movement: compare to prior week if we have data.
  if (prior && prior.size > 0) {
    let biggestMover = null;
    for (const [map, count] of ranked) {
      const priorCount = prior.get(map) || 0;
      const diff = count - priorCount;
      if (!biggestMover || Math.abs(diff) > Math.abs(biggestMover.diff)) {
        biggestMover = { map, diff };
      }
    }
    if (biggestMover && biggestMover.diff >= 2) {
      lines.push(`${biggestMover.map} picked up noticeably more plays compared to last week.`);
    } else if (biggestMover && biggestMover.diff <= -2) {
      lines.push(`${biggestMover.map} cooled off a bit compared to last week.`);
    }
  }

  // Quiet maps: anything with very low counts relative to the leader.
  const quiet = ranked.filter(([, count]) => count <= Math.max(1, topCount * 0.05));
  if (quiet.length === 1) {
    lines.push(`${quiet[0][0]} barely got picked this week.`);
  } else if (quiet.length > 1) {
    lines.push(`${quiet.map(([m]) => m).join(' and ')} stayed pretty quiet.`);
  }

  const narrative = lines.join(' ');

  // Full breakdown, percentages summing to 100%.
  const breakdown = ranked
    .map(([map, count]) => {
      const pct = Math.round((count / total) * 1000) / 10; // one decimal
      return `${map}: ${pct}%`;
    })
    .join(', ');

  return `${narrative}\n\nFull split — ${breakdown}.`;
}

module.exports = function setup(client, { supabase }) {
  if (!supabase || !CHANNEL_ID) {
    console.log('[map-history-digest] Skipping setup — supabase or MAP_HISTORY_CHANNEL_ID not configured.');
    return;
  }

  async function postDigest() {
    const current = await getWeeklyMapCounts(supabase);
    if (!current) {
      console.error('[map-history-digest] Failed to fetch current week data.');
      return;
    }
    const prior = await getPriorWeekMapCounts(supabase);

    const text = writeDigest(current, prior);

    const channel = client.channels.cache.get(CHANNEL_ID)
      ?? await client.channels.fetch(CHANNEL_ID).catch(() => null);

    if (!channel) {
      console.error('[map-history-digest] Could not find channel', CHANNEL_ID);
      return;
    }

    await channel.send(text).catch(err => console.error('[map-history-digest] Failed to post:', err.message));

    const overall = await getOverallItemCounts(supabase);
    const barsEmbed = buildOverallBarsEmbed(overall || { dino: new Map(), weapon: new Map(), vehicle: new Map(), pickup: new Map() }, EmbedBuilder);
    await channel.send({ embeds: [barsEmbed] }).catch(err => console.error('[map-history-digest] Failed to post bars:', err.message));

    // Overlaid per-map chart for the past week.
    const { data: weekRows } = await supabase
      .from('round_logs')
      .select('map, played_at')
      .gte('played_at', new Date(Date.now() - WEEK_MS).toISOString())
      .neq('server_type', 'pro');

    if (weekRows && weekRows.length > 0) {
      const { labels, series } = bucketRoundsByMap(weekRows, new Date(Date.now() - WEEK_MS), new Date());
      if (series.length > 0) {
        const chartUrl = buildLineChartUrl(labels, series, 'Map Popularity — Past Week');
        const chartEmbed = new EmbedBuilder().setColor(0x5865F2).setImage(chartUrl);
        await channel.send({ embeds: [chartEmbed] }).catch(err => console.error('[map-history-digest] Failed to post chart:', err.message));
      }
    }

    await supabase
      .from('scheduled_posts')
      .upsert({ id: POST_ID, last_posted_at: new Date().toISOString() });

    console.log('[map-history-digest] Posted weekly digest.');
  }

  async function scheduleNext() {
    const { data } = await supabase
      .from('scheduled_posts')
      .select('last_posted_at')
      .eq('id', POST_ID)
      .maybeSingle();

    const lastPosted = data?.last_posted_at ? new Date(data.last_posted_at).getTime() : 0;
    const elapsed = Date.now() - lastPosted;

    if (elapsed >= WEEK_MS) {
      await postDigest();
      setTimeout(scheduleNext, WEEK_MS);
    } else {
      const remaining = WEEK_MS - elapsed;
      setTimeout(async () => {
        await postDigest();
        setTimeout(scheduleNext, WEEK_MS);
      }, remaining);
      console.log(`[map-history-digest] Next post in ${Math.round(remaining / (60 * 60 * 1000))}h.`);
    }
  }

  scheduleNext();
};

// Expose formatting functions so a test command can generate output using
// the exact same logic, with synthetic data instead of a live query.
module.exports.writeDigest = writeDigest;
module.exports.buildOverallBarsEmbed = buildOverallBarsEmbed;