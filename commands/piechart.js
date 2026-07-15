'use strict';

const {
  SlashCommandBuilder,
  AttachmentBuilder,
} = require('discord.js');
const { buildPieCard, MAP_COLORS } = require('../modules/chart');

const ALL_MAPS          = ['Jungle', 'Canyon', 'Cavern', 'Primal Park'];
const DAYS              = 7;

async function renderPieChart(interaction, supabase, { mapFilter, gameMode }) {
  const modeLabel = gameMode ?? 'All Modes';

  const { data, error } = await supabase.rpc('get_piechart_data', { days_back: DAYS });

  if (error) {
    console.error('[piechart]', error.message);
    return interaction.editReply(`❌ Query failed: ${error.message}`);
  }

  if (!data || data.length === 0) {
    return interaction.editReply(`No round data found for the past ${DAYS} days.`);
  }

  // Filter by game_mode if specified
  // (game_mode not in rpc yet — can add later)

  let segments, cardTitle, cardStats;

  if (mapFilter) {
    const mapRows = data.filter(r => r.map === mapFilter);
    if (mapRows.length === 0) {
      return interaction.editReply(`No data found for **${mapFilter}** in the past ${DAYS} days.`);
    }

    const dinoRow     = mapRows.find(r => r.round_result === 'DinoWin');
    const survivorRow = mapRows.find(r => r.round_result === 'SurvivorWin');
    const dinoWins    = Number(dinoRow?.cnt     ?? 0);
    const survivorWins = Number(survivorRow?.cnt ?? 0);
    const totalRounds = dinoWins + survivorWins;

    segments  = [
      { label: 'Dino Win',     value: dinoWins,     color: '#ED4245' },
      { label: 'Survivor Win', value: survivorWins,  color: '#57F287' },
    ];
    cardTitle = `${mapFilter} — Win Rate`;
    cardStats = [
      { label: 'Total Rounds', value: totalRounds.toLocaleString(),  color: '#5865F2' },
      { label: 'Dino Wins',    value: dinoWins.toLocaleString(),     color: '#ED4245' },
      { label: 'Surv. Wins',   value: survivorWins.toLocaleString(), color: '#57F287' },
    ];

    const buffer = await buildPieCard({
      title:       cardTitle,
      subtitle:    `Primal Pursuit · ${modeLabel} · Past ${DAYS} Days`,
      stats:       cardStats,
      lookback:    `Past ${DAYS} Days`,
      segments,
      centerLabel: `${totalRounds.toLocaleString()}\nrounds`,
    });

    return interaction.editReply({
      files: [new AttachmentBuilder(buffer, { name: 'piechart.png' })],
    });

  } else {
    // Map distribution — sum both outcomes per map
    const mapTotals = new Map();
    for (const row of data) {
      if (!row.map) continue;
      mapTotals.set(row.map, (mapTotals.get(row.map) ?? 0) + Number(row.cnt));
    }

    const totalRounds = [...mapTotals.values()].reduce((s, v) => s + v, 0);

    segments = [...mapTotals.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([label, value]) => ({ label, value, color: MAP_COLORS[label] }));

    if (segments.length === 0) return interaction.editReply('No map data available.');

    cardTitle = 'Map Distribution';
    cardStats = [
      { label: 'Total Rounds', value: totalRounds.toLocaleString(), color: '#5865F2' },
      { label: 'Maps',         value: segments.length.toString(),   color: '#57F287' },
    ];

    const buffer = await buildPieCard({
      title:       cardTitle,
      subtitle:    `Primal Pursuit · ${modeLabel} · Past ${DAYS} Days`,
      stats:       cardStats,
      lookback:    `Past ${DAYS} Days`,
      segments,
      centerLabel: `${totalRounds.toLocaleString()}\nrounds`,
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
    ),

  async execute(interaction, { supabase }) {
    await interaction.deferReply();
    const mapFilter = interaction.options.getString('map');
    await renderPieChart(interaction, supabase, { mapFilter, gameMode: null });
  },
};