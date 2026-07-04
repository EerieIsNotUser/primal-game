const {
  SlashCommandBuilder,
  AttachmentBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
} = require('discord.js');
const { buildLineChartImage, buildDualAxisChartImage, buildChartCard, bucketRoundsByMap, MAP_COLORS } = require('../modules/chart');

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

const WIN_RATE_DAYS = [
  { label: 'Past 7 Days',  value: '7'  },
  { label: 'Past 14 Days', value: '14' },
  { label: 'Past 30 Days', value: '30' },
  { label: 'Past 90 Days', value: '90' },
];

function buildDaysButtonRow(activeDays) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('mapchart_days_1')
      .setLabel('1d')
      .setStyle(activeDays === 1 ? ButtonStyle.Primary : ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('mapchart_days_7')
      .setLabel('7d')
      .setStyle(activeDays === 7 ? ButtonStyle.Primary : ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('mapchart_days_14')
      .setLabel('14d')
      .setStyle(activeDays === 14 ? ButtonStyle.Primary : ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('mapchart_days_30')
      .setLabel('30d')
      .setStyle(activeDays === 30 ? ButtonStyle.Primary : ButtonStyle.Secondary),
  );
}

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

function buildWinRateDaysSelectRow() {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId('mapchart_range_select')
      .setPlaceholder('Choose a time range')
      .addOptions(WIN_RATE_DAYS.map(r => ({ label: r.label, value: r.value })))
  );
}

// Bucket round_logs rows into daily win-rate values for a single item.
function bucketWinRateByDay(rows, days) {
  const now = Date.now();
  const buckets = [];

  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now - i * 24 * 60 * 60 * 1000);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const label = `${d.getMonth() + 1}/${d.getDate()}`;
    buckets.push({ key, label, wins: 0, total: 0 });
  }

  const bucketMap = new Map(buckets.map(b => [b.key, b]));

  for (const row of rows) {
    const d = new Date(row.played_at);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const bucket = bucketMap.get(key);
    if (!bucket) continue;
    bucket.total++;
    if (row.round_result === 'SurvivorWin') bucket.wins++;
  }

  const labels = buckets.map(b => b.label);
  const data = buckets.map(b => (b.total > 0 ? Math.round((b.wins / b.total) * 100) : 0));
  return { labels, data };
}

// Fetch round_result + map for the past 6 months — used as the baseline
// for detecting "noticeable" popularity shifts in the selected window.
async function getSixMonthBaseline(supabase) {
  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - 6);

  const { data, error } = await supabase
    .from('round_logs')
    .select('map, round_result')
    .gte('played_at', cutoff.toISOString());

  if (error || !data) return null;
  return data;
}

function mapShareOf(rows) {
  const counts = new Map();
  for (const row of rows) {
    if (!row.map) continue;
    counts.set(row.map, (counts.get(row.map) || 0) + 1);
  }
  const total = rows.length;
  const shares = new Map();
  for (const [map, count] of counts) {
    shares.set(map, total > 0 ? count / total : 0);
  }
  return shares;
}

function winRateByMap(rows) {
  const byMap = new Map(); // map -> { dinoWins, survivorWins, total }
  for (const row of rows) {
    if (!row.map) continue;
    if (!byMap.has(row.map)) byMap.set(row.map, { dinoWins: 0, survivorWins: 0, total: 0 });
    const m = byMap.get(row.map);
    m.total++;
    if (row.round_result === 'DinoWin') m.dinoWins++;
    if (row.round_result === 'SurvivorWin') m.survivorWins++;
  }
  return byMap;
}

