// ─── Weekly map-history digest (v2 — rebuilt for round-level schema) ───────
// Posts a weekly summary to #map-history using only round-level data:
// map popularity, round_result split, item adoption rates, MVP frequency.
// No per-player data exists in this schema — this is intentionally aggregate-only.

const { EmbedBuilder } = require('discord.js');

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const POST_ID = 'map-history-weekly';
const CHANNEL_ID = process.env.MAP_HISTORY_CHANNEL_ID;

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

async function getWeeklyRounds(supabase) {
  const cutoff = new Date(Date.now() - WEEK_MS);

  const { data, error } = await supabase
    .from('round_logs')
    .select('map, round_result, num_players_with_medkits, num_players_with_toolkits, num_players_with_fuelcans, num_players_with_dinotrackers, num_players_with_mines, num_players_with_gamepass_weapons, number_of_players, mvp_equipped_vehicle, mvp_equipped_weapon')
    .gte('played_at', cutoff.toISOString());

  if (error || !data) return null;
  return data;
}

async function getPriorWeekMapCounts(supabase) {
  const now = Date.now();
  const start = new Date(now - 2 * WEEK_MS);
  const end = new Date(now - WEEK_MS);

  const { data, error } = await supabase
    .from('round_logs')
    .select('map')
    .gte('played_at', start.toISOString())
    .lt('played_at', end.toISOString());

  if (error || !data) return null;

  const counts = new Map();
  for (const row of data) {
    if (!row.map) continue;
    counts.set(row.map, (counts.get(row.map) || 0) + 1);
  }
  return counts;
}

