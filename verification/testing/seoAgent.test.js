'use strict';

const assert = require('node:assert');
const {
  runKeywordResearch,
  analyzeSearchIntent,
  analyzeProductSeo,
  analyzeCollectionSeo,
  analyzeContentSeo,
  analyzeOnPageSeo,
  analyzeSeoOpportunities,
  runSeoAgent,
  retrieveSeoData,
} = require('../../agent/core/seoAgent');
const { validateSeoAgentResultShape } = require('../../agent/core/seoAgentResultModel');

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
  const validation = validateSeoAgentResultShape(result);
  assert.strictEqual(validation.valid, true, `expected valid, got errors: ${validation.errors.join(', ')}`);
}

// --- runKeywordResearch --------------------------------------------------------------

test('runKeywordResearch requires a non-empty keywords array', () => {
  assert.throws(() => runKeywordResearch({}), /requires a non-empty `keywords`/);
});

test('runKeywordResearch requires each entry to have a keyword', () => {
  assert.throws(() => runKeywordResearch({ keywords: [{}] }), /requires a non-empty `keyword`/);
});

test('runKeywordResearch composes opportunity/competition into findings and source into evidence trail', () => {
  const result = runKeywordResearch({
    market: 'European Union',
    keywords: [
      {
        keyword: 'insulated hiking jacket',
        opportunity: 'Rising interest',
        competition: 'Moderate',
        source: ['listing page'],
      },
    ],
  });
  assertValid(result);
  assert.strictEqual(result.capability, 'keyword_research');
  assert.strictEqual(result.market, 'European Union');
  assert.ok(result.findings.includes('Rising interest'));
  assert.ok(result.findings.includes('Moderate'));
  assert.deepStrictEqual(result.source, ['listing page']);
  assert.strictEqual(result.specialized_records.length, 1);
});

test('runKeywordResearch with no source stays unassessed/unverified and reports a limitation', () => {
  const result = runKeywordResearch({ keywords: [{ keyword: 'lightweight rain jacket' }] });
  assertValid(result);
  assert.strictEqual(result.confidence, 'unassessed');
  assert.strictEqual(result.verification_status, 'unverified');
  assert.ok(result.limitations.some((l) => l.includes('No evidence was supplied for lightweight rain jacket')));
});

test('runKeywordResearch never invents recommendations', () => {
  const result = runKeywordResearch({ keywords: [{ keyword: 'x' }] });
  assertValid(result);
  assert.deepStrictEqual(result.recommendations, []);
});

test('runKeywordResearch passes through caller-supplied recommendations unchanged', () => {
  const result = runKeywordResearch({ keywords: [{ keyword: 'x' }], recommendations: ['Consider Y'] });
  assertValid(result);
  assert.deepStrictEqual(result.recommendations, ['Consider Y']);
});

test('runKeywordResearch downgrades an unearned "verified" claim to unverified', () => {
  const result = runKeywordResearch({ keywords: [{ keyword: 'x' }], verificationStatus: 'verified' });
  assertValid(result);
  assert.strictEqual(result.verification_status, 'unverified');
  assert.ok(result.limitations.some((l) => l.includes('downgraded to unverified')));
});

test('runKeywordResearch honors a "verified" claim when source backs it', () => {
  const result = runKeywordResearch({
    keywords: [{ keyword: 'x', source: ['s1'] }],
    verificationStatus: 'verified',
  });
  assertValid(result);
  assert.strictEqual(result.verification_status, 'verified');
});

test('runKeywordResearch never fabricates a numeric search-volume/competition metric', () => {
  const result = runKeywordResearch({ keywords: [{ keyword: 'x' }] });
  assert.ok(!('search_volume' in result.specialized_records[0]));
});

// --- structured execution: all 7 requested fields, per keyword, only ever what was supplied ---

