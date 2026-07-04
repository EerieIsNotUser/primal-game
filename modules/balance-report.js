// ─── Balance Report (v3 — stat card, fixed schema) ────────────────────────
// Posts weekly to REPORT_CHANNEL_ID, also triggered via /balancereport.
// Compares this week to last week. Game modes: Normal, Double Trouble.

const { AttachmentBuilder } = require('discord.js');
const { buildBalanceReportCard } = require('./chart');

const REPORT_CHANNEL_ID = '1515750926688845945';
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

const ITEM_FIELDS = [
  { field: 'num_players_with_medkits',     label: 'Med Kit'     },
  { field: 'num_players_with_toolkits',    label: 'Toolkit'     },
  { field: 'num_players_with_fuelcans',    label: 'Fuel Can'    },
  { field: 'num_players_with_dinotrackers',label: 'Dino Tracker'},
  { field: 'num_players_with_mines',       label: 'Mine'        },
];

async function getRoundsInRange(supabase, startMs, endMs) {
  const { data, error } = await supabase
    .from('round_logs')
    .select('map, round_result, game_mode, mvp_equipped_vehicle, mvp_equipped_weapon, average_level, num_players_with_medkits, num_players_with_toolkits, num_players_with_fuelcans, num_players_with_dinotrackers, num_players_with_mines, number_of_players')
    .gte('played_at', new Date(startMs).toISOString())
    .lt('played_at', new Date(endMs).toISOString())
    .limit(100000);
  if (error || !data) return null;
  return data;
}

