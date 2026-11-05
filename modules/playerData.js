// ─── player_data payload normaliser ───────────────────────────────────────────
// The game sends per-player stats (for example a player leaving, with their play
// time) as their own payload, separate from the round payload. KKG has not fixed
// the final shape yet, so this accepts the shapes that are likely and keeps
// anything it does not recognise instead of throwing it away.
//
// Accepted bodies (all of these work):
//   { UserId, PlayTimeSeconds, ... }                         one player
//   { Players: [ {...}, {...} ] }                            several players
//   [ {...}, {...} ]                                         bare array
//   { level, data: <any of the above>, placeId, time }       Logger.Send wrapper
//
// Field names are matched ignoring case, underscores and dashes, so UserId,
// userId, user_id and USERID are all the same field. See PLAYER_DATA.md for the
// names this knows. Unknown fields are stored in the `extra` column.
//
// Pure functions, no I/O: this file is covered by tests/playerData.test.js.

const MAX_PLAYERS_PER_REQUEST = 200;
const MAX_EXTRA_BYTES         = 8 * 1024;

const canon = (k) => String(k).toLowerCase().replace(/[^a-z0-9]/g, '');

// canonical key -> column. Every alias a sender might reasonably use.
const FIELD_ALIASES = {
  robloxuserid: 'roblox_user_id', userid: 'roblox_user_id', playerid: 'roblox_user_id', robloxid: 'roblox_user_id',
  event: 'event', eventtype: 'event', action: 'event',
  sessionid: 'session_id', sessionkey: 'session_id',
  playtimeseconds: 'play_time_seconds', playtime: 'play_time_seconds', durationseconds: 'play_time_seconds', duration: 'play_time_seconds',
  platform: 'platform',
  touchenabled: 'touch_enabled',
  preferredinput: 'preferred_input',
  placeid: 'place_id',
  occurredat: 'occurred_at', timestamp: 'occurred_at', time: 'occurred_at', leftat: 'occurred_at',
};

// The game's JSON encoder cannot write NaN, so it sends {"t":"numeric","v":"nan"}
// instead. Same unwrap as /api/round-complete.
function unwrapNum(v) {
  if (v !== null && typeof v === 'object' && v.t === 'numeric') {
    const n = (typeof v.v === 'number' || (typeof v.v === 'string' && v.v.trim() !== '')) ? Number(v.v) : NaN;
    return Number.isFinite(n) ? n : null;
  }
  return v;
}

function toNumber(v) {
  v = unwrapNum(v);
  if (typeof v === 'string' && v.trim() !== '') v = Number(v);
  return (typeof v === 'number' && Number.isFinite(v)) ? v : null;
}

function toText(v, max = 40) {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  return s ? s.slice(0, max) : null;
}

function toBool(v) {
  if (typeof v === 'boolean') return v;
  if (v === 'true' || v === 1) return true;
  if (v === 'false' || v === 0) return false;
  return null;
}

// Roblox user ids are positive integers. Keep them as text (they can outgrow a
// safe JS integer if a sender passes a number, so prefer strings from the game).
function toUserId(v) {
  v = unwrapNum(v);
  if (typeof v === 'number') {
    if (!Number.isSafeInteger(v) || v <= 0) return null;
    return String(v);
  }
  if (typeof v === 'string' && /^[0-9]{1,20}$/.test(v.trim())) {
    const s = v.trim().replace(/^0+(?=\d)/, '');
    return s === '0' ? null : s;
  }
  return null;
}

function toPlaceId(v) {
  const n = toNumber(v);
  return (n != null && Number.isSafeInteger(n) && n > 0) ? n : null;
}

// Unix seconds (what the round payload's `time` uses), unix milliseconds, or an ISO string.
function toTimestamp(v) {
  v = unwrapNum(v);
  let ms = null;
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) ms = v > 1e12 ? v : v * 1000;
  else if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    ms = Number.isFinite(n) && n > 0 ? (n > 1e12 ? n : n * 1000) : Date.parse(v);
  }
  if (ms == null || !Number.isFinite(ms)) return null;
  const d = new Date(ms);
  // Reject nonsense (before the game existed, or more than a day in the future).
  if (d.getUTCFullYear() < 2020 || ms > Date.now() + 24 * 3600 * 1000) return null;
  return d.toISOString();
}

