const { SlashCommandBuilder, AttachmentBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { buildPieCard, MAP_COLORS } = require('../modules/chart');

// ─── /testpiechart ────────────────────────────────────────────────────────
// Generates synthetic data and posts both modes (distribution + win/loss)
// so the card layout can be verified without real round data.

const ALL_MAPS = ['Jungle', 'Canyon', 'Cavern', 'Primal Park'];

const MAP_PROFILES = {
  'Jungle':       { base: 500, variance: 100 },
  'Canyon':       { base: 320, variance: 80  },
  'Cavern':       { base: 210, variance: 60  },
  'Primal Park':  { base: 140, variance: 50  },
};

function randInt(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }

function buildPreviewButtons() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('preview_pie_1d').setLabel('1d').setStyle(ButtonStyle.Secondary).setDisabled(true),
    new ButtonBuilder().setCustomId('preview_pie_7d').setLabel('7d').setStyle(ButtonStyle.Secondary).setDisabled(true),
    new ButtonBuilder().setCustomId('preview_pie_14d').setLabel('14d').setStyle(ButtonStyle.Primary).setDisabled(true),
    new ButtonBuilder().setCustomId('preview_pie_30d').setLabel('30d').setStyle(ButtonStyle.Secondary).setDisabled(true),
  );
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('testpiechart')
    .setDescription('Preview piechart with synthetic data — posts both distribution and win/loss modes')
    .addStringOption(opt =>
      opt.setName('server_type')
        .setDescription('Server type label (default: all)')
        .setRequired(false)
        .addChoices(
          { name: 'Regular', value: 'regular' },
          { name: 'Pro',     value: 'pro'     },
        )
    ),

  async execute(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const serverType  = interaction.options.getString('server_type');
    const serverLabel = serverType ? (serverType === 'pro' ? 'Pro' : 'Regular') : 'All Servers';
    const days        = 14;
    const files       = [];

    // ── Mode 1: distribution across all maps ─────────────────────────────
    const distSegments = ALL_MAPS.map(map => ({
      label: map,
      value: randInt(MAP_PROFILES[map].base - MAP_PROFILES[map].variance, MAP_PROFILES[map].base + MAP_PROFILES[map].variance),
      color: MAP_COLORS[map],
    })).sort((a, b) => b.value - a.value);
    const distTotal = distSegments.reduce((s, r) => s + r.value, 0);

    const distBuffer = await buildPieCard({
      title:       'Map Distribution',
      subtitle:    `Primal Pursuit · ${serverLabel} · Past ${days} Days  (test)`,
      stats: [
        { label: 'Total Rounds', value: distTotal.toLocaleString(), color: '#5865F2' },
        { label: 'Maps',         value: distSegments.length.toString(), color: '#57F287' },
      ],
      lookback:    `Past ${days} Days`,
      segments:    distSegments,
      centerLabel: `${distTotal.toLocaleString()}\nrounds`,
    });
    files.push(new AttachmentBuilder(distBuffer, { name: 'testpiechart-distribution.png' }));

    // ── Mode 2: win/loss for Jungle ───────────────────────────────────────
    const mapTotal     = randInt(80, 200);
    const dinoWins     = randInt(Math.floor(mapTotal * 0.3), Math.floor(mapTotal * 0.7));
    const survivorWins = mapTotal - dinoWins;

    const winlossBuffer = await buildPieCard({
      title:       'Jungle — Win Rate',
      subtitle:    `Primal Pursuit · ${serverLabel} · Past ${days} Days  (test)`,
      stats: [
        { label: 'Total Rounds', value: mapTotal.toLocaleString(),       color: '#5865F2' },
        { label: 'Dino Wins',    value: dinoWins.toLocaleString(),        color: '#ED4245' },
        { label: 'Surv. Wins',   value: survivorWins.toLocaleString(),    color: '#57F287' },
      ],
      lookback:    `Past ${days} Days`,
      segments: [
        { label: 'Dino Win',     value: dinoWins,     color: '#ED4245' },
        { label: 'Survivor Win', value: survivorWins,  color: '#57F287' },
      ],
      centerLabel: `${mapTotal.toLocaleString()}\nrounds`,
    });
    files.push(new AttachmentBuilder(winlossBuffer, { name: 'testpiechart-winloss.png' }));

    await interaction.channel.send({
      content: '*(test data)* `/testpiechart` — distribution (left) + win/loss (right)',
      files,
      components: [buildPreviewButtons()],
    }).catch(err => console.error('[testpiechart] send failed:', err.message));

    return interaction.editReply('Posted test pie charts above.');
  },
};