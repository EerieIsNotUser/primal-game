const { SlashCommandBuilder, AttachmentBuilder } = require('discord.js');
const chrono = require('chrono-node');
const { buildStatCard } = require('../modules/chart');

// ─── /winrate ────────────────────────────────────────────────────────────
// Filterable win rate query: pick a category (dino/vehicle/weapon), a
// specific item, optional server type / game mode / time range filters,
// OR a natural-language date range ("January 15th through March 16th").
// Returns "Winrate over X period, Y%" plus matching rounds as a pastebin-
// style plain text attachment. Flags statistically significant deviations
// from the item's all-time average.
//
// IMPORTANT CAVEAT — current data limitation:
//   - Vehicles/Weapons: win rate here means "rounds where this item was the
//     MVP, what % were SurvivorWin" — an MVP-correlation proxy, NOT true
//     per-item usage win rate (that data doesn't exist in the current
//     payload — no per-player/per-item win-loss tracking).
//   - Dinos: PLACEHOLDER ONLY. No dino identity field exists anywhere in
//     the current round_logs schema.
//   - Pickups: not trackable per-item — only round-level adoption counts
//     exist, not tied to a specific MVP.

const VEHICLES = ['ATV', 'Golf Cart', 'Jeep', 'Hypercar', 'Pickup Truck', 'Police Car', 'Pumpkin Wagon', 'Buggy', 'Hybrid', 'Banana Car', 'Go-Kart', 'Bush Car', 'Muscle Car', 'Ambulance', 'Tow Truck', 'MRAP', 'Warthog', 'The Hornet', 'Humvee', 'Cyber-Beast', 'Monster Truck', 'Scrapper', 'Lunar Rover'];
const WEAPONS = ['Pistol', 'Shotgun', 'MP5', 'Light Sniper', 'AR-15', 'AK-47', 'Crossbow', 'Heavy Sniper', 'AR-Dino', 'AR-Uni', 'P90', 'Water Gun', 'Raygun', 'Scar', 'Trike Shotgun', 'Minigun', 'IWS 2000', 'LMG', 'Deagle', 'Railgun', 'Plasma Rifle', 'Flamethrower', 'Tri-Beam', 'Scrapyard Shotgun', 'SPAS-12'];
const DINOS = ['T-Rex', 'Pachy', 'Raptor', 'Carno', 'Dilo', 'Baryonyx', 'Cerato', 'Giga', 'Spino', 'Trike', 'Deino', 'Bronto', 'Exoraptor'];

const SERVER_TYPES = [
  { name: 'Regular', value: 'regular' },
  { name: 'Pro', value: 'pro' },
];

