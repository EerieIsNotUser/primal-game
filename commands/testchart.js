const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { buildLineChartUrl } = require('../modules/chart');

const MAPS = ['Jungle', 'Canyon', 'Cavern', 'Primal Park'];

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
    .setDescription('Post sample map popularity charts using generated test data')
    .addStringOption(opt =>
      opt.setName('mode')
        .setDescription('Single map or overlaid comparison')
        .addChoices(
          { name: 'Single Map', value: 'single' },
          { name: 'Overlay (multiple maps)', value: 'overlay' },
          { name: 'Both', value: 'both' },
        )),

  async execute(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const mode = interaction.options.getString('mode') || 'both';
    console.log('[testchart] mode:', mode);
    const days = 14;
    const labels = [];
    const now = new Date();
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(now - i * 24 * 60 * 60 * 1000);
      labels.push(`${d.getMonth() + 1}/${d.getDate()}`);
    }

    const embeds = [];
    console.log('[testchart] mode:', mode);

    if (mode === 'single' || mode === 'both') {
      const data = generateSeries(days, 45, 25, 0, 10);
      const url = buildLineChartUrl(labels, [{ label: 'Jungle', data }], 'Jungle — Rounds Played (Past 14 Days)');
      console.log('[testchart] single URL:', url);
      embeds.push(new EmbedBuilder().setColor(0x5865F2).setImage(url));
    }

    if (mode === 'overlay' || mode === 'both') {
      const series = [
        { label: 'Jungle', data: generateSeries(days, 45, 25, 0, 10) },
        { label: 'Canyon', data: generateSeries(days, 30, 15, 1.2, 8) },
        { label: 'Cavern', data: generateSeries(days, 20, 10, 2.0, 6) },
        { label: 'Primal Park', data: generateSeries(days, 12, 8, 0.6, 5) },
      ];
      const url = buildLineChartUrl(labels, series, 'Map Popularity — Past 14 Days');
      embeds.push(new EmbedBuilder().setColor(0x5865F2).setImage(url));
    }

    await interaction.channel.send({ content: '*(test data)*', embeds }).catch(err => {
      console.error('[testchart] send failed:', err.message);
    });

    return interaction.editReply('Posted test chart(s) above.');
  },
};