// ─── Balance Council Weekly Report (v2 — narrative + change detection) ────
// Auto-posts weekly to REPORT_CHANNEL_ID, also pullable on demand via
// /balancereport. Compares this week to last week, calls out what changed,
// and breaks everything down by game mode (regular / pro / doubletrouble)
// since those have meaningfully different player counts and dynamics
// (Double Trouble: 2 dinos, 9 survivors, 11 total; Regular/Pro: 1 dino,
// up to 10 survivors).

const { EmbedBuilder } = require('discord.js');

const REPORT_CHANNEL_ID = '1515751121560272987';
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const POST_ID = 'balance-council-weekly';

const GAME_MODES = ['regular', 'pro', 'doubletrouble'];
const GAME_MODE_LABELS = { regular: 'Regular', pro: 'Pro', doubletrouble: 'Double Trouble' };

async function getRoundsInRange(supabase, startMs, endMs) {
  const { data, error } = await supabase
    .from('round_logs')
    .select('map, round_result, game_mode, mvp_equipped_vehicle, mvp_equipped_weapon, mvp_damage, num_players_with_medkits, num_players_with_toolkits, num_players_with_fuelcans, num_players_with_dinotrackers, num_players_with_mines, num_players_with_gamepass_weapons, number_of_players')
    .gte('played_at', new Date(startMs).toISOString())
    .lt('played_at', new Date(endMs).toISOString());

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
  if (rows.length === 0) return { dinoWinPct: null, survivorWinPct: null };
  const dinoWins = rows.filter(r => r.round_result === 'DinoWin').length;
  const survivorWins = rows.filter(r => r.round_result === 'SurvivorWin').length;
  return {
    dinoWinPct: Math.round((dinoWins / rows.length) * 100),
    survivorWinPct: Math.round((survivorWins / rows.length) * 100),
  };
}

function itemAdoption(rows) {
  if (rows.length === 0) return null;
  let totals = { medkits: 0, toolkits: 0, fuelcans: 0, dinotrackers: 0, mines: 0, gamepassWeapons: 0 };
  let totalPlayers = 0;
  for (const row of rows) {
    totals.medkits += row.num_players_with_medkits || 0;
    totals.toolkits += row.num_players_with_toolkits || 0;
    totals.fuelcans += row.num_players_with_fuelcans || 0;
    totals.dinotrackers += row.num_players_with_dinotrackers || 0;
    totals.mines += row.num_players_with_mines || 0;
    totals.gamepassWeapons += row.num_players_with_gamepass_weapons || 0;
    totalPlayers += row.number_of_players || 0;
  }
  if (totalPlayers === 0) return null;
  const pct = v => Math.round((v / totalPlayers) * 1000) / 10;
  return {
    medkits: pct(totals.medkits), toolkits: pct(totals.toolkits), fuelcans: pct(totals.fuelcans),
    dinotrackers: pct(totals.dinotrackers), mines: pct(totals.mines), gamepassWeapons: pct(totals.gamepassWeapons),
  };
}

// Build a single sentence describing a week-over-week change, or null if
// the change is small enough not to be worth mentioning (< 3 points).
function describeDelta(label, thisVal, lastVal, unit = '%') {
  if (thisVal === null || lastVal === null) return null;
  const delta = thisVal - lastVal;
  if (Math.abs(delta) < 3) return null;
  const direction = delta > 0 ? 'up' : 'down';
  return `${label} is ${direction} ${Math.abs(delta)}${unit} (${lastVal}${unit} → ${thisVal}${unit})`;
}

