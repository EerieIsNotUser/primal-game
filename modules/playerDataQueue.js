// ─── player_data write queue ──────────────────────────────────────────────────
// Sits between /api/player-data and Supabase.
//
// Leave events arrive far more often than rounds (every player of every round, plus
// anyone who joins and leaves between rounds), so rows are written in batches
// instead of one request each:
//   - rows wait in memory and are flushed every flushMs, or at once when batchSize
//     rows are waiting;
//   - a failed write is retried with backoff, nothing is dropped for being slow;
//   - a batch the database rejects as malformed is split and written row by row, so
//     one bad row cannot take its neighbours with it. A row the database still
//     rejects is logged and counted, never retried forever;
//   - the queue is capped: when full the endpoint answers 503 so the sender can see
//     it, instead of memory growing without limit;
//   - shutdown() flushes what is waiting (the deploy hook waits a moment for it).
//
// Duplicates: rows that carry a session_id are written with ON CONFLICT DO NOTHING on
// (session_id, event), so a retry or a resend of the same event is harmless. Rows
// without a session_id cannot be recognised, so if a write is cut off after the
// database committed it, a retry can store them twice. Sending a session_id fixes that.
//
// Limit worth knowing: the buffer lives in memory (unlike the round queue it has no
// disk journal). A deploy is covered by the flush on SIGTERM; a hard crash loses
// whatever was still waiting, which is at most about flushMs of rows.

const { classify } = require('./roundQueue');

const DEFAULTS = {
  maxQueue:      20000,
  batchSize:     200,
  flushMs:       1000,
  callTimeoutMs: 30000,
  baseBackoffMs: 500,
  maxBackoffMs:  30000,
  alertAfterMs:  30000,
  alertRepeatMs: 10 * 60000,
};

const short = (e) => `${e?.code ? `${e.code}: ` : ''}${String(e?.message ?? e ?? 'unknown error').replace(/\s+/g, ' ').slice(0, 200)}`;

function create(opts) {
  const o = { ...DEFAULTS, ...opts };
  const { supabase } = o;
  const sleep    = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const now      = o.now ?? (() => Date.now());
  const noop     = () => {};
  const onAlert  = o.onAlert  ?? noop;
  const onNotice = o.onNotice ?? noop;
  const log      = o.log ?? { error: console.error, log: console.log };

  const buf = [];
  let timer = null;
  let running = null;
  let stopped = false;

  let failStreak = 0;
  let degradedSince = null;
  let alerted = false;
  let lastAlertAt = 0;
  let writtenDuringOutage = 0;
  let droppedSinceAlert = 0;
  let lastDropAlertAt = 0;
  const totals = { written: 0, dropped: 0 };

  async function call(fn) {
    let timeoutId;
    try {
      const timeout = new Promise((_, rej) => { timeoutId = setTimeout(() => rej(Object.assign(new Error('request timed out in the bot'), { __botTimeout: true })), o.callTimeoutMs); });
      return await Promise.race([fn(), timeout]);
    } catch (err) {
      return { error: { message: err.message, code: err.__botTimeout ? 'BOT_TIMEOUT' : '' } };
    } finally {
      clearTimeout(timeoutId);
    }
  }

  const write = (rows) => call(() => supabase.from('player_data').upsert(rows, { onConflict: 'session_id,event', ignoreDuplicates: true }));

  function noteFailure(error) {
    log.error('[player-data] Insert error:', short(error));
    failStreak += 1;
    if (degradedSince == null) degradedSince = now();
    const t = now();
    if (t - degradedSince < o.alertAfterMs) return;
    if (alerted && t - lastAlertAt < o.alertRepeatMs) return;
    alerted = true; lastAlertAt = t;
    Promise.resolve(onAlert(`player_data inserts have been failing for ${Math.round((t - degradedSince) / 1000)}s (${short(error)}). ${buf.length} row(s) are queued and retrying automatically. None have been discarded.`)).catch(noop);
  }

  function noteSuccess(count) {
    failStreak = 0;
    totals.written += count;
    if (degradedSince != null) writtenDuringOutage += count;
    if (!buf.length) {
      if (degradedSince != null && alerted) Promise.resolve(onNotice(`player_data recovered: ${writtenDuringOutage} row(s) written after the outage.`)).catch(noop);
      if (!buf.length) { degradedSince = null; alerted = false; writtenDuringOutage = 0; }
    }
  }

  function dropRow(row, error) {
    totals.dropped += 1;
    droppedSinceAlert += 1;
    log.error('[player-data] Row rejected by the database, dropped:', short(error), JSON.stringify(row).slice(0, 300));
    const t = now();
    if (t - lastDropAlertAt >= o.alertRepeatMs) {
      lastDropAlertAt = t;
      const n = droppedSinceAlert; droppedSinceAlert = 0;
      Promise.resolve(onAlert(`player_data: ${n} row(s) rejected by the database and dropped (${short(error)}). Check the Railway logs for the rows; this usually means the payload shape changed.`)).catch(noop);
    }
  }

  // Returns true if the whole batch is settled (written or dropped), false if it was put back to retry.
  async function writeBatch(batch) {
    const { error } = await write(batch);
    if (!error) { noteSuccess(batch.length); return true; }

    if (classify(error) !== 'permanent') {
      buf.unshift(...batch);
      noteFailure(error);
      return false;
    }

    // The database refused something in this batch: find which rows.
    for (let i = 0; i < batch.length; i++) {
      const res = await write([batch[i]]);
      if (!res.error) { noteSuccess(1); continue; }
      if (classify(res.error) === 'permanent') { dropRow(batch[i], res.error); continue; }
      buf.unshift(...batch.slice(i)); // transient trouble mid-way: retry the rest later
      noteFailure(res.error);
      return false;
    }
    return true;
  }

  async function drain() {
    while (buf.length) {
      const batch = buf.splice(0, o.batchSize);
      const settled = await writeBatch(batch);
      if (!settled) {
        const wait = Math.min(o.maxBackoffMs, o.baseBackoffMs * 2 ** Math.min(Math.max(failStreak - 1, 0), 7)) + Math.floor(Math.random() * 250);
        await sleep(wait);
      }
    }
  }

  function kick() {
    if (running) return;
    running = drain().catch((err) => log.error('[player-data] Drain crashed:', err.message)).finally(() => { running = null; if (buf.length) schedule(); });
  }

  function schedule() {
    if (timer || running) return;
    timer = setTimeout(() => { timer = null; kick(); }, buf.length >= o.batchSize ? 0 : o.flushMs);
  }

  // rows: normalised rows from modules/playerData.js
  function enqueue(rows) {
    if (stopped) return { ok: false, reason: 'shutting down' };
    if (buf.length + rows.length > o.maxQueue) return { ok: false, reason: 'queue full' };
    buf.push(...rows);
    schedule();
    return { ok: true, queued: buf.length };
  }

  // Write everything waiting now (used by shutdown and by tests).
  async function flush() {
    if (timer) { clearTimeout(timer); timer = null; }
    kick();
    while (running) await running;
  }

  async function shutdown(waitMs = 2500) {
    stopped = true;
    await Promise.race([flush(), new Promise((r) => setTimeout(r, waitMs))]);
    return { pending: buf.length };
  }

  return { enqueue, flush, shutdown, stats: () => ({ pending: buf.length, failStreak, degraded: degradedSince != null, ...totals }) };
}

module.exports = { create };
