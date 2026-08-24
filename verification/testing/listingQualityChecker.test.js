'use strict';

const assert = require('node:assert');
const { checkListingQuality } = require('../../agent/core/listingQualityChecker');
const { createEmptyListingContentRecord } = require('../../agent/core/listingContentModel');
const { createEmptySeoResearchRecord } = require('../../agent/core/seoResearchModel');
const { validateListingQualityCheckShape } = require('../../agent/core/listingQualityCheckModel');

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

function baseListing() {
  return createEmptyListingContentRecord('(Example insulated jacket)');
}

function keyword(text, source = ['(placeholder source)']) {
  const record = createEmptySeoResearchRecord(text);
  record.source = source;
  return record;
}

test('checkListingQuality throws when listingRecord is missing', () => {
  assert.throws(() => checkListingQuality({}), /requires a valid listingContentModel\.js record/);
});

test('checkListingQuality throws when listingRecord is structurally invalid', () => {
  const bad = { not_a_real: 'record' };
  assert.throws(() => checkListingQuality({ listingRecord: bad }), /requires a valid listingContentModel\.js record/);
});

test('checkListingQuality throws when a keyword record is structurally invalid', () => {
  const listingRecord = baseListing();
  assert.throws(
    () => checkListingQuality({ listingRecord, keywordRecords: [{ not_a_real: 'keyword' }] }),
    /invalid keyword record at index 0/
  );
});

test('a completely blank listing reports every dimension empty and a 0% score, never fabricated', () => {
  const listingRecord = baseListing();
  const result = checkListingQuality({ listingRecord });
  for (const dimension of Object.keys(result.dimension_status)) {
    assert.strictEqual(result.dimension_status[dimension], 'empty', `expected ${dimension} to be empty`);
  }
  assert.strictEqual(result.quality_score.percentage, 0);
  assert.strictEqual(result.quality_score.status, 'empty');
});

test('a fully-optimized listing reports success on every dimension and a 100% score', () => {
  const listingRecord = baseListing();
  listingRecord.product_title = 'Insulated Hiking Jacket';
  listingRecord.description = 'A warm, waterproof jacket built for cold weekend hikes and everyday winter wear.';
  listingRecord.benefits = ['Keeps you warm on cold hikes.'];
  listingRecord.features = ['Waterproof shell.'];
  listingRecord.selling_points = ['Lighter than comparable jackets.'];
  listingRecord.faqs = [{ question: 'Is it machine washable?', answer: 'Cold wash only, addresses waterproof concerns too.' }];
  listingRecord.attributes = [{ name: 'material', value: 'ripstop nylon' }];
  listingRecord.variants = [{ variant_reference: '(variant M)', title: 'Medium' }];
  listingRecord.cta = 'Shop the collection now.';

  const result = checkListingQuality({
    listingRecord,
    keywordRecords: [keyword('insulated hiking jacket')],
    factualAttributes: ['waterproof'],
    customerObjections: ['machine washable'],
  });

  for (const dimension of Object.keys(result.dimension_status)) {
    assert.strictEqual(result.dimension_status[dimension], 'success', `expected ${dimension} to be success`);
  }
  assert.strictEqual(result.quality_score.percentage, 100);
  assert.strictEqual(result.quality_score.status, 'success');
  assert.deepStrictEqual(result.dimension_gaps, []);
});

// --- completeness --------------------------------------------------------------------

test('completeness is partial and names each missing essential field', () => {
  const listingRecord = baseListing();
  listingRecord.product_title = 'Insulated Hiking Jacket';
  const result = checkListingQuality({ listingRecord });
  assert.strictEqual(result.dimension_status.completeness, 'partial');
  assert.ok(result.recommendations.some((r) => r.includes('description is missing')));
  assert.ok(result.recommendations.some((r) => r.includes('cta is missing')));
});

// --- clarity --------------------------------------------------------------------------

test('clarity is empty when no title, description, benefits, or features are supplied', () => {
  const listingRecord = baseListing();
  const result = checkListingQuality({ listingRecord });
  assert.strictEqual(result.dimension_status.clarity, 'empty');
});

test('clarity is partial when the title is too short', () => {
  const listingRecord = baseListing();
  listingRecord.product_title = 'Jacket';
  const result = checkListingQuality({ listingRecord });
  assert.strictEqual(result.dimension_status.clarity, 'partial');
});

test('clarity is partial when a benefit/feature item exceeds the conciseness guideline', () => {
  const listingRecord = baseListing();
  listingRecord.benefits = ['x'.repeat(200)];
  const result = checkListingQuality({ listingRecord });
  assert.strictEqual(result.dimension_status.clarity, 'partial');
  assert.ok(result.findings.some((f) => f.includes('exceed 160 characters')));
});

test('clarity never evaluates grammar, tone, or persuasiveness - only structural length', () => {
  const listingRecord = baseListing();
  listingRecord.product_title = 'A Perfectly Fine Title Length Here';
  listingRecord.description = 'A perfectly serviceable description that clears the thin-content guideline easily.';
  const result = checkListingQuality({ listingRecord });
  assert.strictEqual(result.dimension_status.clarity, 'success');
});

