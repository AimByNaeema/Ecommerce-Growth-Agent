'use strict';

const assert = require('node:assert');
const {
  PRODUCT_OPPORTUNITY_ANALYSIS_STAGES,
} = require('../../workflows/productOpportunityAnalysisWorkflow');

const EXPECTED_ORDER = [
  'assess_demand',
  'assess_competition',
  'assess_customer_fit',
  'assess_differentiation',
  'assess_market_relevance',
  'assess_commercial_potential',
  'assess_risks',
  'assess_evidence_quality',
];

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

test('the workflow has exactly the 8 required stages, in the requested order', () => {
  assert.deepStrictEqual(
    PRODUCT_OPPORTUNITY_ANALYSIS_STAGES.map((stage) => stage.id),
    EXPECTED_ORDER
  );
});

test('every stage has a non-empty title and description', () => {
  for (const stage of PRODUCT_OPPORTUNITY_ANALYSIS_STAGES) {
    assert.ok(stage.title && stage.title.trim() !== '', `${stage.id} is missing a title`);
    assert.ok(stage.description && stage.description.trim() !== '', `${stage.id} is missing a description`);
  }
});

test('stage ids are unique', () => {
  const ids = PRODUCT_OPPORTUNITY_ANALYSIS_STAGES.map((stage) => stage.id);
  assert.strictEqual(new Set(ids).size, ids.length);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
