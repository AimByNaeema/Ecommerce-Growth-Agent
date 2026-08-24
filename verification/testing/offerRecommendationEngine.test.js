'use strict';

const assert = require('node:assert');
const { generateOfferRecommendations } = require('../../agent/core/offerRecommendationEngine');

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

test('throws when productReference is missing', () => {
  assert.throws(() => generateOfferRecommendations({}), /requires a non-empty `productReference`/);
});

test('every dimension defaults to empty when nothing is supplied', () => {
  const result = generateOfferRecommendations({ productReference: '(example)' });
  for (const status of Object.values(result.dimension_status)) {
    assert.strictEqual(status, 'empty');
  }
  assert.strictEqual(result.coverage_score.status, 'empty');
  assert.strictEqual(result.confidence, 'unassessed');
  assert.strictEqual(result.missing_information.length, 7);
});

test('throws on a relatedProducts entry with an invalid relationship', () => {
  assert.throws(
    () =>
      generateOfferRecommendations({
        productReference: '(example)',
        relatedProducts: [{ productReference: '(other)', relationship: 'not_a_real_relationship' }],
      }),
    /relationship to be one of/
  );
});

test('throws on a relatedProducts entry missing productReference', () => {
  assert.throws(
    () =>
      generateOfferRecommendations({
        productReference: '(example)',
        relatedProducts: [{ relationship: 'bundle_candidate' }],
      }),
    /relatedProducts\[0\]\.productReference/
  );
});

test('bundle: success when an evidenced bundle_candidate is supplied', () => {
  const result = generateOfferRecommendations({
    productReference: '(jacket)',
    relatedProducts: [{ productReference: '(hat)', relationship: 'bundle_candidate', evidence: ['co-purchase data'] }],
  });
  assert.strictEqual(result.dimension_status.bundle, 'success');
  assert.ok(result.recommendations.some((r) => r.includes('Bundle "(jacket)" with "(hat)"')));
});

test('bundle: partial when a bundle_candidate has no evidence', () => {
  const result = generateOfferRecommendations({
    productReference: '(jacket)',
    relatedProducts: [{ productReference: '(hat)', relationship: 'bundle_candidate' }],
  });
  assert.strictEqual(result.dimension_status.bundle, 'partial');
  assert.ok(result.missing_information.some((m) => m.dimension === 'bundle'));
});

test('upsell only matches higher_tier relationships, not bundle_candidate or complementary', () => {
  const result = generateOfferRecommendations({
    productReference: '(jacket)',
    relatedProducts: [
      { productReference: '(hat)', relationship: 'bundle_candidate', evidence: ['x'] },
      { productReference: '(gloves)', relationship: 'complementary', evidence: ['x'] },
    ],
  });
  assert.strictEqual(result.dimension_status.upsell, 'empty');
});

test('cross_sell matches both complementary and accessory relationships', () => {
  const result = generateOfferRecommendations({
    productReference: '(jacket)',
    relatedProducts: [
      { productReference: '(gloves)', relationship: 'complementary', evidence: ['x'] },
      { productReference: '(scarf)', relationship: 'accessory', evidence: ['y'] },
    ],
  });
  assert.strictEqual(result.dimension_status.cross_sell, 'success');
  assert.ok(result.recommendations.some((r) => r.includes('(gloves)')));
  assert.ok(result.recommendations.some((r) => r.includes('(scarf)')));
});

test('discount: empty when neither pricing nor discountConstraints are supplied', () => {
  const result = generateOfferRecommendations({ productReference: '(jacket)' });
  assert.strictEqual(result.dimension_status.discount, 'empty');
});

test('discount: partial when pricing is supplied but discountConstraints is not', () => {
  const result = generateOfferRecommendations({
    productReference: '(jacket)',
    pricing: { currency: 'USD', cost: 35, price: 100 },
  });
  assert.strictEqual(result.dimension_status.discount, 'partial');
});

test('discount: computes a correct capped discount percentage from margin math', () => {
  const result = generateOfferRecommendations({
    productReference: '(jacket)',
    pricing: { currency: 'USD', cost: 35, price: 100 },
    discountConstraints: { minMarginPercent: 40, maxDiscountPercent: 25 },
  });
  // margin = (100-35)/100 = 65%; room = 65-40 = 25%; cap = min(25, 25) = 25%
  assert.strictEqual(result.dimension_status.discount, 'success');
  assert.ok(result.findings.some((f) => f.includes('65.0%')));
  assert.ok(result.recommendations.some((r) => r.includes('up to 25.0%')));
});

test('discount: recommends no discount when margin room is negative', () => {
  const result = generateOfferRecommendations({
    productReference: '(jacket)',
    pricing: { currency: 'USD', cost: 80, price: 100 },
    discountConstraints: { minMarginPercent: 40 },
  });
  // margin = 20%, which is already below the 40% floor - no room for a discount
  assert.strictEqual(result.dimension_status.discount, 'success');
  assert.ok(result.recommendations.some((r) => r.includes('No discount is currently supportable')));
});

test('incentive: relays a real, evidenced incentive without inventing one', () => {
  const result = generateOfferRecommendations({
    productReference: '(jacket)',
    incentiveOptions: [{ incentive: 'Free shipping over $75', evidence: ['business.yaml'] }],
  });
  assert.strictEqual(result.dimension_status.incentive, 'success');
  assert.ok(result.recommendations.some((r) => r.includes('Free shipping over $75')));
});

