const { SlashCommandBuilder, AttachmentBuilder } = require('discord.js');
const { buildGameStatsOverviewCard, buildTierListCard, MAP_COLORS } = require('../modules/chart');

// ─── /gamestats ───────────────────────────────────────────────────────────────
// Win rate + top 10 dinos/vehicles/weapons breakdown by lobby type.
// Sent as four separate cards: overview, dinos, vehicles, weapons.
//
// Lobby types:
//   main     — 12076775711  (main game, default)
//   pro      — 16060525458  (pro lobbies)
//   training — 100026158235338 (training lobbies, opt-in only)
//
// Win % methodology:
//   Dinos    — DinoWin % in rounds where that dino was present (presence proxy)
//   Vehicles — SurvivorWin % in rounds where this vehicle was the MVP
//   Weapons  — SurvivorWin % in rounds where this weapon was the MVP
//   All show sample size prominently; < 20 rounds flagged with ⚠

const LOBBY_TYPES = [
  { name: 'Main Game',        value: 'main',     placeId: '12076775711'      },
  { name: 'Pro Lobbies',      value: 'pro',      placeId: '16060525458'      },
  { name: 'Training Lobbies', value: 'training', placeId: '100026158235338'  },
];

const TIME_RANGES = [
  { name: 'Past Week',    value: '7'   },
  { name: 'Past Month',   value: '30'  },
  { name: 'Past Quarter', value: '90'  },
  { name: 'Past Year',    value: '365' },
  { name: 'All Time',     value: 'all' },
];

// ── Data fetching ─────────────────────────────────────────────────────────────
async function fetchRows(supabase, placeId, days, minLevel = null, maxLevel = null) {
  let query = supabase
    .from('round_logs')
    .select('round_result, map, game_mode, mvp_equipped_weapon, mvp_equipped_vehicle, dinosaurs_used, average_level')
    .eq('place_id', placeId)
    .limit(100000);

  if (days !== 'all') {
    const cutoff = new Date(Date.now() - parseInt(days, 10) * 24 * 60 * 60 * 1000);
    query = query.gte('played_at', cutoff.toISOString());
  }

  if (minLevel !== null) query = query.gte('average_level', minLevel);
  if (maxLevel !== null) query = query.lte('average_level', maxLevel);

  const { data, error } = await query;
  if (error || !data) return null;
  return data;
}

// ── Stat builders ─────────────────────────────────────────────────────────────
function buildOverviewStats(rows) {
  const total        = rows.length;
  const dinoWins     = rows.filter(r => r.round_result === 'DinoWin').length;
  const survivorWins = total - dinoWins;
  const dinoWinPct   = total > 0 ? Math.round((dinoWins / total) * 100) : 0;
  const survWinPct   = 100 - dinoWinPct;

  // Per-map breakdown
  const maps = ['Jungle', 'Canyon', 'Cavern', 'Primal Park'];
  const mapLines = maps.map(map => {
    const mapRows = rows.filter(r => r.map === map);
    if (mapRows.length === 0) return null;
    const mDino = mapRows.filter(r => r.round_result === 'DinoWin').length;
    const mPct  = Math.round((mDino / mapRows.length) * 100);
    const low   = mapRows.length < 20 ? ' ⚠' : '';
    return `${map}: Dino ${mPct}% / Surv ${100 - mPct}% (${mapRows.length}r${low})`;
  }).filter(Boolean);

  // Game mode breakdown
  const normal    = rows.filter(r => r.game_mode === 'Normal');
  const dt        = rows.filter(r => r.game_mode === 'Double Trouble');
  const normalPct = normal.length > 0 ? Math.round((normal.filter(r => r.round_result === 'DinoWin').length / normal.length) * 100) : null;
  const dtPct     = dt.length > 0     ? Math.round((dt.filter(r => r.round_result === 'DinoWin').length / dt.length) * 100) : null;

  const modePanelLines = [
    normalPct !== null ? `Normal: Dino ${normalPct}% / Surv ${100 - normalPct}% (${normal.length}r)` : null,
    dtPct     !== null ? `Double Trouble: Dino ${dtPct}% / Surv ${100 - dtPct}% (${dt.length}r)` : null,
  ].filter(Boolean);

  return {
    total, dinoWins, survivorWins, dinoWinPct, survWinPct,
    mapLines, modePanelLines,
  };
}

