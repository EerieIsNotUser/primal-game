const {
  SlashCommandBuilder,
  AttachmentBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require('discord.js');
const { buildPieCard, MAP_COLORS } = require('../modules/chart');

// ─── /piechart ────────────────────────────────────────────────────────────
// No map: donut shows round distribution across all maps.
// With map: donut shows DinoWin vs SurvivorWin for that map.
// game_mode filters to Normal/Double Trouble; defaults to all.

const ALL_MAPS = ['Jungle', 'Canyon', 'Cavern', 'Primal Park'];

const sessions = new Map();
function setSession(id, data) {
  sessions.set(id, data);
  setTimeout(() => sessions.delete(id), 5 * 60 * 1000);
}

function buildDaysButtonRow(activeDays) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('piechart_days_1').setLabel('1d').setStyle(activeDays === 1  ? ButtonStyle.Primary : ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('piechart_days_7').setLabel('7d').setStyle(activeDays === 7  ? ButtonStyle.Primary : ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('piechart_days_14').setLabel('14d').setStyle(activeDays === 14 ? ButtonStyle.Primary : ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('piechart_days_30').setLabel('30d').setStyle(activeDays === 30 ? ButtonStyle.Primary : ButtonStyle.Secondary),
  );
}

async function renderPieChart(interaction, supabase, { mapFilter, gameMode, days }) {
  const endDate   = new Date();
  const startDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const modeLabel = gameMode ?? 'All Modes';

  let query = supabase
    .from('round_logs')
    .select('map, round_result, game_mode')
    .gte('played_at', startDate.toISOString())
    .lte('played_at', endDate.toISOString())
    .limit(100000);

  if (gameMode) query = query.eq('game_mode', gameMode);

  const { data: rows, error } = await query;
  if (error) return interaction.editReply('❌ Something went wrong fetching round data.');
  if (!rows || rows.length === 0) return interaction.editReply(`No round data found for the past ${days} days.`);

  let segments, cardTitle, cardStats;

  if (mapFilter) {
    const mapRows = rows.filter(r => r.map === mapFilter);
    if (mapRows.length === 0)
      return interaction.editReply(`No data found for **${mapFilter}** in the past ${days} days.`);

    const dinoWins     = mapRows.filter(r => r.round_result === 'DinoWin').length;
    const survivorWins = mapRows.filter(r => r.round_result === 'SurvivorWin').length;

    segments  = [
      { label: 'Dino Win',     value: dinoWins,     color: '#ED4245' },
      { label: 'Survivor Win', value: survivorWins,  color: '#57F287' },
    ];
    cardTitle = `${mapFilter} — Win Rate`;
    cardStats = [
      { label: 'Total Rounds', value: mapRows.length.toLocaleString(), color: '#5865F2' },
      { label: 'Dino Wins',    value: dinoWins.toLocaleString(),        color: '#ED4245' },
      { label: 'Surv. Wins',   value: survivorWins.toLocaleString(),    color: '#57F287' },
    ];

    const buffer = await buildPieCard({
      title: cardTitle,
      subtitle: `Primal Pursuit · ${modeLabel} · Past ${days} Days`,
      stats: cardStats,
      lookback: `Past ${days} Days`,
      segments,
      centerLabel: `${mapRows.length.toLocaleString()}\nrounds`,
    });

    return interaction.editReply({
      files: [new AttachmentBuilder(buffer, { name: 'piechart.png' })],
      components: [buildDaysButtonRow(days)],
    });
  } else {
    const mapCounts = new Map();
    for (const row of rows) {
      if (!row.map) continue;
      mapCounts.set(row.map, (mapCounts.get(row.map) || 0) + 1);
    }
    segments = [...mapCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([label, value]) => ({ label, value, color: MAP_COLORS[label] }));

    if (segments.length === 0) return interaction.editReply('No map data available.');

    cardTitle = 'Map Distribution';
    cardStats = [
      { label: 'Total Rounds', value: rows.length.toLocaleString(),    color: '#5865F2' },
      { label: 'Maps',         value: segments.length.toString(),       color: '#57F287' },
    ];

    const buffer = await buildPieCard({
      title: cardTitle,
      subtitle: `Primal Pursuit · ${modeLabel} · Past ${days} Days`,
      stats: cardStats,
      lookback: `Past ${days} Days`,
      segments,
      centerLabel: `${rows.length.toLocaleString()}\nrounds`,
    });

    return interaction.editReply({
      files: [new AttachmentBuilder(buffer, { name: 'piechart.png' })],
      components: [buildDaysButtonRow(days)],
    });
  }
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('piechart')
    .setDescription('Map distribution or win/loss breakdown as a donut chart')
    .addStringOption(opt =>
      opt.setName('map')
        .setDescription('Win/loss breakdown for a specific map (default: all maps distribution)')
        .setRequired(false)
        .addChoices(...ALL_MAPS.map(m => ({ name: m, value: m })))
    )
    .addStringOption(opt =>
      opt.setName('game_mode')
        .setDescription('Filter by game mode (default: all)')
        .setRequired(false)
        .addChoices(
          { name: 'Normal',         value: 'Normal'         },
          { name: 'Double Trouble', value: 'Double Trouble' },
        )
    )
    .addIntegerOption(opt =>
      opt.setName('days')
        .setDescription('Days to look back (default: 14)')
        .setMinValue(1)
        .setMaxValue(90)
        .setRequired(false)
    ),

  async execute(interaction, { supabase }) {
    await interaction.deferReply();
    const mapFilter  = interaction.options.getString('map');
    const gameMode   = interaction.options.getString('game_mode') ?? null;
    const days       = interaction.options.getInteger('days') ?? 14;

    await renderPieChart(interaction, supabase, { mapFilter, gameMode, days });

    const reply = await interaction.fetchReply();
    setSession(reply.id, { mapFilter, gameMode, days });
  },

  async handleComponent(interaction, { supabase }) {
    const session = sessions.get(interaction.message.id) ?? { days: 14 };

    if (interaction.customId.startsWith('piechart_days_')) {
      const days = parseInt(interaction.customId.replace('piechart_days_', ''), 10);
      session.days = days;
      setSession(interaction.message.id, session);
      await interaction.deferUpdate();
      return renderPieChart(interaction, supabase, { ...session, days });
    }
  },
};