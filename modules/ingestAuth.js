'use strict';
// Shared-secret check for the /api/* ingest routes.
//
// - The comparison is constant-time (both sides are hashed to the same length first, then compared with
//   crypto.timingSafeEqual), so the time a wrong key takes says nothing about how much of it was right.
// - It is mounted before the JSON body parser (bot.js), so a request without the key is refused before its body is read or parsed.
// - Nothing is rate limited by address on purpose: behind Railway's proxy every caller can look like the same address, so a
//   per-address limit could lock the game's own servers out. A key this long cannot be guessed; refusing cheaply is enough.

const crypto = require('crypto');

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest();

function keyMatches(given, expected) {
  if (!expected || !given) return false;
  return crypto.timingSafeEqual(sha256(given), sha256(expected));
}

function keyFrom(req) {
  return req.headers['x-api-key'] ?? req.headers['authorization']?.replace(/^Bearer\s+/i, '');
}

function requireIngestKey(req, res, next) {
  if (!keyMatches(keyFrom(req), process.env.INGEST_API_KEY)) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
}

module.exports = { keyMatches, keyFrom, requireIngestKey };
