'use strict';
const { SlashCommandBuilder, AttachmentBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { fetchImage, SiteImageError } = require('../modules/siteImage');

// ─── /winrate ─────────────────────────────────────────────────────────────────
// One dinosaur, weapon or vehicle: its win rate with a 95% range, tier, rank, and how it moved day by day. The picture is drawn by
// the website (/api/bot/image, kind "item") from the same daily totals and tier rules as its Win rate and Tier list pages.
//
// The old version read raw rounds through a 1,000 row cap, kept a hard-coded item list that was missing newer items, and compared a
// dino's win rate with a survivor baseline. This one counts every round, and the item list comes from the data.
//
// Win % methodology:
//   Dinos    — dino-side win % in rounds where that dino (or one of its skins) was present
//   Vehicles — survivor-side win % in rounds where that vehicle's driver was the MVP
//   Weapons  — survivor-side win % in rounds where that weapon's holder was the MVP

const CATEGORIES = [
  { name: 'Dinosaur', value: 'dino'    },
  { name: 'Weapon',   value: 'weapon'  },
  { name: 'Vehicle',  value: 'vehicle' },
];
const LOBBIES = [
  { name: 'Main Game',         value: 'main'     },
  { name: 'Pro Lobbies',       value: 'pro'      },
  { name: 'Training Lobbies',  value: 'training' },
  { name: 'All (no Training)', value: 'all'      },
];
// The item view reads daily totals, so the shortest period is a week.
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
const DB_KEY = { dino: 'dino', weapon: 'weapon_mvp', vehicle: 'vehicle_mvp' };

const ANALYTICS_URL = `${(process.env.WEBSITE_URL || 'https://www.primalpursuitrblx.com').replace(/\/+$/, '')}/dashboard/winrate`;
const linkRow = () => new ActionRowBuilder().addComponents(new ButtonBuilder().setLabel('Open win rate page').setStyle(ButtonStyle.Link).setURL(ANALYTICS_URL));

// Names for autocomplete, from the data (last 90 days, at least 50 rounds), kept for ten minutes.
let namesCache = { at: 0, value: null, loading: null };
async function itemNames(supabase) {
  if (namesCache.value && Date.now() - namesCache.at < 10 * 60_000) return namesCache.value;
  namesCache.loading ??= Promise.resolve(supabase.rpc('bot_item_names')).then(({ data, error }) => {
    if (error) throw new Error(error.message);
    namesCache = { at: Date.now(), value: data ?? {}, loading: null };
    return namesCache.value;
  }).finally(() => { namesCache.loading = null; });
  return namesCache.loading;
}

module.exports = {
  _resetNames() { namesCache = { at: 0, value: null, loading: null }; },
  data: new SlashCommandBuilder()
    .setName('winrate')
    .setDescription('Win rate, tier and trend for one dinosaur, weapon or vehicle')
    .addStringOption(opt => opt.setName('category').setDescription('What kind of item').setRequired(true).addChoices(...CATEGORIES))
    .addStringOption(opt => opt.setName('item').setDescription('Which one (start typing to search)').setRequired(true).setAutocomplete(true))
    .addStringOption(opt => opt.setName('lobby').setDescription('Lobby type (default: Main Game)').addChoices(...LOBBIES))
    .addStringOption(opt => opt.setName('time_range').setDescription('Time period (default: past month)').addChoices(...RANGES))
    .addStringOption(opt => opt.setName('lobby_size').setDescription('Only rounds from lobbies of this average level').addChoices(...SIZES)),

  async autocomplete(interaction, { supabase } = {}) {
    const focused = interaction.options.getFocused().toLowerCase();
    const cat = interaction.options.getString('category');
    let choices = [];
    try {
      const all = await itemNames(supabase);
      const keys = cat ? [DB_KEY[cat]] : Object.values(DB_KEY);
      const seen = new Set();
      for (const k of keys) for (const n of all[k] ?? []) if (!seen.has(n) && n.toLowerCase().includes(focused)) { seen.add(n); choices.push(n); }
      choices = choices.slice(0, 25);
    } catch (err) {
      console.error('[winrate] autocomplete:', err.message);
    }
    await interaction.respond(choices.map(n => ({ name: n, value: n }))).catch(() => {});
  },

  async execute(interaction, deps = {}) {
    const get = deps.fetchImage ?? fetchImage;
    await interaction.deferReply();
    const o = interaction.options;
    const item = (o.getString('item') ?? '').trim();
    if (!item) return interaction.editReply('Pick an item to look up.');
    const p = {
      kind: 'item',
      cat: o.getString('category'),
      item,
      lobby: o.getString('lobby') ?? 'main',
      range: o.getString('time_range') ?? '30d',
      size: o.getString('lobby_size') ?? 'all',
    };
    try {
      const png = await get(p);
      return await interaction.editReply({ files: [new AttachmentBuilder(png, { name: `winrate-${item.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.png` })], components: [linkRow()] });
    } catch (err) {
      if (err instanceof SiteImageError && err.status === 404) return interaction.editReply(`No rounds found for **${item}** in that selection. Pick a name from the list, or try a longer period.`);
      if (!(err instanceof SiteImageError) || err.status >= 500 || err.status === 0 || err.status === 401) console.error('[winrate]', err.message);
      return interaction.editReply(err instanceof SiteImageError ? err.userMessage : 'Something went wrong drawing that.');
    }
  },
};
