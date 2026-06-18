const { SlashCommandBuilder } = require('discord.js');
const { getWeeklyRows, buildMvpTierEmbed, buildPerMapMvpEmbed, buildAdoptionAndResultEmbed } = require('../modules/balance-report');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('balancereport')
    .setDescription('Pull up this week\'s Balance Council report on demand'),

  async execute(interaction, { supabase }) {
    await interaction.deferReply();

    const rows = await getWeeklyRows(supabase);
    if (!rows) {
      return interaction.editReply('❌ Something went wrong fetching round data.');
    }

    if (rows.length === 0) {
      return interaction.editReply('No round data logged this week yet.');
    }

    return interaction.editReply({
      embeds: [
        buildMvpTierEmbed(rows),
        buildPerMapMvpEmbed(rows),
        buildAdoptionAndResultEmbed(rows),
      ],
    });
  },
};