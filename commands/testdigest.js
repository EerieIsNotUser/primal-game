const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { writeDigest, buildBreakdownEmbeds } = require('../modules/map-history-digest');

const MAPS = ['Jungle', 'Canyon', 'Cavern', 'Primal Park'];
const DINOS = ['Trex', 'Pachycephalosaurus', 'Deinosuchus', 'Triceratops'];
const WEAPONS = ['Railgun', 'Sawn-off Shotgun', 'MP5', 'Deagle'];
const VEHICLES = ['Tow Truck', 'Pickup', 'Pumpkin Wagon'];
const PICKUPS = ['Fuel Can', 'Repair Kit', 'Med Kit', 'Dino Tracker', 'Mine'];

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function randomInt(min, max) {
  return min + Math.floor(Math.random() * (max - min + 1));
}

// Generate a weighted random count map for a list of items - one "favorite"
// item gets a noticeably higher count, the rest get smaller random counts.
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
      // favorite item gets 30-50% of the total
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
  // Per-map round counts for "this week"
  const mapCounts = weightedCounts(MAPS, [25, 60]);
  const total = [...mapCounts.values()].reduce((a, b) => a + b, 0);
  const ranked = [...mapCounts.entries()].sort((a, b) => b[1] - a[1]);
  const current = { ranked, total };

  // "Prior week" - similar but with some variance, to produce movement
  const prior = new Map();
  for (const [map, count] of mapCounts) {
    const drift = randomInt(-8, 8);
    prior.set(map, Math.max(0, count + drift));
  }

  // Per-map item breakdowns
  const perMap = new Map();
  for (const [map] of mapCounts) {
    perMap.set(map, {
      dino: weightedCounts(DINOS, [8, 25]),
      weapon: weightedCounts(WEAPONS, [8, 25]),
      vehicle: weightedCounts(VEHICLES, [5, 15]),
      pickup: weightedCounts(PICKUPS, [5, 20]),
    });
  }

  return { current, prior, perMap };
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('testdigest')
    .setDescription('Post a sample weekly map-history digest using generated test data'),

  async execute(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const { current, prior, perMap } = generateFakeWeekData();

    const text = writeDigest(current, prior);
    const mapOrder = current.ranked.map(([map]) => map);
    const breakdownEmbeds = buildBreakdownEmbeds(perMap, mapOrder, EmbedBuilder);

    await interaction.channel.send(`*(test data)*\n${text}`).catch(() => {});
    await interaction.channel.send({ embeds: breakdownEmbeds }).catch(() => {});

    return interaction.editReply('Posted a test digest with generated data above.');
  },
};