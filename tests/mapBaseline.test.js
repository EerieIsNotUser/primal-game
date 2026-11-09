'use strict';
// /mapchart six-month baseline: built from the per-day counters, paged, and skipped (not shown partial) when a read fails.
// Run: node tests/mapBaseline.test.js
const assert = require('assert');
const Module = require('module');
// commands/mapchart.js needs discord.js and the canvas charts at load; the baseline code needs neither.
const origLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === '../modules/chart') return { buildLineChartImage() {}, buildDualAxisChartImage() {}, bucketRoundsByMap() {}, MAP_COLORS: {} };
  return origLoad.call(this, request, ...rest);
};
const { _internals } = require('../commands/mapchart');
Module._load = origLoad;
const { getSixMonthBaseline, buildChartNarrative, mapShareFromCounts } = _internals;

const NOW = Date.parse('2026-11-09T01:00:00Z');
// A fake client with PostgREST's cap: map_daily_stats and round_stats_daily as tables, filtered by day, ordered, range-paged
function client({ counters, rolled, cap = 1000, failTable = null }) {
  const tables = { map_daily_stats: counters, round_stats_daily: rolled };
  const seen = [];
  return {
    seen,
    from(name) {
      const q = { f: [], order: [] };
      const b = {
        select() { return b; },
        gte(c, v) { q.f.push((r) => r[c] >= v); return b; },
        lt(c, v) { q.f.push((r) => r[c] < v); return b; },
        order(c, o = {}) { q.order.push([c, o.ascending !== false]); return b; },
        async range(a, z) {
          seen.push({ name, a, z, order: q.order.map((x) => x[0]) });
          if (failTable === name) return { data: null, error: { message: 'down' } };
          const rows = tables[name].filter((r) => q.f.every((fn) => fn(r))).sort((x, y) => {
            for (const [c, asc] of q.order) { if (x[c] !== y[c]) return (x[c] > y[c] ? 1 : -1) * (asc ? 1 : -1); }
            return 0;
          });
          return { data: rows.slice(a, Math.min(z + 1, a + cap)), error: null };
        },
      };
      return b;
    },
  };
}

let passed = 0;
const test = async (name, fn) => { try { await fn(); passed++; console.log('  ok  ', name); } catch (e) { console.error('  FAIL', name, '\n', e); process.exitCode = 1; } };
const day = (n) => new Date(NOW - n * 86400e3).toISOString().slice(0, 10);

(async () => {
  await test('counts per map come from the counters across page boundaries, plus rolled-up days older than 10 days', async () => {
    // 4 maps x 200 days = 800 counter rows; shrink the server cap to 300 so pages are crossed
    const maps = ['Jungle', 'Cavern', 'Canyon', 'Primal Park'];
    const counters = [];
    for (let d = 0; d < 200; d++) for (const [i, m] of maps.entries()) counters.push({ map: m, day: day(d), total: 100 * (i + 1) });
    const rolled = [
      { id: 1, day: day(60), map: 'Jungle', dino_wins: 10, survivor_wins: 5 },
      { id: 2, day: day(60), map: 'Jungle', dino_wins: 1, survivor_wins: 1 },   // second row for the same day and map
      { id: 3, day: day(3), map: 'Cavern', dino_wins: 999, survivor_wins: 999 }, // newer than the retention window: not used
      { id: 4, day: day(400), map: 'Cavern', dino_wins: 999, survivor_wins: 999 }, // older than six months: not used
    ];
    const c = client({ counters, rolled, cap: 300 });
    const base = await getSixMonthBaseline(c, { now: NOW });
    const inWindow = counters.filter((r) => r.day >= new Date(new Date(NOW).setMonth(new Date(NOW).getMonth() - 6)).toISOString().slice(0, 10));
    const expected = new Map();
    for (const r of inWindow) expected.set(r.map, (expected.get(r.map) || 0) + r.total);
    expected.set('Jungle', expected.get('Jungle') + 17);
    assert.deepStrictEqual([...base.counts.entries()].sort(), [...expected.entries()].sort());
    assert.strictEqual(base.total, [...expected.values()].reduce((a, b) => a + b, 0));
    // every read had a unique ordering and no page was asked for twice
    const keys = c.seen.map((s) => `${s.name}:${s.a}`);
    assert.strictEqual(new Set(keys).size, keys.length);
    assert.ok(c.seen.filter((s) => s.name === 'map_daily_stats').every((s) => s.order.join() === 'day,map'));
    assert.ok(c.seen.filter((s) => s.name === 'round_stats_daily').every((s) => s.order.join() === 'id'));
  });

  await test('newest days are included (today, even though a page boundary falls right before it)', async () => {
    const counters = [];
    for (let d = 0; d < 150; d++) counters.push({ map: 'Jungle', day: day(d), total: 1 });
    counters.push({ map: 'Jungle', day: day(0), total: 0 });
    const base = await getSixMonthBaseline(client({ counters, rolled: [], cap: 50 }), { now: NOW });
    assert.strictEqual(base.counts.get('Jungle'), 150);
  });

  await test('a failed read, or one that hit the safety stop, gives no baseline (null) instead of partial shares', async () => {
    const counters = [{ map: 'Jungle', day: day(1), total: 5 }];
    assert.strictEqual(await getSixMonthBaseline(client({ counters, rolled: [], failTable: 'map_daily_stats' }), { now: NOW }), null);
    assert.strictEqual(await getSixMonthBaseline(client({ counters, rolled: [], failTable: 'round_stats_daily' }), { now: NOW }), null);
    const stopped = async () => ({ rows: [], error: null, truncated: true });
    assert.strictEqual(await getSixMonthBaseline(client({ counters, rolled: [] }), { now: NOW, read: stopped }), null);
  });

  await test('the narrative uses the same shares as before: a map up 8+ points against its baseline is reported', async () => {
    const baseline = { counts: new Map([['Jungle', 600], ['Cavern', 400]]), total: 1000 };
    const rows = [...Array(80).fill({ map: 'Jungle', round_result: 'DinoWin' }), ...Array(20).fill({ map: 'Cavern', round_result: 'SurvivorWin' })];
    const text = buildChartNarrative(rows, baseline, ['Jungle', 'Cavern']);
    assert.match(text, /Jungle is up 20 pts/);
    assert.match(text, /Cavern is down 20 pts/);
    assert.ok(buildChartNarrative(rows, null, ['Jungle']).indexOf('6-month') === -1, 'no baseline: no popularity line');
    assert.strictEqual(mapShareFromCounts(new Map([['a', 1]]), 4).get('a'), 0.25);
    assert.strictEqual(mapShareFromCounts(new Map([['a', 1]]), 0).get('a'), 0);
  });

  console.log(`\n${passed} mapBaseline tests passed`);
})();
