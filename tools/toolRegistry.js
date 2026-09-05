'use strict';

// The registry of tools the Chief/Orchestrator may call. This is a registry
// FOUNDATION plus real, callable tools: a descriptive list plus small read-only
// lookup helpers - there is still no register/execute/dispatch function anywhere in
// this file (that lives in agent/core/orchestratorExecutionContract.js, gated by
// agent/core/toolPermissions.js), so tools are not called *from here*.
// business_configuration_retrieval, ai_reasoning_completion, market_research,
// customer_research, global_market_opportunity_analysis, competitor_research,
// product_data_retrieval, collection_data_retrieval, market_product_opportunity_analysis,
// keyword_research, seo_analysis, listing_content_generation, marketing_analysis,
// social_content_planning, paid_advertising_planning, social_media_strategy_generation,
// platform_content_generation, content_calendar_generation,
// advertising_strategy_planning, advertising_performance_analysis, analytics,
// analytics_data_retrieval, and live_competitor_research are the twenty-three entries
// actually implemented (see tools/businessConfigurationRetrieval.js,
// tools/aiReasoningCompletion.js, tools/marketResearchTool.js,
// tools/customerResearchTool.js, tools/globalMarketOpportunityTool.js,
// tools/competitorResearchTool.js, tools/productDataRetrievalTool.js,
// tools/collectionDataRetrievalTool.js, tools/marketProductOpportunityTool.js,
// tools/keywordResearchTool.js, tools/seoAnalysisTool.js, tools/listingContentTool.js,
// tools/marketingAnalysisTool.js, tools/socialContentTool.js,
// tools/paidAdvertisingTool.js, tools/socialMediaStrategyTool.js,
// tools/platformContentTool.js, tools/contentCalendarTool.js,
// tools/advertisingStrategyTool.js, tools/advertisingPerformanceTool.js,
// tools/analyticsTool.js, tools/analyticsDataTool.js, and
// tools/webCompetitorResearchTool.js) - the other 3 tools (product_research,
// memory_retrieval, verification) remain 'not_implemented'.
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
  // Shared infrastructure, owned by no specialist - like 'configuration', 'memory' and
  // 'verification', it is absent from agent/core/toolPermissions.js's
  // CATEGORY_TO_SPECIALIST, so that module derives it into
  // SHARED_INFRASTRUCTURE_CATEGORIES automatically. Compliance gates content on every
  // specialist's behalf; giving any one of them ownership of it would be exactly the
  // side channel CLAUDE.md section 2 forbids.
  'compliance',
];

const TOOL_STATUSES = ['not_implemented', 'implemented'];

// The operation type each tool performs, independent of both `category` (which
// domain owns it) and approvals/approvalArchitecture.js's classification (whether a
// human must sign off before it proceeds). This is the axis
// agent/core/toolPermissions.js's SPECIALIST_ROLE_PERMISSIONS gates on: a specialist's
// role grants it some subset of these operation types, and a tool it would otherwise
// be permitted to use (by category) is still denied if its role doesn't cover the
// tool's operation.
//   - 'read'    - retrieves or analyzes existing data; never authors new marketable
//                 content (business/product data retrieval, all research, SEO
//                 analysis, analytics, advertising performance analysis).
//   - 'write'   - composes new content/drafts/deliverables a human would review
//                 (listing content, marketing/social/ad content and strategy,
//                 campaign/content-calendar entries, the raw AI reasoning completion).
//   - 'execute' - would call or change an external system directly. No tool is
//                 'execute' today - none is wired to any external mutation yet (see
//                 approvals/approvalArchitecture.js's 'externally_executable' class,
//                 which is in the same honest position) - reserved for when one is.
const TOOL_OPERATIONS = ['read', 'write', 'execute'];