test('runKeywordResearch captures all 7 structured fields (keyword, intent, relevance, competition, opportunity, source, confidence) for a keyword where data is available', () => {
  const result = runKeywordResearch({
    keywords: [
      {
        keyword: 'insulated hiking jacket',
        searchIntent: 'commercial investigation',
        relevance: 'high',
        competition: 'Moderate, few well-reviewed listings.',
        opportunity: 'Rising search interest.',
        source: ['(placeholder keyword source)'],
        confidence: 'medium',
      },
    ],
  });
  assertValid(result);
  const record = result.specialized_records[0];
  assert.strictEqual(record.keyword, 'insulated hiking jacket');
  assert.strictEqual(record.search_intent, 'commercial investigation');
  assert.strictEqual(record.relevance, 'high');
  assert.strictEqual(record.competition, 'Moderate, few well-reviewed listings.');
  assert.strictEqual(record.opportunity, 'Rising search interest.');
  assert.deepStrictEqual(record.source, ['(placeholder keyword source)']);
  assert.strictEqual(record.confidence, 'medium');
});

test('runKeywordResearch executes independently per keyword - a fully-evidenced keyword and a bare keyword in the same call do not leak fields into each other', () => {
  const result = runKeywordResearch({
    keywords: [
      {
        keyword: 'insulated hiking jacket',
        searchIntent: 'commercial investigation',
        relevance: 'high',
        competition: 'Moderate.',
        opportunity: 'Rising interest.',
        source: ['source A'],
        confidence: 'medium',
      },
      { keyword: 'waterproof hiking boots' },
    ],
  });
  assertValid(result);
  assert.strictEqual(result.specialized_records.length, 2);

  const evidenced = result.specialized_records.find((r) => r.keyword === 'insulated hiking jacket');
  assert.strictEqual(evidenced.relevance, 'high');
  assert.strictEqual(evidenced.confidence, 'medium');

  // The bare keyword gets its own record (data was requested for it), but every
  // field beyond the keyword itself stays at its honest, unassessed/empty default -
  // never inferred from the other keyword in the same call.
  const bare = result.specialized_records.find((r) => r.keyword === 'waterproof hiking boots');
  assert.strictEqual(bare.relevance, 'unassessed');
  assert.strictEqual(bare.competition, '');
  assert.strictEqual(bare.opportunity, '');
  assert.deepStrictEqual(bare.source, []);
  assert.strictEqual(bare.confidence, 'unassessed');
});

test('runKeywordResearch output never contains a fabricated numeric metric anywhere (search volume, rank, traffic estimate)', () => {
  const result = runKeywordResearch({
    keywords: [{ keyword: 'x', competition: 'high', opportunity: 'strong' }],
  });
  const record = result.specialized_records[0];
  for (const forbiddenKey of ['search_volume', 'volume', 'rank', 'traffic', 'traffic_estimate', 'competition_score']) {
    assert.ok(!(forbiddenKey in record), `record must not contain a fabricated \`${forbiddenKey}\` field`);
  }
  // competition/opportunity stay the exact qualitative strings supplied - never
  // converted into a computed number.
  assert.strictEqual(typeof record.competition, 'string');
  assert.strictEqual(typeof record.opportunity, 'string');
});

// --- analyzeSearchIntent --------------------------------------------------------------

test('analyzeSearchIntent requires a non-empty keywords array', () => {
  assert.throws(() => analyzeSearchIntent({}), /requires a non-empty `keywords`/);
});

test('analyzeSearchIntent groups keywords by their search_intent field', () => {
  const result = analyzeSearchIntent({
    keywords: [
      { keyword: 'insulated hiking jacket', searchIntent: 'commercial investigation' },
      { keyword: 'buy insulated jacket online', searchIntent: 'transactional' },
      { keyword: 'how to layer for cold hikes', searchIntent: 'informational' },
    ],
  });
  assertValid(result);
  assert.strictEqual(result.capability, 'search_intent_analysis');
  assert.ok(result.findings.some((f) => f.startsWith('commercial investigation: insulated hiking jacket')));
  assert.ok(result.findings.some((f) => f.startsWith('transactional: buy insulated jacket online')));
  assert.ok(result.findings.some((f) => f.startsWith('informational: how to layer for cold hikes')));
});

