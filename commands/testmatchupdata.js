const { SlashCommandBuilder, AttachmentBuilder } = require('discord.js');
const { buildStatCard, buildTierListCard, MAP_COLORS } = require('../modules/chart');

// ─── /testmatchupdata ─────────────────────────────────────────────────────────
// Posts synthetic matchup data cards to preview the layout without real data.

const ALL_MAPS   = ['Jungle', 'Canyon', 'Cavern', 'Primal Park'];
const WEAPONS    = ['Plasma Rifle', 'AK-47', 'Flamethrower', 'IWS 2000', 'LMG', 'Deagle', 'Railgun', 'MP5', 'Shotgun', 'Crossbow'];
const VEHICLES   = ['Hypercar', 'Police Car', 'MRAP', 'Monster Truck', 'ATV', 'Jeep', 'Go-Kart', 'Pickup Truck', 'Muscle Car', 'Warthog'];
const DINOS      = ['T-Rex', 'Pachy', 'Raptor', 'Carno', 'Dilo', 'Giga', 'Spino', 'Trike', 'Deino', 'Bronto'];

function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function randInt(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }

function generateMapStats() {
  const dinoWinPct  = randInt(35, 65);
  const rounds      = randInt(80, 300);
  const topWeapon   = pick(WEAPONS);
  const topVehicle  = pick(VEHICLES);
  const topDino     = pick(DINOS);
  const wCount      = randInt(10, Math.floor(rounds * 0.4));
  const vCount      = randInt(10, Math.floor(rounds * 0.4));
  const dCount      = randInt(15, Math.floor(rounds * 0.6));
  return { dinoWinPct, rounds, topWeapon, wCount, topVehicle, vCount, topDino, dCount };
}

function generatePairs(limit = 10) {
  const pairs = [];
  const used  = new Set();
  while (pairs.length < limit) {
    const w = pick(WEAPONS);
    const v = pick(VEHICLES);
    const key = `${w} + ${v}`;
    if (used.has(key)) continue;
    used.add(key);
    pairs.push({ name: key, count: randInt(5, 80) });
  }
  return pairs.sort((a, b) => b.count - a.count);
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('testmatchupdata')
    .setDescription('Preview matchup data cards with synthetic data'),

  async execute(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const lookback  = 'Jun 1 – Jun 30, 2026';
    const tierLabel = 'Weekly';
    const files     = [];

    // Per-map cards
    for (const map of ALL_MAPS) {
      const stats    = generateMapStats();
      const survWinPct = 100 - stats.dinoWinPct;

      const buf = await buildStatCard({
        title:    map,
        subtitle: `Matchup Data · ${tierLabel}  (test)`,
        stats: [
          { label: 'Rounds',       value: stats.rounds.toLocaleString(), color: MAP_COLORS[map] ?? '#5865F2' },
          { label: 'Dino Win',     value: `${stats.dinoWinPct}%`,        color: '#ED4245' },
          { label: 'Survivor Win', value: `${survWinPct}%`,              color: '#57F287' },
        ],
        lookback,
        panels: [
          { title: 'Top MVP Gun', lines: [`${stats.topWeapon} (${stats.wCount}x)`]  },
          { title: 'Top MVP Car', lines: [`${stats.topVehicle} (${stats.vCount}x)`] },
          { title: 'Top Dino',    lines: [`${stats.topDino} (${stats.dCount}x)`]    },
        ],
      });

      files.push(new AttachmentBuilder(buf, { name: `test-matchup-${map.replace(/\s+/g, '-').toLowerCase()}.png` }));
    }

    // MVP pairs card
    const pairs     = generatePairs();
    const pairTotal = pairs.reduce((s, i) => s + i.count, 0);
    const pairBuf   = await buildTierListCard({
      title:       'Top MVP Weapon + Vehicle Pairs',
      subtitle:    `Primal Pursuit · ${tierLabel}  (test)`,
      stats: [{ label: 'MVP Rounds', value: pairTotal.toLocaleString(), color: '#FEE75C' }],
      lookback,
      items:       pairs,
      accentColor: '#FEE75C',
    });
    files.push(new AttachmentBuilder(pairBuf, { name: 'test-matchup-pairs.png' }));

    await interaction.channel.send({
      content: `*(test data)* **Weekly Matchup Data** — ${lookback}`,
      files,
    }).catch(err => console.error('[testmatchupdata] send failed:', err.message));

    return interaction.editReply('Posted test matchup data above.');
  },
};