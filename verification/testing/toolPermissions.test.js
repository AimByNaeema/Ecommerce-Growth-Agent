'use strict';

const assert = require('node:assert');
const {
  CATEGORY_TO_SPECIALIST,
  SHARED_INFRASTRUCTURE_CATEGORIES,
  AUTO_APPROVED_CLASSIFICATIONS,
  isSpecialistPermittedForCategory,
  evaluateToolAccess,
  checkToolAccess,
} = require('../../agent/core/toolPermissions');

// checkToolAccess is the real, tools/toolRegistry.js-backed API - it is exercised here
// against real registry entries wherever real data can produce the outcome. Every
// implemented tool in today's registry (business_configuration_retrieval,
// market_research, customer_research, competitor_research, ai_reasoning_completion,
// product_data_retrieval) is classified analysis_only or recommendation - both
// auto-approved - so no real tool can currently produce an 'approval_required'
// decision end-to-end; that branch is covered via evaluateToolAccess() with a
// clearly-labeled synthetic tool shape instead of inventing a new entry in the real
// registry.

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

test('isSpecialistPermittedForCategory grants a specialist only its own mapped categories', () => {
  assert.strictEqual(isSpecialistPermittedForCategory('seo', 'seo'), true);
  assert.strictEqual(isSpecialistPermittedForCategory('seo', 'marketing'), false);
  assert.strictEqual(isSpecialistPermittedForCategory('research', 'research'), true);
  assert.strictEqual(isSpecialistPermittedForCategory('research', 'customer_market_intelligence'), true);
});

test('isSpecialistPermittedForCategory treats a null specialistId as shared infrastructure only', () => {
  assert.strictEqual(isSpecialistPermittedForCategory(null, 'configuration'), true);
  assert.strictEqual(isSpecialistPermittedForCategory(null, 'products'), false);
});

test('CATEGORY_TO_SPECIALIST and SHARED_INFRASTRUCTURE_CATEGORIES partition all mapped categories with no overlap', () => {
  for (const category of Object.keys(CATEGORY_TO_SPECIALIST)) {
    assert.ok(!SHARED_INFRASTRUCTURE_CATEGORIES.includes(category), `${category} should not be shared infrastructure`);
  }
});

// --- checkToolAccess: real registry-backed cases ------------------------------------

test('ALLOWED: an implemented, auto-approved tool requested by its rightful owner (shared infrastructure)', () => {
  const result = checkToolAccess({ specialistId: null, toolId: 'business_configuration_retrieval' });
  assert.strictEqual(result.decision, 'allowed');
  assert.strictEqual(result.available, true);
  assert.strictEqual(result.permitted, true);
  assert.strictEqual(result.approval_required, false);
  assert.strictEqual(result.classification, 'analysis_only');
});

test('DENIED: a specialist that does not own the tool\'s category is refused, even though the tool is implemented', () => {
  const result = checkToolAccess({ specialistId: 'marketing', toolId: 'business_configuration_retrieval' });
  assert.strictEqual(result.decision, 'denied');
  assert.strictEqual(result.available, true);
  assert.strictEqual(result.permitted, false);
  assert.ok(/not permitted/.test(result.reason));
});

test('UNAVAILABLE: a registered but not-yet-implemented tool is refused regardless of who asks', () => {
  const result = checkToolAccess({ specialistId: 'product', toolId: 'product_research' });
  assert.strictEqual(result.decision, 'unavailable');
  assert.strictEqual(result.available, false);
  assert.ok(/not yet implemented/.test(result.reason));
});

test('UNAVAILABLE: an unknown tool id is refused honestly, not treated as denied or approved', () => {
  const result = checkToolAccess({ specialistId: 'seo', toolId: 'not_a_real_tool' });
  assert.strictEqual(result.decision, 'unavailable');
  assert.strictEqual(result.tool_id, null);
});

test('a specialist IS permitted for a not-yet-implemented tool in its own category (permission and availability are independent)', () => {
  // product_research belongs to the 'products' category, which the 'product'
  // specialist owns - the tool being unavailable must not be reported as a
  // permission problem.
  const result = checkToolAccess({ specialistId: 'product', toolId: 'product_research' });
  assert.strictEqual(result.decision, 'unavailable');
  assert.notStrictEqual(result.decision, 'denied');
});

// --- evaluateToolAccess: the pure decision function, including approval_required ---

test('evaluateToolAccess: unavailable when no tool was resolved at all', () => {
  const result = evaluateToolAccess({ specialistId: 'seo', tool: null });
  assert.strictEqual(result.decision, 'unavailable');
});

test('evaluateToolAccess: unavailable when the tool exists but is not implemented', () => {
  const result = evaluateToolAccess({
    specialistId: 'seo',
    tool: { id: 'hypothetical_seo_tool', status: 'not_implemented', category: 'seo' },
  });
  assert.strictEqual(result.decision, 'unavailable');
});

test('evaluateToolAccess: denied when the tool is implemented but the specialist does not own its category', () => {
  const result = evaluateToolAccess({
    specialistId: 'marketing',
    tool: { id: 'hypothetical_seo_tool', status: 'implemented', category: 'seo' },
    classification: 'analysis_only',
  });
  assert.strictEqual(result.decision, 'denied');
});

test('APPROVAL_REQUIRED: an implemented, permitted tool with a classification outside AUTO_APPROVED_CLASSIFICATIONS', () => {
  // No tool in today's real registry is both implemented and approval_required (the
  // only implemented tool is analysis_only) - this synthetic shape proves the branch
  // works correctly for when a write-capable tool is eventually added.
  const hypotheticalWriteTool = { id: 'hypothetical_publish_listing', status: 'implemented', category: 'seo' };
  assert.ok(!AUTO_APPROVED_CLASSIFICATIONS.includes('externally_executable'));

  const result = evaluateToolAccess({
    specialistId: 'seo',
    tool: hypotheticalWriteTool,
    classification: 'externally_executable',
  });
  assert.strictEqual(result.decision, 'approval_required');
  assert.strictEqual(result.available, true);
  assert.strictEqual(result.permitted, true);
  assert.strictEqual(result.approval_required, true);
  assert.strictEqual(result.classification, 'externally_executable');
});

test('APPROVAL_REQUIRED: an implemented, permitted tool with no classification at all defaults to requiring approval, never auto-allowed', () => {
  const result = evaluateToolAccess({
    specialistId: 'marketing',
    tool: { id: 'hypothetical_unclassified_tool', status: 'implemented', category: 'marketing' },
    classification: null,
  });
  assert.strictEqual(result.decision, 'approval_required');
});

test('ALLOWED: evaluateToolAccess only reaches allowed once available, permitted, and auto-approved all hold', () => {
  const result = evaluateToolAccess({
    specialistId: 'marketing',
    tool: { id: 'hypothetical_analysis_tool', status: 'implemented', category: 'marketing' },
    classification: 'analysis_only',
  });
  assert.strictEqual(result.decision, 'allowed');
  assert.strictEqual(result.approval_required, false);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
