// ─── Bot Status ───────────────────────────────────────────────────────────────
// Maintains a single persistent embed in #bot-status that updates every 10
// minutes with ping, rounds tracked, recent error counts, and overall status.
//
// Status levels:
//   Online   — no errors in the last interval
//   Unstable — some errors but also some successes (partial degradation)
//   Offline  — 3+ consecutive failures with no successful inserts (collection stopped)

const { EmbedBuilder } = require('discord.js');

const STATUS_CHANNEL_ID  = '1515750726264029294';
const UPDATE_INTERVAL_MS = 10 * 60 * 1000;

// Shared state — mutated by recordSuccess/recordError calls from bot.js
const state = {
  recentErrors:      0,
  recentSuccesses:   0,
  consecutiveErrors: 0,
  lastSuccessAt:     null,
  lastErrorMsg:      null,
};

function getStatus() {
  if (state.consecutiveErrors >= 3) return 'Offline';
  if (state.recentErrors > 0)       return 'Unstable';
  return 'Online';
}

async function updateStatusMessage(client, supabase) {
  try {
    const ping   = client.ws.ping;
    const status = getStatus();
    const color  = status === 'Online' ? 0x57F287 : status === 'Unstable' ? 0xFEE75C : 0xED4245;
    const icon   = status === 'Online' ? '🟢'     : status === 'Unstable' ? '🟡'     : '🔴';

    const { count: totalRounds } = await supabase
      .from('round_logs')
      .select('*', { count: 'exact', head: true });

    const lastSuccessStr = state.lastSuccessAt
      ? `<t:${Math.floor(state.lastSuccessAt.getTime() / 1000)}:R>`
      : '—';

    const embed = new EmbedBuilder()
      .setColor(color)
      .setTitle('PrimalGame — Bot Status')
      .addFields(
        { name: 'Status',         value: `${icon} **${status}**`,              inline: true },
        { name: 'Ping',           value: `${ping}ms`,                           inline: true },
        { name: 'Rounds Tracked', value: (totalRounds ?? 0).toLocaleString(),   inline: true },
        { name: 'Ingestion Errors (interval)', value: state.recentErrors.toString(),   inline: true },
        { name: 'Successful Inserts (interval)', value: state.recentSuccesses.toString(), inline: true },
        { name: 'Last Successful Insert', value: lastSuccessStr, inline: true },
      )
      .setFooter({ text: 'Updates every 10 minutes · PrimalGame' })
      .setTimestamp();

    // Reset interval counters after building the embed
    state.recentErrors    = 0;
    state.recentSuccesses = 0;

    // Fetch channel
    const ch = client.channels.cache.get(STATUS_CHANNEL_ID)
      ?? await client.channels.fetch(STATUS_CHANNEL_ID).catch(() => null);
    if (!ch) { console.error('[bot-status] Could not find status channel'); return; }

    // Try to edit existing pinned message
    const { data: stateRow } = await supabase
      .from('primalgame_state')
      .select('value')
      .eq('key', 'status_message_id')
      .single();

    if (stateRow?.value) {
      const existing = await ch.messages.fetch(stateRow.value).catch(() => null);
      if (existing) {
        await existing.edit({ embeds: [embed] });
        return;
      }
    }

    // Post new message + store ID
    const newMsg = await ch.send({ embeds: [embed] });
    await supabase
      .from('primalgame_state')
      .upsert({ key: 'status_message_id', value: newMsg.id });

  } catch (err) {
    console.error('[bot-status] Update failed:', err.message);
  }
}

function setupBotStatus(client, { supabase }) {
  setTimeout(() => {
    updateStatusMessage(client, supabase);
    setInterval(() => updateStatusMessage(client, supabase), UPDATE_INTERVAL_MS);
  }, 5000);
  console.log('[bot-status] Started. First update in 5s, then every 10 minutes.');
}

setupBotStatus.recordSuccess = function () {
  state.recentSuccesses++;
  state.consecutiveErrors = 0;
  state.lastSuccessAt     = new Date();
};

setupBotStatus.recordError = function (msg) {
  state.recentErrors++;
  state.consecutiveErrors++;
  state.lastErrorMsg = msg;
};

setupBotStatus.getStatus = getStatus;

module.exports = setupBotStatus;