const { SlashCommandBuilder, AttachmentBuilder } = require('discord.js');

// ─── /testwinrate ────────────────────────────────────────────────────────
// Synthetic-data version of /winrate. Unlike the real command, this
// includes a working dino path (with a fake dino_name field) so the full
// query/filter/output format can be verified before KKG adds real dino
// tracking. Once that field is live, /winrate's dino branch can be wired
// up to match this same logic.

const MAPS = ['Jungle', 'Canyon', 'Cavern', 'Primal Park'];
const VEHICLES = ['ATV', 'Golf Cart', 'Jeep', 'Hypercar', 'Pickup Truck', 'Police Car', 'Pumpkin Wagon'];
const WEAPONS = ['MP5', 'Shotgun', 'AK-47', 'Railgun', 'Deagle', 'Plasma Rifle', 'Crossbow'];
const DINOS = ['T-Rex', 'Pachy', 'Raptor', 'Carno', 'Dilo', 'Giga', 'Spino', 'Trike', 'Exoraptor'];
const GAME_MODES = ['regular', 'pro', 'doubletrouble'];

function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function randInt(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }

const PICKUPS = ['Fuel Can', 'Repair Kit', 'Med Kit', 'Dino Tracker', 'Mine'];

function generateFakeRound(daysAgo) {
  const playedAt = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000 - randInt(0, 23) * 60 * 60 * 1000);
  return {
    played_at: playedAt.toISOString(),
    map: pick(MAPS),
    round_result: Math.random() < 0.5 ? 'DinoWin' : 'SurvivorWin',
    game_mode: pick(GAME_MODES),
    dino_name: pick(DINOS), // fake field — doesn't exist in real schema yet
    mvp_equipped_vehicle: pick(VEHICLES),
    mvp_equipped_weapon: pick(WEAPONS),
    mvp_pickup: pick(PICKUPS), // fake field — doesn't exist in real schema yet
    mvp_damage: randInt(100, 2000),
  };
}

