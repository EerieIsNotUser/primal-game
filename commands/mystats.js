const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');

const MIN_SAMPLE = 5; // minimum rounds to qualify for "best" item

const STAFF_ROLES = [
  '1256733838248513697', // Server Staff
  '1493513103667630150', // Game Manager
  '1387594932122030101', // Bot Admin
  '1255270373889675366', // Senior
];

function isStaff(member) {
  return STAFF_ROLES.some(id => member.roles.cache.has(id));
}

// For a map of item -> { wins, total }, return the best item by win rate
// with at least MIN_SAMPLE rounds played.
function bestItem(countMap) {
  let best = null;
  let bestRate = -1;
  for (const [name, { wins, total }] of countMap) {
    if (total < MIN_SAMPLE) continue;
    const rate = wins / total;
    if (rate > bestRate) {
      bestRate = rate;
      best = { name, wins, total, rate };
    }
  }
  return best;
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('mystats')
    .setDescription('View your Primal Pursuit round stats')
    .addUserOption(opt =>
      opt.setName('user')
        .setDescription('Staff only — look up another user')
        .setRequired(false)
    )
    .addStringOption(opt =>
      opt.setName('server_type')
        .setDescription('Filter by server type (default: both)')
        .addChoices(
          { name: 'All servers', value: 'all' },
          { name: 'Regular / Casual only', value: 'regular' },
          { name: 'Pro only', value: 'pro' },
        )
        .setRequired(false)
    ),

  async execute(interaction, { supabase }) {
    await interaction.deferReply({ ephemeral: true });

    const targetUser = interaction.options.getUser('user');
    const serverType = interaction.options.getString('server_type') ?? 'all';

    // Staff gate for looking up others
    if (targetUser && targetUser.id !== interaction.user.id) {
      if (!isStaff(interaction.member)) {
        return interaction.editReply('❌ Only staff can look up other users\' stats.');
      }
    }

    const discordId = targetUser ? targetUser.id : interaction.user.id;
    const displayUser = targetUser ?? interaction.user;

    // Resolve Roblox ID from verified_users
    const { data: verified, error: verifyError } = await supabase
      .from('verified_users')
      .select('roblox_id, roblox_username')
      .eq('discord_id', discordId)
      .maybeSingle();

    if (verifyError) {
      console.error('[mystats] Supabase verify error:', verifyError.message);
      return interaction.editReply('❌ Something went wrong fetching verification data.');
    }

    if (!verified) {
      return interaction.editReply(
        targetUser
          ? `❌ <@${discordId}> has not verified their Roblox account.`
          : '❌ You haven\'t verified your Roblox account. Use `/verify` to get started.'
      );
    }

    // Fetch round_players rows for this Roblox user, joining round_logs for server_type
    let query = supabase
      .from('round_players')
      .select('dino, weapon, vehicle, won, round_logs!inner(server_type)')
      .eq('roblox_user_id', verified.roblox_id);

    if (serverType === 'regular') {
      query = query.eq('round_logs.server_type', 'regular');
    } else if (serverType === 'pro') {
      query = query.eq('round_logs.server_type', 'pro');
    }

    const { data: rows, error: rowsError } = await query;

    if (rowsError) {
      console.error('[mystats] Supabase rows error:', rowsError.message);
      return interaction.editReply('❌ Something went wrong fetching round data.');
    }

    if (!rows || rows.length === 0) {
      const typeLabel = serverType === 'all' ? '' : ` on **${serverType}** servers`;
      return interaction.editReply(
        targetUser
          ? `No round data found for <@${discordId}>${typeLabel}.`
          : `No round data found for your account${typeLabel}. Play some rounds first!`
      );
    }

    // Aggregate
    const totalRounds = rows.length;
    const totalWins = rows.filter(r => r.won).length;
    const winRate = ((totalWins / totalRounds) * 100).toFixed(1);

    // Build per-item win/total maps
    const dinoMap = new Map();
    const weaponMap = new Map();
    const vehicleMap = new Map();

    for (const row of rows) {
      for (const [map, val] of [
        [dinoMap, row.dino],
        [weaponMap, row.weapon],
        [vehicleMap, row.vehicle],
      ]) {
        if (!val) continue;
        if (!map.has(val)) map.set(val, { wins: 0, total: 0 });
        const entry = map.get(val);
        entry.total++;
        if (row.won) entry.wins++;
      }
    }

    const bestDino    = bestItem(dinoMap);
    const bestWeapon  = bestItem(weaponMap);
    const bestVehicle = bestItem(vehicleMap);

    const fmt = item => item
      ? `${item.name} (${(item.rate * 100).toFixed(1)}% WR, ${item.total} rounds)`
      : `Not enough data (min ${MIN_SAMPLE} rounds)`;

    const serverTypeLabel = serverType === 'all' ? 'All Servers' : serverType === 'pro' ? 'Pro' : 'Regular / Casual';

    const embed = new EmbedBuilder()
      .setColor(0x5865F2)
      .setTitle(`📊 ${verified.roblox_username ?? displayUser.username}'s Stats`)
      .setDescription(`Showing stats for **${serverTypeLabel}**`)
      .addFields(
        { name: '🎮 Total Rounds', value: totalRounds.toLocaleString('en-US'), inline: true },
        { name: '🏆 Win Rate',     value: `${winRate}%`,                        inline: true },
        { name: '🦖 Best Dino',    value: fmt(bestDino),                        inline: false },
        { name: '🔫 Best Weapon',  value: fmt(bestWeapon),                      inline: false },
        { name: '🚗 Best Vehicle', value: fmt(bestVehicle),                     inline: false },
      )
      .setFooter({ text: `PrimalGame · Roblox ID ${verified.roblox_id}` })
      .setTimestamp();

    return interaction.editReply({ embeds: [embed] });
  },
};