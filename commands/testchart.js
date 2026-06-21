const { SlashCommandBuilder, AttachmentBuilder } = require('discord.js');
const { buildLineChartImage, buildDualAxisChartImage } = require('../modules/chart');

const ALL_MAPS = ['Jungle', 'Canyon', 'Cavern', 'Primal Park'];

// Deterministic-ish flavor per map so different maps don't all look identical
const MAP_PROFILES = {
  'Jungle':      { base: 45, amp: 25, phase: 0,   noise: 10 },
  'Canyon':      { base: 30, amp: 15, phase: 1.2, noise: 8  },
  'Cavern':      { base: 20, amp: 10, phase: 2.0, noise: 6  },
  'Primal Park': { base: 12, amp: 8,  phase: 0.6, noise: 5  },
};

function generateSeries(days, { base, amp, phase, noise }) {
  const data = [];
  for (let i = 0; i < days; i++) {
    const x = (i / days) * Math.PI * 1.5;
    const val = base + amp * Math.sin(x + phase) + (Math.random() - 0.5) * noise;
    data.push(Math.max(0, Math.round(val)));
  }
  return data;
}

function resolveMapName(input) {
  if (!input) return null;
  const normalized = input.trim().toLowerCase();
  return ALL_MAPS.find(m => m.toLowerCase() === normalized) ?? null;
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('testchart')
    .setDescription('Post sample charts using generated test data')
    .addStringOption(opt =>
      opt.setName('mode')
        .setDescription('Which chart type(s) to preview')
        .addChoices(
          { name: 'Single Map', value: 'single' },
          { name: 'Overlay (pick 2-4 maps)', value: 'overlay' },
          { name: 'Dual-Axis (volume backdrop + line)', value: 'dual' },
          { name: 'All', value: 'all' },
        ))
    .addStringOption(opt =>
      opt.setName('map')
        .setDescription('Map for Single Map / Dual-Axis modes (default: Jungle)')
        .setRequired(false)
        .addChoices(...ALL_MAPS.map(m => ({ name: m, value: m })))
    )
    .addStringOption(opt =>
      opt.setName('map2')
        .setDescription('2nd map to include in Overlay mode')
        .setRequired(false)
        .addChoices(...ALL_MAPS.map(m => ({ name: m, value: m })))
    )
    .addStringOption(opt =>
      opt.setName('map3')
        .setDescription('3rd map to include in Overlay mode')
        .setRequired(false)
        .addChoices(...ALL_MAPS.map(m => ({ name: m, value: m })))
    )
    .addStringOption(opt =>
      opt.setName('map4')
        .setDescription('4th map to include in Overlay mode')
        .setRequired(false)
        .addChoices(...ALL_MAPS.map(m => ({ name: m, value: m })))
    ),

  async execute(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const mode = interaction.options.getString('mode') || 'all';
    const primaryMap = resolveMapName(interaction.options.getString('map')) || 'Jungle';

    // Build overlay map list: primary map + any of map2/3/4 that were picked,
    // deduplicated. If none of map2/3/4 given, overlay falls back to all 4.
    const extraMaps = [
      interaction.options.getString('map2'),
      interaction.options.getString('map3'),
      interaction.options.getString('map4'),
    ].map(resolveMapName).filter(Boolean);

    let overlayMaps;
    if (extraMaps.length > 0) {
      overlayMaps = [...new Set([primaryMap, ...extraMaps])];
    } else {
      overlayMaps = ALL_MAPS;
    }

    const days = 14;
    const labels = [];
    const now = new Date();
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(now - i * 24 * 60 * 60 * 1000);
      labels.push(`${d.getMonth() + 1}/${d.getDate()}`);
    }

    const files = [];

    if (mode === 'single' || mode === 'all') {
      const data = generateSeries(days, MAP_PROFILES[primaryMap]);
      const buffer = await buildLineChartImage(labels, [{ label: primaryMap, data }], `${primaryMap} — Rounds Played (Past 14 Days)`);
      files.push(new AttachmentBuilder(buffer, { name: 'testchart-single.png' }));
    }

    if (mode === 'overlay' || mode === 'all') {
      const series = overlayMaps.map(map => ({
        label: map,
        data: generateSeries(days, MAP_PROFILES[map]),
      }));
      const buffer = await buildLineChartImage(labels, series, 'Map Popularity — Past 14 Days');
      files.push(new AttachmentBuilder(buffer, { name: 'testchart-overlay.png' }));
    }

    if (mode === 'dual' || mode === 'all') {
      // Dual mode uses the SAME map selection as overlay mode (primary +
      // map2/3/4, or all 4 if none specified) — every selected map gets
      // its own line on the right axis, bars show the combined total.
      const dualMapsData = {};
      overlayMaps.forEach(map => {
        dualMapsData[map] = generateSeries(days, MAP_PROFILES[map]);
      });

      const totalPerDay = labels.map((_, i) =>
        overlayMaps.reduce((sum, map) => sum + dualMapsData[map][i], 0)
      );

      const lineSeries = overlayMaps.map(map => ({ label: map, data: dualMapsData[map] }));

      const dualTitle = overlayMaps.length === 1
        ? `${overlayMaps[0]} — Map Popularity vs Total Rounds`
        : `Map Popularity vs Total Rounds (${overlayMaps.length} maps)`;

      const buffer = await buildDualAxisChartImage(
        labels, totalPerDay, 'Total Rounds Played (All Maps)',
        lineSeries, dualTitle
      );
      files.push(new AttachmentBuilder(buffer, { name: 'testchart-dual.png' }));
    }

    const overlayNote = (mode === 'overlay' || mode === 'dual' || mode === 'all')
      ? `\n*Maps: ${overlayMaps.join(', ')}*`
      : '';

    await interaction.channel.send({ content: `*(test data)*${overlayNote}`, files }).catch(err => {
      console.error('[testchart] send failed:', err.message);
    });

    return interaction.editReply('Posted test chart(s) above.');
  },
};