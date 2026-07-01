// ─── Tier List Digest ─────────────────────────────────────────────────────────
// Posts a ranked tier list to #tierlist every Friday at midnight US Eastern.
// Covers: Top 10 MVP Weapons, Top 10 MVP Vehicles, Pickup Item Adoption.
// Dinos added once KKG adds dino identity field to the payload.
//
// Tier priority (same as map-history):
//   Yearly    ≥ 365 days   Quarterly ≥ 91 days
//   Monthly   ≥ 28 days    Weekly    always
//
// NOTE: Monthly, quarterly, yearly can be triggered manually via planned
// /tierlist [period] command.

const { AttachmentBuilder } = require('discord.js');
const { buildTierListCard } = require('./chart');

const CHANNEL_ID = '1515750926688845945';

const TIERS = [
  { key: 'yearly',    label: 'Yearly',    minDays: 365 },
  { key: 'quarterly', label: 'Quarterly', minDays: 91  },
  { key: 'monthly',   label: 'Monthly',   minDays: 28  },
  { key: 'weekly',    label: 'Weekly',    minDays: 7   },
];

const PICKUP_FIELDS = [
  { field: 'num_players_with_medkits',         label: 'Med Kit'         },
  { field: 'num_players_with_fuelcans',         label: 'Fuel Can'        },
  { field: 'num_players_with_toolkits',         label: 'Toolkit'         },
  { field: 'num_players_with_dinotrackers',     label: 'Dino Tracker'    },
  { field: 'num_players_with_mines',            label: 'Mine'            },
];

// ── Scheduler ─────────────────────────────────────────────────────────────────
function getMsUntilNextFridayMidnightNY() {
  const now = new Date();

  for (let i = 1; i <= 8; i++) {
    const candidate = new Date(now.getTime() + i * 24 * 60 * 60 * 1000);
    const dayInNY   = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York', weekday: 'short',
    }).format(candidate);

    if (dayInNY !== 'Fri') continue;

    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(candidate);

    const yr = parts.find(p => p.type === 'year').value;
    const mo = parts.find(p => p.type === 'month').value;
    const dy = parts.find(p => p.type === 'day').value;

    const noonUTC  = new Date(`${yr}-${mo}-${dy}T12:00:00Z`);
    const noonNYHr = parseInt(new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York', hour: 'numeric', hour12: false,
    }).format(noonUTC));
    const offsetHrs  = 12 - noonNYHr;
    const midnightUTC = new Date(`${yr}-${mo}-${dy}T${String(offsetHrs).padStart(2, '0')}:00:00Z`);
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
      .eq('key', `tierlist_${tier.key}_at`)
      .single();

    const lastAt     = data?.value ? new Date(data.value).getTime() : 0;
    const daysSince  = (now - lastAt) / (24 * 60 * 60 * 1000);

    if (daysSince >= tier.minDays) return tier;
  }

  return TIERS[TIERS.length - 1];
}

// ── Data fetching ─────────────────────────────────────────────────────────────
async function fetchTopMvp(supabase, field, days, limit = 10) {
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const { data, error } = await supabase
    .from('round_logs')
    .select(field)
    .gte('played_at', cutoff.toISOString())
    .not(field, 'is', null);

  if (error || !data) return [];

  const counts = new Map();
  for (const row of data) {
    const val = row[field];
    if (val) counts.set(val, (counts.get(val) || 0) + 1);
  }

  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([name, count]) => ({ name, count }));
}

async function fetchTopPickups(supabase, days) {
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const { data, error } = await supabase
    .from('round_logs')
    .select(PICKUP_FIELDS.map(f => f.field).join(', '))
    .gte('played_at', cutoff.toISOString());

  if (error || !data) return [];

  const totals = {};
  for (const pf of PICKUP_FIELDS) totals[pf.field] = 0;

  for (const row of data) {
    for (const pf of PICKUP_FIELDS) {
      totals[pf.field] += row[pf.field] ?? 0;
    }
  }

  return PICKUP_FIELDS
    .map(pf => ({ name: pf.label, count: totals[pf.field] }))
    .sort((a, b) => b.count - a.count);
}

