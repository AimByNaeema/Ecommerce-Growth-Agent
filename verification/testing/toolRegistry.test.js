'use strict';

const assert = require('node:assert');
const {
  TOOL_CATEGORIES,
  TOOL_STATUSES,
  TOOL_OPERATIONS,
  TOOL_PLATFORMS,
  TOOL_REGISTRY,
  getToolById,
  getToolsByCategory,
  getToolsByStatus,
  getToolsByOperation,
  getToolsByPlatform,
} = require('../../tools/toolRegistry');
const { CHANNELS } = require('../../agent/core/channelModel');

// The ONLY platform-bound tools, and exactly which platform(s) each reaches. Hand-written
// here on purpose: this is the independent check on the registry, so it must not be
// derived from the registry it is checking. Every entry is grounded in the tool's own
// implementation - the seven tool files that require() an adapter under
// integrations/adapters/, plus the three shopify_* corrections whose registry
// descriptions name the Shopify mutation each one calls.
const EXPECTED_PLATFORM_BINDINGS = {
  business_configuration_retrieval: ['shopify'],
  product_data_retrieval: ['shopify'],
  collection_data_retrieval: ['shopify'],
  analytics_data_retrieval: ['shopify'],
  shopify_vendor_correction: ['shopify'],
  shopify_inventory_correction: ['shopify'],
  shopify_collection_membership_update: ['shopify'],
  etsy_shop_data_retrieval: ['etsy'],
  etsy_listing_data_retrieval: ['etsy'],
  // The one genuinely multi-platform tool: tools/customerMarketOpportunityTool.js reads
  // the Shopify catalogue and the Etsy listings independently in one Promise.all.
  catalogue_expansion_opportunities: ['shopify', 'etsy'],
};

const EXPECTED_ORDER = [
  'business_configuration_retrieval',
  'product_data_retrieval',
  'collection_data_retrieval',
  'etsy_shop_data_retrieval',
  'etsy_listing_data_retrieval',
  'market_product_opportunity_analysis',
  'product_research',
  'market_research',
  'customer_research',
  'global_market_opportunity_analysis',
  'catalogue_expansion_opportunities',
  'competitor_research',
  'research_analysis',
  'keyword_research',
  'seo_analysis',
  'listing_content_generation',
  'marketing_analysis',
  'offer_recommendation',
  'social_content_planning',
  'paid_advertising_planning',
  'social_media_strategy_generation',
  'platform_content_generation',
  'content_calendar_generation',
  'advertising_strategy_planning',
  'advertising_performance_analysis',
  'analytics',
  'analytics_data_retrieval',
  'ai_reasoning_completion',
  'memory_retrieval',
  'verification',
  'live_competitor_research',
  'discover_market_questions',
  'seo_content_generation',
  'compliance_check',
  'seo_quality_check',
  'listing_quality_check',
  'shopify_vendor_correction',
  'shopify_inventory_correction',
  'shopify_collection_membership_update',
];

