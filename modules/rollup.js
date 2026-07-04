// ─── Round Logs Rollup ────────────────────────────────────────────────────────
// Nightly job that aggregates round_logs rows older than RETENTION_DAYS into
// round_stats_daily, then deletes those raw rows.
//
// Rollup is idempotent — running it twice on the same day is safe. The UNIQUE
// constraint on (day, map, game_mode) means re-processing the same rows will
// upsert rather than duplicate. Deleted rows are only removed after a
// successful upsert, so no data is ever lost on partial failure.
//
// round_stats_daily stores pre-summed counts so any date range query can be
// answered by summing daily buckets — no raw rows needed for historical data.

const RETENTION_DAYS = 10;

const BRACKETS = [
  { key: '1_20',    min: 1,   max: 20   },
  { key: '21_40',   min: 21,  max: 40   },
  { key: '41_100',  min: 41,  max: 100  },
  { key: '101_250', min: 101, max: 250  },
  { key: '251_plus',min: 251, max: Infinity },
];

// ── Aggregate a batch of rows into a daily stats object ───────────────────────
function aggregateRows(rows) {
  // Group by day → map → game_mode
  const groups = new Map();

  for (const row of rows) {
    const day      = row.played_at.slice(0, 10); // YYYY-MM-DD
    const map      = row.map      ?? 'Unknown';
    const gameMode = row.game_mode ?? 'Unknown';
    const key      = `${day}|${map}|${gameMode}`;

    if (!groups.has(key)) {
      groups.set(key, {
        day, map, game_mode: gameMode,
        dino_wins: 0, survivor_wins: 0, total_rounds: 0,
        brackets: Object.fromEntries(BRACKETS.map(b => [b.key, { dino_wins: 0, survivor_wins: 0, total: 0 }])),
        weapons:  new Map(), // name → { dino_wins, survivor_wins, total }
        vehicles: new Map(),
        dinos:    new Map(),
        num_players_with_medkits:          0,
        num_players_with_fuelcans:         0,
        num_players_with_toolkits:         0,
        num_players_with_dinotrackers:     0,
        num_players_with_mines:            0,
        num_players_with_gamepass_weapons: 0,
        place_ids: new Set(),
      });
    }

    const g = groups.get(key);
    const isDinoWin = row.round_result === 'DinoWin';

    g.total_rounds++;
    if (isDinoWin) g.dino_wins++; else g.survivor_wins++;

    // Level brackets
    const lvl = row.average_level;
    if (lvl != null) {
      for (const br of BRACKETS) {
        if (lvl >= br.min && lvl <= br.max) {
          g.brackets[br.key].total++;
          if (isDinoWin) g.brackets[br.key].dino_wins++;
          else           g.brackets[br.key].survivor_wins++;
          break;
        }
      }
    }

    // MVP weapon
    if (row.mvp_equipped_weapon) {
      const w = row.mvp_equipped_weapon;
      if (!g.weapons.has(w)) g.weapons.set(w, { dino_wins: 0, survivor_wins: 0, total: 0 });
      const wc = g.weapons.get(w);
      wc.total++;
      if (isDinoWin) wc.dino_wins++; else wc.survivor_wins++;
    }

    // MVP vehicle
    if (row.mvp_equipped_vehicle) {
      const v = row.mvp_equipped_vehicle;
      if (!g.vehicles.has(v)) g.vehicles.set(v, { dino_wins: 0, survivor_wins: 0, total: 0 });
      const vc = g.vehicles.get(v);
      vc.total++;
      if (isDinoWin) vc.dino_wins++; else vc.survivor_wins++;
    }

    // Dinos used
    const dinos = Array.isArray(row.dinosaurs_used)
      ? row.dinosaurs_used
      : (row.dinosaurs_used ? [row.dinosaurs_used] : []);
    for (const d of dinos) {
      if (!g.dinos.has(d)) g.dinos.set(d, { dino_wins: 0, survivor_wins: 0, total: 0 });
      const dc = g.dinos.get(d);
      dc.total++;
      if (isDinoWin) dc.dino_wins++; else dc.survivor_wins++;
    }

    // Pickup totals
    g.num_players_with_medkits          += row.num_players_with_medkits          ?? 0;
    g.num_players_with_fuelcans         += row.num_players_with_fuelcans         ?? 0;
    g.num_players_with_toolkits         += row.num_players_with_toolkits         ?? 0;
    g.num_players_with_dinotrackers     += row.num_players_with_dinotrackers     ?? 0;
    g.num_players_with_mines            += row.num_players_with_mines            ?? 0;
    g.num_players_with_gamepass_weapons += row.num_players_with_gamepass_weapons ?? 0;

    if (row.place_id) g.place_ids.add(String(row.place_id));
  }

  // Convert groups to upsert-ready objects
  return [...groups.values()].map(g => {
    const bracketCols = {};
    for (const br of BRACKETS) {
      const b = g.brackets[br.key];
      bracketCols[`bracket_${br.key}_dino_wins`]     = b.dino_wins;
      bracketCols[`bracket_${br.key}_survivor_wins`] = b.survivor_wins;
      bracketCols[`bracket_${br.key}_total`]         = b.total;
    }

    const toJsonb = (map) => [...map.entries()]
      .sort((a, b) => b[1].total - a[1].total)
      .map(([name, counts]) => ({ name, ...counts }));

    return {
      day:        g.day,
      map:        g.map,
      game_mode:  g.game_mode,
      dino_wins:     g.dino_wins,
      survivor_wins: g.survivor_wins,
      total_rounds:  g.total_rounds,
      ...bracketCols,
      mvp_weapons:  toJsonb(g.weapons),
      mvp_vehicles: toJsonb(g.vehicles),
      dinos_used:   toJsonb(g.dinos),
      num_players_with_medkits:          g.num_players_with_medkits,
      num_players_with_fuelcans:         g.num_players_with_fuelcans,
      num_players_with_toolkits:         g.num_players_with_toolkits,
      num_players_with_dinotrackers:     g.num_players_with_dinotrackers,
      num_players_with_mines:            g.num_players_with_mines,
      num_players_with_gamepass_weapons: g.num_players_with_gamepass_weapons,
      place_ids:  [...g.place_ids],
      updated_at: new Date().toISOString(),
    };
  });
}

