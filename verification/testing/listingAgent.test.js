'use strict';

const assert = require('node:assert');
const {
  generateListingContent,
  formatForMarketplace,
  runListingAgent,
  retrieveListingData,
} = require('../../agent/core/listingAgent');
const { validateListingAgentResultShape } = require('../../agent/core/listingAgentResultModel');

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

test('generateListingContent requires a non-empty productReference', () => {
  assert.throws(() => generateListingContent({}), /requires a non-empty `productReference`/);
});

test('generateListingContent produces a valid, correctly-capabilitied result', () => {
  const result = generateListingContent({ productReference: '(Example jacket)' });
  assert.strictEqual(result.capability, 'listing_content');
  const validation = validateListingAgentResultShape(result);
  assert.strictEqual(validation.valid, true, `expected valid, got errors: ${validation.errors.join(', ')}`);
});

test('generateListingContent composes all 10 requested content categories into one record', () => {
  const result = generateListingContent({
    productReference: '(Example jacket)',
    productTitle: 'Insulated Hiking Jacket',
    description: 'Warm, waterproof jacket for cold hikes.',
    benefits: ['Keeps you warm on cold hikes.'],
    features: ['Waterproof shell.'],
    sellingPoints: ['Lighter than comparable jackets.'],
    faqs: [{ question: 'Is it machine washable?', answer: 'Cold wash only.' }],
    attributes: [{ name: 'material', value: 'ripstop nylon' }],
    variants: [{ variant_reference: '(Example variant: size M)', title: 'Medium' }],
    cta: 'Shop the collection now.',
  });
  const record = result.specialized_records[0];
  assert.strictEqual(record.product_title, 'Insulated Hiking Jacket');
  assert.strictEqual(record.description, 'Warm, waterproof jacket for cold hikes.');
  assert.deepStrictEqual(record.benefits, ['Keeps you warm on cold hikes.']);
  assert.deepStrictEqual(record.features, ['Waterproof shell.']);
  assert.deepStrictEqual(record.selling_points, ['Lighter than comparable jackets.']);
  assert.deepStrictEqual(record.faqs, [{ question: 'Is it machine washable?', answer: 'Cold wash only.' }]);
  assert.deepStrictEqual(record.attributes, [{ name: 'material', value: 'ripstop nylon' }]);
  assert.deepStrictEqual(record.variants, [{ variant_reference: '(Example variant: size M)', title: 'Medium' }]);
  assert.strictEqual(record.cta, 'Shop the collection now.');
});

// --- Structured ecommerce listing generation: multi-source composition -------------

test('generateListingContent derives title from seoRecommendations when no explicit productTitle is given', () => {
  const result = generateListingContent({
    productReference: '(Example jacket)',
    seoRecommendations: { product_title: 'SEO-recommended title', description: 'SEO-recommended description.' },
  });
  const record = result.specialized_records[0];
  assert.strictEqual(record.product_title, 'SEO-recommended title');
  assert.strictEqual(record.description, 'SEO-recommended description.');
});

test('generateListingContent prefers an explicit productTitle/description over seoRecommendations', () => {
  const result = generateListingContent({
    productReference: '(Example jacket)',
    productTitle: 'Explicit title',
    description: 'Explicit description.',
    seoRecommendations: { product_title: 'SEO-recommended title', description: 'SEO-recommended description.' },
  });
  const record = result.specialized_records[0];
  assert.strictEqual(record.product_title, 'Explicit title');
  assert.strictEqual(record.description, 'Explicit description.');
});

test('generateListingContent falls back to productInfo.description when nothing else supplies a description', () => {
  const result = generateListingContent({
    productReference: '(Example jacket)',
    productInfo: { description: 'Product-info description.' },
  });
  const record = result.specialized_records[0];
  assert.strictEqual(record.description, 'Product-info description.');
});

