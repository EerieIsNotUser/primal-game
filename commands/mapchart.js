const {
  SlashCommandBuilder,
  AttachmentBuilder,
  ActionRowBuilder,
  StringSelectMenuBuilder,
} = require('discord.js');
const { buildLineChartImage, buildDualAxisChartImage, bucketRoundsByMap } = require('../modules/chart');

// ─── /mapchart ───────────────────────────────────────────────────────────
// Two chart types, switchable via dropdown:
//   1. Map Popularity (original behavior) — round counts per map over time
//   2. Win Rate Over Time — a specific dino/vehicle/weapon's win rate
//      trend, bucketed monthly. Requires category + item + month range,
//      selected via follow-up dropdowns after picking this chart type.
//
// Caveat carried over from /winrate: vehicle/weapon "win rate" is an
// MVP-correlation proxy, not true per-item usage win rate. Dino category
// is a placeholder pending KKG (no dino field in current schema).

const VEHICLES = ['ATV', 'Golf Cart', 'Jeep', 'Hypercar', 'Pickup Truck', 'Police Car', 'Pumpkin Wagon', 'Buggy', 'Hybrid', 'Banana Car', 'Go-Kart', 'Bush Car', 'Muscle Car', 'Ambulance', 'Tow Truck', 'MRAP', 'Warthog', 'The Hornet', 'Humvee', 'Cyber-Beast', 'Monster Truck', 'Scrapper', 'Lunar Rover'];
const WEAPONS = ['Pistol', 'Shotgun', 'MP5', 'Light Sniper', 'AR-15', 'AK-47', 'Crossbow', 'Heavy Sniper', 'AR-Dino', 'AR-Uni', 'P90', 'Water Gun', 'Raygun', 'Scar', 'Trike Shotgun', 'Minigun', 'IWS 2000', 'LMG', 'Deagle', 'Railgun', 'Plasma Rifle', 'Flamethrower', 'Tri-Beam', 'Scrapyard Shotgun', 'SPAS-12'];

const MONTH_RANGES = [
  { label: 'Past Month', value: '1' },
  { label: 'Past 3 Months', value: '3' },
  { label: 'Past 6 Months', value: '6' },
  { label: 'Past 12 Months', value: '12' },
];

// In-memory session store for the multi-step component flow, keyed by
// the original interaction's message ID. Cleared after 5 minutes.
const sessions = new Map();
function setSession(messageId, data) {
  sessions.set(messageId, data);
  setTimeout(() => sessions.delete(messageId), 5 * 60 * 1000);
}

function buildTypeSelectRow() {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId('mapchart_type_select')
      .setPlaceholder('Choose a chart type')
      .addOptions(
        { label: 'Map Popularity', value: 'map_popularity', description: 'Round counts per map over time', default: true },
        { label: 'Win Rate Over Time', value: 'win_rate', description: 'A specific item\'s win rate trend' },
      )
  );
}

function buildCategorySelectRow() {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId('mapchart_category_select')
      .setPlaceholder('Choose a category')
      .addOptions(
        { label: 'Vehicle', value: 'vehicle' },
        { label: 'Weapon', value: 'weapon' },
        { label: 'Dino (placeholder — no data yet)', value: 'dino' },
      )
  );
}

function buildItemSelectRow(category) {
  const pool = category === 'vehicle' ? VEHICLES : category === 'weapon' ? WEAPONS : [];
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId('mapchart_item_select')
      .setPlaceholder('Choose an item')
      .addOptions(pool.slice(0, 25).map(name => ({ label: name, value: name })))
  );
}

function buildMonthRangeSelectRow() {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId('mapchart_range_select')
      .setPlaceholder('Choose a time range')
      .addOptions(MONTH_RANGES.map(r => ({ label: r.label, value: r.value })))
  );
}

// Bucket round_logs rows into monthly win-rate values for a single item.
function bucketWinRateByMonth(rows, months) {
  const buckets = new Map(); // "YYYY-MM" -> { wins, total }
  const now = new Date();

  for (let i = months - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    buckets.set(key, { wins: 0, total: 0, label: d.toLocaleDateString('en-US', { month: 'short' }) });
  }

  for (const row of rows) {
    const d = new Date(row.played_at);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    if (!buckets.has(key)) continue;
    const bucket = buckets.get(key);
    bucket.total++;
    if (row.round_result === 'SurvivorWin') bucket.wins++;
  }

  const labels = [...buckets.values()].map(b => b.label);
  const data = [...buckets.values()].map(b => (b.total > 0 ? Math.round((b.wins / b.total) * 100) : 0));
  return { labels, data };
}