const IMPLEMENTED_IDS = [
  'business_configuration_retrieval',
  'product_data_retrieval',
  'collection_data_retrieval',
  // The two Etsy reads. Read-only GETs against the Etsy Open API v3 for the owner's own
  // shop (integrations/adapters/etsyReadClient.js), which has no write path at all - the
  // Etsy PUBLISH adapter remains closed and is untouched by them. Added in the read-only
  // Etsy phase alongside tools/etsyShopDataTool.js and tools/etsyListingDataTool.js.
  'etsy_shop_data_retrieval',
  'etsy_listing_data_retrieval',
  'market_product_opportunity_analysis',
  // Long reserved as 'not_implemented' and now wrapped by tools/productResearchTool.js,
  // which connects the four Product capabilities that previously had no tool.
  'product_research',
  'market_research',
  'customer_research',
  'global_market_opportunity_analysis',
  'catalogue_expansion_opportunities',
  'competitor_research',
  'research_analysis',
  'keyword_research',
  'seo_analysis',
  'listing_content_generation',
  'marketing_analysis',
  // Wraps agent/core/offerRecommendationEngine.js, the one implemented Marketing engine
  // that had no route into normal Chief dispatch.
  'offer_recommendation',
  'social_content_planning',
  'paid_advertising_planning',
  'social_media_strategy_generation',
  'platform_content_generation',
  'content_calendar_generation',
  'advertising_strategy_planning',
  'advertising_performance_analysis',
  'analytics',
  'analytics_data_retrieval',
  'ai_reasoning_completion',
  'live_competitor_research',
  'discover_market_questions',
  'seo_content_generation',
  'compliance_check',
  // Wrap agent/core/seoQualityChecker.js and agent/core/listingQualityChecker.js, the
  // two remaining implemented SEO/Listing engines that had no route into normal Chief
  // dispatch - the same gap tools/offerRecommendationTool.js closed for Marketing.
  'seo_quality_check',
  'listing_quality_check',
  // The first three 'execute'-operation tools: each calls the external Shopify store
  // directly, once authorized through the full compliance -> approval -> publish-
  // authorization chain (see integrations/shopifyVendorCorrection.js,
  // integrations/shopifyInventoryCorrection.js, and
  // integrations/shopifyCollectionMembership.js). Added 2026-09-08, by explicit user
  // decision, to execute confirmed store-growth corrections.
  'shopify_vendor_correction',
  'shopify_inventory_correction',
  'shopify_collection_membership_update',
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

test('the registry has exactly the 39 required tools, in the requested order', () => {
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

test('every entry has a valid category, status, and operation', () => {
  for (const tool of TOOL_REGISTRY) {
    assert.ok(TOOL_CATEGORIES.includes(tool.category), `${tool.id} has an invalid category: ${tool.category}`);
    assert.ok(TOOL_STATUSES.includes(tool.status), `${tool.id} has an invalid status: ${tool.status}`);
    assert.ok(TOOL_OPERATIONS.includes(tool.operation), `${tool.id} has an invalid operation: ${tool.operation}`);
  }
});

test('TOOL_OPERATIONS is exactly read/write/execute', () => {
  assert.deepStrictEqual(TOOL_OPERATIONS, ['read', 'write', 'execute']);
});

test('exactly the three Shopify write tools are "execute" - each calls the external store directly, once authorized', () => {
  assert.deepStrictEqual(
    getToolsByOperation('execute')
      .map((tool) => tool.id)
      .sort(),
    ['shopify_collection_membership_update', 'shopify_inventory_correction', 'shopify_vendor_correction']
  );
});

test('getToolsByOperation() filters correctly', () => {
  const writeTools = getToolsByOperation('write');
  assert.deepStrictEqual(
    writeTools.map((tool) => tool.id).sort(),
    [
      'ai_reasoning_completion',
      'content_calendar_generation',
      'listing_content_generation',
      // Audits an already-built listing content record - registered 'write' because
      // agent/core/toolPermissions.js's SPECIALIST_ROLE_PERMISSIONS scopes Listing to
      // ['write'] only, the same precedent offer_recommendation set for Marketing's
      // identical write-only role (see tools/listingQualityCheckTool.js).
      'listing_quality_check',
      'marketing_analysis',
      // Composes an offer recommendation record for a human to act on - applies,
      // publishes and purchases nothing (see tools/offerRecommendationTool.js).
      'offer_recommendation',
      'paid_advertising_planning',
      'platform_content_generation',
      'social_content_planning',
      'social_media_strategy_generation',
      'advertising_strategy_planning',
      // Authors website content answering a real customer question - the SEO
      // specialist's one write tool. Publishes nothing.
      'seo_content_generation',
    ].sort()
  );
});

test('every entry except the implemented set is not_implemented - do not implement other tools yet', () => {
  for (const tool of TOOL_REGISTRY) {
    if (IMPLEMENTED_IDS.includes(tool.id)) continue;
    assert.strictEqual(tool.status, 'not_implemented', `${tool.id} should not be implemented yet`);
  }
});

test('business_configuration_retrieval, product_data_retrieval, collection_data_retrieval, market_product_opportunity_analysis, market_research, customer_research, global_market_opportunity_analysis, competitor_research, keyword_research, seo_analysis, listing_content_generation, marketing_analysis, social_content_planning, paid_advertising_planning, social_media_strategy_generation, platform_content_generation, content_calendar_generation, advertising_strategy_planning, advertising_performance_analysis, analytics, analytics_data_retrieval, ai_reasoning_completion, and live_competitor_research are implemented', () => {
  for (const id of IMPLEMENTED_IDS) {
    assert.strictEqual(getToolById(id).status, 'implemented', `${id} should be implemented`);
  }
});

test('getToolById() finds a known tool and returns undefined for an unknown one', () => {
  assert.strictEqual(getToolById('keyword_research').title, 'Keyword research');
  assert.strictEqual(getToolById('does_not_exist'), undefined);
});

test('getToolsByCategory() filters correctly', () => {
  const seoTools = getToolsByCategory('seo');
  assert.deepStrictEqual(seoTools.map((tool) => tool.id), [
    'keyword_research',
    'seo_analysis',
    'discover_market_questions',
    'seo_content_generation',
    'seo_quality_check',
  ]);
});

test('getToolsByStatus() returns the correct counts for each status', () => {
  assert.strictEqual(getToolsByStatus('not_implemented').length, TOOL_REGISTRY.length - IMPLEMENTED_IDS.length);
  assert.strictEqual(getToolsByStatus('implemented').length, IMPLEMENTED_IDS.length);
});

// ---------------------------------------------------------------------------------
// PLATFORM BINDING - the third axis, read by agent/core/toolPermissions.js's gate.
// ---------------------------------------------------------------------------------

test('TOOL_PLATFORMS is agent/core/channelModel.js CHANNELS, not a second platform list', () => {
  assert.deepStrictEqual(TOOL_PLATFORMS, CHANNELS);
  // Guards against a platform being named here before a real adapter for it exists.
  assert.deepStrictEqual(TOOL_PLATFORMS, ['shopify', 'etsy']);
});

test('every entry declares a platforms array naming only platforms with a real adapter', () => {
  for (const tool of TOOL_REGISTRY) {
    assert.ok(Array.isArray(tool.platforms), `${tool.id} platforms must be an array`);
    for (const platform of tool.platforms) {
      assert.ok(
        TOOL_PLATFORMS.includes(platform),
        `${tool.id} names platform '${platform}', which this project has no adapter for`
      );
    }
    assert.strictEqual(
      new Set(tool.platforms).size,
      tool.platforms.length,
      `${tool.id} lists a platform more than once`
    );
  }
});

test('exactly the expected tools are platform-bound, with exactly the expected platforms', () => {
  const actual = {};
  for (const tool of TOOL_REGISTRY) {
    if (tool.platforms.length > 0) actual[tool.id] = tool.platforms;
  }
  assert.deepStrictEqual(actual, EXPECTED_PLATFORM_BINDINGS);
});

test('every other tool is platform-neutral - it reaches no e-commerce platform at all', () => {
  const neutral = TOOL_REGISTRY.filter((tool) => tool.platforms.length === 0).map((tool) => tool.id);
  assert.strictEqual(neutral.length, TOOL_REGISTRY.length - Object.keys(EXPECTED_PLATFORM_BINDINGS).length);
  for (const id of Object.keys(EXPECTED_PLATFORM_BINDINGS)) {
    assert.ok(!neutral.includes(id), `${id} should be platform-bound, not neutral`);
  }
});

test('getToolsByPlatform() returns every tool bound to that platform, including multi-platform ones', () => {
  const shopify = getToolsByPlatform('shopify').map((tool) => tool.id);
  const etsy = getToolsByPlatform('etsy').map((tool) => tool.id);

  assert.deepStrictEqual(
    shopify,
    Object.keys(EXPECTED_PLATFORM_BINDINGS).filter((id) => EXPECTED_PLATFORM_BINDINGS[id].includes('shopify'))
      .sort((a, b) => EXPECTED_ORDER.indexOf(a) - EXPECTED_ORDER.indexOf(b))
  );
  assert.deepStrictEqual(
    etsy,
    Object.keys(EXPECTED_PLATFORM_BINDINGS).filter((id) => EXPECTED_PLATFORM_BINDINGS[id].includes('etsy'))
      .sort((a, b) => EXPECTED_ORDER.indexOf(a) - EXPECTED_ORDER.indexOf(b))
  );

  // The multi-platform tool appears under BOTH, which is the point of an array field.
  assert.ok(shopify.includes('catalogue_expansion_opportunities'));
  assert.ok(etsy.includes('catalogue_expansion_opportunities'));
});

test('getToolsByPlatform(null) returns the platform-neutral tools', () => {
  const neutral = getToolsByPlatform(null).map((tool) => tool.id);
  assert.deepStrictEqual(getToolsByPlatform(undefined).map((tool) => tool.id), neutral);
  assert.ok(neutral.includes('keyword_research'));
  assert.ok(neutral.includes('compliance_check'));
  assert.ok(!neutral.includes('product_data_retrieval'));
  for (const tool of getToolsByPlatform(null)) {
    assert.deepStrictEqual(tool.platforms, []);
  }
});

test('getToolsByPlatform() returns [] for a platform this project has no adapter for', () => {
  for (const unknown of ['amazon', 'ebay', 'woocommerce', 'Shopify', 'SHOPIFY', '']) {
    assert.deepStrictEqual(getToolsByPlatform(unknown), [], `${unknown} should match no tool`);
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
