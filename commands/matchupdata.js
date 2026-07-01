const { SlashCommandBuilder, AttachmentBuilder } = require('discord.js');
const chrono = require('chrono-node');
const { postMatchupData } = require('../modules/matchupdata-digest');

// ─── /matchupdata ─────────────────────────────────────────────────────────────
// Manual trigger for matchup data with optional date range.

function parseDateRange(text) {
  const results = chrono.parse(text, new Date());
  if (results.length === 0) return null;
  const result    = results[0];
  const startDate = result.start ? result.start.date() : null;
  const endDate   = result.end   ? result.end.date()   : (result.start ? result.start.date() : null);
  if (!startDate) return null;
  return { startDate, endDate: endDate ?? startDate };
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('matchupdata')
    .setDescription('View matchup data — most common guns, cars and dinos per map')
    .addStringOption(opt =>
      opt.setName('dates')
        .setDescription('Date range e.g. "January 15th through May 30th" (default: past 7 days)')
        .setRequired(false)
    ),

  async execute(interaction, { supabase }) {
    await interaction.deferReply();

    const datesInput = interaction.options.getString('dates');
    let overrideDates = null;

    if (datesInput) {
      const parsed = parseDateRange(datesInput);
      if (!parsed) {
        return interaction.editReply(
          `❌ Couldn't understand "${datesInput}". Try something like "January 15th through May 30th" or "last 30 days".`
        );
      }
      overrideDates = parsed;
    } else {
      overrideDates = {
        startDate: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
        endDate:   new Date(),
      };
    }

    const success = await postMatchupData(interaction.client, supabase, overrideDates);

    if (!success) {
      return interaction.editReply('No round data found for the selected date range.');
    }

    return interaction.deleteReply().catch(() => {});
  },
};