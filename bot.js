require('dotenv').config();
const fs     = require('fs');
const path   = require('path');
const express = require('express');
const { Client, GatewayIntentBits, Collection, EmbedBuilder, AttachmentBuilder } = require('discord.js');
const { execSync } = require('child_process');
const { createClient } = require('@supabase/supabase-js');

// ── Supabase ─────────────────────────────────────────────────────────────────
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

// ── Discord client ──────────────────────────────────────────────────────────
// Guilds is enough for slash commands. Add more intents only when a feature
// actually needs them (e.g. GuildMembers for member-lookup commands) - fewer
// intents means PrimalGame stays out of Discord's privileged intent review.
const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

client.commands = new Collection();
const commandsPath = path.join(__dirname, 'commands');
const commandFiles = fs.readdirSync(commandsPath).filter(f => f.endsWith('.js'));
const commandDataForRegistration = [];

for (const file of commandFiles) {
  const command = require(path.join(commandsPath, file));
  if (command.data && command.execute) {
    client.commands.set(command.data.name, command);
    commandDataForRegistration.push(command.data.toJSON());
  }
}

// ── Register slash commands with Discord ─────────────────────────────────
// Runs on every boot. Guild-scoped (instant updates) if DISCORD_GUILD_ID is
// set, otherwise global (takes up to an hour to propagate).
const { REST, Routes } = require('discord.js');
const rest = new REST().setToken(process.env.DISCORD_TOKEN?.trim());

async function registerCommands() {
  try {
    const route = process.env.DISCORD_GUILD_ID
      ? Routes.applicationGuildCommands(process.env.DISCORD_CLIENT_ID, process.env.DISCORD_GUILD_ID)
      : Routes.applicationCommands(process.env.DISCORD_CLIENT_ID);

    const data = await rest.put(route, { body: commandDataForRegistration });
    console.log(`Registered ${data.length} slash command(s)${process.env.DISCORD_GUILD_ID ? ' (guild-scoped)' : ' (global)'}.`);
  } catch (err) {
    console.error('Failed to register slash commands:', err);
  }
}

registerCommands();

client.once('ready', async () => {
  console.log(`PrimalGame logged in as ${client.user.tag}`);

  require('./modules/map-history-digest')(client, { supabase });
  // Manual trigger available via module.exports.postDigest(client, supabase)
  require('./modules/anomaly-alerts')(client, { supabase });
  require('./modules/balance-report')(client, { supabase });
  require('./modules/raw-data-digest')(client, { supabase });
  require('./modules/bot-logs')(client, { supabase });
  require('./modules/bot-status')(client, { supabase });
  require('./modules/bot-errors')(client, { supabase });

  // ── Deployment update feed ─────────────────────────────────────────────
  try {
    const commitMsg  = execSync('git log -1 --format=%s').toString().trim();
    const commitHash = execSync('git log -1 --format=%h').toString().trim();
    const commitDate = execSync('git log -1 --format=%ci').toString().trim();

    const feedCh = client.channels.cache.get('1515751286312669354')
      ?? await client.channels.fetch('1515751286312669354').catch(() => null);

    if (feedCh && commitMsg) {
      const deployEmbed = new EmbedBuilder()
        .setColor(0x24292e)
        .setAuthor({
          name:    'EerieIsUser pushed an update',
          iconURL: 'https://github.com/EerieIsNotUser.png',
        })
        .setDescription(commitMsg)
        .setThumbnail(client.user.displayAvatarURL({ size: 256 }))
        .addFields(
          { name: 'Branch',     value: 'main',         inline: true },
          { name: 'Repository', value: 'primal-game',  inline: true },
        )
        .setFooter({ text: `Discord: @EerieIsUser · ${commitHash}` })
        .setTimestamp(new Date(commitDate));

      await feedCh.send({ embeds: [deployEmbed] }).catch(() => {});
    }
  } catch (_) {}
});

