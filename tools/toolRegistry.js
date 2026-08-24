'use strict';

// The registry of tools the Chief/Orchestrator may call. This is a registry
// FOUNDATION plus real, callable tools: a descriptive list plus small read-only
// lookup helpers - there is still no register/execute/dispatch function anywhere in
// this file (that lives in agent/core/orchestratorExecutionContract.js, gated by
// agent/core/toolPermissions.js), so tools are not called *from here*.
// business_configuration_retrieval, ai_reasoning_completion, market_research,
// competitor_research, customer_research, product_data_retrieval, keyword_research,
// seo_analysis, listing_content_generation, and marketing_analysis are the ten
// entries actually implemented (see tools/businessConfigurationRetrieval.js,
// tools/aiReasoningCompletion.js, tools/marketResearchTool.js,
// tools/competitorResearchTool.js, tools/customerResearchTool.js,
// tools/productDataRetrievalTool.js, tools/keywordResearchTool.js,
// tools/seoAnalysisTool.js, tools/listingContentTool.js, and
// tools/marketingAnalysisTool.js) - the other 3 tools remain 'not_implemented'.
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
