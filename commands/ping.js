'use strict';
const { SlashCommandBuilder } = require('discord.js');
const siteImage = require('../modules/siteImage');

// ─── /status ──────────────────────────────────────────────────────────────────
// Is the bot up, how fast do the database and the picture service answer, and how fresh are the daily totals the pictures use.
// (The old version counted rows in race_stats, a table nothing uses any more.)

const timed = async fn => { const t = Date.now(); try { return { ms: Date.now() - t, ...(await fn()) }; } catch (err) { return { ms: Date.now() - t, error: err.message }; } };

module.exports = {
  data: new SlashCommandBuilder()
    .setName('status')
    .setDescription('Check that PrimalGame, its database and the picture service are up'),

  async execute(interaction, { supabase } = {}, deps = {}) {
    if (interaction.replied || interaction.deferred) return;
    await interaction.deferReply();
    const f = deps.fetchImpl ?? fetch;
    const [db, site] = await Promise.all([
      timed(async () => {
        if (!supabase) throw new Error('not connected');
        const { data, error } = await supabase.from('bot_stats_daily').select('day').order('day', { ascending: false }).limit(1);
        if (error) throw new Error(error.message);
        return { day: data?.[0]?.day ?? null };
      }),
      timed(async () => {
        const secret = await (deps.getSecret ?? siteImage.getSecret)();
        const r = await f(siteImage.buildUrl({ kind: 'ping' }, { secret }), { signal: AbortSignal.timeout(8000) });
        if (!r.ok) throw new Error(`answered ${r.status}`);
        return {};
      }),
    ]);
    const lines = [
      `PrimalGame is online (bot ping ${Math.round(interaction.client?.ws?.ping ?? 0)} ms).`,
      db.error ? `Database: ${db.error}.` : `Database: ok, ${db.ms} ms. Latest day in the daily totals: ${db.day ?? 'none yet'}.`,
      site.error ? `Picture service: ${site.error}.` : `Picture service: ok, ${site.ms} ms.`,
    ];
    return interaction.editReply(lines.join('\n'));
  },
};