// Build the narrative message: popularity shifts (vs 6-month baseline) +
// per-map dino/survivor win rates for the selected window.
function buildChartNarrative(selectedRows, baselineRows, mapsShown) {
  const lines = [];

  // Popularity shift detection (only for maps actually shown in the chart)
  if (baselineRows && baselineRows.length > 0) {
    const selectedShare = mapShareOf(selectedRows);
    const baselineShare = mapShareOf(baselineRows);

    const shifts = [];
    for (const map of mapsShown) {
      const sel = (selectedShare.get(map) || 0) * 100;
      const base = (baselineShare.get(map) || 0) * 100;
      const delta = sel - base;
      if (Math.abs(delta) >= 8) { // threshold: 8 percentage points
        shifts.push({ map, delta, sel, base });
      }
    }
    shifts.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));

    if (shifts.length > 0) {
      const shiftLines = shifts.slice(0, 3).map(s =>
        `${s.map} is ${s.delta > 0 ? 'up' : 'down'} ${Math.abs(s.delta).toFixed(0)} pts vs its 6-month average (${s.base.toFixed(0)}% → ${s.sel.toFixed(0)}%)`
      );
      lines.push(`📊 Noticeable shift: ${shiftLines.join('; ')}.`);
    } else {
      lines.push(`📊 No noticeable popularity shift vs the 6-month average.`);
    }
  }

  // Win rate per map (Dino vs Survivor), for the selected window only
  const winRates = winRateByMap(selectedRows);
  const winRateLines = mapsShown
    .filter(map => winRates.has(map))
    .map(map => {
      const w = winRates.get(map);
      const dinoPct = w.total > 0 ? Math.round((w.dinoWins / w.total) * 100) : 0;
      const survivorPct = w.total > 0 ? Math.round((w.survivorWins / w.total) * 100) : 0;
      return `${map}: Dino ${dinoPct}% / Survivor ${survivorPct}%`;
    });

  if (winRateLines.length > 0) {
    lines.push(`⚔️ Win rate: ${winRateLines.join(' · ')}.`);
  }

  return lines.join('\n');
}

async function renderMapPopularity(interaction, supabase, days = 14, mapFilter = null) {
  const endDate   = new Date();
  const startDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const bucketMs  = days <= 1 ? 60 * 60 * 1000 : 24 * 60 * 60 * 1000; // hourly for 1d, daily otherwise

  const { data: rows, error } = await supabase
    .from('round_logs')
    .select('map, played_at, round_result')
    .gte('played_at', startDate.toISOString())
    .lte('played_at', endDate.toISOString())
    .limit(100000);

  if (error) return interaction.editReply('❌ Something went wrong fetching round data.');
  if (!rows || rows.length === 0) return interaction.editReply(`No round data found for the past ${days} days.`);

  const { labels, series } = bucketRoundsByMap(rows, startDate, endDate, bucketMs);
  if (series.length === 0) return interaction.editReply('No map data available to chart.');

  const baselineRows = await getSixMonthBaseline(supabase);

  let chartBuffer;
  let mapsShown;
  let cardTitle;
  if (mapFilter) {
    const mapSeries = series.find(s => s.label.toLowerCase() === mapFilter.toLowerCase());
    if (!mapSeries) return interaction.editReply(`No data found for map "${mapFilter}".`);

    mapsShown = [mapSeries.label];
    const totalPerDay = labels.map((_, i) => series.reduce((sum, s) => sum + (s.data[i] || 0), 0));
    chartBuffer = await buildDualAxisChartImage(
      labels, totalPerDay, 'Total Rounds Played (All Maps)',
      [{ label: mapSeries.label, data: mapSeries.data, color: MAP_COLORS[mapSeries.label] }],
      null
    );
    cardTitle = `${mapSeries.label} — Popularity vs Total Rounds`;
  } else {
    mapsShown = series.map(s => s.label);
    const coloredSeries = series.map(s => ({ ...s, color: MAP_COLORS[s.label] ?? s.color }));
    const totalPerBucket = labels.map((_, i) => series.reduce((sum, s) => sum + (s.data[i] || 0), 0));
    chartBuffer = await buildDualAxisChartImage(
      labels, totalPerBucket, 'Total Rounds',
      coloredSeries,
      null
    );
    cardTitle = 'Map Popularity';
  }

  const buffer = await buildChartCard(chartBuffer, {
    title: cardTitle,
    subtitle: `Primal Pursuit · Past ${days} Days`,
    stats: [
      { label: 'Total Rounds', value: rows.length.toLocaleString(), color: '#5865F2' },
      { label: 'Maps', value: mapsShown.length.toString(), color: '#57F287' },
    ],
    lookback: `Past ${days} Days`,
  });

  const narrative = buildChartNarrative(rows, baselineRows, mapsShown);
  const attachment = new AttachmentBuilder(buffer, { name: 'mapchart.png' });
  const content = narrative
    ? `\`${rows.length} rounds · all servers\`\n${narrative}`
    : `\`${rows.length} rounds · all servers\``;

  return interaction.editReply({ content, files: [attachment], components: [buildDaysButtonRow(days), buildTypeSelectRow()] });
}

