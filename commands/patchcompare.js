'use strict';
const { SlashCommandBuilder } = require('discord.js');
const { LOBBIES, reply } = require('../modules/imageCommand');

// ─── /patchcompare ────────────────────────────────────────────────────────────
// Before and after a balance patch, from the patch log on the website (Staff can add one there). The picture is drawn by the website
// (/api/bot/image, kind "patchcompare"): dino win rate and MVP damage, and the weapons and dinosaurs that moved most, split at the exact
// moment the patch went live. Every weapon in the round counts, not only the MVP's, and each change is measured against the move in all rounds.

const BEFORE = [
  { name: '7 days before', value: 7 },
  { name: '14 days before (default)', value: 14 },
  { name: '30 days before', value: 30 },
];

const label = r => `${r.title} (${new Date(`${r.changed_on}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })})`.slice(0, 100);

module.exports = {
  data: new SlashCommandBuilder()
    .setName('patchcompare')
    .setDescription('How the game changed before and after a balance patch')
    .addStringOption(o => o.setName('patch').setDescription('Which patch (default: the latest)').setAutocomplete(true))
    .addIntegerOption(o => o.setName('before').setDescription('How much of the time before the patch to compare against').addChoices(...BEFORE))
    .addStringOption(o => o.setName('lobby').setDescription('Lobby type (default: Main Game)').addChoices(...LOBBIES.filter(l => l.value !== 'training'))),

  async autocomplete(interaction, { supabase } = {}) {
    const focused = interaction.options.getFocused().toLowerCase();
    let choices = [];
    try {
      const { data, error } = await supabase.from('balance_changes').select('id, title, changed_on').order('changed_on', { ascending: false }).order('created_at', { ascending: false }).limit(50);
      if (error) throw new Error(error.message);
      choices = (data ?? []).filter(r => r.title.toLowerCase().includes(focused)).slice(0, 25).map(r => ({ name: label(r), value: String(r.id) }));
    } catch (err) {
      console.error('[patchcompare] autocomplete:', err.message);
    }
    await interaction.respond(choices).catch(() => {});
  },

  async execute(interaction, deps = {}) {
    await interaction.deferReply();
    const o = interaction.options;
    const picked = (o.getString('patch') ?? '').trim();
    if (picked && !/^\d+$/.test(picked)) return interaction.editReply('Pick a patch from the list. It only knows patches that are in the patch log on the website.');
    const params = { kind: 'patchcompare', lobby: o.getString('lobby') ?? 'main', range: '30d', size: 'all', before: o.getInteger('before') ?? 14, patch: picked || null };
    return reply(interaction, deps, {
      params, file: 'patch-compare.png', label: 'Open patch log', path: '/dashboard/patch-log', tag: 'patchcompare',
      notFound: 'Nothing to compare yet. Either that patch is not in the patch log, or no rounds have been played since it went live.',
    });
  },
};
