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
  console.log(`PrimalGame logged in as ${client.user.tag}`);
});

client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;

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

client.login(process.env.DISCORD_TOKEN);

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
  console.log('Received round-complete payload:', req.body);
  res.json({ received: true });
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`PrimalGame ingestion API listening on port ${port}`);
});
