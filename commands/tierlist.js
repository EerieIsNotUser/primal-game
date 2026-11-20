'use strict';
const { SlashCommandBuilder, AttachmentBuilder } = require('discord.js');
const { fetchImage, SiteImageError } = require('../modules/siteImage');

// ─── /tierlist ────────────────────────────────────────────────────────────────
// Tier lists for dinosaurs, weapons and vehicles, drawn by the website with the same rules as its Tier list page: tiers come from win
// rate only (adjusted for small samples, 20 rounds to appear), so an item does not rank high just because it is used a lot.
// Dinos count dino-side wins; weapons and vehicles count survivor-side wins in rounds where that item's holder was MVP.
// One picture per category, all three in a single message by default.
//
// Free-form dates are gone: the website only keeps full-day totals for long periods, so the choices below are the periods that
// can be answered exactly.

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

const CATEGORIES = [
  { name: 'Dinosaurs',          value: 'dino'    },
  { name: 'Weapons',            value: 'weapon'  },
  { name: 'Vehicles',           value: 'vehicle' },
  { name: 'All three (default)', value: 'all'    },
];
const SIZES = [
  { name: 'Beginner lobbies (level 1–40)',   value: 'beginner' },
  { name: 'Standard lobbies (level 41–250)', value: 'standard' },
  { name: 'Pro-level lobbies (level 251+)',  value: 'pro'      },
];

module.exports = {
  data: new SlashCommandBuilder()
    .setName('tierlist')
    .setDescription('Dinosaur, weapon and vehicle tier lists by win rate')
    .addStringOption(opt => opt.setName('lobby').setDescription('Lobby type (default: Main Game)').addChoices(...LOBBIES))
    .addStringOption(opt => opt.setName('time_range').setDescription('Time period (default: past week)').addChoices(...RANGES))
    .addStringOption(opt => opt.setName('category').setDescription('Which tier list (default: all three)').addChoices(...CATEGORIES))
    .addStringOption(opt => opt.setName('lobby_size').setDescription('Only rounds from lobbies of this average level').addChoices(...SIZES)),

  async execute(interaction, deps = {}) {
    const get = deps.fetchImage ?? fetchImage;
    await interaction.deferReply();
    const base = {
      lobby: interaction.options.getString('lobby') ?? 'main',
      range: interaction.options.getString('time_range') ?? '7d',
      size:  interaction.options.getString('lobby_size') ?? 'all',
    };
    const cat = interaction.options.getString('category') ?? 'all';
    const cats = cat === 'all' ? ['dino', 'weapon', 'vehicle'] : [cat];
    try {
      const pngs = await Promise.all(cats.map(c => get({ kind: `tiers_${c}`, ...base })));
      return await interaction.editReply({ files: pngs.map((png, i) => new AttachmentBuilder(png, { name: `tierlist-${cats[i]}.png` })) });
    } catch (err) {
      if (!(err instanceof SiteImageError) || err.status >= 500 || err.status === 0 || err.status === 401) console.error('[tierlist]', err.message);
      return interaction.editReply(err instanceof SiteImageError ? err.userMessage : 'Something went wrong drawing the tier list.');
    }
  },
};
