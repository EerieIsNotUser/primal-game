'use strict';
// Plain node assert script: node tests/githubWebhook.test.js
// Covers modules/githubSignature.js and that bot.js makes the signature mandatory and guards the JSON parse.
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { signatureMatches } = require('../modules/githubSignature');

const S = 'whsec-test';
const body = Buffer.from('{"commits":[]}');
const sign = (b, s = S) => 'sha256=' + crypto.createHmac('sha256', s).update(b).digest('hex');

assert.strictEqual(signatureMatches(S, sign(body), body), true);
assert.strictEqual(signatureMatches(S, undefined, body), false, 'header left off');
assert.strictEqual(signatureMatches(S, '', body), false);
assert.strictEqual(signatureMatches(S, 'sha256=ab', body), false, 'short header (length differs)');
assert.strictEqual(signatureMatches(S, sign(body).toUpperCase(), body), false);
assert.strictEqual(signatureMatches(S, sign(body, 'other'), body), false, 'wrong secret');
assert.strictEqual(signatureMatches(S, sign(Buffer.from('x')), body), false, 'signature of another body');
assert.strictEqual(signatureMatches(S, [sign(body)], body), false, 'header sent twice (array)');
assert.strictEqual(signatureMatches(S, sign(body), undefined), false, 'no body');
assert.strictEqual(signatureMatches('', sign(body, ''), body), false, 'no secret: nothing is accepted by this check');

const src = fs.readFileSync(path.join(__dirname, '..', 'bot.js'), 'utf8');
const handler = src.slice(src.indexOf("app.post('/github-webhook'"), src.indexOf("app.use('/api', requireIngestKey)"));
assert.ok(/if \(secret && !signatureMatches\(/.test(handler), 'signature is required whenever a secret is set');
assert.ok(!/if \(secret && sig\)/.test(handler), 'the old "only if a header was sent" check is gone');
assert.ok(/try \{\s*payload = JSON\.parse/.test(handler), 'JSON.parse is guarded');
assert.ok(/status\(400\)/.test(handler));

console.log('githubWebhook tests passed');
