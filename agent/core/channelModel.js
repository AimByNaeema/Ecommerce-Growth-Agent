'use strict';

// Channel identity - the rule that keeps two sales channels' records separate.
//
// THE PROBLEM THIS EXISTS TO PREVENT. This project now reads from two unrelated
// platforms: a Shopify store (integrations/adapters/shopifyClient.js) and an Etsy shop
// (integrations/adapters/etsyClient.js). Their records look superficially alike - both
// have a title, a price, an image - and a product can genuinely exist on both. The
// tempting mistake is to treat "same-looking title" as "same thing", merge them, and
// report one number. That would be wrong in a way that is very hard to notice later: a
// Shopify product id and an Etsy listing id are unrelated identifiers in unrelated
// namespaces, and nothing about them can be compared. Any total built on a silent merge
// is a fabricated figure (CLAUDE.md rule 8).
//
// WHAT THIS MODULE DOES. It makes the channel an explicit, validated, non-optional
// property of every cross-channel record, so a record can always answer "which platform
// did this actually come from?" without inference.
//
// WHAT THIS MODULE DELIBERATELY DOES NOT DO. There is no merge function, no
// id-equivalence helper, no fuzzy title matcher, and no "resolve the same product across
// channels" utility - not even a private one. Their absence is the isolation guarantee,
// and verification/testing/etsyChannelIsolation.test.js asserts the module's export list
// to keep it that way. Cross-channel aggregation is a real, useful feature, but it is a
// separate explicitly-scoped decision that must state its own matching rule and its own
// limitations; it is not something this file should quietly grow into.
//
// NOT AN ENUM OF EVERYTHING IMAGINABLE. CHANNELS lists only the platforms this project
// has a real adapter for today. agent/core/marketplaceListingFormatModel.js deliberately
// keeps its own `marketplace` field free-form (a formatting target is not a data source),
// and compliance/compliancePolicy.js's RECOGNIZED_PLATFORMS deliberately names contexts
// it holds no rules for. Those three vocabularies answer different questions and are
// intentionally not merged into one.

// The channels this project can actually read data from, because a real adapter exists.
// A platform joins this list the day its adapter lands, not the day it is discussed.
const CHANNELS = ['shopify', 'etsy'];

// The field every channel-scoped record carries. Named as a constant so a typo in a
// consumer is a reference error rather than a silently-absent property.
const CHANNEL_FIELD = 'channel';

// The native record identifier each channel uses. Present so the difference is
// documented and inspectable - NOT so the two can be translated between. There is
// deliberately no function here that maps one to the other.
const CHANNEL_NATIVE_ID_FIELDS = {
  shopify: 'product_id',
  etsy: 'listing_id',
};

function isValidChannel(channel) {
  return typeof channel === 'string' && CHANNELS.includes(channel);
}

// Throws unless `channel` is one this project has an adapter for. Fails closed on an
// unknown channel rather than passing it through - an unrecognized channel string
// silently flowing into a record is exactly how a record loses its provenance.
function assertChannel(channel, fnName = 'assertChannel') {
  if (!isValidChannel(channel)) {
    throw new Error(
      `${fnName} requires a known channel (${CHANNELS.join(', ')}), received ${JSON.stringify(channel)}. ` +
        'A channel is only recognized once a real adapter for it exists under integrations/adapters/.'
    );
  }
  return channel;
}

// Returns a NEW record carrying its channel. Never mutates the input, and refuses to
// re-stamp a record that already declares a DIFFERENT channel - silently overwriting a
// record's provenance is the single most damaging thing this module could allow, so it
// is an error rather than a last-write-wins.
function stampChannel(record, channel) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    throw new Error('stampChannel requires a record object.');
  }
  assertChannel(channel, 'stampChannel');

  const existing = record[CHANNEL_FIELD];
  if (typeof existing === 'string' && existing !== '' && existing !== channel) {
    throw new Error(
      `stampChannel refuses to re-stamp a record already marked channel '${existing}' as '${channel}'. ` +
        'A record belongs to exactly one channel; changing it would destroy its provenance.'
    );
  }

  return { ...record, [CHANNEL_FIELD]: channel };
}

// The channel a record declares, or null when it declares none. Returns null rather than
// guessing a default - "probably Shopify, since that came first" is precisely the
// assumption this module exists to prevent.
function getChannel(record) {
  if (!record || typeof record !== 'object') return null;
  const value = record[CHANNEL_FIELD];
  return isValidChannel(value) ? value : null;
}

// Filters a mixed list down to one channel's records. This is a SEPARATION helper, not a
// join: it only ever narrows a list, and two calls with different channels can never
// produce a combined record.
function recordsForChannel(records, channel) {
  assertChannel(channel, 'recordsForChannel');
  if (!Array.isArray(records)) return [];
  return records.filter((record) => getChannel(record) === channel);
}

// The native id field name for a channel, for display and documentation. Returns null
// for an unknown channel. It returns a FIELD NAME, never a translated id.
function nativeIdFieldFor(channel) {
  return isValidChannel(channel) ? CHANNEL_NATIVE_ID_FIELDS[channel] : null;
}

module.exports = {
  CHANNELS,
  CHANNEL_FIELD,
  CHANNEL_NATIVE_ID_FIELDS,
  isValidChannel,
  assertChannel,
  stampChannel,
  getChannel,
  recordsForChannel,
  nativeIdFieldFor,
};

if (require.main === module) {
  console.log('Smart E-Commerce Growth AI Agent - channel identity (separation, never merging):\n');
  console.log(`Channels with a real adapter: ${CHANNELS.join(', ')}`);
  for (const channel of CHANNELS) {
    console.log(`  ${channel} -> native record id field: ${nativeIdFieldFor(channel)}`);
  }

  const shopifyRecord = stampChannel({ product_id: '(placeholder)', title: 'Birthday Invitation' }, 'shopify');
  const etsyRecord = stampChannel({ listing_id: '(placeholder)', title: 'Birthday Invitation' }, 'etsy');

  console.log('\nTwo identically-titled records from two channels stay two records:');
  console.log(`  ${JSON.stringify(shopifyRecord)}`);
  console.log(`  ${JSON.stringify(etsyRecord)}`);
  console.log(`  Shopify-only view: ${recordsForChannel([shopifyRecord, etsyRecord], 'shopify').length} record(s)`);
  console.log(`  Etsy-only view:    ${recordsForChannel([shopifyRecord, etsyRecord], 'etsy').length} record(s)`);

  console.log('\nRe-stamping a record into another channel is refused:');
  try {
    stampChannel(etsyRecord, 'shopify');
  } catch (err) {
    console.log(`  ${err.message}`);
  }

  console.log('\nThis module exports no merge, join, or id-equivalence function - by design:');
  console.log(`  ${Object.keys(module.exports).join(', ')}`);
}
