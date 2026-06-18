const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');

// ─── /leaderboards (v2) ──────────────────────────────────────────────────
// Rebuilt around what the schema actually contains: round-level MVP fields
// only. No per-player kill/escape data exists in the current payload, so
// the original Most Dangerous Predator / Most Cunning Survivor / Most
// Notorious Hunter player leaderboards CANNOT be built from this data.
//
// NOTE FOR KKG SESSION: there is no mvp_dino field in the current payload —
// only mvp_equipped_vehicle and mvp_equipped_weapon. If a per-round MVP
// dino exists in-game, it needs to be added to the Logger.Send payload for
// a dino MVP leaderboard to be possible. Until then this command only
// covers weapon/vehicle MVP frequency.

const TOP_N = 10;

async function rankMvpField(supabase, field) {
  const { data, error } = await supabase
    .from('round_logs')
    .select(field);

  if (error || !data) return null;

  const counts = new Map();
  for (const row of data) {
    const val = row[field];
    if (!val) continue;
    counts.set(val, (counts.get(val) || 0) + 1);
  }

  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, TOP_N);
}

function formatBoard(ranks, unit) {
  if (!ranks || ranks.length === 0) return '*No data yet.*';
  const MEDALS = ['🥇', '🥈', '🥉'];
  return ranks
    .map(([name, count], i) => {
      const medal = MEDALS[i] ?? `**${i + 1}.**`;
      return `${medal} ${name} — MVP ${count}x ${unit}`;
    })
    .join('\n');
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('leaderboards')
    .setDescription('View MVP frequency leaderboards (weapon/vehicle)')
    .addStringOption(opt =>
      opt.setName('board')
        .setDescription('Which leaderboard to view')
        .setRequired(true)
        .addChoices(
          { name: '🔫 MVP Weapon Frequency', value: 'weapon' },
          { name: '🚗 MVP Vehicle Frequency', value: 'vehicle' },
        )
    ),

  async execute(interaction, { supabase }) {
    await interaction.deferReply();

    const board = interaction.options.getString('board');
    const field = board === 'weapon' ? 'mvp_equipped_weapon' : 'mvp_equipped_vehicle';
    const title = board === 'weapon' ? '🔫 MVP Weapon Frequency' : '🚗 MVP Vehicle Frequency';

    const ranks = await rankMvpField(supabase, field);

    if (ranks === null) {
      return interaction.editReply('❌ Something went wrong fetching leaderboard data.');
    }

    const embed = new EmbedBuilder()
      .setColor(0x5865F2)
      .setTitle(title)
      .setDescription(formatBoard(ranks, 'rounds'))
      .setFooter({ text: `PrimalGame · Top ${TOP_N} · All-time, all servers` })
      .setTimestamp();

    return interaction.editReply({ embeds: [embed] });
  },
};