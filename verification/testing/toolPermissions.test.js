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
  PLATFORM_GATE_RULE,
  isPlatformEnabledForBusiness,
  isToolPlatformPermitted,
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

test('ALLOWED: the Product specialist can reach market_product_opportunity_analysis (products/read, real registry entry)', () => {
  const result = checkToolAccess({ specialistId: 'product', toolId: 'market_product_opportunity_analysis' });
  assert.strictEqual(result.decision, 'allowed');
  assert.strictEqual(result.available, true);
  assert.strictEqual(result.permitted, true);
  assert.strictEqual(result.approval_required, false);
  assert.strictEqual(result.classification, 'analysis_only');
});

test('DENIED: a specialist outside the products category cannot reach market_product_opportunity_analysis', () => {
  const result = checkToolAccess({ specialistId: 'research', toolId: 'market_product_opportunity_analysis' });
  assert.strictEqual(result.decision, 'denied');
  assert.strictEqual(result.permitted, false);
});

test('DENIED: a specialist that does not own the tool\'s category is refused, even though the tool is implemented', () => {
  const result = checkToolAccess({ specialistId: 'marketing', toolId: 'business_configuration_retrieval' });
  assert.strictEqual(result.decision, 'denied');
  assert.strictEqual(result.available, true);
  assert.strictEqual(result.permitted, false);
  assert.ok(/not permitted/.test(result.reason));
});

