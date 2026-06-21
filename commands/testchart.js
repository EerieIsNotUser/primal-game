const { SlashCommandBuilder, AttachmentBuilder } = require('discord.js');
const { buildLineChartImage, buildDualAxisChartImage } = require('../modules/chart');

function generateSeries(days, base, amp, phase, noise) {
  const data = [];
  for (let i = 0; i < days; i++) {
    const x = (i / days) * Math.PI * 1.5;
    const val = base + amp * Math.sin(x + phase) + (Math.random() - 0.5) * noise;
    data.push(Math.max(0, Math.round(val)));
  }
  return data;
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
          { name: 'Overlay (multiple maps)', value: 'overlay' },
          { name: 'Dual-Axis (volume backdrop + line, matches /mapchart map:)', value: 'dual' },
          { name: 'All', value: 'all' },
        )),

  async execute(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const mode = interaction.options.getString('mode') || 'all';
    const days = 14;
    const labels = [];
    const now = new Date();
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(now - i * 24 * 60 * 60 * 1000);
      labels.push(`${d.getMonth() + 1}/${d.getDate()}`);
    }

    const files = [];

    if (mode === 'single' || mode === 'all') {
      const data = generateSeries(days, 45, 25, 0, 10);
      const buffer = await buildLineChartImage(labels, [{ label: 'Jungle', data }], 'Jungle — Rounds Played (Past 14 Days)');
      files.push(new AttachmentBuilder(buffer, { name: 'testchart-single.png' }));
    }

    if (mode === 'overlay' || mode === 'all') {
      const series = [
        { label: 'Jungle', data: generateSeries(days, 45, 25, 0, 10) },
        { label: 'Canyon', data: generateSeries(days, 30, 15, 1.2, 8) },
        { label: 'Cavern', data: generateSeries(days, 20, 10, 2.0, 6) },
        { label: 'Primal Park', data: generateSeries(days, 12, 8, 0.6, 5) },
      ];
      const buffer = await buildLineChartImage(labels, series, 'Map Popularity — Past 14 Days');
      files.push(new AttachmentBuilder(buffer, { name: 'testchart-overlay.png' }));
    }

    if (mode === 'dual' || mode === 'all') {
      const jungleData = generateSeries(days, 45, 25, 0, 10);
      const otherMapsData = [
        generateSeries(days, 30, 15, 1.2, 8),
        generateSeries(days, 20, 10, 2.0, 6),
        generateSeries(days, 12, 8, 0.6, 5),
      ];
      const totalPerDay = labels.map((_, i) =>
        jungleData[i] + otherMapsData.reduce((sum, series) => sum + series[i], 0)
      );
      const buffer = await buildDualAxisChartImage(
        labels, totalPerDay, 'Total Rounds Played (All Maps)',
        jungleData, 'Jungle Popularity',
        '#5865F2', 'Jungle — Map Popularity vs Total Rounds'
      );
      files.push(new AttachmentBuilder(buffer, { name: 'testchart-dual.png' }));
    }

    await interaction.channel.send({ content: '*(test data)*', files }).catch(err => {
      console.error('[testchart] send failed:', err.message);
    });

    return interaction.editReply('Posted test chart(s) above.');
  },
};