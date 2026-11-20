'use strict';
const { SlashCommandBuilder, AttachmentBuilder } = require('discord.js');
const { fetchImage, SiteImageError } = require('../modules/siteImage');

// ─── /tierlist ────────────────────────────────────────────────────────────────
// Most used MVP weapons and vehicles, and how many players carried each pickup. One picture, drawn by the website from the
// shared stats function (see /gamestats). The old version read raw rounds through a 1,000 row cap, so its counts were
// wrong for any busy period; this one counts every round.
//
// Free-form dates ("January 15th through May 30th") are gone: the website only keeps full-day totals for long periods, so
// the choices below are the periods that can be answered exactly.

const LOBBIES = [
  { name: 'Main Game',         value: 'main'     },
  { name: 'Pro Lobbies',       value: 'pro'      },
  { name: 'Training Lobbies',  value: 'training' },
  { name: 'All (no Training)', value: 'all'      },
];
const RANGES = [
  { name: 'Past 24 hours', value: '24h'  },
  { name: 'Past week',     value: '7d'   },
  { name: 'Past month',    value: '30d'  },
  { name: 'Past 90 days',  value: '90d'  },
  { name: 'Past year',     value: '365d' },
  { name: 'All time',      value: 'all'  },
];

module.exports = {
  data: new SlashCommandBuilder()
    .setName('tierlist')
    .setDescription('Most used MVP weapons and vehicles, and pickup adoption')
    .addStringOption(opt => opt.setName('lobby').setDescription('Lobby type (default: Main Game)').addChoices(...LOBBIES))
    .addStringOption(opt => opt.setName('time_range').setDescription('Time period (default: past week)').addChoices(...RANGES)),

  async execute(interaction, deps = {}) {
    const get = deps.fetchImage ?? fetchImage;
    await interaction.deferReply();
    const p = {
      kind: 'popular',
      lobby: interaction.options.getString('lobby') ?? 'main',
      range: interaction.options.getString('time_range') ?? '7d',
    };
    try {
      const png = await get(p);
      return await interaction.editReply({ files: [new AttachmentBuilder(png, { name: 'tierlist.png' })] });
    } catch (err) {
      if (!(err instanceof SiteImageError) || err.status >= 500 || err.status === 0 || err.status === 401) console.error('[tierlist]', err.message);
      return interaction.editReply(err instanceof SiteImageError ? err.userMessage : 'Something went wrong drawing the tier list.');
    }
  },
};
