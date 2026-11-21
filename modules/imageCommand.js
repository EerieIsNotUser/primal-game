'use strict';
const { AttachmentBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { fetchImage, SiteImageError } = require('./siteImage');

// Shared pieces for the commands that post one picture drawn by the website (/api/bot/image).
const LOBBIES = [
  { name: 'Main Game',         value: 'main'     },
  { name: 'Pro Lobbies',       value: 'pro'      },
  { name: 'Training Lobbies',  value: 'training' },
  { name: 'All (no Training)', value: 'all'      },
];
// These views read the daily totals, so the shortest period is a week.
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

const siteUrl = path => `${(process.env.WEBSITE_URL || 'https://www.primalpursuitrblx.com').replace(/\/+$/, '')}${path}`;
const linkRow = (label, path) => new ActionRowBuilder().addComponents(new ButtonBuilder().setLabel(label).setStyle(ButtonStyle.Link).setURL(siteUrl(path)));

// Defers, downloads the picture and replies once. `params` is what the site is asked for.
async function reply(interaction, deps, { params, file, label, path, tag, notFound }) {
  const get = deps.fetchImage ?? fetchImage;
  try {
    const png = await get(params);
    return await interaction.editReply({ files: [new AttachmentBuilder(png, { name: file })], components: [linkRow(label, path)] });
  } catch (err) {
    if (!(err instanceof SiteImageError) || err.status >= 500 || err.status === 0 || err.status === 401) console.error(`[${tag}]`, err.message);
    if (notFound && err instanceof SiteImageError && err.status === 404) return interaction.editReply(notFound);
    return interaction.editReply(err instanceof SiteImageError ? err.userMessage : 'Something went wrong drawing that.');
  }
}

module.exports = { LOBBIES, RANGES, SIZES, reply, linkRow, siteUrl };
