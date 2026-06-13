require('dotenv').config();
const fs = require('fs');
const path = require('path');
const express = require('express');
const { Client, GatewayIntentBits, Collection } = require('discord.js');
const { createClient } = require('@supabase/supabase-js');

// Supabase client - optional until SUPABASE_URL / SUPABASE_SERVICE_KEY are set
const supabase = (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY)
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
  : null;

// Discord client
const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

client.commands = new Collection();
const commandsPath = path.join(__dirname, 'commands');
const commandFiles = fs.readdirSync(commandsPath).filter(f => f.endsWith('.js'));
for (const file of commandFiles) {
  const command = require(path.join(commandsPath, file));
  if (command.data && command.execute) {
    client.commands.set(command.data.name, command);
  }
}

client.once('ready', () => {
  console.log(`PrimalGame logged in as ${client.user.tag} (pid ${process.pid})`);
});

const recentInteractionIds = new Set();

client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;

  // Discord occasionally redelivers the same interaction (e.g. on gateway
  // resume), producing a second interaction object whose replied/deferred
  // flags both start false. Dedupe by interaction ID so only the first
  // dispatch is processed.
  if (recentInteractionIds.has(interaction.id)) return;
  recentInteractionIds.add(interaction.id);
  setTimeout(() => recentInteractionIds.delete(interaction.id), 60_000);

  const command = client.commands.get(interaction.commandName);
  if (!command) return;

  try {
    await command.execute(interaction, { supabase });
  } catch (err) {
    console.error(`Error running /${interaction.commandName}:`, err);
    const reply = { content: 'Something went wrong running that command.', ephemeral: true };
    if (interaction.replied || interaction.deferred) {
      await interaction.followUp(reply).catch(() => {});
    } else {
      await interaction.reply(reply).catch(() => {});
    }
  }
});

client.login(process.env.DISCORD_TOKEN?.trim());

// Ingestion API
const app = express();
app.use(express.json());

app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'primalgame' });
});

function requireIngestKey(req, res, next) {
  const key = req.headers['x-api-key'];
  if (!key || key !== process.env.INGEST_API_KEY) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
}

app.post('/api/round-complete', requireIngestKey, async (req, res) => {
  if (!supabase) return res.status(503).json({ error: 'database not configured' });

  const { map, serverType, playerCount, averageLevel, gameVersion, players } = req.body;

  if (!map || !Array.isArray(players) || players.length === 0) {
    return res.status(400).json({ error: 'invalid payload: map and players[] are required' });
  }

  const { data: round, error: roundError } = await supabase
    .from('round_logs')
    .insert({
      map,
      server_type: serverType || 'regular',
      player_count: playerCount ?? players.length,
      average_level: averageLevel ?? null,
      game_version: gameVersion ?? null,
    })
    .select('id')
    .single();

  if (roundError) {
    console.error('[round-complete] failed to insert round_logs:', roundError.message);
    return res.status(500).json({ error: roundError.message });
  }

  const playerRows = players.map(p => ({
    round_id: round.id,
    roblox_user_id: String(p.robloxUserId),
    discord_id: p.discordId ? String(p.discordId) : null,
    dino: p.dino ?? null,
    weapon: p.weapon ?? null,
    vehicle: p.vehicle ?? null,
    level: p.level ?? null,
    won: !!p.won,
  }));

  const { error: playersError } = await supabase.from('round_players').insert(playerRows);

  if (playersError) {
    console.error('[round-complete] failed to insert round_players:', playersError.message);
    return res.status(500).json({ error: playersError.message });
  }

  console.log(`[round-complete] logged round ${round.id} on ${map} with ${playerRows.length} players`);
  res.json({ received: true, roundId: round.id });
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`PrimalGame ingestion API listening on port ${port}`);
});
