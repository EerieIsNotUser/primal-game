const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');

// ─── Period -> cutoff date ──────────────────────────────────────────────────
function periodToCutoff(period) {
  if (!period || period === 'all') return null;
  const now = Date.now();
  const HOUR = 60 * 60 * 1000;
  switch (period) {
    case 'day':     return new Date(now - 24 * HOUR);
    case 'week':    return new Date(now - 7 * 24 * HOUR);
    case 'month':   return new Date(now - 30 * 24 * HOUR);
    case 'quarter': return new Date(now - 90 * 24 * HOUR);
    default:        return null;
  }
}

const PERIOD_LABELS = {
  day: 'past 24 hours',
  week: 'past week',
  month: 'past month',
  quarter: 'past quarter',
  all: 'all time',
};

module.exports = {
  data: new SlashCommandBuilder()
    .setName('mapvotes')
    .setDescription('See which maps are played most, ranked by round count')
    .addStringOption(opt =>
      opt.setName('period')
        .setDescription('Time period to look at (ignored if "hours" is set)')
        .addChoices(
          { name: 'Past 24 Hours', value: 'day' },
          { name: 'Past Week', value: 'week' },
          { name: 'Past Month', value: 'month' },
          { name: 'Past Quarter', value: 'quarter' },
          { name: 'All Time', value: 'all' },
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

  async execute(interaction, { supabase }) {
    if (!supabase) {
      return interaction.reply('PrimalGame is not connected to the database.');
    }

    const period     = interaction.options.getString('period');
    const hours      = interaction.options.getInteger('hours');
    const serverType = interaction.options.getString('server_type');

    await interaction.deferReply();

    let query = supabase
      .from('round_logs')
      .select('map, server_type, played_at');

    // Timeframe: custom "hours" overrides "period" if both are given.
    let cutoff = null;
    let timeframeLabel;
    if (hours) {
      cutoff = new Date(Date.now() - hours * 60 * 60 * 1000);
      timeframeLabel = `past ${hours} hour${hours === 1 ? '' : 's'}`;
    } else {
      cutoff = periodToCutoff(period);
      timeframeLabel = PERIOD_LABELS[period || 'all'];
    }
    if (cutoff) query = query.gte('played_at', cutoff.toISOString());

    // Server type: explicit filter if given, otherwise exclude pro by default.
    let serverLabel;
    if (serverType && serverType !== 'all') {
      query = query.eq('server_type', serverType);
      serverLabel = `${serverType} servers`;
    } else if (!serverType) {
      query = query.neq('server_type', 'pro');
      serverLabel = 'non-pro servers';
    } else {
      serverLabel = 'all server types';
    }

    const { data, error } = await query;

    if (error) {
      console.error('[mapvotes] query error:', error.message);
      return interaction.editReply(`Query failed: ${error.message}`);
    }

    if (!data || data.length === 0) {
      return interaction.editReply('No rounds found matching those filters.');
    }

    // Count rounds per map.
    const counts = new Map();
    for (const row of data) {
      if (!row.map) continue;
      counts.set(row.map, (counts.get(row.map) || 0) + 1);
    }

    const total = data.length;
    const ranked = [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([map, count], i) => {
        const pct = ((count / total) * 100).toFixed(1);
        return `**${i + 1}.** ${map} — ${count} round${count === 1 ? '' : 's'} (${pct}%)`;
      });

    const embed = new EmbedBuilder()
      .setColor(0x57F287)
      .setTitle('🗺️ Map Popularity')
      .setDescription(`${serverLabel}, ${timeframeLabel}\n\n${ranked.join('\n')}`)
      .addFields({ name: 'Total Rounds', value: `${total}`, inline: true })
      .setFooter({ text: 'PrimalGame' })
      .setTimestamp();

    return interaction.editReply({ embeds: [embed] });
  },
};