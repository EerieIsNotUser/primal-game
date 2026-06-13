const { SlashCommandBuilder } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('pingtest')
    .setDescription('Brand-new test command to isolate the 40060 issue'),

  async execute(interaction, { supabase }) {
    console.log('[ping] start', interaction.id, 'replied:', interaction.replied, 'deferred:', interaction.deferred);
    if (interaction.replied || interaction.deferred) return;

    if (!supabase) {
      console.log('[ping] supabase is null');
      return interaction.reply('PrimalGame is online. (Supabase not connected)');
    }
    console.log('[ping] querying race_stats...');
    const { count, error } = await supabase.from('race_stats').select('*', { count: 'exact', head: true });
    console.log('[ping] query done. count:', count, 'error:', error?.message);
    if (error) {
      return interaction.reply(`PrimalGame is online. Supabase error: ${error.message}`);
    }
    console.log('[ping] replying success');
    return interaction.reply(`PrimalGame is online. Supabase connected (${count} race_stats rows).`);
  },
};
