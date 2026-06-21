const { SlashCommandBuilder, AttachmentBuilder } = require('discord.js');

// ─── /winrate ────────────────────────────────────────────────────────────
// Filterable win rate query: pick a category (dino/vehicle/weapon), a
// specific item, optional server type / game mode / time range filters.
// Returns "Winrate over X period, Y%" plus matching rounds as a pastebin-
// style plain text attachment.
//
// IMPORTANT CAVEAT — current data limitation:
//   - Vehicles/Weapons: win rate here means "rounds where this item was the
//     MVP, what % were SurvivorWin" — an MVP-correlation proxy, NOT true
//     per-item usage win rate (that data doesn't exist in the current
//     payload — no per-player/per-item win-loss tracking).
//   - Dinos: PLACEHOLDER ONLY. No dino identity field exists anywhere in
//     the current round_logs schema. This category will show "no data"
//     against real data until KKG adds a dino field. Use /testwinrate to
//     verify the dino path works once that field exists.

const VEHICLES = ['ATV', 'Golf Cart', 'Jeep', 'Hypercar', 'Pickup Truck', 'Police Car', 'Pumpkin Wagon', 'Buggy', 'Hybrid', 'Banana Car', 'Go-Kart', 'Bush Car', 'Muscle Car', 'Ambulance', 'Tow Truck', 'MRAP', 'Warthog', 'The Hornet', 'Humvee', 'Cyber-Beast', 'Monster Truck', 'Scrapper', 'Lunar Rover'];
const WEAPONS = ['Pistol', 'Shotgun', 'MP5', 'Light Sniper', 'AR-15', 'AK-47', 'Crossbow', 'Heavy Sniper', 'AR-Dino', 'AR-Uni', 'P90', 'Water Gun', 'Raygun', 'Scar', 'Trike Shotgun', 'Minigun', 'IWS 2000', 'LMG', 'Deagle', 'Railgun', 'Plasma Rifle', 'Flamethrower', 'Tri-Beam', 'Scrapyard Shotgun', 'SPAS-12'];
// Placeholder list — no dino field exists in real payload yet
const DINOS = ['T-Rex', 'Pachy', 'Raptor', 'Carno', 'Dilo', 'Baryonyx', 'Cerato', 'Giga', 'Spino', 'Trike', 'Deino', 'Bronto', 'Exoraptor'];

const GAME_MODES = [
  { name: 'All', value: 'all' },
  { name: 'Regular / Casual', value: 'regular' },
  { name: 'Pro', value: 'pro' },
  { name: 'Double Trouble', value: 'doubletrouble' },
];

const TIME_RANGES = [
  { name: 'Past week', value: '7' },
  { name: 'Past month', value: '30' },
  { name: 'Past 3 months', value: '90' },
  { name: 'Past 6 months', value: '180' },
  { name: 'All time', value: 'all' },
];

function buildPastebinTable(rows) {
  const COLUMNS = [
    { key: 'played_at', label: 'Played At', width: 20 },
    { key: 'map', label: 'Map', width: 14 },
    { key: 'round_result', label: 'Result', width: 14 },
    { key: 'game_mode', label: 'Mode', width: 14 },
    { key: 'mvp_equipped_vehicle', label: 'MVP Vehicle', width: 14 },
    { key: 'mvp_equipped_weapon', label: 'MVP Weapon', width: 14 },
    { key: 'mvp_damage', label: 'MVP Dmg', width: 9 },
  ];

  function formatCell(value, width) {
    let str = value === null || value === undefined ? '-' : String(value);
    if (str.length > width) str = str.slice(0, width - 1) + '…';
    return str.padEnd(width);
  }

  function formatTimestamp(ts) {
    return new Date(ts).toISOString().replace('T', ' ').slice(0, 19);
  }

  const header = COLUMNS.map(c => formatCell(c.label, c.width)).join(' | ');
  const separator = COLUMNS.map(c => '-'.repeat(c.width)).join('-+-');
  const lines = rows.map(row =>
    COLUMNS.map(c => formatCell(c.key === 'played_at' ? formatTimestamp(row[c.key]) : row[c.key], c.width)).join(' | ')
  );

  return [header, separator, ...lines].join('\n');
}

async function queryWinRate(supabase, { category, item, serverType, days }) {
  let query = supabase.from('round_logs').select('*');

  if (days !== 'all') {
    const cutoff = new Date(Date.now() - parseInt(days, 10) * 24 * 60 * 60 * 1000);
    query = query.gte('played_at', cutoff.toISOString());
  }

  if (serverType && serverType !== 'all') {
    query = query.eq('game_mode', serverType);
  }

  // Filter by MVP field matching the chosen item (vehicle/weapon only —
  // dino has no field to filter on, handled separately below)
  if (category === 'vehicle') {
    query = query.eq('mvp_equipped_vehicle', item);
  } else if (category === 'weapon') {
    query = query.eq('mvp_equipped_weapon', item);
  }
  // category === 'dino': no field exists, intentionally not filtered —
  // will return empty/all rows depending on data, handled by caller

  const { data, error } = await query.order('played_at', { ascending: true });
  if (error) return null;
  return data ?? [];
}

