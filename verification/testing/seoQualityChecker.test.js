'use strict';

const assert = require('node:assert');
const { checkSeoQuality } = require('../../agent/core/seoQualityChecker');
const { createEmptyListingOptimizationRecord } = require('../../agent/core/listingOptimizationModel');
const { createEmptySeoResearchRecord } = require('../../agent/core/seoResearchModel');
const { validateSeoQualityCheckShape } = require('../../agent/core/seoQualityCheckModel');

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

function assertValid(result) {
  const validation = validateSeoQualityCheckShape(result);
  assert.strictEqual(validation.valid, true, `expected valid, got errors: ${validation.errors.join(', ')}`);
}

function keywordRecord(keyword, overrides = {}) {
  const record = createEmptySeoResearchRecord(keyword);
  Object.assign(record, overrides);
  return record;
}

// --- input validation -----------------------------------------------------------------

test('checkSeoQuality throws when listingRecord is missing', () => {
  assert.throws(() => checkSeoQuality({}), /requires a valid listingOptimizationModel\.js record/);
});

test('checkSeoQuality throws when listingRecord is structurally invalid', () => {
  const invalid = createEmptyListingOptimizationRecord('sku-1');
  delete invalid.metadata;
  assert.throws(() => checkSeoQuality({ listingRecord: invalid }), /requires a valid listingOptimizationModel\.js record/);
});

test('checkSeoQuality throws when a keyword record is structurally invalid', () => {
  const listing = createEmptyListingOptimizationRecord('sku-1');
  const badKeyword = { keyword: 'x' };
  assert.throws(
    () => checkSeoQuality({ listingRecord: listing, keywordRecords: [badKeyword] }),
    /received an invalid keyword record at index 0/
  );
});

// --- baseline: nothing supplied stays honestly empty, never fabricated -----------------

test('a completely blank listing reports every dimension empty and a 0% score, never fabricated', () => {
  const listing = createEmptyListingOptimizationRecord('sku-1');
  const result = checkSeoQuality({ listingRecord: listing });
  assertValid(result);
  for (const status of Object.values(result.dimension_status)) {
    assert.strictEqual(status, 'empty');
  }
  assert.strictEqual(result.quality_score.percentage, 0);
  assert.strictEqual(result.quality_score.status, 'empty');
  assert.strictEqual(result.dimension_gaps.length, 9);
});

// --- a fully-optimized listing reports success across every dimension -------------------

test('a fully-optimized listing reports success on every dimension and a 100% score', () => {
  const listing = createEmptyListingOptimizationRecord('sku-1');
  listing.product_title = 'Insulated Hiking Jacket for Cold Weather Hikes';
  listing.description = 'A warm, waterproof shell built for long days outdoors, with a fitted hood and reinforced seams.';
  listing.keywords = ['insulated hiking jacket'];
  listing.search_intent = 'commercial investigation';
  listing.headings = [{ level: 'h1', text: 'Built for Cold-Weather Trails' }];
  listing.metadata = {
    meta_title: 'Insulated Hiking Jacket | Store',
    meta_description: 'A warm, waterproof shell for cold-weather hikes, with a fitted hood and reinforced seams for long days outdoors.',
    url_slug: 'insulated-hiking-jacket',
    alt_text: 'Insulated hiking jacket product photo',
  };
  listing.internal_links = [{ anchor_text: 'outdoor apparel collection', target: 'outdoor-apparel' }];
  listing.supporting_content = ['Add a cold-weather layering buying guide.'];

  const keyword = keywordRecord('insulated hiking jacket', { search_intent: 'commercial investigation' });

  const result = checkSeoQuality({
    listingRecord: listing,
    keywordRecords: [keyword],
    factualAttributes: ['waterproof'],
  });
  assertValid(result);
  for (const [dimension, status] of Object.entries(result.dimension_status)) {
    assert.strictEqual(status, 'success', `expected ${dimension} to be success`);
  }
  assert.strictEqual(result.quality_score.percentage, 100);
  assert.strictEqual(result.quality_score.status, 'success');
  assert.deepStrictEqual(result.dimension_gaps, []);
});

// --- keyword_targeting -------------------------------------------------------------------

test('keyword_targeting is empty when no target keywords are supplied', () => {
  const listing = createEmptyListingOptimizationRecord('sku-1');
  const result = checkSeoQuality({ listingRecord: listing });
  assert.strictEqual(result.dimension_status.keyword_targeting, 'empty');
});

test('keyword_targeting is partial and names the untargeted keyword', () => {
  const listing = createEmptyListingOptimizationRecord('sku-1');
  listing.product_title = 'Insulated Hiking Jacket';
  const result = checkSeoQuality({
    listingRecord: listing,
    keywordRecords: [keywordRecord('insulated hiking jacket'), keywordRecord('waterproof hiking boots')],
  });
  assert.strictEqual(result.dimension_status.keyword_targeting, 'partial');
  assert.ok(result.recommendations.some((r) => r.includes('"waterproof hiking boots" does not appear')));
  assert.ok(!result.recommendations.some((r) => r.includes('"insulated hiking jacket" does not appear')));
});