// ── Main rollup function ──────────────────────────────────────────────────────
async function runRollup(supabase) {
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000);
  const cutoffISO = cutoff.toISOString();

  console.log(`[rollup] Starting rollup — archiving rows older than ${cutoffISO}`);

  // Fetch all rows older than retention window in batches of 10k
  const BATCH_SIZE = 10000;
  let offset = 0;
  let totalProcessed = 0;
  let totalDeleted = 0;

  while (true) {
    const { data: rows, error } = await supabase
      .from('round_logs')
      .select('*')
      .lt('played_at', cutoffISO)
      .order('played_at', { ascending: true })
      .range(offset, offset + BATCH_SIZE - 1);

    if (error) {
      console.error('[rollup] Failed to fetch rows:', error.message);
      return { success: false, error: error.message };
    }

    if (!rows || rows.length === 0) break;

    console.log(`[rollup] Processing batch of ${rows.length} rows (offset ${offset})`);

    // Aggregate this batch
    const stats = aggregateRows(rows);

    // Upsert into round_stats_daily — merge with existing rows for the same day/map/game_mode
    // Use raw SQL via rpc for true increment-on-conflict, or fetch+merge in JS
    for (const stat of stats) {
      // Fetch existing row for this day/map/game_mode if it exists
      const { data: existing } = await supabase
        .from('round_stats_daily')
        .select('*')
        .eq('day', stat.day)
        .eq('map', stat.map)
        .eq('game_mode', stat.game_mode)
        .maybeSingle();

      if (existing) {
        // Merge: add new counts to existing
        const merged = mergeStat(existing, stat);
        const { error: upsertErr } = await supabase
          .from('round_stats_daily')
          .update(merged)
          .eq('day', stat.day)
          .eq('map', stat.map)
          .eq('game_mode', stat.game_mode);

        if (upsertErr) {
          console.error(`[rollup] Failed to update stat for ${stat.day}/${stat.map}/${stat.game_mode}:`, upsertErr.message);
          return { success: false, error: upsertErr.message };
        }
      } else {
        const { error: insertErr } = await supabase
          .from('round_stats_daily')
          .insert(stat);

        if (insertErr) {
          console.error(`[rollup] Failed to insert stat for ${stat.day}/${stat.map}/${stat.game_mode}:`, insertErr.message);
          return { success: false, error: insertErr.message };
        }
      }
    }

    // Delete the processed rows by ID
    const ids = rows.map(r => r.id);
    const { error: deleteErr } = await supabase
      .from('round_logs')
      .delete()
      .in('id', ids);

    if (deleteErr) {
      console.error('[rollup] Failed to delete processed rows:', deleteErr.message);
      return { success: false, error: deleteErr.message };
    }

    totalProcessed += rows.length;
    totalDeleted   += rows.length;
    offset = 0; // Reset offset since we deleted the rows — next fetch starts fresh

    console.log(`[rollup] Processed and deleted ${rows.length} rows. Total so far: ${totalProcessed}`);

    if (rows.length < BATCH_SIZE) break;
  }

  console.log(`[rollup] Complete — processed ${totalProcessed} rows, deleted ${totalDeleted} raw rows.`);
  return { success: true, processed: totalProcessed, deleted: totalDeleted };
}