function buildNarrative(thisWeek, lastWeek, gameMode) {
  if (thisWeek.rows.length === 0) {
    return `No rounds logged this week${gameMode ? ` for ${GAME_MODE_LABELS[gameMode]}` : ''}.`;
  }

  const lines = [];
  const totalThis = thisWeek.rows.length;
  const totalLast = lastWeek.rows.length;

  // Round volume
  if (totalLast > 0) {
    const volDelta = totalThis - totalLast;
    const volPct = Math.round((volDelta / totalLast) * 100);
    if (Math.abs(volPct) >= 10) {
      lines.push(`Round volume is ${volDelta > 0 ? 'up' : 'down'} ${Math.abs(volPct)}% week over week (${totalLast} → ${totalThis} rounds).`);
    }
  } else {
    lines.push(`${totalThis} rounds logged this week — no prior week data to compare against yet.`);
  }

  // Win rate split
  const thisSplit = winRateSplit(thisWeek.rows);
  const lastSplit = winRateSplit(lastWeek.rows);
  const winDelta = describeDelta('Dino win rate', thisSplit.dinoWinPct, lastSplit.dinoWinPct);
  if (winDelta) lines.push(winDelta + '.');

  // Item adoption changes
  const thisAdoption = itemAdoption(thisWeek.rows);
  const lastAdoption = itemAdoption(lastWeek.rows);
  if (thisAdoption && lastAdoption) {
    const itemLabels = { medkits: 'Med Kit', toolkits: 'Toolkit', fuelcans: 'Fuel Can', dinotrackers: 'Dino Tracker', mines: 'Mine', gamepassWeapons: 'Gamepass weapon' };
    for (const key of Object.keys(itemLabels)) {
      const d = describeDelta(`${itemLabels[key]} adoption`, thisAdoption[key], lastAdoption[key], ' pts');
      if (d) lines.push(d + '.');
    }
  }

  // MVP movers — did the top weapon/vehicle change?
  const thisWeapons = rankBy(thisWeek.rows, 'mvp_equipped_weapon', 1);
  const lastWeapons = rankBy(lastWeek.rows, 'mvp_equipped_weapon', 1);
  if (thisWeapons[0] && lastWeapons[0] && thisWeapons[0][0] !== lastWeapons[0][0]) {
    lines.push(`Top MVP weapon changed from ${lastWeapons[0][0]} to ${thisWeapons[0][0]}.`);
  }

  const thisVehicles = rankBy(thisWeek.rows, 'mvp_equipped_vehicle', 1);
  const lastVehicles = rankBy(lastWeek.rows, 'mvp_equipped_vehicle', 1);
  if (thisVehicles[0] && lastVehicles[0] && thisVehicles[0][0] !== lastVehicles[0][0]) {
    lines.push(`Top MVP vehicle changed from ${lastVehicles[0][0]} to ${thisVehicles[0][0]}.`);
  }

  if (lines.length === 0) {
    lines.push(`Nothing stood out this week — round volume, win rates, item adoption, and MVP frequency all held steady compared to last week.`);
  }

  return lines.join(' ');
}

function buildHighlightsEmbed(thisWeek, gameMode) {
  const label = gameMode ? GAME_MODE_LABELS[gameMode] : 'All Modes';
  const rows = thisWeek.rows;

  if (rows.length === 0) {
    return new EmbedBuilder()
      .setColor(0x5865F2)
      .setTitle(`${label} — Highlights`)
      .setDescription('No rounds logged this week.');
  }

  const topVehicles = rankBy(rows, 'mvp_equipped_vehicle', 3);
  const topWeapons = rankBy(rows, 'mvp_equipped_weapon', 3);
  const topMaps = rankBy(rows, 'map', 3);
  const split = winRateSplit(rows);

  return new EmbedBuilder()
    .setColor(0x5865F2)
    .setTitle(`${label} — Highlights`)
    .addFields(
      { name: 'Round Result', value: `Dino: ${split.dinoWinPct}% · Survivor: ${split.survivorWinPct}%`, inline: false },
      { name: 'Top Maps', value: topMaps.length ? topMaps.map(([m, c]) => `${m} (${c})`).join(', ') : 'No data', inline: false },
      { name: 'Top MVP Vehicles', value: topVehicles.length ? topVehicles.map(([v, c]) => `${v} (${c}x)`).join(', ') : 'No data', inline: false },
      { name: 'Top MVP Weapons', value: topWeapons.length ? topWeapons.map(([w, c]) => `${w} (${c}x)`).join(', ') : 'No data', inline: false },
    )
    .setFooter({ text: `${rows.length} rounds this week` });
}