function rankBy(rows, field, n = 3) {
  const counts = new Map();
  for (const row of rows) {
    const val = row[field];
    if (!val) continue;
    counts.set(val, (counts.get(val) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);
}

function winRateSplit(rows) {
  if (!rows.length) return { dinoPct: null, survivorPct: null };
  const d = rows.filter(r => r.round_result === 'DinoWin').length;
  return {
    dinoPct:     Math.round((d / rows.length) * 100),
    survivorPct: Math.round(((rows.length - d) / rows.length) * 100),
  };
}

function itemAdoptionPcts(rows) {
  if (!rows.length) return null;
  let totalPlayers = 0;
  const totals = {};
  for (const f of ITEM_FIELDS) totals[f.field] = 0;
  for (const row of rows) {
    for (const f of ITEM_FIELDS) totals[f.field] += row[f.field] || 0;
    totalPlayers += row.number_of_players || 0;
  }
  if (!totalPlayers) return null;
  return ITEM_FIELDS.map(f => ({
    label: f.label,
    pct: Math.round((totals[f.field] / totalPlayers) * 1000) / 10,
  }));
}

// Best map by proportional survivor win rate
function bestMapByWinRate(rows) {
  const mapStats = new Map();
  for (const row of rows) {
    if (!row.map) continue;
    if (!mapStats.has(row.map)) mapStats.set(row.map, { wins: 0, total: 0 });
    const m = mapStats.get(row.map);
    m.total++;
    if (row.round_result === 'SurvivorWin') m.wins++;
  }
  return [...mapStats.entries()]
    .filter(([, v]) => v.total >= 5)
    .sort((a, b) => (b[1].wins / b[1].total) - (a[1].wins / a[1].total))[0] ?? null;
}

async function buildReport(supabase) {
  const now          = Date.now();
  const thisStart    = now - WEEK_MS;
  const lastStart    = now - 2 * WEEK_MS;

  const [thisWeek, lastWeek] = await Promise.all([
    getRoundsInRange(supabase, thisStart, now),
    getRoundsInRange(supabase, lastStart, thisStart),
  ]);

  if (!thisWeek || !lastWeek) return null;

  const thisSplit  = winRateSplit(thisWeek);
  const lastSplit  = winRateSplit(lastWeek);
  const adoption   = itemAdoptionPcts(thisWeek);
  const topWeapons = rankBy(thisWeek, 'mvp_equipped_weapon', 1);
  const topVehicles= rankBy(thisWeek, 'mvp_equipped_vehicle', 1);
  const bestMap    = bestMapByWinRate(thisWeek);

  // Win rate delta (rounded to avoid float noise)
  const winDelta = thisSplit.dinoPct !== null && lastSplit.dinoPct !== null
    ? Math.round((thisSplit.dinoPct - lastSplit.dinoPct) * 10) / 10
    : null;
  const winDeltaStr = winDelta === null ? '—'
    : winDelta === 0 ? 'Steady'
    : `${winDelta > 0 ? '+' : ''}${winDelta} pts vs last week`;

  // Volume delta
  const volDelta = lastWeek.length > 0
    ? Math.round(((thisWeek.length - lastWeek.length) / lastWeek.length) * 100)
    : null;
  const volStr = volDelta === null || lastWeek.length < 50
    ? `${thisWeek.length.toLocaleString()} rounds`
    : `${thisWeek.length.toLocaleString()} (${volDelta > 0 ? '+' : ''}${volDelta}% WoW)`;

  // Item adoption top 3
  const adoptionStr = adoption
    ? adoption.slice(0, 3).map(a => `${a.label} ${a.pct}%`).join(' · ')
    : '—';

  const startStr = new Date(thisStart).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  const endStr   = new Date(now).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  const lookback = `${startStr} – ${endStr}`;

  // Build map rankings sorted by round count
  const mapCounts = new Map();
  for (const row of thisWeek) {
    if (!row.map) continue;
    if (!mapCounts.has(row.map)) mapCounts.set(row.map, { rounds: 0, survivorWins: 0 });
    const m = mapCounts.get(row.map);
    m.rounds++;
    if (row.round_result === 'SurvivorWin') m.survivorWins++;
  }
  const mapRankings = [...mapCounts.entries()]
    .sort((a, b) => b[1].rounds - a[1].rounds)
    .map(([name, stats]) => ({ name, ...stats }));

  const cardBuffer = await buildBalanceReportCard({
    title:        'Weekly Balance Report',
    subtitle:     `Primal Pursuit · ${lookback}`,
    lookback,
    totalRounds:  thisWeek.length,
    dinoWins:     thisWeek.filter(r => r.round_result === 'DinoWin').length,
    survivorWins: thisWeek.filter(r => r.round_result === 'SurvivorWin').length,
    winDelta,
    topWeapon:    topWeapons[0]  ? { name: topWeapons[0][0],  count: topWeapons[0][1]  } : null,
    topVehicle:   topVehicles[0] ? { name: topVehicles[0][0], count: topVehicles[0][1] } : null,
    maps:         mapRankings,
    adoption:     adoption ?? [],
  });

  return { cardBuffer, lookback };
}

async function postReport(channel, supabase) {
  const report = await buildReport(supabase);
  if (!report) {
    console.error('[balance-report] Failed to build report.');
    return false;
  }
  await channel.send({
    files: [new AttachmentBuilder(report.cardBuffer, { name: 'balance-report.png' })],
  }).catch(err => console.error('[balance-report] Failed to post:', err.message));
  return true;
}

function setup(client, { supabase }) {
  if (!supabase) return;

  async function scheduledPost() {
    const ch = client.channels.cache.get(REPORT_CHANNEL_ID)
      ?? await client.channels.fetch(REPORT_CHANNEL_ID).catch(() => null);
    if (!ch) { console.error('[balance-report] Could not find channel'); return; }
    await postReport(ch, supabase);
    await supabase.from('primalgame_state').upsert({ key: 'balance_weekly_at', value: new Date().toISOString() });
    console.log('[balance-report] Posted weekly balance report.');
  }

  async function scheduleNext() {
    const { data } = await supabase
      .from('primalgame_state').select('value').eq('key', 'balance_weekly_at').single();
    const lastPosted = data?.value ? new Date(data.value).getTime() : 0;
    const remaining  = WEEK_MS - (Date.now() - lastPosted);

    if (remaining <= 0) {
      await scheduledPost();
      setTimeout(scheduleNext, WEEK_MS);
    } else {
      setTimeout(async () => { await scheduledPost(); setTimeout(scheduleNext, WEEK_MS); }, remaining);
      console.log(`[balance-report] Next post in ${Math.round(remaining / (60 * 60 * 1000))}h.`);
    }
  }

  scheduleNext();
}

module.exports = setup;
module.exports.postReport = postReport;
module.exports.buildReport = buildReport;