const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { writeDigest, buildOverallBarsEmbed } = require('../modules/map-history-digest');

const MAPS = ['Jungle', 'Canyon', 'Cavern', 'Primal Park'];
const DINOS = ['Trex', 'Pachycephalosaurus', 'Deinosuchus', 'Triceratops'];
const WEAPONS = ['Railgun', 'Sawn-off Shotgun', 'MP5', 'Deagle'];
const VEHICLES = ['Tow Truck', 'Pickup', 'Pumpkin Wagon'];
const PICKUPS = ['Fuel Can', 'Repair Kit', 'Med Kit', 'Dino Tracker', 'Mine'];

function randomInt(min, max) {
  return min + Math.floor(Math.random() * (max - min + 1));
}

function weightedCounts(items, totalRange = [10, 40]) {
  const shuffled = [...items].sort(() => Math.random() - 0.5);
  const counts = new Map();
  const total = randomInt(...totalRange);
  let remaining = total;

  for (let i = 0; i < shuffled.length; i++) {
    const isLast = i === shuffled.length - 1;
    let count;
    if (isLast) {
      count = remaining;
    } else if (i === 0) {
      count = Math.max(1, Math.round(total * (0.3 + Math.random() * 0.2)));
    } else {
      count = randomInt(0, Math.max(1, Math.floor(remaining / (shuffled.length - i))));
    }
    count = Math.min(count, remaining);
    if (count > 0) counts.set(shuffled[i], count);
    remaining -= count;
  }

  return counts;
}

function generateFakeWeekData() {
  const mapCounts = weightedCounts(MAPS, [25, 60]);
  const total = [...mapCounts.values()].reduce((a, b) => a + b, 0);
  const ranked = [...mapCounts.entries()].sort((a, b) => b[1] - a[1]);
  const current = { ranked, total };

  const prior = new Map();
  for (const [map, count] of mapCounts) {
    const drift = randomInt(-8, 8);
    prior.set(map, Math.max(0, count + drift));
  }

  const overall = {
    dino: weightedCounts(DINOS, [3000, 12000]),
    weapon: weightedCounts(WEAPONS, [3000, 12000]),
    vehicle: weightedCounts(VEHICLES, [2000, 8000]),
    pickup: weightedCounts(PICKUPS, [1000, 6000]),
  };

  return { current, prior, overall };
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('testdigest')
    .setDescription('Post a sample weekly map-history digest using generated test data'),

  async execute(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const { current, prior, overall } = generateFakeWeekData();

    const text = writeDigest(current, prior);
    const barsEmbed = buildOverallBarsEmbed(overall, EmbedBuilder);

    await interaction.channel.send(`*(test data)*\n${text}`).catch(err => {
      console.error('[testdigest] send failed:', err.message);
    });
    await interaction.channel.send({ embeds: [barsEmbed] }).catch(err => {
      console.error('[testdigest] send failed:', err.message);
    });

    return interaction.editReply('Posted a test digest with generated data above.');
  },
};