test('analyzeSearchIntent groups keywords with no asserted intent under (unassigned)', () => {
  const result = analyzeSearchIntent({ keywords: [{ keyword: 'x' }] });
  assertValid(result);
  assert.ok(result.findings.some((f) => f.startsWith('(unassigned): x')));
});

// --- analyzeProductSeo -----------------------------------------------------------------

test('analyzeProductSeo requires a non-empty productReference', () => {
  assert.throws(() => analyzeProductSeo({}), /requires a non-empty `productReference`/);
});

test('analyzeProductSeo composes a listingOptimizationModel.js record', () => {
  const result = analyzeProductSeo({
    productReference: 'sku-123',
    productTitle: 'Insulated Hiking Jacket',
    internalOptimizationOpportunities: ['Meta description missing target keyword.'],
  });
  assertValid(result);
  assert.strictEqual(result.capability, 'product_seo');
  assert.strictEqual(result.specialized_records[0].product_reference, 'sku-123');
  assert.ok(result.findings.includes('Meta description missing target keyword.'));
});

test('analyzeProductSeo with no evidence reports a limitation naming the product', () => {
  const result = analyzeProductSeo({ productReference: 'sku-123' });
  assertValid(result);
  assert.ok(result.limitations.some((l) => l.includes('No evidence was supplied for sku-123')));
});

test('analyzeProductSeo composes caller-supplied evidence into evidence/source, reusing researchAgent.js\'s generic record builder', () => {
  const result = analyzeProductSeo({
    productReference: 'sku-123',
    evidence: [{ topic: 'Audit', finding: 'Meta description is empty.', source: ['audit tool'] }],
  });
  assertValid(result);
  assert.ok(result.evidence.includes('Meta description is empty.'));
  assert.deepStrictEqual(result.source, ['audit tool']);
  assert.ok(!result.limitations.some((l) => l.includes('No evidence was supplied')));
});

// --- analyzeProductSeo: structured product SEO optimization (title, meta description,
// headings, description, keyword usage, internal links, supporting content) ---

test('analyzeProductSeo generates structured recommendations for all 7 requested categories', () => {
  const result = analyzeProductSeo({
    productReference: 'sku-123',
    productTitle: 'Insulated Hiking Jacket',
    description: 'A warm, waterproof jacket for cold-weather hikes.',
    keywords: ['insulated hiking jacket'],
    keywordUsage: [{ keyword: 'insulated hiking jacket', placement: 'title, h1, first paragraph' }],
    headings: [
      { level: 'h1', text: 'Insulated Hiking Jacket' },
      { level: 'h2', text: 'Key Features' },
    ],
    metadata: { metaTitle: 'Insulated Hiking Jacket | Store', metaDescription: 'Stay warm and dry on cold hikes.' },
    internalLinks: [{ anchor_text: 'outdoor apparel collection', target: 'outdoor-apparel' }],
    supportingContent: ['Add a cold-weather layering buying guide.'],
  });
  assertValid(result);
  const record = result.specialized_records[0];

  // title
  assert.strictEqual(record.product_title, 'Insulated Hiking Jacket');
  // meta description
  assert.strictEqual(record.metadata.meta_description, 'Stay warm and dry on cold hikes.');
  // headings
  assert.deepStrictEqual(record.headings, [
    { level: 'h1', text: 'Insulated Hiking Jacket' },
    { level: 'h2', text: 'Key Features' },
  ]);
  // description
  assert.strictEqual(record.description, 'A warm, waterproof jacket for cold-weather hikes.');
  // keyword usage
  assert.deepStrictEqual(record.keyword_usage, [
    { keyword: 'insulated hiking jacket', placement: 'title, h1, first paragraph' },
  ]);
  // internal links
  assert.deepStrictEqual(record.internal_links, [{ anchor_text: 'outdoor apparel collection', target: 'outdoor-apparel' }]);
  // supporting content
  assert.deepStrictEqual(record.supporting_content, ['Add a cold-weather layering buying guide.']);
  assert.ok(result.findings.includes('Add a cold-weather layering buying guide.'));
});

