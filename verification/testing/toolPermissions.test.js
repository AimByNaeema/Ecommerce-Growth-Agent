'use strict';

const assert = require('node:assert');
const {
  CATEGORY_TO_SPECIALIST,
  SHARED_INFRASTRUCTURE_CATEGORIES,
  AUTO_APPROVED_CLASSIFICATIONS,
  TOOL_CLASSIFICATIONS,
  SPECIALIST_ROLE_PERMISSIONS,
  SHARED_INFRASTRUCTURE_ROLE_PERMISSIONS,
  isSpecialistPermittedForCategory,
  isOperationPermittedForSpecialist,
  evaluateToolAccess,
  checkToolAccess,
} = require('../../agent/core/toolPermissions');
const {
  AUTO_APPROVED_CLASSIFICATIONS: ARCHITECTURE_AUTO_APPROVED_CLASSIFICATIONS,
  getClassificationById,
} = require('../../approvals/approvalArchitecture');
const { TOOL_REGISTRY, TOOL_OPERATIONS, getToolById } = require('../../tools/toolRegistry');
const { SPECIALIST_REGISTRY } = require('../../agent/core/specialistRegistry');

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
  // operation: 'read' matches SEO's role (SPECIALIST_ROLE_PERMISSIONS.seo = ['read'])
  // so this fixture reaches the approval branch being tested here, not the role/
  // operation denial branch - that branch has its own dedicated tests below.
  const hypotheticalWriteTool = { id: 'hypothetical_publish_listing', status: 'implemented', category: 'seo', operation: 'read' };
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
  // operation: 'write' matches Marketing's role (SPECIALIST_ROLE_PERMISSIONS.marketing
  // = ['write']), so this reaches the approval branch, not the role denial branch.
  const result = evaluateToolAccess({
    specialistId: 'marketing',
    tool: { id: 'hypothetical_unclassified_tool', status: 'implemented', category: 'marketing', operation: 'write' },
    classification: null,
  });
  assert.strictEqual(result.decision, 'approval_required');
});

test('ALLOWED: evaluateToolAccess only reaches allowed once available, category-permitted, role-permitted, and auto-approved all hold', () => {
  const result = evaluateToolAccess({
    specialistId: 'marketing',
    tool: { id: 'hypothetical_analysis_tool', status: 'implemented', category: 'marketing', operation: 'write' },
    classification: 'analysis_only',
  });
  assert.strictEqual(result.decision, 'allowed');
  assert.strictEqual(result.approval_required, false);
  assert.strictEqual(result.category_permitted, true);
  assert.strictEqual(result.operation_permitted, true);
});

// --- Role-based (READ/WRITE/EXECUTE) permissions ------------------------------------

test('SPECIALIST_ROLE_PERMISSIONS declares a role for every specialist in specialistRegistry.js, using only real operation ids', () => {
  for (const specialist of SPECIALIST_REGISTRY) {
    const role = SPECIALIST_ROLE_PERMISSIONS[specialist.id];
    assert.ok(role && role.length > 0, `${specialist.id} has no declared role permissions`);
    for (const operation of role) {
      assert.ok(TOOL_OPERATIONS.includes(operation), `${specialist.id}'s role includes an invalid operation '${operation}'`);
    }
  }
});

test('no specialist role grants "execute" today - no tool is externally_executable yet, matching approvals/approvalArchitecture.js', () => {
  for (const role of Object.values(SPECIALIST_ROLE_PERMISSIONS)) {
    assert.ok(!role.includes('execute'), 'no specialist role should include execute yet');
  }
  assert.ok(!SHARED_INFRASTRUCTURE_ROLE_PERMISSIONS.includes('execute'));
});

test('isOperationPermittedForSpecialist grants a specialist only its own role\'s operations', () => {
  assert.strictEqual(isOperationPermittedForSpecialist('research', 'read'), true);
  assert.strictEqual(isOperationPermittedForSpecialist('research', 'write'), false);
  assert.strictEqual(isOperationPermittedForSpecialist('listing', 'write'), true);
  assert.strictEqual(isOperationPermittedForSpecialist('listing', 'read'), false);
  assert.strictEqual(isOperationPermittedForSpecialist('social_advertising', 'read'), true);
  assert.strictEqual(isOperationPermittedForSpecialist('social_advertising', 'write'), true);
});

test('isOperationPermittedForSpecialist treats a null specialistId as shared infrastructure only', () => {
  assert.strictEqual(isOperationPermittedForSpecialist(null, 'read'), true);
  assert.strictEqual(isOperationPermittedForSpecialist(null, 'write'), true);
  assert.strictEqual(isOperationPermittedForSpecialist(null, 'execute'), false);
});

