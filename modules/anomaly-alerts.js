// ─── Anomaly Alerts ───────────────────────────────────────────────────────────
// Checks win rates for dinos, weapons, and vehicles over the last 100 rounds
// and posts alerts to a designated channel when thresholds are crossed.
//
// Thresholds are configurable via env vars — tune after seeing real data:
//   ANOMALY_HIGH_THRESHOLD  (default: 0.75 — 75% win rate = overpowered alert)
//   ANOMALY_LOW_THRESHOLD   (default: 0.25 — 25% win rate = underpowered alert)
//
// Checks run hourly to avoid Supabase rate limits.
// Deduplication: alerts for the same item+direction are suppressed for 24 hours
// to avoid spam if the condition persists across multiple hourly checks.

const { EmbedBuilder } = require('discord.js');

const ALERT_CHANNEL_ID  = '1515751050085138563';
const CHECK_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const SAMPLE_SIZE       = 100;            // rolling last N rounds
const MIN_SAMPLE        = 20;             // minimum rounds before alerting on an item
const DEDUP_WINDOW_MS   = 24 * 60 * 60 * 1000; // suppress repeat alerts for 24h

// In-memory dedup store: `${category}:${name}:${direction}` -> timestamp last alerted
const alertedAt = new Map();

function getThresholds() {
  const high = parseFloat(process.env.ANOMALY_HIGH_THRESHOLD ?? '0.75');
  const low  = parseFloat(process.env.ANOMALY_LOW_THRESHOLD  ?? '0.25');
  return { high, low };
}

function isDuped(key) {
  const last = alertedAt.get(key);
  return last && (Date.now() - last) < DEDUP_WINDOW_MS;
}

function markAlerted(key) {
  alertedAt.set(key, Date.now());
}

// Aggregate win rates for a given field (dino/weapon/vehicle) across recent rows.
// Returns Map<name, { wins, total, winRate }>
function aggregateWinRates(rows, field) {
  const map = new Map();
  for (const row of rows) {
    const val = row[field];
    if (!val) continue;
    if (!map.has(val)) map.set(val, { wins: 0, total: 0 });
    const entry = map.get(val);
    entry.total++;
    if (row.won) entry.wins++;
  }
  for (const entry of map.values()) {
    entry.winRate = entry.total > 0 ? entry.wins / entry.total : 0;
  }
  return map;
}

async function runAnomalyCheck(client, supabase) {
  const { high, low } = getThresholds();

  // Fetch last SAMPLE_SIZE rounds
  const { data: rows, error } = await supabase
    .from('round_logs')
    .select('mvp_equipped_weapon, mvp_equipped_vehicle, round_result')
    .order('id', { ascending: false })
    .limit(SAMPLE_SIZE);

  if (error || !rows || rows.length === 0) {
    console.error('[anomaly] Failed to fetch round data:', error?.message ?? 'no rows');
    return;
  }

  const channel = client.channels.cache.get(ALERT_CHANNEL_ID)
    ?? await client.channels.fetch(ALERT_CHANNEL_ID).catch(() => null);

  if (!channel) {
    console.error('[anomaly] Could not find alert channel', ALERT_CHANNEL_ID);
    return;
  }

  const alerts = [];

  // Remap rows to normalised shape — MVP-correlation proxy same as /winrate.
  // Dino category omitted until KKG adds a dino identity field to round_logs.
  const normalisedRows = rows.map(r => ({
    weapon:  r.mvp_equipped_weapon  ?? null,
    vehicle: r.mvp_equipped_vehicle ?? null,
    won:     r.round_result === 'SurvivorWin',
  }));

  const categories = [
    { key: 'weapon',  emoji: '🔫', label: 'Weapon'  },
    { key: 'vehicle', emoji: '🚗', label: 'Vehicle' },
  ];

  for (const { key, emoji, label } of categories) {
    const winRates = aggregateWinRates(normalisedRows, key);

    for (const [name, { wins, total, winRate }] of winRates) {
      if (total < MIN_SAMPLE) continue;

      if (winRate >= high) {
        const dedupKey = `${key}:${name}:high`;
        if (!isDuped(dedupKey)) {
          alerts.push({
            dedupKey,
            direction: 'high',
            emoji,
            label,
            name,
            winRate,
            wins,
            total,
          });
          markAlerted(dedupKey);
        }
      } else if (winRate <= low) {
        const dedupKey = `${key}:${name}:low`;
        if (!isDuped(dedupKey)) {
          alerts.push({
            dedupKey,
            direction: 'low',
            emoji,
            label,
            name,
            winRate,
            wins,
            total,
          });
          markAlerted(dedupKey);
        }
      }
    }
  }

  if (alerts.length === 0) {
    console.log('[anomaly] Check complete — no new anomalies detected.');
    return;
  }

  // Post one embed per alert to keep them distinct and easy to action
  for (const alert of alerts) {
    const isHigh = alert.direction === 'high';
    const color  = isHigh ? 0xED4245 : 0x5865F2; // red = OP, blue = UP
    const tag    = isHigh ? '🔴 OVERPOWERED' : '🔵 UNDERPOWERED';
    const pct    = (alert.winRate * 100).toFixed(1);
    const thresh = isHigh
      ? (high * 100).toFixed(0)
      : (low  * 100).toFixed(0);

    const embed = new EmbedBuilder()
      .setColor(color)
      .setTitle(`${alert.emoji} Balance Anomaly Detected — ${tag}`)
      .setDescription(
        `**${alert.label}: ${alert.name}** has a win rate of **${pct}%** ` +
        `over the last ${alert.total} rounds, which is ` +
        `${isHigh ? `above the **${thresh}%** overpowered threshold` : `below the **${thresh}%** underpowered threshold`}.\n\n` +
        `**Wins:** ${alert.wins} / ${alert.total} rounds\n` +
        `**Sample window:** last ${SAMPLE_SIZE} rounds (rolling)\n\n` +
        `This alert will not repeat for 24 hours unless the anomaly persists into the next check window.`
      )
      .setFooter({ text: 'PrimalGame Anomaly Monitor' })
      .setTimestamp();

    await channel.send({ embeds: [embed] }).catch(err =>
      console.error('[anomaly] Failed to post alert:', err.message)
    );
  }

  console.log(`[anomaly] Check complete — ${alerts.length} alert(s) posted.`);
}

module.exports = function setupAnomalyAlerts(client, { supabase }) {
  if (!supabase) {
    console.log('[anomaly] Skipping setup — supabase not configured.');
    return;
  }

  // Stagger first check by 5 minutes after boot to avoid startup congestion
  setTimeout(() => {
    runAnomalyCheck(client, supabase);
    setInterval(() => runAnomalyCheck(client, supabase), CHECK_INTERVAL_MS);
  }, 5 * 60 * 1000);

  console.log('[anomaly] Anomaly alert scheduler started — first check in 5 minutes, then hourly.');
};

// Expose for manual testing via a future /checkanomalies staff command
module.exports.runAnomalyCheck = runAnomalyCheck;