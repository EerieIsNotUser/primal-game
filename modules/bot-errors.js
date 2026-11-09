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

// Cleanup on a fatal error is bounded: a hung Discord or Supabase call must
// never keep a crashed process alive.
const CLEANUP_TIMEOUT_MS = 4000;

function describeError(err) {
  return err instanceof Error
    ? `${err.name}: ${err.message}\n${err.stack?.slice(0, 500) ?? ''}`
    : String(err);
}

// Resolves 'done' | 'failed' | 'timeout', never rejects.
function withTimeout(work, ms) {
  let timer;
  const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve('timeout'), ms); });
  const settled = Promise.resolve(work).then(() => 'done', () => 'failed');
  return Promise.race([settled, timeout]).finally(() => clearTimeout(timer));
}

// supabase-js query builders are thenables: they have .then but no .catch, so
// the result is awaited and the { error } field is checked instead.
async function saveCrash(supabase, value) {
  try {
    const { error } = await supabase
      .from('primalgame_state')
      .update({ value })
      .eq('key', 'last_crash');
    if (error) console.error('[bot-errors] Could not store crash info:', error.message);
  } catch (err) {
    console.error('[bot-errors] Could not store crash info:', err?.message ?? err);
  }
}

// beforeExit: optional async hook (e.g. flush the ingest queues), run in
// parallel with the crash report and bounded by the same timeout.
// exit/proc/timeoutMs are injectable for tests.
function setupBotErrors(client, {
  supabase,
  beforeExit,
  exit = (code) => process.exit(code),
  proc = process,
  timeoutMs = CLEANUP_TIMEOUT_MS,
} = {}) {
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

  // Fatal path: store the crash for the next boot, post to Discord, flush the
  // queues, then exit(1). Runs once; anything that fails or hangs is cut off
  // after timeoutMs and the exit still happens.
  let exiting = false;
  async function fatal(label, title, crashInfo) {
    if (exiting) return; // a second error during cleanup must not restart it
    exiting = true;
    try {
      console.error(`[bot-errors] ${label}:`, crashInfo);
      const cleanup = [
        saveCrash(supabase, crashInfo),
        postBotError(client, title, `\`\`\`${crashInfo}\`\`\``),
      ];
      if (beforeExit) cleanup.push(Promise.resolve().then(beforeExit));
      const outcome = await withTimeout(Promise.all(cleanup), timeoutMs);
      if (outcome !== 'done') console.error(`[bot-errors] Cleanup ${outcome}, exiting anyway.`);
    } catch (err) {
      console.error('[bot-errors] Cleanup error:', err?.message ?? err);
    } finally {
      exit(1);
    }
  }

  // Uncaught exceptions: process state is unknown, so exit (Railway restarts).
  proc.on('uncaughtException', (err) => {
    fatal('Uncaught exception', 'Uncaught Exception', describeError(err));
  });

  // Unhandled promise rejections: Node's own default is to crash, so this
  // exits too. UNHANDLED_REJECTION_EXIT=off turns it back into log-and-report.
  proc.on('unhandledRejection', (reason) => {
    const msg = describeError(reason);
    if (process.env.UNHANDLED_REJECTION_EXIT === 'off') {
      console.error('[bot-errors] Unhandled rejection (not exiting):', msg);
      postBotError(client, 'Unhandled Promise Rejection', `\`\`\`${msg}\`\`\``);
      return;
    }
    fatal('Unhandled rejection', 'Unhandled Promise Rejection', msg);
  });

  console.log('[bot-errors] Bot error monitor active.');
}

module.exports = setupBotErrors;
module.exports.withTimeout = withTimeout;
module.exports.describeError = describeError;