const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { buildLineChartUrl, bucketRoundsByMap } = require('../modules/chart');

const PERIOD_LABELS = {
  day: 'Past 24 Hours',
  week: 'Past Week',
  month: 'Past Month',
  quarter: 'Past Quarter',
};

function periodToRange(period, hours) {
  const now = new Date();
  if (hours) {
    return { start: new Date(now.getTime() - hours * 60 * 60 * 1000), end: now, bucketHourly: hours <= 48 };
  }
  const HOUR = 60 * 60 * 1000;
  switch (period) {
    case 'day':     return { start: new Date(now - 24 * HOUR), end: now, bucketHourly: true };
    case 'week':    return { start: new Date(now - 7 * 24 * HOUR), end: now, bucketHourly: false };
    case 'month':   return { start: new Date(now - 30 * 24 * HOUR), end: now, bucketHourly: false };
    case 'quarter': return { start: new Date(now - 90 * 24 * HOUR), end: now, bucketHourly: false };
    default:        return { start: new Date(now - 7 * 24 * HOUR), end: now, bucketHourly: false };
  }
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('mapchart')
    .setDescription('See a chart of how often a map (or all maps) was played over time')
    .addStringOption(opt =>
      opt.setName('map')
        .setDescription('Map to chart (omit to show all maps overlaid)')
        .setAutocomplete(true))
    .addStringOption(opt =>
      opt.setName('period')
        .setDescription('Time period to chart (default: past week)')
        .addChoices(
          { name: 'Past 24 Hours', value: 'day' },
          { name: 'Past Week', value: 'week' },
          { name: 'Past Month', value: 'month' },
          { name: 'Past Quarter', value: 'quarter' },
        ))
    .addIntegerOption(opt =>
      opt.setName('hours')
        .setDescription('Custom timeframe in hours — overrides "period" if set')
        .setMinValue(1))
    .addStringOption(opt =>
      opt.setName('server_type')
        .setDescription('Filter by server type (default: all except pro)')
        .addChoices(
          { name: 'Regular Servers', value: 'regular' },
          { name: 'Training Servers', value: 'training' },
          { name: 'Pro Servers', value: 'pro' },
          { name: 'All Server Types', value: 'all' },
        )),

  async autocomplete(interaction, { supabase }) {
    if (!supabase) return interaction.respond([]);

    const query = interaction.options.getFocused().toLowerCase();

    const { data, error } = await supabase
      .from('round_logs')
      .select('map')
      .not('map', 'is', null)
      .limit(1000);

    if (error || !data) return interaction.respond([]);

    const distinct = [...new Set(data.map(r => r.map).filter(Boolean))];
    const matches = distinct
      .filter(v => v.toLowerCase().includes(query))
      .slice(0, 25)
      .map(v => ({ name: v, value: v }));

    return interaction.respond(matches);
  },

  async execute(interaction, { supabase }) {
    if (!supabase) {
      return interaction.reply('PrimalGame is not connected to the database.');
    }

    const map        = interaction.options.getString('map');
    const period     = interaction.options.getString('period');
    const hours      = interaction.options.getInteger('hours');
    const serverType = interaction.options.getString('server_type');

    await interaction.deferReply();

    const { start, end, bucketHourly } = periodToRange(period, hours);

    let query = supabase
      .from('round_logs')
      .select('map, played_at')
      .gte('played_at', start.toISOString())
      .lte('played_at', end.toISOString());

    if (map) query = query.eq('map', map);

    if (serverType && serverType !== 'all') {
      query = query.eq('server_type', serverType);
    } else if (!serverType) {
      query = query.neq('server_type', 'pro');
    }

    const { data, error } = await query;

    if (error) {
      console.error('[mapchart] query error:', error.message);
      return interaction.editReply(`Query failed: ${error.message}`);
    }

    if (!data || data.length === 0) {
      return interaction.editReply('No rounds found matching those filters.');
    }

    const bucketMs = bucketHourly ? 60 * 60 * 1000 : 24 * 60 * 60 * 1000;
    const { labels, series } = bucketRoundsByMap(data, start, end, bucketMs);

    if (series.length === 0) {
      return interaction.editReply('No data to chart for those filters.');
    }

    const timeframeLabel = hours
      ? `past ${hours} hour${hours === 1 ? '' : 's'}`
      : (PERIOD_LABELS[period] || PERIOD_LABELS.week);

    const title = map
      ? `${map} — Rounds Played (${timeframeLabel})`
      : `Map Popularity — ${timeframeLabel}`;

    const chartUrl = buildLineChartUrl(labels, series, title);

    const embed = new EmbedBuilder()
      .setColor(0x5865F2)
      .setImage(chartUrl)
      .setFooter({ text: 'PrimalGame' })
      .setTimestamp();

    return interaction.editReply({ embeds: [embed] });
  },
};