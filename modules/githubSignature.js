'use strict';
const crypto = require('crypto');

// Checks GitHub's `X-Hub-Signature-256` header against the raw request body.
// A missing, empty, short or wrong header is a mismatch; only an exact match returns true.
function signatureMatches(secret, header, body) {
  if (!secret) return false;
  const raw = Buffer.isBuffer(body) ? body : Buffer.alloc(0);
  const expected = Buffer.from('sha256=' + crypto.createHmac('sha256', secret).update(raw).digest('hex'));
  const got = Buffer.from(typeof header === 'string' ? header : '');
  return got.length === expected.length && crypto.timingSafeEqual(got, expected);
}

module.exports = { signatureMatches };
