const { SlashCommandBuilder, AttachmentBuilder } = require('discord.js');
const { buildReport } = require('../modules/balance-report');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('balancereport')
    .setDescription('Pull up this week\'s balance report on demand'),

  async execute(interaction, { supabase }) {
    await interaction.deferReply();

    const report = await buildReport(supabase);
    if (!report) {
      return interaction.editReply('❌ Something went wrong fetching round data.');
    }

    return interaction.editReply({
      files: [new AttachmentBuilder(report.cardBuffer, { name: 'balance-report.png' })],
    });
  },
};