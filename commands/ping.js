const { SlashCommandBuilder } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('ping')
    .setDescription('Check that PrimalGame is online and responding'),

  async execute(interaction) {
    await interaction.reply('PrimalGame is online.');
  },
};
