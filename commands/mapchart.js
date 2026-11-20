'use strict';
const { SlashCommandBuilder, AttachmentBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { fetchImage, SiteImageError } = require('../modules/siteImage');

// ─── /mapchart ────────────────────────────────────────────────────────────────
// Every map: how many rounds it gets, the dino win rate on it with a 95% range, and each map's dino win rate day by day.
// The picture is drawn by the website (/api/bot/image, kind "maps") from the same daily totals as its Maps page.
// An item's win rate over time is now /winrate.

const LOBBIES = [
  { name: 'Main Game',         value: 'main'     },
  { name: 'Pro Lobbies',       value: 'pro'      },
  { name: 'Training Lobbies',  value: 'training' },
  { name: 'All (no Training)', value: 'all'      },
];
// Daily totals, so the shortest period is a week.
const RANGES = [
  { name: 'Past week',    value: '7d'   },
  { name: 'Past month',   value: '30d'  },
  { name: 'Past 90 days', value: '90d'  },
  { name: 'Past year',    value: '365d' },
  { name: 'All time',     value: 'all'  },
];
const SIZES = [
  { name: 'Beginner lobbies (level 1–40)',   value: 'beginner' },
  { name: 'Standard lobbies (level 41–250)', value: 'standard' },
  { name: 'Pro-level lobbies (level 251+)',  value: 'pro'      },
];

const ANALYTICS_URL = `${(process.env.WEBSITE_URL || 'https://www.primalpursuitrblx.com').replace(/\/+$/, '')}/dashboard/maps`;
const linkRow = () => new ActionRowBuilder().addComponents(new ButtonBuilder().setLabel('Open maps page').setStyle(ButtonStyle.Link).setURL(ANALYTICS_URL));

module.exports = {
  data: new SlashCommandBuilder()
    .setName('mapchart')
    .setDescription('How often each map is played and who wins on it')
    .addStringOption(opt => opt.setName('lobby').setDescription('Lobby type (default: Main Game)').addChoices(...LOBBIES))
    .addStringOption(opt => opt.setName('time_range').setDescription('Time period (default: past month)').addChoices(...RANGES))
    .addStringOption(opt => opt.setName('lobby_size').setDescription('Only rounds from lobbies of this average level').addChoices(...SIZES)),

  async execute(interaction, deps = {}) {
    const get = deps.fetchImage ?? fetchImage;
    await interaction.deferReply();
    const o = interaction.options;
    const p = {
      kind: 'maps',
      lobby: o.getString('lobby') ?? 'main',
      range: o.getString('time_range') ?? '30d',
      size: o.getString('lobby_size') ?? 'all',
    };
    try {
      const png = await get(p);
      return await interaction.editReply({ files: [new AttachmentBuilder(png, { name: 'mapchart.png' })], components: [linkRow()] });
    } catch (err) {
      if (!(err instanceof SiteImageError) || err.status >= 500 || err.status === 0 || err.status === 401) console.error('[mapchart]', err.message);
      return interaction.editReply(err instanceof SiteImageError ? err.userMessage : 'Something went wrong drawing that.');
    }
  },
};