async function buildFullReport(supabase) {
  const now = Date.now();
  const thisWeekStart = now - WEEK_MS;
  const lastWeekStart = now - 2 * WEEK_MS;

  const allThisWeek = await getRoundsInRange(supabase, thisWeekStart, now);
  const allLastWeek = await getRoundsInRange(supabase, lastWeekStart, thisWeekStart);

  if (allThisWeek === null || allLastWeek === null) return null;

  // Overall narrative (all modes combined)
  const overallNarrative = buildNarrative({ rows: allThisWeek }, { rows: allLastWeek }, null);
  const overallHighlights = buildHighlightsEmbed({ rows: allThisWeek }, null);

  // Per-game-mode breakdown
  const modeEmbeds = [];
  for (const mode of GAME_MODES) {
    const thisModeRows = allThisWeek.filter(r => r.game_mode === mode);
    const lastModeRows = allLastWeek.filter(r => r.game_mode === mode);
    if (thisModeRows.length === 0 && lastModeRows.length === 0) continue; // skip modes with zero data entirely

    const modeNarrative = buildNarrative({ rows: thisModeRows }, { rows: lastModeRows }, mode);
    const modeHighlights = buildHighlightsEmbed({ rows: thisModeRows }, mode);
    modeHighlights.setDescription(modeNarrative);
    modeEmbeds.push(modeHighlights);
  }

  return {
    overallNarrative,
    overallHighlights,
    modeEmbeds,
    totalRounds: allThisWeek.length,
  };
}

async function postReport(channel, supabase) {
  const report = await buildFullReport(supabase);
  if (!report) {
    console.error('[balance-report] Failed to build report.');
    await channel.send('Failed to fetch round data for the report — check logs.').catch(() => {});
    return false;
  }

  await channel.send({
    content: `**Weekly Summary**\n${report.overallNarrative}`,
    embeds: [report.overallHighlights],
  }).catch(err => console.error('[balance-report] Failed to post overall:', err.message));

  for (const embed of report.modeEmbeds) {
    await channel.send({ embeds: [embed] }).catch(err => console.error('[balance-report] Failed to post mode embed:', err.message));
  }

  return true;
}

function setup(client, { supabase }) {
  if (!supabase) {
    console.log('[balance-report] Skipping setup — supabase not configured.');
    return;
  }

  async function scheduledPost() {
    const channel = client.channels.cache.get(REPORT_CHANNEL_ID)
      ?? await client.channels.fetch(REPORT_CHANNEL_ID).catch(() => null);

    if (!channel) {
      console.error('[balance-report] Could not find report channel', REPORT_CHANNEL_ID);
      return;
    }

    await postReport(channel, supabase);

    await supabase
      .from('scheduled_posts')
      .upsert({ id: POST_ID, last_posted_at: new Date().toISOString() });

    console.log('[balance-report] Posted weekly Balance Council report.');
  }

  async function scheduleNext() {
    const { data } = await supabase
      .from('scheduled_posts')
      .select('last_posted_at')
      .eq('id', POST_ID)
      .maybeSingle();

    const lastPosted = data?.last_posted_at ? new Date(data.last_posted_at).getTime() : 0;
    const elapsed = Date.now() - lastPosted;

    if (elapsed >= WEEK_MS) {
      await scheduledPost();
      setTimeout(scheduleNext, WEEK_MS);
    } else {
      const remaining = WEEK_MS - elapsed;
      setTimeout(async () => {
        await scheduledPost();
        setTimeout(scheduleNext, WEEK_MS);
      }, remaining);
      console.log(`[balance-report] Next post in ${Math.round(remaining / (60 * 60 * 1000))}h.`);
    }
  }

  scheduleNext();
}

module.exports = setup;
module.exports.postReport = postReport;
module.exports.buildFullReport = buildFullReport;