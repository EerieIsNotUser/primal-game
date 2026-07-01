// ─── Lua Error Monitor ────────────────────────────────────────────────────────
// Detects anomalous payloads from KKG's Roblox script that suggest a Lua-side
// scripting error. Posts to #lua-errors with a description of what looks wrong.
// Does NOT block ingestion — the round is still stored if possible.

const { EmbedBuilder } = require('discord.js');

const LUA_ERROR_CHANNEL_ID = '1521948000690372770';
const OWNER_ID             = '1289766186170581120';

const KNOWN_RESULTS = new Set(['DinoWin', 'HumanWin', 'HumanEscape', 'SurvivorWin']);
const KNOWN_MAPS    = new Set(['Jungle', 'Canyon', 'Cavern', 'Primal Park']);

// Dedup — don't spam the same issue repeatedly within 10 minutes
const recentAlerts = new Map();
function isDuped(key) {
  const last = recentAlerts.get(key);
  if (last && Date.now() - last < 10 * 60 * 1000) return true;
  recentAlerts.set(key, Date.now());
  return false;
}

function analysePayload(rawBody, parsedBody) {
  const issues = [];

  // Wrong Logger.Send call hit this endpoint
  if (rawBody.level && rawBody.level !== 'RoundResult') {
    issues.push(`Unexpected \`level\` field: \`${rawBody.level}\` — a non-round Logger.Send call may be hitting this endpoint`);
  }

  // Unknown round result
  if (parsedBody.Round_Result && !KNOWN_RESULTS.has(parsedBody.Round_Result)) {
    issues.push(`Unknown \`Round_Result\`: \`${parsedBody.Round_Result}\` — not a recognised outcome value`);
  }

  // Unknown map
  if (parsedBody.Round_Map && !KNOWN_MAPS.has(parsedBody.Round_Map)) {
    issues.push(`Unknown \`Round_Map\`: \`${parsedBody.Round_Map}\` — not a recognised map name`);
  }

  // Zero or suspiciously high player count
  if (parsedBody.Round_NumberOfPlayers !== undefined && parsedBody.Round_NumberOfPlayers !== null) {
    if (parsedBody.Round_NumberOfPlayers === 0) {
      issues.push(`\`Round_NumberOfPlayers\` is 0 — round logged with no players`);
    } else if (parsedBody.Round_NumberOfPlayers > 50) {
      issues.push(`\`Round_NumberOfPlayers\` is ${parsedBody.Round_NumberOfPlayers} — unusually high, possible data error`);
    }
  }

  // Negative MVP damage
  if (parsedBody.Round_MVP_Damage !== undefined && parsedBody.Round_MVP_Damage !== null) {
    if (parsedBody.Round_MVP_Damage < 0) {
      issues.push(`\`Round_MVP_Damage\` is negative (${parsedBody.Round_MVP_Damage}) — impossible value`);
    }
  }

  // Many null fields simultaneously — suggests payload schema mismatch
  const expectedFields = [
    'Round_AverageLevel', 'Round_NumberOfPlayers', 'Round_Game_Mode',
    'Round_AtmosphereType', 'Round_DinoPlayerAverageLevel',
    'Round_DinosaursUsed', 'Round_VehiclesUsed', 'Round_WeaponsUsed',
  ];
  const nullCount = expectedFields.filter(f => parsedBody[f] == null).length;
  if (nullCount >= 5) {
    issues.push(`${nullCount}/${expectedFields.length} expected fields are null — possible payload schema mismatch or incomplete Logger.Send call`);
  }

  return issues;
}

async function checkAndPostLuaError(client, rawBody, parsedBody) {
  const issues = analysePayload(rawBody, parsedBody);
  if (issues.length === 0) return;

  // Dedup by issue fingerprint
  const fingerprint = issues.join('|');
  if (isDuped(fingerprint)) return;

  try {
    const ch = client.channels.cache.get(LUA_ERROR_CHANNEL_ID)
      ?? await client.channels.fetch(LUA_ERROR_CHANNEL_ID).catch(() => null);
    if (!ch) return;

    const embed = new EmbedBuilder()
      .setColor(0xFCA253)
      .setTitle('⚠️ Suspicious Payload Detected')
      .setDescription(
        `A round payload was received that may indicate a Lua scripting issue.\n\n` +
        `**Issues detected:**\n${issues.map(i => `• ${i}`).join('\n')}`
      )
      .addFields({
        name: 'Raw Payload (truncated)',
        value: `\`\`\`json\n${JSON.stringify(rawBody).slice(0, 800)}\`\`\``,
      })
      .setFooter({ text: 'PrimalGame · Lua Error Monitor' })
      .setTimestamp();

    await ch.send({ content: `<@${OWNER_ID}>`, embeds: [embed] });
    console.log(`[lua-errors] Posted alert — ${issues.length} issue(s) detected.`);
  } catch (err) {
    console.error('[lua-errors] Failed to post alert:', err.message);
  }
}

module.exports = { checkAndPostLuaError };