const TOOL_REGISTRY = [
  {
    id: 'business_configuration_retrieval',
    title: 'Business configuration retrieval',
    description:
      "Retrieve the connected Shopify store's shop identity (name, domain, email) via integrations/adapters/shopifyClient.js's getShopInfo() - see tools/businessConfigurationRetrieval.js.",
    category: 'configuration',
    operation: 'read',
    status: 'implemented',
  },
  {
    id: 'product_data_retrieval',
    title: 'Product data retrieval',
    description:
      "Retrieve read-only product data (products, variants, inventory, prices, SKUs, status, collections, metadata) from the connected Shopify store via integrations/adapters/shopifyClient.js's getProducts() - see tools/productDataRetrievalTool.js. No writes.",
    category: 'products',
    operation: 'read',
    status: 'implemented',
  },
  {
    id: 'collection_data_retrieval',
    title: 'Collection data retrieval',
    description:
      "Retrieve read-only, store-wide collection data (title, handle, description, image, product count) from the connected Shopify store via integrations/adapters/shopifyClient.js's getCollections() - see tools/collectionDataRetrievalTool.js. No writes.",
    category: 'products',
    operation: 'read',
    status: 'implemented',
  },
  {
    id: 'market_product_opportunity_analysis',
    title: 'Market-connected product opportunity analysis',
    description:
      "Connect one global market intelligence row (global_market_opportunity_analysis) to one product candidate: Market -> Category -> Trend -> Product -> Competition -> Economics -> Opportunity, producing a real agent/core/opportunityAnalysisModel.js record via workflows/productOpportunityAnalysisWorkflow.js's analyzeProductOpportunityFromMarket() - see tools/marketProductOpportunityTool.js. Economics is pricing/cost inputs only, never a computed margin; assessment/confidence are never invented - an estimate is never presented as a verified fact.",
    category: 'products',
    operation: 'read',
    status: 'implemented',
  },
  {
    id: 'product_research',
    title: 'Product research',
    description:
      'Run product research per the products/productResearchArchitecture.js pipeline.',
    category: 'products',
    operation: 'read',
    status: 'not_implemented',
  },
  {
    id: 'market_research',
    title: 'Market research',
    description:
      "Produce market research records conforming to agent/core/marketResearchModel.js via agent/core/researchAgent.js's runMarketResearch() - see tools/marketResearchTool.js.",
    category: 'research',
    operation: 'read',
    status: 'implemented',
  },
  {
    id: 'customer_research',
    title: 'Customer research',
    description:
      "Produce customer segment research records conforming to agent/core/customerSegmentResearchModel.js via agent/core/researchAgent.js's runCustomerMarketIntelligence() - see tools/customerResearchTool.js.",
    category: 'customer_market_intelligence',
    operation: 'read',
    status: 'implemented',
  },
  {
    id: 'global_market_opportunity_analysis',
    title: 'Global market opportunity analysis',
    description:
      "Structured global ecommerce market opportunity analysis across 9 evidence-backed dimensions per market/country row (country, category, demand, competition, pricing, trends, customer_need, risk, opportunity) via workflows/globalEcommerceMarketResearchWorkflow.js's compareGlobalMarkets() - see tools/globalMarketOpportunityTool.js. Deterministic composition only, no invented statistic; every fact retains its source/evidence.",
    category: 'research',
    operation: 'read',
    status: 'implemented',
  },
  {
    id: 'competitor_research',
    title: 'Competitor research',
    description:
      "Produce competitor research records - covering a business's known competitors - conforming to agent/core/competitorResearchModel.js via agent/core/researchAgent.js's runCompetitorResearch() - see tools/competitorResearchTool.js.",
    category: 'research',
    operation: 'read',
    status: 'implemented',
  },
  {
    id: 'keyword_research',
    title: 'Keyword research',
    description:
      "Produce agent/core/seoResearchModel.js keyword records and search-intent groupings via agent/core/seoAgent.js's runKeywordResearch()/analyzeSearchIntent(), following the workflows/keywordResearchWorkflow.js pipeline - see tools/keywordResearchTool.js.",
    category: 'seo',
    operation: 'read',
    status: 'implemented',
  },
  {
    id: 'seo_analysis',
    title: 'SEO analysis',
    description:
      "Analyze product/collection/content on-page SEO and SEO opportunity coverage via agent/core/seoAgent.js, composing agent/core/listingOptimizationModel.js and agent/core/onPageOptimizationModel.js records - see tools/seoAnalysisTool.js.",
    category: 'seo',
    operation: 'read',
    status: 'implemented',
  },
  {
    id: 'listing_content_generation',
    title: 'Listing content generation',
    description:
      "Compose agent/core/listingContentModel.js listing-content records (title, description, benefits, features, selling points, FAQs, attributes, variants) and agent/core/marketplaceListingFormatModel.js marketplace-formatted records via agent/core/listingAgent.js - see tools/listingContentTool.js.",
    category: 'listing',
    operation: 'write',
    status: 'implemented',
  },
  {
    id: 'marketing_analysis',
    title: 'Marketing analysis',
    description:
      "Produce agent/core/marketingAnalysisModel.js, agent/core/growthOpportunityModel.js, and agent/core/customerSegmentResearchModel.js records via agent/core/marketingAgent.js's 8 capabilities (marketing strategy, audience segmentation, offers, promotions, retention, campaign planning, email strategy, conversion opportunities) - see tools/marketingAnalysisTool.js.",
    category: 'marketing',
    operation: 'write',
    status: 'implemented',
  },
  {
    id: 'social_content_planning',
    title: 'Social content planning',
    description:
      "Compose agent/core/socialContentModel.js social media content records via agent/core/socialAdvertisingAgent.js's 5 social capabilities (instagram, facebook, tiktok, pinterest, youtube) - see tools/socialContentTool.js.",
    category: 'social_advertising',
    operation: 'write',
    status: 'implemented',
  },
  {
    id: 'paid_advertising_planning',
    title: 'Paid advertising planning',
    description:
      "Compose agent/core/adCampaignModel.js paid ad campaign records via agent/core/socialAdvertisingAgent.js's 3 advertising capabilities (meta_ads, google_ads, tiktok_ads) - see tools/paidAdvertisingTool.js.",
    category: 'social_advertising',
    operation: 'write',
    status: 'implemented',
  },
  {
    id: 'social_media_strategy_generation',
    title: 'Social media strategy generation',
    description:
      "Compose agent/core/socialMediaStrategyModel.js cross-platform strategy records (content pillars, audience, platform selection, posting strategy, content themes, campaign themes, KPIs) via agent/core/socialAdvertisingAgent.js's social_media_strategy capability - see tools/socialMediaStrategyTool.js.",
    category: 'social_advertising',
    operation: 'write',
    status: 'implemented',
  },
  {
    id: 'platform_content_generation',
    title: 'Platform-aware ecommerce content generation',
    description:
      "Compose agent/core/platformContentModel.js content records (hooks, captions, CTAs, content ideas, short-form video concepts, carousel concepts, creative briefs, all adapted to one selected platform) via agent/core/socialAdvertisingAgent.js's content_generation capability - see tools/platformContentTool.js.",
    category: 'social_advertising',
    operation: 'write',
    status: 'implemented',
  },
  {
    id: 'content_calendar_generation',
    title: 'Social content calendar generation',
    description:
      "Compose agent/core/contentCalendarModel.js calendar entries (date, platform, content type, topic, hook, CTA, campaign, product, KPI) via agent/core/socialAdvertisingAgent.js's content_calendar capability, optionally informed by Marketing Agent campaign context via agent/core/marketingAgent.js's campaign_plan builder - see tools/contentCalendarTool.js.",
    category: 'social_advertising',
    operation: 'write',
    status: 'implemented',
  },
  {
    id: 'advertising_strategy_planning',
    title: 'Advertising strategy planning',
    description:
      "Compose agent/core/advertisingStrategyModel.js pre-launch advertising strategy records (campaign objective, audience, offer, creative angle, ad copy, CTA, budget recommendation, KPI, testing plan) via agent/core/socialAdvertisingAgent.js's advertising_strategy capability - see tools/advertisingStrategyTool.js.",
    category: 'social_advertising',
    operation: 'write',
    status: 'implemented',
  },
  {
    id: 'advertising_performance_analysis',
    title: 'Advertising performance analysis',
    description:
      "Compose agent/core/advertisingPerformanceModel.js performance records (impressions, CTR, CPC, CPM, conversions, CPA, ROAS) via agent/core/socialAdvertisingAgent.js's advertising_performance capability, separating caller-supplied actual metrics from metrics agent/core/advertisingPerformanceCalculator.js derives from them, and from recommendations - see tools/advertisingPerformanceTool.js.",
    category: 'social_advertising',
    operation: 'read',
    status: 'implemented',
  },
  {
    id: 'analytics',
    title: 'Analytics',
    description:
      "Compose agent/core/analyticsModel.js snapshot records (sales, products, customers, conversion, traffic, marketing, advertising, inventory) and agent/core/growthOpportunityModel.js records (growth opportunities) from CALLER-SUPPLIED evidence, via agent/core/analyticsAgent.js's 9 capabilities - see tools/analyticsTool.js.",
    category: 'analytics',
    operation: 'read',
    status: 'implemented',
  },
  {
    id: 'analytics_data_retrieval',
    title: 'Analytics data retrieval',
    description:
      "Retrieve read-only LIVE data (orders, products, customers, inventory) from the connected Shopify store via integrations/adapters/shopifyClient.js, compute agent/core/analyticsMetricsCalculator.js's calculated/estimated metrics from it, and compose the result via agent/core/analyticsAgent.js's sales/products/customers/inventory capabilities - see tools/analyticsDataTool.js. No writes; customers uses non-PII fields only.",
    category: 'analytics',
    operation: 'read',
    status: 'implemented',
  },
  {
    id: 'ai_reasoning_completion',
    title: 'AI reasoning completion',
    description:
      "Run one structured Claude completion (instruction + optional context) via agent/core/claudeClient.js's sendMessage() - see tools/aiReasoningCompletion.js. Every call is capped/budgeted by agent/core/tokenControls.js.",
    category: 'ai_reasoning',
    operation: 'write',
    status: 'implemented',
  },
  {
    id: 'memory_retrieval',
    title: 'Memory retrieval',
    description:
      'Retrieve persisted state from memory/state/ per agent/core/memoryRules.js and agent/core/stateModel.js.',
    category: 'memory',
    operation: 'read',
    status: 'not_implemented',
  },
  {
    id: 'verification',
    title: 'Verification',
    description:
      "Verify results/evidence per agent/core/researchRecordModel.js's confidence/verification_status convention and the agent contract's verify_results stage.",
    category: 'verification',
    operation: 'read',
    status: 'not_implemented',
  },
  {
    id: 'live_competitor_research',
    title: 'Live web competitor research',
    description:
      "Find real, currently-operating competitors via Anthropic's hosted web_search tool (agent/core/claudeClient.js's sendMessage `tools` passthrough), verify every claimed competitor against the search results actually returned, and compose the result via agent/core/researchAgent.js's runCompetitorResearch() - see tools/webCompetitorResearchTool.js. The Research specialist's live counterpart to competitor_research, dispatched only when a free-text objective supplies no structured research_params. No writes; never reports an unverified competitor as real.",
    category: 'research',
    operation: 'read',
    status: 'implemented',
  },
  {
    id: 'discover_market_questions',
    title: 'Real market question discovery',
    description:
      "Find real questions people publicly ask about a topic via Anthropic's hosted web_search tool (agent/core/claudeClient.js's sendMessage `tools` passthrough), verify every claimed question against the search results actually returned, and normalize/deduplicate them into agent/core/questionEvidenceModel.js evidence records - see tools/marketQuestionDiscoveryTool.js. The evidence-acquisition layer upstream of the SEO specialist's information_gap_analysis capability: its output feeds agent/core/informationGapEngine.js directly. No writes, no scraping, no new credential; a question whose source cannot be verified is reported as model-generated, never as a real market question.",
    category: 'seo',
    operation: 'read',
    status: 'implemented',
  },
  {
    id: 'seo_content_generation',
    title: 'SEO content generation from an information gap',
    description:
      "Turn a validated information-gap opportunity (agent/core/informationGapModel.js) into a structured content brief and, only when the evidence justifies it, a content draft - see tools/seoContentGenerationTool.js. Deterministic gating/brief/post-checks live in agent/core/contentBriefEngine.js; the single model call reuses tools/aiReasoningCompletion.js, so AI_PROVIDER selection and the shared token budget apply unchanged. The one 'write' tool the SEO specialist owns: it authors website content answering a real customer question, which the listing-shaped agent/core/listingAgent.js cannot produce. Publishes nothing - its output is a draft for Compliance and human approval; an unevidenced opportunity is blocked before any model call is made.",
    category: 'seo',
    operation: 'write',
    status: 'implemented',
  },
  {
    id: 'compliance_check',
    title: 'Compliance check',
    // WORDING NOTE: this description is also routing-target text - see
    // agent/core/orchestratorExecutionContract.js's buildRoutingTargets(), which scores a
    // free-text objective against every tool's id/title/description. tokenize() there
    // only strips its own STOPWORDS list, so incidental filler ("its", "one", "your")
    // becomes a real scoring token and can win a clause outright on a single weak match.
    // An earlier draft of this description contained "its" and thereby captured the
    // fragment "update its title" - a Listing clause - away from the clause-recovery
    // path that is supposed to handle it. Domain nouns only, deliberately.
    description:
      "Evaluate already-generated content against compliance/complianceEngine.js's deterministic pre-action checks - provenance, unsupported claims, similarity against supplied reference material, intellectual-property indicators, structured platform-policy rules, and explicitly prohibited content - returning a PASS/REVIEW/BLOCK verdict plus a governance record. See tools/complianceCheckTool.js. Shared infrastructure owned by no specialist; read-only validation that authors nothing, approves nothing, and publishes nothing, so a verdict never becomes an approval.",
    category: 'compliance',
    operation: 'read',
    status: 'implemented',
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

function getToolsByOperation(operation) {
  return TOOL_REGISTRY.filter((tool) => tool.operation === operation);
}

module.exports = {
  TOOL_CATEGORIES,
  TOOL_STATUSES,
  TOOL_OPERATIONS,
  TOOL_REGISTRY,
  getToolRegistry,
  getToolById,
  getToolsByCategory,
  getToolsByStatus,
  getToolsByOperation,
};

if (require.main === module) {
  console.log('Smart E-Commerce Growth AI Agent - tool registry (foundation only):\n');
  for (const category of TOOL_CATEGORIES) {
    const toolsInCategory = getToolsByCategory(category);
    if (toolsInCategory.length === 0) continue;
    console.log(`[${category}]`);
    for (const tool of toolsInCategory) {
      console.log(`  - ${tool.id} (${tool.status}, ${tool.operation}): ${tool.title}`);
      console.log(`      ${tool.description}`);
    }
  }
  const implementedCount = getToolsByStatus('implemented').length;
  console.log(`\n${TOOL_REGISTRY.length} tools registered, ${implementedCount} implemented - registry foundation only.`);
  console.log('No tool is ever called from this file - dispatch lives in agent/core/orchestratorExecutionContract.js, gated by agent/core/toolPermissions.js.');
}
