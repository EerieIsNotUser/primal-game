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
// The signing key is derived from the database service key the site and this bot already both have (same derivation as the site's
// lib/botImage/sign.js), so there is no separate secret to manage.
const deriveSecret = root => (root ? crypto.createHmac('sha256', String(root)).update('primal-bot-image-v1').digest('hex') : '');
const defaultSecret = () => deriveSecret(process.env.SUPABASE_SERVICE_KEY);
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
function buildUrl(params, { secret = defaultSecret(), now = Date.now() } = {}) {
  if (!secret) throw new SiteImageError('SUPABASE_SERVICE_KEY is not set', { userMessage: 'The picture service is not set up yet.' });
  const g = grainFor(params.range);
  const full = { ...params, g, b: Math.floor(now / (g * 60_000)) };
  full.s = signParams(secret, full);
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(full)) if (v != null && v !== '') qs.set(k, String(v));
  return `${BASE()}?${qs}`;
}

// Returns a PNG Buffer. One quick retry for a dropped connection or a 5xx; everything else becomes a SiteImageError with
// a sentence that is safe to show in Discord.
async function fetchImage(params, { fetchImpl = fetch, retryDelayMs = 400, ...opts } = {}) {
  const url = buildUrl(params, opts);
  let last;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetchImpl(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (res.ok) return Buffer.from(await res.arrayBuffer());
      let reason = '';
      try { reason = (await res.json())?.error ?? ''; } catch { /* not JSON */ }
      if (res.status === 404) throw new SiteImageError(`no rounds: ${reason}`, { status: 404, userMessage: 'No rounds match that selection.' });
      if (res.status === 400) throw new SiteImageError(`bad request: ${reason}`, { status: 400, userMessage: reason || 'That combination of options is not supported.' });
      if (res.status === 401) throw new SiteImageError('site refused the signature (SUPABASE_SERVICE_KEY here differs from SUPABASE_SERVICE_ROLE_KEY on the site)', { status: 401 });
      last = new SiteImageError(`site answered ${res.status} ${reason}`, { status: res.status });
    } catch (err) {
      if (err instanceof SiteImageError && err.status && err.status < 500) throw err;
      last = err instanceof SiteImageError ? err : new SiteImageError(`request failed: ${err.message}`);
    }
    if (attempt === 0) await new Promise(r => setTimeout(r, retryDelayMs));
  }
  throw last;
}

// A cheap signed request every few minutes keeps one site function warm. Failures are ignored: it only helps speed.
function startKeepWarm({ intervalMs = 4 * 60_000, fetchImpl = fetch } = {}) {
  if (!process.env.SUPABASE_SERVICE_KEY) { console.log('[siteImage] SUPABASE_SERVICE_KEY is not set: /gamestats and /tierlist will say the picture service is not set up.'); return null; }
  const ping = () => fetchImpl(buildUrl({ kind: 'ping' }), { signal: AbortSignal.timeout(10_000) }).catch(() => {});
  ping();
  const timer = setInterval(ping, intervalMs);
  timer.unref?.();
  return timer;
}

module.exports = { deriveSecret, startKeepWarm, fetchImage, buildUrl, signParams, canonical, grainFor, SiteImageError };
