'use strict';

const assert = require('node:assert');
const {
  PRODUCT_CAPABILITY_IDS,
  RESEARCH_CAPABILITY_IDS,
  SPECIALIST_CAPABILITY_REGISTRY,
  getSpecialistCapabilityRegistry,
  getSpecialistCapabilityById,
  getCapabilityTask,
  getSpecialistCapabilityEntriesByStatus,
} = require('../../agent/core/specialistCapabilityRegistry');
const { getSpecialistById } = require('../../agent/core/specialistRegistry');
const { getToolsByCategory, getToolById } = require('../../tools/toolRegistry');
const { SPECIALIST_TO_CATEGORIES, checkToolAccess, SPECIALIST_ROLE_PERMISSIONS } = require('../../agent/core/toolPermissions');
const { RESEARCH_AGENT_RESULT_FIELDS } = require('../../agent/core/researchAgentResultModel');
const { SEO_CAPABILITIES, SEO_AGENT_RESULT_FIELDS } = require('../../agent/core/seoAgentResultModel');
const { LISTING_CAPABILITIES, LISTING_AGENT_RESULT_FIELDS } = require('../../agent/core/listingAgentResultModel');
const { MARKETING_CAPABILITIES, MARKETING_AGENT_RESULT_FIELDS } = require('../../agent/core/marketingAgentResultModel');
const {
  SOCIAL_ADVERTISING_CAPABILITIES,
  SOCIAL_ADVERTISING_AGENT_RESULT_FIELDS,
} = require('../../agent/core/socialAdvertisingAgentResultModel');
const { ANALYTICS_CAPABILITIES, ANALYTICS_AGENT_RESULT_FIELDS } = require('../../agent/core/analyticsAgentResultModel');

const EXPECTED_ORDER = ['research', 'product', 'seo', 'listing', 'marketing', 'social_advertising', 'analytics_optimization'];

const CAPABILITY_ENUM_BY_SPECIALIST = {
  research: RESEARCH_CAPABILITY_IDS,
  product: PRODUCT_CAPABILITY_IDS,
  seo: SEO_CAPABILITIES,
  listing: LISTING_CAPABILITIES,
  marketing: MARKETING_CAPABILITIES,
  social_advertising: SOCIAL_ADVERTISING_CAPABILITIES,
  analytics_optimization: ANALYTICS_CAPABILITIES,
};

const OUTPUT_FIELDS_BY_SPECIALIST = {
  research: RESEARCH_AGENT_RESULT_FIELDS,
  seo: SEO_AGENT_RESULT_FIELDS,
  listing: LISTING_AGENT_RESULT_FIELDS,
  marketing: MARKETING_AGENT_RESULT_FIELDS,
  social_advertising: SOCIAL_ADVERTISING_AGENT_RESULT_FIELDS,
  analytics_optimization: ANALYTICS_AGENT_RESULT_FIELDS,
};

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

test('the registry has exactly the 7 approved specialists, in the same order as specialistRegistry.js', () => {
  assert.deepStrictEqual(SPECIALIST_CAPABILITY_REGISTRY.map((e) => e.id), EXPECTED_ORDER);
});

test('every entry\'s id/title/description/status deep-equals agent/core/specialistRegistry.js - reused, not copied', () => {
  for (const entry of SPECIALIST_CAPABILITY_REGISTRY) {
    const specialist = getSpecialistById(entry.id);
    assert.strictEqual(entry.title, specialist.title);
    assert.strictEqual(entry.description, specialist.description);
    assert.strictEqual(entry.status, specialist.status);
  }
});

test('all 7 specialists are status implemented, including product (the corrected stale field)', () => {
  for (const id of EXPECTED_ORDER) {
    assert.strictEqual(getSpecialistCapabilityById(id).status, 'implemented');
  }
});

