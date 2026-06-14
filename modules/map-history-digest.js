// ─── Weekly map-history digest ─────────────────────────────────────────────
// Posts a short, natural-language summary of map popularity to #map-history
// once a week, followed by a per-map item breakdown embed.
// Schedule persists across restarts via the scheduled_posts table.

const { EmbedBuilder } = require('discord.js');

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

// Per-map most/least used dino, vehicle, weapon for the past week, non-pro servers.
async function getPerMapItemBreakdown(supabase) {
  const cutoff = new Date(Date.now() - WEEK_MS);

  const { data, error } = await supabase
    .from('round_players')
    .select('dino, weapon, vehicle, pickups, round_logs!inner(map, played_at, server_type)')
    .gte('round_logs.played_at', cutoff.toISOString())
    .neq('round_logs.server_type', 'pro');

  if (error || !data) return null;

  // mapName -> { dino: Map, weapon: Map, vehicle: Map, pickup: Map }
  const perMap = new Map();
  for (const row of data) {
    const map = row.round_logs?.map;
    if (!map) continue;
    if (!perMap.has(map)) {
      perMap.set(map, { dino: new Map(), weapon: new Map(), vehicle: new Map(), pickup: new Map() });
    }
    const entry = perMap.get(map);
    for (const [field, val] of [['dino', row.dino], ['weapon', row.weapon], ['vehicle', row.vehicle]]) {
      if (!val) continue;
      entry[field].set(val, (entry[field].get(val) || 0) + 1);
    }
    // pickups is an array - each item counted individually.
    if (Array.isArray(row.pickups)) {
      for (const item of row.pickups) {
        if (!item) continue;
        entry.pickup.set(item, (entry.pickup.get(item) || 0) + 1);
      }
    }
  }

  return perMap;
}

function mostAndLeast(countMap) {
  if (countMap.size === 0) return { most: null, least: null };
  const sorted = [...countMap.entries()].sort((a, b) => b[1] - a[1]);
  return { most: sorted[0], least: sorted[sorted.length - 1] };
}

function buildBreakdownEmbeds(perMap, mapOrder, EmbedBuilder) {
  if (!perMap || perMap.size === 0) {
    return [new EmbedBuilder()
      .setColor(0x2b2d31)
      .setTitle('🔍 Per-Map Breakdown — Past Week')
      .setDescription('No per-map item data to break down this week.')];
  }

  // Order maps the same way as the main digest (by round count), falling
  // back to whatever order perMap has for any maps not in mapOrder.
  const ordered = [...mapOrder.filter(m => perMap.has(m))];
  for (const m of perMap.keys()) {
    if (!ordered.includes(m)) ordered.push(m);
  }

  const embed = new EmbedBuilder()
    .setColor(0x2b2d31)
    .setTitle('🔍 Per-Map Breakdown — Past Week')
    .setFooter({ text: 'PrimalGame · non-pro servers · most/least used per category' })
    .setTimestamp();

  for (const map of ordered) {
    const counts = perMap.get(map);
    const dino = mostAndLeast(counts.dino);
    const weapon = mostAndLeast(counts.weapon);
    const vehicle = mostAndLeast(counts.vehicle);
    const pickup = mostAndLeast(counts.pickup);

    const fmt = (label, mAndL) => {
      if (!mAndL.most) return `${label}: no data`;
      const mostStr = `${mAndL.most[0]} (${mAndL.most[1]})`;
      if (mAndL.most[0] === mAndL.least[0]) return `${label}: ${mostStr} only`;
      const leastStr = `${mAndL.least[0]} (${mAndL.least[1]})`;
      return `${label}: most ${mostStr} · least ${leastStr}`;
    };

    embed.addFields({
      name: map,
      value: [fmt('Dino', dino), fmt('Vehicle', vehicle), fmt('Weapon', weapon), fmt('Pickup', pickup)].join('\n'),
      inline: false,
    });
  }

  return [embed];
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

    const perMap = await getPerMapItemBreakdown(supabase);
    const mapOrder = current.ranked.map(([map]) => map);
    const breakdownEmbeds = buildBreakdownEmbeds(perMap, mapOrder, EmbedBuilder);
    await channel.send({ embeds: breakdownEmbeds }).catch(err => console.error('[map-history-digest] Failed to post breakdown:', err.message));

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
module.exports.buildBreakdownEmbeds = buildBreakdownEmbeds;