const GAME_MODE_OPTIONS = [
  { name: 'Standard', value: 'standard' },
  { name: 'Double Trouble (placeholder — not cross-filterable yet)', value: 'doubletrouble' },
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

// Hard cap on rows included in any single attachment — at 1,500+ daily
// players this protects against generating multi-megabyte files for wide
// date ranges. Above this cap, rows are evenly sampled across the full
// range (not just truncated to the first N) so the file still represents
// the whole period, not just its earliest portion.
const MAX_ATTACHMENT_ROWS = 5000;

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

// Parse a natural-language date range like "January 15th through March 16th"
// Returns { startDate, endDate } or null if it couldn't be parsed.
function parseDateRange(text) {
  const results = chrono.parse(text, new Date());
  if (results.length === 0) return null;

  const result = results[0];
  const startDate = result.start ? result.start.date() : null;
  const endDate = result.end ? result.end.date() : (result.start ? result.start.date() : null);

  if (!startDate) return null;

  // If only a start was parsed (no range), treat as a single day
  return { startDate, endDate: endDate ?? startDate };
}

async function queryWinRate(supabase, { category, item, gameMode, days, dateRange }) {
  let query = supabase.from('round_logs').select('*');

  if (dateRange) {
    query = query.gte('played_at', dateRange.startDate.toISOString()).lte('played_at', dateRange.endDate.toISOString());
  } else if (days !== 'all') {
    const cutoff = new Date(Date.now() - parseInt(days, 10) * 24 * 60 * 60 * 1000);
    query = query.gte('played_at', cutoff.toISOString());
  }

  if (gameMode && gameMode !== 'all') {
    query = query.eq('game_mode', gameMode);
  }

  if (category === 'vehicle') {
    query = query.eq('mvp_equipped_vehicle', item);
  } else if (category === 'weapon') {
    query = query.eq('mvp_equipped_weapon', item);
  }

  const { data, error } = await query.order('played_at', { ascending: true });
  if (error) return null;
  return data ?? [];
}

// Fetch ALL-TIME win/total counts for baseline comparison (not full rows —
// at high round volume, fetching every row just to count wins is wasteful).
// Excludes the selected period itself so the baseline isn't self-referential.
async function queryAllTimeBaseline(supabase, { category, item, gameMode, excludeRange }) {
  let baseQuery = supabase.from('round_logs').select('round_result', { count: 'exact' });

  if (gameMode && gameMode !== 'all') baseQuery = baseQuery.eq('game_mode', gameMode);
  if (category === 'vehicle') baseQuery = baseQuery.eq('mvp_equipped_vehicle', item);
  else if (category === 'weapon') baseQuery = baseQuery.eq('mvp_equipped_weapon', item);

  if (excludeRange) {
    // Two separate count queries (before range, after range) since Supabase
    // can't easily express "NOT BETWEEN" — sum the two counts together.
    const beforeQuery = supabase.from('round_logs').select('round_result', { count: 'exact' });
    const afterQuery = supabase.from('round_logs').select('round_result', { count: 'exact' });

    let bq = beforeQuery, aq = afterQuery;
    if (gameMode && gameMode !== 'all') { bq = bq.eq('game_mode', gameMode); aq = aq.eq('game_mode', gameMode); }
    if (category === 'vehicle') { bq = bq.eq('mvp_equipped_vehicle', item); aq = aq.eq('mvp_equipped_vehicle', item); }
    else if (category === 'weapon') { bq = bq.eq('mvp_equipped_weapon', item); aq = aq.eq('mvp_equipped_weapon', item); }

    bq = bq.lt('played_at', excludeRange.startDate.toISOString());
    aq = aq.gt('played_at', excludeRange.endDate.toISOString());

    const [{ data: beforeData, count: beforeCount, error: beforeErr }, { data: afterData, count: afterCount, error: afterErr }] =
      await Promise.all([bq, aq]);

    if (beforeErr || afterErr) return null;

    const beforeWins = (beforeData ?? []).filter(r => r.round_result === 'SurvivorWin').length;
    const afterWins = (afterData ?? []).filter(r => r.round_result === 'SurvivorWin').length;

    return { total: (beforeCount ?? 0) + (afterCount ?? 0), wins: beforeWins + afterWins };
  }

  const { data, count, error } = await baseQuery;
  if (error || !data) return null;

  const wins = data.filter(r => r.round_result === 'SurvivorWin').length;
  return { total: count ?? data.length, wins };
}

function computeWinRate(rows) {
  if (rows.length === 0) return null;
  const wins = rows.filter(r => r.round_result === 'SurvivorWin').length;
  return wins / rows.length;
}

// Two-proportion z-test: is the selected period's win rate significantly
// different from the baseline rate, given both sample sizes?
// Returns { zScore, pValue, significant } or null if either sample is too small.
function testSignificance(p1, n1, p2, n2) {
  if (n1 < 5 || n2 < 5) return null; // too small to say anything meaningful

  const pooledP = (p1 * n1 + p2 * n2) / (n1 + n2);
  const se = Math.sqrt(pooledP * (1 - pooledP) * (1 / n1 + 1 / n2));
  if (se === 0) return null;

  const z = (p1 - p2) / se;
  // Two-tailed p-value approximation from z-score (normal distribution)
  const pValue = 2 * (1 - normalCdf(Math.abs(z)));

  return { zScore: z, pValue, significant: pValue < 0.05 };
}

function normalCdf(z) {
  return (1 + erf(z / Math.sqrt(2))) / 2;
}

function erf(x) {
  // Abramowitz-Stegun approximation, max error ~1.5e-7
  const sign = x >= 0 ? 1 : -1;
  x = Math.abs(x);
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741, a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const t = 1 / (1 + p * x);
  const y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
  return sign * y;
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
      opt.setName('server_type')
        .setDescription('Server type to filter by')
        .setRequired(true)
        .addChoices(...SERVER_TYPES.map(s => ({ name: s.name, value: s.value })))
    )
    .addStringOption(opt =>
      opt.setName('game_mode')
        .setDescription('Game mode to filter by')
        .setRequired(true)
        .addChoices(...GAME_MODE_OPTIONS.map(s => ({ name: s.name, value: s.value })))
    )
    .addStringOption(opt =>
      opt.setName('dates')
        .setDescription('Natural date range, e.g. "January 15th through March 16th" (overrides time_range)')
        .setRequired(false)
    )
    .addStringOption(opt =>
      opt.setName('time_range')
        .setDescription('Time period (default: past month) — ignored if "dates" is set')
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
    const serverType = interaction.options.getString('server_type');
    const gameModeChoice = interaction.options.getString('game_mode');

    if (gameModeChoice === 'doubletrouble' && serverType) {
      return interaction.editReply(
        `❌ Cross-filtering Double Trouble with a specific server type isn't possible yet — ` +
        `the current data only tracks one combined game_mode value, not server type and game mode independently. ` +
        `This is a known gap, flagged for KKG.\n\n` +
        `Use \`/testwinrate\` to preview this once that field exists.`
      );
    }

    // Until the schema splits server_type and game_mode, query against the
    // existing single game_mode column using server_type as the value
    // (Double Trouble path above is blocked, so this only ever receives
    // 'regular' or 'pro' here).
    const gameMode = serverType;
    const datesInput = interaction.options.getString('dates');
    const days = interaction.options.getString('time_range') ?? '30';

    if (category === 'dino') {
      return interaction.editReply(
        `❌ Dino win rate isn't available yet — the current round logging doesn't track which dino was played. ` +
        `This is a known gap, flagged for KKG. Once that field exists, this command will work the same way it does for vehicles/weapons, ` +
        `including "most common winning dino against a car/gun" breakdowns.\n\n` +
        `Use \`/testwinrate\` to preview this feature with synthetic data.`
      );
    }

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

    const rows = await queryWinRate(supabase, { category, item, gameMode, days, dateRange });

    if (rows === null) {
      return interaction.editReply('❌ Something went wrong querying round data.');
    }

    if (rows.length === 0) {
      return interaction.editReply(`No rounds found for **${item}** with the selected filters.`);
    }

    const winRate = computeWinRate(rows);
    const winRatePct = Math.round(winRate * 100);

    const periodLabel = dateRange
      ? `${dateRange.startDate.toLocaleDateString('en-US', { month: 'long', day: 'numeric' })} – ${dateRange.endDate.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}`
      : TIME_RANGES.find(t => t.value === days)?.name ?? 'selected period';

    const modeLabel = GAME_MODES.find(s => s.value === gameMode)?.name ?? 'All';
    const categoryLabel = category === 'vehicle' ? 'Car' : 'Gun';

    // ── Statistical significance check vs all-time baseline ──────────────
    const baseline = await queryAllTimeBaseline(supabase, { category, item, gameMode, excludeRange: dateRange });
    let significanceNote = '';

    if (baseline && baseline.total >= 5) {
      const baselineRate = baseline.wins / baseline.total;
      const baselinePct = Math.round(baselineRate * 100);
      const test = testSignificance(winRate, rows.length, baselineRate, baseline.total);

      if (test && test.significant) {
        const direction = winRate < baselineRate ? '⚠️ SIGNIFICANTLY LOWER' : '⚠️ SIGNIFICANTLY HIGHER';
        significanceNote =
          `\n\n${direction} than the all-time average for ${item} (${baselinePct}% across ${baseline.total} other rounds). ` +
          `This difference is statistically significant (p < 0.05), not just normal variation.`;
      } else if (test) {
        significanceNote = `\n\nAll-time average for ${item}: ${baselinePct}% (${baseline.total} other rounds) — within normal variation.`;
      }
    }

    // ── Most common map / co-occurring weapon-vehicle ────────────────────
    const dinoWinRows = rows.filter(r => r.round_result === 'DinoWin');
    const topVehicleCounts = new Map();
    const topWeaponCounts = new Map();
    for (const r of dinoWinRows) {
      if (r.mvp_equipped_vehicle) topVehicleCounts.set(r.mvp_equipped_vehicle, (topVehicleCounts.get(r.mvp_equipped_vehicle) || 0) + 1);
      if (r.mvp_equipped_weapon) topWeaponCounts.set(r.mvp_equipped_weapon, (topWeaponCounts.get(r.mvp_equipped_weapon) || 0) + 1);
    }
    const topVehicle = [...topVehicleCounts.entries()].sort((a, b) => b[1] - a[1])[0];
    const topWeapon = [...topWeaponCounts.entries()].sort((a, b) => b[1] - a[1])[0];

    const mapCounts = new Map();
    const coWeaponCounts = new Map();
    const coVehicleCounts = new Map();
    for (const r of rows) {
      if (r.map) mapCounts.set(r.map, (mapCounts.get(r.map) || 0) + 1);
      if (category === 'vehicle' && r.mvp_equipped_weapon) coWeaponCounts.set(r.mvp_equipped_weapon, (coWeaponCounts.get(r.mvp_equipped_weapon) || 0) + 1);
      if (category === 'weapon' && r.mvp_equipped_vehicle) coVehicleCounts.set(r.mvp_equipped_vehicle, (coVehicleCounts.get(r.mvp_equipped_vehicle) || 0) + 1);
    }
    const topMap = [...mapCounts.entries()].sort((a, b) => b[1] - a[1])[0];
    const topCoWeapon = [...coWeaponCounts.entries()].sort((a, b) => b[1] - a[1])[0];
    const topCoVehicle = [...coVehicleCounts.entries()].sort((a, b) => b[1] - a[1])[0];

    const coOccurrenceLines = [`Most common map: ${topMap ? `${topMap[0]} (${topMap[1]}x)` : 'No data'}`];
    if (category === 'vehicle') {
      coOccurrenceLines.push(`Most common gun alongside this car: ${topCoWeapon ? `${topCoWeapon[0]} (${topCoWeapon[1]}x)` : 'No data'}`);
    } else {
      coOccurrenceLines.push(`Most common car alongside this gun: ${topCoVehicle ? `${topCoVehicle[0]} (${topCoVehicle[1]}x)` : 'No data'}`);
    }

    const mvpBreakdown = dinoWinRows.length > 0
      ? `Most common MVP car in DinoWin rounds: ${topVehicle ? `${topVehicle[0]} (${topVehicle[1]}x)` : 'No data'}\n` +
        `Most common MVP gun in DinoWin rounds: ${topWeapon ? `${topWeapon[0]} (${topWeapon[1]}x)` : 'No data'}\n` +
        `*(not tied to a specific dino — needs dino tracking, see /testwinrate for a preview)*\n\n` +
        coOccurrenceLines.join('\n') +
        `\nMost common pickups: not available yet — needs per-MVP pickup tracking (see /testwinrate for a preview)`
      : 'No DinoWin rounds in this selection to break down.';

    // ── Stat card ─────────────────────────────────────────────────────────
    const winColorHex  = winRatePct >= 55 ? '#57F287' : winRatePct <= 40 ? '#ED4245' : '#FEE75C';
    const serverLabel  = serverType === 'pro' ? 'Pro' : 'Regular';

    const baselineText = baseline && baseline.total >= 5
      ? `${Math.round((baseline.wins / baseline.total) * 100)}%  (${baseline.total.toLocaleString()})`
      : '—';

    let noteText = '';
    if (significanceNote.includes('SIGNIFICANTLY')) {
      const baselinePct = baseline ? Math.round((baseline.wins / baseline.total) * 100) : 0;
      const direction   = winRatePct < baselinePct ? 'below' : 'above';
      noteText = `Win rate is significantly ${direction} the all-time average of ${baselinePct}% (p < 0.05)`;
    }

    const coItemName  = category === 'vehicle'
      ? (topCoWeapon  ? `${topCoWeapon[0]} (${topCoWeapon[1]}x)`   : '—')
      : (topCoVehicle ? `${topCoVehicle[0]} (${topCoVehicle[1]}x)` : '—');
    const coItemLabel  = category === 'vehicle' ? 'Co-occurring Gun' : 'Co-occurring Car';
    const dinoWinLabel = category === 'vehicle' ? 'DinoWin — Top Gun' : 'DinoWin — Top Car';
    const dinoWinValue = dinoWinRows.length > 0
      ? (category === 'vehicle'
          ? (topWeapon  ? `${topWeapon[0]} (${topWeapon[1]}x)`   : '—')
          : (topVehicle ? `${topVehicle[0]} (${topVehicle[1]}x)` : '—'))
      : '—';

    const cardBuffer = await buildStatCard({
      title:    item,
      subtitle: `${categoryLabel} · ${serverLabel} Servers`,
      stats: [
        { label: 'Win Rate', value: `${winRatePct}%`,            color: winColorHex },
        { label: 'Rounds',   value: rows.length.toLocaleString(), color: '#5865F2'   },
        { label: 'Baseline', value: baselineText,                 color: '#72767d'   },
      ],
      lookback: periodLabel,
      panels: [
        { title: 'Best Map',   lines: [topMap ? `${topMap[0]} (${topMap[1]}x)` : '—'] },
        { title: coItemLabel,  lines: [coItemName]   },
        { title: dinoWinLabel, lines: [dinoWinValue] },
      ],
      note: noteText,
    });

    // ── Attachment ────────────────────────────────────────────────────────
    const { rows: tableRows, sampled, originalCount } = capAndSample(rows);
    const table          = buildPastebinTable(tableRows);
    const cardAttachment = new AttachmentBuilder(cardBuffer, { name: 'winrate.png' });
    const txtAttachment  = new AttachmentBuilder(Buffer.from(table, 'utf8'), {
      name: `winrate-${item.replace(/\s+/g, '-')}-${Date.now()}.txt`,
    });

    const replyPayload = { files: [cardAttachment, txtAttachment] };
    if (sampled) {
      replyPayload.content = `*Attachment: evenly-sampled ${tableRows.length.toLocaleString()} of ${originalCount.toLocaleString()} rounds — win rate calculated from all ${originalCount.toLocaleString()}.*`;
    }
    return interaction.editReply(replyPayload);
  },
};