test('required_tools for seo/research/product deep-equal fresh getToolsByCategory() calls - derived, not hand-listed', () => {
  const seoEntry = getSpecialistCapabilityById('seo');
  assert.deepStrictEqual(seoEntry.required_tools, getToolsByCategory('seo').map((t) => t.id));

  const researchEntry = getSpecialistCapabilityById('research');
  const expectedResearchTools = [
    ...getToolsByCategory('research').map((t) => t.id),
    ...getToolsByCategory('customer_market_intelligence').map((t) => t.id),
  ];
  assert.deepStrictEqual(researchEntry.required_tools, expectedResearchTools);

  const productEntry = getSpecialistCapabilityById('product');
  assert.deepStrictEqual(productEntry.required_tools, getToolsByCategory('products').map((t) => t.id));
});

test('permissions.categories for every entry deep-equals SPECIALIST_TO_CATEGORIES', () => {
  for (const entry of SPECIALIST_CAPABILITY_REGISTRY) {
    assert.deepStrictEqual(entry.permissions.categories, SPECIALIST_TO_CATEGORIES[entry.id] || []);
  }
});

test('every permissions.tool_access element deep-equals a fresh direct checkToolAccess() call - reused, not reimplemented', () => {
  for (const entry of SPECIALIST_CAPABILITY_REGISTRY) {
    for (const access of entry.permissions.tool_access) {
      const fresh = checkToolAccess({ specialistId: entry.id, toolId: access.tool_id });
      assert.deepStrictEqual(access, fresh);
    }
  }
});

test('known-decision spot checks: product_research is unavailable, market_research is allowed', () => {
  const productEntry = getSpecialistCapabilityById('product');
  const productResearchAccess = productEntry.permissions.tool_access.find((a) => a.tool_id === 'product_research');
  assert.strictEqual(productResearchAccess.decision, 'unavailable');

  const researchEntry = getSpecialistCapabilityById('research');
  const marketResearchAccess = researchEntry.permissions.tool_access.find((a) => a.tool_id === 'market_research');
  assert.strictEqual(marketResearchAccess.decision, 'allowed');
});

test('approval_requirements: an allowed tool has requires_human_approval false and its real classification', () => {
  const researchEntry = getSpecialistCapabilityById('research');
  const marketResearchApproval = researchEntry.approval_requirements.find((a) => a.tool_id === 'market_research');
  assert.strictEqual(marketResearchApproval.requires_human_approval, false);
  assert.strictEqual(marketResearchApproval.classification, 'analysis_only');
  assert.ok(marketResearchApproval.title);
});

test('approval_requirements: an unavailable tool has requires_human_approval true and a null classification - never silently fine', () => {
  const productEntry = getSpecialistCapabilityById('product');
  const productResearchApproval = productEntry.approval_requirements.find((a) => a.tool_id === 'product_research');
  assert.strictEqual(productResearchApproval.requires_human_approval, true);
  assert.strictEqual(productResearchApproval.classification, null);
});

test('every specialist\'s supported_tasks[].id list deep-equals its real capability enum (or PRODUCT_CAPABILITY_IDS)', () => {
  for (const [specialistId, expectedIds] of Object.entries(CAPABILITY_ENUM_BY_SPECIALIST)) {
    const entry = getSpecialistCapabilityById(specialistId);
    assert.deepStrictEqual(entry.supported_tasks.map((t) => t.id), expectedIds);
  }
});

test('every supported_tasks[].tool_ids is a subset of that entry\'s own required_tools', () => {
  for (const entry of SPECIALIST_CAPABILITY_REGISTRY) {
    for (const task of entry.supported_tasks) {
      for (const toolId of task.tool_ids) {
        assert.ok(entry.required_tools.includes(toolId), `${entry.id}/${task.id} references ${toolId} not in required_tools`);
      }
    }
  }
});

test('every tool_id referenced anywhere in supported_tasks is a real, known tool', () => {
  for (const entry of SPECIALIST_CAPABILITY_REGISTRY) {
    for (const task of entry.supported_tasks) {
      for (const toolId of task.tool_ids) {
        assert.ok(getToolById(toolId), `${toolId} is not a real tools/toolRegistry.js entry`);
      }
    }
  }
});

