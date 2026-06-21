const { SlashCommandBuilder } = require('discord.js');
const { postRawData } = require('../modules/raw-data-digest');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('rawdata')
    .setDescription('Pull raw round data as a plain text table')
    .addIntegerOption(opt =>
      opt.setName('days')
        .setDescription('Number of days to look back (default 7)')
        .setMinValue(1)
        .setMaxValue(90)
        .setRequired(false)
    ),

  async execute(interaction, { supabase }) {
    await interaction.deferReply();

    const days = interaction.options.getInteger('days') ?? 7;
    const periodMs = days * 24 * 60 * 60 * 1000;
    const periodLabel = days === 7 ? 'week' : `${days} days`;

    const success = await postRawData(interaction.channel, supabase, periodMs, periodLabel);

    if (success) {
      return interaction.deleteReply().catch(() => {});
    }
    return interaction.editReply('❌ Something went wrong fetching round data.');
  },
};