async function renderMapPopularity(interaction, supabase, days = 14, mapFilter = null) {
  const endDate = new Date();
  const startDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const { data: rows, error } = await supabase
    .from('round_logs')
    .select('map, played_at')
    .gte('played_at', startDate.toISOString())
    .lte('played_at', endDate.toISOString());

  if (error) return interaction.editReply('❌ Something went wrong fetching round data.');
  if (!rows || rows.length === 0) return interaction.editReply(`No round data found for the past ${days} days.`);

  const { labels, series } = bucketRoundsByMap(rows, startDate, endDate);
  if (series.length === 0) return interaction.editReply('No map data available to chart.');

  let buffer;
  if (mapFilter) {
    // Single map: dual-axis — grey bars = total rounds across ALL maps that
    // day, colored line = this specific map's rounds that day.
    const mapSeries = series.find(s => s.label.toLowerCase() === mapFilter.toLowerCase());
    if (!mapSeries) return interaction.editReply(`No data found for map "${mapFilter}".`);

    const totalPerDay = labels.map((_, i) => series.reduce((sum, s) => sum + (s.data[i] || 0), 0));
    buffer = await buildDualAxisChartImage(
      labels, totalPerDay, 'Total Rounds Played (All Maps)',
      mapSeries.data, `${mapSeries.label} Popularity`,
      '#5865F2', `${mapSeries.label} — Map Popularity vs Total Rounds`
    );
  } else {
    buffer = await buildLineChartImage(labels, series, `Map Popularity — Past ${days} Days`);
  }

  const attachment = new AttachmentBuilder(buffer, { name: 'mapchart.png' });
  return interaction.editReply({ content: `\`${rows.length} rounds · all servers\``, files: [attachment], components: [buildTypeSelectRow()] });
}

async function renderWinRateOverTime(interaction, supabase, category, item, months) {
  if (category === 'dino') {
    return interaction.editReply({
      content: `❌ Dino win rate isn't available yet — no dino tracking exists in the current data. Flagged for KKG.`,
      embeds: [], files: [], components: [buildTypeSelectRow()],
    });
  }

  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - months);

  let query = supabase.from('round_logs').select('round_result, played_at').gte('played_at', cutoff.toISOString());
  query = category === 'vehicle' ? query.eq('mvp_equipped_vehicle', item) : query.eq('mvp_equipped_weapon', item);

  const { data: rows, error } = await query;
  if (error) return interaction.editReply('❌ Something went wrong fetching round data.');
  if (!rows || rows.length === 0) {
    return interaction.editReply({
      content: `No rounds found for **${item}** in the selected range.`,
      embeds: [], files: [], components: [buildTypeSelectRow()],
    });
  }

  const { labels, data } = bucketWinRateByMonth(rows, months);
  const buffer = await buildLineChartImage(labels, [{ label: `${item} Win Rate`, data }], `${item} — Win Rate Over Time`);
  const attachment = new AttachmentBuilder(buffer, { name: 'winratechart.png' });

  return interaction.editReply({ content: `\`${rows.length} rounds · MVP-correlation proxy\``, files: [attachment], components: [buildTypeSelectRow()] });
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('mapchart')
    .setDescription('View map popularity or item win rate charts')
    .addIntegerOption(opt =>
      opt.setName('days')
        .setDescription('Days to look back for Map Popularity view (default 14)')
        .setMinValue(1)
        .setMaxValue(90)
        .setRequired(false)
    )
    .addStringOption(opt =>
      opt.setName('map')
        .setDescription('Single map — shows dual-axis chart vs total rounds (default: all maps overlaid)')
        .setRequired(false)
    ),

  async execute(interaction, { supabase }) {
    await interaction.deferReply();
    const days = interaction.options.getInteger('days') ?? 14;
    const mapFilter = interaction.options.getString('map');

    await renderMapPopularity(interaction, supabase, days, mapFilter);

    const reply = await interaction.fetchReply();
    setSession(reply.id, { supabase, days, mapFilter, step: 'type' });
  },

  // Component interaction handler — registered separately in bot.js
  async handleComponent(interaction, { supabase }) {
    const session = sessions.get(interaction.message.id) ?? { supabase, days: 14 };

    if (interaction.customId === 'mapchart_type_select') {
      const type = interaction.values[0];
      if (type === 'map_popularity') {
        await interaction.deferUpdate();
        return renderMapPopularity(interaction, supabase, session.days, session.mapFilter);
      }
      // win_rate selected — show category picker next
      session.step = 'category';
      setSession(interaction.message.id, session);
      return interaction.update({ content: 'Choose a category:', embeds: [], files: [], components: [buildCategorySelectRow()] });
    }

    if (interaction.customId === 'mapchart_category_select') {
      const category = interaction.values[0];
      session.category = category;
      session.step = 'item';
      setSession(interaction.message.id, session);

      if (category === 'dino') {
        return interaction.update({
          content: `❌ Dino win rate isn't available yet — no dino tracking exists in the current data.`,
          embeds: [], files: [], components: [buildTypeSelectRow()],
        });
      }

      return interaction.update({ content: 'Choose an item:', embeds: [], files: [], components: [buildItemSelectRow(category)] });
    }

    if (interaction.customId === 'mapchart_item_select') {
      session.item = interaction.values[0];
      session.step = 'range';
      setSession(interaction.message.id, session);
      return interaction.update({ content: 'Choose a time range:', embeds: [], files: [], components: [buildMonthRangeSelectRow()] });
    }

    if (interaction.customId === 'mapchart_range_select') {
      const months = parseInt(interaction.values[0], 10);
      await interaction.deferUpdate();
      return renderWinRateOverTime(interaction, supabase, session.category, session.item, months);
    }
  },
};