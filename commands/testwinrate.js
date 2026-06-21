const { SlashCommandBuilder, AttachmentBuilder } = require('discord.js');

// ─── /testwinrate ────────────────────────────────────────────────────────
// Synthetic-data version of /winrate. Includes a working dino path (with a
// fake dino_name field) and a fake mvp_pickup field, neither of which exist
// in the real schema yet — this lets the full intended format be verified
// before KKG adds those fields. Also includes the same 5000-row sampling
// cap as the real command, with a much higher max round count so the
// sampling behavior can actually be triggered and inspected.

const MAPS = ['Jungle', 'Canyon', 'Cavern', 'Primal Park'];
const VEHICLES = ['ATV', 'Golf Cart', 'Jeep', 'Hypercar', 'Pickup Truck', 'Police Car', 'Pumpkin Wagon'];
const WEAPONS = ['MP5', 'Shotgun', 'AK-47', 'Railgun', 'Deagle', 'Plasma Rifle', 'Crossbow'];
const DINOS = ['T-Rex', 'Pachy', 'Raptor', 'Carno', 'Dilo', 'Giga', 'Spino', 'Trike', 'Exoraptor'];
const GAME_MODES = ['regular', 'pro', 'doubletrouble'];
const PICKUPS = ['Fuel Can', 'Repair Kit', 'Med Kit', 'Dino Tracker', 'Mine'];

const MAX_ATTACHMENT_ROWS = 5000;

function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function randInt(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }

function generateFakeRound(daysAgo) {
  const playedAt = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000 - randInt(0, 23) * 60 * 60 * 1000);
  return {
    played_at: playedAt.toISOString(),
    map: pick(MAPS),
    round_result: Math.random() < 0.5 ? 'DinoWin' : 'SurvivorWin',
    game_mode: pick(GAME_MODES),
    dino_name: pick(DINOS),           // fake field — doesn't exist in real schema yet
    mvp_equipped_vehicle: pick(VEHICLES),
    mvp_equipped_weapon: pick(WEAPONS),
    mvp_pickup: pick(PICKUPS),         // fake field — doesn't exist in real schema yet
    mvp_damage: randInt(100, 2000),
  };
}

