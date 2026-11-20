'use strict';
// Downloads finished stat pictures from the website (/api/bot/image). The site draws them next to the database and the CDN keeps
// identical ones for a few minutes, so a command is one short download instead of a long run of database requests.
const crypto = require('crypto');

const BASE = () => `${(process.env.WEBSITE_URL || 'https://www.primalpursuitrblx.com').replace(/\/+$/, '')}/api/bot/image`;
const TIMEOUT_MS = 20_000;

// Same rule as the site: every parameter but the signature, sorted, empty ones left out.
function canonical(params) {
  return Object.keys(params).filter(k => k !== 's' && params[k] != null && params[k] !== '').sort()
    .map(k => `${k}=${params[k]}`).join('&');
}
// The signing key is made fresh each time the bot starts and published to the database (table bot_image_key, service role only).
// The website reads it from there to check requests, so nothing has to be set in an environment variable on either side.
const fingerprint = secret => (secret ? crypto.createHash('sha256').update('fp:' + String(secret)).digest('hex').slice(0, 8) : 'none');
let db = null;
let signingKey = null;
async function publishKey() {
  if (!db) throw new Error('no database client');
  signingKey ??= crypto.randomBytes(32).toString('hex');
  const { error } = await db.from('bot_image_key').upsert({ id: 1, key: signingKey, updated_at: new Date().toISOString() });
  if (error) throw new Error(error.message);
}
let ready = null;
function init(client) {
  db = client; signingKey = null;
  ready = publishKey().then(() => { console.log(`[siteImage] signing key published (fingerprint ${fingerprint(signingKey)})`); }, err => { console.error('[siteImage] could not publish the signing key:', err.message); signingKey = null; });
  return ready;
}
async function getSecret() {
  if (ready) await ready;
  if (!signingKey) throw new SiteImageError('no signing key', { userMessage: 'The picture service is not set up yet.' });
  return signingKey;
}
const signParams = (secret, params) => crypto.createHmac('sha256', String(secret)).update(canonical(params)).digest('hex');

// Short periods change every minute, longer ones (read from daily totals) every ten.
const grainFor = range => (range === '24h' || range === '7d' ? 1 : 10);

class SiteImageError extends Error {
  constructor(message, { status = 0, userMessage } = {}) {
    super(message);
    this.status = status;
    this.userMessage = userMessage ?? 'The picture service did not answer. Try again in a moment.';
  }
}

// Builds the signed address for one picture.
function buildUrl(params, { secret, now = Date.now() } = {}) {
  if (!secret) throw new SiteImageError('no signing key', { userMessage: 'The picture service is not set up yet.' });
  const g = grainFor(params.range);
  const full = { ...params, g, b: Math.floor(now / (g * 60_000)) };
  full.s = signParams(secret, full);
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(full)) if (v != null && v !== '') qs.set(k, String(v));
  return `${BASE()}?${qs}`;
}

// Returns a PNG Buffer. One quick retry for a dropped connection or a 5xx; everything else becomes a SiteImageError with
// a sentence that is safe to show in Discord. A refused signature (the site may still hold the key of an earlier run of the bot)
// writes the key to the database again and tries once more.
async function fetchImage(params, { fetchImpl = fetch, retryDelayMs = 400, republishDelayMs = 1500, ...opts } = {}) {
  const secret = opts.secret ?? await getSecret();
  const url = buildUrl(params, { ...opts, secret });
  let last, republished = false, failures = 0;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await fetchImpl(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (res.ok) return Buffer.from(await res.arrayBuffer());
      let reason = '';
      try { reason = (await res.json())?.error ?? ''; } catch { /* not JSON */ }
      if (res.status === 404) throw new SiteImageError(`no rounds: ${reason}`, { status: 404, userMessage: 'No rounds match that selection.' });
      if (res.status === 400) throw new SiteImageError(`bad request: ${reason}`, { status: 400, userMessage: reason || 'That combination of options is not supported.' });
      if (res.status === 401) {
        last = new SiteImageError(`site refused the signature (bot key fingerprint ${fingerprint(secret)})`, { status: 401 });
        if (republished || opts.secret || !db) throw last;
        republished = true;
        await publishKey().catch(err => console.error('[siteImage] could not publish the signing key again:', err.message));
        await new Promise(r => setTimeout(r, republishDelayMs));
        continue;
      }
      last = new SiteImageError(`site answered ${res.status} ${reason}`, { status: res.status });
    } catch (err) {
      if (err instanceof SiteImageError && err.status && err.status < 500) throw err;
      last = err instanceof SiteImageError ? err : new SiteImageError(`request failed: ${err.message}`);
    }
    if (++failures >= 2) break;
    await new Promise(r => setTimeout(r, retryDelayMs));
  }
  throw last;
}

// Publishes the signing key, then pings the site every few minutes so one function stays warm. Failures are ignored: it only helps speed.
function startKeepWarm({ supabase, intervalMs = 4 * 60_000, fetchImpl = fetch } = {}) {
  if (!supabase) { console.log('[siteImage] no database client: /gamestats and /tierlist will say the picture service is not set up.'); return null; }
  const ping = async () => {
    try { const secret = await getSecret(); await fetchImpl(buildUrl({ kind: 'ping' }, { secret }), { signal: AbortSignal.timeout(10_000) }); } catch { /* speed only */ }
  };
  init(supabase).then(ping);
  const timer = setInterval(ping, intervalMs);
  timer.unref?.();
  return timer;
}

module.exports = { init, startKeepWarm, getSecret, fetchImage, buildUrl, signParams, canonical, grainFor, fingerprint, SiteImageError };