test('the known Research tool_ids gaps (global_market_research, trend_research, opportunity_discovery) are honestly empty', () => {
  const researchEntry = getSpecialistCapabilityById('research');
  for (const id of ['global_market_research', 'trend_research', 'opportunity_discovery']) {
    const task = researchEntry.supported_tasks.find((t) => t.id === id);
    assert.deepStrictEqual(task.tool_ids, []);
  }
  for (const id of ['market_research', 'competitor_research', 'customer_market_intelligence', 'customer_segmentation']) {
    const task = researchEntry.supported_tasks.find((t) => t.id === id);
    assert.ok(task.tool_ids.length > 0, `${id} should have at least one tool id`);
  }
});

test('4 of Product\'s 5 productAgent.js-backed supported_tasks have tool_ids: [] - no tool wraps productAgent.js\'s own functions today (market_product_opportunity_analysis and product_discovery are the two exceptions: a separate workflow wired to a real tool, and a live Shopify pull wired to a real tool, respectively)', () => {
  const productEntry = getSpecialistCapabilityById('product');
  for (const task of productEntry.supported_tasks) {
    if (task.id === 'market_product_opportunity_analysis') {
      assert.deepStrictEqual(task.tool_ids, ['market_product_opportunity_analysis']);
    } else if (task.id === 'product_discovery') {
      assert.deepStrictEqual(task.tool_ids, ['product_data_retrieval']);
      assert.strictEqual(task.live_data_tool_id, 'product_data_retrieval');
    } else {
      assert.deepStrictEqual(task.tool_ids, []);
      assert.strictEqual(task.live_data_tool_id, null);
    }
  }
});

test('output_contract.fields for one task per envelope-based specialist deep-equals the real *_FIELDS.map(f => f.id)', () => {
  const checks = [
    ['seo', 'product_seo'],
    ['listing', 'listing_content'],
    ['marketing', 'marketing_strategy'],
    ['social_advertising', 'instagram'],
    ['analytics_optimization', 'sales'],
    ['research', 'market_research'],
  ];
  for (const [specialistId, taskId] of checks) {
    const task = getCapabilityTask(specialistId, taskId);
    const expectedFields = OUTPUT_FIELDS_BY_SPECIALIST[specialistId].map((f) => f.id);
    assert.deepStrictEqual(task.output_contract.fields, expectedFields);
  }
});

test('Product\'s 4 model-backed tasks each point at their own distinct output model, and product_validation is the honest ad hoc exception', () => {
  const { PRODUCT_FIELDS } = require('../../agent/core/productModel');
  const { PRODUCT_AGENT_RESULT_FIELDS } = require('../../agent/core/productAgentResultModel');
  const { PRODUCT_OPPORTUNITY_SCORE_FIELDS } = require('../../agent/core/productOpportunityScoreModel');
  const { PRODUCT_RECOMMENDATION_FIELDS } = require('../../agent/core/productRecommendationModel');

  assert.deepStrictEqual(
    getCapabilityTask('product', 'product_discovery').output_contract.fields,
    PRODUCT_FIELDS.map((f) => f.id)
  );
  assert.deepStrictEqual(
    getCapabilityTask('product', 'product_opportunity_analysis').output_contract.fields,
    PRODUCT_AGENT_RESULT_FIELDS.map((f) => f.id)
  );
  assert.deepStrictEqual(
    getCapabilityTask('product', 'product_opportunity_scoring').output_contract.fields,
    PRODUCT_OPPORTUNITY_SCORE_FIELDS.map((f) => f.id)
  );
  assert.deepStrictEqual(
    getCapabilityTask('product', 'product_recommendation').output_contract.fields,
    PRODUCT_RECOMMENDATION_FIELDS.map((f) => f.id)
  );

  const validationTask = getCapabilityTask('product', 'product_validation');
  assert.strictEqual(validationTask.output_contract.model, null);
  assert.deepStrictEqual(validationTask.output_contract.fields, ['shape_valid', 'shape_errors', 'completeness', 'is_research_ready']);
});