// JSON-safe copy of an unknown value: wrappers unwrapped, depth and size limited.
function cleanExtraValue(v, depth = 0) {
  v = unwrapNum(v);
  if (v === null || typeof v === 'string' || typeof v === 'boolean') return v;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (depth >= 4) return null;
  if (Array.isArray(v)) return v.slice(0, 100).map((x) => cleanExtraValue(x, depth + 1));
  if (typeof v === 'object') {
    const out = {};
    for (const [k, x] of Object.entries(v).slice(0, 100)) out[k] = cleanExtraValue(x, depth + 1);
    return out;
  }
  return null; // functions, undefined, symbols
}

function normalizePlayer(p, meta) {
  if (p === null || typeof p !== 'object' || Array.isArray(p)) return { error: 'entry is not an object' };

  const known = {};
  const extra = {};
  for (const [key, value] of Object.entries(p)) {
    const col = FIELD_ALIASES[canon(key)];
    // first alias wins when a sender sends two spellings of the same field
    if (col && !(col in known)) known[col] = value;
    else if (!col) extra[key] = value;
  }

  const userId = toUserId(known.roblox_user_id);
  if (!userId) return { error: 'missing or invalid UserId (needs a positive whole number)' };

  const playTime = toNumber(known.play_time_seconds);

  const row = {
    roblox_user_id:    userId,
    event:             (toText(known.event, 40) ?? 'unspecified').toLowerCase(),
    session_id:        toText(known.session_id, 100),
    place_id:          toPlaceId(known.place_id) ?? meta.placeId,
    occurred_at:       toTimestamp(known.occurred_at) ?? meta.occurredAt,
    play_time_seconds: playTime != null && playTime >= 0 ? playTime : null,
    platform:          toText(known.platform),
    touch_enabled:     toBool(known.touch_enabled),
    preferred_input:   toText(known.preferred_input),
    extra:             {},
  };

  // Something sent but unusable (a negative play time, say) is kept rather than lost.
  if (known.play_time_seconds != null && row.play_time_seconds == null) extra._invalid_play_time = cleanExtraValue(known.play_time_seconds);

  let cleaned = cleanExtraValue(extra);
  if (Buffer.byteLength(JSON.stringify(cleaned)) > MAX_EXTRA_BYTES) {
    cleaned = { _truncated: true, _keys: Object.keys(extra).slice(0, 50) };
  }
  row.extra = cleaned;
  return { row };
}

// -> { rows, rejected: [{ index, reason }], error? }
// `error` is set when the whole request is unusable (not an object, no players, too many).
function normalizePayload(body) {
  if (body === null || typeof body !== 'object') return { rows: [], rejected: [], error: 'body must be a JSON object or array' };

  const root = (!Array.isArray(body) && body.data !== null && typeof body.data === 'object') ? body.data : body;

  let list;
  if (Array.isArray(root)) list = root;
  else {
    const named = Object.entries(root).find(([k, v]) => Array.isArray(v) && ['players', 'playerdata', 'data'].includes(canon(k)));
    list = named ? named[1] : [root];
  }

  if (list.length === 0) return { rows: [], rejected: [], error: 'no players in payload' };
  if (list.length > MAX_PLAYERS_PER_REQUEST) return { rows: [], rejected: [], error: `too many players in one request (max ${MAX_PLAYERS_PER_REQUEST})` };

  // Request-level context, taken from the outer body first and then the inner one.
  const outerKeys = Object.fromEntries(Object.entries(body).map(([k, v]) => [canon(k), v]));
  const innerKeys = (root !== body && !Array.isArray(root)) ? Object.fromEntries(Object.entries(root).map(([k, v]) => [canon(k), v])) : {};
  const meta = {
    placeId:    toPlaceId(outerKeys.placeid ?? innerKeys.placeid),
    occurredAt: toTimestamp(outerKeys.time ?? innerKeys.time ?? outerKeys.timestamp ?? innerKeys.timestamp),
  };

  const rows = [];
  const rejected = [];
  list.forEach((p, index) => {
    const res = normalizePlayer(p, meta);
    if (res.row) rows.push(res.row);
    else rejected.push({ index, reason: res.error });
  });
  return { rows, rejected };
}

module.exports = { normalizePayload, normalizePlayer, MAX_PLAYERS_PER_REQUEST, FIELD_ALIASES };
