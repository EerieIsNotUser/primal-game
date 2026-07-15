'use strict';

const {
  SlashCommandBuilder,
  AttachmentBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require('discord.js');
const { buildWinRateCardV2, MAP_COLORS } = require('../modules/chart');

const ALL_MAPS          = ['Jungle', 'Canyon', 'Cavern', 'Primal Park'];
const TRAINING_PLACE_ID = '100026158235338';
const DEFAULT_DAYS      = 7;

const sessions = new Map();
function setSession(id, data) {
  sessions.set(id, data);
  setTimeout(() => sessions.delete(id), 5 * 60 * 1000);
}

function buildMapButtonRow(activeMap) {
  const maps = [...ALL_MAPS, 'All Maps'];
  const rows = [];
  const row1 = new ActionRowBuilder();
  const row2 = new ActionRowBuilder();

  maps.forEach((map, i) => {
    const btn = new ButtonBuilder()
      .setCustomId(`winrate_map_${map}`)
      .setLabel(map)
      .setStyle(map === (activeMap ?? 'All Maps') ? ButtonStyle.Primary : ButtonStyle.Secondary);
    if (i < 3) row1.addComponents(btn);
    else        row2.addComponents(btn);
  });

  rows.push(row1);
  if (row2.components.length) rows.push(row2);
  return rows;
}

async function renderWinRate(interaction, supabase, { mapFilter, gameMode, days }) {
  const modeLabel = gameMode ?? 'All Modes';
  const daysBack  = days ?? DEFAULT_DAYS;

  const { data, error } = await supabase.rpc('get_winrate_data', { days_back: daysBack });

  if (error) {
    console.error('[winrate]', error.message);
    return interaction.editReply(`❌ Query failed: ${error.message}`);
  }

  if (!data || data.length === 0) {
    return interaction.editReply(`No round data found for the past ${daysBack} days.`);
  }

  // Filter by game_mode if specified
  const filtered = gameMode ? data.filter(r => r.game_mode === gameMode) : data;

  // Build per-map win rate stats
  const mapStats = new Map();
  for (const row of filtered) {
    if (!row.map) continue;
    if (!mapStats.has(row.map)) mapStats.set(row.map, { dinoWins: 0, survivorWins: 0 });
    const s = mapStats.get(row.map);
    if (row.round_result === 'DinoWin')     s.dinoWins     += Number(row.cnt);
    if (row.round_result === 'SurvivorWin') s.survivorWins += Number(row.cnt);
  }

  if (mapStats.size === 0) return interaction.editReply('No data available.');

  let cardData;

  if (mapFilter && mapFilter !== 'All Maps') {
    const s = mapStats.get(mapFilter);
    if (!s) return interaction.editReply(`No data found for **${mapFilter}**.`);

    const total    = s.dinoWins + s.survivorWins;
    const dinoRate = total > 0 ? ((s.dinoWins / total) * 100).toFixed(1) : '0.0';
    const survRate = total > 0 ? ((s.survivorWins / total) * 100).toFixed(1) : '0.0';

    cardData = {
      title:    `${mapFilter} — Win Rate`,
      subtitle: `Primal Pursuit · ${modeLabel} · Past ${daysBack} Days`,
      rows: [
        { label: 'Dino Win Rate',     value: `${dinoRate}%`,              color: '#ED4245' },
        { label: 'Survivor Win Rate', value: `${survRate}%`,              color: '#57F287' },
        { label: 'Total Rounds',      value: total.toLocaleString(),       color: '#5865F2' },
        { label: 'Dino Wins',         value: s.dinoWins.toLocaleString(),  color: '#ED4245' },
        { label: 'Surv. Wins',        value: s.survivorWins.toLocaleString(), color: '#57F287' },
      ],
      lookback: `Past ${daysBack} Days`,
    };
  } else {
    // All maps overview
    const tableRows = [...mapStats.entries()]
      .sort((a, b) => {
        const totalA = a[1].dinoWins + a[1].survivorWins;
        const totalB = b[1].dinoWins + b[1].survivorWins;
        return totalB - totalA;
      })
      .map(([map, s]) => {
        const total    = s.dinoWins + s.survivorWins;
        const dinoRate = total > 0 ? ((s.dinoWins / total) * 100).toFixed(1) : '0.0';
        const survRate = total > 0 ? ((s.survivorWins / total) * 100).toFixed(1) : '0.0';
        return { map, dinoRate, survRate, total, ...s };
      });

    const grandTotal = tableRows.reduce((s, r) => s + r.total, 0);
    const grandDino  = tableRows.reduce((s, r) => s + r.dinoWins, 0);
    const grandSurv  = tableRows.reduce((s, r) => s + r.survivorWins, 0);
    const grandDinoRate = grandTotal > 0 ? ((grandDino / grandTotal) * 100).toFixed(1) : '0.0';
    const grandSurvRate = grandTotal > 0 ? ((grandSurv / grandTotal) * 100).toFixed(1) : '0.0';

    cardData = {
      title:    'Win Rate — All Maps',
      subtitle: `Primal Pursuit · ${modeLabel} · Past ${daysBack} Days`,
      rows: [
        { label: 'Total Rounds',      value: grandTotal.toLocaleString(), color: '#5865F2' },
        { label: 'Overall Dino Win',  value: `${grandDinoRate}%`,        color: '#ED4245' },
        { label: 'Overall Surv. Win', value: `${grandSurvRate}%`,        color: '#57F287' },
        ...tableRows.map(r => ({
          label: r.map,
          value: `🦕 ${r.dinoRate}% · 🧍 ${r.survRate}%`,
          color: MAP_COLORS[r.map] ?? '#FFFFFF',
        })),
      ],
      lookback: `Past ${daysBack} Days`,
    };
  }

  const buffer = await buildWinRateCardV2(cardData);

  const components = buildMapButtonRow(mapFilter);

  return interaction.editReply({
    files:      [new AttachmentBuilder(buffer, { name: 'winrate.png' })],
    components,
  });
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('winrate')
    .setDescription('Win rate breakdown by map for the past 7 days')
    .addStringOption(opt =>
      opt.setName('map')
        .setDescription('Filter to a specific map (default: all maps)')
        .setRequired(false)
        .addChoices(...ALL_MAPS.map(m => ({ name: m, value: m })))
    )
    .addStringOption(opt =>
      opt.setName('game_mode')
        .setDescription('Filter by game mode (default: all)')
        .setRequired(false)
        .addChoices(
          { name: 'Normal',         value: 'Normal'         },
          { name: 'Double Trouble', value: 'Double Trouble' },
        )
    ),

  async execute(interaction, { supabase }) {
    await interaction.deferReply();
    const mapFilter = interaction.options.getString('map');
    const gameMode  = interaction.options.getString('game_mode') ?? null;

    await renderWinRate(interaction, supabase, { mapFilter, gameMode, days: DEFAULT_DAYS });

    const reply = await interaction.fetchReply();
    setSession(reply.id, { mapFilter, gameMode, days: DEFAULT_DAYS });
  },

  async handleComponent(interaction, { supabase }) {
    const session = sessions.get(interaction.message.id) ?? { days: DEFAULT_DAYS };

    if (interaction.customId.startsWith('winrate_map_')) {
      const map = interaction.customId.replace('winrate_map_', '');
      session.mapFilter = map === 'All Maps' ? null : map;
      setSession(interaction.message.id, session);
      await interaction.deferUpdate();
      return renderWinRate(interaction, supabase, session);
    }
  },
};