'use strict';

const assert = require('node:assert');
const {
  PRODUCT_RESEARCH_STAGES,
} = require('../../products/productResearchArchitecture');

const EXPECTED_ORDER = [
  'discover_opportunities',
  'collect_evidence',
  'compare_opportunities',
  'identify_demand_signals',
  'identify_competition',
  'identify_market_fit',
  'record_confidence',
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

test('the pipeline has exactly the 7 required stages, in the requested order', () => {
  assert.deepStrictEqual(
    PRODUCT_RESEARCH_STAGES.map((stage) => stage.id),
    EXPECTED_ORDER
  );
});

test('every stage has a non-empty title and description', () => {
  for (const stage of PRODUCT_RESEARCH_STAGES) {
    assert.ok(stage.title && stage.title.trim() !== '', `${stage.id} is missing a title`);
    assert.ok(stage.description && stage.description.trim() !== '', `${stage.id} is missing a description`);
  }
});

test('stage ids are unique', () => {
  const ids = PRODUCT_RESEARCH_STAGES.map((stage) => stage.id);
  assert.strictEqual(new Set(ids).size, ids.length);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
