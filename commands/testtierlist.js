const { SlashCommandBuilder, AttachmentBuilder } = require('discord.js');
const { buildTierListCard } = require('../modules/chart');

// ─── /testtierlist ────────────────────────────────────────────────────────────
// Posts synthetic tier list cards to preview the layout without real data.

const WEAPONS = ['Plasma Rifle','AK-47','Flamethrower','IWS 2000','LMG','Deagle','Railgun','MP5','Shotgun','Crossbow'];
const VEHICLES = ['Hypercar','Police Car','MRAP','Monster Truck','ATV','Jeep','Go-Kart','Pickup Truck','Muscle Car','Warthog'];
const PICKUPS = ['Med Kit','Fuel Can','Toolkit','Dino Tracker','Mine','Gamepass Weapon'];

function randInt(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }

function generateItems(names, baseCount) {
  return names
    .map(name => ({ name, count: randInt(Math.floor(baseCount * 0.3), baseCount) }))
    .sort((a, b) => b.count - a.count);
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('testtierlist')
    .setDescription('Preview tier list cards with synthetic data'),

  async execute(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const lookback = 'Jun 1 – Jun 30, 2026';
    const weaponItems  = generateItems(WEAPONS, 120);
    const vehicleItems = generateItems(VEHICLES, 120);
    const pickupItems  = generateItems(PICKUPS, 800);

    const cards = [
      {
        buffer: await buildTierListCard({
          title:       'Top 10 MVP Weapons',
          subtitle:    'Primal Pursuit · Weekly Tier List  (test)',
          stats: [{ label: 'MVP Rounds', value: weaponItems.reduce((s, i) => s + i.count, 0).toLocaleString(), color: '#ED4245' }],
          lookback,
          items:       weaponItems,
          accentColor: '#ED4245',
        }),
        name: 'test-tierlist-weapons.png',
      },
      {
        buffer: await buildTierListCard({
          title:       'Top 10 MVP Vehicles',
          subtitle:    'Primal Pursuit · Weekly Tier List  (test)',
          stats: [{ label: 'MVP Rounds', value: vehicleItems.reduce((s, i) => s + i.count, 0).toLocaleString(), color: '#5865F2' }],
          lookback,
          items:       vehicleItems,
          accentColor: '#5865F2',
        }),
        name: 'test-tierlist-vehicles.png',
      },
      {
        buffer: await buildTierListCard({
          title:       'Pickup Item Adoption',
          subtitle:    'Primal Pursuit · Weekly Tier List  (test)',
          stats: [{ label: 'Total Pickups', value: pickupItems.reduce((s, i) => s + i.count, 0).toLocaleString(), color: '#57F287' }],
          lookback,
          items:       pickupItems,
          accentColor: '#57F287',
        }),
        name: 'test-tierlist-pickups.png',
      },
    ];

    await interaction.channel.send({
      content: '*(test data)* **Weekly Tier List** — Jun 1 – Jun 30, 2026',
      files: cards.map(c => new AttachmentBuilder(c.buffer, { name: c.name })),
    }).catch(err => console.error('[testtierlist] send failed:', err.message));

    return interaction.editReply('Posted test tier list above.');
  },
};