// --- search_intent -------------------------------------------------------------------------

test('search_intent is empty when unset', () => {
  const listing = createEmptyListingOptimizationRecord('sku-1');
  const result = checkSeoQuality({ listingRecord: listing });
  assert.strictEqual(result.dimension_status.search_intent, 'empty');
});

test('search_intent is partial when it does not align with any target keyword\'s intent', () => {
  const listing = createEmptyListingOptimizationRecord('sku-1');
  listing.search_intent = 'transactional';
  const result = checkSeoQuality({
    listingRecord: listing,
    keywordRecords: [keywordRecord('x', { search_intent: 'informational' })],
  });
  assert.strictEqual(result.dimension_status.search_intent, 'partial');
});

// --- title -----------------------------------------------------------------------------------

test('title is empty when missing', () => {
  const listing = createEmptyListingOptimizationRecord('sku-1');
  const result = checkSeoQuality({ listingRecord: listing });
  assert.strictEqual(result.dimension_status.title, 'empty');
  assert.ok(result.recommendations.some((r) => r.includes('Add a product title')));
});

test('title is partial when too short', () => {
  const listing = createEmptyListingOptimizationRecord('sku-1');
  listing.product_title = 'Jacket';
  const result = checkSeoQuality({ listingRecord: listing });
  assert.strictEqual(result.dimension_status.title, 'partial');
  assert.ok(result.findings.some((f) => f.includes('conventional guideline: 15-60')));
});

test('title is partial when too long', () => {
  const listing = createEmptyListingOptimizationRecord('sku-1');
  listing.product_title = 'A'.repeat(75);
  const result = checkSeoQuality({ listingRecord: listing });
  assert.strictEqual(result.dimension_status.title, 'partial');
});

// --- metadata --------------------------------------------------------------------------------

test('metadata is partial when only some sub-fields are populated', () => {
  const listing = createEmptyListingOptimizationRecord('sku-1');
  listing.metadata.meta_title = 'Insulated Hiking Jacket | Store';
  const result = checkSeoQuality({ listingRecord: listing });
  assert.strictEqual(result.dimension_status.metadata, 'partial');
  assert.ok(result.recommendations.some((r) => r.includes('Add a meta_description')));
  assert.ok(result.recommendations.some((r) => r.includes('Add a url_slug')));
});

test('metadata flags a meta_description outside the conventional length guideline', () => {
  const listing = createEmptyListingOptimizationRecord('sku-1');
  listing.metadata.meta_title = 'Insulated Hiking Jacket | Store';
  listing.metadata.meta_description = 'Too short.';
  listing.metadata.url_slug = 'insulated-hiking-jacket';
  const result = checkSeoQuality({ listingRecord: listing });
  assert.strictEqual(result.dimension_status.metadata, 'partial');
  assert.ok(result.findings.some((f) => f.includes('conventional guideline: 50-160')));
});

// --- content_quality ---------------------------------------------------------------------------

test('content_quality flags a description below the thin-content length guideline', () => {
  const listing = createEmptyListingOptimizationRecord('sku-1');
  listing.description = 'Too short.';
  const result = checkSeoQuality({ listingRecord: listing });
  assert.strictEqual(result.dimension_status.content_quality, 'partial');
  assert.ok(result.findings.some((f) => f.includes('below the 40-character thin-content guideline')));
});

test('content_quality never evaluates grammar, tone, or persuasiveness - only structural presence/length', () => {
  const listing = createEmptyListingOptimizationRecord('sku-1');
  listing.description = 'colorless green ideas sleep furiously, this makes no sense grammatically or persuasively';
  const result = checkSeoQuality({ listingRecord: listing });
  // A structurally-long-enough description passes, regardless of whether it reads
  // sensibly - this module has no grammar/tone/persuasiveness judgment at all.
  assert.ok(result.findings.some((f) => f.includes('Description is present and at least 40 characters')));
});

// --- product_accuracy --------------------------------------------------------------------------

test('product_accuracy is honestly empty (not a failure) when no factual attributes are supplied', () => {
  const listing = createEmptyListingOptimizationRecord('sku-1');
  listing.description = 'A warm, waterproof jacket.';
  const result = checkSeoQuality({ listingRecord: listing });
  assert.strictEqual(result.dimension_status.product_accuracy, 'empty');
  assert.ok(!result.recommendations.some((r) => r.startsWith('[Product accuracy]')));
});

test('product_accuracy is partial and names exactly the missing attribute', () => {
  const listing = createEmptyListingOptimizationRecord('sku-1');
  listing.description = 'A warm, waterproof jacket.';
  const result = checkSeoQuality({ listingRecord: listing, factualAttributes: ['waterproof', '600-fill down'] });
  assert.strictEqual(result.dimension_status.product_accuracy, 'partial');
  assert.ok(result.recommendations.some((r) => r.includes('"600-fill down" is not mentioned')));
  assert.ok(!result.recommendations.some((r) => r.includes('"waterproof" is not mentioned')));
});