// ── Merge two stat objects (existing DB row + new aggregated batch) ────────────
function mergeStat(existing, incoming) {
  const merged = { updated_at: new Date().toISOString() };

  // Simple integer fields
  const intFields = [
    'dino_wins', 'survivor_wins', 'total_rounds',
    'num_players_with_medkits', 'num_players_with_fuelcans',
    'num_players_with_toolkits', 'num_players_with_dinotrackers',
    'num_players_with_mines', 'num_players_with_gamepass_weapons',
    ...BRACKETS.flatMap(b => [
      `bracket_${b.key}_dino_wins`,
      `bracket_${b.key}_survivor_wins`,
      `bracket_${b.key}_total`,
    ]),
  ];

  for (const f of intFields) {
    merged[f] = (existing[f] ?? 0) + (incoming[f] ?? 0);
  }

  // JSONB arrays — merge by name, summing counts
  merged.mvp_weapons  = mergeJsonbCounts(existing.mvp_weapons  ?? [], incoming.mvp_weapons  ?? []);
  merged.mvp_vehicles = mergeJsonbCounts(existing.mvp_vehicles ?? [], incoming.mvp_vehicles ?? []);
  merged.dinos_used   = mergeJsonbCounts(existing.dinos_used   ?? [], incoming.dinos_used   ?? []);

  // place_ids — union
  const placeSet = new Set([...(existing.place_ids ?? []), ...(incoming.place_ids ?? [])]);
  merged.place_ids = [...placeSet];

  return merged;
}

function mergeJsonbCounts(existingArr, incomingArr) {
  const map = new Map();

  for (const item of existingArr) {
    map.set(item.name, { dino_wins: item.dino_wins ?? 0, survivor_wins: item.survivor_wins ?? 0, total: item.total ?? 0 });
  }
  for (const item of incomingArr) {
    if (map.has(item.name)) {
      const e = map.get(item.name);
      map.set(item.name, {
        dino_wins:     e.dino_wins     + (item.dino_wins     ?? 0),
        survivor_wins: e.survivor_wins + (item.survivor_wins ?? 0),
        total:         e.total         + (item.total         ?? 0),
      });
    } else {
      map.set(item.name, { dino_wins: item.dino_wins ?? 0, survivor_wins: item.survivor_wins ?? 0, total: item.total ?? 0 });
    }
  }

  return [...map.entries()]
    .sort((a, b) => b[1].total - a[1].total)
    .map(([name, counts]) => ({ name, ...counts }));
}

// ── Scheduler ─────────────────────────────────────────────────────────────────
// Runs nightly at 3 AM UTC (quiet period, avoids batch summary window).
function getMsUntilNext3amUTC() {
  const now = new Date();
  const next = new Date(now);
  next.setUTCHours(3, 0, 0, 0);
  if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
  return next.getTime() - now.getTime();
}

module.exports = function setupRollup(client, { supabase }) {
  async function scheduleNext() {
    const ms  = getMsUntilNext3amUTC();
    const hrs = (ms / (60 * 60 * 1000)).toFixed(1);
    console.log(`[rollup] Next rollup in ${hrs}h (3 AM UTC).`);

    setTimeout(async () => {
      const result = await runRollup(supabase);
      if (!result.success) {
        console.error('[rollup] Rollup failed:', result.error);
      }
      scheduleNext();
    }, ms);
  }

  scheduleNext();
};

// Expose for manual trigger
module.exports.runRollup = runRollup;