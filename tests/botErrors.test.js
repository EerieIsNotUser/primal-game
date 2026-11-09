// Fatal-error handler: the crash record is written through a faithful
// supabase-js stand-in (builders are thenables with .then but NO .catch), the
// process always exits with 1, cleanup is bounded, and a handler that throws
// cannot loop.  Run: node tests/botErrors.test.js

const assert = require('assert');
const EventEmitter = require('events');
const setupBotErrors = require('../modules/bot-errors');

// supabase-js query builders are thenables and have no .catch method.
function thenableBuilder(result, log) {
  const b = {
    update(v) { log.push(['update', v]); return b; },
    select() { return b; },
    eq(k, v) { log.push(['eq', k, v]); return b; },
    single() { return b; },
    then(resolve, reject) { return Promise.resolve(result).then(resolve, reject); },
  };
  return b;
}
function fakeSupabase(result = { data: null, error: null }) {
  const log = [];
  return { log, from: (t) => { log.push(['from', t]); return thenableBuilder(result, log); } };
}

function fakeClient(sent = []) {
  const ch = { send: async (m) => { sent.push(m); } };
  return {
    sent,
    on() {},
    channels: { cache: { get: () => ch }, fetch: async () => ch },
  };
}

function makeProc() { return new EventEmitter(); }
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

async function setup(over = {}) {
  const proc = makeProc();
  const exits = [];
  const supabase = over.supabase ?? fakeSupabase();
  const client = over.client ?? fakeClient();
  setupBotErrors(client, {
    supabase,
    proc,
    exit: (c) => exits.push(c),
    timeoutMs: over.timeoutMs ?? 200,
    beforeExit: over.beforeExit,
  });
  await tick(); // let checkPreviousCrash settle
  return { proc, exits, supabase, client };
}

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ok  ', name); }
  catch (e) { console.error('  FAIL', name, '\n', e); process.exitCode = 1; }
}

(async () => {
  // Guard: the stub really has no .catch, as the real builders.
  await test('stub builder has no .catch (matches supabase-js)', () => {
    assert.strictEqual(typeof fakeSupabase().from('x').catch, 'undefined');
  });

  await test('uncaughtException stores the crash, posts, and exits 1', async () => {
    const { proc, exits, supabase, client } = await setup();
    supabase.log.length = 0;
    proc.emit('uncaughtException', new Error('boom'));
    await tick(50);
    assert.deepStrictEqual(exits, [1]);
    const upd = supabase.log.find((l) => l[0] === 'update');
    assert.ok(upd && /Error: boom/.test(upd[1].value), 'crash info saved');
    assert.ok(client.sent.some((m) => /Uncaught Exception/.test(m.embeds[0].data.title)), 'posted');
  });

  await test('unhandledRejection exits 1 (was: logged and carried on)', async () => {
    const { proc, exits } = await setup();
    proc.emit('unhandledRejection', new Error('nope'));
    await tick(50);
    assert.deepStrictEqual(exits, [1]);
  });

  await test('non-Error rejection reasons are described, not thrown on', async () => {
    const { proc, exits, supabase } = await setup();
    supabase.log.length = 0;
    proc.emit('unhandledRejection', 'plain string');
    await tick(50);
    assert.deepStrictEqual(exits, [1]);
    assert.ok(supabase.log.some((l) => l[0] === 'update' && l[1].value === 'plain string'));
  });

  await test('a database error result does not stop the exit', async () => {
    const { proc, exits } = await setup({ supabase: fakeSupabase({ data: null, error: { message: 'down' } }) });
    proc.emit('uncaughtException', new Error('x'));
    await tick(50);
    assert.deepStrictEqual(exits, [1]);
  });

  await test('a database call that throws does not stop the exit', async () => {
    const throwing = { from() { throw new Error('client broken'); } };
    const { proc, exits } = await setup({ supabase: throwing });
    proc.emit('uncaughtException', new Error('x'));
    await tick(50);
    assert.deepStrictEqual(exits, [1]);
  });

  await test('a hung cleanup is cut off after the timeout and still exits', async () => {
    const hang = { from: () => ({ update() { return this; }, eq() { return this; }, then() { /* never settles */ } }) };
    const { proc, exits } = await setup({ supabase: hang, timeoutMs: 80 });
    proc.emit('uncaughtException', new Error('x'));
    await tick(40);
    assert.deepStrictEqual(exits, [], 'still waiting inside the bound');
    await tick(100);
    assert.deepStrictEqual(exits, [1]);
  });

  await test('beforeExit runs, and a failing beforeExit does not block the exit', async () => {
    let ran = 0;
    const a = await setup({ beforeExit: async () => { ran++; } });
    a.proc.emit('uncaughtException', new Error('x'));
    await tick(50);
    assert.strictEqual(ran, 1);
    assert.deepStrictEqual(a.exits, [1]);

    const b = await setup({ beforeExit: async () => { throw new Error('flush failed'); } });
    b.proc.emit('uncaughtException', new Error('y'));
    await tick(50);
    assert.deepStrictEqual(b.exits, [1]);
  });

  await test('re-entrancy: errors during cleanup do not start a second cleanup or a second exit', async () => {
    let ran = 0;
    const { proc, exits } = await setup({ beforeExit: async () => { ran++; await tick(40); } });
    proc.emit('uncaughtException', new Error('first'));
    proc.emit('unhandledRejection', new Error('second'));
    proc.emit('uncaughtException', new Error('third'));
    await tick(120);
    assert.strictEqual(ran, 1);
    assert.deepStrictEqual(exits, [1]);
  });

  await test('the handlers are not async functions (nothing can reject out of them)', async () => {
    const { proc } = await setup();
    for (const ev of ['uncaughtException', 'unhandledRejection']) {
      for (const fn of proc.listeners(ev)) assert.notStrictEqual(fn.constructor.name, 'AsyncFunction');
    }
  });

  await test('UNHANDLED_REJECTION_EXIT=off keeps the old log-and-continue behaviour', async () => {
    process.env.UNHANDLED_REJECTION_EXIT = 'off';
    try {
      const { proc, exits } = await setup();
      proc.emit('unhandledRejection', new Error('tolerated'));
      await tick(50);
      assert.deepStrictEqual(exits, []);
    } finally { delete process.env.UNHANDLED_REJECTION_EXIT; }
  });

  await test('withTimeout resolves done / failed / timeout and never rejects', async () => {
    const { withTimeout } = setupBotErrors;
    assert.strictEqual(await withTimeout(Promise.resolve(1), 50), 'done');
    assert.strictEqual(await withTimeout(Promise.reject(new Error('x')), 50), 'failed');
    assert.strictEqual(await withTimeout(new Promise(() => {}), 20), 'timeout');
  });

  console.log(`\n${passed} botErrors tests passed`);
})();
