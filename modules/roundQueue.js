// ─── Round queue ──────────────────────────────────────────────────────────────
// Sits between the /api/round-complete endpoint and Supabase.
//
// Why it exists: every row in round_logs fires ~22 triggers that update the
// aggregate tables the website reads. When the database is busy those inserts
// can hit a lock or statement timeout, and before this queue the round was simply
// lost (the endpoint answered 500 and the game does not resend).
//
// What it does:
//   - A round is written to a local journal first, then acknowledged. Once the
//     endpoint has answered 200 the round survives a process restart.
//   - One writer inserts rounds one at a time, in the order they arrived, so the
//     bot never competes with itself for the same aggregate rows.
//   - On failure it backs off and retries. Nothing is dropped for being slow.
//   - A retry never inserts a round twice: after any failure where the database
//     may have committed (lost connection, gateway timeout), it first looks the
//     round up by its played_at/received_at pair before trying again.
//   - Only a row the database itself rejects as malformed is set aside, written to
//     a dead-letter file, and reported. If several rejections happen back to back
//     it stops dropping and holds the queue, because that pattern means something
//     systemic (a schema change) rather than one bad row.
//   - The queue is capped. When full the endpoint answers 503 instead of growing
//     without limit.
//
// Limits worth knowing: the journal is a file on the container's disk. It survives
// a process restart or crash, but not a brand new container unless a volume is
// mounted at ROUND_QUEUE_DIR. In normal operation the queue is empty within
// milliseconds, so the journal only matters while the database is struggling.

const fs   = require('fs');
const path = require('path');

const DEFAULTS = {
  maxQueue:           10000,
  callTimeoutMs:      60000,
  settleAfterTimeoutMs: 15000, // a request we gave up on may still be running on the server
  baseBackoffMs:      500,
  maxBackoffMs:       30000,
  alertAfterMs:       30000,     // outage must last this long before anyone is pinged
  alertRepeatMs:      10 * 60000,
  maxPlayerAttempts:  10,
  systemicRejections: 5,
  compactBytes:       8 * 1024 * 1024,
};

// Rolled back, or never executed: safe to run the same statement again.
const SAFE_RETRY = new Set([
  '57014', // statement timeout / cancelled
  '55P03', // lock timeout
  '40001', // serialization failure
  '40P01', // deadlock detected
  '53300', // too many connections
  '57P01', // admin shutdown
  'PGRST000', 'PGRST001', 'PGRST002', 'PGRST003', // PostgREST could not reach or use the database
]);

function classify(error) {
  const code = String(error?.code ?? '');
  if (/^(22|23)/.test(code) || code === 'PGRST102') return 'permanent'; // this row is the problem
  if (SAFE_RETRY.has(code)) return 'safe';
  return 'ambiguous'; // may have committed (fetch failed, gateway error, our own timeout, anything unknown)
}

const short = (e) => `${e?.code ? `${e.code}: ` : ''}${String(e?.message ?? e ?? 'unknown error').replace(/\s+/g, ' ').slice(0, 200)}`;

