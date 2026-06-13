const { SlashCommandBuilder } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('status')
    .setDescription('Check that PrimalGame is online and connected to Supabase'),

  async execute(interaction, { supabase }) {
    if (interaction.replied || interaction.deferred) return;

    if (!supabase) {
      return interaction.reply('PrimalGame is online. (Supabase not connected)');
    }
    const { count, error } = await supabase.from('race_stats').select('*', { count: 'exact', head: true });
    if (error) {
      return interaction.reply(`PrimalGame is online. Supabase error: ${error.message}`);
    }
    return interaction.reply(`PrimalGame is online. Supabase connected (${count} race_stats rows).`);
  },
};
