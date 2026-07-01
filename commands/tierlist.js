const { SlashCommandBuilder, AttachmentBuilder } = require('discord.js');
const chrono = require('chrono-node');
const { buildTierListCard } = require('../modules/chart');

// ─── /tierlist ────────────────────────────────────────────────────────────────
// Manual tier list with optional natural-language date range.
// Defaults to the last 7 days if no dates are provided.

const PICKUP_FIELDS = [
  { field: 'num_players_with_medkits',         label: 'Med Kit'         },
  { field: 'num_players_with_fuelcans',         label: 'Fuel Can'        },
  { field: 'num_players_with_toolkits',         label: 'Toolkit'         },
  { field: 'num_players_with_dinotrackers',     label: 'Dino Tracker'    },
  { field: 'num_players_with_mines',            label: 'Mine'            },
];

function parseDateRange(text) {
  const results = chrono.parse(text, new Date());
  if (results.length === 0) return null;
  const result    = results[0];
  const startDate = result.start ? result.start.date() : null;
  const endDate   = result.end   ? result.end.date()   : (result.start ? result.start.date() : null);
  if (!startDate) return null;
  return { startDate, endDate: endDate ?? startDate };
}

async function fetchTopMvp(supabase, field, startDate, endDate, limit = 10) {
  const { data, error } = await supabase
    .from('round_logs')
    .select(field)
    .gte('played_at', startDate.toISOString())
    .lte('played_at', endDate.toISOString())
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

async function fetchTopPickups(supabase, startDate, endDate) {
  const { data, error } = await supabase
    .from('round_logs')
    .select(PICKUP_FIELDS.map(f => f.field).join(', '))
    .gte('played_at', startDate.toISOString())
    .lte('played_at', endDate.toISOString());

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

module.exports = {
  data: new SlashCommandBuilder()
    .setName('tierlist')
    .setDescription('View ranked tier list for weapons, vehicles and pickups')
    .addStringOption(opt =>
      opt.setName('dates')
        .setDescription('Date range e.g. "January 15th through May 30th" (default: past 7 days)')
        .setRequired(false)
    ),

  async execute(interaction, { supabase }) {
    await interaction.deferReply();

    const datesInput = interaction.options.getString('dates');
    let startDate, endDate, lookback;

    if (datesInput) {
      const parsed = parseDateRange(datesInput);
      if (!parsed) {
        return interaction.editReply(
          `❌ Couldn't understand "${datesInput}". Try something like "January 15th through May 30th" or "last 30 days".`
        );
      }
      startDate = parsed.startDate;
      endDate   = parsed.endDate;
      lookback  = `${startDate.toLocaleDateString('en-US', { month: 'long', day: 'numeric' })} – ${endDate.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}`;
    } else {
      endDate   = new Date();
      startDate = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
      lookback  = 'Past 7 Days';
    }

    const [topWeapons, topVehicles, topPickups] = await Promise.all([
      fetchTopMvp(supabase, 'mvp_equipped_weapon',  startDate, endDate),
      fetchTopMvp(supabase, 'mvp_equipped_vehicle', startDate, endDate),
      fetchTopPickups(supabase, startDate, endDate),
    ]);

    if (!topWeapons.length && !topVehicles.length && !topPickups.length) {
      return interaction.editReply(`No round data found for the selected date range.`);
    }

    const totalWeaponRounds  = topWeapons.reduce((s, i)  => s + i.count, 0);
    const totalVehicleRounds = topVehicles.reduce((s, i) => s + i.count, 0);
    const totalPickupPlayers = topPickups.reduce((s, i)  => s + i.count, 0);

    const cards = [
      {
        buffer: await buildTierListCard({
          title:       'Top 10 MVP Weapons',
          subtitle:    `Primal Pursuit · ${lookback}`,
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
          subtitle:    `Primal Pursuit · ${lookback}`,
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
          subtitle:    `Primal Pursuit · ${lookback}`,
          stats: [{ label: 'Total Pickups', value: totalPickupPlayers.toLocaleString(), color: '#57F287' }],
          lookback,
          items:       topPickups,
          accentColor: '#57F287',
        }),
        name: 'tierlist-pickups.png',
      },
    ];

    return interaction.editReply({
      content: `**Tier List** — ${lookback}`,
      files: cards.map(c => new AttachmentBuilder(c.buffer, { name: c.name })),
    });
  },
};