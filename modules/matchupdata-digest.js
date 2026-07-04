// ─── Matchup Data Digest ──────────────────────────────────────────────────────
// Posts per-map matchup stat cards + MVP weapon/vehicle pair tier list.
// Auto-schedules Thursday midnight US Eastern, same tier priority as tierlist.
//
// Per map: most common MVP weapon, MVP vehicle, dinosaur used
// Global:  top 10 MVP weapon + vehicle pairs
//
// NOTE: Dino data uses dinosaurs_used array (all dinos in round).
// Per-player dino identity will improve this once KKG adds that field.

const { AttachmentBuilder } = require('discord.js');
const { buildStatCard, buildTierListCard, MAP_COLORS } = require('./chart');

const CHANNEL_ID = '1515750872498438234';
const ALL_MAPS   = ['Jungle', 'Canyon', 'Cavern', 'Primal Park'];

const TIERS = [
  { key: 'yearly',    label: 'Yearly',    minDays: 365 },
  { key: 'quarterly', label: 'Quarterly', minDays: 91  },
  { key: 'monthly',   label: 'Monthly',   minDays: 28  },
  { key: 'weekly',    label: 'Weekly',    minDays: 7   },
];

// ── Scheduler ─────────────────────────────────────────────────────────────────
function getMsUntilNextThursdayMidnightNY() {
  const now = new Date();

  for (let i = 1; i <= 8; i++) {
    const candidate = new Date(now.getTime() + i * 24 * 60 * 60 * 1000);
    const dayInNY   = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York', weekday: 'short',
    }).format(candidate);

    if (dayInNY !== 'Thu') continue;

    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(candidate);

    const yr = parts.find(p => p.type === 'year').value;
    const mo = parts.find(p => p.type === 'month').value;
    const dy = parts.find(p => p.type === 'day').value;

    const noonUTC   = new Date(`${yr}-${mo}-${dy}T12:00:00Z`);
    const noonNYHr  = parseInt(new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York', hour: 'numeric', hour12: false,
    }).format(noonUTC));
    const offsetHrs    = 12 - noonNYHr;
    const midnightUTC  = new Date(`${yr}-${mo}-${dy}T${String(offsetHrs).padStart(2, '0')}:00:00Z`);
    const ms = midnightUTC.getTime() - now.getTime();
    if (ms > 0) return ms;
  }

  return 7 * 24 * 60 * 60 * 1000;
}

// ── Tier determination ────────────────────────────────────────────────────────
async function determineTier(supabase) {
  const now = Date.now();
  for (const tier of TIERS) {
    const { data } = await supabase
      .from('primalgame_state')
      .select('value')
      .eq('key', `matchupdata_${tier.key}_at`)
      .single();
    const lastAt    = data?.value ? new Date(data.value).getTime() : 0;
    const daysSince = (now - lastAt) / (24 * 60 * 60 * 1000);
    if (daysSince >= tier.minDays) return tier;
  }
  return TIERS[TIERS.length - 1];
}