test('getSpecialistCapabilityById() finds a known entry and returns undefined for an unknown one', () => {
  assert.strictEqual(getSpecialistCapabilityById('seo').title, 'SEO');
  assert.strictEqual(getSpecialistCapabilityById('does_not_exist'), undefined);
});

test('getCapabilityTask() finds a known task and returns undefined for an unknown specialist or capability', () => {
  assert.strictEqual(getCapabilityTask('seo', 'product_seo').title, 'Product SEO');
  assert.strictEqual(getCapabilityTask('seo', 'not_a_real_capability'), undefined);
  assert.strictEqual(getCapabilityTask('not_a_real_specialist', 'product_seo'), undefined);
});

test('getSpecialistCapabilityEntriesByStatus() returns all 7 as implemented and 0 as not_implemented', () => {
  assert.strictEqual(getSpecialistCapabilityEntriesByStatus('implemented').length, 7);
  assert.strictEqual(getSpecialistCapabilityEntriesByStatus('not_implemented').length, 0);
});

test('role-based permissions: every specialist\'s tool_access for a required, implemented tool reports operation_permitted true - each specialist only accesses tools its role covers', () => {
  for (const entry of SPECIALIST_CAPABILITY_REGISTRY) {
    for (const access of entry.permissions.tool_access) {
      if (access.decision === 'unavailable') continue; // not_implemented tools have no role verdict to check
      assert.strictEqual(
        access.operation_permitted,
        true,
        `${entry.id}'s tool_access for '${access.tool_id}' should be operation_permitted (role: ${SPECIALIST_ROLE_PERMISSIONS[entry.id]})`
      );
      const tool = getToolById(access.tool_id);
      assert.ok(
        SPECIALIST_ROLE_PERMISSIONS[entry.id].includes(tool.operation),
        `${entry.id}'s role (${SPECIALIST_ROLE_PERMISSIONS[entry.id]}) does not list '${tool.operation}', the real operation of '${access.tool_id}'`
      );
    }
  }
});

test('getSpecialistCapabilityRegistry() returns the same array getSpecialistCapabilityById reads from', () => {
  assert.strictEqual(getSpecialistCapabilityRegistry(), SPECIALIST_CAPABILITY_REGISTRY);
});

// Spot checks for the registry-completion pass (Part A of the token-efficient
// context management work): a few of the 19 tasks that previously declared no
// `optional` array at all now do, each field verified directly against its real
// *Agent.js handler - see the registry's own KNOWN `required` GAPS comment for what
// was deliberately left untouched.
test('global_market_research now declares a real optional array, including a per-entry field', () => {
  const task = getCapabilityTask('research', 'global_market_research');
  assert.ok(task.input_contract.optional.length > 0);
  assert.ok(task.input_contract.optional.includes('markets[].country'));
});

test('product_discovery now declares a real optional array, including a nested pricing sub-field', () => {
  const task = getCapabilityTask('product', 'product_discovery');
  assert.ok(task.input_contract.optional.length > 0);
  assert.ok(task.input_contract.optional.includes('entries[].pricing.price'));
});

test('insights declares a real optional array but never lists `recommendations` - it is computed, not caller-supplied', () => {
  const task = getCapabilityTask('analytics_optimization', 'insights');
  assert.ok(task.input_contract.optional.length > 0);
  assert.ok(task.input_contract.optional.includes('metrics[].possibleCause'));
  assert.ok(
    !task.input_contract.optional.includes('recommendations'),
    'analyzeInsights() computes recommendations itself and never reads params.recommendations'
  );
});

test('product_validation is honestly left with an empty optional array - validateProduct() reads only productRecord', () => {
  const task = getCapabilityTask('product', 'product_validation');
  assert.deepStrictEqual(task.input_contract.optional, []);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
