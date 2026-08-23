'use strict';

const assert = require('node:assert');
const {
  TOOL_CATEGORIES,
  TOOL_STATUSES,
  TOOL_REGISTRY,
  getToolById,
  getToolsByCategory,
  getToolsByStatus,
} = require('../../tools/toolRegistry');

const EXPECTED_ORDER = [
  'business_configuration_retrieval',
  'product_data_retrieval',
  'product_research',
  'market_research',
  'customer_research',
  'competitor_research',
  'keyword_research',
  'seo_analysis',
  'marketing_analysis',
  'analytics',
  'memory_retrieval',
  'verification',
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

test('the registry has exactly the 12 required tools, in the requested order', () => {
  assert.deepStrictEqual(
    TOOL_REGISTRY.map((tool) => tool.id),
    EXPECTED_ORDER
  );
});

test('every entry has a non-empty title and description', () => {
  for (const tool of TOOL_REGISTRY) {
    assert.ok(tool.title && tool.title.trim() !== '', `${tool.id} is missing a title`);
    assert.ok(tool.description && tool.description.trim() !== '', `${tool.id} is missing a description`);
  }
});

test('tool ids are unique', () => {
  const ids = TOOL_REGISTRY.map((tool) => tool.id);
  assert.strictEqual(new Set(ids).size, ids.length);
});

test('every entry has a valid category and status', () => {
  for (const tool of TOOL_REGISTRY) {
    assert.ok(TOOL_CATEGORIES.includes(tool.category), `${tool.id} has an invalid category: ${tool.category}`);
    assert.ok(TOOL_STATUSES.includes(tool.status), `${tool.id} has an invalid status: ${tool.status}`);
  }
});

test('every entry except business_configuration_retrieval is not_implemented - do not implement other tools yet', () => {
  for (const tool of TOOL_REGISTRY) {
    if (tool.id === 'business_configuration_retrieval') continue;
    assert.strictEqual(tool.status, 'not_implemented', `${tool.id} should not be implemented yet`);
  }
});

test('business_configuration_retrieval is implemented', () => {
  assert.strictEqual(getToolById('business_configuration_retrieval').status, 'implemented');
});

test('getToolById() finds a known tool and returns undefined for an unknown one', () => {
  assert.strictEqual(getToolById('keyword_research').title, 'Keyword research');
  assert.strictEqual(getToolById('does_not_exist'), undefined);
});

test('getToolsByCategory() filters correctly', () => {
  const seoTools = getToolsByCategory('seo');
  assert.deepStrictEqual(seoTools.map((tool) => tool.id), ['keyword_research', 'seo_analysis']);
});

test('getToolsByStatus() returns the correct counts for each status', () => {
  assert.strictEqual(getToolsByStatus('not_implemented').length, TOOL_REGISTRY.length - 1);
  assert.strictEqual(getToolsByStatus('implemented').length, 1);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