async function renderWinRateOverTime(interaction, supabase, category, item, days) {
  if (category === 'dino') {
    return interaction.editReply({
      content: `❌ Dino win rate isn't available yet — no dino tracking exists in the current data. Flagged for KKG.`,
      embeds: [], files: [], components: [buildTypeSelectRow()],
    });
  }

  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const cutoffISO = cutoff.toISOString();

  // Fetch item-specific rows (for win rate line)
  let itemQuery = supabase.from('round_logs').select('round_result, played_at').gte('played_at', cutoffISO);
  itemQuery = category === 'vehicle' ? itemQuery.eq('mvp_equipped_vehicle', item) : itemQuery.eq('mvp_equipped_weapon', item);

  // Fetch all rounds in window (for total volume bars)
  const [{ data: itemRows, error: itemErr }, { data: allRows, error: allErr }] = await Promise.all([
    itemQuery.limit(100000),
    supabase.from('round_logs').select('played_at').gte('played_at', cutoffISO).limit(100000),
  ]);

  if (itemErr || allErr) return interaction.editReply('❌ Something went wrong fetching round data.');
  if (!itemRows || itemRows.length === 0) {
    return interaction.editReply({
      content: `No rounds found for **${item}** in the selected range.`,
      embeds: [], files: [], components: [buildTypeSelectRow()],
    });
  }

  const { labels, data: winRateData } = bucketWinRateByDay(itemRows, days);

  // Bucket all rounds into daily totals for bar series
  const totalByDay = new Array(days).fill(0);
  const startMs = cutoff.getTime();
  for (const row of (allRows ?? [])) {
    const idx = Math.floor((new Date(row.played_at).getTime() - startMs) / (24 * 60 * 60 * 1000));
    if (idx >= 0 && idx < days) totalByDay[idx]++;
  }

  const catLabel = category === 'vehicle' ? 'Vehicle' : 'Weapon';
  const lineColor = category === 'vehicle' ? '#5865F2' : '#ED4245';

  const chartBuffer = await buildDualAxisChartImage(
    labels,
    totalByDay,
    'Total Rounds (All)',
    [{ label: `${item} Surv. Win %`, data: winRateData, color: lineColor }],
    null,
    true
  );

  const buffer = await buildChartCard(chartBuffer, {
    title: `${item} — Win Rate Over Time`,
    subtitle: `Primal Pursuit · ${catLabel} · Past ${days} Days`,
    stats: [
      { label: 'MVP Rounds',   value: itemRows.length.toLocaleString(), color: lineColor   },
      { label: 'Total Rounds', value: (allRows?.length ?? 0).toLocaleString(), color: '#5865F2' },
    ],
    lookback: `Past ${days} Days`,
  });

  const attachment = new AttachmentBuilder(buffer, { name: 'winratechart.png' });
  return interaction.editReply({
    content: `\`${itemRows.length} MVP rounds · MVP-correlation proxy\``,
    files: [attachment],
    components: [buildTypeSelectRow()],
  });
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
    const days = interaction.options.getInteger('days') ?? 7;
    const mapFilter = interaction.options.getString('map');

    await renderMapPopularity(interaction, supabase, days, mapFilter);

    const reply = await interaction.fetchReply();
    setSession(reply.id, { supabase, days, mapFilter, step: 'type' });
  },

  // Component interaction handler — registered separately in bot.js
  async handleComponent(interaction, { supabase }) {
    const session = sessions.get(interaction.message.id) ?? { supabase, days: 14 };

    if (interaction.customId.startsWith('mapchart_days_')) {
      const days = parseInt(interaction.customId.replace('mapchart_days_', ''), 10);
      session.days = days;
      setSession(interaction.message.id, session);
      await interaction.deferUpdate();
      return renderMapPopularity(interaction, supabase, days, session.mapFilter ?? null);
    }

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
      return interaction.update({ content: 'Choose a time range:', embeds: [], files: [], components: [buildWinRateDaysSelectRow()] });
    }

    if (interaction.customId === 'mapchart_range_select') {
      const days = parseInt(interaction.values[0], 10);
      await interaction.deferUpdate();
      return renderWinRateOverTime(interaction, supabase, session.category, session.item, days);
    }
  },
};