client.on('interactionCreate', async interaction => {
  if (interaction.isAutocomplete()) {
    const command = client.commands.get(interaction.commandName);
    if (!command?.autocomplete) return;
    try {
      await command.autocomplete(interaction, { supabase });
    } catch (err) {
      console.error(`Error running autocomplete for /${interaction.commandName}:`, err);
    }
    return;
  }

  // ── Button / select menu component handlers ───────────────────────────
  if (interaction.isButton() || interaction.isStringSelectMenu()) {
    const id = interaction.customId;
    let commandName = null;
    if (id.startsWith('mapchart_') || id.startsWith('preview_')) commandName = 'mapchart';
    if (id.startsWith('piechart_'))                               commandName = 'piechart';

    if (commandName) {
      const command = client.commands.get(commandName);
      if (command?.handleComponent) {
        try {
          await command.handleComponent(interaction, { supabase });
        } catch (err) {
          console.error(`Error handling component ${id}:`, err);
        }
      }
      return;
    }
  }

  if (!interaction.isChatInputCommand()) return;

  const command = client.commands.get(interaction.commandName);
  if (!command) return;

  try {
    await command.execute(interaction, { supabase });
  } catch (err) {
    console.error(`Error running /${interaction.commandName}:`, err);
    const reply = { content: '❌ Something went wrong running that command.', ephemeral: true };
    if (interaction.replied || interaction.deferred) {
      await interaction.followUp(reply).catch(() => {});
    } else {
      await interaction.reply(reply).catch(() => {});
    }
  }
});

client.login(process.env.DISCORD_TOKEN?.trim());

// ── Ingestion API ────────────────────────────────────────────────────────────
// Roblox (via KKG's script) will POST round-complete payloads here once the
// payload shape is finalized. For now this is just a health check + stub so
// the Express server has somewhere to live from day one.
const app = express();
app.use(express.json());

app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'primalgame' });
});

// Shared-secret check for any future /api/* ingestion routes.
function requireIngestKey(req, res, next) {
  const key = req.headers['x-api-key']
    ?? req.headers['authorization']?.replace(/^Bearer\s+/i, '');
  if (!key || key !== process.env.INGEST_API_KEY) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
}

const { checkAndPostLuaError } = require('./modules/lua-errors');
const SUMMARY_CHANNEL_ID   = '1515751286312669354';
const SUMMARY_BATCH_SIZE   = 100;
const INGESTION_ERROR_CH   = '1515751607608803359';
const OWNER_ID             = '1289766186170581120';

async function postIngestionError(msg) {
  try {
    const ch = client.channels.cache.get(INGESTION_ERROR_CH)
      ?? await client.channels.fetch(INGESTION_ERROR_CH).catch(() => null);
    if (ch) await ch.send(`<@${OWNER_ID}> ⚠️ Ingestion error: ${msg}`);
  } catch (err) {
    console.error('[ingestion-errors] Failed to post error:', err.message);
  }
}

