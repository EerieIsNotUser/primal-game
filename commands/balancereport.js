const { SlashCommandBuilder } = require('discord.js');
const { buildFullReport } = require('../modules/balance-report');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('balancereport')
    .setDescription('Pull up this week\'s Balance Council report on demand'),

  async execute(interaction, { supabase }) {
    await interaction.deferReply();

    const report = await buildFullReport(supabase);
    if (!report) {
      return interaction.editReply('❌ Something went wrong fetching round data.');
    }

    if (report.totalRounds === 0) {
      return interaction.editReply('No round data logged this week yet.');
    }

    await interaction.editReply({
      content: `**Weekly Summary**\n${report.overallNarrative}`,
      embeds: [report.overallHighlights],
    });

    for (const embed of report.modeEmbeds) {
      await interaction.followUp({ embeds: [embed] }).catch(() => {});
    }
  },
};