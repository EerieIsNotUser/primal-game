const { SlashCommandBuilder, AttachmentBuilder } = require('discord.js');
const { buildWinRateCardV2 } = require('../modules/chart');

// ─── /testwinrate ─────────────────────────────────────────────────────────────
// Renders a V2 win rate card with synthetic data for design comparison.
// Not a real query — purely for previewing the new card layout.

module.exports = {
  data: new SlashCommandBuilder()
    .setName('testwinrate')
    .setDescription('Preview the experimental V2 win rate card design')
    .addStringOption(opt =>
      opt.setName('category')
        .setDescription('Category to preview')
        .setRequired(false)
        .addChoices(
          { name: 'Weapon',   value: 'weapon'  },
          { name: 'Vehicle',  value: 'vehicle' },
          { name: 'Dinosaur', value: 'dino'    },
        )
    ),

  async execute(interaction) {
    await interaction.deferReply();

    const category = interaction.options.getString('category') ?? 'weapon';

    // Synthetic data matching realistic Police Car / IWS 2000 / Deino ranges
    const synthData = {
      weapon: {
        itemName: 'IWS 2000', rounds: 10311, survivorWins: 7014, dinoWins: 3297,
        bestMap: { name: 'Jungle', survivorWinPct: 70, rounds: 5982 },
        coItem:  { name: 'Muscle Car', count: 1901 },
        baseline: { rate: 0.66, rounds: 41200 },
        levelBrackets: [
          { label: '1–20',    survivorPct: 77, total: 644  },
          { label: '21–40',   survivorPct: 72, total: 4128 },
          { label: '41–100',  survivorPct: 63, total: 3941 },
          { label: '100–250', survivorPct: 59, total: 1598 },
        ],
      },
      vehicle: {
        itemName: 'Police Car', rounds: 10311, survivorWins: 7014, dinoWins: 3297,
        bestMap: { name: 'Jungle', survivorWinPct: 76, rounds: 5982 },
        coItem:  { name: 'Minigun', count: 1901 },
        baseline: null,
        levelBrackets: [
          { label: '1–20',    survivorPct: 77, total: 644  },
          { label: '21–40',   survivorPct: 72, total: 4128 },
          { label: '41–100',  survivorPct: 62, total: 3941 },
          { label: '100–250', survivorPct: 59, total: 1598 },
        ],
      },
      dino: {
        itemName: 'Deino', rounds: 638, survivorWins: 389, dinoWins: 249,
        bestMap: { name: 'Cavern', survivorWinPct: 18, rounds: 17 },
        coItem:  null,
        baseline: null,
        levelBrackets: [
          { label: '35–40',   survivorPct: 75, total: 4   },
          { label: '41–100',  survivorPct: 72, total: 394 },
          { label: '100–250', survivorPct: 40, total: 228 },
        ],
      },
    };

    const data = synthData[category];

    const buffer = await buildWinRateCardV2({
      ...data,
      category,
      lookback: 'Past month · Pro Lobbies (weighted)',
    });

    return interaction.editReply({
      content: `**Win Rate Card V2 — ${category} preview** · Synthetic data`,
      files: [new AttachmentBuilder(buffer, { name: 'winrate-v2-test.png' })],
    });
  },
};