'use strict';
const { SlashCommandBuilder } = require('discord.js');
const { LOBBIES, RANGES, reply } = require('../modules/imageCommand');

// ─── /matchupdata ─────────────────────────────────────────────────────────────
// What each map sees most of: the most common dinosaurs, MVP weapons and MVP vehicles on every map, as a share of that map's rounds.
// Counts every round from the daily totals (the old version read raw rounds through a 1,000 row cap). Dates are the usual choices
// now, not free text.

module.exports = {
  data: new SlashCommandBuilder()
    .setName('matchupdata')
    .setDescription('The most common dinosaurs, weapons and vehicles on each map')
    .addStringOption(o => o.setName('lobby').setDescription('Lobby type (default: Main Game)').addChoices(...LOBBIES))
    .addStringOption(o => o.setName('time_range').setDescription('Time period (default: past week)').addChoices(...RANGES)),

  async execute(interaction, deps = {}) {
    await interaction.deferReply();
    const o = interaction.options;
    const params = { kind: 'matchups', lobby: o.getString('lobby') ?? 'main', range: o.getString('time_range') ?? '7d', size: 'all' };
    return reply(interaction, deps, { params, file: 'matchups.png', label: 'Open matchups', path: '/dashboard/matchups', tag: 'matchupdata' });
  },
};
