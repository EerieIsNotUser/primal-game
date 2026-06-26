require('dotenv').config();
const fs = require('fs');
const path = require('path');
const express = require('express');
const { Client, GatewayIntentBits, Collection } = require('discord.js');
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

client.once('ready', () => {
  console.log(`PrimalGame logged in as ${client.user.tag}`);

  require('./modules/map-history-digest')(client, { supabase });
  require('./modules/anomaly-alerts')(client, { supabase });
  require('./modules/balance-report')(client, { supabase });
  require('./modules/raw-data-digest')(client, { supabase });
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

app.post('/api/round-complete', requireIngestKey, async (req, res) => {
  console.log('[round-complete] Raw payload:', JSON.stringify(req.body));
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

  if (!Round_Map || !Round_Result) {
    console.error('[round-complete] Missing required fields:', { Round_Map, Round_Result });
    return res.status(400).json({ error: 'Missing required fields: Round_Map and Round_Result' });
  }

  // Normalise result values to canonical form — KKG's game emits 'HumanEscape'
  // for survivor escapes; map to 'SurvivorWin' so all queries work consistently.
  const normalisedResult = (Round_Result === 'HumanEscape' || Round_Result === 'HumanWin')
    ? 'SurvivorWin' : Round_Result;

  const { error } = await supabase.from('round_logs').insert({
    played_at: new Date().toISOString(),
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
    return res.status(500).json({ error: 'Failed to log round' });
  }

  console.log(`[round-complete] Logged round on ${Round_Map} (${Round_Result}) — players: ${Round_NumberOfPlayers ?? '?'}, MVP weapon: ${Round_MVP_EquippedWeapon ?? 'none'}, MVP vehicle: ${Round_MVP_EquippedVehicle ?? 'none'}`);
  res.json({ received: true });
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`PrimalGame ingestion API listening on port ${port}`);
});