async function postBatchSummary(rows) {
  try {
    const dinoWins     = rows.filter(r => r.round_result === 'DinoWin').length;
    const survivorWins = rows.filter(r => r.round_result === 'SurvivorWin').length;
    const dinoWinPct   = Math.round((dinoWins / rows.length) * 100);

    const mapCounts     = new Map();
    const weaponCounts  = new Map();
    const vehicleCounts = new Map();
    const dinoCounts    = new Map();

    for (const r of rows) {
      if (r.map) mapCounts.set(r.map, (mapCounts.get(r.map) || 0) + 1);
      if (r.mvp_equipped_weapon)  weaponCounts.set(r.mvp_equipped_weapon,  (weaponCounts.get(r.mvp_equipped_weapon)  || 0) + 1);
      if (r.mvp_equipped_vehicle) vehicleCounts.set(r.mvp_equipped_vehicle, (vehicleCounts.get(r.mvp_equipped_vehicle) || 0) + 1);
      if (r.dinosaurs_used) {
        const dinos = Array.isArray(r.dinosaurs_used) ? r.dinosaurs_used : [r.dinosaurs_used];
        for (const d of dinos) dinoCounts.set(d, (dinoCounts.get(d) || 0) + 1);
      }
    }

    const topMap     = [...mapCounts.entries()].sort((a, b) => b[1] - a[1])[0];
    const topWeapon  = [...weaponCounts.entries()].sort((a, b) => b[1] - a[1])[0];
    const topVehicle = [...vehicleCounts.entries()].sort((a, b) => b[1] - a[1])[0];
    const topDino    = [...dinoCounts.entries()].sort((a, b) => b[1] - a[1])[0];

    const firstRound = new Date(rows[0].played_at);
    const lastRound  = new Date(rows[rows.length - 1].played_at);
    const dateRange  = `${firstRound.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} – ${lastRound.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`;

    const embed = new EmbedBuilder()
      .setColor(0x5865F2)
      .setTitle(`${SUMMARY_BATCH_SIZE} Rounds Logged`)
      .setDescription(dateRange)
      .addFields(
        { name: 'Win Rate',        value: `Dino ${dinoWinPct}% / Survivor ${100 - dinoWinPct}%`, inline: true },
        { name: 'Dino Wins',       value: dinoWins.toString(),                                     inline: true },
        { name: 'Survivor Wins',   value: survivorWins.toString(),                                 inline: true },
        { name: 'Top Map',         value: topMap     ? `${topMap[0]} (${topMap[1]}x)`       : '—', inline: true },
        { name: 'Top MVP Weapon',  value: topWeapon  ? `${topWeapon[0]} (${topWeapon[1]}x)` : '—', inline: true },
        { name: 'Top MVP Vehicle', value: topVehicle ? `${topVehicle[0]} (${topVehicle[1]}x)` : '—', inline: true },
        { name: 'Top Dino Used',   value: topDino    ? `${topDino[0]} (${topDino[1]}x)`     : '—', inline: true },
      )
      .setFooter({ text: `PrimalGame · ${SUMMARY_BATCH_SIZE}-round batch summary` })
      .setTimestamp();

    // Raw data attachment
    const COLS = [
      { key: 'played_at',            label: 'Played At',   width: 20 },
      { key: 'map',                  label: 'Map',         width: 14 },
      { key: 'round_result',         label: 'Result',      width: 14 },
      { key: 'game_mode',            label: 'Mode',        width: 16 },
      { key: 'mvp_equipped_weapon',  label: 'MVP Weapon',  width: 18 },
      { key: 'mvp_equipped_vehicle', label: 'MVP Vehicle', width: 16 },
      { key: 'mvp_damage',           label: 'MVP Dmg',     width: 9  },
      { key: 'number_of_players',    label: 'Players',     width: 8  },
    ];
    const fmt = (v, w) => { let s = v == null ? '-' : String(v); if (s.length > w) s = s.slice(0, w - 1) + '…'; return s.padEnd(w); };
    const header    = COLS.map(c => fmt(c.label, c.width)).join(' | ');
    const separator = COLS.map(c => '-'.repeat(c.width)).join('-+-');
    const lines     = rows.map(r => COLS.map(c => {
      const v = c.key === 'played_at' ? new Date(r[c.key]).toISOString().replace('T', ' ').slice(0, 19) : r[c.key];
      return fmt(v, c.width);
    }).join(' | '));
    const table      = [header, separator, ...lines].join('\n');
    const attachment = new AttachmentBuilder(Buffer.from(table, 'utf8'), { name: `rounds-batch-${Date.now()}.txt` });

    const ch = client.channels.cache.get(SUMMARY_CHANNEL_ID)
      ?? await client.channels.fetch(SUMMARY_CHANNEL_ID).catch(() => null);
    if (ch) await ch.send({ embeds: [embed], files: [attachment] });

    console.log(`[round-complete] ${SUMMARY_BATCH_SIZE}-round batch summary posted.`);
  } catch (err) {
    console.error('[round-complete] Summary post failed:', err.message);
  }
}

async function checkAndPostSummary() {
  try {
    const { data: stateRow } = await supabase
      .from('primalgame_state')
      .select('value')
      .eq('key', 'last_summary_at')
      .single();

    const lastSummaryAt = stateRow?.value ?? '1970-01-01T00:00:00Z';

    const { count } = await supabase
      .from('round_logs')
      .select('*', { count: 'exact', head: true })
      .gt('played_at', lastSummaryAt);

    if ((count ?? 0) < SUMMARY_BATCH_SIZE) return;

    const { data: rows } = await supabase
      .from('round_logs')
      .select('*')
      .gt('played_at', lastSummaryAt)
      .order('played_at', { ascending: true })
      .limit(SUMMARY_BATCH_SIZE);

    if (!rows || rows.length < SUMMARY_BATCH_SIZE) return;

    await postBatchSummary(rows);

    await supabase
      .from('primalgame_state')
      .update({ value: rows[rows.length - 1].played_at })
      .eq('key', 'last_summary_at');
  } catch (err) {
    console.error('[round-complete] Summary check failed:', err.message);
  }
}

