// /api/round-complete validation and Express 4 async error handling.
// Run: node tests/roundPayload.test.js
const assert = require('assert');
const http = require('http');
const express = require('express');
const { normalizeRound, MAX_PLAYERS, MAX_ISSUES } = require('../modules/roundPayload');
const { asyncRoute, httpErrorHandler } = require('../modules/httpErrors');

const NOW = Date.UTC(2026, 10, 8, 12, 0, 0);
const T = Math.floor(NOW / 1000) - 60;
const base = () => ({ Round_Map: 'Jungle', Round_Result: 'SurvivorWin' });

let passed = 0;
const test = async (name, fn) => {
  try { await fn(); passed++; console.log('  ok  ', name); }
  catch (e) { console.error('  FAIL', name, '\n', e); process.exitCode = 1; }
};
const ok = (body) => { const r = normalizeRound(body, { now: NOW }); assert.ok(r.ok, JSON.stringify(r.issues)); return r; };
const bad = (body, re) => {
  const r = normalizeRound(body, { now: NOW });
  assert.strictEqual(r.ok, false, 'should be rejected');
  if (re) assert.ok(r.issues.some((i) => re.test(i)), `issues: ${r.issues.join(' | ')}`);
  return r;
};

(async () => {
  // ── Both accepted shapes ──
  await test('flat payload', () => {
    const r = ok({ ...base(), time: T, placeId: 12076775711, Round_AverageLevel: 12.5, Round_NumberOfPlayers: 9 });
    assert.strictEqual(r.roundRow.map, 'Jungle');
    assert.strictEqual(r.roundRow.played_at, new Date(T * 1000).toISOString());
    assert.strictEqual(r.roundRow.place_id, 12076775711);
    assert.strictEqual(r.roundRow.number_of_players, 9);
  });
  await test('Logger.Send envelope gives the same round row', () => {
    const flat = ok({ ...base(), time: T, placeId: 1, Round_NumberOfPlayers: 9 });
    const env  = ok({ level: 'info', placeId: 1, time: T, data: { ...base(), Round_NumberOfPlayers: 9 } });
    assert.deepStrictEqual(env.roundRow, flat.roundRow);
  });
  await test('HumanEscape / HumanWin normalise to SurvivorWin', () => {
    assert.strictEqual(ok({ ...base(), Round_Result: 'HumanEscape' }).roundRow.round_result, 'SurvivorWin');
    assert.strictEqual(ok({ ...base(), Round_Result: 'HumanWin' }).roundRow.round_result, 'SurvivorWin');
  });
  await test('missing time or 0 means now; missing optional fields keep old defaults', () => {
    const r = ok(base());
    assert.strictEqual(r.roundRow.played_at, new Date(NOW).toISOString());
    assert.strictEqual(ok({ ...base(), time: 0 }).roundRow.played_at, new Date(NOW).toISOString());
    assert.strictEqual(r.roundRow.num_players_with_medkits, 0);
    assert.strictEqual(r.roundRow.average_level, null);
    assert.strictEqual(r.roundRow.dinosaurs_used, null);
    assert.deepStrictEqual(r.playerRows, []);
  });

  // ── Whole-body problems ──
  await test('non-object bodies are rejected, not thrown on', () => {
    for (const b of [null, undefined, 'x', 5, [], [{}]]) bad(b, /JSON object/);
    bad({ data: 'x' }, /data must be an object/);
    bad({ data: [] }, /data must be an object/);
  });

  // ── Required fields ──
  await test('required fields must be non-empty short strings', () => {
    bad({ Round_Result: 'SurvivorWin' }, /Round_Map/);
    bad({ Round_Map: 'Jungle' }, /Round_Result/);
    bad({ Round_Map: 5, Round_Result: 'x' }, /Round_Map/);
    bad({ Round_Map: '  ', Round_Result: 'x' }, /Round_Map/);
    bad({ Round_Map: 'x'.repeat(201), Round_Result: 'x' }, /Round_Map/);
    bad({ Round_Map: { a: 1 }, Round_Result: 'x' }, /Round_Map/);
  });

  // ── Time ──
  await test('non-numeric, NaN-ish and out-of-range time is a 400, not a RangeError', () => {
    for (const t of ['abc', {}, [], true, 1e18, -5, 1e12 /* milliseconds by mistake */, T + 3 * 86400]) bad({ ...base(), time: t }, /time/);
    assert.doesNotThrow(() => normalizeRound({ ...base(), time: 'abc' }, { now: NOW }));
  });
  await test('numeric-string time is still accepted (as before)', () => {
    assert.strictEqual(ok({ ...base(), time: String(T) }).roundRow.played_at, new Date(T * 1000).toISOString());
  });

  // ── Numbers ──
  await test('game NaN wrapper becomes null; finite wrapper becomes a number', () => {
    const r = ok({ ...base(), Round_AverageLevel: { m: null, t: 'numeric', v: 'nan' }, Round_MVP_Damage: { t: 'numeric', v: '250.5' } });
    assert.strictEqual(r.roundRow.average_level, null);
    assert.strictEqual(r.roundRow.mvp_damage, 250.5);
  });
  await test('bad numbers are rejected up front (they would fail the whole insert)', () => {
    bad({ ...base(), Round_AverageLevel: 'high' }, /Round_AverageLevel/);
    bad({ ...base(), Round_NumberOfPlayers: 11.5 }, /Round_NumberOfPlayers/);
    bad({ ...base(), Round_NumPlayers_WithMines: 3e9 }, /Round_NumPlayers_WithMines/);
    bad({ ...base(), Round_MVP_Damage: {} }, /Round_MVP_Damage/);
    bad({ ...base(), placeId: 'abc' }, /placeId/);
    bad({ ...base(), placeId: -1 }, /placeId/);
  });

  // ── Lists ──
  await test('arrays: missing is null; bad elements and oversize are rejected', () => {
    assert.deepStrictEqual(ok({ ...base(), Round_DinosaursUsed: ['Rex', 'Raptor'] }).roundRow.dinosaurs_used, ['Rex', 'Raptor']);
    assert.deepStrictEqual(ok({ ...base(), Round_DinosaursUsed: 'Rex' }).roundRow.dinosaurs_used, ['Rex']);
    assert.strictEqual(ok({ ...base(), Round_VehiclesUsed: 'nope' }).roundRow.vehicles_used, null);
    bad({ ...base(), Round_WeaponsUsed: [{ a: 1 }] }, /Round_WeaponsUsed/);
    bad({ ...base(), Round_WeaponsUsed: new Array(201).fill('x') }, /Round_WeaponsUsed/);
  });

  // ── Players ──
  await test('null / junk player entries are skipped, the round is kept, and nothing throws', () => {
    const r = ok({ ...base(), Round_Players: [null, 5, 'x', [], { UserId: 111, Platform: 'PC', Role: 'Survivor', DurationSeconds: 90, RespawnCount: 1, TouchEnabled: false }, { UserId: {} }, {}, { UserId: 'abc' }, { RobloxUserId: '222' }] });
    assert.deepStrictEqual(r.playerRows.map((p) => p.roblox_user_id), ['111', '222']);
    assert.strictEqual(r.skippedPlayers, 7);
    assert.strictEqual(r.playerRows[0].duration_seconds, 90);
    assert.strictEqual(r.playerRows[0].touch_enabled, false);
  });
  await test('bad fields inside a player become null, the player stays', () => {
    const r = ok({ ...base(), Round_Players: [{ UserId: 7, DurationSeconds: 'long', RespawnCount: 1.5, Platform: { x: 1 } }] });
    assert.deepStrictEqual(r.playerRows[0], { roblox_user_id: '7', platform: null, touch_enabled: null, preferred_input: null, duration_seconds: null, role: null, respawn_count: null });
  });
  await test('Round_Players missing, null or not an array means no players', () => {
    for (const v of [undefined, null, 'x', 5, {}]) assert.deepStrictEqual(ok({ ...base(), Round_Players: v }).playerRows, []);
  });
  await test('too many players is rejected as a whole', () => {
    bad({ ...base(), Round_Players: new Array(MAX_PLAYERS + 1).fill({ UserId: 1 }) }, /Round_Players/);
  });

  // ── Bounded, value-free issues ──
  await test('issues are capped and never repeat sent values', () => {
    const secret = 'SECRET-VALUE-XYZ';
    const r = bad({
      Round_Map: 5, Round_Result: 5, time: secret, placeId: secret, Round_AverageLevel: secret, Round_NumberOfPlayers: secret,
      Round_Game_Mode: 7, Round_AtmosphereType: 7, Round_MVP_Damage: secret,
    });
    assert.ok(r.issues.length <= MAX_ISSUES);
    assert.ok(!JSON.stringify(r.issues).includes(secret));
  });

  // ── No partial queueing: a rejected body never reaches the queue ──
  await test('a rejected payload yields no rows at all', () => {
    const r = bad({ ...base(), time: 'abc', Round_Players: [{ UserId: 1 }] });
    assert.strictEqual(r.roundRow, undefined);
    assert.strictEqual(r.playerRows, undefined);
  });

  // ── Express 4 async errors ──
  await test('a rejected async handler reaches the error middleware (HTTP)', async () => {
    const app = express();
    app.use(express.json({ limit: '1kb' }));
    app.post('/boom', asyncRoute(async () => { throw new Error('secret internal detail'); }));
    app.post('/ok', asyncRoute(async (req, res) => res.json({ got: normalizeRound(req.body).ok })));
    app.use(httpErrorHandler);
    const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
    const url = (p) => `http://127.0.0.1:${server.address().port}${p}`;
    const post = (p, body, raw) => fetch(url(p), { method: 'POST', headers: { 'content-type': 'application/json' }, body: raw ?? JSON.stringify(body) });
    const rejections = [];
    const onRej = (e) => rejections.push(e);
    process.on('unhandledRejection', onRej);
    try {
      const a = await post('/boom', {});
      assert.strictEqual(a.status, 500);
      const at = await a.text();
      assert.deepStrictEqual(JSON.parse(at), { error: 'Internal error' });
      assert.ok(!at.includes('secret internal detail'));

      const b = await post('/ok', null, '{not json');
      assert.strictEqual(b.status, 400);
      assert.deepStrictEqual(await b.json(), { error: 'Body is not valid JSON' });

      const c = await post('/ok', null, JSON.stringify({ pad: 'x'.repeat(5000) }));
      assert.strictEqual(c.status, 413);

      const d = await post('/ok', base());
      assert.deepStrictEqual(await d.json(), { got: true });
      await new Promise((r) => setTimeout(r, 30));
      assert.deepStrictEqual(rejections, [], 'no unhandled rejection');
    } finally {
      process.off('unhandledRejection', onRej);
      server.close();
    }
  });

  console.log(`\n${passed} roundPayload tests passed`);
})();
