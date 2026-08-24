'use strict';

const assert = require('node:assert');
const { runSeoAnalysisTool } = require('../../tools/seoAnalysisTool');

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

test('failed: no researchParams supplied at all reports an honest error, never a fabricated result', () => {
  const outcome = runSeoAnalysisTool(undefined);
  assert.strictEqual(outcome.status, 'failed');
  assert.strictEqual(outcome.result, null);
  assert.ok(outcome.error.includes('No structured research input was supplied'));
});

test('failed: an unknown seoCapability reports an honest error', () => {
  const outcome = runSeoAnalysisTool({ seoCapability: 'not_a_real_capability' });
  assert.strictEqual(outcome.status, 'failed');
  assert.strictEqual(outcome.result, null);
  assert.ok(outcome.error.includes('Unknown seoCapability'));
});

test('failed: researchParams missing the required field for the default (product_seo) capability', () => {
  const outcome = runSeoAnalysisTool({});
  assert.strictEqual(outcome.status, 'failed');
  assert.ok(outcome.error.includes('requires a non-empty `productReference`'));
});

test('empty: valid product SEO input with no evidence supplied', () => {
  const outcome = runSeoAnalysisTool({ productReference: 'sku-123' });
  assert.strictEqual(outcome.status, 'empty');
  assert.strictEqual(outcome.error, null);
});

test('successful: valid product SEO input with evidence supplied', () => {
  const outcome = runSeoAnalysisTool({
    productReference: 'sku-123',
    evidence: [{ topic: 'Audit', finding: 'Meta description is empty.', source: ['audit tool'] }],
  });
  assert.strictEqual(outcome.status, 'success');
  assert.strictEqual(outcome.error, null);
});

test('collection_seo capability dispatches to analyzeCollectionSeo', () => {
  const outcome = runSeoAnalysisTool({ seoCapability: 'collection_seo', collectionReference: 'outdoor-apparel' });
  assert.strictEqual(outcome.error, null);
  assert.strictEqual(outcome.result.capability, 'collection_seo');
});

test('content_seo capability dispatches to analyzeContentSeo', () => {
  const outcome = runSeoAnalysisTool({ seoCapability: 'content_seo', contentReference: 'blog/x' });
  assert.strictEqual(outcome.error, null);
  assert.strictEqual(outcome.result.capability, 'content_seo');
});

test('on_page_seo capability dispatches to analyzeOnPageSeo', () => {
  const outcome = runSeoAnalysisTool({
    seoCapability: 'on_page_seo',
    subjectType: 'product',
    productReference: 'sku-123',
  });
  assert.strictEqual(outcome.error, null);
  assert.strictEqual(outcome.result.capability, 'on_page_seo');
});

test('seo_opportunity_analysis capability dispatches to analyzeSeoOpportunities', () => {
  const outcome = runSeoAnalysisTool({
    seoCapability: 'seo_opportunity_analysis',
    keywords: [{ keyword: 'a', opportunity: 'high', competition: 'low', source: ['source A'] }],
  });
  assert.strictEqual(outcome.error, null);
  assert.strictEqual(outcome.result.capability, 'seo_opportunity_analysis');
  // status reflects source/evidence coverage (deriveStatus), distinct from the
  // result's own opportunity/competition coverage findings - both are honest, just
  // about different things.
  assert.strictEqual(outcome.status, 'success');
  assert.ok(outcome.result.findings.includes('Coverage status: success.'));
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