test('every real, implemented tool\'s operation is covered by its owning specialist\'s role - today\'s registry is fully role-consistent', () => {
  for (const tool of TOOL_REGISTRY) {
    if (tool.status !== 'implemented') continue;
    const specialistId = CATEGORY_TO_SPECIALIST[tool.category] || null;
    assert.strictEqual(
      isOperationPermittedForSpecialist(specialistId, tool.operation),
      true,
      `${tool.id} (operation '${tool.operation}') is not covered by ${specialistId || '(shared infrastructure)'}'s role`
    );
  }
});

test('DENIAL: a specialist that owns the category is still denied a tool whose operation falls outside its role', () => {
  // Research's role is read-only (SPECIALIST_ROLE_PERMISSIONS.research) - a
  // hypothetical WRITE tool in the 'research' category (which Research does own) must
  // still be denied. This is the scenario category ownership alone cannot catch - the
  // real value of a separate role/operation gate.
  const result = evaluateToolAccess({
    specialistId: 'research',
    tool: { id: 'hypothetical_publish_research_report', status: 'implemented', category: 'research', operation: 'write' },
    classification: 'analysis_only',
  });
  assert.strictEqual(result.decision, 'denied');
  assert.strictEqual(result.category_permitted, true);
  assert.strictEqual(result.operation_permitted, false);
  assert.strictEqual(result.permitted, false);
  assert.ok(/role does not permit 'write'/.test(result.reason));
});

test('DENIAL: a WRITE-only specialist is denied a READ tool even inside its own category', () => {
  // Listing's role is write-only - a hypothetical READ tool in the 'listing' category
  // must still be denied, proving the gate works in both directions.
  const result = evaluateToolAccess({
    specialistId: 'listing',
    tool: { id: 'hypothetical_listing_analytics', status: 'implemented', category: 'listing', operation: 'read' },
    classification: 'analysis_only',
  });
  assert.strictEqual(result.decision, 'denied');
  assert.strictEqual(result.operation_permitted, false);
});

test('AUTHORIZATION: a specialist whose role covers the operation, and who owns the category, is not blocked by the role gate', () => {
  const result = evaluateToolAccess({
    specialistId: 'research',
    tool: { id: 'hypothetical_trend_report', status: 'implemented', category: 'research', operation: 'read' },
    classification: 'analysis_only',
  });
  assert.strictEqual(result.category_permitted, true);
  assert.strictEqual(result.operation_permitted, true);
  assert.strictEqual(result.decision, 'allowed');
});

test('AUTHORIZATION: role denial never masks as a different decision - it is always "denied", same as a category denial', () => {
  const categoryDenied = evaluateToolAccess({
    specialistId: 'marketing',
    tool: { id: 'x', status: 'implemented', category: 'seo', operation: 'read' },
    classification: 'analysis_only',
  });
  const roleDenied = evaluateToolAccess({
    specialistId: 'research',
    tool: { id: 'y', status: 'implemented', category: 'research', operation: 'write' },
    classification: 'analysis_only',
  });
  assert.strictEqual(categoryDenied.decision, 'denied');
  assert.strictEqual(roleDenied.decision, 'denied');
  assert.strictEqual(categoryDenied.category_permitted, false);
  assert.strictEqual(roleDenied.category_permitted, true);
});

test('checkToolAccess (real registry-backed): a real tool\'s decision reports category_permitted, operation_permitted, and operation honestly', () => {
  const result = checkToolAccess({ specialistId: null, toolId: 'business_configuration_retrieval' });
  assert.strictEqual(result.category_permitted, true);
  assert.strictEqual(result.operation_permitted, true);
  assert.strictEqual(result.operation, getToolById('business_configuration_retrieval').operation);
});

// --- approvals/approvalArchitecture.js reuse (not duplicated) ----------------------

test('AUTO_APPROVED_CLASSIFICATIONS is reused, not redefined, from approvals/approvalArchitecture.js', () => {
  assert.strictEqual(AUTO_APPROVED_CLASSIFICATIONS, ARCHITECTURE_AUTO_APPROVED_CLASSIFICATIONS);
});

test('every TOOL_CLASSIFICATIONS value is a real classification id from approvals/approvalArchitecture.js', () => {
  for (const [toolId, classification] of Object.entries(TOOL_CLASSIFICATIONS)) {
    assert.ok(getClassificationById(classification), `TOOL_CLASSIFICATIONS.${toolId} = '${classification}' is not a real classification id`);
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
