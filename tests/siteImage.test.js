'use strict';
// Signed picture requests and the two commands built on them, with the network and Discord faked.
// Run: node tests/siteImage.test.js
const assert = require('assert');
const { init, buildUrl, fetchImage, signParams, canonical, grainFor, SiteImageError, startKeepWarm } = require('../modules/siteImage');
const gamestats = require('../commands/gamestats');
const tierlist = require('../commands/tierlist');

(async () => {
  const NOW = Date.parse('2026-11-20T20:30:00Z');
  process.env.WEBSITE_URL = 'https://example.test/';

  // ── signed address ──
  assert.equal(canonical({ b: 1, a: 2, s: 'x', c: '', d: null }), 'a=2&b=1');
  assert.equal(grainFor('24h'), 1); assert.equal(grainFor('7d'), 1); assert.equal(grainFor('30d'), 10); assert.equal(grainFor('all'), 10);
  const url = new URL(buildUrl({ kind: 'overview', lobby: 'main', range: '7d', size: 'all', min: null, max: null }, { secret: 's3', now: NOW }));
  assert.equal(url.origin + url.pathname, 'https://example.test/api/bot/image');
  assert.equal(url.searchParams.get('g'), '1');
  assert.equal(url.searchParams.get('b'), String(Math.floor(NOW / 60000)));
  assert.equal(url.searchParams.has('min'), false, 'empty options are not sent');
  const got = Object.fromEntries(url.searchParams);
  assert.equal(got.s, signParams('s3', got), 'the signature covers exactly what is sent');
  const long = new URL(buildUrl({ kind: 'overview', range: '90d' }, { secret: 's3', now: NOW }));
  assert.equal(long.searchParams.get('g'), '10');
  assert.equal(long.searchParams.get('b'), String(Math.floor(NOW / 600000)));
  assert.throws(() => buildUrl({ kind: 'overview' }, { secret: '' }), e => e instanceof SiteImageError && /not set up/.test(e.userMessage));

  // ── download ──
  const png = Buffer.from([137, 80, 78, 71]);
  const reply = (status, body) => async () => ({ ok: status < 300, status, arrayBuffer: async () => png, json: async () => body });
  const opts = { secret: 's3', now: NOW, retryDelayMs: 1 };
  assert.deepEqual(await fetchImage({ kind: 'overview' }, { ...opts, fetchImpl: reply(200) }), png);
  await assert.rejects(fetchImage({ kind: 'overview' }, { ...opts, fetchImpl: reply(404, { error: 'none' }) }), e => e.status === 404 && e.userMessage === 'No rounds match that selection.');
  await assert.rejects(fetchImage({ kind: 'overview' }, { ...opts, fetchImpl: reply(400, { error: 'Level limits only work for the last 24 hours or 7 days.' }) }), e => e.userMessage.startsWith('Level limits'));
  await assert.rejects(fetchImage({ kind: 'overview' }, { ...opts, fetchImpl: reply(401, {}) }), e => e.status === 401 && /signature/.test(e.message));
  // A 5xx or a dropped connection is tried once more, then reported.
  let n = 0;
  assert.deepEqual(await fetchImage({ kind: 'overview' }, { ...opts, fetchImpl: async () => { n++; if (n === 1) throw new Error('fetch failed'); return { ok: true, status: 200, arrayBuffer: async () => png }; } }), png);
  assert.equal(n, 2);
  n = 0;
  await assert.rejects(fetchImage({ kind: 'overview' }, { ...opts, fetchImpl: async () => { n++; return { ok: false, status: 502, json: async () => ({}) }; } }), e => e instanceof SiteImageError);
  assert.equal(n, 2, 'one retry only');
  n = 0;
  await assert.rejects(fetchImage({ kind: 'overview' }, { ...opts, fetchImpl: async () => { n++; return { ok: false, status: 404, json: async () => ({}) }; } }));
  assert.equal(n, 1, 'a 404 is not retried');

  // ── signing key: made at start, written to the database, used for every request ──
  const rows = [];
  const fakeDb = { from: t => ({ upsert: async r => { assert.equal(t, 'bot_image_key'); rows.push(r); return { error: null }; } }) };
  await init(fakeDb);
  assert.equal(rows.length, 1); assert.equal(rows[0].id, 1); assert.match(rows[0].key, /^[0-9a-f]{64}$/);
  const seen = [];
  const okFetch = async u => { seen.push(new URL(u)); return { ok: true, status: 200, arrayBuffer: async () => png }; };
  await fetchImage({ kind: 'overview' }, { fetchImpl: okFetch });
  const q = Object.fromEntries(seen[0].searchParams);
  assert.equal(q.s, signParams(rows[0].key, q), 'requests are signed with the key that was published');
  // A refused signature writes the key again and tries once more, then succeeds.
  n = 0;
  const flaky = async u => { n++; return n === 1 ? { ok: false, status: 401, json: async () => ({}) } : { ok: true, status: 200, arrayBuffer: async () => png }; };
  assert.deepEqual(await fetchImage({ kind: 'overview' }, { fetchImpl: flaky, republishDelayMs: 1 }), png);
  assert.equal(rows.length, 2, 'the key was written again'); assert.equal(rows[1].key, rows[0].key, 'same key, not a new one');
  // Still refused after that: reported, not retried forever.
  n = 0;
  await assert.rejects(fetchImage({ kind: 'overview' }, { fetchImpl: async () => { n++; return { ok: false, status: 401, json: async () => ({}) }; }, republishDelayMs: 1 }), e => e.status === 401);
  assert.equal(n, 2);
  // A failed write means nothing is signed and the user is told the service is not set up.
  const brokenDb = { from: () => ({ upsert: async () => ({ error: { message: 'down' } }) }) };
  const quiet = console.error; console.error = () => {};
  await init(brokenDb);
  console.error = quiet;
  await assert.rejects(fetchImage({ kind: 'overview' }, { fetchImpl: okFetch }), e => /not set up/.test(e.userMessage));
  await init(fakeDb);

  // ── keep-warm ──
  const logged0 = console.log; console.log = () => {};
  assert.equal(startKeepWarm({}), null, 'without a database client nothing is scheduled');
  console.log = logged0;
  let pings = 0;
  const timer = startKeepWarm({ supabase: fakeDb, intervalMs: 5, fetchImpl: async u => { pings++; assert.ok(new URL(u).searchParams.get('kind') === 'ping'); } });
  await new Promise(r => setTimeout(r, 60)); clearInterval(timer);
  assert.ok(pings >= 2);

  // ── commands ──
  const interaction = (opts = {}) => {
    const sent = [];
    return {
      sent,
      options: { getString: k => opts[k] ?? null, getInteger: k => opts[k] ?? null },
      deferReply: async () => { sent.push('defer'); },
      editReply: async x => { sent.push(x); },
    };
  };
  const names = c => c.data.toJSON().options.map(o => o.name);
  assert.deepEqual(names(gamestats), ['lobby', 'time_range', 'lobby_size', 'min_level', 'max_level']);
  assert.deepEqual(names(tierlist), ['lobby', 'time_range']);
  assert.ok(gamestats.data.toJSON().options.find(o => o.name === 'time_range').choices.some(c => c.value === '24h'), '24 hour filter is offered');

  // gamestats: defers first, then one reply holding both pictures
  let asked = [];
  const i1 = interaction({ lobby: 'pro', time_range: '24h', min_level: 40 });
  await gamestats.execute(i1, { fetchImage: async p => { asked.push(p); return png; } });
  assert.equal(i1.sent[0], 'defer');
  assert.equal(i1.sent.length, 2, 'exactly one reply after the defer');
  assert.equal(i1.sent[1].files.length, 2);
  assert.deepEqual(asked.map(p => p.kind).sort(), ['leaders', 'overview']);
  assert.deepEqual(asked[0], { kind: asked[0].kind, lobby: 'pro', range: '24h', size: 'all', min: 40, max: null });

  const i2 = interaction({ time_range: '30d', min_level: 40 });
  asked = [];
  await gamestats.execute(i2, { fetchImage: async p => { asked.push(p); return png; } });
  assert.equal(asked.length, 0, 'bad combination is refused before any download');
  assert.match(i2.sent[1], /lobby_size/);

  const i3 = interaction({});
  await gamestats.execute(i3, { fetchImage: async () => { throw new SiteImageError('x', { status: 404, userMessage: 'No rounds match that selection.' }); } });
  assert.equal(i3.sent[1], 'No rounds match that selection.');
  const i4 = interaction({});
  const logged = console.error; console.error = () => {};
  await gamestats.execute(i4, { fetchImage: async () => { throw new Error('weird'); } });
  console.error = logged;
  assert.match(i4.sent[1], /Something went wrong/);

  // tierlist: one picture, defaults to the main game and the past week
  asked = [];
  const i5 = interaction({});
  await tierlist.execute(i5, { fetchImage: async p => { asked.push(p); return png; } });
  assert.deepEqual(asked, [{ kind: 'popular', lobby: 'main', range: '7d' }]);
  assert.equal(i5.sent[1].files.length, 1);

  console.log('siteImage: ok');
})().catch(e => { console.error(e); process.exit(1); });
