const { SlashCommandBuilder } = require('discord.js');

const OWNER_ID = '1289766186170581120';

module.exports = {
  data: new SlashCommandBuilder()
    .setName('rollup')
    .setDescription('Manually trigger the round_logs rollup and archival job (owner only)'),

  async execute(interaction, { supabase }) {
    if (interaction.user.id !== OWNER_ID) {
      return interaction.reply({ content: '❌ Owner only.', ephemeral: true });
    }

    await interaction.deferReply({ ephemeral: true });

    const { runRollup } = require('../modules/rollup');
    const result = await runRollup(supabase);

    if (!result.success) {
      return interaction.editReply(`❌ Rollup failed: ${result.error}`);
    }

    return interaction.editReply(
      `✅ Rollup complete. Processed and archived **${result.processed.toLocaleString()}** rows.`
    );
  },
};