test('UNAVAILABLE: a registered but not-yet-implemented tool is refused regardless of who asks', () => {
  // memory_retrieval, not product_research: product_research is now implemented
  // (tools/productResearchTool.js), so this test moved to one of the two tools that
  // genuinely remain 'not_implemented' in tools/toolRegistry.js.
  const result = checkToolAccess({ specialistId: 'product', toolId: 'memory_retrieval' });
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
  // A synthetic tool in the 'products' category, which the 'product' specialist owns -
  // the tool being unavailable must not be reported as a permission problem. Synthetic
  // rather than a real registry id because every tool in an owned category is now
  // implemented: product_research, the last one, is wrapped by
  // tools/productResearchTool.js, and the two tools that remain 'not_implemented'
  // (memory_retrieval, verification) are shared infrastructure that no specialist owns,
  // so neither could exercise this branch honestly.
  const result = evaluateToolAccess({
    specialistId: 'product',
    tool: { id: 'hypothetical_product_tool', status: 'not_implemented', category: 'products' },
  });
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

test('only the Product specialist role grants "execute" today, scoped to the three Shopify write tools', () => {
  for (const [specialistId, role] of Object.entries(SPECIALIST_ROLE_PERMISSIONS)) {
    if (specialistId === 'product') {
      assert.ok(role.includes('execute'), "product's role must include execute (2026-09-08 decision)");
    } else {
      assert.ok(!role.includes('execute'), `${specialistId} should not include execute`);
    }
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

// ---------------------------------------------------------------------------------
// THE PLATFORM GATE - the third least-privilege axis, after category and role.
// ---------------------------------------------------------------------------------
//
// NO NETWORK, NO CREDENTIAL, NO ADAPTER is touched by any test below: the gate is pure
// and reads only the list it is handed. The ETSY_* env vars set in the headline test are
// deliberate canaries proving exactly that - the decision must not move when credentials
// appear.

// --- the acceptance case: a Shopify-only business cannot reach Etsy tools -------------

test('ACCEPTANCE: a Shopify-only business is DENIED both Etsy tools, even with Etsy credentials present', () => {
  const saved = {
    ETSY_API_KEYSTRING: process.env.ETSY_API_KEYSTRING,
    ETSY_OAUTH_ACCESS_TOKEN: process.env.ETSY_OAUTH_ACCESS_TOKEN,
    ETSY_OAUTH_REFRESH_TOKEN: process.env.ETSY_OAUTH_REFRESH_TOKEN,
    ETSY_SHOP_ID: process.env.ETSY_SHOP_ID,
    ETSY_SHARED_SECRET: process.env.ETSY_SHARED_SECRET,
  };
  // Fully "connected" Etsy credentials - fake values, never used to call anything.
  process.env.ETSY_API_KEYSTRING = 'CANARY-etsy-keystring-must-not-enable-etsy';
  process.env.ETSY_OAUTH_ACCESS_TOKEN = 'CANARY-etsy-access-token-must-not-enable-etsy';
  process.env.ETSY_OAUTH_REFRESH_TOKEN = 'CANARY-etsy-refresh-token-must-not-enable-etsy';
  process.env.ETSY_SHOP_ID = '12345678';
  process.env.ETSY_SHARED_SECRET = 'CANARY-etsy-shared-secret-must-not-enable-etsy';

  try {
    for (const toolId of ['etsy_shop_data_retrieval', 'etsy_listing_data_retrieval']) {
      // Product is the specialist that genuinely OWNS these tools by category and role -
      // so category and role both pass, and only the platform gate can refuse them. That
      // is the whole point: this is not a re-test of category ownership.
      const owned = checkToolAccess({ specialistId: 'product', toolId });
      assert.strictEqual(owned.decision, 'allowed', `${toolId} should be category/role-permitted for product`);

      const result = checkToolAccess({ specialistId: 'product', toolId, enabledPlatforms: ['shopify'] });
      assert.strictEqual(result.decision, 'denied', `${toolId} must be denied for a Shopify-only business`);
      assert.strictEqual(result.permitted, false);
      assert.strictEqual(result.platform_permitted, false);
      // The earlier gates are reported as having passed, so the reason is unambiguous.
      assert.strictEqual(result.category_permitted, true);
      assert.strictEqual(result.operation_permitted, true);
      assert.ok(/etsy/.test(result.reason), 'the reason must name the platform the tool is bound to');
      assert.ok(
        /never from which credentials happen to be present/.test(result.reason),
        'the reason must state that credentials do not grant enablement'
      );
      // The canary must never surface in a refusal.
      assert.ok(!/CANARY/.test(result.reason), 'no credential value may appear in the reason');
    }
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("a Shopify-only business keeps every Shopify-bound tool it already owns", () => {
  for (const toolId of ['product_data_retrieval', 'collection_data_retrieval']) {
    const result = checkToolAccess({ specialistId: 'product', toolId, enabledPlatforms: ['shopify'] });
    assert.strictEqual(result.decision, 'allowed', `${toolId} should stay allowed`);
    assert.strictEqual(result.platform_permitted, true);
  }
});

test('an Etsy-only business is the mirror image: Etsy tools allowed, Shopify tools denied', () => {
  assert.strictEqual(
    checkToolAccess({ specialistId: 'product', toolId: 'etsy_shop_data_retrieval', enabledPlatforms: ['etsy'] }).decision,
    'allowed'
  );
  assert.strictEqual(
    checkToolAccess({ specialistId: 'product', toolId: 'product_data_retrieval', enabledPlatforms: ['etsy'] }).decision,
    'denied'
  );
});

// --- platform-neutral tools are never affected ---------------------------------------

test('platform-neutral tools stay available under ANY enabled set, including none at all', () => {
  const neutral = [
    ['research', 'market_research'],
    ['seo', 'keyword_research'],
    ['listing', 'listing_content_generation'],
    ['marketing', 'marketing_analysis'],
    ['social_advertising', 'social_content_planning'],
    ['analytics_optimization', 'analytics'],
    [null, 'ai_reasoning_completion'],
  ];
  for (const enabledPlatforms of [[], ['shopify'], ['etsy'], ['shopify', 'etsy']]) {
    for (const [specialistId, toolId] of neutral) {
      assert.deepStrictEqual(getToolById(toolId).platforms, [], `${toolId} should be platform-neutral`);
      const result = checkToolAccess({ specialistId, toolId, enabledPlatforms });
      assert.strictEqual(
        result.decision,
        'allowed',
        `${toolId} should stay allowed with enabledPlatforms=${JSON.stringify(enabledPlatforms)}`
      );
      assert.strictEqual(result.platform_permitted, true);
    }
  }
});

// --- the one multi-platform tool (PLATFORM_GATE_RULE: ANY, not ALL) -------------------

test('a multi-platform tool is allowed when EITHER of its platforms is enabled, denied when neither is', () => {
  const toolId = 'catalogue_expansion_opportunities';
  assert.deepStrictEqual(getToolById(toolId).platforms, ['shopify', 'etsy']);

  for (const enabledPlatforms of [['shopify'], ['etsy'], ['shopify', 'etsy']]) {
    assert.strictEqual(
      checkToolAccess({ specialistId: 'product', toolId, enabledPlatforms }).decision,
      'allowed',
      `should be allowed with ${JSON.stringify(enabledPlatforms)}`
    );
  }
  assert.strictEqual(checkToolAccess({ specialistId: 'product', toolId, enabledPlatforms: [] }).decision, 'denied');
});

test('PLATFORM_GATE_RULE documents the ANY semantics and does not overstate what it closes', () => {
  assert.strictEqual(PLATFORM_GATE_RULE.id, 'platform_gate_requires_any_declared_platform_enabled');
  assert.ok(/AT LEAST ONE/.test(PLATFORM_GATE_RULE.description));
  // The residual gap must stay declared rather than quietly dropped.
  assert.ok(/customerMarketOpportunityTool/.test(PLATFORM_GATE_RULE.known_limitation));
});

// --- fail closed ---------------------------------------------------------------------

test('FAIL CLOSED: a platform-bound tool is denied for every uncertain enabled-platform value', () => {
  const badValues = [
    [],
    ['amazon'],
    ['ebay'],
    ['woocommerce'],
    ['Shopify'],
    ['SHOPIFY'],
    [''],
    [null],
    [undefined],
    [42],
    ['shopify ', ' shopify'],
    'shopify',
    {},
    0,
    NaN,
  ];
  for (const enabledPlatforms of badValues) {
    const result = checkToolAccess({ specialistId: 'product', toolId: 'product_data_retrieval', enabledPlatforms });
    assert.strictEqual(
      result.decision,
      'denied',
      `enabledPlatforms=${JSON.stringify(enabledPlatforms)} must deny a platform-bound tool`
    );
    assert.strictEqual(result.platform_permitted, false);
  }
});

test('an unrecognized platform can never be enabled, however it is written in config', () => {
  for (const platform of ['amazon', 'ebay', 'woocommerce', 'wordpress', '', null, undefined, 42]) {
    assert.strictEqual(
      isPlatformEnabledForBusiness({ platform, enabledPlatforms: [platform] }),
      false,
      `${JSON.stringify(platform)} must never count as enabled`
    );
  }
  // Listing an unknown platform alongside a real one grants only the real one.
  assert.strictEqual(isPlatformEnabledForBusiness({ platform: 'shopify', enabledPlatforms: ['amazon', 'shopify'] }), true);
  assert.strictEqual(isPlatformEnabledForBusiness({ platform: 'etsy', enabledPlatforms: ['amazon', 'shopify'] }), false);
});

test('isToolPlatformPermitted() treats an absent or empty tool binding as platform-neutral', () => {
  for (const toolPlatforms of [undefined, null, [], 'shopify', {}]) {
    assert.strictEqual(
      isToolPlatformPermitted({ toolPlatforms, enabledPlatforms: [] }),
      true,
      `toolPlatforms=${JSON.stringify(toolPlatforms)} must be treated as unrestricted`
    );
  }
  assert.strictEqual(isToolPlatformPermitted({ toolPlatforms: ['etsy'], enabledPlatforms: [] }), false);
});

// --- the gate is opt-in: omitting the list changes nothing ----------------------------

test('REGRESSION GUARD: omitting enabledPlatforms reproduces the pre-gate decision for EVERY tool', () => {
  const specialistIds = [null, ...Object.keys(SPECIALIST_ROLE_PERMISSIONS)];
  for (const tool of TOOL_REGISTRY) {
    for (const specialistId of specialistIds) {
      const omitted = checkToolAccess({ specialistId, toolId: tool.id });
      const explicitNull = checkToolAccess({ specialistId, toolId: tool.id, enabledPlatforms: null });
      const explicitUndefined = checkToolAccess({ specialistId, toolId: tool.id, enabledPlatforms: undefined });
      assert.deepStrictEqual(explicitNull, omitted, `${tool.id}/${specialistId}: null must behave as omitted`);
      assert.deepStrictEqual(explicitUndefined, omitted, `${tool.id}/${specialistId}: undefined must behave as omitted`);
      // With no platform context there is no platform verdict to report - never a
      // silently permissive `true`.
      if (omitted.decision === 'allowed' || omitted.decision === 'approval_required') {
        assert.strictEqual(omitted.platform_permitted, null, `${tool.id}: platform_permitted must be null when unchecked`);
      }
    }
  }
});

// --- ordering: the platform gate runs AFTER category and role ------------------------

test('a category-denied tool still reports the CATEGORY reason, not the platform one', () => {
  // seo does not own the 'products' category, and product_data_retrieval is Shopify-bound.
  const result = checkToolAccess({ specialistId: 'seo', toolId: 'product_data_retrieval', enabledPlatforms: [] });
  assert.strictEqual(result.decision, 'denied');
  assert.strictEqual(result.category_permitted, false);
  assert.strictEqual(result.platform_permitted, null, 'the platform gate must not have run');
  assert.ok(/not permitted to use tools in category/.test(result.reason));
});

test('a role-denied tool still reports the ROLE reason, not the platform one', () => {
  const result = evaluateToolAccess({
    specialistId: 'research',
    tool: { id: 'hypothetical_write_tool', status: 'implemented', category: 'research', operation: 'write', platforms: ['etsy'] },
    classification: 'analysis_only',
    enabledPlatforms: [],
  });
  assert.strictEqual(result.decision, 'denied');
  assert.strictEqual(result.operation_permitted, false);
  assert.strictEqual(result.platform_permitted, null, 'the platform gate must not have run');
  assert.ok(/does not permit 'write' operations/.test(result.reason));
});

test('an unavailable tool is still unavailable, whatever the enabled platforms say', () => {
  const result = checkToolAccess({ specialistId: null, toolId: 'memory_retrieval', enabledPlatforms: ['shopify'] });
  assert.strictEqual(result.decision, 'unavailable');
  assert.strictEqual(result.platform_permitted, null);
});

test('the platform gate runs BEFORE approval - a gated Shopify write is denied, never approval_required', () => {
  // shopify_vendor_correction is externally_executable, so with Shopify enabled it must
  // reach the approval gate; with Shopify disabled it must never get that far.
  const enabled = checkToolAccess({ specialistId: 'product', toolId: 'shopify_vendor_correction', enabledPlatforms: ['shopify'] });
  assert.strictEqual(enabled.decision, 'approval_required');
  assert.strictEqual(enabled.platform_permitted, true);

  const disabled = checkToolAccess({ specialistId: 'product', toolId: 'shopify_vendor_correction', enabledPlatforms: ['etsy'] });
  assert.strictEqual(disabled.decision, 'denied');
  assert.strictEqual(disabled.approval_required, null);
});

test('this module reads no credential and no file to decide a platform - the gate is pure', () => {
  const source = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '..', '..', 'agent', 'core', 'toolPermissions.js'),
    'utf8'
  );
  // Comment lines are stripped first: this file documents WHERE the enabled list comes
  // from (configuration/businessRegistry.js) on purpose, and naming a module in prose is
  // the opposite of depending on it. Only real code may be judged here.
  const code = source
    .split(/\r?\n/)
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n');

  for (const forbidden of ['process.env', 'readFileSync', 'existsSync', 'businessRegistry', 'configValidator']) {
    assert.ok(!code.includes(forbidden), `agent/core/toolPermissions.js must not reference ${forbidden} in code`);
  }
  // Its only requires stay the three it already had, plus the platform vocabulary.
  const requires = (code.match(/require\('[^']+'\)/g) || []).sort();
  assert.deepStrictEqual(requires, [
    "require('../../approvals/approvalArchitecture')",
    "require('../../tools/toolRegistry')",
    "require('../../tools/toolRegistry')",
    "require('./channelModel')",
  ]);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
