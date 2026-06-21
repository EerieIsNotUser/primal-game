const { SlashCommandBuilder, EmbedBuilder, AttachmentBuilder } = require('discord.js');
const { buildLineChartImage, bucketRoundsByMap } = require('../modules/chart');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('mapchart')
    .setDescription('View map popularity over the past N days')
    .addIntegerOption(opt =>
      opt.setName('days')
        .setDescription('Number of days to look back (default 14)')
        .setMinValue(1)
        .setMaxValue(90)
        .setRequired(false)
    )
    .addStringOption(opt =>
      opt.setName('map')
        .setDescription('Single map only (default: all maps overlaid)')
        .setRequired(false)
    ),

  async execute(interaction, { supabase }) {
    await interaction.deferReply();

    const days = interaction.options.getInteger('days') ?? 14;
    const mapFilter = interaction.options.getString('map');

    const endDate = new Date();
    const startDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    let query = supabase
      .from('round_logs')
      .select('map, played_at')
      .gte('played_at', startDate.toISOString())
      .lte('played_at', endDate.toISOString());

    if (mapFilter) {
      query = query.ilike('map', mapFilter);
    }

    const { data: rows, error } = await query;

    if (error) {
      console.error('[mapchart] Supabase error:', error.message);
      return interaction.editReply('❌ Something went wrong fetching round data.');
    }

    if (!rows || rows.length === 0) {
      return interaction.editReply(`No round data found for the past ${days} days${mapFilter ? ` on ${mapFilter}` : ''}.`);
    }

    const { labels, series } = bucketRoundsByMap(rows, startDate, endDate);

    if (series.length === 0) {
      return interaction.editReply('No map data available to chart.');
    }

    const title = mapFilter
      ? `${series[0]?.label ?? mapFilter} — Rounds Played (Past ${days} Days)`
      : `Map Popularity — Past ${days} Days`;

    const buffer = await buildLineChartImage(labels, series, title);
    const attachment = new AttachmentBuilder(buffer, { name: 'mapchart.png' });

    const embed = new EmbedBuilder()
      .setColor(0x5865F2)
      .setImage('attachment://mapchart.png')
      .setFooter({ text: `PrimalGame · ${rows.length} rounds · all servers` });

    return interaction.editReply({ embeds: [embed], files: [attachment] });
  },
};