// ── Data helpers ──────────────────────────────────────────────────────────────
function topEntry(map, key) {
  const counts = new Map();
  for (const row of map.values ? [...map.values()] : map) {
    const val = row[key];
    if (!val) continue;
    counts.set(val, (counts.get(val) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0] ?? null;
}

function topDino(rows) {
  const counts = new Map();
  for (const row of rows) {
    const dinos = Array.isArray(row.dinosaurs_used) ? row.dinosaurs_used : (row.dinosaurs_used ? [row.dinosaurs_used] : []);
    for (const d of dinos) counts.set(d, (counts.get(d) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0] ?? null;
}

function topPairs(rows, limit = 10) {
  const counts = new Map();
  for (const row of rows) {
    const w = row.mvp_equipped_weapon;
    const v = row.mvp_equipped_vehicle;
    if (!w || !v) continue;
    const key = `${w} + ${v}`;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([name, count]) => ({ name, count }));
}

// ── Card builders ─────────────────────────────────────────────────────────────
async function buildMapCard(map, rows, tierLabel, lookback) {
  const topWeapon  = topEntry(rows, 'mvp_equipped_weapon');
  const topVehicle = topEntry(rows, 'mvp_equipped_vehicle');
  const topDinoVal = topDino(rows);

  const dinoWins     = rows.filter(r => r.round_result === 'DinoWin').length;
  const survivorWins = rows.length - dinoWins;
  const dinoWinPct   = rows.length > 0 ? Math.round((dinoWins / rows.length) * 100) : 0;

  return buildStatCard({
    title:    map,
    subtitle: `Matchup Data · ${tierLabel}`,
    stats: [
      { label: 'Rounds',       value: rows.length.toLocaleString(),             color: MAP_COLORS[map] ?? '#5865F2' },
      { label: 'Dino Win',     value: `${dinoWinPct}%`,                         color: '#ED4245' },
      { label: 'Survivor Win', value: `${100 - dinoWinPct}%`,                   color: '#57F287' },
    ],
    lookback,
    panels: [
      { title: 'Top MVP Gun',  lines: [topWeapon  ? `${topWeapon[0]} (${topWeapon[1]}x)`   : '—'] },
      { title: 'Top MVP Car',  lines: [topVehicle ? `${topVehicle[0]} (${topVehicle[1]}x)` : '—'] },
      { title: 'Top Dino',     lines: [topDinoVal ? `${topDinoVal[0]} (${topDinoVal[1]}x)` : '—'] },
    ],
  });
}

// ── Post digest ───────────────────────────────────────────────────────────────
async function postMatchupData(client, supabase, overrideDates = null) {
  const tier = overrideDates ? null : await determineTier(supabase);

  let startDate, endDate, lookback, tierLabel;
  if (overrideDates) {
    startDate  = overrideDates.startDate;
    endDate    = overrideDates.endDate;
    lookback   = `${startDate.toLocaleDateString('en-US', { month: 'long', day: 'numeric' })} – ${endDate.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}`;
    tierLabel  = 'Custom Range';
  } else {
    const days = tier.minDays;
    endDate    = new Date();
    startDate  = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    lookback   = `${startDate.toLocaleDateString('en-US', { month: 'long', day: 'numeric' })} – ${endDate.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}`;
    tierLabel  = tier.label;
  }

  const { data: rows, error } = await supabase
    .from('round_logs')
    .select('map, round_result, mvp_equipped_weapon, mvp_equipped_vehicle, dinosaurs_used')
    .gte('played_at', startDate.toISOString())
    .lte('played_at', endDate.toISOString())
    .limit(100000);

  if (error || !rows || rows.length === 0) {
    console.log(`[matchupdata] No rounds found for ${tierLabel} — skipping.`);
    return false;
  }

  const ch = client.channels.cache.get(CHANNEL_ID)
    ?? await client.channels.fetch(CHANNEL_ID).catch(() => null);
  if (!ch) { console.error('[matchupdata] Could not find channel'); return false; }

  await ch.send({ content: `**${tierLabel} Matchup Data** — ${lookback}` });

  // Per-map cards
  for (const map of ALL_MAPS) {
    const mapRows = rows.filter(r => r.map === map);
    if (mapRows.length === 0) continue;

    const buf = await buildMapCard(map, mapRows, tierLabel, lookback);
    await ch.send({
      files: [new AttachmentBuilder(buf, { name: `matchup-${map.replace(/\s+/g, '-').toLowerCase()}.png` })],
    }).catch(err => console.error(`[matchupdata] Failed to post ${map}:`, err.message));
  }

  // MVP pairs card
  const pairs     = topPairs(rows);
  const pairTotal = pairs.reduce((s, i) => s + i.count, 0);
  const pairBuf   = await buildTierListCard({
    title:       'Top MVP Weapon + Vehicle Pairs',
    subtitle:    `Primal Pursuit · ${tierLabel}`,
    stats: [{ label: 'MVP Rounds', value: pairTotal.toLocaleString(), color: '#FEE75C' }],
    lookback,
    items:       pairs,
    accentColor: '#FEE75C',
  });
  await ch.send({
    files: [new AttachmentBuilder(pairBuf, { name: 'matchup-pairs.png' })],
  }).catch(err => console.error('[matchupdata] Failed to post pairs:', err.message));

  // Update state (skip if override dates)
  if (!overrideDates) {
    const toUpdate = ['weekly'];
    if (tier.key !== 'weekly') toUpdate.push(tier.key);
    for (const key of toUpdate) {
      await supabase.from('primalgame_state')
        .upsert({ key: `matchupdata_${key}_at`, value: new Date().toISOString() });
    }
  }

  console.log(`[matchupdata] Posted ${tierLabel} matchup data — ${rows.length} rounds.`);
  return true;
}

// ── Setup ─────────────────────────────────────────────────────────────────────
module.exports = function setupMatchupData(client, { supabase }) {
  async function scheduleNext() {
    const ms  = getMsUntilNextThursdayMidnightNY();
    const hrs = Math.round(ms / (60 * 60 * 1000));
    console.log(`[matchupdata] Next post in ${hrs}h (Thursday midnight ET).`);
    setTimeout(async () => {
      await postMatchupData(client, supabase);
      scheduleNext();
    }, ms);
  }
  scheduleNext();
};

module.exports.postMatchupData = postMatchupData;