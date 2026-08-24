'use strict';

// The registry of tools the Chief/Orchestrator may call. This is a registry
// FOUNDATION plus real, callable tools: a descriptive list plus small read-only
// lookup helpers - there is still no register/execute/dispatch function anywhere in
// this file (that lives in agent/core/orchestratorExecutionContract.js, gated by
// agent/core/toolPermissions.js), so tools are not called *from here*.
// business_configuration_retrieval, ai_reasoning_completion, market_research,
// competitor_research, customer_research, product_data_retrieval, keyword_research,
// seo_analysis, listing_content_generation, marketing_analysis,
// social_content_planning, paid_advertising_planning,
// social_media_strategy_generation, platform_content_generation,
// content_calendar_generation, advertising_strategy_planning, and
// advertising_performance_analysis are the seventeen entries actually implemented (see
// tools/businessConfigurationRetrieval.js, tools/aiReasoningCompletion.js,
// tools/marketResearchTool.js, tools/competitorResearchTool.js,
// tools/customerResearchTool.js, tools/productDataRetrievalTool.js,
// tools/keywordResearchTool.js, tools/seoAnalysisTool.js, tools/listingContentTool.js,
// tools/marketingAnalysisTool.js, tools/socialContentTool.js,
// tools/paidAdvertisingTool.js, tools/socialMediaStrategyTool.js,
// tools/platformContentTool.js, tools/contentCalendarTool.js,
// tools/advertisingStrategyTool.js, and tools/advertisingPerformanceTool.js) - the
// other 2 tools remain 'not_implemented'.
//
// This is a single shared list for the ONE agent - every entry is a capability that
// agent can eventually use, never a separate agent, persona, or system prompt. See
// agent/core/agentContract.js's select_tools stage, which this registry exists to
// support.

const TOOL_CATEGORIES = [
  'configuration',
  'products',
  'research',
  'customer_market_intelligence',
  'seo',
  'listing',
  'marketing',
  'social_advertising',
  'analytics',
  'ai_reasoning',
  'memory',
  'verification',
];

const TOOL_STATUSES = ['not_implemented', 'implemented'];

