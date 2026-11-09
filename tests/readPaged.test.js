'use strict';
// Paged reads never skip or repeat a row, whatever the server's row cap is, and never end silently short.
// Run: node tests/readPaged.test.js
const assert = require('assert');
const { readPaged } = require('../modules/readPaged');

// A table behind a query builder that behaves like PostgREST: ordered by the requested columns, .range(a, b) is inclusive
// and the server returns at most `cap` rows per request without saying so.
function table(rows, { cap = 1000, failOnPage = null } = {}) {
  const calls = [];
  const make = () => {
    const q = { order: [] };
    const b = {
      order(col, o = {}) { q.order.push([col, o.ascending !== false]); return b; },
      async range(a, z) {
        calls.push([a, z]);
        if (failOnPage != null && calls.length === failOnPage) return { data: null, error: { message: 'boom' } };
        const sorted = rows.slice().sort((x, y) => {
          for (const [c, asc] of q.order) { if (x[c] !== y[c]) return (x[c] > y[c] ? 1 : -1) * (asc ? 1 : -1); }
          return 0;
        });
        return { data: sorted.slice(a, Math.min(z + 1, a + cap)), error: null };
      },
    };
    return b;
  };
  return { make, calls };
}
const mk = (n) => Array.from({ length: n }, (_, i) => ({ id: i + 1, day: `2026-11-${String(1 + (i % 9)).padStart(2, '0')}` })); // many rows share a day

let passed = 0;
const test = async (name, fn) => { try { await fn(); passed++; console.log('  ok  ', name); } catch (e) { console.error('  FAIL', name, '\n', e); process.exitCode = 1; } };
const keyed = (t) => () => t.make().order('day').order('id');

(async () => {
  for (const [rowsN, cap, size] of [[0, 1000, 1000], [1, 1000, 1000], [999, 1000, 1000], [1000, 1000, 1000], [1001, 1000, 1000], [2500, 1000, 1000], [2500, 300, 1000], [2500, 1000, 400], [2001, 1000, 1000]]) {
    await test(`${rowsN} rows, server cap ${cap}, page size ${size}: every row once, in order`, async () => {
      const data = mk(rowsN);
      const t = table(data, { cap });
      const r = await readPaged(keyed(t), { pageSize: size });
      assert.strictEqual(r.error, null);
      assert.strictEqual(r.truncated, false);
      assert.strictEqual(r.rows.length, rowsN);
      assert.strictEqual(new Set(r.rows.map((x) => x.id)).size, rowsN, 'no duplicates');
      const expected = data.slice().sort((a, b) => (a.day === b.day ? a.id - b.id : a.day > b.day ? 1 : -1)).map((x) => x.id);
      assert.deepStrictEqual(r.rows.map((x) => x.id), expected, 'no row skipped, same order as one big read');
    });
  }

  await test('the newest rows are included (descending order): the first and last page boundaries carry the newest and oldest', async () => {
    const data = Array.from({ length: 2345 }, (_, i) => ({ id: i + 1, played_at: i + 1 })); // 2345 is the newest
    const t = table(data);
    const r = await readPaged(() => t.make().order('played_at', { ascending: false }).order('id', { ascending: false }));
    assert.strictEqual(r.rows[0].played_at, 2345);
    assert.strictEqual(r.rows.at(-1).played_at, 1);
    assert.strictEqual(r.rows.length, 2345);
  });

  await test('a failing page returns the error (and what was read), not a short result that looks complete', async () => {
    const t = table(mk(3000), { failOnPage: 2 });
    const r = await readPaged(keyed(t));
    assert.ok(r.error);
    assert.strictEqual(r.rows.length, 1000);
  });

  await test('the safety stop reports truncated: true instead of pretending the read is complete', async () => {
    const t = table(mk(5000));
    const r = await readPaged(keyed(t), { maxRows: 2000 });
    assert.strictEqual(r.truncated, true);
    assert.strictEqual(r.rows.length, 2000);
  });

  console.log(`\n${passed} readPaged tests passed`);
})();
