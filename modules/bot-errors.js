// ─── Bot Error Monitor ────────────────────────────────────────────────────────
// Three layers of protection:
//   1. uncaughtException / unhandledRejection — catches crashes before exit,
//      attempts a Discord post, stores crash info in primalgame_state
//   2. On startup — detects a previous crash record and posts "back online"
//   3. shardDisconnect — posts while client is still alive if WS drops

const { EmbedBuilder } = require('discord.js');

const BOT_ERROR_CHANNEL_ID = '1515751644430733382';
const OWNER_ID             = '1289766186170581120';

async function postBotError(client, title, description) {
  try {
    const ch = client.channels.cache.get(BOT_ERROR_CHANNEL_ID)
      ?? await client.channels.fetch(BOT_ERROR_CHANNEL_ID).catch(() => null);
    if (!ch) return;

    const embed = new EmbedBuilder()
      .setColor(0xED4245)
      .setTitle(`🔴 ${title}`)
      .setDescription(description)
      .setFooter({ text: 'PrimalGame · Bot Error Monitor' })
      .setTimestamp();

    await ch.send({ content: `<@${OWNER_ID}>`, embeds: [embed] });
  } catch (err) {
    console.error('[bot-errors] Failed to post error:', err.message);
  }
}

async function checkPreviousCrash(client, supabase) {
  try {
    const { data } = await supabase
      .from('primalgame_state')
      .select('value')
      .eq('key', 'last_crash')
      .single();

    if (!data?.value) return;

    // There was a crash — post recovery message and clear the record
    await postBotError(
      client,
      'Bot Recovered',
      `PrimalGame is back online after an unexpected crash.\n\n**Crash details:**\n\`\`\`${data.value}\`\`\``
    );

    await supabase
      .from('primalgame_state')
      .update({ value: '' })
      .eq('key', 'last_crash');

    console.log('[bot-errors] Previous crash detected and reported.');
  } catch (err) {
    console.error('[bot-errors] Crash check failed:', err.message);
  }
}

function setupBotErrors(client, { supabase }) {
  // Check for previous crash on startup
  checkPreviousCrash(client, supabase);

  // WebSocket disconnect
  client.on('shardDisconnect', (event, shardId) => {
    postBotError(
      client,
      'WebSocket Disconnected',
      `Shard ${shardId} disconnected.\n**Code:** ${event.code}\n**Reason:** ${event.reason || 'No reason provided'}`
    );
  });

  // Uncaught exceptions — attempt Discord post, store crash, then exit
  process.on('uncaughtException', async (err) => {
    console.error('[bot-errors] Uncaught exception:', err);

    const crashInfo = `${err.name}: ${err.message}\n${err.stack?.slice(0, 500) ?? ''}`;

    // Store crash info for recovery message on next boot
    await supabase
      .from('primalgame_state')
      .update({ value: crashInfo })
      .eq('key', 'last_crash')
      .catch(() => {});

    await postBotError(client, 'Uncaught Exception', `\`\`\`${crashInfo}\`\`\``).catch(() => {});

    process.exit(1);
  });

  // Unhandled promise rejections
  process.on('unhandledRejection', async (reason) => {
    const msg = reason instanceof Error
      ? `${reason.name}: ${reason.message}\n${reason.stack?.slice(0, 500) ?? ''}`
      : String(reason);

    console.error('[bot-errors] Unhandled rejection:', msg);

    await supabase
      .from('primalgame_state')
      .update({ value: msg })
      .eq('key', 'last_crash')
      .catch(() => {});

    await postBotError(client, 'Unhandled Promise Rejection', `\`\`\`${msg}\`\`\``).catch(() => {});
  });

  console.log('[bot-errors] Bot error monitor active.');
}

module.exports = setupBotErrors;