'use strict';
const { SlashCommandBuilder } = require('discord.js');
const { LOBBIES, RANGES, reply } = require('../modules/imageCommand');

// ─── /peaktimes ───────────────────────────────────────────────────────────────
// When the game is busiest: average rounds in each hour of each weekday (Eastern time), plus the busiest and quietest hour and day.

module.exports = {
  data: new SlashCommandBuilder()
    .setName('peaktimes')
    .setDescription('When the game is busiest, by weekday and hour')
    .addStringOption(o => o.setName('lobby').setDescription('Lobby type (default: Main Game)').addChoices(...LOBBIES))
    .addStringOption(o => o.setName('time_range').setDescription('Time period (default: past month)').addChoices(...RANGES)),

  async execute(interaction, deps = {}) {
    await interaction.deferReply();
    const o = interaction.options;
    const params = { kind: 'peak', lobby: o.getString('lobby') ?? 'main', range: o.getString('time_range') ?? '30d', size: 'all' };
    return reply(interaction, deps, { params, file: 'peak-times.png', label: 'Open peak times', path: '/dashboard/peak-times', tag: 'peaktimes' });
  },
};
