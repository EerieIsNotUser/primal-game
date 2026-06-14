const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');

// ─── Sparkline ──────────────────────────────────────────────────────────────
const SPARK_CHARS = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];

function buildSparkline(rounds) {
  // Bucket rounds by date, scale bucket count to the span of data.
  if (rounds.length === 0) return null;

  const timestamps = rounds.map(r => new Date(r.played_at).getTime());
  const earliest = Math.min(...timestamps);
  const latest = Math.max(...timestamps);
  const spanMs = latest - earliest;

  const DAY = 24 * 60 * 60 * 1000;
  let bucketMs;
  if (spanMs <= 7 * DAY) bucketMs = DAY;            // daily buckets for up to a week
  else if (spanMs <= 31 * DAY) bucketMs = 7 * DAY;  // weekly buckets for up to a month
  else bucketMs = 30 * DAY;                          // monthly buckets beyond that

  const buckets = new Map(); // bucketIndex -> { wins, total }
  for (const r of rounds) {
    const ts = new Date(r.played_at).getTime();
    const idx = Math.floor((ts - earliest) / bucketMs);
    if (!buckets.has(idx)) buckets.set(idx, { wins: 0, total: 0 });
    const b = buckets.get(idx);
    b.total++;
    if (r.won) b.wins++;
  }

  const maxIdx = Math.max(...buckets.keys());
  let spark = '';
  for (let i = 0; i <= maxIdx; i++) {
    const b = buckets.get(i);
    if (!b) {
      spark += ' '; // gap, no data for this bucket
      continue;
    }
    const rate = b.wins / b.total;
    const charIdx = Math.min(SPARK_CHARS.length - 1, Math.floor(rate * SPARK_CHARS.length));
    spark += SPARK_CHARS[charIdx];
  }
  return spark;
}

// ─── Period -> cutoff date ──────────────────────────────────────────────────
function periodToCutoff(period) {
  if (!period || period === 'all') return null;
  const now = Date.now();
  const DAY = 24 * 60 * 60 * 1000;
  switch (period) {
    case 'day':     return new Date(now - 1 * DAY);
    case 'week':    return new Date(now - 7 * DAY);
    case 'month':   return new Date(now - 30 * DAY);
    case 'quarter': return new Date(now - 90 * DAY);
    default:        return null;
  }
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('roundstats')
    .setDescription('Query round win rates with combinable filters')
    .addStringOption(opt =>
      opt.setName('period')
        .setDescription('Time period to look at')
        .addChoices(
          { name: 'Today', value: 'day' },
          { name: 'Past Week', value: 'week' },
          { name: 'Past Month', value: 'month' },
          { name: 'Past Quarter', value: 'quarter' },
          { name: 'All Time', value: 'all' },
        ))
    .addStringOption(opt =>
      opt.setName('dino')
        .setDescription('Filter by dinosaur')
        .setAutocomplete(true))
    .addStringOption(opt =>
      opt.setName('weapon')
        .setDescription('Filter by weapon')
        .setAutocomplete(true))
    .addStringOption(opt =>
      opt.setName('vehicle')
        .setDescription('Filter by vehicle')
        .setAutocomplete(true))
    .addStringOption(opt =>
      opt.setName('map')
        .setDescription('Filter by map')
        .setAutocomplete(true))
    .addStringOption(opt =>
      opt.setName('server_type')
        .setDescription('Filter by server type')
        .addChoices(
          { name: 'Pro Servers', value: 'pro' },
          { name: 'Regular Servers', value: 'regular' },
        )),

  async autocomplete(interaction, { supabase }) {
    if (!supabase) return interaction.respond([]);

    const focused = interaction.options.getFocused(true);
    const query = focused.value.toLowerCase();

    // dino/weapon/vehicle live on round_players; map lives on round_logs.
    const table = focused.name === 'map' ? 'round_logs' : 'round_players';
    const column = focused.name;

    const { data, error } = await supabase
      .from(table)
      .select(column)
      .not(column, 'is', null)
      .limit(1000);

    if (error || !data) return interaction.respond([]);

    const distinct = [...new Set(data.map(r => r[column]).filter(Boolean))];
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

    const period     = interaction.options.getString('period');
    const dino       = interaction.options.getString('dino');
    const weapon     = interaction.options.getString('weapon');
    const vehicle    = interaction.options.getString('vehicle');
    const map        = interaction.options.getString('map');
    const serverType = interaction.options.getString('server_type');

    await interaction.deferReply();

    // Base query: round_players joined to round_logs, so we can filter on
    // either table's columns and still get played_at/server_type/map per row.
    let query = supabase
      .from('round_players')
      .select('won, dino, weapon, vehicle, round_logs!inner(played_at, map, server_type)');

    if (dino)    query = query.eq('dino', dino);
    if (weapon)  query = query.eq('weapon', weapon);
    if (vehicle) query = query.eq('vehicle', vehicle);
    if (map)        query = query.eq('round_logs.map', map);
    if (serverType) query = query.eq('round_logs.server_type', serverType);

    const cutoff = periodToCutoff(period);
    if (cutoff) query = query.gte('round_logs.played_at', cutoff.toISOString());

    const { data, error } = await query;

    if (error) {
      console.error('[roundstats] query error:', error.message);
      return interaction.editReply(`Query failed: ${error.message}`);
    }

    if (!data || data.length === 0) {
      return interaction.editReply('No rounds found matching those filters.');
    }

    const total = data.length;
    const wins = data.filter(r => r.won).length;
    const winRate = ((wins / total) * 100).toFixed(1);

    // Sparkline needs played_at per row, flattened from the joined table.
    const rowsForSpark = data.map(r => ({ won: r.won, played_at: r.round_logs.played_at }));
    const sparkline = buildSparkline(rowsForSpark);

    // Build a human-readable summary of the active filters.
    const filterParts = [];
    if (dino)        filterParts.push(`dino: **${dino}**`);
    if (weapon)      filterParts.push(`weapon: **${weapon}**`);
    if (vehicle)     filterParts.push(`vehicle: **${vehicle}**`);
    if (map)         filterParts.push(`map: **${map}**`);
    if (serverType)  filterParts.push(`server: **${serverType}**`);
    if (period && period !== 'all') {
      const periodLabels = { day: 'today', week: 'past week', month: 'past month', quarter: 'past quarter' };
      filterParts.push(`period: **${periodLabels[period]}**`);
    }

    const embed = new EmbedBuilder()
      .setColor(0x5865F2)
      .setTitle('📊 Round Stats')
      .setDescription(filterParts.length ? filterParts.join(' · ') : 'All rounds, all time')
      .addFields(
        { name: 'Win Rate', value: `${winRate}%`, inline: true },
        { name: 'Sample Size', value: `${total} round${total === 1 ? '' : 's'}`, inline: true },
      )
      .setFooter({ text: 'PrimalGame' })
      .setTimestamp();

    if (sparkline) {
      embed.addFields({ name: 'Trend', value: `\`${sparkline}\``, inline: false });
    }

    return interaction.editReply({ embeds: [embed] });
  },
};