const { SlashCommandBuilder, AttachmentBuilder } = require('discord.js');
const { buildRawTable } = require('../modules/raw-data-digest');

// ─── /testrawdata ────────────────────────────────────────────────────────
// Generates synthetic round_logs-shaped rows so the raw data table format
// can be tested before real KKG payloads start flowing in.

const MAPS = ['Jungle', 'Canyon', 'Cavern', 'Primal Park'];
const RESULTS = ['DinoWin', 'SurvivorWin'];
const GAME_MODES = ['regular', 'pro', 'doubletrouble'];
const ATMOSPHERES = ['Day', 'Night', 'Storm'];
const VEHICLES = ['ATV', 'Golf Cart', 'Jeep', 'Hypercar', 'Pickup Truck', 'Police Car', 'Pumpkin Wagon'];
const WEAPONS = ['MP5', 'Shotgun', 'AK-47', 'Railgun', 'Deagle', 'Plasma Rifle', 'Crossbow'];

function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function randInt(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }

function generateFakeRound(daysAgo) {
  const playedAt = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000 - randInt(0, 23) * 60 * 60 * 1000);
  const numPlayers = randInt(4, 12);

  return {
    played_at: playedAt.toISOString(),
    map: pick(MAPS),
    round_result: pick(RESULTS),
    game_mode: pick(GAME_MODES),
    atmosphere_type: pick(ATMOSPHERES),
    number_of_players: numPlayers,
    average_level: randInt(5, 40),
    dino_player_average_level: randInt(5, 40),
    num_players_with_medkits: randInt(0, numPlayers),
    num_players_with_toolkits: randInt(0, numPlayers),
    num_players_with_fuelcans: randInt(0, numPlayers),
    num_players_with_dinotrackers: randInt(0, numPlayers),
    num_players_with_mines: randInt(0, numPlayers),
    num_players_with_gamepass_weapons: randInt(0, Math.floor(numPlayers / 2)),
    mvp_equipped_vehicle: pick(VEHICLES),
    mvp_equipped_weapon: pick(WEAPONS),
    mvp_damage: randInt(100, 2000),
  };
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('testrawdata')
    .setDescription('Post a sample raw data table using synthetic round data')
    .addIntegerOption(opt =>
      opt.setName('rounds')
        .setDescription('Number of fake rounds to generate (default 25)')
        .setMinValue(1)
        .setMaxValue(200)
        .setRequired(false)
    ),

  async execute(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const count = interaction.options.getInteger('rounds') ?? 25;

    const rows = [];
    for (let i = 0; i < count; i++) {
      rows.push(generateFakeRound(randInt(0, 6)));
    }
    rows.sort((a, b) => new Date(a.played_at) - new Date(b.played_at));

    const table = buildRawTable(rows);
    const buffer = Buffer.from(table, 'utf8');
    const attachment = new AttachmentBuilder(buffer, { name: `test-round-data-${Date.now()}.txt` });

    await interaction.channel.send({
      content: `*(test data)* ${rows.length} synthetic rounds. Full data attached.`,
      files: [attachment],
    }).catch(err => {
      console.error('[testrawdata] send failed:', err.message);
    });

    return interaction.editReply('Posted test raw data table above.');
  },
};