function create(opts) {
  const o = { ...DEFAULTS, ...opts };
  const { supabase } = o;
  const sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const now   = o.now ?? (() => Date.now());
  const noop  = () => {};
  const onAlert   = o.onAlert   ?? noop;   // needs attention
  const onNotice  = o.onNotice  ?? noop;   // informational (recovery)
  const onSuccess = o.onSuccess ?? noop;   // one round fully written
  const onError   = o.onError   ?? noop;   // one failed attempt
  const log       = o.log ?? { error: console.error, log: console.log };

  const dir         = o.dir;
  const journalPath = dir ? path.join(dir, 'round-queue.jsonl') : null;
  const deadPath    = dir ? path.join(dir, 'round-queue-dead.jsonl') : null;

  const items = [];          // pending, oldest first
  let nextSeq = 1;
  let lastReceivedMs = 0;
  let draining = false;
  let stopped = false;
  let current = Promise.resolve();
  let journalOk = !!dir;
  let journalBytes = 0;

  // health bookkeeping
  let failStreak = 0;        // consecutive failed attempts (drives backoff)
  let degradedSince = null;  // ms when the current outage began
  let lastAlertAt = 0;
  let alerted = false;
  let writtenDuringOutage = 0;
  let droppedDuringOutage = 0;
  let rejectionStreak = 0;
  let holdAlerted = false;
  const totals = { written: 0, dropped: 0, playerRowsLost: 0 };

  // ── journal ────────────────────────────────────────────────────────────────
  function journal(rec) {
    if (!journalOk) return;
    try {
      const line = JSON.stringify(rec) + '\n';
      fs.appendFileSync(journalPath, line);
      journalBytes += Buffer.byteLength(line);
    } catch (err) {
      journalOk = false;
      log.error('[round-queue] Journal write failed, continuing in memory only:', err.message);
    }
  }

  function rewriteJournal() {
    if (!journalOk) return;
    try {
      const lines = [];
      for (const it of items) {
        lines.push(JSON.stringify({ t: 'a', q: it.seq, row: it.row, players: it.players }));
        if (it.roundId != null) lines.push(JSON.stringify({ t: 'r', q: it.seq, id: it.roundId }));
      }
      const body = lines.length ? lines.join('\n') + '\n' : '';
      fs.writeFileSync(journalPath + '.tmp', body);
      fs.renameSync(journalPath + '.tmp', journalPath);
      journalBytes = Buffer.byteLength(body);
    } catch (err) {
      log.error('[round-queue] Journal compaction failed:', err.message);
    }
  }

  function loadJournal() {
    if (!journalOk) return;
    try {
      fs.mkdirSync(dir, { recursive: true });
      if (!fs.existsSync(journalPath)) return;
      const live = new Map();
      for (const line of fs.readFileSync(journalPath, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        let rec; try { rec = JSON.parse(line); } catch { continue; } // a torn last line from a crash
        if (rec.t === 'a') live.set(rec.q, { seq: rec.q, row: rec.row, players: rec.players ?? [], roundId: null });
        else if (rec.t === 'r' && live.has(rec.q)) live.get(rec.q).roundId = rec.id;
        else if (rec.t === 'd') live.delete(rec.q);
      }
      for (const it of [...live.values()].sort((a, b) => a.seq - b.seq)) {
        // We cannot know whether the last attempt before the restart committed, so check first.
        it.attempts = 0;
        it.ambiguous = it.roundId == null;
        it.playersAmbiguous = it.roundId != null && it.players.length > 0;
        items.push(it);
        nextSeq = Math.max(nextSeq, it.seq + 1);
        lastReceivedMs = Math.max(lastReceivedMs, Date.parse(it.row.received_at) || 0);
      }
      rewriteJournal();
      if (items.length) log.log(`[round-queue] Restored ${items.length} unwritten round(s) from the journal.`);
    } catch (err) {
      journalOk = false;
      log.error('[round-queue] Could not read journal:', err.message);
    }
  }

  function deadLetter(it, reason) {
    try {
      if (!deadPath) return;
      fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(deadPath, JSON.stringify({ at: new Date(now()).toISOString(), reason, row: it.row, players: it.players }) + '\n');
    } catch (err) {
      log.error('[round-queue] Dead-letter write failed:', err.message);
    }
  }

  // ── database calls ─────────────────────────────────────────────────────────
  async function call(fn) {
    let timer;
    try {
      const timeout = new Promise((_, rej) => { timer = setTimeout(() => rej(Object.assign(new Error('request timed out in the bot'), { __botTimeout: true })), o.callTimeoutMs); });
      return await Promise.race([fn(), timeout]);
    } catch (err) {
      return { data: null, error: { message: err.message, code: err.__botTimeout ? 'BOT_TIMEOUT' : '' } };
    } finally {
      clearTimeout(timer);
    }
  }

  const findExistingRound = (it) => call(() => supabase.from('round_logs').select('id, map')
    .eq('played_at', it.row.played_at).eq('received_at', it.row.received_at).limit(5));
  const insertRound = (it) => call(() => supabase.from('round_logs').insert(it.row).select('id'));
  const countPlayers = (it) => call(() => supabase.from('round_players').select('id', { count: 'exact', head: true }).eq('round_id', it.roundId));
  const insertPlayers = (it) => call(() => supabase.from('round_players').insert(it.players.map((p) => ({ ...p, round_id: it.roundId }))));

  // ── processing one item ────────────────────────────────────────────────────
  // returns 'done' | 'retry' | 'dropped'
  async function step(it) {
    // 1. the round itself
    if (it.roundId == null) {
      if (it.ambiguous) {
        if (it.settleUntil && now() < it.settleUntil) await sleep(it.settleUntil - now());
        const { data, error } = await findExistingRound(it);
        if (error) return fail(error, 'lookup');
        const hit = (data ?? []).find((r) => r.map === it.row.map);
        if (hit) { it.roundId = hit.id; it.ambiguous = false; journal({ t: 'r', q: it.seq, id: it.roundId }); }
        else it.ambiguous = false; // confirmed it is not there
      }
      if (it.roundId == null) {
        const { data, error } = await insertRound(it);
        if (error) {
          const kind = classify(error);
          if (kind === 'permanent') return reject(it, error);
          if (kind === 'ambiguous') { it.ambiguous = true; if (error.code === 'BOT_TIMEOUT') it.settleUntil = now() + o.settleAfterTimeoutMs; }
          return fail(error, 'insert');
        }
        it.roundId = data?.[0]?.id ?? null;
        if (it.roundId == null) it.players = []; // inserted but no id came back; nothing to attach players to
        else journal({ t: 'r', q: it.seq, id: it.roundId });
      }
    }

    // 2. per-player rows (a failure here never re-inserts the round)
    if (it.roundId != null && it.players.length) {
      if (it.playersAmbiguous) {
        if (it.settleUntil && now() < it.settleUntil) await sleep(it.settleUntil - now());
        const { count, error } = await countPlayers(it);
        if (error) return fail(error, 'player lookup');
        if ((count ?? 0) > 0) it.players = [];
        it.playersAmbiguous = false;
      }
      if (it.players.length) {
        const { error } = await insertPlayers(it);
        if (error) {
          const kind = classify(error);
          it.attempts = (it.attempts ?? 0) + 1;
          if (kind === 'permanent' || it.attempts >= o.maxPlayerAttempts) {
            totals.playerRowsLost += it.players.length;
            log.error(`[round-complete] round_players insert error (giving up on ${it.players.length} row(s)):`, short(error));
            Promise.resolve(onAlert(`round_players insert failed for round ${it.roundId} — ${short(error)}`)).catch(noop);
            it.players = [];
          } else {
            if (kind === 'ambiguous') { it.playersAmbiguous = true; if (error.code === 'BOT_TIMEOUT') it.settleUntil = now() + o.settleAfterTimeoutMs; }
            return fail(error, 'round_players insert');
          }
        }
      }
    }
    return 'done';
  }

  function fail(error, what) {
    log.error(`[round-complete] ${what === 'insert' ? 'Insert error' : `${what} error`}:`, short(error));
    onError(short(error));
    failStreak += 1;
    if (degradedSince == null) degradedSince = now();
    maybeAlert(error);
    return 'retry';
  }

  function reject(it, error) {
    rejectionStreak += 1;
    if (rejectionStreak >= o.systemicRejections) {
      // Looks like the database refuses everything: hold the queue instead of draining it into the dead-letter file.
      rejectionStreak = o.systemicRejections; // stay at the threshold until something succeeds
      log.error('[round-queue] Repeated rejections, holding the queue:', short(error));
      if (!holdAlerted) Promise.resolve(onAlert(`The database rejected ${o.systemicRejections} rounds in a row (${short(error)}). That points to a schema or data-format change, so the queue is holding ${items.length} round(s) instead of discarding them. Needs a fix, then it resumes by itself.`)).catch(noop);
      holdAlerted = true;
      return fail(error, 'rejected');
    }
    totals.dropped += 1; droppedDuringOutage += 1;
    deadLetter(it, short(error));
    log.error('[round-complete] Round rejected by the database, set aside:', short(error));
    onError(short(error));
    Promise.resolve(onAlert(`Round rejected by the database and set aside (saved to round-queue-dead.jsonl): ${short(error)}`)).catch(noop);
    return 'dropped';
  }

  function maybeAlert(error) {
    const t = now();
    if (degradedSince == null || t - degradedSince < o.alertAfterMs) return;
    if (alerted && t - lastAlertAt < o.alertRepeatMs) return;
    alerted = true; lastAlertAt = t;
    Promise.resolve(onAlert(`Supabase inserts have been failing for ${Math.round((t - degradedSince) / 1000)}s (${short(error)}). ${items.length} round(s) are queued and retrying automatically. None have been discarded.`)).catch(noop);
  }

  function recovered() {
    if (degradedSince != null && alerted) {
      Promise.resolve(onNotice(`Ingestion recovered. Queue is empty: ${writtenDuringOutage} round(s) written after the outage, ${droppedDuringOutage} set aside.`)).catch(noop);
    }
    degradedSince = null; alerted = false; writtenDuringOutage = 0; droppedDuringOutage = 0;
  }

  // ── the single writer ──────────────────────────────────────────────────────
  async function drain() {
    if (draining) return;
    draining = true;
    try {
      while (items.length && !stopped) {
        const it = items[0];
        const result = await step(it);
        if (result === 'retry') {
          const wait = Math.min(o.maxBackoffMs, o.baseBackoffMs * 2 ** Math.min(Math.max(failStreak - 1, 0), 7)) + Math.floor(Math.random() * 250);
          await sleep(wait);
          continue;
        }
        items.shift();
        journal({ t: 'd', q: it.seq });
        if (journalBytes > o.compactBytes) rewriteJournal(); // long backlog: keep the file from growing with finished rounds
        if (result === 'done') {
          failStreak = 0; rejectionStreak = 0; holdAlerted = false; totals.written += 1;
          if (degradedSince != null) writtenDuringOutage += 1;
          try { onSuccess(); } catch { /* callback errors must not stall the queue */ }
        } else {
          failStreak = 0; // a dropped row means the database answered
        }
      }
      if (!items.length) {
        recovered();
        if (journalBytes > 0) rewriteJournal(); // nothing pending: leave the journal empty
      }
    } finally {
      draining = false;
    }
  }

  function kick() { if (!draining) current = drain().catch((err) => log.error('[round-queue] Drain crashed:', err.message)); }

  // ── public API ─────────────────────────────────────────────────────────────
  function enqueue(row, players = []) {
    if (stopped) return { ok: false, reason: 'shutting down' };
    if (items.length >= o.maxQueue) return { ok: false, reason: 'queue full' };
    let t = now(); if (t <= lastReceivedMs) t = lastReceivedMs + 1; lastReceivedMs = t; // unique per round
    const it = { seq: nextSeq++, row: { ...row, received_at: new Date(t).toISOString() }, players, roundId: null, attempts: 0, ambiguous: false, playersAmbiguous: false };
    journal({ t: 'a', q: it.seq, row: it.row, players: it.players });
    items.push(it);
    kick();
    return { ok: true, queued: items.length };
  }

  async function shutdown(waitMs = 2500) {
    stopped = true;
    await Promise.race([current, new Promise((r) => setTimeout(r, waitMs))]);
    return { pending: items.length };
  }

  loadJournal();
  if (items.length) kick();

  return {
    enqueue, shutdown,
    stats: () => ({ pending: items.length, failStreak, degraded: degradedSince != null, ...totals, journal: journalOk }),
    idle: () => current,
  };
}

module.exports = { create, classify };