test('analyzeProductSeo never invents a factual product claim - unsupplied fields stay honestly empty, not fabricated', () => {
  const result = analyzeProductSeo({ productReference: 'sku-123' });
  const record = result.specialized_records[0];
  assert.strictEqual(record.product_title, '');
  assert.strictEqual(record.description, '');
  assert.deepStrictEqual(record.headings, []);
  assert.deepStrictEqual(record.keyword_usage, []);
  assert.deepStrictEqual(record.internal_links, []);
  assert.deepStrictEqual(record.supporting_content, []);
});

test('analyzeProductSeo result states recommendations are suggestions only, never auto-published, and preserve factual product information', () => {
  const result = analyzeProductSeo({ productReference: 'sku-123' });
  assert.ok(result.limitations.some((l) => l.includes('nothing here is automatically published')));
  assert.ok(result.limitations.some((l) => l.includes('no factual product information is altered or invented')));
});

// --- analyzeCollectionSeo ---------------------------------------------------------------

test('analyzeCollectionSeo requires a non-empty collectionReference', () => {
  assert.throws(() => analyzeCollectionSeo({}), /requires a non-empty `subjectReference`/);
});

test('analyzeCollectionSeo composes an onPageOptimizationModel.js record with subject_type collection', () => {
  const result = analyzeCollectionSeo({
    collectionReference: 'outdoor-apparel',
    collectionTitle: 'Outdoor Apparel',
  });
  assertValid(result);
  assert.strictEqual(result.capability, 'collection_seo');
  assert.strictEqual(result.specialized_records[0].subject_type, 'collection');
  assert.strictEqual(result.specialized_records[0].subject_reference, 'outdoor-apparel');
});

// --- analyzeContentSeo -------------------------------------------------------------------

test('analyzeContentSeo requires a non-empty contentReference', () => {
  assert.throws(() => analyzeContentSeo({}), /requires a non-empty `subjectReference`/);
});

test('analyzeContentSeo composes an onPageOptimizationModel.js record with subject_type content', () => {
  const result = analyzeContentSeo({
    contentReference: 'blog/cold-weather-layering-guide',
    contentTitle: 'How to Layer for Cold Hikes',
  });
  assertValid(result);
  assert.strictEqual(result.capability, 'content_seo');
  assert.strictEqual(result.specialized_records[0].subject_type, 'content');
  assert.strictEqual(result.specialized_records[0].subject_reference, 'blog/cold-weather-layering-guide');
});

// --- analyzeOnPageSeo (dispatcher) --------------------------------------------------------

test('analyzeOnPageSeo requires a valid subjectType', () => {
  assert.throws(() => analyzeOnPageSeo({ subjectType: 'not_a_real_type' }), /requires a valid `subjectType`/);
  assert.throws(() => analyzeOnPageSeo({}), /requires a valid `subjectType`/);
});

test('analyzeOnPageSeo dispatches subjectType product to analyzeProductSeo, tagged on_page_seo', () => {
  const result = analyzeOnPageSeo({ subjectType: 'product', productReference: 'sku-123' });
  assertValid(result);
  assert.strictEqual(result.capability, 'on_page_seo');
  assert.strictEqual(result.specialized_records[0].product_reference, 'sku-123');
});

