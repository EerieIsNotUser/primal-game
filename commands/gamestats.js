'use strict';
const { SlashCommandBuilder, AttachmentBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { fetchImage, SiteImageError } = require('../modules/siteImage');

// ─── /gamestats ───────────────────────────────────────────────────────────────
// Win rates by map, mode and level, and the dinos, weapons and vehicles that win. The pictures are drawn by the website
// (/api/bot/image) from the same database function the other stat commands use, so this command is one download, not a pile
// of queries. Two pictures go out in a single message: the overview and the leaders.
//
// Win % methodology (unchanged):
//   Dinos    — dino-side win % in rounds where that dino was present
//   Vehicles — survivor-side win % in rounds where that vehicle's driver was the MVP
//   Weapons  — survivor-side win % in rounds where that weapon's holder was the MVP
//
// Note: the website's balance pages have no 24 hour view; this command adds one.

const LOBBIES = [
  { name: 'Main Game',        value: 'main'     },
  { name: 'Pro Lobbies',      value: 'pro'      },
  { name: 'Training Lobbies', value: 'training' },
  { name: 'All (no Training)', value: 'all'     },
];
const RANGES = [
  { name: 'Past 24 hours',   value: '24h'  },
  { name: 'Past week',       value: '7d'   },
  { name: 'Past month',      value: '30d'  },
  { name: 'Past 90 days',    value: '90d'  },
  { name: 'Past year',       value: '365d' },
  { name: 'All time',        value: 'all'  },
];
const SIZES = [
  { name: 'Beginner lobbies (level 1–40)',  value: 'beginner' },
  { name: 'Standard lobbies (level 41–250)', value: 'standard' },
  { name: 'Pro-level lobbies (level 251+)',  value: 'pro'      },
];

const ANALYTICS_URL = `${(process.env.WEBSITE_URL || 'https://www.primalpursuitrblx.com').replace(/\/+$/, '')}/dashboard/gamestats`;
const analyticsRow = () => new ActionRowBuilder().addComponents(
  new ButtonBuilder().setLabel('Open analytics').setStyle(ButtonStyle.Link).setURL(ANALYTICS_URL),
);

// Exposed for tests.
function paramsFrom(interaction) {
  const o = interaction.options;
  return {
    lobby: o.getString('lobby') ?? 'main',
    range: o.getString('time_range') ?? '7d',
    size:  o.getString('lobby_size') ?? 'all',
    min:   o.getInteger('min_level') ?? null,
    max:   o.getInteger('max_level') ?? null,
  };
}

module.exports = {
  paramsFrom,
  data: new SlashCommandBuilder()
    .setName('gamestats')
    .setDescription('Win rate by map, mode and level, plus the dinos, weapons and vehicles that win')
    .addStringOption(opt => opt.setName('lobby').setDescription('Lobby type (default: Main Game)')
      .addChoices(...LOBBIES))
    .addStringOption(opt => opt.setName('time_range').setDescription('Time period (default: past week)')
      .addChoices(...RANGES))
    .addStringOption(opt => opt.setName('lobby_size').setDescription('Only rounds from lobbies of this average level (works for every time period)')
      .addChoices(...SIZES))
    .addIntegerOption(opt => opt.setName('min_level').setDescription('Minimum average level (past 24 hours or past week only)')
      .setMinValue(1).setMaxValue(1000))
    .addIntegerOption(opt => opt.setName('max_level').setDescription('Maximum average level (past 24 hours or past week only)')
      .setMinValue(1).setMaxValue(1000)),

  async execute(interaction, deps = {}) {
    const get = deps.fetchImage ?? fetchImage;
    await interaction.deferReply();
    const p = paramsFrom(interaction);

    if ((p.min != null || p.max != null) && !(p.range === '24h' || p.range === '7d')) {
      return interaction.editReply('Level limits only work for the past 24 hours or past week. For longer periods use **lobby_size**.');
    }

    try {
      const [overview, leaders] = await Promise.all([
        get({ kind: 'overview', ...p }),
        get({ kind: 'leaders', ...p }),
      ]);
      return await interaction.editReply({
        files: [
          new AttachmentBuilder(overview, { name: 'gamestats-overview.png' }),
          new AttachmentBuilder(leaders,  { name: 'gamestats-leaders.png' }),
        ],
        components: [analyticsRow()],
      });
    } catch (err) {
      if (!(err instanceof SiteImageError) || err.status >= 500 || err.status === 0 || err.status === 401) {
        console.error('[gamestats]', err.message);
      }
      return interaction.editReply(err instanceof SiteImageError ? err.userMessage : 'Something went wrong drawing those stats.');
    }
  },
};
