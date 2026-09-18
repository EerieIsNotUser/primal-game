const { SlashCommandBuilder, AttachmentBuilder } = require('discord.js');
const { buildPlayerStatsCard } = require('../modules/chart');

const TIME_RANGES = [
  { name: 'Past Week',    value: '7'   },
  { name: 'Past Month',   value: '30'  },
  { name: 'Past Quarter', value: '90'  },
  { name: 'All Time',     value: 'all' },
];

module.exports = {
  data: new SlashCommandBuilder()
    .setName('mystats')
    .setDescription('View your Primal Pursuit round stats')
    .addStringOption(opt =>
      opt.setName('time_range')
        .setDescription('Time period (default: all time)')
        .setRequired(false)
        .addChoices(...TIME_RANGES.map(t => ({ name: t.name, value: t.value })))
    ),

  async execute(interaction, { supabase }) {
    await interaction.deferReply();

    const days = interaction.options.getString('time_range') ?? 'all';

    // ── Resolve Discord → Roblox ─────────────────────────────────────────
    const { data: verified, error: verifyErr } = await supabase
      .from('verified_users')
      .select('roblox_id, roblox_username')
      .eq('discord_id', interaction.user.id)
      .maybeSingle();

    if (verifyErr || !verified) {
      return interaction.editReply('❌ You need to be verified to use this command. Verify your Roblox account first.');
    }

    // ── Fetch player rows ─────────────────────────────────────────────────
    let query = supabase
      .from('round_players')
      .select('round_id, platform, duration_seconds, role, respawn_count, created_at')
      .eq('roblox_user_id', verified.roblox_id);

    if (days !== 'all') {
      const cutoff = new Date(Date.now() - parseInt(days, 10) * 24 * 60 * 60 * 1000);
      query = query.gte('created_at', cutoff.toISOString());
    }

    const { data: rows, error } = await query;

    if (error) {
      console.error('[/mystats]', error.message);
      return interaction.editReply('❌ Something went wrong fetching your stats.');
    }

    if (!rows || rows.length === 0) {
      return interaction.editReply(`No round data found for **${verified.roblox_username}** in the selected time range yet.`);
    }

    // ── Aggregate ────────────────────────────────────────────────────────
    const totalRounds   = rows.length;
    const durations      = rows.map(r => r.duration_seconds).filter(d => d != null && d > 0);
    const totalDuration  = durations.reduce((s, d) => s + d, 0);
    const avgDuration    = durations.length > 0 ? totalDuration / durations.length : 0;

    const respawns = rows.map(r => r.respawn_count).filter(r => r != null);
    const avgRespawns = respawns.length > 0 ? respawns.reduce((s, r) => s + r, 0) / respawns.length : 0;

    const roleCounts = new Map();
    for (const r of rows) {
      if (!r.role) continue;
      roleCounts.set(r.role, (roleCounts.get(r.role) ?? 0) + 1);
    }
    const roleBreakdown = [...roleCounts.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count);

    const platformCounts = new Map();
    for (const r of rows) {
      if (!r.platform) continue;
      platformCounts.set(r.platform, (platformCounts.get(r.platform) ?? 0) + 1);
    }
    const platformBreakdown = [...platformCounts.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count);

    const lookback = days === 'all' ? 'All Time' : TIME_RANGES.find(t => t.value === days)?.name ?? days + ' Days';

    const buffer = await buildPlayerStatsCard({
      robloxUsername: verified.roblox_username,
      robloxId:       verified.roblox_id,
      lookback,
      totalRounds,
      totalDuration,
      avgDuration,
      roleBreakdown,
      platformBreakdown,
      avgRespawns,
    });

    return interaction.editReply({
      files: [new AttachmentBuilder(buffer, { name: 'mystats.png' })],
    });
  },
};