function buildPastebinTable(rows, includeDino) {
  const COLUMNS = [
    { key: 'played_at', label: 'Played At', width: 20 },
    { key: 'map', label: 'Map', width: 14 },
    { key: 'round_result', label: 'Result', width: 14 },
    { key: 'game_mode', label: 'Mode', width: 14 },
    ...(includeDino ? [{ key: 'dino_name', label: 'Dino', width: 12 }] : []),
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

module.exports = {
  data: new SlashCommandBuilder()
    .setName('testwinrate')
    .setDescription('Test /winrate with synthetic data, including dino (not yet real)')
    .addStringOption(opt =>
      opt.setName('category')
        .setDescription('What to check win rate for')
        .setRequired(true)
        .addChoices(
          { name: 'Dino', value: 'dino' },
          { name: 'Vehicle', value: 'vehicle' },
          { name: 'Weapon', value: 'weapon' },
        )
    )
    .addStringOption(opt =>
      opt.setName('item')
        .setDescription('Specific item name')
        .setRequired(true)
        .setAutocomplete(true)
    )
    .addIntegerOption(opt =>
      opt.setName('rounds')
        .setDescription('Number of synthetic rounds to generate (default 200)')
        .setMinValue(10)
        .setMaxValue(1000)
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

  async execute(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const category = interaction.options.getString('category');
    const item = interaction.options.getString('item');
    const roundCount = interaction.options.getInteger('rounds') ?? 200;

    const allRows = [];
    for (let i = 0; i < roundCount; i++) {
      allRows.push(generateFakeRound(randInt(0, 90)));
    }

    let matching;
    if (category === 'dino') {
      matching = allRows.filter(r => r.dino_name === item);
    } else if (category === 'vehicle') {
      matching = allRows.filter(r => r.mvp_equipped_vehicle === item);
    } else {
      matching = allRows.filter(r => r.mvp_equipped_weapon === item);
    }

    matching.sort((a, b) => new Date(a.played_at) - new Date(b.played_at));

    if (matching.length === 0) {
      return interaction.editReply(`No synthetic rounds matched **${item}** — try again, or increase rounds.`);
    }

    const wins = matching.filter(r => r.round_result === 'SurvivorWin').length;
    const winRate = Math.round((wins / matching.length) * 100);

    const categoryLabel = category === 'vehicle' ? 'Car' : category === 'weapon' ? 'Gun' : 'Dino';

    let breakdown = '';

    const mapCounts = new Map();
    for (const r of matching) {
      if (r.map) mapCounts.set(r.map, (mapCounts.get(r.map) || 0) + 1);
    }
    const topMap = [...mapCounts.entries()].sort((a, b) => b[1] - a[1])[0];
    const mapLine = `Most common map: ${topMap ? `${topMap[0]} (${topMap[1]}x)` : 'No data'}`;

    if (category === 'dino') {
      const dinoWins = matching.filter(r => r.round_result === 'DinoWin');
      const vCounts = new Map();
      const wCounts = new Map();
      for (const r of dinoWins) {
        if (r.mvp_equipped_vehicle) vCounts.set(r.mvp_equipped_vehicle, (vCounts.get(r.mvp_equipped_vehicle) || 0) + 1);
        if (r.mvp_equipped_weapon) wCounts.set(r.mvp_equipped_weapon, (wCounts.get(r.mvp_equipped_weapon) || 0) + 1);
      }
      const topV = [...vCounts.entries()].sort((a, b) => b[1] - a[1])[0];
      const topW = [...wCounts.entries()].sort((a, b) => b[1] - a[1])[0];
      breakdown =
        `Most common MVP car when ${item} won: ${topV ? `${topV[0]} (${topV[1]}x)` : 'No data'}\n` +
        `Most common MVP gun when ${item} won: ${topW ? `${topW[0]} (${topW[1]}x)` : 'No data'}\n` +
        mapLine;
    } else {
      const itemWinRounds = matching.filter(r => r.round_result === 'DinoWin');
      const dCounts = new Map();
      const coCounts = new Map(); // co-occurring weapon or vehicle
      for (const r of itemWinRounds) {
        if (r.dino_name) dCounts.set(r.dino_name, (dCounts.get(r.dino_name) || 0) + 1);
        if (category === 'vehicle' && r.mvp_equipped_weapon) coCounts.set(r.mvp_equipped_weapon, (coCounts.get(r.mvp_equipped_weapon) || 0) + 1);
        if (category === 'weapon' && r.mvp_equipped_vehicle) coCounts.set(r.mvp_equipped_vehicle, (coCounts.get(r.mvp_equipped_vehicle) || 0) + 1);
      }
      const topD = [...dCounts.entries()].sort((a, b) => b[1] - a[1])[0];
      const topCo = [...coCounts.entries()].sort((a, b) => b[1] - a[1])[0];
      const coLabel = category === 'vehicle' ? 'gun alongside this car' : 'car alongside this gun';

      const pickupCounts = new Map();
      for (const r of itemWinRounds) {
        if (r.mvp_pickup) pickupCounts.set(r.mvp_pickup, (pickupCounts.get(r.mvp_pickup) || 0) + 1);
      }
      const topPickup = [...pickupCounts.entries()].sort((a, b) => b[1] - a[1])[0];

      breakdown =
        `Most common winning dino when ${item} was MVP: ${topD ? `${topD[0]} (${topD[1]}x)` : 'No data'}\n` +
        `Most common ${coLabel}: ${topCo ? `${topCo[0]} (${topCo[1]}x)` : 'No data'}\n` +
        `Most common pickup: ${topPickup ? `${topPickup[0]} (${topPickup[1]}x)` : 'No data'}\n` +
        mapLine;
    }

    const summary =
      `*(test data)* **${item} (${categoryLabel}) won ${winRate}% for your selected dates**\n` +
      `${matching.length} round${matching.length !== 1 ? 's' : ''} out of ${roundCount} generated\n\n` +
      breakdown;

    const table = buildPastebinTable(matching, category === 'dino');
    const buffer = Buffer.from(table, 'utf8');
    const attachment = new AttachmentBuilder(buffer, { name: `test-winrate-${item.replace(/\s+/g, '-')}-${Date.now()}.txt` });

    await interaction.channel.send({ content: summary, files: [attachment] }).catch(err => {
      console.error('[testwinrate] send failed:', err.message);
    });

    return interaction.editReply('Posted test winrate query above.');
  },
};