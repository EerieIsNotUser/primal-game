'use strict';

const {
  SlashCommandBuilder,
  AttachmentBuilder,
} = require('discord.js');
const { buildPieCard, MAP_COLORS } = require('../modules/chart');

const ALL_MAPS          = ['Jungle', 'Canyon', 'Cavern', 'Primal Park'];
const TRAINING_PLACE_ID = '100026158235338';
const DAYS              = 7;

async function renderPieChart(interaction, supabase, { mapFilter, gameMode }) {
  const startDate = new Date(Date.now() - DAYS * 24 * 60 * 60 * 1000);
  const modeLabel = gameMode ?? 'All Modes';

  let query = supabase
    .from('round_logs')
    .select('map, round_result, game_mode')
    .gte('played_at', startDate.toISOString())
    .neq('place_id', TRAINING_PLACE_ID);

  if (gameMode) query = query.eq('game_mode', gameMode);

  const { data: rows, error } = await query;
  if (error) {
    console.error('[piechart]', error.message);
    return interaction.editReply(`❌ Query failed: ${error.message}`);
  }
  if (!rows || rows.length === 0) {
    return interaction.editReply(`No round data found for the past ${DAYS} days.`);
  }

  let segments, cardTitle, cardStats;

  if (mapFilter) {
    const mapRows = rows.filter(r => r.map === mapFilter);
    if (mapRows.length === 0) {
      return interaction.editReply(`No data found for **${mapFilter}** in the past ${DAYS} days.`);
    }

    const dinoWins     = mapRows.filter(r => r.round_result === 'DinoWin').length;
    const survivorWins = mapRows.filter(r => r.round_result === 'SurvivorWin').length;

    segments  = [
      { label: 'Dino Win',     value: dinoWins,    color: '#ED4245' },
      { label: 'Survivor Win', value: survivorWins, color: '#57F287' },
    ];
    cardTitle = `${mapFilter} — Win Rate`;
    cardStats = [
      { label: 'Total Rounds', value: mapRows.length.toLocaleString(), color: '#5865F2' },
      { label: 'Dino Wins',    value: dinoWins.toLocaleString(),       color: '#ED4245' },
      { label: 'Surv. Wins',   value: survivorWins.toLocaleString(),   color: '#57F287' },
    ];

    const buffer = await buildPieCard({
      title:       cardTitle,
      subtitle:    `Primal Pursuit · ${modeLabel} · Past ${DAYS} Days`,
      stats:       cardStats,
      lookback:    `Past ${DAYS} Days`,
      segments,
      centerLabel: `${mapRows.length.toLocaleString()}\nrounds`,
    });

    return interaction.editReply({
      files: [new AttachmentBuilder(buffer, { name: 'piechart.png' })],
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
      { label: 'Total Rounds', value: rows.length.toLocaleString(), color: '#5865F2' },
      { label: 'Maps',         value: segments.length.toString(),   color: '#57F287' },
    ];

    const buffer = await buildPieCard({
      title:       cardTitle,
      subtitle:    `Primal Pursuit · ${modeLabel} · Past ${DAYS} Days`,
      stats:       cardStats,
      lookback:    `Past ${DAYS} Days`,
      segments,
      centerLabel: `${rows.length.toLocaleString()}\nrounds`,
    });

    return interaction.editReply({
      files: [new AttachmentBuilder(buffer, { name: 'piechart.png' })],
    });
  }
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('piechart')
    .setDescription('Map distribution or win/loss breakdown for the past 7 days')
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
    ),

  async execute(interaction, { supabase }) {
    await interaction.deferReply();
    const mapFilter = interaction.options.getString('map');
    const gameMode  = interaction.options.getString('game_mode') ?? null;
    await renderPieChart(interaction, supabase, { mapFilter, gameMode });
  },
};