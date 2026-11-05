// Plain node assert script: node tests/playerData.test.js
const assert = require('assert');
const { normalizePayload, MAX_PLAYERS_PER_REQUEST } = require('../modules/playerData');
const queueMod = require('../modules/playerDataQueue');

let passed = 0;
const test = async (name, fn) => { await fn(); passed += 1; console.log('ok  -', name); };

(async () => {
  // ── normaliser ────────────────────────────────────────────────────────────
  await test('single player, PascalCase names from the planned payload', () => {
    const { rows, rejected } = normalizePayload({
      UserId: 12345, Platform: 'Mobile', TouchEnabled: true, PreferredInput: 'Touch',
      PlayTimeSeconds: 912.5, Event: 'Leave', SessionId: 'abc-1',
    });
    assert.strictEqual(rejected.length, 0);
    assert.deepStrictEqual(rows[0], {
      roblox_user_id: '12345', event: 'leave', session_id: 'abc-1', place_id: null, occurred_at: null,
      play_time_seconds: 912.5, platform: 'Mobile', touch_enabled: true, preferred_input: 'Touch', extra: {},
    });
  });

  await test('field names ignore case, underscores and dashes', () => {
    const { rows } = normalizePayload({ user_id: '777', play_time_seconds: 10, PREFERRED_INPUT: 'Gamepad', 'touch-enabled': false });
    assert.strictEqual(rows[0].roblox_user_id, '777');
    assert.strictEqual(rows[0].play_time_seconds, 10);
    assert.strictEqual(rows[0].preferred_input, 'Gamepad');
    assert.strictEqual(rows[0].touch_enabled, false);
  });

  await test('Logger.Send wrapper: placeId and time come from the outer body', () => {
    const t = Math.floor(Date.now() / 1000) - 60;
    const { rows } = normalizePayload({ level: 'info', placeId: 98765, time: t, data: { UserId: 5, DurationSeconds: 30 } });
    assert.strictEqual(rows[0].place_id, 98765);
    assert.strictEqual(rows[0].occurred_at, new Date(t * 1000).toISOString());
    assert.strictEqual(rows[0].play_time_seconds, 30);
  });

  await test('several players under Players, in a bare array, and under the wrapper', () => {
    const a = normalizePayload({ Players: [{ UserId: 1 }, { UserId: 2 }] });
    const b = normalizePayload([{ UserId: 1 }, { UserId: 2 }, { UserId: 3 }]);
    const c = normalizePayload({ data: { players: [{ UserId: 9 }] }, placeId: 1 });
    assert.deepStrictEqual([a.rows.length, b.rows.length, c.rows.length], [2, 3, 1]);
    assert.strictEqual(c.rows[0].place_id, 1);
  });

  await test('unknown fields are kept in extra, wrappers unwrapped, junk dropped', () => {
    const { rows } = normalizePayload({
      UserId: 4, Kills: 7, Deaths: { t: 'numeric', v: 'nan' }, Loadout: { weapon: 'AK', slots: [1, 2] },
      Ratio: { t: 'numeric', v: '1.5' }, Nothing: null,
    });
    assert.deepStrictEqual(rows[0].extra, { Kills: 7, Deaths: null, Loadout: { weapon: 'AK', slots: [1, 2] }, Ratio: 1.5, Nothing: null });
  });

  await test('oversized extra is replaced by a marker instead of being stored', () => {
    const { rows } = normalizePayload({ UserId: 4, Blob: 'x'.repeat(20000), Small: 1 });
    assert.strictEqual(rows[0].extra._truncated, true);
    assert.deepStrictEqual(rows[0].extra._keys.sort(), ['Blob', 'Small']);
  });

  await test('bad values become null, never reach the database as errors', () => {
    const { rows } = normalizePayload({ UserId: 4, PlayTimeSeconds: -5, TouchEnabled: 'maybe', Platform: 7, Time: 12 });
    assert.strictEqual(rows[0].play_time_seconds, null);
    assert.strictEqual(rows[0].touch_enabled, null);
    assert.strictEqual(rows[0].platform, null);
    assert.strictEqual(rows[0].occurred_at, null); // 1970: not a real time
    assert.strictEqual(rows[0].extra._invalid_play_time, -5);
  });

  await test('NaN wrapper in play time becomes null', () => {
    const { rows } = normalizePayload({ UserId: 4, PlayTimeSeconds: { m: null, t: 'numeric', v: 'nan' } });
    assert.strictEqual(rows[0].play_time_seconds, null);
  });

  await test('user ids: strings and numbers accepted, junk rejected per entry', () => {
    const { rows, rejected } = normalizePayload({ Players: [
      { UserId: '000123' }, { UserId: 55 }, { UserId: 'abc' }, { UserId: -1 }, { UserId: 0 }, { UserId: 1.5 }, {}, 'text', { Platform: 'PC' },
    ] });
    assert.deepStrictEqual(rows.map(r => r.roblox_user_id), ['123', '55']);
    assert.strictEqual(rejected.length, 7);
    assert.deepStrictEqual(rejected.map(r => r.index), [2, 3, 4, 5, 6, 7, 8]);
  });

  await test('missing event is stored as unspecified, not guessed', () => {
    assert.strictEqual(normalizePayload({ UserId: 3 }).rows[0].event, 'unspecified');
  });

  await test('whole-request problems are reported as error', () => {
    assert.ok(normalizePayload(null).error);
    assert.ok(normalizePayload('hello').error);
    assert.ok(normalizePayload([]).error);
    assert.ok(normalizePayload({ Players: [] }).error);
    const tooMany = Array.from({ length: MAX_PLAYERS_PER_REQUEST + 1 }, (_, i) => ({ UserId: i + 1 }));
    assert.ok(/too many/.test(normalizePayload(tooMany).error));
  });

  // ── queue ─────────────────────────────────────────────────────────────────
  // Fake supabase: records every upsert; `script` decides what each call returns.
  function fakeSupabase(script = () => ({ error: null })) {
    const calls = [];
    return {
      calls,
      from: (table) => ({
        upsert: async (rows, opts) => { calls.push({ table, rows, opts }); return script(rows, calls.length); },
      }),
    };
  }
  const row = (id, extra = {}) => ({ roblox_user_id: String(id), event: 'leave', session_id: `s${id}`, extra, ...extra });
  const quiet = { error() {}, log() {} };
  const q = (supabase, extra = {}) => queueMod.create({ supabase, sleep: async () => {}, log: quiet, flushMs: 5, ...extra });

  await test('queue: rows are batched and written with ignore-duplicates on (session_id,event)', async () => {
    const sb = fakeSupabase();
    const queue = q(sb, { batchSize: 3 });
    assert.ok(queue.enqueue([row(1), row(2), row(3), row(4), row(5)]).ok);
    await queue.flush();
    assert.deepStrictEqual(sb.calls.map(c => c.rows.length), [3, 2]);
    assert.strictEqual(sb.calls[0].table, 'player_data');
    assert.deepStrictEqual(sb.calls[0].opts, { onConflict: 'session_id,event', ignoreDuplicates: true });
    assert.strictEqual(queue.stats().written, 5);
    assert.strictEqual(queue.stats().pending, 0);
  });

  await test('queue: the timer flushes without anyone calling flush()', async () => {
    const sb = fakeSupabase();
    const queue = q(sb);
    queue.enqueue([row(1)]);
    await new Promise(r => setTimeout(r, 60));
    assert.strictEqual(sb.calls.length, 1);
    await queue.flush();
  });

  await test('queue: transient failure is retried and nothing is lost or reordered', async () => {
    const sb = fakeSupabase((rows, n) => (n <= 2 ? { error: { code: '57014', message: 'canceling statement due to statement timeout' } } : { error: null }));
    const queue = q(sb, { batchSize: 2 });
    queue.enqueue([row(1), row(2), row(3)]);
    await queue.flush();
    const written = sb.calls.filter((c, i) => i >= 2).flatMap(c => c.rows.map(r => r.roblox_user_id));
    assert.deepStrictEqual(written, ['1', '2', '3']);
    assert.strictEqual(queue.stats().written, 3);
    assert.strictEqual(queue.stats().dropped, 0);
  });

  await test('queue: a rejected batch is split so one bad row does not take the rest', async () => {
    const sb = fakeSupabase((rows) => (rows.some(r => r.roblox_user_id === '2') ? { error: { code: '22P02', message: 'invalid input syntax' } } : { error: null }));
    const alerts = [];
    const queue = q(sb, { onAlert: (m) => alerts.push(m) });
    queue.enqueue([row(1), row(2), row(3)]);
    await queue.flush();
    const okRows = sb.calls.filter(c => c.rows.length === 1 && c.rows[0].roblox_user_id !== '2').map(c => c.rows[0].roblox_user_id);
    assert.deepStrictEqual(okRows, ['1', '3']);
    assert.deepStrictEqual(queue.stats(), { pending: 0, failStreak: 0, degraded: false, written: 2, dropped: 1 });
    assert.strictEqual(alerts.length, 1);
  });

  await test('queue: a full queue refuses instead of growing, and refuses after shutdown', async () => {
    const queue = q(fakeSupabase(), { maxQueue: 3 });
    assert.ok(queue.enqueue([row(1), row(2)]).ok);
    assert.deepStrictEqual(queue.enqueue([row(3), row(4)]), { ok: false, reason: 'queue full' });
    await queue.shutdown();
    assert.deepStrictEqual(queue.enqueue([row(5)]), { ok: false, reason: 'shutting down' });
  });

  await test('queue: shutdown flushes what is waiting', async () => {
    const sb = fakeSupabase();
    const queue = q(sb, { flushMs: 60000 });
    queue.enqueue([row(1), row(2)]);
    const res = await queue.shutdown();
    assert.strictEqual(res.pending, 0);
    assert.strictEqual(sb.calls.length, 1);
  });

  await test('queue: outage alert fires once the outage is long enough, recovery is announced', async () => {
    let t = 0;
    const alerts = []; const notices = [];
    const sb = fakeSupabase((rows, n) => (n <= 3 ? { error: { code: 'PGRST002', message: 'down' } } : { error: null }));
    const queue = q(sb, { now: () => t, sleep: async () => { t += 20000; }, alertAfterMs: 30000, onAlert: (m) => alerts.push(m), onNotice: (m) => notices.push(m) });
    queue.enqueue([row(1)]);
    await queue.flush();
    assert.strictEqual(alerts.length, 1);
    assert.strictEqual(notices.length, 1);
    assert.strictEqual(queue.stats().written, 1);
  });

  console.log(`\n${passed} tests passed`);
})().catch((err) => { console.error('\nFAILED:', err); process.exit(1); });
