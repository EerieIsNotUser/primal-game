const { SlashCommandBuilder, AttachmentBuilder } = require('discord.js');
const chrono = require('chrono-node');
const { buildStatCard } = require('../modules/chart');

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

// Parse a natural-language date range like "January 15th through March 16th" —
// same logic as real /winrate. Returns { startDate, endDate } or null.
function parseDateRange(text) {
  const results = chrono.parse(text, new Date());
  if (results.length === 0) return null;
  const result = results[0];
  const startDate = result.start ? result.start.date() : null;
  const endDate = result.end ? result.end.date() : (result.start ? result.start.date() : null);
  if (!startDate) return null;
  return { startDate, endDate: endDate ?? startDate };
}

// Generate a played_at timestamp within a specific date range
function randomTimestampInRange(startDate, endDate) {
  const startMs = startDate.getTime();
  const endMs = endDate.getTime();
  return new Date(startMs + Math.random() * (endMs - startMs));
}

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
    { key: 'server_type', label: 'Server', width: 9 },
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
    .addStringOption(opt =>
      opt.setName('server_type')
        .setDescription('Server type to filter by')
        .setRequired(true)
        .addChoices(
          { name: 'Regular', value: 'regular' },
          { name: 'Pro', value: 'pro' },
        )
    )
    .addStringOption(opt =>
      opt.setName('game_mode')
        .setDescription('Game mode to filter by')
        .setRequired(true)
        .addChoices(
          { name: 'Standard', value: 'standard' },
          { name: 'Double Trouble', value: 'doubletrouble' },
        )
    )
    .addStringOption(opt =>
      opt.setName('dates')
        .setDescription('Natural date range, e.g. "January 15th through March 16th" (default: scattered across past 180 days)')
        .setRequired(false)
    )
    .addStringOption(opt =>
      opt.setName('result_filter')
        .setDescription('Only show rounds with this outcome (default: both)')
        .setRequired(false)
        .addChoices(
          { name: 'Dino Wins only', value: 'DinoWin' },
          { name: 'Survivor Wins only', value: 'SurvivorWin' },
        )
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
    const serverType = interaction.options.getString('server_type');
    const gameMode = interaction.options.getString('game_mode');
    const datesInput = interaction.options.getString('dates');
    const resultFilter = interaction.options.getString('result_filter');
    const requestedCount = interaction.options.getInteger('rounds') ?? 50;

    let dateRange = null;
    if (datesInput) {
      dateRange = parseDateRange(datesInput);
      if (!dateRange) {
        return interaction.editReply(
          `❌ Couldn't understand the date range "${datesInput}". Try something like ` +
          `"January 15th through March 16th" or "last 2 weeks".`
        );
      }
    }

    // Generate exactly the requested number of MATCHING rounds for this
    // item — mirrors real /winrate, which returns every round that matches.
    // Unlike real /winrate, this CAN combine server_type + game_mode
    // (e.g. Pro + Double Trouble) since it's synthetic — previews the
    // feature ahead of the real schema supporting it.
    const matching = [];
    for (let i = 0; i < requestedCount; i++) {
      const round = dateRange
        ? { ...generateFakeRound(0), played_at: randomTimestampInRange(dateRange.startDate, dateRange.endDate).toISOString() }
        : generateFakeRound(randInt(0, 180));
      if (category === 'dino') round.dino_name = item;
      else if (category === 'vehicle') round.mvp_equipped_vehicle = item;
      else round.mvp_equipped_weapon = item;
      round.server_type = serverType;
      round.game_mode = gameMode;
      matching.push(round);
    }

    let filtered = matching;
    if (resultFilter) {
      filtered = matching.filter(r => r.round_result === resultFilter);
      if (filtered.length === 0) {
        return interaction.editReply(`No generated rounds matched the result filter (${resultFilter}) — try again, or increase rounds.`);
      }
    }
    filtered.sort((a, b) => new Date(a.played_at) - new Date(b.played_at));

    const wins = filtered.filter(r => r.round_result === 'SurvivorWin').length;
    const winRate = Math.round((wins / filtered.length) * 100);
    const categoryLabel = category === 'vehicle' ? 'Car' : category === 'weapon' ? 'Gun' : 'Dino';

    const mapCounts = new Map();
    for (const r of filtered) {
      if (r.map) mapCounts.set(r.map, (mapCounts.get(r.map) || 0) + 1);
    }
    const topMap = [...mapCounts.entries()].sort((a, b) => b[1] - a[1])[0];

    // Map breakdown only makes sense as win/loss for dino category — for
    // vehicle/weapon, "won"/"lost" refers to the item's own MVP correlation,
    // which is already covered elsewhere, so general map stays as-is there.
    let mapLine;
    if (category === 'dino') {
      const wonRows = filtered.filter(r => r.round_result === 'DinoWin');
      const lostRows = filtered.filter(r => r.round_result === 'SurvivorWin');

      const wonMapCounts = new Map();
      for (const r of wonRows) {
        if (r.map) wonMapCounts.set(r.map, (wonMapCounts.get(r.map) || 0) + 1);
      }
      const lostMapCounts = new Map();
      for (const r of lostRows) {
        if (r.map) lostMapCounts.set(r.map, (lostMapCounts.get(r.map) || 0) + 1);
      }
      const topWonMap = [...wonMapCounts.entries()].sort((a, b) => b[1] - a[1])[0];
      const topLostMap = [...lostMapCounts.entries()].sort((a, b) => b[1] - a[1])[0];

      mapLine =
        `Most common map overall: ${topMap ? `${topMap[0]} (${topMap[1]}x)` : 'No data'}\n` +
        `Most common map when ${item} won: ${topWonMap ? `${topWonMap[0]} (${topWonMap[1]}x)` : 'No data'}\n` +
        `Most common map when ${item} lost: ${topLostMap ? `${topLostMap[0]} (${topLostMap[1]}x)` : 'No data'}`;
    } else {
      mapLine = `Most common map: ${topMap ? `${topMap[0]} (${topMap[1]}x)` : 'No data'}`;
    }

    let breakdown;
    let breakdownData = {};
    if (category === 'dino') {
      const dinoWins = filtered.filter(r => r.round_result === 'DinoWin');
      const dinoLosses = filtered.filter(r => r.round_result === 'SurvivorWin');

      const vCounts = new Map(), wCounts = new Map(), pCounts = new Map();
      for (const r of dinoWins) {
        if (r.mvp_equipped_vehicle) vCounts.set(r.mvp_equipped_vehicle, (vCounts.get(r.mvp_equipped_vehicle) || 0) + 1);
        if (r.mvp_equipped_weapon) wCounts.set(r.mvp_equipped_weapon, (wCounts.get(r.mvp_equipped_weapon) || 0) + 1);
        if (r.mvp_pickup) pCounts.set(r.mvp_pickup, (pCounts.get(r.mvp_pickup) || 0) + 1);
      }
      const topV = [...vCounts.entries()].sort((a, b) => b[1] - a[1])[0];
      const topW = [...wCounts.entries()].sort((a, b) => b[1] - a[1])[0];
      const topP = [...pCounts.entries()].sort((a, b) => b[1] - a[1])[0];

      // Same breakdown, but for rounds where this dino LOST (survivors won)
      const lvCounts = new Map(), lwCounts = new Map();
      for (const r of dinoLosses) {
        if (r.mvp_equipped_vehicle) lvCounts.set(r.mvp_equipped_vehicle, (lvCounts.get(r.mvp_equipped_vehicle) || 0) + 1);
        if (r.mvp_equipped_weapon) lwCounts.set(r.mvp_equipped_weapon, (lwCounts.get(r.mvp_equipped_weapon) || 0) + 1);
      }
      const topLV = [...lvCounts.entries()].sort((a, b) => b[1] - a[1])[0];
      const topLW = [...lwCounts.entries()].sort((a, b) => b[1] - a[1])[0];

      breakdown =
        `Most common MVP car when ${item} won: ${topV ? `${topV[0]} (${topV[1]}x)` : 'No data'}\n` +
        `Most common MVP gun when ${item} won: ${topW ? `${topW[0]} (${topW[1]}x)` : 'No data'}\n` +
        `Most common pickup: ${topP ? `${topP[0]} (${topP[1]}x)` : 'No data'}\n` +
        `Most common MVP car when ${item} lost: ${topLV ? `${topLV[0]} (${topLV[1]}x)` : 'No data'}\n` +
        `Most common MVP gun when ${item} lost: ${topLW ? `${topLW[0]} (${topLW[1]}x)` : 'No data'}\n` +
        mapLine;
      breakdownData = {
        wonCar:  topV  ? `${topV[0]} (${topV[1]}x)`   : 'No data',
        wonGun:  topW  ? `${topW[0]} (${topW[1]}x)`   : 'No data',
        lostCar: topLV ? `${topLV[0]} (${topLV[1]}x)` : 'No data',
        lostGun: topLW ? `${topLW[0]} (${topLW[1]}x)` : 'No data',
        pickup:  topP  ? `${topP[0]} (${topP[1]}x)`   : 'No data',
      };
    } else {
      const itemWinRounds = filtered.filter(r => r.round_result === 'DinoWin');
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
      breakdownData = {
        topDino: topD  ? `${topD[0]} (${topD[1]}x)`   : 'No data',
        coItem:  topCo ? `${topCo[0]} (${topCo[1]}x)` : 'No data',
        coLabel: category === 'vehicle' ? 'Co-occurring Gun' : 'Co-occurring Car',
        pickup:  topP  ? `${topP[0]} (${topP[1]}x)`   : 'No data',
      };
    }

    // Generate a comparable "previous period" batch for the same item to
    // simulate a baseline — same pattern as real /winrate's all-time comparison.
    const baselineCount = randInt(Math.floor(requestedCount * 0.5), requestedCount * 2);
    const baseline = [];
    for (let i = 0; i < baselineCount; i++) {
      const round = generateFakeRound(randInt(180, 360)); // older period
      if (category === 'dino') round.dino_name = item;
      else if (category === 'vehicle') round.mvp_equipped_vehicle = item;
      else round.mvp_equipped_weapon = item;
      round.server_type = serverType;
      round.game_mode = gameMode;
      baseline.push(round);
    }
    const baselineWins = baseline.filter(r => r.round_result === 'SurvivorWin').length;
    const baselineRate = Math.round((baselineWins / baseline.length) * 100);

    const changeLines = [];
    const winDelta = winRate - baselineRate;
    if (Math.abs(winDelta) >= 5) {
      changeLines.push(`⚠️ Win rate is ${winDelta > 0 ? 'up' : 'down'} ${Math.abs(winDelta)} points vs the prior period (${baselineRate}% → ${winRate}%).`);
    }

    // Compare top map/co-occurrence between the two periods for a second signal
    const baselineMapCounts = new Map();
    for (const r of baseline) {
      if (r.map) baselineMapCounts.set(r.map, (baselineMapCounts.get(r.map) || 0) + 1);
    }
    const baselineTopMap = [...baselineMapCounts.entries()].sort((a, b) => b[1] - a[1])[0];
    if (topMap && baselineTopMap && topMap[0] !== baselineTopMap[0]) {
      changeLines.push(`Most common map changed from ${baselineTopMap[0]} to ${topMap[0]}.`);
    }

    const changesSummary = changeLines.length > 0
      ? `\n\n**Significant changes:**\n${changeLines.join('\n')}`
      : `\n\n*No significant changes vs the prior period (${baselineRate}% baseline, ${baseline.length} rounds).*`;

    const periodLabel = dateRange
      ? `${dateRange.startDate.toLocaleDateString('en-US', { month: 'long', day: 'numeric' })} – ${dateRange.endDate.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}`
      : 'past 180 days (scattered)';

    const resultFilterLabel = resultFilter ? ` · ${resultFilter === 'DinoWin' ? 'Dino Wins only' : 'Survivor Wins only'}` : '';

    // ── Stat card ─────────────────────────────────────────────────────────
    const winColorHex = winRate >= 55 ? '#57F287' : winRate <= 40 ? '#ED4245' : '#FEE75C';
    const serverLabel = serverType === 'pro' ? 'Pro' : 'Regular';

    const deltaNote = changeLines.length > 0
      ? changeLines.map(l => l.replace(/^⚠️\s*/, '')).join(' · ')
      : '';

    let panels;
    if (category === 'dino') {
      panels = [
        { title: 'Best Map', lines: [topMap ? `${topMap[0]} (${topMap[1]}x)` : '—'] },
        {
          title: 'When Won',
          lines: [`Car: ${breakdownData.wonCar}`, `Gun: ${breakdownData.wonGun}`, `Pickup: ${breakdownData.pickup}`],
          color: '#57F287',
        },
        {
          title: 'When Lost',
          lines: [`Car: ${breakdownData.lostCar}`, `Gun: ${breakdownData.lostGun}`],
          color: '#ED4245',
        },
      ];
    } else {
      panels = [
        { title: 'Best Map',            lines: [topMap ? `${topMap[0]} (${topMap[1]}x)` : '—'] },
        { title: breakdownData.coLabel, lines: [breakdownData.coItem]  },
        { title: 'Winning Dino',        lines: [breakdownData.topDino] },
      ];
    }

    const cardBuffer = await buildStatCard({
      title:    item,
      subtitle: `${categoryLabel} · ${serverLabel} · ${gameMode}  (test)`,
      stats: [
        { label: 'Win Rate',     value: `${winRate}%`,                          color: winColorHex },
        { label: 'Rounds',       value: filtered.length.toLocaleString(),        color: '#5865F2'   },
        { label: 'Prior Period', value: `${baselineRate}% (${baseline.length})`, color: '#72767d'   },
      ],
      lookback: periodLabel,
      panels,
      note: deltaNote,
    });

    // ── Attachment ────────────────────────────────────────────────────────
    const { rows: tableRows, sampled, originalCount } = capAndSample(filtered);
    const table          = buildPastebinTable(tableRows, category === 'dino');
    const cardAttachment = new AttachmentBuilder(cardBuffer, { name: 'winrate.png' });
    const txtAttachment  = new AttachmentBuilder(Buffer.from(table, 'utf8'), {
      name: `test-winrate-${item.replace(/\s+/g, '-')}-${Date.now()}.txt`,
    });

    const replyPayload = { files: [cardAttachment, txtAttachment] };
    if (sampled) {
      replyPayload.content = `*Attachment: evenly-sampled ${tableRows.length.toLocaleString()} of ${originalCount.toLocaleString()} rounds — win rate calculated from all ${originalCount.toLocaleString()}.*`;
    }

    await interaction.channel.send(replyPayload).catch(err => {
      console.error('[testwinrate] send failed:', err.message);
    });

    return interaction.editReply('Posted test winrate card above.');
  },
};