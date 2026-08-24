'use strict';

const assert = require('node:assert');
const { runListingContentTool } = require('../../tools/listingContentTool');

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

test('runListingContentTool never throws - returns failed status when researchParams is missing', () => {
  const outcome = runListingContentTool(undefined);
  assert.strictEqual(outcome.status, 'failed');
  assert.strictEqual(outcome.result, null);
  assert.ok(outcome.error.includes('No structured research input was supplied'));
});

test('runListingContentTool returns failed status for an unknown listingCapability', () => {
  const outcome = runListingContentTool({ listingCapability: 'not_a_real_capability' });
  assert.strictEqual(outcome.status, 'failed');
  assert.ok(outcome.error.includes('Unknown listingCapability'));
});

test('runListingContentTool returns failed status when a required field is missing', () => {
  const outcome = runListingContentTool({ productReference: '' });
  assert.strictEqual(outcome.status, 'failed');
  assert.ok(outcome.error.includes('requires a non-empty'));
});

test('runListingContentTool defaults to listing_content capability', () => {
  const outcome = runListingContentTool({ productReference: '(Example jacket)' });
  assert.strictEqual(outcome.result.capability, 'listing_content');
});

test('runListingContentTool returns empty status when no evidence is supplied', () => {
  const outcome = runListingContentTool({
    productReference: '(Example jacket)',
    benefits: ['Keeps you warm.'],
  });
  assert.strictEqual(outcome.status, 'empty');
});

test('runListingContentTool returns success status when evidence is supplied', () => {
  const outcome = runListingContentTool({
    productReference: '(Example jacket)',
    benefits: ['Keeps you warm.'],
    evidence: [{ topic: 'Spec sheet', finding: 'Shell fabric is ripstop nylon.', source: ['spec-sheet-1'] }],
  });
  assert.strictEqual(outcome.status, 'success');
});

test('runListingContentTool marketplace_format returns partial status when no format constraints are supplied', () => {
  const outcome = runListingContentTool({
    listingCapability: 'marketplace_format',
    marketplace: 'etsy',
    productReference: '(Example jacket)',
    sourceListing: { productTitle: 'Insulated Hiking Jacket' },
  });
  assert.strictEqual(outcome.status, 'partial');
});

test('runListingContentTool marketplace_format returns success status when format constraints are applied', () => {
  const outcome = runListingContentTool({
    listingCapability: 'marketplace_format',
    marketplace: 'etsy',
    productReference: '(Example jacket)',
    sourceListing: { productTitle: 'Insulated Hiking Jacket' },
    constraints: { maxTitleLength: 5 },
  });
  assert.strictEqual(outcome.status, 'success');
  assert.strictEqual(outcome.result.specialized_records[0].formatted_title, 'Insul');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
