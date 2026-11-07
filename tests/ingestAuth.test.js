'use strict';
// Plain node assert script: node tests/ingestAuth.test.js
// Covers modules/ingestAuth.js and that bot.js mounts it before the body parser.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { keyMatches, requireIngestKey } = require('../modules/ingestAuth');

// keyMatches
assert.strictEqual(keyMatches('secret', 'secret'), true);
assert.strictEqual(keyMatches('secreT', 'secret'), false);
assert.strictEqual(keyMatches('secret ', 'secret'), false);
assert.strictEqual(keyMatches('', 'secret'), false);
assert.strictEqual(keyMatches(undefined, 'secret'), false);
assert.strictEqual(keyMatches('secret', undefined), false, 'no key configured: nothing is accepted');
assert.strictEqual(keyMatches('secret', ''), false);
assert.strictEqual(keyMatches('a'.repeat(5000), 'secret'), false, 'a very long key is fine (hashed first)');

// middleware
const run = (headers) => {
  const out = { status: null, nexted: false };
  const res = { status(c) { out.status = c; return this; }, json() { return this; } };
  requireIngestKey({ headers }, res, () => { out.nexted = true; });
  return out;
};
process.env.INGEST_API_KEY = 'k'.repeat(40);
assert.deepStrictEqual(run({ 'x-api-key': 'k'.repeat(40) }), { status: null, nexted: true });
assert.deepStrictEqual(run({ authorization: 'Bearer ' + 'k'.repeat(40) }), { status: null, nexted: true });
assert.deepStrictEqual(run({ authorization: 'bearer ' + 'k'.repeat(40) }), { status: null, nexted: true });
assert.deepStrictEqual(run({ 'x-api-key': 'nope' }), { status: 401, nexted: false });
assert.deepStrictEqual(run({}), { status: 401, nexted: false });
delete process.env.INGEST_API_KEY;
assert.deepStrictEqual(run({ 'x-api-key': 'anything' }), { status: 401, nexted: false }, 'unset key fails closed');

// bot.js: the key is checked on /api before express.json() runs
const src = fs.readFileSync(path.join(__dirname, '..', 'bot.js'), 'utf8');
const mount = src.indexOf("app.use('/api', requireIngestKey)");
const parser = src.indexOf('app.use(express.json())');
assert.ok(mount > 0 && parser > 0 && mount < parser, "app.use('/api', requireIngestKey) must come before app.use(express.json())");

console.log('ingestAuth tests passed');
