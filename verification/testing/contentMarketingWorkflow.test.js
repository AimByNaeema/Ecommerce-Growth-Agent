'use strict';

const assert = require('node:assert');
const {
  CONTENT_MARKETING_STAGES,
} = require('../../workflows/contentMarketingWorkflow');

const EXPECTED_ORDER = [
  'understand_product',
  'identify_customer',
  'identify_problem_or_need',
  'identify_search_interest',
  'identify_content_opportunity',
  'produce_content_recommendation',
  'verify_recommendation',
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

test('the workflow has exactly the 7 required stages, in the requested order', () => {
  assert.deepStrictEqual(
    CONTENT_MARKETING_STAGES.map((stage) => stage.id),
    EXPECTED_ORDER
  );
});

test('every stage has a non-empty title and description', () => {
  for (const stage of CONTENT_MARKETING_STAGES) {
    assert.ok(stage.title && stage.title.trim() !== '', `${stage.id} is missing a title`);
    assert.ok(stage.description && stage.description.trim() !== '', `${stage.id} is missing a description`);
  }
});

test('stage ids are unique', () => {
  const ids = CONTENT_MARKETING_STAGES.map((stage) => stage.id);
  assert.strictEqual(new Set(ids).size, ids.length);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
