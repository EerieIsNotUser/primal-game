const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');

// ─── /mystats (stub) ─────────────────────────────────────────────────────
// Per-player stats require per-player data, which does not exist in the
// current round-level-only payload from KKG's Logger.Send("RoundResult").
// This is a placeholder until that's resolved — do not build real logic
// here until a per-player data source is confirmed.

module.exports = {
  data: new SlashCommandBuilder()
    .setName('mystats')
    .setDescription('View your Primal Pursuit round stats (coming soon)'),

  async execute(interaction) {
    const embed = new EmbedBuilder()
      .setColor(0xFEE75C)
      .setTitle('📊 /mystats — Coming Soon')
      .setDescription(
        'Personal stats aren\'t available yet — the current round logging ' +
        'only tracks round-level data (map, MVP, item adoption), not ' +
        'individual player performance.\n\n' +
        'This is on the roadmap once per-player tracking is added to the ' +
        'game\'s logging system.'
      )
      .setFooter({ text: 'PrimalGame' });

    return interaction.reply({ embeds: [embed], ephemeral: true });
  },
};