test('analyzeOnPageSeo dispatches subjectType collection to analyzeCollectionSeo, tagged on_page_seo', () => {
  const result = analyzeOnPageSeo({ subjectType: 'collection', collectionReference: 'outdoor-apparel' });
  assertValid(result);
  assert.strictEqual(result.capability, 'on_page_seo');
  assert.strictEqual(result.specialized_records[0].subject_type, 'collection');
});

test('analyzeOnPageSeo dispatches subjectType content to analyzeContentSeo, tagged on_page_seo', () => {
  const result = analyzeOnPageSeo({ subjectType: 'content', contentReference: 'blog/x' });
  assertValid(result);
  assert.strictEqual(result.capability, 'on_page_seo');
  assert.strictEqual(result.specialized_records[0].subject_type, 'content');
});

// --- analyzeSeoOpportunities -------------------------------------------------------------

test('analyzeSeoOpportunities requires a non-empty keywords array', () => {
  assert.throws(() => analyzeSeoOpportunities({}), /requires a non-empty `keywords`/);
});

test('analyzeSeoOpportunities reports full coverage as success, never a score', () => {
  const result = analyzeSeoOpportunities({
    keywords: [
      { keyword: 'a', opportunity: 'high', competition: 'low' },
      { keyword: 'b', opportunity: 'medium', competition: 'medium' },
    ],
  });
  assertValid(result);
  assert.strictEqual(result.capability, 'seo_opportunity_analysis');
  assert.ok(result.findings.includes('Coverage status: success.'));
  assert.ok(result.findings.includes('2/2 keyword(s) have an opportunity assessment.'));
  assert.ok(!('score' in result));
  assert.ok(!('verdict' in result));
});

test('analyzeSeoOpportunities reports partial coverage honestly', () => {
  const result = analyzeSeoOpportunities({
    keywords: [{ keyword: 'a', opportunity: 'high' }, { keyword: 'b' }],
  });
  assertValid(result);
  assert.ok(result.findings.includes('Coverage status: partial.'));
});

test('analyzeSeoOpportunities reports empty coverage honestly when nothing is assessed', () => {
  const result = analyzeSeoOpportunities({ keywords: [{ keyword: 'a' }, { keyword: 'b' }] });
  assertValid(result);
  assert.ok(result.findings.includes('Coverage status: empty.'));
});

// --- runSeoAgent dispatcher ----------------------------------------------------------------

test('runSeoAgent dispatches keyword_research to runKeywordResearch', () => {
  const result = runSeoAgent({ capability: 'keyword_research', keywords: [{ keyword: 'x' }] });
  assertValid(result);
  assert.strictEqual(result.capability, 'keyword_research');
});

test('runSeoAgent dispatches seo_opportunity_analysis to analyzeSeoOpportunities', () => {
  const result = runSeoAgent({ capability: 'seo_opportunity_analysis', keywords: [{ keyword: 'x' }] });
  assertValid(result);
  assert.strictEqual(result.capability, 'seo_opportunity_analysis');
});

test('runSeoAgent rejects an unknown capability', () => {
  assert.throws(() => runSeoAgent({ capability: 'not_a_real_capability' }), /Unknown SEO capability/);
});

// --- retrieveSeoData (data retrieval stage) -------------------------------------------------

test('retrieveSeoData builds one validated keyword record per entry', () => {
  const records = retrieveSeoData('keyword', [{ keyword: 'x' }], 'test');
  assert.strictEqual(records.length, 1);
  assert.strictEqual(records[0].keyword, 'x');
});

test('retrieveSeoData delegates the generic kind to researchAgent.js\'s retrieveResearchData rather than reimplementing it', () => {
  const records = retrieveSeoData('generic', [{ topic: 'x', finding: 'y' }], 'test');
  assert.strictEqual(records.length, 1);
  assert.strictEqual(records[0].topic, 'x');
});

test('retrieveSeoData throws for an unknown kind', () => {
  assert.throws(() => retrieveSeoData('not_a_real_kind', [{}], 'test'), /unknown record kind/);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