function capAndSample(rows) {
  if (rows.length <= MAX_ATTACHMENT_ROWS) {
    return { rows, sampled: false, originalCount: rows.length };
  }
  const step = rows.length / MAX_ATTACHMENT_ROWS;
  const sampled = [];
  for (let i = 0; i < MAX_ATTACHMENT_ROWS; i++) {
    sampled.push(rows[Math.floor(i * step)]);
  }
  return { rows: sampled, sampled: true, originalCount: rows.length };
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
    { key: 'mvp_pickup', label: 'MVP Pickup', width: 12 },
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
    .setDescription('Test /winrate with synthetic data, including dino + pickups (not yet real)')
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
        .setDescription('Number of matching rounds to generate (default 50, max 10000 to test sampling cap)')
        .setMinValue(1)
        .setMaxValue(10000)
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
    const requestedCount = interaction.options.getInteger('rounds') ?? 50;

    // Generate exactly the requested number of MATCHING rounds for this
    // item — mirrors real /winrate, which returns every round that matches.
    const matching = [];
    for (let i = 0; i < requestedCount; i++) {
      const round = generateFakeRound(randInt(0, 180));
      if (category === 'dino') round.dino_name = item;
      else if (category === 'vehicle') round.mvp_equipped_vehicle = item;
      else round.mvp_equipped_weapon = item;
      matching.push(round);
    }

    matching.sort((a, b) => new Date(a.played_at) - new Date(b.played_at));

    const wins = matching.filter(r => r.round_result === 'SurvivorWin').length;
    const winRate = Math.round((wins / matching.length) * 100);
    const categoryLabel = category === 'vehicle' ? 'Car' : category === 'weapon' ? 'Gun' : 'Dino';

    const mapCounts = new Map();
    for (const r of matching) {
      if (r.map) mapCounts.set(r.map, (mapCounts.get(r.map) || 0) + 1);
    }
    const topMap = [...mapCounts.entries()].sort((a, b) => b[1] - a[1])[0];
    const mapLine = `Most common map: ${topMap ? `${topMap[0]} (${topMap[1]}x)` : 'No data'}`;

    let breakdown;
    if (category === 'dino') {
      const dinoWins = matching.filter(r => r.round_result === 'DinoWin');
      const vCounts = new Map(), wCounts = new Map(), pCounts = new Map();
      for (const r of dinoWins) {
        if (r.mvp_equipped_vehicle) vCounts.set(r.mvp_equipped_vehicle, (vCounts.get(r.mvp_equipped_vehicle) || 0) + 1);
        if (r.mvp_equipped_weapon) wCounts.set(r.mvp_equipped_weapon, (wCounts.get(r.mvp_equipped_weapon) || 0) + 1);
        if (r.mvp_pickup) pCounts.set(r.mvp_pickup, (pCounts.get(r.mvp_pickup) || 0) + 1);
      }
      const topV = [...vCounts.entries()].sort((a, b) => b[1] - a[1])[0];
      const topW = [...wCounts.entries()].sort((a, b) => b[1] - a[1])[0];
      const topP = [...pCounts.entries()].sort((a, b) => b[1] - a[1])[0];
      breakdown =
        `Most common MVP car when ${item} won: ${topV ? `${topV[0]} (${topV[1]}x)` : 'No data'}\n` +
        `Most common MVP gun when ${item} won: ${topW ? `${topW[0]} (${topW[1]}x)` : 'No data'}\n` +
        `Most common pickup: ${topP ? `${topP[0]} (${topP[1]}x)` : 'No data'}\n` +
        mapLine;
    } else {
      const itemWinRounds = matching.filter(r => r.round_result === 'DinoWin');
      const dCounts = new Map(), coCounts = new Map(), pCounts = new Map();
      for (const r of itemWinRounds) {
        if (r.dino_name) dCounts.set(r.dino_name, (dCounts.get(r.dino_name) || 0) + 1);
        if (category === 'vehicle' && r.mvp_equipped_weapon) coCounts.set(r.mvp_equipped_weapon, (coCounts.get(r.mvp_equipped_weapon) || 0) + 1);
        if (category === 'weapon' && r.mvp_equipped_vehicle) coCounts.set(r.mvp_equipped_vehicle, (coCounts.get(r.mvp_equipped_vehicle) || 0) + 1);
        if (r.mvp_pickup) pCounts.set(r.mvp_pickup, (pCounts.get(r.mvp_pickup) || 0) + 1);
      }
      const topD = [...dCounts.entries()].sort((a, b) => b[1] - a[1])[0];
      const topCo = [...coCounts.entries()].sort((a, b) => b[1] - a[1])[0];
      const topP = [...pCounts.entries()].sort((a, b) => b[1] - a[1])[0];
      const coLabel = category === 'vehicle' ? 'gun alongside this car' : 'car alongside this gun';

      breakdown =
        `Most common winning dino when ${item} was MVP: ${topD ? `${topD[0]} (${topD[1]}x)` : 'No data'}\n` +
        `Most common ${coLabel}: ${topCo ? `${topCo[0]} (${topCo[1]}x)` : 'No data'}\n` +
        `Most common pickup: ${topP ? `${topP[0]} (${topP[1]}x)` : 'No data'}\n` +
        mapLine;
    }

    const summary =
      `*(test data)* **${item} (${categoryLabel}) won ${winRate}% for your selected dates**\n` +
      `${matching.length} round${matching.length !== 1 ? 's' : ''} generated\n\n` +
      breakdown;

    const { rows: tableRows, sampled, originalCount } = capAndSample(matching);
    const table = buildPastebinTable(tableRows, category === 'dino');
    const buffer = Buffer.from(table, 'utf8');
    const attachment = new AttachmentBuilder(buffer, { name: `test-winrate-${item.replace(/\s+/g, '-')}-${Date.now()}.txt` });

    const finalSummary = sampled
      ? `${summary}\n\n📊 *Attachment shows an evenly-sampled ${tableRows.length} of ${originalCount} total matching rounds (file size cap). The ${winRate}% win rate above is calculated from all ${originalCount} rounds, not just the sample.*`
      : summary;

    await interaction.channel.send({ content: finalSummary, files: [attachment] }).catch(err => {
      console.error('[testwinrate] send failed:', err.message);
    });

    return interaction.editReply('Posted test winrate query above.');
  },
};