const TOOL_REGISTRY = [
  {
    id: 'business_configuration_retrieval',
    title: 'Business configuration retrieval',
    description:
      "Retrieve the connected Shopify store's shop identity (name, domain, email) via integrations/adapters/shopifyClient.js's getShopInfo() - see tools/businessConfigurationRetrieval.js.",
    category: 'configuration',
    status: 'implemented',
  },
  {
    id: 'product_data_retrieval',
    title: 'Product data retrieval',
    description:
      "Retrieve read-only product data (products, variants, inventory, prices, SKUs, status, collections, metadata) from the connected Shopify store via integrations/adapters/shopifyClient.js's getProducts() - see tools/productDataRetrievalTool.js. No writes.",
    category: 'products',
    status: 'implemented',
  },
  {
    id: 'product_research',
    title: 'Product research',
    description:
      'Run product research per the products/productResearchArchitecture.js pipeline.',
    category: 'products',
    status: 'not_implemented',
  },
  {
    id: 'market_research',
    title: 'Market research',
    description:
      "Produce market research records conforming to agent/core/marketResearchModel.js via agent/core/researchAgent.js's runMarketResearch() - see tools/marketResearchTool.js.",
    category: 'research',
    status: 'implemented',
  },
  {
    id: 'customer_research',
    title: 'Customer research',
    description:
      "Produce customer segment research records conforming to agent/core/customerSegmentResearchModel.js via agent/core/researchAgent.js's runCustomerMarketIntelligence() - see tools/customerResearchTool.js.",
    category: 'customer_market_intelligence',
    status: 'implemented',
  },
  {
    id: 'competitor_research',
    title: 'Competitor research',
    description:
      "Produce competitor research records conforming to agent/core/competitorResearchModel.js via agent/core/researchAgent.js's runCompetitorResearch() - see tools/competitorResearchTool.js.",
    category: 'research',
    status: 'implemented',
  },
  {
    id: 'keyword_research',
    title: 'Keyword research',
    description:
      "Produce agent/core/seoResearchModel.js keyword records and search-intent groupings via agent/core/seoAgent.js's runKeywordResearch()/analyzeSearchIntent(), following the workflows/keywordResearchWorkflow.js pipeline - see tools/keywordResearchTool.js.",
    category: 'seo',
    status: 'implemented',
  },
  {
    id: 'seo_analysis',
    title: 'SEO analysis',
    description:
      "Analyze product/collection/content on-page SEO and SEO opportunity coverage via agent/core/seoAgent.js, composing agent/core/listingOptimizationModel.js and agent/core/onPageOptimizationModel.js records - see tools/seoAnalysisTool.js.",
    category: 'seo',
    status: 'implemented',
  },
  {
    id: 'listing_content_generation',
    title: 'Listing content generation',
    description:
      "Compose agent/core/listingContentModel.js listing-content records (title, description, benefits, features, selling points, FAQs, attributes, variants) and agent/core/marketplaceListingFormatModel.js marketplace-formatted records via agent/core/listingAgent.js - see tools/listingContentTool.js.",
    category: 'listing',
    status: 'implemented',
  },
  {
    id: 'marketing_analysis',
    title: 'Marketing analysis',
    description:
      "Produce agent/core/marketingAnalysisModel.js, agent/core/growthOpportunityModel.js, and agent/core/customerSegmentResearchModel.js records via agent/core/marketingAgent.js's 8 capabilities (marketing strategy, audience segmentation, offers, promotions, retention, campaign planning, email strategy, conversion opportunities) - see tools/marketingAnalysisTool.js.",
    category: 'marketing',
    status: 'implemented',
  },
  {
    id: 'social_content_planning',
    title: 'Social content planning',
    description:
      "Compose agent/core/socialContentModel.js social media content records via agent/core/socialAdvertisingAgent.js's 5 social capabilities (instagram, facebook, tiktok, pinterest, youtube) - see tools/socialContentTool.js.",
    category: 'social_advertising',
    status: 'implemented',
  },
  {
    id: 'paid_advertising_planning',
    title: 'Paid advertising planning',
    description:
      "Compose agent/core/adCampaignModel.js paid ad campaign records via agent/core/socialAdvertisingAgent.js's 3 advertising capabilities (meta_ads, google_ads, tiktok_ads) - see tools/paidAdvertisingTool.js.",
    category: 'social_advertising',
    status: 'implemented',
  },
  {
    id: 'social_media_strategy_generation',
    title: 'Social media strategy generation',
    description:
      "Compose agent/core/socialMediaStrategyModel.js cross-platform strategy records (content pillars, audience, platform selection, posting strategy, content themes, campaign themes, KPIs) via agent/core/socialAdvertisingAgent.js's social_media_strategy capability - see tools/socialMediaStrategyTool.js.",
    category: 'social_advertising',
    status: 'implemented',
  },
  {
    id: 'platform_content_generation',
    title: 'Platform-aware ecommerce content generation',
    description:
      "Compose agent/core/platformContentModel.js content records (hooks, captions, CTAs, content ideas, short-form video concepts, carousel concepts, creative briefs, all adapted to one selected platform) via agent/core/socialAdvertisingAgent.js's content_generation capability - see tools/platformContentTool.js.",
    category: 'social_advertising',
    status: 'implemented',
  },
  {
    id: 'content_calendar_generation',
    title: 'Social content calendar generation',
    description:
      "Compose agent/core/contentCalendarModel.js calendar entries (date, platform, content type, topic, hook, CTA, campaign, product, KPI) via agent/core/socialAdvertisingAgent.js's content_calendar capability, optionally informed by Marketing Agent campaign context via agent/core/marketingAgent.js's campaign_plan builder - see tools/contentCalendarTool.js.",
    category: 'social_advertising',
    status: 'implemented',
  },
  {
    id: 'advertising_strategy_planning',
    title: 'Advertising strategy planning',
    description:
      "Compose agent/core/advertisingStrategyModel.js pre-launch advertising strategy records (campaign objective, audience, offer, creative angle, ad copy, CTA, budget recommendation, KPI, testing plan) via agent/core/socialAdvertisingAgent.js's advertising_strategy capability - see tools/advertisingStrategyTool.js.",
    category: 'social_advertising',
    status: 'implemented',
  },
  {
    id: 'advertising_performance_analysis',
    title: 'Advertising performance analysis',
    description:
      "Compose agent/core/advertisingPerformanceModel.js performance records (impressions, CTR, CPC, CPM, conversions, CPA, ROAS) via agent/core/socialAdvertisingAgent.js's advertising_performance capability, separating caller-supplied actual metrics from metrics agent/core/advertisingPerformanceCalculator.js derives from them, and from recommendations - see tools/advertisingPerformanceTool.js.",
    category: 'social_advertising',
    status: 'implemented',
  },
  {
    id: 'analytics',
    title: 'Analytics',
    description:
      'Retrieve or compute store performance/growth metrics (see analytics/README.md).',
    category: 'analytics',
    status: 'not_implemented',
  },
  {
    id: 'ai_reasoning_completion',
    title: 'AI reasoning completion',
    description:
      "Run one structured Claude completion (instruction + optional context) via agent/core/claudeClient.js's sendMessage() - see tools/aiReasoningCompletion.js. Every call is capped/budgeted by agent/core/tokenControls.js.",
    category: 'ai_reasoning',
    status: 'implemented',
  },
  {
    id: 'memory_retrieval',
    title: 'Memory retrieval',
    description:
      'Retrieve persisted state from memory/state/ per agent/core/memoryRules.js and agent/core/stateModel.js.',
    category: 'memory',
    status: 'not_implemented',
  },
  {
    id: 'verification',
    title: 'Verification',
    description:
      "Verify results/evidence per agent/core/researchRecordModel.js's confidence/verification_status convention and the agent contract's verify_results stage.",
    category: 'verification',
    status: 'not_implemented',
  },
];

function getToolRegistry() {
  return TOOL_REGISTRY;
}

function getToolById(id) {
  return TOOL_REGISTRY.find((tool) => tool.id === id);
}

function getToolsByCategory(category) {
  return TOOL_REGISTRY.filter((tool) => tool.category === category);
}

function getToolsByStatus(status) {
  return TOOL_REGISTRY.filter((tool) => tool.status === status);
}

module.exports = {
  TOOL_CATEGORIES,
  TOOL_STATUSES,
  TOOL_REGISTRY,
  getToolRegistry,
  getToolById,
  getToolsByCategory,
  getToolsByStatus,
};

if (require.main === module) {
  console.log('Smart E-Commerce Growth AI Agent - tool registry (foundation only):\n');
  for (const category of TOOL_CATEGORIES) {
    const toolsInCategory = getToolsByCategory(category);
    if (toolsInCategory.length === 0) continue;
    console.log(`[${category}]`);
    for (const tool of toolsInCategory) {
      console.log(`  - ${tool.id} (${tool.status}): ${tool.title}`);
      console.log(`      ${tool.description}`);
    }
  }
  const implementedCount = getToolsByStatus('implemented').length;
  console.log(`\n${TOOL_REGISTRY.length} tools registered, ${implementedCount} implemented - registry foundation only.`);
  console.log('No tool is ever called from this file - dispatch lives in agent/core/orchestratorExecutionContract.js, gated by agent/core/toolPermissions.js.');
}
