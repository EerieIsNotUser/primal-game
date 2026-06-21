// ─── Raw Data Digest ─────────────────────────────────────────────────────
// Replaces the curated MVP-tier/emoji embeds with a full raw data dump:
// every round from the period, every column, as an aligned plain-text
// table attachment. Discord message itself stays minimal — no emoji
// decoration, just a short summary line plus the file.
//
// Posts weekly to REPORT_CHANNEL_ID, also pullable on demand via
// /rawdata [days].

const { AttachmentBuilder } = require('discord.js');

const REPORT_CHANNEL_ID = '1515751121560272987';
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const POST_ID = 'raw-data-weekly';

const COLUMNS = [
  { key: 'played_at',                         label: 'Played At',     width: 20 },
  { key: 'map',                                label: 'Map',           width: 14 },
  { key: 'round_result',                       label: 'Result',        width: 14 },
  { key: 'game_mode',                          label: 'Mode',          width: 10 },
  { key: 'atmosphere_type',                    label: 'Atmosphere',    width: 12 },
  { key: 'number_of_players',                  label: 'Players',       width: 8  },
  { key: 'average_level',                      label: 'AvgLvl',        width: 8  },
  { key: 'dino_player_average_level',          label: 'DinoAvgLvl',    width: 11 },
  { key: 'num_players_with_medkits',           label: 'Medkits',       width: 8  },
  { key: 'num_players_with_toolkits',          label: 'Toolkits',      width: 9  },
  { key: 'num_players_with_fuelcans',          label: 'Fuelcans',      width: 9  },
  { key: 'num_players_with_dinotrackers',      label: 'Trackers',      width: 9  },
  { key: 'num_players_with_mines',             label: 'Mines',         width: 6  },
  { key: 'num_players_with_gamepass_weapons',  label: 'GPWeapons',     width: 10 },
  { key: 'mvp_equipped_vehicle',                label: 'MVP Vehicle',   width: 14 },
  { key: 'mvp_equipped_weapon',                 label: 'MVP Weapon',    width: 14 },
  { key: 'mvp_damage',                          label: 'MVP Dmg',       width: 9  },
];

function formatCell(value, width) {
  let str = value === null || value === undefined ? '-' : String(value);
  if (str.length > width) str = str.slice(0, width - 1) + '…';
  return str.padEnd(width);
}

function formatTimestamp(ts) {
  const d = new Date(ts);
  return d.toISOString().replace('T', ' ').slice(0, 19);
}

function buildRawTable(rows) {
  const header = COLUMNS.map(c => formatCell(c.label, c.width)).join(' | ');
  const separator = COLUMNS.map(c => '-'.repeat(c.width)).join('-+-');

  const lines = rows.map(row => {
    return COLUMNS.map(c => {
      const val = c.key === 'played_at' ? formatTimestamp(row[c.key]) : row[c.key];
      return formatCell(val, c.width);
    }).join(' | ');
  });

  return [header, separator, ...lines].join('\n');
}

async function getRows(supabase, sinceMs) {
  const cutoff = new Date(Date.now() - sinceMs);
  const { data, error } = await supabase
    .from('round_logs')
    .select(COLUMNS.map(c => c.key).join(','))
    .gte('played_at', cutoff.toISOString())
    .order('played_at', { ascending: true });

  if (error || !data) return null;
  return data;
}

async function postRawData(channel, supabase, periodMs, periodLabel) {
  const rows = await getRows(supabase, periodMs);
  if (rows === null) {
    console.error('[raw-data] Failed to fetch round data.');
    await channel.send('Failed to fetch round data — check logs.').catch(() => {});
    return false;
  }

  if (rows.length === 0) {
    await channel.send(`No rounds logged in the past ${periodLabel}.`).catch(() => {});
    return true;
  }

  const table = buildRawTable(rows);
  const buffer = Buffer.from(table, 'utf8');
  const attachment = new AttachmentBuilder(buffer, { name: `round-data-${Date.now()}.txt` });

  const summary = `${rows.length} rounds logged in the past ${periodLabel}. Full data attached.`;

  await channel.send({ content: summary, files: [attachment] }).catch(err =>
    console.error('[raw-data] Failed to post:', err.message)
  );

  return true;
}

function setup(client, { supabase }) {
  if (!supabase) {
    console.log('[raw-data] Skipping setup — supabase not configured.');
    return;
  }

  async function scheduledPost() {
    const channel = client.channels.cache.get(REPORT_CHANNEL_ID)
      ?? await client.channels.fetch(REPORT_CHANNEL_ID).catch(() => null);

    if (!channel) {
      console.error('[raw-data] Could not find report channel', REPORT_CHANNEL_ID);
      return;
    }

    await postRawData(channel, supabase, WEEK_MS, 'week');

    await supabase
      .from('scheduled_posts')
      .upsert({ id: POST_ID, last_posted_at: new Date().toISOString() });

    console.log('[raw-data] Posted weekly raw data dump.');
  }

  async function scheduleNext() {
    const { data } = await supabase
      .from('scheduled_posts')
      .select('last_posted_at')
      .eq('id', POST_ID)
      .maybeSingle();

    const lastPosted = data?.last_posted_at ? new Date(data.last_posted_at).getTime() : 0;
    const elapsed = Date.now() - lastPosted;

    if (elapsed >= WEEK_MS) {
      await scheduledPost();
      setTimeout(scheduleNext, WEEK_MS);
    } else {
      const remaining = WEEK_MS - elapsed;
      setTimeout(async () => {
        await scheduledPost();
        setTimeout(scheduleNext, WEEK_MS);
      }, remaining);
      console.log(`[raw-data] Next post in ${Math.round(remaining / (60 * 60 * 1000))}h.`);
    }
  }

  scheduleNext();
}

module.exports = setup;
module.exports.postRawData = postRawData;
module.exports.getRows = getRows;
module.exports.buildRawTable = buildRawTable;