function buildDinoStats(rows, limit = 10) {
  const counts = new Map(); // dino → { dinoWins, total }
  for (const row of rows) {
    const dinos = Array.isArray(row.dinosaurs_used)
      ? row.dinosaurs_used
      : (row.dinosaurs_used ? [row.dinosaurs_used] : []);
    for (const d of dinos) {
      if (!counts.has(d)) counts.set(d, { dinoWins: 0, total: 0 });
      const c = counts.get(d);
      c.total++;
      if (row.round_result === 'DinoWin') c.dinoWins++;
    }
  }

  return [...counts.entries()]
    .filter(([, c]) => c.total >= 5) // minimum sample
    .map(([name, c]) => ({
      name,
      count: c.total,
      winPct: Math.round((c.dinoWins / c.total) * 100),
      lowSample: c.total < 20,
    }))
    .sort((a, b) => b.winPct - a.winPct || b.count - a.count)
    .slice(0, limit);
}

function buildMvpStats(rows, field, limit = 10) {
  // field: 'mvp_equipped_weapon' or 'mvp_equipped_vehicle'
  // Win rate = SurvivorWin % when this item was MVP
  const counts = new Map();
  for (const row of rows) {
    const item = row[field];
    if (!item) continue;
    if (!counts.has(item)) counts.set(item, { survivorWins: 0, total: 0 });
    const c = counts.get(item);
    c.total++;
    if (row.round_result === 'SurvivorWin') c.survivorWins++;
  }

  return [...counts.entries()]
    .filter(([, c]) => c.total >= 5)
    .map(([name, c]) => ({
      name,
      count: c.total,
      winPct: Math.round((c.survivorWins / c.total) * 100),
      lowSample: c.total < 20,
    }))
    .sort((a, b) => b.winPct - a.winPct || b.count - a.count)
    .slice(0, limit);
}

// ── Card builders ─────────────────────────────────────────────────────────────
async function buildOverviewCard(stats, rows, lobbyLabel, lookback) {
  const { total, dinoWins, survivorWins } = stats;

  const MAPS = ['Jungle', 'Canyon', 'Cavern', 'Primal Park'];
  const mapData = MAPS.map(name => {
    const mapRows     = rows.filter(r => r.map === name);
    const mDinoWins   = mapRows.filter(r => r.round_result === 'DinoWin').length;
    return { name, dinoWins: mDinoWins, survivorWins: mapRows.length - mDinoWins, total: mapRows.length };
  }).filter(m => m.total > 0);

  const modeMap = new Map();
  for (const r of rows) {
    const m = r.game_mode ?? 'Unknown';
    if (!modeMap.has(m)) modeMap.set(m, { dinoWins: 0, survivorWins: 0, total: 0 });
    const mc = modeMap.get(m);
    mc.total++;
    if (r.round_result === 'DinoWin') mc.dinoWins++; else mc.survivorWins++;
  }
  const modeData = [...modeMap.entries()].map(([name, c]) => ({ name, ...c }));

  return buildGameStatsOverviewCard({
    title:        `${lobbyLabel} — Win Rate Overview`,
    subtitle:     `Primal Pursuit · ${lookback}`,
    lookback,
    totalRounds:  total,
    dinoWins,
    survivorWins,
    maps:         mapData,
    modes:        modeData,
  });
}

async function buildDinoCard(dinoStats, lobbyLabel, lookback) {
  // Convert to tierlist format: name + count (using winPct as display value)
  // We show winPct in the name since tierlist sorts by count
  const items = dinoStats.map(d => ({
    name:  `${d.name}${d.lowSample ? ' ⚠' : ''} (${d.count}r)`,
    count: d.winPct,
  }));

  const totalRounds = dinoStats.reduce((s, d) => s + d.count, 0);

  return buildTierListCard({
    title:       `${lobbyLabel} — Dino Win Rate`,
    subtitle:    `Primal Pursuit · ${lookback} · Presence-based`,
    stats: [
      { label: 'Dinos Tracked', value: dinoStats.length.toString(), color: '#ED4245' },
    ],
    lookback,
    items,
    accentColor: '#ED4245',
    unit: '%',
  });
}