// ── Post digest ───────────────────────────────────────────────────────────────
async function postTierList(client, supabase) {
  const tier = await determineTier(supabase);
  const days = tier.minDays;

  const ch = client.channels.cache.get(CHANNEL_ID)
    ?? await client.channels.fetch(CHANNEL_ID).catch(() => null);
  if (!ch) { console.error('[tierlist] Could not find channel'); return; }

  const startStr = new Date(Date.now() - days * 24 * 60 * 60 * 1000)
    .toLocaleDateString('en-US', { month: 'long', day: 'numeric' });
  const endStr   = new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
  const lookback = `${startStr} – ${endStr}`;

  const [topWeapons, topVehicles, topPickups] = await Promise.all([
    fetchTopMvp(supabase, 'mvp_equipped_weapon',  days),
    fetchTopMvp(supabase, 'mvp_equipped_vehicle', days),
    fetchTopPickups(supabase, days),
  ]);

  const totalWeaponRounds  = topWeapons.reduce((s, i)  => s + i.count, 0);
  const totalVehicleRounds = topVehicles.reduce((s, i) => s + i.count, 0);
  const totalPickupPlayers = topPickups.reduce((s, i)  => s + i.count, 0);

  const cards = [
    {
      buffer: await buildTierListCard({
        title:       'Top 10 MVP Weapons',
        subtitle:    `Primal Pursuit · ${tier.label} Tier List`,
        stats: [{ label: 'MVP Rounds', value: totalWeaponRounds.toLocaleString(), color: '#ED4245' }],
        lookback,
        items:       topWeapons,
        accentColor: '#ED4245',
      }),
      name: 'tierlist-weapons.png',
    },
    {
      buffer: await buildTierListCard({
        title:       'Top 10 MVP Vehicles',
        subtitle:    `Primal Pursuit · ${tier.label} Tier List`,
        stats: [{ label: 'MVP Rounds', value: totalVehicleRounds.toLocaleString(), color: '#5865F2' }],
        lookback,
        items:       topVehicles,
        accentColor: '#5865F2',
      }),
      name: 'tierlist-vehicles.png',
    },
    {
      buffer: await buildTierListCard({
        title:       'Pickup Item Adoption',
        subtitle:    `Primal Pursuit · ${tier.label} Tier List`,
        stats: [{ label: 'Total Pickups', value: totalPickupPlayers.toLocaleString(), color: '#57F287' }],
        lookback,
        items:       topPickups,
        accentColor: '#57F287',
      }),
      name: 'tierlist-pickups.png',
    },
  ];

  await ch.send({
    content: `**${tier.label} Tier List** — ${lookback}`,
    files: cards.map(c => new AttachmentBuilder(c.buffer, { name: c.name })),
  }).catch(err => console.error('[tierlist] Failed to post:', err.message));

  // Update state
  const toUpdate = ['weekly'];
  if (tier.key !== 'weekly') toUpdate.push(tier.key);
  for (const key of toUpdate) {
    await supabase.from('primalgame_state')
      .upsert({ key: `tierlist_${key}_at`, value: new Date().toISOString() });
  }

  console.log(`[tierlist] Posted ${tier.label} tier list.`);
}

// ── Setup ─────────────────────────────────────────────────────────────────────
module.exports = function setupTierList(client, { supabase }) {
  async function scheduleNext() {
    const ms  = getMsUntilNextFridayMidnightNY();
    const hrs = Math.round(ms / (60 * 60 * 1000));
    console.log(`[tierlist] Next post in ${hrs}h (Friday midnight ET).`);

    setTimeout(async () => {
      await postTierList(client, supabase);
      scheduleNext();
    }, ms);
  }

  scheduleNext();
};

// Expose for manual trigger via planned /tierlist command
module.exports.postTierList = postTierList;