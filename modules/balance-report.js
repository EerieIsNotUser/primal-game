// ─── Balance Council Weekly Report ──────────────────────────────────────
// Auto-posts weekly to channel 1515751121560272987, and is also pullable
// on demand via /balancereport. Built strictly from KKG's confirmed
// Logger.Send("RoundResult", {...}) payload — no dino-specific breakdowns
// since no dino identity/win-loss exists in this payload.

const { EmbedBuilder, SlashCommandBuilder } = require('discord.js');

const REPORT_CHANNEL_ID = '1515751121560272987';
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const POST_ID = 'balance-council-weekly';

async function getWeeklyRows(supabase) {
  const cutoff = new Date(Date.now() - WEEK_MS);
  const { data, error } = await supabase
    .from('round_logs')
    .select('map, round_result, mvp_equipped_vehicle, mvp_equipped_weapon, mvp_damage, num_players_with_medkits, num_players_with_toolkits, num_players_with_fuelcans, num_players_with_dinotrackers, num_players_with_mines, num_players_with_gamepass_weapons, number_of_players, game_mode')
    .gte('played_at', cutoff.toISOString());

  if (error || !data) return null;
  return data;
}

function rankBy(rows, field, mapFilter = null) {
  const counts = new Map();
  for (const row of rows) {
    if (mapFilter && row.map !== mapFilter) continue;
    const val = row[field];
    if (!val) continue;
    counts.set(val, (counts.get(val) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}

function topN(ranks, n = 3) {
  return ranks.slice(0, n);
}

const BAR_LENGTH = 12;
function makeBar(value, max) {
  const filled = max > 0 ? Math.round((value / max) * BAR_LENGTH) : 0;
  return '█'.repeat(Math.max(0, filled)) + '░'.repeat(BAR_LENGTH - Math.max(0, filled));
}

// ── Embed 1: MVP Weapon/Vehicle tier lists (overall, all maps) ──────────
function buildMvpTierEmbed(rows) {
  const weaponRanks = topN(rankBy(rows, 'mvp_equipped_weapon'), 5);
  const vehicleRanks = topN(rankBy(rows, 'mvp_equipped_vehicle'), 5);

  const embed = new EmbedBuilder()
    .setColor(0x5865F2)
    .setTitle('🏆 MVP Tier Lists — This Week')
    .setFooter({ text: 'Balance Council Report · All maps, all servers' })
    .setTimestamp();

  for (const [label, ranks, emoji] of [['Weapons', weaponRanks, '🔫'], ['Vehicles', vehicleRanks, '🚗']]) {
    if (ranks.length === 0) {
      embed.addFields({ name: `${emoji} ${label}`, value: 'No data this week.', inline: false });
      continue;
    }
    const max = ranks[0][1];
    const lines = ranks.map(([name, count]) => `\`${makeBar(count, max)}\` ${name} (MVP ${count}x)`);
    embed.addFields({ name: `${emoji} ${label}`, value: lines.join('\n'), inline: false });
  }

  return embed;
}

// ── Embed 2: MVP weapon/vehicle breakdown PER MAP ────────────────────────
function buildPerMapMvpEmbed(rows) {
  const maps = [...new Set(rows.map(r => r.map).filter(Boolean))];

  const embed = new EmbedBuilder()
    .setColor(0x57F287)
    .setTitle('🗺️ MVP Breakdown by Map — This Week')
    .setFooter({ text: 'Balance Council Report · top weapon/vehicle MVP per map' })
    .setTimestamp();

  if (maps.length === 0) {
    embed.setDescription('No round data this week.');
    return embed;
  }

  for (const map of maps) {
    const weaponTop = topN(rankBy(rows, 'mvp_equipped_weapon', map), 1)[0];
    const vehicleTop = topN(rankBy(rows, 'mvp_equipped_vehicle', map), 1)[0];
    const roundCount = rows.filter(r => r.map === map).length;

    embed.addFields({
      name: `${map} (${roundCount} rounds)`,
      value:
        `🔫 Top Weapon MVP: ${weaponTop ? `${weaponTop[0]} (${weaponTop[1]}x)` : 'No data'}\n` +
        `🚗 Top Vehicle MVP: ${vehicleTop ? `${vehicleTop[0]} (${vehicleTop[1]}x)` : 'No data'}`,
      inline: false,
    });
  }

  return embed;
}

// ── Embed 3: Item adoption + round result split ──────────────────────────
function buildAdoptionAndResultEmbed(rows) {
  if (rows.length === 0) {
    return new EmbedBuilder()
      .setColor(0xFEE75C)
      .setTitle('🎒 Item Adoption & Round Results — This Week')
      .setDescription('No round data this week.')
      .setFooter({ text: 'Balance Council Report' });
  }

  let totals = { medkits: 0, toolkits: 0, fuelcans: 0, dinotrackers: 0, mines: 0, gamepassWeapons: 0 };
  let totalPlayers = 0;
  const resultCounts = new Map();

  for (const row of rows) {
    totals.medkits += row.num_players_with_medkits || 0;
    totals.toolkits += row.num_players_with_toolkits || 0;
    totals.fuelcans += row.num_players_with_fuelcans || 0;
    totals.dinotrackers += row.num_players_with_dinotrackers || 0;
    totals.mines += row.num_players_with_mines || 0;
    totals.gamepassWeapons += row.num_players_with_gamepass_weapons || 0;
    totalPlayers += row.number_of_players || 0;

    if (row.round_result) {
      resultCounts.set(row.round_result, (resultCounts.get(row.round_result) || 0) + 1);
    }
  }

  const pct = (val) => totalPlayers > 0 ? ((val / totalPlayers) * 100).toFixed(1) : '0.0';

  const adoptionLines = [
    `🩹 Med Kits: **${pct(totals.medkits)}%**`,
    `🔧 Toolkits: **${pct(totals.toolkits)}%**`,
    `⛽ Fuel Cans: **${pct(totals.fuelcans)}%**`,
    `📡 Dino Trackers: **${pct(totals.dinotrackers)}%**`,
    `💣 Mines: **${pct(totals.mines)}%**`,
    `💎 Gamepass Weapons: **${pct(totals.gamepassWeapons)}%**`,
  ];

  const resultLines = [...resultCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([result, count]) => {
      const resultPct = ((count / rows.length) * 100).toFixed(1);
      return `${result}: **${resultPct}%** (${count} rounds)`;
    });

  return new EmbedBuilder()
    .setColor(0xFEE75C)
    .setTitle('🎒 Item Adoption & Round Results — This Week')
    .addFields(
      { name: 'Item Adoption Rate (% of total players)', value: adoptionLines.join('\n'), inline: false },
      { name: 'Round Result Split', value: resultLines.length ? resultLines.join('\n') : 'No result data.', inline: false },
    )
    .setFooter({ text: `Balance Council Report · ${rows.length} rounds, ${totalPlayers} total players` })
    .setTimestamp();
}

async function postReport(channel, supabase) {
  const rows = await getWeeklyRows(supabase);
  if (!rows) {
    console.error('[balance-report] Failed to fetch weekly data.');
    return false;
  }

  await channel.send({ embeds: [buildMvpTierEmbed(rows)] }).catch(err => console.error('[balance-report] Failed to post MVP tier:', err.message));
  await channel.send({ embeds: [buildPerMapMvpEmbed(rows)] }).catch(err => console.error('[balance-report] Failed to post per-map:', err.message));
  await channel.send({ embeds: [buildAdoptionAndResultEmbed(rows)] }).catch(err => console.error('[balance-report] Failed to post adoption/result:', err.message));

  return true;
}

function setup(client, { supabase }) {
  if (!supabase) {
    console.log('[balance-report] Skipping setup — supabase not configured.');
    return;
  }

  async function scheduledPost() {
    const channel = client.channels.cache.get(REPORT_CHANNEL_ID)
      ?? await client.channels.fetch(REPORT_CHANNEL_ID).catch(() => null);

    if (!channel) {
      console.error('[balance-report] Could not find report channel', REPORT_CHANNEL_ID);
      return;
    }

    await postReport(channel, supabase);

    await supabase
      .from('scheduled_posts')
      .upsert({ id: POST_ID, last_posted_at: new Date().toISOString() });

    console.log('[balance-report] Posted weekly Balance Council report.');
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
      await scheduledPost();
      setTimeout(scheduleNext, WEEK_MS);
    } else {
      const remaining = WEEK_MS - elapsed;
      setTimeout(async () => {
        await scheduledPost();
        setTimeout(scheduleNext, WEEK_MS);
      }, remaining);
      console.log(`[balance-report] Next post in ${Math.round(remaining / (60 * 60 * 1000))}h.`);
    }
  }

  scheduleNext();
}

module.exports = setup;
module.exports.postReport = postReport;
module.exports.buildMvpTierEmbed = buildMvpTierEmbed;
module.exports.buildPerMapMvpEmbed = buildPerMapMvpEmbed;
module.exports.buildAdoptionAndResultEmbed = buildAdoptionAndResultEmbed;
module.exports.getWeeklyRows = getWeeklyRows;