// --- accuracy ---------------------------------------------------------------------------

test('accuracy is honestly empty (not a failure) when no factual attributes are supplied', () => {
  const listingRecord = baseListing();
  listingRecord.description = 'Some description text.';
  const result = checkListingQuality({ listingRecord });
  assert.strictEqual(result.dimension_status.accuracy, 'empty');
});

test('accuracy is partial and names exactly the missing attribute', () => {
  const listingRecord = baseListing();
  listingRecord.description = 'A warm jacket for cold weather.';
  const result = checkListingQuality({ listingRecord, factualAttributes: ['waterproof'] });
  assert.strictEqual(result.dimension_status.accuracy, 'partial');
  assert.ok(result.recommendations.some((r) => r.includes('"waterproof" is not mentioned')));
});

test('accuracy never judges truthfulness - only checks literal presence of the caller-supplied attribute string', () => {
  const listingRecord = baseListing();
  listingRecord.description = 'A waterproof jacket for cold weather.';
  const result = checkListingQuality({ listingRecord, factualAttributes: ['waterproof'] });
  assert.strictEqual(result.dimension_status.accuracy, 'success');
});

// --- conversion_quality -----------------------------------------------------------------

test('conversion_quality is empty when nothing relevant is supplied', () => {
  const listingRecord = baseListing();
  const result = checkListingQuality({ listingRecord });
  assert.strictEqual(result.dimension_status.conversion_quality, 'empty');
});

test('conversion_quality is partial when only some conversion elements are present', () => {
  const listingRecord = baseListing();
  listingRecord.cta = 'Buy now.';
  const result = checkListingQuality({ listingRecord });
  assert.strictEqual(result.dimension_status.conversion_quality, 'partial');
});

test('conversion_quality is success when CTA, benefits, and selling points/features are all present', () => {
  const listingRecord = baseListing();
  listingRecord.cta = 'Buy now.';
  listingRecord.benefits = ['Keeps you warm.'];
  listingRecord.features = ['Waterproof shell.'];
  const result = checkListingQuality({ listingRecord });
  assert.strictEqual(result.dimension_status.conversion_quality, 'success');
});

// --- seo_compatibility ------------------------------------------------------------------

test('seo_compatibility is empty when no target keywords are supplied', () => {
  const listingRecord = baseListing();
  const result = checkListingQuality({ listingRecord });
  assert.strictEqual(result.dimension_status.seo_compatibility, 'empty');
});

test('seo_compatibility is partial and names the untargeted keyword', () => {
  const listingRecord = baseListing();
  listingRecord.product_title = 'Insulated Hiking Jacket';
  const result = checkListingQuality({
    listingRecord,
    keywordRecords: [keyword('insulated hiking jacket'), keyword('rain jacket')],
  });
  assert.strictEqual(result.dimension_status.seo_compatibility, 'partial');
  assert.ok(result.recommendations.some((r) => r.includes('"rain jacket" does not appear')));
});

test('seo_compatibility checks title, description, and FAQs', () => {
  const listingRecord = baseListing();
  listingRecord.faqs = [{ question: 'Is the rain jacket waterproof?', answer: 'Yes.' }];
  const result = checkListingQuality({ listingRecord, keywordRecords: [keyword('rain jacket')] });
  assert.strictEqual(result.dimension_status.seo_compatibility, 'success');
});

// --- customer_objections -----------------------------------------------------------------

test('customer_objections is empty when no objections are supplied', () => {
  const listingRecord = baseListing();
  const result = checkListingQuality({ listingRecord });
  assert.strictEqual(result.dimension_status.customer_objections, 'empty');
});

test('customer_objections is partial and names the unaddressed objection', () => {
  const listingRecord = baseListing();
  listingRecord.faqs = [{ question: 'Is it machine washable?', answer: 'Cold wash only.' }];
  const result = checkListingQuality({
    listingRecord,
    customerObjections: ['machine washable', 'too expensive'],
  });
  assert.strictEqual(result.dimension_status.customer_objections, 'partial');
  assert.ok(result.recommendations.some((r) => r.includes('"too expensive" is not addressed')));
});

test('customer_objections is success when every objection is addressed', () => {
  const listingRecord = baseListing();
  listingRecord.description = 'Priced fairly for the quality - built to last for years.';
  const result = checkListingQuality({ listingRecord, customerObjections: ['priced fairly'] });
  assert.strictEqual(result.dimension_status.customer_objections, 'success');
});

// --- missing_information -----------------------------------------------------------------

test('missing_information names every missing field exactly once, across the full record', () => {
  const listingRecord = baseListing();
  listingRecord.product_title = 'Insulated Hiking Jacket';
  const result = checkListingQuality({ listingRecord });
  const missingInfoRecs = result.recommendations.filter((r) => r.startsWith('[Missing information]'));
  assert.strictEqual(missingInfoRecs.length, 8);
  assert.ok(missingInfoRecs.some((r) => r.includes('description is missing')));
  assert.ok(missingInfoRecs.some((r) => r.includes('attributes is missing')));
});