async function buildMvpCard(mvpStats, type, lobbyLabel, lookback) {
  const color     = type === 'vehicle' ? '#5865F2' : '#ED4245';
  const typeLabel = type === 'vehicle' ? 'Vehicle' : 'Weapon';
  const winSide   = 'Survivor Win'; // MVP win rate = survivor win when this item is MVP

  const items = mvpStats.map(d => ({
    name:  `${d.name}${d.lowSample ? ' ⚠' : ''} (${d.count}r)`,
    count: d.winPct,
  }));

  return buildTierListCard({
    title:       `${lobbyLabel} — Top ${typeLabel}s`,
    subtitle:    `Primal Pursuit · ${lookback} · MVP ${winSide} %`,
    stats: [
      { label: `${typeLabel}s Tracked`, value: mvpStats.length.toString(), color },
    ],
    lookback,
    items,
    accentColor: color,
    unit: '%',
  });
}

// ── Command ───────────────────────────────────────────────────────────────────
module.exports = {
  data: new SlashCommandBuilder()
    .setName('gamestats')
    .setDescription('Win rate and top performers by lobby type')
    .addStringOption(opt =>
      opt.setName('lobby')
        .setDescription('Lobby type to analyse')
        .setRequired(true)
        .addChoices(...LOBBY_TYPES.map(l => ({ name: l.name, value: l.value })))
    )
    .addStringOption(opt =>
      opt.setName('time_range')
        .setDescription('Time period (default: past month)')
        .setRequired(false)
        .addChoices(...TIME_RANGES.map(t => ({ name: t.name, value: t.value })))
    )
    .addIntegerOption(opt =>
      opt.setName('min_level')
        .setDescription('Minimum average player level to include (e.g. 40 excludes beginner rounds)')
        .setMinValue(1)
        .setMaxValue(1000)
        .setRequired(false)
    )
    .addIntegerOption(opt =>
      opt.setName('max_level')
        .setDescription('Maximum average player level to include (e.g. 100 excludes high-level rounds)')
        .setMinValue(1)
        .setMaxValue(1000)
        .setRequired(false)
    ),

  async execute(interaction, { supabase }) {
    await interaction.deferReply();

    const lobbyValue = interaction.options.getString('lobby');
    const days       = interaction.options.getString('time_range') ?? '30';
    const minLevel   = interaction.options.getInteger('min_level') ?? null;
    const maxLevel   = interaction.options.getInteger('max_level') ?? null;

    const lobby = LOBBY_TYPES.find(l => l.value === lobbyValue);
    if (!lobby) return interaction.editReply('❌ Invalid lobby type.');

    const rows = await fetchRows(supabase, lobby.placeId, days, minLevel, maxLevel);

    if (rows === null) {
      return interaction.editReply('❌ Something went wrong fetching round data.');
    }
    if (rows.length === 0) {
      return interaction.editReply(`No round data found for **${lobby.name}** in the selected time range.`);
    }

    const baseLookback = days === 'all' ? 'All Time' : `Past ${TIME_RANGES.find(t => t.value === days)?.name.replace('Past ', '') ?? days + ' Days'}`;
    const levelSuffix  = minLevel || maxLevel
      ? ` · Lvl ${minLevel ?? 1}–${maxLevel ?? '∞'}`
      : '';
    const lookback = baseLookback + levelSuffix;
    const lobbyLabel  = lobby.name;

    const overviewStats = buildOverviewStats(rows);
    const dinoStats     = buildDinoStats(rows);
    const vehicleStats  = buildMvpStats(rows, 'mvp_equipped_vehicle');
    const weaponStats   = buildMvpStats(rows, 'mvp_equipped_weapon');

    // Build all four cards
    const [overviewBuf, dinoBuf, vehicleBuf, weaponBuf] = await Promise.all([
      buildOverviewCard(overviewStats, rows, lobbyLabel, lookback),
      buildDinoCard(dinoStats,     lobbyLabel, lookback),
      buildMvpCard(vehicleStats, 'vehicle', lobbyLabel, lookback),
      buildMvpCard(weaponStats,  'weapon',  lobbyLabel, lookback),
    ]);

    // Send overview as the reply, then follow up with the three tier lists
    await interaction.editReply({
      content: `**${lobbyLabel} Stats** — ${lookback} · ${rows.length.toLocaleString()} rounds`,
      files: [new AttachmentBuilder(overviewBuf, { name: 'gamestats-overview.png' })],
    });

    await interaction.followUp({
      files: [new AttachmentBuilder(dinoBuf, { name: 'gamestats-dinos.png' })],
    });

    await interaction.followUp({
      files: [new AttachmentBuilder(vehicleBuf, { name: 'gamestats-vehicles.png' })],
    });

    await interaction.followUp({
      files: [new AttachmentBuilder(weaponBuf, { name: 'gamestats-weapons.png' })],
    });
  },
};