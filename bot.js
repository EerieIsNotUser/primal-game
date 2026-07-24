require('dotenv').config();
const fs     = require('fs');
const path   = require('path');
const express = require('express');
const { Client, GatewayIntentBits, Collection, EmbedBuilder, AttachmentBuilder } = require('discord.js');
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
  require('./modules/tierlist-digest')(client, { supabase });
  require('./modules/matchupdata-digest')(client, { supabase });
  // Manual triggers available via module.exports.postDigest / postTierList / postMatchupData
  require('./modules/anomaly-alerts')(client, { supabase });
  require('./modules/balance-report')(client, { supabase });
  require('./modules/raw-data-digest')(client, { supabase });
  require('./modules/bot-logs')(client, { supabase });
  require('./modules/bot-status')(client, { supabase });
  require('./modules/bot-errors')(client, { supabase });
  require('./modules/rollup')(client, { supabase });

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
const crypto = require('crypto');
const app    = express();

// ── GitHub push webhook (must be BEFORE express.json()) ───────────────────────
app.post('/github-webhook', express.raw({ type: '*/*' }), async (req, res) => {
  const sig    = req.headers['x-hub-signature-256'];
  const secret = process.env.GITHUB_WEBHOOK_SECRET;

  if (secret && sig) {
    const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(req.body).digest('hex');
    try {
      if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
        return res.status(401).json({ error: 'Invalid signature' });
      }
    } catch {
      return res.status(401).json({ error: 'Invalid signature' });
    }
  }

  const payload = JSON.parse(req.body.toString());
  if (!payload.commits?.length) return res.json({ ok: true });

  const branch   = payload.ref?.replace('refs/heads/', '') ?? 'unknown';
  const pusher   = payload.pusher?.name ?? 'Unknown';
  const discord  = ({ 'EerieIsNotUser': 'EerieIsUser' })[pusher] ?? pusher;
  const repoName = payload.repository?.name ?? 'primal-game';

  const ch = client.channels.cache.get('1521953811428671568')
    ?? await client.channels.fetch('1521953811428671568').catch(() => null);
  if (!ch) return res.status(500).json({ error: 'Channel not found' });

  for (const commit of payload.commits) {
    const embed = new EmbedBuilder()
      .setColor(0x24292e)
      .setAuthor({
        name:    `${discord} pushed an update`,
        iconURL: `https://github.com/${pusher}.png`,
      })
      .setDescription(commit.message)
      .setThumbnail(client.user?.displayAvatarURL({ size: 256 }) ?? null)
      .addFields(
        { name: 'Branch',     value: branch,   inline: true },
        { name: 'Repository', value: repoName, inline: true },
      )
      .setFooter({ text: `Discord: @${discord}` })
      .setTimestamp(new Date(commit.timestamp));

    await ch.send({ embeds: [embed] }).catch(err =>
      console.error('[github-webhook] Failed to post:', err.message)
    );
  }

  res.json({ ok: true });
});

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

    // ── Stat card ─────────────────────────────────────────────────────────
    const { buildStatCard } = require('./modules/chart');

    const winColorHex = dinoWinPct >= 60 ? '#ED4245' : (100 - dinoWinPct) >= 60 ? '#57F287' : '#FEE75C';

    const cardBuffer = await buildStatCard({
      title:    `${SUMMARY_BATCH_SIZE} Rounds Logged`,
      subtitle: `Primal Pursuit · ${dateRange}`,
      stats: [
        { label: 'Total Rounds',  value: rows.length.toLocaleString(),  color: '#5865F2' },
        { label: 'Dino Win',      value: `${dinoWinPct}%`,              color: '#ED4245' },
        { label: 'Survivor Win',  value: `${100 - dinoWinPct}%`,        color: '#57F287' },
      ],
      lookback: dateRange,
      panels: [
        { title: 'Top Map',         lines: [topMap     ? `${topMap[0]} (${topMap[1]}x)`         : '—'] },
        { title: 'Top MVP Weapon',  lines: [topWeapon  ? `${topWeapon[0]} (${topWeapon[1]}x)`   : '—'] },
        { title: 'Top MVP Vehicle', lines: [topVehicle ? `${topVehicle[0]} (${topVehicle[1]}x)` : '—'] },
        { title: 'Top Dino Used',   lines: [topDino    ? `${topDino[0]} (${topDino[1]}x)`       : '—'] },
      ],
      note: winColorHex === '#ED4245'
        ? `Dinos are winning ${dinoWinPct}% of rounds this batch — significantly above average.`
        : winColorHex === '#57F287'
        ? `Survivors are winning ${100 - dinoWinPct}% of rounds this batch — significantly above average.`
        : '',
    });

    // ── Raw data attachment ───────────────────────────────────────────────
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
    const cardAttachment = new AttachmentBuilder(cardBuffer, { name: 'batch-summary.png' });

    const ch = client.channels.cache.get(SUMMARY_CHANNEL_ID)
      ?? await client.channels.fetch(SUMMARY_CHANNEL_ID).catch(() => null);
    if (ch) await ch.send({ files: [cardAttachment, attachment] });

    console.log(`[round-complete] ${SUMMARY_BATCH_SIZE}-round batch summary posted.`);

    // ── Win-rate channel — one stat card per map ──────────────────────────
    await postWinRateUpdate(rows);
  } catch (err) {
    console.error('[round-complete] Summary post failed:', err.message);
  }
}

const WIN_RATE_CHANNEL_ID = '1515750371157606400';
const ALL_MAPS            = ['Jungle', 'Canyon', 'Cavern', 'Primal Park'];

