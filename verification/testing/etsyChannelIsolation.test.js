'use strict';

// agent/core/channelModel.js - Etsy and Shopify records stay separate.
//
// The central assertion of this file is a NEGATIVE one: no merge, join or id-equivalence
// helper exists. That absence is the isolation guarantee, so it is asserted explicitly
// rather than left to be noticed if someone adds one later.

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const channelModel = require('../../agent/core/channelModel');
const { stampChannel, getChannel, recordsForChannel, assertChannel, CHANNELS } = channelModel;

// The channel the read client declares for everything it returns.
function etsyReadClientChannel() {
  return require('../../integrations/adapters/etsyReadClient').ETSY_CHANNEL;
}

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`PASS: ${name}`);
    passed += 1;
  } catch (err) {
    console.error(`FAIL: ${name}`);
    console.error(`  ${err.message}`);
    failed += 1;
  }
}

test('the two channels with a real adapter are recognized, and nothing else is', () => {
  assert.deepStrictEqual(CHANNELS, ['shopify', 'etsy']);
  for (const unknown of ['amazon', 'ebay', 'woocommerce', 'Etsy', 'ETSY', '', null, undefined, 42]) {
    assert.throws(() => assertChannel(unknown), /requires a known channel/, `${unknown} must be refused`);
  }
});

test('an Etsy record carries channel etsy and a Shopify record carries channel shopify', () => {
  const etsyRecord = stampChannel({ listing_id: 111, title: 'Birthday Invitation' }, 'etsy');
  const shopifyRecord = stampChannel({ product_id: 'gid://111', title: 'Birthday Invitation' }, 'shopify');
  assert.strictEqual(getChannel(etsyRecord), 'etsy');
  assert.strictEqual(getChannel(shopifyRecord), 'shopify');
});

test('IDENTICAL TITLES ACROSS CHANNELS STAY TWO RECORDS - nothing is matched by name', () => {
  const etsyRecord = stampChannel({ listing_id: 111, title: 'Birthday Invitation' }, 'etsy');
  const shopifyRecord = stampChannel({ product_id: '111', title: 'Birthday Invitation' }, 'shopify');
  const all = [etsyRecord, shopifyRecord];

  assert.strictEqual(all.length, 2, 'two channels, two records');
  assert.strictEqual(recordsForChannel(all, 'etsy').length, 1);
  assert.strictEqual(recordsForChannel(all, 'shopify').length, 1);
  // The ids look alike and are unrelated. Nothing in this module compares them.
  assert.notStrictEqual(getChannel(etsyRecord), getChannel(shopifyRecord));
});

test('a record already stamped for one channel cannot be re-stamped into another', () => {
  const etsyRecord = stampChannel({ listing_id: 111 }, 'etsy');
  assert.throws(() => stampChannel(etsyRecord, 'shopify'), /refuses to re-stamp/);
  // Re-stamping with the SAME channel is harmless and allowed.
  assert.strictEqual(getChannel(stampChannel(etsyRecord, 'etsy')), 'etsy');
});

test('stampChannel never mutates its input', () => {
  const original = { listing_id: 111 };
  const stamped = stampChannel(original, 'etsy');
  assert.strictEqual(original.channel, undefined, 'the caller\'s object must be untouched');
  assert.strictEqual(stamped.channel, 'etsy');
});

test('an unstamped or wrongly-stamped record reports null - never a guessed default', () => {
  assert.strictEqual(getChannel({ listing_id: 111 }), null);
  assert.strictEqual(getChannel({ channel: 'amazon' }), null);
  assert.strictEqual(getChannel(null), null);
  // Notably NOT 'shopify' just because Shopify came first.
});

test('the native id field names differ and are never translated between', () => {
  assert.strictEqual(channelModel.nativeIdFieldFor('shopify'), 'product_id');
  assert.strictEqual(channelModel.nativeIdFieldFor('etsy'), 'listing_id');
  assert.strictEqual(channelModel.nativeIdFieldFor('amazon'), null);
});

test('NO MERGE, JOIN OR ID-EQUIVALENCE FUNCTION IS EXPORTED - the isolation guarantee', () => {
  const exported = Object.keys(channelModel);
  for (const name of exported) {
    assert.ok(
      !/merge|join|combine|unify|reconcile|equivalen|matchacross|crosschannel|resolveproduct/i.test(name.replace(/_/g, '')),
      `channelModel must not export '${name}' - cross-channel matching is a separate, explicitly-scoped decision`
    );
  }
  assert.deepStrictEqual(exported, [
    'CHANNELS',
    'CHANNEL_FIELD',
    'CHANNEL_NATIVE_ID_FIELDS',
    'isValidChannel',
    'assertChannel',
    'stampChannel',
    'getChannel',
    'recordsForChannel',
    'nativeIdFieldFor',
  ]);
});

test('the Etsy read client stamps every record it returns, and stamps only etsy', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', '..', 'integrations', 'adapters', 'etsyReadClient.js'), 'utf8');
  const code = source.replace(/^\s*\/\/.*$/gm, '');
  assert.ok(code.includes("require('../../agent/core/channelModel')"), 'the read client must use the channel model');
  // Every stamp in the read client uses the ETSY_CHANNEL constant - one use of the
  // constant per stampChannel( call, and no other channel name appears in the code at
  // all - so this module can never stamp a record as Shopify.
  const stampCalls = (code.match(/stampChannel\(/g) || []).length;
  const constantUses = (code.match(/\bETSY_CHANNEL\b/g) || []).length;
  assert.ok(stampCalls > 0, 'the read client must stamp its records');
  assert.ok(
    constantUses >= stampCalls,
    `${stampCalls} stampChannel() call(s) but only ${constantUses} use(s) of ETSY_CHANNEL - a stamp may be hardcoded`
  );
  assert.ok(!/['"]shopify['"]/.test(code), 'the Etsy read client must not name the Shopify channel');
  assert.strictEqual(etsyReadClientChannel(), 'etsy');
});

test('this test file is registered in the suite runner', () => {
  const { TEST_FILES } = require('./runAllTests');
  assert.ok(TEST_FILES.includes('etsyChannelIsolation.test.js'));
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
