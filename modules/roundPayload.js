// Validation and normalisation of a POST /api/round-complete payload.
//
// Pure: no I/O, no clock unless `now` is not passed. Everything is checked
// BEFORE anything is queued, so a bad payload is answered with a bounded 400
// and nothing is half-written. Accepts both shapes the game sends:
//   flat:         { Round_Map, Round_Result, ..., time?, placeId? }
//   Logger.Send:  { level, placeId, time, data: { Round_Map, ... } }
//
// Round-level problems reject the round. Problems inside a single player entry
// never do: that entry is skipped (or the one field nulled) and counted, because
// the round log is the record of value and player rows are secondary.
//
// Issue messages name fields only and never repeat sent values, so they are
// safe to return to the caller and to post to Discord.

const MIN_PLAYED_AT_MS = Date.UTC(2020, 0, 1);
const MAX_FUTURE_MS    = 24 * 60 * 60 * 1000;
const MAX_STR          = 200;
const MAX_LIST         = 200;
const MAX_PLAYERS      = 500;
const MAX_ISSUES       = 5;
const INT4_MAX         = 2147483647;
const NUM_ABS_MAX      = 1e12;

const BAD = Symbol('invalid');

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// The game's JSON encoder cannot write NaN, so it sends {"m":null,"t":"numeric","v":"nan"}.
// A finite value becomes a number; nan/inf become null.
function unwrapNum(v) {
  if (v !== null && typeof v === 'object' && !Array.isArray(v) && v.t === 'numeric') {
    const n = (typeof v.v === 'number' || (typeof v.v === 'string' && v.v.trim() !== '')) ? Number(v.v) : NaN;
    return Number.isFinite(n) ? n : null;
  }
  return v;
}

// -> number | null | BAD.  null/undefined/''/NaN are "no value"; anything that is
// not a number or a numeric string is BAD.
function toNumber(raw, { int = false } = {}) {
  const v = unwrapNum(raw);
  if (v === null || v === undefined) return null;
  let n;
  if (typeof v === 'number') n = v;
  else if (typeof v === 'string') {
    if (v.trim() === '') return null;
    n = Number(v);
  } else return BAD;
  if (Number.isNaN(n)) return typeof v === 'number' ? null : BAD;
  if (!Number.isFinite(n) || Math.abs(n) > NUM_ABS_MAX) return BAD;
  if (int && (!Number.isInteger(n) || Math.abs(n) > INT4_MAX)) return BAD;
  return n;
}

// -> string | null | BAD
function toText(v) {
  if (v === null || v === undefined) return null;
  if (typeof v !== 'string' || v.length > MAX_STR) return BAD;
  return v;
}

// -> string[] | BAD.  Elements must be strings (numbers are stringified).
function toTextList(arr) {
  if (arr.length > MAX_LIST) return BAD;
  const out = [];
  for (const el of arr) {
    if (typeof el === 'number' && Number.isFinite(el)) out.push(String(el));
    else if (typeof el === 'string' && el.length <= MAX_STR) out.push(el);
    else return BAD;
  }
  return out;
}