test('product_accuracy never judges truthfulness - only checks literal presence of the caller-supplied attribute string', () => {
  const listing = createEmptyListingOptimizationRecord('sku-1');
  listing.description = 'This jacket is not waterproof at all.';
  const result = checkSeoQuality({ listingRecord: listing, factualAttributes: ['waterproof'] });
  // The word appears literally, so it's counted present - this module cannot and does
  // not detect negation/contradiction, only literal presence.
  assert.strictEqual(result.dimension_status.product_accuracy, 'success');
});

// --- missing_information -----------------------------------------------------------------------

test('missing_information names every missing field exactly once', () => {
  const listing = createEmptyListingOptimizationRecord('sku-1');
  listing.product_title = 'Insulated Hiking Jacket';
  listing.keywords = ['insulated hiking jacket'];
  const result = checkSeoQuality({ listingRecord: listing });
  assert.strictEqual(result.dimension_status.missing_information, 'partial');
  assert.ok(result.recommendations.some((r) => r.includes('description is missing')));
  assert.ok(result.recommendations.some((r) => r.includes('metadata.meta_title is missing')));
  assert.ok(result.recommendations.some((r) => r.includes('headings is missing')));
  assert.ok(!result.recommendations.some((r) => r.includes('product_title is missing')));
});

// --- over_optimization -------------------------------------------------------------------------

test('over_optimization is empty (nothing to check) when no target keywords are supplied', () => {
  const listing = createEmptyListingOptimizationRecord('sku-1');
  const result = checkSeoQuality({ listingRecord: listing });
  assert.strictEqual(result.dimension_status.over_optimization, 'empty');
});

test('over_optimization flags a keyword repeated beyond the occurrence threshold', () => {
  const listing = createEmptyListingOptimizationRecord('sku-1');
  listing.product_title = 'jacket jacket jacket jacket';
  listing.description = 'jacket jacket';
  const result = checkSeoQuality({ listingRecord: listing, keywordRecords: [keywordRecord('jacket')] });
  assert.ok(result.recommendations.some((r) => r.includes('appears 6 times') && r.includes('keyword stuffing')));
});

test('over_optimization is success when every keyword stays within the threshold', () => {
  const listing = createEmptyListingOptimizationRecord('sku-1');
  listing.product_title = 'Insulated Hiking Jacket';
  listing.description = 'A warm jacket for cold hikes.';
  const result = checkSeoQuality({ listingRecord: listing, keywordRecords: [keywordRecord('insulated hiking jacket')] });
  assert.strictEqual(result.dimension_status.over_optimization, 'success');
});

// --- internal_linking_opportunities --------------------------------------------------------------

test('internal_linking_opportunities is empty when no links are suggested', () => {
  const listing = createEmptyListingOptimizationRecord('sku-1');
  const result = checkSeoQuality({ listingRecord: listing });
  assert.strictEqual(result.dimension_status.internal_linking_opportunities, 'empty');
  assert.ok(result.recommendations.some((r) => r.includes('Suggest at least one internal link')));
});

test('internal_linking_opportunities is partial when a suggested link is incomplete', () => {
  const listing = createEmptyListingOptimizationRecord('sku-1');
  listing.internal_links = [{ anchor_text: '', target: 'outdoor-apparel' }];
  const result = checkSeoQuality({ listingRecord: listing });
  assert.strictEqual(result.dimension_status.internal_linking_opportunities, 'partial');
});

test('internal_linking_opportunities is success when every suggested link is complete', () => {
  const listing = createEmptyListingOptimizationRecord('sku-1');
  listing.internal_links = [{ anchor_text: 'outdoor apparel', target: 'outdoor-apparel' }];
  const result = checkSeoQuality({ listingRecord: listing });
  assert.strictEqual(result.dimension_status.internal_linking_opportunities, 'success');
});

// --- honesty: no fabricated ranking/performance claim anywhere -------------------------------------

test('the result never contains a fabricated ranking/traffic/performance prediction anywhere', () => {
  const listing = createEmptyListingOptimizationRecord('sku-1');
  const result = checkSeoQuality({ listingRecord: listing });
  const serialized = JSON.stringify(result).toLowerCase();
  for (const bannedTerm of ['rank #', 'will rank', 'traffic increase', 'ranking_prediction', 'guaranteed']) {
    assert.ok(!serialized.includes(bannedTerm), `result must not contain "${bannedTerm}"`);
  }
});

test('every recommendation is prefixed with its dimension label for traceability', () => {
  const listing = createEmptyListingOptimizationRecord('sku-1');
  const result = checkSeoQuality({ listingRecord: listing });
  for (const recommendation of result.recommendations) {
    assert.ok(/^\[[A-Za-z -]+\]/.test(recommendation), `"${recommendation}" is missing a [Dimension] prefix`);
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