test('generateListingContent derives cta from brandInfo.tagline when no explicit cta is given', () => {
  const result = generateListingContent({
    productReference: '(Example jacket)',
    brandInfo: { name: 'Example brand', tagline: 'Gear up. Head out.', tone: 'friendly' },
  });
  const record = result.specialized_records[0];
  assert.strictEqual(record.cta, 'Gear up. Head out.');
});

test('generateListingContent never invents a title/description/CTA when no source supplies one', () => {
  const result = generateListingContent({ productReference: '(Example jacket)' });
  const record = result.specialized_records[0];
  assert.strictEqual(record.product_title, '');
  assert.strictEqual(record.description, '');
  assert.strictEqual(record.cta, '');
});

test('generateListingContent reports missing information by name for every absent structured source', () => {
  const result = generateListingContent({ productReference: '(Example jacket)' });
  assert.ok(result.limitations.includes('No product information was supplied.'));
  assert.ok(result.limitations.includes('No target market was supplied.'));
  assert.ok(result.limitations.includes('No customer segment was supplied.'));
  assert.ok(result.limitations.includes('No SEO recommendations were supplied.'));
  assert.ok(result.limitations.includes('No brand information was supplied.'));
});

test('generateListingContent reports no missing structured-source information once all 5 sources are supplied', () => {
  const result = generateListingContent({
    productReference: '(Example jacket)',
    productInfo: { description: 'x' },
    targetMarket: 'European Union',
    customerSegment: { segment_definition: 'Weekend hikers' },
    seoRecommendations: { product_title: 'x' },
    brandInfo: { name: 'Example brand', tagline: 'x' },
  });
  assert.ok(!result.limitations.includes('No product information was supplied.'));
  assert.ok(!result.limitations.includes('No target market was supplied.'));
  assert.ok(!result.limitations.includes('No customer segment was supplied.'));
  assert.ok(!result.limitations.includes('No SEO recommendations were supplied.'));
  assert.ok(!result.limitations.includes('No brand information was supplied.'));
});

test('generateListingContent surfaces targetMarket as the result market', () => {
  const result = generateListingContent({ productReference: '(Example jacket)', targetMarket: 'European Union' });
  assert.strictEqual(result.market, 'European Union');
});

test('generateListingContent surfaces customer segment needs/motivations as findings, never as invented benefits', () => {
  const result = generateListingContent({
    productReference: '(Example jacket)',
    customerSegment: {
      segment_definition: 'Weekend hikers',
      needs: ['Reliable warmth'],
      buying_motivations: ['Upcoming trip'],
    },
  });
  assert.ok(result.findings.includes('Customer segment: Weekend hikers'));
  assert.ok(result.findings.includes('Customer segment need: Reliable warmth'));
  assert.ok(result.findings.includes('Customer segment buying motivation: Upcoming trip'));
  assert.deepStrictEqual(result.specialized_records[0].benefits, []);
});

test('generateListingContent surfaces SEO-recommended keywords as findings without altering title/description precedence', () => {
  const result = generateListingContent({
    productReference: '(Example jacket)',
    productTitle: 'Explicit title',
    seoRecommendations: { keywords: ['insulated hiking jacket'] },
  });
  assert.ok(result.findings.includes('SEO-recommended keyword: insulated hiking jacket'));
  assert.strictEqual(result.specialized_records[0].product_title, 'Explicit title');
});

test('generateListingContent never invents a feature/attribute/variant that was not supplied', () => {
  const result = generateListingContent({ productReference: '(Example jacket)' });
  const record = result.specialized_records[0];
  assert.deepStrictEqual(record.features, []);
  assert.deepStrictEqual(record.attributes, []);
  assert.deepStrictEqual(record.variants, []);
});

test('generateListingContent result states no product specification is invented and nothing is auto-published', () => {
  const result = generateListingContent({ productReference: '(Example jacket)' });
  assert.ok(
    result.limitations.some((l) => l.includes('No product specification is invented or altered'))
  );
  assert.ok(
    result.limitations.some((l) => l.includes('requires a separate, human-approved action'))
  );
});