function normalizeRound(reqBody, { now = Date.now() } = {}) {
  const issues = [];
  const add = (msg) => { if (issues.length < MAX_ISSUES) issues.push(msg); };

  if (!isPlainObject(reqBody)) return { ok: false, issues: ['body must be a JSON object'] };

  const body = reqBody.data ?? reqBody;
  if (!isPlainObject(body)) return { ok: false, issues: ['data must be an object'] };

  const {
    Round_Result, Round_AverageLevel, Round_NumberOfPlayers, Round_Game_Mode,
    Round_Map, Round_AtmosphereType, Round_DinoPlayerAverageLevel,
    Round_NumPlayers_WithMedkits, Round_NumPlayers_WithToolkits, Round_NumPlayers_WithFuelcans,
    Round_NumPlayers_WithDinoTrackers, Round_NumPlayers_WithMines, Round_NumPlayers_WithGamepassWeapons,
    Round_DinosaursUsed, Round_VehiclesUsed, Round_WeaponsUsed,
    Round_MVP_EquippedVehicle, Round_MVP_EquippedWeapon, Round_MVP_Damage,
    Round_Players,
  } = body;

  // ── Required ────────────────────────────────────────────────────────────────
  const requiredText = (v, name) => {
    const t = toText(v);
    if (t === BAD || t === null || t.trim() === '') { add(`${name} is required and must be a short string`); return null; }
    return t;
  };
  const map    = requiredText(Round_Map, 'Round_Map');
  const result = requiredText(Round_Result, 'Round_Result');

  // ── Time (seconds since 1970). Absent/0 means "now", as before. ─────────────
  let playedAt = new Date(now).toISOString();
  const rawTime = reqBody.time;
  if (rawTime !== undefined && rawTime !== null && rawTime !== 0 && rawTime !== '') {
    const secs = toNumber(rawTime);
    const ms = secs === BAD || secs === null ? NaN : secs * 1000;
    if (!Number.isFinite(ms) || ms < MIN_PLAYED_AT_MS || ms > now + MAX_FUTURE_MS || Number.isNaN(new Date(ms).getTime())) {
      add('time must be seconds since 1970 (a plausible, current date)');
    } else {
      playedAt = new Date(ms).toISOString();
    }
  }

  // ── Place ───────────────────────────────────────────────────────────────────
  let placeId = null;
  if (reqBody.placeId !== undefined && reqBody.placeId !== null) {
    const p = toNumber(reqBody.placeId, {});
    if (p === BAD || p === null || !Number.isSafeInteger(p) || p < 0) add('placeId must be a non-negative integer');
    else placeId = p;
  }

  // ── Optional scalars ────────────────────────────────────────────────────────
  const num = (v, name, int) => {
    const n = toNumber(v, { int });
    if (n === BAD) { add(`${name} must be ${int ? 'an integer' : 'a number'}`); return null; }
    return n;
  };
  const text = (v, name) => {
    const t = toText(v);
    if (t === BAD) { add(`${name} must be a short string`); return null; }
    return t;
  };
  const count = (v, name) => { const n = num(v, name, true); return n === null ? 0 : n; };

  const roundRow = {
    played_at:    playedAt,
    place_id:     placeId,
    round_result: (result === 'HumanEscape' || result === 'HumanWin') ? 'SurvivorWin' : result,
    average_level:             num(Round_AverageLevel, 'Round_AverageLevel', false),
    number_of_players:         num(Round_NumberOfPlayers, 'Round_NumberOfPlayers', true),
    game_mode:                 text(Round_Game_Mode, 'Round_Game_Mode'),
    map,
    atmosphere_type:           text(Round_AtmosphereType, 'Round_AtmosphereType'),
    dino_player_average_level: num(Round_DinoPlayerAverageLevel, 'Round_DinoPlayerAverageLevel', false),
    num_players_with_medkits:      count(Round_NumPlayers_WithMedkits, 'Round_NumPlayers_WithMedkits'),
    num_players_with_toolkits:     count(Round_NumPlayers_WithToolkits, 'Round_NumPlayers_WithToolkits'),
    num_players_with_fuelcans:     count(Round_NumPlayers_WithFuelcans, 'Round_NumPlayers_WithFuelcans'),
    num_players_with_dinotrackers: count(Round_NumPlayers_WithDinoTrackers, 'Round_NumPlayers_WithDinoTrackers'),
    num_players_with_mines:        count(Round_NumPlayers_WithMines, 'Round_NumPlayers_WithMines'),
    num_players_with_gamepass_weapons: count(Round_NumPlayers_WithGamepassWeapons, 'Round_NumPlayers_WithGamepassWeapons'),
    dinosaurs_used: null,
    vehicles_used:  null,
    weapons_used:   null,
    mvp_equipped_vehicle: text(Round_MVP_EquippedVehicle, 'Round_MVP_EquippedVehicle'),
    mvp_equipped_weapon:  text(Round_MVP_EquippedWeapon, 'Round_MVP_EquippedWeapon'),
    mvp_damage:           num(Round_MVP_Damage, 'Round_MVP_Damage', false),
  };

  // ── Lists (a missing or non-array value is simply "none", as before) ────────
  const list = (v, name) => {
    if (!Array.isArray(v)) return null;
    const l = toTextList(v);
    if (l === BAD) { add(`${name} must be a short list of strings`); return null; }
    return l;
  };
  if (Array.isArray(Round_DinosaursUsed)) roundRow.dinosaurs_used = list(Round_DinosaursUsed, 'Round_DinosaursUsed');
  else if (Round_DinosaursUsed) {
    const one = toText(Round_DinosaursUsed);
    if (one === BAD) add('Round_DinosaursUsed must be a short list of strings');
    else roundRow.dinosaurs_used = [one];
  }
  roundRow.vehicles_used = list(Round_VehiclesUsed, 'Round_VehiclesUsed');
  roundRow.weapons_used  = list(Round_WeaponsUsed, 'Round_WeaponsUsed');

  // ── Players ─────────────────────────────────────────────────────────────────
  const playerRows = [];
  let skippedPlayers = 0;
  if (Array.isArray(Round_Players)) {
    if (Round_Players.length > MAX_PLAYERS) {
      add(`Round_Players has more than ${MAX_PLAYERS} entries`);
    } else {
      for (const p of Round_Players) {
        if (!isPlainObject(p)) { skippedPlayers++; continue; }
        const rawId = p.UserId ?? p.RobloxUserId;
        const id = (typeof rawId === 'number' && Number.isSafeInteger(rawId) && rawId > 0) ? String(rawId)
          : (typeof rawId === 'string' && /^\d{1,20}$/.test(rawId)) ? rawId
          : null;
        if (!id) { skippedPlayers++; continue; }
        const dur = toNumber(p.DurationSeconds);
        const resp = toNumber(p.RespawnCount, { int: true });
        const str = (v) => { const t = toText(v); return t === BAD ? null : t; };
        playerRows.push({
          roblox_user_id:   id,
          platform:         str(p.Platform),
          touch_enabled:    typeof p.TouchEnabled === 'boolean' ? p.TouchEnabled : null,
          preferred_input:  str(p.PreferredInput),
          duration_seconds: dur === BAD ? null : dur,
          role:             str(p.Role),
          respawn_count:    resp === BAD ? null : resp,
        });
      }
    }
  }

  if (issues.length) return { ok: false, issues };
  return { ok: true, roundRow, playerRows, skippedPlayers };
}

module.exports = { normalizeRound, MAX_PLAYERS, MAX_ISSUES, MIN_PLAYED_AT_MS };