test('missing_information is distinct from completeness - audits optional fields completeness ignores', () => {
  const listingRecord = baseListing();
  listingRecord.product_title = 'Insulated Hiking Jacket';
  listingRecord.description = 'A warm, waterproof jacket for cold hikes and everyday winter wear.';
  listingRecord.benefits = ['Keeps you warm.'];
  listingRecord.features = ['Waterproof shell.'];
  listingRecord.cta = 'Buy now.';
  // Every completeness field is now populated, but selling_points/faqs/attributes/
  // variants are not - completeness should be success while missing_information stays
  // partial, proving the two dimensions are not just aliases of each other.
  const result = checkListingQuality({ listingRecord });
  assert.strictEqual(result.dimension_status.completeness, 'success');
  assert.strictEqual(result.dimension_status.missing_information, 'partial');
});

// --- unsupported_claims -------------------------------------------------------------------

test('unsupported_claims is empty when no description/benefits/features/selling points are supplied', () => {
  const listingRecord = baseListing();
  const result = checkListingQuality({ listingRecord });
  assert.strictEqual(result.dimension_status.unsupported_claims, 'empty');
});

test('unsupported_claims is success when no claim-trigger phrases are found', () => {
  const listingRecord = baseListing();
  listingRecord.description = 'A warm, waterproof jacket for cold hikes.';
  const result = checkListingQuality({ listingRecord });
  assert.strictEqual(result.dimension_status.unsupported_claims, 'success');
});

test('unsupported_claims flags a claim phrase with no backing factual attribute', () => {
  const listingRecord = baseListing();
  listingRecord.description = 'The best jacket you will ever own.';
  const result = checkListingQuality({ listingRecord });
  assert.strictEqual(result.dimension_status.unsupported_claims, 'partial');
  assert.ok(result.recommendations.some((r) => r.includes('"best" appears') || r.includes('The phrase "best"')));
});

test('unsupported_claims is success when every found claim phrase is backed by a factual attribute', () => {
  const listingRecord = baseListing();
  listingRecord.description = 'Rated the best jacket for winter hiking.';
  const result = checkListingQuality({ listingRecord, factualAttributes: ['best jacket for winter hiking (independently verified award)'] });
  assert.strictEqual(result.dimension_status.unsupported_claims, 'success');
});

test('unsupported_claims never judges truthfulness - only checks literal presence and factual-attribute backing', () => {
  const listingRecord = baseListing();
  listingRecord.description = 'Guaranteed to keep you warm.';
  const resultUnbacked = checkListingQuality({ listingRecord });
  assert.strictEqual(resultUnbacked.dimension_status.unsupported_claims, 'partial');
  const resultBacked = checkListingQuality({ listingRecord, factualAttributes: ['guaranteed by a 2-year warranty'] });
  assert.strictEqual(resultBacked.dimension_status.unsupported_claims, 'success');
});

// --- overall result shape / honesty guarantees ---------------------------------------------

test('the result never contains a fabricated conversion/ranking/sales prediction anywhere', () => {
  const listingRecord = baseListing();
  listingRecord.product_title = 'Insulated Hiking Jacket';
  listingRecord.description = 'A warm, waterproof jacket for cold hikes.';
  const result = checkListingQuality({ listingRecord });
  const serialized = JSON.stringify(result).toLowerCase();
  assert.ok(!serialized.includes('will convert'));
  assert.ok(!serialized.includes('will rank'));
  assert.ok(!serialized.includes('sales increase'));
});

test('every recommendation is prefixed with its dimension label for traceability', () => {
  const listingRecord = baseListing();
  const result = checkListingQuality({ listingRecord });
  for (const recommendation of result.recommendations) {
    assert.ok(/^\[[A-Za-z ]+\]/.test(recommendation), `not prefixed: ${recommendation}`);
  }
});

test('checkListingQuality produces a result that passes validateListingQualityCheckShape', () => {
  const listingRecord = baseListing();
  listingRecord.product_title = 'Insulated Hiking Jacket';
  const result = checkListingQuality({ listingRecord });
  const validation = validateListingQualityCheckShape(result);
  assert.strictEqual(validation.valid, true, `expected valid, got errors: ${validation.errors.join(', ')}`);
});

test('source is the flattened union of keyword record source entries', () => {
  const listingRecord = baseListing();
  const result = checkListingQuality({
    listingRecord,
    keywordRecords: [keyword('a', ['src-1']), keyword('b', ['src-2', 'src-3'])],
  });
  assert.deepStrictEqual(result.source, ['src-1', 'src-2', 'src-3']);
});

test('specialized_records carries the full underlying listing and keyword records', () => {
  const listingRecord = baseListing();
  const kw = keyword('insulated hiking jacket');
  const result = checkListingQuality({ listingRecord, keywordRecords: [kw] });
  assert.strictEqual(result.specialized_records.listing_record, listingRecord);
  assert.deepStrictEqual(result.specialized_records.keyword_records, [kw]);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
