// ─── Bot Logs ─────────────────────────────────────────────────────────────────
// Intercepts console.log and console.error, buffers entries for one hour,
// then posts a summary embed to #bot-logs. Railway logs remain unchanged —
// this just mirrors them to Discord for visibility without needing Railway access.

const { EmbedBuilder } = require('discord.js');

const LOGS_CHANNEL_ID  = '1521953749139062926';
const POST_INTERVAL_MS = 60 * 60 * 1000;

// Entries buffered since last post
const buffer = { info: [], error: [] };

// Terms to suppress from Discord logs
const SUPPRESS = ['claude', 'anthropic'];
function shouldSuppress(msg) {
  const lower = msg.toLowerCase();
  return SUPPRESS.some(t => lower.includes(t));
}

function timestamp() {
  return new Date().toLocaleTimeString('en-US', {
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  });
}

function interceptConsole() {
  const origLog   = console.log.bind(console);
  const origError = console.error.bind(console);

  console.log = (...args) => {
    origLog(...args);
    const msg = args.map(String).join(' ');
    if (!shouldSuppress(msg)) buffer.info.push(`[${timestamp()}] ${msg}`);
  };

  console.error = (...args) => {
    origError(...args);
    const msg = args.map(String).join(' ');
    if (!shouldSuppress(msg)) buffer.error.push(`[${timestamp()}] ${msg}`);
  };
}

function buildLogsEmbed() {
  const now      = new Date();
  const hourStr  = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
  const dateStr  = now.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

  const hasErrors = buffer.error.length > 0;
  const color     = hasErrors ? 0xED4245 : 0x57F287;

  const embed = new EmbedBuilder()
    .setColor(color)
    .setTitle(`Hourly Log Summary — ${dateStr} ${hourStr}`)
    .setFooter({ text: 'PrimalGame · Bot Logs' })
    .setTimestamp();

  // Info logs — cap at 3800 chars total to stay under embed limits
  if (buffer.info.length > 0) {
    let infoText = buffer.info.join('\n');
    if (infoText.length > 1800) {
      const lines = buffer.info;
      infoText = `*(${lines.length - 20} earlier entries omitted)*\n` +
        lines.slice(-20).join('\n');
    }
    if (infoText.length > 1800) infoText = infoText.slice(-1800);
    embed.addFields({
      name:  `Info (${buffer.info.length})`,
      value: `\`\`\`\n${infoText}\n\`\`\``,
    });
  } else {
    embed.addFields({ name: 'Info', value: '*No log entries this hour.*' });
  }

  // Error logs
  if (buffer.error.length > 0) {
    let errText = buffer.error.join('\n');
    if (errText.length > 1800) {
      errText = buffer.error.slice(-15).join('\n');
      if (errText.length > 1800) errText = errText.slice(-1800);
    }
    embed.addFields({
      name:  `Errors (${buffer.error.length})`,
      value: `\`\`\`\n${errText}\n\`\`\``,
    });
  }

  return embed;
}

async function postLogs(client) {
  try {
    const embed = buildLogsEmbed();

    // Clear buffer after building embed
    buffer.info  = [];
    buffer.error = [];

    const ch = client.channels.cache.get(LOGS_CHANNEL_ID)
      ?? await client.channels.fetch(LOGS_CHANNEL_ID).catch(() => null);
    if (!ch) { console.error('[bot-logs] Could not find logs channel'); return; }

    await ch.send({ embeds: [embed] });
  } catch (err) {
    // Use originals to avoid infinite loop
    process.stderr.write(`[bot-logs] Failed to post: ${err.message}\n`);
  }
}

module.exports = function setupBotLogs(client, { supabase }) {
  interceptConsole();

  // Stagger first post to align to the next top of the hour
  const now          = new Date();
  const msToNextHour = (60 - now.getMinutes()) * 60 * 1000 - now.getSeconds() * 1000;

  setTimeout(() => {
    postLogs(client);
    setInterval(() => postLogs(client), POST_INTERVAL_MS);
  }, msToNextHour);

  console.log(`[bot-logs] Started — first post in ${Math.round(msToNextHour / 60000)}min, then hourly.`);
};