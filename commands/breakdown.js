'use strict';
const { SlashCommandBuilder } = require('discord.js');
const { LOBBIES, RANGES, SIZES, reply } = require('../modules/imageCommand');

// ─── /breakdown ───────────────────────────────────────────────────────────────
// Who wins, split by lobby level, game mode, or Main Game against Pro Lobbies: rounds and dino win rate for each group with a
// 95% range, and each group's win rate day by day. Drawn by the website from the same daily totals as its pages.

const BY = {
  level: { kind: 'ladder',  file: 'level-ladder.png',    label: 'Open level ladder', path: '/dashboard/level-ladder' },
  mode:  { kind: 'modes',   file: 'game-modes.png',      label: 'Open game modes',   path: '/dashboard/double-trouble' },
  lobby: { kind: 'lobbies', file: 'lobby-comparison.png', label: 'Open lobby page',   path: '/dashboard/lobby' },
};

module.exports = {
  data: new SlashCommandBuilder()
    .setName('breakdown')
    .setDescription('Win rates split by lobby level, game mode, or Main Game vs Pro Lobbies')
    .addStringOption(o => o.setName('by').setDescription('How to split the rounds').setRequired(true).addChoices(
      { name: 'Lobby level (level ladder)', value: 'level' },
      { name: 'Game mode (Normal vs Double Trouble)', value: 'mode' },
      { name: 'Lobby type (Main Game vs Pro Lobbies)', value: 'lobby' },
    ))
    .addStringOption(o => o.setName('lobby').setDescription('Lobby type (default: Main Game; ignored when splitting by lobby type)').addChoices(...LOBBIES))
    .addStringOption(o => o.setName('time_range').setDescription('Time period (default: past month)').addChoices(...RANGES))
    .addStringOption(o => o.setName('lobby_size').setDescription('Only rounds from lobbies of this average level').addChoices(...SIZES)),

  async execute(interaction, deps = {}) {
    await interaction.deferReply();
    const o = interaction.options;
    const by = BY[o.getString('by')] ?? BY.level;
    const params = { kind: by.kind, lobby: o.getString('lobby') ?? 'main', range: o.getString('time_range') ?? '30d', size: o.getString('lobby_size') ?? 'all' };
    return reply(interaction, deps, { params, file: by.file, label: by.label, path: by.path, tag: 'breakdown' });
  },
};
