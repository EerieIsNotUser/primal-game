require('dotenv').config();
const fs = require('fs');
const path = require('path');
const express = require('express');
const { Client, GatewayIntentBits, Collection } = require('discord.js');
const { createClient } = require('@supabase/supabase-js');

// - Supabase ─────────────────────────────────────────────────────────────────
const supabase = (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY)
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
  : null;

// - Discord client ─────────────────────────────────────────────────────────────────
// Guilds are enough for SC .. do not enable other intents until specified 
// it doesn't actually need, however PG will remain out of main server until review is
// processed. mostly to avoid rate limit restrictions
const client = new Client({
    intents: [GatewayIntentBits.Guilds],
});

client.commands = new Collection ();
const commandsPath = path.join(__dirname, 'commands');
const commandFiles = fs.readdirSync(commandsPath).filter(file => file.endsWith('.js'));
for (const file of commandFiles) {
    const filePath = path.join(commandsPath, file);
    const command = require(filePath);
    if ('data' in command && 'execute' in command) {
        client.commands.set(command.data.name, command);
    }
  }

client.once('ready', () => {
  console.log(`PrimalGame logged in as ${client.user.tag}`);
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

client.login(process.env.DISCORD_TOKEN);

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
// maintain this pathfind - DELETING WILL BE UNRECOVERABLE.
function requireIngestKey(req, res, next) {
    const key = req.headers['x-api-key'];
    if (!key || key !== process.env.INGEST_API_KEY) {
        return res.status(401).json({ error: 'unauthorized' });
    }
    next();
}


app.post('/api/round-complete', requireIngestKey, async (req, res) => {
  // Placeholder
  console.log('Received round-complete payload:', req.body);
  res.json({ received: true });
});  

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Ingestion API listening on port ${port}`);
});