test('value_proposition: an unevidenced statement with a claim phrase is flagged as unsupported', () => {
  const result = generateOfferRecommendations({
    productReference: '(jacket)',
    valuePropositions: [{ statement: 'The best jacket you will ever own.' }],
  });
  assert.strictEqual(result.dimension_status.value_proposition, 'partial');
  assert.ok(result.unsupported_claims_flagged.some((c) => c.includes('"best"')));
});

test('value_proposition: an evidenced statement with a claim phrase is NOT flagged', () => {
  const result = generateOfferRecommendations({
    productReference: '(jacket)',
    valuePropositions: [{ statement: 'Guaranteed waterproof to 10,000mm.', evidence: ['lab test report'] }],
  });
  assert.strictEqual(result.dimension_status.value_proposition, 'success');
  assert.strictEqual(result.unsupported_claims_flagged.length, 0);
});

test('value_proposition: a plain statement with no claim phrase is never flagged even without evidence', () => {
  const result = generateOfferRecommendations({
    productReference: '(jacket)',
    valuePropositions: [{ statement: 'Made from recycled polyester.' }],
  });
  assert.strictEqual(result.unsupported_claims_flagged.length, 0);
});

test('objection_handling: empty response is not counted as evidenced and is recommended for follow-up', () => {
  const result = generateOfferRecommendations({
    productReference: '(jacket)',
    objections: [{ objection: 'Is it too expensive?' }],
  });
  assert.strictEqual(result.dimension_status.objection_handling, 'partial');
  assert.ok(result.recommendations.some((r) => r.includes('has no response yet')));
});

test('objection_handling: an unevidenced response with a claim phrase is flagged as unsupported', () => {
  const result = generateOfferRecommendations({
    productReference: '(jacket)',
    objections: [{ objection: 'Will it last?', response: 'It is guaranteed to last a lifetime.' }],
  });
  assert.ok(result.unsupported_claims_flagged.some((c) => c.includes('"guaranteed"')));
});

test('objection_handling: an evidenced response is not flagged', () => {
  const result = generateOfferRecommendations({
    productReference: '(jacket)',
    objections: [{ objection: 'Will it last?', response: 'It is guaranteed to last a lifetime.', evidence: ['warranty policy'] }],
  });
  assert.strictEqual(result.dimension_status.objection_handling, 'success');
  assert.strictEqual(result.unsupported_claims_flagged.length, 0);
});

test('coverage_score and confidence reflect the mix of dimension statuses', () => {
  const result = generateOfferRecommendations({
    productReference: '(jacket)',
    pricing: { currency: 'USD', cost: 35, price: 100 },
    discountConstraints: { minMarginPercent: 40 },
    incentiveOptions: [{ incentive: 'Free shipping', evidence: ['business.yaml'] }],
  });
  // discount + incentive = success (2/7); everything else empty
  assert.strictEqual(result.coverage_score.dimensions_success, 2);
  assert.strictEqual(result.coverage_score.dimensions_empty, 5);
  assert.strictEqual(result.coverage_score.percentage, Math.round((2 / 7) * 100));
  assert.strictEqual(result.confidence, 'low');
});

test('confidence is high only when every dimension is success', () => {
  const result = generateOfferRecommendations({
    productReference: '(jacket)',
    pricing: { currency: 'USD', cost: 35, price: 100 },
    discountConstraints: { minMarginPercent: 40 },
    relatedProducts: [
      { productReference: '(hat)', relationship: 'bundle_candidate', evidence: ['x'] },
      { productReference: '(premium jacket)', relationship: 'higher_tier', evidence: ['x'] },
      { productReference: '(gloves)', relationship: 'complementary', evidence: ['x'] },
    ],
    incentiveOptions: [{ incentive: 'Free shipping', evidence: ['x'] }],
    valuePropositions: [{ statement: 'Made from recycled polyester.', evidence: ['x'] }],
    objections: [{ objection: 'Too expensive?', response: 'Priced at premium tier.', evidence: ['x'] }],
  });
  assert.strictEqual(result.coverage_score.status, 'success');
  assert.strictEqual(result.confidence, 'high');
});

test('evidence field flattens evidence from every entry across all dimensions', () => {
  const result = generateOfferRecommendations({
    productReference: '(jacket)',
    relatedProducts: [{ productReference: '(hat)', relationship: 'bundle_candidate', evidence: ['co-purchase data'] }],
    incentiveOptions: [{ incentive: 'Free shipping', evidence: ['business.yaml'] }],
  });
  assert.ok(result.evidence.includes('co-purchase data'));
  assert.ok(result.evidence.includes('business.yaml'));
});

test('never invents a product, discount percentage, incentive, or claim beyond what was supplied', () => {
  const result = generateOfferRecommendations({
    productReference: '(jacket)',
    pricing: { currency: 'USD', cost: 35, price: 100 },
    discountConstraints: { minMarginPercent: 40, maxDiscountPercent: 25 },
  });
  const serialized = JSON.stringify(result);
  // no fabricated dollar amount, only the caller-supplied cost/price appear
  assert.ok(!serialized.includes('$'));
  assert.strictEqual(result.specialized_records.related_products.length, 0);
  assert.strictEqual(result.specialized_records.incentive_options.length, 0);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