function rankByField(rows, field) {
  const counts = new Map();
  for (const row of rows) {
    const val = row[field];
    if (!val) continue;
    counts.set(val, (counts.get(val) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}

const BAR_LENGTH = 14;

function makeBar(value, max) {
  const filled = max > 0 ? Math.round((value / max) * BAR_LENGTH) : 0;
  return '█'.repeat(Math.max(0, filled)) + '░'.repeat(BAR_LENGTH - Math.max(0, filled));
}

function topN(countList, n = 3) {
  return countList.slice(0, n);
}

// Build embed with MVP weapon/vehicle frequency this week
function buildMvpEmbed(rows) {
  const embed = new EmbedBuilder()
    .setColor(0x5865F2)
    .setTitle('🏆 MVP Frequency This Week')
    .setFooter({ text: 'PrimalGame · all servers · top 3 per category' })
    .setTimestamp();

  const weaponRanks = topN(rankByField(rows, 'mvp_equipped_weapon'), 3);
  const vehicleRanks = topN(rankByField(rows, 'mvp_equipped_vehicle'), 3);

  for (const [label, ranks, emoji] of [
    ['Weapons', weaponRanks, '🔫'],
    ['Vehicles', vehicleRanks, '🚗'],
  ]) {
    if (ranks.length === 0) {
      embed.addFields({ name: `${emoji} ${label}`, value: 'No MVP data this week.', inline: false });
      continue;
    }
    const max = ranks[0][1];
    const lines = ranks.map(([name, count]) => `\`${makeBar(count, max)}\` ${name} (MVP ${count}x)`);
    embed.addFields({ name: `${emoji} ${label}`, value: lines.join('\n'), inline: false });
  }

  return embed;
}

// Build item adoption rate embed — % of average players per round bringing each item
function buildItemAdoptionEmbed(rows) {
  if (rows.length === 0) {
    return new EmbedBuilder()
      .setColor(0x57F287)
      .setTitle('🎒 Item Adoption This Week')
      .setDescription('No rounds logged this week.')
      .setFooter({ text: 'PrimalGame' });
  }

  const totals = {
    medkits: 0, toolkits: 0, fuelcans: 0, dinotrackers: 0, mines: 0, gamepassWeapons: 0,
  };
  let totalPlayers = 0;

  for (const row of rows) {
    totals.medkits += row.num_players_with_medkits || 0;
    totals.toolkits += row.num_players_with_toolkits || 0;
    totals.fuelcans += row.num_players_with_fuelcans || 0;
    totals.dinotrackers += row.num_players_with_dinotrackers || 0;
    totals.mines += row.num_players_with_mines || 0;
    totals.gamepassWeapons += row.num_players_with_gamepass_weapons || 0;
    totalPlayers += row.number_of_players || 0;
  }

  const pct = (val) => totalPlayers > 0 ? ((val / totalPlayers) * 100).toFixed(1) : '0.0';

  const lines = [
    `🩹 Med Kits: **${pct(totals.medkits)}%** of players`,
    `🔧 Toolkits: **${pct(totals.toolkits)}%** of players`,
    `⛽ Fuel Cans: **${pct(totals.fuelcans)}%** of players`,
    `📡 Dino Trackers: **${pct(totals.dinotrackers)}%** of players`,
    `💣 Mines: **${pct(totals.mines)}%** of players`,
    `💎 Gamepass Weapons: **${pct(totals.gamepassWeapons)}%** of players`,
  ];

  return new EmbedBuilder()
    .setColor(0x57F287)
    .setTitle('🎒 Item Adoption This Week')
    .setDescription(lines.join('\n'))
    .setFooter({ text: 'PrimalGame · % of total players across all rounds' })
    .setTimestamp();
}

function writeDigest(rows, priorMapCounts) {
  if (rows.length === 0) {
    return "Not much to report this week — no rounds logged, so map history is quiet.";
  }

  const mapRanks = topN(rankByField(rows, 'map'), 10);
  const [topMap, topCount] = mapRanks[0];
  const total = rows.length;
  const topPct = ((topCount / total) * 100).toFixed(0);

  const lines = [];
  const openers = [
    `${topMap} was the map of choice this week`,
    `${topMap} took the top spot this week`,
    `${topMap} saw the most action this week`,
  ];
  lines.push(`${pick(openers)}, showing up in ${topCount} of ${total} rounds (about ${topPct}%).`);

  if (mapRanks.length > 1) {
    const [secondMap, secondCount] = mapRanks[1];
    if (topCount - secondCount <= Math.max(2, topCount * 0.15)) {
      lines.push(`${secondMap} wasn't far behind with ${secondCount}.`);
    } else {
      lines.push(`${secondMap} came in second with ${secondCount}, a fair bit back.`);
    }
  }

  if (priorMapCounts && priorMapCounts.size > 0) {
    let biggestMover = null;
    for (const [map, count] of mapRanks) {
      const priorCount = priorMapCounts.get(map) || 0;
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

  const narrative = lines.join(' ');
  const breakdown = mapRanks
    .map(([map, count]) => {
      const pct = Math.round((count / total) * 1000) / 10;
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
    const rows = await getWeeklyRounds(supabase);
    if (!rows) {
      console.error('[map-history-digest] Failed to fetch weekly round data.');
      return;
    }
    const priorMapCounts = await getPriorWeekMapCounts(supabase);

    const text = writeDigest(rows, priorMapCounts);

    const channel = client.channels.cache.get(CHANNEL_ID)
      ?? await client.channels.fetch(CHANNEL_ID).catch(() => null);

    if (!channel) {
      console.error('[map-history-digest] Could not find channel', CHANNEL_ID);
      return;
    }

    await channel.send(text).catch(err => console.error('[map-history-digest] Failed to post:', err.message));

    const itemEmbed = buildItemAdoptionEmbed(rows);
    await channel.send({ embeds: [itemEmbed] }).catch(err => console.error('[map-history-digest] Failed to post item adoption:', err.message));

    const mvpEmbed = buildMvpEmbed(rows);
    await channel.send({ embeds: [mvpEmbed] }).catch(err => console.error('[map-history-digest] Failed to post MVP frequency:', err.message));

    await supabase
      .from('scheduled_posts')
      .upsert({ id: POST_ID, last_posted_at: new Date().toISOString() });

    console.log('[map-history-digest] Posted weekly digest (v2).');
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

module.exports.writeDigest = writeDigest;
module.exports.buildMvpEmbed = buildMvpEmbed;
module.exports.buildItemAdoptionEmbed = buildItemAdoptionEmbed;