app.post('/api/round-complete', requireIngestKey, async (req, res) => {
  if (!req.body?.data?.Round_Map) console.log('[round-complete] Unexpected payload shape:', JSON.stringify(req.body));
  // Support both flat payload and Logger.Send wrapper ({ level, data: { ... } })
  const body = req.body?.data ?? req.body;
  const {
    Round_Result, Round_AverageLevel, Round_NumberOfPlayers, Round_Game_Mode,
    Round_Map, Round_AtmosphereType, Round_DinoPlayerAverageLevel,
    Round_NumPlayers_WithMedkits, Round_NumPlayers_WithToolkits, Round_NumPlayers_WithFuelcans,
    Round_NumPlayers_WithDinoTrackers, Round_NumPlayers_WithMines, Round_NumPlayers_WithGamepassWeapons,
    Round_DinosaursUsed, Round_VehiclesUsed, Round_WeaponsUsed,
    Round_MVP_EquippedVehicle, Round_MVP_EquippedWeapon, Round_MVP_Damage,
  } = body;

  // Analyse payload for Lua-side scripting issues before anything else
  checkAndPostLuaError(client, req.body, body);

  if (!Round_Map || !Round_Result) {
    const errMsg = `Missing required fields — Round_Map: ${Round_Map ?? 'undefined'}, Round_Result: ${Round_Result ?? 'undefined'}`;
    console.error('[round-complete]', errMsg);
    postIngestionError(errMsg);
    require('./modules/bot-status').recordError(errMsg);
    return res.status(400).json({ error: 'Missing required fields: Round_Map and Round_Result' });
  }

  const normalisedResult = (Round_Result === 'HumanEscape' || Round_Result === 'HumanWin')
    ? 'SurvivorWin' : Round_Result;

  const roundEndTime = req.body?.time
    ? new Date(req.body.time * 1000).toISOString()
    : new Date().toISOString();

  const { error } = await supabase.from('round_logs').insert({
    played_at:    roundEndTime,
    received_at:  new Date().toISOString(),
    place_id:     req.body?.placeId ?? null,
    round_result: normalisedResult,
    average_level: Round_AverageLevel ?? null,
    number_of_players: Round_NumberOfPlayers ?? null,
    game_mode: Round_Game_Mode ?? null,
    map: Round_Map,
    atmosphere_type: Round_AtmosphereType ?? null,
    dino_player_average_level: Round_DinoPlayerAverageLevel ?? null,
    num_players_with_medkits: Round_NumPlayers_WithMedkits ?? 0,
    num_players_with_toolkits: Round_NumPlayers_WithToolkits ?? 0,
    num_players_with_fuelcans: Round_NumPlayers_WithFuelcans ?? 0,
    num_players_with_dinotrackers: Round_NumPlayers_WithDinoTrackers ?? 0,
    num_players_with_mines: Round_NumPlayers_WithMines ?? 0,
    num_players_with_gamepass_weapons: Round_NumPlayers_WithGamepassWeapons ?? 0,
    dinosaurs_used: Array.isArray(Round_DinosaursUsed) ? Round_DinosaursUsed : (Round_DinosaursUsed ? [Round_DinosaursUsed] : null),
    vehicles_used: Array.isArray(Round_VehiclesUsed) ? Round_VehiclesUsed : null,
    weapons_used: Array.isArray(Round_WeaponsUsed) ? Round_WeaponsUsed : null,
    mvp_equipped_vehicle: Round_MVP_EquippedVehicle ?? null,
    mvp_equipped_weapon: Round_MVP_EquippedWeapon ?? null,
    mvp_damage: Round_MVP_Damage ?? null,
  });

  if (error) {
    console.error('[round-complete] Insert error:', error.message);
    postIngestionError(`Supabase insert failed — ${error.message}`);
    require('./modules/bot-status').recordError(error.message);
    return res.status(500).json({ error: 'Failed to log round' });
  }

  require('./modules/bot-status').recordSuccess();
  res.json({ received: true });

  // Fire summary check after responding so it doesn't block the HTTP response
  checkAndPostSummary();
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`PrimalGame ingestion API listening on port ${port}`);
});