test('generateListingContent reports empty when no evidence is supplied', () => {
  const result = generateListingContent({ productReference: '(Example jacket)' });
  assert.ok(result.limitations.some((l) => l.startsWith('No evidence was supplied for')));
});

test('generateListingContent surfaces supplied evidence/source', () => {
  const result = generateListingContent({
    productReference: '(Example jacket)',
    evidence: [{ topic: 'Spec sheet', finding: 'Shell fabric is ripstop nylon.', source: ['spec-sheet-1'] }],
  });
  assert.deepStrictEqual(result.evidence, ['Shell fabric is ripstop nylon.']);
  assert.deepStrictEqual(result.source, ['spec-sheet-1']);
});

test('formatForMarketplace requires a non-empty marketplace and productReference', () => {
  assert.throws(() => formatForMarketplace({ productReference: 'x' }), /requires a non-empty `marketplace`/);
  assert.throws(() => formatForMarketplace({ marketplace: 'etsy' }), /requires a non-empty `productReference`/);
});

test('formatForMarketplace truncates title/description per supplied constraints and records what changed', () => {
  const result = formatForMarketplace({
    marketplace: 'etsy',
    productReference: '(Example jacket)',
    sourceListing: { productTitle: '0123456789', description: 'a short description' },
    constraints: { maxTitleLength: 5 },
  });
  const record = result.specialized_records[0];
  assert.strictEqual(record.formatted_title, '01234');
  assert.strictEqual(record.formatted_description, 'a short description');
  assert.ok(record.format_constraints_applied.some((c) => c.includes('Title truncated to 5 characters')));
});

test('formatForMarketplace never generates new content - only echoes source content when no constraints are supplied', () => {
  const result = formatForMarketplace({
    marketplace: 'etsy',
    productReference: '(Example jacket)',
    sourceListing: { productTitle: 'Insulated Hiking Jacket', description: 'A warm jacket.' },
  });
  const record = result.specialized_records[0];
  assert.strictEqual(record.formatted_title, 'Insulated Hiking Jacket');
  assert.strictEqual(record.formatted_description, 'A warm jacket.');
  assert.deepStrictEqual(record.format_constraints_applied, []);
  assert.ok(result.limitations.some((l) => l.startsWith('No format constraints were supplied')));
});

test('formatForMarketplace carries formatted_attributes through unchanged from the source listing', () => {
  const result = formatForMarketplace({
    marketplace: 'etsy',
    productReference: '(Example jacket)',
    sourceListing: { attributes: [{ name: 'material', value: 'ripstop nylon' }] },
  });
  const record = result.specialized_records[0];
  assert.deepStrictEqual(record.formatted_attributes, [{ name: 'material', value: 'ripstop nylon' }]);
});

test('marketplace field is free-form - an unlisted marketplace name is accepted, not rejected', () => {
  const result = formatForMarketplace({
    marketplace: 'a brand new marketplace nobody coded for',
    productReference: '(Example jacket)',
  });
  assert.strictEqual(result.specialized_records[0].marketplace, 'a brand new marketplace nobody coded for');
});

test('runListingAgent dispatches by capability', () => {
  const result = runListingAgent({ capability: 'listing_content', productReference: '(Example jacket)' });
  assert.strictEqual(result.capability, 'listing_content');
});

test('runListingAgent throws on an unknown capability', () => {
  assert.throws(() => runListingAgent({ capability: 'not_a_real_capability' }), /Unknown Listing capability/);
});

test('retrieveListingData delegates generic-kind entries to researchAgent.js', () => {
  const records = retrieveListingData(
    'generic',
    [{ topic: 'Spec sheet', finding: 'Shell fabric is ripstop nylon.', source: ['spec-sheet-1'] }],
    'test'
  );
  assert.strictEqual(records.length, 1);
  assert.strictEqual(records[0].finding, 'Shell fabric is ripstop nylon.');
});

test('retrieveListingData throws on an unknown record kind', () => {
  assert.throws(() => retrieveListingData('not_a_real_kind', [], 'test'), /unknown record kind/);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