async function postWinRateUpdate(rows) {
  try {
    const { buildWinRateDashboard } = require('./modules/chart');

    const winRateCh = client.channels.cache.get(WIN_RATE_CHANNEL_ID)
      ?? await client.channels.fetch(WIN_RATE_CHANNEL_ID).catch(() => null);
    if (!winRateCh) return;

    const firstRound = new Date(rows[0].played_at);
    const lastRound  = new Date(rows[rows.length - 1].played_at);
    const dateRange  = `${firstRound.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} – ${lastRound.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`;

    const totalDinoWins     = rows.filter(r => r.round_result === 'DinoWin').length;
    const totalDinoWinPct   = Math.round((totalDinoWins / rows.length) * 100);

    const mapData = ALL_MAPS.map(name => {
      const mapRows     = rows.filter(r => r.map === name);
      const dinoWins    = mapRows.filter(r => r.round_result === 'DinoWin').length;
      const survivorWins = mapRows.length - dinoWins;
      return { name, rounds: mapRows.length, dinoWins, survivorWins };
    });

    const dashboardBuffer = await buildWinRateDashboard({
      title:    'Win Rate by Map',
      subtitle: `Primal Pursuit · ${SUMMARY_BATCH_SIZE}-Round Batch · ${dateRange}`,
      stats: [
        { label: 'Total Rounds',   value: rows.length.toLocaleString(),   color: '#5865F2' },
        { label: 'Overall Dino',   value: `${totalDinoWinPct}%`,          color: '#ED4245' },
        { label: 'Overall Surv.',  value: `${100 - totalDinoWinPct}%`,    color: '#57F287' },
      ],
      lookback: dateRange,
      maps:     mapData,
    });

    await winRateCh.send({
      files: [new AttachmentBuilder(dashboardBuffer, { name: 'winrate-dashboard.png' })],
    }).catch(err => console.error('[win-rate] Failed to post dashboard:', err.message));

    console.log('[win-rate] Posted win-rate dashboard.');
  } catch (err) {
    console.error('[win-rate] Post failed:', err.message);
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
      .gt('played_at', lastSummaryAt)
      .neq('place_id', '100026158235338');

    if ((count ?? 0) < SUMMARY_BATCH_SIZE) return;

    const { data: rows } = await supabase
      .from('round_logs')
      .select('*')
      .gt('played_at', lastSummaryAt)
      .neq('place_id', '100026158235338')
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

let summaryCheckTimer = null;
function debouncedSummaryCheck() {
  if (summaryCheckTimer) return;
  summaryCheckTimer = setTimeout(async () => {
    summaryCheckTimer = null;
    await checkAndPostSummary().catch(err =>
      console.error('[round-complete] Summary check error:', err.message)
    );
  }, 30_000);
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

  // Sanitise numeric fields — KKG's script can send NaN (e.g. 0/0 average level)
  // which Supabase rejects for numeric columns. Replace NaN with null.
  const safeNum = (v) => (v == null || (typeof v === 'number' && isNaN(v))) ? null : v;
  const safeInt = (v, fallback = 0) => (v == null || (typeof v === 'number' && isNaN(v))) ? fallback : v;

  const { error } = await supabase.from('round_logs').insert({
    played_at:    roundEndTime,
    received_at:  new Date().toISOString(),
    place_id:     req.body?.placeId ?? null,
    round_result: normalisedResult,
    average_level:             safeNum(Round_AverageLevel),
    number_of_players:         safeNum(Round_NumberOfPlayers),
    game_mode:                 Round_Game_Mode ?? null,
    map:                       Round_Map,
    atmosphere_type:           Round_AtmosphereType ?? null,
    dino_player_average_level: safeNum(Round_DinoPlayerAverageLevel),
    num_players_with_medkits:      safeInt(Round_NumPlayers_WithMedkits),
    num_players_with_toolkits:     safeInt(Round_NumPlayers_WithToolkits),
    num_players_with_fuelcans:     safeInt(Round_NumPlayers_WithFuelcans),
    num_players_with_dinotrackers: safeInt(Round_NumPlayers_WithDinoTrackers),
    num_players_with_mines:        safeInt(Round_NumPlayers_WithMines),
    num_players_with_gamepass_weapons: safeInt(Round_NumPlayers_WithGamepassWeapons),
    dinosaurs_used: Array.isArray(Round_DinosaursUsed) ? Round_DinosaursUsed : (Round_DinosaursUsed ? [Round_DinosaursUsed] : null),
    vehicles_used: Array.isArray(Round_VehiclesUsed) ? Round_VehiclesUsed : null,
    weapons_used:  Array.isArray(Round_WeaponsUsed)  ? Round_WeaponsUsed  : null,
    mvp_equipped_vehicle: Round_MVP_EquippedVehicle ?? null,
    mvp_equipped_weapon:  Round_MVP_EquippedWeapon  ?? null,
    mvp_damage:           safeNum(Round_MVP_Damage),
  });

  if (error) {
    console.error('[round-complete] Insert error:', error.message);
    postIngestionError(`Supabase insert failed — ${error.message}`);
    require('./modules/bot-status').recordError(error.message);
    return res.status(500).json({ error: 'Failed to log round' });
  }

  require('./modules/bot-status').recordSuccess();
  res.json({ received: true });

  // Debounced summary check — at most once every 30 seconds regardless of round volume
  debouncedSummaryCheck();
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`PrimalGame ingestion API listening on port ${port}`);
});