function computeWinRate(rows) {
  if (rows.length === 0) return null;
  const wins = rows.filter(r => r.round_result === 'SurvivorWin').length;
  return Math.round((wins / rows.length) * 100);
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('winrate')
    .setDescription('Query win rate for a specific dino, vehicle, or weapon')
    .addStringOption(opt =>
      opt.setName('category')
        .setDescription('What to check win rate for')
        .setRequired(true)
        .addChoices(
          { name: 'Dino (placeholder — no data yet)', value: 'dino' },
          { name: 'Vehicle (MVP-correlation)', value: 'vehicle' },
          { name: 'Weapon (MVP-correlation)', value: 'weapon' },
        )
    )
    .addStringOption(opt =>
      opt.setName('item')
        .setDescription('Specific item name')
        .setRequired(true)
        .setAutocomplete(true)
    )
    .addStringOption(opt =>
      opt.setName('game_mode')
        .setDescription('Filter by game mode (default: all)')
        .addChoices(...GAME_MODES.map(s => ({ name: s.name, value: s.value })))
        .setRequired(false)
    )
    .addStringOption(opt =>
      opt.setName('time_range')
        .setDescription('Time period (default: past month)')
        .addChoices(...TIME_RANGES.map(t => ({ name: t.name, value: t.value })))
        .setRequired(false)
    ),

  async autocomplete(interaction) {
    const focused = interaction.options.getFocused(true);
    if (focused.name !== 'item') return interaction.respond([]);

    const category = interaction.options.getString('category');
    const pool = category === 'dino' ? DINOS : category === 'vehicle' ? VEHICLES : category === 'weapon' ? WEAPONS : [];
    const query = focused.value.toLowerCase();

    const matches = pool
      .filter(name => name.toLowerCase().includes(query))
      .slice(0, 25)
      .map(name => ({ name, value: name }));

    return interaction.respond(matches);
  },

  async execute(interaction, { supabase }) {
    await interaction.deferReply();

    const category = interaction.options.getString('category');
    const item = interaction.options.getString('item');
    const serverType = interaction.options.getString('game_mode') ?? 'all';
    const days = interaction.options.getString('time_range') ?? '30';

    if (category === 'dino') {
      return interaction.editReply(
        `❌ Dino win rate isn't available yet — the current round logging doesn't track which dino was played. ` +
        `This is a known gap, flagged for KKG. Once that field exists, this command will work the same way it does for vehicles/weapons, ` +
        `including "most common winning dino against a car/gun" breakdowns.\n\n` +
        `Use \`/testwinrate\` to preview this feature with synthetic data.`
      );
    }

    const rows = await queryWinRate(supabase, { category, item, serverType, days });

    if (rows === null) {
      return interaction.editReply('❌ Something went wrong querying round data.');
    }

    if (rows.length === 0) {
      return interaction.editReply(`No rounds found for **${item}** with the selected filters.`);
    }

    const winRate = computeWinRate(rows);
    const timeLabel = TIME_RANGES.find(t => t.value === days)?.name ?? 'selected period';
    const serverLabel = GAME_MODES.find(s => s.value === serverType)?.name ?? 'All';

    const categoryLabel = category === 'vehicle' ? 'Car' : category === 'weapon' ? 'Gun' : 'Dino';

    // Most common MVP car/gun across DinoWin rounds (general, not tied to a
    // specific dino — that breakdown isn't possible until dino tracking exists)
    const dinoWinRows = rows.filter(r => r.round_result === 'DinoWin');
    const topVehicleCounts = new Map();
    const topWeaponCounts = new Map();
    for (const r of dinoWinRows) {
      if (r.mvp_equipped_vehicle) topVehicleCounts.set(r.mvp_equipped_vehicle, (topVehicleCounts.get(r.mvp_equipped_vehicle) || 0) + 1);
      if (r.mvp_equipped_weapon) topWeaponCounts.set(r.mvp_equipped_weapon, (topWeaponCounts.get(r.mvp_equipped_weapon) || 0) + 1);
    }
    const topVehicle = [...topVehicleCounts.entries()].sort((a, b) => b[1] - a[1])[0];
    const topWeapon = [...topWeaponCounts.entries()].sort((a, b) => b[1] - a[1])[0];

    const mvpBreakdown = dinoWinRows.length > 0
      ? `Most common MVP car in DinoWin rounds: ${topVehicle ? `${topVehicle[0]} (${topVehicle[1]}x)` : 'No data'}\n` +
        `Most common MVP gun in DinoWin rounds: ${topWeapon ? `${topWeapon[0]} (${topWeapon[1]}x)` : 'No data'}\n` +
        `*(not tied to a specific dino — that breakdown needs dino tracking, see /testwinrate for a preview)*`
      : 'No DinoWin rounds in this selection to break down.';

    const summary =
      `**${item} (${categoryLabel}) won ${winRate}% for your selected dates**\n` +
      `${timeLabel} · ${serverLabel} servers · ${rows.length} round${rows.length !== 1 ? 's' : ''}\n` +
      `*(MVP-correlation proxy — not true per-item usage win rate, see /winrate caveats)*\n\n` +
      mvpBreakdown;

    const table = buildPastebinTable(rows);
    const buffer = Buffer.from(table, 'utf8');
    const attachment = new AttachmentBuilder(buffer, { name: `winrate-${item.replace(/\s+/g, '-')}-${Date.now()}.txt` });

    return interaction.editReply({ content: summary, files: [attachment] });
  },
};